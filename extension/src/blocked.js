import { applyDomTranslations, t } from "./lib/i18n.js";
import { initTheme } from "./lib/theme.js";
import { playReturnSound, startPresenceAlarm, stopPresenceAlarm } from "./lib/alarm.js";

const params = new URLSearchParams(window.location.search);
const isDemo = params.get("demo") === "1";
const isShieldBlock = params.get("reason") === "shield";
const isReelBlock = params.get("reason") === "reels";
const isPresenceMode = params.get("mode") === "presence";
const COUNTDOWN_SECONDS = isPresenceMode ? 30 : 3;
const RING_CIRC = 163.36;

initTheme({ enableBridge: false });

function getRawBlockedUrl() {
  const hash = window.location.hash ? window.location.hash.slice(1) : "";
  if (!hash) return "https://instagram.com";
  try {
    if (hash.startsWith("http%3A") || hash.startsWith("https%3A")) {
      return decodeURIComponent(hash);
    }
    return hash;
  } catch {
    return hash;
  }
}

async function triggerBoomerang() {
  stopPresenceAlarm();
  try {
    await chrome.runtime.sendMessage({
      type: "BOOMERANG_CLOSE",
      isDemo,
      isPresence: isPresenceMode
    });
  } catch {
    window.close();
  }
}

async function initBlockedPage() {
  const blockedUrl = getRawBlockedUrl();
  const domainEl = document.getElementById("blocked-domain");
  const stageBlockedEl = document.getElementById("stage-blocked-domain");
  const workTitleEl = document.getElementById("work-target-title");
  const workDomainEl = document.getElementById("work-target-domain");
  const workStateEl = document.getElementById("work-target-state");
  const goalBannerEl = document.getElementById("goal-banner");
  const goalBannerTitleEl = document.getElementById("goal-banner-title");
  const statsTotalEl = document.getElementById("stats-total");
  const statsSiteEl = document.getElementById("stats-site-count");
  const btnNow = document.getElementById("btn-boomerang-now");
  const btnLabel = document.getElementById("btn-boomerang-label");
  const headerMetaEl = document.getElementById("header-meta-text");

  btnNow.addEventListener("click", () => {
    triggerBoomerang();
  });

  window.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === "Escape") {
      e.preventDefault();
      triggerBoomerang();
    }
  });

  let activeLang = "fr";

  try {
    const res = await chrome.runtime.sendMessage({
      type: "RECORD_BLOCK_AND_GET_CONTEXT",
      blockedUrl,
      isDemo,
      isPresence: isPresenceMode
    });

    if (res && res.ok) {
      const lang = res.lang || "fr";
      activeLang = lang;
      applyDomTranslations(document, lang);

      if (isPresenceMode) {
        document.body.dataset.mode = "presence";
        headerMetaEl.textContent = t("presence_eyebrow", lang);
        const h1 = document.querySelector("h1");
        if (h1) h1.textContent = t("presence_title", lang);
        const targetText =
          res.desktopGoalWindow?.processName ||
          res.bestWorkTab?.domain ||
          res.activeGoal?.title ||
          "work";
        const subEl = document.querySelector(".subtitle");
        if (subEl) {
          subEl.textContent = t("presence_desc", lang, {
            min: res.presenceIdleMinutes || 2,
            target: targetText
          });
        }
        const timerLabelEl = document.querySelector(".timer-bar-header > span:first-child");
        if (timerLabelEl) {
          timerLabelEl.textContent = t("presence_alarm_in", lang, { sec: COUNTDOWN_SECONDS });
        }
        playReturnSound(res.sound);
      } else {
        playReturnSound(res.sound);
        if (isDemo) {
          headerMetaEl.textContent = t("blk_header_demo", lang);
        } else if (isShieldBlock) {
          headerMetaEl.textContent = t("shield_blk_header", lang);
          const h1 = document.querySelector("h1");
          if (h1) h1.textContent = t("shield_blk_title", lang);
        } else if (isReelBlock) {
          headerMetaEl.textContent = t("reel_blk_header", lang);
          const h1 = document.querySelector("h1");
          if (h1) h1.textContent = t("reel_blk_title", lang);
          const subEl = document.querySelector(".subtitle");
          if (subEl) subEl.textContent = t("reel_blk_sub", lang);
        }
      }

      const intercepted = isPresenceMode
        ? `${res.presenceIdleMinutes || 2} min`
        : res.blockedDomain || "instagram.com";
      domainEl.textContent = intercepted;
      stageBlockedEl.textContent = intercepted;

      const total = res.stats?.total || (isDemo || isPresenceMode ? 0 : 1);
      const siteCount = res.stats?.perSite?.[res.blockedDomain] || (isDemo || isPresenceMode ? 0 : 1);
      statsTotalEl.textContent = String(total);
      statsSiteEl.textContent = String(siteCount);

      if (res.activeGoal?.title) {
        goalBannerTitleEl.textContent = res.activeGoal.title;
        goalBannerEl.classList.remove("hidden");
      }

      if (res.desktopGoalWindow && (!res.bestWorkTab || res.activeGoal?.targetType === "app")) {
        const winLabel = res.desktopGoalWindow.title || res.desktopGoalWindow.processName;
        workStateEl.textContent = t("blk_node_desktop", lang);
        workTitleEl.textContent = winLabel;
        workDomainEl.textContent = res.desktopGoalWindow.processName || "";
        btnLabel.textContent = isPresenceMode
          ? t("presence_btn_resume", lang)
          : t("blk_btn_return_to", lang, { title: res.desktopGoalWindow.processName || winLabel });
      } else if (res.bestWorkTab) {
        const docTitle = res.bestWorkTab.title || res.bestWorkTab.domain;
        workStateEl.textContent = t("blk_node_autofocus", lang);
        workTitleEl.textContent = docTitle;
        workDomainEl.textContent = res.bestWorkTab.domain;
        btnLabel.textContent = isPresenceMode
          ? t("presence_btn_resume", lang)
          : t("blk_btn_return_to", lang, { title: docTitle });
      } else if (res.desktopGoalWindow) {
        const winLabel = res.desktopGoalWindow.title || res.desktopGoalWindow.processName;
        workStateEl.textContent = t("blk_node_desktop", lang);
        workTitleEl.textContent = winLabel;
        workDomainEl.textContent = res.desktopGoalWindow.processName || "";
        btnLabel.textContent = isPresenceMode
          ? t("presence_btn_resume", lang)
          : t("blk_btn_return_to", lang, { title: winLabel });
      } else if (res.activeGoal?.app) {
        workStateEl.textContent = t("blk_node_desktop", lang);
        workTitleEl.textContent = res.activeGoal.title || t("blk_return_desktop_app", lang);
        workDomainEl.textContent = res.activeGoal.app;
        btnLabel.textContent = isPresenceMode ? t("presence_btn_resume", lang) : t("blk_btn_close_only", lang);
      } else {
        workStateEl.textContent = t("blk_node_close_only", lang);
        workTitleEl.textContent = res.activeGoal?.title || t("blk_return_close_only", lang);
        workDomainEl.textContent = t("blk_no_fake_target", lang);
        btnLabel.textContent = isPresenceMode ? t("presence_btn_resume", lang) : t("blk_btn_close_only", lang);
      }
    }
  } catch {
    const fallback = blockedUrl || "instagram.com";
    domainEl.textContent = fallback;
    stageBlockedEl.textContent = fallback;
  }

  let remaining = COUNTDOWN_SECONDS;
  const numEl = document.getElementById("countdown-number");
  const inlineEl = document.getElementById("countdown-inline");
  const barEl = document.getElementById("progress-bar");
  const ringEl = document.getElementById("blocked-ring-arc");

  numEl.textContent = String(remaining);
  inlineEl.textContent = String(remaining);

  requestAnimationFrame(() => {
    barEl.style.transition = `transform ${COUNTDOWN_SECONDS}s linear`;
    barEl.style.transform = "scaleX(0)";
    if (ringEl) {
      ringEl.style.transition = `stroke-dashoffset ${COUNTDOWN_SECONDS}s linear`;
      ringEl.style.strokeDashoffset = String(RING_CIRC);
    }
  });

  const timerLabelEl = document.querySelector(".timer-bar-header > span:first-child");
  const timer = setInterval(() => {
    remaining -= 1;
    if (remaining <= 0) {
      clearInterval(timer);
      if (isPresenceMode) {
        numEl.textContent = "!";
        inlineEl.textContent = "0";
        document.body.dataset.alarm = "active";
        if (timerLabelEl) {
          timerLabelEl.textContent = t("presence_alarm_active", activeLang);
        }
        startPresenceAlarm();
      } else {
        numEl.textContent = "0";
        inlineEl.textContent = "0";
        triggerBoomerang();
      }
    } else {
      numEl.textContent = String(remaining);
      inlineEl.textContent = String(remaining);
      if (isPresenceMode && timerLabelEl) {
        timerLabelEl.textContent = t("presence_alarm_in", activeLang, { sec: remaining });
      }
    }
  }, 1000);
}

initBlockedPage();
