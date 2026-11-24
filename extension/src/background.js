import {
  normalizeDomain,
  extractHostname,
  shouldBlockUrl,
  findMatchingWorkTab
} from "./lib/domains.js";
import {
  createDefaultState,
  getLocalDateKey,
  isBlockingActive,
  isLocked,
  getActivationStatus,
  recordBlockedAttempt,
  normalizeGoal,
  getEffectiveWorkSites,
  applyGoalToState,
  isFocusTimerOrScheduleActive
} from "./lib/state.js";
import { buildRules, cleanDomainList } from "./lib/rules.js";
import { resolveLanguage } from "./lib/i18n.js";
import { normalizeSoundSettings } from "./lib/alarm.js";
import {
  normalizeShieldState,
  isShieldLocked,
  mergeShieldStates,
  buildShieldRules,
  shouldShieldBlockUrl,
  evaluateSocialShieldUrl,
  isSocialShieldManagedDomain
} from "./lib/shield.js";
import {
  createEmptyExtensionAnalytics,
  recordExtensionSegment,
  recordExtensionBlocked,
  recordExtensionSession,
  buildLocalDashboardRaw,
  pruneExtensionAnalytics
} from "./lib/ext_analytics.js";

const STORAGE_KEY = "dhirna_state";
const ANALYTICS_STORAGE_KEY = "dhirna_ext_analytics";
const ACTIVE_SEGMENT_KEY = "dhirna_active_segment";
const ALARM_TICK = "dhirna-tick";
const ALARM_SESSION_END = "dhirna-session-end";
const DESKTOP_BRIDGE_BASE = "http://127.0.0.1:47821";
const IDLE_THRESHOLD_SECONDS = 60;

function detectBrowserTag() {
  const ua = (navigator?.userAgent || "").toLowerCase();
  if (ua.includes("edg/")) return "msedge";
  if (navigator?.brave) return "brave";
  return "chrome";
}

async function fetchBridge(path, options = {}, timeoutMs = 800) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${DESKTOP_BRIDGE_BASE}${path}`, {
      ...options,
      signal: controller.signal
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function postBridge(path, payload) {
  fetchBridge(
    path,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...payload, browser: detectBrowserTag() })
    },
    800
  ).catch(() => {});
}

async function loadState() {
  const stored = await chrome.storage.local.get(STORAGE_KEY);
  const defaults = createDefaultState();
  const current = stored[STORAGE_KEY] || {};
  const todayKey = getLocalDateKey();

  const stats =
    current.stats && current.stats.date === todayKey
      ? current.stats
      : { date: todayKey, total: 0, perSite: {} };

  return {
    ...defaults,
    ...current,
    language: current.language || defaults.language,
    onboardingDismissed: Boolean(current.onboardingDismissed),
    goalOnboardingDone: Boolean(current.goalOnboardingDone),
    activeGoal: normalizeGoal(current.activeGoal),
    shield: normalizeShieldState(current.shield),
    sound: normalizeSoundSettings(current.sound),
    workSites: cleanDomainList(current.workSites ?? defaults.workSites),
    blacklist: cleanDomainList(current.blacklist ?? defaults.blacklist),
    whitelist: cleanDomainList(current.whitelist ?? defaults.whitelist),
    schedules: Array.isArray(current.schedules) ? current.schedules : defaults.schedules,
    stats
  };
}

async function saveState(state) {
  await chrome.storage.local.set({ [STORAGE_KEY]: state });
}

async function syncGoalWithBridge(state) {
  const remote = await fetchBridge("/goal", { method: "GET" }, 400);
  if (!remote || !remote.ok) return state;

  const remoteGoal = normalizeGoal(remote.goal);
  const localGoal = normalizeGoal(state.activeGoal);
  const remoteTs = remoteGoal?.updatedAtMs || 0;
  const localTs = localGoal?.updatedAtMs || 0;

  if (remoteGoal && remoteTs > localTs) {
    const merged = applyGoalToState(state, remoteGoal);
    await saveState(merged);
    return merged;
  }

  if (localGoal && localTs > remoteTs) {
    postBridge("/goal", { goal: localGoal });
  }

  return state;
}

async function syncShieldWithBridge(state) {
  const remote = await fetchBridge("/shield", { method: "GET" }, 400);
  if (!remote || !remote.ok || !remote.shield) return state;

  const merged = mergeShieldStates(state.shield, remote.shield);
  if (merged.winner === "remote") {
    const nextState = { ...state, shield: merged.shield };
    await saveState(nextState);
    return nextState;
  }

  if (merged.winner === "local") {
    postBridge("/shield", { shield: merged.shield });
  }

  return state;
}

async function loadExtAnalytics() {
  const stored = await chrome.storage.local.get(ANALYTICS_STORAGE_KEY);
  return stored[ANALYTICS_STORAGE_KEY] || createEmptyExtensionAnalytics();
}

async function saveExtAnalytics(analytics) {
  await chrome.storage.local.set({ [ANALYTICS_STORAGE_KEY]: analytics });
}

async function loadActiveSegment() {
  const stored = await chrome.storage.local.get(ACTIVE_SEGMENT_KEY);
  return stored[ACTIVE_SEGMENT_KEY] || null;
}

async function saveActiveSegment(seg) {
  await chrome.storage.local.set({ [ACTIVE_SEGMENT_KEY]: seg });
}

function classifyTabDomain(hostname, state) {
  if (!hostname) return "neutral";
  const effectiveWorkSites = getEffectiveWorkSites(state);
  const isWork = effectiveWorkSites.some(
    (w) => hostname === w || hostname.endsWith(`.${w}`)
  );
  if (isWork) return "work";
  const blockCheck = shouldBlockUrl(`https://${hostname}`, {
    ...state,
    workSites: effectiveWorkSites
  });
  if (blockCheck.blocked) return "distraction";
  return "neutral";
}

async function flushActiveSegment(endedAtMs = Date.now(), awaitBridge = false) {
  const current = await loadActiveSegment();
  if (!current || !current.domain || !current.startedAtMs) {
    return;
  }
  await saveActiveSegment(null);

  const rawDur = endedAtMs - current.startedAtMs;
  const durationMs = Math.min(Math.max(0, rawDur), 5 * 60_000);
  if (durationMs < 1000) return;

  let analytics = await loadExtAnalytics();
  analytics = recordExtensionSegment(analytics, {
    domain: current.domain,
    kind: current.kind,
    durationMs,
    endedAtMs
  });
  await saveExtAnalytics(analytics);

  const payload = {
    startedAtMs: current.startedAtMs,
    endedAtMs,
    durationMs,
    domain: current.domain,
    kind: current.kind,
    browser: detectBrowserTag()
  };

  if (awaitBridge) {
    await fetchBridge(
      "/segment",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      },
      800
    );
  } else {
    postBridge("/segment", payload);
  }
}

async function syncActiveTabTracking(stateOverride = null) {
  const state = stateOverride || (await loadState());
  const nowMs = Date.now();

  let idleState = "active";
  try {
    if (chrome.idle?.queryState) {
      idleState = await chrome.idle.queryState(IDLE_THRESHOLD_SECONDS);
    }
  } catch {
    idleState = "active";
  }
  if (idleState !== "active") {
    await flushActiveSegment(Math.max(0, nowMs - IDLE_THRESHOLD_SECONDS * 1000));
  }

  if (state.presenceCheckEnabled !== false) {
    const presenceSec = Math.max(60, (Number(state.presenceIdleMinutes) || 2) * 60);
    let longIdle = "active";
    try {
      if (chrome.idle?.queryState) {
        longIdle = await chrome.idle.queryState(presenceSec);
      }
    } catch {
      longIdle = "active";
    }
    if (longIdle === "idle" || longIdle === "locked") {
      try {
        const win = await chrome.windows.getLastFocused({ populate: true });
        if (win && win.focused) {
          const allTabs = await chrome.tabs.query({});
          const effectiveWorkSites = getEffectiveWorkSites(state);
          const { openWorkTabs } = findMatchingWorkTab(allTabs, effectiveWorkSites, null, state.activeGoal?.site || "");
          const blockingOn = isBlockingActive(state, new Date(nowMs), openWorkTabs);
          const presenceUrl = chrome.runtime.getURL("src/blocked.html?mode=presence");
          const alreadyOpen = allTabs.some((t) => typeof t.url === "string" && t.url.startsWith(presenceUrl));
          if (blockingOn && !alreadyOpen) {
            const desktopHealth = await fetchBridge("/health", { method: "GET" }, 300);
            if (!desktopHealth?.ok) {
              await flushActiveSegment(Math.max(0, nowMs - presenceSec * 1000));
              await chrome.tabs.create({ url: presenceUrl, active: true });
              return;
            }
          }
        }
      } catch {
        // Ignore popup/tab query failures
      }
    }
  }

  if (idleState !== "active") {
    return;
  }

  let focusedWindow = null;
  try {
    const win = await chrome.windows.getLastFocused({ populate: true });
    if (win && win.focused) {
      focusedWindow = win;
    }
  } catch {
    focusedWindow = null;
  }

  if (!focusedWindow) {
    await flushActiveSegment(nowMs);
    return;
  }

  const activeTab = (focusedWindow.tabs || []).find((t) => t.active);
  const hostname = extractHostname(activeTab?.url || "");
  if (!hostname) {
    await flushActiveSegment(nowMs);
    return;
  }

  const kind = classifyTabDomain(hostname, state);
  const existing = await loadActiveSegment();

  if (existing && existing.domain === hostname && existing.kind === kind) {
    if (nowMs - existing.startedAtMs >= 30_000) {
      await flushActiveSegment(nowMs);
      await saveActiveSegment({ tabId: activeTab.id, domain: hostname, kind, startedAtMs: nowMs });
    }
    return;
  }

  await flushActiveSegment(nowMs);
  await saveActiveSegment({
    tabId: activeTab.id,
    domain: hostname,
    kind,
    startedAtMs: nowMs
  });
}

function getEffectiveLang(state) {
  const uiLang =
    typeof chrome?.i18n?.getUILanguage === "function"
      ? chrome.i18n.getUILanguage()
      : navigator?.language || "fr";
  return resolveLanguage(state?.language, uiLang);
}

async function updateBadge(status, shield = null) {
  if (!status.active) {
    if (shield?.enabled) {
      await chrome.action.setBadgeText({ text: "SAFE" });
      await chrome.action.setBadgeBackgroundColor({ color: "#6A98F0" });
    } else {
      await chrome.action.setBadgeText({ text: "" });
    }
    return;
  }
  const badgeMap = {
    session: { text: "LOCK", color: "#D9A054" },
    auto: { text: "AUTO", color: "#6A98F0" },
    schedule: { text: "PLAN", color: "#6A98F0" },
    manual: { text: "ON", color: "#6A98F0" }
  };
  const cfg = badgeMap[status.source] || { text: "ON", color: "#6A98F0" };
  await chrome.action.setBadgeText({ text: cfg.text });
  await chrome.action.setBadgeBackgroundColor({ color: cfg.color });
}

async function refreshEngine(stateOverride = null) {
  const state = stateOverride || (await loadState());
  const now = new Date();
  let stateChanged = false;

  if (typeof state.sessionEndsAt === "number" && state.sessionEndsAt <= now.getTime()) {
    state.sessionEndsAt = null;
    state.sessionCompletedFree = true;
    stateChanged = true;
    let analytics = await loadExtAnalytics();
    analytics = recordExtensionSession(analytics, { outcome: "completed", endedAtMs: now.getTime() });
    await saveExtAnalytics(analytics);
    postBridge("/session", { action: "end", outcome: "completed" });
  }

  const effectiveWorkSites = getEffectiveWorkSites(state);
  const allTabs = await chrome.tabs.query({});
  const { openWorkTabs, bestWorkTab } = findMatchingWorkTab(
    allTabs,
    effectiveWorkSites,
    state.lastWorkTab?.id ?? null,
    state.activeGoal?.site || ""
  );

  if (bestWorkTab) {
    const prev = state.lastWorkTab;
    if (
      !prev ||
      prev.id !== bestWorkTab.id ||
      prev.title !== bestWorkTab.title ||
      prev.domain !== bestWorkTab.domain
    ) {
      state.lastWorkTab = bestWorkTab;
      stateChanged = true;
    }
  } else if (state.lastWorkTab !== null) {
    state.lastWorkTab = null;
    stateChanged = true;
  }

  if (stateChanged) {
    await saveState(state);
  }

  const lang = getEffectiveLang(state);
  const active = isBlockingActive(state, now, openWorkTabs);
  const focusTimerOrSched = isFocusTimerOrScheduleActive(state, now, openWorkTabs);
  const socialShieldConfigured = Boolean(state.shield?.enabled && state.shield?.noReels !== false);
  const effectiveBlacklist =
    socialShieldConfigured && !focusTimerOrSched
      ? (state.blacklist || []).filter((d) => !isSocialShieldManagedDomain(d))
      : state.blacklist;
  const status = getActivationStatus(state, now, openWorkTabs, lang);
  await updateBadge(status, state.shield);

  const existingRules = await chrome.declarativeNetRequest.getDynamicRules();
  const removeRuleIds = existingRules.map((r) => r.id);
  const focusRules = buildRules({
    active,
    mode: state.mode,
    blacklist: effectiveBlacklist,
    whitelist: state.whitelist,
    workSites: effectiveWorkSites,
    extensionId: chrome.runtime.id
  });
  const shieldRules = buildShieldRules({
    shield: state.shield,
    extensionId: chrome.runtime.id,
    focusActive: focusTimerOrSched
  });

  await chrome.declarativeNetRequest.updateDynamicRules({
    removeRuleIds,
    addRules: [...focusRules, ...shieldRules]
  });

  const blockedPagePrefix = chrome.runtime.getURL("src/blocked.html");
  const tamperGuardOn = Boolean(state.shield?.enabled || active || isLocked(state));
  for (const tab of allTabs) {
    if (!tab.id || !tab.url || tab.url.startsWith(blockedPagePrefix)) continue;

    const lowerUrl = String(tab.url || "").trim().toLowerCase();
    if (
      tamperGuardOn &&
      (lowerUrl.startsWith("chrome://extensions") ||
        lowerUrl.startsWith("brave://extensions") ||
        lowerUrl.startsWith("edge://extensions") ||
        lowerUrl.startsWith("vivaldi://extensions") ||
        lowerUrl.startsWith("opera://extensions") ||
        lowerUrl.startsWith("about:addons") ||
        lowerUrl.startsWith("about:debugging"))
    ) {
      const redirectUrl = `${blockedPagePrefix}?reason=shield#${tab.url}`;
      try {
        await chrome.tabs.update(tab.id, { url: redirectUrl });
      } catch {
        try {
          await chrome.tabs.remove(tab.id);
        } catch {
          // Ignore
        }
      }
      continue;
    }

    if (state.shield?.enabled) {
      const shieldCheck = shouldShieldBlockUrl(tab.url, state.shield);
      if (shieldCheck.blocked) {
        const redirectUrl = `${blockedPagePrefix}?reason=shield#${tab.url}`;
        try {
          await chrome.tabs.update(tab.id, { url: redirectUrl });
        } catch {
          // Ignore
        }
        continue;
      }

      const socialCheck = evaluateSocialShieldUrl(tab.url, state.shield, {
        focusActive: focusTimerOrSched
      });
      if (socialCheck.action === "redirect-inbox" && socialCheck.targetUrl) {
        if (tab.url !== socialCheck.targetUrl) {
          try {
            await chrome.tabs.update(tab.id, { url: socialCheck.targetUrl });
          } catch {
            // Ignore
          }
        }
        continue;
      }
      if (socialCheck.action === "close-reel") {
        const redirectUrl = `${blockedPagePrefix}?reason=reels#${tab.url}`;
        try {
          await chrome.tabs.update(tab.id, { url: redirectUrl });
        } catch {
          // Ignore
        }
        continue;
      }
      if (socialCheck.action === "allow-dm") {
        continue;
      }
    }

    if (active) {
      const hostname = extractHostname(tab.url);
      if (socialShieldConfigured && !focusTimerOrSched && isSocialShieldManagedDomain(hostname)) {
        continue;
      }
      const check = shouldBlockUrl(tab.url, { ...state, workSites: effectiveWorkSites });
      if (check.blocked) {
        const redirectUrl = `${blockedPagePrefix}#${tab.url}`;
        try {
          await chrome.tabs.update(tab.id, { url: redirectUrl });
        } catch {
          // Ignore
        }
      }
    }
  }

  return { state, status, openWorkTabs, bestWorkTab, lang };
}

async function closeOrClearTab(senderTabId, senderWindowId, allTabs) {
  let tabAction = "noop";
  if (!senderTabId) return tabAction;
  const windowTabs = allTabs.filter((t) => t.windowId === senderWindowId);
  if (windowTabs.length <= 1) {
    try {
      await chrome.tabs.update(senderTabId, { url: "chrome://newtab" });
      tabAction = "cleared-sole-tab";
    } catch {
      // Ignore
    }
  } else {
    try {
      await chrome.tabs.remove(senderTabId);
      tabAction = "closed-tab";
    } catch {
      // Ignore
    }
  }
  return tabAction;
}

async function executeBoomerangClose(senderTab, isDemo = false, isPresence = false) {
  const state = await loadState();
  const allTabs = await chrome.tabs.query({});
  const senderTabId = senderTab?.id ?? null;
  const senderWindowId = senderTab?.windowId ?? null;

  if (isDemo) {
    const optionsPrefix = chrome.runtime.getURL("src/options.html");
    const optionsTab = allTabs.find(
      (t) => t.id !== senderTabId && typeof t.url === "string" && t.url.startsWith(optionsPrefix)
    );
    if (optionsTab?.id) {
      try {
        await chrome.tabs.update(optionsTab.id, { active: true });
        if (optionsTab.windowId) {
          await chrome.windows.update(optionsTab.windowId, { focused: true });
        }
      } catch {
        // Ignore
      }
    }
    if (senderTabId) {
      try {
        await chrome.tabs.remove(senderTabId);
      } catch {
        // Ignore
      }
    }
    return { action: "demo-completed" };
  }

  const prefersDesktopApp = Boolean(
    state.activeGoal?.app && (state.activeGoal?.targetType === "app" || !state.activeGoal?.site)
  );

  if (prefersDesktopApp) {
    const tabAction = await closeOrClearTab(senderTabId, senderWindowId, allTabs);
    const focusRes = await fetchBridge(
      "/focus-goal",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          app: state.activeGoal?.app || "",
          browser: detectBrowserTag()
        })
      },
      700
    );
    if (focusRes?.focused) {
      return { action: "focused-desktop-goal", window: focusRes.window, tabAction };
    }
  }

  const effectiveWorkSites = getEffectiveWorkSites(state);
  const { bestWorkTab } = findMatchingWorkTab(
    allTabs.filter((t) => t.id !== senderTabId),
    effectiveWorkSites,
    state.lastWorkTab?.id ?? null,
    state.activeGoal?.site || ""
  );

  if (bestWorkTab && bestWorkTab.id) {
    try {
      await chrome.tabs.update(bestWorkTab.id, { active: true });
      if (bestWorkTab.windowId) {
        await chrome.windows.update(bestWorkTab.windowId, { focused: true });
      }
    } catch {
      // Fallback if work tab closed
    }

    if (senderTabId) {
      try {
        await chrome.tabs.remove(senderTabId);
      } catch {
        // Ignore if already closed
      }
    }
    return { action: isPresence ? "presence-resumed-tab" : "focused-work-tab", target: bestWorkTab };
  }

  const tabAction = prefersDesktopApp
    ? "handled"
    : await closeOrClearTab(senderTabId, senderWindowId, allTabs);

  if (!prefersDesktopApp) {
    const focusRes = await fetchBridge(
      "/focus-goal",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          app: state.activeGoal?.app || "",
          browser: detectBrowserTag()
        })
      },
      700
    );
    if (focusRes?.focused) {
      return { action: "focused-desktop-goal", window: focusRes.window, tabAction };
    }
  }

  return { action: tabAction };
}

if (chrome.idle?.setDetectionInterval) {
  chrome.idle.setDetectionInterval(IDLE_THRESHOLD_SECONDS);
}

if (chrome.idle?.onStateChanged) {
  chrome.idle.onStateChanged.addListener(async (newState) => {
    if (newState !== "active") {
      await flushActiveSegment(Date.now());
    } else {
      await syncActiveTabTracking();
    }
  });
}

if (chrome.windows?.onFocusChanged) {
  chrome.windows.onFocusChanged.addListener(async (windowId) => {
    if (windowId === chrome.windows.WINDOW_ID_NONE) {
      await flushActiveSegment(Date.now());
    } else {
      postBridge("/heartbeat", {});
      await syncActiveTabTracking();
    }
  });
}

chrome.runtime.onInstalled.addListener(async (details) => {
  let state = await loadState();
  await saveState(state);
  await chrome.alarms.create(ALARM_TICK, { periodInMinutes: 0.5 });
  state = await syncGoalWithBridge(state);
  state = await syncShieldWithBridge(state);
  await refreshEngine(state);
  await syncActiveTabTracking(state);
  postBridge("/heartbeat", {});

  if (details?.reason === "install") {
    try {
      await chrome.tabs.create({
        url: chrome.runtime.getURL("src/options.html")
      });
    } catch {
      // Fail-safe
    }
  }
});

chrome.runtime.onStartup.addListener(async () => {
  await chrome.alarms.create(ALARM_TICK, { periodInMinutes: 0.5 });
  let state = await loadState();
  state = await syncGoalWithBridge(state);
  state = await syncShieldWithBridge(state);
  await refreshEngine(state);
  await syncActiveTabTracking(state);
  postBridge("/heartbeat", {});
});

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === ALARM_SESSION_END) {
    const state = await loadState();
    state.sessionEndsAt = null;
    state.sessionCompletedFree = true;
    await saveState(state);

    let analytics = await loadExtAnalytics();
    analytics = recordExtensionSession(analytics, { outcome: "completed", endedAtMs: Date.now() });
    await saveExtAnalytics(analytics);
    postBridge("/session", { action: "end", outcome: "completed" });

    const { lang } = await refreshEngine(state);
    try {
      await chrome.notifications.create({
        type: "basic",
        iconUrl: chrome.runtime.getURL("assets/icons/icon128.png"),
        title: lang === "en" ? "Dhirna — Session complete" : "Dhirna — Session terminée",
        message:
          lang === "en"
            ? "Your locked focus session is finished."
            : "Votre session de concentration verrouillée est terminée."
      });
    } catch {
      // Optional fail-safe
    }
    return;
  }

  if (alarm.name === ALARM_TICK) {
    postBridge("/heartbeat", {});
    let state = await loadState();
    state = await syncGoalWithBridge(state);
    state = await syncShieldWithBridge(state);
    await refreshEngine(state);
    await syncActiveTabTracking(state);
    let analytics = await loadExtAnalytics();
    analytics = pruneExtensionAnalytics(analytics, Date.now());
    await saveExtAnalytics(analytics);
  }
});

chrome.tabs.onUpdated.addListener(async (_tabId, changeInfo, tab) => {
  if (changeInfo.status === "complete" || changeInfo.url || changeInfo.title) {
    postBridge("/heartbeat", {});
    const state = await loadState();
    const effectiveWorkSites = getEffectiveWorkSites(state);
    const hostname = extractHostname(tab.url || "");
    if (hostname && effectiveWorkSites.some((w) => hostname === w || hostname.endsWith(`.${w}`))) {
      state.lastWorkTab = {
        id: tab.id,
        windowId: tab.windowId,
        url: tab.url,
        title: tab.title || hostname,
        domain: hostname
      };
      await saveState(state);
    }
    await refreshEngine(state);
    if (tab.active) {
      await syncActiveTabTracking(state);
    }
  }
});

chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  postBridge("/heartbeat", {});
  try {
    const tab = await chrome.tabs.get(tabId);
    const state = await loadState();
    const effectiveWorkSites = getEffectiveWorkSites(state);
    const hostname = extractHostname(tab.url || "");
    if (hostname && effectiveWorkSites.some((w) => hostname === w || hostname.endsWith(`.${w}`))) {
      state.lastWorkTab = {
        id: tab.id,
        windowId: tab.windowId,
        url: tab.url,
        title: tab.title || hostname,
        domain: hostname
      };
      await saveState(state);
    }
    await refreshEngine(state);
    await syncActiveTabTracking(state);
  } catch {
    await refreshEngine();
    await syncActiveTabTracking();
  }
});

chrome.tabs.onRemoved.addListener(async () => {
  await refreshEngine();
  await syncActiveTabTracking();
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  (async () => {
    let state = await loadState();
    const now = new Date();

    switch (message?.type) {
      case "GET_STATUS": {
        state = await syncGoalWithBridge(state);
        state = await syncShieldWithBridge(state);
        const { status, openWorkTabs, bestWorkTab, lang } = await refreshEngine(state);
        sendResponse({ ok: true, state, status, openWorkTabs, bestWorkTab, lang });
        break;
      }

      case "UPDATE_SHIELD": {
        const curr = normalizeShieldState(state.shield);
        const patch = message.shield || {};
        const locked = isShieldLocked(curr, Date.now());
        if (locked && (patch.enabled === false || patch.safeSearch === false || patch.noReels === false)) {
          sendResponse({ ok: false, error: "Shield is locked" });
          break;
        }
        state.shield = normalizeShieldState({
          ...curr,
          ...patch,
          lockUntilMs: curr.lockUntilMs,
          updatedAtMs: Date.now()
        });
        await saveState(state);
        postBridge("/shield", { shield: state.shield });
        const { status, openWorkTabs, bestWorkTab, lang } = await refreshEngine(state);
        sendResponse({ ok: true, state, status, openWorkTabs, bestWorkTab, lang });
        break;
      }

      case "LOCK_SHIELD": {
        const hours = Math.max(1, Math.min(24 * 30, Number(message.hours) || 24));
        const curr = normalizeShieldState(state.shield);
        const nextLock = Math.max(curr.lockUntilMs || 0, Date.now() + hours * 3_600_000);
        state.shield = normalizeShieldState({
          ...curr,
          enabled: true,
          lockUntilMs: nextLock,
          updatedAtMs: Date.now()
        });
        await saveState(state);
        postBridge("/shield", { shield: state.shield });
        const { status, openWorkTabs, bestWorkTab, lang } = await refreshEngine(state);
        sendResponse({ ok: true, state, status, openWorkTabs, bestWorkTab, lang });
        break;
      }

      case "UPDATE_SOUND": {
        state.sound = normalizeSoundSettings({
          ...(state.sound || {}),
          ...(message.sound || {})
        });
        await saveState(state);
        const { status, openWorkTabs, bestWorkTab, lang } = await refreshEngine(state);
        sendResponse({ ok: true, state, status, openWorkTabs, bestWorkTab, lang });
        break;
      }

      case "CHECK_SHIELD_DIAGNOSTIC": {
        state = await syncShieldWithBridge(state);
        let incognitoAllowed = false;
        try {
          if (chrome.extension?.isAllowedIncognitoAccess) {
            incognitoAllowed = await chrome.extension.isAllowedIncognitoAccess();
          }
        } catch {
          incognitoAllowed = false;
        }
        const bridgeRes = await fetchBridge("/shield", { method: "GET" }, 1800);
        const rulesCount = buildShieldRules({
          shield: state.shield,
          extensionId: chrome.runtime.id
        }).length;
        sendResponse({
          ok: true,
          shield: state.shield,
          incognitoAllowed,
          extensionId: chrome.runtime.id,
          rulesCount,
          desktopConnected: Boolean(bridgeRes?.ok),
          desktopDiagnostic: bridgeRes?.diagnostic || null
        });
        break;
      }

      case "GET_MOBILE_QR_URL": {
        const provider = message.provider || state.shield?.provider || "cleanbrowsing";
        const bridgeRes = await fetchBridge(
          "/mobile-qr",
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ provider })
          },
          1000
        );
        sendResponse({
          ok: true,
          iosUrl: bridgeRes?.url || null,
          desktopConnected: Boolean(bridgeRes?.ok)
        });
        break;
      }

      case "SOCIAL_SHIELD_ENFORCE": {
        const tabId = sender?.tab?.id;
        const targetUrl = message.url || sender?.tab?.url || "https://www.instagram.com/reels/";
        const allTabsNow = await chrome.tabs.query({});
        const { openWorkTabs: workTabsNow } = findMatchingWorkTab(
          allTabsNow,
          getEffectiveWorkSites(state),
          state.lastWorkTab?.id ?? null,
          state.activeGoal?.site || ""
        );
        const focusActiveNow = isFocusTimerOrScheduleActive(state, now, workTabsNow);
        if (tabId && state.shield?.enabled && state.shield?.noReels !== false && focusActiveNow) {
          const blockedPagePrefix = chrome.runtime.getURL("src/blocked.html");
          if (message.action === "redirect-inbox" && message.targetUrl) {
            await chrome.tabs.update(tabId, { url: message.targetUrl }).catch(() => {});
          } else {
            await chrome.tabs
              .update(tabId, { url: `${blockedPagePrefix}?reason=reels#${targetUrl}` })
              .catch(() => {});
          }
        }
        sendResponse({ ok: true });
        break;
      }

      case "GET_OPEN_TABS": {
        const allTabs = await chrome.tabs.query({});
        const seen = new Set();
        const tabs = [];
        for (const tab of allTabs) {
          const domain = extractHostname(tab.url || "");
          if (!domain) continue;
          const key = `${domain}::${tab.id}`;
          if (seen.has(key)) continue;
          seen.add(key);
          tabs.push({
            id: tab.id,
            windowId: tab.windowId,
            title: tab.title || domain,
            domain,
            url: tab.url,
            active: Boolean(tab.active)
          });
        }
        sendResponse({ ok: true, tabs });
        break;
      }

      case "SET_ACTIVE_GOAL": {
        const nextGoal = normalizeGoal({
          ...(message.goal || {}),
          updatedAtMs: Date.now()
        });
        if (!nextGoal) {
          sendResponse({ ok: false, error: "Goal requires a title or target" });
          break;
        }
        state = applyGoalToState(state, nextGoal, {
          replaceWorkLists: Boolean(message.replaceWorkLists),
          blacklist: Array.isArray(message.blacklist) ? message.blacklist : undefined
        });
        await saveState(state);
        postBridge("/goal", { goal: state.activeGoal });
        const { status, openWorkTabs, bestWorkTab, lang } = await refreshEngine(state);
        await syncActiveTabTracking(state);
        sendResponse({ ok: true, state, status, openWorkTabs, bestWorkTab, lang });
        break;
      }

      case "GET_EXTENSION_DASHBOARD": {
        const days = Math.max(1, Math.min(400, Number(message.days) || 7));
        await flushActiveSegment(Date.now(), true);
        await syncActiveTabTracking(state);

        const desktopData = await fetchBridge(`/dashboard?days=${days}`, { method: "GET" }, 800);
        if (desktopData && Array.isArray(desktopData.daily)) {
          postBridge("/heartbeat", {});
          sendResponse({
            ok: true,
            source: "desktop-sqlite",
            lang: getEffectiveLang(state),
            data: desktopData
          });
          break;
        }

        const localStore = await loadExtAnalytics();
        const localData = buildLocalDashboardRaw(localStore, days, Date.now());
        sendResponse({
          ok: true,
          source: "extension-local",
          lang: getEffectiveLang(state),
          data: localData
        });
        break;
      }

      case "RESET_EXTENSION_DASHBOARD": {
        await saveActiveSegment(null);
        await saveExtAnalytics(createEmptyExtensionAnalytics());
        state.stats = { date: getLocalDateKey(now), total: 0, perSite: {} };
        await saveState(state);
        await fetchBridge("/reset", { method: "POST" }, 800);
        sendResponse({ ok: true });
        break;
      }

      case "SET_LANGUAGE": {
        if (["auto", "fr", "en"].includes(message.language)) {
          state.language = message.language;
          await saveState(state);
        }
        const { status, openWorkTabs, bestWorkTab, lang } = await refreshEngine(state);
        sendResponse({ ok: true, state, status, openWorkTabs, bestWorkTab, lang });
        break;
      }

      case "START_SESSION": {
        const minutes = Number(message.minutes) || 25;
        const plannedMs = minutes * 60 * 1000;
        const endsAt = Date.now() + plannedMs;
        state.sessionCompletedFree = false;
        state.sessionEndsAt = endsAt;
        if (message.goal) {
          const nextGoal = normalizeGoal({ ...message.goal, updatedAtMs: Date.now() });
          if (nextGoal) {
            state = applyGoalToState(state, nextGoal);
            postBridge("/goal", { goal: state.activeGoal });
          }
        }
        await saveState(state);
        await chrome.alarms.create(ALARM_SESSION_END, { when: endsAt });
        postBridge("/session", { action: "start", plannedMs });
        const { status, openWorkTabs, bestWorkTab, lang } = await refreshEngine(state);
        sendResponse({ ok: true, state, status, openWorkTabs, bestWorkTab, lang });
        break;
      }

      case "SET_MANUAL": {
        if (isLocked(state, now) && !message.manualOn) {
          sendResponse({ ok: false, error: "Locked session running" });
          break;
        }
        if (message.manualOn) state.sessionCompletedFree = false;
        state.manualOn = Boolean(message.manualOn);
        await saveState(state);
        const { status, openWorkTabs, bestWorkTab, lang } = await refreshEngine(state);
        sendResponse({ ok: true, state, status, openWorkTabs, bestWorkTab, lang });
        break;
      }

      case "SET_AUTO_TRIGGER": {
        if (isLocked(state, now) && !message.autoTriggerEnabled) {
          sendResponse({ ok: false, error: "Locked session running" });
          break;
        }
        state.autoTriggerEnabled = Boolean(message.autoTriggerEnabled);
        await saveState(state);
        const { status, openWorkTabs, bestWorkTab, lang } = await refreshEngine(state);
        sendResponse({ ok: true, state, status, openWorkTabs, bestWorkTab, lang });
        break;
      }

      case "UPDATE_PLAN": {
        if (isLocked(state, now)) {
          sendResponse({ ok: false, error: "Locked session running" });
          break;
        }
        if (typeof message.mode === "string" && ["blacklist", "whitelist"].includes(message.mode)) {
          state.mode = message.mode;
        }
        if (Array.isArray(message.workSites)) {
          state.workSites = cleanDomainList(message.workSites);
        }
        if (Array.isArray(message.blacklist)) {
          state.blacklist = cleanDomainList(message.blacklist);
        }
        if (Array.isArray(message.whitelist)) {
          state.whitelist = cleanDomainList(message.whitelist);
        }
        if (typeof message.autoTriggerEnabled === "boolean") {
          state.autoTriggerEnabled = message.autoTriggerEnabled;
        }
        if (Array.isArray(message.schedules)) {
          state.schedules = message.schedules;
        }
        if (typeof message.presenceCheckEnabled === "boolean") {
          state.presenceCheckEnabled = message.presenceCheckEnabled;
        }
        if ([1, 2, 5].includes(Number(message.presenceIdleMinutes))) {
          state.presenceIdleMinutes = Number(message.presenceIdleMinutes);
        }
        await saveState(state);
        const { status, openWorkTabs, bestWorkTab, lang } = await refreshEngine(state);
        sendResponse({ ok: true, state, status, openWorkTabs, bestWorkTab, lang });
        break;
      }

      case "QUICK_ADD_DOMAIN": {
        const listName = message.listName;
        const domain = normalizeDomain(message.domain || "");
        if (!domain || !["workSites", "blacklist", "whitelist"].includes(listName)) {
          sendResponse({ ok: false, error: "Invalid domain" });
          break;
        }
        state[listName] = cleanDomainList([...(state[listName] || []), domain]);
        await saveState(state);
        const { status, openWorkTabs, bestWorkTab, lang } = await refreshEngine(state);
        sendResponse({ ok: true, domain, state, status, openWorkTabs, bestWorkTab, lang });
        break;
      }

      case "QUICK_REMOVE_DOMAIN": {
        if (isLocked(state, now)) {
          sendResponse({ ok: false, error: "Locked session running" });
          break;
        }
        const listName = message.listName;
        const domain = normalizeDomain(message.domain || "");
        if (!["workSites", "blacklist", "whitelist"].includes(listName)) {
          sendResponse({ ok: false, error: "Invalid list" });
          break;
        }
        state[listName] = (state[listName] || []).filter((d) => d !== domain);
        if (listName === "workSites" && state.activeGoal?.site === domain) {
          state.activeGoal = normalizeGoal({
            ...state.activeGoal,
            site: "",
            updatedAtMs: Date.now()
          });
          postBridge("/goal", { goal: state.activeGoal });
        }
        await saveState(state);
        const { status, openWorkTabs, bestWorkTab, lang } = await refreshEngine(state);
        sendResponse({ ok: true, state, status, openWorkTabs, bestWorkTab, lang });
        break;
      }

      case "SET_PRESENCE_SETTINGS": {
        if (typeof message.presenceCheckEnabled === "boolean") {
          state.presenceCheckEnabled = message.presenceCheckEnabled;
        }
        if ([1, 2, 5].includes(Number(message.presenceIdleMinutes))) {
          state.presenceIdleMinutes = Number(message.presenceIdleMinutes);
        }
        await saveState(state);
        const { status, openWorkTabs, bestWorkTab, lang } = await refreshEngine(state);
        sendResponse({ ok: true, state, status, openWorkTabs, bestWorkTab, lang });
        break;
      }

      case "RECORD_BLOCK_AND_GET_CONTEXT": {
        const rawUrl = message.blockedUrl || "";
        const isDemo = Boolean(message.isDemo);
        const isPresence = Boolean(message.isPresence);
        const hostname = extractHostname(rawUrl) || normalizeDomain(rawUrl) || "instagram.com";

        state = await syncGoalWithBridge(state);

        if (!isDemo && !isPresence) {
          state.stats = recordBlockedAttempt(state.stats, hostname, getLocalDateKey(now));
          await saveState(state);

          let analytics = await loadExtAnalytics();
          analytics = recordExtensionBlocked(analytics, {
            domain: hostname,
            tsMs: now.getTime(),
            kind: "distraction-site"
          });
          await saveExtAnalytics(analytics);

          postBridge("/event", {
            eventType: "blocked",
            target: hostname,
            metaJson: JSON.stringify({ kind: "distraction-site", source: "extension" })
          });
        }

        const allTabs = await chrome.tabs.query({});
        const effectiveWorkSites = getEffectiveWorkSites(state);
        const { bestWorkTab } = findMatchingWorkTab(
          allTabs,
          effectiveWorkSites,
          state.lastWorkTab?.id ?? null,
          state.activeGoal?.site || ""
        );

        const prefersDesktopApp = Boolean(
          state.activeGoal?.app && (state.activeGoal?.targetType === "app" || !state.activeGoal?.site)
        );
        let desktopGoalWindow = null;
        if (!bestWorkTab || prefersDesktopApp || state.activeGoal?.app) {
          const bridgeGoal = await fetchBridge("/goal", { method: "GET" }, 450);
          if (bridgeGoal?.desktopWindow) {
            desktopGoalWindow = bridgeGoal.desktopWindow;
          }
        }

        const returnWorkTab = prefersDesktopApp && desktopGoalWindow ? null : bestWorkTab;

        sendResponse({
          ok: true,
          isDemo,
          isPresence,
          presenceIdleMinutes: state.presenceIdleMinutes || 2,
          lang: getEffectiveLang(state),
          blockedDomain: hostname,
          stats: state.stats,
          sound: state.sound,
          bestWorkTab: returnWorkTab,
          desktopGoalWindow,
          activeGoal: state.activeGoal,
          workSites: effectiveWorkSites
        });
        break;
      }

      case "BOOMERANG_CLOSE": {
        const result = await executeBoomerangClose(
          sender?.tab,
          Boolean(message.isDemo),
          Boolean(message.isPresence)
        );
        sendResponse({ ok: true, ...result });
        break;
      }

      default:
        sendResponse({ ok: false, error: "Unknown command" });
    }
  })();
  return true;
});
