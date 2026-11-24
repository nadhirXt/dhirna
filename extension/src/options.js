import { normalizeDomain } from "./lib/domains.js";
import { normalizeProcessName } from "./lib/matcher.js";
import { SUGGESTED_WORK_SITES, SUGGESTED_BLOCKED_SITES } from "./lib/state.js";
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
  runBoomerangMiniPreview,
  initCommandPalette,
  initPresenceModal
} from "./lib/studio-ui.js";

let currentState = null;
let currentStatus = null;
let activeLang = "fr";
let activeView = "dashboard";
let selectedDays = 7;
let latestDashboardRaw = null;
let latestDashboardSource = "extension-local";
let latestShieldDiag = null;
let shieldDisableInterval = null;
let goalModalMode = "site";
let goalModalIsOnboarding = false;
let selectedOnboardingDistractions = new Set(["instagram.com", "tiktok.com"]);
let activeMobileOs = "ios";
let cachedIosQrUrl = null;
let presenceModalCtrl = null;

const DAY_LABELS = {
  fr: { 1: "Lun", 2: "Mar", 3: "Mer", 4: "Jeu", 5: "Ven", 6: "Sam", 0: "Dim" },
  en: { 1: "Mon", 2: "Tue", 3: "Wed", 4: "Thu", 5: "Fri", 6: "Sat", 0: "Sun" }
};

function showToast(id = "save-toast", text = null) {
  const toast = document.getElementById(id);
  if (!toast) return;
  if (text) toast.textContent = text;
  toast.classList.remove("hidden");
  setTimeout(() => toast.classList.add("hidden"), 2200);
}

function downloadTextFile(filename, content, mimeType) {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function setActiveView(viewName) {
  activeView = viewName;
  const isDash = viewName === "dashboard";
  const isPlanner = viewName === "planner";
  const isShield = viewName === "shield";
  document.getElementById("view-dashboard").classList.toggle("hidden", !isDash);
  document.getElementById("view-planner").classList.toggle("hidden", !isPlanner);
  document.getElementById("view-shield").classList.toggle("hidden", !isShield);
  document.getElementById("planner-subnav").classList.toggle("hidden", !isPlanner);
  document.getElementById("nav-tab-dashboard").classList.toggle("active", isDash);
  document.getElementById("nav-tab-planner").classList.toggle("active", isPlanner);
  document.getElementById("nav-tab-shield").classList.toggle("active", isShield);
  if (isDash) {
    refreshDashboard();
  } else if (isShield) {
    runShieldDiagnostic();
    refreshMobileQr();
  }
}

function setGoalModalMode(mode) {
  goalModalMode = mode;
  document.querySelectorAll(".goal-mode-btn").forEach((b) => {
    b.classList.toggle("active", b.dataset.goalMode === mode);
  });
  const showSite = mode === "site" || mode === "both";
  const showApp = mode === "app" || mode === "both";
  document.getElementById("goal-field-tab-wrap").classList.toggle("hidden", !showSite);
  document.getElementById("goal-field-site-wrap").classList.toggle("hidden", !showSite);
  document.getElementById("goal-field-app-wrap").classList.toggle("hidden", !showApp);
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

async function openGoalModal({ onboarding = false } = {}) {
  goalModalIsOnboarding = Boolean(onboarding);

  const existing = currentState?.activeGoal || null;
  document.getElementById("goal-input-title").value = existing?.title || "";
  document.getElementById("goal-input-site").value = existing?.site || "";
  document.getElementById("goal-input-app").value = existing?.app || "";
  document.getElementById("goal-form-error").classList.add("hidden");

  const initialMode =
    existing?.targetType === "app" || existing?.targetType === "both" ? existing.targetType : "site";
  setGoalModalMode(initialMode);

  const tabSel = document.getElementById("goal-select-tab");
  tabSel.innerHTML = "";
  const ph = document.createElement("option");
  ph.value = "";
  ph.textContent = t("goal_pick_none", activeLang);
  tabSel.appendChild(ph);

  try {
    const openRes = await chrome.runtime.sendMessage({ type: "GET_OPEN_TABS" });
    if (openRes?.ok && Array.isArray(openRes.tabs)) {
      for (const tab of openRes.tabs) {
        const opt = document.createElement("option");
        opt.value = JSON.stringify({ domain: tab.domain, title: tab.title });
        opt.textContent = `[${tab.domain}] ${tab.title}`;
        tabSel.appendChild(opt);
      }
    }
  } catch {
    // Ignore tab lookup failure
  }

  document.getElementById("goal-modal-eyebrow").classList.toggle("hidden", !goalModalIsOnboarding);
  document.getElementById("goal-distractions-wrap").classList.toggle("hidden", !goalModalIsOnboarding);
  document.getElementById("btn-goal-cancel").classList.toggle("hidden", false);
  document.getElementById("btn-goal-submit").textContent = t("goal_btn_save", activeLang);

  if (goalModalIsOnboarding) {
    selectedOnboardingDistractions = new Set(
      (currentState?.blacklist || []).length > 0
        ? currentState.blacklist
        : ["instagram.com", "tiktok.com"]
    );
    renderGoalDistractionChips();
  }

  document.getElementById("goal-modal").classList.remove("hidden");
  document.getElementById("goal-input-title").focus();
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
    } catch {
      // default browser site
    }
    tdKind.textContent = t(kindKey, lang);
    tdKind.style.color = "var(--text-secondary)";

    tr.appendChild(tdTime);
    tr.appendChild(tdTarget);
    tr.appendChild(tdKind);
    tbody.appendChild(tr);
  }
}

function renderDashboard(rawData, source, lang) {
  latestDashboardRaw = rawData;
  latestDashboardSource = source || "extension-local";
  const vm = computeDashboardViewModel(rawData, selectedDays, lang, new Date());

  const badge = document.getElementById("ext-sync-badge");
  if (latestDashboardSource === "desktop-sqlite") {
    badge.textContent = t("dash_sync_desktop_ok", lang);
    badge.style.color = "var(--accent)";
  } else {
    badge.textContent = t("dash_sync_ext_only", lang);
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
  try {
    const res = await chrome.runtime.sendMessage({
      type: "GET_EXTENSION_DASHBOARD",
      days: selectedDays
    });
    if (res?.ok && res.data) {
      if (res.lang) activeLang = res.lang;
      renderDashboard(res.data, res.source, activeLang);
    }
  } catch (err) {
    console.error("Extension dashboard load failed:", err);
  }
}

function renderActiveGoalCard(state, lang) {
  const titleEl = document.getElementById("ext-goal-title");
  const targetEl = document.getElementById("ext-goal-target");
  const btnEl = document.getElementById("btn-open-goal-modal");
  const archWork = document.getElementById("arch-work-preview");
  const goal = state.activeGoal;

  if (goal) {
    titleEl.textContent = goal.title || goal.site || goal.app;
    const parts = [];
    if (goal.site) parts.push(goal.site);
    if (goal.app) parts.push(goal.app);
    targetEl.textContent = parts.join(", ") || t("goal_card_label", lang);
    btnEl.textContent = t("goal_btn_edit", lang);
  } else {
    titleEl.textContent = t("goal_none_title", lang);
    targetEl.textContent = t("goal_none_hint", lang);
    btnEl.textContent = t("goal_btn_set", lang);
  }

  if (archWork) {
    const list =
      Array.isArray(state.workSites) && state.workSites.length > 0
        ? state.workSites.slice(0, 2).join(", ")
        : goal?.site || goal?.app || t("goal_none_title", lang);
    archWork.textContent = list;
  }
}

function renderTagList(containerId, list, styleClass, listName, locked) {
  const container = document.getElementById(containerId);
  container.innerHTML = "";

  if (!Array.isArray(list) || list.length === 0) {
    const empty = document.createElement("span");
    empty.style.color = "var(--text-muted)";
    empty.style.fontSize = "12px";
    empty.textContent = t("opt_no_domain", activeLang);
    container.appendChild(empty);
    return;
  }

  for (const domain of list) {
    const el = document.createElement("span");
    el.className = `tag-item ${styleClass}`;
    const txt = document.createElement("span");
    txt.textContent = domain;
    el.appendChild(txt);

    if (!locked) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.textContent = "×";
      btn.addEventListener("click", async () => {
        const res = await chrome.runtime.sendMessage({
          type: "QUICK_REMOVE_DOMAIN",
          listName,
          domain
        });
        if (res?.ok) {
          applyState(res.state, res.status, res.lang);
          showToast();
        }
      });
      el.appendChild(btn);
    }
    container.appendChild(el);
  }
}

function renderSuggestionChips(containerId, suggestions, existingList, listName, locked) {
  const container = document.getElementById(containerId);
  container.innerHTML = "";
  for (const domain of suggestions) {
    if (existingList.includes(domain)) continue;
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "sug-chip";
    btn.textContent = `+ ${domain}`;
    btn.disabled = locked;
    btn.addEventListener("click", async () => {
      const res = await chrome.runtime.sendMessage({
        type: "QUICK_ADD_DOMAIN",
        listName,
        domain
      });
      if (res?.ok) {
        applyState(res.state, res.status, res.lang);
        showToast();
      }
    });
    container.appendChild(btn);
  }
}

function renderShieldDiagnostic(diag, lang) {
  latestShieldDiag = diag;
  const dnsEl = document.getElementById("diag-dns-val");
  const incEl = document.getElementById("diag-incognito-val");
  const incBtn = document.getElementById("btn-diag-incognito");
  if (!diag || !dnsEl || !incEl) return;

  dnsEl.classList.remove("ok", "warn");
  if (diag.desktopConnected && diag.desktopDiagnostic) {
    const prov = getShieldProvider(diag.desktopDiagnostic.provider);
    if (diag.desktopDiagnostic.osDnsConfigured && diag.desktopDiagnostic.canaryBlocked) {
      dnsEl.textContent = t("shield_diag_dns_ok", lang, { provider: prov.name });
      dnsEl.classList.add("ok");
    } else {
      dnsEl.textContent = diag.desktopDiagnostic.details || t("shield_diag_dns_warn", lang);
      dnsEl.classList.add("warn");
    }
  } else {
    dnsEl.textContent = t("shield_diag_dns_ext_note", lang);
  }

  incEl.classList.remove("ok", "warn");
  if (diag.incognitoAllowed) {
    incEl.textContent = t("shield_diag_incognito_ok", lang);
    incEl.classList.add("ok");
    incBtn.classList.add("hidden");
  } else {
    incEl.textContent = t("shield_diag_incognito_warn", lang);
    incEl.classList.add("warn");
    incBtn.classList.remove("hidden");
  }
}

async function runShieldDiagnostic() {
  try {
    const res = await chrome.runtime.sendMessage({ type: "CHECK_SHIELD_DIAGNOSTIC" });
    if (res?.ok) {
      renderShieldDiagnostic(res, activeLang);
    }
  } catch {
    // Ignore
  }
}

async function refreshMobileQr() {
  const provider = getShieldProvider(currentState?.shield?.provider || "cleanbrowsing");
  const qrHost = document.getElementById("ext-mobile-qr");
  const iosPanel = document.getElementById("ext-mobile-ios-panel");
  const androidPanel = document.getElementById("ext-mobile-android-panel");
  if (!qrHost || !iosPanel || !androidPanel) return;

  document.getElementById("ext-mob-tab-ios")?.classList.toggle("active", activeMobileOs === "ios");
  document
    .getElementById("ext-mob-tab-android")
    ?.classList.toggle("active", activeMobileOs === "android");
  iosPanel.classList.toggle("hidden", activeMobileOs !== "ios");
  androidPanel.classList.toggle("hidden", activeMobileOs !== "android");

  const hostEl = document.getElementById("shield-android-host");
  if (hostEl) hostEl.textContent = provider.dotHost;

  if (activeMobileOs === "android") {
    if (qrHost.dataset.qrValue !== provider.dotHost) {
      qrHost.innerHTML = renderQrSvg(provider.dotHost, { sizePx: 148, ecLevel: "Q" });
      qrHost.dataset.qrValue = provider.dotHost;
    }
    return;
  }

  try {
    const res = await chrome.runtime.sendMessage({
      type: "GET_MOBILE_QR_URL",
      provider: provider.id
    });
    cachedIosQrUrl = res?.iosUrl || provider.dohUrl;
  } catch {
    cachedIosQrUrl = provider.dohUrl;
  }

  if (qrHost.dataset.qrValue !== cachedIosQrUrl) {
    qrHost.innerHTML = renderQrSvg(cachedIosQrUrl, { sizePx: 148, ecLevel: "Q" });
    qrHost.dataset.qrValue = cachedIosQrUrl;
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
    ips.textContent = p.ipv4.join(" · ");

    const desc = document.createElement("div");
    desc.className = "provider-desc";
    desc.textContent = lang === "en" ? p.descEn : p.descFr;

    btn.appendChild(name);
    btn.appendChild(ips);
    btn.appendChild(desc);

    btn.addEventListener("click", async () => {
      if (p.id === shield.provider) return;
      const r = await chrome.runtime.sendMessage({
        type: "UPDATE_SHIELD",
        shield: { provider: p.id }
      });
      if (r?.ok) {
        applyState(r.state, r.status, r.lang);
        refreshMobileQr();
        showToast("shield-toast", t("opt_saved_toast", activeLang));
      }
    });

    grid.appendChild(btn);
  }

  refreshMobileQr();

  if (latestShieldDiag) {
    renderShieldDiagnostic(latestShieldDiag, lang);
  }
}

function openShieldDisableModal(onConfirm, onCancel) {
  if (shieldDisableInterval) clearInterval(shieldDisableInterval);
  const phrase = SHIELD_DISABLE_PHRASE[activeLang] || SHIELD_DISABLE_PHRASE.fr;
  const modal = document.getElementById("shield-disable-modal");
  const timerEl = document.getElementById("shield-disable-timer");
  const phraseLbl = document.getElementById("shield-disable-phrase-lbl");
  const input = document.getElementById("shield-disable-input");
  const btnConfirm = document.getElementById("btn-shield-confirm-off");
  const btnKeep = document.getElementById("btn-shield-keep");

  let remaining = SHIELD_COOLDOWN_SECONDS;
  input.value = "";
  phraseLbl.textContent = t("shield_disable_phrase_label", activeLang, { phrase });
  timerEl.textContent = t("shield_disable_wait", activeLang, { sec: remaining });
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
      timerEl.textContent = t("shield_disable_wait", activeLang, { sec: remaining });
    }
    updateConfirmState();
  }, 1000);
}

function applyState(state, status, lang = activeLang) {
  currentState = state;
  currentStatus = status;
  if (lang) activeLang = lang;

  applyDomTranslations(document, activeLang);
  applyTheme(getActiveTheme(), { lang: activeLang });
  const langBtn = document.getElementById("opt-btn-lang");
  if (langBtn) {
    langBtn.textContent = activeLang.toUpperCase();
  }

  const dayMap = DAY_LABELS[activeLang] || DAY_LABELS.fr;
  document.querySelectorAll(".day-btn").forEach((btn) => {
    const d = Number(btn.dataset.day);
    if (dayMap[d]) btn.textContent = dayMap[d];
  });

  const statusPill = document.getElementById("opt-status-pill");
  statusPill.textContent = status.label;
  statusPill.classList.toggle("is-locked", Boolean(status.locked));
  statusPill.classList.toggle("is-active", Boolean(status.active && !status.locked));
  document.getElementById("lock-warning").classList.toggle("hidden", !status.locked);

  renderActiveGoalCard(state, activeLang);
  renderShieldUI(state, activeLang);
  updateChronometerHud(document.getElementById("studio-chrono-hud"), {
    state,
    status,
    lang: activeLang
  });

  const chkAuto = document.getElementById("opt-auto-trigger");
  chkAuto.checked = Boolean(state.autoTriggerEnabled);
  chkAuto.disabled = status.locked;

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

  const radioBlack = document.getElementById("mode-blacklist");
  const radioWhite = document.getElementById("mode-whitelist");
  radioBlack.checked = state.mode !== "whitelist";
  radioWhite.checked = state.mode === "whitelist";
  radioBlack.disabled = status.locked;
  radioWhite.disabled = status.locked;

  document
    .getElementById("panel-blacklist")
    .classList.toggle("hidden", state.mode === "whitelist");
  document
    .getElementById("panel-whitelist")
    .classList.toggle("hidden", state.mode !== "whitelist");

  renderTagList("opt-work-tags", state.workSites, "work", "workSites", status.locked);
  renderSuggestionChips(
    "work-suggestions",
    SUGGESTED_WORK_SITES,
    state.workSites || [],
    "workSites",
    status.locked
  );

  renderTagList("opt-blacklist-tags", state.blacklist, "block", "blacklist", status.locked);
  renderSuggestionChips(
    "block-suggestions",
    SUGGESTED_BLOCKED_SITES,
    state.blacklist || [],
    "blacklist",
    status.locked
  );

  renderTagList("opt-whitelist-tags", state.whitelist, "work", "whitelist", status.locked);

  const sched =
    (Array.isArray(state.schedules) && state.schedules[0]) || {
      id: "default-workdays",
      enabled: false,
      days: [1, 2, 3, 4, 5],
      start: "09:00",
      end: "17:00"
    };

  const schedEnabled = document.getElementById("sched-enabled");
  schedEnabled.checked = Boolean(sched.enabled);
  schedEnabled.disabled = status.locked;

  document.getElementById("sched-start").value = sched.start || "09:00";
  document.getElementById("sched-end").value = sched.end || "17:00";

  document.querySelectorAll(".day-btn").forEach((btn) => {
    const dayNum = Number(btn.dataset.day);
    btn.classList.toggle("selected", Array.isArray(sched.days) && sched.days.includes(dayNum));
    btn.disabled = status.locked;
  });

  if (activeView === "dashboard" && latestDashboardRaw) {
    renderDashboard(latestDashboardRaw, latestDashboardSource, activeLang);
  }
}

async function saveSchedule() {
  if (!currentState || currentStatus?.locked) return;
  const enabled = document.getElementById("sched-enabled").checked;
  const start = document.getElementById("sched-start").value || "09:00";
  const end = document.getElementById("sched-end").value || "17:00";
  const days = [];
  document.querySelectorAll(".day-btn.selected").forEach((btn) => {
    days.push(Number(btn.dataset.day));
  });

  const schedules = [
    {
      id: "default-workdays",
      enabled,
      days,
      start,
      end
    }
  ];

  const res = await chrome.runtime.sendMessage({
    type: "UPDATE_PLAN",
    schedules
  });
  if (res?.ok) {
    applyState(res.state, res.status, res.lang);
    showToast();
  }
}

async function initOptions() {
  const res = await chrome.runtime.sendMessage({ type: "GET_STATUS" });
  if (res?.ok) {
    applyState(res.state, res.status, res.lang);
  }

  document.getElementById("nav-tab-dashboard").addEventListener("click", () => {
    setActiveView("dashboard");
  });
  document.getElementById("nav-tab-planner").addEventListener("click", () => {
    setActiveView("planner");
  });
  document.getElementById("nav-tab-shield").addEventListener("click", () => {
    setActiveView("shield");
  });

  document.querySelectorAll("[data-mobile-os]").forEach((btn) => {
    btn.addEventListener("click", () => {
      activeMobileOs = btn.dataset.mobileOs === "android" ? "android" : "ios";
      refreshMobileQr();
    });
  });

  const chkShield = document.getElementById("shield-toggle-enabled");
  chkShield.addEventListener("change", async () => {
    if (chkShield.checked) {
      const r = await chrome.runtime.sendMessage({
        type: "UPDATE_SHIELD",
        shield: { enabled: true }
      });
      if (r?.ok) {
        applyState(r.state, r.status, r.lang);
        showToast("shield-toast", t("shield_toast_on", activeLang));
        await runShieldDiagnostic();
      } else {
        chkShield.checked = false;
      }
      return;
    }

    chkShield.checked = true;
    openShieldDisableModal(
      async () => {
        const r = await chrome.runtime.sendMessage({
          type: "UPDATE_SHIELD",
          shield: { enabled: false }
        });
        if (r?.ok) {
          applyState(r.state, r.status, r.lang);
          showToast("shield-toast", t("shield_toast_off", activeLang));
          await runShieldDiagnostic();
        }
      },
      () => {
        chkShield.checked = true;
      }
    );
  });

  document.getElementById("shield-chk-safesearch").addEventListener("change", async (e) => {
    const r = await chrome.runtime.sendMessage({
      type: "UPDATE_SHIELD",
      shield: { safeSearch: e.target.checked }
    });
    if (r?.ok) {
      applyState(r.state, r.status, r.lang);
      showToast("shield-toast", t("opt_saved_toast", activeLang));
    } else {
      e.target.checked = !e.target.checked;
    }
  });

  document.getElementById("shield-chk-noreels").addEventListener("change", async (e) => {
    const r = await chrome.runtime.sendMessage({
      type: "UPDATE_SHIELD",
      shield: { noReels: e.target.checked }
    });
    if (r?.ok) {
      applyState(r.state, r.status, r.lang);
      showToast("shield-toast", t("opt_saved_toast", activeLang));
    } else {
      e.target.checked = !e.target.checked;
    }
  });

  document.getElementById("shield-chk-youtube").addEventListener("change", async (e) => {
    const r = await chrome.runtime.sendMessage({
      type: "UPDATE_SHIELD",
      shield: { youtubeRestricted: e.target.checked }
    });
    if (r?.ok) {
      applyState(r.state, r.status, r.lang);
      showToast("shield-toast", t("opt_saved_toast", activeLang));
    } else {
      e.target.checked = !e.target.checked;
    }
  });

  document.querySelectorAll(".btn-shield-lock").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const hours = Number(btn.dataset.hours) || 24;
      const r = await chrome.runtime.sendMessage({
        type: "LOCK_SHIELD",
        hours
      });
      if (r?.ok) {
        applyState(r.state, r.status, r.lang);
        showToast("shield-toast", t("shield_toast_locked", activeLang));
      }
    });
  });

  document.getElementById("btn-shield-test").addEventListener("click", () => {
    runShieldDiagnostic();
  });

  document.getElementById("btn-diag-incognito").addEventListener("click", () => {
    const extId = latestShieldDiag?.extensionId || chrome.runtime.id;
    chrome.tabs.create({ url: `chrome://extensions/?id=${extId}` });
  });

  document.getElementById("btn-diag-doh").addEventListener("click", () => {
    chrome.tabs.create({ url: "chrome://settings/security" });
  });

  document.getElementById("btn-shield-copy-dot").addEventListener("click", async () => {
    const host = document.getElementById("shield-android-host").textContent.trim();
    try {
      await navigator.clipboard.writeText(host);
    } catch {
      // Ignore
    }
    showToast("shield-toast", t("shield_copied", activeLang));
  });

  document.getElementById("btn-shield-download-ios").addEventListener("click", () => {
    const providerId = currentState?.shield?.provider || "cleanbrowsing";
    const xml = buildIosMobileConfig(providerId);
    downloadTextFile(
      `dhirna-shield-${providerId}.mobileconfig`,
      xml,
      "application/x-apple-aspen-config"
    );
  });

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
      setGoalModalMode(btn.dataset.goalMode || "site");
    });
  });

  document.getElementById("goal-select-tab").addEventListener("change", (e) => {
    if (!e.target.value) return;
    try {
      const picked = JSON.parse(e.target.value);
      if (picked.domain) {
        document.getElementById("goal-input-site").value = picked.domain;
      }
      const titleInput = document.getElementById("goal-input-title");
      if (!titleInput.value.trim() && picked.title) {
        titleInput.value = picked.title.slice(0, 60);
      }
    } catch {
      // Ignore
    }
  });

  document.getElementById("btn-goal-cancel").addEventListener("click", () => {
    document.getElementById("goal-modal").classList.add("hidden");
  });

  document.getElementById("goal-modal-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const title = document.getElementById("goal-input-title").value.trim();
    const site =
      goalModalMode === "site" || goalModalMode === "both"
        ? normalizeDomain(document.getElementById("goal-input-site").value)
        : "";
    const app =
      goalModalMode === "app" || goalModalMode === "both"
        ? normalizeProcessName(document.getElementById("goal-input-app").value)
        : "";

    if (!title && !site && !app) {
      document.getElementById("goal-form-error").classList.remove("hidden");
      return;
    }

    const r = await chrome.runtime.sendMessage({
      type: "SET_ACTIVE_GOAL",
      goal: { title, site, app },
      replaceWorkLists: goalModalIsOnboarding,
      blacklist: goalModalIsOnboarding ? Array.from(selectedOnboardingDistractions) : undefined
    });

    if (r?.ok) {
      applyState(r.state, r.status, r.lang);
      document.getElementById("goal-modal").classList.add("hidden");
      showToast("dash-toast", t("goal_toast_saved", activeLang));
      await refreshDashboard();
    }
  });

  document.getElementById("btn-dash-refresh").addEventListener("click", () => {
    refreshDashboard();
  });

  document.getElementById("btn-dash-csv").addEventListener("click", () => {
    if (!latestDashboardRaw) return;
    const csv = buildCsvExport(latestDashboardRaw, selectedDays, new Date());
    downloadTextFile(`dhirna-focus-${selectedDays}d.csv`, csv, "text/csv;charset=utf-8");
  });

  document.getElementById("btn-dash-json").addEventListener("click", () => {
    if (!latestDashboardRaw) return;
    const json = JSON.stringify(latestDashboardRaw, null, 2);
    downloadTextFile(`dhirna-focus-${selectedDays}d.json`, json, "application/json;charset=utf-8");
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
    await chrome.runtime.sendMessage({ type: "RESET_EXTENSION_DASHBOARD" });
    await refreshDashboard();
    const st = await chrome.runtime.sendMessage({ type: "GET_STATUS" });
    if (st?.ok) applyState(st.state, st.status, st.lang);
    showToast("dash-toast", t("dash_reset_done", activeLang));
  });

  document.getElementById("opt-btn-lang").addEventListener("click", async () => {
    const nextLang = activeLang === "fr" ? "en" : "fr";
    const r = await chrome.runtime.sendMessage({
      type: "SET_LANGUAGE",
      language: nextLang
    });
    if (r?.ok) {
      applyState(r.state, r.status, r.lang);
    }
  });

  document.getElementById("opt-auto-trigger").addEventListener("change", async (e) => {
    const r = await chrome.runtime.sendMessage({
      type: "SET_AUTO_TRIGGER",
      autoTriggerEnabled: e.target.checked
    });
    if (r?.ok) {
      applyState(r.state, r.status, r.lang);
      showToast();
    }
  });

  document.querySelectorAll('input[name="mode"]').forEach((radio) => {
    radio.addEventListener("change", async (e) => {
      const r = await chrome.runtime.sendMessage({
        type: "UPDATE_PLAN",
        mode: e.target.value
      });
      if (r?.ok) {
        applyState(r.state, r.status, r.lang);
        showToast();
      }
    });
  });

  const bindAddForm = (formId, inputId, listName) => {
    document.getElementById(formId).addEventListener("submit", async (e) => {
      e.preventDefault();
      const input = document.getElementById(inputId);
      const domain = normalizeDomain(input.value);
      if (!domain) return;
      input.value = "";
      const r = await chrome.runtime.sendMessage({
        type: "QUICK_ADD_DOMAIN",
        listName,
        domain
      });
      if (r?.ok) {
        applyState(r.state, r.status, r.lang);
        showToast();
      }
    });
  };

  bindAddForm("opt-form-work", "opt-input-work", "workSites");
  bindAddForm("opt-form-blacklist", "opt-input-blacklist", "blacklist");
  bindAddForm("opt-form-whitelist", "opt-input-whitelist", "whitelist");

  document.querySelectorAll(".day-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      btn.classList.toggle("selected");
    });
  });

  document.getElementById("sched-enabled").addEventListener("change", saveSchedule);
  document.getElementById("btn-save-schedule").addEventListener("click", saveSchedule);

  const startExtSession = async (minutes) => {
    const mins = Number(minutes) || 25;
    if (!currentState?.activeGoal) {
      await openGoalModal({ onboarding: false });
      return;
    }
    try {
      const r = await chrome.runtime.sendMessage({
        type: "START_SESSION",
        minutes: mins
      });
      if (r?.ok) {
        applyState(r.state, r.status, r.lang);
        showToast("dash-toast", r.status?.label || `${mins}m`);
      }
    } catch {
      // Ignore outside extension runtime
    }
  };

  document.querySelectorAll("[data-hud-minutes]").forEach((btn) => {
    btn.addEventListener("click", () => {
      startExtSession(btn.dataset.hudMinutes);
    });
  });

  document.getElementById("btn-hud-sim-boom")?.addEventListener("click", () => {
    runBoomerangMiniPreview(document.getElementById("studio-chrono-hud"), {
      lang: activeLang
    });
  });

  presenceModalCtrl = initPresenceModal({
    modalEl: document.getElementById("presence-modal"),
    cardEl: document.getElementById("presence-modal-card"),
    statusEl: document.getElementById("presence-status-pill"),
    titleEl: document.getElementById("presence-title"),
    descEl: document.getElementById("presence-desc"),
    barEl: document.getElementById("presence-bar"),
    resumeBtnEl: document.getElementById("btn-presence-resume"),
    getLang: () => activeLang,
    getSoundSettings: () => currentState?.sound || null,
    onConfirm: () => showToast("dash-toast", t("presence_btn_resume", activeLang))
  });

  document.getElementById("chk-presence-enabled")?.addEventListener("change", async (e) => {
    const r = await chrome.runtime.sendMessage({
      type: "SET_PRESENCE_SETTINGS",
      presenceCheckEnabled: e.target.checked
    });
    if (r?.ok) applyState(r.state, r.status, r.lang);
  });

  document.querySelectorAll(".presence-pill-btn[data-presence-min]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const r = await chrome.runtime.sendMessage({
        type: "SET_PRESENCE_SETTINGS",
        presenceIdleMinutes: Number(btn.dataset.presenceMin) || 2
      });
      if (r?.ok) applyState(r.state, r.status, r.lang);
    });
  });

  document.getElementById("btn-test-presence")?.addEventListener("click", () => {
    presenceModalCtrl.open({
      idleMinutes: Number(currentState?.presenceIdleMinutes) || 2,
      alarmDelaySeconds: 30,
      targetLabel:
        currentState?.activeGoal?.site ||
        currentState?.activeGoal?.app ||
        currentState?.activeGoal?.title ||
        "Dhirna"
    });
  });

  await initTheme({ getLang: () => activeLang, enableBridge: true });

  initCommandPalette({
    modalEl: document.getElementById("cmdk-modal"),
    triggerEl: document.getElementById("opt-btn-cmdk"),
    getLang: () => activeLang,
    isBlocked: () =>
      !document.getElementById("goal-modal").classList.contains("hidden") ||
      !document.getElementById("reset-modal").classList.contains("hidden") ||
      !document.getElementById("presence-modal").classList.contains("hidden"),
    shortcuts: {
      1: () => setActiveView("dashboard"),
      2: () => setActiveView("planner"),
      3: () => setActiveView("shield"),
      t: () => toggleTheme({ lang: activeLang }),
      g: () => openGoalModal({ onboarding: false })
    },
    getCommands: (lang) => [
      {
        group: t("cmdk_group_nav", lang),
        label: t("dash_nav_label", lang),
        shortcut: "1",
        tone: "accent",
        run: () => setActiveView("dashboard")
      },
      {
        group: t("cmdk_group_nav", lang),
        label: t("dash_nav_planner", lang),
        shortcut: "2",
        run: () => setActiveView("planner")
      },
      {
        group: t("cmdk_group_nav", lang),
        label: t("shield_nav_label", lang),
        shortcut: "3",
        run: () => setActiveView("shield")
      },
      {
        group: t("cmdk_group_session", lang),
        label: t("cmdk_act_s25", lang),
        shortcut: "25m",
        tone: "amber",
        run: () => startExtSession(25)
      },
      {
        group: t("cmdk_group_session", lang),
        label: t("cmdk_act_s50", lang),
        shortcut: "50m",
        tone: "amber",
        run: () => startExtSession(50)
      },
      {
        group: t("cmdk_group_session", lang),
        label: t("cmdk_act_s90", lang),
        shortcut: "90m",
        tone: "amber",
        run: () => startExtSession(90)
      },
      {
        group: t("cmdk_group_tools", lang),
        label: t("cmdk_act_theme", lang),
        shortcut: "T",
        tone: "accent",
        run: () => toggleTheme({ lang: activeLang })
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
          const nextLang = activeLang === "fr" ? "en" : "fr";
          const r = await chrome.runtime.sendMessage({
            type: "SET_LANGUAGE",
            language: nextLang
          });
          if (r?.ok) applyState(r.state, r.status, r.lang);
        }
      }
    ]
  });

  setInterval(() => {
    const lockEnd = Number(currentState?.sessionEndsAt || currentState?.sessionEndTime) || 0;
    if (lockEnd > Date.now()) {
      updateChronometerHud(document.getElementById("studio-chrono-hud"), {
        state: currentState,
        status: currentStatus || { locked: true, active: true },
        lang: activeLang
      });
    }
  }, 1000);

  if (window.location.hash === "#planner") {
    setActiveView("planner");
  } else if (window.location.hash === "#shield") {
    setActiveView("shield");
  } else {
    setActiveView("dashboard");
  }

  if (window.location.hash === "#goal") {
    await openGoalModal({ onboarding: false });
  }
}

initOptions();
