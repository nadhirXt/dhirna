import { DhirnaDesktopEngine, isTauriEnv, tauriInvoke } from "./engine.js";
import {
  BUILTIN_SOUNDS,
  normalizeSoundSettings,
  playReturnSound
} from "./lib/alarm.js";
import { normalizeDomain } from "./lib/domains.js";
import { normalizeProcessName, isBrowserProcess, isOwnDhirnaWindow } from "./lib/matcher.js";
import {
  SUGGESTED_BLOCKED_SITES,
  USB_SOCIAL_APPS,
  normalizeUsbBlockedApps
} from "./lib/state.js";
import { applyDomTranslations, t } from "./lib/i18n.js";
import { computeDashboardViewModel, buildCsvExport } from "./lib/analytics.js";
import { renderDailyFocusChart, renderRankedList, renderHourlyStrip } from "./lib/charts.js";
import {
  SHIELD_PROVIDERS,
  SHIELD_COOLDOWN_SECONDS,
  SHIELD_DISABLE_PHRASE,
  getShieldProvider,
  normalizeShieldState,
  isShieldLocked,
  formatShieldLockRemaining,
  buildIosMobileConfig
} from "./lib/shield.js";
import { renderQrSvg } from "./lib/qr.js";
import { initTheme, toggleTheme, applyTheme, getActiveTheme } from "./lib/theme.js";
import {
  updateChronometerHud,
  initCommandPalette,
  initPresenceModal
} from "./lib/studio-ui.js";

let engine = null;
let delayInterval = null;
let shieldDisableInterval = null;
let activeView = "session";
let selectedSessionMinutes = 25;
let silenceMenuPeek = false;
let selectedDays = 7;
let latestDashboardRaw = null;
let latestShieldDiag = null;
let selectedMobileOs = "ios"; // "ios" | "android"
let latestMobileQrInfo = null;
let goalModalMode = "app";
let goalModalIsOnboarding = false;
let pendingSessionMinutes = null;
let selectedOnboardingDistractions = new Set(["instagram.com", "tiktok.com"]);
let pickedGoalWindow = null;
let presenceModalCtrl = null;
let scheduleDirty = false;
let noticeToastTimer = null;

const renderCache = {
  lang: null,
  themeKey: null,
  windowsKey: null,
  shieldProvidersKey: null,
  soundsBuiltinKey: null,
  workAppsKey: null,
  workSitesKey: null,
  blacklistKey: null,
  blockedAppsKey: null,
  usbAppsKey: null,
  scheduleKey: null,
  dashKey: null
};

function showToast(id = "save-toast", text = null) {
  const toast = document.getElementById(id);
  if (!toast) return;
  if (text) toast.textContent = text;
  toast.classList.remove("hidden");
  clearTimeout(toast._hideTimer);
  toast._hideTimer = setTimeout(() => toast.classList.add("hidden"), 2600);
}

async function copyTextReliable(text) {
  const value = String(text || "");
  if (!value) return false;
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(value);
      return true;
    }
  } catch {
    // Fallback below
  }
  try {
    const ta = document.createElement("textarea");
    ta.value = value;
    ta.style.position = "fixed";
    ta.style.left = "-9999px";
    ta.style.top = "0";
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    const ok = document.execCommand("copy");
    ta.remove();
    if (ok) return true;
  } catch {
    // Fallback to native OS clipboard command
  }
  if (engine && typeof engine.copyToClipboard === "function") {
    return engine.copyToClipboard(value);
  }
  return false;
}

async function downloadTextFile(filename, content, mimeType, toastId = "shield-toast") {
  if (isTauriEnv() && engine && typeof engine.saveExportFile === "function") {
    try {
      const savedPath = await engine.saveExportFile(filename, content);
      if (savedPath) {
        const lang = engine.getLang();
        const msg = lang === "en" ? `Saved: ${savedPath}` : `Enregistré : ${savedPath}`;
        showToast(toastId, msg);
        return true;
      }
    } catch (err) {
      showToast(toastId, String(err));
      return false;
    }
  }
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
  return true;
}

async function withButtonBusy(btn, fn) {
  if (!btn || btn.dataset.busy === "1") return;
  btn.dataset.busy = "1";
  const wasDisabled = btn.disabled;
  btn.disabled = true;
  try {
    await fn();
  } finally {
    delete btn.dataset.busy;
    btn.disabled = wasDisabled;
  }
}

function syncSilenceMode(status, lang = "fr") {
  const isLockedSession = Boolean(status?.locked);
  const inSilence = isLockedSession && activeView === "session" && !silenceMenuPeek;
  if (inSilence) {
    document.body.dataset.sessionMode = "silence";
  } else {
    delete document.body.dataset.sessionMode;
  }
  const btnSilence = document.getElementById("btn-toggle-silence");
  if (btnSilence) {
    btnSilence.classList.toggle("hidden", !isLockedSession);
    btnSilence.textContent = t(inSilence ? "session_show_menu" : "session_hide_menu", lang);
  }
}

function syncLockWarning(status) {
  const el = document.getElementById("lock-warning");
  if (!el) return;
  const show = Boolean(status?.locked) && (activeView === "planner" || activeView === "shield");
  el.classList.toggle("hidden", !show);
}

async function syncMobileQrServerForView() {
  if (!engine) return;
  if (activeView === "shield" && selectedMobileOs === "ios") {
    const providerId = engine.state?.shield?.provider || "cleanbrowsing";
    latestMobileQrInfo = await engine.startMobileQr(providerId).catch(() => null);
    renderMobileQrCard(engine.state, engine.getLang());
  } else {
    latestMobileQrInfo = null;
    engine.stopMobileQr().catch(() => {});
  }
}

function setActiveView(viewName) {
  activeView = viewName;
  const isSession = viewName === "session";
  const isShield = viewName === "shield";
  const isSounds = viewName === "sounds";
  const isPlanner = viewName === "planner";
  const isDash = viewName === "dashboard";

  document.getElementById("view-session")?.classList.toggle("hidden", !isSession);
  document.getElementById("view-shield")?.classList.toggle("hidden", !isShield);
  document.getElementById("view-sounds")?.classList.toggle("hidden", !isSounds);
  document.getElementById("view-planner")?.classList.toggle("hidden", !isPlanner);
  document.getElementById("view-dashboard")?.classList.toggle("hidden", !isDash);
  document.getElementById("planner-subnav")?.classList.toggle("hidden", !isPlanner);

  document.getElementById("nav-tab-session")?.classList.toggle("active", isSession);
  document.getElementById("nav-tab-shield")?.classList.toggle("active", isShield);
  document.getElementById("nav-tab-sounds")?.classList.toggle("active", isSounds);
  document.getElementById("nav-tab-planner")?.classList.toggle("active", isPlanner);
  document.getElementById("nav-tab-dashboard")?.classList.toggle("active", isDash);

  if (engine) {
    const status = engine.getStatus();
    syncSilenceMode(status, engine.getLang());
    syncLockWarning(status);
  }

  syncMobileQrServerForView();

  if (isDash) {
    refreshDashboard();
  } else if (isShield) {
    runShieldDiagnostic();
  }
}

function formatEventTime(tsMs) {
  const d = new Date(Number(tsMs) || 0);
  if (Number.isNaN(d.getTime())) return "—";
  const datePart = `${String(d.getDate()).padStart(2, "0")}/${String(d.getMonth() + 1).padStart(2, "0")}`;
  const timePart = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  return `${datePart} ${timePart}`;
}

function renderRecentEvents(events, lang) {
  const tbody = document.getElementById("recent-events-body");
  tbody.innerHTML = "";

  if (!Array.isArray(events) || events.length === 0) {
    const tr = document.createElement("tr");
    const td = document.createElement("td");
    td.colSpan = 3;
    td.className = "empty-placeholder";
    td.textContent = t("dash_empty_state", lang);
    tr.appendChild(td);
    tbody.appendChild(tr);
    return;
  }

  for (const ev of events) {
    const tr = document.createElement("tr");

    const tdTime = document.createElement("td");
    tdTime.className = "col-mono";
    tdTime.textContent = formatEventTime(ev.tsMs);

    const tdTarget = document.createElement("td");
    tdTarget.className = "col-mono";
    tdTarget.style.color = "var(--text-primary)";
    tdTarget.textContent = ev.target || "—";

    const tdKind = document.createElement("td");
    let kindKey = "dash_kind_site";
    try {
      const meta = JSON.parse(ev.metaJson || "{}");
      if (meta.kind === "distraction-app") kindKey = "dash_kind_app";
      else if (meta.kind === "usb-phone") kindKey = "dash_kind_usb";
    } catch {
      // keep default
    }
    tdKind.textContent = t(kindKey, lang);
    tdKind.style.color = "var(--text-secondary)";

    tr.appendChild(tdTime);
    tr.appendChild(tdTarget);
    tr.appendChild(tdKind);
    tbody.appendChild(tr);
  }
}

function renderDashboard(rawData, lang) {
  latestDashboardRaw = rawData;
  const vm = computeDashboardViewModel(rawData, selectedDays, lang, new Date());

  const badge = document.getElementById("dash-preview-badge");
  badge.classList.remove("hidden");
  if (!isTauriEnv()) {
    badge.textContent = t("dash_preview_note", lang);
    badge.style.color = "var(--text-muted)";
  } else if (engine?.bridgeStatus?.extensionConnected) {
    badge.textContent = t("dash_sync_ext_connected", lang);
    badge.style.color = "var(--accent)";
  } else {
    badge.textContent = t("dash_sync_desktop_only", lang);
    badge.style.color = "var(--text-muted)";
  }

  const applyKpi = (valId, deltaId, kpi) => {
    document.getElementById(valId).textContent = kpi.value;
    const dEl = document.getElementById(deltaId);
    dEl.textContent = kpi.delta.text;
    dEl.classList.remove("positive", "negative");
    if (kpi.delta.tone === "positive") dEl.classList.add("positive");
    if (kpi.delta.tone === "negative") dEl.classList.add("negative");
  };

  applyKpi("kpi-focus-val", "kpi-focus-delta", vm.kpis.focus);
  applyKpi("kpi-blocked-val", "kpi-blocked-delta", vm.kpis.blocked);
  applyKpi("kpi-rate-val", "kpi-rate-delta", vm.kpis.focusRate);
  applyKpi("kpi-sessions-val", "kpi-sessions-delta", vm.kpis.sessions);

  renderDailyFocusChart(document.getElementById("chart-daily-focus"), vm.series, lang);
  renderRankedList(document.getElementById("list-top-blocked"), vm.topBlocked, "count", lang);
  renderRankedList(document.getElementById("list-time-tools"), vm.timeByTarget, "duration", lang);
  renderHourlyStrip(document.getElementById("chart-hourly-strip"), vm.hourly, lang);

  const peakLabelEl = document.getElementById("hourly-peak-label");
  if (vm.hourly.peakHour !== null) {
    peakLabelEl.textContent = t("dash_hourly_peak", lang, {
      hour: `${String(vm.hourly.peakHour).padStart(2, "0")}h`,
      count: vm.hourly.maxCount
    });
  } else {
    peakLabelEl.textContent = "";
  }

  renderRecentEvents(vm.recentEvents, lang);
}

async function refreshDashboard() {
  if (!engine) return;
  try {
    const raw = await engine.fetchDashboard(selectedDays);
    renderDashboard(raw, engine.getLang());
  } catch (err) {
    console.error("Dashboard load failed:", err);
  }
}

function startDisableCountdown(onComplete, onCancel) {
  if (delayInterval) clearInterval(delayInterval);
  const box = document.getElementById("desk-delay-box");
  const secEl = document.getElementById("desk-delay-sec");
  const btnCancel = document.getElementById("btn-desk-cancel-delay");

  let remaining = 30;
  secEl.textContent = String(remaining);
  box.classList.remove("hidden");

  btnCancel.onclick = () => {
    clearInterval(delayInterval);
    delayInterval = null;
    box.classList.add("hidden");
    onCancel();
  };

  delayInterval = setInterval(async () => {
    remaining -= 1;
    if (remaining <= 0) {
      clearInterval(delayInterval);
      delayInterval = null;
      box.classList.add("hidden");
      await onComplete();
    } else {
      secEl.textContent = String(remaining);
    }
  }, 1000);
}

function renderSimpleTags(containerId, list, locked, onRemove) {
  const container = document.getElementById(containerId);
  container.innerHTML = "";
  if (!Array.isArray(list) || list.length === 0) {
    const empty = document.createElement("span");
    empty.style.color = "var(--text-muted)";
    empty.style.fontSize = "12px";
    empty.textContent = "—";
    container.appendChild(empty);
    return;
  }

  for (const item of list) {
    const tag = document.createElement("span");
    tag.className = "tag-item";
    const txt = document.createElement("span");
    txt.textContent = item;
    tag.appendChild(txt);

    if (!locked) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.textContent = "×";
      btn.addEventListener("click", () => onRemove(item));
      tag.appendChild(btn);
    }
    container.appendChild(tag);
  }
}

function renderBlockedApps(state, locked, lang) {
  const container = document.getElementById("desk-blocked-apps-list");
  container.innerHTML = "";
  const apps = Array.isArray(state.blockedApps) ? state.blockedApps : [];

  for (const app of apps) {
    const proc = typeof app === "string" ? app : app.process;
    const kill = typeof app === "object" && Boolean(app.kill);

    const row = document.createElement("div");
    row.className = "app-row";

    const left = document.createElement("span");
    left.textContent = proc;
    row.appendChild(left);

    const right = document.createElement("div");
    right.className = "app-row-right";

    const lbl = document.createElement("label");
    lbl.className = "switch-row";
    const chk = document.createElement("input");
    chk.type = "checkbox";
    chk.checked = kill;
    chk.disabled = locked;
    chk.addEventListener("change", async () => {
      app.kill = chk.checked;
      await engine.save();
      engine.notifyUI();
      showToast();
    });
    const span = document.createElement("span");
    span.textContent = t("desk_kill_toggle", lang);
    lbl.appendChild(chk);
    lbl.appendChild(span);
    right.appendChild(lbl);

    if (!locked) {
      const btnDel = document.createElement("button");
      btnDel.type = "button";
      btnDel.style.background = "none";
      btnDel.style.border = "none";
      btnDel.style.color = "var(--text-muted)";
      btnDel.style.cursor = "pointer";
      btnDel.textContent = "×";
      btnDel.addEventListener("click", async () => {
        engine.state.blockedApps = engine.state.blockedApps.filter(
          (a) => (typeof a === "string" ? a : a.process) !== proc
        );
        await engine.save();
        engine.notifyUI();
        showToast();
      });
      right.appendChild(btnDel);
    }

    row.appendChild(right);
    container.appendChild(row);
  }
}

function setGoalModalMode(mode) {
  goalModalMode = mode;
  document.querySelectorAll(".goal-mode-btn").forEach((b) => {
    b.classList.toggle("active", b.dataset.goalMode === mode);
  });
  const showApp = mode === "app" || mode === "both";
  const showSite = mode === "site" || mode === "both";
  document.getElementById("goal-field-app-wrap").classList.toggle("hidden", !showApp);
  document.getElementById("goal-field-win-wrap").classList.toggle("hidden", !showApp);
  document.getElementById("goal-field-site-wrap").classList.toggle("hidden", !showSite);
}

function renderGoalDistractionChips() {
  const host = document.getElementById("goal-distraction-chips");
  host.innerHTML = "";
  for (const domain of SUGGESTED_BLOCKED_SITES) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = `goal-chip ${selectedOnboardingDistractions.has(domain) ? "selected" : ""}`;
    btn.textContent = domain;
    btn.addEventListener("click", () => {
      if (selectedOnboardingDistractions.has(domain)) {
        selectedOnboardingDistractions.delete(domain);
      } else {
        selectedOnboardingDistractions.add(domain);
      }
      renderGoalDistractionChips();
    });
    host.appendChild(btn);
  }
}

async function openGoalModal({ onboarding = false, sessionMinutes = null } = {}) {
  goalModalIsOnboarding = Boolean(onboarding);
  pendingSessionMinutes = sessionMinutes;
  const lang = engine.getLang();

  await engine.refreshWindows();

  const existing = engine.state.activeGoal;
  pickedGoalWindow = existing?.windowTitle
    ? {
        id: engine.state.lastWorkWindow?.id || 0,
        processName: existing.app || "",
        title: existing.windowTitle
      }
    : null;
  document.getElementById("goal-input-title").value = existing?.title || "";
  document.getElementById("goal-input-app").value = existing?.app || "";
  document.getElementById("goal-input-site").value = existing?.site || "";
  document.getElementById("goal-form-error").classList.add("hidden");

  const initialMode =
    existing?.targetType === "site" || existing?.targetType === "both" ? existing.targetType : "app";
  setGoalModalMode(initialMode);

  const winSel = document.getElementById("goal-select-window");
  winSel.innerHTML = "";
  const placeholder = document.createElement("option");
  placeholder.value = "";
  placeholder.textContent = t("goal_pick_none", lang);
  winSel.appendChild(placeholder);
  for (const w of engine.openWindows || []) {
    if (isOwnDhirnaWindow(w)) continue;
    const proc = normalizeProcessName(w.processName || "");
    if (!proc) continue;
    const opt = document.createElement("option");
    opt.value = JSON.stringify({ id: w.id || 0, processName: proc, title: w.title || proc });
    opt.textContent = `[${proc}] ${w.title || proc}`;
    winSel.appendChild(opt);
  }

  document.getElementById("goal-modal-eyebrow").classList.toggle("hidden", !goalModalIsOnboarding);
  document.getElementById("goal-distractions-wrap").classList.toggle("hidden", !goalModalIsOnboarding);
  document.getElementById("btn-goal-submit").textContent = t(
    goalModalIsOnboarding ? "goal_btn_confirm" : "goal_btn_save",
    lang
  );

  if (goalModalIsOnboarding) {
    selectedOnboardingDistractions = new Set(
      (engine.state.blacklist || []).length > 0
        ? engine.state.blacklist
        : ["instagram.com", "tiktok.com"]
    );
    renderGoalDistractionChips();
  }

  document.getElementById("goal-modal").classList.remove("hidden");
  document.getElementById("goal-input-title").focus();
}

function renderActiveGoalCard(state, lang) {
  const titleEl = document.getElementById("desk-goal-title");
  const targetEl = document.getElementById("desk-goal-target");
  const btnEl = document.getElementById("btn-open-goal-modal");
  const goal = state.activeGoal;

  if (goal) {
    titleEl.textContent = goal.title || goal.app || goal.site;
    const parts = [];
    if (goal.app) parts.push(goal.app);
    if (goal.site) parts.push(goal.site);
    targetEl.textContent = parts.join(", ") || t("goal_card_label", lang);
    btnEl.textContent = t("goal_btn_edit", lang);
  } else {
    titleEl.textContent = t("goal_none_title", lang);
    targetEl.textContent = t("goal_none_hint", lang);
    btnEl.textContent = t("goal_btn_set", lang);
  }
}

function renderShieldDiagnostic(diag, lang) {
  latestShieldDiag = diag;
  const dnsEl = document.getElementById("diag-dns-val");
  const canaryEl = document.getElementById("diag-canary-val");
  if (!diag || !dnsEl || !canaryEl) return;

  const prov = getShieldProvider(diag.provider);
  dnsEl.classList.remove("ok", "warn");
  if (diag.osDnsConfigured) {
    dnsEl.textContent = t("shield_diag_dns_ok", lang, { provider: prov.name });
    dnsEl.classList.add("ok");
  } else {
    dnsEl.textContent = t("shield_diag_dns_warn", lang);
    dnsEl.classList.add("warn");
  }

  canaryEl.classList.remove("ok", "warn");
  if (diag.canaryBlocked) {
    canaryEl.textContent = `${diag.canaryDomain} (${lang === "en" ? "blocked" : "bloqué"})`;
    canaryEl.classList.add("ok");
  } else {
    canaryEl.textContent = `${diag.canaryDomain} (${diag.details || (lang === "en" ? "unfiltered" : "non filtré")})`;
    canaryEl.classList.add("warn");
  }
}

async function runShieldDiagnostic() {
  if (!engine) return;
  try {
    const diag = await engine.checkShieldDiagnostic();
    renderShieldDiagnostic(diag, engine.getLang());
  } catch {
    // Ignore diagnostic error
  }
}

function renderMobileQrCard(state, lang) {
  const shield = normalizeShieldState(state?.shield);
  const provider = getShieldProvider(shield.provider);
  const isIos = selectedMobileOs === "ios";

  const tabIos = document.getElementById("btn-mobile-tab-ios");
  const tabAndroid = document.getElementById("btn-mobile-tab-android");
  tabIos?.classList.toggle("active", isIos);
  tabIos?.setAttribute("aria-selected", String(isIos));
  tabAndroid?.classList.toggle("active", !isIos);
  tabAndroid?.setAttribute("aria-selected", String(!isIos));

  const qrHost = document.getElementById("shield-mobile-qr");
  const codeEl = document.getElementById("shield-mobile-code");
  const btnCopy = document.getElementById("btn-shield-copy-dot");
  const btnExport = document.getElementById("btn-shield-export-ios");
  const s1 = document.getElementById("shield-step-1");
  const s2 = document.getElementById("shield-step-2");
  const s3 = document.getElementById("shield-step-3");
  const hintEl = document.getElementById("shield-mobile-hint");

  btnCopy?.classList.toggle("hidden", isIos);
  btnExport?.classList.toggle("hidden", !isIos);

  if (isIos) {
    const qrPayload =
      latestMobileQrInfo?.available && latestMobileQrInfo?.url
        ? latestMobileQrInfo.url
        : provider.dohUrl;
    if (qrHost && qrHost.dataset.qrValue !== qrPayload) {
      qrHost.innerHTML = renderQrSvg(qrPayload, { sizePx: 156, ecLevel: "M" });
      qrHost.dataset.qrValue = qrPayload;
    }
    if (codeEl) codeEl.textContent = qrPayload;
    if (s1) s1.textContent = t("shield_ios_s1", lang);
    if (s2) s2.textContent = t("shield_ios_s2", lang);
    if (s3) s3.textContent = t("shield_ios_s3", lang);
    if (hintEl) hintEl.textContent = t("shield_ios_offline_hint", lang);
  } else {
    const dotHost = provider.dotHost;
    if (qrHost && qrHost.dataset.qrValue !== dotHost) {
      qrHost.innerHTML = renderQrSvg(dotHost, { sizePx: 156, ecLevel: "Q" });
      qrHost.dataset.qrValue = dotHost;
    }
    if (codeEl) codeEl.textContent = dotHost;
    if (s1) s1.textContent = t("shield_android_s1", lang);
    if (s2) s2.textContent = t("shield_android_s2", lang);
    if (s3) s3.textContent = t("shield_android_s3", lang);
    if (hintEl) hintEl.textContent = `${provider.name} — DNS-over-TLS`;
  }
}

function renderShieldUI(state, lang) {
  const shield = normalizeShieldState(state.shield);
  const locked = isShieldLocked(shield);

  const pill = document.getElementById("shield-status-pill");
  pill.classList.remove("shield-pill-active", "shield-pill-off");
  if (locked) {
    pill.textContent = t("shield_status_locked", lang, {
      time: formatShieldLockRemaining(shield, lang)
    });
    pill.classList.add("shield-pill-active");
  } else if (shield.enabled) {
    pill.textContent = t("shield_status_active", lang);
    pill.classList.add("shield-pill-active");
  } else {
    pill.textContent = t("shield_status_off", lang);
    pill.classList.add("shield-pill-off");
  }

  const chkEnabled = document.getElementById("shield-toggle-enabled");
  chkEnabled.checked = shield.enabled;
  chkEnabled.disabled = locked;

  const chkSafe = document.getElementById("shield-chk-safesearch");
  chkSafe.checked = shield.safeSearch;
  chkSafe.disabled = locked;

  const chkNoReels = document.getElementById("shield-chk-noreels");
  if (chkNoReels) {
    chkNoReels.checked = shield.noReels !== false;
    chkNoReels.disabled = locked;
  }

  const chkYt = document.getElementById("shield-chk-youtube");
  chkYt.checked = shield.youtubeRestricted;

  const lockDesc = document.getElementById("shield-lock-desc");
  if (locked) {
    lockDesc.textContent = t("shield_lock_active_note", lang, {
      time: formatShieldLockRemaining(shield, lang)
    });
    lockDesc.style.color = "var(--accent)";
  } else {
    lockDesc.textContent = t("shield_lock_desc", lang);
    lockDesc.style.color = "";
  }

  const providersKey = `${shield.provider}|${shield.enabled}|${locked}|${lang}`;
  if (renderCache.shieldProvidersKey !== providersKey) {
    renderCache.shieldProvidersKey = providersKey;
    const grid = document.getElementById("shield-providers-grid");
    grid.innerHTML = "";
    for (const p of Object.values(SHIELD_PROVIDERS)) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = `provider-card ${p.id === shield.provider ? "selected" : ""}`;
      btn.disabled = locked && p.id !== shield.provider;

      const name = document.createElement("div");
      name.className = "provider-name";
      name.textContent = p.name;

      const ips = document.createElement("div");
      ips.className = "provider-ips";
      ips.textContent = p.ipv4.join(" / ");

      const desc = document.createElement("div");
      desc.className = "provider-desc";
      desc.textContent = lang === "en" ? p.descEn : p.descFr;

      btn.appendChild(name);
      btn.appendChild(ips);
      btn.appendChild(desc);

      btn.addEventListener("click", async () => {
        const currentShield = normalizeShieldState(engine.state.shield);
        if (p.id === currentShield.provider) return;
        await withButtonBusy(btn, async () => {
          if (currentShield.enabled) {
            const res = await engine.applyShield({ provider: p.id });
            if (res.ok) {
              if (res.diagnostic) renderShieldDiagnostic(res.diagnostic, engine.getLang());
              showToast("shield-toast", t("shield_toast_on", engine.getLang()));
            }
          } else {
            engine.state.shield = normalizeShieldState({
              ...currentShield,
              provider: p.id,
              updatedAtMs: Date.now()
            });
            await engine.save();
            await engine.syncBridgeShield();
            engine.notifyUI();
          }
          await syncMobileQrServerForView();
        });
      });

      grid.appendChild(btn);
    }
  }

  renderMobileQrCard(state, lang);

  if (latestShieldDiag) {
    renderShieldDiagnostic(latestShieldDiag, lang);
  }
}

function renderSoundsUI(state, lang) {
  const sound = normalizeSoundSettings(state.sound);
  const builtinKey = `${sound.selectedSound}|${lang}`;
  if (renderCache.soundsBuiltinKey !== builtinKey) {
    renderCache.soundsBuiltinKey = builtinKey;
    const grid = document.getElementById("sounds-builtin-grid");
    if (grid) {
      grid.innerHTML = "";
      for (const item of BUILTIN_SOUNDS) {
        const isSelected = sound.selectedSound === item.id;
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = `sound-card ${isSelected ? "selected" : ""}`;
        btn.setAttribute("role", "radio");
        btn.setAttribute("aria-checked", String(isSelected));

        const top = document.createElement("div");
        top.className = "sound-card-top";

        const name = document.createElement("span");
        name.className = "sound-card-name";
        name.textContent = lang === "en" ? item.nameEn : item.nameFr;

        const dot = document.createElement("span");
        dot.className = "sound-radio-dot";
        dot.setAttribute("aria-hidden", "true");

        top.appendChild(name);
        top.appendChild(dot);

        const desc = document.createElement("div");
        desc.className = "sound-card-desc";
        desc.textContent = lang === "en" ? item.descEn : item.descFr;

        btn.appendChild(top);
        btn.appendChild(desc);

        btn.addEventListener("click", async () => {
          const updated = await engine.updateSoundSettings({ selectedSound: item.id });
          playReturnSound(updated);
        });

        grid.appendChild(btn);
      }
    }
  }

  const hasCustom = Boolean(sound.customSoundFile);
  const customWell = document.getElementById("custom-sound-well");
  const customStatus = document.getElementById("custom-sound-status");
  const btnUseCustom = document.getElementById("btn-sound-use-custom");
  const btnRemoveCustom = document.getElementById("btn-sound-remove");

  customWell?.classList.toggle("is-selected", sound.selectedSound === "custom" && hasCustom);
  if (customStatus) {
    customStatus.textContent = hasCustom
      ? t("sounds_custom_active", lang, { name: sound.customSoundName || sound.customSoundFile })
      : t("sounds_custom_none", lang);
  }
  btnUseCustom?.classList.toggle("hidden", !hasCustom || sound.selectedSound === "custom");
  btnRemoveCustom?.classList.toggle("hidden", !hasCustom);

  const slider = document.getElementById("sound-volume-slider");
  const volVal = document.getElementById("sound-volume-val");
  if (slider && document.activeElement !== slider) {
    slider.value = String(sound.volumePct);
  }
  if (volVal) {
    volVal.textContent = `${sound.volumePct} %`;
  }

  const chkMute = document.getElementById("sound-chk-mute");
  if (chkMute) {
    chkMute.checked = Boolean(sound.muted);
  }

  const chkForceUnmute = document.getElementById("sound-chk-force-unmute");
  if (chkForceUnmute) {
    chkForceUnmute.checked = sound.forceUnmuteOnAlarm !== false;
  }
}

function openShieldDisableModal(onConfirm, onCancel) {
  if (shieldDisableInterval) clearInterval(shieldDisableInterval);
  const lang = engine.getLang();
  const phrase = SHIELD_DISABLE_PHRASE[lang] || SHIELD_DISABLE_PHRASE.fr;
  const modal = document.getElementById("shield-disable-modal");
  const timerEl = document.getElementById("shield-disable-timer");
  const phraseLbl = document.getElementById("shield-disable-phrase-lbl");
  const input = document.getElementById("shield-disable-input");
  const btnConfirm = document.getElementById("btn-shield-confirm-off");
  const btnKeep = document.getElementById("btn-shield-keep");

  let remaining = SHIELD_COOLDOWN_SECONDS;
  input.value = "";
  phraseLbl.textContent = t("shield_disable_phrase_label", lang, { phrase });
  timerEl.textContent = t("shield_disable_wait", lang, { sec: remaining });
  btnConfirm.disabled = true;
  modal.classList.remove("hidden");

  const updateConfirmState = () => {
    const matches = input.value.trim().toUpperCase() === phrase.toUpperCase();
    btnConfirm.disabled = remaining > 0 || !matches;
  };

  input.oninput = updateConfirmState;

  const closeModal = () => {
    if (shieldDisableInterval) {
      clearInterval(shieldDisableInterval);
      shieldDisableInterval = null;
    }
    modal.classList.add("hidden");
  };

  btnKeep.onclick = () => {
    closeModal();
    onCancel();
  };

  btnConfirm.onclick = async () => {
    if (btnConfirm.disabled) return;
    closeModal();
    await onConfirm();
  };

  shieldDisableInterval = setInterval(() => {
    remaining -= 1;
    if (remaining <= 0) {
      clearInterval(shieldDisableInterval);
      shieldDisableInterval = null;
      timerEl.textContent = "0 s";
    } else {
      timerEl.textContent = t("shield_disable_wait", lang, { sec: remaining });
    }
    updateConfirmState();
  }, 1000);
}

function renderUsbSensorUi(state, status, lang) {
  const usbEnabled = state.usbReelsEnabled !== false;
  const usbSt = engine?.usbStatus || {};

  const chkUsb = document.getElementById("chk-usb-guard-enabled");
  if (chkUsb) {
    chkUsb.checked = usbEnabled;
    chkUsb.disabled = Boolean(status?.locked);
  }

  const lostBanner = document.getElementById("usb-lost-banner");
  if (lostBanner) {
    const showLost = Boolean(usbEnabled && usbSt.sensorLost);
    lostBanner.textContent = t("usb_banner_lost", lang);
    lostBanner.classList.toggle("hidden", !showLost);
  }

  const btnIosDriver = document.getElementById("btn-install-ios-driver");
  if (btnIosDriver) {
    const needsDriver = Boolean(
      usbEnabled && usbSt.iosHardwarePresent && !usbSt.iosDriverReady
    );
    btnIosDriver.classList.toggle("hidden", !needsDriver);
  }

  const pill = document.getElementById("usb-sensor-pill");
  if (!pill) return;

  if (!usbEnabled) {
    pill.dataset.state = "standby";
    pill.textContent = t("usb_pill_off", lang);
    return;
  }

  if (usbSt.sensorLost) {
    pill.dataset.state = "alarm";
    pill.textContent = t("usb_pill_lost", lang);
    return;
  }

  if (usbSt.activeDistraction) {
    const labelMap = {
      instagram: "Instagram",
      tiktok: "TikTok",
      snapchat: "Snapchat",
      facebook: "Facebook",
      x: "X",
      reddit: "Reddit",
      shorts: "Shorts"
    };
    const appName = labelMap[usbSt.activeDistraction] || usbSt.activeDistraction;
    pill.dataset.state = "alarm";
    pill.textContent = t("usb_pill_alarm", lang, { app: appName });
    return;
  }

  const healthy = Number(usbSt.healthyCount) || 0;
  const untrusted = Number(usbSt.untrustedCount) || 0;
  const devices = Array.isArray(usbSt.devices) ? usbSt.devices : [];

  if (healthy > 0) {
    pill.dataset.state = "ready";
    if (healthy > 1) {
      pill.textContent = t("usb_pill_ready_multi", lang, { count: healthy });
    } else {
      const okDev = devices.find((d) => d.health === "ok");
      pill.textContent = t(
        okDev?.platform === "android" ? "usb_pill_ready_android" : "usb_pill_ready_ios",
        lang
      );
    }
    return;
  }

  if (untrusted > 0) {
    pill.dataset.state = "warn";
    pill.textContent = t("usb_pill_untrusted", lang);
    return;
  }

  pill.dataset.state = "standby";
  pill.textContent = t("usb_pill_standby", lang);
}

function renderUI(state, status, openWindows, lang) {
  if (renderCache.lang !== lang) {
    renderCache.lang = lang;
    applyDomTranslations(document, lang);
  }
  const activeTheme = getActiveTheme();
  const themeKey = `${activeTheme}|${lang}`;
  if (renderCache.themeKey !== themeKey) {
    renderCache.themeKey = themeKey;
    applyTheme(activeTheme, { lang });
  }
  document.getElementById("desk-btn-lang").textContent = lang.toUpperCase();
  const statusPill = document.getElementById("desk-status-pill");
  statusPill.textContent = status.label;
  statusPill.classList.toggle("is-locked", Boolean(status.locked));
  statusPill.classList.toggle("is-active", Boolean(status.active && !status.locked));
  document.getElementById("desk-stats-total").textContent = String(state.stats?.total || 0);

  syncLockWarning(status);
  renderActiveGoalCard(state, lang);
  renderShieldUI(state, lang);
  renderSoundsUI(state, lang);
  renderUsbSensorUi(state, status, lang);

  updateChronometerHud(document.getElementById("studio-chrono-hud"), {
    state,
    status,
    lang,
    selectedMinutes: selectedSessionMinutes
  });
  syncSilenceMode(status, lang);
  const endLbl = document.getElementById("vernier-end-label");
  if (endLbl) {
    endLbl.textContent = `${String(selectedSessionMinutes).padStart(2, "0")}:00`;
  }

  const chkManual = document.getElementById("desk-manual-on");
  chkManual.checked = Boolean(state.manualOn);
  chkManual.disabled = status.locked;

  const chkAuto = document.getElementById("desk-auto-trigger");
  chkAuto.checked = Boolean(state.autoTriggerEnabled);
  chkAuto.disabled = status.locked;

  const chkStrict = document.getElementById("desk-strict-mode");
  chkStrict.checked = Boolean(state.strictMode);
  chkStrict.disabled = status.locked;

  const chkPresence = document.getElementById("chk-presence-enabled");
  if (chkPresence) {
    chkPresence.checked = state.presenceCheckEnabled !== false;
    chkPresence.disabled = status.locked;
  }
  const idleMin = Number(state.presenceIdleMinutes) || 2;
  document.querySelectorAll(".presence-pill-btn[data-presence-min]").forEach((btn) => {
    btn.classList.toggle("active", Number(btn.dataset.presenceMin) === idleMin);
    btn.disabled = status.locked;
  });

  // Populate open windows dropdown (excluding Dhirna itself)
  const select = document.getElementById("select-open-window");
  const filteredWins = (openWindows || []).filter((w) => !isOwnDhirnaWindow(w));
  const windowsKey = filteredWins
    .map((w) => `${w.id || 0}:${w.processName || ""}:${w.title || ""}`)
    .join("\n");
  if (renderCache.windowsKey !== windowsKey && document.activeElement !== select) {
    renderCache.windowsKey = windowsKey;
    const prevVal = select.value;
    select.innerHTML = "";
    for (const w of filteredWins) {
      const opt = document.createElement("option");
      opt.value = JSON.stringify({ id: w.id || 0, processName: w.processName, title: w.title });
      opt.textContent = `[${w.processName || "app"}] ${w.title}`;
      select.appendChild(opt);
    }
    if (prevVal) select.value = prevVal;
  }

  const workAppsKey = `${JSON.stringify(state.workApps)}|${status.locked}`;
  if (renderCache.workAppsKey !== workAppsKey) {
    renderCache.workAppsKey = workAppsKey;
    renderSimpleTags("desk-work-apps-tags", state.workApps, status.locked, async (proc) => {
      engine.state.workApps = engine.state.workApps.filter((p) => p !== proc);
      if (engine.state.activeGoal?.app === proc) {
        engine.state.activeGoal = { ...engine.state.activeGoal, app: "", updatedAtMs: Date.now() };
        await engine.syncBridgeGoal();
      }
      await engine.save();
      engine.notifyUI();
      showToast();
    });
  }

  const workSitesKey = `${JSON.stringify(state.workSites)}|${status.locked}`;
  if (renderCache.workSitesKey !== workSitesKey) {
    renderCache.workSitesKey = workSitesKey;
    renderSimpleTags("desk-work-sites-tags", state.workSites, status.locked, async (site) => {
      engine.state.workSites = engine.state.workSites.filter((s) => s !== site);
      if (engine.state.activeGoal?.site === site) {
        engine.state.activeGoal = { ...engine.state.activeGoal, site: "", updatedAtMs: Date.now() };
        await engine.syncBridgeGoal();
      }
      await engine.save();
      engine.notifyUI();
      showToast();
    });
  }

  const blacklistKey = `${JSON.stringify(state.blacklist)}|${status.locked}`;
  if (renderCache.blacklistKey !== blacklistKey) {
    renderCache.blacklistKey = blacklistKey;
    renderSimpleTags("desk-blacklist-tags", state.blacklist, status.locked, async (site) => {
      engine.state.blacklist = engine.state.blacklist.filter((s) => s !== site);
      await engine.save();
      engine.notifyUI();
      showToast();
    });
  }

  const blockedAppsKey = `${JSON.stringify(state.blockedApps)}|${status.locked}|${lang}`;
  if (renderCache.blockedAppsKey !== blockedAppsKey) {
    renderCache.blockedAppsKey = blockedAppsKey;
    renderBlockedApps(state, status.locked, lang);
  }

  const usbApps = normalizeUsbBlockedApps(state.usbBlockedApps);
  const usbAppsKey = `${JSON.stringify(usbApps)}|${status.locked}`;
  if (renderCache.usbAppsKey !== usbAppsKey) {
    renderCache.usbAppsKey = usbAppsKey;
    const host = document.getElementById("desk-usb-apps-chips");
    if (host) {
      host.innerHTML = "";
      for (const item of USB_SOCIAL_APPS) {
        const selected = usbApps.includes(item.id);
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = `goal-chip ${selected ? "selected" : ""}`;
        btn.disabled = Boolean(status.locked);
        btn.textContent = item.label;
        btn.addEventListener("click", async () => {
          const cur = normalizeUsbBlockedApps(engine.state.usbBlockedApps);
          const next = cur.includes(item.id)
            ? cur.filter((id) => id !== item.id)
            : [...cur, item.id];
          await engine.setUsbBlockedApps(next);
          showToast();
        });
        host.appendChild(btn);
      }
    }
  }

  const sched =
    (Array.isArray(state.schedules) && state.schedules[0]) || {
      id: "default-workdays",
      enabled: false,
      days: [1, 2, 3, 4, 5],
      start: "09:00",
      end: "17:00"
    };
  const schedStartEl = document.getElementById("sched-start");
  const schedEndEl = document.getElementById("sched-end");
  const schedEnabledEl = document.getElementById("sched-enabled");
  schedEnabledEl.disabled = status.locked;
  const scheduleKey = `${JSON.stringify(sched)}|${status.locked}`;
  if (!scheduleDirty && renderCache.scheduleKey !== scheduleKey) {
    renderCache.scheduleKey = scheduleKey;
    schedEnabledEl.checked = Boolean(sched.enabled);
    if (document.activeElement !== schedStartEl) {
      schedStartEl.value = sched.start || "09:00";
    }
    if (document.activeElement !== schedEndEl) {
      schedEndEl.value = sched.end || "17:00";
    }
    document.querySelectorAll(".day-btn").forEach((btn) => {
      const d = Number(btn.dataset.day);
      btn.classList.toggle("selected", Array.isArray(sched.days) && sched.days.includes(d));
      btn.disabled = status.locked;
    });
  } else {
    document.querySelectorAll(".day-btn").forEach((btn) => {
      btn.disabled = status.locked;
    });
  }

  if (activeView === "dashboard" && latestDashboardRaw) {
    const dashKey = `${latestDashboardRaw.generatedAtMs || 0}|${selectedDays}|${lang}|${Boolean(engine?.bridgeStatus?.extensionConnected)}`;
    if (renderCache.dashKey !== dashKey) {
      renderCache.dashKey = dashKey;
      renderDashboard(latestDashboardRaw, lang);
    }
  }
}

async function initDesktopApp() {
  engine = new DhirnaDesktopEngine(renderUI);
  await engine.init();

  // Sidebar view navigation (5 items)
  document.getElementById("nav-tab-session")?.addEventListener("click", () => {
    silenceMenuPeek = false;
    setActiveView("session");
  });
  document.getElementById("nav-tab-shield")?.addEventListener("click", () => {
    setActiveView("shield");
  });
  document.getElementById("nav-tab-sounds")?.addEventListener("click", () => {
    setActiveView("sounds");
  });
  document.getElementById("nav-tab-planner")?.addEventListener("click", () => {
    setActiveView("planner");
  });
  document.getElementById("nav-tab-dashboard")?.addEventListener("click", () => {
    setActiveView("dashboard");
  });

  document.getElementById("btn-toggle-silence")?.addEventListener("click", () => {
    silenceMenuPeek = !silenceMenuPeek;
    syncSilenceMode(engine.getStatus(), engine.getLang());
  });

  // ===================== BOUCLIER (PC + MOBILE QR) =====================
  const chkShield = document.getElementById("shield-toggle-enabled");
  chkShield.addEventListener("change", async () => {
    if (chkShield.checked) {
      const res = await engine.applyShield({ enabled: true });
      if (res.ok) {
        if (res.diagnostic) renderShieldDiagnostic(res.diagnostic, engine.getLang());
        showToast("shield-toast", t("shield_toast_on", engine.getLang()));
      } else {
        chkShield.checked = false;
      }
      return;
    }

    chkShield.checked = true;
    openShieldDisableModal(
      async () => {
        const res = await engine.applyShield({ enabled: false });
        if (res.ok) {
          if (res.diagnostic) renderShieldDiagnostic(res.diagnostic, engine.getLang());
          showToast("shield-toast", t("shield_toast_off", engine.getLang()));
        }
      },
      () => {
        chkShield.checked = true;
      }
    );
  });

  document.getElementById("shield-chk-safesearch").addEventListener("change", async (e) => {
    const val = e.target.checked;
    if (engine.state.shield?.enabled) {
      const res = await engine.applyShield({ safeSearch: val });
      if (!res.ok) e.target.checked = !val;
      else if (res.diagnostic) renderShieldDiagnostic(res.diagnostic, engine.getLang());
    } else {
      engine.state.shield = normalizeShieldState({
        ...engine.state.shield,
        safeSearch: val,
        updatedAtMs: Date.now()
      });
      await engine.save();
      await engine.syncBridgeShield();
    }
  });

  document.getElementById("shield-chk-noreels").addEventListener("change", async (e) => {
    const val = e.target.checked;
    if (engine.state.shield?.enabled) {
      const res = await engine.applyShield({ noReels: val });
      if (!res.ok) e.target.checked = !val;
      else if (res.diagnostic) renderShieldDiagnostic(res.diagnostic, engine.getLang());
    } else {
      engine.state.shield = normalizeShieldState({
        ...engine.state.shield,
        noReels: val,
        updatedAtMs: Date.now()
      });
      await engine.save();
      await engine.syncBridgeShield();
    }
  });

  document.getElementById("shield-chk-youtube").addEventListener("change", async (e) => {
    const val = e.target.checked;
    if (engine.state.shield?.enabled) {
      const res = await engine.applyShield({ youtubeRestricted: val });
      if (!res.ok) e.target.checked = !val;
      else if (res.diagnostic) renderShieldDiagnostic(res.diagnostic, engine.getLang());
    } else {
      engine.state.shield = normalizeShieldState({
        ...engine.state.shield,
        youtubeRestricted: val,
        updatedAtMs: Date.now()
      });
      await engine.save();
      await engine.syncBridgeShield();
    }
  });

  document.querySelectorAll(".btn-shield-lock").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const hours = Number(btn.dataset.hours) || 24;
      const res = await engine.lockShield(hours);
      if (res.ok) {
        if (res.diagnostic) renderShieldDiagnostic(res.diagnostic, engine.getLang());
        showToast("shield-toast", t("shield_toast_locked", engine.getLang()));
      }
    });
  });

  document.getElementById("btn-shield-test").addEventListener("click", (e) => {
    withButtonBusy(e.currentTarget, () => runShieldDiagnostic());
  });

  // Mobile OS Segmented Selector (iOS vs Android)
  document.getElementById("btn-mobile-tab-ios")?.addEventListener("click", async () => {
    if (selectedMobileOs === "ios") return;
    selectedMobileOs = "ios";
    renderMobileQrCard(engine.state, engine.getLang());
    await syncMobileQrServerForView();
  });

  document.getElementById("btn-mobile-tab-android")?.addEventListener("click", async () => {
    if (selectedMobileOs === "android") return;
    selectedMobileOs = "android";
    await syncMobileQrServerForView();
    renderMobileQrCard(engine.state, engine.getLang());
  });

  document.getElementById("btn-shield-copy-dot").addEventListener("click", async () => {
    const host = document.getElementById("shield-mobile-code").textContent.trim();
    const ok = await copyTextReliable(host);
    showToast("shield-toast", ok ? t("shield_copied", engine.getLang()) : host);
  });

  document.getElementById("btn-shield-export-ios").addEventListener("click", async (e) => {
    await withButtonBusy(e.currentTarget, async () => {
      const providerId = engine.state.shield?.provider || "cleanbrowsing";
      const xml = buildIosMobileConfig(providerId);
      await downloadTextFile(
        `dhirna-shield-${providerId}.mobileconfig`,
        xml,
        "application/x-apple-aspen-config",
        "shield-toast"
      );
    });
  });

  // ===================== SONS ("RETOUR AU TRAVAIL") =====================
  const fileInput = document.getElementById("sound-file-input");
  const errEl = document.getElementById("sound-error-msg");

  document.getElementById("btn-sound-import")?.addEventListener("click", () => {
    errEl?.classList.add("hidden");
    fileInput?.click();
  });

  fileInput?.addEventListener("change", async (e) => {
    const file = e.target.files && e.target.files[0];
    fileInput.value = "";
    if (!file) return;
    errEl?.classList.add("hidden");

    const res = await engine.importCustomSound(file);
    if (!res.ok) {
      const msg = res.errorKey ? t(res.errorKey, engine.getLang()) : res.error || "";
      if (errEl) {
        errEl.textContent = msg;
        errEl.classList.remove("hidden");
      }
      return;
    }

    showToast("sound-toast", t("sound_toast_imported", engine.getLang()));
    playReturnSound(res.sound);
  });

  document.getElementById("btn-sound-use-custom")?.addEventListener("click", async () => {
    const updated = await engine.updateSoundSettings({ selectedSound: "custom" });
    playReturnSound(updated);
  });

  document.getElementById("btn-sound-remove")?.addEventListener("click", async () => {
    errEl?.classList.add("hidden");
    await engine.removeCustomSound();
    showToast("sound-toast", t("sound_toast_removed", engine.getLang()));
  });

  const volumeSlider = document.getElementById("sound-volume-slider");
  volumeSlider?.addEventListener("input", () => {
    const val = Number(volumeSlider.value) || 0;
    const lbl = document.getElementById("sound-volume-val");
    if (lbl) lbl.textContent = `${val} %`;
  });
  volumeSlider?.addEventListener("change", async () => {
    await engine.updateSoundSettings({ volumePct: Number(volumeSlider.value) || 0 });
  });

  document.getElementById("sound-chk-mute")?.addEventListener("change", async (e) => {
    await engine.updateSoundSettings({ muted: Boolean(e.target.checked) });
  });

  document.getElementById("sound-chk-force-unmute")?.addEventListener("change", async (e) => {
    await engine.updateSoundSettings({ forceUnmuteOnAlarm: Boolean(e.target.checked) });
  });

  document.getElementById("btn-sound-test")?.addEventListener("click", () => {
    const sound = normalizeSoundSettings(engine.state.sound);
    if (sound.muted) {
      showToast("sound-toast", t("sound_toast_muted", engine.getLang()));
      return;
    }
    playReturnSound(sound);
  });

  // ===================== HISTORIQUE & OBJECTIF =====================
  document.querySelectorAll("#view-dashboard .seg-btn[data-days]").forEach((btn) => {
    btn.addEventListener("click", () => {
      selectedDays = Number(btn.dataset.days) || 7;
      document.querySelectorAll("#view-dashboard .seg-btn[data-days]").forEach((b) => {
        b.classList.toggle("active", b === btn);
      });
      refreshDashboard();
    });
  });

  document.getElementById("btn-open-goal-modal").addEventListener("click", () => {
    openGoalModal({ onboarding: false });
  });

  document.querySelectorAll(".goal-mode-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      setGoalModalMode(btn.dataset.goalMode || "app");
    });
  });

  document.getElementById("goal-select-window").addEventListener("change", (e) => {
    if (!e.target.value) {
      pickedGoalWindow = null;
      return;
    }
    try {
      const picked = JSON.parse(e.target.value);
      pickedGoalWindow = picked;
      if (picked.processName && !isBrowserProcess(picked.processName)) {
        document.getElementById("goal-input-app").value = picked.processName;
      }
      const titleInput = document.getElementById("goal-input-title");
      if (!titleInput.value.trim() && picked.title) {
        titleInput.value = picked.title.slice(0, 60);
      }
    } catch {
      pickedGoalWindow = null;
    }
  });

  document.getElementById("btn-goal-cancel").addEventListener("click", () => {
    pendingSessionMinutes = null;
    document.getElementById("goal-modal").classList.add("hidden");
  });

  document.getElementById("goal-modal-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const title = document.getElementById("goal-input-title").value.trim();
    const rawApp =
      goalModalMode === "app" || goalModalMode === "both"
        ? normalizeProcessName(document.getElementById("goal-input-app").value)
        : "";
    const rawSite =
      goalModalMode === "site" || goalModalMode === "both"
        ? normalizeDomain(document.getElementById("goal-input-site").value)
        : "";

    if (!title && !rawApp && !rawSite) {
      document.getElementById("goal-form-error").classList.remove("hidden");
      return;
    }

    const opts = goalModalIsOnboarding
      ? {
          replaceWorkLists: true,
          blacklist: Array.from(selectedOnboardingDistractions)
        }
      : {};

    const winTitle = pickedGoalWindow?.title || engine.state.activeGoal?.windowTitle || "";
    const saved = await engine.setActiveGoal(
      {
        title,
        app: rawApp,
        site: rawSite,
        windowTitle: winTitle
      },
      opts
    );

    if (saved) {
      if (pickedGoalWindow?.id || rawApp) {
        const winPayload = {
          id: pickedGoalWindow?.id || 0,
          processName: rawApp || pickedGoalWindow?.processName || "",
          title: winTitle || title,
          pid: 0
        };
        engine.state.lastWorkWindow = {
          id: winPayload.id,
          title: winPayload.title,
          processName: winPayload.processName,
          entry: winPayload.processName,
          source: "app"
        };
        await engine.save();
        await tauriInvoke("note_work_window", { win: winPayload }).catch(() => {});
      }
      document.getElementById("goal-modal").classList.add("hidden");
      showToast("dash-toast", t("goal_toast_saved", engine.getLang()));
      if (pendingSessionMinutes) {
        const mins = pendingSessionMinutes;
        pendingSessionMinutes = null;
        await launchFocusSession(mins);
      }
    }
  });

  document.getElementById("btn-dash-refresh").addEventListener("click", () => {
    refreshDashboard();
  });

  document.getElementById("btn-dash-csv").addEventListener("click", async (e) => {
    if (!latestDashboardRaw) return;
    await withButtonBusy(e.currentTarget, async () => {
      const csv = buildCsvExport(latestDashboardRaw, selectedDays, new Date());
      await downloadTextFile(
        `dhirna-focus-${selectedDays}d.csv`,
        csv,
        "text/csv;charset=utf-8",
        "dash-toast"
      );
    });
  });

  document.getElementById("btn-dash-json").addEventListener("click", async (e) => {
    if (!latestDashboardRaw) return;
    await withButtonBusy(e.currentTarget, async () => {
      const json = JSON.stringify(latestDashboardRaw, null, 2);
      await downloadTextFile(
        `dhirna-focus-${selectedDays}d.json`,
        json,
        "application/json;charset=utf-8",
        "dash-toast"
      );
    });
  });

  const resetModal = document.getElementById("reset-modal");
  document.getElementById("btn-dash-reset").addEventListener("click", () => {
    resetModal.classList.remove("hidden");
  });
  document.getElementById("btn-reset-cancel").addEventListener("click", () => {
    resetModal.classList.add("hidden");
  });
  document.getElementById("btn-reset-confirm").addEventListener("click", async () => {
    resetModal.classList.add("hidden");
    await engine.resetAnalytics();
    await refreshDashboard();
    showToast("dash-toast", t("dash_reset_done", engine.getLang()));
  });

  document.getElementById("desk-btn-lang").addEventListener("click", async () => {
    const next = engine.getLang() === "fr" ? "en" : "fr";
    await engine.setLanguage(next);
  });

  // ===================== RÈGLES (PLANNER) =====================
  document.getElementById("btn-refresh-windows").addEventListener("click", async (e) => {
    await withButtonBusy(e.currentTarget, async () => {
      renderCache.windowsKey = null;
      await engine.refreshWindows();
      engine.notifyUI();
    });
  });

  document.getElementById("btn-pick-as-work").addEventListener("click", async () => {
    const sel = document.getElementById("select-open-window").value;
    if (!sel) return;
    const { id, processName, title } = JSON.parse(sel);
    const proc = normalizeProcessName(processName);
    if (!proc) return;
    if (isBrowserProcess(proc)) {
      const msg =
        engine.getLang() === "en"
          ? "Browser window detected: add the website domain under Work sites below."
          : "Fenêtre navigateur détectée : ajoutez plutôt le domaine dans « Sites de travail » ci-dessous.";
      showToast("save-toast", msg);
      return;
    }
    if (!engine.state.workApps.includes(proc)) {
      engine.state.workApps.push(proc);
    }
    engine.state.lastWorkWindow = {
      id: id || 0,
      processName: proc,
      title: title || proc,
      entry: proc,
      source: "app"
    };
    await tauriInvoke("note_work_window", {
      win: { id: id || 0, processName: proc, title: title || proc, pid: 0 }
    }).catch(() => {});

    if (!engine.state.activeGoal?.app) {
      await engine.setActiveGoal({
        ...(engine.state.activeGoal || {}),
        title: engine.state.activeGoal?.title || title || proc,
        app: proc,
        windowTitle: title || ""
      });
    } else {
      await engine.save();
      await engine.syncBridgeGoal();
      await engine.refreshWindows();
      engine.notifyUI();
    }
    showToast();
  });

  document.getElementById("btn-pick-as-block").addEventListener("click", async () => {
    const sel = document.getElementById("select-open-window").value;
    if (!sel) return;
    const { processName } = JSON.parse(sel);
    const proc = normalizeProcessName(processName);
    if (!proc) return;
    if (isBrowserProcess(proc)) {
      const msg =
        engine.getLang() === "en"
          ? "Browser window detected: add the distracting site under Sites to close below."
          : "Fenêtre navigateur détectée : ajoutez plutôt le domaine dans « Sites à fermer » ci-dessous.";
      showToast("save-toast", msg);
      return;
    }
    const exists = engine.state.blockedApps.some(
      (a) => (typeof a === "string" ? a : a.process) === proc
    );
    if (!exists) {
      engine.state.blockedApps.push({ process: proc, label: proc, kill: true });
      await engine.save();
      engine.notifyUI();
      showToast();
    }
  });

  document.getElementById("form-work-app").addEventListener("submit", async (e) => {
    e.preventDefault();
    const input = document.getElementById("input-work-app");
    const proc = normalizeProcessName(input.value);
    if (!proc) return;
    input.value = "";
    if (!engine.state.workApps.includes(proc)) {
      engine.state.workApps.push(proc);
      await engine.save();
      engine.notifyUI();
      showToast();
    }
  });

  document.getElementById("form-work-site").addEventListener("submit", async (e) => {
    e.preventDefault();
    const input = document.getElementById("input-work-site");
    const domain = normalizeDomain(input.value);
    if (!domain) return;
    input.value = "";
    if (!engine.state.workSites.includes(domain)) {
      engine.state.workSites.push(domain);
      await engine.save();
      engine.notifyUI();
      showToast();
    }
  });

  document.getElementById("form-blocked-site").addEventListener("submit", async (e) => {
    e.preventDefault();
    const input = document.getElementById("input-blocked-site");
    const domain = normalizeDomain(input.value);
    if (!domain) return;
    input.value = "";
    if (!engine.state.blacklist.includes(domain)) {
      engine.state.blacklist.push(domain);
      await engine.save();
      engine.notifyUI();
      showToast();
    }
  });

  document.getElementById("form-blocked-app").addEventListener("submit", async (e) => {
    e.preventDefault();
    const input = document.getElementById("input-blocked-app");
    const proc = normalizeProcessName(input.value);
    if (!proc) return;
    input.value = "";
    const exists = engine.state.blockedApps.some(
      (a) => (typeof a === "string" ? a : a.process) === proc
    );
    if (!exists) {
      engine.state.blockedApps.push({ process: proc, label: proc, kill: true });
      await engine.save();
      engine.notifyUI();
      showToast();
    }
  });

  // ===================== SESSION FOCUS =====================
  const launchFocusSession = async (minutes) => {
    const mins = Number(minutes) || selectedSessionMinutes || 25;
    selectedSessionMinutes = mins;
    if (!engine.state.activeGoal) {
      openGoalModal({ onboarding: false, sessionMinutes: mins });
      return;
    }
    silenceMenuPeek = false;
    setActiveView("session");
    await engine.startSession(mins);
    const stageEl = document.getElementById("studio-chrono-hud");
    if (stageEl) {
      stageEl.classList.remove("is-starting");
      void stageEl.offsetWidth;
      stageEl.classList.add("is-starting");
      setTimeout(() => stageEl.classList.remove("is-starting"), 420);
    }
  };

  document.querySelectorAll("[data-select-minutes]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const mins = Number(btn.dataset.selectMinutes) || 25;
      selectedSessionMinutes = mins;
      document.querySelectorAll("[data-select-minutes]").forEach((b) => {
        b.classList.toggle("selected", b === btn);
      });
      const endLbl = document.getElementById("vernier-end-label");
      if (endLbl) endLbl.textContent = `${String(mins).padStart(2, "0")}:00`;
      updateChronometerHud(document.getElementById("studio-chrono-hud"), {
        state: engine.state,
        status: engine.getStatus(),
        lang: engine.getLang(),
        selectedMinutes: selectedSessionMinutes
      });
    });
  });

  document.getElementById("btn-session-start")?.addEventListener("click", () => {
    launchFocusSession(selectedSessionMinutes);
  });

  const chkManual = document.getElementById("desk-manual-on");
  chkManual.addEventListener("change", () => {
    if (chkManual.checked) {
      engine.setManualOn(true);
      return;
    }
    chkManual.checked = true;
    startDisableCountdown(
      () => engine.setManualOn(false),
      () => {
        chkManual.checked = true;
      }
    );
  });

  const chkAuto = document.getElementById("desk-auto-trigger");
  chkAuto.addEventListener("change", () => {
    if (chkAuto.checked) {
      engine.setAutoTrigger(true);
      return;
    }
    chkAuto.checked = true;
    startDisableCountdown(
      () => engine.setAutoTrigger(false),
      () => {
        chkAuto.checked = true;
      }
    );
  });

  const chkStrict = document.getElementById("desk-strict-mode");
  chkStrict.addEventListener("change", async () => {
    const res = await engine.setStrictMode(chkStrict.checked);
    if (!res.ok) {
      chkStrict.checked = !chkStrict.checked;
    } else {
      showToast();
    }
  });

  document.querySelectorAll(".day-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      scheduleDirty = true;
      btn.classList.toggle("selected");
    });
  });
  document.getElementById("sched-start").addEventListener("input", () => {
    scheduleDirty = true;
  });
  document.getElementById("sched-end").addEventListener("input", () => {
    scheduleDirty = true;
  });

  const saveSched = async () => {
    const enabled = document.getElementById("sched-enabled").checked;
    const start = document.getElementById("sched-start").value || "09:00";
    const end = document.getElementById("sched-end").value || "17:00";
    const days = [];
    document.querySelectorAll(".day-btn.selected").forEach((b) => days.push(Number(b.dataset.day)));
    engine.state.schedules = [{ id: "default-workdays", enabled, days, start, end }];
    scheduleDirty = false;
    renderCache.scheduleKey = null;
    await engine.save();
    engine.notifyUI();
    showToast();
  };

  document.getElementById("sched-enabled").addEventListener("change", saveSched);
  document.getElementById("btn-save-schedule").addEventListener("click", saveSched);

  engine.onQuitBlocked = () => {
    const toast = document.getElementById("app-notice-toast");
    const body = document.getElementById("app-notice-toast-body");
    if (toast && body) {
      body.textContent =
        engine.getLang() === "en"
          ? "Protection active: finish your session or disable the shield before quitting Dhirna."
          : "Protection active : terminez votre session ou désactivez le bouclier avant de quitter Dhirna.";
      toast.classList.remove("hidden");
      clearTimeout(noticeToastTimer);
      noticeToastTimer = setTimeout(() => toast.classList.add("hidden"), 5500);
    }
    playReturnSound(engine.state.sound);
  };

  // Dual Theme Engine + Command Palette (Ctrl+K)
  await initTheme({ getLang: () => engine.getLang(), enableBridge: isTauriEnv() });

  initCommandPalette({
    modalEl: document.getElementById("cmdk-modal"),
    triggerEl: document.getElementById("desk-btn-cmdk"),
    getLang: () => engine.getLang(),
    isBlocked: () =>
      !document.getElementById("goal-modal").classList.contains("hidden") ||
      !document.getElementById("reset-modal").classList.contains("hidden") ||
      !document.getElementById("shield-disable-modal").classList.contains("hidden") ||
      !document.getElementById("presence-modal").classList.contains("hidden"),
    shortcuts: {
      1: () => setActiveView("session"),
      2: () => setActiveView("shield"),
      3: () => setActiveView("sounds"),
      4: () => setActiveView("planner"),
      5: () => setActiveView("dashboard"),
      t: () => toggleTheme({ lang: engine.getLang() }),
      g: () => openGoalModal({ onboarding: false })
    },
    getCommands: (lang) => [
      {
        group: t("cmdk_group_nav", lang),
        label: t("nav_session", lang),
        shortcut: "1",
        tone: "accent",
        run: () => setActiveView("session")
      },
      {
        group: t("cmdk_group_nav", lang),
        label: t("shield_nav_label", lang),
        shortcut: "2",
        run: () => setActiveView("shield")
      },
      {
        group: t("cmdk_group_nav", lang),
        label: t("sounds_nav_label", lang),
        shortcut: "3",
        run: () => setActiveView("sounds")
      },
      {
        group: t("cmdk_group_nav", lang),
        label: t("dash_nav_planner", lang),
        shortcut: "4",
        run: () => setActiveView("planner")
      },
      {
        group: t("cmdk_group_nav", lang),
        label: t("dash_nav_label", lang),
        shortcut: "5",
        run: () => setActiveView("dashboard")
      },
      {
        group: t("cmdk_group_session", lang),
        label: t("cmdk_act_s25", lang),
        shortcut: "25m",
        tone: "amber",
        run: () => launchFocusSession(25)
      },
      {
        group: t("cmdk_group_session", lang),
        label: t("cmdk_act_s50", lang),
        shortcut: "50m",
        tone: "amber",
        run: () => launchFocusSession(50)
      },
      {
        group: t("cmdk_group_session", lang),
        label: t("cmdk_act_s90", lang),
        shortcut: "90m",
        tone: "amber",
        run: () => launchFocusSession(90)
      },
      {
        group: t("cmdk_group_tools", lang),
        label: t("cmdk_act_sim", lang),
        run: () => playReturnSound(engine.state.sound)
      },
      {
        group: t("cmdk_group_tools", lang),
        label: t("cmdk_act_theme", lang),
        shortcut: "T",
        tone: "accent",
        run: () => toggleTheme({ lang: engine.getLang() })
      },
      {
        group: t("cmdk_group_tools", lang),
        label: t("cmdk_act_goal", lang),
        shortcut: "G",
        run: () => openGoalModal({ onboarding: false })
      },
      {
        group: t("cmdk_group_tools", lang),
        label: t("cmdk_act_lang", lang),
        run: async () => {
          const next = engine.getLang() === "fr" ? "en" : "fr";
          await engine.setLanguage(next);
        }
      }
    ]
  });

  // Anti-AFK Presence Check Modal
  presenceModalCtrl = initPresenceModal({
    modalEl: document.getElementById("presence-modal"),
    cardEl: document.getElementById("presence-modal-card"),
    statusEl: document.getElementById("presence-status-pill"),
    titleEl: document.getElementById("presence-title"),
    descEl: document.getElementById("presence-desc"),
    barEl: document.getElementById("presence-bar"),
    resumeBtnEl: document.getElementById("btn-presence-resume"),
    getLang: () => engine.getLang(),
    getSoundSettings: () => engine.state.sound,
    onConfirm: () => engine.confirmPresenceResume()
  });

  engine.onPresenceFallback = (payload) => {
    presenceModalCtrl.open({
      idleMinutes: payload?.idleMinutes || engine.state.presenceIdleMinutes || 2,
      alarmDelaySeconds: payload?.alarmDelaySeconds || 30,
      targetLabel:
        payload?.returnTarget?.processName ||
        payload?.returnTarget?.title ||
        engine.state.activeGoal?.title ||
        "Dhirna"
    });
  };

  engine.onPresenceResumed = () => {
    presenceModalCtrl.close();
  };

  document.getElementById("chk-presence-enabled")?.addEventListener("change", async (e) => {
    await engine.setPresenceSettings({ presenceCheckEnabled: e.target.checked });
  });

  const chkUsbGuard = document.getElementById("chk-usb-guard-enabled");
  chkUsbGuard?.addEventListener("change", () => {
    if (chkUsbGuard.checked) {
      engine.setUsbGuardEnabled(true);
      return;
    }
    const st = engine.getStatus();
    if (!st.active) {
      engine.setUsbGuardEnabled(false);
      return;
    }
    chkUsbGuard.checked = true;
    startDisableCountdown(
      () => engine.setUsbGuardEnabled(false),
      () => {
        chkUsbGuard.checked = true;
      }
    );
  });

  document.getElementById("btn-install-ios-driver")?.addEventListener("click", async (e) => {
    await withButtonBusy(e.currentTarget, async () => {
      const res = await engine.installIosUsbDriver();
      if (res.ok) {
        showToast(
          "dash-toast",
          engine.getLang() === "en" ? "iPhone USB driver ready" : "Pilote iPhone USB prêt"
        );
      } else {
        showToast("dash-toast", res.error);
      }
    });
  });

  document.querySelectorAll(".presence-pill-btn[data-presence-min]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      await engine.setPresenceSettings({
        presenceIdleMinutes: Number(btn.dataset.presenceMin) || 2
      });
    });
  });

  document.getElementById("btn-test-presence")?.addEventListener("click", async () => {
    const idleMinutes = Number(engine.state.presenceIdleMinutes) || 2;
    if (isTauriEnv()) {
      await engine.triggerPresencePrompt(idleMinutes * 60_000);
    } else {
      const target = engine.pickReturnTarget();
      presenceModalCtrl.open({
        idleMinutes,
        alarmDelaySeconds: 30,
        targetLabel:
          target?.processName || target?.title || engine.state.activeGoal?.title || "Dhirna"
      });
    }
  });

  window.addEventListener("beforeunload", () => {
    engine.stopMobileQr().catch(() => {});
  });

  // Live 1s Vernier tick during locked session
  setInterval(() => {
    if (!engine?.state) return;
    const lockEnd = Number(engine.state.sessionEndsAt || engine.state.sessionEndTime) || 0;
    if (lockEnd > Date.now()) {
      const st = engine.getStatus ? engine.getStatus() : { locked: true, active: true };
      updateChronometerHud(document.getElementById("studio-chrono-hud"), {
        state: engine.state,
        status: st,
        lang: engine.getLang(),
        selectedMinutes: selectedSessionMinutes
      });
      syncSilenceMode(st, engine.getLang());
    }
  }, 1000);

  // Open directly on calm Focus view (zero blocking anti-porn pact gate)
  setActiveView("session");
  await refreshDashboard();
  setInterval(() => {
    if (activeView === "dashboard" && !document.hidden) {
      refreshDashboard();
    }
  }, 30_000);
}

initDesktopApp();
