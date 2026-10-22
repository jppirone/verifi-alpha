// node --experimental-strip-types tools/resume/test-work-overlap-same-company.ts   (no dependencies, no network)
// AP9 rule 11: the work overlap check (30 day rule) never flags two roles of the SAME company. The check exists as two copies,
// one in confirm-resume-data and one in resume-resubmission; this test reads each copy's own source and runs it.
import assert from "node:assert/strict";
import fs from "node:fs";
import { stripTypeScriptTypes } from "node:module";

let n = 0; const t = (name: string, fn: () => void) => { fn(); n++; console.log("ok  ", name); };

function load(file: string) {
  const src = fs.readFileSync(new URL(`../../supabase/functions/${file}/index.ts`, import.meta.url), "utf8").replace(/\r\n/g, "\n");
  const start = src.indexOf("type OverlapItem");
  const end = src.indexOf("\n}\n", src.indexOf("function detectWorkOverlaps")) + 3;
  assert.ok(start > 0 && end > start, `${file}: overlap source not found`);
  const js = stripTypeScriptTypes(src.slice(start, end)) + "\nexport { detectWorkOverlaps };";
  return import("data:text/javascript;base64," + Buffer.from(js, "utf8").toString("base64")).then((m) => m.detectWorkOverlaps as (items: any[]) => any[]);
}

for (const file of ["confirm-resume-data", "resume-resubmission"]) {
  const detect = await load(file);
  t(`${file}: two roles of the same company that overlap by months are not flagged`, () => {
    const items = [
      { id: "a", company: "Thomson Reuters", start: "1996-01-01", end: "1998-01-01" },
      { id: "b", company: "Thomson Reuters", start: "1996-01-01", end: "1997-01-01" },
    ];
    assert.deepEqual(detect(items), []);
  });
  t(`${file}: the company match ignores case, spacing and punctuation`, () => {
    const items = [
      { id: "a", company: "WESTCX", start: "2023-09-01", end: "2026-08-01" },
      { id: "b", company: "WestCX.", start: "2024-01-01", end: "2025-01-01" },
    ];
    assert.deepEqual(detect(items), []);
  });
  t(`${file}: two different companies that overlap by more than 30 days are still flagged`, () => {
    const items = [
      { id: "a", company: "Acme Corp", start: "2020-01-01", end: "2022-01-01" },
      { id: "b", company: "Other Corp", start: "2021-01-01", end: "2023-01-01" },
    ];
    const r = detect(items);
    assert.equal(r.length, 1); assert.deepEqual([r[0].a, r[0].b], ["a", "b"]);
  });
  t(`${file}: a missing company is never treated as a match (still flagged)`, () => {
    const items = [
      { id: "a", start: "2020-01-01", end: "2022-01-01" },
      { id: "b", company: "", start: "2021-01-01", end: "2023-01-01" },
    ];
    assert.equal(detect(items).length, 1);
  });
  t(`${file}: exactly 30 days still does not trigger, 31 does (unchanged rule)`, () => {
    // BH (October 21, 2026): day precision stated explicitly, so these stay the boundary of the plain 30 day rule (a year only date would be judged by the certain overlap rule instead)
    const D = { startPrecision: "day", endPrecision: "day" };
    assert.equal(detect([{ id: "a", company: "X", start: "2020-01-01", end: "2020-02-01", ...D }, { id: "b", company: "Y", start: "2020-01-01", end: "2020-03-01", ...D }]).length, 1); // 31 days
    assert.equal(detect([{ id: "a", company: "X", start: "2020-01-01", end: "2020-01-31", ...D }, { id: "b", company: "Y", start: "2020-01-01", end: "2020-03-01", ...D }]).length, 0); // 30 days
  });
}
console.log(`\n${n} tests passed`);
