import { tauriInvoke, tauriListen } from "./engine.js";
import { applyDomTranslations, t } from "./lib/i18n.js";
import { initTheme } from "./lib/theme.js";
import {
  playReturnSound,
  startPresenceAlarm,
  stopPresenceAlarm
} from "./lib/alarm.js";

let countdownTimer = null;
let usbRepeatTimer = null;
let overlayMode = "interception"; // "interception" | "presence" | "usb-alarm"
const RING_CIRC = 188.5;

initTheme({ enableBridge: false });

function stopAllOverlayTimersAndAudio() {
  if (countdownTimer) {
    clearInterval(countdownTimer);
    countdownTimer = null;
  }
  if (usbRepeatTimer) {
    clearInterval(usbRepeatTimer);
    usbRepeatTimer = null;
  }
  stopPresenceAlarm();
}

async function finishOverlay() {
  if (overlayMode === "usb-alarm") {
    return;
  }
  stopAllOverlayTimersAndAudio();
  if (overlayMode === "presence") {
    overlayMode = "interception";
    delete document.body.dataset.mode;
    delete document.body.dataset.alarm;
    await tauriInvoke("confirm_presence_resume");
  } else {
    await tauriInvoke("trigger_overlay_complete");
  }
}

function startCountdown(ctx) {
  if (!ctx || overlayMode === "usb-alarm") return;
  overlayMode = "interception";
  stopAllOverlayTimersAndAudio();
  delete document.body.dataset.mode;
  delete document.body.dataset.alarm;
  document.getElementById("btn-ov-now")?.classList.remove("hidden");

  const lang = ctx?.lang || "fr";
  applyDomTranslations(document, lang);

  playReturnSound(ctx?.sound, { customDataUrl: ctx?.customSoundDataUrl });

  const h1El = document.querySelector("h1");
  if (h1El) h1El.textContent = t("blk_title", lang);

  const label = ctx?.distractionLabel || "instagram.com";
  document.getElementById("ov-node-blocked").textContent = label;

  const subEl = document.querySelector(".subtitle");
  if (subEl) {
    subEl.innerHTML = "";
    const s1 = document.createElement("span");
    s1.textContent = `${t("blk_subtitle_prefix", lang)} `;
    const code = document.createElement("code");
    code.id = "ov-distraction";
    code.textContent = label;
    const s2 = document.createElement("span");
    s2.textContent = ` ${t("blk_subtitle_suffix", lang)}`;
    subEl.appendChild(s1);
    subEl.appendChild(code);
    subEl.appendChild(s2);
  }

  const goalPill = document.getElementById("ov-goal-pill");
  const goalTitleEl = document.getElementById("ov-goal-title");
  if (ctx?.goalTitle) {
    goalTitleEl.textContent = ctx.goalTitle;
    goalPill.classList.remove("hidden");
  } else {
    goalPill.classList.add("hidden");
  }

  document.getElementById("ov-node-work").textContent =
    ctx?.returnTarget?.title ||
    ctx?.returnTarget?.processName ||
    ctx?.goalTitle ||
    t("blk_return_close_only", lang);

  const btnLbl = document.getElementById("ov-btn-label");
  if (btnLbl) {
    btnLbl.textContent = t("blk_btn_return", lang);
  }

  let remaining = 3;
  document.getElementById("ov-sec").textContent = "3";
  document.getElementById("ov-ring-num").textContent = "3";

  const bar = document.getElementById("ov-bar");
  bar.style.transition = "none";
  bar.style.transform = "scaleX(1)";

  const ring = document.getElementById("ov-ring-arc");
  if (ring) {
    ring.style.transition = "none";
    ring.style.strokeDashoffset = "0";
  }

  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      bar.style.transition = "transform 3s linear";
      bar.style.transform = "scaleX(0)";
      if (ring) {
        ring.style.transition = "stroke-dashoffset 3s linear";
        ring.style.strokeDashoffset = String(RING_CIRC);
      }
    });
  });

  countdownTimer = setInterval(() => {
    remaining -= 1;
    if (remaining <= 0) {
      finishOverlay();
    } else {
      document.getElementById("ov-sec").textContent = String(remaining);
      document.getElementById("ov-ring-num").textContent = String(remaining);
    }
  }, 1000);
}

function startPresenceOverlay(ctx) {
  if (!ctx || overlayMode === "usb-alarm") return;
  overlayMode = "presence";
  stopAllOverlayTimersAndAudio();
  document.body.dataset.mode = "presence";
  delete document.body.dataset.alarm;

  const lang = ctx?.lang || "fr";
  applyDomTranslations(document, lang);

  const idleMin = Number(ctx.idleMinutes) || 2;
  const targetLabel =
    ctx?.returnTarget?.processName ||
    ctx?.returnTarget?.title ||
    ctx?.goalTitle ||
    "Dhirna";

  const h1El = document.querySelector("h1");
  const subEl = document.querySelector(".subtitle");
  const btnLbl = document.getElementById("ov-btn-label");
  const btnNow = document.getElementById("btn-ov-now");

  btnNow?.classList.remove("hidden");

  if (h1El) h1El.textContent = t("presence_title", lang);
  if (subEl) {
    subEl.textContent = t("presence_desc", lang, { min: idleMin, target: targetLabel });
  }

  document.getElementById("ov-node-blocked").textContent = `${idleMin} min`;
  document.getElementById("ov-node-work").textContent =
    ctx?.returnTarget?.title || ctx?.returnTarget?.processName || targetLabel;

  const goalPill = document.getElementById("ov-goal-pill");
  const goalTitleEl = document.getElementById("ov-goal-title");
  if (ctx?.goalTitle) {
    goalTitleEl.textContent = ctx.goalTitle;
    goalPill.classList.remove("hidden");
  } else {
    goalPill.classList.add("hidden");
  }

  if (btnLbl) {
    btnLbl.textContent = t("presence_btn_resume", lang);
  }

  playReturnSound(ctx?.sound, { customDataUrl: ctx?.customSoundDataUrl });

  const totalSec = Number(ctx.alarmDelaySeconds) || 30;
  let remaining = totalSec;
  document.getElementById("ov-sec").textContent = String(remaining);
  document.getElementById("ov-ring-num").textContent = String(remaining);

  const bar = document.getElementById("ov-bar");
  bar.style.transition = "none";
  bar.style.transform = "scaleX(1)";

  const ring = document.getElementById("ov-ring-arc");
  if (ring) {
    ring.style.transition = "none";
    ring.style.strokeDashoffset = "0";
  }

  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      bar.style.transition = `transform ${totalSec}s linear`;
      bar.style.transform = "scaleX(0)";
      if (ring) {
        ring.style.transition = `stroke-dashoffset ${totalSec}s linear`;
        ring.style.strokeDashoffset = String(RING_CIRC);
      }
    });
  });

  countdownTimer = setInterval(() => {
    remaining -= 1;
    if (remaining <= 0) {
      clearInterval(countdownTimer);
      countdownTimer = null;
      document.body.dataset.alarm = "active";
      document.getElementById("ov-sec").textContent = "!";
      document.getElementById("ov-ring-num").textContent = "!";
      if (subEl) subEl.textContent = t("presence_alarm_active", lang);
      if (ctx?.sound?.forceUnmuteOnAlarm !== false || !ctx?.sound?.muted) {
        startPresenceAlarm({ volumeCapPct: ctx?.sound?.volumePct });
      }
    } else {
      document.getElementById("ov-sec").textContent = String(remaining);
      document.getElementById("ov-ring-num").textContent = String(remaining);
    }
  }, 1000);
}

function startUsbPhoneAlarmOverlay(ctx) {
  if (!ctx) return;
  overlayMode = "usb-alarm";
  stopAllOverlayTimersAndAudio();
  document.body.dataset.mode = "usb-alarm";
  document.body.dataset.alarm = "active";

  const lang = ctx?.lang || "fr";
  applyDomTranslations(document, lang);

  const appLabel = ctx?.appLabel || "Instagram";
  const targetLabel =
    ctx?.returnTarget?.title ||
    ctx?.returnTarget?.processName ||
    ctx?.goalTitle ||
    "Dhirna";

  const h1El = document.querySelector("h1");
  const subEl = document.querySelector(".subtitle");
  const btnNow = document.getElementById("btn-ov-now");

  if (h1El) h1El.textContent = t("usb_alarm_title", lang);
  if (subEl) subEl.textContent = t("usb_alarm_desc", lang, { app: appLabel });

  document.getElementById("ov-node-blocked").textContent = `${appLabel} (USB)`;
  document.getElementById("ov-node-work").textContent = targetLabel;
  document.getElementById("ov-sec").textContent = "USB";
  document.getElementById("ov-ring-num").textContent = "!";

  const goalPill = document.getElementById("ov-goal-pill");
  const goalTitleEl = document.getElementById("ov-goal-title");
  if (ctx?.goalTitle) {
    goalTitleEl.textContent = ctx.goalTitle;
    goalPill.classList.remove("hidden");
  } else {
    goalPill.classList.add("hidden");
  }

  // Zero PC dismiss button: only locking phone screen or leaving Reels stops the alarm
  btnNow?.classList.add("hidden");

  const bar = document.getElementById("ov-bar");
  if (bar) {
    bar.style.transition = "none";
    bar.style.transform = "scaleX(1)";
  }
  const ring = document.getElementById("ov-ring-arc");
  if (ring) {
    ring.style.transition = "none";
    ring.style.strokeDashoffset = "0";
  }

  const forceUnmute = ctx?.sound?.forceUnmuteOnAlarm !== false;
  if (forceUnmute || !ctx?.sound?.muted) {
    const vol = Math.min(85, Math.max(30, Number(ctx?.sound?.volumePct) || 70));
    const ringOnce = () => {
      if (forceUnmute) {
        tauriInvoke("force_unmute_system_audio", { percent: vol }).catch(() => {});
      }
      playReturnSound(ctx?.sound, {
        customDataUrl: ctx?.customSoundDataUrl,
        ignoreMute: forceUnmute
      });
    };
    ringOnce();
    usbRepeatTimer = setInterval(() => {
      if (overlayMode === "usb-alarm") {
        ringOnce();
      }
    }, 2000);
  }
}

document.getElementById("btn-ov-now").addEventListener("click", () => {
  finishOverlay();
});

window.addEventListener("keydown", (e) => {
  if (e.key === "Enter" || e.key === "Escape") {
    e.preventDefault();
    finishOverlay();
  }
});

tauriListen("overlay-context", (payload) => {
  startCountdown(payload);
});

tauriListen("presence-context", (payload) => {
  startPresenceOverlay(payload);
});

tauriListen("usb-phone-alarm", (payload) => {
  startUsbPhoneAlarmOverlay(payload);
});

tauriListen("usb-phone-alarm-stop", () => {
  stopAllOverlayTimersAndAudio();
  overlayMode = "interception";
  delete document.body.dataset.mode;
  delete document.body.dataset.alarm;
  document.getElementById("btn-ov-now")?.classList.remove("hidden");
});

window.addEventListener("focus", async () => {
  if (!countdownTimer && !usbRepeatTimer && document.body.dataset.alarm !== "active") {
    const usbCtx = await tauriInvoke("get_usb_phone_alarm_context");
    if (usbCtx) {
      startUsbPhoneAlarmOverlay(usbCtx);
      return;
    }
    const presCtx = await tauriInvoke("get_presence_context");
    if (presCtx) {
      startPresenceOverlay(presCtx);
      return;
    }
    const ctx = await tauriInvoke("get_overlay_context");
    if (ctx) startCountdown(ctx);
  }
});
