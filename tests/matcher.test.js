import test from "node:test";
import assert from "node:assert/strict";
import {
  normalizeProcessName,
  isBrowserProcess,
  titleMatchesDomain,
  classifyWindow,
  isOwnDhirnaWindow,
  isTamperOrExtensionManagerWindow
} from "../core/matcher.js";

test("normalizeProcessName strips paths and .exe on Windows and Linux", () => {
  assert.equal(normalizeProcessName("C:\\Program Files\\Mozilla Firefox\\firefox.exe"), "firefox");
  assert.equal(normalizeProcessName("/usr/lib/brave-browser/brave"), "brave");
  assert.equal(normalizeProcessName("Discord.exe"), "discord");
});

test("isBrowserProcess detects major Linux and Windows browsers", () => {
  assert.equal(isBrowserProcess("firefox.exe"), true);
  assert.equal(isBrowserProcess("brave-browser"), true);
  assert.equal(isBrowserProcess("msedge.exe"), true);
  assert.equal(isBrowserProcess("code"), false);
  assert.equal(isBrowserProcess("discord.exe"), false);
});

test("titleMatchesDomain matches real browser window titles across Firefox, Brave, Chrome, Edge", () => {
  assert.equal(titleMatchesDomain("(3) Instagram — Mozilla Firefox", "instagram.com"), true);
  assert.equal(titleMatchesDomain("Instagram - Brave", "instagram.com"), true);
  assert.equal(titleMatchesDomain("Explore / X - Google Chrome", "x.com"), true);
  assert.equal(titleMatchesDomain("Machine Learning - Coursera - Microsoft Edge", "coursera.org"), true);
});

test("classifyWindow prioritizes work apps and work sites to prevent false positives", () => {
  const state = {
    workApps: ["code", "soffice.bin"],
    workSites: ["docs.google.com", "github.com"],
    blockedApps: [{ process: "discord", label: "Discord", kill: false }],
    blacklist: ["instagram.com", "youtube.com"]
  };

  assert.deepEqual(
    classifyWindow({ processName: "code.exe", title: "index.js - Visual Studio Code" }, state),
    { kind: "work", source: "app", entry: "code" }
  );

  assert.deepEqual(
    classifyWindow(
      { processName: "firefox", title: "Stratégie Instagram 2026 - Google Docs — Mozilla Firefox" },
      state
    ),
    { kind: "work", source: "site", entry: "docs.google.com" }
  );

  assert.deepEqual(
    classifyWindow({ processName: "firefox", title: "Instagram — Mozilla Firefox" }, state),
    { kind: "distraction-site", entry: "instagram.com" }
  );

  const discordRes = classifyWindow({ processName: "Discord.exe", title: "#general | Discord" }, state);
  assert.equal(discordRes.kind, "distraction-app");
  assert.equal(discordRes.entry.process, "discord");
});

test("classifyWindow does not mistake external IDEs editing Dhirna for Dhirna itself", () => {
  const state = {
    activeGoal: {
      title: "Coder Antigravity",
      targetType: "app",
      app: "antigravity-editor",
      windowTitle: "dhirna — Antigravity",
      site: ""
    },
    workApps: ["antigravity"]
  };

  assert.equal(isOwnDhirnaWindow("dhirna-desktop", "Dhirna — Focus"), true);
  assert.equal(isOwnDhirnaWindow("antigravity", "dhirna — Antigravity"), false);

  assert.deepEqual(
    classifyWindow({ processName: "antigravity", title: "Dhirna — Antigravity" }, state),
    { kind: "work", source: "app", entry: "antigravity-editor" }
  );

  assert.deepEqual(
    classifyWindow({ processName: "electron", title: "dhirna — Antigravity" }, state),
    { kind: "work", source: "app", entry: "antigravity-editor" }
  );
});

test("classifyWindow flags Reels/Shorts/TikTok during active Focus Timer and unlocks after 00:00", () => {
  const now = new Date(1_800_000_000_000);
  const activeTimerState = {
    blacklist: ["instagram.com", "tiktok.com", "youtube.com"],
    sessionEndsAt: now.getTime() + 60_000,
    shield: { enabled: true, noReels: true }
  };

  const reelWin = classifyWindow(
    { processName: "firefox", title: "Instagram Reels — Mozilla Firefox" },
    activeTimerState,
    now
  );
  assert.equal(reelWin.kind, "distraction-site");
  assert.equal(reelWin.source, "social-shield");

  const ytShortWin = classifyWindow(
    { processName: "brave-browser", title: "Funny Cat #Shorts - YouTube — Brave" },
    activeTimerState,
    now
  );
  assert.equal(ytShortWin.kind, "distraction-site");
  assert.equal(ytShortWin.source, "social-shield");

  const dmWin = classifyWindow(
    { processName: "firefox", title: "Inbox • Direct — Instagram — Mozilla Firefox" },
    activeTimerState,
    now
  );
  assert.equal(dmWin.kind, "neutral");
  assert.equal(dmWin.source, "social-shield-dm");

  const finishedTimerState = {
    blacklist: ["instagram.com", "tiktok.com", "youtube.com"],
    sessionEndsAt: null,
    autoTriggerEnabled: true,
    shield: { enabled: true, noReels: true }
  };
  assert.equal(
    classifyWindow({ processName: "firefox", title: "Instagram Reels — Mozilla Firefox" }, finishedTimerState, now).kind,
    "neutral"
  );
  assert.equal(
    classifyWindow({ processName: "brave", title: "TikTok - Make Your Day — Brave" }, finishedTimerState, now).kind,
    "neutral"
  );
});

test("isTamperOrExtensionManagerWindow and classifyWindow block browser extension manager tampering", () => {
  assert.equal(
    isTamperOrExtensionManagerWindow({
      processName: "chrome",
      title: "Extensions - Google Chrome"
    }),
    true
  );
  assert.equal(
    isTamperOrExtensionManagerWindow({
      processName: "brave-browser",
      title: "brave://extensions - Brave"
    }),
    true
  );
  assert.equal(
    isTamperOrExtensionManagerWindow({
      processName: "firefox",
      title: "Add-ons Manager — Mozilla Firefox"
    }),
    true
  );
  assert.equal(
    isTamperOrExtensionManagerWindow({
      processName: "code",
      title: "Extensions - Visual Studio Code"
    }),
    false
  );

  const stateWithShield = {
    shield: { enabled: true, noReels: true },
    blacklist: []
  };
  const tamperRes = classifyWindow(
    { processName: "brave-browser", title: "Extensions - Brave" },
    stateWithShield
  );
  assert.equal(tamperRes.kind, "distraction-site");
  assert.equal(tamperRes.source, "tamper-guard");
});
