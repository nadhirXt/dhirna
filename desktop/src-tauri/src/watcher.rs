use crate::platform::current_platform;
use std::thread;
use std::time::Duration;
use tauri::{AppHandle, Emitter};

/// Starts the background OS window watcher thread (400 ms polling interval).
/// Emits `active-window-changed` only when `(window.id, window.title)` changes.
pub fn spawn_window_watcher(app: AppHandle) {
    thread::spawn(move || {
        let platform = current_platform();
        let mut last_key: Option<(u64, String)> = None;

        loop {
            if let Some(win) = platform.active_window() {
                let key = (win.id, win.title.clone());
                if last_key.as_ref() != Some(&key) {
                    last_key = Some(key);
                    let _ = app.emit("active-window-changed", &win);
                    if crate::analytics::bridge::should_defer_browser(&win.process_name) {
                        crate::analytics::pause_active_segment();
                    } else {
                        crate::analytics::note_window_change(win.id, &win.process_name, "");
                    }
                }
            }
            thread::sleep(Duration::from_millis(400));
        }
    });
}
