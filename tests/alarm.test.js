import test from "node:test";
import assert from "node:assert/strict";
import {
  BUILTIN_SOUNDS,
  DEFAULT_ALARM_MAX_DURATION_SEC,
  DEFAULT_ALARM_VOLUME_CAP_PCT,
  HARD_MAX_ALARM_DURATION_SEC,
  HARD_MAX_ALARM_VOLUME_PCT,
  MAX_CUSTOM_SOUND_BYTES,
  MIN_ALARM_VOLUME_PCT,
  clampAlarmDurationSec,
  clampAlarmVolumePct,
  clampSoundVolumePct,
  isPresenceAlarmPlaying,
  normalizeSoundSettings,
  playReturnSound,
  setCustomSoundDataUrl,
  startPresenceAlarm,
  stopPresenceAlarm,
  validateSoundFileMeta
} from "../core/alarm.js";

test("clampAlarmVolumePct, clampSoundVolumePct, and clampAlarmDurationSec enforce safe ceilings", () => {
  assert.equal(clampAlarmVolumePct(undefined), DEFAULT_ALARM_VOLUME_CAP_PCT);
  assert.equal(clampAlarmVolumePct(100), HARD_MAX_ALARM_VOLUME_PCT);
  assert.equal(clampAlarmVolumePct(250), HARD_MAX_ALARM_VOLUME_PCT);
  assert.equal(clampAlarmVolumePct(0), MIN_ALARM_VOLUME_PCT);
  assert.equal(clampAlarmVolumePct(65), 65);

  assert.equal(clampSoundVolumePct(undefined), 70);
  assert.equal(clampSoundVolumePct(-10), 0);
  assert.equal(clampSoundVolumePct(140), 100);
  assert.equal(clampSoundVolumePct(45), 45);

  assert.equal(clampAlarmDurationSec(undefined), DEFAULT_ALARM_MAX_DURATION_SEC);
  assert.equal(clampAlarmDurationSec(9999), HARD_MAX_ALARM_DURATION_SEC);
  assert.equal(clampAlarmDurationSec(1), 5);
  assert.equal(clampAlarmDurationSec(60), 60);
});

test("BUILTIN_SOUNDS exposes all 4 discreet Dhirna alerts and normalizeSoundSettings validates state", () => {
  assert.deepEqual(
    BUILTIN_SOUNDS.map((s) => s.id),
    ["chime", "bell", "pulse", "tap"]
  );

  const def = normalizeSoundSettings();
  assert.deepEqual(def, {
    selectedSound: "chime",
    volumePct: 70,
    muted: false,
    forceUnmuteOnAlarm: true,
    customSoundName: "",
    customSoundFile: ""
  });

  // Selecting "custom" without a persisted file safely falls back to "chime"
  const orphanCustom = normalizeSoundSettings({ selectedSound: "custom", customSoundFile: "" });
  assert.equal(orphanCustom.selectedSound, "chime");

  const validCustom = normalizeSoundSettings({
    selectedSound: "custom",
    volumePct: 82,
    muted: true,
    customSoundName: "focus_bell.wav",
    customSoundFile: "custom_alert.wav"
  });
  assert.equal(validCustom.selectedSound, "custom");
  assert.equal(validCustom.volumePct, 82);
  assert.equal(validCustom.muted, true);
  assert.equal(validCustom.customSoundFile, "custom_alert.wav");
});

test("validateSoundFileMeta validates .mp3, .wav, .ogg extensions, <= 5 MB size, and magic headers", () => {
  // Valid WAV header (RIFF....WAVE)
  const wavHeader = new Uint8Array([
    0x52, 0x49, 0x46, 0x46, 0x24, 0x00, 0x00, 0x00, 0x57, 0x41, 0x56, 0x45
  ]);
  assert.deepEqual(
    validateSoundFileMeta({ name: "alert.wav", sizeBytes: 42_000, headerBytes: wavHeader }),
    { valid: true, ext: "wav", mime: "audio/wav", errorKey: null }
  );

  // Valid OGG header (OggS)
  const oggHeader = new Uint8Array([0x4f, 0x67, 0x67, 0x53, 0x00, 0x02]);
  assert.equal(
    validateSoundFileMeta({ name: "soft.OGG", sizeBytes: 120_000, headerBytes: oggHeader }).valid,
    true
  );

  // Valid MP3 ID3 header & MPEG frame sync header
  const mp3Id3 = new Uint8Array([0x49, 0x44, 0x33, 0x04, 0x00]);
  const mp3Sync = new Uint8Array([0xff, 0xfb, 0x90, 0x64]);
  assert.equal(
    validateSoundFileMeta({ name: "chime.mp3", sizeBytes: 85_000, headerBytes: mp3Id3 }).valid,
    true
  );
  assert.equal(
    validateSoundFileMeta({ name: "raw.mp3", sizeBytes: 85_000, headerBytes: mp3Sync }).valid,
    true
  );

  // Reject unsupported extension, empty file, > 5 MB, and corrupt header
  assert.equal(
    validateSoundFileMeta({ name: "script.exe", sizeBytes: 1024 }).errorKey,
    "sound_err_format"
  );
  assert.equal(
    validateSoundFileMeta({ name: "empty.mp3", sizeBytes: 0 }).errorKey,
    "sound_err_empty"
  );
  assert.equal(
    validateSoundFileMeta({ name: "huge.wav", sizeBytes: MAX_CUSTOM_SOUND_BYTES + 1 }).errorKey,
    "sound_err_size"
  );
  assert.equal(
    validateSoundFileMeta({
      name: "fake.wav",
      sizeBytes: 2048,
      headerBytes: new Uint8Array([0x00, 0x01, 0x02, 0x03, 0x04])
    }).errorKey,
    "sound_err_corrupt"
  );
});

test("playReturnSound respects muted toggle, zero volume, and built-in selection", () => {
  setCustomSoundDataUrl("");
  assert.deepEqual(playReturnSound({ selectedSound: "bell", volumePct: 60, muted: true }), {
    played: false,
    reason: "muted",
    soundId: "bell"
  });
  assert.deepEqual(playReturnSound({ selectedSound: "pulse", volumePct: 0, muted: false }), {
    played: false,
    reason: "zero-volume",
    soundId: "pulse"
  });
  assert.deepEqual(playReturnSound({ selectedSound: "tap", volumePct: 75, muted: false }), {
    played: true,
    reason: null,
    soundId: "tap"
  });
});

test("startPresenceAlarm starts and stopPresenceAlarm immediately halts state", () => {
  stopPresenceAlarm();
  assert.equal(isPresenceAlarmPlaying(), false);
  startPresenceAlarm({ volumeCapPct: 70, maxDurationSec: 30 });
  assert.equal(isPresenceAlarmPlaying(), true);
  stopPresenceAlarm();
  assert.equal(isPresenceAlarmPlaying(), false);
});
