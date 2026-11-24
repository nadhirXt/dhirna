/**
 * Dhirna Desktop Core Engine (Tauri 2 bridge + Browser preview fallback).
 */

import {
  classifyWindow,
  normalizeProcessName,
  isTamperOrExtensionManagerWindow
} from "./lib/matcher.js";
import {
  createDefaultState,
  getLocalDateKey,
  isBlockingActive,
  isLocked,
  getActivationStatus,
  recordBlockedAttempt,
  normalizeGoal,
  normalizePresenceSettings,
  normalizeUsbBlockedApps,
  applyGoalToState,
  isFocusTimerOrScheduleActive
} from "./lib/state.js";
import {
  normalizeSoundSettings,
  validateSoundFileMeta,
  setCustomSoundDataUrl,
  getCustomSoundDataUrl
} from "./lib/alarm.js";
import { cleanDomainList } from "./lib/rules.js";
import { resolveLanguage } from "./lib/i18n.js";
import { createPreviewDataset } from "./lib/analytics.js";
import {
  normalizeShieldState,
  isShieldLocked,
  getShieldProvider,
  mergeShieldStates
} from "./lib/shield.js";

const LOCAL_STORAGE_KEY = "dhirna_desktop_state";
const PREVIEW_RESET_KEY = "dhirna_preview_reset";
const PREVIEW_CUSTOM_SOUND_KEY = "dhirna_preview_custom_sound";
const GRACE_COOLDOWN_MS = 4000;

const MOCK_OPEN_WINDOWS = [
  { id: 101, processName: "code", title: "matcher.js — dhirna — Visual Studio Code", pid: 4120 },
  { id: 102, processName: "firefox", title: "Overleaf — Rapport — Mozilla Firefox", pid: 4310 },
  { id: 103, processName: "soffice.bin", title: "Rapport_Final.odt — LibreOffice Writer", pid: 4890 },
  { id: 104, processName: "discord", title: "#general | Discord", pid: 5120 },
  { id: 105, processName: "steam", title: "Steam", pid: 5340 }
];

export function isTauriEnv() {
  return Boolean(window.__TAURI__?.core?.invoke);
}

export async function tauriInvoke(cmd, args = {}) {
  if (isTauriEnv()) {
    return window.__TAURI__.core.invoke(cmd, args);
  }
  switch (cmd) {
    case "load_state": {
      const raw = localStorage.getItem(LOCAL_STORAGE_KEY);
      return raw ? JSON.parse(raw) : null;
    }
    case "save_state":
      localStorage.setItem(LOCAL_STORAGE_KEY, JSON.stringify(args.state));
      return null;
    case "list_windows":
      return MOCK_OPEN_WINDOWS;
    case "sync_bridge_goal":
      return args.goal || null;
    case "sync_bridge_shield":
      return args.shield || null;
    case "apply_adult_shield":
    case "check_adult_shield": {
      const p = getShieldProvider(args.provider || "cleanbrowsing");
      return {
        provider: p.id,
        osDnsConfigured: Boolean(args.enable),
        safesearchHostsActive: Boolean(args.enable && args.safeSearch),
        activeResolvers: args.enable ? p.ipv4 : [],
        canaryDomain: p.canaryDomain,
        canaryBlocked: Boolean(args.enable),
        details: "Aperçu local navigateur (hors Tauri)"
      };
    }
    case "analytics_dashboard": {
      if (localStorage.getItem(PREVIEW_RESET_KEY) === "1") {
        return {
          days: Number(args.days) || 7,
          generatedAtMs: Date.now(),
          isPreview: true,
          daily: [],
          previousTotals: {
            focusMs: 0,
            distractionMs: 0,
            blockedCount: 0,
            sessionsCompleted: 0,
            sessionsFailed: 0
          },
          topBlocked: [],
          timeByTarget: [],
          blockedByHour: [],
          recentEvents: []
        };
      }
      return createPreviewDataset(Number(args.days) || 7);
    }
    case "analytics_reset":
      localStorage.setItem(PREVIEW_RESET_KEY, "1");
      return null;
    case "analytics_bridge_status":
      return { running: false, port: 47821, extensionConnected: false, connectedBrowser: "" };
    case "start_mobile_qr": {
      const p = getShieldProvider(args.provider || "cleanbrowsing");
      return {
        available: true,
        url: "http://192.168.1.42:47890/dhirna-shield.mobileconfig",
        ip: "192.168.1.42",
        port: 47890,
        provider: p.id
      };
    }
    case "stop_mobile_qr":
      return null;
    case "import_custom_sound_cmd": {
      const ext = String(args.originalName || "alert.mp3")
        .split(".")
        .pop()
        .toLowerCase();
      const mime =
        ext === "wav" ? "audio/wav" : ext === "ogg" ? "audio/ogg" : "audio/mpeg";
      const rawB64 = String(args.dataBase64 || "");
      const dataUrl = rawB64.startsWith("data:") ? rawB64 : `data:${mime};base64,${rawB64}`;
      const info = {
        fileName: `custom_alert.${ext}`,
        originalName: String(args.originalName || `custom_alert.${ext}`),
        mime,
        dataUrl
      };
      localStorage.setItem(PREVIEW_CUSTOM_SOUND_KEY, JSON.stringify(info));
      return info;
    }
    case "load_custom_sound_cmd": {
      const raw = localStorage.getItem(PREVIEW_CUSTOM_SOUND_KEY);
      return raw ? JSON.parse(raw) : null;
    }
    case "remove_custom_sound_cmd":
      localStorage.removeItem(PREVIEW_CUSTOM_SOUND_KEY);
      return null;
    case "get_usb_sensor_status":
    case "set_usb_sensor_enabled_cmd":
    case "install_ios_usb_driver_cmd":
      return {
        enabled: args.enable !== false,
        iosDriverReady: true,
        iosHardwarePresent: false,
        healthyCount: 0,
        untrustedCount: 0,
        activeDistraction: null,
        sensorLost: false,
        devices: []
      };
    case "show_usb_phone_alarm":
    case "hide_usb_phone_alarm":
    case "get_usb_phone_alarm_context":
      return null;
    case "get_system_idle_ms":
      return 0;
    case "is_safe_mode_cmd":
      return false;
    default:
      return null;
  }
}

export async function tauriListen(eventName, handler) {
  if (window.__TAURI__?.event?.listen) {
    return window.__TAURI__.event.listen(eventName, (event) => handler(event.payload));
  }
  return () => {};
}

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(new Error("Impossible de lire le fichier audio"));
    reader.readAsDataURL(file);
  });
}

export class DhirnaDesktopEngine {
  constructor(onStateChange) {
    this.onStateChange = onStateChange;
    this.state = createDefaultState();
    this.openWindows = [];
    this.openWorkTargets = [];
    this.lastInterceptionAt = 0;
    this.pendingInterception = null;
    this.presencePromptOpen = false;
    this.onPresenceFallback = null;
    this.onPresenceResumed = null;
    this.onQuitBlocked = null;
    this.usbStatus = {
      enabled: true,
      iosDriverReady: false,
      iosHardwarePresent: false,
      healthyCount: 0,
      untrustedCount: 0,
      activeDistraction: null,
      sensorLost: false,
      devices: []
    };
    this.usbAlarmActive = false;
    this.usbAlarmApp = null;
    this.pausedForUsbLossRemainingMs = null;
    this.bridgeStatus = { running: false, port: 47821, extensionConnected: false, connectedBrowser: "" };
    this.everHadExtensionConnected = false;
    this.lastFocusTimerOrSchedActive = null;
    this.lastSyncedFocusEndsAt = null;
    this.safeMode = false;
    this.tickInFlight = false;
  }

  getLang() {
    return resolveLanguage(this.state?.language, navigator.language || "fr");
  }

  async init() {
    const stored = await tauriInvoke("load_state");
    const defaults = createDefaultState();
    const todayKey = getLocalDateKey();

    if (stored && typeof stored === "object") {
      const pres = normalizePresenceSettings(stored);
      this.state = {
        ...defaults,
        ...stored,
        ...pres,
        goalOnboardingDone: Boolean(stored.goalOnboardingDone),
        activeGoal: normalizeGoal(stored.activeGoal),
        shield: normalizeShieldState(stored.shield),
        sound: normalizeSoundSettings(stored.sound),
        usbReelsEnabled: stored.usbReelsEnabled !== false,
        usbBlockedApps: normalizeUsbBlockedApps(stored.usbBlockedApps),
        workSites: cleanDomainList(stored.workSites ?? defaults.workSites),
        workApps: Array.isArray(stored.workApps)
          ? stored.workApps.map(normalizeProcessName).filter(Boolean)
          : defaults.workApps,
        blacklist: cleanDomainList(stored.blacklist ?? defaults.blacklist),
        whitelist: cleanDomainList(stored.whitelist ?? defaults.whitelist),
        blockedApps: Array.isArray(stored.blockedApps) ? stored.blockedApps : defaults.blockedApps,
        stats:
          stored.stats && stored.stats.date === todayKey
            ? stored.stats
            : { date: todayKey, total: 0, perSite: {} }
      };
    } else {
      this.state = defaults;
      await this.save();
    }

    // Hydrate persisted custom alert sound from <appData>/sounds/
    const storedSound = await tauriInvoke("load_custom_sound_cmd").catch(() => null);
    if (storedSound?.dataUrl) {
      setCustomSoundDataUrl(storedSound.dataUrl);
      if (!this.state.sound?.customSoundFile) {
        this.state.sound = normalizeSoundSettings({
          ...this.state.sound,
          customSoundFile: storedSound.fileName,
          customSoundName: this.state.sound?.customSoundName || storedSound.originalName
        });
      }
    } else {
      setCustomSoundDataUrl("");
      if (this.state.sound?.customSoundFile || this.state.sound?.selectedSound === "custom") {
        this.state.sound = normalizeSoundSettings({
          ...this.state.sound,
          selectedSound: "chime",
          customSoundFile: "",
          customSoundName: ""
        });
      }
    }

    await this.syncBridgeGoal();
    await this.syncBridgeShield();
    await this.refreshWindows();
    await this.syncFocusTimerWithBackend();

    await tauriListen("active-window-changed", (win) => {
      this.handleActiveWindow(win);
    });

    await tauriListen("goal-synced", (remoteGoal) => {
      this.handleRemoteGoal(remoteGoal);
    });

    await tauriListen("shield-synced", (remoteShield) => {
      this.handleRemoteShield(remoteShield);
    });

    await tauriListen("tray-start-session", (minutes) => {
      this.startSession(Number(minutes) || 25);
    });

    await tauriListen("overlay-complete", () => {
      this.pendingInterception = null;
      this.lastInterceptionAt = Date.now();
    });

    await tauriListen("presence-resumed", () => {
      this.presencePromptOpen = false;
      if (typeof this.onPresenceResumed === "function") {
        this.onPresenceResumed();
      }
    });

    await tauriListen("quit-blocked", () => {
      if (typeof this.onQuitBlocked === "function") {
        this.onQuitBlocked();
      }
    });

    this.safeMode = Boolean(await tauriInvoke("is_safe_mode_cmd").catch(() => false));

    await tauriListen("usb-sensor-status", (st) => {
      this.handleUsbSensorStatus(st);
    });

    const initialUsb = await tauriInvoke("set_usb_sensor_enabled_cmd", {
      enable: this.state.usbReelsEnabled !== false,
      watchedApps: normalizeUsbBlockedApps(this.state.usbBlockedApps)
    }).catch(() => null);
    if (initialUsb) {
      this.usbStatus = initialUsb;
    }

    if (this.state.shield?.enabled) {
      tauriInvoke("set_anti_uninstall_guardian_cmd", { enable: true }).catch(() => {});
    }

    setInterval(() => {
      this.tick();
    }, 2000);

    this.notifyUI();
  }

  async save() {
    await tauriInvoke("save_state", { state: this.state });
    await this.syncFocusTimerWithBackend();
  }

  async syncFocusTimerWithBackend(now = new Date()) {
    const active = isFocusTimerOrScheduleActive(this.state, now, this.openWorkTargets);
    const endsAtMs =
      typeof this.state.sessionEndsAt === "number" && this.state.sessionEndsAt > now.getTime()
        ? this.state.sessionEndsAt
        : 0;
    if (this.lastFocusTimerOrSchedActive !== active || this.lastSyncedFocusEndsAt !== endsAtMs) {
      this.lastFocusTimerOrSchedActive = active;
      this.lastSyncedFocusEndsAt = endsAtMs;
      await tauriInvoke("sync_focus_timer_state", { active, endsAtMs }).catch(() => {});
    }
  }

  async syncBridgeGoal() {
    await tauriInvoke("sync_bridge_goal", { goal: this.state.activeGoal || null }).catch(() => null);
  }

  async syncBridgeShield() {
    const remote = await tauriInvoke("sync_bridge_shield", {
      shield: normalizeShieldState(this.state.shield)
    }).catch(() => null);
    if (remote && typeof remote === "object") {
      const merged = mergeShieldStates(this.state.shield, remote);
      if (merged.winner === "remote") {
        this.state.shield = merged.shield;
        await this.save();
      }
    }
  }

  async handleRemoteShield(remoteShield) {
    const merged = mergeShieldStates(this.state.shield, remoteShield);
    if (merged.winner === "remote") {
      this.state.shield = merged.shield;
      await this.save();
      this.notifyUI();
    }
  }

  async startMobileQr(provider) {
    const prov = provider || this.state.shield?.provider || "cleanbrowsing";
    return tauriInvoke("start_mobile_qr", { provider: prov });
  }

  async stopMobileQr() {
    await tauriInvoke("stop_mobile_qr").catch(() => null);
  }

  async updateSoundSettings(patch = {}) {
    this.state.sound = normalizeSoundSettings({
      ...this.state.sound,
      ...patch
    });
    await this.save();
    this.notifyUI();
    return this.state.sound;
  }

  async importCustomSound(file) {
    if (!file) {
      return { ok: false, errorKey: "sound_err_empty" };
    }
    const headerBuf = await file.slice(0, 16).arrayBuffer();
    const headerBytes = new Uint8Array(headerBuf);
    const check = validateSoundFileMeta({
      name: file.name,
      sizeBytes: file.size,
      headerBytes
    });
    if (!check.valid) {
      return { ok: false, errorKey: check.errorKey || "sound_err_format" };
    }

    try {
      const dataBase64 = await readFileAsDataUrl(file);
      const saved = await tauriInvoke("import_custom_sound_cmd", {
        originalName: file.name,
        dataBase64
      });
      if (!saved?.dataUrl) {
        return { ok: false, errorKey: "sound_err_corrupt" };
      }
      setCustomSoundDataUrl(saved.dataUrl);
      this.state.sound = normalizeSoundSettings({
        ...this.state.sound,
        selectedSound: "custom",
        customSoundName: saved.originalName || file.name,
        customSoundFile: saved.fileName
      });
      await this.save();
      this.notifyUI();
      return { ok: true, sound: this.state.sound };
    } catch (err) {
      return { ok: false, error: String(err) };
    }
  }

  async removeCustomSound() {
    await tauriInvoke("remove_custom_sound_cmd").catch(() => null);
    setCustomSoundDataUrl("");
    this.state.sound = normalizeSoundSettings({
      ...this.state.sound,
      selectedSound: "chime",
      customSoundName: "",
      customSoundFile: ""
    });
    await this.save();
    this.notifyUI();
    return { ok: true, sound: this.state.sound };
  }

  async applyShield(patch = {}) {
    const curr = normalizeShieldState(this.state.shield);
    if (isShieldLocked(curr) && (patch.enabled === false || patch.safeSearch === false || patch.noReels === false)) {
      return { ok: false, error: "Shield locked" };
    }
    const next = normalizeShieldState({
      ...curr,
      ...patch,
      lockUntilMs: patch.lockUntilMs !== undefined ? patch.lockUntilMs : curr.lockUntilMs,
      updatedAtMs: Date.now()
    });
    try {
      const diagnostic = await tauriInvoke("apply_adult_shield", {
        provider: next.provider,
        enable: next.enabled,
        safeSearch: next.safeSearch,
        youtubeRestricted: next.youtubeRestricted,
        noReels: next.noReels
      });
      await tauriInvoke("set_anti_uninstall_guardian_cmd", { enable: Boolean(next.enabled) }).catch(
        () => {}
      );
      this.state.shield = next;
      await this.save();
      await this.syncBridgeShield();
      this.notifyUI();
      return { ok: true, diagnostic };
    } catch (err) {
      this.notifyUI();
      return { ok: false, error: String(err) };
    }
  }

  async lockShield(hours) {
    const curr = normalizeShieldState(this.state.shield);
    const lockUntilMs = Math.max(curr.lockUntilMs || 0, Date.now() + hours * 3_600_000);
    return this.applyShield({ enabled: true, lockUntilMs });
  }

  async checkShieldDiagnostic() {
    const curr = normalizeShieldState(this.state.shield);
    return tauriInvoke("check_adult_shield", { provider: curr.provider });
  }

  async handleRemoteGoal(remoteGoal) {
    const normalized = normalizeGoal(remoteGoal);
    const currTs = this.state.activeGoal?.updatedAtMs || 0;
    if (normalized && normalized.updatedAtMs >= currTs) {
      this.state = applyGoalToState(this.state, normalized);
      await this.save();
      await this.refreshWindows();
      this.notifyUI();
    }
  }

  async setActiveGoal(goalInput, options = {}) {
    const goal = normalizeGoal({
      ...(goalInput || {}),
      updatedAtMs: Date.now()
    });
    if (!goal) return false;
    this.state = applyGoalToState(this.state, goal, options);
    await this.save();
    await this.syncBridgeGoal();
    await this.refreshWindows();
    this.notifyUI();
    return true;
  }

  async refreshWindows() {
    const wins = (await tauriInvoke("list_windows")) || [];
    this.openWindows = wins;
    this.openWorkTargets = [];

    for (const w of wins) {
      const c = classifyWindow(w, this.state);
      if (c.kind === "work") {
        this.openWorkTargets.push({
          id: w.id,
          title: w.title,
          processName: w.processName,
          entry: c.entry,
          source: c.source
        });
      }
    }

    if (this.state.lastWorkWindow) {
      const stillOpen = this.openWorkTargets.some((w) => w.id === this.state.lastWorkWindow.id);
      if (!stillOpen) {
        this.state.lastWorkWindow = this.openWorkTargets[0] || null;
      }
    } else if (this.openWorkTargets.length > 0) {
      this.state.lastWorkWindow = this.openWorkTargets[0];
    }

    const bestTarget = this.pickReturnTarget();
    if (bestTarget && bestTarget.id) {
      tauriInvoke("note_work_window", {
        win: {
          id: bestTarget.id,
          title: bestTarget.title || "",
          pid: 0,
          processName: bestTarget.processName || ""
        }
      }).catch(() => {});
    }
  }

  pickReturnTarget() {
    const goalApp = normalizeProcessName(this.state.activeGoal?.app || "");
    const goalSite = this.state.activeGoal?.site || "";
    const goalWinTitle = (this.state.activeGoal?.windowTitle || "").trim().toLowerCase();

    if (goalApp) {
      const matchApp =
        this.openWorkTargets.find((w) => {
          const wp = normalizeProcessName(w.processName);
          return wp === goalApp || (wp.length >= 6 && goalApp.startsWith(wp)) || (goalApp.length >= 6 && wp.startsWith(goalApp));
        }) ||
        this.openWindows.find((w) => {
          const wp = normalizeProcessName(w.processName);
          return wp === goalApp || (w.title || "").toLowerCase().includes(goalApp);
        });
      if (matchApp) return matchApp;
    }

    if (goalWinTitle) {
      const matchWin = this.openWindows.find((w) =>
        (w.title || "").toLowerCase().includes(goalWinTitle)
      );
      if (matchWin) return matchWin;
    }

    if (goalSite) {
      const matchSite = this.openWorkTargets.find((w) => w.source === "site" && w.entry === goalSite);
      if (matchSite) return matchSite;
    }

    if (
      this.state.lastWorkWindow &&
      this.openWorkTargets.some((w) => w.id === this.state.lastWorkWindow.id)
    ) {
      return this.state.lastWorkWindow;
    }

    return this.openWorkTargets[0] || null;
  }

  getStatus() {
    return getActivationStatus(this.state, new Date(), this.openWorkTargets, this.getLang());
  }

  notifyUI() {
    if (typeof this.onStateChange === "function") {
      this.onStateChange(this.state, this.getStatus(), this.openWindows, this.getLang());
    }
  }

  async tick() {
    if (this.tickInFlight) return;
    this.tickInFlight = true;
    try {
      const now = new Date();
      const freshUsb = await tauriInvoke("get_usb_sensor_status").catch(() => null);
      if (freshUsb) {
        await this.handleUsbSensorStatus(freshUsb, now.getTime());
      }

      if (this.pausedForUsbLossRemainingMs !== null && typeof this.state.sessionEndsAt === "number") {
        this.state.sessionEndsAt = now.getTime() + this.pausedForUsbLossRemainingMs;
      } else if (typeof this.state.sessionEndsAt === "number" && this.state.sessionEndsAt <= now.getTime()) {
        this.state.sessionEndsAt = null;
        this.state.sessionCompletedFree = true;
        tauriInvoke("analytics_session_end", { outcome: "completed" }).catch(() => {});
        await this.save();
      }
      const status = await tauriInvoke("analytics_bridge_status").catch(() => null);
      if (status) {
        this.bridgeStatus = status;
        if (status.extensionConnected || Number(status.lastHeartbeatMs) > 0) {
          this.everHadExtensionConnected = true;
        }
      }
      await this.refreshWindows();
      await this.syncFocusTimerWithBackend(now);

      if (
        this.state.presenceCheckEnabled !== false &&
        !this.presencePromptOpen &&
        !this.pendingInterception &&
        isBlockingActive(this.state, new Date(), this.openWorkTargets)
      ) {
        const idleMs = Number(await tauriInvoke("get_system_idle_ms").catch(() => 0)) || 0;
        const thresholdMs = (Number(this.state.presenceIdleMinutes) || 2) * 60_000;
        if (idleMs >= thresholdMs) {
          await this.triggerPresencePrompt(idleMs);
        }
      }

      this.notifyUI();
    } finally {
      this.tickInFlight = false;
    }
  }

  async triggerPresencePrompt(idleMs = 120_000) {
    if (this.presencePromptOpen) return;
    this.presencePromptOpen = true;
    await tauriInvoke("pause_focus_for_idle", { deductMs: Math.max(0, Math.round(idleMs)) }).catch(() => {});

    const returnTarget = this.pickReturnTarget();
    const payload = {
      lang: this.getLang(),
      idleMinutes: Number(this.state.presenceIdleMinutes) || 2,
      alarmDelaySeconds: 30,
      goalTitle: this.state.activeGoal?.title || "",
      returnTarget,
      sound: this.state.sound,
      customSoundDataUrl: getCustomSoundDataUrl()
    };

    if (isTauriEnv()) {
      await tauriInvoke("show_presence_overlay", { payload }).catch(() => {});
    } else if (typeof this.onPresenceFallback === "function") {
      this.onPresenceFallback(payload);
    }
  }

  async confirmPresenceResume() {
    this.presencePromptOpen = false;
    if (isTauriEnv()) {
      await tauriInvoke("confirm_presence_resume").catch(() => {});
    }
    this.notifyUI();
  }

  async setPresenceSettings({ presenceCheckEnabled, presenceIdleMinutes } = {}) {
    if (typeof presenceCheckEnabled === "boolean") {
      this.state.presenceCheckEnabled = presenceCheckEnabled;
    }
    if ([1, 2, 5].includes(Number(presenceIdleMinutes))) {
      this.state.presenceIdleMinutes = Number(presenceIdleMinutes);
    }
    await this.save();
    this.notifyUI();
  }

  isChromiumExtBrowser(processName) {
    const norm = normalizeProcessName(processName || "");
    return [
      "brave",
      "brave-browser",
      "chrome",
      "google-chrome",
      "google-chrome-stable",
      "chromium",
      "chromium-browser",
      "msedge",
      "microsoft-edge"
    ].includes(norm);
  }

  isDeferredToExtension(processName) {
    if (!this.bridgeStatus?.extensionConnected) return false;
    return this.isChromiumExtBrowser(processName);
  }

  async handleActiveWindow(win) {
    if (!win || this.pendingInterception) return;
    const isTamperWin = isTamperOrExtensionManagerWindow(win);
    if (!isTamperWin && this.isDeferredToExtension(win.processName)) {
      return;
    }
    let classification = classifyWindow(win, this.state);

    const extDisconnectedTamper =
      !isTamperWin &&
      this.everHadExtensionConnected &&
      !this.bridgeStatus?.extensionConnected &&
      this.isChromiumExtBrowser(win.processName) &&
      Boolean(
        this.state?.shield?.enabled ||
          isFocusTimerOrScheduleActive(this.state, new Date(), this.openWorkTargets)
      );
    if (extDisconnectedTamper) {
      classification = {
        kind: "distraction-site",
        entry: "Extension Dhirna désactivée — Réactivez-la pour utiliser le navigateur",
        source: "tamper-guard"
      };
    }

    const analyticsKind =
      classification.kind === "work"
        ? "work"
        : classification.kind === "distraction-site" || classification.kind === "distraction-app"
          ? "distraction"
          : "neutral";
    const analyticsDomain =
      (classification.kind === "work" && classification.source === "site") ||
      classification.kind === "distraction-site"
        ? String(classification.entry || "")
        : "";
    tauriInvoke("analytics_tag", {
      winId: win.id || 0,
      kind: analyticsKind,
      domain: analyticsDomain
    }).catch(() => {});

    if (classification.kind === "work") {
      const changed =
        this.state.lastWorkWindow?.id !== win.id ||
        this.state.lastWorkWindow?.title !== win.title;
      this.state.lastWorkWindow = {
        id: win.id,
        title: win.title,
        processName: win.processName,
        entry: classification.entry,
        source: classification.source
      };
      tauriInvoke("note_work_window", { win }).catch(() => {});
      if (changed) {
        await this.refreshWindows();
        await this.save();
        this.notifyUI();
      }
      return;
    }

    if (
      classification.kind !== "distraction-site" &&
      classification.kind !== "distraction-app"
    ) {
      return;
    }

    const now = new Date();
    await this.refreshWindows();
    const isSocialShield =
      classification.source === "social-shield" || classification.source === "tamper-guard";
    if (!isSocialShield && !isBlockingActive(this.state, now, this.openWorkTargets)) {
      return;
    }

    if (Date.now() - this.lastInterceptionAt < GRACE_COOLDOWN_MS) {
      return;
    }
    this.lastInterceptionAt = Date.now();

    const targetLabel =
      classification.kind === "distraction-site"
        ? classification.entry
        : classification.entry.label || classification.entry.process;

    this.state.stats = recordBlockedAttempt(this.state.stats, targetLabel, getLocalDateKey(now));
    tauriInvoke("analytics_event", {
      eventType: "blocked",
      target: targetLabel,
      metaJson: JSON.stringify({ kind: classification.kind })
    }).catch(() => {});
    await this.save();
    this.notifyUI();

    const returnTarget = this.pickReturnTarget();
    const context = {
      isDemo: false,
      lang: this.getLang(),
      goalTitle: this.state.activeGoal?.title || "",
      distractionKind: classification.kind,
      distractionWindowId: win.id,
      distractionPid: Number(win.pid) || 0,
      distractionProcess: win.processName,
      distractionLabel: targetLabel,
      shouldKill:
        classification.kind === "distraction-app"
          ? classification.entry?.kill !== false
          : false,
      returnTarget,
      stats: this.state.stats,
      sound: this.state.sound,
      customSoundDataUrl: getCustomSoundDataUrl()
    };

    this.pendingInterception = context;
    setTimeout(() => {
      this.pendingInterception = null;
    }, 4500);

    await tauriInvoke("show_overlay", { payload: context });
  }

  async startSession(minutes) {
    const mins = Math.max(1, Number(minutes) || 25);
    this.pausedForUsbLossRemainingMs = null;
    this.state.sessionCompletedFree = false;
    this.state.sessionEndsAt = Date.now() + mins * 60 * 1000;
    tauriInvoke("analytics_session_start", { plannedMs: mins * 60 * 1000 }).catch(() => {});
    await this.save();
    this.notifyUI();
    return { ok: true };
  }

  async setUsbGuardEnabled(enabled) {
    const clean = Boolean(enabled);
    if (isLocked(this.state) && !clean) return false;
    this.state.usbReelsEnabled = clean;
    if (!clean) {
      this.pausedForUsbLossRemainingMs = null;
      await this.clearUsbPhoneAlarm();
    }
    const st = await tauriInvoke("set_usb_sensor_enabled_cmd", {
      enable: clean,
      watchedApps: normalizeUsbBlockedApps(this.state.usbBlockedApps)
    }).catch(() => null);
    if (st) this.usbStatus = st;
    await this.save();
    this.notifyUI();
    return true;
  }

  async setUsbBlockedApps(apps) {
    if (isLocked(this.state)) return false;
    this.state.usbBlockedApps = normalizeUsbBlockedApps(apps);
    const st = await tauriInvoke("set_usb_sensor_enabled_cmd", {
      enable: this.state.usbReelsEnabled !== false,
      watchedApps: this.state.usbBlockedApps
    }).catch(() => null);
    if (st) this.usbStatus = st;
    await this.save();
    this.notifyUI();
    return true;
  }

  async installIosUsbDriver() {
    try {
      const st = await tauriInvoke("install_ios_usb_driver_cmd");
      if (st) this.usbStatus = st;
      this.notifyUI();
      return { ok: true, status: st };
    } catch (err) {
      return { ok: false, error: String(err) };
    }
  }

  async handleUsbSensorStatus(st, nowMs = Date.now()) {
    if (!st) return;
    this.usbStatus = st;

    if (typeof this.state.sessionEndsAt === "number" && this.state.sessionEndsAt > nowMs) {
      if (st.sensorLost && this.state.usbReelsEnabled !== false) {
        if (this.pausedForUsbLossRemainingMs === null) {
          this.pausedForUsbLossRemainingMs = Math.max(1000, this.state.sessionEndsAt - nowMs);
          tauriInvoke("pause_focus_for_idle", { deductMs: 0 }).catch(() => {});
        }
        this.state.sessionEndsAt = nowMs + this.pausedForUsbLossRemainingMs;
      } else if (this.pausedForUsbLossRemainingMs !== null) {
        this.state.sessionEndsAt = nowMs + this.pausedForUsbLossRemainingMs;
        this.pausedForUsbLossRemainingMs = null;
        await this.save().catch(() => {});
      }
    } else {
      this.pausedForUsbLossRemainingMs = null;
    }

    const protectionActive = Boolean(
      this.state.usbReelsEnabled !== false &&
        !st.sensorLost &&
        isBlockingActive(this.state, new Date(nowMs), this.openWorkTargets)
    );

    if (protectionActive && st.activeDistraction) {
      await this.triggerUsbPhoneAlarm(st.activeDistraction);
    } else if (this.usbAlarmActive) {
      await this.clearUsbPhoneAlarm();
    }

    this.notifyUI();
  }

  async triggerUsbPhoneAlarm(appRaw) {
    const normApp = String(appRaw || "instagram").toLowerCase();
    if (this.usbAlarmActive && this.usbAlarmApp === normApp) {
      return;
    }
    const firstTrigger = !this.usbAlarmActive;
    this.usbAlarmActive = true;
    this.usbAlarmApp = normApp;

    const labelMap = {
      instagram: "Instagram",
      tiktok: "TikTok",
      snapchat: "Snapchat",
      facebook: "Facebook",
      x: "X / Twitter",
      reddit: "Reddit",
      shorts: "YouTube Shorts"
    };
    const appLabel = labelMap[normApp] || "Instagram";
    const targetName = `${appLabel} (USB)`;

    if (firstTrigger) {
      const now = new Date();
      this.state.stats = recordBlockedAttempt(this.state.stats, targetName, getLocalDateKey(now));
      tauriInvoke("analytics_event", {
        eventType: "blocked",
        target: targetName,
        metaJson: JSON.stringify({ kind: "usb-phone", app: normApp })
      }).catch(() => {});
      tauriInvoke("pause_focus_for_idle", { deductMs: 1500 }).catch(() => {});
      await this.save().catch(() => {});
    }

    const returnTarget = this.pickReturnTarget();
    const payload = {
      app: normApp,
      appLabel,
      lang: this.getLang(),
      goalTitle: this.state.activeGoal?.title || "",
      returnTarget,
      sound: this.state.sound,
      customSoundDataUrl: getCustomSoundDataUrl()
    };

    await tauriInvoke("show_usb_phone_alarm", { payload }).catch(() => {});
  }

  async clearUsbPhoneAlarm() {
    if (!this.usbAlarmActive) return;
    this.usbAlarmActive = false;
    this.usbAlarmApp = null;
    const returnTarget = this.pickReturnTarget();
    await tauriInvoke("hide_usb_phone_alarm", { returnTarget }).catch(() => {});
  }

  async setLanguage(language) {
    this.state.language = language;
    await this.save();
    this.notifyUI();
  }

  async setAutoTrigger(enabled) {
    if (isLocked(this.state) && !enabled) return false;
    if (enabled) this.state.sessionCompletedFree = false;
    this.state.autoTriggerEnabled = Boolean(enabled);
    await this.save();
    this.notifyUI();
    return true;
  }

  async setManualOn(enabled) {
    if (isLocked(this.state) && !enabled) return false;
    if (enabled) this.state.sessionCompletedFree = false;
    this.state.manualOn = Boolean(enabled);
    await this.save();
    this.notifyUI();
    return true;
  }

  async setStrictMode(enabled) {
    if (isLocked(this.state) && !enabled) return { ok: false, error: "Session locked" };
    try {
      await tauriInvoke("set_strict_mode", {
        domains: this.state.blacklist,
        enable: Boolean(enabled)
      });
      this.state.strictMode = Boolean(enabled);
      await this.save();
      this.notifyUI();
      return { ok: true };
    } catch (err) {
      this.notifyUI();
      return { ok: false, error: String(err) };
    }
  }

  async fetchDashboard(days = 7) {
    return tauriInvoke("analytics_dashboard", { days: Number(days) || 7 });
  }

  async resetAnalytics() {
    await tauriInvoke("analytics_reset");
    this.state.stats = { date: getLocalDateKey(), total: 0, perSite: {} };
    await this.save();
    this.notifyUI();
  }

  async saveExportFile(filename, content) {
    if (!isTauriEnv()) {
      return null;
    }
    return tauriInvoke("save_export_file", { filename, content });
  }

  async copyToClipboard(text) {
    if (!isTauriEnv()) {
      return false;
    }
    try {
      await tauriInvoke("copy_to_clipboard", { text });
      return true;
    } catch {
      return false;
    }
  }
}
