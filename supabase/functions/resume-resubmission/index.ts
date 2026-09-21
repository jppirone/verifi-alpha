// Setup type definitions for built-in Supabase Runtime APIs
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { withSupabase } from "jsr:@supabase/server@1";

// RESUME RESUBMISSION, STAGE 1 (2026-09-21). A confirmed candidate can submit a NEW resume that is treated as their complete current record
// (not a diff). This function owns the workflow up to the review screen; nothing here changes the live profile:
//
//   start   {ack_text_version}  records the acknowledgement of the "this becomes your complete record" modal, enforces the rate limit
//                               (3 per 24 h, 10 per 30 days, every attempt counted) and opens one attempt (status 'uploading'). upload-resume refuses
//                               a resubmission upload without an open attempt.
//   status                      the candidate's latest attempt, minimally.
//   plan    {resubmission_id}   once the upload has been extracted (and licenses detected) computes the REVIEW DATA: what would be added, kept
//                               unchanged, changed (facts changed: re-verification) and removed, against the ACTIVE profile. Read-only against
//                               the profile: it stores the plan on the attempt (for Stage 2's apply) and nothing else. Poll it until status 'ready'.
//   apply   {resubmission_id, plan_hash, opt_in}  (STAGE 2) commits exactly the plan the candidate reviewed, in ONE database transaction
//                               (apply_resume_resubmission): archive then delete removed items, reset changed items to New with a rebuilt claim and a
//                               before/after timeline entry, update kept items' descriptive fields only (their queue rows are not touched), confirm new
//                               items and create their queue rows per the opt-in, delete the staged duplicates, re-home everything to the new document.
//                               A stale plan (anything changed since review) is refused with 409 and the fresh plan; nothing is written. After the commit:
//                               real registry checks for new/changed licenses. The response lists the items whose employer contact details are now needed.
//   cancel  {resubmission_id}   discards the attempt entirely: the staged rows, the stored file and the attempt's document. Only ever an
//                               unconfirmed resubmission document; the existing profile is never touched.
//
// SCOPE: full_resume accounts (a "hybrid" is a full_resume account with licenses). License-only accounts have no resume and keep their own path.
//
// MATCHING (the block between the @@matcher markers is pure and unit-tested: scripts/test-resume-matcher.mjs). The one high-stakes decision
// is "kept unchanged, verification preserved", so that gate is strict; the softer thresholds only decide whether something is labelled
// 'changed' or 'removed and added', and both of those end in (re-)verification.
//   * KEPT      every verified fact is present and agrees (a fact the new file simply does not state is NOT a change; the verified value stays).
//   * CHANGED   same item, but a fact conflicts, or the new file states a fact the verified record did not have (additive facts are unverified
//               claims). Exceptions: a consistent finer/coarser date, and location that is only added or dropped. Descriptive text never re-verifies.
//   * REMOVED   on the active profile, not in the new file (archived by Stage 2, never held for confirmation).
//   * ADDED     in the new file, not on the active profile (fresh verification).
// A near-tie between two candidate pairings is never "kept". Extraction is not deterministic: the same file gives "AI"/"Al" variants,
// blank companies and template placeholders, so text is folded (case, punctuation, l/I/1 and O/0 OCR confusions, abbreviations) and compared by
// trigram similarity, never by exact string.

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const REST = { "apikey": SERVICE_KEY, "Authorization": `Bearer ${SERVICE_KEY}` };
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
};
const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// The wording version of the acknowledgement modal the candidate must accept before an upload starts (recorded with the attempt).
const ACK_TEXT_VERSION = "v1-2026-09-21";
const RATE_PER_DAY = 3;
const RATE_PER_30_DAYS = 10;
const MAX_DETECT_ATTEMPTS = 2;

// @@matcher-start
type Rec = Record<string, any>;
type Change = { field: string; kind: "conflict" | "added"; before: string | null; after: string | null };
type Pair = { oldIdx: number; newIdx: number; cls: "kept" | "changed"; changes: Change[]; flags: string[]; descriptive: string[]; ambiguous: boolean; score: number };
type Section = { pairs: Pair[]; removed: number[]; added: number[] };

const PLACEHOLDER = /^\s*\[[^\]]*\]\s*$/;
const clean = (s: unknown): string => (s == null || PLACEHOLDER.test(String(s)) ? "" : String(s).replace(/\s+/g, " ").trim());
const norm = (s: unknown): string =>
  clean(s).toLowerCase().replace(/['’]/g, "").replace(/&/g, " and ").replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\b(inc|llc|ltd|corp|corporation|co|company|the)\b/g, " ").replace(/\s+/g, " ").trim();
const ABBR: Record<string, string> = {
  mgr: "manager", sr: "senior", jr: "junior", dir: "director", eng: "engineer", asst: "assistant", assoc: "associate", admin: "administrator",
  dev: "developer", ops: "operations", vp: "vice president", dept: "department", exec: "executive", rep: "representative", spec: "specialist",
  coord: "coordinator", supv: "supervisor", univ: "university", intl: "international", mgmt: "management", svc: "service", svcs: "services",
};
const expand = (s: string): string => s.split(" ").map((w) => ABBR[w] ?? w).join(" ");
// OCR confusions: l / I / 1 read alike, and O / 0 (the same fold mergeBoundaryContinuations already applies).
const fold = (s: unknown): string => expand(norm(s)).replace(/[l1]/g, "i").replace(/0/g, "o");
function grams(s: string): Map<string, number> {
  const t = `  ${s} `; const g = new Map<string, number>();
  for (let i = 0; i < t.length - 2; i++) { const k = t.slice(i, i + 3); g.set(k, (g.get(k) || 0) + 1); }
  return g;
}
function dice(a: string, b: string): number {
  if (!a || !b) return 0;
  if (a === b) return 1;
  const A = grams(a), B = grams(b); let inter = 0, na = 0, nb = 0;
  for (const [k, v] of A) { na += v; inter += Math.min(v, B.get(k) || 0); }
  for (const v of B.values()) nb += v;
  return (2 * inter) / (na + nb);
}
const sim = (a: unknown, b: unknown): number => dice(fold(a), fold(b));

const STATE_ABBR: Record<string, string> = {
  alabama: "al", alaska: "ak", arizona: "az", arkansas: "ar", california: "ca", colorado: "co", connecticut: "ct", delaware: "de", florida: "fl",
  georgia: "ga", hawaii: "hi", idaho: "id", illinois: "il", indiana: "in", iowa: "ia", kansas: "ks", kentucky: "ky", louisiana: "la", maine: "me",
  maryland: "md", massachusetts: "ma", michigan: "mi", minnesota: "mn", mississippi: "ms", missouri: "mo", montana: "mt", nebraska: "ne", nevada: "nv",
  "new hampshire": "nh", "new jersey": "nj", "new mexico": "nm", "new york": "ny", "north carolina": "nc", "north dakota": "nd", ohio: "oh",
  oklahoma: "ok", oregon: "or", pennsylvania: "pa", "rhode island": "ri", "south carolina": "sc", "south dakota": "sd", tennessee: "tn", texas: "tx",
  utah: "ut", vermont: "vt", virginia: "va", washington: "wa", "west virginia": "wv", wisconsin: "wi", wyoming: "wy",
};
const STATE_NAMES = new Set(Object.keys(STATE_ABBR));
const STATE_CODES = new Set(Object.values(STATE_ABBR));
function normLocation(s: unknown): string {
  let t = norm(s);
  for (const [name, ab] of Object.entries(STATE_ABBR)) t = t.replace(new RegExp(`\\b${name}\\b`, "g"), ab);
  return t;
}

// A company may be written "A/B", "A (B)" or "A, B". Compare the PRIMARY name of each side against every alias of the other (never bare aliases
// against each other: two different employers can both end ", Florida").
function aliases(co: unknown): string[] {
  return clean(co).split(/[\/(),]| aka | dba /i).map((x) => x.trim()).filter((x) => x.length >= 3 && !STATE_NAMES.has(norm(x)) && !STATE_CODES.has(norm(x)));
}
function companySim(a: unknown, b: unknown): number | null {
  const A = aliases(a), B = aliases(b);
  if (!A.length || !B.length) return null;
  let best = sim(a, b);
  for (const y of B) best = Math.max(best, sim(A[0], y));
  for (const x of A) best = Math.max(best, sim(B[0], x));
  return best;
}

// A date as 'YYYY' | 'YYYY-MM' | 'YYYY-MM-DD' | 'present' | null, at exactly the precision the source showed.
function dv(date: unknown, prec: unknown): string | null {
  if (prec === "present") return "present";
  if (!date) return null;
  const m = String(date).match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return null;
  const p = prec === "year" || prec === "month" || prec === "day" ? prec : (m[2] === "01" && m[3] === "01" ? "year" : m[3] === "01" ? "month" : "day");
  return p === "year" ? m[1] : p === "month" ? `${m[1]}-${m[2]}` : `${m[1]}-${m[2]}-${m[3]}`;
}
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
function showDate(v: string | null): string | null {
  if (!v) return null;
  if (v === "present") return "Present";
  const [y, mo, d] = v.split("-");
  return d ? `${MONTHS[Number(mo) - 1]} ${Number(d)}, ${y}` : mo ? `${MONTHS[Number(mo) - 1]} ${y}` : y;
}
type Rel = "same" | "omitted" | "added" | "conflict" | "ignored";
// old = the verified record, nw = the new file. A date the new file does not state is omitted (not a change); one it states that the verified
// record lacked is added (an unverified claim); a finer or coarser but consistent date is the same fact; 'present' against a date is a conflict.
function dateRel(o: string | null, n: string | null): Rel {
  if (n == null) return o == null ? "same" : "omitted";
  if (o == null) return "added";
  if (o === "present" || n === "present") return o === n ? "same" : "conflict";
  const len = Math.min(o.length, n.length);
  return o.slice(0, len) === n.slice(0, len) ? "same" : "conflict";
}
function textRel(o: unknown, n: unknown, thr: number, f: (a: unknown, b: unknown) => number = sim): Rel {
  const a = clean(o), b = clean(n);
  if (!b) return a ? "omitted" : "same";
  if (!a) return "added";
  return f(a, b) >= thr ? "same" : "conflict";
}
function locationRel(o: unknown, n: unknown): Rel {
  const a = clean(o), b = clean(n);
  if (!a || !b) return "ignored"; // location added or dropped: descriptive, never a re-verification
  return dice(normLocation(a), normLocation(b)) >= 0.8 ? "same" : "conflict";
}

// One-to-one pairing, best score first. A pairing whose runner-up (for either side) scores within 0.15 is flagged ambiguous and never kept.
function assign(cands: { i: number; j: number; score: number }[], nOld: number, nNew: number): { pairs: { i: number; j: number; score: number; ambiguous: boolean }[]; removed: number[]; added: number[] } {
  const sorted = [...cands].sort((a, b) => b.score - a.score || a.i - b.i || a.j - b.j);
  const usedO = new Set<number>(), usedN = new Set<number>(); const pairs: { i: number; j: number; score: number; ambiguous: boolean }[] = [];
  for (const p of sorted) {
    if (usedO.has(p.i) || usedN.has(p.j)) continue;
    const rival = sorted.some((q) => q !== p && ((q.i === p.i && !usedN.has(q.j)) || (q.j === p.j && !usedO.has(q.i))) && q.score >= p.score - 0.15);
    pairs.push({ ...p, ambiguous: rival }); usedO.add(p.i); usedN.add(p.j);
  }
  return { pairs, removed: [...Array(nOld).keys()].filter((i) => !usedO.has(i)), added: [...Array(nNew).keys()].filter((j) => !usedN.has(j)) };
}
function finish(rels: { field: string; rel: Rel; before: string | null; after: string | null }[], p: { i: number; j: number; score: number; ambiguous: boolean }, flags: string[], descriptive: string[]): Pair {
  const changes: Change[] = rels.filter((r) => r.rel === "conflict" || r.rel === "added").map((r) => ({ field: r.field, kind: r.rel as "conflict" | "added", before: r.before, after: r.after }));
  if (p.ambiguous) flags.push("ambiguous_match");
  return { oldIdx: p.i, newIdx: p.j, cls: changes.length === 0 && !p.ambiguous ? "kept" : "changed", changes, flags, descriptive, ambiguous: p.ambiguous, score: p.score };
}

// ---- jobs ----
// Fields: title, company, location, start_date(+_precision), end_date(+_precision), employer_name_override, job_responsibilities.
function matchWork(oldR: Rec[], newR: Rec[]): Section {
  const cands: { i: number; j: number; score: number }[] = [];
  oldR.forEach((o, i) => newR.forEach((n, j) => {
    const oc = clean(o.employer_name_override) || o.company;
    const co = companySim(oc, n.company), ti = sim(o.title, n.title);
    const st = dateRel(dv(o.start_date, o.start_date_precision), dv(n.start_date, n.start_date_precision));
    const anchors = (co !== null && co >= 0.85 ? 1 : 0) + (clean(o.title) && clean(n.title) && ti >= 0.85 ? 1 : 0) + (st === "same" ? 1 : 0);
    if (anchors >= 2) cands.push({ i, j, score: (co ?? 0.5) + ti + (st === "same" ? 1 : 0) });
  }));
  const r = assign(cands, oldR.length, newR.length);
  const pairs = r.pairs.map((p) => {
    const o = oldR[p.i], n = newR[p.j];
    const oc = clean(o.employer_name_override) || clean(o.company);
    const os = dv(o.start_date, o.start_date_precision), ns = dv(n.start_date, n.start_date_precision);
    const oe = dv(o.end_date, o.end_date_precision), ne = dv(n.end_date, n.end_date_precision);
    const rels = [
      { field: "company", rel: textRel(oc, n.company, 0.9, (a, b) => companySim(a, b) ?? 0), before: oc || null, after: clean(n.company) || null },
      { field: "title", rel: textRel(o.title, n.title, 0.9), before: clean(o.title) || null, after: clean(n.title) || null },
      { field: "start_date", rel: dateRel(os, ns), before: showDate(os), after: showDate(ns) },
      { field: "end_date", rel: dateRel(oe, ne), before: showDate(oe), after: showDate(ne) },
      { field: "location", rel: locationRel(o.location, n.location), before: clean(o.location) || null, after: clean(n.location) || null },
    ];
    const flags: string[] = [];
    for (const x of rels) {
      if (x.rel === "omitted" && (x.field === "company" || x.field === "end_date" || x.field === "start_date")) flags.push(`${x.field}_not_stated`);
    }
    if ((os && ns && os !== ns && dateRel(os, ns) === "same") || (oe && ne && oe !== ne && dateRel(oe, ne) === "same" && oe !== "present")) flags.push("date_precision_differs_kept_as_verified");
    const desc: string[] = [];
    if (norm(o.job_responsibilities) !== norm(n.job_responsibilities)) desc.push("responsibilities");
    return finish(rels, p, flags, desc);
  });
  return { pairs, removed: r.removed, added: r.added };
}

// ---- education ----
const DEGREE_LEVELS: [RegExp, string][] = [
  [/\b(ph ?d|doctor|doctorate|dphil|edd)\b/, "doctorate"], [/\b(master|masters|mba|msc|m ?s|m ?a|meng|mfa)\b/, "master"],
  [/\b(bachelor|bachelors|bsc|b ?s|b ?a|bba|beng|bfa|undergraduate)\b/, "bachelor"], [/\b(associate|associates|a ?a ?s?|a ?s)\b/, "associate"],
  [/\b(high school|ged|secondary)\b/, "highschool"], [/\b(certificate|diploma)\b/, "certificate"],
];
function degreeLevel(d: unknown): string {
  const t = norm(d); if (!t) return "";
  for (const [re, lvl] of DEGREE_LEVELS) if (re.test(t)) return lvl;
  return t;
}
const GENERIC_DEGREE = /^(bachelor|bachelors|master|masters|associate|associates|doctorate|doctor)( degree)?$/;
const specificDegree = (d: unknown): boolean => { const t = norm(d); return !!t && !GENERIC_DEGREE.test(t); };
function matchEducation(oldR: Rec[], newR: Rec[]): Section {
  const cands: { i: number; j: number; score: number }[] = [];
  oldR.forEach((o, i) => newR.forEach((n, j) => {
    if (!clean(o.institution) || !clean(n.institution)) return; // no institution, no identity
    const is = sim(o.institution, n.institution);
    if (is < 0.85) return;
    const lo = degreeLevel(o.degree), ln = degreeLevel(n.degree);
    if (lo && ln && lo !== ln) return; // a bachelor's and a master's at one school are two items
    cands.push({ i, j, score: is + (lo && ln ? 1 : 0.5) });
  }));
  const r = assign(cands, oldR.length, newR.length);
  const pairs = r.pairs.map((p) => {
    const o = oldR[p.i], n = newR[p.j];
    const os = dv(o.start_date, o.start_date_precision), ns = dv(n.start_date, n.start_date_precision);
    const oe = dv(o.end_date, o.end_date_precision), ne = dv(n.end_date, n.end_date_precision);
    let degRel: Rel;
    if (!clean(n.degree)) degRel = clean(o.degree) ? "omitted" : "same";
    else if (!clean(o.degree)) degRel = "added";
    else if (specificDegree(o.degree) && specificDegree(n.degree)) degRel = sim(o.degree, n.degree) >= 0.9 ? "same" : "conflict";
    else if (!specificDegree(o.degree) && specificDegree(n.degree)) degRel = "added";
    else degRel = "same";
    const rels = [
      { field: "institution", rel: textRel(o.institution, n.institution, 0.9), before: clean(o.institution) || null, after: clean(n.institution) || null },
      { field: "degree", rel: degRel, before: clean(o.degree) || null, after: clean(n.degree) || null },
      { field: "field_of_study", rel: textRel(o.field_of_study, n.field_of_study, 0.85), before: clean(o.field_of_study) || null, after: clean(n.field_of_study) || null },
      { field: "start_date", rel: dateRel(os, ns), before: showDate(os), after: showDate(ns) },
      { field: "end_date", rel: dateRel(oe, ne), before: showDate(oe), after: showDate(ne) },
      { field: "location", rel: locationRel(o.location, n.location), before: clean(o.location) || null, after: clean(n.location) || null },
    ];
    const flags: string[] = [];
    for (const x of rels) if (x.rel === "omitted" && (x.field === "field_of_study" || x.field === "degree")) flags.push(`${x.field}_not_stated`);
    return finish(rels, p, flags, []);
  });
  return { pairs, removed: r.removed, added: r.added };
}

// ---- certifications and licenses (one certification row; a license is that row plus its license_items extension, carried as `state`) ----
const lnorm = (s: unknown): string => String(s ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
function matchCertifications(oldR: Rec[], newR: Rec[]): Section {
  const cands: { i: number; j: number; score: number }[] = [];
  oldR.forEach((o, i) => newR.forEach((n, j) => {
    const on = lnorm(o.license_number), nn = lnorm(n.license_number);
    const ns = sim(o.name, n.name);
    const isu = clean(o.issuing_body) && clean(n.issuing_body) ? sim(o.issuing_body, n.issuing_body) : null;
    let same: boolean;
    if (on && nn) same = on === nn;                                   // a license number decides on its own (different number = different item)
    else same = clean(o.name) !== "" && clean(n.name) !== "" && ns >= 0.9 && (isu === null || isu >= 0.8);
    if (same) cands.push({ i, j, score: (on && nn ? 2 : 0) + ns + (isu ?? 0.5) });
  }));
  const r = assign(cands, oldR.length, newR.length);
  const pairs = r.pairs.map((p) => {
    const o = oldR[p.i], n = newR[p.j];
    const oi = dv(o.issue_date, o.issue_date_precision), ni = dv(n.issue_date, n.issue_date_precision);
    const ox = dv(o.expiration_date, o.expiration_date_precision), nx = dv(n.expiration_date, n.expiration_date_precision);
    const ols = clean(o.license_state).toUpperCase(), nls = clean(n.license_state).toUpperCase();
    const byNumber = !!lnorm(o.license_number) && !!lnorm(n.license_number); // the number identifies a license; how its title is worded is descriptive
    const rels = [
      { field: "name", rel: byNumber ? "same" : textRel(o.name, n.name, 0.9), before: clean(o.name) || null, after: clean(n.name) || null },
      { field: "issuing_body", rel: textRel(o.issuing_body, n.issuing_body, 0.8), before: clean(o.issuing_body) || null, after: clean(n.issuing_body) || null },
      { field: "license_number", rel: !lnorm(n.license_number) ? (lnorm(o.license_number) ? "omitted" : "same") : !lnorm(o.license_number) ? "added" : lnorm(o.license_number) === lnorm(n.license_number) ? "same" : "conflict", before: clean(o.license_number) || null, after: clean(n.license_number) || null },
      { field: "issue_date", rel: dateRel(oi, ni), before: showDate(oi), after: showDate(ni) },
      { field: "expiration_date", rel: dateRel(ox, nx), before: showDate(ox), after: showDate(nx) },
      { field: "license_state", rel: !nls ? (ols ? "omitted" : "same") : !ols ? "added" : ols === nls ? "same" : "conflict", before: ols || null, after: nls || null },
    ] as { field: string; rel: Rel; before: string | null; after: string | null }[];
    const flags: string[] = [];
    for (const x of rels) if (x.rel === "omitted" && (x.field === "license_number" || x.field === "issuing_body" || x.field === "license_state")) flags.push(`${x.field}_not_stated`);
    return finish(rels, p, flags, []);
  });
  return { pairs, removed: r.removed, added: r.added };
}

// ---- skills and freeform sections: descriptive, no verification ----
function matchTexts(oldT: string[], newT: string[], thr: number): { pairs: { i: number; j: number }[]; removed: number[]; added: number[] } {
  const cands: { i: number; j: number; score: number }[] = [];
  oldT.forEach((o, i) => newT.forEach((n, j) => { const s = sim(o, n); if (s >= thr) cands.push({ i, j, score: s }); }));
  const r = assign(cands, oldT.length, newT.length);
  return { pairs: r.pairs.map((p) => ({ i: p.i, j: p.j })), removed: r.removed, added: r.added };
}

// Would this text plausibly still be in the new file? (an item proposed for removal whose name appears in the new document's text was probably
// missed by extraction, not removed by the candidate). true / false, or null when the new document has no text to check against.
// Whole words only (a needle inside a longer word does not count), and the caller passes only distinctive needles: found live, a company alias
// "Independent" (from "Independent / Freelance") matched the ordinary phrase "independent AI projects" and flagged a job that is NOT in the file.
function presentInText(foldedDoc: string | null, ...needles: unknown[]): boolean | null {
  if (foldedDoc === null) return null;
  const hay = ` ${foldedDoc} `;
  for (const n of needles) { const f = fold(n); if (f.length >= 5 && hay.includes(` ${f} `)) return true; }
  return false;
}
// @@matcher-end

// ---------------------------------------------------------------------------------------------------------------------------------------------
// Auth: the candidate's own live session, exactly as the other candidate-keyed functions (hashed, unrevoked, unexpired, this candidate).
async function sha256Hex(s: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return Array.from(new Uint8Array(d)).map((b) => b.toString(16).padStart(2, "0")).join("");
}
async function rows(path: string): Promise<any[]> {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, { headers: REST });
  return r.ok ? await r.json() : [];
}
async function isCandidateSession(body: any, candidateId: string): Promise<boolean> {
  const tok = typeof body?.session_token === "string" ? body.session_token : "";
  if (tok.length < 20 || tok.length > 200 || !candidateId) return false;
  const sess = (await rows(`candidate_sessions?token_hash=eq.${await sha256Hex(tok)}&select=candidate_id,expires_at,revoked_at`))[0];
  return !!sess && !sess.revoked_at && new Date(sess.expires_at).getTime() > Date.now() && sess.candidate_id === candidateId;
}
async function patch(path: string, body: unknown): Promise<any[]> {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, { method: "PATCH", headers: { ...REST, "Content-Type": "application/json", "Prefer": "return=representation" }, body: JSON.stringify(body) });
  return r.ok ? await r.json() : [];
}

const OPEN = ["uploading", "extracting", "detecting_licenses", "ready"];
// @@ops-start
const printDate = (d: unknown, p: unknown): string => showDate(dv(d, p)) || "";
const label = {
  work: (r: Rec) => [clean(r.title), clean(r.employer_name_override) || clean(r.company), [printDate(r.start_date, r.start_date_precision), printDate(r.end_date, r.end_date_precision)].filter(Boolean).join(" – ")].filter(Boolean).join(" · ") || "(untitled job)",
  education: (r: Rec) => [[clean(r.degree), clean(r.field_of_study)].filter(Boolean).join(", "), clean(r.institution)].filter(Boolean).join(" · ") || "(untitled education)",
  certification: (r: Rec) => [clean(r.name), clean(r.issuing_body), r.license_number ? `#${clean(r.license_number)}` : ""].filter(Boolean).join(" · ") || "(untitled certification)",
};
// The staff-facing claim text a NEW or CHANGED item carries: the same shape as confirm-resume-data's claim builders.
const claim = {
  work: (w: Rec) => [w.title, w.company, w.location, [printDate(w.start_date, w.start_date_precision), printDate(w.end_date, w.end_date_precision)].filter(Boolean).join(" – ")].filter(Boolean).join(", "),
  education: (e: Rec) => [e.degree, e.field_of_study, e.institution, e.location, [printDate(e.start_date, e.start_date_precision), printDate(e.end_date, e.end_date_precision)].filter(Boolean).join(" – ")].filter(Boolean).join(", "),
  certification: (c: Rec) => [c.name, c.issuing_body, c.license_number ? `Lic #${c.license_number}` : null, printDate(c.issue_date, c.issue_date_precision)].filter(Boolean).join(", "),
  license: (c: Rec, state: string) => [c.name || "License", c.issuing_body, c.license_number ? `Lic #${c.license_number}` : null, state].filter(Boolean).join(", "), // verify-license's claimFor
  needsReview: (f: Rec) => {
    const heading = (f.heading || "").trim(), content = (f.content || "").trim();
    const preview = content.length > 140 ? content.slice(0, 140) + "…" : content;
    return heading ? `${heading}: ${preview}` : preview || "(no heading, no content)";
  },
};

type OptIn = { work: boolean; education: boolean; certifications: boolean };
const TABLE: Record<string, string> = { work: "work_history_items", education: "education_items", certification: "certification_items", skill: "skill_items", freeform: "candidate_freeform_sections" };
// which stored columns a changed FACT rewrites (a fact the new file merely omits is never rewritten)
const FACT_COLS: Record<string, Record<string, string[]>> = {
  work: { company: ["company"], title: ["title"], start_date: ["start_date", "start_date_precision"], end_date: ["end_date", "end_date_precision"], location: ["location"] },
  education: { institution: ["institution"], degree: ["degree"], field_of_study: ["field_of_study"], start_date: ["start_date", "start_date_precision"], end_date: ["end_date", "end_date_precision"], location: ["location"] },
  certification: { name: ["name"], issuing_body: ["issuing_body"], license_number: ["license_number"], issue_date: ["issue_date", "issue_date_precision"], expiration_date: ["expiration_date", "expiration_date_precision"], license_state: [] },
};
const DESCRIPTIVE_COLS = ["position", "heading", "extraction_confidence"];
const NEEDS_REVIEW_NOTE = (f: Rec) => `Auto-flagged: unstructured content from the candidate's resume that didn't map to a defined category (heading: ${JSON.stringify(f.heading || "(none)")}). Not independently validated against the uploaded document the way the structured fields above it are — review for anything that reads like an inserted job-description-style claim rather than content genuinely present on the original resume. Full content:\n\n${f.content || ""}`;

// The record a CHANGED item becomes: the verified record with ONLY the changed facts rewritten (a fact the new file omits, or states in a way the
// matcher treats as the same, keeps its verified value). One function so the plan the candidate reviews and the update apply commits can never
// disagree about the claim text.
function mergeFacts(kind: string, o: Rec, n: Rec, changes: Change[]): { facts: Record<string, unknown>; clearContact: boolean; merged: Rec } {
  const facts: Record<string, unknown> = {}; let clearContact = false;
  for (const ch of changes) {
    for (const col of FACT_COLS[kind][ch.field] || []) facts[col] = n[col] ?? null;
    if (kind === "work" && ch.field === "company") clearContact = true; // a different employer: the old contact details no longer apply
  }
  if (clearContact) Object.assign(facts, { employer_name_override: null, employer_location_override: null, contact_phone: null, contact_name: null });
  return { facts, clearContact, merged: { ...o, ...facts } };
}

// ctx = what computePlan read and matched (active rows a*, staged rows s*, the queue rows, the match results). Returns the INSTRUCTIONS the SQL apply
// executes, plus what must happen after the commit (license checks, contact details).
function buildOps(c: any, optIn: OptIn, newDoc: string, baseDoc: string | null) {
  const { aW, aE, aS, aF, aL, sW, sE, sS, sF, sL, vq, W, E, C, S, F, oldCert, newCert } = c;
  const aLic = new Map<string, any>(aL.map((l: any) => [l.linked_certification_id, l])), sLic = new Map<string, any>(sL.map((l: any) => [l.linked_certification_id, l]));
  const bySrc = new Map<string, any[]>();
  for (const v of vq) if (v.source_item_id) { const a = bySrc.get(v.source_item_id) || []; a.push(v); bySrc.set(v.source_item_id, a); }
  const vqIds = new Set<string>(vq.map((v: any) => v.id));
  const rowsOf = (id: string, type?: string) => (bySrc.get(id) || []).filter((v) => !type || v.type === type);
  const ops: any = {
    candidate_id: c.cid, new_document_id: newDoc, base_document_id: baseDoc, opt_in: optIn,
    removed: [], changed: [], kept: [], added: [], lineage: [], contact_reset: false,
    staged: { work_history_items: sW.map((r: any) => r.id), education_items: sE.map((r: any) => r.id), certification_items: newCert.map((r: any) => r.id), skill_items: sS.map((r: any) => r.id), candidate_freeform_sections: sF.map((r: any) => r.id) },
    staged_delete: { work: [], education: [], certification: [], skill: [], freeform: [] },
    guard: {
      items: [
        ...aW.map((r: any) => ({ t: "work_history_items", id: r.id, ts: r.updated_at })), ...aE.map((r: any) => ({ t: "education_items", id: r.id, ts: r.updated_at })),
        ...oldCert.map((r: any) => ({ t: "certification_items", id: r.id, ts: r.updated_at })), ...aS.map((r: any) => ({ t: "skill_items", id: r.id, ts: r.updated_at })),
        ...aF.map((r: any) => ({ t: "candidate_freeform_sections", id: r.id, ts: r.updated_at })), ...aL.map((r: any) => ({ t: "license_items", id: r.id, ts: r.updated_at })),
      ],
      counts: { work_history_items: aW.length, education_items: aE.length, certification_items: oldCert.length, skill_items: aS.length, candidate_freeform_sections: aF.length, license_items: aL.length },
      queue: vq.map((v: any) => ({ id: v.id, status: v.status, ts: v.status_changed_at })), queue_count: vq.length,
    },
  };
  const verifyIds: string[] = [];
  const contactNeeded: { work: string[]; certification: string[] } = { work: [], certification: [] };
  const CAT: Record<string, keyof OptIn> = { work: "work", education: "education", certification: "certifications" };
  const QTYPE: Record<string, string> = { work: "Job Experience", education: "Education", certification: "Certification" };

  // the queue row a NEW item (or a changed item that had none) gets, under the same rules confirm-resume-data applies
  const newQueue = (kind: string, r: Rec) => {
    if (kind === "certification") {
      const unmatched = r.source_match === "unmatched", missingTrade = !r.trade_soc_code;
      if (!unmatched && !optIn.certifications) return null;
      if (unmatched || missingTrade) {
        const reasons: string[] = [];
        if (unmatched) reasons.push(`this certification's name did not fuzzy-match anything in the candidate's own uploaded document (OCR'd text) — see certification_source_match. Not proof of fabrication (OCR coverage has real, documented gaps: vision-routed pages have no OCR text at all), but real enough to warrant a human look before treating it as verified. Name as extracted: ${JSON.stringify(r.name || "")}`);
        if (missingTrade) reasons.push("no trade/occupation type (SOC code) was selected for this certification — see certification_items.trade_soc_code. No automated licensing-board check can be routed without it, so this needs a human look rather than silently sitting as a normal queue item with no check that will ever fire.");
        return { type: "Certification", claim: claim.certification(r), status: "Needs Reconciliation", internal_note: `Auto-flagged: ${reasons.join(" Also: ")}` };
      }
      return { type: "Certification", claim: claim.certification(r), status: "New", internal_note: null };
    }
    if (!optIn[CAT[kind]]) return null;
    return { type: QTYPE[kind], claim: (claim as any)[kind](r), status: "New", internal_note: null };
  };
  const lineage = (kind: string, id: string, relation: string) => ops.lineage.push({ kind, id, relation });

  const sections: [string, Section, any[], any[]][] = [["work", W, aW, sW], ["education", E, aE, sE], ["certification", C, oldCert, newCert]];
  for (const [kind, sec, oldR, newR] of sections) {
    for (const i of sec.removed) {
      const r = oldR[i]; const lic = kind === "certification" ? aLic.get(r.id) : null;
      const ids = new Set<string>(rowsOf(r.id).map((v) => v.id));
      if (lic) { for (const v of rowsOf(lic.id)) ids.add(v.id); if (lic.queue_item_id && vqIds.has(lic.queue_item_id)) ids.add(lic.queue_item_id); }
      ops.removed.push({ kind, id: r.id, license_id: lic ? lic.id : null, vq: [...ids] });
    }
    for (const p of sec.pairs) {
      const o = oldR[p.oldIdx], n = newR[p.newIdx];
      const desc: Record<string, unknown> = {};
      for (const col of DESCRIPTIVE_COLS) desc[col] = n[col] ?? null;
      if (kind === "work" && clean(n.job_responsibilities)) desc.job_responsibilities = n.job_responsibilities;
      ops.staged_delete[kind].push(n.id);
      if (p.cls === "kept") {
        ops.kept.push({ kind, id: o.id, fields: desc });
        lineage(kind, o.id, p.descriptive.length ? "descriptive_updated" : "reconfirmed");
        continue;
      }
      // CHANGED: rewrite only the facts that changed; everything the new file omitted keeps its verified value
      const mf = mergeFacts(kind, o, n, p.changes);
      const fields: Record<string, unknown> = { ...desc, ...mf.facts };
      const merged = mf.merged;
      const newClaim = (claim as any)[kind](merged);
      const existing = rowsOf(o.id, QTYPE[kind])[0] || null;
      const lic = kind === "certification" ? aLic.get(o.id) : null;
      const allVq = new Set<string>(rowsOf(o.id).map((v) => v.id));
      if (lic) { for (const v of rowsOf(lic.id)) allVq.add(v.id); if (lic.queue_item_id && vqIds.has(lic.queue_item_id)) allVq.add(lic.queue_item_id); }
      const what = p.changes.map((ch: Change) => `${ch.field.replace(/_/g, " ")}: ${ch.before ?? "(none)"} → ${ch.after ?? "(none)"}${ch.kind === "added" ? " (new detail)" : ""}`).join("; ") || "matched ambiguously, so treated as changed";
      let queue: any = null;
      if (existing) {
        // the same flag rule a NEW certification gets: an unmatched name, or no trade selected (so no automated check can ever route), is Needs
        // Reconciliation, not New, whatever the row's previous status was
        const flagged = kind === "certification" && (merged.source_match === "unmatched" || !merged.trade_soc_code);
        const status = flagged ? "Needs Reconciliation" : "New";
        queue = optIn[CAT[kind]] ? { mode: "reset", id: existing.id, claim: newClaim, status, note: `Before: ${existing.claim || "(no claim)"} (status ${existing.status}). After: ${newClaim} (status ${status}). Changed: ${what}.` } : { mode: "delete", ids: [existing.id] };
      } else {
        const q = newQueue(kind, merged);
        if (q) queue = { mode: "insert", row: q };
      }
      if (queue && queue.mode !== "delete" && (kind === "work" || kind === "certification")) contactNeeded[kind].push(o.id); // education has no contact step
      const entry: any = { kind, id: o.id, fields, vq_all: [...allVq], queue };
      // the license extension (a licensed certification only)
      if (kind === "certification" && p.changes.some((ch: Change) => ch.field === "license_state" || ch.field === "license_number")) {
        const licS = sLic.get(n.id);
        const state = (licS?.state || lic?.state || "") as string;
        if (lic) {
          const lq = rowsOf(lic.id, "License")[0] || (lic.queue_item_id ? vq.find((v: any) => v.id === lic.queue_item_id) : null);
          entry.license = {
            action: "reset", id: lic.id, state: licS?.state || "", state_source: licS?.state_source || "candidate", state_evidence: licS?.state_evidence || null,
            queue_id: lq ? lq.id : null, claim: claim.license(merged, state),
            note: `Before: ${lq?.claim || "(no claim)"} (status ${lq?.status || "n/a"}). After: ${claim.license(merged, state)}. Changed: ${what}.`,
          };
          if (state) verifyIds.push(lic.id);
        } else if (licS) {
          entry.license = { action: "attach", staged_id: licS.id };
          if (licS.state) verifyIds.push(licS.id);
        }
        if (entry.license) lineage("license", entry.license.id || entry.license.staged_id, "facts_changed");
      }
      ops.changed.push(entry);
      lineage(kind, o.id, "facts_changed");
    }
    for (const j of sec.added) {
      const r = newR[j]; const licS = kind === "certification" ? sLic.get(r.id) : null;
      const q = newQueue(kind, r);
      ops.added.push({ kind, staged_id: r.id, queue: q, license_staged_id: licS ? licS.id : null });
      lineage(kind, r.id, "origin");
      if (q && (kind === "work" || kind === "certification")) contactNeeded[kind].push(r.id);
      if (licS) { lineage("license", licS.id, "origin"); if (licS.state) verifyIds.push(licS.id); }
    }
  }

  // skills: unverified, so removed = archived + deleted, kept = position only, added = confirmed
  for (const i of S.removed) ops.removed.push({ kind: "skill", id: aS[i].id, vq: [] });
  for (const p of S.pairs) { ops.kept.push({ kind: "skill", id: aS[p.i].id, fields: { position: sS[p.j].position ?? null, section_position: sS[p.j].section_position ?? null } }); ops.staged_delete.skill.push(sS[p.j].id); lineage("skill", aS[p.i].id, "reconfirmed"); }
  for (const j of S.added) { ops.added.push({ kind: "skill", staged_id: sS[j].id, queue: null }); lineage("skill", sS[j].id, "origin"); }
  // freeform sections: a needs_review section's queue row is found by its claim text (that queue row has no source id)
  const nrRows = vq.filter((v: any) => v.type === "Needs Review");
  for (const i of F.removed) {
    const f = aF[i];
    const ids = f.section_type === "needs_review" ? nrRows.filter((v: any) => v.claim === claim.needsReview(f)).map((v: any) => v.id) : [];
    ops.removed.push({ kind: "freeform", id: f.id, vq: ids });
  }
  for (const p of F.pairs) { ops.kept.push({ kind: "freeform", id: aF[p.i].id, fields: { position: sF[p.j].position ?? null, heading: sF[p.j].heading ?? null } }); ops.staged_delete.freeform.push(sF[p.j].id); lineage("freeform", aF[p.i].id, "reconfirmed"); }
  for (const j of F.added) {
    const f = sF[j];
    ops.added.push({ kind: "freeform", staged_id: f.id, queue: f.section_type === "needs_review" ? { type: "Needs Review", claim: claim.needsReview(f), status: "Needs Reconciliation", internal_note: NEEDS_REVIEW_NOTE(f) } : null });
    lineage("freeform", f.id, "origin");
  }

  ops.contact_reset = contactNeeded.work.length + contactNeeded.certification.length > 0;
  const counts = {
    added: ops.added.length, kept: ops.kept.length, changed: ops.changed.length, removed: ops.removed.length,
    queue_rows_created: ops.added.filter((a: any) => a.queue).length + ops.changed.filter((x: any) => x.queue && x.queue.mode === "insert").length,
    queue_rows_reset: ops.changed.filter((x: any) => x.queue && x.queue.mode === "reset").length,
    licenses_to_verify: verifyIds.length, contact_needed: contactNeeded,
  };
  ops.counts = counts;
  return { ops, verifyIds: [...new Set(verifyIds)], contactNeeded, counts };
}
// @@ops-end

function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (v && typeof v === "object") return `{${Object.keys(v as object).sort().map((k) => `${JSON.stringify(k)}:${canonical((v as any)[k])}`).join(",")}}`;
  return JSON.stringify(v);
}

// Discards one attempt's own upload: its staged rows (through the existing discard RPC), the stored files. Only ever an UNCONFIRMED document of
// kind 'resubmission'; anything else is refused and nothing is touched.
async function discardAttemptDoc(cid: string, docId: string): Promise<{ ok: boolean; refused?: boolean; detail?: string }> {
  const doc = (await rows(`resume_documents?id=eq.${docId}&candidate_id=eq.${cid}&select=id,kind,confirmed_at,original_storage_path,sanitized_render_path`))[0];
  if (!doc) return { ok: true };
  if (doc.kind !== "resubmission" || doc.confirmed_at) return { ok: false, refused: true };
  const rpc = await fetch(`${SUPABASE_URL}/rest/v1/rpc/discard_resume_document`, { method: "POST", headers: { ...REST, "Content-Type": "application/json" }, body: JSON.stringify({ p_resume_document_id: doc.id, p_candidate_id: cid }) });
  if (!rpc.ok) return { ok: false, detail: (await rpc.text()).slice(0, 200) };
  for (const p of [doc.original_storage_path, doc.sanitized_render_path].filter(Boolean)) {
    await fetch(`${SUPABASE_URL}/storage/v1/object/resume-documents/${p}`, { method: "DELETE", headers: REST }).catch(() => {});
  }
  return { ok: true };
}

async function computePlan(resub: any, doc: any): Promise<{ plan: any; fingerprint: string; ctx: any }> {
  const cid = resub.candidate_id, newDoc = doc.id;
  const confirmedDocs = (await rows(`resume_documents?candidate_id=eq.${cid}&confirmed_at=not.is.null&select=id`)).map((d) => d.id);
  if (!confirmedDocs.length) throw new Error("no_confirmed_document");
  const active = `candidate_id=eq.${cid}&candidate_confirmed=eq.true&resume_document_id=in.(${confirmedDocs.join(",")})`;
  const staged = `candidate_id=eq.${cid}&resume_document_id=eq.${newDoc}`;
  const [aW, aE, aC, aS, aF, aL, sW, sE, sC, sS, sF, sL, vq, snaps] = await Promise.all([
    rows(`work_history_items?${active}&select=*&order=position`), rows(`education_items?${active}&select=*&order=position`),
    rows(`certification_items?${active}&select=*&order=position`), rows(`skill_items?${active}&select=id,skill_text,position,section_position,updated_at&order=position`),
    rows(`candidate_freeform_sections?${active}&select=id,section_type,heading,content,position,updated_at&order=position`),
    rows(`license_items?${active}&select=id,linked_certification_id,state,verification_outcome,queue_item_id,updated_at`),
    rows(`work_history_items?${staged}&select=*&order=position`), rows(`education_items?${staged}&select=*&order=position`),
    rows(`certification_items?${staged}&select=*&order=position`), rows(`skill_items?${staged}&select=id,skill_text,position,section_position&order=position`),
    rows(`candidate_freeform_sections?${staged}&select=id,section_type,heading,content,position&order=position`),
    rows(`license_items?${staged}&select=id,linked_certification_id,state,state_source,state_evidence`),
    rows(`verification_items?candidate_id=eq.${cid}&select=id,type,claim,status,status_changed_at,source_item_id,assigned_to,correction_requested`),
    rows(`comparison_snapshots?candidate_id=eq.${cid}&select=request_id`),
  ]);
  const ocr = (await rows(`resume_documents?id=eq.${newDoc}&select=ocr_raw_text`))[0]?.ocr_raw_text as string | null | undefined;
  const docText: string | null = ocr && ocr.trim() ? fold(ocr) : null;

  // verification rows by source item (License rows point at the license_items row, not the certification)
  const vBySource = new Map<string, any[]>();
  for (const v of vq) if (v.source_item_id) { const a = vBySource.get(v.source_item_id) || []; a.push(v); vBySource.set(v.source_item_id, a); }
  const vInfo = (id: string, types: string[]) => {
    const v = (vBySource.get(id) || []).find((x) => types.includes(x.type));
    return v ? { queue_id: v.id, status: v.status, verified_on: v.status === "Confirmed" ? v.status_changed_at : null, assigned: !!v.assigned_to, open: !["Confirmed", "Discrepancy", "Unable to Verify"].includes(v.status) } : null;
  };
  const licByCert = (rowsL: any[]) => new Map(rowsL.map((l) => [l.linked_certification_id, l]));
  const aLic = licByCert(aL), sLic = licByCert(sL);
  const withLic = (c: any, m: Map<string, any>) => ({ ...c, license_state: m.get(c.id)?.state ?? null });

  const oldCert = aC.map((c) => withLic(c, aLic)), newCert = sC.map((c) => withLic(c, sLic));
  const W = matchWork(aW, sW), E = matchEducation(aE, sE), C = matchCertifications(oldCert, newCert);
  const S = matchTexts(aS.map((s) => s.skill_text), sS.map((s) => s.skill_text), 0.92);
  const F = matchTexts(aF.map((f) => `${f.section_type} ${f.content}`), sF.map((f) => `${f.section_type} ${f.content}`), 0.95);

  const plan: any = { removed: [], changed: [], added: [], kept: [], skills: { added: [], removed: [], kept: S.pairs.length }, freeform: { added: [], removed: [], kept: F.pairs.length }, warnings: [] };
  const optCount: Record<string, number> = { work: 0, education: 0, certification: 0 };

  const emit = (kind: "work" | "education" | "certification", sec: Section, oldR: any[], newR: any[]) => {
    const types = kind === "work" ? ["Job Experience"] : kind === "education" ? ["Education"] : ["Certification"];
    const vOf = (r: any) => {
      const v = vInfo(r.id, types);
      if (kind !== "certification") return v;
      const lic = aLic.get(r.id); const lv = lic ? vInfo(lic.id, ["License"]) : null;
      return v || lv ? { ...(v || {}), ...(lv ? { license: lv } : {}) } : null;
    };
    for (const i of sec.removed) {
      const r = oldR[i];
      // work: the full title, the full company name, or a multi-word alias (never a one-word alias such as "Independent")
      const seen = kind === "work" ? presentInText(docText, r.title, clean(r.employer_name_override) || clean(r.company), ...aliases(r.company).filter((x) => x.trim().split(/\s+/).length >= 2))
        : kind === "education" ? presentInText(docText, r.institution) : presentInText(docText, r.license_number ? lnorm(r.license_number) : null, r.name);
      plan.removed.push({ kind, item_id: r.id, label: label[kind](r), verification: vOf(r), has_open_queue_item: !!(vOf(r) as any)?.open, still_in_new_file_text: seen });
    }
    for (const p of sec.pairs) {
      const o = oldR[p.oldIdx], n = newR[p.newIdx];
      if (p.cls === "kept") plan.kept.push({ kind, item_id: o.id, staged_id: n.id, label: label[kind](o), verification: vOf(o), descriptive_updates: p.descriptive, flags: p.flags });
      else {
        const v = vOf(o);
        plan.changed.push({
          kind, item_id: o.id, staged_id: n.id, label: label[kind](o), changes: p.changes, ambiguous: p.ambiguous, flags: p.flags,
          verification_before: v ? (v as any).status ?? null : null,
          verification_after: v ? "New (re-verified)" : "not in verification (no queue row before)",
          new_claim: claim[kind](mergeFacts(kind, o, n, p.changes).merged),
        });
        if (v) optCount[kind]++;
      }
    }
    for (const j of sec.added) {
      const r = newR[j]; const flags: string[] = [];
      if (kind === "education" && !clean(r.institution)) flags.push("incomplete");
      if (kind === "work" && !clean(r.company) && !clean(r.title)) flags.push("incomplete");
      if (kind === "certification" && !clean(r.name)) flags.push("incomplete");
      if ([r.company, r.title, r.institution, r.degree, r.field_of_study, r.name].some((x) => x != null && PLACEHOLDER.test(String(x)))) flags.push("placeholder_text");
      plan.added.push({ kind, staged_id: r.id, label: label[kind](r), claim: claim[kind](r), flags });
      if (flags.includes("incomplete") || flags.includes("placeholder_text")) plan.warnings.push({ code: flags.includes("incomplete") ? "incomplete_item" : "placeholder_text", kind, label: label[kind](r) });
    }
  };
  emit("work", W, aW, sW); emit("education", E, aE, sE); emit("certification", C, oldCert, newCert);

  for (const i of S.removed) plan.skills.removed.push({ text: aS[i].skill_text, still_in_new_file_text: presentInText(docText, aS[i].skill_text) });
  for (const j of S.added) plan.skills.added.push({ text: sS[j].skill_text });
  for (const i of F.removed) plan.freeform.removed.push({ section_type: aF[i].section_type, heading: aF[i].heading || null, preview: clean(aF[i].content).slice(0, 120) });
  for (const j of F.added) plan.freeform.added.push({ section_type: sF[j].section_type, heading: sF[j].heading || null, preview: clean(sF[j].content).slice(0, 120) });

  const removedTotal = plan.removed.length + plan.skills.removed.length;
  const activeTotal = aW.length + aE.length + aC.length + aS.length;
  if (removedTotal >= 5 && removedTotal / Math.max(1, activeTotal) >= 0.5) plan.warnings.push({ code: "large_removal", removed: removedTotal, of: activeTotal });
  const misses = plan.removed.filter((r: any) => r.still_in_new_file_text === true).length + plan.skills.removed.filter((r: any) => r.still_in_new_file_text === true).length;
  if (misses) plan.warnings.push({ code: "possible_extraction_miss", count: misses });
  if (docText === null) plan.warnings.push({ code: "no_text_to_check_removals" });
  if (plan.changed.some((c: any) => c.ambiguous)) plan.warnings.push({ code: "ambiguous_match", count: plan.changed.filter((c: any) => c.ambiguous).length });

  // Employers who hold an approved snapshot right now (frozen copies: this resubmission does not change them).
  let holders = 0, heldSnapshots = 0;
  if (snaps.length) {
    // resume comparisons only: a license report snapshot does not contain the resume items this update changes
    const reqs = await rows(`comparison_requests?id=in.(${snaps.map((s) => s.request_id).join(",")})&kind=eq.resume_comparison&select=id,org_id,requester_email`);
    heldSnapshots = reqs.length;
    holders = new Set(reqs.map((r) => r.org_id || (r.requester_email || "").toLowerCase())).size;
  }
  plan.employer_access = { holders, snapshots: heldSnapshots, note: "Comparisons an employer already holds are frozen copies and are not changed by this update." };
  const has = (types: string[]) => vq.some((v) => types.includes(v.type));
  plan.opt_in = {
    work: { count: plan.added.filter((a: any) => a.kind === "work").length + plan.changed.filter((c: any) => c.kind === "work").length, default: has(["Job Experience"]) },
    education: { count: plan.added.filter((a: any) => a.kind === "education").length + plan.changed.filter((c: any) => c.kind === "education").length, default: has(["Education"]) },
    certifications: { count: plan.added.filter((a: any) => a.kind === "certification").length + plan.changed.filter((c: any) => c.kind === "certification").length, default: has(["Certification", "License"]) },
  };
  plan.counts = { added: plan.added.length + plan.skills.added.length, kept: plan.kept.length + S.pairs.length, changed: plan.changed.length, removed: plan.removed.length + plan.skills.removed.length };
  plan.base_document_id = resub.base_document_id;
  plan.new_document_id = newDoc;

  // Fingerprint of the ACTIVE profile the plan was computed against (Stage 2 recomputes it and refuses to apply a plan built on an older state).
  const fp = canonical([
    aW.map((r) => [r.id, r.updated_at]), aE.map((r) => [r.id, r.updated_at]), aC.map((r) => [r.id, r.updated_at]), aS.map((r) => [r.id, r.updated_at]),
    aF.map((r) => [r.id, r.updated_at]), aL.map((r) => [r.id, r.updated_at, r.verification_outcome]),
    vq.filter((v) => v.source_item_id).map((v) => [v.id, v.status, v.status_changed_at]).sort(),
    [sW, sE, sC, sS, sF, sL].map((a) => a.map((r: any) => r.id).sort()),
  ]);
  return { plan, fingerprint: await sha256Hex(fp), ctx: { cid, aW, aE, aC, aS, aF, aL, sW, sE, sC, sS, sF, sL, vq, W, E, C, S, F, oldCert, newCert } };
}

export default {
  fetch: withSupabase({ auth: "none" }, async (req, _ctx) => {
    if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
    if (req.method !== "POST") return json({ ok: false, error: "method_not_allowed" }, 405);
    let body: any = {};
    try { body = await req.json(); } catch (_e) { body = {}; }
    const cid = typeof body.candidate_id === "string" ? body.candidate_id : "";
    if (!UUID.test(cid) || !(await isCandidateSession(body, cid))) return json({ ok: false, error: "unauthorized" }, 401);
    try {
      const action = typeof body.action === "string" ? body.action : "";
      const cand = (await rows(`candidates?id=eq.${cid}&select=id,account_type,deletion_scheduled_at`))[0];
      if (!cand) return json({ ok: false, error: "unauthorized" }, 401);

      if (action === "start") {
        if (cand.account_type !== "full_resume") return json({ ok: false, error: "not_available_for_account_type" }, 403);
        if (cand.deletion_scheduled_at) return json({ ok: false, error: "account_deactivated" }, 403);
        if (body.acknowledged !== true || body.ack_text_version !== ACK_TEXT_VERSION) return json({ ok: false, error: "ack_required", ack_text_version: ACK_TEXT_VERSION }, 400);
        const base = (await rows(`resume_documents?candidate_id=eq.${cid}&confirmed_at=not.is.null&select=id&order=confirmed_at.desc&limit=1`))[0];
        if (!base) return json({ ok: false, error: "no_confirmed_resume" }, 409);
        const open = (await rows(`resume_resubmissions?candidate_id=eq.${cid}&status=in.(${OPEN.join(",")})&select=id,status&limit=1`))[0];
        if (open) return json({ ok: false, error: "resubmission_in_progress", resubmission_id: open.id, status: open.status }, 409);
        const now = Date.now();
        const day = await rows(`resume_resubmissions?candidate_id=eq.${cid}&created_at=gt.${encodeURIComponent(new Date(now - 24 * 3600 * 1000).toISOString())}&select=created_at&order=created_at.asc`);
        const month = await rows(`resume_resubmissions?candidate_id=eq.${cid}&created_at=gt.${encodeURIComponent(new Date(now - 30 * 24 * 3600 * 1000).toISOString())}&select=created_at&order=created_at.asc`);
        if (day.length >= RATE_PER_DAY) return json({ ok: false, error: "rate_limited", window: "day", limit: RATE_PER_DAY, retry_after_seconds: Math.max(60, Math.ceil((new Date(day[0].created_at).getTime() + 24 * 3600 * 1000 - now) / 1000)) }, 429);
        if (month.length >= RATE_PER_30_DAYS) return json({ ok: false, error: "rate_limited", window: "30_days", limit: RATE_PER_30_DAYS, retry_after_seconds: Math.max(60, Math.ceil((new Date(month[0].created_at).getTime() + 30 * 24 * 3600 * 1000 - now) / 1000)) }, 429);
        // Only once the attempt is really going ahead (not rate-limited): leftover uploads of earlier FAILED attempts, kept so staff could see the
        // failure, are discarded now that the candidate is trying again.
        for (const f of await rows(`resume_resubmissions?candidate_id=eq.${cid}&status=eq.failed&resume_document_id=not.is.null&select=id,resume_document_id`)) {
          await discardAttemptDoc(cid, f.resume_document_id);
        }
        const ins = await fetch(`${SUPABASE_URL}/rest/v1/resume_resubmissions`, {
          method: "POST", headers: { ...REST, "Content-Type": "application/json", "Prefer": "return=representation" },
          body: JSON.stringify({ candidate_id: cid, base_document_id: base.id, status: "uploading", ack_at: new Date().toISOString(), ack_text_version: ACK_TEXT_VERSION }),
        });
        if (!ins.ok) return json({ ok: false, error: "resubmission_in_progress" }, 409); // lost the race for the one open slot
        const row = (await ins.json())[0];
        return json({ ok: true, resubmission_id: row.id, status: row.status });
      }

      if (action === "status") {
        const r = (await rows(`resume_resubmissions?candidate_id=eq.${cid}&select=id,status,resume_document_id,created_at,failure_reason&order=created_at.desc&limit=1`))[0] || null;
        return json({ ok: true, resubmission: r });
      }

      if (typeof body.resubmission_id !== "string" || !UUID.test(body.resubmission_id)) return json({ ok: false, error: "resubmission_id_invalid" }, 400);
      const resub = (await rows(`resume_resubmissions?id=eq.${body.resubmission_id.toLowerCase()}&candidate_id=eq.${cid}&select=*`))[0];
      if (!resub) return json({ ok: false, error: "not_found" }, 404);

      if (action === "cancel") {
        // An attempt that FAILED (extraction or license detection) leaves its staged upload behind for staff to see in the failure report; the
        // candidate can still cancel it, which discards that upload. An applied, cancelled or expired attempt has nothing to cancel.
        if (!OPEN.includes(resub.status) && resub.status !== "failed") return json({ ok: false, error: "not_open", status: resub.status }, 409);
        if (resub.resume_document_id) {
          const d = await discardAttemptDoc(cid, resub.resume_document_id);
          if (d.refused) return json({ ok: false, error: "refused" }, 409);
          if (!d.ok) return json({ ok: false, error: "discard_failed", detail: d.detail }, 500);
        }
        await patch(`resume_resubmissions?id=eq.${resub.id}&status=in.(${[...OPEN, "failed"].join(",")})`, { status: "cancelled", closed_at: new Date().toISOString(), updated_at: new Date().toISOString(), plan: null, plan_hash: null, base_fingerprint: null });
        return json({ ok: true, status: "cancelled" });
      }

      if (action === "plan") {
        if (!OPEN.includes(resub.status)) return json({ ok: true, status: resub.status, plan: resub.plan ?? null });
        if (!resub.resume_document_id) return json({ ok: true, status: "uploading" });
        const doc = (await rows(`resume_documents?id=eq.${resub.resume_document_id}&candidate_id=eq.${cid}&select=id,kind,confirmed_at,extraction_status,license_detection_status,license_detected_at`))[0];
        if (!doc || doc.kind !== "resubmission" || doc.confirmed_at) return json({ ok: false, error: "refused" }, 409);
        const setStatus = (status: string, extra: Record<string, unknown> = {}) => patch(`resume_resubmissions?id=eq.${resub.id}&status=in.(${OPEN.join(",")})`, { status, updated_at: new Date().toISOString(), ...extra });
        if (doc.extraction_status === "failed") { await setStatus("failed", { failure_reason: "extraction_failed", closed_at: new Date().toISOString() }); return json({ ok: true, status: "failed", reason: "extraction_failed" }); }
        if (doc.extraction_status !== "extracted") { if (resub.status !== "extracting") await setStatus("extracting"); return json({ ok: true, status: "extracting" }); }

        // Licenses on the new file must be detected before comparing: otherwise every license on the profile would look "removed".
        if (doc.license_detection_status !== "done") {
          const staleRunning = doc.license_detection_status === "running" && doc.license_detected_at && Date.now() - new Date(doc.license_detected_at).getTime() > 200 * 1000;
          if (doc.license_detection_status === "running" && !staleRunning) return json({ ok: true, status: "detecting_licenses" });
          if (resub.detect_attempts >= MAX_DETECT_ATTEMPTS) { await setStatus("failed", { failure_reason: "license_detection_failed", closed_at: new Date().toISOString() }); return json({ ok: true, status: "failed", reason: "license_detection_failed" }); }
          await setStatus("detecting_licenses", { detect_attempts: resub.detect_attempts + 1 });
          const run = fetch(`${SUPABASE_URL}/functions/v1/detect-license-mentions`, {
            method: "POST", headers: { ...REST, "Content-Type": "application/json" },
            body: JSON.stringify({ candidate_id: cid, resume_document_id: doc.id }), signal: AbortSignal.timeout(170000),
          }).then((r) => r.text()).catch(() => {});
          const er = (globalThis as { EdgeRuntime?: { waitUntil?: (p: Promise<unknown>) => void } }).EdgeRuntime;
          if (er && typeof er.waitUntil === "function") er.waitUntil(run); else await run;
          return json({ ok: true, status: "detecting_licenses" });
        }

        const { plan, fingerprint } = await computePlan(resub, doc);
        const planHash = await sha256Hex(canonical(plan));
        const saved = await setStatus("ready", { plan, plan_hash: planHash, base_fingerprint: fingerprint, counts: plan.counts });
        if (!saved.length) return json({ ok: true, status: "not_open" });
        return json({ ok: true, status: "ready", resubmission_id: resub.id, plan_hash: planHash, plan });
      }

      if (action === "apply") {
        // Nothing unreviewed ever applies. The plan the candidate saw is identified by its hash; it is RE-DERIVED here from the current data and must
        // hash the same, and the transaction re-checks the same facts again under row locks. Any difference answers 409 with the fresh plan, and
        // nothing has been written.
        const oi = body.opt_in;
        if (!oi || typeof oi.work !== "boolean" || typeof oi.education !== "boolean" || typeof oi.certifications !== "boolean") return json({ ok: false, error: "opt_in_invalid" }, 400);
        if (typeof body.plan_hash !== "string" || !/^[0-9a-f]{64}$/.test(body.plan_hash)) return json({ ok: false, error: "plan_hash_invalid" }, 400);
        if (resub.status !== "ready") return json({ ok: false, error: "not_ready", status: resub.status }, 409);
        const doc = (await rows(`resume_documents?id=eq.${resub.resume_document_id}&candidate_id=eq.${cid}&select=id,kind,confirmed_at,extraction_status,license_detection_status`))[0];
        if (!doc || doc.kind !== "resubmission" || doc.confirmed_at || doc.extraction_status !== "extracted" || doc.license_detection_status !== "done") return json({ ok: false, error: "refused" }, 409);
        const stale = async () => {
          // If the attempt is no longer open (a concurrent apply won the race, or it was cancelled) there is no "fresh plan" to offer: say so.
          const cur = (await rows(`resume_resubmissions?id=eq.${resub.id}&select=status`))[0];
          if (!cur || cur.status !== "ready") return json({ ok: false, error: "not_ready", status: cur?.status ?? null }, 409);
          const fresh = await computePlan(resub, doc); const h = await sha256Hex(canonical(fresh.plan));
          await patch(`resume_resubmissions?id=eq.${resub.id}&status=eq.ready`, { plan: fresh.plan, plan_hash: h, base_fingerprint: fresh.fingerprint, counts: fresh.plan.counts, updated_at: new Date().toISOString() });
          return json({ ok: false, error: "plan_changed", plan_hash: h, plan: fresh.plan }, 409);
        };
        const current = await computePlan(resub, doc);
        if (await sha256Hex(canonical(current.plan)) !== body.plan_hash) return await stale();
        const built = buildOps(current.ctx, { work: oi.work, education: oi.education, certifications: oi.certifications }, doc.id, resub.base_document_id);
        const rpc = await fetch(`${SUPABASE_URL}/rest/v1/rpc/apply_resume_resubmission`, {
          method: "POST", headers: { ...REST, "Content-Type": "application/json" }, body: JSON.stringify({ p_resubmission_id: resub.id, p_ops: built.ops }),
        });
        if (!rpc.ok) {
          const err = await rpc.json().catch(() => ({} as any));
          const msg = String(err?.message || "");
          if (msg === "plan_changed") return await stale();
          if (msg === "attempt_not_ready" || msg === "document_not_applicable") return json({ ok: false, error: "not_ready" }, 409);
          return json({ ok: false, error: "apply_failed", detail: msg.slice(0, 200) }, 500);
        }
        const result = await rpc.json();

        // After the commit: real registry checks for every license that is new or whose details changed (the same background pattern, and the
        // same single bundled candidate email, as the first confirmation). Their results land on the license and its queue row as they finish.
        if (built.verifyIds.length) {
          const runChecks = async () => {
            const out = await Promise.all(built.verifyIds.map(async (license_item_id) => {
              try {
                const r = await fetch(`${SUPABASE_URL}/functions/v1/verify-license`, { method: "POST", headers: { ...REST, "Content-Type": "application/json" }, body: JSON.stringify({ candidate_id: cid, license_item_id, defer_notice: true }), signal: AbortSignal.timeout(45000) });
                const j = await r.json().catch(() => ({} as any));
                return { ok: !!j.ok, correction: !!j.correction };
              } catch (_e) { return { ok: false, correction: false }; }
            }));
            if (out.some((o) => o.correction)) {
              await fetch(`${SUPABASE_URL}/functions/v1/verify-license`, { method: "POST", headers: { ...REST, "Content-Type": "application/json" }, body: JSON.stringify({ candidate_id: cid, action: "notify_corrections" }), signal: AbortSignal.timeout(20000) }).catch(() => {});
            }
          };
          const er = (globalThis as { EdgeRuntime?: { waitUntil?: (p: Promise<unknown>) => void } }).EdgeRuntime;
          if (er && typeof er.waitUntil === "function") er.waitUntil(runChecks().catch(() => {})); else await runChecks();
        }
        return json({
          ok: true, status: "applied", counts: built.counts, archived: result.archived, queue_created: result.new_queue,
          licenses_verifying: built.verifyIds, contact_needed: built.contactNeeded, document_id: doc.id,
        });
      }

      return json({ ok: false, error: "unknown_action" }, 400);
    } catch (e) {
      return json({ ok: false, error: "unhandled", detail: String(e).slice(0, 200) }, 500);
    }
  }),
};
