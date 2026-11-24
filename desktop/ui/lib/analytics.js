/**
 * Pure analytics aggregation, formatting, CSV export, and browser-preview helpers for Dhirna.
 * Zero DOM or Tauri dependencies so every metric calculation is tested via `node --test`.
 */

import { getLocalDateKey } from "./state.js";

/**
 * Formats a millisecond duration into a compact readable string.
 * Examples:
 *   0         -> "0 min"
 *   45_000    -> "< 1 min"
 *   2_700_000 -> "45 min"
 *   8_100_000 -> "2 h 15 min"
 *
 * @param {number} ms
 * @returns {string}
 */
export function formatDuration(ms) {
  const safe = Math.max(0, Math.round(Number(ms) || 0));
  if (safe === 0) return "0 min";
  const totalMin = Math.floor(safe / 60_000);
  if (totalMin === 0) return "< 1 min";
  const hours = Math.floor(totalMin / 60);
  const mins = totalMin % 60;
  if (hours === 0) return `${mins} min`;
  if (mins === 0) return `${hours} h`;
  return `${hours} h ${String(mins).padStart(2, "0")} min`;
}

/**
 * Computes focus percentage (0..100) from focus and distraction durations.
 * Returns null if no tracked activity exists yet.
 *
 * @param {number} focusMs
 * @param {number} distractionMs
 * @returns {number | null}
 */
export function computeFocusRate(focusMs, distractionMs) {
  const f = Math.max(0, Number(focusMs) || 0);
  const d = Math.max(0, Number(distractionMs) || 0);
  const total = f + d;
  if (total === 0) return null;
  return Math.round((f / total) * 100);
}

/**
 * Returns localized comparison suffix for a window size (`1`, `7`, `30`).
 *
 * @param {number} days
 * @param {"fr" | "en"} [lang]
 * @returns {string}
 */
export function periodComparisonRef(days, lang = "fr") {
  if (lang === "en") {
    if (days <= 1) return "vs yesterday";
    return `vs prev ${days}d`;
  }
  if (days <= 1) return "vs hier";
  return `vs ${days} j préc.`;
}

/**
 * Formats a duration change against the previous period.
 *
 * @param {number} currentMs
 * @param {number} previousMs
 * @param {number} days
 * @param {"fr" | "en"} [lang]
 * @returns {{ text: string, tone: "positive" | "negative" | "neutral" }}
 */
export function formatDurationDelta(currentMs, previousMs, days, lang = "fr") {
  const ref = periodComparisonRef(days, lang);
  const diffMin = Math.round(((Number(currentMs) || 0) - (Number(previousMs) || 0)) / 60_000);
  if (diffMin === 0) {
    return { text: `0 min ${ref}`, tone: "neutral" };
  }
  const sign = diffMin > 0 ? "+" : "-";
  const absMin = Math.abs(diffMin);
  const formatted = absMin >= 60 ? formatDuration(absMin * 60_000) : `${absMin} min`;
  return {
    text: `${sign}${formatted} ${ref}`,
    tone: diffMin > 0 ? "positive" : "negative"
  };
}

/**
 * Formats a count change against the previous period.
 * Note: For blocked attempts, fewer impulses than the previous period is positive (`invertPolarity = true`).
 *
 * @param {number} current
 * @param {number} previous
 * @param {number} days
 * @param {"fr" | "en"} [lang]
 * @param {boolean} [invertPolarity]
 * @returns {{ text: string, tone: "positive" | "negative" | "neutral" }}
 */
export function formatCountDelta(current, previous, days, lang = "fr", invertPolarity = false) {
  const ref = periodComparisonRef(days, lang);
  const diff = (Number(current) || 0) - (Number(previous) || 0);
  if (diff === 0) {
    return { text: `0 ${ref}`, tone: "neutral" };
  }
  const sign = diff > 0 ? "+" : "";
  const isGood = invertPolarity ? diff < 0 : diff > 0;
  return {
    text: `${sign}${diff} ${ref}`,
    tone: isGood ? "positive" : "negative"
  };
}

/**
 * Formats a percentage-point delta against the previous period.
 *
 * @param {number | null} currentPct
 * @param {number | null} previousPct
 * @param {number} days
 * @param {"fr" | "en"} [lang]
 * @returns {{ text: string, tone: "positive" | "negative" | "neutral" }}
 */
export function formatRateDelta(currentPct, previousPct, days, lang = "fr") {
  const ref = periodComparisonRef(days, lang);
  if (currentPct === null || previousPct === null) {
    return { text: lang === "en" ? "No prior baseline" : "Pas de référence préc.", tone: "neutral" };
  }
  const diff = currentPct - previousPct;
  if (diff === 0) {
    return { text: `0 pt ${ref}`, tone: "neutral" };
  }
  const sign = diff > 0 ? "+" : "";
  return {
    text: `${sign}${diff} pt ${ref}`,
    tone: diff > 0 ? "positive" : "negative"
  };
}

/**
 * Produces a contiguous daily series of exact length `days` ending on `now`,
 * filling missing calendar days with zeros.
 *
 * @param {Array<object>} dailyBuckets
 * @param {number} days
 * @param {Date} [now]
 * @param {"fr" | "en"} [lang]
 * @returns {Array<{ day: string, shortLabel: string, focusMs: number, distractionMs: number, blockedCount: number, sessionsCompleted: number, sessionsFailed: number }>}
 */
export function fillDailySeries(dailyBuckets = [], days = 7, now = new Date(), lang = "fr") {
  const clamped = Math.max(1, Math.min(400, Number(days) || 7));
  const byDay = new Map();
  for (const row of Array.isArray(dailyBuckets) ? dailyBuckets : []) {
    if (row && row.day) {
      byDay.set(row.day, row);
    }
  }

  const weekdayFr = ["Dim", "Lun", "Mar", "Mer", "Jeu", "Ven", "Sam"];
  const weekdayEn = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const result = [];

  for (let offset = clamped - 1; offset >= 0; offset -= 1) {
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - offset);
    const key = getLocalDateKey(d);
    const hit = byDay.get(key);
    const shortLabel =
      clamped <= 7
        ? (lang === "en" ? weekdayEn[d.getDay()] : weekdayFr[d.getDay()])
        : `${String(d.getDate()).padStart(2, "0")}/${String(d.getMonth() + 1).padStart(2, "0")}`;

    result.push({
      day: key,
      shortLabel,
      focusMs: Number(hit?.focusMs) || 0,
      distractionMs: Number(hit?.distractionMs) || 0,
      blockedCount: Number(hit?.blockedCount) || 0,
      sessionsCompleted: Number(hit?.sessionsCompleted) || 0,
      sessionsFailed: Number(hit?.sessionsFailed) || 0
    });
  }

  return result;
}

/**
 * Expands sparse `{ hour, count }` buckets into a full 24-hour array (`0..23`)
 * and returns the peak hour (if any blocked attempts exist).
 *
 * @param {Array<{ hour: number, count: number }>} blockedByHour
 * @returns {{ hours: Array<{ hour: number, label: string, count: number }>, peakHour: number | null, maxCount: number }}
 */
export function buildHourlyDistribution(blockedByHour = []) {
  const map = new Map();
  for (const row of Array.isArray(blockedByHour) ? blockedByHour : []) {
    const h = Number(row?.hour);
    if (Number.isInteger(h) && h >= 0 && h <= 23) {
      map.set(h, (map.get(h) || 0) + (Number(row?.count) || 0));
    }
  }

  let peakHour = null;
  let maxCount = 0;
  const hours = [];

  for (let h = 0; h < 24; h += 1) {
    const count = map.get(h) || 0;
    if (count > maxCount) {
      maxCount = count;
      peakHour = h;
    }
    hours.push({
      hour: h,
      label: `${String(h).padStart(2, "0")}h`,
      count
    });
  }

  return { hours, peakHour, maxCount };
}

/**
 * Builds the complete dashboard view model from raw SQLite (or preview) data.
 *
 * @param {object} rawData
 * @param {number} [days]
 * @param {"fr" | "en"} [lang]
 * @param {Date} [now]
 */
export function computeDashboardViewModel(rawData, days = 7, lang = "fr", now = new Date()) {
  const series = fillDailySeries(rawData?.daily || [], days, now, lang);
  const totals = series.reduce(
    (acc, row) => {
      acc.focusMs += row.focusMs;
      acc.distractionMs += row.distractionMs;
      acc.blockedCount += row.blockedCount;
      acc.sessionsCompleted += row.sessionsCompleted;
      acc.sessionsFailed += row.sessionsFailed;
      return acc;
    },
    { focusMs: 0, distractionMs: 0, blockedCount: 0, sessionsCompleted: 0, sessionsFailed: 0 }
  );

  const prev = rawData?.previousTotals || {
    focusMs: 0,
    distractionMs: 0,
    blockedCount: 0,
    sessionsCompleted: 0,
    sessionsFailed: 0
  };

  const focusRate = computeFocusRate(totals.focusMs, totals.distractionMs);
  const prevFocusRate = computeFocusRate(prev.focusMs, prev.distractionMs);
  const hourly = buildHourlyDistribution(rawData?.blockedByHour || []);

  const topBlocked = (Array.isArray(rawData?.topBlocked) ? rawData.topBlocked : []).slice(0, 8);
  const timeByTarget = (Array.isArray(rawData?.timeByTarget) ? rawData.timeByTarget : []).slice(0, 8);
  const recentEvents = (Array.isArray(rawData?.recentEvents) ? rawData.recentEvents : []).slice(0, 10);

  return {
    days,
    totals,
    kpis: {
      focus: {
        value: formatDuration(totals.focusMs),
        delta: formatDurationDelta(totals.focusMs, prev.focusMs, days, lang)
      },
      blocked: {
        value: String(totals.blockedCount),
        delta: formatCountDelta(totals.blockedCount, prev.blockedCount, days, lang, true)
      },
      focusRate: {
        value: focusRate === null ? "—" : `${focusRate} %`,
        delta: formatRateDelta(focusRate, prevFocusRate, days, lang)
      },
      sessions: {
        value: String(totals.sessionsCompleted),
        delta: formatCountDelta(totals.sessionsCompleted, prev.sessionsCompleted, days, lang, false)
      }
    },
    series,
    hourly,
    topBlocked,
    timeByTarget,
    recentEvents
  };
}

/**
 * Escapes a single CSV field according to RFC 4180.
 *
 * @param {string | number} value
 * @returns {string}
 */
function csvCell(value) {
  const s = String(value ?? "");
  if (s.includes(",") || s.includes('"') || s.includes("\n")) {
    return `"${s.replaceAll('"', '""')}"`;
  }
  return s;
}

/**
 * Generates a UTF-8 CSV report of daily focus time, distractions, blocked count, and completed sessions.
 *
 * @param {object} rawData
 * @param {number} [days]
 * @param {Date} [now]
 * @returns {string}
 */
export function buildCsvExport(rawData, days = 7, now = new Date()) {
  const series = fillDailySeries(rawData?.daily || [], days, now, "en");
  const lines = ["day,focus_minutes,distraction_minutes,blocked_count,sessions_completed,sessions_failed"];
  for (const row of series) {
    lines.push(
      [
        csvCell(row.day),
        Math.round(row.focusMs / 60_000),
        Math.round(row.distractionMs / 60_000),
        row.blockedCount,
        row.sessionsCompleted,
        row.sessionsFailed
      ].join(",")
    );
  }
  return `${lines.join("\n")}\n`;
}

/**
 * Deterministic local preview dataset used ONLY when `desktop/ui/index.html` is opened in a regular
 * browser outside Tauri (so the user can inspect and test the dashboard locally without Rust).
 *
 * @param {number} [days]
 * @param {Date} [now]
 */
export function createPreviewDataset(days = 7, now = new Date()) {
  const clamped = Math.max(1, Math.min(30, Number(days) || 7));
  const focusPatternMin = [145, 210, 180, 95, 240, 165, 195];
  const distPatternMin = [22, 18, 35, 28, 12, 19, 14];
  const blockedPattern = [7, 5, 11, 9, 4, 6, 3];
  const sessPattern = [3, 4, 3, 2, 5, 3, 4];

  const daily = [];
  for (let offset = clamped - 1; offset >= 0; offset -= 1) {
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - offset);
    const idx = offset % focusPatternMin.length;
    daily.push({
      day: getLocalDateKey(d),
      focusMs: focusPatternMin[idx] * 60_000,
      distractionMs: distPatternMin[idx] * 60_000,
      blockedCount: blockedPattern[idx],
      sessionsCompleted: sessPattern[idx],
      sessionsFailed: offset % 5 === 0 ? 1 : 0
    });
  }

  const scale = clamped === 1 ? 1 : clamped === 7 ? 7 : 30;
  const previousTotals = {
    focusMs: Math.round(scale * 155 * 60_000),
    distractionMs: Math.round(scale * 24 * 60_000),
    blockedCount: Math.round(scale * 7),
    sessionsCompleted: Math.round(scale * 3),
    sessionsFailed: Math.max(0, Math.round(scale * 0.2))
  };

  const nowMs = now.getTime();
  return {
    days: clamped,
    generatedAtMs: nowMs,
    isPreview: true,
    daily,
    previousTotals,
    topBlocked: [
      { target: "instagram.com", count: Math.max(2, Math.round(scale * 2.6)) },
      { target: "youtube.com", count: Math.max(1, Math.round(scale * 1.8)) },
      { target: "discord", count: Math.max(1, Math.round(scale * 1.2)) },
      { target: "tiktok.com", count: Math.max(1, Math.round(scale * 0.9)) },
      { target: "reddit.com", count: Math.max(1, Math.round(scale * 0.5)) }
    ],
    timeByTarget: [
      { target: "code", kind: "work", durationMs: Math.round(scale * 92 * 60_000) },
      { target: "docs.google.com", kind: "work", durationMs: Math.round(scale * 54 * 60_000) },
      { target: "github.com", kind: "work", durationMs: Math.round(scale * 28 * 60_000) },
      { target: "soffice.bin", kind: "work", durationMs: Math.round(scale * 18 * 60_000) },
      { target: "instagram.com", kind: "distraction", durationMs: Math.round(scale * 9 * 60_000) },
      { target: "discord", kind: "distraction", durationMs: Math.round(scale * 7 * 60_000) }
    ],
    blockedByHour: [
      { hour: 9, count: 2 },
      { hour: 10, count: 4 },
      { hour: 11, count: 6 },
      { hour: 14, count: 9 },
      { hour: 15, count: 11 },
      { hour: 16, count: 7 },
      { hour: 17, count: 5 },
      { hour: 21, count: 4 }
    ],
    recentEvents: [
      { id: 10, tsMs: nowMs - 14 * 60_000, eventType: "blocked", target: "instagram.com", metaJson: '{"kind":"distraction-site"}' },
      { id: 9, tsMs: nowMs - 48 * 60_000, eventType: "blocked", target: "discord", metaJson: '{"kind":"distraction-app"}' },
      { id: 8, tsMs: nowMs - 95 * 60_000, eventType: "blocked", target: "youtube.com", metaJson: '{"kind":"distraction-site"}' },
      { id: 7, tsMs: nowMs - 150 * 60_000, eventType: "blocked", target: "instagram.com", metaJson: '{"kind":"distraction-site"}' },
      { id: 6, tsMs: nowMs - 210 * 60_000, eventType: "blocked", target: "tiktok.com", metaJson: '{"kind":"distraction-site"}' }
    ]
  };
}
