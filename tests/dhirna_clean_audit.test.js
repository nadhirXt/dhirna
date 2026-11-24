import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SKIP_DIRS = new Set([".git", "node_modules", "target", "dist", "gen"]);
const TEXT_EXTS = new Set([
  ".js",
  ".mjs",
  ".json",
  ".html",
  ".css",
  ".rs",
  ".py",
  ".toml",
  ".md",
  ".yml",
  ".yaml",
  ".sh",
  ".ps1",
  ".svg"
]);

function walkFiles(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walkFiles(full, out);
    } else if (
      TEXT_EXTS.has(path.extname(entry.name).toLowerCase()) ||
      entry.name === "LICENSE" ||
      entry.name === ".gitignore" ||
      entry.name === "CODEOWNERS"
    ) {
      out.push(full);
    }
  }
  return out;
}

test("repository has zero residual legacy brand mentions across code, config, and docs", () => {
  const legacyPattern = new RegExp("sn" + "ap[-_ ]?back|foc" + "usguard", "i");
  const hits = [];

  for (const file of walkFiles(ROOT)) {
    const rel = path.relative(ROOT, file);
    if (legacyPattern.test(rel)) {
      hits.push(`filename: ${rel}`);
      continue;
    }
    const content = fs.readFileSync(file, "utf8");
    const lines = content.split(/\r?\n/);
    lines.forEach((line, idx) => {
      if (legacyPattern.test(line)) {
        hits.push(`${rel}:${idx + 1}: ${line.trim().slice(0, 100)}`);
      }
    });
  }

  assert.deepEqual(hits, [], `Residual legacy brand occurrences found:\n${hits.join("\n")}`);
});

test("Rust desktop backend spawns zero Windows PowerShell, cmd, reg, schtasks, or .ps1 scripts", () => {
  const rustSrcDir = path.join(ROOT, "desktop", "src-tauri", "src");
  const forbiddenWinShell = new RegExp(
    'Command::new\\s*\\(\\s*"(?:powershell|pwsh|cmd|reg|schtasks)(?:\\.exe)?"\\s*\\)|\\.ps1\\b|-ExecutionPolicy',
    "i"
  );
  const violations = [];

  for (const file of walkFiles(rustSrcDir)) {
    if (!file.endsWith(".rs")) continue;
    const rel = path.relative(ROOT, file);
    const content = fs.readFileSync(file, "utf8");
    content.split(/\r?\n/).forEach((line, idx) => {
      if (forbiddenWinShell.test(line)) {
        violations.push(`${rel}:${idx + 1}: ${line.trim()}`);
      }
    });
  }

  assert.deepEqual(
    violations,
    [],
    `Forbidden Windows shell spawn detected in Rust:\n${violations.join("\n")}`
  );
});
