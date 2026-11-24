use rusqlite::{params, Connection, OptionalExtension, Result as SqlResult};
use std::path::Path;

pub const RETENTION_DAYS: i64 = 400;

#[derive(Debug, Clone)]
pub enum WriteOp {
    InsertEvent {
        ts_ms: i64,
        event_type: String,
        target: String,
        meta_json: String,
        session_id: Option<i64>,
    },
    OpenSegment {
        id: i64,
        started_at_ms: i64,
        process_name: String,
        domain: String,
        kind: String,
        session_id: Option<i64>,
    },
    UpdateSegmentTag {
        id: i64,
        kind: String,
        domain: String,
    },
    CloseSegment {
        id: i64,
        started_at_ms: i64,
        ended_at_ms: i64,
        duration_ms: i64,
        kind: String,
        domain: String,
    },
    InsertCompletedSegment {
        id: i64,
        started_at_ms: i64,
        ended_at_ms: i64,
        duration_ms: i64,
        process_name: String,
        domain: String,
        kind: String,
        session_id: Option<i64>,
    },
    StartSession {
        id: i64,
        started_at_ms: i64,
        planned_ms: i64,
    },
    EndSession {
        id: i64,
        ended_at_ms: i64,
        outcome: String,
        focus_ms: i64,
        blocked_count: i64,
    },
}

pub fn open_database(path: &Path) -> SqlResult<Connection> {
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let conn = Connection::open(path)?;
    init_schema(&conn)?;
    Ok(conn)
}

#[cfg(test)]
pub fn open_in_memory() -> SqlResult<Connection> {
    let conn = Connection::open_in_memory()?;
    init_schema(&conn)?;
    Ok(conn)
}

pub fn init_schema(conn: &Connection) -> SqlResult<()> {
    conn.execute_batch(
        "
        PRAGMA journal_mode = WAL;
        PRAGMA synchronous = NORMAL;
        PRAGMA foreign_keys = ON;
        PRAGMA busy_timeout = 3000;

        CREATE TABLE IF NOT EXISTS sessions (
            id INTEGER PRIMARY KEY,
            started_at_ms INTEGER NOT NULL,
            planned_ms INTEGER NOT NULL,
            ended_at_ms INTEGER,
            outcome TEXT NOT NULL DEFAULT 'running',
            focus_ms INTEGER NOT NULL DEFAULT 0,
            blocked_count INTEGER NOT NULL DEFAULT 0
        );

        CREATE TABLE IF NOT EXISTS segments (
            id INTEGER PRIMARY KEY,
            started_at_ms INTEGER NOT NULL,
            ended_at_ms INTEGER,
            duration_ms INTEGER NOT NULL DEFAULT 0,
            process_name TEXT NOT NULL,
            domain TEXT NOT NULL DEFAULT '',
            kind TEXT NOT NULL DEFAULT 'unknown',
            session_id INTEGER REFERENCES sessions(id) ON DELETE SET NULL
        );

        CREATE TABLE IF NOT EXISTS events (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            ts_ms INTEGER NOT NULL,
            event_type TEXT NOT NULL,
            target TEXT NOT NULL DEFAULT '',
            meta_json TEXT NOT NULL DEFAULT '{}',
            session_id INTEGER REFERENCES sessions(id) ON DELETE SET NULL
        );

        CREATE TABLE IF NOT EXISTS daily (
            day TEXT PRIMARY KEY,
            focus_ms INTEGER NOT NULL DEFAULT 0,
            distraction_ms INTEGER NOT NULL DEFAULT 0,
            blocked_count INTEGER NOT NULL DEFAULT 0,
            sessions_completed INTEGER NOT NULL DEFAULT 0,
            sessions_failed INTEGER NOT NULL DEFAULT 0
        );

        CREATE INDEX IF NOT EXISTS idx_segments_started ON segments(started_at_ms);
        CREATE INDEX IF NOT EXISTS idx_segments_kind_started ON segments(kind, started_at_ms);
        CREATE INDEX IF NOT EXISTS idx_events_ts ON events(ts_ms);
        CREATE INDEX IF NOT EXISTS idx_events_target ON events(target);
        CREATE INDEX IF NOT EXISTS idx_events_type_ts ON events(event_type, ts_ms);
        CREATE INDEX IF NOT EXISTS idx_sessions_started ON sessions(started_at_ms);
        ",
    )?;
    Ok(())
}

/// Closes any segment or running session left unclosed by a prior crash so no phantom focus time is counted.
pub fn close_orphaned_records(conn: &Connection) -> SqlResult<usize> {
    let segs = conn.execute(
        "UPDATE segments SET ended_at_ms = started_at_ms, duration_ms = 0 WHERE ended_at_ms IS NULL",
        [],
    )?;
    let sess = conn.execute(
        "UPDATE sessions SET ended_at_ms = started_at_ms, outcome = 'crash' WHERE ended_at_ms IS NULL AND outcome = 'running'",
        [],
    )?;
    Ok(segs + sess)
}

/// Purges raw records older than `retention_days` while keeping the compact `daily` rollups up to the same horizon.
pub fn purge_old_data(conn: &Connection, now_ms: i64, retention_days: i64) -> SqlResult<usize> {
    let cutoff_ms = now_ms.saturating_sub(retention_days.saturating_mul(86_400_000));
    let mut total = 0usize;
    total += conn.execute("DELETE FROM events WHERE ts_ms < ?1", params![cutoff_ms])?;
    total += conn.execute(
        "DELETE FROM segments WHERE started_at_ms < ?1 AND ended_at_ms IS NOT NULL",
        params![cutoff_ms],
    )?;
    total += conn.execute(
        "DELETE FROM sessions WHERE started_at_ms < ?1 AND ended_at_ms IS NOT NULL",
        params![cutoff_ms],
    )?;
    total += conn.execute(
        "DELETE FROM daily WHERE day < date(?1 / 1000, 'unixepoch', 'localtime')",
        params![cutoff_ms],
    )?;
    Ok(total)
}

pub fn next_ids(conn: &Connection) -> SqlResult<(i64, i64)> {
    let seg_max: i64 = conn
        .query_row("SELECT COALESCE(MAX(id), 0) FROM segments", [], |r| r.get(0))
        .optional()?
        .unwrap_or(0);
    let sess_max: i64 = conn
        .query_row("SELECT COALESCE(MAX(id), 0) FROM sessions", [], |r| r.get(0))
        .optional()?
        .unwrap_or(0);
    Ok((seg_max + 1, sess_max + 1))
}

pub fn apply_operations(conn: &mut Connection, ops: &[WriteOp]) -> SqlResult<()> {
    if ops.is_empty() {
        return Ok(());
    }
    let tx = conn.transaction()?;
    let mut blocked_by_hour_bucket: std::collections::HashMap<i64, (i64, i64)> =
        std::collections::HashMap::new();

    for op in ops {
        match op {
            WriteOp::InsertEvent {
                ts_ms,
                event_type,
                target,
                meta_json,
                session_id,
            } => {
                tx.prepare_cached(
                    "INSERT INTO events (ts_ms, event_type, target, meta_json, session_id)
                     VALUES (?1, ?2, ?3, ?4, ?5)",
                )?
                .execute(params![ts_ms, event_type, target, meta_json, session_id])?;

                if event_type == "blocked" {
                    let hour_bucket = ts_ms / 3_600_000;
                    let entry = blocked_by_hour_bucket
                        .entry(hour_bucket)
                        .or_insert((*ts_ms, 0));
                    entry.1 += 1;
                }
            }

            WriteOp::OpenSegment {
                id,
                started_at_ms,
                process_name,
                domain,
                kind,
                session_id,
            } => {
                tx.prepare_cached(
                    "INSERT OR REPLACE INTO segments (id, started_at_ms, ended_at_ms, duration_ms, process_name, domain, kind, session_id)
                     VALUES (?1, ?2, NULL, 0, ?3, ?4, ?5, ?6)",
                )?
                .execute(params![id, started_at_ms, process_name, domain, kind, session_id])?;
            }

            WriteOp::UpdateSegmentTag { id, kind, domain } => {
                tx.prepare_cached(
                    "UPDATE segments
                     SET kind = ?2, domain = CASE WHEN ?3 != '' THEN ?3 ELSE domain END
                     WHERE id = ?1",
                )?
                .execute(params![id, kind, domain])?;
            }

            WriteOp::CloseSegment {
                id,
                started_at_ms,
                ended_at_ms,
                duration_ms,
                kind,
                domain,
            } => {
                let safe_dur = (*duration_ms).max(0);
                tx.prepare_cached(
                    "UPDATE segments
                     SET ended_at_ms = ?2,
                         duration_ms = ?3,
                         kind = ?4,
                         domain = CASE WHEN ?5 != '' THEN ?5 ELSE domain END
                     WHERE id = ?1",
                )?
                .execute(params![id, ended_at_ms, safe_dur, kind, domain])?;

                let focus_delta = if kind == "work" { safe_dur } else { 0 };
                let dist_delta = if kind == "distraction" { safe_dur } else { 0 };
                if focus_delta > 0 || dist_delta > 0 {
                    tx.prepare_cached(
                        "INSERT INTO daily (day, focus_ms, distraction_ms)
                         VALUES (date(?1 / 1000, 'unixepoch', 'localtime'), ?2, ?3)
                         ON CONFLICT(day) DO UPDATE SET
                           focus_ms = focus_ms + excluded.focus_ms,
                           distraction_ms = distraction_ms + excluded.distraction_ms",
                    )?
                    .execute(params![started_at_ms, focus_delta, dist_delta])?;
                }
            }

            WriteOp::InsertCompletedSegment {
                id,
                started_at_ms,
                ended_at_ms,
                duration_ms,
                process_name,
                domain,
                kind,
                session_id,
            } => {
                let safe_dur = (*duration_ms).max(0);
                tx.prepare_cached(
                    "INSERT OR REPLACE INTO segments (id, started_at_ms, ended_at_ms, duration_ms, process_name, domain, kind, session_id)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
                )?
                .execute(params![
                    id,
                    started_at_ms,
                    ended_at_ms,
                    safe_dur,
                    process_name,
                    domain,
                    kind,
                    session_id
                ])?;

                let focus_delta = if kind == "work" { safe_dur } else { 0 };
                let dist_delta = if kind == "distraction" { safe_dur } else { 0 };
                if focus_delta > 0 || dist_delta > 0 {
                    tx.prepare_cached(
                        "INSERT INTO daily (day, focus_ms, distraction_ms)
                         VALUES (date(?1 / 1000, 'unixepoch', 'localtime'), ?2, ?3)
                         ON CONFLICT(day) DO UPDATE SET
                           focus_ms = focus_ms + excluded.focus_ms,
                           distraction_ms = distraction_ms + excluded.distraction_ms",
                    )?
                    .execute(params![started_at_ms, focus_delta, dist_delta])?;
                }
            }

            WriteOp::StartSession {
                id,
                started_at_ms,
                planned_ms,
            } => {
                tx.prepare_cached(
                    "INSERT OR REPLACE INTO sessions (id, started_at_ms, planned_ms, ended_at_ms, outcome, focus_ms, blocked_count)
                     VALUES (?1, ?2, ?3, NULL, 'running', 0, 0)",
                )?
                .execute(params![id, started_at_ms, planned_ms])?;
            }

            WriteOp::EndSession {
                id,
                ended_at_ms,
                outcome,
                focus_ms,
                blocked_count,
            } => {
                tx.prepare_cached(
                    "UPDATE sessions
                     SET ended_at_ms = ?2, outcome = ?3, focus_ms = ?4, blocked_count = ?5
                     WHERE id = ?1",
                )?
                .execute(params![id, ended_at_ms, outcome, focus_ms, blocked_count])?;

                let completed_delta: i64 = if outcome == "completed" { 1 } else { 0 };
                let failed_delta: i64 = if outcome == "abandoned" || outcome == "emergency" {
                    1
                } else {
                    0
                };
                if completed_delta > 0 || failed_delta > 0 {
                    tx.prepare_cached(
                        "INSERT INTO daily (day, sessions_completed, sessions_failed)
                         VALUES (date(?1 / 1000, 'unixepoch', 'localtime'), ?2, ?3)
                         ON CONFLICT(day) DO UPDATE SET
                           sessions_completed = sessions_completed + excluded.sessions_completed,
                           sessions_failed = sessions_failed + excluded.sessions_failed",
                    )?
                    .execute(params![ended_at_ms, completed_delta, failed_delta])?;
                }
            }
        }
    }

    for (_bucket, (sample_ts_ms, delta)) in blocked_by_hour_bucket {
        tx.prepare_cached(
            "INSERT INTO daily (day, blocked_count)
             VALUES (date(?1 / 1000, 'unixepoch', 'localtime'), ?2)
             ON CONFLICT(day) DO UPDATE SET
               blocked_count = blocked_count + excluded.blocked_count",
        )?
        .execute(params![sample_ts_ms, delta])?;
    }

    tx.commit()?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn creates_schema_and_recovers_orphaned_segments() {
        let mut conn = open_in_memory().expect("in-memory db");
        apply_operations(
            &mut conn,
            &[WriteOp::OpenSegment {
                id: 1,
                started_at_ms: 1_700_000_000_000,
                process_name: "code".into(),
                domain: String::new(),
                kind: "work".into(),
                session_id: None,
            }],
        )
        .expect("insert open segment");

        let fixed = close_orphaned_records(&conn).expect("recover");
        assert_eq!(fixed, 1);

        let (ended, dur): (Option<i64>, i64) = conn
            .query_row(
                "SELECT ended_at_ms, duration_ms FROM segments WHERE id = 1",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .expect("select segment");
        assert_eq!(ended, Some(1_700_000_000_000));
        assert_eq!(dur, 0);
    }

    #[test]
    fn purges_records_older_than_400_days() {
        let mut conn = open_in_memory().expect("in-memory db");
        let now_ms: i64 = 1_795_000_000_000;
        let old_ms: i64 = now_ms - (450 * 86_400_000);
        let recent_ms: i64 = now_ms - (5 * 86_400_000);

        apply_operations(
            &mut conn,
            &[
                WriteOp::InsertEvent {
                    ts_ms: old_ms,
                    event_type: "blocked".into(),
                    target: "instagram.com".into(),
                    meta_json: "{}".into(),
                    session_id: None,
                },
                WriteOp::InsertEvent {
                    ts_ms: recent_ms,
                    event_type: "blocked".into(),
                    target: "tiktok.com".into(),
                    meta_json: "{}".into(),
                    session_id: None,
                },
            ],
        )
        .expect("insert events");

        purge_old_data(&conn, now_ms, RETENTION_DAYS).expect("purge");

        let count: i64 = conn
            .query_row("SELECT COUNT(*) FROM events", [], |r| r.get(0))
            .expect("count");
        assert_eq!(count, 1);
    }
}
