import test from "node:test";
import assert from "node:assert/strict";
import {
  formatDuration,
  computeFocusRate,
  fillDailySeries,
  buildHourlyDistribution,
  computeDashboardViewModel,
  buildCsvExport,
  createPreviewDataset
} from "../core/analytics.js";

test("formatDuration formats zero, sub-minute, minutes, and hours consistently", () => {
  assert.equal(formatDuration(0), "0 min");
  assert.equal(formatDuration(25_000), "< 1 min");
  assert.equal(formatDuration(45 * 60_000), "45 min");
  assert.equal(formatDuration(120 * 60_000), "2 h");
  assert.equal(formatDuration(135 * 60_000), "2 h 15 min");
});

test("computeFocusRate calculates percentage or null when empty", () => {
  assert.equal(computeFocusRate(0, 0), null);
  assert.equal(computeFocusRate(3_600_000, 1_200_000), 75);
  assert.equal(computeFocusRate(600_000, 0), 100);
});

test("fillDailySeries fills missing calendar days with zeros and preserves chronological order", () => {
  const now = new Date("2026-11-20T15:00:00");
  const rawDaily = [
    { day: "2026-11-18", focusMs: 1_800_000, distractionMs: 300_000, blockedCount: 4, sessionsCompleted: 1, sessionsFailed: 0 },
    { day: "2026-11-20", focusMs: 3_600_000, distractionMs: 600_000, blockedCount: 2, sessionsCompleted: 2, sessionsFailed: 0 }
  ];
  const filled = fillDailySeries(rawDaily, 7, now, "fr");
  assert.equal(filled.length, 7);
  assert.equal(filled[0].day, "2026-11-14");
  assert.equal(filled[6].day, "2026-11-20");
  assert.equal(filled[4].focusMs, 1_800_000);
  assert.equal(filled[5].focusMs, 0);
  assert.equal(filled[6].focusMs, 3_600_000);
});

test("buildHourlyDistribution expands 24 hours and finds peak distraction hour", () => {
  const res = buildHourlyDistribution([
    { hour: 10, count: 3 },
    { hour: 15, count: 11 },
    { hour: 21, count: 4 }
  ]);
  assert.equal(res.hours.length, 24);
  assert.equal(res.peakHour, 15);
  assert.equal(res.maxCount, 11);
  assert.equal(res.hours[15].label, "15h");
  assert.equal(res.hours[0].count, 0);
});

test("computeDashboardViewModel computes KPIs and deltas against previous period", () => {
  const now = new Date("2026-11-20T18:00:00");
  const raw = {
    daily: [
      { day: "2026-11-20", focusMs: 5_400_000, distractionMs: 600_000, blockedCount: 5, sessionsCompleted: 3, sessionsFailed: 0 }
    ],
    previousTotals: {
      focusMs: 3_600_000,
      distractionMs: 1_200_000,
      blockedCount: 9,
      sessionsCompleted: 2,
      sessionsFailed: 1
    },
    topBlocked: [{ target: "instagram.com", count: 5 }],
    timeByTarget: [{ target: "code", kind: "work", durationMs: 5_400_000 }],
    blockedByHour: [{ hour: 14, count: 5 }],
    recentEvents: [{ id: 1, tsMs: now.getTime(), eventType: "blocked", target: "instagram.com", metaJson: "{}" }]
  };

  const vm = computeDashboardViewModel(raw, 7, "fr", now);
  assert.equal(vm.kpis.focus.value, "1 h 30 min");
  assert.equal(vm.kpis.focus.delta.tone, "positive");
  assert.match(vm.kpis.focus.delta.text, /\+30 min vs 7 j préc\./);

  // Fewer blocked impulses than previous period (5 vs 9) = positive trend
  assert.equal(vm.kpis.blocked.value, "5");
  assert.equal(vm.kpis.blocked.delta.tone, "positive");
  assert.equal(vm.kpis.blocked.delta.text, "-4 vs 7 j préc.");

  assert.equal(vm.kpis.focusRate.value, "90 %");
  assert.equal(vm.kpis.focusRate.delta.text, "+15 pt vs 7 j préc.");
  assert.equal(vm.kpis.sessions.value, "3");
});

test("buildCsvExport outputs valid header and rows for preview dataset", () => {
  const now = new Date("2026-11-20T18:00:00");
  const preview = createPreviewDataset(7, now);
  const csv = buildCsvExport(preview, 7, now);
  const lines = csv.trim().split("\n");
  assert.equal(lines[0], "day,focus_minutes,distraction_minutes,blocked_count,sessions_completed,sessions_failed");
  assert.equal(lines.length, 8);
  assert.ok(lines[7].startsWith("2026-11-20,"));
});
