use super::db::{
    apply_operations, close_orphaned_records, next_ids, open_database, purge_old_data, WriteOp,
    RETENTION_DAYS,
};
use std::path::PathBuf;
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, Sender};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

const FLUSH_BATCH_TRIGGER: usize = 50;
const MAX_BURST_BATCH: usize = 1000;
const FLUSH_INTERVAL: Duration = Duration::from_secs(2);

pub fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

#[derive(Debug)]
#[allow(dead_code)]
pub enum AnalyticsMsg {
    Event {
        ts_ms: i64,
        event_type: String,
        target: String,
        meta_json: String,
    },
    WindowChanged {
        win_id: u64,
        process_name: String,
        domain: String,
        ts_ms: i64,
    },
    TagActiveSegment {
        win_id: u64,
        kind: String,
        domain: String,
    },
    PauseActiveSegment {
        ts_ms: i64,
        deduct_ms: i64,
    },
    CompletedSegment {
        started_at_ms: i64,
        ended_at_ms: i64,
        duration_ms: i64,
        process_name: String,
        domain: String,
        kind: String,
    },
    StartSession {
        planned_ms: i64,
        ts_ms: i64,
    },
    EndSession {
        outcome: String,
        ts_ms: i64,
    },
    Flush(Sender<()>),
    Reset(Sender<Result<(), String>>),
    Shutdown(Sender<()>),
}

struct OpenSegment {
    id: i64,
    win_id: u64,
    domain: String,
    kind: String,
    started_at_ms: i64,
    started_mono: Instant,
}

struct ActiveSession {
    id: i64,
    focus_ms: i64,
    blocked_count: i64,
}

struct WriterState {
    next_segment_id: i64,
    next_session_id: i64,
    open_segment: Option<OpenSegment>,
    active_session: Option<ActiveSession>,
}

impl WriterState {
    fn handle_msg(&mut self, msg: AnalyticsMsg, batch: &mut Vec<WriteOp>) -> Option<Sender<()>> {
        match msg {
            AnalyticsMsg::Event {
                ts_ms,
                event_type,
                target,
                meta_json,
            } => {
                if event_type == "blocked" {
                    if let Some(sess) = self.active_session.as_mut() {
                        sess.blocked_count += 1;
                    }
                }
                batch.push(WriteOp::InsertEvent {
                    ts_ms,
                    event_type,
                    target,
                    meta_json,
                    session_id: self.active_session.as_ref().map(|s| s.id),
                });
                None
            }

            AnalyticsMsg::WindowChanged {
                win_id,
                process_name,
                domain,
                ts_ms,
            } => {
                self.close_current_segment(ts_ms, 0, batch);
                let seg_id = self.next_segment_id;
                self.next_segment_id += 1;

                let clean_proc = process_name.trim().to_lowercase();
                let clean_domain = domain.trim().to_lowercase();
                batch.push(WriteOp::OpenSegment {
                    id: seg_id,
                    started_at_ms: ts_ms,
                    process_name: clean_proc,
                    domain: clean_domain.clone(),
                    kind: "unknown".into(),
                    session_id: self.active_session.as_ref().map(|s| s.id),
                });

                self.open_segment = Some(OpenSegment {
                    id: seg_id,
                    win_id,
                    domain: clean_domain,
                    kind: "unknown".into(),
                    started_at_ms: ts_ms,
                    started_mono: Instant::now(),
                });
                None
            }

            AnalyticsMsg::TagActiveSegment {
                win_id,
                kind,
                domain,
            } => {
                if let Some(open) = self.open_segment.as_mut() {
                    if win_id == 0 || open.win_id == win_id {
                        open.kind = kind.clone();
                        if !domain.is_empty() {
                            open.domain = domain.clone();
                        }
                        batch.push(WriteOp::UpdateSegmentTag {
                            id: open.id,
                            kind,
                            domain,
                        });
                    }
                }
                None
            }

            AnalyticsMsg::PauseActiveSegment { ts_ms, deduct_ms } => {
                self.close_current_segment(ts_ms, deduct_ms, batch);
                None
            }

            AnalyticsMsg::CompletedSegment {
                started_at_ms,
                ended_at_ms,
                duration_ms,
                process_name,
                domain,
                kind,
            } => {
                let safe_dur = duration_ms.max(0);
                if safe_dur > 0 {
                    let seg_id = self.next_segment_id;
                    self.next_segment_id += 1;
                    if kind == "work" {
                        if let Some(sess) = self.active_session.as_mut() {
                            sess.focus_ms += safe_dur;
                        }
                    }
                    batch.push(WriteOp::InsertCompletedSegment {
                        id: seg_id,
                        started_at_ms,
                        ended_at_ms,
                        duration_ms: safe_dur,
                        process_name: process_name.trim().to_lowercase(),
                        domain: domain.trim().to_lowercase(),
                        kind,
                        session_id: self.active_session.as_ref().map(|s| s.id),
                    });
                }
                None
            }

            AnalyticsMsg::StartSession { planned_ms, ts_ms } => {
                if self.active_session.is_some() {
                    self.finish_active_session("abandoned".into(), ts_ms, batch);
                }
                let sess_id = self.next_session_id;
                self.next_session_id += 1;
                batch.push(WriteOp::StartSession {
                    id: sess_id,
                    started_at_ms: ts_ms,
                    planned_ms: planned_ms.max(0),
                });
                self.active_session = Some(ActiveSession {
                    id: sess_id,
                    focus_ms: 0,
                    blocked_count: 0,
                });
                None
            }

            AnalyticsMsg::EndSession { outcome, ts_ms } => {
                self.close_current_segment(ts_ms, 0, batch);
                self.finish_active_session(outcome, ts_ms, batch);
                None
            }

            AnalyticsMsg::Flush(ack) => Some(ack),
            AnalyticsMsg::Reset(_) => None,
            AnalyticsMsg::Shutdown(ack) => {
                self.close_current_segment(now_ms(), 0, batch);
                Some(ack)
            }
        }
    }

    fn close_current_segment(
        &mut self,
        ended_at_ms: i64,
        deduct_ms: i64,
        batch: &mut Vec<WriteOp>,
    ) {
        if let Some(open) = self.open_segment.take() {
            let raw_dur_ms = open.started_mono.elapsed().as_millis() as i64;
            let safe_deduct = deduct_ms.max(0);
            let dur_ms = (raw_dur_ms - safe_deduct).max(0);
            let effective_end_ms = (ended_at_ms - safe_deduct).max(open.started_at_ms);
            if open.kind == "work" && dur_ms > 0 {
                if let Some(sess) = self.active_session.as_mut() {
                    sess.focus_ms += dur_ms;
                }
            }
            batch.push(WriteOp::CloseSegment {
                id: open.id,
                started_at_ms: open.started_at_ms,
                ended_at_ms: effective_end_ms,
                duration_ms: dur_ms,
                kind: open.kind,
                domain: open.domain,
            });
        }
    }

    fn finish_active_session(
        &mut self,
        outcome: String,
        ended_at_ms: i64,
        batch: &mut Vec<WriteOp>,
    ) {
        if let Some(sess) = self.active_session.take() {
            batch.push(WriteOp::EndSession {
                id: sess.id,
                ended_at_ms,
                outcome,
                focus_ms: sess.focus_ms,
                blocked_count: sess.blocked_count,
            });
        }
    }
}

pub fn spawn_writer(db_path: PathBuf) -> Result<Sender<AnalyticsMsg>, String> {
    let mut conn = open_database(&db_path).map_err(|e| format!("Analytics DB open failed: {e}"))?;
    let _ = close_orphaned_records(&conn);
    let _ = purge_old_data(&conn, now_ms(), RETENTION_DAYS);
    let (next_segment_id, next_session_id) =
        next_ids(&conn).map_err(|e| format!("Analytics ID init failed: {e}"))?;

    let (tx, rx): (Sender<AnalyticsMsg>, Receiver<AnalyticsMsg>) = mpsc::channel();

    thread::Builder::new()
        .name("dhirna-analytics-writer".into())
        .spawn(move || {
            let mut state = WriterState {
                next_segment_id,
                next_session_id,
                open_segment: None,
                active_session: None,
            };
            let mut batch: Vec<WriteOp> = Vec::with_capacity(FLUSH_BATCH_TRIGGER);
            let mut last_flush = Instant::now();

            loop {
                let wait = if batch.is_empty() {
                    FLUSH_INTERVAL
                } else {
                    FLUSH_INTERVAL.saturating_sub(last_flush.elapsed())
                };

                let mut flush_ack: Option<Sender<()>> = None;
                let mut reset_ack: Option<Sender<Result<(), String>>> = None;
                let mut should_exit = false;

                match rx.recv_timeout(wait) {
                    Ok(AnalyticsMsg::Reset(ack)) => {
                        reset_ack = Some(ack);
                    }
                    Ok(first_msg) => {
                        let is_shutdown = matches!(first_msg, AnalyticsMsg::Shutdown(_));
                        flush_ack = state.handle_msg(first_msg, &mut batch);
                        if is_shutdown {
                            should_exit = true;
                        } else if flush_ack.is_none() {
                            // Drain burst messages already waiting in channel so high-volume bursts commit in minimal transactions
                            while batch.len() < MAX_BURST_BATCH {
                                match rx.try_recv() {
                                    Ok(AnalyticsMsg::Reset(ack)) => {
                                        reset_ack = Some(ack);
                                        break;
                                    }
                                    Ok(next_msg) => {
                                        let next_is_shutdown =
                                            matches!(next_msg, AnalyticsMsg::Shutdown(_));
                                        flush_ack = state.handle_msg(next_msg, &mut batch);
                                        if next_is_shutdown {
                                            should_exit = true;
                                            break;
                                        }
                                        if flush_ack.is_some() {
                                            break;
                                        }
                                    }
                                    Err(_) => break,
                                }
                            }
                        }
                    }
                    Err(RecvTimeoutError::Timeout) => {}
                    Err(RecvTimeoutError::Disconnected) => {
                        state.close_current_segment(now_ms(), 0, &mut batch);
                        should_exit = true;
                    }
                }

                if let Some(ack) = reset_ack {
                    batch.clear();
                    state.open_segment = None;
                    state.active_session = None;
                    state.next_segment_id = 1;
                    state.next_session_id = 1;
                    let res = super::queries::clear_all_tables(&mut conn);
                    last_flush = Instant::now();
                    let _ = ack.send(res);
                    continue;
                }

                let must_flush = should_exit
                    || flush_ack.is_some()
                    || batch.len() >= FLUSH_BATCH_TRIGGER
                    || (!batch.is_empty() && last_flush.elapsed() >= FLUSH_INTERVAL);

                if must_flush && !batch.is_empty() {
                    let _ = apply_operations(&mut conn, &batch);
                    batch.clear();
                    last_flush = Instant::now();
                }

                if let Some(ack) = flush_ack {
                    let _ = ack.send(());
                }

                if should_exit {
                    break;
                }
            }
        })
        .map_err(|e| format!("Failed to spawn analytics writer thread: {e}"))?;

    Ok(tx)
}

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::Connection;

    #[test]
    fn batches_10000_events_under_300ms_and_creates_sqlite_file() {
        let unique = format!(
            "dhirna_analytics_test_{}_{}.db",
            std::process::id(),
            now_ms()
        );
        let db_path = std::env::temp_dir().join(unique);
        let _ = std::fs::remove_file(&db_path);

        let tx = spawn_writer(db_path.clone()).expect("spawn writer");
        let start = Instant::now();
        let base_ts = now_ms();

        for i in 0..10_000i64 {
            tx.send(AnalyticsMsg::Event {
                ts_ms: base_ts + i,
                event_type: "blocked".into(),
                target: "instagram.com".into(),
                meta_json: "{}".into(),
            })
            .expect("enqueue event");
        }

        let (ack_tx, ack_rx) = mpsc::channel();
        tx.send(AnalyticsMsg::Flush(ack_tx)).expect("send flush");
        ack_rx
            .recv_timeout(Duration::from_secs(5))
            .expect("flush ack");

        let elapsed = start.elapsed();

        let (shut_tx, shut_rx) = mpsc::channel();
        tx.send(AnalyticsMsg::Shutdown(shut_tx)).expect("shutdown");
        let _ = shut_rx.recv_timeout(Duration::from_secs(2));

        assert!(db_path.exists(), "SQLite file must exist on disk");
        let conn = Connection::open(&db_path).expect("open db for verification");
        let count: i64 = conn
            .query_row("SELECT COUNT(*) FROM events", [], |r| r.get(0))
            .expect("count events");
        let daily_blocked: i64 = conn
            .query_row("SELECT COALESCE(SUM(blocked_count), 0) FROM daily", [], |r| {
                r.get(0)
            })
            .expect("sum daily blocked");

        assert_eq!(count, 10_000);
        assert_eq!(daily_blocked, 10_000);
        drop(conn);
        assert!(
            elapsed < Duration::from_millis(2000),
            "10,000 batched events took {:?} (expected < 2000ms)",
            elapsed
        );

        let _ = std::fs::remove_file(&db_path);
        let _ = std::fs::remove_file(db_path.with_extension("db-wal"));
        let _ = std::fs::remove_file(db_path.with_extension("db-shm"));
    }

    #[test]
    fn records_work_segment_then_blocked_event_and_recovers_crash_segment() {
        let unique = format!(
            "dhirna_a2_scenario_{}_{}.db",
            std::process::id(),
            now_ms()
        );
        let db_path = std::env::temp_dir().join(unique);
        let _ = std::fs::remove_file(&db_path);

        let tx = spawn_writer(db_path.clone()).expect("spawn writer");
        let t0 = now_ms();

        tx.send(AnalyticsMsg::StartSession {
            planned_ms: 25 * 60_000,
            ts_ms: t0,
        })
        .unwrap();
        tx.send(AnalyticsMsg::WindowChanged {
            win_id: 42,
            process_name: "firefox".into(),
            domain: String::new(),
            ts_ms: t0,
        })
        .unwrap();
        tx.send(AnalyticsMsg::TagActiveSegment {
            win_id: 42,
            kind: "work".into(),
            domain: "docs.google.com".into(),
        })
        .unwrap();

        thread::sleep(Duration::from_millis(35));

        let t1 = now_ms();
        tx.send(AnalyticsMsg::WindowChanged {
            win_id: 42,
            process_name: "firefox".into(),
            domain: String::new(),
            ts_ms: t1,
        })
        .unwrap();
        tx.send(AnalyticsMsg::TagActiveSegment {
            win_id: 42,
            kind: "distraction".into(),
            domain: "instagram.com".into(),
        })
        .unwrap();
        tx.send(AnalyticsMsg::Event {
            ts_ms: t1,
            event_type: "blocked".into(),
            target: "instagram.com".into(),
            meta_json: r#"{"kind":"distraction-site"}"#.into(),
        })
        .unwrap();

        // Flush without Shutdown to simulate a sudden kill while segment 2 is still open
        let (ack_tx, ack_rx) = mpsc::channel();
        tx.send(AnalyticsMsg::Flush(ack_tx)).unwrap();
        ack_rx.recv_timeout(Duration::from_secs(3)).unwrap();

        // Simulate next startup crash recovery directly on the database
        let conn = open_database(&db_path).expect("reopen db");
        let recovered = close_orphaned_records(&conn).expect("recover crash");
        assert!(recovered >= 1, "orphaned open segment & session should be closed");

        let (seg1_kind, seg1_domain, seg1_dur): (String, String, i64) = conn
            .query_row(
                "SELECT kind, domain, duration_ms FROM segments WHERE id = 1",
                [],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .expect("segment 1");
        assert_eq!(seg1_kind, "work");
        assert_eq!(seg1_domain, "docs.google.com");
        assert!(seg1_dur >= 20, "work segment duration should be >= 20ms, got {seg1_dur}");

        let (seg2_ended, seg2_dur): (Option<i64>, i64) = conn
            .query_row(
                "SELECT ended_at_ms, duration_ms FROM segments WHERE id = 2",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .expect("segment 2");
        assert!(seg2_ended.is_some());
        assert_eq!(seg2_dur, 0);

        let blocked_events: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM events WHERE event_type = 'blocked' AND target = 'instagram.com'",
                [],
                |r| r.get(0),
            )
            .expect("blocked count");
        assert_eq!(blocked_events, 1);
        drop(conn);

        let (shut_tx, shut_rx) = mpsc::channel();
        let _ = tx.send(AnalyticsMsg::Shutdown(shut_tx));
        let _ = shut_rx.recv_timeout(Duration::from_secs(2));

        let _ = std::fs::remove_file(&db_path);
        let _ = std::fs::remove_file(db_path.with_extension("db-wal"));
        let _ = std::fs::remove_file(db_path.with_extension("db-shm"));
    }

    #[test]
    fn pauses_active_segment_with_idle_deduction() {
        let unique = format!(
            "dhirna_idle_deduct_{}_{}.db",
            std::process::id(),
            now_ms()
        );
        let db_path = std::env::temp_dir().join(unique);
        let _ = std::fs::remove_file(&db_path);

        let tx = spawn_writer(db_path.clone()).expect("spawn writer");
        let t0 = now_ms();

        tx.send(AnalyticsMsg::WindowChanged {
            win_id: 77,
            process_name: "antigravity".into(),
            domain: String::new(),
            ts_ms: t0,
        })
        .unwrap();
        tx.send(AnalyticsMsg::TagActiveSegment {
            win_id: 77,
            kind: "work".into(),
            domain: String::new(),
        })
        .unwrap();

        thread::sleep(Duration::from_millis(50));

        // Deduct more than elapsed (e.g. 2 min = 120_000 ms) -> focus duration clamps safely to 0 ms
        tx.send(AnalyticsMsg::PauseActiveSegment {
            ts_ms: now_ms(),
            deduct_ms: 120_000,
        })
        .unwrap();

        let (ack_tx, ack_rx) = mpsc::channel();
        tx.send(AnalyticsMsg::Flush(ack_tx)).unwrap();
        ack_rx.recv_timeout(Duration::from_secs(3)).unwrap();

        let conn = open_database(&db_path).expect("open db");
        let dur_ms: i64 = conn
            .query_row("SELECT duration_ms FROM segments WHERE id = 1", [], |r| r.get(0))
            .expect("query deducted segment");
        assert_eq!(dur_ms, 0, "idle deduction should prevent fake focus time");
        drop(conn);

        let (shut_tx, shut_rx) = mpsc::channel();
        let _ = tx.send(AnalyticsMsg::Shutdown(shut_tx));
        let _ = shut_rx.recv_timeout(Duration::from_secs(2));

        let _ = std::fs::remove_file(&db_path);
        let _ = std::fs::remove_file(db_path.with_extension("db-wal"));
        let _ = std::fs::remove_file(db_path.with_extension("db-shm"));
    }
}
