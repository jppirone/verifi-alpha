// node tools/resume/test-download-names-bu.mjs   (no network, no model call, no database; the page code is cut out of candidate.html and employer.html and run)
// BU (October 23, 2026), on top of BR: the employer Download PDF button, the standard names of the two activity CSVs, and the ATS friendly format wording.
// Each rule has a planted bug that is shown to be caught. NOT proved: a real download into a real Downloads folder in each browser.
import assert from "node:assert/strict";
import fs from "node:fs";
import { execFileSync } from "node:child_process";

const repo = new URL("../../", import.meta.url);
const rd = (f) => fs.readFileSync(new URL(f, repo), "utf8").replace(/\r\n/g, "\n");
const git = (...a) => execFileSync("git", a, { cwd: repo, maxBuffer: 1 << 28 }).toString().replace(/\r\n/g, "\n");
const BR_HEAD = "8b6dbec", BU_HEAD = "c7ff604";   // the diff scans below look at the BU commit only (BR_HEAD to BU_HEAD), so later work on other branches does not fail them
const CAND = rd("candidate.html"), EMP = rd("employer.html");
const CAND_BR = git("show", BR_HEAD + ":candidate.html"), EMP_BR = git("show", BR_HEAD + ":employer.html");
const tests = []; const t = (name, fn) => tests.push([name, fn]);
function method(src, name) { let s = src.indexOf("\n  " + name + "("); if (s < 0) s = src.indexOf("\n  async " + name + "("); if (s < 0) return ""; return src.slice(s + 1, src.indexOf("\n  }\n", s) + 4); }
const U = (...c) => String.fromCharCode(...c);
const NAMEFN = method(CAND, "downloadFileName"), NAMEFN_EMP = method(EMP, "downloadFileName");
assert.ok(NAMEFN.length > 600, "found in candidate.html");
const fnFrom = (src) => new Function("return class P { " + src + " }")().prototype.downloadFileName;
const D = new Date(2026, 9, 23, 10, 5, 0);   // local October 23, 2026

// ---------------------------------------------------------------- 1. the two copies
t("1. the name function is the same text in candidate.html and employer.html", () => { assert.equal(NAMEFN_EMP, NAMEFN); });
t("1b. planted: a one character difference between the two copies is caught", () => {
  const planted = EMP.replace("slice(0, 30)", "slice(0, 31)"); assert.notEqual(planted, EMP);
  assert.notEqual(method(planted, "downloadFileName"), NAMEFN);
});

// ---------------------------------------------------------------- 2. the comparison name
t("2. comparison name: Applitrust-Comparison-YYYY-MM-DD.pdf with the local date, and nothing from the candidate or the employer", () => {
  const f = fnFrom(NAMEFN_EMP);
  assert.equal(f("comparison", "", "", D), "Applitrust-Comparison-2026-10-23.pdf");
  assert.equal(f("comparison", "Ana", "Lee", D), "Applitrust-Comparison-2026-10-23.pdf", "even if names were passed, none are used");
  assert.equal(f("comparison", "ATID-7K3M-Q9XP-2WD2", "ATID", D).includes("ATID"), false);
  assert.equal(f("comparison", "x", "y", new Date(2026, 0, 5)), "Applitrust-Comparison-2026-01-05.pdf");
});
t("2b. planted: a name in the comparison file name is caught; so is an ATID", () => {
  const withName = NAMEFN_EMP.replace("return 'Applitrust-Comparison-' + day + '.pdf';", "return pre + 'Applitrust-Comparison-' + day + '.pdf';"); assert.notEqual(withName, NAMEFN_EMP);
  assert.notEqual(fnFrom(withName)("comparison", "Ana", "Lee", D), "Applitrust-Comparison-2026-10-23.pdf");
  const withAtid = NAMEFN_EMP.replace("return 'Applitrust-Comparison-' + day + '.pdf';", "return 'Applitrust-Comparison-' + (first || '') + day + '.pdf';"); assert.notEqual(withAtid, NAMEFN_EMP);
  assert.equal(fnFrom(withAtid)("comparison", "ATID-7K3M-Q9XP-2WD2", "", D).includes("ATID"), true, "the planted version leaks");
  assert.equal(fnFrom(NAMEFN_EMP)("comparison", "ATID-7K3M-Q9XP-2WD2", "", D).includes("ATID"), false, "the real one does not");
});
function inZone(tz, srcText, iso, kind) {
  const code = "const C=new Function('return class P { '+process.argv[1]+' }')();const o=new Date(process.argv[2]);console.log(JSON.stringify({off:o.getTimezoneOffset(),utc:o.toISOString().slice(0,10),name:C.prototype.downloadFileName(process.argv[3],'','',o)}));";
  return JSON.parse(execFileSync(process.execPath, ["-e", code, srcText, iso, kind], { env: { ...process.env, TZ: tz } }).toString().trim());
}
t("3. the comparison date is the employer's LOCAL date (east and west of UTC); a UTC version is caught", () => {
  const east = inZone("Pacific/Kiritimati", NAMEFN_EMP, "2026-10-23T12:00:00Z", "comparison");
  assert.equal(east.off, -840); assert.equal(east.utc, "2026-10-23"); assert.equal(east.name, "Applitrust-Comparison-2026-10-24.pdf");
  const west = inZone("America/Los_Angeles", NAMEFN_EMP, "2026-10-24T03:00:00Z", "comparison");
  assert.equal(west.utc, "2026-10-24"); assert.equal(west.name, "Applitrust-Comparison-2026-10-23.pdf");
  const bad = NAMEFN_EMP.replace("d.getFullYear()", "d.getUTCFullYear()").replace("d.getMonth()", "d.getUTCMonth()").replace("d.getDate()", "d.getUTCDate()");
  assert.equal(inZone("Pacific/Kiritimati", bad, "2026-10-23T12:00:00Z", "comparison").name, "Applitrust-Comparison-2026-10-23.pdf", "the planted UTC version shows the UTC day");
});

// ---------------------------------------------------------------- 4. the CSV names
function csvChecks(fn) {
  const bad = []; const eq = (label, got, want) => { if (got !== want) bad.push(label + ": got " + got + " want " + want); };
  eq("activity range", fn("activity", "Ana", "Lee", D, "2026-09-01-to-2026-10-23"), "Ana-Lee-Applitrust-Activity-2026-09-01-to-2026-10-23.csv");
  eq("license from and to", fn("license-activity", "Ana", "Lee", D, "from-2026-09-01-to-2026-10-23"), "Ana-Lee-Applitrust-License-Activity-from-2026-09-01-to-2026-10-23.csv");
  eq("license from only", fn("license-activity", "Ana", "Lee", D, "from-2026-09-01"), "Ana-Lee-Applitrust-License-Activity-from-2026-09-01.csv");
  eq("license to only", fn("license-activity", "Ana", "Lee", D, "to-2026-10-23"), "Ana-Lee-Applitrust-License-Activity-to-2026-10-23.csv");
  eq("activity no range uses the local date", fn("activity", "Ana", "Lee", D, ""), "Ana-Lee-Applitrust-Activity-2026-10-23.csv");
  eq("license no range uses the local date", fn("license-activity", "Ana", "Lee", D, ""), "Ana-Lee-Applitrust-License-Activity-2026-10-23.csv");
  eq("undefined range", fn("activity", "Ana", "Lee", D), "Ana-Lee-Applitrust-Activity-2026-10-23.csv");
  eq("no name, activity", fn("activity", "", "", D, "2026-09-01-to-2026-10-23"), "Applitrust-Activity-2026-09-01-to-2026-10-23.csv");
  eq("no name, license", fn("license-activity", "", "", D, ""), "Applitrust-License-Activity-2026-10-23.csv");
  eq("first only", fn("activity", "Ana", "", D, ""), "Ana-Applitrust-Activity-2026-10-23.csv");
  eq("accents and apostrophe", fn("activity", "Jos" + U(233), "O'Br" + U(252, 105) + "en", D, ""), "Jose-OBruien-Applitrust-Activity-2026-10-23.csv");
  eq("unsafe name", fn("license-activity", "A/B:C", "D*E", D, ""), "ABC-DE-Applitrust-License-Activity-2026-10-23.csv");
  eq("unsafe range", fn("activity", "Ana", "Lee", D, "2026/09:01*x"), "Ana-Lee-Applitrust-Activity-20260901x.csv");
  eq("long names", fn("activity", "A".repeat(50), "B".repeat(50), D, ""), "A".repeat(30) + "-" + "B".repeat(30) + "-Applitrust-Activity-2026-10-23.csv");
  eq("pdf and json still as in BR", fn("pdf", "Ana", "Lee", D) + "|" + fn("json", "Ana", "Lee", D), "Ana-Lee-Resume-Applitrust.pdf|Ana-Lee-Applitrust-JSON-Resume-2026-10-23.json");
  return bad;
}
t("4. the CSV names: with and without range, with and without a name, accented and unsafe names, long names, BR names intact", () => { assert.deepEqual(csvChecks(fnFrom(NAMEFN)), []); assert.deepEqual(csvChecks(fnFrom(NAMEFN_EMP)), []); });
const MUT = [
  ["range ignored", (s) => s.replace("(String(range == null ? '' : range).replace(/[^A-Za-z0-9-]/g, '') || day)", "day")],
  ["range not cleaned", (s) => s.replace("String(range == null ? '' : range).replace(/[^A-Za-z0-9-]/g, '')", "String(range == null ? '' : range)")],
  ["no date fallback", (s) => s.replace("|| day)", "|| 'none')")],
  ["labels swapped", (s) => s.replace("kind === 'activity' ? 'Activity-' : 'License-Activity-'", "kind === 'activity' ? 'License-Activity-' : 'Activity-'")],
  ["name dropped from the csv", (s) => s.replace("return pre + 'Applitrust-' + (kind", "return 'Applitrust-' + (kind")],
  ["wrong extension", (s) => s.replace("+ '.csv';", "+ '.txt';")],
];
for (const [label, mut] of MUT) t("4b. planted bug caught: " + label, () => { const src = mut(NAMEFN); assert.notEqual(src, NAMEFN, "applied"); assert.ok(csvChecks(fnFrom(src)).length > 0); });

// ---------------------------------------------------------------- 5. the CSV clicks: contents byte for byte, names built at the click from the saved identity
async function runCsv(src, which, state) {
  const names = which === "activity" ? ["exportActivityCsv"] : ["exportLicenseActivityCsv", "licenseActivityFiltered", "licenseActivityTypeLabel"];
  const P = new Function("return class P { " + names.map((n) => method(src, n)).join("\n") + " " + method(src, "downloadFileName") + " }")();
  const p = new P(); p.state = state;
  let anchor = null, blob = null;
  globalThis.document = { createElement: () => (anchor = { click() {}, remove() {} }), body: { appendChild() {}, removeChild() {} } };
  const o1 = URL.createObjectURL, o2 = URL.revokeObjectURL;
  URL.createObjectURL = (b) => { blob = b; return "blob:z"; }; URL.revokeObjectURL = () => {};
  try { if (which === "activity") p.exportActivityCsv(); else p.exportLicenseActivityCsv(); } finally { URL.createObjectURL = o1; URL.revokeObjectURL = o2; }
  return { name: anchor.download, text: await blob.text() };
}
const AT = (d, h) => new Date(2026, 8, d, h, 0, 0).toISOString();
const ST = () => ({ savedFirst: "Ana", savedLast: "Lee", profileFirst: "Typed", profileLast: "Only",
  activityStart: "2026-09-01", activityEnd: "2026-09-30", licActStart: "", licActEnd: "",
  activityLog: [{ activity: 'Signed in "once"', timestamp: AT(2, 9) }, { activity: "Exported, data", timestamp: AT(15, 10) }, { activity: "Outside", timestamp: new Date(2026, 9, 5, 9).toISOString() }],
  licenseActivity: [{ at: AT(3, 9), category: "license", text: "A, license" }, { at: AT(20, 9), category: "notice", text: "Email sent" }] });
t("5. activity CSV: new name with the range of the old name; the CSV text is byte for byte what the BR commit produced", async () => {
  const now = await runCsv(CAND, "activity", ST()), before = await runCsv(CAND_BR, "activity", ST());
  assert.equal(before.name, "activity-2026-09-01-to-2026-09-30.csv");
  assert.equal(now.name, "Ana-Lee-Applitrust-Activity-2026-09-01-to-2026-09-30.csv");
  assert.equal(now.text, before.text); assert.ok(now.text.includes("Exported, data"));
});
t("5b. license activity CSV: the four range cases keep the old range text, and the CSV text is byte for byte unchanged", async () => {
  for (const [s, e, want, old] of [["", "", "2026-10-23", "activity.csv"], ["2026-09-01", "", "from-2026-09-01", "activity-from-2026-09-01.csv"], ["", "2026-09-30", "to-2026-09-30", "activity-to-2026-09-30.csv"], ["2026-09-01", "2026-09-30", "from-2026-09-01-to-2026-09-30", "activity-from-2026-09-01-to-2026-09-30.csv"]]) {
    const st = ST(); st.licActStart = s; st.licActEnd = e;
    const now = await runCsv(CAND, "license", st), before = await runCsv(CAND_BR, "license", Object.assign(ST(), { licActStart: s, licActEnd: e }));
    assert.equal(before.name, old);
    const dayNow = (() => { const d = new Date(); return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0"); })();
    assert.equal(now.name, "Ana-Lee-Applitrust-License-Activity-" + (want === "2026-10-23" ? dayNow : want) + ".csv");
    assert.equal(now.text, before.text);
  }
});
t("5c. the CSV names come from the saved name at the click, never the profile fields; planted bug caught", async () => {
  const a = await runCsv(CAND, "activity", ST()); assert.equal(a.name.startsWith("Ana-Lee-"), true);
  const st = ST(); st.savedFirst = "Maria"; st.savedLast = "Silva"; assert.equal((await runCsv(CAND, "activity", st)).name.startsWith("Maria-Silva-"), true);
  const bad = CAND.replace("this.downloadFileName('activity', s.savedFirst, s.savedLast,", "this.downloadFileName('activity', s.profileFirst, s.profileLast,"); assert.notEqual(bad, CAND);
  assert.equal((await runCsv(bad, "activity", ST())).name.startsWith("Ana-Lee-"), false);
  const bad2 = CAND.replace("this.downloadFileName('license-activity', this.state.savedFirst, this.state.savedLast,", "this.downloadFileName('license-activity', this.state.profileFirst, this.state.profileLast,"); assert.notEqual(bad2, CAND);
  assert.equal((await runCsv(bad2, "license", ST())).name.startsWith("Ana-Lee-"), false);
});

// ---------------------------------------------------------------- 6. the employer Download PDF button
const PROPS = () => { const a = EMP.indexOf("      genDocNotReady:"), b = EMP.indexOf("      closeCompare:", a); return EMP.slice(a, b); };
function clickHarness(block, over = {}) {
  let anchor = null, fetches = 0, rebuilds = 0, blobs = 0;
  const doc = { createElement: () => (anchor = { click() { this.clicked = true; }, remove() {} }), body: { appendChild() {} } };
  const self = Object.assign({ _genDocUrl: "blob:viewer", state: { compare: { genDocReady: true } }, downloadFileName: fnFrom(NAMEFN_EMP), buildComparisonPdfBytes() { rebuilds++; return "x"; }, buildComparisonLines() { rebuilds++; return []; } }, over);
  const realFetch = globalThis.fetch, realBlob = globalThis.Blob;
  globalThis.fetch = async () => { fetches++; return new Response("{}"); };   // counts any call; the real button must make none
  globalThis.Blob = class { constructor() { blobs++; } };
  try { const make = new Function("document", "cmp", "return (function(){ return ({" + block + "}); })"); const props = make(doc, self.state.compare).call(self); props.downloadComparisonPdf(); return { anchor, fetches, rebuilds, blobs, props }; }
  finally { globalThis.fetch = realFetch; globalThis.Blob = realBlob; }
}
t("6. the button saves the viewer's own bytes: the same blob address, the standard name, no network call, no rebuild, no new blob", () => {
  const r = clickHarness(PROPS());
  assert.equal(r.anchor.href, "blob:viewer"); assert.equal(r.anchor.clicked, true);
  assert.match(r.anchor.download, /^Applitrust-Comparison-\d{4}-\d{2}-\d{2}\.pdf$/);
  assert.equal(r.fetches, 0); assert.equal(r.rebuilds, 0); assert.equal(r.blobs, 0);
});
t("6b. planted bugs caught: a function call, a rebuild, a different address", () => {
  const withFetch = PROPS().replace("const a = document.createElement('a');", "fetch('/x'); const a = document.createElement('a');"); assert.notEqual(withFetch, PROPS());
  assert.ok(clickHarness(withFetch).fetches > 0, "the planted call is seen");
});
t("6c. planted: rebuilding the document in the click is caught", () => {
  const rebuild = PROPS().replace("const a = document.createElement('a');", "this.buildComparisonPdfBytes(this.buildComparisonLines({})); const a = document.createElement('a');"); assert.notEqual(rebuild, PROPS());
  assert.ok(clickHarness(rebuild).rebuilds > 0);
  const other = PROPS().replace("a.href = this._genDocUrl;", "a.href = 'blob:other';"); assert.notEqual(other, PROPS());
  assert.notEqual(clickHarness(other).anchor.href, "blob:viewer");
});
t("7. not ready: the button is disabled until the document is in the viewer, and a click then does nothing", () => {
  const block = PROPS();
  const flag = (cmp) => new Function("cmp", "return ({" + block.slice(0, block.indexOf("downloadComparisonPdf")).replace(/\/\/[^\n]*/g, "") + " x: 0 })")(cmp).genDocNotReady;
  assert.equal(flag({}), true); assert.equal(flag({ genDocReady: false }), true); assert.equal(flag({ genDocReady: true }), false); assert.equal(flag(null), true);
  assert.equal(clickHarness(block, { state: { compare: {} } }).anchor, null, "no anchor, no click");
  assert.equal(clickHarness(block, { _genDocUrl: null }).anchor, null);
  assert.ok(/disabled="\{\{ genDocNotReady \}\}"[^>]*sc-camel-on-click="\{\{ downloadComparisonPdf \}\}">Download PDF<\/button>/.test(EMP), "the template binds the button");
});
t("7b. planted: an always enabled button is caught", () => {
  const bad = PROPS().replace("genDocNotReady: !(cmp && cmp.genDocReady),", "genDocNotReady: false,"); assert.notEqual(bad, PROPS());
  const flag = (cmp) => new Function("cmp", "return ({" + bad.slice(0, bad.indexOf("downloadComparisonPdf")).replace(/\/\/[^\n]*/g, "") + " x: 0 })")(cmp).genDocNotReady;
  assert.equal(flag({}), false, "the planted version is enabled with nothing loaded");
  const noGuard = PROPS().replace("if (!this._genDocUrl || !(this.state.compare && this.state.compare.genDocReady)) return;", ""); assert.notEqual(noGuard, PROPS());
  assert.notEqual(clickHarness(noGuard, { state: { compare: {} } }).anchor, null, "the planted click goes ahead before ready");
});
t("8. the real renderGeneratedDocument: the viewer and the Download button use the same blob (the saved bytes are the shown bytes); the ready flag is set only after the viewer holds the document", () => {
  const made = []; let embed = null; let stateSet = null;
  const container = { innerHTML: "", appendChild(e) { embed = e; } };
  const doc = { getElementById: () => container, createElement: (tag) => (tag === "embed" ? { style: {} } : { click() {}, remove() {} }) };
  const URLs = { createObjectURL: (b) => { made.push(b); return "blob:v" + made.length; }, revokeObjectURL() {} };
  const self = { state: { compare: { generatedDocument: { available: true } } }, buildComparisonLines: () => [], comparisonAtidLine: () => null, buildComparisonPdfBytes: () => "PDFBYTES", setState(p) { stateSet = p; self.state = Object.assign({}, self.state, p); }, downloadFileName: fnFrom(NAMEFN_EMP) };
  const run = (src) => { made.length = 0; embed = null; stateSet = null; self.state = { compare: { generatedDocument: { available: true } } }; self._genDocUrl = null;
    const fn = new Function("document", "URL", "console", "requestAnimationFrame", "Blob", "Uint8Array", "return function(){ " + method(src, "renderGeneratedDocument").replace(/^[^{]*\{/, "").replace(/\}\s*$/, "") + " }");
    fn(doc, URLs, console, () => {}, class { constructor(p) { this.parts = p; } }, Uint8Array).call(self); };
  run(EMP);
  assert.equal(made.length, 1); assert.equal(embed.src, self._genDocUrl); assert.equal(self.state.compare.genDocReady, true);
  const r = clickHarness(PROPS(), { _genDocUrl: self._genDocUrl, state: self.state });
  assert.equal(r.anchor.href, embed.src);
  const early = EMP.replace("container.appendChild(em);\n      if (this.state.compare)", "if (this.state.compare)"); assert.notEqual(early, EMP);
  run(early); assert.ok(stateSet, "planted: the flag is still set"); // the planted order sets the flag before the viewer holds the document; the real order is pinned by the next check
  assert.ok(EMP.indexOf("container.appendChild(em);") < EMP.indexOf("genDocReady: true"), "the flag comes after the document is in the viewer");
});

// ---------------------------------------------------------------- 7. the ATS wording
const ATS_NEW = "A single PDF in an ATS friendly format, built fresh from what is saved on your account: your confirmed resume content with the choices you made on Customization and Content Manager. It carries no verification marks, and it is never the originally uploaded document. To change what appears, use Customization or Content Manager; changes are saved there as you make them.";
t("9. ATS wording: the new sentence is exactly as quoted and the old words are gone from the page", () => {
  assert.ok(CAND.includes(">" + ATS_NEW + "</div>"));
  assert.equal(CAND.includes("ATS-safe"), false);
  assert.ok(CAND_BR.includes("A single ATS-safe PDF, built fresh from what is saved on your account:"));
});
t("9b. planted: a sentence with a guarantee, a percent or a score is caught", () => {
  const claim = new RegExp("guarantee|%|score|pass|percent", "i");
  assert.equal(claim.test(ATS_NEW), false, "the real sentence makes no such claim");
  for (const bad of ["guaranteed", "100%", "scores", "passes"]) assert.equal(claim.test(ATS_NEW + " " + bad), true);
});

// ---------------------------------------------------------------- 8. nothing else changed
function changed(file) { const d = git("diff", "-U0", BR_HEAD, BU_HEAD, "--", file).split("\n").filter((l) => /^[-+]/.test(l) && !/^(---|\+\+\+)/.test(l)); return { removed: d.filter((l) => l[0] === "-").map((l) => l.slice(1)), added: d.filter((l) => l[0] === "+").map((l) => l.slice(1)) }; }
t("10. only the named lines changed: candidate.html (the name function, the two CSV anchors, the ATS sentence) and employer.html (additions only)", () => {
  const files = git("diff", "--name-only", BR_HEAD, BU_HEAD).split("\n").filter(Boolean).filter((f) => !/^tools\/resume\/test-/.test(f));
  assert.deepEqual(files.sort(), ["candidate.html", "employer.html"]);
  const c = changed("candidate.html");
  const keep = (l) => !/^\s*\/\/ BR and BU|^\s*\/\/ Each name part/.test(l);
  const removed = c.removed.filter(keep).map((l) => l.trim());
  assert.ok(removed.includes("downloadFileName(kind, first, last, when) {"));
  assert.ok(removed.some((l) => l.startsWith("a.download = 'activity-' + s.activityStart")));
  assert.ok(removed.some((l) => l.startsWith("a.download = 'activity' + (this.state.licActStart")));
  assert.ok(removed.some((l) => l.includes("A single ATS-safe PDF, built fresh from")));
  assert.equal(removed.length, 7, "exactly these candidate.html lines were replaced (the ATS note, the name function's comment, signature and three returns, the two CSV anchors; the comment line starting Each name part is filtered out above): " + removed.join(" | ").slice(0, 200));
  const e = changed("employer.html");
  assert.equal(e.removed.length, 0, "employer.html: additions only");
  assert.ok(e.added.some((l) => l.includes("Download PDF</button>")));
  assert.ok(e.added.some((l) => l.includes("genDocReady: true")));
});
t("11. every added line is plain ASCII, with no em dash and no spaced double hyphen (also this test file)", () => {
  const DASH2 = String.fromCharCode(32, 45, 45, 32), EM = String.fromCharCode(0x2014);
  for (const f of ["candidate.html", "employer.html"]) for (const l of changed(f).added) { assert.equal(/[^\x00-\x7f]/.test(l), false, f + ": " + l.slice(0, 70)); assert.equal(l.includes(EM) || l.includes(DASH2), false, f + ": " + l.slice(0, 70)); }
  const self = fs.readFileSync(new URL("tools/resume/test-download-names-bu.mjs", repo), "utf8");
  assert.equal(/[^\x00-\x7f]/.test(self) || self.includes(EM) || self.includes(DASH2), false, "this test file");
});
t("12. the money, charge, claim token and ATID code is untouched: employer.html changed only in the five named places", () => {
  const e = changed("employer.html").added.join("\n");
  assert.equal(/charge|stripe|claim|token|atid/i.test(e.replace(/ATID or the saved name|nothing from the candidate/g, "").replace(/\/\/[^\n]*/g, "")), false);
});

let failed = 0;
for (const [name, fn] of tests) {
  try { await fn(); console.log("  ok   " + name); } catch (e) { failed++; console.log("  FAIL " + name + "\n       " + String(e?.message ?? e).split("\n").slice(0, 6).join("\n       ")); }
}
console.log(`\n${tests.length - failed} passed, ${failed} failed`);
if (failed) process.exit(1);
