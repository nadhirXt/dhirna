use super::writer::now_ms;
use crate::platform::{current_platform, WinInfo};
use serde::{Deserialize, Serialize};
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::atomic::{AtomicBool, AtomicI64, Ordering};
use std::sync::{Mutex, OnceLock};
use std::thread;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager};

pub const BRIDGE_PORT: u16 = 47821;
const EXTENSION_TTL_MS: i64 = 35_000;

static BRIDGE_RUNNING: AtomicBool = AtomicBool::new(false);
static LAST_EXT_HEARTBEAT_MS: AtomicI64 = AtomicI64::new(0);
static FOCUS_TIMER_ACTIVE: AtomicBool = AtomicBool::new(false);
static FOCUS_ENDS_AT_MS: AtomicI64 = AtomicI64::new(0);
static CONNECTED_BROWSER: Mutex<String> = Mutex::new(String::new());
static SHARED_GOAL: Mutex<Option<ActiveGoal>> = Mutex::new(None);
static LAST_WORK_WINDOW: Mutex<Option<WinInfo>> = Mutex::new(None);
static SHARED_SHIELD: Mutex<ShieldConfig> = Mutex::new(ShieldConfig::default_const());
static SHARED_THEME: Mutex<ThemePref> = Mutex::new(ThemePref::default_const());
static BRIDGE_APP: OnceLock<AppHandle> = OnceLock::new();

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ThemePref {
    #[serde(default = "default_theme_name")]
    pub theme: String,
    #[serde(default)]
    pub updated_at_ms: i64,
}

fn default_theme_name() -> String {
    "dark".to_string()
}

impl ThemePref {
    pub const fn default_const() -> Self {
        Self {
            theme: String::new(),
            updated_at_ms: 0,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BridgeStatus {
    pub running: bool,
    pub port: u16,
    pub extension_connected: bool,
    pub connected_browser: String,
    pub last_heartbeat_ms: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ActiveGoal {
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub target_type: String,
    #[serde(default)]
    pub site: String,
    #[serde(default)]
    pub app: String,
    #[serde(default)]
    pub window_title: String,
    #[serde(default)]
    pub updated_at_ms: i64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct GoalEnvelope {
    #[serde(default)]
    goal: Option<ActiveGoal>,
    #[serde(default)]
    browser: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ShieldConfig {
    #[serde(default)]
    pub enabled: bool,
    #[serde(default = "default_shield_provider")]
    pub provider: String,
    #[serde(default = "default_true")]
    pub safe_search: bool,
    #[serde(default)]
    pub youtube_restricted: bool,
    #[serde(default = "default_true")]
    pub no_reels: bool,
    #[serde(default)]
    pub lock_until_ms: Option<i64>,
    #[serde(default)]
    pub updated_at_ms: i64,
}

fn default_shield_provider() -> String {
    "cleanbrowsing".to_string()
}

fn default_true() -> bool {
    true
}

impl ShieldConfig {
    pub const fn default_const() -> Self {
        Self {
            enabled: false,
            provider: String::new(),
            safe_search: true,
            youtube_restricted: false,
            no_reels: true,
            lock_until_ms: None,
            updated_at_ms: 0,
        }
    }

    pub fn normalized(mut self) -> Self {
        if self.provider.is_empty() {
            self.provider = "cleanbrowsing".to_string();
        }
        self
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ShieldEnvelope {
    shield: ShieldConfig,
    #[serde(default)]
    browser: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct MobileQrPayload {
    #[serde(default)]
    provider: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct FocusGoalPayload {
    #[serde(default)]
    app: String,
    #[serde(default)]
    browser: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SegmentPayload {
    started_at_ms: i64,
    ended_at_ms: i64,
    duration_ms: i64,
    domain: String,
    kind: String,
    #[serde(default)]
    browser: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct EventPayload {
    event_type: String,
    target: String,
    #[serde(default)]
    meta_json: Option<String>,
    #[serde(default)]
    browser: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SessionPayload {
    action: String,
    #[serde(default)]
    planned_ms: i64,
    #[serde(default)]
    outcome: String,
    #[serde(default)]
    browser: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct HeartbeatPayload {
    #[serde(default)]
    browser: String,
}

fn normalize_proc(name: &str) -> String {
    let base = name
        .trim()
        .to_lowercase()
        .rsplit(['/', '\\'])
        .next()
        .unwrap_or("")
        .to_string();
    base.trim_end_matches(".exe").to_string()
}

pub fn note_extension_heartbeat(browser: &str) {
    LAST_EXT_HEARTBEAT_MS.store(now_ms(), Ordering::SeqCst);
    let clean = browser.trim().to_lowercase();
    if !clean.is_empty() {
        if let Ok(mut guard) = CONNECTED_BROWSER.lock() {
            *guard = clean;
        }
    }
}

pub fn is_extension_connected_at(current_ms: i64) -> bool {
    let last = LAST_EXT_HEARTBEAT_MS.load(Ordering::SeqCst);
    last > 0 && current_ms.saturating_sub(last) <= EXTENSION_TTL_MS
}

pub fn bridge_status() -> BridgeStatus {
    let now = now_ms();
    let last = LAST_EXT_HEARTBEAT_MS.load(Ordering::SeqCst);
    let browser = CONNECTED_BROWSER
        .lock()
        .map(|g| g.clone())
        .unwrap_or_default();
    BridgeStatus {
        running: BRIDGE_RUNNING.load(Ordering::SeqCst),
        port: BRIDGE_PORT,
        extension_connected: is_extension_connected_at(now),
        connected_browser: browser,
        last_heartbeat_ms: last,
    }
}

pub fn get_shared_goal() -> Option<ActiveGoal> {
    SHARED_GOAL.lock().ok().and_then(|g| g.clone())
}

pub fn get_shared_theme() -> ThemePref {
    let mut pref = SHARED_THEME
        .lock()
        .map(|g| g.clone())
        .unwrap_or_else(|_| ThemePref::default_const());
    if pref.theme != "light" {
        pref.theme = "dark".to_string();
    }
    pref
}

pub fn set_shared_theme(mut incoming: ThemePref) -> ThemePref {
    incoming.theme = if incoming.theme == "light" {
        "light".to_string()
    } else {
        "dark".to_string()
    };
    if let Ok(mut guard) = SHARED_THEME.lock() {
        if incoming.updated_at_ms == 0 || incoming.updated_at_ms >= guard.updated_at_ms {
            *guard = incoming.clone();
        }
        let mut out = guard.clone();
        if out.theme != "light" {
            out.theme = "dark".to_string();
        }
        return out;
    }
    incoming
}

pub fn set_shared_goal(incoming: Option<ActiveGoal>, emit_to_desktop: bool) -> Option<ActiveGoal> {
    let updated = {
        let Ok(mut guard) = SHARED_GOAL.lock() else {
            return incoming;
        };
        match (&*guard, incoming) {
            (Some(curr), Some(next))
                if next.updated_at_ms > 0 && next.updated_at_ms < curr.updated_at_ms =>
            {
                guard.clone()
            }
            (_, next) => {
                *guard = next;
                guard.clone()
            }
        }
    };

    if emit_to_desktop {
        if let Some(app) = BRIDGE_APP.get() {
            let _ = app.emit("goal-synced", &updated);
        }
    }
    updated
}

pub fn get_shared_shield() -> ShieldConfig {
    SHARED_SHIELD
        .lock()
        .ok()
        .map(|g| g.clone().normalized())
        .unwrap_or_else(|| ShieldConfig::default_const().normalized())
}

pub fn set_shared_shield(incoming: ShieldConfig, emit_to_desktop: bool) -> ShieldConfig {
    let incoming = incoming.normalized();
    let updated = {
        let Ok(mut guard) = SHARED_SHIELD.lock() else {
            return incoming;
        };
        if guard.updated_at_ms > 0 && incoming.updated_at_ms < guard.updated_at_ms {
            guard.clone().normalized()
        } else {
            *guard = incoming;
            guard.clone().normalized()
        }
    };

    if emit_to_desktop {
        if let Some(app) = BRIDGE_APP.get() {
            let _ = app.emit("shield-synced", &updated);
        }
    }
    updated
}

pub fn set_focus_timer_state(active: bool, ends_at_ms: i64) {
    FOCUS_TIMER_ACTIVE.store(active, Ordering::SeqCst);
    FOCUS_ENDS_AT_MS.store(if active { ends_at_ms.max(0) } else { 0 }, Ordering::SeqCst);
}

pub fn get_focus_timer_state() -> (bool, i64) {
    let active_flag = FOCUS_TIMER_ACTIVE.load(Ordering::SeqCst);
    let ends_at = FOCUS_ENDS_AT_MS.load(Ordering::SeqCst);
    let now = now_ms();
    if ends_at > 0 {
        if ends_at > now {
            return (true, ((ends_at - now) + 999) / 1000);
        }
        FOCUS_TIMER_ACTIVE.store(false, Ordering::SeqCst);
        FOCUS_ENDS_AT_MS.store(0, Ordering::SeqCst);
        return (false, 0);
    }
    (active_flag, 0)
}

pub fn set_last_work_window(win: Option<WinInfo>) {
    if let Ok(mut guard) = LAST_WORK_WINDOW.lock() {
        *guard = win;
    }
}

pub fn get_last_work_window() -> Option<WinInfo> {
    LAST_WORK_WINDOW.lock().ok().and_then(|g| g.clone())
}

fn is_browser_proc(norm: &str) -> bool {
    matches!(
        norm,
        "brave"
            | "brave-browser"
            | "chrome"
            | "google-chrome"
            | "google-chrome-stable"
            | "chromium"
            | "chromium-browser"
            | "msedge"
            | "microsoft-edge"
            | "firefox"
            | "firefox-esr"
            | "firefox-bin"
            | "opera"
            | "vivaldi"
            | "vivaldi-bin"
            | "zen"
            | "librewolf"
            | "waterfox"
    )
}

fn proc_matches(actual: &str, target: &str) -> bool {
    if actual.is_empty() || target.is_empty() {
        return false;
    }
    if actual == target {
        return true;
    }
    if actual.len() >= 6 && target.starts_with(actual) {
        return true;
    }
    if target.len() >= 6 && actual.starts_with(target) {
        return true;
    }
    false
}

pub fn find_open_goal_window(preferred_app: Option<&str>) -> Option<WinInfo> {
    let shared_goal = get_shared_goal();
    let target_app = preferred_app
        .map(normalize_proc)
        .filter(|s| !s.is_empty())
        .or_else(|| {
            shared_goal
                .as_ref()
                .map(|g| normalize_proc(&g.app))
                .filter(|s| !s.is_empty())
        });
    let goal_win_title = shared_goal
        .as_ref()
        .map(|g| g.window_title.trim().to_lowercase())
        .filter(|s| !s.is_empty());
    let last_win = get_last_work_window();

    let wins: Vec<WinInfo> = current_platform()
        .list_windows()
        .into_iter()
        .filter(|w| {
            let proc = normalize_proc(&w.process_name);
            let title = w.title.trim();
            !proc.is_empty()
                && proc != "dhirna"
                && proc != "dhirna-desktop"
                && !matches!(title, "Dhirna" | "Dhirna — Focus" | "Dhirna — Alerte Focus")
                && !is_browser_proc(&proc)
        })
        .collect();

    if let Some(ref app) = target_app {
        if let Some(ref wt) = goal_win_title {
            if let Some(found) = wins.iter().find(|w| {
                let p = normalize_proc(&w.process_name);
                (proc_matches(&p, app) || w.title.to_lowercase().contains(app))
                    && w.title.to_lowercase().contains(wt)
            }) {
                return Some(found.clone());
            }
        }
        if let Some(found) = wins.iter().find(|w| {
            let p = normalize_proc(&w.process_name);
            proc_matches(&p, app) || w.title.to_lowercase().contains(app)
        }) {
            return Some(found.clone());
        }
    }

    if let Some(ref wt) = goal_win_title {
        if let Some(found) = wins.iter().find(|w| w.title.to_lowercase().contains(wt)) {
            return Some(found.clone());
        }
    }

    if let Some(ref last) = last_win {
        if let Some(found) = wins.iter().find(|w| w.id == last.id) {
            return Some(found.clone());
        }
        let last_proc = normalize_proc(&last.process_name);
        if let Some(found) = wins
            .iter()
            .find(|w| proc_matches(&normalize_proc(&w.process_name), &last_proc))
        {
            return Some(found.clone());
        }
    }

    None
}

pub fn focus_desktop_goal(preferred_app: Option<&str>) -> Option<WinInfo> {
    let win = find_open_goal_window(preferred_app)?;
    let _ = current_platform().focus_window(win.id);
    Some(win)
}

pub fn should_defer_browser(process_name: &str) -> bool {
    if !is_extension_connected_at(now_ms()) {
        return false;
    }
    let norm = normalize_proc(process_name);
    matches!(
        norm.as_str(),
        "brave"
            | "brave-browser"
            | "chrome"
            | "google-chrome"
            | "google-chrome-stable"
            | "chromium"
            | "chromium-browser"
            | "msedge"
            | "microsoft-edge"
    )
}

fn parse_days_query(path: &str) -> i64 {
    if let Some((_, query)) = path.split_once('?') {
        for pair in query.split('&') {
            if let Some((k, v)) = pair.split_once('=') {
                if k == "days" {
                    if let Ok(n) = v.parse::<i64>() {
                        return n.clamp(1, 400);
                    }
                }
            }
        }
    }
    7
}

fn write_http_response(stream: &mut TcpStream, status: &str, body: &str) {
    let response = format!(
        "HTTP/1.1 {status}\r\n\
         Content-Type: application/json; charset=utf-8\r\n\
         Access-Control-Allow-Origin: *\r\n\
         Access-Control-Allow-Methods: GET, POST, OPTIONS\r\n\
         Access-Control-Allow-Headers: Content-Type\r\n\
         Content-Length: {}\r\n\
         Connection: close\r\n\r\n{}",
        body.len(),
        body
    );
    let _ = stream.write_all(response.as_bytes());
    let _ = stream.flush();
}

fn read_http_request(stream: &mut TcpStream) -> Option<(String, String, String)> {
    let _ = stream.set_read_timeout(Some(Duration::from_millis(800)));
    let mut buf = Vec::with_capacity(4096);
    let mut chunk = [0u8; 2048];
    let mut header_end: Option<usize> = None;
    let mut content_length: usize = 0;

    loop {
        match stream.read(&mut chunk) {
            Ok(0) => break,
            Ok(n) => {
                buf.extend_from_slice(&chunk[..n]);
                if header_end.is_none() {
                    if let Some(pos) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
                        header_end = Some(pos + 4);
                        let headers_str = String::from_utf8_lossy(&buf[..pos]);
                        for line in headers_str.lines() {
                            if let Some((k, v)) = line.split_once(':') {
                                if k.trim().eq_ignore_ascii_case("content-length") {
                                    content_length = v.trim().parse::<usize>().unwrap_or(0);
                                }
                            }
                        }
                    }
                }
                if let Some(end) = header_end {
                    if buf.len() >= end + content_length {
                        break;
                    }
                }
                if buf.len() > 65_536 {
                    break;
                }
            }
            Err(_) => break,
        }
    }

    let end = header_end?;
    let header_str = String::from_utf8_lossy(&buf[..end - 4]);
    let mut lines = header_str.lines();
    let request_line = lines.next()?;
    let mut parts = request_line.split_whitespace();
    let method = parts.next()?.to_string();
    let path = parts.next()?.to_string();
    let body = String::from_utf8_lossy(&buf[end..buf.len().min(end + content_length)]).to_string();
    Some((method, path, body))
}

fn handle_client(mut stream: TcpStream) {
    let Some((method, path, body)) = read_http_request(&mut stream) else {
        return;
    };

    if method == "OPTIONS" {
        write_http_response(&mut stream, "204 No Content", "");
        return;
    }

    let route = path.split('?').next().unwrap_or(&path);

    match (method.as_str(), route) {
        ("GET", "/health") => {
            let status = bridge_status();
            let json = serde_json::json!({
                "ok": true,
                "app": "dhirna-desktop",
                "version": env!("CARGO_PKG_VERSION"),
                "extensionConnected": status.extension_connected,
                "connectedBrowser": status.connected_browser
            })
            .to_string();
            write_http_response(&mut stream, "200 OK", &json);
        }

        ("GET", "/goal") => {
            let goal = get_shared_goal();
            let desktop_window = find_open_goal_window(None);
            let json = serde_json::json!({
                "ok": true,
                "goal": goal,
                "desktopWindow": desktop_window
            })
            .to_string();
            write_http_response(&mut stream, "200 OK", &json);
        }

        ("POST", "/goal") => match serde_json::from_str::<GoalEnvelope>(&body) {
            Ok(env) => {
                if !env.browser.is_empty() {
                    note_extension_heartbeat(&env.browser);
                }
                let current = set_shared_goal(env.goal, true);
                let json = serde_json::json!({
                    "ok": true,
                    "goal": current
                })
                .to_string();
                write_http_response(&mut stream, "200 OK", &json);
            }
            Err(e) => {
                let json = serde_json::json!({ "ok": false, "error": e.to_string() }).to_string();
                write_http_response(&mut stream, "400 Bad Request", &json);
            }
        },

        ("POST", "/focus-goal") => {
            let payload =
                serde_json::from_str::<FocusGoalPayload>(&body).unwrap_or(FocusGoalPayload {
                    app: String::new(),
                    browser: String::new(),
                });
            if !payload.browser.is_empty() {
                note_extension_heartbeat(&payload.browser);
            }
            let pref = if payload.app.is_empty() {
                None
            } else {
                Some(payload.app.as_str())
            };
            let focused_win = focus_desktop_goal(pref);
            let json = serde_json::json!({
                "ok": true,
                "focused": focused_win.is_some(),
                "window": focused_win
            })
            .to_string();
            write_http_response(&mut stream, "200 OK", &json);
        }

        ("GET", "/shield") => {
            let shield = get_shared_shield();
            let diag = crate::shield::check_system_shield(&shield.provider);
            let json = serde_json::json!({
                "ok": true,
                "shield": shield,
                "diagnostic": diag
            })
            .to_string();
            write_http_response(&mut stream, "200 OK", &json);
        }

        ("POST", "/shield") => match serde_json::from_str::<ShieldEnvelope>(&body) {
            Ok(env) => {
                if !env.browser.is_empty() {
                    note_extension_heartbeat(&env.browser);
                }
                let current = set_shared_shield(env.shield, true);
                let json = serde_json::json!({
                    "ok": true,
                    "shield": current
                })
                .to_string();
                write_http_response(&mut stream, "200 OK", &json);
            }
            Err(e) => {
                let json = serde_json::json!({ "ok": false, "error": e.to_string() }).to_string();
                write_http_response(&mut stream, "400 Bad Request", &json);
            }
        },

        ("POST", "/mobile-qr") => {
            let payload =
                serde_json::from_str::<MobileQrPayload>(&body).unwrap_or(MobileQrPayload {
                    provider: String::new(),
                });
            let prov = if payload.provider.is_empty() {
                get_shared_shield().provider
            } else {
                payload.provider
            };
            let info = crate::mobile_qr::start_or_update_mobile_qr(&prov);
            let json = serde_json::json!({
                "ok": true,
                "available": info.available,
                "url": info.url,
                "ip": info.ip,
                "port": info.port,
                "provider": info.provider
            })
            .to_string();
            write_http_response(&mut stream, "200 OK", &json);
        }

        ("GET", "/dashboard") => {
            let days = parse_days_query(&path);
            match super::query_dashboard(days) {
                Ok(data) => {
                    let json = serde_json::to_string(&data).unwrap_or_else(|_| "{}".into());
                    write_http_response(&mut stream, "200 OK", &json);
                }
                Err(err) => {
                    let json = serde_json::json!({ "ok": false, "error": err }).to_string();
                    write_http_response(&mut stream, "500 Internal Server Error", &json);
                }
            }
        }

        ("POST", "/heartbeat") => {
            let parsed: HeartbeatPayload =
                serde_json::from_str(&body).unwrap_or(HeartbeatPayload {
                    browser: "chromium".into(),
                });
            let browser = if parsed.browser.is_empty() {
                "chromium"
            } else {
                &parsed.browser
            };
            note_extension_heartbeat(browser);
            write_http_response(&mut stream, "200 OK", r#"{"ok":true}"#);
        }

        ("POST", "/segment") => match serde_json::from_str::<SegmentPayload>(&body) {
            Ok(seg) => {
                let browser = if seg.browser.is_empty() {
                    "chromium"
                } else {
                    &seg.browser
                };
                note_extension_heartbeat(browser);
                super::record_completed_segment(
                    seg.started_at_ms,
                    seg.ended_at_ms,
                    seg.duration_ms,
                    browser,
                    &seg.domain,
                    &seg.kind,
                );
                write_http_response(&mut stream, "200 OK", r#"{"ok":true}"#);
            }
            Err(e) => {
                let json = serde_json::json!({ "ok": false, "error": e.to_string() }).to_string();
                write_http_response(&mut stream, "400 Bad Request", &json);
            }
        },

        ("POST", "/event") => match serde_json::from_str::<EventPayload>(&body) {
            Ok(ev) => {
                let browser = if ev.browser.is_empty() {
                    "chromium"
                } else {
                    &ev.browser
                };
                note_extension_heartbeat(browser);
                super::record_event(&ev.event_type, &ev.target, ev.meta_json);
                write_http_response(&mut stream, "200 OK", r#"{"ok":true}"#);
            }
            Err(e) => {
                let json = serde_json::json!({ "ok": false, "error": e.to_string() }).to_string();
                write_http_response(&mut stream, "400 Bad Request", &json);
            }
        },

        ("POST", "/session") => match serde_json::from_str::<SessionPayload>(&body) {
            Ok(sess) => {
                if !sess.browser.is_empty() {
                    note_extension_heartbeat(&sess.browser);
                }
                if sess.action == "start" {
                    super::start_session(sess.planned_ms);
                    set_focus_timer_state(
                        true,
                        if sess.planned_ms > 0 {
                            now_ms() + sess.planned_ms
                        } else {
                            0
                        },
                    );
                } else if sess.action == "end" {
                    let outcome = if sess.outcome.is_empty() {
                        "completed"
                    } else {
                        &sess.outcome
                    };
                    super::end_session(outcome);
                    set_focus_timer_state(false, 0);
                }
                write_http_response(&mut stream, "200 OK", r#"{"ok":true}"#);
            }
            Err(e) => {
                let json = serde_json::json!({ "ok": false, "error": e.to_string() }).to_string();
                write_http_response(&mut stream, "400 Bad Request", &json);
            }
        },

        ("GET", "/theme") => {
            let pref = get_shared_theme();
            let json = serde_json::json!({
                "ok": true,
                "theme": pref.theme,
                "updatedAtMs": pref.updated_at_ms
            })
            .to_string();
            write_http_response(&mut stream, "200 OK", &json);
        }

        ("POST", "/theme") => match serde_json::from_str::<ThemePref>(&body) {
            Ok(pref) => {
                let saved = set_shared_theme(pref);
                let json = serde_json::json!({
                    "ok": true,
                    "theme": saved.theme,
                    "updatedAtMs": saved.updated_at_ms
                })
                .to_string();
                write_http_response(&mut stream, "200 OK", &json);
            }
            Err(e) => {
                let json = serde_json::json!({ "ok": false, "error": e.to_string() }).to_string();
                write_http_response(&mut stream, "400 Bad Request", &json);
            }
        },

        ("POST", "/window/show") => {
            let mut shown = false;
            if let Some(app) = BRIDGE_APP.get() {
                if let Some(w) = app.get_webview_window("main") {
                    let _ = w.unminimize();
                    let _ = w.show();
                    let _ = w.set_focus();
                    shown = true;
                }
            }
            let json = serde_json::json!({ "ok": true, "shown": shown }).to_string();
            write_http_response(&mut stream, "200 OK", &json);
        }

        ("POST", "/reset") => match super::reset_all() {
            Ok(()) => write_http_response(&mut stream, "200 OK", r#"{"ok":true}"#),
            Err(err) => {
                let json = serde_json::json!({ "ok": false, "error": err }).to_string();
                write_http_response(&mut stream, "500 Internal Server Error", &json);
            }
        },

        _ => {
            write_http_response(
                &mut stream,
                "404 Not Found",
                r#"{"ok":false,"error":"Not found"}"#,
            );
        }
    }
}

pub fn spawn_bridge(app: Option<AppHandle>) -> Result<(), String> {
    if let Some(handle) = app {
        let _ = BRIDGE_APP.set(handle);
    }
    if BRIDGE_RUNNING.load(Ordering::SeqCst) {
        return Ok(());
    }
    let addr = format!("127.0.0.1:{BRIDGE_PORT}");
    let listener = TcpListener::bind(&addr).map_err(|e| format!("Bridge bind {addr} failed: {e}"))?;
    BRIDGE_RUNNING.store(true, Ordering::SeqCst);

    thread::Builder::new()
        .name("dhirna-local-bridge".into())
        .spawn(move || {
            for stream in listener.incoming().flatten() {
                thread::spawn(move || handle_client(stream));
            }
        })
        .map_err(|e| format!("Failed to spawn bridge thread: {e}"))?;

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_days_query_and_clamps_range() {
        assert_eq!(parse_days_query("/dashboard?days=1"), 1);
        assert_eq!(parse_days_query("/dashboard?days=30"), 30);
        assert_eq!(parse_days_query("/dashboard?days=9999"), 400);
        assert_eq!(parse_days_query("/dashboard"), 7);
    }

    #[test]
    fn deduplicates_chromium_browsers_only_while_extension_heartbeat_is_fresh() {
        note_extension_heartbeat("brave");
        assert!(is_extension_connected_at(now_ms()));
        assert!(should_defer_browser("brave-browser"));
        assert!(should_defer_browser("chrome.exe"));
        assert!(!should_defer_browser("code"));
        assert!(!should_defer_browser("discord"));
    }

    #[test]
    fn syncs_goal_using_latest_timestamp_wins() {
        let g1 = ActiveGoal {
            title: "Rapport".into(),
            target_type: "app".into(),
            site: String::new(),
            app: "code".into(),
            window_title: "VS Code".into(),
            updated_at_ms: 2000,
        };
        let older = ActiveGoal {
            title: "Old".into(),
            target_type: "site".into(),
            site: "overleaf.com".into(),
            app: String::new(),
            window_title: String::new(),
            updated_at_ms: 1000,
        };
        let newer = ActiveGoal {
            title: "Coder API".into(),
            target_type: "both".into(),
            site: "github.com".into(),
            app: "code".into(),
            window_title: String::new(),
            updated_at_ms: 3000,
        };

        let _ = set_shared_goal(None, false);
        assert_eq!(set_shared_goal(Some(g1.clone()), false), Some(g1.clone()));
        assert_eq!(set_shared_goal(Some(older), false), Some(g1));
        assert_eq!(set_shared_goal(Some(newer.clone()), false), Some(newer));
        assert_eq!(set_shared_goal(None, false), None);
    }

    #[test]
    fn syncs_shield_config_using_latest_timestamp_wins() {
        let s1 = ShieldConfig {
            enabled: true,
            provider: "cleanbrowsing".into(),
            safe_search: true,
            youtube_restricted: false,
            no_reels: true,
            lock_until_ms: None,
            updated_at_ms: 5000,
        };
        let older = ShieldConfig {
            enabled: false,
            provider: "cloudflare".into(),
            safe_search: true,
            youtube_restricted: false,
            no_reels: true,
            lock_until_ms: None,
            updated_at_ms: 1000,
        };
        let newer = ShieldConfig {
            enabled: true,
            provider: "adguard".into(),
            safe_search: true,
            youtube_restricted: true,
            no_reels: false,
            lock_until_ms: Some(9_999_999),
            updated_at_ms: 8000,
        };
        if let Ok(mut g) = SHARED_SHIELD.lock() {
            *g = ShieldConfig::default_const();
        }
        assert_eq!(set_shared_shield(s1.clone(), false), s1);
        assert_eq!(set_shared_shield(older, false), s1);
        assert_eq!(set_shared_shield(newer.clone(), false), newer);
    }

    #[test]
    fn syncs_theme_using_latest_timestamp_wins() {
        if let Ok(mut g) = SHARED_THEME.lock() {
            *g = ThemePref::default_const();
        }
        let light = set_shared_theme(ThemePref {
            theme: "light".into(),
            updated_at_ms: 5000,
        });
        assert_eq!(light.theme, "light");
        let stale = set_shared_theme(ThemePref {
            theme: "dark".into(),
            updated_at_ms: 1000,
        });
        assert_eq!(stale.theme, "light");
        let fresh = set_shared_theme(ThemePref {
            theme: "dark".into(),
            updated_at_ms: 9000,
        });
        assert_eq!(fresh.theme, "dark");
    }
}
