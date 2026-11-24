/**
 * Pure window & process classifier for Dhirna Desktop (Linux X11 & Windows Win32).
 * Detects planned work sites, distracting sites across all browsers, work apps, and distracting apps.
 */

import { normalizeDomain } from "./domains.js";
import { isFocusTimerOrScheduleActive } from "./state.js";
import { isSocialShieldManagedDomain } from "./shield.js";

export const BROWSER_PROCESSES = [
  "firefox",
  "firefox-esr",
  "firefox-bin",
  "chrome",
  "google-chrome",
  "google-chrome-stable",
  "chromium",
  "chromium-browser",
  "brave",
  "brave-browser",
  "msedge",
  "microsoft-edge",
  "opera",
  "vivaldi",
  "vivaldi-bin",
  "zen",
  "librewolf",
  "waterfox"
];

export const TITLE_KEYWORDS = {
  "instagram.com": ["instagram"],
  "youtube.com": ["youtube"],
  "tiktok.com": ["tiktok"],
  "facebook.com": ["facebook"],
  "reddit.com": ["reddit"],
  "x.com": [" / x", " on x", "twitter"],
  "twitter.com": ["twitter", " / x"],
  "netflix.com": ["netflix"],
  "twitch.tv": ["twitch"],
  "docs.google.com": ["google docs", "docs.google.com"],
  "drive.google.com": ["google drive", "drive.google.com"],
  "github.com": ["github"],
  "gitlab.com": ["gitlab"],
  "notion.so": ["notion"],
  "figma.com": ["figma"],
  "localhost": ["localhost", "127.0.0.1"]
};

export function normalizeProcessName(processName) {
  if (typeof processName !== "string") return "";
  const base = processName
    .trim()
    .toLowerCase()
    .split(/[/\\]/)
    .pop();
  return (base || "").replace(/\.exe$/i, "");
}

export function isBrowserProcess(processName) {
  const norm = normalizeProcessName(processName);
  if (!norm) return false;
  return BROWSER_PROCESSES.some((b) => norm === b || norm.startsWith(`${b}-`));
}

export function keywordsForDomain(domain, customKeywords = {}) {
  const norm = normalizeDomain(domain);
  if (!norm) return [];

  if (customKeywords && Array.isArray(customKeywords[norm]) && customKeywords[norm].length > 0) {
    return customKeywords[norm].map((k) => String(k).toLowerCase().trim()).filter(Boolean);
  }

  if (TITLE_KEYWORDS[norm]) {
    return TITLE_KEYWORDS[norm];
  }

  const parts = norm.split(".");
  const mainLabel = parts.length >= 2 ? parts[parts.length - 2] : parts[0];
  const set = new Set([norm]);
  if (mainLabel && mainLabel.length >= 3) {
    set.add(mainLabel);
  }
  return Array.from(set);
}

export function titleMatchesDomain(title, domain, customKeywords = {}) {
  if (typeof title !== "string" || !title.trim()) return false;
  const lowerTitle = title.toLowerCase();
  const keywords = keywordsForDomain(domain, customKeywords);
  return keywords.some((kw) => lowerTitle.includes(kw));
}

/**
 * Returns true only for Dhirna's own Desktop windows, never external editors/IDEs
 * whose workspace or project title happens to include the word "Dhirna".
 */
const OWN_DHIRNA_TITLES = new Set([
  "Dhirna",
  "Dhirna — Focus",
  "Dhirna — Alerte Focus"
]);

export function isOwnDhirnaWindow(proc, title) {
  const cleanProc = normalizeProcessName(proc || "");
  const cleanTitle = typeof title === "string" ? title.trim() : "";
  if (cleanProc === "dhirna" || cleanProc === "dhirna-desktop") {
    return true;
  }
  return OWN_DHIRNA_TITLES.has(cleanTitle);
}

export function isWindowTitleReelOrShort(title = "") {
  if (typeof title !== "string" || !title) return false;
  return /\b(reels?|shorts|tiktok)\b/i.test(title);
}

export function isWindowTitleDirectMessages(title = "") {
  if (typeof title !== "string" || !title) return false;
  if (isWindowTitleReelOrShort(title)) return false;
  return /\b(direct|inbox|messages|messenger|chats)\b/i.test(title);
}

/**
 * Detects whether a browser window/tab is attempting to open the Browser Extensions Manager
 * (`chrome://extensions`, `brave://extensions`, `edge://extensions`, `about:addons`, etc.)
 * to disable or uninstall the Dhirna extension.
 */
export function isTamperOrExtensionManagerWindow(win) {
  if (!win) return false;
  const proc = normalizeProcessName(win.processName || "");
  const title = typeof win.title === "string" ? win.title.trim().toLowerCase() : "";
  if (!title) return false;
  if (
    title.includes("chrome://extensions") ||
    title.includes("brave://extensions") ||
    title.includes("edge://extensions") ||
    title.includes("vivaldi://extensions") ||
    title.includes("opera://extensions") ||
    title.includes("about:addons") ||
    title.includes("about:debugging")
  ) {
    return true;
  }
  if (
    isBrowserProcess(proc) &&
    (/^(extensions|manage extensions|gestionnaire d'extensions|modules complémentaires|add-ons manager)\b/i.test(
      title
    ) ||
      /\b(extensions\s+-\s+(google chrome|brave|chromium|microsoft edge|vivaldi|opera))\b/i.test(
        title
      ))
  ) {
    return true;
  }
  return false;
}

function processMatchesTarget(actualProc, targetProc) {
  if (!actualProc || !targetProc) return false;
  if (actualProc === targetProc) return true;
  if (actualProc.length >= 6 && targetProc.startsWith(actualProc)) return true;
  if (targetProc.length >= 6 && actualProc.startsWith(targetProc)) return true;
  return false;
}

/**
 * Classifies an OS window (`{ id, processName, title }`) against user state.
 */
export function classifyWindow(win, state = {}, now = new Date()) {
  if (!win) return { kind: "neutral", entry: null };
  const proc = normalizeProcessName(win.processName || "");
  const title = typeof win.title === "string" ? win.title : "";

  if (isOwnDhirnaWindow(proc, title)) {
    return { kind: "neutral", entry: null };
  }

  const tamperGuardActive = Boolean(
    state?.shield?.enabled ||
      isFocusTimerOrScheduleActive(state, now) ||
      state?.manualOn ||
      state?.strictMode
  );
  if (tamperGuardActive && isTamperOrExtensionManagerWindow(win)) {
    return {
      kind: "distraction-site",
      entry: "Protection Anti-Désinstallation (Extensions)",
      source: "tamper-guard"
    };
  }

  const goalApp = normalizeProcessName(state?.activeGoal?.app || "");
  const goalSite = normalizeDomain(state?.activeGoal?.site || "");
  const goalWinTitle =
    typeof state?.activeGoal?.windowTitle === "string"
      ? state.activeGoal.windowTitle.trim().toLowerCase()
      : "";
  const workApps = [
    ...(goalApp ? [goalApp] : []),
    ...(Array.isArray(state.workApps) ? state.workApps : [])
  ];
  const workSites = [
    ...(goalSite ? [goalSite] : []),
    ...(Array.isArray(state.workSites) ? state.workSites : [])
  ];
  const blockedApps = Array.isArray(state.blockedApps) ? state.blockedApps : [];
  const blacklist = Array.isArray(state.blacklist) ? state.blacklist : [];
  const customKeywords = state.customKeywords || {};

  const browser = isBrowserProcess(proc);

  for (const app of workApps) {
    const targetProc = normalizeProcessName(typeof app === "string" ? app : app?.process || "");
    if (processMatchesTarget(proc, targetProc)) {
      return { kind: "work", source: "app", entry: targetProc };
    }
  }
  if (!browser && goalWinTitle && title.toLowerCase().includes(goalWinTitle)) {
    return { kind: "work", source: "app", entry: goalApp || proc || goalWinTitle };
  }

  if (browser && title) {
    for (const site of workSites) {
      if (titleMatchesDomain(title, site, customKeywords)) {
        return { kind: "work", source: "site", entry: normalizeDomain(site) };
      }
    }
  }

  const socialFocusActive = isFocusTimerOrScheduleActive(state, now);
  const socialShieldConfigured = Boolean(
    state?.shield?.enabled && state?.shield?.noReels !== false
  );

  if (socialShieldConfigured && socialFocusActive && browser && title) {
    if (isWindowTitleReelOrShort(title)) {
      return { kind: "distraction-site", entry: "Reels / Shorts", source: "social-shield" };
    }
    if (
      isWindowTitleDirectMessages(title) &&
      (titleMatchesDomain(title, "instagram.com", customKeywords) ||
        titleMatchesDomain(title, "facebook.com", customKeywords) ||
        titleMatchesDomain(title, "messenger.com", customKeywords))
    ) {
      return { kind: "neutral", entry: "Direct Messages", source: "social-shield-dm" };
    }
  }

  for (const app of blockedApps) {
    const appObj =
      typeof app === "string"
        ? { process: normalizeProcessName(app), label: app, kill: false }
        : {
            process: normalizeProcessName(app?.process || ""),
            label: app?.label || app?.process || "",
            kill: Boolean(app?.kill)
          };
    if (processMatchesTarget(proc, appObj.process)) {
      return { kind: "distraction-app", entry: appObj };
    }
  }

  if (browser && title) {
    for (const site of blacklist) {
      if (socialShieldConfigured && !socialFocusActive && isSocialShieldManagedDomain(site)) {
        continue;
      }
      if (titleMatchesDomain(title, site, customKeywords)) {
        return { kind: "distraction-site", entry: normalizeDomain(site) };
      }
    }
  }

  return { kind: "neutral", entry: null };
}
