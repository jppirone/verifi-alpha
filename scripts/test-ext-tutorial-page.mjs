// Extension tutorial page test (prompt EJ, 2026-10-28). No network, no key, no browser.
// Checks ext-tutorial.html: it exists, has the heading, the sentence "Coming soon.", a Close button, the noindex tag, no outside address, no script but the close script,
// and that the page is not wired to the passphrase gate, not linked from the other pages. Mutation controls run in memory.
//   node scripts/test-ext-tutorial-page.mjs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const NOINDEX = '<meta name="robots" content="noindex, nofollow">';
const OTHERS = ["index.html", "candidate.html", "employer.html", "staff.html"];

export function analyze(page, others) {
  const problems = []; let checks = 0;
  const check = (ok, msg) => { checks++; if (!ok) problems.push(msg); };
  check(typeof page === "string" && page.length > 0, "ext-tutorial.html is missing");
  if (typeof page !== "string") return { checks, problems };
  const head = (page.match(/<head[\s\S]*?<\/head>/i) || [""])[0];
  const body = (page.match(/<body[\s\S]*<\/body>/i) || [""])[0];
  check(/<h1>\s*How to attach your resume\s*<\/h1>/.test(body), "the heading 'How to attach your resume' is missing");
  check(body.includes("Coming soon."), "the sentence 'Coming soon.' is missing");
  check(/<button[^>]*id="closeBtn"[^>]*>\s*Close\s*<\/button>/.test(body), "the Close button is missing");
  check(head.includes(NOINDEX) && (page.match(/<meta name="robots"/gi) || []).length === 1, "the noindex tag is missing or repeated");
  check(!/https?:\/\/|\/\/[a-z0-9.-]+\.[a-z]{2,}/i.test(page.replace(/<!DOCTYPE[^>]*>/i, "")), "an outside address appears in the page");
  check(!/@import|<link\b|<img\b|<iframe\b|<source\b|url\(/i.test(page), "an outside font, stylesheet, image or frame is referenced");
  const scripts = page.match(/<script\b[^>]*>[\s\S]*?<\/script>/gi) || [];
  check(scripts.length === 1, `expected exactly one script, found ${scripts.length}`);
  check(scripts.every((s) => !/\bsrc\s*=/i.test(s)), "a script loads from a file");
  const code = scripts.join("");
  check(code.includes("window.close()") && code.includes("You can close this tab now."), "the close script does not call window.close() with the fallback line");
  check(!/fetch\(|XMLHttpRequest|supabase|localStorage|sessionStorage|navigator\.sendBeacon|eval\(/i.test(code), "the script does a data call or stores something");
  check(!/alpha-gate/.test(page), "the page is wired to the passphrase gate");
  check(!/[\u2014]/.test(page) && !/[^\x00-\x7f]/.test(page), "the page has an em dash or a non-ASCII character");
  for (const [n, t] of Object.entries(others || {})) check(!t.includes("ext-tutorial"), `${n} links to the tutorial page`);
  return { checks, problems };
}

const read = (n) => { const p = path.join(ROOT, n); return fs.existsSync(p) ? fs.readFileSync(p, "utf8") : undefined; };
const page = read("ext-tutorial.html");
const others = Object.fromEntries(OTHERS.map((n) => [n, read(n)]).filter(([, t]) => t !== undefined));
let bad = 0; const out = [];
const ok = (cond, name, extra = "") => { if (!cond) bad++; out.push(`${cond ? "PASS" : "FAIL"}  ${name}${cond ? "" : "  " + extra}`); };

const base = analyze(page, others);
ok(base.problems.length === 0, `ext-tutorial.html as it stands, ${base.checks} checks`, base.problems.join("; "));

const plants = [
  ["a missing file", undefined],
  ["no heading", page.replace("How to attach your resume</h1>", "Welcome</h1>")],
  ["no Coming soon sentence", page.replace("Coming soon.", "Soon.")],
  ["no Close button", page.replace('id="closeBtn"', 'id="x"')],
  ["no noindex tag", page.replace(NOINDEX, "")],
  ["an outside font", page.replace("<style>", "<style>@import url('https://fonts.example/x.css');")],
  ["an outside script", page.replace("<script>", '<script src="https://cdn.example/a.js"></script>\n<script>')],
  ["a second script", page.replace("</body>", "<script>var a = 1;</script></body>")],
  ["the gate script added", page.replace("<style>", '<script src="js/alpha-gate.js"></script><style>')],
  ["a data call in the script", page.replace("window.close();", "window.close(); fetch('/x');")],
  ["no fallback line", page.replace("You can close this tab now.", "Done.")],
  ["an em dash", page.replace("Coming soon.", "Coming soon \u2014 really.")],
];
for (const [name, bad_] of plants) ok(analyze(bad_, others).problems.length > 0, `plant: ${name} is caught`, "MISSED");
ok(analyze(page, { ...others, "index.html": (others["index.html"] || "") + '<a href="ext-tutorial">x</a>' }).problems.length > 0, "plant: a link from another page is caught", "MISSED");
const nothing = analyze(page.replace("THIS TEXT IS NOT IN THE FILE", "x"), others);
ok(nothing.problems.length === 0, "plant pointed at nothing leaves the checks passing", nothing.problems.join("; "));

console.log(out.join("\n"));
console.log(`\nTOTAL: ${out.length - bad} passed, ${bad} failed`);
process.exit(bad ? 1 : 0);
