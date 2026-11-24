use super::db::open_database;
use rusqlite::{params, Connection};
use serde::Serialize;
use std::path::Path;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DailyBucket {
    pub day: String,
    pub focus_ms: i64,
    pub distraction_ms: i64,
    pub blocked_count: i64,
    pub sessions_completed: i64,
    pub sessions_failed: i64,
}

#[derive(Debug, Clone, Serialize, Default, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PeriodTotals {
    pub focus_ms: i64,
    pub distraction_ms: i64,
    pub blocked_count: i64,
    pub sessions_completed: i64,
    pub sessions_failed: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TargetCount {
    pub target: String,
    pub count: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TargetDuration {
    pub target: String,
    pub kind: String,
    pub duration_ms: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HourCount {
    pub hour: i64,
    pub count: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecentEvent {
    pub id: i64,
    pub ts_ms: i64,
    pub event_type: String,
    pub target: String,
    pub meta_json: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DashboardRawData {
    pub days: i64,
    pub generated_at_ms: i64,
    pub daily: Vec<DailyBucket>,
    pub previous_totals: PeriodTotals,
    pub top_blocked: Vec<TargetCount>,
    pub time_by_target: Vec<TargetDuration>,
    pub blocked_by_hour: Vec<HourCount>,
    pub recent_events: Vec<RecentEvent>,
}

pub fn query_dashboard_conn(
    conn: &Connection,
    days: i64,
    now_ms: i64,
) -> Result<DashboardRawData, String> {
    let clamped_days = days.clamp(1, 400);
    let cutoff_ms = now_ms.saturating_sub(clamped_days.saturating_mul(86_400_000));
    let current_offset = format!("-{} days", clamped_days - 1);
    let prev_offset = format!("-{} days", (2 * clamped_days) - 1);

    let mut daily = Vec::new();
    {
        let mut stmt = conn
            .prepare(
                "SELECT day, focus_ms, distraction_ms, blocked_count, sessions_completed, sessions_failed
                 FROM daily
                 WHERE day >= date(?1 / 1000, 'unixepoch', 'localtime', ?2)
                 ORDER BY day ASC",
            )
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map(params![now_ms, current_offset], |r| {
                Ok(DailyBucket {
                    day: r.get(0)?,
                    focus_ms: r.get(1)?,
                    distraction_ms: r.get(2)?,
                    blocked_count: r.get(3)?,
                    sessions_completed: r.get(4)?,
                    sessions_failed: r.get(5)?,
                })
            })
            .map_err(|e| e.to_string())?;
        for row in rows.flatten() {
            daily.push(row);
        }
    }

    let previous_totals = conn
        .query_row(
            "SELECT COALESCE(SUM(focus_ms), 0),
                    COALESCE(SUM(distraction_ms), 0),
                    COALESCE(SUM(blocked_count), 0),
                    COALESCE(SUM(sessions_completed), 0),
                    COALESCE(SUM(sessions_failed), 0)
             FROM daily
             WHERE day >= date(?1 / 1000, 'unixepoch', 'localtime', ?2)
               AND day <  date(?1 / 1000, 'unixepoch', 'localtime', ?3)",
            params![now_ms, prev_offset, current_offset],
            |r| {
                Ok(PeriodTotals {
                    focus_ms: r.get(0)?,
                    distraction_ms: r.get(1)?,
                    blocked_count: r.get(2)?,
                    sessions_completed: r.get(3)?,
                    sessions_failed: r.get(4)?,
                })
            },
        )
        .map_err(|e| e.to_string())?;

    let mut top_blocked = Vec::new();
    {
        let mut stmt = conn
            .prepare(
                "SELECT target, COUNT(*) AS cnt
                 FROM events
                 WHERE event_type = 'blocked' AND ts_ms >= ?1 AND target != ''
                 GROUP BY target
                 ORDER BY cnt DESC
                 LIMIT 10",
            )
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map(params![cutoff_ms], |r| {
                Ok(TargetCount {
                    target: r.get(0)?,
                    count: r.get(1)?,
                })
            })
            .map_err(|e| e.to_string())?;
        for row in rows.flatten() {
            top_blocked.push(row);
        }
    }

    let mut time_by_target = Vec::new();
    {
        let mut stmt = conn
            .prepare(
                "SELECT CASE WHEN domain != '' THEN domain ELSE process_name END AS label,
                        kind,
                        SUM(duration_ms) AS total_ms
                 FROM segments
                 WHERE started_at_ms >= ?1 AND duration_ms > 0
                 GROUP BY label, kind
                 ORDER BY total_ms DESC
                 LIMIT 15",
            )
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map(params![cutoff_ms], |r| {
                Ok(TargetDuration {
                    target: r.get(0)?,
                    kind: r.get(1)?,
                    duration_ms: r.get(2)?,
                })
            })
            .map_err(|e| e.to_string())?;
        for row in rows.flatten() {
            time_by_target.push(row);
        }
    }

    let mut blocked_by_hour = Vec::new();
    {
        let mut stmt = conn
            .prepare(
                "SELECT CAST(strftime('%H', ts_ms / 1000, 'unixepoch', 'localtime') AS INTEGER) AS hr,
                        COUNT(*) AS cnt
                 FROM events
                 WHERE event_type = 'blocked' AND ts_ms >= ?1
                 GROUP BY hr
                 ORDER BY hr ASC",
            )
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map(params![cutoff_ms], |r| {
                Ok(HourCount {
                    hour: r.get(0)?,
                    count: r.get(1)?,
                })
            })
            .map_err(|e| e.to_string())?;
        for row in rows.flatten() {
            blocked_by_hour.push(row);
        }
    }

    let mut recent_events = Vec::new();
    {
        let mut stmt = conn
            .prepare(
                "SELECT id, ts_ms, event_type, target, meta_json
                 FROM events
                 WHERE event_type = 'blocked' AND ts_ms >= ?1
                 ORDER BY ts_ms DESC
                 LIMIT 10",
            )
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map(params![cutoff_ms], |r| {
                Ok(RecentEvent {
                    id: r.get(0)?,
                    ts_ms: r.get(1)?,
                    event_type: r.get(2)?,
                    target: r.get(3)?,
                    meta_json: r.get(4)?,
                })
            })
            .map_err(|e| e.to_string())?;
        for row in rows.flatten() {
            recent_events.push(row);
        }
    }

    Ok(DashboardRawData {
        days: clamped_days,
        generated_at_ms: now_ms,
        daily,
        previous_totals,
        top_blocked,
        time_by_target,
        blocked_by_hour,
        recent_events,
    })
}

pub fn query_dashboard_raw(
    db_path: &Path,
    days: i64,
    now_ms: i64,
) -> Result<DashboardRawData, String> {
    let conn = open_database(db_path).map_err(|e| e.to_string())?;
    query_dashboard_conn(&conn, days, now_ms)
}

pub fn clear_all_tables(conn: &mut Connection) -> Result<(), String> {
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    tx.execute("DELETE FROM events", [])
        .map_err(|e| e.to_string())?;
    tx.execute("DELETE FROM segments", [])
        .map_err(|e| e.to_string())?;
    tx.execute("DELETE FROM sessions", [])
        .map_err(|e| e.to_string())?;
    tx.execute("DELETE FROM daily", [])
        .map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::analytics::db::{apply_operations, open_in_memory, WriteOp};

    #[test]
    fn queries_current_and_previous_period_and_recent_events_then_resets() {
        let mut conn = open_in_memory().expect("in-memory db");
        let now_ms: i64 = 1_795_100_000_000;
        let prev_period_ms: i64 = now_ms - (9 * 86_400_000);
        let curr_period_ms: i64 = now_ms - (2 * 86_400_000);

        apply_operations(
            &mut conn,
            &[
                WriteOp::OpenSegment {
                    id: 1,
                    started_at_ms: prev_period_ms,
                    process_name: "code".into(),
                    domain: String::new(),
                    kind: "work".into(),
                    session_id: None,
                },
                WriteOp::CloseSegment {
                    id: 1,
                    started_at_ms: prev_period_ms,
                    ended_at_ms: prev_period_ms + 1_800_000,
                    duration_ms: 1_800_000,
                    kind: "work".into(),
                    domain: String::new(),
                },
                WriteOp::OpenSegment {
                    id: 2,
                    started_at_ms: curr_period_ms,
                    process_name: "code".into(),
                    domain: String::new(),
                    kind: "work".into(),
                    session_id: None,
                },
                WriteOp::CloseSegment {
                    id: 2,
                    started_at_ms: curr_period_ms,
                    ended_at_ms: curr_period_ms + 3_600_000,
                    duration_ms: 3_600_000,
                    kind: "work".into(),
                    domain: String::new(),
                },
                WriteOp::InsertEvent {
                    ts_ms: curr_period_ms + 5000,
                    event_type: "blocked".into(),
                    target: "instagram.com".into(),
                    meta_json: r#"{"kind":"distraction-site"}"#.into(),
                    session_id: None,
                },
            ],
        )
        .expect("seed ops");

        let data = query_dashboard_conn(&conn, 7, now_ms).expect("query 7d");
        assert_eq!(data.days, 7);
        assert_eq!(data.previous_totals.focus_ms, 1_800_000);
        assert_eq!(data.daily.iter().map(|d| d.focus_ms).sum::<i64>(), 3_600_000);
        assert_eq!(data.top_blocked.len(), 1);
        assert_eq!(data.top_blocked[0].target, "instagram.com");
        assert_eq!(data.recent_events.len(), 1);
        assert_eq!(data.recent_events[0].target, "instagram.com");

        clear_all_tables(&mut conn).expect("clear tables");
        let after = query_dashboard_conn(&conn, 7, now_ms).expect("query after reset");
        assert!(after.daily.is_empty());
        assert!(after.recent_events.is_empty());
        assert_eq!(after.previous_totals.focus_ms, 0);
    }
}
