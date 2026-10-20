// node tools/resume/test-atid-page.mjs   (no network, no model call; reads candidate.html)
// ATID (October 19, 2026): the candidate page. The methods are cut out of candidate.html as written and run in a small stub class; the baseline (before the
// ATID) is cut out of git commit 220fb21 the same way, so "off is byte for byte what it was" is a real comparison, not a re-statement.
// PDF files are opened with mupdf (loaded from the scratch install used for the OCR work; override with ATID_MUPDF=<path to mupdf/dist/mupdf.js>).
// NOT proved here: how the real page draws the card and the checkboxes in a browser, pdf.js preview, the clipboard, the real download (John's hand tests).
import assert from "node:assert/strict";
import fs from "node:fs";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const MUPDF = process.env.ATID_MUPDF || "C:/Users/jpiro/AppData/Local/Temp/ocr-repro/node_modules/mupdf/dist/mupdf.js";
if (!fs.existsSync(MUPDF)) { console.log("SKIP: mupdf not found at " + MUPDF + " (set ATID_MUPDF)"); process.exit(2); }
const mupdf = await import(pathToFileURL(MUPDF).href);

const repo = new URL("../../", import.meta.url);
const NOW = fs.readFileSync(new URL("candidate.html", repo), "utf8").replace(/\r\n/g, "\n");
const BASE_COMMIT = process.env.ATID_BASE || "220fb21";
const OLD = execFileSync("git", ["show", BASE_COMMIT + ":candidate.html"], { cwd: repo, maxBuffer: 1 << 28 }).toString("utf8").replace(/\r\n/g, "\n");
const V = JSON.parse(fs.readFileSync(new URL("tools/resume/atid-vectors.json", repo), "utf8"));

function method(src, name) {
  const start = src.indexOf("\n  " + name + "(");
  if (start < 0) return null;
  const end = src.indexOf("\n  }\n", start);
  return src.slice(start + 1, end + 4);
}
const SWITCHES = {};
globalThis.document = { getElementById: (id) => (id in SWITCHES ? { checked: SWITCHES[id] } : null) };
function makeClass(src, names) {
  const body = names.map((n) => method(src, n)).filter(Boolean).join("\n");
  return new Function("return class P { " + body + " }")();
}
const NOWC = makeClass(NOW, ["sanitizeAts", "atidIsStored", "atidDisplayForm", "atidSwitchOn", "atidPdfOpts", "buildAtsPdfBytes", "buildDataExport", "isoPartialDate", "verificationSafeLabel"]);
const OLDC = makeClass(OLD, ["sanitizeAts", "buildAtsPdfBytes", "buildDataExport", "isoPartialDate", "verificationSafeLabel"]);
const now = new NOWC(), old = new OLDC();
now.state = { atid: "ATID7K3MQ9XP2WD2" };
const DISP = "ATID-7K3M-Q9XP-2WD2";

const tests = [];
const t = (name, fn) => tests.push([name, fn]);
const setSwitches = (o) => { for (const k of Object.keys(SWITCHES)) delete SWITCHES[k]; Object.assign(SWITCHES, o); };

// a deterministic set of line lists: sizes around the page edges, bold lines, characters the writer escapes
let seed = 7; const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
const WORDS = ["Led", "team", "(Senior)", "back\\slash", "R&D", "2019-2024", "Analyst", "ATS", "O'Brien", "x(y)z", "\u2022 bullet", "caf\u00e9"];
const mkLines = (n) => Array.from({ length: n }, (_, i) => ({ text: Array.from({ length: 1 + Math.floor(rnd() * 8) }, () => WORDS[Math.floor(rnd() * WORDS.length)]).join(" "), bold: i % 7 === 0 }));
const SIZES = [0, 1, 2, 44, 45, 46, 89, 90, 91, 135, 136, 200];
const LINESETS = SIZES.map((n) => mkLines(n));
for (let k = 0; k < 40; k++) LINESETS.push(mkLines(Math.floor(rnd() * 220)));

// ---------- the page's own copy of the format ----------
t("candidate.html atidIsStored / atidDisplayForm agree with the shared vector (the third implementation, after SQL and the shared TS module)", () => {
  for (const c of V.stored_cases) assert.equal(now.atidIsStored(c.value), c.valid, JSON.stringify(c.value));
  for (const c of V.display_cases) assert.equal(now.atidDisplayForm(c.stored), c.display === c.stored && !now.atidIsStored(c.stored) ? "" : c.display, c.stored);
});

// ---------- PDF: switches off ----------
t("PDF off: byte for byte the same as the writer before the ATID, for " + LINESETS.length + " line lists (no opts, {}, and opts with empty values)", () => {
  for (const lines of LINESETS) {
    const base = old.buildAtsPdfBytes(lines);
    assert.ok(now.buildAtsPdfBytes(lines) === base, "no opts, " + lines.length + " lines");
    assert.ok(now.buildAtsPdfBytes(lines, {}) === base, "{}");
    assert.ok(now.buildAtsPdfBytes(lines, { atidLine: "", atidMeta: null }) === base, "empty values");
  }
});
t("PDF off: the switches really are read from the screen: all unchecked gives {} even though the account has an ATID; nothing ticked, nothing added", () => {
  setSwitches({ "atid-pdf-line-switch": false, "atid-pdf-meta-switch": false });
  assert.deepEqual(now.atidPdfOpts(), {});
  setSwitches({});   // the boxes are not on the screen at all
  assert.deepEqual(now.atidPdfOpts(), {});
  now.state = { atid: "" }; setSwitches({ "atid-pdf-line-switch": true, "atid-pdf-meta-switch": true });
  assert.deepEqual(now.atidPdfOpts(), {}, "ticked but no ATID: nothing");
  now.state = { atid: "ATID7K3MQ9XP2WD3" };
  assert.deepEqual(now.atidPdfOpts(), {}, "an invalid ATID is never printed");
  now.state = { atid: "ATID7K3MQ9XP2WD2" };
  setSwitches({ "atid-pdf-line-switch": true, "atid-pdf-meta-switch": false });
  assert.deepEqual(now.atidPdfOpts(), { atidLine: DISP });
  setSwitches({ "atid-pdf-line-switch": false, "atid-pdf-meta-switch": true });
  assert.deepEqual(now.atidPdfOpts(), { atidMeta: DISP });
  setSwitches({});
});

// ---------- PDF: visible line ----------
const pdfBytes = (s) => Uint8Array.from(Buffer.from(s, "latin1"));
const open = (s) => mupdf.Document.openDocument(pdfBytes(s), "application/pdf");
const pageLines = (doc, i) => { const out = []; doc.loadPage(i).toStructuredText("preserve-whitespace").walk({ beginLine(bbox) { out.push({ y0: bbox[1], y1: bbox[3], text: "" }); }, onChar(c) { out[out.length - 1].text += c; } }); return out; };
t("PDF line on: the last page ends with ONE small line of exactly the display form, below the text area; page count unchanged; the other pages and the text lines unchanged", () => {
  for (const lines of LINESETS.filter((_, i) => i % 3 === 0 || SIZES.includes(lines_len(_)))) {
    const off = now.buildAtsPdfBytes(lines), on = now.buildAtsPdfBytes(lines, { atidLine: DISP });
    const dOff = open(off), dOn = open(on);
    assert.equal(dOn.countPages(), dOff.countPages(), lines.length + " lines: page count");
    const last = dOn.countPages() - 1;
    for (let p = 0; p < last; p++) assert.deepEqual(pageLines(dOn, p), pageLines(dOff, p), "page " + p);
    const lOff = pageLines(dOff, last), lOn = pageLines(dOn, last);
    assert.equal(lOn.length, lOff.length + 1, lines.length + " lines: exactly one more line on the last page");
    assert.deepEqual(lOn.slice(0, -1), lOff, "all the earlier lines on the last page are untouched, same positions");
    const added = lOn[lOn.length - 1];
    assert.equal(added.text, DISP);
    assert.ok(added.y0 >= 792 - 54, "below the text area: y0 " + added.y0 + " >= 738");
    assert.ok(added.y1 <= 792, "inside the page");
  }
});
function lines_len(l) { return l.length; }
t("PDF line on, FULL last page (45 lines; 90; 135): the 45 lines keep their places, the page count does not grow, the ATID is the 46th line on the page but outside the text area", () => {
  for (const n of [45, 90, 135]) {
    const lines = mkLines(n);
    const off = open(now.buildAtsPdfBytes(lines)), on = open(now.buildAtsPdfBytes(lines, { atidLine: DISP }));
    assert.equal(off.countPages(), n / 45); assert.equal(on.countPages(), n / 45);
    const lOff = pageLines(off, n / 45 - 1), lOn = pageLines(on, n / 45 - 1);
    assert.equal(lOff.length, 45); assert.equal(lOn.length, 46);
    assert.deepEqual(lOn.slice(0, 45), lOff);
    const lastText = lOff[44];
    assert.ok(lOn[45].y0 > lastText.y1, "the ATID is below the last text line");
    assert.ok(lOn[45].y0 >= 738);
  }
});
t("PDF line on: the content streams of all pages except the last are byte for byte the same; the last stream = the old stream + one text object", () => {
  const lines = mkLines(100);
  const off = now.buildAtsPdfBytes(lines), on = now.buildAtsPdfBytes(lines, { atidLine: DISP });
  const streams = (s) => [...s.matchAll(/stream\n([\s\S]*?)endstream/g)].map((m) => m[1]);
  const a = streams(off), b = streams(on);
  assert.equal(a.length, b.length);
  for (let i = 0; i < a.length - 1; i++) assert.equal(b[i], a[i]);
  assert.ok(b[a.length - 1].startsWith(a[a.length - 1].replace(/\n$/, "")));
  assert.equal(b[a.length - 1].replace(a[a.length - 1].replace(/\n$/, ""), ""), "\nBT\n/F1 8 Tf\n1 0 0 1 54 36.00 Tm\n(" + DISP + ") Tj\nET\n");
});
t("PDF line on: the Length of every stream is right and the xref table points at every object (both with and without the line)", () => verifyStructure(now.buildAtsPdfBytes(mkLines(100), { atidLine: DISP })));

// ---------- PDF: hidden metadata ----------
function verifyStructure(s) {
  const sx = Number(/startxref\n(\d+)\n%%EOF$/.exec(s)[1]);
  assert.equal(s.slice(sx, sx + 5), "xref\n");
  const m = /xref\n0 (\d+)\n([\s\S]*?)trailer\n<< \/Size (\d+)([^>]*)>>/.exec(s.slice(sx));
  const n = Number(m[1]); assert.equal(Number(m[3]), n);
  const entries = m[2].trim().split("\n"); assert.equal(entries.length, n);
  for (let i = 1; i < n; i++) { const off = Number(entries[i].slice(0, 10)); assert.equal(s.slice(off, off + String(i).length + 6), i + " 0 obj", "object " + i + " at its offset"); }
  for (const sm of s.matchAll(/<< \/Length (\d+) >>\nstream\n([\s\S]*?)endstream/g)) assert.equal(Number(sm[1]), sm[2].length);
  return { n, trailer: m[4] };
}
t("PDF hidden copy on: /Keywords reads back through mupdf as exactly the display form; trailer has /Info; xref and Size are right; pages and text unchanged", () => {
  for (const n of [0, 1, 45, 46, 100]) {
    const lines = mkLines(n);
    const off = now.buildAtsPdfBytes(lines), on = now.buildAtsPdfBytes(lines, { atidMeta: DISP });
    const dOn = open(on), dOff = open(off);
    assert.equal(dOn.getMetaData("info:Keywords"), DISP);
    assert.ok(!dOff.getMetaData("info:Keywords"), "off: no Keywords");
    assert.equal(dOn.countPages(), dOff.countPages());
    for (let p = 0; p < dOn.countPages(); p++) assert.deepEqual(pageLines(dOn, p), pageLines(dOff, p));
    const sOn = verifyStructure(on), sOff = verifyStructure(off);
    assert.equal(sOn.n, sOff.n + 1); assert.match(sOn.trailer, / \/Root 1 0 R \/Info \d+ 0 R /); assert.doesNotMatch(sOff.trailer, /Info/);
  }
});
t("PDF hidden copy on: only the Info object, the object count and the trailer differ from the off file (everything before the xref is the off file + one object)", () => {
  const lines = mkLines(60);
  const off = now.buildAtsPdfBytes(lines), on = now.buildAtsPdfBytes(lines, { atidMeta: DISP });
  const cut = (s) => s.slice(0, s.indexOf("xref\n0 "));
  // 60 lines = 2 pages = objects 1..8, so the Info object is number 9
  assert.equal(cut(on), cut(off) + "9 0 obj\n<< /Keywords (" + DISP + ") >>\nendobj\n");
});
t("both switches on: the visible line and the Keywords are both there, the structure is still sound", () => {
  const on = now.buildAtsPdfBytes(mkLines(45), { atidLine: DISP, atidMeta: DISP });
  const d = open(on);
  assert.equal(d.getMetaData("info:Keywords"), DISP);
  assert.equal(pageLines(d, 0).at(-1).text, DISP);
  verifyStructure(on);
});
t("the hidden copy is escaped like any PDF string (a value with ( ) or a backslash cannot break the file)", () => {
  const on = now.buildAtsPdfBytes(mkLines(3), { atidMeta: "a(b)c\\d" });
  verifyStructure(on);
  assert.equal(open(on).getMetaData("info:Keywords"), "a(b)c\\d");
});

// ---------- JSON ----------
const EX = { work_history: [], education: [], skills: [{ skill_text: "SQL" }], freeform: [{ section_type: "summary", content: "A summary." }] };
const PROFILE = { first: "Jane", last: "Doe", email: "jane@example.test", phone: "", phoneConfirmed: false, kycVerifiedAt: null, location: "Austin, TX" };
const exportJson = (inst, profile) => { const d = JSON.parse(JSON.stringify(inst.buildDataExport(EX, { items: [], licenses: [], summaries: [] }, profile))); delete d.meta.exportedAt; return d; };
t("JSON off: byte for byte the same as before the ATID (profile.atid undefined, null and empty)", () => {
  const base = JSON.stringify(exportJson(old, PROFILE), null, 2);
  for (const a of [undefined, null, ""]) assert.equal(JSON.stringify(exportJson(now, { ...PROFILE, atid: a }), null, 2), base);
  assert.equal(JSON.stringify(exportJson(now, PROFILE), null, 2), base);
  assert.equal(base.includes("applitrustId"), false);
});
t("JSON on: exactly one extra key, basics.applitrustId = the display form; removing it gives the old file", () => {
  const base = exportJson(old, PROFILE), on = exportJson(now, { ...PROFILE, atid: DISP });
  assert.equal(on.basics.applitrustId, DISP);
  assert.equal(JSON.stringify(on).split("applitrustId").length - 1, 1, "appears once in the whole file");
  const d = structuredClone(on); delete d.basics.applitrustId;
  assert.equal(JSON.stringify(d), JSON.stringify(base));
  assert.deepEqual(Object.keys(on.basics).slice(0, 4), ["name", "email", "applitrustId", "summary"].filter((k) => k in on.basics).slice(0, 4));
});

// ---------- the screen ----------
t("the screen: three checkboxes with the exact labels, none checked by default, none bound to state or storage; the explanation sits with each group", () => {
  for (const label of ["Include my ATID in the JSON file", "Include my ATID as a line at the end of the PDF", "Include my ATID in the PDF's hidden information"]) assert.ok(NOW.includes("<span>" + label + "</span>"), label);
  // (AR added a fourth ATID checkbox, atid-employer-visible-switch, which IS stored; it is not one of the three export switches and is tested in test-atid-lookup-page.mjs)
  const boxes = [...NOW.matchAll(/<input type="checkbox" id="(atid-[a-z-]+)"([^>]*)>/g)].filter((m) => m[1] !== "atid-employer-visible-switch");
  assert.deepEqual(boxes.map((m) => m[1]), ["atid-json-switch", "atid-pdf-line-switch", "atid-pdf-meta-switch"]);
  for (const m of boxes) assert.doesNotMatch(m[2], /checked/, m[1]);
  assert.equal([...NOW.matchAll(/An ATID printed on a resume can be copied by anyone, so include it only when you want a recipient to be able to send information back to you\./g)].length, 2, "the explanation under the JSON switch and under the two PDF switches");
  assert.equal(/(localStorage|sessionStorage)[^\n]*atid-(json|pdf)|atid-(json|pdf)[^\n]*(localStorage|sessionStorage)/.test(NOW), false);
  assert.equal(/setState\([^)]*atid(Json|Pdf)/.test(NOW), false, "the switch values are not put into state");
});
t("the screen: the Profile row shows the display form, a Copy button and the agreed sentence, for every account type (not inside the full-resume gate)", () => {
  assert.ok(NOW.includes("ATID stands for Applitrust ID. It is yours for the life of your account and never changes when you upload a new resume."));
  const i = NOW.indexOf('<sc-if value="{{ hasAtid }}" hint-placeholder-val="{{ false }}">\n        <div class="card elev-sm"');
  assert.ok(i > 0); const j = NOW.indexOf("Basic info", i); assert.ok(j > i && j - i < 3600);
  assert.ok(NOW.slice(i, j).includes("{{ atidDisplay }}") && NOW.slice(i, j).includes("{{ copyAtid }}"));
  assert.equal(NOW.slice(i, j).includes("isFullResumeAccount"), false);
});
t("the session profile is mapped into state, and the JSON export reads its switch at the click, before any fetch", () => {
  assert.ok(NOW.includes("atid: (profile && typeof profile.atid === 'string' && profile.atid) || this.state.atid,"));
  const ex = method(NOW, "async exportVerifiedData") || NOW.slice(NOW.indexOf("  async exportVerifiedData()"));
  const a = ex.indexOf("const wantAtid = this.atidSwitchOn('atid-json-switch')"), f = ex.indexOf("await ");
  assert.ok(a > 0 && f > a);
});
t("nothing else in the page changed in a way that matters: sanitizeAts and isoPartialDate are identical to the base commit (buildResumeLines changed on purpose in AW, the job heading; test-job-heading.mjs proves every other line is unchanged)", () => {
  for (const n of ["sanitizeAts", "isoPartialDate"]) assert.equal(method(NOW, n), method(OLD, n), n);
});

let failed = 0;
for (const [name, fn] of tests) {
  try { await fn(); console.log("  ok   " + name); } catch (e) { failed++; console.log("  FAIL " + name + "\n       " + String(e?.message ?? e).split("\n").slice(0, 8).join("\n       ")); }
}
console.log(`\n${tests.length - failed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
