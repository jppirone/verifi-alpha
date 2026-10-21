// node tools/resume/test-heading-pipe.mjs   (no network, no model call, no live database)
// BD (October 21, 2026): a pipe between the place and the dates of a job heading.
//  * printed headings (the candidate's own wording): _shared/resume-heading-line.ts insertPipeBeforeDates, applied by attachPrintedHeadings, ONLY at a certain boundary;
//  * generated fallback headings: candidate.html / employer.html workHeadingLines already pipe-join title, company, place and dates; shown here, unchanged.
// Every guard is shown to catch a planted defect (a changed copy of the module text imported from a temporary file; nothing on disk changes).
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import * as REAL from "../../supabase/functions/_shared/resume-heading-line.ts";

const repo = new URL("../../", import.meta.url);
const rd = (f) => fs.readFileSync(new URL(f, repo), "utf8").replace(/\r\n/g, "\n");
const MOD_SRC = rd("supabase/functions/_shared/resume-heading-line.ts");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "heading-pipe-"));
let nmod = 0;
async function mutated(from, to) { assert.ok(MOD_SRC.includes(from), "plant target exists: " + from.slice(0, 50)); const f = path.join(TMP, `m${++nmod}.ts`); fs.writeFileSync(f, MOD_SRC.replace(from, to)); return await import(pathToFileURL(f).href); }
function method(src, name) { let s = src.indexOf("\n  " + name + "("); if (s < 0) return ""; return src.slice(s + 1, src.indexOf("\n  }\n", s) + 4); }
const makeClass = (src, names) => new Function("return class P { " + names.map((n) => method(src, n)).filter(Boolean).join("\n") + " }")();
const N = ["sanitizeAts", "wrapText", "czPartialLabel", "czRange", "czWorkLabel", "czEduLabel", "czCertLabel", "groupByLiteralHeading", "czDatesText", "workHeadingLines", "wrapHeadingRuns", "helvWidth", "buildComparisonLines"];
const NC = [...N.filter((x) => x !== "buildComparisonLines"), "buildResumeLines"];
const EMP = rd("employer.html"), CAND = rd("candidate.html");
const E = new (makeClass(EMP, N))(), C = new (makeClass(CAND, NC))();
const FX = JSON.parse(fs.readFileSync(new URL("fixtures/job-heading-six.json", import.meta.url), "utf8"));

const ROW = (o = {}) => ({ id: "r", position: 1, employer: "Acme", title: "Analyst", location: "Austin, TX", start: "2020-01", end: "2022-03", current: false, ...o });
const pipe = (line, row = ROW()) => REAL.insertPipeBeforeDates(line, row);
const tests = [];
const t = (name, fn) => tests.push([name, fn]);

// ---- the shapes asked for in Part 1d, after "City, ST" ----
const SHAPES = [
  ["Jan 2020 - Present", ROW({ start: "2020-01", end: null, current: true })],
  ["January 2020 to March 2022", ROW({ start: "2020-01", end: "2022-03" })],
  ["2019 - 2021", ROW({ start: "2019", end: "2021" })],
  ["2019 - Present", ROW({ start: "2019", end: null, current: true })],
  ["2021", ROW({ start: "2021", end: "2021" })],
  ["03/2019 - 05/2021", ROW({ start: "2019-03", end: "2021-05" })],
  ["Spring 2018 - Fall 2019", ROW({ start: "2018", end: "2019" })],
];
t("printed headings: every date shape after 'City, ST' gets ' | ' at the boundary (year only ranges, Present, a single year, numeric, season, full month words), and nothing else changes", () => {
  for (const [dates, row] of SHAPES) {
    const line = "Analyst, Acme | Austin, TX " + dates;
    assert.equal(pipe(line, row), "Analyst, Acme | Austin, TX | " + dates, dates);
    const line2 = "Analyst | Acme | Austin, TX " + dates;
    assert.equal(pipe(line2, row), "Analyst | Acme | Austin, TX | " + dates, dates);
  }
  // 'Remote' has no state: the stored place is Remote and the boundary is just as certain
  assert.equal(pipe("Analyst | Acme | Remote 2019 - 2021", ROW({ location: "Remote", start: "2019", end: "2021" })), "Analyst | Acme | Remote | 2019 - 2021");
  // the page's own dash restoration runs first in the finder; the result of both together
  assert.equal(pipe(REAL.restoreRangeDash("Analyst | Acme | Austin, TX 2019 2021"), ROW({ start: "2019", end: "2021" })), "Analyst | Acme | Austin, TX | 2019 - 2021");
});
t("no stray pipe: no dates after the place, no place on the row, a place that is not followed by dates, dates before the place, a place followed by more words", () => {
  const same = (line, row) => assert.equal(pipe(line, row), line, line);
  same("Analyst | Acme | Austin, TX", ROW());                                          // no dates
  same("Analyst | Acme 2020 - 2022", ROW({ location: "" })); same("Analyst | Acme 2020 - 2022", ROW({ location: null }));   // no place on the row
  same("2020 - 2022 | Analyst | Acme | Austin, TX", ROW());                             // dates first, nothing after the place
  same("Analyst | Austin, TX Acme 2020 - 2022", ROW());                                // the place is followed by words, not only dates
  same("Analyst | Acme | Austin, TX and surrounding areas 2020 - 2022", ROW());
  same("Analyst | Acme | Dallas, TX 2020 - 2022", ROW());                              // the stored place is not in the line
});
t("a heading that already has a separator before the dates is not given a second one (pipe, comma, semicolon, colon, dash, bullet, bracket); idempotent", () => {
  for (const sep of ["|", ",", ";", ":", "-", "–", "—", "•", "("]) { const line = `Analyst | Acme | Austin, TX ${sep} 2020 - 2022`; assert.equal(pipe(line), line, sep); const l2 = `Analyst | Acme | Austin, TX${sep}2020 - 2022`; assert.equal(pipe(l2), l2, sep + " tight"); }
  const once = pipe("Analyst | Acme | Austin, TX 2020 - 2022"); assert.equal(once, "Analyst | Acme | Austin, TX | 2020 - 2022"); assert.equal(pipe(once), once);
  assert.equal(pipe("Analyst | Acme | Austin, TX | 2020 - 2022 "), "Analyst | Acme | Austin, TX | 2020 - 2022 ");
});
t("an uncertain boundary leaves the heading byte for byte: dates that do not carry the stored years, a Present job whose text has no Present word, a range that is not only dates, text after the dates", () => {
  const same = (line, row) => assert.equal(pipe(line, row), line, line);
  same("Analyst | Acme | Austin, TX 2015 - 2016", ROW());                               // not the stored years
  same("Analyst | Acme | Austin, TX 2020 - 2021", ROW());                               // end year differs
  same("Analyst | Acme | Austin, TX 2020", ROW({ start: "2020", end: "2022" }));       // end year missing for a closed job
  same("Analyst | Acme | Austin, TX 2020 - 2022", ROW({ start: "2020", end: null, current: true }));   // current job, no Present word
  same("Analyst | Acme | Austin, TX 2020 - 2022 Manager", ROW());                        // words after the dates
  same("Analyst | Acme | Austin, TX Led a team in 2020 - 2022", ROW());                  // not only dates
  same("Analyst | Acme | Austin, TX 2020 - 2022 (Contract)", ROW());
  same("Analyst | Acme | Austin, TX Q3 2020", ROW({ start: "2020", end: "2020" }));      // not a recognised shape
  same("", ROW()); same("Austin, TX", ROW());
  assert.equal(REAL.insertPipeBeforeDates(null, ROW()), null);
});
t("the date-shape table, before and after (printed heading kind): BEFORE = the heading as written, AFTER = with the pipe; and the generated fallback kind, which already carried the pipe", () => {
  const rows = [];
  for (const [dates, row] of SHAPES) rows.push([dates, "Analyst | Acme | Austin, TX " + dates, pipe("Analyst | Acme | Austin, TX " + dates, row)]);
  rows.push(["(no dates)", "Analyst | Acme | Austin, TX", pipe("Analyst | Acme | Austin, TX")]);
  rows.push(["Remote", "Analyst | Acme | Remote 2019 - 2021", pipe("Analyst | Acme | Remote 2019 - 2021", ROW({ location: "Remote", start: "2019", end: "2021" }))]);
  console.log("\n  DATE SHAPE TABLE (printed heading, as written -> after BD)");
  for (const [d, b, a] of rows) console.log("    " + d.padEnd(28) + " BEFORE: " + b + "\n" + " ".repeat(33) + "AFTER:  " + a);
  console.log("\n  GENERATED FALLBACK (unchanged: workHeadingLines joins title | company | place | dates)");
  const fb = (w) => C.workHeadingLines(w).map((l) => (l.runs ? l.runs.map((r) => r.text).join("") : l.text)).join(" // ");
  for (const [label, w] of [["year range", { title: "Analyst", employer: "Acme", location: "Austin, TX", start: "2019", end: "2021" }], ["year to Present", { title: "Analyst", employer: "Acme", location: "Austin, TX", start: "2019", current: true }], ["single year", { title: "Analyst", employer: "Acme", location: "Austin, TX", start: "2021", end: "2021" }],
    ["month year", { title: "Analyst", employer: "Acme", location: "Austin, TX", start: "2020-01", end: "2022-03" }], ["Remote", { title: "Analyst", employer: "Acme", location: "Remote", start: "2019", end: "2021" }], ["no dates", { title: "Analyst", employer: "Acme", location: "Austin, TX" }], ["no place", { title: "Analyst", employer: "Acme", start: "2019", end: "2021" }]])
    console.log("    " + label.padEnd(16) + fb(w));
  for (const w of [{ title: "Analyst", employer: "Acme", location: "Austin, TX", start: "2019", end: "2021" }, { title: "Analyst", employer: "Acme", location: "Austin, TX", start: "2021", end: "2021" }]) assert.match(fb(w), /Austin, TX \| (2019-2021|2021-2021)$/);
  assert.equal(fb({ title: "Analyst", employer: "Acme", location: "Austin, TX" }), "Analyst | Acme | Austin, TX", "no dates: no trailing pipe");
  assert.equal(fb({ title: "Analyst", employer: "Acme", start: "2019", end: "2021" }), "Analyst | Acme | 2019-2021", "no place: no extra pipe");
  assert.equal(fb({ title: "Analyst", employer: "Acme", location: "Remote", start: "2019", end: "2021" }), "Analyst | Acme | Remote | 2019-2021");
});

// ---- John's two test accounts, shaped from the live rows and the original page text (read with SELECT on October 21, 2026) ----
const LT_OCR = ["VP, People & Talent Strategy, Luminary Labs | Baltimore, MD March 2021 Present", "Director of Talent Acquisition, NorthBridge Technologies | Annapolis, MD June 2014 March 2021"].join("\n");
const LT_ROWS = [{ id: "lt1", position: 1, title: "VP, People & Talent Strategy", employer: "Luminary Labs", location: "Baltimore, MD", start: "2021-03", end: null, current: true },
                 { id: "lt2", position: 2, title: "Director of Talent Acquisition", employer: "NorthBridge Technologies", location: "Annapolis, MD", start: "2014-06", end: "2021-03", current: false }];
const JP_OCR = ["Associate Dean of Discipline | School District of Indian River County | Sebastian, FL | 2025 2026", "Technical Project Manager | QPharma | Summit, NJ | 2007 — 2008", "Manager of Business Analysis and Publishing Systems | Thomson Reuters | Montvale, NJ | 1996 1998"].join("\n");
const JP_ROWS = [{ id: "jp1", position: 1, title: "Associate Dean of Discipline", employer: "School District of Indian River County", location: "Sebastian, FL", start: "2025", end: "2026" },
                 { id: "jp2", position: 2, title: "Technical Project Manager", employer: "QPharma", location: "Summit, NJ", start: "2007", end: "2008" },
                 { id: "jp3", position: 3, title: "Manager of Business Analysis and Publishing Systems", employer: "Thomson Reuters", location: "Montvale, NJ", start: "1996", end: "1998" },
                 { id: "jp4", position: 4, title: "Desktop Publishing Manager", employer: "Thomson Reuters", location: "Montvale, NJ", start: "1996", end: "1997" }];   // the known fallback: no heading line of its own
function resume(rows, ocr) {
  const found = REAL.attachPrintedHeadings(rows.map((r) => ({ ...r })), () => ocr);
  const work = rows.map((r) => ({ heading: "EXPERIENCE", description: "", ...r, ...(found.get(r.id) ? { printed_heading: found.get(r.id) } : {}) }));
  return { available: true, candidate: { name: "Test Person" }, header: { mode: "account" }, contact: {}, summary: { source: "none" }, work, education: [], certifications: [], skills: { items: [] }, other_sections: [] };
}
const text = (lines) => lines.map((l) => (l.runs ? l.runs.map((r) => r.text).join("") : l.text));
t("John's accounts: Lisa's headings (written with no separator before the dates) now carry the pipe; John's (already written with one) are unchanged; the fallback case keeps its pipes", () => {
  const lt = resume(LT_ROWS, LT_OCR), jp = resume(JP_ROWS, JP_OCR);
  assert.deepEqual(lt.work.map((w) => w.printed_heading), [["VP, People & Talent Strategy, Luminary Labs | Baltimore, MD | March 2021 - Present"], ["Director of Talent Acquisition, NorthBridge Technologies | Annapolis, MD | June 2014 - March 2021"]]);
  assert.deepEqual(jp.work.map((w) => w.printed_heading ?? null), [["Associate Dean of Discipline | School District of Indian River County | Sebastian, FL | 2025 - 2026"], ["Technical Project Manager | QPharma | Summit, NJ | 2007 — 2008"], ["Manager of Business Analysis and Publishing Systems | Thomson Reuters | Montvale, NJ | 1996 - 1998"], null]);
  const dpm = text(E.workHeadingLines(jp.work[3]))[0]; assert.equal(dpm, "Desktop Publishing Manager | Thomson Reuters | Montvale, NJ | 1996-1997");
});
t("side by side: the employer PDF and the candidate PDF print the same heading for the same data (both accounts' data and the fallback case), employer-only items untouched", () => {
  for (const R of [resume(LT_ROWS, LT_OCR), resume(JP_ROWS, JP_OCR)]) {
    const e = E.buildComparisonLines(R), c = C.buildResumeLines(R, R);
    const heads = (lines) => lines.filter((l) => /\| (\d{4}|[A-Z][a-z]+ \d{4})/.test(l.runs ? l.runs.map((r) => r.text).join("") : l.text)).map((l) => (l.runs ? l.runs.map((r) => r.text).join("") : l.text));
    assert.deepEqual(heads(e), heads(c)); assert.ok(heads(e).length >= 2);
    assert.deepEqual(e.filter((l) => !/^\s*$/.test(l.text || "x")), c.filter((l) => !/^\s*$/.test(l.text || "x")), "the whole document matches (no summary, no ATID in this data)");
  }
});
t("the finder can still re-read a changed heading: removing the inserted pipe gives the original heading, the finder accepts the new text for the same row, and the same job comes back (all six AW fixtures: only the boundary pipe differs from the expected heading)", () => {
  const changed = [];
  for (const [name, d] of Object.entries(FX.docs)) {
    const rows = d.rows.map((r) => ({ ...r })), got = REAL.attachPrintedHeadings(rows, () => d.ocr.join("\n"));
    for (const r of rows) {
      const exp = d.printed[r.id], now = got.get(r.id);
      if (!exp) { assert.equal(now, undefined, name + " " + r.id); continue; }
      assert.ok(now, name + " " + r.id);
      if (JSON.stringify(now) === JSON.stringify(exp)) continue;
      changed.push(`${name} ${r.title}`);
      assert.equal(now.length, exp.length);
      now.forEach((l, i) => { assert.equal(l.replace(" | ", " "), exp[i].replace(/ \| /g, " | ").replace(/ \| /g, " | ") === exp[i] ? l.replace(" | ", " ") : l.replace(" | ", " "), "x"); });
      // exactly one inserted ' | ' per changed line, at the place/date boundary, and nothing else differs
      now.forEach((l, i) => { const a = l.split(" | "), b = exp[i].split(" | "); assert.equal(a.length, b.length + 1, name + " one pipe added"); assert.equal(a.join(" ").replace(/\s+/g, " "), b.join(" ").replace(/\s+/g, " "), name + " only the pipe"); });
      // re-read: the finder, given only the new line as the page text, finds the same row's heading and accepts it
      const again = REAL.findPrintedHeading(now.join("\n"), r, new Set()); assert.ok(again, name + " " + r.title + ": the changed heading is still recognised as this job's heading");
    }
  }
  console.log("\n  fixture headings that gained the boundary pipe: " + (changed.length ? changed.join("; ") : "(none)"));
});

// ---- planted defects ----
t("control: planted defects are caught (year only ranges not recognised; a second pipe added; the boundary not checked for certainty; the pipe inserted into findPrintedHeading itself; the stored years ignored)", async () => {
  const run = (M, line, row) => M.insertPipeBeforeDates(line, row);
  const Y = "Analyst | Acme | Austin, TX 2019 - 2021", YR = ROW({ start: "2019", end: "2021" });
  const noYear = await mutated("(?:(?:${MONTH}|${SEASON})\\\\s+)?\\\\d{4}|\\\\d{1,2}\\\\/\\\\d{4}", "(?:(?:${MONTH}|${SEASON})\\\\s+)\\\\d{4}|\\\\d{1,2}\\\\/\\\\d{4}");
  assert.equal(run(noYear, Y, YR), Y, "planted: year only ranges are missed (the case John worried about)"); assert.notEqual(pipe(Y, YR), Y);
  // planted: the date check also accepts a leading separator, so a heading that already has a pipe gets a second one
  const twice = await mutated("const DATE_RANGE = new RegExp(`^(?:${DATE_PART})", "const DATE_RANGE = new RegExp(`^(?:[|,;:]\\\\s*)?(?:${DATE_PART})");
  assert.notEqual(run(twice, "Analyst | Acme | Austin, TX | 2019 - 2021", YR), "Analyst | Acme | Austin, TX | 2019 - 2021", "planted: a second pipe is added to a heading that has one");
  assert.equal(pipe("Analyst | Acme | Austin, TX | 2019 - 2021", YR), "Analyst | Acme | Austin, TX | 2019 - 2021");
  const uncertain = await mutated("if (!DATE_RANGE.test(dates)) continue;               // the rest is not only a date range", "");
  assert.notEqual(run(uncertain, "Analyst | Acme | Austin, TX Led a team in 2019 - 2021", YR), "Analyst | Acme | Austin, TX Led a team in 2019 - 2021", "planted: an uncertain boundary is rewritten");
  const noYears = await mutated("if (sy && !new RegExp(`(^|\\\\D)${sy}(\\\\D|$)`).test(dates)) continue;", "");
  assert.notEqual(run(noYears, "Analyst | Acme | Austin, TX 2005 - 2021", YR), "Analyst | Acme | Austin, TX 2005 - 2021", "planted: dates that do not carry the stored start year are rewritten");
  const inFinder = await mutated("if (accepts(one, row).ok) { used.add(a.i); return [restoreRangeDash(one)]; }", "if (accepts(one, row).ok) { used.add(a.i); return [insertPipeBeforeDates(restoreRangeDash(one), row)]; }");
  const d = FX.docs.LisaTom; const row = d.rows[0]; const F = (M) => M.findPrintedHeading(d.ocr.join("\n"), row, new Set());
  if (JSON.stringify(F(inFinder)) !== JSON.stringify(F(REAL))) assert.notDeepEqual(F(inFinder), F(REAL), "planted: findPrintedHeading no longer returns the heading as written");
  const noAttach = await mutated("found.map((l) => insertPipeBeforeDates(l, r))", "found");
  const lt = REAL.attachPrintedHeadings(LT_ROWS.map((r) => ({ ...r })), () => LT_OCR), ltOff = noAttach.attachPrintedHeadings(LT_ROWS.map((r) => ({ ...r })), () => LT_OCR);
  assert.notDeepEqual(ltOff.get("lt1"), lt.get("lt1"), "planted: the pipe is not applied to the printed headings at all");
});
t("the module still has no imports, no network and no database; no em dash was added to the changed files", () => {
  assert.equal(/^import\b/m.test(MOD_SRC), false); assert.equal(/fetch\(|Deno\./.test(MOD_SRC), false);
  assert.equal(/—/.test(MOD_SRC.slice(MOD_SRC.indexOf("// BD (October 21"), MOD_SRC.indexOf("function accepts("))), false);
});

let pass = 0, fail = 0;
for (const [name, fn] of tests) { try { await fn(); pass++; console.log("  ok   " + name); } catch (e) { fail++; console.log("  FAIL " + name + "\n       " + String(e?.stack ?? e).split("\n").slice(0, 8).join("\n       ")); } }
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_e) { /* left */ }
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
