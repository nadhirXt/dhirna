pub mod bridge;
pub mod db;
pub mod queries;
pub mod writer;

use std::path::PathBuf;
use std::sync::mpsc::{self, Sender};
use std::sync::OnceLock;
use std::time::Duration;
use tauri::{AppHandle, Manager};
use writer::{now_ms, spawn_writer, AnalyticsMsg};

pub struct AnalyticsHandle {
    pub db_path: PathBuf,
    tx: Sender<AnalyticsMsg>,
}

static INSTANCE: OnceLock<AnalyticsHandle> = OnceLock::new();

pub fn init(app: &AppHandle) -> Result<(), String> {
    if INSTANCE.get().is_some() {
        return Ok(());
    }
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|e| format!("Cannot resolve config dir for analytics: {e}"))?;
    let db_path = dir.join("dhirna_analytics.db");
    let tx = spawn_writer(db_path.clone())?;
    let _ = INSTANCE.set(AnalyticsHandle { db_path, tx });
    let _ = bridge::spawn_bridge(Some(app.clone()));
    Ok(())
}

/// Non-blocking fire-and-forget event logger. Safe to call from any thread.
pub fn record_event(event_type: &str, target: &str, meta_json: Option<String>) {
    if let Some(handle) = INSTANCE.get() {
        let _ = handle.tx.send(AnalyticsMsg::Event {
            ts_ms: now_ms(),
            event_type: event_type.to_string(),
            target: target.to_lowercase(),
            meta_json: meta_json.unwrap_or_else(|| "{}".to_string()),
        });
    }
}

pub fn note_window_change(win_id: u64, process_name: &str, domain: &str) {
    if let Some(handle) = INSTANCE.get() {
        let _ = handle.tx.send(AnalyticsMsg::WindowChanged {
            win_id,
            process_name: process_name.to_string(),
            domain: domain.to_string(),
            ts_ms: now_ms(),
        });
    }
}

pub fn pause_active_segment() {
    pause_active_segment_with_deduction(0);
}

pub fn pause_active_segment_with_deduction(deduct_ms: i64) {
    if let Some(handle) = INSTANCE.get() {
        let _ = handle.tx.send(AnalyticsMsg::PauseActiveSegment {
            ts_ms: now_ms(),
            deduct_ms: deduct_ms.max(0),
        });
    }
}

pub fn record_completed_segment(
    started_at_ms: i64,
    ended_at_ms: i64,
    duration_ms: i64,
    process_name: &str,
    domain: &str,
    kind: &str,
) {
    if let Some(handle) = INSTANCE.get() {
        let _ = handle.tx.send(AnalyticsMsg::CompletedSegment {
            started_at_ms,
            ended_at_ms,
            duration_ms,
            process_name: process_name.to_string(),
            domain: domain.to_string(),
            kind: kind.to_string(),
        });
    }
}

pub fn tag_active_segment(win_id: u64, kind: &str, domain: &str) {
    if let Some(handle) = INSTANCE.get() {
        let _ = handle.tx.send(AnalyticsMsg::TagActiveSegment {
            win_id,
            kind: kind.to_string(),
            domain: domain.to_string(),
        });
    }
}

pub fn start_session(planned_ms: i64) {
    if let Some(handle) = INSTANCE.get() {
        let _ = handle.tx.send(AnalyticsMsg::StartSession {
            planned_ms,
            ts_ms: now_ms(),
        });
    }
}

pub fn end_session(outcome: &str) {
    if let Some(handle) = INSTANCE.get() {
        let _ = handle.tx.send(AnalyticsMsg::EndSession {
            outcome: outcome.to_string(),
            ts_ms: now_ms(),
        });
    }
}

pub fn flush() {
    if let Some(handle) = INSTANCE.get() {
        let (ack_tx, ack_rx) = mpsc::channel();
        if handle.tx.send(AnalyticsMsg::Flush(ack_tx)).is_ok() {
            let _ = ack_rx.recv_timeout(Duration::from_millis(500));
        }
    }
}

/// Closes any open segment and flushes pending events before clean exit.
pub fn shutdown() {
    if let Some(handle) = INSTANCE.get() {
        let (ack_tx, ack_rx) = mpsc::channel();
        if handle.tx.send(AnalyticsMsg::Shutdown(ack_tx)).is_ok() {
            let _ = ack_rx.recv_timeout(Duration::from_millis(500));
        }
    }
}

pub fn query_dashboard(days: i64) -> Result<queries::DashboardRawData, String> {
    let handle = INSTANCE
        .get()
        .ok_or_else(|| "Analytics module not initialized".to_string())?;
    flush();
    queries::query_dashboard_raw(&handle.db_path, days, now_ms())
}

pub fn reset_all() -> Result<(), String> {
    let handle = INSTANCE
        .get()
        .ok_or_else(|| "Analytics module not initialized".to_string())?;
    let (ack_tx, ack_rx) = mpsc::channel();
    handle
        .tx
        .send(AnalyticsMsg::Reset(ack_tx))
        .map_err(|_| "Analytics writer thread stopped".to_string())?;
    ack_rx
        .recv_timeout(Duration::from_secs(3))
        .map_err(|_| "Analytics reset timed out".to_string())?
}

pub fn bridge_status() -> bridge::BridgeStatus {
    bridge::bridge_status()
}
