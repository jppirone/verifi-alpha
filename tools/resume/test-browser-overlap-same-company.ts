// node --experimental-strip-types tools/resume/test-browser-overlap-same-company.ts   (no dependencies, no network, no model call)
// AP9G: the browser copy of the overlap check (candidate.html, detectWorkOverlaps) skips two roles of the SAME company, exactly like the
// two edge function copies. This test cuts the three browser methods out of candidate.html's own source, runs them, and also runs the
// edge function copies' own source on the same inputs to show that browser and server agree.
import assert from "node:assert/strict";
import fs from "node:fs";
import { stripTypeScriptTypes } from "node:module";

let n = 0; const t = (name: string, fn: () => void) => { fn(); n++; console.log("ok  ", name); };
const html = fs.readFileSync(new URL("../../candidate.html", import.meta.url), "utf8").replace(/\r\n/g, "\n");
const a0 = html.indexOf("  effectiveWorkEndForOverlap(endDate, endPrecision) {");
const a1 = html.indexOf("    return pairs;\n  }", a0) + "    return pairs;\n  }".length;
assert.ok(a0 > 0 && a1 > a0, "browser overlap methods not found in candidate.html");
const slice = html.slice(a0, a1);
assert.ok(slice.includes("overlapCompanyKey(") && slice.includes("detectWorkOverlaps("), "the browser slice must hold the company key and the detector");
const mk = (src: string) => new Function(`return class { ${src} }`)();
const Browser: any = mk(slice);
const B = new Browser();
// the same slice with the company line removed: shows what the page did before this change (negative control)
const Old: any = new (mk(slice.split("\n").filter((l) => !l.includes("this.overlapCompanyKey(a.item.company) &&")).join("\n")))();

function serverDetect(file: string) {
  const src = fs.readFileSync(new URL(`../../supabase/functions/${file}/index.ts`, import.meta.url), "utf8").replace(/\r\n/g, "\n");
  const s = src.indexOf("type OverlapItem");
  const e = src.indexOf("\n}\n", src.indexOf("function detectWorkOverlaps")) + 3;
  const js = stripTypeScriptTypes(src.slice(s, e)) + "\nreturn detectWorkOverlaps;";
  return new Function(js)() as (items: any[]) => any[];
}
const serverRule = {
  confirm: serverDetect("confirm-resume-data"),
  resub: serverDetect("resume-resubmission"),
};

// a work row as the page holds it
const row = (id: string, company: string | null | undefined, title: string, sd: string, ed: string | null, ep = "year"): any => ({ id, company, title, start_date: sd, end_date: ed, start_date_precision: "year", end_date_precision: ep });
const flagged = (rows: any[]) => B.detectWorkOverlaps(rows).map((p: any) => [p.a.id, p.b.id, p.days]);
const serverFlagged = (rows: any[]) => [serverRule.confirm, serverRule.resub].map((f) => f(rows.map((r) => ({ id: r.id, company: r.company, start: r.start_date, end: r.end_date, startPrecision: r.start_date_precision, endPrecision: r.end_date_precision }))).map((p: any) => [p.a, p.b, p.days]));

t("the browser rule text is the server rule text (same key function, same skip line)", () => {
  const server = fs.readFileSync(new URL("../../supabase/functions/confirm-resume-data/index.ts", import.meta.url), "utf8");
  assert.ok(server.includes('c.toLowerCase().replace(/[^a-z0-9]+/g, "")'));
  assert.ok(slice.includes("c.toLowerCase().replace(/[^a-z0-9]+/g, '')"));
});

t("same company, overlapping dates: not flagged", () => {
  assert.deepEqual(flagged([row("a", "Acme Corp", "Director", "2018-01-01", "2023-01-01"), row("b", "Acme Corp", "Manager", "2019-01-01", "2021-01-01")]), []);
});

t("different company, overlapping dates: flagged", () => {
  const r = flagged([row("a", "Acme Corp", "Director", "2018-01-01", "2023-01-01"), row("b", "Other Corp", "Manager", "2019-01-01", "2021-01-01")]);
  assert.equal(r.length, 1); assert.deepEqual([r[0][0], r[0][1]], ["a", "b"]);
});

t("empty company on either row or both rows never matches: overlapping dates are flagged", () => {
  for (const [ca, cb] of [["", "Acme Corp"], ["Acme Corp", ""], ["", ""], [null, null], [undefined, "Acme Corp"], ["  ", "  "], ["...", "---"]] as any[]) {
    assert.equal(flagged([row("a", ca, "X", "2018-01-01", "2023-01-01"), row("b", cb, "Y", "2019-01-01", "2021-01-01")]).length, 1, JSON.stringify([ca, cb]));
  }
});

t("company names that differ only in case, punctuation or spacing are the same company", () => {
  for (const [ca, cb] of [["Thomson Reuters", "THOMSON REUTERS."], ["Thomson Reuters", "thomson  reuters"], ["Thomson-Reuters", "Thomson Reuters,"], ["WESTCX", "WestCX."]]) {
    assert.deepEqual(flagged([row("a", ca, "X", "2018-01-01", "2023-01-01"), row("b", cb, "Y", "2019-01-01", "2021-01-01")]), [], `${ca} / ${cb}`);
  }
});

t("names that differ in a real letter or digit are different companies (Thomson Healthcare vs Thomson Reuters)", () => {
  assert.equal(flagged([row("a", "Thomson Healthcare", "X", "2018-01-01", "2023-01-01"), row("b", "Thomson Reuters", "Y", "2019-01-01", "2021-01-01")]).length, 1);
});

t("the Indian River pair (2018 to 2025 and 2025 to 2026): not flagged, and it never needed the exemption", () => {
  const rows = [row("a", "School District of Indian River County", "Associate Dean of Discipline", "2025-01-01", "2026-01-01"), row("b", "School District of Indian River County", "Business Education Teacher", "2018-01-01", "2025-01-01")];
  assert.deepEqual(flagged(rows), []);
  assert.deepEqual(Old.detectWorkOverlaps(rows), []); // also not flagged by the page before this change (the ranges only touch)
});

t("the 30 and 31 day boundary behaves exactly as before (different companies)", () => {
  const mkp = (days: number) => [row("a", "A Co", "X", "2020-01-01", "2020-01-01"), row("b", "B Co", "Y", "2020-01-01", "2020-01-01")].map((r, i) => ({ ...r, start_date_precision: "day", end_date_precision: "day", start_date: "2020-01-01", end_date: i === 0 ? "2020-12-31" : new Date(Date.parse("2020-01-01") + days * 86400000).toISOString().slice(0, 10) }));
  assert.equal(flagged(mkp(30)).length, 0); // exactly 30 days overlap: not flagged
  assert.equal(flagged(mkp(31)).length, 1); // 31 days: flagged
  assert.deepEqual(flagged(mkp(31)), Old.detectWorkOverlaps(mkp(31)).map((p: any) => [p.a.id, p.b.id, p.days]));
  // and the same-company pair at 31+ days is exempt
  const same = mkp(40).map((r) => ({ ...r, company: "Same Co" }));
  assert.equal(flagged(same).length, 0);
});

// BH (October 21, 2026): these dates are year only, so under the certain overlap rule the pair is no longer flagged even WITHOUT the same company exemption (the smallest overlap is 1 day).
// The exemption's own negative control now uses the same dates at day precision, where the old page's 366 days is still real.
t("the exact Thomson Reuters pair of document 13537c49 (1996 to 1998 and 1996 to 1997): not flagged; year only dates are not flagged even without the exemption; at day precision the page without the exemption flags 366 days", () => {
  const rows = [row("m", "Thomson Reuters", "Manager of Business Analysis and Publishing Systems", "1996-01-01", "1998-01-01"), row("d", "Thomson Reuters", "Desktop Publishing Manager", "1996-01-01", "1997-01-01")];
  assert.deepEqual(flagged(rows), []);
  assert.deepEqual(Old.detectWorkOverlaps(rows), []);
  const day = rows.map((r) => ({ ...r, start_date_precision: "day", end_date_precision: "day" }));
  assert.deepEqual(flagged(day), []);
  const old = Old.detectWorkOverlaps(day);
  assert.equal(old.length, 1); assert.equal(old[0].days, 366);
});

// the 9 rows of document 13537c49 as stored (company values character for character)
const SIMPLE9 = [
  row("1", "School District of Indian River County", "Associate Dean of Discipline", "2025-01-01", "2026-01-01"),
  row("2", "School District of Indian River County", "Business Education Teacher", "2018-01-01", "2025-01-01"),
  row("3", "Truven Health Analytics (IBM Watson Health)", "Business Integration Manager", "2008-01-01", "2016-01-01"),
  row("4", "QPharma", "Technical Project Manager", "2007-01-01", "2008-01-01"),
  row("5", "WorkWave", "Handheld Product Support Specialist / Project Manager", "2006-01-01", "2007-01-01"),
  row("6", "Thomson Healthcare", "Manager of Handheld Application Development", "2001-01-01", "2003-01-01"),
  row("7", "Thomson Reuters", "Manager of Business Analysis and Publishing Systems", "1996-01-01", "1998-01-01"),
  row("8", "Thomson Reuters", "Desktop Publishing Manager", "1996-01-01", "1997-01-01"),
  row("9", "Letraset", "Project Manager", "1995-01-01", "1996-01-01"),
];
t("a PironeSimple shaped set of all 9 entries with the stored company values: nothing flagged (BH: with year only dates even the page without the exemption flags nothing; at day precision it flags exactly the Thomson Reuters pair, 366 days)", () => {
  assert.equal(SIMPLE9.length, 9);
  assert.deepEqual(flagged(SIMPLE9), []);
  assert.deepEqual(Old.detectWorkOverlaps(SIMPLE9), []);
  const day = SIMPLE9.map((r) => ({ ...r, start_date_precision: "day", end_date_precision: "day" }));
  assert.deepEqual(flagged(day), []);
  const old = Old.detectWorkOverlaps(day);
  assert.deepEqual(old.map((p: any) => [p.a.id, p.b.id, p.days]), [["7", "8", 366]]);
});

t("a still ongoing role (Present) at the same company as a past role: exempt; at another company: flagged", () => {
  const cur = (id: string, co: string) => ({ ...row(id, co, "Lead", "2020-01-01", null, "present") });
  assert.deepEqual(flagged([row("a", "Acme", "Analyst", "2018-01-01", "2022-01-01"), cur("b", "Acme")]), []);
  assert.equal(flagged([row("a", "Acme", "Analyst", "2018-01-01", "2022-01-01"), cur("b", "Other")]).length, 1);
});

t("browser and server agree: the same pairs are flagged for the same inputs (confirm-resume-data and resume-resubmission copies)", () => {
  const sets = [SIMPLE9,
    [row("a", "Acme", "X", "2018-01-01", "2023-01-01"), row("b", "ACME.", "Y", "2019-01-01", "2021-01-01"), row("c", "Other", "Z", "2020-06-01", "2022-06-01")],
    [row("a", "", "X", "2018-01-01", "2023-01-01"), row("b", "", "Y", "2019-01-01", "2021-01-01")],
    [row("a", null, "X", "2018-01-01", "2023-01-01"), row("b", "Acme", "Y", "2019-01-01", "2021-01-01")]];
  for (const rows of sets) {
    const b = flagged(rows); const [c, r] = serverFlagged(rows);
    assert.deepEqual(b, c); assert.deepEqual(b, r);
  }
});

console.log(`\n${n} tests passed`);
