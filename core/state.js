/**
 * Pure state, active goal, schedule, session lock, sound preferences, and statistics logic for Dhirna.
 */

import { t } from "./i18n.js";
import { normalizeDomain } from "./domains.js";
import { normalizeProcessName } from "./matcher.js";
import { createDefaultShieldState } from "./shield.js";
import { normalizeSoundSettings } from "./alarm.js";

export const SUGGESTED_WORK_SITES = [
  "docs.google.com",
  "drive.google.com",
  "github.com",
  "notion.so",
  "figma.com",
  "overleaf.com",
  "localhost"
];

export const SUGGESTED_BLOCKED_SITES = [
  "instagram.com",
  "tiktok.com",
  "youtube.com",
  "facebook.com",
  "x.com",
  "reddit.com"
];

export const SUGGESTED_WORK_APPS = ["code", "soffice.bin", "obsidian", "alacritty", "gnome-terminal"];

export const SUGGESTED_BLOCKED_APPS = [
  { process: "discord", label: "Discord", kill: true },
  { process: "steam", label: "Steam", kill: true },
  { process: "telegram-desktop", label: "Telegram", kill: true },
  { process: "spotify", label: "Spotify", kill: true }
];

export const USB_SOCIAL_APPS = [
  { id: "instagram", label: "Instagram" },
  { id: "tiktok", label: "TikTok" },
  { id: "snapchat", label: "Snapchat" },
  { id: "facebook", label: "Facebook" },
  { id: "x", label: "X / Twitter" },
  { id: "reddit", label: "Reddit" },
  { id: "shorts", label: "YouTube Shorts" }
];

export const DEFAULT_USB_SOCIAL_APP_IDS = USB_SOCIAL_APPS.map((a) => a.id);
const VALID_USB_APP_IDS = new Set(DEFAULT_USB_SOCIAL_APP_IDS);

export function normalizeUsbBlockedApps(raw) {
  if (!Array.isArray(raw)) {
    return [...DEFAULT_USB_SOCIAL_APP_IDS];
  }
  const clean = [];
  for (const item of raw) {
    const id = String(item || "").trim().toLowerCase();
    if (VALID_USB_APP_IDS.has(id) && !clean.includes(id)) {
      clean.push(id);
    }
  }
  return clean;
}

const LEGACY_DEFAULT_WORK_SITES = ["docs.google.com", "drive.google.com"];
const LEGACY_DEFAULT_WORK_APPS = ["code", "soffice.bin"];

/**
 * Returns today's date key in local time: "YYYY-MM-DD".
 *
 * @param {Date} [now]
 * @returns {string}
 */
export function getLocalDateKey(now = new Date()) {
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/**
 * Normalizes a user-declared focus goal.
 * Returns `null` if title, site, and app are all empty.
 */
export function normalizeGoal(raw, nowMs = Date.now()) {
  if (!raw || typeof raw !== "object") return null;
  const title = typeof raw.title === "string" ? raw.title.trim().slice(0, 120) : "";
  const site = normalizeDomain(raw.site || "");
  const app = normalizeProcessName(raw.app || "");
  const windowTitle =
    typeof raw.windowTitle === "string" ? raw.windowTitle.trim().slice(0, 120) : "";

  if (!title && !site && !app) return null;

  let targetType = "custom";
  if (site && app) {
    targetType = "both";
  } else if (site) {
    targetType = "site";
  } else if (app) {
    targetType = "app";
  }

  const updatedAtMs =
    typeof raw.updatedAtMs === "number" && Number.isFinite(raw.updatedAtMs) && raw.updatedAtMs > 0
      ? raw.updatedAtMs
      : nowMs;

  return {
    title,
    targetType,
    site,
    app,
    windowTitle,
    updatedAtMs
  };
}

/**
 * Returns the effective list of work sites, prioritizing the active goal's site first.
 */
export function getEffectiveWorkSites(state = {}) {
  const out = [];
  const goalSite = normalizeDomain(state?.activeGoal?.site || "");
  if (goalSite) out.push(goalSite);
  const list = Array.isArray(state?.workSites) ? state.workSites : [];
  for (const raw of list) {
    const d = normalizeDomain(raw);
    if (d && !out.includes(d)) out.push(d);
  }
  return out;
}

/**
 * Returns the effective list of work apps, prioritizing the active goal's app first.
 */
export function getEffectiveWorkApps(state = {}) {
  const out = [];
  const goalApp = normalizeProcessName(state?.activeGoal?.app || "");
  if (goalApp) out.push(goalApp);
  const list = Array.isArray(state?.workApps) ? state.workApps : [];
  for (const raw of list) {
    const p = normalizeProcessName(typeof raw === "string" ? raw : raw?.process || "");
    if (p && !out.includes(p)) out.push(p);
  }
  return out;
}

/**
 * Checks if a saved profile still holds untouched legacy v1.0.x default lists.
 */
export function hasLegacyUntouchedDefaults(state = {}) {
  if (!state || state.goalOnboardingDone === true) return false;
  const sites = Array.isArray(state.workSites) ? state.workSites : [];
  const apps = Array.isArray(state.workApps) ? state.workApps : [];
  const onlyLegacySites =
    sites.length > 0 && sites.every((s) => LEGACY_DEFAULT_WORK_SITES.includes(normalizeDomain(s)));
  const onlyLegacyApps =
    apps.length > 0 && apps.every((a) => LEGACY_DEFAULT_WORK_APPS.includes(normalizeProcessName(a)));
  return onlyLegacySites || onlyLegacyApps;
}

/**
 * Applies a newly declared user goal to state cleanly.
 */
export function applyGoalToState(state, goalInput, options = {}) {
  const goal = normalizeGoal(goalInput);
  const replaceWorkLists = Boolean(options.replaceWorkLists) || hasLegacyUntouchedDefaults(state);

  let nextWorkSites = replaceWorkLists
    ? []
    : (Array.isArray(state.workSites) ? state.workSites : []).map(normalizeDomain).filter(Boolean);
  let nextWorkApps = replaceWorkLists
    ? []
    : (Array.isArray(state.workApps) ? state.workApps : [])
        .map((a) => normalizeProcessName(typeof a === "string" ? a : a?.process || ""))
        .filter(Boolean);

  if (goal?.site) {
    nextWorkSites = [goal.site, ...nextWorkSites.filter((d) => d !== goal.site)];
  }
  if (goal?.app) {
    nextWorkApps = [goal.app, ...nextWorkApps.filter((a) => a !== goal.app)];
  }

  const nextState = {
    ...state,
    goalOnboardingDone: true,
    activeGoal: goal,
    workSites: nextWorkSites,
    workApps: nextWorkApps,
    lastWorkTab: replaceWorkLists ? null : state.lastWorkTab || null,
    lastWorkWindow: replaceWorkLists ? null : state.lastWorkWindow || null
  };

  if (Array.isArray(options.blacklist)) {
    nextState.blacklist = Array.from(
      new Set(options.blacklist.map(normalizeDomain).filter(Boolean))
    );
  }
  if (Array.isArray(options.blockedApps)) {
    nextState.blockedApps = options.blockedApps;
  }

  return nextState;
}

export const ALLOWED_PRESENCE_IDLE_MINUTES = [1, 2, 5];

/**
 * Normalizes anti-AFK presence check settings with safe defaults (2 min idle, 30s alarm delay).
 */
export function normalizePresenceSettings(raw = {}) {
  const mins = Number(raw?.presenceIdleMinutes);
  return {
    presenceCheckEnabled: raw?.presenceCheckEnabled !== false,
    presenceIdleMinutes: ALLOWED_PRESENCE_IDLE_MINUTES.includes(mins) ? mins : 2,
    presenceAlarmDelaySeconds: 30
  };
}

export function createDefaultState(now = new Date()) {
  return {
    language: "auto", // "auto" | "fr" | "en"
    onboardingDismissed: false,
    goalOnboardingDone: false,
    activeGoal: null, // { title, targetType, site, app, windowTitle, updatedAtMs }
    mode: "blacklist", // "blacklist" | "whitelist"
    workSites: [],
    workApps: [],
    blacklist: ["instagram.com", "tiktok.com"],
    whitelist: [],
    blockedApps: [],
    customKeywords: {},
    strictMode: false,
    shield: createDefaultShieldState(),
    sound: normalizeSoundSettings(),
    autoTriggerEnabled: true,
    manualOn: false,
    presenceCheckEnabled: true,
    presenceIdleMinutes: 2,
    presenceAlarmDelaySeconds: 30,
    usbReelsEnabled: true,
    usbBlockedApps: [...DEFAULT_USB_SOCIAL_APP_IDS],
    sessionEndsAt: null,
    sessionCompletedFree: false,
    schedules: [
      {
        id: "default-workdays",
        enabled: false,
        days: [1, 2, 3, 4, 5],
        start: "09:00",
        end: "17:00"
      }
    ],
    lastWorkTab: null,
    lastWorkWindow: null,
    stats: {
      date: getLocalDateKey(now),
      total: 0,
      perSite: {}
    }
  };
}

export function parseTimeToMinutes(timeStr) {
  if (typeof timeStr !== "string") return null;
  const match = /^(\d{1,2}):(\d{2})$/.exec(timeStr.trim());
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59) return null;
  return hours * 60 + minutes;
}

export function isScheduleEntryActive(entry, now = new Date()) {
  if (!entry || entry.enabled === false) return false;
  const days = Array.isArray(entry.days) ? entry.days : [];
  if (days.length === 0) return false;

  const startMin = parseTimeToMinutes(entry.start);
  const endMin = parseTimeToMinutes(entry.end);
  if (startMin === null || endMin === null || startMin === endMin) return false;

  const currentDay = now.getDay();
  const currentMin = now.getHours() * 60 + now.getMinutes();

  if (startMin < endMin) {
    return days.includes(currentDay) && currentMin >= startMin && currentMin < endMin;
  }

  const isLatePart = days.includes(currentDay) && currentMin >= startMin;
  const previousDay = (currentDay + 6) % 7;
  const isEarlyMorningPart = days.includes(previousDay) && currentMin < endMin;
  return isLatePart || isEarlyMorningPart;
}

export function isScheduleActive(schedules = [], now = new Date()) {
  if (!Array.isArray(schedules)) return false;
  return schedules.some((entry) => isScheduleEntryActive(entry, now));
}

export function isSessionActive(state, now = Date.now()) {
  if (!state || typeof state.sessionEndsAt !== "number") return false;
  const nowMs = now instanceof Date ? now.getTime() : Number(now);
  return state.sessionEndsAt > nowMs;
}

export function isAutoTriggerActive(state, openWorkTargets = []) {
  if (!state || !state.autoTriggerEnabled) return false;
  return Array.isArray(openWorkTargets) && openWorkTargets.length > 0;
}

export function isFocusTimerOrScheduleActive(state, now = new Date(), openWorkTargets = null) {
  if (!state) return false;
  const nowDate = now instanceof Date ? now : new Date(Number(now) || Date.now());
  if (isSessionActive(state, nowDate) || isScheduleActive(state.schedules, nowDate)) {
    return true;
  }
  if (state.sessionCompletedFree === true) {
    return false;
  }
  if (Boolean(state.manualOn)) {
    return true;
  }
  if (Array.isArray(openWorkTargets) && isAutoTriggerActive(state, openWorkTargets)) {
    return true;
  }
  return false;
}

export function isBlockingActive(state, now = new Date(), openWorkTargets = []) {
  if (!state) return false;
  return (
    Boolean(state.manualOn) ||
    isSessionActive(state, now) ||
    isScheduleActive(state.schedules, now) ||
    isAutoTriggerActive(state, openWorkTargets)
  );
}

export function isLocked(state, now = Date.now()) {
  return isSessionActive(state, now);
}

export function getActivationStatus(state, now = new Date(), openWorkTargets = [], lang = "fr") {
  const nowMs = now instanceof Date ? now.getTime() : Number(now);
  const nowDate = now instanceof Date ? now : new Date(nowMs);

  if (isSessionActive(state, nowMs)) {
    const remainingMs = Math.max(0, state.sessionEndsAt - nowMs);
    const totalSec = Math.ceil(remainingMs / 1000);
    const min = Math.floor(totalSec / 60);
    const sec = String(totalSec % 60).padStart(2, "0");
    return {
      active: true,
      locked: true,
      source: "session",
      label: t("status_session", lang, { time: `${min}:${sec}` }),
      remainingMs
    };
  }

  if (isAutoTriggerActive(state, openWorkTargets)) {
    const primary = openWorkTargets[0];
    const targetName = primary.domain || primary.entry || primary.processName || "work";
    return {
      active: true,
      locked: false,
      source: "auto",
      label: t("status_auto", lang, { domain: targetName }),
      remainingMs: 0
    };
  }

  if (isScheduleActive(state?.schedules, nowDate)) {
    return {
      active: true,
      locked: false,
      source: "schedule",
      label: t("status_schedule", lang),
      remainingMs: 0
    };
  }

  if (state?.manualOn) {
    return {
      active: true,
      locked: false,
      source: "manual",
      label: t("status_manual", lang),
      remainingMs: 0
    };
  }

  return {
    active: false,
    locked: false,
    source: "off",
    label: t("status_off", lang),
    remainingMs: 0
  };
}

export function recordBlockedAttempt(stats, targetName, todayKey = getLocalDateKey()) {
  const cleanName = (targetName || "inconnu").toLowerCase();
  const baseStats =
    stats && stats.date === todayKey
      ? {
          date: todayKey,
          total: typeof stats.total === "number" ? stats.total : 0,
          perSite: { ...(stats.perSite || {}) }
        }
      : {
          date: todayKey,
          total: 0,
          perSite: {}
        };

  baseStats.total += 1;
  baseStats.perSite[cleanName] = (baseStats.perSite[cleanName] || 0) + 1;
  return baseStats;
}
