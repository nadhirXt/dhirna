import test from "node:test";
import assert from "node:assert/strict";
import {
  createEmptyExtensionAnalytics,
  recordExtensionSegment,
  recordExtensionBlocked,
  recordExtensionSession,
  buildLocalDashboardRaw,
  pruneExtensionAnalytics
} from "../core/ext_analytics.js";

test("extension analytics records real focus segments, blocked attempts, sessions and computes previousTotals", () => {
  const now = new Date("2026-11-21T14:30:00");
  const nowMs = now.getTime();
  const prevMs = nowMs - 9 * 86_400_000;
  const currMs = nowMs - 1 * 86_400_000;

  let store = createEmptyExtensionAnalytics();

  // Previous 7-day window: 30 min on docs.google.com + 2 blocks
  store = recordExtensionSegment(store, {
    domain: "docs.google.com",
    kind: "work",
    durationMs: 30 * 60_000,
    endedAtMs: prevMs
  });
  store = recordExtensionBlocked(store, { domain: "instagram.com", tsMs: prevMs + 5000 });
  store = recordExtensionBlocked(store, { domain: "tiktok.com", tsMs: prevMs + 10_000 });

  // Current 7-day window: 60 min on docs.google.com + 15 min on github.com + 1 block + 1 session
  store = recordExtensionSegment(store, {
    domain: "docs.google.com",
    kind: "work",
    durationMs: 60 * 60_000,
    endedAtMs: currMs
  });
  store = recordExtensionSegment(store, {
    domain: "github.com",
    kind: "work",
    durationMs: 15 * 60_000,
    endedAtMs: nowMs
  });
  store = recordExtensionBlocked(store, { domain: "instagram.com", tsMs: nowMs });
  store = recordExtensionSession(store, { outcome: "completed", endedAtMs: nowMs });

  const raw = buildLocalDashboardRaw(store, 7, nowMs);
  assert.equal(raw.days, 7);
  assert.equal(raw.previousTotals.focusMs, 30 * 60_000);
  assert.equal(raw.previousTotals.blockedCount, 2);

  const currFocusMs = raw.daily.reduce((s, d) => s + d.focusMs, 0);
  const currBlocked = raw.daily.reduce((s, d) => s + d.blockedCount, 0);
  const currSessions = raw.daily.reduce((s, d) => s + d.sessionsCompleted, 0);
  assert.equal(currFocusMs, 75 * 60_000);
  assert.equal(currBlocked, 1);
  assert.equal(currSessions, 1);

  assert.equal(raw.topBlocked[0].target, "instagram.com");
  assert.equal(raw.topBlocked[0].count, 1);
  assert.equal(raw.timeByTarget[0].target, "docs.google.com");
  assert.equal(raw.timeByTarget[0].durationMs, 60 * 60_000);
  assert.equal(raw.blockedByHour.length, 1);
  assert.equal(raw.blockedByHour[0].hour, 14);
  assert.equal(raw.recentEvents.length, 1);
});

test("pruneExtensionAnalytics removes entries older than retention window", () => {
  const nowMs = new Date("2026-11-21T12:00:00").getTime();
  const veryOldMs = nowMs - 450 * 86_400_000;

  let store = createEmptyExtensionAnalytics();
  store = recordExtensionBlocked(store, { domain: "instagram.com", tsMs: veryOldMs });
  store = recordExtensionBlocked(store, { domain: "youtube.com", tsMs: nowMs });

  const pruned = pruneExtensionAnalytics(store, nowMs, 400);
  assert.equal(Object.keys(pruned.daily).length, 1);
  assert.equal(pruned.recentEvents.length, 1);
  assert.equal(pruned.recentEvents[0].target, "youtube.com");
});
