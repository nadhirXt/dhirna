import test from "node:test";
import assert from "node:assert/strict";
import {
  createDefaultState,
  normalizeGoal,
  getEffectiveWorkSites,
  getEffectiveWorkApps,
  applyGoalToState,
  isScheduleEntryActive,
  isSessionActive,
  isAutoTriggerActive,
  isBlockingActive,
  isLocked,
  getActivationStatus,
  recordBlockedAttempt,
  normalizePresenceSettings
} from "../core/state.js";

test("createDefaultState starts with empty work targets, sound defaults, and goal onboarding enabled", () => {
  const s = createDefaultState();
  assert.deepEqual(s.workSites, []);
  assert.deepEqual(s.workApps, []);
  assert.equal(s.goalOnboardingDone, false);
  assert.equal(s.activeGoal, null);
  assert.deepEqual(s.sound, {
    selectedSound: "chime",
    volumePct: 70,
    muted: false,
    forceUnmuteOnAlarm: true,
    customSoundName: "",
    customSoundFile: ""
  });
});

test("normalizeGoal and applyGoalToState replace legacy defaults with declared user goal", () => {
  const legacyState = {
    ...createDefaultState(),
    goalOnboardingDone: false,
    workSites: ["docs.google.com", "drive.google.com"],
    workApps: ["code", "soffice.bin"]
  };

  assert.equal(normalizeGoal({ title: "  ", site: "", app: "" }), null);

  const next = applyGoalToState(
    legacyState,
    { title: "Finir rapport PFE", site: "https://www.overleaf.com/project/1", app: "Obsidian.exe" },
    { replaceWorkLists: true, blacklist: ["instagram.com", "youtube.com"] }
  );

  assert.equal(next.goalOnboardingDone, true);
  assert.equal(next.activeGoal?.title, "Finir rapport PFE");
  assert.equal(next.activeGoal?.site, "overleaf.com");
  assert.equal(next.activeGoal?.app, "obsidian");
  assert.equal(next.activeGoal?.targetType, "both");
  assert.deepEqual(next.workSites, ["overleaf.com"]);
  assert.deepEqual(next.workApps, ["obsidian"]);
  assert.deepEqual(getEffectiveWorkSites(next), ["overleaf.com"]);
  assert.deepEqual(getEffectiveWorkApps(next), ["obsidian"]);
  assert.deepEqual(next.blacklist, ["instagram.com", "youtube.com"]);
});

test("isScheduleEntryActive handles standard daytime and overnight windows", () => {
  const daytime = {
    enabled: true,
    days: [1, 2, 3, 4, 5], // Mon..Fri
    start: "09:00",
    end: "17:00"
  };

  // Wednesday 10:30 -> active
  const wedMorning = new Date("2026-11-18T10:30:00");
  assert.equal(isScheduleEntryActive(daytime, wedMorning), true);

  // Wednesday 18:00 -> inactive
  const wedEvening = new Date("2026-11-18T18:00:00");
  assert.equal(isScheduleEntryActive(daytime, wedEvening), false);

  // Overnight schedule: Mon-Fri 22:00 to 02:00
  const overnight = {
    enabled: true,
    days: [1, 2, 3, 4, 5],
    start: "22:00",
    end: "02:00"
  };

  // Friday 23:15 -> active
  assert.equal(isScheduleEntryActive(overnight, new Date("2026-11-20T23:15:00")), true);
  // Saturday 01:15 (carryover from Friday night) -> active
  assert.equal(isScheduleEntryActive(overnight, new Date("2026-11-21T01:15:00")), true);
  // Saturday 23:15 (Saturday not in days) -> inactive
  assert.equal(isScheduleEntryActive(overnight, new Date("2026-11-21T23:15:00")), false);
});

test("isSessionActive and isLocked reflect running timed sessions", () => {
  const now = 1_700_000_000_000;
  const activeState = { sessionEndsAt: now + 60_000 };
  const expiredState = { sessionEndsAt: now - 1000 };

  assert.equal(isSessionActive(activeState, now), true);
  assert.equal(isLocked(activeState, now), true);
  assert.equal(isSessionActive(expiredState, now), false);
  assert.equal(isLocked(expiredState, now), false);
});

test("isAutoTriggerActive activates automatically when a planned work tab is open", () => {
  const state = createDefaultState();
  state.autoTriggerEnabled = true;
  state.manualOn = false;

  assert.equal(isAutoTriggerActive(state, []), false);
  assert.equal(isBlockingActive(state, new Date("2026-11-19T12:00:00"), []), false);

  const openWorkTabs = [{ id: 1, domain: "docs.google.com", title: "Mon Doc" }];
  assert.equal(isAutoTriggerActive(state, openWorkTabs), true);
  assert.equal(isBlockingActive(state, new Date("2026-11-19T12:00:00"), openWorkTabs), true);

  const status = getActivationStatus(state, new Date("2026-11-19T12:00:00"), openWorkTabs);
  assert.equal(status.active, true);
  assert.equal(status.source, "auto");
  assert.match(status.label, /docs\.google\.com/);
});

test("recordBlockedAttempt increments daily total and per-site counter and resets on new day", () => {
  let stats = { date: "2026-11-19", total: 0, perSite: {} };
  stats = recordBlockedAttempt(stats, "instagram.com", "2026-11-19");
  stats = recordBlockedAttempt(stats, "instagram.com", "2026-11-19");
  stats = recordBlockedAttempt(stats, "tiktok.com", "2026-11-19");

  assert.equal(stats.total, 3);
  assert.equal(stats.perSite["instagram.com"], 2);
  assert.equal(stats.perSite["tiktok.com"], 1);

  // Next day reset
  const nextDayStats = recordBlockedAttempt(stats, "instagram.com", "2026-11-20");
  assert.equal(nextDayStats.date, "2026-11-20");
  assert.equal(nextDayStats.total, 1);
  assert.equal(nextDayStats.perSite["instagram.com"], 1);
  assert.equal(nextDayStats.perSite["tiktok.com"], undefined);
});

test("normalizePresenceSettings defaults to 2 min idle and 30s alarm delay", () => {
  assert.deepEqual(normalizePresenceSettings(), {
    presenceCheckEnabled: true,
    presenceIdleMinutes: 2,
    presenceAlarmDelaySeconds: 30
  });
  assert.deepEqual(
    normalizePresenceSettings({ presenceCheckEnabled: false, presenceIdleMinutes: 5 }),
    {
      presenceCheckEnabled: false,
      presenceIdleMinutes: 5,
      presenceAlarmDelaySeconds: 30
    }
  );
  assert.deepEqual(normalizePresenceSettings({ presenceIdleMinutes: 99 }), {
    presenceCheckEnabled: true,
    presenceIdleMinutes: 2,
    presenceAlarmDelaySeconds: 30
  });
});
