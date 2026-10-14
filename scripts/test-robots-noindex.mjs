// Robots file and noindex test (prompt AP4, 2026-10-14). No network, no key, no browser.
// Fails if any tracked HTML page lacks the noindex tag in its head, or robots.txt is missing or does not disallow everything.
// Mutation controls run in memory (nothing on disk is touched).
//   node scripts/test-robots-noindex.mjs
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const TAG = '<meta name="robots" content="noindex, nofollow">';

export function analyze(pages, robots) {
  const problems = []; let checks = 0;
  const check = (ok, msg) => { checks++; if (!ok) problems.push(msg); };
  check(Object.keys(pages).length > 0, "no html pages found");
  for (const [name, text] of Object.entries(pages)) {
    const head = (text.match(/<head[\s\S]*?<\/head>/i) || [text.slice(0, 4000)])[0];
    check(head.includes(TAG), `${name}: the noindex tag is missing from the head`);
    check((text.match(/<meta name="robots"/gi) || []).length === 1, `${name}: expected exactly one robots meta tag`);
  }
  check(typeof robots === "string", "robots.txt is missing");
  if (typeof robots === "string") {
    const lines = robots.split(/\r?\n/).map((l) => l.trim().toLowerCase()).filter((l) => l && !l.startsWith("#"));
    check(lines.includes("user-agent: *"), "robots.txt has no 'User-agent: *' group");
    check(lines.includes("disallow: /"), "robots.txt does not 'Disallow: /'");
    check(!lines.some((l) => l === "allow: /" || l === "disallow:"), "robots.txt allows everything or part of the site");
  }
  return { checks, problems };
}

function load() {
  const ls = spawnSync("git", ["ls-files", "*.html"], { cwd: ROOT, encoding: "utf8" });
  const names = ls.stdout.split(/\r?\n/).filter(Boolean);
  const pages = {}; for (const n of names) pages[n] = fs.readFileSync(path.join(ROOT, n), "utf8");
  const rp = path.join(ROOT, "robots.txt");
  return { pages, robots: fs.existsSync(rp) ? fs.readFileSync(rp, "utf8") : undefined };
}

const { pages, robots } = load();
let bad = 0; const out = [];
const ok = (cond, name, extra = "") => { if (!cond) bad++; out.push(`${cond ? "PASS" : "FAIL"}  ${name}${cond ? "" : "  " + extra}`); };

const base = analyze(pages, robots);
ok(base.problems.length === 0, `repository as it stands: ${Object.keys(pages).length} html pages (${Object.keys(pages).join(", ")}) and robots.txt, ${base.checks} checks`, base.problems.join("; "));

const first = Object.keys(pages)[0];
const m1 = analyze({ ...pages, [first]: pages[first].replace(TAG, "") }, robots);
ok(m1.problems.length > 0, `plant 1: a page without the tag (${first}) is caught`, "MISSED");
const m2 = analyze(pages, "User-agent: *\nDisallow:\n");
ok(m2.problems.length > 0, "plant 2: a robots.txt that allows all is caught", "MISSED");
const m3 = analyze(pages, undefined);
ok(m3.problems.length > 0, "plant 3: a missing robots.txt is caught", "MISSED");
const m4 = analyze({ ...pages, [first]: pages[first].replace("THIS TEXT IS NOT IN THE FILE", "x") }, robots);
ok(m4.problems.length === 0 && pages[first].replace("THIS TEXT IS NOT IN THE FILE", "x") === pages[first], "plant 4: a plant pointed at nothing leaves the checks passing", m4.problems.join("; "));

console.log(out.join("\n"));
console.log(`\nTOTAL: ${out.length - bad} passed, ${bad} failed`);
process.exit(bad ? 1 : 0);
