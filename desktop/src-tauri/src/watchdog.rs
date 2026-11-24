//! Crash-recovery watchdog & CLI flags (`--kill`, `--safe-mode`, and internal Win32 UAC helpers).

use crate::analytics::writer::now_ms;
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
#[cfg(target_os = "linux")]
use std::process::Command;
use std::sync::atomic::{AtomicBool, Ordering};
use std::thread;
use std::time::Duration;

static SAFE_MODE: AtomicBool = AtomicBool::new(false);
static WATCHDOG_RUNNING: AtomicBool = AtomicBool::new(false);

pub const STALE_HEARTBEAT_MS: i64 = 30_000;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CliMode {
    Normal,
    Kill,
    SafeMode,
    Help,
    InternalApplyHosts(PathBuf),
    InternalApplyShield { mode: String, tmp_hosts: PathBuf },
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WatchdogState {
    pub pid: u32,
    pub blocking_active: bool,
    pub safe_mode: bool,
    pub heartbeat_ms: i64,
    pub version: String,
}

pub fn parse_cli_flags<I, S>(args: I) -> CliMode
where
    I: IntoIterator<Item = S>,
    S: AsRef<str>,
{
    let vec: Vec<String> = args.into_iter().map(|s| s.as_ref().to_string()).collect();
    let mut i = 1usize;
    while i < vec.len() {
        match vec[i].trim() {
            "--kill" | "-k" | "--emergency-stop" => return CliMode::Kill,
            "--safe-mode" | "--no-block" => return CliMode::SafeMode,
            "--help" | "-h" => return CliMode::Help,
            "--internal-apply-hosts" => {
                if let Some(p) = vec.get(i + 1) {
                    return CliMode::InternalApplyHosts(PathBuf::from(p));
                }
            }
            "--internal-apply-shield" => {
                if let (Some(mode), Some(p)) = (vec.get(i + 1), vec.get(i + 2)) {
                    return CliMode::InternalApplyShield {
                        mode: mode.clone(),
                        tmp_hosts: PathBuf::from(p),
                    };
                }
            }
            _ => {}
        }
        i += 1;
    }
    CliMode::Normal
}

pub fn set_safe_mode(enabled: bool) {
    SAFE_MODE.store(enabled, Ordering::SeqCst);
}

pub fn is_safe_mode() -> bool {
    SAFE_MODE.load(Ordering::SeqCst)
}

pub fn watchdog_file_path() -> PathBuf {
    #[cfg(target_os = "windows")]
    {
        if let Ok(appdata) = std::env::var("APPDATA") {
            return PathBuf::from(appdata)
                .join("Dhirna")
                .join("dhirna_watchdog.json");
        }
    }
    if let Ok(xdg) = std::env::var("XDG_CONFIG_HOME") {
        if !xdg.trim().is_empty() {
            return PathBuf::from(xdg)
                .join("dhirna")
                .join("dhirna_watchdog.json");
        }
    }
    if let Ok(home) = std::env::var("HOME") {
        return PathBuf::from(home)
            .join(".config")
            .join("dhirna")
            .join("dhirna_watchdog.json");
    }
    std::env::temp_dir().join("dhirna_watchdog.json")
}

pub fn write_watchdog_state_at(path: &Path, state: &WatchdogState) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("watchdog dir error: {e}"))?;
    }
    let json = serde_json::to_string_pretty(state).map_err(|e| e.to_string())?;
    fs::write(path, json).map_err(|e| format!("watchdog write error: {e}"))
}

pub fn read_watchdog_state_at(path: &Path) -> Option<WatchdogState> {
    let raw = fs::read_to_string(path).ok()?;
    serde_json::from_str(&raw).ok()
}

pub fn is_stale_blocking_crash(
    prev: &WatchdogState,
    current_pid: u32,
    now: i64,
    prev_pid_alive: bool,
) -> bool {
    if !prev.blocking_active || prev.pid == current_pid {
        return false;
    }
    !prev_pid_alive || now.saturating_sub(prev.heartbeat_ms) > STALE_HEARTBEAT_MS
}

fn is_pid_alive(pid: u32) -> bool {
    if pid == 0 {
        return false;
    }
    #[cfg(target_os = "linux")]
    {
        Path::new(&format!("/proc/{pid}")).exists()
    }
    #[cfg(target_os = "windows")]
    {
        let mut sys = sysinfo::System::new();
        let sys_pid = sysinfo::Pid::from_u32(pid);
        sys.refresh_pids_specifics(&[sys_pid], sysinfo::ProcessRefreshKind::new());
        sys.process(sys_pid).is_some()
    }
    #[cfg(not(any(target_os = "linux", target_os = "windows")))]
    {
        let _ = pid;
        false
    }
}

pub fn recover_from_stale_crash_if_needed() -> bool {
    let path = watchdog_file_path();
    let Some(prev) = read_watchdog_state_at(&path) else {
        return false;
    };
    let current_pid = std::process::id();
    let alive = is_pid_alive(prev.pid);
    if !is_stale_blocking_crash(&prev, current_pid, now_ms(), alive) {
        return false;
    }

    eprintln!(
        "[Dhirna Watchdog] Unclean previous exit detected (pid={}). Clearing stuck blocking locks.",
        prev.pid
    );
    crate::analytics::bridge::set_focus_timer_state(false, 0);
    let _ = fs::remove_file(&path);
    true
}

pub fn clear_watchdog_on_clean_exit() {
    let path = watchdog_file_path();
    let _ = fs::remove_file(path);
}

pub fn spawn_watchdog_heartbeat() {
    if WATCHDOG_RUNNING.swap(true, Ordering::SeqCst) {
        return;
    }
    let _ = thread::Builder::new()
        .name("dhirna-watchdog-hb".into())
        .spawn(|| {
            let path = watchdog_file_path();
            let pid = std::process::id();
            loop {
                let (focus_active, _) = crate::analytics::bridge::get_focus_timer_state();
                let shield = crate::analytics::bridge::get_shared_shield();
                let state = WatchdogState {
                    pid,
                    blocking_active: !is_safe_mode() && (focus_active || shield.enabled),
                    safe_mode: is_safe_mode(),
                    heartbeat_ms: now_ms(),
                    version: env!("CARGO_PKG_VERSION").to_string(),
                };
                let _ = write_watchdog_state_at(&path, &state);
                thread::sleep(Duration::from_secs(5));
            }
        });
}

pub fn execute_cli_kill() -> Result<String, String> {
    let mut actions: Vec<String> = Vec::new();

    match crate::shield::set_anti_uninstall_guardian(false) {
        Ok(msg) => actions.push(msg),
        Err(err) => actions.push(format!("Guardian cleanup note: {err}")),
    }

    #[cfg(target_os = "linux")]
    {
        let _ = Command::new("systemctl")
            .args(["--user", "stop", "dhirna-guardian.service"])
            .output();
    }

    let my_pid = std::process::id();
    let mut killed_pids = Vec::new();
    let mut sys = sysinfo::System::new();
    sys.refresh_processes_specifics(sysinfo::ProcessRefreshKind::new());
    for (pid, proc_info) in sys.processes() {
        let p_u32 = pid.as_u32();
        if p_u32 == my_pid {
            continue;
        }
        let name = proc_info.name().to_ascii_lowercase();
        if name.contains("dhirna-desktop") || name == "dhirna" {
            if proc_info.kill() {
                killed_pids.push(p_u32);
            }
        }
    }
    if killed_pids.is_empty() {
        actions.push("Aucun autre processus dhirna-desktop actif.".into());
    } else {
        actions.push(format!("Processus arrêtés : {:?}.", killed_pids));
    }

    let path = watchdog_file_path();
    if path.exists() {
        let _ = fs::remove_file(&path);
        actions.push("Verrou watchdog supprimé.".into());
    }

    let hosts_path = crate::hosts::system_hosts_path();
    if let Ok(content) = fs::read_to_string(&hosts_path) {
        let cleaned = crate::hosts::remove_dhirna_block(&content);
        if cleaned != content {
            if fs::write(&hosts_path, &cleaned).is_ok() {
                actions.push(format!("Bloc Dhirna retiré de {}.", hosts_path.display()));
            } else {
                actions.push(format!(
                    "Bloc Dhirna encore présent dans {} (relancez dhirna-desktop --kill en administrateur).",
                    hosts_path.display()
                ));
            }
        }
    }

    Ok(actions.join("\n"))
}

pub fn print_cli_help() {
    println!(
        "Dhirna Desktop v{}\n\
         Usage: dhirna-desktop [OPTION]\n\n\
         Options:\n\
         \x20 --safe-mode     Démarre Dhirna sans aucun blocage, overlay ni verrouillage\n\
         \x20 --kill          Arrête d'urgence Dhirna, désactive le gardien et nettoie les verrous\n\
         \x20 --help          Affiche cette aide\n",
        env!("CARGO_PKG_VERSION")
    );
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_kill_safe_mode_help_and_internal_flags() {
        assert_eq!(parse_cli_flags(["dhirna-desktop"]), CliMode::Normal);
        assert_eq!(parse_cli_flags(["dhirna-desktop", "--kill"]), CliMode::Kill);
        assert_eq!(parse_cli_flags(["dhirna-desktop", "-k"]), CliMode::Kill);
        assert_eq!(parse_cli_flags(["dhirna-desktop", "--safe-mode"]), CliMode::SafeMode);
        assert_eq!(parse_cli_flags(["dhirna-desktop", "--help"]), CliMode::Help);
        assert_eq!(
            parse_cli_flags(["dhirna-desktop", "--internal-apply-hosts", "/tmp/h"]),
            CliMode::InternalApplyHosts(PathBuf::from("/tmp/h"))
        );
    }

    #[test]
    fn detects_stale_blocking_crash_and_writes_reads_watchdog_state() {
        let prev = WatchdogState {
            pid: 99999,
            blocking_active: true,
            safe_mode: false,
            heartbeat_ms: 100_000,
            version: "1.0.0".into(),
        };
        assert!(is_stale_blocking_crash(&prev, 12345, 105_000, false));
        assert!(!is_stale_blocking_crash(&prev, 12345, 110_000, true));
        assert!(is_stale_blocking_crash(&prev, 12345, 140_000, true));
        assert!(!is_stale_blocking_crash(&prev, 99999, 140_000, false));
        let idle_prev = WatchdogState {
            blocking_active: false,
            ..prev.clone()
        };
        assert!(!is_stale_blocking_crash(&idle_prev, 12345, 140_000, false));

        let tmp = std::env::temp_dir().join(format!("dhirna_wd_test_{}.json", std::process::id()));
        write_watchdog_state_at(&tmp, &prev).unwrap();
        let loaded = read_watchdog_state_at(&tmp).unwrap();
        assert_eq!(loaded, prev);
        let _ = fs::remove_file(&tmp);
    }
}
