/**
 * 100% offline Web Audio API "Retour au travail" sound synthesizer, custom audio player,
 * and presence chronometer alarm for Dhirna.
 */

export const DEFAULT_ALARM_VOLUME_CAP_PCT = 70;
export const HARD_MAX_ALARM_VOLUME_PCT = 85;
export const MIN_ALARM_VOLUME_PCT = 10;
export const DEFAULT_ALARM_MAX_DURATION_SEC = 90;
export const HARD_MAX_ALARM_DURATION_SEC = 300;

export const DEFAULT_SOUND_VOLUME_PCT = 70;
export const MAX_CUSTOM_SOUND_BYTES = 5 * 1024 * 1024; // 5 MB
export const ALLOWED_SOUND_EXTENSIONS = ["mp3", "wav", "ogg"];

export const BUILTIN_SOUNDS = [
  {
    id: "chime",
    nameFr: "Chime",
    nameEn: "Chime",
    descFr: "Quinte cristalline courte et posée",
    descEn: "Short, calm crystalline fifth"
  },
  {
    id: "bell",
    nameFr: "Soft Bell",
    nameEn: "Soft Bell",
    descFr: "Cloche harmonique feutrée sans dureté",
    descEn: "Warm harmonic bell without harshness"
  },
  {
    id: "pulse",
    nameFr: "Focus Pulse",
    nameEn: "Focus Pulse",
    descFr: "Double impulsion boisée de rappel",
    descEn: "Warm two-beat marimba pulse"
  },
  {
    id: "tap",
    nameFr: "Minimal Tap",
    nameEn: "Minimal Tap",
    descFr: "Impulsion ultra-discrète de 60 ms",
    descEn: "Ultra-discreet 60 ms tactile tap"
  }
];

const BUILTIN_SOUND_IDS = new Set(BUILTIN_SOUNDS.map((s) => s.id));

let audioCtx = null;
let alarmIntervalId = null;
let alarmMaxDurationTimer = null;
let alarmPlaying = false;
let cachedCustomDataUrl = "";
let activeCustomAudio = null;

export function clampAlarmVolumePct(pct) {
  const n = Number(pct);
  if (!Number.isFinite(n)) return DEFAULT_ALARM_VOLUME_CAP_PCT;
  return Math.min(HARD_MAX_ALARM_VOLUME_PCT, Math.max(MIN_ALARM_VOLUME_PCT, Math.round(n)));
}

export function clampSoundVolumePct(pct) {
  const n = Number(pct);
  if (!Number.isFinite(n)) return DEFAULT_SOUND_VOLUME_PCT;
  return Math.min(100, Math.max(0, Math.round(n)));
}

export function clampAlarmDurationSec(sec) {
  const n = Number(sec);
  if (!Number.isFinite(n)) return DEFAULT_ALARM_MAX_DURATION_SEC;
  return Math.min(HARD_MAX_ALARM_DURATION_SEC, Math.max(5, Math.round(n)));
}

/**
 * Normalizes persistent user sound preferences.
 *
 * @param {object | null | undefined} raw
 * @returns {{
 *   selectedSound: "chime" | "bell" | "pulse" | "tap" | "custom",
 *   volumePct: number,
 *   muted: boolean,
 *   customSoundName: string,
 *   customSoundFile: string
 * }}
 */
export function normalizeSoundSettings(raw = {}) {
  const safe = raw && typeof raw === "object" ? raw : {};
  const customSoundName =
    typeof safe.customSoundName === "string" ? safe.customSoundName.trim().slice(0, 140) : "";
  const customSoundFile =
    typeof safe.customSoundFile === "string" ? safe.customSoundFile.trim().slice(0, 140) : "";
  const reqId = typeof safe.selectedSound === "string" ? safe.selectedSound.trim() : "chime";

  let selectedSound = "chime";
  if (reqId === "custom" && customSoundFile) {
    selectedSound = "custom";
  } else if (BUILTIN_SOUND_IDS.has(reqId)) {
    selectedSound = reqId;
  }

  return {
    selectedSound,
    volumePct: clampSoundVolumePct(safe.volumePct),
    muted: Boolean(safe.muted),
    forceUnmuteOnAlarm: safe.forceUnmuteOnAlarm !== false,
    customSoundName: customSoundFile ? customSoundName || customSoundFile : "",
    customSoundFile
  };
}

/**
 * Pure format, size, and magic-byte validator for imported custom sound files (.mp3, .wav, .ogg).
 *
 * @param {{ name?: string, sizeBytes?: number, headerBytes?: Uint8Array | number[] | null }} meta
 * @returns {{ valid: boolean, ext: string, mime: string, errorKey: string | null }}
 */
export function validateSoundFileMeta({ name = "", sizeBytes = 0, headerBytes = null } = {}) {
  const cleanName = String(name || "").trim();
  const dotIdx = cleanName.lastIndexOf(".");
  const ext = dotIdx >= 0 ? cleanName.slice(dotIdx + 1).toLowerCase() : "";

  if (!ALLOWED_SOUND_EXTENSIONS.includes(ext)) {
    return { valid: false, ext: "", mime: "", errorKey: "sound_err_format" };
  }

  const size = Number(sizeBytes);
  if (!Number.isFinite(size) || size <= 0) {
    return { valid: false, ext, mime: "", errorKey: "sound_err_empty" };
  }
  if (size > MAX_CUSTOM_SOUND_BYTES) {
    return { valid: false, ext, mime: "", errorKey: "sound_err_size" };
  }

  if (headerBytes && headerBytes.length >= 4) {
    const b = headerBytes;
    if (ext === "wav") {
      const isRiff = b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46;
      const isWave =
        b.length < 12 || (b[8] === 0x57 && b[9] === 0x41 && b[10] === 0x56 && b[11] === 0x45);
      if (!isRiff || !isWave) {
        return { valid: false, ext, mime: "", errorKey: "sound_err_corrupt" };
      }
    } else if (ext === "ogg") {
      const isOggs = b[0] === 0x4f && b[1] === 0x67 && b[2] === 0x67 && b[3] === 0x53;
      if (!isOggs) {
        return { valid: false, ext, mime: "", errorKey: "sound_err_corrupt" };
      }
    } else if (ext === "mp3") {
      const isId3 = b[0] === 0x49 && b[1] === 0x44 && b[2] === 0x33;
      const isMpegSync = b[0] === 0xff && (b[1] & 0xe0) === 0xe0;
      if (!isId3 && !isMpegSync) {
        return { valid: false, ext, mime: "", errorKey: "sound_err_corrupt" };
      }
    }
  }

  const mime =
    ext === "wav" ? "audio/wav" : ext === "ogg" ? "audio/ogg" : "audio/mpeg";
  return { valid: true, ext, mime, errorKey: null };
}

export function setCustomSoundDataUrl(dataUrl) {
  cachedCustomDataUrl = typeof dataUrl === "string" ? dataUrl : "";
}

export function getCustomSoundDataUrl() {
  return cachedCustomDataUrl;
}

function gainForVolumeCap(volumeCapPct) {
  const pct = clampAlarmVolumePct(volumeCapPct);
  return Number(((pct / HARD_MAX_ALARM_VOLUME_PCT) * 0.28).toFixed(4));
}

function gainForSoundVolume(volumePct) {
  const pct = clampSoundVolumePct(volumePct);
  if (pct <= 0) return 0;
  return Number(((pct / 100) * 0.26).toFixed(4));
}

function ensureAudioContext() {
  if (typeof window === "undefined") return null;
  const Ctor = window.AudioContext || window.webkitAudioContext;
  if (!Ctor) return null;
  if (!audioCtx || audioCtx.state === "closed") {
    audioCtx = new Ctor();
  }
  if (audioCtx.state === "suspended") {
    audioCtx.resume().catch(() => {});
  }
  return audioCtx;
}

function playTone(freqHz, startOffsetSec, durationSec, gainPeak = 0.16, type = "sine") {
  if (gainPeak <= 0.0002) return;
  const ctx = ensureAudioContext();
  if (!ctx) return;
  try {
    const startAt = ctx.currentTime + Math.max(0, startOffsetSec);
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freqHz, startAt);

    gain.gain.setValueAtTime(0.0001, startAt);
    gain.gain.exponentialRampToValueAtTime(Math.max(0.001, gainPeak), startAt + 0.012);
    gain.gain.exponentialRampToValueAtTime(0.0001, startAt + Math.max(0.035, durationSec));

    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(startAt);
    osc.stop(startAt + durationSec + 0.02);
  } catch {
    // WebView autoplay policy fallback handled cleanly without throwing
  }
}

function synthesizeBuiltinSound(soundId, peak) {
  if (peak <= 0.0002) return;
  switch (soundId) {
    case "bell":
      // Warm harmonic bell (E5 fundamental + soft E6 overtone)
      playTone(659.25, 0.0, 0.42, peak, "sine");
      playTone(1318.51, 0.0, 0.24, peak * 0.35, "sine");
      break;
    case "pulse":
      // Two-beat marimba-style focus pulse (A4 -> D5)
      playTone(440.0, 0.0, 0.12, peak * 0.9, "triangle");
      playTone(587.33, 0.14, 0.18, peak, "triangle");
      break;
    case "tap":
      // Minimal 60 ms tactile tap
      playTone(340.0, 0.0, 0.055, peak * 0.85, "sine");
      playTone(220.0, 0.015, 0.045, peak * 0.55, "triangle");
      break;
    case "chime":
    default:
      // Crisp ascending fifth (C5 -> G5)
      playTone(523.25, 0.0, 0.15, peak * 0.88, "sine");
      playTone(783.99, 0.11, 0.24, peak, "triangle");
      break;
  }
}

/**
 * Plays the user's configured "Retour au travail" alert (built-in synth or imported custom audio).
 *
 * @param {object} [rawSettings]
 * @param {{ customDataUrl?: string, ignoreMute?: boolean }} [opts]
 * @returns {{ played: boolean, reason: string | null, soundId: string }}
 */
export function playReturnSound(rawSettings = {}, opts = {}) {
  const settings = normalizeSoundSettings(rawSettings);
  if (settings.muted && !opts.ignoreMute) {
    return { played: false, reason: "muted", soundId: settings.selectedSound };
  }
  if (settings.volumePct <= 0) {
    return { played: false, reason: "zero-volume", soundId: settings.selectedSound };
  }

  const dataUrl = opts.customDataUrl || cachedCustomDataUrl;
  if (settings.selectedSound === "custom" && dataUrl && typeof Audio !== "undefined") {
    try {
      if (activeCustomAudio) {
        activeCustomAudio.pause();
        activeCustomAudio.currentTime = 0;
      }
      const audio = new Audio(dataUrl);
      audio.volume = Math.min(1, Math.max(0, settings.volumePct / 100));
      activeCustomAudio = audio;
      const playPromise = audio.play();
      if (playPromise && typeof playPromise.catch === "function") {
        playPromise.catch(() => {
          synthesizeBuiltinSound("chime", gainForSoundVolume(settings.volumePct));
        });
      }
      return { played: true, reason: null, soundId: "custom" };
    } catch {
      synthesizeBuiltinSound("chime", gainForSoundVolume(settings.volumePct));
      return { played: true, reason: "fallback-builtin", soundId: "chime" };
    }
  }

  const effectiveId = BUILTIN_SOUND_IDS.has(settings.selectedSound)
    ? settings.selectedSound
    : "chime";
  synthesizeBuiltinSound(effectiveId, gainForSoundVolume(settings.volumePct));
  return { played: true, reason: null, soundId: effectiveId };
}

/**
 * Plays a calm attention alert when the inactivity check appears, respecting sound settings.
 */
export function playReminderChime(soundSettings) {
  if (soundSettings && typeof soundSettings === "object") {
    playReturnSound(soundSettings);
    return;
  }
  playTone(523.25, 0, 0.14, 0.14, "sine");
  playTone(783.99, 0.11, 0.22, 0.16, "triangle");
}

function playTripleChronoBurst(volumeCapPct = DEFAULT_ALARM_VOLUME_CAP_PCT) {
  const peak = gainForVolumeCap(volumeCapPct);
  playTone(880.0, 0.0, 0.11, peak, "triangle");
  playTone(1174.66, 0.13, 0.11, peak, "triangle");
  playTone(880.0, 0.26, 0.13, Math.min(0.3, peak * 1.07), "triangle");
}

function forceSystemUnmuteIfTauri(percent = DEFAULT_ALARM_VOLUME_CAP_PCT) {
  const clamped = clampAlarmVolumePct(percent);
  try {
    if (typeof window !== "undefined" && window.__TAURI__?.core?.invoke) {
      window.__TAURI__.core.invoke("force_unmute_system_audio", { percent: clamped }).catch(() => {});
    }
  } catch {
    // Ignore outside Tauri Desktop environment
  }
}

/**
 * Starts a repeating audible chronometer alarm loop until `stopPresenceAlarm()` is called
 * or until the safety `maxDurationSec` ceiling expires.
 *
 * @param {{ volumeCapPct?: number, maxDurationSec?: number, onAutoStop?: () => void }} [opts]
 */
export function startPresenceAlarm(opts = {}) {
  if (alarmPlaying) return;
  const volumeCapPct = clampAlarmVolumePct(opts.volumeCapPct);
  const maxDurationSec = clampAlarmDurationSec(opts.maxDurationSec);
  alarmPlaying = true;
  forceSystemUnmuteIfTauri(volumeCapPct);
  ensureAudioContext();
  playTripleChronoBurst(volumeCapPct);
  let burstTick = 0;
  alarmIntervalId = setInterval(() => {
    if (alarmPlaying) {
      burstTick += 1;
      if (burstTick % 3 === 0) {
        forceSystemUnmuteIfTauri(volumeCapPct);
      }
      playTripleChronoBurst(volumeCapPct);
    }
  }, 850);
  alarmMaxDurationTimer = setTimeout(() => {
    stopPresenceAlarm();
    if (typeof opts.onAutoStop === "function") {
      opts.onAutoStop();
    }
  }, maxDurationSec * 1000);
}

/**
 * Stops the repeating alarm loop immediately and clears all safety timers.
 */
export function stopPresenceAlarm() {
  alarmPlaying = false;
  if (alarmIntervalId !== null) {
    clearInterval(alarmIntervalId);
    alarmIntervalId = null;
  }
  if (alarmMaxDurationTimer !== null) {
    clearTimeout(alarmMaxDurationTimer);
    alarmMaxDurationTimer = null;
  }
  if (activeCustomAudio) {
    try {
      activeCustomAudio.pause();
      activeCustomAudio.currentTime = 0;
    } catch {
      // ignore
    }
    activeCustomAudio = null;
  }
  if (audioCtx && audioCtx.state !== "closed") {
    audioCtx.suspend().catch(() => {});
  }
}

export function isPresenceAlarmPlaying() {
  return alarmPlaying;
}
