import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  createDefaultState,
  DEFAULT_USB_SOCIAL_APP_IDS,
  normalizeUsbBlockedApps
} from "../core/state.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BRIDGE_DIR = path.join(ROOT, "desktop", "src-tauri", "src");

test("createDefaultState enables all 7 USB social apps (including Snapchat) by default", () => {
  const s = createDefaultState();
  assert.equal(s.usbReelsEnabled, true);
  assert.deepEqual(s.usbBlockedApps, DEFAULT_USB_SOCIAL_APP_IDS);
  assert.ok(s.usbBlockedApps.includes("instagram"));
  assert.ok(s.usbBlockedApps.includes("snapchat"));
  assert.ok(s.usbBlockedApps.includes("tiktok"));
  assert.deepEqual(normalizeUsbBlockedApps(["snapchat", "invalid", "tiktok", "snapchat"]), [
    "snapchat",
    "tiktok"
  ]);
});

test("ios_usb_bridge detects Snapchat/Instagram bursts, cuts fast on app switch, and cuts instantly on screen lock", () => {
  const pyCheck = `
import sys
sys.path.insert(0, ${JSON.stringify(BRIDGE_DIR)})
import ios_usb_bridge as b

assert "snapchat" in b.TRACKED_APPS
assert b.BUNDLE_ID_TO_APP["com.toyopagroup.picaboo"] == "snapchat"

tr = b.AppStreamTracker("snapchat")

# 1. Idle background push while unlocked -> never triggers
tr.add_bytes(1000, 1500, False)
assert tr.evaluate(2500, False, True) is False

# 2. Single 140 KB burst sustains > 34 KB/s over 4s window -> triggers after 1.5s
tr.add_bytes(4000, 140 * 1024, False)
assert tr.evaluate(4000, False, True) is False
assert tr.evaluate(5600, False, True) is True

# 3. Switching to another app while quiet >= 2.5s cuts alarm rapidly
assert tr.evaluate(8500, False, True, other_app_active=True) is False

# 4. Re-trigger then instant cutoff on screen lock
tr.add_bytes(10000, 140 * 1024, False)
assert tr.evaluate(10000, False, True) is False
assert tr.evaluate(11600, False, True) is True
assert tr.evaluate(11700, True, True) is False
print("IOS_TRACKER_OK")
`;
  const out = execFileSync("python3", ["-c", pyCheck], { encoding: "utf8" }).trim();
  assert.equal(out, "IOS_TRACKER_OK");
});
