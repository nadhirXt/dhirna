#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod analytics;
mod commands;
mod hosts;
mod mobile_qr;
mod platform;
mod shield;
mod sounds;
mod usb_sensor;
mod watchdog;
mod watcher;

use std::io::Write;
use std::net::{SocketAddr, TcpListener, TcpStream};
use std::sync::OnceLock;
use std::time::Duration;
use tauri::{
    menu::{Menu, MenuItem},
    tray::TrayIconBuilder,
    Emitter, Manager, WindowEvent,
};

const SINGLE_INSTANCE_LOCK_PORT: u16 = 47825;
static SINGLE_INSTANCE_LOCK: OnceLock<TcpListener> = OnceLock::new();

fn acquire_single_instance_or_focus_existing() -> bool {
    let lock_addr = format!("127.0.0.1:{SINGLE_INSTANCE_LOCK_PORT}");
    if let Ok(listener) = TcpListener::bind(&lock_addr) {
        let _ = SINGLE_INSTANCE_LOCK.set(listener);
        return true;
    }

    let bridge_addr: SocketAddr = format!("127.0.0.1:{}", analytics::bridge::BRIDGE_PORT)
        .parse()
        .expect("valid loopback addr");
    if let Ok(mut stream) = TcpStream::connect_timeout(&bridge_addr, Duration::from_millis(400)) {
        let _ = stream.set_write_timeout(Some(Duration::from_millis(400)));
        let _ = stream.write_all(
            b"POST /window/show HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
        );
        let _ = stream.flush();
    }
    eprintln!("[Dhirna] Instance déjà active : fenêtre existante ramenée au premier plan.");
    false
}

fn main() {
    match watchdog::parse_cli_flags(std::env::args()) {
        watchdog::CliMode::Help => {
            watchdog::print_cli_help();
            return;
        }
        watchdog::CliMode::InternalApplyHosts(tmp_path) => {
            match hosts::execute_internal_apply_hosts(&tmp_path) {
                Ok(()) => std::process::exit(0),
                Err(err) => {
                    eprintln!("[Dhirna hosts] {err}");
                    std::process::exit(1);
                }
            }
        }
        watchdog::CliMode::InternalApplyShield { mode, tmp_hosts } => {
            match shield::execute_internal_apply_shield(&mode, &tmp_hosts) {
                Ok(()) => std::process::exit(0),
                Err(err) => {
                    eprintln!("[Dhirna shield] {err}");
                    std::process::exit(1);
                }
            }
        }
        watchdog::CliMode::Kill => match watchdog::execute_cli_kill() {
            Ok(report) => {
                println!("[Dhirna --kill]\n{report}");
                std::process::exit(0);
            }
            Err(err) => {
                eprintln!("[Dhirna --kill] Erreur: {err}");
                std::process::exit(1);
            }
        },
        watchdog::CliMode::SafeMode => {
            if !acquire_single_instance_or_focus_existing() {
                return;
            }
            watchdog::set_safe_mode(true);
            eprintln!("[Dhirna] Démarré en mode sans échec (--safe-mode) : blocage et verrouillage désactivés.");
        }
        watchdog::CliMode::Normal => {
            if !acquire_single_instance_or_focus_existing() {
                return;
            }
            watchdog::recover_from_stale_crash_if_needed();
        }
    }

    tauri::Builder::default()
        .setup(|app| {
            let open_i = MenuItem::with_id(app, "open", "Ouvrir Dhirna", true, None::<&str>)?;
            let sess_i = MenuItem::with_id(
                app,
                "session25",
                "Session Focus 25 min",
                true,
                None::<&str>,
            )?;
            let quit_i = MenuItem::with_id(app, "quit", "Quitter Dhirna", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&open_i, &sess_i, &quit_i])?;

            let mut tray_builder = TrayIconBuilder::new()
                .tooltip("Dhirna")
                .menu(&menu)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "open" => {
                        if let Some(w) = app.get_webview_window("main") {
                            let _ = w.show();
                            let _ = w.set_focus();
                        }
                    }
                    "session25" => {
                        let _ = app.emit("tray-start-session", 25);
                    }
                    "quit" => {
                        if !watchdog::is_safe_mode() {
                            let (focus_active, _) = analytics::bridge::get_focus_timer_state();
                            let shield_cfg = analytics::bridge::get_shared_shield();
                            if focus_active || shield_cfg.enabled {
                                if let Some(w) = app.get_webview_window("main") {
                                    let _ = w.show();
                                    let _ = w.set_focus();
                                }
                                let _ = app.emit("quit-blocked", true);
                                return;
                            }
                        }
                        mobile_qr::stop_mobile_qr();
                        usb_sensor::shutdown_usb_sensor();
                        watchdog::clear_watchdog_on_clean_exit();
                        analytics::shutdown();
                        app.exit(0);
                    }
                    _ => {}
                });

            if let Some(icon) = app.default_window_icon() {
                tray_builder = tray_builder.icon(icon.clone());
            }
            let _ = tray_builder.build(app)?;

            let _ = analytics::init(app.handle());
            watchdog::spawn_watchdog_heartbeat();

            if !watchdog::is_safe_mode() {
                watcher::spawn_window_watcher(app.handle().clone());
                usb_sensor::start_usb_sensor_supervisor(app.handle().clone());
            } else {
                let _ = app.emit("safe-mode-active", true);
            }

            Ok(())
        })
        .on_window_event(|window, event| {
            if window.label() == "main" {
                if let WindowEvent::CloseRequested { api, .. } = event {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            commands::load_state,
            commands::save_state,
            commands::list_windows,
            commands::active_window,
            commands::focus_window,
            commands::minimize_window,
            commands::close_window,
            commands::close_browser_tab,
            commands::kill_process,
            commands::show_overlay,
            commands::get_overlay_context,
            commands::trigger_overlay_complete,
            commands::hide_overlay,
            commands::set_strict_mode,
            commands::analytics_event,
            commands::analytics_tag,
            commands::analytics_session_start,
            commands::analytics_session_end,
            commands::analytics_dashboard,
            commands::analytics_reset,
            commands::analytics_bridge_status,
            commands::sync_bridge_goal,
            commands::sync_bridge_shield,
            commands::apply_adult_shield,
            commands::sync_focus_timer_state,
            commands::check_adult_shield,
            commands::start_mobile_qr,
            commands::stop_mobile_qr,
            commands::import_custom_sound_cmd,
            commands::load_custom_sound_cmd,
            commands::remove_custom_sound_cmd,
            commands::get_system_idle_ms,
            commands::pause_focus_for_idle,
            commands::note_work_window,
            commands::show_presence_overlay,
            commands::get_presence_context,
            commands::confirm_presence_resume,
            commands::force_unmute_system_audio,
            commands::set_anti_uninstall_guardian_cmd,
            commands::is_safe_mode_cmd,
            commands::save_export_file,
            commands::copy_to_clipboard,
            commands::get_usb_sensor_status,
            commands::set_usb_sensor_enabled_cmd,
            commands::install_ios_usb_driver_cmd,
            commands::show_usb_phone_alarm,
            commands::get_usb_phone_alarm_context,
            commands::hide_usb_phone_alarm
        ])
        .run(tauri::generate_context!())
        .expect("error while running Dhirna desktop application");
}
