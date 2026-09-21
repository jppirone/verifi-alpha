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
const printDate = (d: unknown, p: unknown): string => showDate(dv(d, p)) || "";
const label = {
  work: (r: Rec) => [clean(r.title), clean(r.employer_name_override) || clean(r.company), [printDate(r.start_date, r.start_date_precision), printDate(r.end_date, r.end_date_precision)].filter(Boolean).join(" – ")].filter(Boolean).join(" · ") || "(untitled job)",
  education: (r: Rec) => [[clean(r.degree), clean(r.field_of_study)].filter(Boolean).join(", "), clean(r.institution)].filter(Boolean).join(" · ") || "(untitled education)",
  certification: (r: Rec) => [clean(r.name), clean(r.issuing_body), r.license_number ? `#${clean(r.license_number)}` : ""].filter(Boolean).join(" · ") || "(untitled certification)",
};
// The staff-facing claim text a NEW or CHANGED item will carry (same shape as confirm-resume-data's claim builders; Stage 2 inserts it).
const claim = {
  work: (w: Rec) => [w.title, w.company, w.location, [printDate(w.start_date, w.start_date_precision), printDate(w.end_date, w.end_date_precision)].filter(Boolean).join(" – ")].filter(Boolean).join(", "),
  education: (e: Rec) => [e.degree, e.field_of_study, e.institution, e.location, [printDate(e.start_date, e.start_date_precision), printDate(e.end_date, e.end_date_precision)].filter(Boolean).join(" – ")].filter(Boolean).join(", "),
  certification: (c: Rec) => [c.name, c.issuing_body, c.license_number ? `Lic #${c.license_number}` : null, printDate(c.issue_date, c.issue_date_precision)].filter(Boolean).join(", "),
};

function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (v && typeof v === "object") return `{${Object.keys(v as object).sort().map((k) => `${JSON.stringify(k)}:${canonical((v as any)[k])}`).join(",")}}`;
  return JSON.stringify(v);
}

async function computePlan(resub: any, doc: any): Promise<{ plan: any; fingerprint: string }> {
  const cid = resub.candidate_id, newDoc = doc.id;
  const confirmedDocs = (await rows(`resume_documents?candidate_id=eq.${cid}&confirmed_at=not.is.null&select=id`)).map((d) => d.id);
  if (!confirmedDocs.length) throw new Error("no_confirmed_document");
  const active = `candidate_id=eq.${cid}&candidate_confirmed=eq.true&resume_document_id=in.(${confirmedDocs.join(",")})`;
  const staged = `candidate_id=eq.${cid}&resume_document_id=eq.${newDoc}`;
  const [aW, aE, aC, aS, aF, aL, sW, sE, sC, sS, sF, sL, vq, snaps] = await Promise.all([
    rows(`work_history_items?${active}&select=*&order=position`), rows(`education_items?${active}&select=*&order=position`),
    rows(`certification_items?${active}&select=*&order=position`), rows(`skill_items?${active}&select=id,skill_text,position,updated_at&order=position`),
    rows(`candidate_freeform_sections?${active}&select=id,section_type,heading,content,updated_at&order=position`),
    rows(`license_items?${active}&select=id,linked_certification_id,state,verification_outcome,queue_item_id,updated_at`),
    rows(`work_history_items?${staged}&select=*&order=position`), rows(`education_items?${staged}&select=*&order=position`),
    rows(`certification_items?${staged}&select=*&order=position`), rows(`skill_items?${staged}&select=id,skill_text,position&order=position`),
    rows(`candidate_freeform_sections?${staged}&select=id,section_type,heading,content&order=position`),
    rows(`license_items?${staged}&select=id,linked_certification_id,state`),
    rows(`verification_items?candidate_id=eq.${cid}&select=id,type,status,status_changed_at,source_item_id,assigned_to,correction_requested`),
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
          new_claim: claim[kind](n),
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
  return { plan, fingerprint: await sha256Hex(fp) };
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
        if (!OPEN.includes(resub.status)) return json({ ok: false, error: "not_open", status: resub.status }, 409);
        if (resub.resume_document_id) {
          const doc = (await rows(`resume_documents?id=eq.${resub.resume_document_id}&candidate_id=eq.${cid}&select=id,kind,confirmed_at,original_storage_path,sanitized_render_path`))[0];
          // Never a confirmed document, never an initial one: the only thing this can discard is this attempt's own unconfirmed upload.
          if (doc && (doc.kind !== "resubmission" || doc.confirmed_at)) return json({ ok: false, error: "refused" }, 409);
          if (doc) {
            const rpc = await fetch(`${SUPABASE_URL}/rest/v1/rpc/discard_resume_document`, { method: "POST", headers: { ...REST, "Content-Type": "application/json" }, body: JSON.stringify({ p_resume_document_id: doc.id, p_candidate_id: cid }) });
            if (!rpc.ok) return json({ ok: false, error: "discard_failed", detail: (await rpc.text()).slice(0, 200) }, 500);
            for (const p of [doc.original_storage_path, doc.sanitized_render_path].filter(Boolean)) {
              await fetch(`${SUPABASE_URL}/storage/v1/object/resume-documents/${p}`, { method: "DELETE", headers: REST }).catch(() => {});
            }
          }
        }
        await patch(`resume_resubmissions?id=eq.${resub.id}&status=in.(${OPEN.join(",")})`, { status: "cancelled", closed_at: new Date().toISOString(), updated_at: new Date().toISOString(), plan: null, plan_hash: null, base_fingerprint: null });
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

      return json({ ok: false, error: "unknown_action" }, 400);
    } catch (e) {
      return json({ ok: false, error: "unhandled", detail: String(e).slice(0, 200) }, 500);
    }
  }),
};
