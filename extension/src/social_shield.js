(() => {
  const STORAGE_KEY = "dhirna_state";
  const STYLE_ID = "dhirna-social-shield-css";

  let active = false;
  let lastHref = "";
  let sentCloseForHref = "";
  let latestState = null;
  let sessionExpiryTimer = null;

  function parseMinutesHHMM(str) {
    if (typeof str !== "string") return null;
    const m = /^(\d{1,2}):(\d{2})$/.exec(str.trim());
    if (!m) return null;
    const hh = Number(m[1]);
    const mm = Number(m[2]);
    if (hh < 0 || hh > 23 || mm < 0 || mm > 59) return null;
    return hh * 60 + mm;
  }

  function isFocusTimerOrScheduleActive(state, now = new Date()) {
    if (!state) return false;
    const nowMs = now.getTime();
    if (typeof state.sessionEndsAt === "number" && state.sessionEndsAt > nowMs) {
      return true;
    }
    const schedules = Array.isArray(state.schedules) ? state.schedules : [];
    const day = now.getDay();
    const prevDay = (day + 6) % 7;
    const curMin = now.getHours() * 60 + now.getMinutes();
    const schedOn = schedules.some((entry) => {
      if (!entry || entry.enabled === false) return false;
      const days = Array.isArray(entry.days) ? entry.days : [];
      const s = parseMinutesHHMM(entry.start);
      const e = parseMinutesHHMM(entry.end);
      if (s === null || e === null || s === e || days.length === 0) return false;
      if (s < e) {
        return days.includes(day) && curMin >= s && curMin < e;
      }
      return (days.includes(day) && curMin >= s) || (days.includes(prevDay) && curMin < e);
    });
    if (schedOn) return true;
    if (state.sessionCompletedFree === true) return false;
    if (state.manualOn) return true;
    return Boolean(state.autoTriggerEnabled && state.lastWorkTab);
  }

  function isDomain(host, base) {
    return host === base || host.endsWith(`.${base}`);
  }

  function evaluateCurrentUrl(rawHref) {
    let parsed;
    try {
      parsed = new URL(rawHref);
    } catch {
      return { action: "allow", targetUrl: null };
    }
    const host = parsed.hostname.toLowerCase();
    const path = parsed.pathname || "/";

    if (isDomain(host, "messenger.com")) {
      return { action: "allow-dm", targetUrl: null };
    }
    if (isDomain(host, "tiktok.com")) {
      return { action: "close-reel", targetUrl: null };
    }
    if (isDomain(host, "instagram.com")) {
      if (/^\/(direct|accounts|challenge|api|static|ajax)(\/|$)/i.test(path)) {
        return { action: "allow-dm", targetUrl: null };
      }
      if (/^\/reels?(\/|$)/i.test(path)) {
        return { action: "close-reel", targetUrl: null };
      }
      return {
        action: "redirect-inbox",
        targetUrl: "https://www.instagram.com/direct/inbox/"
      };
    }
    if (isDomain(host, "youtube.com") || isDomain(host, "youtu.be")) {
      if (/^\/shorts(\/|$)/i.test(path)) {
        return { action: "close-reel", targetUrl: null };
      }
      return { action: "allow", targetUrl: null };
    }
    if (isDomain(host, "facebook.com")) {
      if (/^\/(messages|login|checkpoint|recover)(\/|$)/i.test(path)) {
        return { action: "allow-dm", targetUrl: null };
      }
      if (/^\/(reels?|watch|videos|stories)(\/|$)/i.test(path)) {
        return { action: "close-reel", targetUrl: null };
      }
      if (path === "/" || /^\/(home\.php|explore)(\/|$)/i.test(path)) {
        return {
          action: "redirect-inbox",
          targetUrl: "https://www.facebook.com/messages/"
        };
      }
    }
    return { action: "allow", targetUrl: null };
  }

  function pauseAllMedia() {
    try {
      document.querySelectorAll("video, audio").forEach((el) => {
        try {
          el.pause();
          el.muted = true;
        } catch {
          // Ignore media pause failure
        }
      });
    } catch {
      // Document not ready yet
    }
  }

  function injectSurgicalCss() {
    if (!active) return;
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = `
      /* Dhirna Messages-Only Mode: hide Reels, Shorts, Explore & Stories */
      a[href="/reels"],
      a[href^="/reels/"],
      a[href*="/reels/"],
      a[href^="/reel/"],
      a[href="/explore"],
      a[href^="/explore/"],
      a[href="/"] > svg[aria-label*="Home"],
      a[href="/"][role="link"],
      article[role="presentation"],
      ytd-guide-entry-renderer:has(a[title="Shorts"]),
      ytd-mini-guide-entry-renderer:has(a[title="Shorts"]),
      a[title="Shorts"],
      ytd-reel-shelf-renderer,
      ytd-rich-shelf-renderer[is-shorts],
      ytm-reel-shelf-renderer,
      ytd-video-renderer:has(a[href^="/shorts"]),
      ytd-grid-video-renderer:has(a[href^="/shorts"]),
      ytd-compact-video-renderer:has(a[href^="/shorts"]),
      ytd-rich-item-renderer:has(a[href^="/shorts"]),
      a[href*="/watch/"],
      [aria-label="Reels"],
      [aria-label="Stories"] {
        display: none !important;
        visibility: hidden !important;
        pointer-events: none !important;
      }
    `;
    const root = document.head || document.documentElement;
    if (root) {
      root.appendChild(style);
    }
  }

  function removeSurgicalCss() {
    const existing = document.getElementById(STYLE_ID);
    if (existing) existing.remove();
    if (document.documentElement) {
      document.documentElement.style.opacity = "";
    }
  }

  function triggerCloseReel(url) {
    pauseAllMedia();
    if (document.documentElement) {
      document.documentElement.style.opacity = "0";
    }
    if (sentCloseForHref === url) return;
    sentCloseForHref = url;
    try {
      chrome.runtime.sendMessage({
        type: "SOCIAL_SHIELD_ENFORCE",
        action: "close-reel",
        url
      });
    } catch {
      // Ignore extension context invalidation
    }
  }

  function enforceCurrentLocation() {
    if (!active) return;
    const href = window.location.href;
    const verdict = evaluateCurrentUrl(href);

    if (verdict.action === "close-reel") {
      triggerCloseReel(href);
      return;
    }

    if (verdict.action === "redirect-inbox" && verdict.targetUrl && href !== verdict.targetUrl) {
      if (document.documentElement) {
        document.documentElement.style.opacity = "0";
      }
      window.location.replace(verdict.targetUrl);
      return;
    }

    if (document.documentElement && document.documentElement.style.opacity === "0") {
      document.documentElement.style.opacity = "";
    }
    injectSurgicalCss();
  }

  function applyShieldState(state) {
    latestState = state || null;
    if (sessionExpiryTimer) {
      clearTimeout(sessionExpiryTimer);
      sessionExpiryTimer = null;
    }
    const shield = state?.shield;
    const now = new Date();
    const focusActive = isFocusTimerOrScheduleActive(state, now);
    active = Boolean(shield?.enabled && shield?.noReels !== false && focusActive);
    if (active) {
      if (typeof state?.sessionEndsAt === "number" && state.sessionEndsAt > now.getTime()) {
        const delay = Math.min(2_147_483_647, Math.max(50, state.sessionEndsAt - now.getTime() + 80));
        sessionExpiryTimer = setTimeout(() => {
          applyShieldState(latestState);
        }, delay);
      }
      injectSurgicalCss();
      enforceCurrentLocation();
    } else {
      sentCloseForHref = "";
      removeSurgicalCss();
    }
  }

  setInterval(() => {
    if (latestState) {
      applyShieldState(latestState);
    }
  }, 15000);

  try {
    chrome.storage.local.get(STORAGE_KEY, (data) => {
      applyShieldState(data?.[STORAGE_KEY]);
    });
    chrome.storage.onChanged.addListener((changes, areaName) => {
      if (areaName === "local" && changes[STORAGE_KEY]) {
        applyShieldState(changes[STORAGE_KEY].newValue);
      }
    });
  } catch {
    // Ignore restricted frame errors
  }

  document.addEventListener(
    "click",
    (event) => {
      if (!active) return;
      const anchor = event.target?.closest?.("a[href]");
      if (!anchor) return;
      const resolvedUrl = anchor.href;
      if (!resolvedUrl) return;
      const verdict = evaluateCurrentUrl(resolvedUrl);
      if (verdict.action === "close-reel") {
        event.preventDefault();
        event.stopPropagation();
        triggerCloseReel(resolvedUrl);
      } else if (verdict.action === "redirect-inbox" && verdict.targetUrl) {
        event.preventDefault();
        event.stopPropagation();
        window.location.replace(verdict.targetUrl);
      }
    },
    true
  );

  window.addEventListener("popstate", () => enforceCurrentLocation());
  window.addEventListener("yt-navigate-start", () => enforceCurrentLocation());
  window.addEventListener("yt-navigate-finish", () => enforceCurrentLocation());

  const observer = new MutationObserver(() => {
    if (!active) return;
    injectSurgicalCss();
    if (window.location.href !== lastHref) {
      lastHref = window.location.href;
      enforceCurrentLocation();
    }
  });

  if (document.documentElement) {
    observer.observe(document.documentElement, { childList: true, subtree: true });
  }
})();
