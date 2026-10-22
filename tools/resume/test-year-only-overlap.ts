// node --experimental-strip-types tools/resume/test-year-only-overlap.ts   (no dependencies, no network, no model call, no database)
// BH (October 21, 2026): the CERTAIN OVERLAP rule for the work overlap check. A year only start or end may fall on any day of that year; a pair is flagged only when the SMALLEST overlap those
// choices allow is more than 30 days. Month, day, present and unmarked dates count as stored. The rule exists as three copies (confirm-resume-data, resume-resubmission, candidate.html); this
// test cuts each copy out of its own source, runs the same cases through all three, proves the closed form against a brute force enumeration, and plants a bug in each copy to show it is caught.
import assert from "node:assert/strict";
import fs from "node:fs";
import { stripTypeScriptTypes } from "node:module";

const read = (p: string) => fs.readFileSync(new URL(`../../${p}`, import.meta.url), "utf8").replace(/\r\n/g, "\n");
const SRC = { confirm: read("supabase/functions/confirm-resume-data/index.ts"), resub: read("supabase/functions/resume-resubmission/index.ts"), html: read("candidate.html") };
const DAY = 86400000;
const TODAY = new Date().toISOString().slice(0, 10);

type Job = { id: string; company?: string | null; start: string | null; startPrecision: string | null; end: string | null; endPrecision: string | null };
type Rule = { name: string; detect: (jobs: Job[]) => any[]; certain: (a: Job, b: Job) => { days: number; atLeast: boolean } };

// ---- cut a copy out of its source and make it callable
function serverRule(name: string, src: string): Rule {
  const s = src.indexOf("type OverlapItem");
  const e = src.indexOf("\n}\n", src.indexOf("function detectWorkOverlaps")) + 3;
  assert.ok(s > 0 && e > s, `${name}: overlap source not found`);
  const js = stripTypeScriptTypes(src.slice(s, e)) + "\nreturn { detect: detectWorkOverlaps, certain: certainOverlap };";
  const m = new Function(js)();
  return { name, detect: (jobs) => m.detect(jobs), certain: (a, b) => m.certain(a, b) };
}
function browserRule(name: string, html: string): Rule {
  const a0 = html.indexOf("  effectiveWorkEndForOverlap(endDate, endPrecision) {");
  const a1 = html.indexOf("    return pairs;\n  }", a0) + "    return pairs;\n  }".length;
  assert.ok(a0 > 0 && a1 > a0, `${name}: browser overlap methods not found`);
  const B: any = new (new Function(`return class { ${html.slice(a0, a1)} }`)())();
  // the page holds work rows; a present end is a null end_date with the marker, exactly as stored
  const toRow = (j: Job) => ({ id: j.id, company: j.company, start_date: j.start, start_date_precision: j.startPrecision, end_date: j.endPrecision === "present" ? null : j.end, end_date_precision: j.endPrecision });
  return { name, detect: (jobs) => B.detectWorkOverlaps(jobs.map(toRow)).map((p: any) => ({ a: p.a.id, b: p.b.id, days: p.days, ...(p.atLeast ? { atLeast: true } : {}) })), certain: (a, b) => B.certainOverlap(a, b) };
}
const rulesOf = (src = SRC): Rule[] => [serverRule("confirm-resume-data", src.confirm), serverRule("resume-resubmission", src.resub), browserRule("candidate.html", src.html)];

// ---- jobs from the way a resume prints them: "2019" year, "2019-03" month, "2019-03-15" day, null end + present
const D = (s: string | null) => { if (!s) return { date: null as string | null, prec: null as string | null }; if (/^[0-9]{4}$/.test(s)) return { date: `${s}-01-01`, prec: "year" }; if (/^[0-9]{4}-[0-9]{2}$/.test(s)) return { date: `${s}-01`, prec: "month" }; return { date: s, prec: "day" }; };
const job = (id: string, company: string, start: string | null, end: string | null, present = false): Job => { const s = D(start), e = D(end); return { id, company, start: s.date, startPrecision: s.prec, end: present ? TODAY : e.date, endPrecision: present ? "present" : e.prec }; };

// ---- the table: expected flag, smallest certain overlap in days, and whether the figure is a floor ("at least")
type Case = { n: string; label: string; a: Job; b: Job; flag: boolean; days?: number; atLeast?: boolean };
const CASES: Case[] = [
  { n: "1", label: "2015-2019 vs 2019-2021", a: job("A", "A Co", "2015", "2019"), b: job("B", "B Co", "2019", "2021"), flag: false, days: 0 },
  { n: "2", label: "2015-2019 vs Mar 2019-2021", a: job("A", "A Co", "2015", "2019"), b: job("B", "B Co", "2019-03", "2021"), flag: false, days: 0 },
  { n: "3", label: "2018-2020 vs Jun 2019-Dec 2019 (the whole second job, 183 days as stored: Jun 1 to Dec 1)", a: job("A", "A Co", "2018", "2020"), b: job("B", "B Co", "2019-06", "2019-12"), flag: true, days: 183, atLeast: false },
  { n: "4", label: "2018-2020 vs 2019-2021", a: job("A", "A Co", "2018", "2020"), b: job("B", "B Co", "2019", "2021"), flag: false, days: 1 },
  { n: "5", label: "2018-Present vs 2020-2022", a: job("A", "A Co", "2018", null, true), b: job("B", "B Co", "2020", "2022"), flag: true, days: 366, atLeast: true },
  { n: "6", label: "Jan 2018-Mar 2019 vs Mar 2019-Dec 2020", a: job("A", "A Co", "2018-01", "2019-03"), b: job("B", "B Co", "2019-03", "2020-12"), flag: false, days: 0 },
  { n: "7", label: "2019 vs 2019 (single years)", a: job("A", "A Co", "2019", "2019"), b: job("B", "B Co", "2019", "2019"), flag: false, days: 0 },
  { n: "8", label: "2019-2019 vs Jun 2019-Aug 2019", a: job("A", "A Co", "2019", "2019"), b: job("B", "B Co", "2019-06", "2019-08"), flag: false, days: 0 },
  { n: "9", label: "A with no end and no present marker vs 2019-2020 (skipped, as today)", a: { id: "A", company: "A Co", start: "2018-01-01", startPrecision: "year", end: null, endPrecision: null }, b: job("B", "B Co", "2019", "2020"), flag: false },
  { n: "10", label: "2019-2021 vs 2020-2022 (leap year inside)", a: job("A", "A Co", "2019", "2021"), b: job("B", "B Co", "2020", "2022"), flag: false, days: 1 },
  { n: "11", label: "2018-2020 vs Mar 2019-2020 (the 10 month case)", a: job("A", "A Co", "2018", "2020"), b: job("B", "B Co", "2019-03", "2020"), flag: true, days: 306, atLeast: true },
  { n: "12", label: "Jan 2019-Dec 2020 vs Feb 2020-Dec 2021 (all months)", a: job("A", "A Co", "2019-01", "2020-12"), b: job("B", "B Co", "2020-02", "2021-12"), flag: true, days: 304, atLeast: false },
  { n: "13", label: "Jan 2019-Present vs Jun 2020-Present (month and present)", a: job("A", "A Co", "2019-01", null, true), b: job("B", "B Co", "2020-06", null, true), flag: true },
  { n: "14", label: "same company, 2018-Present vs 2020-2022: exempt", a: job("A", "Same Co", "2018", null, true), b: job("B", "Same Co.", "2020", "2022"), flag: false },
  { n: "15", label: "Mar 2019-2021 vs 2019-2021 (a month start and year ends: 2020 is a leap year, Dec 31 2019 to Jan 1 2021 is 367 days)", a: job("A", "A Co", "2019-03", "2021"), b: job("B", "B Co", "2019", "2021"), flag: true, days: 367, atLeast: true },
];

// ---- the brute force: every valid day level reading of the year only dates (coarse step: Jan 1 and the first and last day of every month of that year, the extremes included),
// the true minimum and maximum overlap over all of them
const ms = (iso: string) => Date.parse(iso);
// the grid of a year only date also holds every precise date of the two jobs that falls in that year (a job cannot end before its own precise start, so those points are where the limits meet)
function choices(date: string, prec: string | null, extras: number[] = []): number[] {
  if (prec !== "year") return [ms(date)];
  const y = new Date(ms(date)).getUTCFullYear(); const out = new Set<number>([Date.UTC(y, 0, 1)]);
  for (let m = 0; m < 12; m++) { out.add(Date.UTC(y, m, 1)); out.add(Date.UTC(y, m + 1, 0)); }
  for (const x of extras) if (new Date(x).getUTCFullYear() === y) out.add(x);
  return [...out].sort((p, q) => p - q);
}
function jobChoices(j: Job, extras: number[] = []): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (const s of choices(j.start!, j.startPrecision, extras)) for (const e of choices(j.end!, j.endPrecision, extras)) if (s <= e) out.push([s, e]);
  return out;
}
const preciseDates = (...jobs: Job[]): number[] => jobs.flatMap((j) => [j.startPrecision !== "year" ? ms(j.start!) : NaN, j.endPrecision !== "year" ? ms(j.end!) : NaN]).filter((x) => Number.isFinite(x));
function brute(a: Job, b: Job): { min: number; max: number } | null {
  const ex = preciseDates(a, b);
  const ca = jobChoices(a, ex), cb = jobChoices(b, ex);
  if (!ca.length || !cb.length) return null;
  let min = Infinity, max = -Infinity;
  for (const [sA, eA] of ca) for (const [sB, eB] of cb) { const o = Math.max(0, Math.min(eA, eB) - Math.max(sA, sB)); if (o < min) min = o; if (o > max) max = o; }
  return { min: Math.round(min / DAY), max: Math.round(max / DAY) };
}

// small pools of date ranges (year, month and day precision, and present) for the brute force
const STARTS = ["2018", "2019", "2019-03", "2019-06-15", "2020"], ENDS = ["2019", "2019-12", "2020", "2021", "2021-02", null];
const POOL: Job[] = []; for (const s of STARTS) for (const e of ENDS) { const j = e === null ? job(`${s}~P`, "x", s, null, true) : job(`${s}~${e}`, "x", s, e); if (jobChoices(j).length) POOL.push(j); }
const POOL_PAIRS: Array<[Job, Job]> = []; for (let i = 0; i < POOL.length; i++) for (let k = i + 1; k < POOL.length; k++) POOL_PAIRS.push([POOL[i], POOL[k]]);

// ---- everything the planted bugs must be caught by: returns the list of failures (empty = all good)
function failures(rules: Rule[], pairs = POOL_PAIRS, cases = CASES): string[] {
  const out: string[] = [];
  for (const c of cases) {
    const results = rules.map((r) => r.detect([c.a, c.b]));
    results.forEach((res, i) => {
      const hit = res[0];
      if (c.flag !== (res.length === 1)) out.push(`${rules[i].name} case ${c.n} flag`);
      else if (c.flag && c.days !== undefined && hit.days !== c.days) out.push(`${rules[i].name} case ${c.n} days ${hit.days} != ${c.days}`);
      else if (c.flag && c.atLeast !== undefined && !!hit.atLeast !== c.atLeast) out.push(`${rules[i].name} case ${c.n} atLeast`);
    });
    if (new Set(results.map((r) => JSON.stringify(r))).size !== 1) out.push(`parity case ${c.n}`);
  }
  for (const [a, b] of pairs) {
    const bf = brute(a, b); if (!bf) continue;
    for (const r of rules) {
      const got = r.certain(a, b);
      if (got.days !== bf.min) out.push(`${r.name} brute min ${a.id}/${b.id}: ${got.days} != ${bf.min}`);
      if (got.atLeast !== (bf.max !== bf.min)) out.push(`${r.name} label ${a.id}/${b.id}`);
    }
    const flaggedBy = rules.map((r) => r.detect([{ ...a, company: "A Co" }, { ...b, company: "B Co" }]).length === 1);   // the pool jobs share a company name; the exemption is tested on its own
    if (flaggedBy.some((f) => f !== bf.min > 30)) out.push(`flag vs brute ${a.id}/${b.id}`);
  }
  return out;
}

let n = 0; const t = (name: string, fn: () => void) => { fn(); n++; console.log("ok  ", name); };
const RULES = rulesOf();
const SMALL = POOL_PAIRS.filter((_, i) => i % 7 === 0);   // a quick subset for the planted runs

t("the table: each case gives the expected flag, smallest certain overlap in days and label in ALL THREE copies, and the three copies agree", () => {
  const bad = failures(RULES, [], CASES);
  assert.deepEqual(bad, []);
  // print the table
  for (const c of CASES) { const r = RULES.map((x) => x.detect([c.a, c.b])); console.log(`      ${c.n}. ${c.label}: ${r[0].length ? "FLAGS " + r[0][0].days + (r[0][0].atLeast ? " (at least)" : " days") : "no flag"} | confirm/resub/page agree: ${new Set(r.map((x) => JSON.stringify(x))).size === 1}`); }
});

t("case 3 and 5 and 11 against the prompt: 3 is 183 days exactly (Jun 1 to Dec 1 as stored, a month precision end is the 1st), 5 flags with at least 366, 11 flags with at least 306", () => {
  for (const r of RULES) {
    assert.deepEqual(r.detect([CASES[2].a, CASES[2].b]).map((p) => [p.days, !!p.atLeast]), [[183, false]]);
    assert.deepEqual(r.detect([CASES[4].a, CASES[4].b]).map((p) => [p.days, !!p.atLeast]), [[366, true]]);
    assert.deepEqual(r.detect([CASES[10].a, CASES[10].b]).map((p) => [p.days, !!p.atLeast]), [[306, true]]);
  }
});

t("BRUTE FORCE: the closed form equals the true minimum overlap, and the label equals (maximum differs from minimum), on every pair of a pool of year, month, day and present ranges, in all three copies", () => {
  let checked = 0; const bad: string[] = [];
  for (const [a, b] of POOL_PAIRS) { const bf = brute(a, b); if (!bf) continue; checked++;
    for (const r of RULES) { const g = r.certain(a, b); if (g.days !== bf.min) bad.push(`${r.name} ${a.id}/${b.id} ${g.days} != ${bf.min}`); if (g.atLeast !== (bf.max !== bf.min)) bad.push(`${r.name} label ${a.id}/${b.id}`); } }
  assert.deepEqual(bad, []);
  assert.ok(checked > 300, `pairs checked: ${checked}`);
  console.log(`      pairs enumerated: ${checked}; every valid reading of every year only date (Jan 1 and the first and last day of each month) was tried; coarse step, extremes included`);
});

t("BRUTE FORCE at day resolution: for random pairs, no random day level reading ever gives an overlap below the closed form minimum or above the maximum", () => {
  let seed = 12345; const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
  const specs = ["2017", "2018", "2019", "2020", "2021", "2018-05", "2019-02", "2019-11", "2020-04", "2020-08-20", "2018-12-31"];
  let tested = 0;
  for (let k = 0; k < 1500; k++) {
    const mk = (id: string) => { const s = specs[Math.floor(rnd() * specs.length)], e = specs[Math.floor(rnd() * specs.length)]; return job(id, "x", s, e); };
    const a = mk("a"), b = mk("b"); const bf = brute(a, b); if (!bf) continue; tested++;
    const cf = RULES[0].certain(a, b); const most = (() => { const ya = (j: Job) => [j.startPrecision === "year" ? Date.UTC(new Date(ms(j.start!)).getUTCFullYear(), 0, 1) : ms(j.start!), j.endPrecision === "year" ? Date.UTC(new Date(ms(j.end!)).getUTCFullYear(), 11, 31) : ms(j.end!)]; return Math.max(0, Math.round((Math.min(ya(a)[1], ya(b)[1]) - Math.max(ya(a)[0], ya(b)[0])) / DAY)); })();
    for (let s = 0; s < 150; s++) {
      const pick = (j: Job): [number, number] | null => { for (let tries = 0; tries < 40; tries++) { const lo = j.startPrecision === "year" ? Date.UTC(new Date(ms(j.start!)).getUTCFullYear(), 0, 1) : ms(j.start!), hi = j.startPrecision === "year" ? Date.UTC(new Date(ms(j.start!)).getUTCFullYear(), 11, 31) : ms(j.start!); const elo = j.endPrecision === "year" ? Date.UTC(new Date(ms(j.end!)).getUTCFullYear(), 0, 1) : ms(j.end!), ehi = j.endPrecision === "year" ? Date.UTC(new Date(ms(j.end!)).getUTCFullYear(), 11, 31) : ms(j.end!); const sv = lo + Math.floor(rnd() * ((hi - lo) / DAY + 1)) * DAY, ev = elo + Math.floor(rnd() * ((ehi - elo) / DAY + 1)) * DAY; if (sv <= ev) return [sv, ev]; } return null; };
      const pa = pick(a), pb = pick(b); if (!pa || !pb) continue;
      const o = Math.max(0, Math.min(pa[1], pb[1]) - Math.max(pa[0], pb[0])) / DAY;
      assert.ok(o >= cf.days - 0.5, `a sample (${o}) is below the closed form minimum ${cf.days} for ${a.id}/${b.id}`);
      assert.ok(o <= most + 0.5, `a sample (${o}) is above the maximum ${most}`);
    }
  }
  assert.ok(tested > 200, `random pairs tested: ${tested}`);
});

t("an all month, day or present precision pair gives EXACTLY the old answer: 30000 random pairs, old rule versus new rule, in all three copies, zero differences (flag, days, and no 'at least')", () => {
  const OLD = new Function(`
    function effectiveWorkEnd(endDate, endPrecision) { if (endPrecision === "present") return new Date().toISOString().slice(0, 10); return endDate; }
    const overlapCompanyKey = (c) => (typeof c === "string" ? c.toLowerCase().replace(/[^a-z0-9]+/g, "") : "");
    function detectWorkOverlaps(items) { const out = []; for (let i = 0; i < items.length; i++) { for (let j = i + 1; j < items.length; j++) { const a = items[i], b = items[j];
      if (!a.start || !a.end || !b.start || !b.end) continue;
      if (overlapCompanyKey(a.company) && overlapCompanyKey(a.company) === overlapCompanyKey(b.company)) continue;
      const aS = Date.parse(a.start), aE = Date.parse(a.end), bS = Date.parse(b.start), bE = Date.parse(b.end);
      if (!Number.isFinite(aS) || !Number.isFinite(aE) || !Number.isFinite(bS) || !Number.isFinite(bE)) continue;
      const overlapStart = Math.max(aS, bS), overlapEnd = Math.min(aE, bE);
      if (overlapEnd <= overlapStart) continue;
      const days = Math.round((overlapEnd - overlapStart) / 86400000);
      if (days > 30) out.push({ a: a.id, b: b.id, days }); } } return out; }
    return detectWorkOverlaps;`)() as (items: any[]) => any[];
  let seed = 987654321; const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
  const iso = (t0: number) => new Date(t0).toISOString().slice(0, 10);
  const base = Date.UTC(2005, 0, 1), span = 21 * 365 * DAY;
  const precs = ["month", "day", "day", null];
  const mk = (id: string, company: string): Job => { const s = base + Math.floor(rnd() * span), len = Math.floor((rnd() - 0.05) * 900) * DAY; const sp = precs[Math.floor(rnd() * precs.length)]; const pres = rnd() < 0.15; return { id, company, start: iso(s), startPrecision: sp, end: pres ? TODAY : iso(s + len), endPrecision: pres ? "present" : precs[Math.floor(rnd() * precs.length)] }; };
  let diffs = 0, flaggedN = 0; const samples: string[] = [];
  for (let k = 0; k < 30000; k++) {
    const a = mk("a", rnd() < 0.1 ? "Same" : "A"), b = mk("b", rnd() < 0.1 ? "Same" : "B");
    if (rnd() < 0.05 && a.endPrecision !== "present") a.end = null;   // a null end with no marker is skipped by all (a present end is filled with today before the rule runs, on the server and in the page)
    const old = OLD([a, b]).map((p) => [p.a, p.b, p.days]);
    if (old.length) flaggedN++;
    for (const r of RULES) { const nu = r.detect([a, b]); if (JSON.stringify(nu.map((p) => [p.a, p.b, p.days])) !== JSON.stringify(old) || nu.some((p) => p.atLeast)) { diffs++; if (samples.length < 3) samples.push(`${r.name} old=${JSON.stringify(old)} new=${JSON.stringify(nu)} a=${JSON.stringify(a)} b=${JSON.stringify(b)}`); } }
  }
  assert.equal(diffs, 0, samples.join("\n"));
  assert.ok(flaggedN > 3000, `pairs that flag: ${flaggedN}`);
});

t("boundary: an all day pair at exactly 30 days overlap does not flag and at 31 days flags; Present ends read as today; a null end with no present marker is skipped; a single year '2019' does not flag by itself", () => {
  for (const r of RULES) {
    const day = (id: string, co: string, s: string, e: string) => ({ id, company: co, start: s, startPrecision: "day", end: e, endPrecision: "day" } as Job);
    assert.equal(r.detect([day("a", "X", "2020-01-01", "2020-01-31"), day("b", "Y", "2020-01-01", "2020-03-01")]).length, 0);
    assert.equal(r.detect([day("a", "X", "2020-01-01", "2020-02-01"), day("b", "Y", "2020-01-01", "2020-03-01")]).length, 1);
    const pres = r.detect([job("a", "X", "2019-01", null, true), job("b", "Y", "2025-01", null, true)]);
    assert.equal(pres.length, 1); assert.ok(!pres[0].atLeast);
    assert.equal(pres[0].days, Math.round((Date.parse(TODAY) - Date.parse("2025-01-01")) / DAY));
    assert.deepEqual(r.detect([{ id: "a", company: "X", start: "2018-01-01", startPrecision: "year", end: null, endPrecision: null }, job("b", "Y", "2019", "2020")]), []);
    assert.deepEqual(r.detect([job("a", "X", "2019", "2019"), job("b", "Y", "2015", "2025")]), [], "a single year job inside a long job: smallest overlap can be 0 (it may be zero length)");
    assert.deepEqual(r.detect([job("a", "X", "2019", "2019")]), []);
  }
});

t("the same company exemption still holds with year only dates (and a year only pair of different companies that would flag is flagged)", () => {
  for (const r of RULES) {
    assert.deepEqual(r.detect([job("a", "Same Co", "2018", null, true), job("b", "SAME CO.", "2020", "2022")]), []);
    assert.equal(r.detect([job("a", "Same Co", "2018", null, true), job("b", "Other Co", "2020", "2022")]).length, 1);
    assert.deepEqual(r.detect([job("a", "Thomson Reuters", "1996", "1998"), job("b", "Thomson Reuters", "1996", "1997")]), []);
  }
});

t("labels: 'at least N days' only when a year only date leaves the figure open; plain 'N days' for precise pairs and for a precise job fully inside a year only one (the page's two row builders, cut from candidate.html)", () => {
  const exprs = [...SRC.html.matchAll(/daysLabel: (\(p\.atLeast \? 'at least ' : ''\) \+ p\.days)/g)].map((m) => m[1]);
  assert.equal(exprs.length, 2, "both row builders (plan pairs and page pairs) build the label");
  const label = (expr: string, p: any) => new Function("p", `return ${expr};`)(p);
  const pairs = (j: Case) => RULES[2].detect([j.a, j.b])[0];
  assert.equal(label(exprs[0], pairs(CASES[4])), "at least 366");   // year only affects the figure
  assert.equal(label(exprs[1], pairs(CASES[10])), "at least 306");
  assert.equal(label(exprs[0], pairs(CASES[2])), "183");            // precise job inside a year only job: exact
  assert.equal(label(exprs[1], pairs(CASES[11])), "304");           // all months: exact
  assert.match(SRC.html, /Overlap: \{\{ row\.daysLabel \}\} days/);
  assert.match(SRC.html, /days: p\.days, \.\.\.\(p\.atLeast \? \{ atLeast: true \} : \{\}\) \}\)\);/, "the server pair keeps its flag when the page hydrates it");
});

t("the precisions are carried through every place that builds the overlap input, and a typed in date keeps its month precision", () => {
  assert.match(SRC.confirm, /startPrecision: r\.start_date_precision as string \| null, endPrecision: r\.end_date_precision as string \| null/);
  assert.match(SRC.confirm, /startPrecision: w\.start_date_precision \?\? null, endPrecision: w\.end_date_precision \?\? null/);
  assert.match(SRC.resub, /startPrecision: r\.start_date_precision \?\? null, endPrecision: r\.end_date_precision \?\? null, company: r\.company, row: r/);
  assert.match(SRC.resub, /startPrecision: n\.start_date_precision \?\? null, endPrecision: n\.end_date_precision \?\? null, company: n\.company, row: n/);
  assert.match(SRC.html, /startPrecision: w\.start_date_precision \|\| null, endPrecision: w\.end_date_precision \|\| null/);
  assert.match(SRC.html, /\[field \+ '_precision'\]: value \? 'month'/, "a date the candidate types is month precision, as before");
});

t("the two server copies are the same logic character for character (certainOverlap and detectWorkOverlaps)", () => {
  const cut = (s: string, name: string) => s.slice(s.indexOf(`function ${name}`), s.indexOf("\n}\n", s.indexOf(`function ${name}`)) + 3);
  assert.equal(cut(SRC.confirm, "certainOverlap"), cut(SRC.resub, "certainOverlap"));
  assert.equal(cut(SRC.confirm, "detectWorkOverlaps"), cut(SRC.resub, "detectWorkOverlaps"));
});

// ---- PLANTED BUGS: each is applied to each of the three copies in turn and must be caught by the same checks
const PLANTS: Array<{ name: string; edit: (kind: "server" | "browser") => [string, string] }> = [
  { name: "ignoring the precision (old behavior): the year only edge is never used", edit: (k) => k === "server" ? ['p === "year" ? Date.UTC', 'p === "never" ? Date.UTC'] : ["p === 'year' ? Date.UTC", "p === 'never' ? Date.UTC"] },
  { name: "the earliest start used where the latest start belongs", edit: () => ["Math.min(earliestEnd(a) - latestStart(b), earliestEnd(b) - latestStart(a)", "Math.min(earliestEnd(a) - earliestStart(b), earliestEnd(b) - latestStart(a)"] },
  { name: "Dec 31 used for a year only end (the earliest end is Jan 1)", edit: (k) => k === "server" ? ["earliestEnd = (x: OverlapItem) => edge(x.end, x.endPrecision, 0, 1)", "earliestEnd = (x: OverlapItem) => edge(x.end, x.endPrecision, 11, 31)"] : ["earliestEnd = (x) => edge(x.end, x.endPrecision, 0, 1)", "earliestEnd = (x) => edge(x.end, x.endPrecision, 11, 31)"] },
  { name: "a year only start treated as Jan 1 only", edit: (k) => k === "server" ? ["latestStart = (x: OverlapItem) => edge(x.start, x.startPrecision, 11, 31)", "latestStart = (x: OverlapItem) => edge(x.start, x.startPrecision, 0, 1)"] : ["latestStart = (x) => edge(x.start, x.startPrecision, 11, 31)", "latestStart = (x) => edge(x.start, x.startPrecision, 0, 1)"] },
  { name: "the 'at least' label shown for precise dates too", edit: () => ["atLeast: most !== least", "atLeast: true"] },
  { name: "the job's own length dropped from the smallest overlap", edit: () => [", earliestEnd(a) - latestStart(a), earliestEnd(b) - latestStart(b)", ""] },
];
const KINDS: Array<{ key: "confirm" | "resub" | "html"; kind: "server" | "browser" }> = [{ key: "confirm", kind: "server" }, { key: "resub", kind: "server" }, { key: "html", kind: "browser" }];
t("planted bugs, each in each of the three copies in turn, are all caught (table, parity, brute force or label checks fail)", () => {
  assert.deepEqual(failures(rulesOf(), SMALL), [], "the clean copies pass the same checks");
  let planted = 0;
  for (const p of PLANTS) for (const k of KINDS) {
    const [from, to] = p.edit(k.kind);
    assert.ok(SRC[k.key].includes(from), `plant "${p.name}" anchor not found in ${k.key}`);
    const src = { ...SRC, [k.key]: SRC[k.key].replace(from, to) };
    assert.notEqual(src[k.key], SRC[k.key]);
    const bad = failures(rulesOf(src), SMALL);
    assert.ok(bad.length > 0, `NOT CAUGHT: "${p.name}" in ${k.key}`);
    planted++;
  }
  console.log(`      planted runs: ${planted}, all caught`);
});
t("planted: ONE copy left on the old rule (each copy in turn) makes the parity test fail", () => {
  for (const k of KINDS) {
    const from = k.kind === "server" ? "const o = certainOverlap(a, b);" : "const o = this.certainOverlap(a, b);";
    const to = k.kind === "server" ? "const o = { days: Math.round((Math.min(aE, bE) - Math.max(aS, bS)) / 86400000), atLeast: false };" : "const o = { days: Math.round((Math.min(aE, bE) - Math.max(aS, bS)) / 86400000), atLeast: false };";
    assert.ok(SRC[k.key].includes(from), `anchor in ${k.key}`);
    const bad = failures(rulesOf({ ...SRC, [k.key]: SRC[k.key].replace(from, to) }), [], CASES);
    assert.ok(bad.some((x) => x.startsWith("parity")), `parity not failed with ${k.key} on the old rule: ${bad.join(" | ")}`);
  }
});
t("planted: an input builder that drops the precisions is caught by the source check", () => {
  const bad = SRC.confirm.replace("startPrecision: w.start_date_precision ?? null, endPrecision: w.end_date_precision ?? null", "");
  assert.notEqual(bad, SRC.confirm); assert.doesNotMatch(bad, /startPrecision: w\.start_date_precision \?\? null/);
  const bad2 = SRC.resub.replace("startPrecision: n.start_date_precision ?? null, endPrecision: n.end_date_precision ?? null, ", "");
  assert.notEqual(bad2, SRC.resub); assert.doesNotMatch(bad2, /startPrecision: n\.start_date_precision/);
});
t("no em dash was added to the changed rule text", () => {
  const dash = String.fromCharCode(0x2014);
  for (const s of [SRC.confirm, SRC.resub]) { const i = s.indexOf("function certainOverlap"); assert.ok(!s.slice(i, s.indexOf("\n}\n", s.indexOf("function detectWorkOverlaps")) + 3).includes(dash)); }
  const h = SRC.html.indexOf("  certainOverlap(a, b) {"); assert.ok(!SRC.html.slice(h, SRC.html.indexOf("    return pairs;\n  }", h)).includes(dash));
});

console.log(`\n${n} tests passed`);
