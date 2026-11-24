#![cfg(target_os = "linux")]

use super::{process_name_for_pid, Platform, WinInfo};
use std::process::Command;
use std::sync::Mutex;
use std::thread;
use std::time::{Duration, Instant};
use x11rb::connection::Connection;
use x11rb::protocol::xproto::{
    AtomEnum, ClientMessageEvent, ConfigureWindowAux, ConnectionExt, EventMask, InputFocus,
    StackMode, Window,
};
use x11rb::protocol::xtest::ConnectionExt as XTestExt;
use x11rb::rust_connection::RustConnection;

struct X11ActivitySnapshot {
    last_pointer: (i16, i16, u16),
    last_keymap: [u8; 32],
    last_active_win: u64,
    last_change: Instant,
    last_dbus_check: Instant,
    cached_dbus_idle_ms: Option<u64>,
    mutter_unavailable: bool,
}

struct CachedX11 {
    conn: RustConnection,
    root: Window,
    atom_active_window: u32,
    atom_client_list: u32,
    atom_net_wm_name: u32,
    atom_utf8_string: u32,
    atom_net_wm_pid: u32,
    atom_close_window: u32,
    atom_wm_change_state: u32,
}

static X11_CONN: Mutex<Option<CachedX11>> = Mutex::new(None);
static X11_IDLE_STATE: Mutex<Option<X11ActivitySnapshot>> = Mutex::new(None);

fn intern_atom_raw(conn: &RustConnection, name: &[u8]) -> Result<u32, String> {
    conn.intern_atom(false, name)
        .map_err(|e| e.to_string())?
        .reply()
        .map(|r| r.atom)
        .map_err(|e| e.to_string())
}

fn open_cached_x11() -> Result<CachedX11, String> {
    let (conn, screen_num) =
        RustConnection::connect(None).map_err(|e| format!("X11 connect failed: {e}"))?;
    let root = conn.setup().roots[screen_num].root;
    Ok(CachedX11 {
        atom_active_window: intern_atom_raw(&conn, b"_NET_ACTIVE_WINDOW")?,
        atom_client_list: intern_atom_raw(&conn, b"_NET_CLIENT_LIST")?,
        atom_net_wm_name: intern_atom_raw(&conn, b"_NET_WM_NAME")?,
        atom_utf8_string: intern_atom_raw(&conn, b"UTF8_STRING")?,
        atom_net_wm_pid: intern_atom_raw(&conn, b"_NET_WM_PID")?,
        atom_close_window: intern_atom_raw(&conn, b"_NET_CLOSE_WINDOW")?,
        atom_wm_change_state: intern_atom_raw(&conn, b"WM_CHANGE_STATE")?,
        conn,
        root,
    })
}

fn with_x11<R>(f: impl FnOnce(&CachedX11) -> Result<R, String>) -> Result<R, String> {
    let mut guard = X11_CONN.lock().unwrap_or_else(|e| e.into_inner());
    if guard.is_none() {
        *guard = Some(open_cached_x11()?);
    }
    let first_attempt = match guard.as_ref() {
        Some(ctx) => f(ctx),
        None => Err("X11 unavailable".into()),
    };
    if first_attempt.is_ok() {
        return first_attempt;
    }
    // Reconnect once if X server dropped the connection
    *guard = None;
    first_attempt
}

fn parse_mutter_idletime(output: &str) -> Option<u64> {
    // gdbus returns e.g. "(uint64 12345,)" — split on whitespace/parens/commas and skip type token "uint64"
    for token in output.split(|c: char| !c.is_ascii_alphanumeric()) {
        if !token.is_empty() && token.chars().all(|c| c.is_ascii_digit()) {
            if let Ok(val) = token.parse::<u64>() {
                return Some(val);
            }
        }
    }
    None
}

fn query_gnome_mutter_idle_ms() -> Option<u64> {
    let out = Command::new("gdbus")
        .args([
            "call",
            "--session",
            "--dest",
            "org.gnome.Mutter.IdleMonitor",
            "--object-path",
            "/org/gnome/Mutter/IdleMonitor/Core",
            "--method",
            "org.gnome.Mutter.IdleMonitor.GetIdletime",
        ])
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let text = String::from_utf8_lossy(&out.stdout);
    parse_mutter_idletime(&text)
}

pub struct LinuxX11Platform;

impl LinuxX11Platform {
    pub fn new() -> Self {
        Self
    }

    /// Dynamically resolves an X11 keysym (e.g. 'w' = 0x0077, Control_L = 0xffe3)
    /// into the active X server's physical keycode so AZERTY, QWERTY, QWERTZ all work.
    fn keycode_for_keysym(&self, conn: &RustConnection, target_sym: u32, fallback: u8) -> u8 {
        let min_kc = conn.setup().min_keycode;
        let max_kc = conn.setup().max_keycode;
        if max_kc < min_kc {
            return fallback;
        }
        let count = max_kc - min_kc + 1;
        if let Ok(cookie) = conn.get_keyboard_mapping(min_kc, count) {
            if let Ok(reply) = cookie.reply() {
                let per = reply.keysyms_per_keycode as usize;
                if per > 0 {
                    for (idx, chunk) in reply.keysyms.chunks(per).enumerate() {
                        if chunk.contains(&target_sym) {
                            return min_kc.wrapping_add(idx as u8);
                        }
                    }
                }
            }
        }
        fallback
    }

    fn read_window_title(&self, ctx: &CachedX11, win: Window) -> String {
        if let Ok(cookie) = ctx.conn.get_property(
            false,
            win,
            ctx.atom_net_wm_name,
            ctx.atom_utf8_string,
            0,
            1024,
        ) {
            if let Ok(reply) = cookie.reply() {
                if !reply.value.is_empty() {
                    return String::from_utf8_lossy(&reply.value).trim().to_string();
                }
            }
        }
        if let Ok(cookie) =
            ctx.conn
                .get_property(false, win, AtomEnum::WM_NAME, AtomEnum::STRING, 0, 1024)
        {
            if let Ok(reply) = cookie.reply() {
                if !reply.value.is_empty() {
                    return String::from_utf8_lossy(&reply.value).trim().to_string();
                }
            }
        }
        String::new()
    }

    fn read_window_pid(&self, ctx: &CachedX11, win: Window) -> u32 {
        if let Ok(cookie) = ctx.conn.get_property(
            false,
            win,
            ctx.atom_net_wm_pid,
            AtomEnum::CARDINAL,
            0,
            1,
        ) {
            if let Ok(reply) = cookie.reply() {
                if let Some(mut val32) = reply.value32() {
                    if let Some(pid) = val32.next() {
                        return pid;
                    }
                }
            }
        }
        0
    }

    fn build_win_info(&self, ctx: &CachedX11, win: Window) -> Option<WinInfo> {
        if win == 0 {
            return None;
        }
        let title = self.read_window_title(ctx, win);
        if title.is_empty() {
            return None;
        }
        let pid = self.read_window_pid(ctx, win);
        let process_name = process_name_for_pid(pid);
        Some(WinInfo {
            id: win as u64,
            title,
            pid,
            process_name,
        })
    }

    fn active_window_id_raw(ctx: &CachedX11) -> u64 {
        ctx.conn
            .get_property(
                false,
                ctx.root,
                ctx.atom_active_window,
                AtomEnum::WINDOW,
                0,
                1,
            )
            .ok()
            .and_then(|c| c.reply().ok())
            .and_then(|r| r.value32()?.next())
            .map(|w| w as u64)
            .unwrap_or(0)
    }

    fn wait_until_active(&self, target_id: u64, max_attempts: usize) {
        for _ in 0..max_attempts {
            if with_x11(|ctx| Ok(Self::active_window_id_raw(ctx))).unwrap_or(0) == target_id {
                return;
            }
            let _ = self.focus_window(target_id);
            thread::sleep(Duration::from_millis(35));
        }
    }
}

impl Platform for LinuxX11Platform {
    fn active_window(&self) -> Option<WinInfo> {
        with_x11(|ctx| {
            let reply = ctx
                .conn
                .get_property(
                    false,
                    ctx.root,
                    ctx.atom_active_window,
                    AtomEnum::WINDOW,
                    0,
                    1,
                )
                .map_err(|e| e.to_string())?
                .reply()
                .map_err(|e| e.to_string())?;
            let win = match reply.value32().and_then(|mut it| it.next()) {
                Some(w) => w,
                None => return Ok(None),
            };
            Ok(self.build_win_info(ctx, win))
        })
        .ok()
        .flatten()
    }

    fn list_windows(&self) -> Vec<WinInfo> {
        with_x11(|ctx| {
            let mut results = Vec::new();
            let reply = ctx
                .conn
                .get_property(
                    false,
                    ctx.root,
                    ctx.atom_client_list,
                    AtomEnum::WINDOW,
                    0,
                    256,
                )
                .map_err(|e| e.to_string())?
                .reply()
                .map_err(|e| e.to_string())?;
            if let Some(windows) = reply.value32() {
                for win in windows {
                    if let Some(info) = self.build_win_info(ctx, win) {
                        results.push(info);
                    }
                }
            }
            Ok(results)
        })
        .unwrap_or_default()
    }

    fn focus_window(&self, id: u64) -> Result<(), String> {
        let win = id as Window;
        with_x11(|ctx| {
            let _ = ctx.conn.map_window(win);
            let _ = ctx.conn.configure_window(
                win,
                &ConfigureWindowAux::new().stack_mode(StackMode::ABOVE),
            );
            let ev = ClientMessageEvent::new(
                32,
                win,
                ctx.atom_active_window,
                [2u32, x11rb::CURRENT_TIME, 0, 0, 0],
            );
            ctx.conn
                .send_event(
                    false,
                    ctx.root,
                    EventMask::SUBSTRUCTURE_REDIRECT | EventMask::SUBSTRUCTURE_NOTIFY,
                    ev,
                )
                .map_err(|e| e.to_string())?;
            let _ = ctx
                .conn
                .set_input_focus(InputFocus::PARENT, win, x11rb::CURRENT_TIME);
            ctx.conn.flush().map_err(|e| e.to_string())
        })?;

        thread::sleep(Duration::from_millis(30));
        if with_x11(|ctx| Ok(Self::active_window_id_raw(ctx))).unwrap_or(0) == id {
            return Ok(());
        }

        // Fallback via wmctrl only if EWMH ClientMessage was throttled by the WM
        let _ = Command::new("wmctrl")
            .args(["-i", "-a", &format!("0x{:x}", id)])
            .output();

        for _ in 0..3 {
            if with_x11(|ctx| Ok(Self::active_window_id_raw(ctx))).unwrap_or(0) == id {
                break;
            }
            let _ = with_x11(|ctx| {
                let _ = ctx.conn.configure_window(
                    win,
                    &ConfigureWindowAux::new().stack_mode(StackMode::ABOVE),
                );
                let ev_retry = ClientMessageEvent::new(
                    32,
                    win,
                    ctx.atom_active_window,
                    [2u32, x11rb::CURRENT_TIME, 0, 0, 0],
                );
                let _ = ctx.conn.send_event(
                    false,
                    ctx.root,
                    EventMask::SUBSTRUCTURE_REDIRECT | EventMask::SUBSTRUCTURE_NOTIFY,
                    ev_retry,
                );
                let _ = ctx
                    .conn
                    .set_input_focus(InputFocus::PARENT, win, x11rb::CURRENT_TIME);
                let _ = ctx.conn.flush();
                Ok(())
            });
            thread::sleep(Duration::from_millis(30));
        }
        Ok(())
    }

    fn minimize_window(&self, id: u64) -> Result<(), String> {
        let win = id as Window;
        with_x11(|ctx| {
            // IconicState = 3
            let ev = ClientMessageEvent::new(32, win, ctx.atom_wm_change_state, [3u32, 0, 0, 0, 0]);
            ctx.conn
                .send_event(
                    false,
                    ctx.root,
                    EventMask::SUBSTRUCTURE_REDIRECT | EventMask::SUBSTRUCTURE_NOTIFY,
                    ev,
                )
                .map_err(|e| e.to_string())?;
            ctx.conn.flush().map_err(|e| e.to_string())
        })
    }

    fn close_window(&self, id: u64) -> Result<(), String> {
        let win = id as Window;
        with_x11(|ctx| {
            let ev = ClientMessageEvent::new(32, win, ctx.atom_close_window, [0u32, 2, 0, 0, 0]);
            ctx.conn
                .send_event(
                    false,
                    ctx.root,
                    EventMask::SUBSTRUCTURE_REDIRECT | EventMask::SUBSTRUCTURE_NOTIFY,
                    ev,
                )
                .map_err(|e| e.to_string())?;
            ctx.conn.flush().map_err(|e| e.to_string())
        })
    }

    fn send_close_tab(&self, id: u64) -> Result<(), String> {
        // Ensure the browser window actually regains focus after the overlay hides
        self.wait_until_active(id, 8);
        thread::sleep(Duration::from_millis(60));

        // Resolve physical keycodes dynamically from X11 keyboard mapping (supports AZERTY & QWERTY)
        // XK_Control_L = 0xffe3, XK_w = 0x0077, XK_W = 0x0057
        let (kc_ctrl, kc_w) = with_x11(|ctx| {
            let ctrl = self.keycode_for_keysym(&ctx.conn, 0xffe3, 37);
            let mut w = self.keycode_for_keysym(&ctx.conn, 0x0077, 0);
            if w == 0 {
                w = self.keycode_for_keysym(&ctx.conn, 0x0057, 25);
            }
            Ok((ctrl, w))
        })?;

        const KEYPRESS: u8 = 2;
        const KEYRELEASE: u8 = 3;

        with_x11(|ctx| {
            ctx.conn
                .xtest_fake_input(KEYPRESS, kc_ctrl, 0, ctx.root, 0, 0, 0)
                .map_err(|e| e.to_string())?;
            ctx.conn.flush().map_err(|e| e.to_string())
        })?;
        thread::sleep(Duration::from_millis(20));

        with_x11(|ctx| {
            ctx.conn
                .xtest_fake_input(KEYPRESS, kc_w, 0, ctx.root, 0, 0, 0)
                .map_err(|e| e.to_string())?;
            ctx.conn.flush().map_err(|e| e.to_string())
        })?;
        thread::sleep(Duration::from_millis(20));

        with_x11(|ctx| {
            ctx.conn
                .xtest_fake_input(KEYRELEASE, kc_w, 0, ctx.root, 0, 0, 0)
                .map_err(|e| e.to_string())?;
            ctx.conn
                .xtest_fake_input(KEYRELEASE, kc_ctrl, 0, ctx.root, 0, 0, 0)
                .map_err(|e| e.to_string())?;
            ctx.conn.flush().map_err(|e| e.to_string())
        })?;

        // Give the browser 120ms to process Ctrl+W and close the tab before Dhirna switches window focus
        thread::sleep(Duration::from_millis(120));
        Ok(())
    }

    fn idle_duration_ms(&self) -> u64 {
        let now = Instant::now();
        let (pointer_state, keymap_state, active_win_id) = with_x11(|ctx| {
            let mut ptr = (0i16, 0i16, 0u16);
            let mut keys = [0u8; 32];
            if let Ok(cookie) = ctx.conn.query_pointer(ctx.root) {
                if let Ok(reply) = cookie.reply() {
                    ptr = (reply.root_x, reply.root_y, reply.mask.into());
                }
            }
            if let Ok(cookie) = ctx.conn.query_keymap() {
                if let Ok(reply) = cookie.reply() {
                    keys = reply.keys;
                }
            }
            let active_id = Self::active_window_id_raw(ctx);
            Ok((ptr, keys, active_id))
        })
        .unwrap_or(((0, 0, 0), [0u8; 32], 0));

        let mut x11_idle_ms = 0u64;
        let mut dbus_idle_ms = None;

        if let Ok(mut guard) = X11_IDLE_STATE.lock() {
            let state = guard.get_or_insert_with(|| X11ActivitySnapshot {
                last_pointer: pointer_state,
                last_keymap: keymap_state,
                last_active_win: active_win_id,
                last_change: now,
                last_dbus_check: now - Duration::from_secs(5),
                cached_dbus_idle_ms: None,
                mutter_unavailable: false,
            });

            if pointer_state != state.last_pointer
                || keymap_state != state.last_keymap
                || (active_win_id != 0 && active_win_id != state.last_active_win)
            {
                state.last_pointer = pointer_state;
                state.last_keymap = keymap_state;
                state.last_active_win = active_win_id;
                state.last_change = now;
            }

            if !state.mutter_unavailable
                && state.last_dbus_check.elapsed() >= Duration::from_millis(3000)
            {
                state.last_dbus_check = now;
                let res = query_gnome_mutter_idle_ms();
                if res.is_none() {
                    // Avoid spawning failing gdbus calls on non-GNOME desktops (Cinnamon/XFCE/MATE)
                    state.mutter_unavailable = true;
                }
                state.cached_dbus_idle_ms = res;
            }

            x11_idle_ms = state.last_change.elapsed().as_millis() as u64;
            dbus_idle_ms = state.cached_dbus_idle_ms;
        }

        match dbus_idle_ms {
            Some(mutter_ms) => x11_idle_ms.min(mutter_ms),
            None => x11_idle_ms,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_mutter_idletime_uint64_output() {
        assert_eq!(parse_mutter_idletime("(uint64 123456,)"), Some(123456));
        assert_eq!(parse_mutter_idletime("(uint64 0,)"), Some(0));
        assert_eq!(parse_mutter_idletime(""), None);
    }
}
