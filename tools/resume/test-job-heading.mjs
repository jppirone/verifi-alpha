// node --experimental-strip-types tools/resume/test-job-heading.mjs   (no network, no model call, no live database, no browser)
// AW (October 20, 2026): the generated PDF prints each job heading the way the candidate's own resume showed it.
//   * supabase/functions/_shared/resume-heading-line.ts finds the printed heading in the stored page text (proved on the six test resumes, built from what is stored on the live project);
//   * candidate.html prints it (workHeadingLines) or, when it cannot be found, the pipe heading Title | Company | Location | Dates (title in bold, an empty field leaves out its pipe);
//   * get-customization hands the found heading to the page (real function source, run against an in-memory stand-in for the database REST API);
//   * everything else in the PDF is the same as the writer before this change (cut out of git commit 9c243b2 and compared line by line and byte for byte).
// PDF files are opened with mupdf (scratch install used for the OCR work; override with ATID_MUPDF=<path to mupdf/dist/mupdf.js>).
// NOT proved: a real browser, the real deployed function with real data, a real Workday run (hand test for John).
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { findPrintedHeading, attachPrintedHeadings, restoreRangeDash } from "../../supabase/functions/_shared/resume-heading-line.ts";

const MUPDF = process.env.ATID_MUPDF || "C:/Users/jpiro/AppData/Local/Temp/ocr-repro/node_modules/mupdf/dist/mupdf.js";
if (!fs.existsSync(MUPDF)) { console.log("SKIP: mupdf not found at " + MUPDF + " (set ATID_MUPDF)"); process.exit(2); }
const mupdf = await import(pathToFileURL(MUPDF).href);

const repo = new URL("../../", import.meta.url);
const BASE = process.env.AW_BASE || "9c243b2";
const NOW = fs.readFileSync(new URL("candidate.html", repo), "utf8").replace(/\r\n/g, "\n");
const OLD = execFileSync("git", ["show", `${BASE}:candidate.html`], { cwd: repo, maxBuffer: 1 << 28 }).toString("utf8").replace(/\r\n/g, "\n");
// AU (commit 75c8eab, tag ap9au-before-merge-oct20 while it exists locally) owns exportVerifiedData and atidPdfOpts: it rewrote them to read the stored export choices. The commit hash is used
// because it stays reachable once AU is merged, which a local tag does not.
const AU_REF = process.env.AW_AU_REF || "75c8eab";
const AU_OWNED = ["exportVerifiedData", "atidPdfOpts"];
const AU_SRC = execFileSync("git", ["show", `${AU_REF}:candidate.html`], { cwd: repo, maxBuffer: 1 << 28 }).toString("utf8").replace(/\r\n/g, "\n");
function differingFromAu(src, names) { return names.filter((n) => method(src, n) !== method(AU_SRC, n)); }
const FX = JSON.parse(fs.readFileSync(new URL("fixtures/job-heading-six.json", import.meta.url), "utf8"));
function method(src, name) {
  let start = src.indexOf("\n  " + name + "(");
  if (start < 0) start = src.indexOf("\n  async " + name + "(");
  if (start < 0) return null;
  return src.slice(start + 1, src.indexOf("\n  }\n", start) + 4);
}
const NAMES = ["buildResumeLines", "buildAtsPdfBytes", "sanitizeAts", "wrapText", "groupByLiteralHeading", "czPartialLabel", "czRange", "czWorkLabel", "czEduLabel", "czCertLabel", "workHeadingLines", "wrapHeadingRuns", "czDatesText", "helvWidth"];
// the widths below come from the PDF reader's own Helvetica, NOT from the table in the page: an independent check of that table
const HV = new mupdf.Font("Helvetica"), HB = new mupdf.Font("Helvetica-Bold");
const measure = (s, bold) => [...s].reduce((n, ch) => n + (bold ? HB : HV).advanceGlyph((bold ? HB : HV).encodeCharacter(ch.charCodeAt(0))) * 11, 0);
const lineWidth = (l) => (l.runs ? l.runs.reduce((n, r) => n + measure(r.text, r.bold), 0) : measure(l.text, !!l.bold));
const PAGE_ROOM = 612 - 2 * 54;   // the width between the writer's margins
const mk = (src) => new Function("return class P { " + NAMES.map((n) => method(src, n)).filter(Boolean).join("\n") + " }")();
const now = new (mk(NOW))(), old = new (mk(OLD))();

const tests = []; const t = (n, f) => tests.push([n, f]);
const asWork = (rows, extra = {}) => rows.map((r) => ({ heading: "PROFESSIONAL EXPERIENCE", description: "", ...r, ...extra }));
const resumeOf = (rows) => ({ candidate: { name: "Jane Doe" }, header: { mode: "account" }, work: asWork(rows) });
const linesOf = (inst, rows, withPrinted) => inst.buildResumeLines(resumeOf(rows.map((r) => ({ ...r, ...(withPrinted && withPrinted[r.id] ? { printed_heading: withPrinted[r.id] } : {}) }))), resumeOf(rows));

// ---------------------------------------------------------------- the finder on the six test resumes
for (const [name, d] of Object.entries(FX.docs)) {
  t(`finder, ${name}: every job heading is found exactly as the candidate's resume printed it (or correctly not found)`, () => {
    const ocr = d.ocr.join("\n"), used = new Set();
    for (const r of [...d.rows].sort((a, b) => a.position - b.position)) {
      const got = findPrintedHeading(ocr, r, used);
      assert.deepEqual(got, d.printed[r.id], `${name} ${r.id} ${r.title}`);
    }
  });
}
t("finder: the printed title wins over a compound stored title (Aclark 'Recruiter to Senior Recruiter' prints the line the candidate wrote, 'Recruiter')", () => {
  const d = FX.docs.Aclark; const row = d.rows.find((r) => r.id === "a2");
  assert.equal(row.title, "Recruiter to Senior Recruiter");
  const got = findPrintedHeading(d.ocr.join("\n"), row, new Set());
  assert.deepEqual(got, ["WESTCX, Recruiter, Remote (Sep 2023-Jun 2024)"]); assert.equal(got[0].includes("to Senior"), false);
});
t("finder: the dash the OCR dropped between two bare years comes back; ranges that already have one are left alone", () => {
  for (const [i, o] of [["Title | Co | NJ | 2019 2023", "Title | Co | NJ | 2019 - 2023"], ["School Dist, FL 2014 Present", "School Dist, FL 2014 - Present"], ["X (Jul 2024 Aug 2026)", "X (Jul 2024 - Aug 2026)"], ["Title | Co | 2007 — 2008", "Title | Co | 2007 — 2008"], ["Co (Apr 2011-Aug 2015)", "Co (Apr 2011-Aug 2015)"], ["Co | 2023—Present", "Co | 2023—Present"], ["Led 25 people 2019", "Led 25 people 2019"]]) assert.equal(restoreRangeDash(i), o, i);
});
t("finder: a heading is never invented. Edited company or place (the confirm screen changed it), wrong dates, no dates, or a sentence that only mentions the company, all give null", () => {
  const ocr = "Business Integration Manager | Truven Health Analytics | Ann Arbor, MI | 2008 2016\n— \nWe worked with Truven Health Analytics in Ann Arbor, MI from 2008 to 2016.".replace("— \n", "");
  const base = { employer: "Truven Health Analytics", title: "Business Integration Manager", location: "Ann Arbor, MI", start: "2008", end: "2016" };
  assert.ok(findPrintedHeading(ocr, base, new Set()));
  for (const edit of [{ employer: "Truven Analytics Inc" }, { location: "Detroit, MI" }, { start: "2009" }, { end: "2017" }, { start: "", end: "" }]) assert.equal(findPrintedHeading(ocr, { ...base, ...edit }, new Set()), null, JSON.stringify(edit));
  // a sentence with company, place and both years is not a heading, even when the real heading line is already taken (a second identical job finds nothing)
  const used = new Set(); findPrintedHeading(ocr, base, used); assert.equal(findPrintedHeading(ocr, base, used), null);
  assert.equal(findPrintedHeading("", base, new Set()), null); assert.equal(findPrintedHeading(null, base, new Set()), null);
});
t("finder: two jobs that look alike (same company, different dates) take their own lines, one to one, and a line is never used twice", () => {
  const ocr = ["Manager of Business Analysis | Thomson Reuters | Montvale, NJ | 1996 1998", "Promoted from Desktop Publishing Manager (1996-1997)"].join("\n");
  const a = { id: "x", position: 1, employer: "Thomson Reuters", title: "Manager of Business Analysis", location: "Montvale, NJ", start: "1996", end: "1998" };
  const b = { id: "y", position: 2, employer: "Thomson Reuters", title: "Desktop Publishing Manager", location: "Montvale, NJ", start: "1996", end: "1997" };
  const m = attachPrintedHeadings([b, a], () => ocr);
  assert.deepEqual([...m.keys()], ["x"]);
});

// ---------------------------------------------------------------- the writer: the six resumes, what is printed now and what was printed before
const TABLE = [];
for (const [name, d] of Object.entries(FX.docs)) {
  t(`writer, ${name}: each heading prints as the candidate's resume showed it; before this change it printed 'Company, Title, Location (years)'`, () => {
    const found = {}; const used = new Set();
    for (const r of [...d.rows].sort((a, b) => a.position - b.position)) { const f = findPrintedHeading(d.ocr.join("\n"), r, used); if (f) found[r.id] = f; }
    const newLines = linesOf(now, d.rows, found).map((l) => l.text), oldLines = linesOf(old, d.rows, null).map((l) => l.text);
    for (const r of d.rows) {
      const printedNow = found[r.id] ? now.workHeadingLines({ printed_heading: found[r.id] }).map((l) => l.text) : now.workHeadingLines(r).map((l) => l.text);
      const before = old.wrapText(old.czWorkLabel(r), 90);
      for (const l of printedNow) assert.ok(newLines.includes(l), `${name} ${r.id}: line in the PDF: ${l}`);
      for (const l of before) assert.ok(oldLines.includes(l), `before: ${l}`);
      TABLE.push(`${name} | ${r.id} | original: ${d.printed[r.id] ? d.printed[r.id].join(" // ") : "(no heading line on the page: sub note only)"} | before: ${before.join(" // ")} | now: ${printedNow.join(" // ")}`);
      if (found[r.id]) assert.equal(printedNow.join(" "), d.printed[r.id].map((s) => now.sanitizeAts(s)).join(" "), r.id + ": the candidate's own wording, order, separators and date text (the writer folds dashes to ASCII as it always has)");
      else assert.equal(printedNow.join(" "), now.workHeadingLines(r).map((l) => l.text).join(" "), r.id + ": the fallback pipe heading");
    }
  });
}
t("writer: the old heading is gone from the PDF for PironeSimple: 'Company, Title, Location (years)' is not printed for any job that has a printed heading", () => {
  const d = FX.docs.PironeSimple, found = {}, used = new Set();
  for (const r of [...d.rows].sort((a, b) => a.position - b.position)) { const f = findPrintedHeading(d.ocr.join("\n"), r, used); if (f) found[r.id] = f; }
  const text = linesOf(now, d.rows, found).map((l) => l.text);
  for (const r of d.rows) if (found[r.id]) assert.equal(text.includes(old.wrapText(old.czWorkLabel(r), 90)[0]), false, r.id);
  assert.ok(text.join(" ").includes("Business Education Teacher | School District of Indian River County | Sebastian, FL | 2018 - 2025"));
});

// ---------------------------------------------------------------- the fallback heading
const heading = (row) => now.workHeadingLines(row);
const plain = (row) => heading(row).map((l) => l.text).join(" // ");
t("fallback: Title | Company | Location | Dates, title in bold, the rest regular", () => {
  const h = heading({ title: "Project Manager", employer: "Letraset", location: "Paramus, NJ", start: "1995", end: "1996" });
  assert.equal(h.length, 1); assert.equal(h[0].text, "Project Manager | Letraset | Paramus, NJ | 1995-1996");
  assert.deepEqual(h[0].runs, [{ text: "Project Manager", bold: true }, { text: " | Letraset | Paramus, NJ | 1995-1996", bold: false }]);
});
t("fallback: a job with no company prints 'Title | Dates', never 'Title |  | Dates'; no location leaves out its pipe; no end date prints Present", () => {
  assert.equal(plain({ title: "Analyst", start: "2019", end: "2022" }), "Analyst | 2019-2022");
  assert.equal(plain({ title: "Analyst", employer: "Acme", start: "2019", end: "2022" }), "Analyst | Acme | 2019-2022");
  assert.equal(plain({ title: "Analyst", employer: "Acme", location: "Austin, TX", start: "2019-03", current: true }), "Analyst | Acme | Austin, TX | Mar 2019-Present");
  assert.equal(plain({ title: "Analyst", employer: "", location: "", start: "2019", end: "2022" }).includes("|  |"), false);
  assert.equal(plain({ title: "Analyst", employer: "Acme", location: "Austin, TX" }), "Analyst | Acme | Austin, TX", "no dates at all: nothing invented");
});
t("fallback: no title prints 'Company | Location | Dates' with no bold; nothing at all prints nothing", () => {
  const h = heading({ employer: "Acme", location: "Austin, TX", start: "2019", end: "2022" });
  assert.equal(h[0].text, "Acme | Location".replace("Location", "Austin, TX | 2019-2022")); assert.equal(h[0].bold, false); assert.equal(h[0].runs, undefined);
  assert.deepEqual(heading({}), []);
});
t("width table: the page's Helvetica widths equal the PDF reader's own, for every printable character, regular and bold", () => {
  for (let c = 32; c <= 126; c++) { const ch = String.fromCharCode(c); assert.ok(Math.abs(now.helvWidth(ch, false) - measure(ch, false)) < 0.001, "regular " + ch); assert.ok(Math.abs(now.helvWidth(ch, true) - measure(ch, true)) < 0.001, "bold " + ch); }
});
t("fallback: a very long title wraps only when it does not fit between the margins, with every word and every pipe kept, the bold part follows the title across the wrap, and a title longer than a line is bold on every line it fills", () => {
  const title = "Senior Director of Global Customer Success Operations and Strategic Enterprise Onboarding Programs";
  const row = { title, employer: "Acme Worldwide Holdings International", location: "Austin, TX", start: "2019", end: "2022" };
  const h = heading(row);
  assert.ok(h.length >= 2); for (const l of h) assert.ok(lineWidth(l) <= PAGE_ROOM, lineWidth(l).toFixed(1) + " " + l.text);
  const joined = h.map((l) => l.text).join(" ");
  assert.equal(joined, title + " | Acme Worldwide Holdings International | Austin, TX | 2019-2022", "no word or pipe lost");
  const boldChars = h.map((l) => l.runs ? l.runs.filter((r) => r.bold).map((r) => r.text).join("") : (l.bold ? l.text : "")).join(" ").trim();
  assert.equal(boldChars, title, "exactly the title is bold, across the wrap");
  for (const l of h) if (l.runs) assert.equal(l.runs.map((r) => r.text).join(""), l.text);
});
t("fallback: a heading that wraps in the middle of the company or the dates keeps every pipe (property over 300 random jobs)", () => {
  let seed = 11; const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  const words = ["Senior", "Manager", "of", "Customer", "Success", "Operations", "Acme", "Global", "Holdings", "International", "Austin,", "TX", "Partners", "&", "Digital"];
  const w = (n) => Array.from({ length: n }, () => words[Math.floor(rnd() * words.length)]).join(" ");
  for (let i = 0; i < 300; i++) {
    const row = { title: w(1 + Math.floor(rnd() * 14)), employer: rnd() < 0.9 ? w(1 + Math.floor(rnd() * 10)) : "", location: rnd() < 0.7 ? w(1 + Math.floor(rnd() * 4)) : "", start: String(1990 + Math.floor(rnd() * 30)), end: rnd() < 0.8 ? String(2020 + Math.floor(rnd() * 6)) : undefined, current: rnd() < 0.2 };
    const h = heading(row), joined = h.map((l) => l.text).join(" ");
    const expect = [row.title, row.employer, row.location, now.czDatesText(row)].filter(Boolean).join(" | ");
    assert.equal(joined, expect, JSON.stringify(row)); assert.equal((joined.match(/\|/g) || []).length, (expect.match(/\|/g) || []).length);
    for (const l of h) assert.ok(lineWidth(l) <= PAGE_ROOM || !l.text.replace(/ \|$/, "").includes(" "), lineWidth(l).toFixed(1) + " " + l.text);
    if (h.length === 1) assert.ok(lineWidth(h[0]) <= PAGE_ROOM);
    else assert.ok(measure(joined, false) > PAGE_ROOM - 60, "it only wrapped because it was (nearly) too wide for one line");
  }
});
t("printed heading: a heading that fits between the margins stays ONE line even when it is more than 90 characters; one that does not fit wraps without losing a word or a pipe, in the body font; two printed lines stay two lines", () => {
  const long = "Business Integration Manager | Truven Health Analytics (IBM Watson Health) | Ann Arbor, MI | 2008 - 2016";
  assert.ok(long.length > 90);
  const h = now.workHeadingLines({ printed_heading: [long] });
  assert.ok(h.every((l) => lineWidth(l) <= PAGE_ROOM && l.bold === false && !l.runs));
  assert.equal(h.length, measure(long, false) <= 500 ? 1 : 2, "one line exactly when it fits");
  assert.equal(h.map((l) => l.text).join(" "), long);
  const wide = "Handheld Product Support Specialist / Project Manager | WorkWave Technologies International Holdings | Tinton Falls, NJ | 2006 - 2007";
  const w2 = now.workHeadingLines({ printed_heading: [wide] });
  assert.ok(w2.length >= 2 && w2.every((l) => lineWidth(l) <= PAGE_ROOM)); assert.equal(w2.map((l) => l.text).join(" "), wide);
  assert.ok(w2.at(-1).text.includes("2006 - 2007") && !w2.at(-1).text.startsWith("- "), "the dates are not split");
  const two = now.workHeadingLines({ printed_heading: ["AI Solutions Consultant & Customer Success Advisor", "Independent / Freelance | 2023—Present | Sebastian, FL"] });
  assert.deepEqual(two.map((l) => l.text), ["AI Solutions Consultant & Customer Success Advisor", "Independent / Freelance | 2023-Present | Sebastian, FL"]);   // the writer folds the dash to ASCII as it always has
  assert.deepEqual(now.workHeadingLines({ title: "T", printed_heading: ["", "  ", 5] }).map((l) => l.text), ["T"], "an unusable printed heading falls back");
});

// ---------------------------------------------------------------- nothing else moved
const RNG = (() => { let s = 42; return () => (s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff; })();
function randomResume(i) {
  const r = RNG; const pick = (a) => a[Math.floor(r() * a.length)];
  const rows = Array.from({ length: 1 + Math.floor(r() * 6) }, (_, k) => ({ id: `r${i}-${k}`, position: 10 + k * 2, heading: pick(["PROFESSIONAL EXPERIENCE", "WORK HISTORY", ""]), employer: pick(["Acme", "Truven Health Analytics (IBM Watson Health)", "", "School District of Indian River County"]), title: pick(["Analyst", "Senior Director of Operations", "Project Manager", ""]), location: pick(["Austin, TX", "", "Remote"]), start: pick(["2001", "2015-03", "2019"]), end: pick(["2004", "2018-11", undefined]), current: r() < 0.2, description: pick(["", "Led a team of five and shipped a thing (twice).", "Built reports\nTrained staff on tooling \\ and (parentheses)"]) }));
  return { R: { candidate: { name: pick(["Jane Doe", "Zoe Q. Test"]) }, header: { mode: pick(["account", "printed"]), printed_header: "Jane Doe\nAustin, TX", location: "Austin, TX" }, contact: { email: { value: "j@x.test" } }, summary: r() < 0.5 ? { heading: "SUMMARY", content: "A long summary sentence that needs to wrap over more than one line when it is placed on the page at ninety characters." } : {},
    work: rows.map((x) => ({ ...x, ...(r() < 0.5 ? { printed_heading: [`${x.title} | ${x.employer} | ${x.location} | ${x.start} - ${x.end || "Present"}`] } : {}) })),
    education: r() < 0.6 ? [{ id: "e" + i, position: 50, heading: "EDUCATION", institution: "State U", degree: "BS", start: "1990", end: "1994" }] : [], certifications: r() < 0.4 ? [{ id: "c" + i, position: 60, heading: "CERTIFICATIONS", name: "PMP", issuer: "PMI", issued: "2010" }] : [],
    skills: r() < 0.6 ? { items: [{ text: "SQL" }, { text: "Excel" }], section_position: 70, heading: "SKILLS" } : undefined, other_sections: r() < 0.3 ? [{ heading: "AWARDS", content: "Employee of the year", position: 80 }] : [] } };
}
t("nothing else moved: for 56 generated resumes (the 6 test resumes + 50 random) every line except the job heading lines is identical to the writer before this change, and the PDF built from those lines is byte for byte the same", () => {
  const cases = [];
  for (const [name, d] of Object.entries(FX.docs)) { const used = new Set(), f = {}; for (const r of [...d.rows].sort((a, b) => a.position - b.position)) { const x = findPrintedHeading(d.ocr.join("\n"), r, used); if (x) f[r.id] = x; } cases.push({ R: resumeOf(d.rows.map((r) => ({ ...r, ...(f[r.id] ? { printed_heading: f[r.id] } : {}) }))) }); }
  for (let i = 0; i < 50; i++) cases.push(randomResume(i));
  assert.equal(cases.length, 56);
  for (const { R } of cases) {
    const newLines = now.buildResumeLines(R, R), oldLines = old.buildResumeLines(R, R);
    const strip = (lines, heads) => { const out = [...lines]; for (const h of heads) { const at = out.findIndex((l, ix) => h.every((s, k) => out[ix + k] && out[ix + k].text === s)); assert.ok(at >= 0, "heading present: " + h[0]); out.splice(at, h.length); } return out; };
    const rows = [...R.work].sort((a, b) => (a.position ?? 1e9) - (b.position ?? 1e9));
    const newHeads = rows.map((w) => now.workHeadingLines(w).map((l) => l.text)).filter((h) => h.length), oldHeads = rows.map((w) => old.wrapText(old.czWorkLabel(w), 90)).filter((h) => h.length);
    const a = strip(newLines, newHeads), b = strip(oldLines, oldHeads);
    assert.deepEqual(a.map((l) => [l.text, !!l.bold]), b.map((l) => [l.text, !!l.bold]));
    assert.ok(a.every((l) => !l.runs), "no run lines outside the headings");
    assert.ok(now.buildAtsPdfBytes(a) === old.buildAtsPdfBytes(b), "bytes");
    assert.ok(now.buildAtsPdfBytes(a, {}) === old.buildAtsPdfBytes(b), "bytes, opts {}");
  }
});
t("nothing else moved: the writer is untouched for every line without runs (a run-free resume is the same bytes), and the ATID line and hidden information are unchanged", () => {
  const lines = Array.from({ length: 130 }, (_, i) => ({ text: `line ${i} (with) back\\slash`, bold: i % 9 === 0 }));
  for (const o of [undefined, {}, { atidLine: "ATID-7K3M-Q9XP-2WD2" }, { atidMeta: "ATID-7K3M-Q9XP-2WD2" }, { atidLine: "ATID-7K3M-Q9XP-2WD2", atidMeta: "ATID-7K3M-Q9XP-2WD2" }]) assert.ok(now.buildAtsPdfBytes(lines, o) === old.buildAtsPdfBytes(lines, o), JSON.stringify(o));
  for (const n of ["sanitizeAts", "wrapText", "czPartialLabel", "czRange", "czWorkLabel", "czEduLabel", "czCertLabel", "groupByLiteralHeading", "buildDataExport", "isoPartialDate"]) assert.equal(method(NOW, n), method(OLD, n), n);
  // exportVerifiedData and atidPdfOpts belong to AU (they read the stored export choices instead of the page). The purpose here is unchanged: prove AW did not alter them, so they are
  // compared with the AU version, not with master.
  assert.deepEqual(differingFromAu(NOW, AU_OWNED), [], "AW must not alter the AU-owned export functions");
});
// control for the guard above: the same comparison, fed a copy of the page in which one AU-owned function has been altered, must report exactly that function
t("control: the AU-owned guard still fails when a function it protects is altered relative to AU (planted change in a copy of the page text)", () => {
  assert.deepEqual(differingFromAu(NOW, AU_OWNED), []);
  const plantedOpts = NOW.replace("if (s.atidExportPdfLine) opts.atidLine = shown;", "if (s.atidExportPdfLine) opts.atidLine = shown + ' ';");
  assert.notEqual(plantedOpts, NOW, "the plant landed");
  assert.deepEqual(differingFromAu(plantedOpts, AU_OWNED), ["atidPdfOpts"]);
  const plantedExport = NOW.replace("const wantAtid = !!s.atidExportJson;", "const wantAtid = !!s.atidExportJson || false;");
  assert.notEqual(plantedExport, NOW, "the plant landed");
  assert.deepEqual(differingFromAu(plantedExport, AU_OWNED), ["exportVerifiedData"]);
  assert.deepEqual(differingFromAu(NOW.replace("async exportVerifiedData() {", "async exportVerifiedDataX() {"), AU_OWNED), ["exportVerifiedData"], "a missing function counts as different");
});

// ---------------------------------------------------------------- real PDFs
const open = (s) => mupdf.Document.openDocument(Uint8Array.from(Buffer.from(s, "latin1")), "application/pdf");
const pageText = (doc, i) => { const out = []; doc.loadPage(i).toStructuredText("preserve-whitespace").walk({ beginLine() { out.push(""); }, onChar(c) { out[out.length - 1] += c; } }); return out; };
const fontsOf = (doc, i) => { const out = []; doc.loadPage(i).toStructuredText("preserve-whitespace").walk({ beginLine() { out.push([]); }, onChar(c, o, font) { out[out.length - 1].push([c, font.getName()]); } }); return out; };
function verifyStructure(s) {
  const sx = Number(/startxref\n(\d+)\n%%EOF$/.exec(s)[1]);
  const m = /xref\n0 (\d+)\n([\s\S]*?)trailer/.exec(s.slice(sx)); const n = Number(m[1]);
  const entries = m[2].trim().split("\n"); assert.equal(entries.length, n);
  for (let i = 1; i < n; i++) { const off = Number(entries[i].slice(0, 10)); assert.equal(s.slice(off, off + String(i).length + 6), i + " 0 obj"); }
  for (const sm of s.matchAll(/<< \/Length (\d+) >>\nstream\n([\s\S]*?)endstream/g)) assert.equal(Number(sm[1]), sm[2].length);
}
t("PDF: the pipe heading opens in a real PDF reader as one line of text with the title in Helvetica-Bold and the rest in Helvetica; the file structure is sound", () => {
  const lines = [...now.workHeadingLines({ title: "Project Manager", employer: "Letraset", location: "Paramus, NJ", start: "1995", end: "1996" }), { text: "A body line", bold: false }];
  const pdf = now.buildAtsPdfBytes(lines); verifyStructure(pdf);
  const doc = open(pdf); assert.equal(doc.countPages(), 1);
  assert.deepEqual(pageText(doc, 0), ["Project Manager | Letraset | Paramus, NJ | 1995-1996", "A body line"]);
  const f = fontsOf(doc, 0)[0]; const boldPart = f.filter(([, n]) => /Bold/i.test(n)).map(([c]) => c).join(""), regPart = f.filter(([, n]) => !/Bold/i.test(n)).map(([c]) => c).join("");
  assert.equal(boldPart, "Project Manager"); assert.equal(regPart, " | Letraset | Paramus, NJ | 1995-1996");
  assert.equal(fontsOf(doc, 0)[1].every(([, n]) => !/Bold/i.test(n)), true, "the next line is back to the body font");
});
t("PDF: a wrapped pipe heading keeps its bold title across both lines, and a later bold section heading still prints bold (the font is tracked across run lines)", () => {
  const title = "Senior Director of Global Customer Success Operations and Strategic Enterprise Onboarding Programs";
  const lines = [...now.workHeadingLines({ title, employer: "Acme Worldwide Holdings International", location: "Austin, TX", start: "2019", end: "2022" }), { text: "SKILLS", bold: true }, { text: "SQL", bold: false }];
  const doc = open(now.buildAtsPdfBytes(lines));
  const t0 = pageText(doc, 0); assert.equal(t0.slice(0, 2).join(" "), title + " | Acme Worldwide Holdings International | Austin, TX | 2019-2022");
  const f = fontsOf(doc, 0); const bold0 = f[0].filter(([, n]) => /Bold/i.test(n)).map(([c]) => c).join("") + " " + f[1].filter(([, n]) => /Bold/i.test(n)).map(([c]) => c).join("");
  assert.equal(bold0.trim(), title);
  assert.equal(f[2].every(([, n]) => /Bold/i.test(n)), true, "SKILLS bold"); assert.equal(f[3].every(([, n]) => !/Bold/i.test(n)), true, "SQL regular");
});
t("PDF: a heading is not kept with its bullets across a page break. The writer cuts pages every 45 lines and has never kept a heading with the line after it; this change does not add that (documented, tested so a change is noticed)", () => {
  const filler = Array.from({ length: 44 }, (_, i) => ({ text: "filler " + i, bold: false }));
  const lines = [...filler, ...now.workHeadingLines({ title: "Analyst", employer: "Acme", start: "2019", end: "2022" }), { text: "bullet after the heading", bold: false }];
  const same = [...filler, { text: "Acme, Analyst (2019-2022)", bold: false }, { text: "bullet after the heading", bold: false }];
  const a = open(now.buildAtsPdfBytes(lines)), b = open(old.buildAtsPdfBytes(same));
  assert.equal(a.countPages(), 2); assert.equal(pageText(a, 0).at(-1), "Analyst | Acme | 2019-2022", "the heading is the LAST line of page 1, as the old heading was");
  assert.equal(pageText(b, 0).at(-1), "Acme, Analyst (2019-2022)"); assert.equal(pageText(a, 1)[0], "bullet after the heading");
});

// ---------------------------------------------------------------- the server: get-customization hands the found heading to the page
const SRK = "srk-test-service-role-key";
globalThis.Deno = { env: { get: (k) => ({ SUPABASE_URL: "http://db.test", SUPABASE_SERVICE_ROLE_KEY: SRK })[k] } };
const sha = async (s) => Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)))).map((b) => b.toString(16).padStart(2, "0")).join("");
let DB, FAIL; const CALLS = [];
const ok = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
globalThis.fetch = async (url, init = {}) => {
  const u = new URL(String(url));
  const rpc = /^\/rest\/v1\/rpc\/(.+)$/.exec(u.pathname); if (rpc) return ok(DB.__rpc);
  const tb = /^\/rest\/v1\/([a-z_]+)$/.exec(u.pathname)?.[1]; if (!tb) return ok({}, 404);
  CALLS.push({ method: (init.method || "GET").toUpperCase(), table: tb, url: String(url) });
  if (FAIL === tb) return ok({ error: "x" }, 500);
  const filters = [...u.searchParams].filter(([k]) => !["select", "limit", "order"].includes(k));
  const rows = (DB[tb] || []).filter((r) => filters.every(([k, v]) => { const m = /^eq\.(.*)$/.exec(v), n = /^in\.\((.*)\)$/.exec(v); if (m) return String(r[k]) === m[1]; if (n) return n[1].split(",").includes(String(r[k])); return true; }));
  const sel = u.searchParams.get("select");
  return ok(rows.map((r) => { if (!sel || sel === "*") return { ...r }; const o = {}; for (const c of sel.split(",")) if (c in r) o[c] = r[c]; return o; }));
};
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "aw-"));
async function load() {
  const src = fs.readFileSync(new URL("supabase/functions/get-customization/index.ts", repo), "utf8").replace(/\r\n/g, "\n")
    .replace(/^import "jsr:@supabase\/functions-js\/edge-runtime\.d\.ts";\n/m, "").replace(/^import \{ withSupabase \} from "jsr:@supabase\/server@[^"]*";\n/m, "const withSupabase = (_o: any, h: any) => h;\n")
    .replace(/from "\.\.\/_shared\/resume-heading-line\.ts"/g, `from "${new URL("supabase/functions/_shared/resume-heading-line.ts", repo).href}"`);
  const f = path.join(TMP, "get-customization.ts"); fs.writeFileSync(f, src); return (await import(pathToFileURL(f).href)).default.fetch;
}
const GET = await load();
const CID = "11111111-1111-4111-8111-111111111111", DOC = "22222222-2222-4222-8222-222222222222", TOKEN = "T".repeat(40);
const wid = (n) => `33333333-3333-4333-8333-${String(n).padStart(12, "0")}`;
async function seedServer(ocr = FX.docs.PironeSimple.ocr.join("\n")) {
  const d = FX.docs.PironeSimple;
  DB = {
    candidate_sessions: [{ token_hash: await sha(TOKEN), candidate_id: CID, expires_at: "2099-01-01T00:00:00Z", revoked_at: null }],
    candidates: [{ id: CID, customization_edit_ack_at: null, customization_edit_ack_text_version: null, atid: null }],
    work_history_items: d.rows.map((r, i) => ({ id: wid(i + 1), resume_document_id: DOC })),
    resume_documents: [{ id: DOC, ocr_raw_text: ocr }],
    __rpc: { available: true, work: d.rows.map((r, i) => ({ id: wid(i + 1), position: r.position, heading: "PROFESSIONAL EXPERIENCE", employer: r.employer, title: r.title, location: r.location, start: r.start, end: r.end, included: true })) },
  };
  FAIL = null; CALLS.length = 0;
}
const call = async (payload) => { const r = await GET(new Request("http://fn.test/x", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) }), {}); return { status: r.status, j: await r.json() }; };
t("get-customization: each work row of the response carries printed_heading found in the stored page text; a row with no heading line on the page carries none", async () => {
  await seedServer();
  for (const view of ["delivered", "editor", undefined]) {
    const r = await call({ candidate_id: CID, session_token: TOKEN, view });
    assert.equal(r.status, 200); assert.equal(r.j.ok, true);
    const w = r.j.resume.work, d = FX.docs.PironeSimple;
    d.rows.forEach((row, i) => { const exp = d.printed[row.id]; assert.deepEqual(w[i].printed_heading ?? null, exp, row.id); });
  }
});
t("get-customization: it only READS (work_history_items and resume_documents), and a failure anywhere in this step leaves the response exactly as before (no field, still ok)", async () => {
  await seedServer(); await call({ candidate_id: CID, session_token: TOKEN, view: "delivered" });
  assert.deepEqual([...new Set(CALLS.map((c) => c.method))], ["GET"]);
  for (const bad of ["work_history_items", "resume_documents"]) { await seedServer(); FAIL = bad; const r = await call({ candidate_id: CID, session_token: TOKEN }); assert.equal(r.j.ok, true, bad); assert.equal(r.j.resume.work.some((w) => "printed_heading" in w), false, bad); }
  await seedServer(null); const r2 = await call({ candidate_id: CID, session_token: TOKEN }); assert.equal(r2.j.ok, true); assert.equal(r2.j.resume.work.some((w) => "printed_heading" in w), false);
  await seedServer(); DB.__rpc.work = []; assert.equal((await call({ candidate_id: CID, session_token: TOKEN })).j.ok, true);
});
// BA (October 21, 2026): John decided the employer's document is generated like the candidate's PDF, so the employer path now carries printed_heading too. This guard (AW: "only get-customization and the
// page mention it") is updated on purpose to name the one server file BA added (candidate-comparison-requests, which supplies it to the employer's generated document). The pass-through functions
// (employer-api, employer-comparison) still must not mention it. test-employer-document.mjs proves the new path.
t("get-customization: still refuses anyone but the candidate's own session; printed_heading is mentioned only by get-customization and (BA) candidate-comparison-requests, never by the pass-through employer functions", async () => {
  await seedServer(); const r = await call({ candidate_id: CID, session_token: "x".repeat(40) }); assert.equal(r.status, 401);
  const dir = new URL("supabase/functions/", repo); const hits = [];
  for (const d of fs.readdirSync(dir, { withFileTypes: true })) if (d.isDirectory()) for (const f of fs.readdirSync(new URL(d.name + "/", dir))) { const p = new URL(`${d.name}/${f}`, dir); if (fs.statSync(p).isFile() && /printed_heading/.test(fs.readFileSync(p, "utf8"))) hits.push(d.name + "/" + f); }
  assert.deepEqual(hits.sort(), ["candidate-comparison-requests/index.ts", "get-customization/index.ts"]);
  const emp = fs.readFileSync(new URL("employer.html", repo), "utf8"); assert.equal(/printed_heading/.test(emp), true, "the employer page reads the field (BA)");
});
// BA: the AW assertion that employer.html and candidate-comparison-requests are byte-identical to the base commit cannot hold once the employer document changes on purpose. What stays guarded here: the
// pass-through employer functions are still identical to the base, and the ATID gating on the employer document (AR) is still in both files.
t("the employer-facing pass-through functions are unchanged from the base commit, and the AR ATID gating on the employer document is still present", () => {
  for (const f of ["supabase/functions/employer-api/index.ts", "supabase/functions/employer-comparison/index.ts"]) assert.equal(execFileSync("git", ["diff", "--stat", BASE, "--", f], { cwd: repo }).toString().trim(), "", f);
  assert.match(fs.readFileSync(new URL("supabase/functions/candidate-comparison-requests/index.ts", repo), "utf8"), /cand\.atid_employer_visible === true && atidIsStored\(cand\.atid\)/);
  assert.match(fs.readFileSync(new URL("employer.html", repo), "utf8"), /push\('Applitrust ID: ' \+ R\.atid\)/);
});

let failed = 0;
for (const [n, f] of tests) { try { await f(); console.log("  ok   " + n); } catch (e) { failed++; console.log("  FAIL " + n + "\n       " + String(e?.message ?? e).split("\n").slice(0, 8).join("\n       ")); } }
if (process.env.AW_TABLE) console.log("\n" + TABLE.join("\n"));
console.log(`\n${tests.length - failed} passed, ${failed} failed`);
fs.rmSync(TMP, { recursive: true, force: true });
process.exit(failed ? 1 : 0);
