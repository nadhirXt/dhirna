use crate::hosts::sync_system_hosts;
use crate::platform::{current_platform, kill_process_by_name, kill_process_by_pid, WinInfo};
use serde_json::Value;
use std::fs;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::thread;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager};

static INTERCEPTION_SEQ: AtomicU64 = AtomicU64::new(0);
static ACTIVE_OVERLAY: Mutex<Option<(u64, Value)>> = Mutex::new(None);
static ACTIVE_PRESENCE: Mutex<Option<Value>> = Mutex::new(None);
static ACTIVE_USB_ALARM: Mutex<Option<Value>> = Mutex::new(None);

fn state_file_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|e| format!("Cannot resolve config dir: {e}"))?;
    fs::create_dir_all(&dir).map_err(|e| format!("Cannot create config dir: {e}"))?;
    Ok(dir.join("dhirna_state.json"))
}

/// Executes the Dhirna close + return-to-work sequence on a native Rust thread
/// so it is never throttled by WebKit2GTK / WebView2 when the main window is hidden.
fn execute_return_native(app: &AppHandle, target_seq: Option<u64>) {
    let payload_opt = {
        let Ok(mut guard) = ACTIVE_OVERLAY.lock() else {
            return;
        };
        match (&*guard, target_seq) {
            (Some((seq, _)), Some(expected)) if *seq != expected => return,
            (Some(_), _) => guard.take().map(|(_, v)| v),
            (None, _) => None,
        }
    };

    let usb_alarm_active = ACTIVE_USB_ALARM
        .lock()
        .ok()
        .map(|g| g.is_some())
        .unwrap_or(false);
    if !usb_alarm_active {
        if let Some(win) = app.get_webview_window("overlay") {
            let _ = win.hide();
        }
    }

    let Some(ctx) = payload_opt else {
        return;
    };

    let app_clone = app.clone();
    thread::spawn(move || {
        thread::sleep(Duration::from_millis(160));

        let platform = current_platform();
        let kind = ctx
            .get("distractionKind")
            .and_then(|v| v.as_str())
            .unwrap_or("");
        let win_id = ctx
            .get("distractionWindowId")
            .and_then(|v| v.as_u64())
            .unwrap_or(0);
        let proc_name = ctx
            .get("distractionProcess")
            .and_then(|v| v.as_str())
            .unwrap_or("");
        let win_pid = ctx
            .get("distractionPid")
            .and_then(|v| v.as_u64())
            .unwrap_or(0) as u32;
        let should_kill = ctx
            .get("shouldKill")
            .and_then(|v| v.as_bool())
            .unwrap_or(true);
        let return_id = ctx
            .get("returnTarget")
            .and_then(|rt| rt.get("id"))
            .and_then(|v| v.as_u64())
            .unwrap_or(0);

        let mut action_ok = false;
        if kind == "distraction-site" && win_id > 0 {
            action_ok = platform.send_close_tab(win_id).is_ok();
        } else if kind == "distraction-app" {
            if should_kill {
                let mut killed = 0usize;
                if !proc_name.is_empty() {
                    killed += kill_process_by_name(proc_name).unwrap_or(0);
                }
                if win_pid > 0 {
                    killed += kill_process_by_pid(win_pid).unwrap_or(0);
                }
                if killed > 0 {
                    action_ok = true;
                } else if win_id > 0 {
                    action_ok = platform.close_window(win_id).is_ok();
                }
            } else if win_id > 0 {
                action_ok = platform.close_window(win_id).is_ok();
            }
        }

        let return_proc = ctx
            .get("returnTarget")
            .and_then(|rt| rt.get("processName"))
            .and_then(|v| v.as_str());
        let return_ok = if return_id > 0 {
            thread::sleep(Duration::from_millis(90));
            let focused_direct = platform.focus_window(return_id).is_ok();
            if platform.active_window().map(|w| w.id) == Some(return_id) {
                focused_direct || true
            } else {
                crate::analytics::bridge::focus_desktop_goal(return_proc).is_some()
            }
        } else {
            thread::sleep(Duration::from_millis(90));
            crate::analytics::bridge::focus_desktop_goal(return_proc).is_some()
        };

        let target_label = ctx
            .get("distractionLabel")
            .and_then(|v| v.as_str())
            .unwrap_or(proc_name);
        let meta = serde_json::json!({
            "kind": kind,
            "success": action_ok,
            "returned": return_ok
        })
        .to_string();
        crate::analytics::record_event("return_done", target_label, Some(meta));

        let _ = app_clone.emit("overlay-complete", &ctx);
    });
}

#[tauri::command]
pub async fn load_state(app: AppHandle) -> Result<Option<Value>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let path = state_file_path(&app)?;
        if !path.exists() {
            return Ok(None);
        }
        let raw = fs::read_to_string(&path).map_err(|e| e.to_string())?;
        let parsed: Value = serde_json::from_str(&raw).map_err(|e| e.to_string())?;
        Ok(Some(parsed))
    })
    .await
    .map_err(|e| format!("load_state task error: {e}"))?
}

#[tauri::command]
pub async fn save_state(app: AppHandle, state: Value) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let path = state_file_path(&app)?;
        let pretty = serde_json::to_string_pretty(&state).map_err(|e| e.to_string())?;
        fs::write(&path, pretty).map_err(|e| e.to_string())?;
        let _ = app.emit("state-updated", &state);
        Ok(())
    })
    .await
    .map_err(|e| format!("save_state task error: {e}"))?
}

#[tauri::command]
pub async fn list_windows() -> Vec<WinInfo> {
    tauri::async_runtime::spawn_blocking(|| current_platform().list_windows())
        .await
        .unwrap_or_default()
}

#[tauri::command]
pub async fn active_window() -> Option<WinInfo> {
    tauri::async_runtime::spawn_blocking(|| current_platform().active_window())
        .await
        .unwrap_or(None)
}

#[tauri::command]
pub async fn focus_window(id: u64) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || current_platform().focus_window(id))
        .await
        .map_err(|e| format!("focus_window task error: {e}"))?
}

#[tauri::command]
pub async fn minimize_window(id: u64) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || current_platform().minimize_window(id))
        .await
        .map_err(|e| format!("minimize_window task error: {e}"))?
}

#[tauri::command]
pub async fn close_window(id: u64) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || current_platform().close_window(id))
        .await
        .map_err(|e| format!("close_window task error: {e}"))?
}

#[tauri::command]
pub async fn close_browser_tab(id: u64) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || current_platform().send_close_tab(id))
        .await
        .map_err(|e| format!("close_browser_tab task error: {e}"))?
}

#[tauri::command]
pub async fn kill_process(process_name: String) -> Result<usize, String> {
    tauri::async_runtime::spawn_blocking(move || kill_process_by_name(&process_name))
        .await
        .map_err(|e| format!("kill_process task error: {e}"))?
}

#[tauri::command]
pub fn show_overlay(app: AppHandle, payload: Value) -> Result<(), String> {
    let seq = INTERCEPTION_SEQ.fetch_add(1, Ordering::SeqCst) + 1;
    if let Ok(mut guard) = ACTIVE_OVERLAY.lock() {
        *guard = Some((seq, payload.clone()));
    }

    if let Some(win) = app.get_webview_window("overlay") {
        let _ = win.center();
        let _ = win.show();
        let _ = win.set_always_on_top(true);
    }
    let _ = app.emit("overlay-context", payload);

    let app_for_timer = app.clone();
    thread::spawn(move || {
        thread::sleep(Duration::from_millis(3050));
        execute_return_native(&app_for_timer, Some(seq));
    });

    Ok(())
}

#[tauri::command]
pub fn get_overlay_context() -> Option<Value> {
    ACTIVE_OVERLAY
        .lock()
        .ok()
        .and_then(|g| g.as_ref().map(|(_, v)| v.clone()))
}

#[tauri::command]
pub fn trigger_overlay_complete(app: AppHandle) -> Result<(), String> {
    execute_return_native(&app, None);
    Ok(())
}

#[tauri::command]
pub fn hide_overlay(app: AppHandle) -> Result<(), String> {
    let usb_alarm_active = ACTIVE_USB_ALARM
        .lock()
        .ok()
        .map(|g| g.is_some())
        .unwrap_or(false);
    if !usb_alarm_active {
        if let Some(win) = app.get_webview_window("overlay") {
            let _ = win.hide();
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn set_strict_mode(domains: Vec<String>, enable: bool) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || sync_system_hosts(&domains, enable))
        .await
        .map_err(|e| format!("set_strict_mode task error: {e}"))?
}

#[tauri::command]
pub fn analytics_event(
    event_type: String,
    target: String,
    meta_json: Option<String>,
) -> Result<(), String> {
    crate::analytics::record_event(&event_type, &target, meta_json);
    Ok(())
}

#[tauri::command]
pub fn analytics_tag(win_id: u64, kind: String, domain: String) -> Result<(), String> {
    crate::analytics::tag_active_segment(win_id, &kind, &domain);
    Ok(())
}

#[tauri::command]
pub fn analytics_session_start(planned_ms: i64) -> Result<(), String> {
    crate::analytics::start_session(planned_ms);
    Ok(())
}

#[tauri::command]
pub fn analytics_session_end(outcome: String) -> Result<(), String> {
    crate::analytics::end_session(&outcome);
    Ok(())
}

#[tauri::command]
pub async fn analytics_dashboard(
    days: i64,
) -> Result<crate::analytics::queries::DashboardRawData, String> {
    tauri::async_runtime::spawn_blocking(move || crate::analytics::query_dashboard(days))
        .await
        .map_err(|e| format!("analytics_dashboard task error: {e}"))?
}

#[tauri::command]
pub async fn analytics_reset() -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(crate::analytics::reset_all)
        .await
        .map_err(|e| format!("analytics_reset task error: {e}"))?
}

#[tauri::command]
pub fn analytics_bridge_status() -> crate::analytics::bridge::BridgeStatus {
    crate::analytics::bridge_status()
}

#[tauri::command]
pub fn sync_bridge_goal(
    goal: Option<crate::analytics::bridge::ActiveGoal>,
) -> Option<crate::analytics::bridge::ActiveGoal> {
    crate::analytics::bridge::set_shared_goal(goal, false)
}

#[tauri::command]
pub fn sync_bridge_shield(
    shield: crate::analytics::bridge::ShieldConfig,
) -> crate::analytics::bridge::ShieldConfig {
    crate::analytics::bridge::set_shared_shield(shield, false)
}

#[tauri::command]
pub async fn apply_adult_shield(
    provider: String,
    enable: bool,
    safe_search: bool,
    youtube_restricted: bool,
    no_reels: Option<bool>,
) -> Result<crate::shield::ShieldDiagnostic, String> {
    tauri::async_runtime::spawn_blocking(move || {
        crate::shield::apply_system_shield_with_options(
            &provider,
            enable,
            safe_search,
            youtube_restricted,
            no_reels.unwrap_or(true),
        )
    })
    .await
    .map_err(|e| format!("apply_adult_shield task error: {e}"))?
}

#[tauri::command]
pub fn sync_focus_timer_state(active: bool, ends_at_ms: Option<i64>) {
    let ends = ends_at_ms.unwrap_or(0);
    crate::analytics::bridge::set_focus_timer_state(active, ends);
    crate::usb_sensor::set_focus_session_active(active);
}

#[tauri::command]
pub async fn check_adult_shield(provider: String) -> crate::shield::ShieldDiagnostic {
    let fallback_provider = provider.clone();
    tauri::async_runtime::spawn_blocking(move || crate::shield::check_system_shield(&provider))
        .await
        .unwrap_or_else(|_| crate::shield::check_system_shield(&fallback_provider))
}

#[tauri::command]
pub async fn start_mobile_qr(provider: String) -> crate::mobile_qr::MobileQrInfo {
    let fp = provider.clone();
    tauri::async_runtime::spawn_blocking(move || {
        crate::mobile_qr::start_or_update_mobile_qr(&provider)
    })
    .await
    .unwrap_or_else(|_| crate::mobile_qr::start_or_update_mobile_qr(&fp))
}

#[tauri::command]
pub fn stop_mobile_qr() {
    crate::mobile_qr::stop_mobile_qr();
}

#[tauri::command]
pub async fn import_custom_sound_cmd(
    app: AppHandle,
    original_name: String,
    data_base64: String,
) -> Result<crate::sounds::StoredSoundInfo, String> {
    tauri::async_runtime::spawn_blocking(move || {
        crate::sounds::import_custom_sound(&app, &original_name, &data_base64)
    })
    .await
    .map_err(|e| format!("import_custom_sound task error: {e}"))?
}

#[tauri::command]
pub async fn load_custom_sound_cmd(app: AppHandle) -> Option<crate::sounds::StoredSoundInfo> {
    tauri::async_runtime::spawn_blocking(move || crate::sounds::load_custom_sound(&app))
        .await
        .unwrap_or(None)
}

#[tauri::command]
pub async fn remove_custom_sound_cmd(app: AppHandle) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || crate::sounds::remove_custom_sound(&app))
        .await
        .map_err(|e| format!("remove_custom_sound task error: {e}"))?
}

#[tauri::command]
pub async fn get_system_idle_ms() -> u64 {
    tauri::async_runtime::spawn_blocking(|| current_platform().idle_duration_ms())
        .await
        .unwrap_or(0)
}

#[tauri::command]
pub fn pause_focus_for_idle(deduct_ms: i64) {
    crate::analytics::pause_active_segment_with_deduction(deduct_ms);
}

#[tauri::command]
pub fn note_work_window(win: WinInfo) {
    crate::analytics::bridge::set_last_work_window(Some(win));
}

#[tauri::command]
pub fn show_presence_overlay(app: AppHandle, payload: Value) -> Result<(), String> {
    if let Ok(mut guard) = ACTIVE_PRESENCE.lock() {
        *guard = Some(payload.clone());
    }
    if let Some(win) = app.get_webview_window("overlay") {
        let _ = win.center();
        let _ = win.show();
        let _ = win.set_always_on_top(true);
        let _ = win.set_focus();
    }
    let _ = app.emit("presence-context", payload);
    Ok(())
}

#[tauri::command]
pub fn get_presence_context() -> Option<Value> {
    ACTIVE_PRESENCE.lock().ok().and_then(|g| g.clone())
}

#[tauri::command]
pub fn confirm_presence_resume(app: AppHandle) -> Result<(), String> {
    let payload_opt = ACTIVE_PRESENCE.lock().ok().and_then(|mut g| g.take());

    let usb_alarm_active = ACTIVE_USB_ALARM
        .lock()
        .ok()
        .map(|g| g.is_some())
        .unwrap_or(false);
    if !usb_alarm_active {
        if let Some(win) = app.get_webview_window("overlay") {
            let _ = win.hide();
        }
    }

    if let Some(ctx) = payload_opt {
        thread::spawn(move || {
            thread::sleep(Duration::from_millis(120));
            let platform = current_platform();
            let return_id = ctx
                .get("returnTarget")
                .and_then(|rt| rt.get("id"))
                .and_then(|v| v.as_u64())
                .unwrap_or(0);
            let return_proc = ctx
                .get("returnTarget")
                .and_then(|rt| rt.get("processName"))
                .and_then(|v| v.as_str());

            if return_id > 0 {
                let _ = platform.focus_window(return_id);
                if platform.active_window().map(|w| w.id) != Some(return_id) {
                    let _ = crate::analytics::bridge::focus_desktop_goal(return_proc);
                }
            } else {
                let _ = crate::analytics::bridge::focus_desktop_goal(return_proc);
            }
        });
    }

    let _ = app.emit("presence-resumed", true);
    Ok(())
}

#[tauri::command]
pub async fn force_unmute_system_audio(percent: Option<u8>) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        crate::platform::force_unmute_and_boost_volume(percent.unwrap_or(85))
    })
    .await
    .map_err(|e| format!("force_unmute_system_audio task error: {e}"))?
}

#[tauri::command]
pub async fn set_anti_uninstall_guardian_cmd(enable: bool) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || crate::shield::set_anti_uninstall_guardian(enable))
        .await
        .map_err(|e| format!("set_anti_uninstall_guardian task error: {e}"))?
}

#[tauri::command]
pub fn is_safe_mode_cmd() -> bool {
    crate::watchdog::is_safe_mode()
}

/// Saves exported files (`.mobileconfig`, `.csv`, `.json`) natively to the user's Downloads folder.
#[tauri::command]
pub async fn save_export_file(
    app: AppHandle,
    filename: String,
    content: String,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let raw_name = std::path::Path::new(&filename)
            .file_name()
            .and_then(|s| s.to_str())
            .unwrap_or("dhirna-export.txt");
        let safe_name: String = raw_name
            .chars()
            .filter(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_'))
            .collect();
        let final_name = if safe_name.is_empty() || safe_name.starts_with('.') {
            "dhirna-export.txt".to_string()
        } else {
            safe_name
        };

        let target_dir = app
            .path()
            .download_dir()
            .or_else(|_| app.path().document_dir())
            .or_else(|_| app.path().app_data_dir())
            .map_err(|e| format!("Cannot resolve Downloads folder: {e}"))?;
        fs::create_dir_all(&target_dir)
            .map_err(|e| format!("Cannot create Downloads folder: {e}"))?;
        let full_path = target_dir.join(&final_name);
        fs::write(&full_path, content.as_bytes())
            .map_err(|e| format!("Cannot save {}: {e}", full_path.display()))?;
        Ok(full_path.to_string_lossy().to_string())
    })
    .await
    .map_err(|e| format!("save_export_file task error: {e}"))?
}

#[tauri::command]
pub async fn copy_to_clipboard(text: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || crate::platform::copy_text_to_clipboard(&text))
        .await
        .map_err(|e| format!("copy_to_clipboard task error: {e}"))?
}

#[tauri::command]
pub fn get_usb_sensor_status() -> crate::usb_sensor::UsbSensorStatus {
    crate::usb_sensor::get_status()
}

#[tauri::command]
pub async fn set_usb_sensor_enabled_cmd(
    app: AppHandle,
    enable: bool,
    watched_apps: Option<Vec<String>>,
) -> crate::usb_sensor::UsbSensorStatus {
    let app_fb = app.clone();
    let apps_fb = watched_apps.clone();
    tauri::async_runtime::spawn_blocking(move || {
        crate::usb_sensor::set_config(&app, enable, watched_apps)
    })
    .await
    .unwrap_or_else(|_| crate::usb_sensor::set_config(&app_fb, enable, apps_fb))
}

#[tauri::command]
pub async fn install_ios_usb_driver_cmd(
    app: AppHandle,
) -> Result<crate::usb_sensor::UsbSensorStatus, String> {
    tauri::async_runtime::spawn_blocking(move || crate::usb_sensor::install_ios_usb_driver(&app))
        .await
        .map_err(|e| format!("install_ios_usb_driver task error: {e}"))?
}

#[tauri::command]
pub fn show_usb_phone_alarm(app: AppHandle, payload: Value) -> Result<(), String> {
    if let Ok(mut guard) = ACTIVE_USB_ALARM.lock() {
        *guard = Some(payload.clone());
    }
    if let Some(win) = app.get_webview_window("overlay") {
        let _ = win.center();
        let _ = win.show();
        let _ = win.set_always_on_top(true);
        let _ = win.set_focus();
    }
    let _ = app.emit("usb-phone-alarm", payload);
    Ok(())
}

#[tauri::command]
pub fn get_usb_phone_alarm_context() -> Option<Value> {
    ACTIVE_USB_ALARM.lock().ok().and_then(|g| g.clone())
}

#[tauri::command]
pub fn hide_usb_phone_alarm(
    app: AppHandle,
    return_target: Option<Value>,
) -> Result<(), String> {
    let was_active = ACTIVE_USB_ALARM
        .lock()
        .ok()
        .and_then(|mut g| g.take())
        .is_some();

    let _ = app.emit("usb-phone-alarm-stop", true);

    if let Some(win) = app.get_webview_window("overlay") {
        let _ = win.hide();
    }

    if was_active {
        if let Some(rt) = return_target {
            thread::spawn(move || {
                thread::sleep(Duration::from_millis(120));
                let platform = current_platform();
                let return_id = rt.get("id").and_then(|v| v.as_u64()).unwrap_or(0);
                let return_proc = rt.get("processName").and_then(|v| v.as_str());
                if return_id > 0 {
                    let _ = platform.focus_window(return_id);
                } else {
                    let _ = crate::analytics::bridge::focus_desktop_goal(return_proc);
                }
            });
        }
    }

    Ok(())
}
