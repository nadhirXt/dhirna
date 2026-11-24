/**
 * Pure local analytics store for the Browser Extension (`chrome.storage.local`).
 * Produces the exact same `DashboardRawData` shape as the Desktop SQLite backend so
 * `core/analytics.js` and `core/charts.js` render both identically.
 */

import { getLocalDateKey } from "./state.js";

export const EXT_RETENTION_DAYS = 400;
const MAX_RECENT_EVENTS = 50;

export function createEmptyExtensionAnalytics() {
  return {
    version: 1,
    daily: {}, // { "YYYY-MM-DD": { focusMs, distractionMs, blockedCount, sessionsCompleted, sessionsFailed } }
    targetsByDay: {}, // { "YYYY-MM-DD": { "<target>|<kind>": durationMs } }
    blockedByDay: {}, // { "YYYY-MM-DD": { "<target>": count } }
    hoursByDay: {}, // { "YYYY-MM-DD": { "<0..23>": count } }
    recentEvents: [] // [{ id, tsMs, eventType, target, metaJson }]
  };
}

function ensureStore(store) {
  const base = createEmptyExtensionAnalytics();
  if (!store || typeof store !== "object") return base;
  return {
    version: 1,
    daily: { ...(store.daily || {}) },
    targetsByDay: { ...(store.targetsByDay || {}) },
    blockedByDay: { ...(store.blockedByDay || {}) },
    hoursByDay: { ...(store.hoursByDay || {}) },
    recentEvents: Array.isArray(store.recentEvents) ? [...store.recentEvents] : []
  };
}

function ensureDayBucket(dailyMap, dayKey) {
  const prev = dailyMap[dayKey] || {};
  return {
    focusMs: Number(prev.focusMs) || 0,
    distractionMs: Number(prev.distractionMs) || 0,
    blockedCount: Number(prev.blockedCount) || 0,
    sessionsCompleted: Number(prev.sessionsCompleted) || 0,
    sessionsFailed: Number(prev.sessionsFailed) || 0
  };
}

export function pruneExtensionAnalytics(store, nowMs = Date.now(), retentionDays = EXT_RETENTION_DAYS) {
  const next = ensureStore(store);
  const cutoffDate = new Date(nowMs - retentionDays * 86_400_000);
  const cutoffKey = getLocalDateKey(cutoffDate);

  for (const mapName of ["daily", "targetsByDay", "blockedByDay", "hoursByDay"]) {
    const map = next[mapName];
    for (const dayKey of Object.keys(map)) {
      if (dayKey < cutoffKey) {
        delete map[dayKey];
      }
    }
  }

  const cutoffMs = nowMs - retentionDays * 86_400_000;
  next.recentEvents = next.recentEvents
    .filter((ev) => (Number(ev?.tsMs) || 0) >= cutoffMs)
    .slice(0, MAX_RECENT_EVENTS);

  return next;
}

/**
 * Records a completed active foreground tab segment (real focus / distraction / neutral time).
 */
export function recordExtensionSegment(
  store,
  { domain, kind = "neutral", durationMs = 0, endedAtMs = Date.now() }
) {
  const safeDur = Math.max(0, Math.round(Number(durationMs) || 0));
  const cleanDomain = String(domain || "").trim().toLowerCase();
  if (safeDur < 1000 || !cleanDomain) {
    return ensureStore(store);
  }

  const next = ensureStore(store);
  const dayKey = getLocalDateKey(new Date(endedAtMs));

  const bucket = ensureDayBucket(next.daily, dayKey);
  if (kind === "work") bucket.focusMs += safeDur;
  if (kind === "distraction") bucket.distractionMs += safeDur;
  next.daily[dayKey] = bucket;

  const dayTargets = { ...(next.targetsByDay[dayKey] || {}) };
  const targetKey = `${cleanDomain}|${kind}`;
  dayTargets[targetKey] = (Number(dayTargets[targetKey]) || 0) + safeDur;
  next.targetsByDay[dayKey] = dayTargets;

  return next;
}

/**
 * Records a blocked distraction attempt from the extension.
 */
export function recordExtensionBlocked(
  store,
  { domain, tsMs = Date.now(), kind = "distraction-site" }
) {
  const cleanDomain = String(domain || "inconnu").trim().toLowerCase();
  const next = ensureStore(store);
  const dt = new Date(tsMs);
  const dayKey = getLocalDateKey(dt);
  const hourKey = String(dt.getHours());

  const bucket = ensureDayBucket(next.daily, dayKey);
  bucket.blockedCount += 1;
  next.daily[dayKey] = bucket;

  const dayBlocked = { ...(next.blockedByDay[dayKey] || {}) };
  dayBlocked[cleanDomain] = (Number(dayBlocked[cleanDomain]) || 0) + 1;
  next.blockedByDay[dayKey] = dayBlocked;

  const dayHours = { ...(next.hoursByDay[dayKey] || {}) };
  dayHours[hourKey] = (Number(dayHours[hourKey]) || 0) + 1;
  next.hoursByDay[dayKey] = dayHours;

  const nextId = (next.recentEvents[0]?.id || 0) + 1;
  next.recentEvents.unshift({
    id: nextId,
    tsMs,
    eventType: "blocked",
    target: cleanDomain,
    metaJson: JSON.stringify({ kind, source: "extension" })
  });
  next.recentEvents = next.recentEvents.slice(0, MAX_RECENT_EVENTS);

  return next;
}

/**
 * Records a completed or failed timed focus session in local extension analytics.
 */
export function recordExtensionSession(store, { outcome = "completed", endedAtMs = Date.now() }) {
  const next = ensureStore(store);
  const dayKey = getLocalDateKey(new Date(endedAtMs));
  const bucket = ensureDayBucket(next.daily, dayKey);
  if (outcome === "completed") {
    bucket.sessionsCompleted += 1;
  } else if (outcome === "abandoned" || outcome === "emergency") {
    bucket.sessionsFailed += 1;
  }
  next.daily[dayKey] = bucket;
  return next;
}

/**
 * Builds the exact `DashboardRawData` object expected by `computeDashboardViewModel`
 * from the extension's local `chrome.storage.local` store.
 */
export function buildLocalDashboardRaw(store, days = 7, nowMs = Date.now()) {
  const safe = ensureStore(store);
  const clamped = Math.max(1, Math.min(400, Number(days) || 7));
  const nowDate = new Date(nowMs);

  const currentKeys = new Set();
  const prevKeys = new Set();

  for (let i = 0; i < clamped; i += 1) {
    const dCurr = new Date(nowDate.getFullYear(), nowDate.getMonth(), nowDate.getDate() - i);
    currentKeys.add(getLocalDateKey(dCurr));

    const dPrev = new Date(
      nowDate.getFullYear(),
      nowDate.getMonth(),
      nowDate.getDate() - (clamped + i)
    );
    prevKeys.add(getLocalDateKey(dPrev));
  }

  const daily = [];
  for (const dayKey of Array.from(currentKeys).sort()) {
    const b = safe.daily[dayKey];
    if (b) {
      daily.push({
        day: dayKey,
        focusMs: Number(b.focusMs) || 0,
        distractionMs: Number(b.distractionMs) || 0,
        blockedCount: Number(b.blockedCount) || 0,
        sessionsCompleted: Number(b.sessionsCompleted) || 0,
        sessionsFailed: Number(b.sessionsFailed) || 0
      });
    }
  }

  const previousTotals = {
    focusMs: 0,
    distractionMs: 0,
    blockedCount: 0,
    sessionsCompleted: 0,
    sessionsFailed: 0
  };
  for (const dayKey of prevKeys) {
    const b = safe.daily[dayKey];
    if (b) {
      previousTotals.focusMs += Number(b.focusMs) || 0;
      previousTotals.distractionMs += Number(b.distractionMs) || 0;
      previousTotals.blockedCount += Number(b.blockedCount) || 0;
      previousTotals.sessionsCompleted += Number(b.sessionsCompleted) || 0;
      previousTotals.sessionsFailed += Number(b.sessionsFailed) || 0;
    }
  }

  const blockedTotals = new Map();
  const targetDurations = new Map();
  const hourTotals = new Map();

  for (const dayKey of currentKeys) {
    const dayBlk = safe.blockedByDay[dayKey] || {};
    for (const [target, count] of Object.entries(dayBlk)) {
      blockedTotals.set(target, (blockedTotals.get(target) || 0) + (Number(count) || 0));
    }

    const dayTargets = safe.targetsByDay[dayKey] || {};
    for (const [compositeKey, dur] of Object.entries(dayTargets)) {
      targetDurations.set(
        compositeKey,
        (targetDurations.get(compositeKey) || 0) + (Number(dur) || 0)
      );
    }

    const dayHours = safe.hoursByDay[dayKey] || {};
    for (const [hrStr, count] of Object.entries(dayHours)) {
      const hr = Number(hrStr);
      if (Number.isInteger(hr) && hr >= 0 && hr <= 23) {
        hourTotals.set(hr, (hourTotals.get(hr) || 0) + (Number(count) || 0));
      }
    }
  }

  const topBlocked = Array.from(blockedTotals.entries())
    .map(([target, count]) => ({ target, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 10);

  const timeByTarget = Array.from(targetDurations.entries())
    .map(([composite, durationMs]) => {
      const [target, kind] = composite.split("|");
      return { target, kind: kind || "neutral", durationMs };
    })
    .filter((row) => row.durationMs > 0)
    .sort((a, b) => b.durationMs - a.durationMs)
    .slice(0, 15);

  const blockedByHour = Array.from(hourTotals.entries())
    .map(([hour, count]) => ({ hour, count }))
    .sort((a, b) => a.hour - b.hour);

  const cutoffMs = nowMs - clamped * 86_400_000;
  const recentEvents = safe.recentEvents
    .filter((ev) => (Number(ev?.tsMs) || 0) >= cutoffMs)
    .slice(0, 10);

  return {
    days: clamped,
    generatedAtMs: nowMs,
    daily,
    previousTotals,
    topBlocked,
    timeByTarget,
    blockedByHour,
    recentEvents
  };
}
