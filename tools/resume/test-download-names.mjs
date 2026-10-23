// node tools/resume/test-download-names.mjs   (no network, no model call, no database; the page code is cut out of candidate.html and run)
// BR (October 23, 2026): every candidate download carries a standard, findable file name.
//   PDF  First-Last-Resume-Applitrust.pdf   JSON  First-Last-Applitrust-JSON-Resume-YYYY-MM-DD.json   (names from the SAVED identity, computed at the click)
// employer.html has no download of the comparison today (it shows the document in an embedded viewer), so it gets no name function; test 14 pins that.
// Each rule has a planted bug that is shown to be caught. NOT proved: a real download into a real Downloads folder in each browser.
import assert from "node:assert/strict";
import fs from "node:fs";
import { execFileSync } from "node:child_process";

const repo = new URL("../../", import.meta.url);
const rd = (f) => fs.readFileSync(new URL(f, repo), "utf8").replace(/\r\n/g, "\n");
const BASE = process.env.BR_BASE || "b1a44b0";
const BR_HEAD = "8b6dbec";   // BU (October 23, 2026): the BR checks below look at the BR commits (BASE to BR_HEAD); the BU build has its own test file (test-download-names-bu.mjs)
const git = (...a) => execFileSync("git", a, { cwd: repo, maxBuffer: 1 << 28 }).toString().replace(/\r\n/g, "\n");
const CAND = rd("candidate.html"), EMP = rd("employer.html");
const OLD = git("show", BASE + ":candidate.html"), OLD_EMP = git("show", BASE + ":employer.html");
const tests = []; const t = (name, fn) => tests.push([name, fn]);
function method(src, name) { let s = src.indexOf("\n  " + name + "("); if (s < 0) s = src.indexOf("\n  async " + name + "("); if (s < 0) return ""; return src.slice(s + 1, src.indexOf("\n  }\n", s) + 4); }
const NAMEFN = method(CAND, "downloadFileName");
assert.ok(NAMEFN.length > 400, "downloadFileName found in candidate.html");
const nameFnFrom = (src) => new Function("return class P { " + src + " }")().prototype.downloadFileName;

// Everything that must hold; returns the list of failed checks (empty = good), so a planted bug can be shown to produce a non-empty list.
const D = new Date(2026, 9, 23, 10, 5, 0);   // local October 23, 2026
function checks(fn) {
  const bad = []; const eq = (label, got, want) => { if (got !== want) bad.push(label + ": got " + got + " want " + want); };
  const pdf = (f, l) => fn("pdf", f, l, D), js = (f, l, d = D) => fn("json", f, l, d);
  eq("plain", pdf("John", "Doe"), "John-Doe-Resume-Applitrust.pdf");
  eq("json plain", js("John", "Doe"), "John-Doe-Applitrust-JSON-Resume-2026-10-23.json");
  eq("hyphenated", pdf("Mary-Jane", "Smith-Jones"), "Mary-Jane-Smith-Jones-Resume-Applitrust.pdf");
  eq("spaces", pdf("Mary Ann", "Van  Der Berg"), "Mary-Ann-Van-Der-Berg-Resume-Applitrust.pdf");
  eq("accents", pdf("José", "Müller"), "Jose-Muller-Resume-Applitrust.pdf");
  eq("accents2", pdf("Ångström", "Čeh"), "Angstrom-Ceh-Resume-Applitrust.pdf");
  eq("o-slash and l-stroke", pdf("Søren", "Łukasz"), "Soren-Lukasz-Resume-Applitrust.pdf");
  eq("apostrophe", pdf("Sean", "O'Brien"), "Sean-OBrien-Resume-Applitrust.pdf");
  eq("typographic apostrophe", pdf("Sean", "O’Brien"), "Sean-OBrien-Resume-Applitrust.pdf");
  for (const ch of ["/", "\\", ":", "*", "?", '"', "<", ">", "|", "\u0000", "\u0007", "\n", "\t"]) eq("unsafe " + JSON.stringify(ch), pdf("Jo" + ch + "hn", "Do" + ch + "e"), ch === "\n" || ch === "\t" ? "Jo-hn-Do-e-Resume-Applitrust.pdf" : "John-Doe-Resume-Applitrust.pdf");
  eq("emoji and non latin", pdf("Ann\u{1F600}a", "张伟"), "Anna-Resume-Applitrust.pdf");
  eq("nothing left", pdf("张", "伟"), "Resume-Applitrust.pdf");
  eq("first only", pdf("John", ""), "John-Resume-Applitrust.pdf");
  eq("last only", pdf("", "Doe"), "Doe-Resume-Applitrust.pdf");
  eq("both empty", pdf("", ""), "Resume-Applitrust.pdf");
  eq("null and undefined", pdf(null, undefined), "Resume-Applitrust.pdf");
  eq("punctuation only", pdf("...", "!!!"), "Resume-Applitrust.pdf");
  eq("json both empty", js("", ""), "Applitrust-JSON-Resume-2026-10-23.json");
  eq("json first only", js("John", ""), "John-Applitrust-JSON-Resume-2026-10-23.json");
  eq("json last only", js("", "Doe"), "Doe-Applitrust-JSON-Resume-2026-10-23.json");
  eq("repeated hyphens", pdf("A--B", "C---D"), "A-B-C-D-Resume-Applitrust.pdf");
  eq("hyphens trimmed", pdf("-John-", "--Doe--"), "John-Doe-Resume-Applitrust.pdf");
  eq("cut at 30", pdf("A".repeat(50), "B".repeat(45)), "A".repeat(30) + "-" + "B".repeat(30) + "-Resume-Applitrust.pdf");
  eq("cut ends on a hyphen", pdf("A".repeat(29) + " BBB", "x"), "A".repeat(29) + "-x-Resume-Applitrust.pdf");
  eq("zero padded date", js("J", "D", new Date(2026, 0, 5, 9, 0, 0)), "J-D-Applitrust-JSON-Resume-2026-01-05.json");
  return bad;
}

t("1. the name function: plain, hyphenated, spaced, accented, apostrophes, unsafe characters, emoji, empty, long, punctuation only, zero padded date", () => { assert.deepEqual(checks(nameFnFrom(NAMEFN)), []); });

// ---- planted bugs in the name function: each mutation must make checks() fail
const MUT = [
  ["accents not folded", (s) => s.replace(".normalize('NFKD')", "")],
  ["o-slash not folded", (s) => s.replace(".replace(/[^ -~]/g, (c) => fold[c.charCodeAt(0)] || c)", "")],
  ["apostrophe becomes a hyphen", (s) => s.replace(".replace(quotes, '')", ".replace(quotes, '-')")],
  ["spaces dropped", (s) => s.replace(".replace(/\\s+/g, '-')", ".replace(/\\s+/g, '')")],
  ["unsafe characters kept", (s) => s.replace(".replace(/[^A-Za-z0-9-]/g, '')", ".replace(/[\\u0000-\\u001f]/g, '')")],
  ["no cut at 30", (s) => s.replace(".slice(0, 30)", ".slice(0, 300)")],
  ["repeated hyphens kept", (s) => s.replace(".replace(/-+/g, '-')", "")],
  ["hyphens not trimmed", (s) => s.replace(".replace(/^-+|-+$/g, '')", "")],
  ["hyphen left after the cut", (s) => s.replace(".slice(0, 30).replace(/-+$/, '')", ".slice(0, 30)")],
  ["empty parts joined", (s) => s.replace("[part(first), part(last)].filter(Boolean)", "[part(first), part(last)]")],
  ["no fallback name", (s) => s.replace("pre + 'Resume-Applitrust.pdf'", "names + '-Resume-Applitrust.pdf'")],
  ["date not padded", (s) => s.replace(".padStart(2, '0')", "").replace(".padStart(2, '0')", "")],
];
for (const [label, mut] of MUT) t("2. planted bug caught: " + label, () => {
  const src = mut(NAMEFN); assert.notEqual(src, NAMEFN, "the planted change applied");
  assert.ok(checks(nameFnFrom(src)).length > 0, "checks() did not notice: " + label);
});

// ---- the local date, in two zones where the UTC date and the local date differ (child process with TZ set)
function inZone(tz, srcText, iso) {
  const code = "const C=new Function('return class P { '+process.argv[1]+' }')();const o=new Date(process.argv[2]);console.log(JSON.stringify({off:o.getTimezoneOffset(),utc:o.toISOString().slice(0,10),name:C.prototype.downloadFileName('json','A','B',o)}));";
  return JSON.parse(execFileSync(process.execPath, ["-e", code, srcText, iso], { env: { ...process.env, TZ: tz } }).toString().trim());
}
t("3. the date is the LOCAL date: east of UTC (the UTC date is a day behind) and west of UTC (the UTC date is a day ahead)", () => {
  const east = inZone("Pacific/Kiritimati", NAMEFN, "2026-10-23T12:00:00Z");
  assert.equal(east.off, -840); assert.equal(east.utc, "2026-10-23"); assert.equal(east.name, "A-B-Applitrust-JSON-Resume-2026-10-24.json");
  const west = inZone("America/Los_Angeles", NAMEFN, "2026-10-24T03:00:00Z");
  assert.equal(west.off, 420); assert.equal(west.utc, "2026-10-24"); assert.equal(west.name, "A-B-Applitrust-JSON-Resume-2026-10-23.json");
});
t("3b. planted: the UTC version gives the wrong day in both zones", () => {
  const bad = NAMEFN.replace("d.getFullYear()", "d.getUTCFullYear()").replace("d.getMonth()", "d.getUTCMonth()").replace("d.getDate()", "d.getUTCDate()");
  assert.equal(inZone("Pacific/Kiritimati", bad, "2026-10-23T12:00:00Z").name.includes("2026-10-24"), false);
  assert.equal(inZone("America/Los_Angeles", bad, "2026-10-24T03:00:00Z").name.includes("2026-10-23"), false);
});

// ---- the click: PDF
const PDFBLOCK = (src) => { const a = src.indexOf("downloadPdf: () => {"); return src.slice(a, src.indexOf("\n      },\n", a) + 8); };
function pdfClick(block, state, cached) {
  let anchor = null;
  const doc = { createElement: () => (anchor = { click() { this.clicked = true; }, remove() {} }), body: { appendChild() {} } };
  const self = { _pdfBlobUrl: "blob:x", _pdfFilename: cached, state, syncPdfBlobToAtidSwitches() {}, downloadFileName: nameFnFrom(NAMEFN) };
  const make = new Function("document", "return (function(){ return ({" + block + "}); })");
  make(doc).call(self).downloadPdf();
  return anchor;
}
t("4. PDF click: named at the click from the saved identity; a name saved after the preview was built is used; the profile fields are not", () => {
  const block = PDFBLOCK(CAND);
  assert.ok(block.length > 100);
  const st = { savedFirst: "Ana", savedLast: "Lee", profileFirst: "Typed", profileLast: "NotSaved" };
  assert.equal(pdfClick(block, st, "resume.pdf").download, "Ana-Lee-Resume-Applitrust.pdf");
  st.savedFirst = "Maria"; st.savedLast = "Silva-Costa";
  const a = pdfClick(block, st, "Ana-Lee-Resume-Applitrust.pdf");
  assert.equal(a.download, "Maria-Silva-Costa-Resume-Applitrust.pdf"); assert.equal(a.clicked, true);
});
t("4b. planted: a name reused from the preview build is caught", () => {
  const bad = PDFBLOCK(CAND).replace(/a\.download = [^\n]*/, "a.download = this._pdfFilename;");
  const a = pdfClick(bad, { savedFirst: "Maria", savedLast: "Silva" }, "Ana-Lee-Resume-Applitrust.pdf");
  assert.notEqual(a.download, "Maria-Silva-Resume-Applitrust.pdf");
});
t("4c. planted: the unsaved profile fields are caught", () => {
  const bad = PDFBLOCK(CAND).replace("this.state.savedFirst, this.state.savedLast", "this.state.profileFirst, this.state.profileLast");
  const a = pdfClick(bad, { savedFirst: "Ana", savedLast: "Lee", profileFirst: "Typed", profileLast: "NotSaved" }, "");
  assert.notEqual(a.download, "Ana-Lee-Resume-Applitrust.pdf");
});

// ---- the click: JSON (the real exportVerifiedData of the old and the new page against the same stand-in)
async function runExport(src, state, mutateDuringWait) {
  const P = new Function("return class P { " + method(src, "exportVerifiedData") + " " + NAMEFN + " buildDataExport(ex, ver, who) { return { ex, who, ver: Object.keys(ver).sort() }; } candidateSessionToken() { return 't'; } addActivityLog() {} }")();
  const p = new P(); p.state = state; p.SUPABASE_FN_URL = "http://fn.test"; p.SUPABASE_ANON_KEY = "k";
  let anchor = null, blob = null;
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (u) => { await new Promise((r) => setTimeout(r, 5)); if (mutateDuringWait) mutateDuringWait(state); return new Response(JSON.stringify({ ok: true, summaries: [], work: [] }), { status: 200 }); };
  globalThis.window = { alert() { throw new Error("alert"); } };
  globalThis.document = { createElement: () => (anchor = { click() {}, remove() {} }), body: { appendChild() {} } };
  const o1 = URL.createObjectURL, o2 = URL.revokeObjectURL;
  URL.createObjectURL = (b) => { blob = b; return "blob:y"; }; URL.revokeObjectURL = () => {};
  try { await p.exportVerifiedData(); } finally { globalThis.fetch = realFetch; URL.createObjectURL = o1; URL.revokeObjectURL = o2; }
  return { name: anchor.download, text: await blob.text() };
}
const ST = () => ({ resumeCandidateId: "c1", savedFirst: "Ana", savedLast: "Lee", accountType: "full", atidExportJson: false, email: "a@example.test" });
t("5. JSON click: the new name, and the JSON text is byte for byte what the previous commit produced for the same input", async () => {
  const now = await runExport(CAND, ST()), before = await runExport(OLD, ST());
  assert.equal(before.name, "verifi-my-data.json");
  assert.match(now.name, /^Ana-Lee-Applitrust-JSON-Resume-\d{4}-\d{2}-\d{2}\.json$/);
  assert.equal(now.text, before.text);
});
t("6. JSON click: named at the click; a saved name that changes while the data loads does not change the name; a changed saved name changes the next one", async () => {
  const a = await runExport(CAND, ST(), (s) => { s.savedFirst = "Changed"; });
  assert.match(a.name, /^Ana-Lee-Applitrust/);
  const st = ST(); st.savedFirst = "Maria"; st.savedLast = "Silva";
  assert.match((await runExport(CAND, st)).name, /^Maria-Silva-Applitrust/);
});
t("6b. planted: naming after the wait is caught", async () => {
  const src = CAND.replace("const downloadName = this.downloadFileName('json', s.savedFirst, s.savedLast, new Date());", "").replace("a.download = downloadName;", "a.download = this.downloadFileName('json', s.savedFirst, s.savedLast, new Date());");
  assert.notEqual(src, CAND);
  const a = await runExport(src, ST(), (s) => { s.savedFirst = "Changed"; });
  assert.doesNotMatch(a.name, /^Ana-Lee-Applitrust/);
});
t("6c. planted: the unsaved profile fields in the JSON name are caught", async () => {
  const src = CAND.replace("this.downloadFileName('json', s.savedFirst, s.savedLast, new Date());   // BR", "this.downloadFileName('json', s.profileFirst, s.profileLast, new Date());   // BR");
  assert.notEqual(src, CAND);
  const st = ST(); st.profileFirst = "Typed"; st.profileLast = "Only";
  assert.doesNotMatch((await runExport(src, st)).name, /^Ana-Lee/);
});

// ---- content unchanged and nothing else changed
t("7. the PDF writer, the line builders and the JSON builder are the same text as before (same input gives the same bytes)", () => {
  for (const m of ["buildAtsPdfBytes", "buildResumeLines", "buildDataExport", "syncPdfBlobToAtidSwitches", "renderPdfPreview"]) {
    const a = method(OLD, m), b = method(CAND, m); assert.ok(a.length > 50 || m === "renderPdfPreview" || a.length > 0, m);
    if (m !== "renderPdfPreview") assert.equal(b, a, m);
  }
});
t("8. the only changed file besides this test is candidate.html, and the changed lines are exactly the BR lines", () => {
  const files = git("diff", "--name-only", BASE, BR_HEAD).split("\n").filter(Boolean).filter((f) => f !== "tools/resume/test-download-names.mjs" && f !== "tools/resume/test-job-heading.mjs");
  assert.deepEqual(files, ["candidate.html"]);
  const diff = git("diff", "-U0", BASE, BR_HEAD, "--", "candidate.html").split("\n").filter((l) => /^[-+]/.test(l) && !/^(---|\+\+\+)/.test(l));
  const removed = diff.filter((l) => l[0] === "-").map((l) => l.slice(1).trim()), added = diff.filter((l) => l[0] === "+").map((l) => l.slice(1).trim());
  assert.deepEqual(removed.sort(), [
    "a.download = 'verifi-my-data.json';", "a.download = this._pdfFilename || 'resume.pdf';", "this._pdfFilename = 'resume.pdf';",
  ].sort());
  assert.ok(added.some((l) => l.startsWith("downloadFileName(kind, first, last, when)")));
  assert.ok(added.some((l) => l === "a.download = downloadName;"));
  assert.ok(added.some((l) => l.startsWith("a.download = this.downloadFileName('pdf', this.state.savedFirst, this.state.savedLast, new Date());")));
});
t("9. no em dash and no spaced double hyphen was added", () => {
  const added = git("diff", "-U0", BASE, BR_HEAD, "--", "candidate.html").split("\n").filter((l) => l[0] === "+" && !l.startsWith("+++"));
  const DASH2 = String.fromCharCode(32, 45, 45, 32), EM = String.fromCharCode(0x2014);
  for (const l of added) { assert.equal(l.includes(EM), false, l.slice(0, 80)); assert.equal(l.includes(DASH2), false, l.slice(0, 80)); }
  const self = fs.readFileSync(new URL("tools/resume/test-download-names.mjs", repo), "utf8");
  assert.equal(self.includes(EM) || self.includes(DASH2), false, "this test file");
});
t("10. nothing in the page still uses the old names", () => {
  assert.equal(/resume\.pdf'|verifi-my-data/.test(CAND.split("\n").filter((l) => !l.includes("BR")).join("\n").replace(/original_filename[^\n]*/g, "")), false);
  assert.equal(CAND.includes("_pdfFilename"), false);
});
t("11. at the BR commit the activity CSV names were unchanged on purpose (BU changes them; see test-download-names-bu.mjs)", () => {
  const br = git("show", BR_HEAD + ":candidate.html");
  assert.ok(br.includes("a.download = 'activity-' + s.activityStart + '-to-' + s.activityEnd + '.csv';"));
  assert.ok(br.includes("a.download = 'activity' + (this.state.licActStart"));
});
t("12. the name function uses no this, no state, no clock of its own besides the date argument (it is pure)", () => {
  assert.equal(/\bthis\b|\bstate\b/.test(NAMEFN.replace(/^\s*\/\/[^\n]*\n/gm, "").replace(/Callers pass[^\n]*/g, "")), false);
  assert.equal(NAMEFN.includes("Date.now"), false);
});
t("13. the page text never describes the name or the download with a guarantee, score or percent in the added lines", () => {
  const added = git("diff", "-U0", BASE, BR_HEAD, "--", "candidate.html").split("\n").filter((l) => l[0] === "+" && !l.startsWith("+++")).join("\n");
  assert.equal(/guarantee|percent|score|%/i.test(added.replace(/ZZZ/g, "")), false);
});
t("14. at the BR commit employer.html was unchanged and had no download of the comparison to name (BU adds the Download PDF button; see test-download-names-bu.mjs)", () => {
  const empBr = git("show", BR_HEAD + ":employer.html");
  assert.equal(empBr, OLD_EMP);
  assert.equal(/\.download\s*=|download=/.test(empBr), false);
  assert.equal(/downloadFileName/.test(empBr), false);
});

let failed = 0;
for (const [name, fn] of tests) {
  try { await fn(); console.log("  ok   " + name); } catch (e) { failed++; console.log("  FAIL " + name + "\n       " + String(e?.message ?? e).split("\n").slice(0, 6).join("\n       ")); }
}
console.log(`\n${tests.length - failed} passed, ${failed} failed`);
if (failed) process.exit(1);
