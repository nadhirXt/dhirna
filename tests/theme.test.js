import test from "node:test";
import assert from "node:assert/strict";
import { THEME_STORAGE_KEY, normalizeTheme, applyTheme, getActiveTheme } from "../core/theme.js";

test("THEME_STORAGE_KEY uses Dhirna namespace", () => {
  assert.equal(THEME_STORAGE_KEY, "dhirna_theme");
});

test("normalizeTheme defaults invalid values to dark and preserves light", () => {
  assert.equal(normalizeTheme("light"), "light");
  assert.equal(normalizeTheme("dark"), "dark");
  assert.equal(normalizeTheme("neon"), "dark");
  assert.equal(normalizeTheme(null), "dark");
  assert.equal(normalizeTheme(undefined), "dark");
});

test("applyTheme updates internal active theme state safely without DOM", () => {
  assert.equal(applyTheme("light"), "light");
  assert.equal(getActiveTheme(), "light");
  assert.equal(applyTheme("dark"), "dark");
  assert.equal(getActiveTheme(), "dark");
});
