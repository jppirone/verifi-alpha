// node --experimental-strip-types tools/resume/test-date-normalize.ts   (no network, no model call, no database)
// AP9AA-2: "Mon YYYY" / "Month YYYY" / "MM/YYYY" dates become "YYYY-MM" before insert_resume_extraction (supabase/functions/_shared/resume-date-normalize.ts, called from
// upload-resume). The database function parse_partial_date accepts only YYYY, YYYY-MM and YYYY-MM-DD, so everything else is left exactly as given.
import assert from "node:assert/strict";
import fs from "node:fs";
import { normalizePartialDate, normalizeExtractionDates } from "../../supabase/functions/_shared/resume-date-normalize.ts";

const tests: Array<[string, () => void | Promise<void>]> = [];
const t = (name: string, fn: () => void | Promise<void>) => tests.push([name, fn]);
const n = (v: unknown) => normalizePartialDate(v);

t("the ten inputs of the AP9Z report", () => {
  const want: Array<[string, string]> = [["Nov 2020", "2020-11"], ["May 2023", "2023-05"], ["Sep 2020", "2020-09"], ["Jan 2011", "2011-01"], ["2023-09", "2023-09"], ["Sep 2023", "2023-09"], ["September 2023", "2023-09"], ["11/2020", "2020-11"], ["2020", "2020"], ["Present", "Present"]];
  for (const [i, o] of want) assert.equal(n(i), o, i);
  console.log("      " + want.map(([i]) => `${JSON.stringify(i)} -> ${JSON.stringify(n(i))}`).join("; "));
});

t("more spellings: Sept., sep, SEP, 9/2023, 09/2023, outer spaces, full names, May, Jun/June", () => {
  const want: Array<[string, string]> = [["Sept. 2023", "2023-09"], ["Sept 2023", "2023-09"], ["sep 2023", "2023-09"], ["SEP 2023", "2023-09"], ["9/2023", "2023-09"], ["09/2023", "2023-09"], ["  Nov 2020  ", "2020-11"], ["Nov  2020", "2020-11"], ["NOVEMBER 2020", "2020-11"], ["Dec. 2019", "2019-12"], ["June 2012", "2012-06"], ["Jun 2012", "2012-06"], ["may 2023", "2023-05"], ["12/1999", "1999-12"], ["1/2001", "2001-01"], ["Jan. 1900", "1900-01"], ["Dec 2100", "2100-12"]];
  for (const [i, o] of want) assert.equal(n(i), o, JSON.stringify(i));
  console.log("      " + want.slice(0, 9).map(([i]) => `${JSON.stringify(i)} -> ${JSON.stringify(n(i))}`).join("; "));
});

t("left untouched, byte for byte: empty, null, non-strings, Present words, ranges, MM/DD/YYYY, free text, bad month, bad year", () => {
  for (const v of ["", "   ", null, undefined, 2020, {}, [], "Present", "present", "Current", "Now", "Ongoing", "garbage", "03/15/2020", "3/15/2020", "Nov 2020 - May 2023", "Nov 2020 to May 2023", "2020-2023", "Nov 2020-May 2023", "Smarch 2020", "Nove 2020", "13/2020", "0/2020", "00/2020", "Nov 1899", "Nov 2101", "Nov 20", "Nov 20201", "11-2020", "2020/11", "Q3 2020", "Fall 2020", "Nov 15, 2020", "15 Nov 2020", "Nov", "2023-09-15", "2023-9", "2023-13", "Nov. . 2020", "Nov.. 2020"]) {
    const out = n(v);
    assert.ok(Object.is(out, v) || out === v, `${JSON.stringify(v)} -> ${JSON.stringify(out)}`);
  }
});

t("property: every value the database already accepts comes back byte for byte (every YYYY, YYYY-MM and YYYY-MM-DD from 1900 to 2100, plus the Present words)", () => {
  let checked = 0;
  for (let y = 1900; y <= 2100; y++) {
    const ys = String(y);
    for (const v of [ys, ` ${ys} `]) { assert.equal(n(v), v); checked++; }
    for (let m = 1; m <= 12; m++) {
      const mm = String(m).padStart(2, "0");
      for (const v of [`${ys}-${mm}`, `${ys}-${mm}-01`, `${ys}-${mm}-15`, `${ys}-${mm}-28`]) { assert.equal(n(v), v); checked++; }
    }
  }
  for (const v of ["Present", "PRESENT", "present", "Current", "Now", "Ongoing", ""]) { assert.equal(n(v), v); checked++; }
  console.log("      " + checked + " values checked");
});

t("every output of the changed forms is exactly YYYY-MM (the form the database accepts)", () => {
  const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const FULL = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
  for (let y = 1900; y <= 2100; y += 7) for (let m = 0; m < 12; m++) {
    const want = `${y}-${String(m + 1).padStart(2, "0")}`;
    for (const v of [`${MONTHS[m]} ${y}`, `${MONTHS[m]}. ${y}`, `${FULL[m]} ${y}`, `${FULL[m].toUpperCase()} ${y}`, `${m + 1}/${y}`, `${String(m + 1).padStart(2, "0")}/${y}`]) assert.equal(n(v), want, v);
  }
});

t("the 14 raw work dates stored for the three documents (2f1fdc89, 0e83aff1, 74fb873c) all change to YYYY-MM; the mapping is printed", () => {
  const raw = ["Nov 2020", "May 2023", "Nov 2015", "Sep 2020", "Nov 2015", "Jan 2011", "Oct 2008", "Mar 2011", "Apr 2011", "Aug 2015", "Oct 2008", "Mar 2011", "Apr 2011", "Aug 2015"];
  assert.equal(raw.length, 14);
  const out = raw.map((v) => n(v) as string);
  for (const o of out) assert.match(o, /^\d{4}-(0[1-9]|1[0-2])$/);
  assert.deepEqual(out, ["2020-11", "2023-05", "2015-11", "2020-09", "2015-11", "2011-01", "2008-10", "2011-03", "2011-04", "2015-08", "2008-10", "2011-03", "2011-04", "2015-08"]);
});

const wh = (company: string, start: unknown, end: unknown, extra: any = {}) => ({ company, title: "T", location: "", start_date: start, end_date: end, job_responsibilities: "x", extraction_confidence: "high", position: 0, ...extra });
t("document 2f1fdc89 shape: the three page-2 jobs get YYYY-MM dates, the two jobs that were already correct are the SAME objects; log text is exact", () => {
  const ex = {
    work_history: [wh("WESTCX", "2023-09", "2026-08"), wh("CONTRACT ENGAGEMENTS", "Nov 2020", "May 2023"), wh("CDW", "Nov 2015", "Sep 2020"), wh("ALLEGIS GLOBAL SOLUTIONS", "Jan 2011", "Nov 2015"), wh("RANDSTAD", "2006-10", "2010-12"), wh("NOW CO", "2024", "Present")],
    education: [{ institution: "BYU", degree: "x", field_of_study: "y", start_date: "", end_date: "", heading: "EDUCATION" }],
    certifications: [{ name: "c", issuing_body: "i", issue_date: "", expiration_date: "" }],
    freeform: [], skills: [],
  };
  const before = JSON.stringify(ex);
  const r = normalizeExtractionDates(ex as any);
  assert.equal(JSON.stringify(ex), before, "the input is not modified");
  assert.equal(r.changed, 6); assert.equal(r.first, "Nov 2020 -> 2020-11");
  const w = r.extraction.work_history as any[];
  assert.deepEqual(w.map((x) => [x.start_date, x.end_date]), [["2023-09", "2026-08"], ["2020-11", "2023-05"], ["2015-11", "2020-09"], ["2011-01", "2015-11"], ["2006-10", "2010-12"], ["2024", "Present"]]);
  assert.strictEqual(w[0], ex.work_history[0]); assert.strictEqual(w[4], ex.work_history[4]); assert.strictEqual(w[5], ex.work_history[5]);
  assert.equal(JSON.stringify(r.extraction.education), JSON.stringify(ex.education)); assert.equal(JSON.stringify(r.extraction.certifications), JSON.stringify(ex.certifications));
  assert.equal(`upload-resume: DOC dates normalized: ${r.changed} value(s), first: ${r.first}`, "upload-resume: DOC dates normalized: 6 value(s), first: Nov 2020 -> 2020-11");
});

t("nothing to change: the very same extraction object comes back, changed 0, no log", () => {
  const ex = { work_history: [wh("A", "2019", "Present"), wh("B", "2019-04", "2020-05-01"), wh("C", "", "")], education: [], certifications: [], freeform: [] };
  const r = normalizeExtractionDates(ex as any);
  assert.strictEqual(r.extraction, ex); assert.equal(r.changed, 0); assert.equal(r.first, null);
});

t("education and certification dates are normalized with the same rule (issue_date / expiration_date for certifications)", () => {
  const ex = { work_history: [], education: [{ institution: "U", start_date: "Sep 2001", end_date: "May 2005" }], certifications: [{ name: "N", issue_date: "6/2019", expiration_date: "Jun 2022" }, { name: "M", issue_date: "2019", expiration_date: "" }], freeform: [] };
  const r = normalizeExtractionDates(ex as any);
  assert.equal(r.changed, 4);
  assert.deepEqual((r.extraction.education as any[]).map((e) => [e.start_date, e.end_date]), [["2001-09", "2005-05"]]);
  assert.deepEqual((r.extraction.certifications as any[]).map((c) => [c.issue_date, c.expiration_date]), [["2019-06", "2022-06"], ["2019", ""]]);
  assert.strictEqual((r.extraction.certifications as any[])[1], ex.certifications[1]);
});

t("never throws: odd shapes return the original", () => {
  const bad: any = { get work_history() { throw new Error("boom"); }, education: [], certifications: [] };
  const r = normalizeExtractionDates(bad); assert.strictEqual(r.extraction, bad); assert.equal(r.changed, 0);
  for (const odd of [{ work_history: null, education: undefined, certifications: "x" }, { work_history: [null, 3, "s", wh("A", "Nov 2020", "")], education: [], certifications: [] }] as any[]) {
    const o = normalizeExtractionDates(odd); assert.ok(o.extraction);
  }
  const mixed = normalizeExtractionDates({ work_history: [null, 3, "s", wh("A", "Nov 2020", "")], education: [], certifications: [] } as any);
  assert.equal(mixed.changed, 1); assert.equal((mixed.extraction.work_history as any[])[3].start_date, "2020-11");
  assert.equal(n(Symbol.iterator as any), Symbol.iterator);
  const evil = { toString() { throw new Error("x"); } };
  assert.strictEqual(n(evil), evil);
});

// ---------- wiring in upload-resume (read from the source) ----------
t("upload-resume calls the normalizer before BOTH insert_resume_extraction calls and logs one line only when something changed", () => {
  const src = fs.readFileSync(new URL("../../supabase/functions/upload-resume/index.ts", import.meta.url), "utf8").replace(/\r\n/g, "\n");
  assert.ok(src.includes('import { normalizeExtractionDates } from "../_shared/resume-date-normalize.ts";'));
  const calls = [...src.matchAll(/supabase\.rpc\("insert_resume_extraction"/g)].map((m) => m.index as number);
  assert.equal(calls.length, 2);
  const norms = [...src.matchAll(/normalizeExtractionDates\((merged|extraction)\)/g)].map((m) => m.index as number);
  assert.equal(norms.length, 2);
  for (let i = 0; i < 2; i++) { assert.ok(norms[i] < calls[i], "normalizer #" + (i + 1) + " is before insert #" + (i + 1)); assert.ok(calls[i] - norms[i] < 1500, "and close to it"); }
  assert.equal([...src.matchAll(/dates normalized: \$\{/g)].length, 2);
  assert.equal([...src.matchAll(/if \(datesFixed(Pdf|Vision)\.changed > 0\)/g)].length, 2, "log only when changed");
});

let failed = 0;
for (const [name, fn] of tests) {
  try { await fn(); console.log("  ok   " + name); } catch (e: any) { failed++; console.log("  FAIL " + name + "\n       " + String(e?.message ?? e).split("\n").slice(0, 6).join("\n       ")); }
}
console.log(`\n${tests.length - failed} passed, ${failed} failed`);
if (failed) process.exit(1);
