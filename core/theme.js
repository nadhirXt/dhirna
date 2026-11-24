/**
 * Dhirna Local Dual-Theme Controller ("dark" Graphite Studio <-> "light" Mineral Paper).
 * 100% local persistence (localStorage + optional chrome.storage.local + optional 127.0.0.1:47821 bridge).
 */

export const THEME_STORAGE_KEY = "dhirna_theme";
const LOCAL_BRIDGE_THEME_URL = "http://127.0.0.1:47821/theme";

const SUN_SVG =
  '<svg viewBox="0 0 16 16" fill="none" aria-hidden="true">' +
  '<circle cx="8" cy="8" r="3" stroke="currentColor" stroke-width="1.5"/>' +
  '<path d="M8 1.5V3M8 13V14.5M1.5 8H3M13 8H14.5M3.4 3.4L4.5 4.5M11.5 11.5L12.6 12.6M12.6 3.4L11.5 4.5M4.5 11.5L3.4 12.6" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/>' +
  "</svg>";

const MOON_SVG =
  '<svg viewBox="0 0 16 16" fill="none" aria-hidden="true">' +
  '<path d="M13.2 9.8A5.5 5.5 0 0 1 6.2 2.8a5.5 5.5 0 1 0 7 7Z" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/>' +
  "</svg>";

let currentTheme = "dark";
let currentUpdatedAtMs = 0;

export function normalizeTheme(value) {
  return value === "light" ? "light" : "dark";
}

export function getActiveTheme() {
  return currentTheme;
}

export function renderThemeButtonState(btn, theme = currentTheme, lang = "fr") {
  if (!btn) return;
  const isLight = theme === "light";
  btn.innerHTML = isLight ? MOON_SVG : SUN_SVG;
  const title = isLight
    ? lang === "en"
      ? "Switch to Dark theme"
      : "Passer en thème Sombre"
    : lang === "en"
      ? "Switch to Light theme"
      : "Passer en thème Clair";
  btn.title = title;
  btn.setAttribute("aria-label", title);
  btn.dataset.themeState = theme;
}

export function applyTheme(theme, { lang = "fr", buttonSelector = "[data-theme-toggle]" } = {}) {
  const normalized = normalizeTheme(theme);
  currentTheme = normalized;
  if (typeof document !== "undefined" && document.documentElement) {
    document.documentElement.dataset.theme = normalized;
    document.querySelectorAll(buttonSelector).forEach((btn) => {
      renderThemeButtonState(btn, normalized, lang);
    });
  }
  return normalized;
}

function writeLocalTheme(theme, updatedAtMs) {
  try {
    if (typeof localStorage !== "undefined") {
      localStorage.setItem(THEME_STORAGE_KEY, theme);
      localStorage.setItem(`${THEME_STORAGE_KEY}_ts`, String(updatedAtMs));
    }
  } catch {
    // ignore storage errors in restricted contexts
  }
  try {
    if (typeof chrome !== "undefined" && chrome?.storage?.local) {
      chrome.storage.local.set({
        [THEME_STORAGE_KEY]: theme,
        [`${THEME_STORAGE_KEY}_ts`]: updatedAtMs
      });
    }
  } catch {
    // ignore outside extension
  }
}

async function pushBridgeTheme(theme, updatedAtMs) {
  if (typeof fetch !== "function") return;
  try {
    const ctrl = typeof AbortController !== "undefined" ? new AbortController() : null;
    const timer = ctrl ? setTimeout(() => ctrl.abort(), 700) : null;
    await fetch(LOCAL_BRIDGE_THEME_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ theme, updatedAtMs }),
      signal: ctrl?.signal
    });
    if (timer) clearTimeout(timer);
  } catch {
    // Desktop bridge offline — stay 100% functional locally
  }
}

async function pullBridgeTheme() {
  if (typeof fetch !== "function") return null;
  try {
    const ctrl = typeof AbortController !== "undefined" ? new AbortController() : null;
    const timer = ctrl ? setTimeout(() => ctrl.abort(), 650) : null;
    const res = await fetch(LOCAL_BRIDGE_THEME_URL, {
      method: "GET",
      signal: ctrl?.signal
    });
    if (timer) clearTimeout(timer);
    if (!res.ok) return null;
    const data = await res.json();
    if (data && (data.theme === "dark" || data.theme === "light")) {
      return {
        theme: data.theme,
        updatedAtMs: Number(data.updatedAtMs) || 0
      };
    }
  } catch {
    // ignore when standalone
  }
  return null;
}

export async function setTheme(theme, { lang = "fr", broadcast = true } = {}) {
  const normalized = normalizeTheme(theme);
  const now = Date.now();
  currentUpdatedAtMs = now;
  applyTheme(normalized, { lang });
  writeLocalTheme(normalized, now);
  if (broadcast) {
    pushBridgeTheme(normalized, now);
  }
  return normalized;
}

export async function toggleTheme({ lang = "fr" } = {}) {
  return setTheme(currentTheme === "dark" ? "light" : "dark", { lang, broadcast: true });
}

export async function initTheme({ getLang = () => "fr", enableBridge = true } = {}) {
  let initialTheme = "dark";
  let initialTs = 0;
  try {
    if (typeof localStorage !== "undefined") {
      const saved = localStorage.getItem(THEME_STORAGE_KEY);
      if (saved === "light" || saved === "dark") {
        initialTheme = saved;
      }
      initialTs = Number(localStorage.getItem(`${THEME_STORAGE_KEY}_ts`)) || 0;
    }
  } catch {
    // ignore
  }
  currentUpdatedAtMs = initialTs;
  applyTheme(initialTheme, { lang: getLang() });

  if (typeof document !== "undefined") {
    document.querySelectorAll("[data-theme-toggle]").forEach((btn) => {
      if (btn.dataset.themeBound === "1") return;
      btn.dataset.themeBound = "1";
      btn.addEventListener("click", () => {
        toggleTheme({ lang: getLang() });
      });
    });
  }

  if (typeof window !== "undefined") {
    window.addEventListener("storage", (ev) => {
      if (ev.key === THEME_STORAGE_KEY && (ev.newValue === "dark" || ev.newValue === "light")) {
        applyTheme(ev.newValue, { lang: getLang() });
      }
    });
  }

  try {
    if (typeof chrome !== "undefined" && chrome?.storage?.local) {
      const stored = await chrome.storage.local.get([
        THEME_STORAGE_KEY,
        `${THEME_STORAGE_KEY}_ts`
      ]);
      const extTheme = stored?.[THEME_STORAGE_KEY];
      const extTs = Number(stored?.[`${THEME_STORAGE_KEY}_ts`]) || 0;
      if ((extTheme === "dark" || extTheme === "light") && extTs >= currentUpdatedAtMs) {
        currentUpdatedAtMs = extTs;
        applyTheme(extTheme, { lang: getLang() });
      }
      chrome.storage.onChanged.addListener((changes, area) => {
        if (area === "local" && changes[THEME_STORAGE_KEY]?.newValue) {
          applyTheme(changes[THEME_STORAGE_KEY].newValue, { lang: getLang() });
        }
      });
    }
  } catch {
    // ignore outside extension
  }

  if (enableBridge) {
    const bridge = await pullBridgeTheme();
    if (bridge && bridge.updatedAtMs > currentUpdatedAtMs) {
      currentUpdatedAtMs = bridge.updatedAtMs;
      applyTheme(bridge.theme, { lang: getLang() });
      writeLocalTheme(bridge.theme, bridge.updatedAtMs);
    } else if (currentUpdatedAtMs > 0) {
      pushBridgeTheme(currentTheme, currentUpdatedAtMs);
    }
  }

  return currentTheme;
}
