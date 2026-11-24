/**
 * Dhirna — Vernier Time Instrument & Studio Controls
 * Shared between Desktop (desktop/ui/) and Browser Extension (extension/src/options).
 * Zero dependencies, 100% offline.
 */

import { t } from "./i18n.js";
import { playReminderChime, startPresenceAlarm, stopPresenceAlarm } from "./alarm.js";

function formatMmSs(ms) {
  const totalSec = Math.max(0, Math.ceil(ms / 1000));
  const mins = Math.floor(totalSec / 60);
  const secs = totalSec % 60;
  return `${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
}

/**
 * Populates the 25 graduations + sliding progress fill & vertical needle on a horizontal Vernier track.
 */
export function buildVernierTrack(trackEl) {
  if (!trackEl || trackEl.dataset.vernierBuilt === "1") return;
  trackEl.dataset.vernierBuilt = "1";
  trackEl.innerHTML = "";

  for (let i = 0; i <= 24; i += 1) {
    const tick = document.createElement("span");
    tick.className = i % 6 === 0 ? "vernier-tick major" : "vernier-tick";
    trackEl.appendChild(tick);
  }

  const fill = document.createElement("div");
  fill.className = "vernier-fill";
  fill.dataset.role = "vernier-fill";
  trackEl.appendChild(fill);

  const needle = document.createElement("div");
  needle.className = "vernier-needle";
  needle.dataset.role = "vernier-needle";
  trackEl.appendChild(needle);
}

/**
 * Backward-compatible mount helper for Extension Options (`[data-chrono-dial]`),
 * rendering the same horizontal Vernier time ruler instead of a generic Pomodoro circle.
 */
export function buildChronometerDial(mountEl) {
  if (!mountEl || mountEl.dataset.dialBuilt === "1") return;
  mountEl.dataset.dialBuilt = "1";

  const track = document.createElement("div");
  track.className = "vernier-track";
  track.dataset.vernierTrack = "1";
  track.setAttribute("aria-hidden", "true");
  buildVernierTrack(track);
  mountEl.appendChild(track);
}

/**
 * Updates the Vernier Session Instrument cleanly from live Dhirna state & status.
 */
export function updateChronometerHud(hudEl, { state, status, lang = "fr", selectedMinutes = 25 }) {
  if (!hudEl || !state) return;

  const explicitTrack = hudEl.querySelector("[data-vernier-track]");
  if (explicitTrack) {
    buildVernierTrack(explicitTrack);
  }
  const dialWrap = hudEl.querySelector("[data-chrono-dial]");
  if (dialWrap) {
    buildChronometerDial(dialWrap);
  }

  const now = Date.now();
  const lockEnd = Number(state.sessionEndsAt || state.sessionEndTime) || 0;
  const remainingMs = Math.max(0, lockEnd - now);
  const isSessionLocked = Boolean(status?.locked && remainingMs > 0);
  const isActive = Boolean(status?.active);
  const isCompletedFree = Boolean(!isSessionLocked && state.sessionCompletedFree);

  hudEl.classList.remove("state-locked", "state-active", "state-idle");
  hudEl.classList.add(
    isSessionLocked ? "state-locked" : isActive ? "state-active" : "state-idle"
  );

  let elapsedPct = 0;
  if (isSessionLocked) {
    const inferredTotalMs =
      remainingMs > 50 * 60_000
        ? 90 * 60_000
        : remainingMs > 25 * 60_000
          ? 50 * 60_000
          : 25 * 60_000;
    const elapsedRatio = 1 - Math.min(1, Math.max(0, remainingMs / inferredTotalMs));
    elapsedPct = Math.round(Math.min(100, Math.max(2, elapsedRatio * 100)) * 10) / 10;
  } else if (isCompletedFree) {
    elapsedPct = 100;
  } else if (isActive) {
    elapsedPct = 100;
  }

  const fillEl = hudEl.querySelector('[data-role="vernier-fill"]');
  const needleEl = hudEl.querySelector('[data-role="vernier-needle"]');
  if (fillEl) fillEl.style.width = `${elapsedPct}%`;
  if (needleEl) needleEl.style.left = `${elapsedPct}%`;

  const readoutEl = hudEl.querySelector("[data-chrono-readout]");
  if (readoutEl) {
    const mins = Number(selectedMinutes) || 25;
    readoutEl.textContent = isSessionLocked
      ? formatMmSs(remainingMs)
      : isCompletedFree
        ? "00:00"
        : `${String(mins).padStart(2, "0")}:00`;
  }

  const subEl = hudEl.querySelector("[data-chrono-sublabel]");
  if (subEl) {
    subEl.textContent = t(
      isSessionLocked ? "hud_sub_locked" : isActive ? "hud_sub_active" : "hud_sub_idle",
      lang
    );
  }

  const eyebrowEl = hudEl.querySelector("[data-chrono-eyebrow]");
  if (eyebrowEl) {
    eyebrowEl.textContent = isCompletedFree
      ? lang === "en"
        ? "Session finished"
        : "Session terminée"
      : t(
          isSessionLocked
            ? "hud_eyebrow_locked"
            : isActive
              ? "hud_eyebrow_active"
              : "hud_eyebrow_idle",
          lang
        );
  }

  const goalHeadingEl = hudEl.querySelector("[data-chrono-goal-title]");
  const goalSubEl = hudEl.querySelector("[data-chrono-goal-sub]");
  const goal = state.activeGoal;
  if (goalHeadingEl) {
    goalHeadingEl.textContent = goal?.title || goal?.app || goal?.site || t("goal_none_title", lang);
  }
  if (goalSubEl) {
    const parts = [];
    if (goal?.app) parts.push(goal.app);
    if (goal?.site) parts.push(goal.site);
    goalSubEl.textContent = parts.length > 0 ? parts.join(", ") : t("goal_none_hint", lang);
  }

  const startBtn = hudEl.querySelector("[data-session-start-btn]");
  if (startBtn) {
    startBtn.disabled = isSessionLocked;
    startBtn.textContent = isSessionLocked
      ? lang === "en"
        ? "Session running"
        : "Session en cours"
      : lang === "en"
        ? "Start session"
        : "Démarrer la session";
  }

  // Boomerang preview endpoints (used in Extension Options)
  const boomTargetEl = hudEl.querySelector("[data-boom-target]");
  if (boomTargetEl) {
    const fallbackWork =
      goal?.app ||
      goal?.site ||
      (Array.isArray(state.workApps) && state.workApps[0]) ||
      (Array.isArray(state.workSites) && state.workSites[0]) ||
      "VS Code / Docs";
    boomTargetEl.textContent = fallbackWork;
  }

  const boomBlockEl = hudEl.querySelector("[data-boom-block]");
  if (boomBlockEl) {
    const firstBlock =
      (Array.isArray(state.blacklist) && state.blacklist[0]) ||
      (Array.isArray(state.blockedApps) &&
        (typeof state.blockedApps[0] === "string"
          ? state.blockedApps[0]
          : state.blockedApps[0]?.process)) ||
      "instagram.com";
    boomBlockEl.textContent = firstBlock;
  }

  // Disable quick-session pills while already locked
  hudEl.querySelectorAll("[data-hud-minutes], [data-select-minutes]").forEach((btn) => {
    btn.disabled = isSessionLocked;
  });
}

let simInterval = null;

/**
 * Plays a tactile 3-second Boomerang simulation inside the Studio Focus HUD.
 */
export function runBoomerangMiniPreview(hudEl, { lang = "fr" } = {}) {
  if (!hudEl) return;
  const strip = hudEl.querySelector("[data-boom-strip]");
  const statusEl = hudEl.querySelector("[data-boom-status]");
  if (!strip || !statusEl) return;

  if (simInterval) {
    clearInterval(simInterval);
    simInterval = null;
  }

  let remaining = 3;
  strip.classList.add("running");
  statusEl.textContent = t("hud_sim_running", lang, { sec: remaining });

  simInterval = setInterval(() => {
    remaining -= 1;
    if (remaining <= 0) {
      clearInterval(simInterval);
      simInterval = null;
      strip.classList.remove("running");
      statusEl.textContent = t("hud_sim_done", lang);
      setTimeout(() => {
        if (!simInterval && statusEl) {
          statusEl.textContent = t("hud_sim_ready", lang);
        }
      }, 2200);
    } else {
      statusEl.textContent = t("hud_sim_running", lang, { sec: remaining });
    }
  }, 1000);
}

/**
 * Keyboard-first Command Palette (⌘K / Ctrl+K) + single-key studio shortcuts (1/2/3/T/G).
 */
export function initCommandPalette({
  modalEl,
  triggerEl,
  getCommands,
  getLang = () => "fr",
  isBlocked = () => false,
  shortcuts = {}
}) {
  if (!modalEl) return { open: () => {}, close: () => {} };

  const inputEl = modalEl.querySelector("[data-cmdk-input]");
  const listEl = modalEl.querySelector("[data-cmdk-list]");
  let isOpen = false;
  let filtered = [];
  let selectedIdx = 0;

  function renderList() {
    const lang = getLang();
    const q = (inputEl?.value || "").trim().toLowerCase();
    const all = getCommands(lang) || [];
    filtered = all.filter((cmd) => {
      if (!q) return true;
      const hay = `${cmd.label} ${cmd.group || ""} ${cmd.keywords || ""}`.toLowerCase();
      return hay.includes(q);
    });

    if (selectedIdx >= filtered.length) selectedIdx = 0;
    listEl.innerHTML = "";

    if (filtered.length === 0) {
      const empty = document.createElement("div");
      empty.className = "cmdk-empty";
      empty.textContent = t("cmdk_empty", lang);
      listEl.appendChild(empty);
      return;
    }

    let lastGroup = null;
    filtered.forEach((cmd, idx) => {
      if (cmd.group && cmd.group !== lastGroup) {
        lastGroup = cmd.group;
        const heading = document.createElement("div");
        heading.className = "cmdk-group-title";
        heading.textContent = cmd.group;
        listEl.appendChild(heading);
      }

      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = `cmdk-item${idx === selectedIdx ? " selected" : ""}`;
      if (cmd.tone) btn.dataset.tone = cmd.tone;

      const left = document.createElement("span");
      left.className = "cmdk-item-left";
      const dot = document.createElement("span");
      dot.className = "cmdk-item-dot";
      const lbl = document.createElement("span");
      lbl.textContent = cmd.label;
      left.appendChild(dot);
      left.appendChild(lbl);

      btn.appendChild(left);

      if (cmd.shortcut) {
        const meta = document.createElement("span");
        meta.className = "cmdk-item-meta";
        const kbd = document.createElement("kbd");
        kbd.className = "kbd-chip";
        kbd.textContent = cmd.shortcut;
        meta.appendChild(kbd);
        btn.appendChild(meta);
      }

      btn.addEventListener("mouseenter", () => {
        selectedIdx = idx;
        listEl.querySelectorAll(".cmdk-item").forEach((el, i) => {
          el.classList.toggle("selected", i === selectedIdx);
        });
      });

      btn.addEventListener("click", () => {
        close();
        cmd.run?.();
      });

      listEl.appendChild(btn);
    });
  }

  function open() {
    if (isBlocked()) return;
    isOpen = true;
    selectedIdx = 0;
    if (inputEl) inputEl.value = "";
    modalEl.classList.remove("hidden");
    renderList();
    requestAnimationFrame(() => inputEl?.focus());
  }

  function close() {
    isOpen = false;
    modalEl.classList.add("hidden");
  }

  triggerEl?.addEventListener("click", open);

  modalEl.addEventListener("click", (e) => {
    if (e.target === modalEl) close();
  });

  inputEl?.addEventListener("input", () => {
    selectedIdx = 0;
    renderList();
  });

  inputEl?.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      if (filtered.length > 0) {
        selectedIdx = (selectedIdx + 1) % filtered.length;
        renderList();
      }
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      if (filtered.length > 0) {
        selectedIdx = (selectedIdx - 1 + filtered.length) % filtered.length;
        renderList();
      }
    } else if (e.key === "Enter") {
      e.preventDefault();
      const chosen = filtered[selectedIdx];
      if (chosen) {
        close();
        chosen.run?.();
      }
    } else if (e.key === "Escape") {
      e.preventDefault();
      close();
    }
  });

  window.addEventListener("keydown", (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
      e.preventDefault();
      if (isOpen) close();
      else open();
      return;
    }

    if (isOpen && e.key === "Escape") {
      e.preventDefault();
      close();
      return;
    }

    if (isOpen || isBlocked()) return;

    // Ignore single-key shortcuts when typing or holding modifiers
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const tag = (e.target?.tagName || "").toLowerCase();
    if (tag === "input" || tag === "textarea" || tag === "select" || e.target?.isContentEditable) {
      return;
    }

    const key = e.key.toLowerCase();
    if (typeof shortcuts[key] === "function") {
      e.preventDefault();
      shortcuts[key]();
    }
  });

  return { open, close };
}

/**
 * Shared 2-minute AFK Presence Check + 30s Audible Alarm modal controller.
 */
export function initPresenceModal({
  modalEl,
  cardEl,
  statusEl,
  titleEl,
  descEl,
  barEl,
  resumeBtnEl,
  getLang = () => "fr",
  getSoundSettings = () => null,
  onConfirm = () => {}
}) {
  if (!modalEl) return { open: () => {}, close: () => {} };
  let timer = null;

  function close() {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
    stopPresenceAlarm();
    cardEl?.classList.remove("is-alarm");
    modalEl.classList.add("hidden");
  }

  function open({ idleMinutes = 2, alarmDelaySeconds = 30, targetLabel = "Dhirna" } = {}) {
    close();
    const lang = getLang();
    if (titleEl) titleEl.textContent = t("presence_title", lang);
    if (descEl) {
      descEl.textContent = t("presence_desc", lang, {
        min: idleMinutes,
        target: targetLabel || "Work"
      });
    }

    let remaining = Number(alarmDelaySeconds) || 30;
    if (statusEl) statusEl.textContent = t("presence_alarm_in", lang, { sec: remaining });
    modalEl.classList.remove("hidden");
    playReminderChime(getSoundSettings());

    if (barEl) {
      barEl.style.transition = "none";
      barEl.style.transform = "scaleX(1)";
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          barEl.style.transition = `transform ${remaining}s linear`;
          barEl.style.transform = "scaleX(0)";
        });
      });
    }

    timer = setInterval(() => {
      remaining -= 1;
      const curLang = getLang();
      if (remaining <= 0) {
        clearInterval(timer);
        timer = null;
        cardEl?.classList.add("is-alarm");
        if (statusEl) statusEl.textContent = t("presence_alarm_active", curLang);
        startPresenceAlarm();
      } else if (statusEl) {
        statusEl.textContent = t("presence_alarm_in", curLang, { sec: remaining });
      }
    }, 1000);
  }

  resumeBtnEl?.addEventListener("click", () => {
    close();
    onConfirm();
  });

  window.addEventListener("keydown", (e) => {
    if (!modalEl.classList.contains("hidden") && e.key === "Enter") {
      e.preventDefault();
      close();
      onConfirm();
    }
  });

  return { open, close };
}
