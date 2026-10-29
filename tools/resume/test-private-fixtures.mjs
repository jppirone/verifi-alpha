// node tools/resume/test-private-fixtures.mjs   (no network, no model call, no database; needs git)
// Prompt EK (October 28, 2026): stored test documents of a real person live in tools/resume/fixtures-private/ (git-ignored), not in the repository.
// 1. the skip path works: with the private folder absent, a test that needs it skips with "private fixture not present, check skipped" and does not fail.
// 2. guard: no tracked file contains that person's name, her test-account label or the two stored document ids. The strings are built from pieces so this file does not contain them.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { loadPrivate, skipUnless, SKIP_MESSAGE } from "./private-fixtures.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(here, "..", "..");
const tests = []; const t = (name, fn) => tests.push([name, fn]);

// ---------- 1. the skip path ----------
t("the skip message is exactly 'private fixture not present, check skipped'", () => assert.equal(SKIP_MESSAGE, "private fixture not present, check skipped"));
t("loadPrivate returns null for a file that is not there", async () => assert.equal(await loadPrivate("no-such-fixture.ts"), null));
t("skipUnless: a missing fixture logs the message, does not call the test and does not throw", () => {
  const lines = []; let called = false;
  skipUnless(null, "a test that needs a private fixture", () => { called = true; }, (l) => lines.push(l))();
  assert.equal(called, false); assert.equal(lines.length, 1); assert.ok(lines[0].includes(SKIP_MESSAGE));
});
t("skipUnless: a present fixture runs the test and returns its result (a failing test still fails)", () => {
  assert.equal(skipUnless({}, "x", () => 7)(), 7);
  assert.throws(skipUnless({}, "x", () => { throw new Error("boom"); }));
});
t("end to end: a copy of tools/resume WITHOUT fixtures-private runs test-inline-sublabels.ts, prints the skip message, exits 0", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ek-skip-"));
  try {
    fs.cpSync(path.join(ROOT, "tools", "resume"), path.join(tmp, "tools", "resume"), { recursive: true, filter: (p) => !p.includes("fixtures-private") });
    fs.cpSync(path.join(ROOT, "supabase", "functions"), path.join(tmp, "supabase", "functions"), { recursive: true });
    assert.equal(fs.existsSync(path.join(tmp, "tools", "resume", "fixtures-private")), false);
    const r = spawnSync(process.execPath, ["--experimental-strip-types", "tools/resume/test-inline-sublabels.ts"], { cwd: tmp, encoding: "utf8" });
    assert.equal(r.status, 0, (r.stdout + r.stderr).slice(-300));
    assert.ok(r.stdout.includes(SKIP_MESSAGE), "no skip message in the output");
    assert.ok(/\d+ passed, 0 failed/.test(r.stdout));
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

// ---------- 2. the guard ----------
const parts = (...p) => p.join("");
const NEEDLES = [new RegExp(parts("aurora", "\\s+", "cl", "ark"), "i"), new RegExp(parts("ac", "lark"), "i"), new RegExp(parts("6fc7", "7af5"), "i"), new RegExp(parts("797f", "c5d5"), "i")];
export function scan(files) { // files: { name: text }
  const found = [];
  for (const [name, text] of Object.entries(files)) for (const re of NEEDLES) if (re.test(text) || re.test(name)) found.push(name);
  return [...new Set(found)];
}
const tracked = () => execFileSync("git", ["ls-files", "-z"], { cwd: ROOT, encoding: "utf8" }).split("\0").filter(Boolean);
t("guard: no tracked file (name or content) contains the name, the test account label or the two stored document ids", () => {
  const files = {}; for (const f of tracked()) { const p = path.join(ROOT, f); if (fs.existsSync(p) && fs.statSync(p).isFile()) files[f] = fs.readFileSync(p, "latin1"); }
  assert.ok(Object.keys(files).length > 100, "fewer tracked files than expected");
  assert.deepEqual(scan(files), []);
});
t("guard: the private folder is git-ignored and nothing in it is tracked", () => {
  assert.equal(spawnSync("git", ["check-ignore", "-q", "tools/resume/fixtures-private/x.ts"], { cwd: ROOT }).status, 0);
  assert.equal(tracked().filter((f) => f.startsWith("tools/resume/fixtures-private/")).length, 0);
});
t("guard plants: each pattern is caught in a file text and in a file name, and clean text passes", () => {
  const A = parts("Aur", "ora Cl", "ark"), B = parts("ac", "lark"), C = parts("6fc7", "7af5"), D = parts("797f", "c5d5");
  for (const bad of [A, A.toUpperCase(), B, B.toUpperCase(), "doc " + C, D]) assert.deepEqual(scan({ "f.txt": "x " + bad + " y" }), ["f.txt"], bad);
  assert.deepEqual(scan({ [B + ".ts"]: "clean" }), [B + ".ts"]);
  assert.deepEqual(scan({ "f.txt": "Ava Sample, docA, docB, asample" }), []);
});

let failed = 0;
for (const [name, fn] of tests) { try { await fn(); console.log("  ok  ", name); } catch (e) { failed++; console.log("  FAIL", name, "\n     ", String(e.message).split("\n")[0]); } }
console.log(`\n${tests.length - failed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
