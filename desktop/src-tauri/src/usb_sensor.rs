//! Auto-supervised USB Reels & Distraction Detector for Dhirna (iOS + Android).
//! - Android USB: 100% native read-only Rust `adb` foreground window inspection (`CREATE_NO_WINDOW` on Windows).
//! - iPhone USB: Auto-managed `ios_usb_bridge.py` subprocess over `stdout` JSONL (`0` network ports, `0` manual daemon).
//! - Fail-safe: If an enrolled USB phone is unplugged mid-session, cuts alarm immediately and signals `sensorLost`.

use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, OnceLock};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, Manager};

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

#[cfg(target_os = "windows")]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

const IOS_BRIDGE_SOURCE: &str = include_str!("ios_usb_bridge.py");
const SENSOR_LOST_GRACE_MS: u128 = 2_600;

static SUPERVISOR_STARTED: AtomicBool = AtomicBool::new(false);
static USB_GUARD_ENABLED: AtomicBool = AtomicBool::new(true);
static FOCUS_SESSION_ACTIVE: AtomicBool = AtomicBool::new(false);
static BOOT_SALT: OnceLock<u64> = OnceLock::new();
static APP_HANDLE_CELL: OnceLock<AppHandle> = OnceLock::new();

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct UsbDeviceReading {
    pub id: String,
    pub platform: String,
    pub health: String,
    pub active: bool,
    pub app: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct UsbSensorStatus {
    pub enabled: bool,
    pub ios_driver_ready: bool,
    pub ios_hardware_present: bool,
    pub healthy_count: usize,
    pub untrusted_count: usize,
    pub active_distraction: Option<String>,
    pub sensor_lost: bool,
    pub devices: Vec<UsbDeviceReading>,
}

impl Default for UsbSensorStatus {
    fn default() -> Self {
        Self {
            enabled: true,
            ios_driver_ready: false,
            ios_hardware_present: false,
            healthy_count: 0,
            untrusted_count: 0,
            active_distraction: None,
            sensor_lost: false,
            devices: Vec::new(),
        }
    }
}

struct UsbState {
    ios_devices: Vec<UsbDeviceReading>,
    android_devices: Vec<UsbDeviceReading>,
    watched_apps: HashSet<String>,
    ios_driver_ready: bool,
    ios_hardware_present: bool,
    enrolled_last_ok: HashMap<String, Instant>,
    last_emitted: Option<UsbSensorStatus>,
}

fn default_watched_apps() -> HashSet<String> {
    [
        "instagram",
        "tiktok",
        "snapchat",
        "facebook",
        "x",
        "reddit",
        "shorts",
    ]
    .into_iter()
    .map(ToString::to_string)
    .collect()
}

impl UsbState {
    fn new() -> Self {
        Self {
            ios_devices: Vec::new(),
            android_devices: Vec::new(),
            watched_apps: default_watched_apps(),
            ios_driver_ready: false,
            ios_hardware_present: false,
            enrolled_last_ok: HashMap::new(),
            last_emitted: None,
        }
    }
}

struct ActiveIosChild {
    child: Child,
    _stdin_guard: ChildStdin,
}

static USB_STATE: OnceLock<Mutex<UsbState>> = OnceLock::new();
static IOS_CHILD: Mutex<Option<ActiveIosChild>> = Mutex::new(None);

fn state_mutex() -> &'static Mutex<UsbState> {
    USB_STATE.get_or_init(|| Mutex::new(UsbState::new()))
}

fn configure_quiet_cmd(cmd: &mut Command) {
    #[cfg(target_os = "windows")]
    {
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    let _ = cmd;
}

fn anonymize_serial(prefix: &str, serial: &str) -> String {
    let salt = *BOOT_SALT.get_or_init(|| {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_nanos() as u64)
            .unwrap_or(0x9E37_79B9_7F4A_7C15)
    });
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325 ^ salt;
    for b in serial.as_bytes() {
        hash ^= *b as u64;
        hash = hash.wrapping_mul(0x0100_0000_01b3);
    }
    format!("{prefix}-{:06x}", hash & 0x00ff_ffff)
}

/// Pure parser for `adb devices` output. Ignores TCP/Wi-Fi (`ip:port`) entries if desired or keeps USB serials.
pub fn parse_adb_devices_output(output: &str) -> Vec<(String, &'static str)> {
    let mut out = Vec::new();
    for raw_line in output.lines() {
        let line = raw_line.trim();
        if line.is_empty() || line.starts_with("List of devices") || line.starts_with('*') {
            continue;
        }
        let mut parts = line.split_whitespace();
        let Some(serial) = parts.next() else {
            continue;
        };
        let Some(state) = parts.next() else {
            continue;
        };
        let mapped = match state {
            "device" => "ok",
            "unauthorized" | "authorizing" => "untrusted",
            _ => "error",
        };
        out.push((serial.to_string(), mapped));
    }
    out
}

/// Pure parser for `adb shell dumpsys window` output: returns `Some(app_key)`
/// only when the phone screen is awake/unlocked and a target social app is in the foreground.
pub fn parse_android_dumpsys_window(dump: &str) -> Option<&'static str> {
    for line in dump.lines() {
        let t = line.trim();
        if t.contains("mDreamingLockscreen=true")
            || t.contains("isStatusBarKeyguard=true")
            || t.contains("mShowingLockscreen=true")
            || t.contains("mAwake=false")
            || t.contains("mInteractive=false")
        {
            return None;
        }
    }

    for line in dump.lines() {
        let t = line.trim();
        if !(t.contains("mCurrentFocus")
            || t.contains("mFocusedApp")
            || t.contains("topResumedActivity")
            || t.contains("ResumedActivity"))
        {
            continue;
        }

        if t.contains("com.instagram.android") {
            return Some("instagram");
        }
        if t.contains("com.zhiliaoapp.musically") || t.contains("com.ss.android.ugc.trill") {
            return Some("tiktok");
        }
        if t.contains("com.snapchat.android") {
            return Some("snapchat");
        }
        if t.contains("com.facebook.katana") || t.contains("com.facebook.lite") {
            return Some("facebook");
        }
        if t.contains("com.twitter.android") {
            return Some("x");
        }
        if t.contains("com.reddit.frontpage") {
            return Some("reddit");
        }
        if t.contains("com.google.android.youtube")
            && (t.contains("ReelWatchActivity") || t.to_ascii_lowercase().contains("shorts"))
        {
            return Some("shorts");
        }
    }

    None
}

fn poll_android_usb() -> Vec<UsbDeviceReading> {
    let mut cmd = Command::new("adb");
    cmd.args(["devices"]);
    configure_quiet_cmd(&mut cmd);

    let Ok(out) = cmd.output() else {
        return Vec::new();
    };
    if !out.status.success() {
        return Vec::new();
    }

    let text = String::from_utf8_lossy(&out.stdout);
    let parsed = parse_adb_devices_output(&text);
    let mut readings = Vec::with_capacity(parsed.len());

    for (serial, health) in parsed {
        let dev_id = anonymize_serial("android", &serial);
        if health != "ok" {
            readings.push(UsbDeviceReading {
                id: dev_id,
                platform: "android".into(),
                health: health.into(),
                active: false,
                app: None,
            });
            continue;
        }

        let mut dump_cmd = Command::new("adb");
        dump_cmd.args(["-s", &serial, "shell", "dumpsys", "window"]);
        configure_quiet_cmd(&mut dump_cmd);

        match dump_cmd.output() {
            Ok(dump_out) if dump_out.status.success() => {
                let dump_str = String::from_utf8_lossy(&dump_out.stdout);
                let detected = parse_android_dumpsys_window(&dump_str);
                readings.push(UsbDeviceReading {
                    id: dev_id,
                    platform: "android".into(),
                    health: "ok".into(),
                    active: detected.is_some(),
                    app: detected.map(ToString::to_string),
                });
            }
            _ => {
                readings.push(UsbDeviceReading {
                    id: dev_id,
                    platform: "android".into(),
                    health: "error".into(),
                    active: false,
                    app: None,
                });
            }
        }
    }

    readings
}

/// Zero-shell detection of Apple USB hardware (`idVendor == 05ac` on Linux, usbmux port on Windows).
pub fn detect_apple_usb_hardware() -> bool {
    #[cfg(target_os = "linux")]
    {
        if let Ok(entries) = fs::read_dir("/sys/bus/usb/devices") {
            for entry in entries.flatten() {
                let vendor_path = entry.path().join("idVendor");
                if let Ok(v) = fs::read_to_string(vendor_path) {
                    if v.trim().eq_ignore_ascii_case("05ac") {
                        return true;
                    }
                }
            }
        }
        false
    }

    #[cfg(target_os = "windows")]
    {
        use std::net::{SocketAddr, TcpStream};
        let addr: SocketAddr = "127.0.0.1:27015".parse().expect("valid addr");
        TcpStream::connect_timeout(&addr, Duration::from_millis(45)).is_ok()
    }

    #[cfg(not(any(target_os = "linux", target_os = "windows")))]
    {
        false
    }
}

fn candidate_ios_pythons(app: &AppHandle) -> Vec<PathBuf> {
    let mut candidates = Vec::new();

    if let Ok(data_dir) = app.path().app_data_dir() {
        #[cfg(target_os = "windows")]
        candidates.push(data_dir.join("venv-ios").join("Scripts").join("python.exe"));
        #[cfg(not(target_os = "windows"))]
        candidates.push(data_dir.join("venv-ios").join("bin").join("python"));
    }

    #[cfg(not(target_os = "windows"))]
    if let Ok(home) = std::env::var("HOME") {
        let h = PathBuf::from(home);
        candidates.push(
            h.join(".local")
                .join("share")
                .join("dhirna")
                .join("venv-ios")
                .join("bin")
                .join("python"),
        );
        candidates.push(
            h.join(".local")
                .join("pipx")
                .join("venvs")
                .join("pymobiledevice3")
                .join("bin")
                .join("python"),
        );
    }

    #[cfg(target_os = "windows")]
    {
        candidates.push(PathBuf::from("python"));
    }
    #[cfg(not(target_os = "windows"))]
    {
        candidates.push(PathBuf::from("python3"));
    }

    candidates
}

fn python_has_pymobiledevice3(python_bin: &Path) -> bool {
    if python_bin.components().count() > 1 && !python_bin.exists() {
        return false;
    }
    let mut cmd = Command::new(python_bin);
    cmd.args(["-c", "import pymobiledevice3"]);
    cmd.stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    configure_quiet_cmd(&mut cmd);
    cmd.status().map(|s| s.success()).unwrap_or(false)
}

fn resolve_ios_python(app: &AppHandle) -> Option<PathBuf> {
    candidate_ios_pythons(app)
        .into_iter()
        .find(|p| python_has_pymobiledevice3(p))
}

fn write_ios_bridge_script(app: &AppHandle) -> Result<PathBuf, String> {
    let base = app
        .path()
        .app_data_dir()
        .or_else(|_| app.path().app_config_dir())
        .map_err(|e| format!("Cannot resolve Dhirna data dir: {e}"))?;
    fs::create_dir_all(&base).map_err(|e| format!("Cannot create Dhirna data dir: {e}"))?;
    let script_path = base.join("ios_usb_bridge.py");
    let should_write = match fs::read_to_string(&script_path) {
        Ok(existing) => existing != IOS_BRIDGE_SOURCE,
        Err(_) => true,
    };
    if should_write {
        fs::write(&script_path, IOS_BRIDGE_SOURCE)
            .map_err(|e| format!("Cannot write ios_usb_bridge.py: {e}"))?;
    }
    Ok(script_path)
}

fn stop_ios_bridge_child() {
    if let Ok(mut guard) = IOS_CHILD.lock() {
        if let Some(mut active) = guard.take() {
            let _ = active.child.kill();
            let _ = active.child.wait();
        }
    }
    if let Ok(mut st) = state_mutex().lock() {
        st.ios_devices.clear();
    }
}

fn ensure_ios_bridge_running(app: &AppHandle) {
    if !USB_GUARD_ENABLED.load(Ordering::SeqCst) {
        stop_ios_bridge_child();
        return;
    }

    if let Ok(mut guard) = IOS_CHILD.lock() {
        if let Some(active) = guard.as_mut() {
            if let Ok(None) = active.child.try_wait() {
                return; // Still running cleanly
            }
        }
        *guard = None;
    }

    let Some(py_bin) = resolve_ios_python(app) else {
        if let Ok(mut st) = state_mutex().lock() {
            st.ios_driver_ready = false;
            st.ios_devices.clear();
        }
        return;
    };

    if let Ok(mut st) = state_mutex().lock() {
        st.ios_driver_ready = true;
    }

    let Ok(script_path) = write_ios_bridge_script(app) else {
        return;
    };

    let mut cmd = Command::new(&py_bin);
    cmd.arg("-u")
        .arg(&script_path)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    configure_quiet_cmd(&mut cmd);

    let Ok(mut child) = cmd.spawn() else {
        return;
    };
    let Some(stdin_guard) = child.stdin.take() else {
        let _ = child.kill();
        return;
    };
    let Some(stdout) = child.stdout.take() else {
        let _ = child.kill();
        return;
    };

    if let Ok(mut guard) = IOS_CHILD.lock() {
        *guard = Some(ActiveIosChild {
            child,
            _stdin_guard: stdin_guard,
        });
    }

    thread::spawn(move || {
        let reader = BufReader::new(stdout);
        for line in reader.lines().map_while(Result::ok) {
            if let Ok(val) = serde_json::from_str::<serde_json::Value>(&line) {
                if val.get("type").and_then(|t| t.as_str()) == Some("ios_snapshot") {
                    if let Some(arr) = val.get("devices") {
                        if let Ok(devs) = serde_json::from_value::<Vec<UsbDeviceReading>>(arr.clone())
                        {
                            if let Ok(mut st) = state_mutex().lock() {
                                st.ios_devices = devs;
                            }
                            recompute_and_emit(false);
                        }
                    }
                }
            }
        }
    });
}

fn compute_status_locked(st: &mut UsbState, now: Instant) -> UsbSensorStatus {
    let enabled = USB_GUARD_ENABLED.load(Ordering::SeqCst);
    let focus_active = FOCUS_SESSION_ACTIVE.load(Ordering::SeqCst);

    if !enabled {
        st.enrolled_last_ok.clear();
        return UsbSensorStatus {
            enabled: false,
            ios_driver_ready: st.ios_driver_ready,
            ios_hardware_present: st.ios_hardware_present,
            healthy_count: 0,
            untrusted_count: 0,
            active_distraction: None,
            sensor_lost: false,
            devices: Vec::new(),
        };
    }

    let mut all_devices = Vec::with_capacity(st.ios_devices.len() + st.android_devices.len());
    all_devices.extend(st.ios_devices.iter().cloned());
    all_devices.extend(st.android_devices.iter().cloned());

    let healthy_count = all_devices.iter().filter(|d| d.health == "ok").count();
    let untrusted_count = all_devices
        .iter()
        .filter(|d| d.health == "untrusted")
        .count();

    if focus_active {
        for d in &all_devices {
            if d.health == "ok" {
                st.enrolled_last_ok.insert(d.id.clone(), now);
            }
        }
    } else {
        st.enrolled_last_ok.clear();
    }

    let sensor_lost = if focus_active && !st.enrolled_last_ok.is_empty() {
        st.enrolled_last_ok.iter().any(|(id, last_ok)| {
            let currently_ok = all_devices.iter().any(|d| &d.id == id && d.health == "ok");
            !currently_ok && now.duration_since(*last_ok).as_millis() > SENSOR_LOST_GRACE_MS
        })
    } else {
        false
    };

    let active_distraction = if sensor_lost {
        None
    } else {
        all_devices
            .iter()
            .find(|d| {
                d.health == "ok"
                    && d.active
                    && d.app
                        .as_deref()
                        .map(|a| st.watched_apps.contains(a))
                        .unwrap_or(false)
            })
            .and_then(|d| d.app.clone())
    };

    UsbSensorStatus {
        enabled: true,
        ios_driver_ready: st.ios_driver_ready,
        ios_hardware_present: st.ios_hardware_present,
        healthy_count,
        untrusted_count,
        active_distraction,
        sensor_lost,
        devices: all_devices,
    }
}

fn recompute_and_emit(force_emit: bool) -> UsbSensorStatus {
    let status = {
        let Ok(mut st) = state_mutex().lock() else {
            return UsbSensorStatus::default();
        };
        let next = compute_status_locked(&mut st, Instant::now());
        let changed = st.last_emitted.as_ref() != Some(&next);
        if changed || force_emit {
            st.last_emitted = Some(next.clone());
            if let Some(app) = APP_HANDLE_CELL.get() {
                let _ = app.emit("usb-sensor-status", &next);
            }
        }
        next
    };
    status
}

pub fn get_status() -> UsbSensorStatus {
    let Ok(mut st) = state_mutex().lock() else {
        return UsbSensorStatus::default();
    };
    compute_status_locked(&mut st, Instant::now())
}

pub fn set_enabled(app: &AppHandle, enable: bool) -> UsbSensorStatus {
    USB_GUARD_ENABLED.store(enable, Ordering::SeqCst);
    if !enable {
        stop_ios_bridge_child();
        if let Ok(mut st) = state_mutex().lock() {
            st.android_devices.clear();
            st.enrolled_last_ok.clear();
        }
    } else {
        ensure_ios_bridge_running(app);
    }
    recompute_and_emit(true)
}

pub fn set_config(app: &AppHandle, enable: bool, watched_apps: Option<Vec<String>>) -> UsbSensorStatus {
    if let Some(apps) = watched_apps {
        if let Ok(mut st) = state_mutex().lock() {
            st.watched_apps = apps
                .into_iter()
                .map(|s| s.trim().to_ascii_lowercase())
                .filter(|s| !s.is_empty())
                .collect();
        }
    }
    set_enabled(app, enable)
}

pub fn set_focus_session_active(active: bool) {
    let prev = FOCUS_SESSION_ACTIVE.swap(active, Ordering::SeqCst);
    if prev != active {
        recompute_and_emit(true);
    }
}

pub fn shutdown_usb_sensor() {
    USB_GUARD_ENABLED.store(false, Ordering::SeqCst);
    stop_ios_bridge_child();
}

/// One-click installer for the isolated iOS USB driver venv (`<appData>/venv-ios`) via `uv` or `python -m venv`.
pub fn install_ios_usb_driver(app: &AppHandle) -> Result<UsbSensorStatus, String> {
    if resolve_ios_python(app).is_some() {
        ensure_ios_bridge_running(app);
        return Ok(recompute_and_emit(true));
    }

    let base = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Cannot resolve Dhirna data dir: {e}"))?;
    fs::create_dir_all(&base).map_err(|e| format!("Cannot create Dhirna data dir: {e}"))?;
    let venv_dir = base.join("venv-ios");

    // Try fast `uv` first if present, otherwise standard `python3 -m venv` / `python -m venv`
    let mut uv_bins = vec![PathBuf::from("uv")];
    #[cfg(not(target_os = "windows"))]
    if let Ok(home) = std::env::var("HOME") {
        uv_bins.insert(0, PathBuf::from(home).join(".local/bin/uv"));
    }

    let mut installed_with_uv = false;
    for uv in uv_bins {
        let mut mk = Command::new(&uv);
        mk.args(["venv", "--clear"]).arg(&venv_dir);
        configure_quiet_cmd(&mut mk);
        if mk.status().map(|s| s.success()).unwrap_or(false) {
            #[cfg(target_os = "windows")]
            let venv_py = venv_dir.join("Scripts").join("python.exe");
            #[cfg(not(target_os = "windows"))]
            let venv_py = venv_dir.join("bin").join("python");

            let mut pip = Command::new(&uv);
            pip.args(["pip", "install", "--python"])
                .arg(&venv_py)
                .arg("pymobiledevice3");
            configure_quiet_cmd(&mut pip);
            if pip.status().map(|s| s.success()).unwrap_or(false) {
                installed_with_uv = true;
                break;
            }
        }
    }

    if !installed_with_uv {
        #[cfg(target_os = "windows")]
        let sys_py = "python";
        #[cfg(not(target_os = "windows"))]
        let sys_py = "python3";

        let mut mk = Command::new(sys_py);
        mk.args(["-m", "venv"]).arg(&venv_dir);
        configure_quiet_cmd(&mut mk);
        let st = mk
            .status()
            .map_err(|e| format!("Python 3 introuvable ({e}). Installez Python 3.10+ puis réessayez."))?;
        if !st.success() {
            return Err("Échec de création de l'environnement Python venv-ios.".into());
        }

        #[cfg(target_os = "windows")]
        let venv_py = venv_dir.join("Scripts").join("python.exe");
        #[cfg(not(target_os = "windows"))]
        let venv_py = venv_dir.join("bin").join("python");

        let mut pip = Command::new(&venv_py);
        pip.args(["-m", "pip", "install", "--upgrade", "pymobiledevice3"]);
        configure_quiet_cmd(&mut pip);
        let pst = pip
            .status()
            .map_err(|e| format!("Échec d'exécution de pip: {e}"))?;
        if !pst.success() {
            return Err("Échec d'installation de pymobiledevice3 via pip.".into());
        }
    }

    ensure_ios_bridge_running(app);
    Ok(recompute_and_emit(true))
}

pub fn start_usb_sensor_supervisor(app: AppHandle) {
    if SUPERVISOR_STARTED.swap(true, Ordering::SeqCst) {
        return;
    }
    let _ = APP_HANDLE_CELL.set(app.clone());

    thread::spawn(move || {
        loop {
            if USB_GUARD_ENABLED.load(Ordering::SeqCst) && !crate::watchdog::is_safe_mode() {
                let apple_hw = detect_apple_usb_hardware();
                let android_devs = poll_android_usb();
                if let Ok(mut st) = state_mutex().lock() {
                    st.ios_hardware_present = apple_hw;
                    st.android_devices = android_devs;
                }
                ensure_ios_bridge_running(&app);
                recompute_and_emit(false);
            } else {
                stop_ios_bridge_child();
            }
            thread::sleep(Duration::from_millis(1200));
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_adb_devices_authorized_and_unauthorized() {
        let sample = "List of devices attached\n\
                      R58M42ABCDE\tdevice usb:1-2 product:panther model:Pixel_7\n\
                      99121FFAZ00\tunauthorized usb:1-3 transport_id:4\n";
        let res = parse_adb_devices_output(sample);
        assert_eq!(
            res,
            vec![
                ("R58M42ABCDE".to_string(), "ok"),
                ("99121FFAZ00".to_string(), "untrusted"),
            ]
        );
    }

    #[test]
    fn parses_android_dumpsys_foreground_and_respects_lockscreen() {
        let ig_open = "  mDreamingLockscreen=false\n  mCurrentFocus=Window{41a u0 com.instagram.android/com.instagram.mainactivity.InstagramMainActivity}\n";
        assert_eq!(parse_android_dumpsys_window(ig_open), Some("instagram"));

        let tiktok_open = "  isStatusBarKeyguard=false\n  topResumedActivity=ActivityRecord{8b2 u0 com.zhiliaoapp.musically/com.ss.android.ugc.aweme.splash.SplashActivity t42}\n";
        assert_eq!(parse_android_dumpsys_window(tiktok_open), Some("tiktok"));

        let snap_open = "  mCurrentFocus=Window{22b u0 com.snapchat.android/com.snap.mushroom.MainActivity}\n";
        assert_eq!(parse_android_dumpsys_window(snap_open), Some("snapchat"));

        let fb_open = "  mCurrentFocus=Window{33c u0 com.facebook.katana/com.facebook.katana.activity.FbMainTabActivity}\n";
        assert_eq!(parse_android_dumpsys_window(fb_open), Some("facebook"));

        let x_open = "  mCurrentFocus=Window{44d u0 com.twitter.android/com.twitter.app.main.MainActivity}\n";
        assert_eq!(parse_android_dumpsys_window(x_open), Some("x"));

        let reddit_open = "  mCurrentFocus=Window{55e u0 com.reddit.frontpage/com.reddit.launch.main.MainActivity}\n";
        assert_eq!(parse_android_dumpsys_window(reddit_open), Some("reddit"));

        let yt_shorts = "  mCurrentFocus=Window{99c u0 com.google.android.youtube/com.google.android.apps.youtube.app.extensions.reel.watch.activity.ReelWatchActivity}\n";
        assert_eq!(parse_android_dumpsys_window(yt_shorts), Some("shorts"));

        let yt_regular = "  mCurrentFocus=Window{99c u0 com.google.android.youtube/com.google.android.apps.youtube.app.watchwhile.WatchWhileActivity}\n";
        assert_eq!(parse_android_dumpsys_window(yt_regular), None);

        let locked_ig = "  mDreamingLockscreen=true\n  mCurrentFocus=Window{41a u0 com.instagram.android/com.instagram.mainactivity.InstagramMainActivity}\n";
        assert_eq!(parse_android_dumpsys_window(locked_ig), None);

        let asleep_snap = "  mAwake=false\n  mCurrentFocus=Window{22b u0 com.snapchat.android/com.snap.mushroom.MainActivity}\n";
        assert_eq!(parse_android_dumpsys_window(asleep_snap), None);
    }

    #[test]
    fn marks_sensor_lost_when_enrolled_phone_disconnects_during_active_session() {
        USB_GUARD_ENABLED.store(true, Ordering::SeqCst);
        FOCUS_SESSION_ACTIVE.store(true, Ordering::SeqCst);

        let mut st = UsbState::new();
        let t0 = Instant::now();
        st.ios_devices = vec![UsbDeviceReading {
            id: "ios-112233".into(),
            platform: "ios".into(),
            health: "ok".into(),
            active: true,
            app: Some("instagram".into()),
        }];

        let s1 = compute_status_locked(&mut st, t0);
        assert_eq!(s1.healthy_count, 1);
        assert_eq!(s1.active_distraction.as_deref(), Some("instagram"));
        assert!(!s1.sensor_lost);

        // Unplug phone -> after 3s grace, sensor_lost = true and active_distraction = None (fail-safe)
        st.ios_devices.clear();
        let s2 = compute_status_locked(&mut st, t0 + Duration::from_millis(3_000));
        assert!(s2.sensor_lost);
        assert_eq!(s2.active_distraction, None);

        FOCUS_SESSION_ACTIVE.store(false, Ordering::SeqCst);
    }
}
