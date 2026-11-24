import test from "node:test";
import assert from "node:assert/strict";
import {
  SHIELD_PROVIDERS,
  createDefaultShieldState,
  normalizeShieldState,
  isShieldLocked,
  mergeShieldStates,
  formatShieldLockRemaining,
  shouldShieldBlockUrl,
  evaluateSocialShieldUrl,
  buildShieldRules,
  buildIosMobileConfig
} from "../core/shield.js";

test("shield state normalizes providers, merges monotonically, and computes lock remaining time", () => {
  const def = createDefaultShieldState();
  assert.equal(def.enabled, false);
  assert.equal(def.provider, "cleanbrowsing");
  assert.equal(def.safeSearch, true);
  assert.equal(def.youtubeRestricted, false);

  const now = 1_795_100_000_000;
  const locked = normalizeShieldState({
    enabled: true,
    provider: "invalid-id",
    lockUntilMs: now + 2 * 86_400_000 + 3 * 3_600_000,
    updatedAtMs: now
  });
  assert.equal(locked.provider, "cleanbrowsing");
  assert.equal(isShieldLocked(locked, now), true);
  assert.equal(formatShieldLockRemaining(locked, "fr", now), "2 j 3 h");
  assert.equal(formatShieldLockRemaining(locked, "en", now), "2d 3h");
  assert.equal(isShieldLocked(locked, now + 5 * 86_400_000), false);

  const merged = mergeShieldStates(def, locked);
  assert.equal(merged.winner, "remote");
  assert.equal(merged.shield.enabled, true);
  assert.equal(merged.shield.lockUntilMs, locked.lockUntilMs);
});

test("shouldShieldBlockUrl blocks curated adult domains and explicit TLDs when enabled", () => {
  const off = createDefaultShieldState();
  assert.equal(shouldShieldBlockUrl("https://badexample.com/test", off).blocked, false);

  const on = { ...off, enabled: true };
  assert.equal(shouldShieldBlockUrl("https://www.pornhub.com/video", on).blocked, true);
  assert.equal(shouldShieldBlockUrl("https://badexample.com/", on).blocked, true);
  assert.equal(shouldShieldBlockUrl("https://random-site.xxx/page", on).blocked, true);
  assert.equal(shouldShieldBlockUrl("https://overleaf.com/project/1", on).blocked, false);
  assert.equal(shouldShieldBlockUrl("https://github.com/nadhirXt/dhirna", on).blocked, false);
});

test("buildShieldRules generates non-colliding IDs (10000+), SafeSearch, and optional YouTube Restricted", () => {
  const offRules = buildShieldRules({ shield: createDefaultShieldState(), extensionId: "ext123" });
  assert.equal(offRules.length, 0);

  const onSafe = buildShieldRules({
    shield: { enabled: true, safeSearch: true, youtubeRestricted: false },
    extensionId: "ext123"
  });
  assert.ok(onSafe.every((r) => r.id >= 10000 && r.priority === 3));
  assert.ok(onSafe.some((r) => r.id === 10001 && r.action.redirect.regexSubstitution.includes("reason=shield")));
  assert.ok(onSafe.some((r) => r.id === 11001 && r.action.redirect.transform.queryTransform.addOrReplaceParams[0].key === "safe"));
  assert.equal(onSafe.some((r) => r.id === 11101), false);

  const withYt = buildShieldRules({
    shield: { enabled: true, safeSearch: true, youtubeRestricted: true },
    extensionId: "ext123"
  });
  const ytRule = withYt.find((r) => r.id === 11101);
  assert.ok(ytRule);
  assert.equal(ytRule.action.type, "modifyHeaders");
  assert.equal(ytRule.action.requestHeaders[0].header, "YouTube-Restrict");
});

test("buildIosMobileConfig generates pure Dhirna encrypted DNS plist without WebClips for all 3 providers", () => {
  for (const id of Object.keys(SHIELD_PROVIDERS)) {
    const p = SHIELD_PROVIDERS[id];
    const xml = buildIosMobileConfig(id);
    assert.ok(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>'));
    assert.ok(xml.includes("com.dhirna.shield"));
    assert.ok(xml.includes("Dhirna Bouclier"));
    assert.ok(xml.includes("<string>com.apple.dnsSettings.managed</string>"));
    assert.ok(xml.includes("<string>HTTPS</string>"));
    assert.ok(xml.includes(`<string>${p.dohUrl}</string>`));
    assert.ok(xml.includes("<key>OnDemandRules</key>"));
    assert.equal(xml.includes("com.apple.webClip.managed"), false);
  }
});

test("evaluateSocialShieldUrl keeps Direct Messages open, redirects feeds to Inbox, and auto-closes Reels/Shorts/TikTok", () => {
  const shieldOn = normalizeShieldState({ enabled: true, noReels: true });

  assert.equal(evaluateSocialShieldUrl("https://www.instagram.com/direct/inbox/", shieldOn).action, "allow-dm");
  assert.equal(evaluateSocialShieldUrl("https://www.instagram.com/direct/t/12345/", shieldOn).action, "allow-dm");
  assert.equal(evaluateSocialShieldUrl("https://www.messenger.com/t/999", shieldOn).action, "allow-dm");
  assert.equal(evaluateSocialShieldUrl("https://www.facebook.com/messages/t/1", shieldOn).action, "allow-dm");

  const igFeed = evaluateSocialShieldUrl("https://www.instagram.com/", shieldOn);
  assert.equal(igFeed.action, "redirect-inbox");
  assert.equal(igFeed.targetUrl, "https://www.instagram.com/direct/inbox/");

  assert.equal(evaluateSocialShieldUrl("https://www.instagram.com/explore/", shieldOn).action, "redirect-inbox");
  assert.equal(evaluateSocialShieldUrl("https://www.instagram.com/reel/Cxyz123/", shieldOn).action, "close-reel");
  assert.equal(evaluateSocialShieldUrl("https://www.instagram.com/reels/", shieldOn).action, "close-reel");
  assert.equal(evaluateSocialShieldUrl("https://www.youtube.com/shorts/abc123", shieldOn).action, "close-reel");
  assert.equal(evaluateSocialShieldUrl("https://www.youtube.com/watch?v=dQw4w9WgXcQ", shieldOn).action, "allow");
  assert.equal(evaluateSocialShieldUrl("https://www.facebook.com/reel/123", shieldOn).action, "close-reel");
  assert.equal(evaluateSocialShieldUrl("https://www.tiktok.com/@user/video/1", shieldOn).action, "close-reel");

  const shieldNoReelsOff = normalizeShieldState({ enabled: true, noReels: false });
  assert.equal(evaluateSocialShieldUrl("https://www.instagram.com/reels/", shieldNoReelsOff).action, "allow");

  assert.equal(
    evaluateSocialShieldUrl("https://www.instagram.com/reels/", shieldOn, { focusActive: false }).action,
    "allow"
  );
  assert.equal(
    evaluateSocialShieldUrl("https://www.tiktok.com/@user/video/1", shieldOn, { focusActive: false }).action,
    "allow"
  );
  assert.equal(
    evaluateSocialShieldUrl("https://www.youtube.com/shorts/abc123", shieldOn, { focusActive: false }).action,
    "allow"
  );

  const rulesDuringFocus = buildShieldRules({
    shield: shieldOn,
    extensionId: "ext123",
    focusActive: true
  });
  const rulesAfterTimer = buildShieldRules({
    shield: shieldOn,
    extensionId: "ext123",
    focusActive: false
  });
  assert.ok(rulesDuringFocus.some((r) => r.id === 11202));
  assert.equal(rulesAfterTimer.some((r) => r.id === 11202), false);
  assert.ok(rulesAfterTimer.some((r) => r.id === 10001));
});
