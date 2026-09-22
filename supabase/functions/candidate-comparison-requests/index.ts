// Setup type definitions for built-in Supabase Runtime APIs
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { withSupabase } from "jsr:@supabase/server@^1";

const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY")!;
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "content-type",
};

// EMPLOYER COMPARISON REQUESTS, CANDIDATE SIDE (2026-09-20, Stage 1; REDESIGNED 2026-09-22). An employer asks (rows are created
// by the employer-side endpoints through create_comparison_request); the candidate, signed in, approves or declines here.
// NOTHING IS ASSEMBLED OR SHOWN TO THE EMPLOYER BEFORE APPROVAL. See the migration 20260920020000_comparison_requests.sql for
// the request/approval/retention lifecycle (UNCHANGED by the 2026-09-22 redesign below — same 72h answer window, same 7-day
// unopened-approval expiry, same 90-day org resume-comparison / 30-day org license-report / 30-minute guest view windows).
//
// Actions (POST {action, ...}). The first three need the candidate's OWN live session (session_token + candidate_id, checked against
// candidate_sessions on every call; every request is also scoped to that candidate, so another candidate's request id is a 404):
//   list           pending requests, history, real Tier 1 lookups that matched this candidate, and what an approval would share (for a resume
//                  comparison: every item, live, one of the five statuses below; for a LICENSE REPORT: the exact license lines, from the last
//                  stored checks)
//   preview        same "what would be shared", but a license report is re-checked against the registry first (cached 10 minutes)
//   respond        {request_id, decision: "approve" | "decline"}
//   view_snapshot  {request_id}: what an approved request currently shares — LIVE, re-assembled from the candidate's current profile on
//                  every call, not a frozen record of what was true at approval (see REDESIGN below)
//   document_link  {request_id}: a 60-second signed link to the employer's own document for one of THIS candidate's requests (private bucket, file unmodified)
//
// TWO KINDS of request (comparison_requests.kind), derived from the candidate's account type and never from anything a caller sends:
//   resume_comparison  full-resume accounts: the assembler below (every work/education/certification item, one of five statuses)
//   license_report     license-only accounts (no resume to compare): one line per license (assembleLicenseReport), status re-checked live at approval
// Internal (never reachable by a candidate or an employer):
//   notify_candidate  {request_id}: the "you have a request" email; service-role bearer only; sent at most once (claimed first)
//   sweep             cron: expire what timed out (expire_comparison_requests), send the undifferentiated "not authorized" emails,
//                     retry candidate notices that never went out; authenticated by the secret in internal_job_secrets
//
// ============================================================================================================================
// REDESIGN (2026-09-22) — a direction change, not a tweak. Full background/decisions in this task's own investigation report;
// restated here because this is the ONE place the rule lives.
//
// The Comparison is an AUDIT tool: an employer already holds a resume/document from elsewhere and wants to check it against
// what is actually true in the system. Because of that:
//   1. EVERY item the candidate has ever submitted (candidate_confirmed = true, on a confirmed resume_documents row) appears,
//      always, in its CURRENT state — never filtered out, never reduced to a bare count, and never something the candidate can
//      exclude or hide from this product (that control exists ONLY in Customization — candidate_customization /
//      candidate_item_overrides / assemble_customized_resume — and this assembler never reads any of those three; the two
//      products stay structurally firewalled from each other, exactly as before this redesign).
//   2. Every item shows exactly one of five honest, non-judgmental statuses, mapped from the internal verification_items.status
//      (externalStatus() below is the ONLY code that decides this mapping):
//        verified      internal 'Confirmed'.
//        in_progress   internal 'New' / 'In Progress' / 'Awaiting Response' / 'Needs Reconciliation', OR the item was never
//                       queued for verification at all in the normal flow (see 'no queue row' below).
//        not_possible  internal 'Verification Not Possible' (added 2026-09-22: no viable path existed to attempt verification
//                       at all — no contact, a defunct company, no public record) OR no verification_items row exists for this
//                       item at all. The two are deliberately the same external bucket: from an employer's point of view, an
//                       item nobody ever had a way to check reads identically whether the reason is "genuinely unreachable" or
//                       "never queued" (e.g. the candidate opted a whole category out of verification at signup) — in neither
//                       case was anything ever found, and 'not_possible' is the honest, non-judgmental word for that.
//        unable        internal 'Unable to Verify' — a channel existed and outreach happened, but no conclusive answer came
//                       back. Distinct from not_possible: this status means an attempt was actually made.
//        discrepancy   internal 'Discrepancy' — a conclusive, conflicting answer came back. ALWAYS carries both `claimed`
//                       (verification_items.claim) and `found` (verification_items.found_value, added 2026-09-22) — never just
//                       the word "Discrepancy" alone. A candidate's dispute of a Discrepancy (submit-candidate-correction-
//                       response) never changes what is shown here while it is pending, and an ACCEPTED correction (staff.html
//                       "Apply correction") resolves the item to Confirmed/verified going forward without altering the
//                       original claim/found_value that live here — see that migration's header for the full data-integrity
//                       story. None of this wording ever implies anything about the candidate's honesty; a dispute is answered
//                       by pointing back at the finding, never by softening or explaining it away.
//      For a license-linked certification the LICENSE's own queue row (type 'License') is authoritative when one exists,
//      exactly as before this redesign — same precedence, just extended to always show something rather than skip.
//   3. LIVE, not a frozen snapshot: comparison_snapshots is still written at approval time (unchanged — see below), but it is
//      now purely a gate ("has this request been approved, and does a row exist") and a historical "what was true when the
//      candidate approved" record. Every actual VIEW of a comparison — view_snapshot here, open_comparison (employer-api.ts,
//      org accounts), enter/open (employer-comparison/index.ts, guests) — calls assembleSnapshot() fresh, on every open, for
//      as long as the request's existing access window (72h / 7 days / 90 or 30 days / 30 minutes — ALL unchanged by this
//      redesign) allows access at all. A brand-new item added by a later resume resubmission, or any status change on an
//      item that already existed, is visible the next time the employer opens the comparison — not just at approval.
//   4. Scope unchanged: skills, summary, hobbies/other freeform sections, job responsibilities, and contact details are still
//      never part of a Comparison (this redesign is about the verification STATUS of submitted work/education/certification
//      items, not about widening what categories are covered).
// ============================================================================================================================
//
// Deletion rules live in the migration (expire_comparison_requests, purge_candidate_comparisons + the deactivation trigger) —
// unchanged by this redesign; comparison_snapshots is still inserted at approval (gating + history) even though its `content`
// is no longer what a view actually serves.
const REST = { "apikey": SUPABASE_SERVICE_ROLE_KEY, "Authorization": `Bearer ${SUPABASE_SERVICE_ROLE_KEY}` };
const JSON_H = { ...REST, "Content-Type": "application/json" };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SNAPSHOT_DAYS = 7;
const SITE = "https://alpha.applitrust.com";

// ---------------------------------------------------------------------------------------------------
// CALLER AUTHENTICATION: same scheme as every candidate endpoint (candidate-session pass, 2026-09-19).
// ---------------------------------------------------------------------------------------------------
async function sha256Hex(s: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return Array.from(new Uint8Array(d)).map((b) => b.toString(16).padStart(2, "0")).join("");
}
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
function isServiceCaller(req: Request): boolean {
  const h = req.headers.get("authorization") || "";
  const t = h.toLowerCase().startsWith("bearer ") ? h.slice(7).trim() : "";
  return !!t && !!SUPABASE_SERVICE_ROLE_KEY && safeEqual(t, SUPABASE_SERVICE_ROLE_KEY);
}
async function isCandidateSession(body: any, candidateId: string): Promise<boolean> {
  const tok = typeof body?.session_token === "string" ? body.session_token : "";
  if (tok.length < 20 || tok.length > 200 || !candidateId) return false;
  const r = await fetch(`${SUPABASE_URL}/rest/v1/candidate_sessions?token_hash=eq.${await sha256Hex(tok)}&select=candidate_id,expires_at,revoked_at`, { headers: REST });
  const sess = r.ok ? (await r.json())[0] : null;
  return !!sess && !sess.revoked_at && new Date(sess.expires_at).getTime() > Date.now() && sess.candidate_id === candidateId;
}

const rest = (path: string, init: RequestInit = {}) => fetch(`${SUPABASE_URL}/rest/v1/${path}`, { ...init, headers: { ...JSON_H, ...(init.headers || {}) } });
async function rows(path: string): Promise<any[]> {
  const r = await rest(path);
  if (!r.ok) throw new Error(`db ${path.split("?")[0]} ${r.status}`);
  const j = await r.json();
  return Array.isArray(j) ? j : [];
}
const esc = (s: unknown) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });

async function sendEmail(to: string, subject: string, html: string): Promise<boolean> {
  try {
    const r = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${RESEND_API_KEY}` },
      body: JSON.stringify({ from: "Verifi <verify@applitrust.com>", to, subject, html }),
    });
    return r.ok;
  } catch (_e) { return false; }
}

// ---------------------------------------------------------------------------------------------------
// SNAPSHOT ASSEMBLY
// ---------------------------------------------------------------------------------------------------
// Dates keep exactly the precision the source printed (year / year-month / day); a month or day is never invented.
function partialDate(date: unknown, precision: unknown): string | null {
  const m = String(date || "").match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return null;
  const p = precision === "year" || precision === "month" || precision === "day" ? precision : (m[2] === "01" && m[3] === "01" ? "year" : (m[3] === "01" ? "month" : "day"));
  return p === "year" ? m[1] : p === "month" ? `${m[1]}-${m[2]}` : m[0];
}
const dayOf = (iso: unknown) => (typeof iso === "string" && iso.length >= 10 ? iso.slice(0, 10) : null);
const clean = (o: Record<string, unknown>) => { for (const k of Object.keys(o)) if (o[k] === null || o[k] === undefined || o[k] === "") delete o[k]; return o; };

// The five external statuses (2026-09-22 redesign) — see the REDESIGN block above for the full mapping rule and reasoning.
type ExternalStatus = "verified" | "in_progress" | "not_possible" | "unable" | "discrepancy";
function externalStatus(internal: string | null | undefined): ExternalStatus {
  if (!internal) return "not_possible"; // no verification_items row at all — never queued
  if (internal === "Confirmed") return "verified";
  if (internal === "Verification Not Possible") return "not_possible";
  if (internal === "Unable to Verify") return "unable";
  if (internal === "Discrepancy") return "discrepancy";
  return "in_progress"; // New, In Progress, Awaiting Response, Needs Reconciliation
}
// The kind of request is a fact about the CANDIDATE, never something a caller chooses: it is derived from the account type here and in
// create_comparison_request (SQL), and an approval refuses if the two ever disagree.
type Kind = "resume_comparison" | "license_report";
const kindForAccount = (t: unknown): Kind | null => (t === "full_resume" ? "resume_comparison" : t === "license_only" ? "license_report" : null);

// One license on a license report. Fields are a WHITELIST: nothing else from the registry, the queue or staff ever reaches an employer.
type LicenseLine = {
  label: string; state?: string;
  status: "verified" | "not_verified" | "discrepancy";
  check: "registry_live" | "registry_last_check" | "verifi_review" | "none";
  checked_on?: string;          // date of the check the status rests on
  license_type?: string;        // the registry's own type text, only when an exact-name record matched
  expiry?: string;              // the registry's expiry (ISO date), only when an exact-name record matched
  license_number?: string;      // ONLY when verified
  reason?: string;              // one of LICENSE_REPORT_REASON, only when not verified
};
type Assembled = { kind: Kind; content: any; licenses: LicenseLine[]; counts: Record<string, any> };

// The ONLY sentences an employer can ever see about WHY a license did not clear. Keyed by license_items.verification_reason; anything
// not listed gets the generic sentence. Deliberately says nothing about name changes, lookup failures, the registry's own status text,
// or who the registry says the license belongs to.
const LICENSE_REASON: Record<string, string> = {
  no_exact_name_match: "The state registry record for this license number is under a different name than the one on this account.",
  exact_match_not_active: "Found in the state registry, but not currently active.",
  // a license a periodic re-check found no longer active after it had been verified (2026-09-21): a different finding from one that never was
  lapsed_since_verified: "Previously verified; the state registry now lists this license as not currently active.",
  no_records: "No record was found in the state registry for this license number.",
};
const LICENSE_REASON_GENERIC = "The automatic check could not confirm this license.";

// LICENSE REPORT reasons: the resume-comparison sentences above plus the ones a report needs because it lists EVERY license, including ones no
// check ran on. Still a closed set; never the registry's text, never a name change, never who a mismatched record belongs to.
const LICENSE_REPORT_REASON: Record<string, string> = {
  ...LICENSE_REASON,
  generic: LICENSE_REASON_GENERIC,
  no_registry_for_state: "No registry check is available for this state.",
  not_checked: "This license has not been checked.",
  under_review: "This license is under review and has not been verified.",
};
function reportReasonKey(outcome: unknown, reason: unknown): string {
  if (outcome === "unsupported_jurisdiction") return "no_registry_for_state";
  if (!outcome || outcome === "incomplete") return "not_checked";
  if (outcome === "not_found") return "no_records";
  if (reason === "no_exact_name_match" || reason === "exact_match_not_active" || reason === "lapsed_since_verified") return String(reason);
  if (reason === "lookup_failed" || reason === "recent_name_change") return "under_review";
  return "generic";
}
const REPORT_FRESH_CHECK_CAP = 6; // live registry checks per report; the rest fall back to their last stored check

const emptyAssembled = (kind: Kind): Assembled => ({
  kind, content: null, licenses: [],
  counts: kind === "license_report"
    ? { summary: { total: 0, verified: 0, not_verified: 0, discrepancy: 0 }, verified_total: 0, not_cleared_total: 0 }
    : { work: emptyStatusCounts(), education: emptyStatusCounts(), certifications: emptyStatusCounts(), total: 0, verified_total: 0 },
});
const emptyStatusCounts = () => ({ total: 0, verified: 0, in_progress: 0, not_possible: 0, unable: 0, discrepancy: 0 });

// The ONE entry point. What is assembled depends only on the candidate's account type; `opts.fresh` (license reports) asks the registry again.
async function assembleSnapshot(candidateId: string, opts: { fresh?: boolean; maxAge?: number } = {}): Promise<Assembled> {
  const cand = (await rows(`candidates?id=eq.${candidateId}&select=account_type,deletion_scheduled_at`))[0];
  const kind = cand ? kindForAccount(cand.account_type) : null;
  if (!cand || !kind || cand.deletion_scheduled_at) return emptyAssembled("resume_comparison");
  return kind === "license_report" ? await assembleLicenseReport(candidateId, opts) : await assembleResumeSnapshot(candidateId);
}

// REDESIGNED 2026-09-22 (see the REDESIGN header block above for the full rule): every candidate_confirmed work/education/
// certification item on a confirmed document, always, each carrying exactly one of the five external statuses
// (externalStatus() above). Called fresh on every actual view (see view_snapshot/open_comparison/enter below), not just once
// at approval, so a later resubmission's new items and any status change are both visible without a new request.
async function assembleResumeSnapshot(candidateId: string): Promise<Assembled> {
  const cand = (await rows(`candidates?id=eq.${candidateId}&select=id,first_name,last_name,account_type,deletion_scheduled_at`))[0];
  const emptyResult = (): Assembled => emptyAssembled("resume_comparison");
  if (!cand || cand.account_type !== "full_resume" || cand.deletion_scheduled_at) return emptyResult();

  // Only rows on a document the candidate has confirmed.
  const docs = await rows(`resume_documents?candidate_id=eq.${candidateId}&confirmed_at=not.is.null&select=id`);
  const docList = docs.map((d) => d.id).join(",");
  const base = `candidate_id=eq.${candidateId}&candidate_confirmed=eq.true&resume_document_id=in.(${docList})`; // only used when docList is non-empty
  const [work, edu, certs, vis, lics] = await Promise.all([
    docList ? rows(`work_history_items?${base}&select=id,company,title,location,start_date,start_date_precision,end_date,end_date_precision,position&order=position.asc`) : Promise.resolve([]),
    docList ? rows(`education_items?${base}&select=id,institution,degree,field_of_study,location,start_date,start_date_precision,end_date,end_date_precision,position&order=position.asc`) : Promise.resolve([]),
    docList ? rows(`certification_items?${base}&select=id,name,issuing_body,license_number,issue_date,issue_date_precision,position&order=position.asc`) : Promise.resolve([]),
    // EVERY queue row for these four types, any status — the old version only ever fetched a status subset (Confirmed, or
    // the bounded not-cleared set); this one needs all of them to place every item into one of the five external buckets.
    rows(`verification_items?candidate_id=eq.${candidateId}&type=in.(Job%20Experience,Education,Certification,License)&select=id,type,source_item_id,status,claim,found_value,status_changed_at`),
    rows(`license_items?candidate_id=eq.${candidateId}&select=id,linked_certification_id,state,queue_item_id,verified_at,verification_outcome`),
  ]);
  const bySource = (type: string) => new Map(vis.filter((v) => v.type === type && v.source_item_id).map((v) => [v.source_item_id as string, v]));
  const jobV = bySource("Job Experience");
  const eduV = bySource("Education");
  const certV = bySource("Certification");
  const licenseQueueV = new Map(vis.filter((v) => v.type === "License").map((v) => [v.id as string, v]));
  const licByCert = new Map(lics.filter((l) => l.linked_certification_id).map((l) => [l.linked_certification_id as string, l]));

  // One shared shape for every item's verification block, regardless of category — status is always present; claimed/found
  // only for discrepancy (never blank the word "Discrepancy" alone), verified_on only for verified.
  const verificationBlock = (v: { status?: string; claim?: string; found_value?: string; status_changed_at?: string } | null | undefined, method: string) => {
    const status = externalStatus(v?.status);
    return clean({
      status,
      method: status === "verified" ? method : undefined,
      verified_on: status === "verified" ? dayOf(v?.status_changed_at) : undefined,
      claimed: status === "discrepancy" ? (v?.claim || undefined) : undefined,
      found: status === "discrepancy" ? (v?.found_value || undefined) : undefined,
    });
  };
  const tally = (counts: ReturnType<typeof emptyStatusCounts>, status: ExternalStatus) => {
    counts.total++;
    if (status === "verified") counts.verified++;
    else if (status === "in_progress") counts.in_progress++;
    else if (status === "not_possible") counts.not_possible++;
    else if (status === "unable") counts.unable++;
    else counts.discrepancy++;
  };

  const workCounts = emptyStatusCounts();
  const workOut = work.map((w) => {
    const v = jobV.get(w.id);
    const vb = verificationBlock(v, "verifi_review");
    tally(workCounts, vb.status);
    return clean({
      employer: w.company, title: w.title, location: w.location,
      start: partialDate(w.start_date, w.start_date_precision),
      end: w.end_date_precision === "present" ? null : partialDate(w.end_date, w.end_date_precision),
      current: w.end_date_precision === "present" ? true : null,
      verification: vb,
    });
  });
  const eduCounts = emptyStatusCounts();
  const eduOut = edu.map((e) => {
    const v = eduV.get(e.id);
    const vb = verificationBlock(v, "verifi_review");
    tally(eduCounts, vb.status);
    return clean({
      institution: e.institution, degree: e.degree, field_of_study: e.field_of_study, location: e.location,
      start: partialDate(e.start_date, e.start_date_precision), end: partialDate(e.end_date, e.end_date_precision),
      verification: vb,
    });
  });
  const certCounts = emptyStatusCounts();
  const certOut = certs.map((c) => {
    const own = certV.get(c.id);
    const lic = licByCert.get(c.id);
    const licQ = lic && lic.queue_item_id ? licenseQueueV.get(lic.queue_item_id) : null;
    // A license-linked certification's own queue row (if any) is never used when the license's row exists — same
    // precedence as before this redesign, just extended to "always show" instead of "skip when neither exists".
    const effective = licQ || own || null;
    const method = licQ ? (lic!.verification_outcome === "verified" ? "state_registry" : "verifi_review") : "verifi_review";
    const vb = verificationBlock(effective, method);
    if (licQ && vb.status === "verified") vb.verified_on = dayOf(lic!.verified_at) || vb.verified_on;
    tally(certCounts, vb.status);
    return clean({
      name: c.name, issuer: c.issuing_body, license_number: c.license_number, license_state: lic ? lic.state : null,
      issued: partialDate(c.issue_date, c.issue_date_precision),
      verification: vb,
    });
  });

  const counts = {
    work: workCounts, education: eduCounts, certifications: certCounts,
    total: workCounts.total + eduCounts.total + certCounts.total,
    verified_total: workCounts.verified + eduCounts.verified + certCounts.verified,
  };
  const name = [cand.first_name, cand.last_name].filter(Boolean).join(" ");
  return {
    kind: "resume_comparison",
    counts,
    licenses: [],
    content: {
      version: 3,
      kind: "resume_comparison",
      assembled_at: new Date().toISOString(),
      candidate: { name },
      basis: "Every job, education entry and certification the candidate has submitted is shown, in its current state, with exactly one status: Verified (Verifi confirmed it); In progress (still being checked); Verification not possible (no viable way to check it existed); Unable to verify (a check was attempted but came back inconclusive); or Discrepancy (a conclusive, conflicting answer came back — shown with both the claimed and the found value). This is the record as of the moment this was opened, not a fixed-in-time snapshot.",
      coverage: { work: counts.work, education: counts.education, certifications: counts.certifications },
      work: workOut, education: eduOut, certifications: certOut,
    },
  };
}

// ---------------------------------------------------------------------------------------------------
// LICENSE REPORT (kind 'license_report', license-only accounts; 2026-09-20). One line per license the account holds; nothing else.
//   status
//     verified      a registry pass (license_items.verification_outcome 'verified' AND a Confirmed License queue row), or a Confirmed queue row
//                   that staff confirmed by hand.
//     discrepancy   the License queue row is at Discrepancy (a human determination).
//     not_verified  everything else, always with one fixed reason sentence (LICENSE_REPORT_REASON), including a license no check could be run
//                   on (unsupported state, incomplete details, not yet checked).
//   FRESHNESS: a registry pass is re-checked live when the candidate approves (opts.fresh). The live result can only DOWNGRADE (verified -> not
//   verified, e.g. the license has since lapsed); it can never upgrade a license that is not verified, so it cannot get around the name-change
//   hold or a staff determination. If the live check cannot be made (registry down, timeout), the line falls back to the last stored check and
//   says so (check: registry_last_check, with that check's date).
//   WHAT AN EMPLOYER CAN SEE per license: label (account's license name + state), state, status, how it was checked, the check date, the fixed
//   reason if not verified, and -- only when an exact-name registry record matched -- the registry's type and expiry. The license NUMBER is shown only
//   for a verified license. Never: registry status text, the registry's holder names, other people's records, staff notes, reason codes.
// ---------------------------------------------------------------------------------------------------
async function freshLicenseCheck(candidateId: string, licenseId: string, maxAge: number): Promise<any | null> {
  try {
    const r = await fetch(`${SUPABASE_URL}/functions/v1/verify-license`, {
      method: "POST", headers: JSON_H,
      body: JSON.stringify({ action: "status_report", candidate_id: candidateId, license_item_id: licenseId, max_age_seconds: maxAge }),
      signal: AbortSignal.timeout(55_000),
    });
    const j = await r.json().catch(() => null);
    return j && j.ok === true ? j : null; // null = the live check could not be made
  } catch (_e) { return null; }
}

async function assembleLicenseReport(candidateId: string, opts: { fresh?: boolean; maxAge?: number }): Promise<Assembled> {
  const cand = (await rows(`candidates?id=eq.${candidateId}&select=id,first_name,last_name,account_type,deletion_scheduled_at`))[0];
  if (!cand || cand.account_type !== "license_only" || cand.deletion_scheduled_at) return emptyAssembled("license_report");
  const [lics, certs, queue] = await Promise.all([
    rows(`license_items?candidate_id=eq.${candidateId}&select=id,linked_certification_id,state,queue_item_id,verified_at,verification_outcome,verification_reason,verification_detail,verification_attempted_at&order=created_at.asc`),
    rows(`certification_items?candidate_id=eq.${candidateId}&select=id,name,license_number`),
    rows(`verification_items?candidate_id=eq.${candidateId}&type=eq.License&select=id,status,status_changed_at`),
  ]);
  const certById = new Map(certs.map((c: any) => [c.id as string, c]));
  const queueById = new Map(queue.map((q: any) => [q.id as string, q]));
  const items = lics.filter((l: any) => l.linked_certification_id && certById.has(l.linked_certification_id));
  const isRegistryPass = (l: any) => l.verification_outcome === "verified" && (queueById.get(l.queue_item_id) as any)?.status === "Confirmed";

  const freshById = new Map<string, any>();
  if (opts.fresh) {
    await Promise.all(items.filter(isRegistryPass).slice(0, REPORT_FRESH_CHECK_CAP).map(async (l: any) => { freshById.set(l.id, await freshLicenseCheck(candidateId, l.id, opts.maxAge ?? 0)); }));
  }

  const pick = (m: any) => ({ license_type: m && m.licenseType ? String(m.licenseType) : undefined, expiry: m && m.expiration ? String(m.expiration) : undefined });
  const lines: LicenseLine[] = [];
  for (const l of items as any[]) {
    const c: any = certById.get(l.linked_certification_id);
    const q: any = queueById.get(l.queue_item_id);
    const base = String(c.name || "License").trim();
    const label = `${/licen[sc]e/i.test(base) ? base : base + " license"}`;
    const common = { label: l.state ? `${label} (${l.state})` : label, state: l.state || undefined };
    const stored = l.verification_detail?.matched_record || null; // only present when an exact-name record matched
    let line: LicenseLine;
    if (isRegistryPass(l)) {
      const f = freshById.get(l.id);
      if (f && f.ok) {
        line = f.outcome === "verified"
          ? { ...common, status: "verified", check: "registry_live", checked_on: dayOf(f.checked_at) || undefined, ...pick(f.matched), license_number: c.license_number || undefined }
          : { ...common, status: "not_verified", check: "registry_live", checked_on: dayOf(f.checked_at) || undefined, ...pick(f.matched), reason: LICENSE_REPORT_REASON[reportReasonKey(f.outcome, f.reason)] };
      } else {
        // no live result (not asked for, or the registry could not be reached): the last stored check, labeled as such
        line = { ...common, status: "verified", check: "registry_last_check", checked_on: dayOf(l.verified_at) || dayOf(q?.status_changed_at) || undefined, ...pick(stored), license_number: c.license_number || undefined };
      }
    } else if (q && q.status === "Confirmed") {
      line = { ...common, status: "verified", check: "verifi_review", checked_on: dayOf(q.status_changed_at) || undefined, license_number: c.license_number || undefined };
    } else {
      const checked = !!l.verification_outcome && l.verification_outcome !== "unsupported_jurisdiction";
      line = {
        ...common, status: q && q.status === "Discrepancy" ? "discrepancy" : "not_verified",
        check: checked ? "registry_last_check" : "none", checked_on: checked ? dayOf(l.verification_attempted_at) || undefined : undefined,
        ...pick(stored), reason: LICENSE_REPORT_REASON[reportReasonKey(l.verification_outcome, l.verification_reason)],
      };
    }
    lines.push(clean(line as any) as LicenseLine);
  }

  const verified = lines.filter((x) => x.status === "verified").length;
  const discrepancy = lines.filter((x) => x.status === "discrepancy").length;
  // counts.summary (NOT counts.licenses): wouldShare() spreads counts next to the `licenses` line list, and a same-named key used to be overwritten by it
  const counts = { summary: { total: lines.length, verified, not_verified: lines.length - verified - discrepancy, discrepancy }, verified_total: verified, not_cleared_total: lines.length - verified };
  const name = [cand.first_name, cand.last_name].filter(Boolean).join(" ");
  return {
    kind: "license_report", counts, licenses: lines,
    content: {
      version: 1, kind: "license_report", assembled_at: new Date().toISOString(), candidate: { name },
      basis: "Every license on the candidate's account is listed with its status. Verified means Verifi checked it against the issuing state's registry, or Verifi staff confirmed it. Anything else says why it is not verified. Each license shows the date of the check its status rests on. This is the record as of the assembly time above.",
      coverage: { licenses: { total: lines.length, verified } },
      licenses: lines,
    },
  };
}

// What the candidate is shown before deciding, and gets back after approving: by kind. For a license report these ARE the lines an employer will
// see (the number of a verified license included); "stored" means built from the last stored checks only, "live" means re-checked against the registry.
// For a resume comparison this is now (2026-09-22) the exact same always-every-item content an employer's own view uses — no separate
// "not cleared" summary shape, since nothing is held back from either audience any more.
const wouldShare = (a: Assembled, preview: "stored" | "live") => a.kind === "license_report"
  ? { kind: a.kind, preview, ...a.counts, licenses: a.licenses }
  : { kind: a.kind, ...a.counts, work: a.content?.work || [], education: a.content?.education || [], certifications: a.content?.certifications || [] };

// ---------------------------------------------------------------------------------------------------
// EMAIL. Everything an employer typed (name, company, email, source) is escaped before it goes into HTML.
// ---------------------------------------------------------------------------------------------------
async function notifyCandidate(requestId: string): Promise<{ sent: boolean; reason?: string }> {
  const r = (await rows(`comparison_requests?id=eq.${requestId}&select=id,candidate_id,requester_name,requester_company,requester_email,attestation,expires_at,status,candidate_notified_at,kind`))[0];
  if (!r) return { sent: false, reason: "not_found" };
  if (r.status !== "pending") return { sent: false, reason: "not_pending" };
  const c = (await rows(`candidates?id=eq.${r.candidate_id}&select=email,first_name`))[0];
  if (!c) return { sent: false, reason: "no_candidate" };
  // Claim first, so two callers can never both send.
  const claim = await rest(`comparison_requests?id=eq.${requestId}&candidate_notified_at=is.null`, { method: "PATCH", headers: { "Prefer": "return=representation" }, body: JSON.stringify({ candidate_notified_at: new Date().toISOString() }) });
  const claimed = claim.ok ? await claim.json() : [];
  if (!Array.isArray(claimed) || claimed.length === 0) return { sent: false, reason: "already_sent" };
  // Deliberately content-free (2026-09-20): an email preview can show up on a lock screen or a watch, so nothing about who is asking, what
  // they say, or what they sent is in the subject or the body. Everything is behind the sign-in.
  const ok = await sendEmail(
    c.email,
    "A request is waiting on Verifi",
    `<p>A request is waiting for your response on Verifi.</p><p>For your privacy the details are not in this email. Sign in and open the Activity tab to see who is asking, how they say they got your information, the document they sent, and exactly what would be shared, then approve or decline. It is best reviewed on a computer.</p><p><a href="${SITE}/candidate.html">Sign in to view the request</a></p><p>The request closes automatically at ${esc(new Date(r.expires_at).toUTCString())} if you do nothing. Nothing is shared unless you approve.</p>`,
  );
  if (!ok) {
    await rest(`comparison_requests?id=eq.${requestId}`, { method: "PATCH", headers: { "Prefer": "return=minimal" }, body: JSON.stringify({ candidate_notified_at: null }) });
    return { sent: false, reason: "email_failed" };
  }
  return { sent: true };
}

// The employer is told the SAME thing whether the candidate declined, the request timed out, or the candidate deactivated: not authorized.
async function noticeRequesterNotAuthorized(requestId: string): Promise<boolean> {
  const r = (await rows(`comparison_requests?id=eq.${requestId}&select=id,requester_email,requester_name,status,approved_at,requester_notified_at`))[0];
  if (!r || !["declined", "expired"].includes(r.status) || r.approved_at || r.requester_notified_at) return false;
  const claim = await rest(`comparison_requests?id=eq.${requestId}&requester_notified_at=is.null`, { method: "PATCH", headers: { "Prefer": "return=representation" }, body: JSON.stringify({ requester_notified_at: new Date().toISOString() }) });
  const claimed = claim.ok ? await claim.json() : [];
  if (!Array.isArray(claimed) || claimed.length === 0) return false;
  const ok = await sendEmail(
    r.requester_email,
    "Your Verifi comparison request was not authorized",
    `<p>Hi ${esc(r.requester_name || "there")},</p><p>Your request to compare a candidate's record was <b>not authorized</b>, so no comparison is available and nothing was charged. That outcome reflects the candidate's own choice, which we do not control or influence, and we cannot share anything further about it.</p>`,
  );
  if (!ok) await rest(`comparison_requests?id=eq.${requestId}`, { method: "PATCH", headers: { "Prefer": "return=minimal" }, body: JSON.stringify({ requester_notified_at: null }) });
  return ok;
}

// GUEST approval (Stage 3): the requester has no account, so the approval email carries a link with a random token; only the token's HASH
// is stored on the request. The token is minted HERE, at send time, and only for a request whose link has never been sent, so a failed send
// is simply retried by the sweep with a fresh token (nothing is lost, and a link that already went out is never invalidated).
async function sendGuestLink(requestId: string): Promise<boolean> {
  const r = (await rows(`comparison_requests?id=eq.${requestId}&select=id,access_method,status,requester_email,requester_name,first_delivered_at,guest_link_sent_at,snapshot_expires_at,kind`))[0];
  if (!r || r.access_method !== "guest" || r.status !== "approved" || r.first_delivered_at || r.guest_link_sent_at) return false;
  const token = Array.from(crypto.getRandomValues(new Uint8Array(32))).map((b) => b.toString(16).padStart(2, "0")).join("");
  const claim = await rest(`comparison_requests?id=eq.${requestId}&guest_link_sent_at=is.null&status=eq.approved`, {
    method: "PATCH", headers: { "Prefer": "return=representation" },
    body: JSON.stringify({ guest_link_sent_at: new Date().toISOString(), guest_token_hash: await sha256Hex(token) }),
  });
  const claimed = claim.ok ? await claim.json() : [];
  if (!Array.isArray(claimed) || claimed.length === 0) return false;
  const price = (await rows("employer_pricing?key=eq.guest_comparison&select=amount_cents,currency"))[0];
  const money = price ? new Intl.NumberFormat("en-US", { style: "currency", currency: String(price.currency || "usd").toUpperCase() }).format(price.amount_cents / 100) : "a one-time fee";
  const lr = r.kind === "license_report";
  const ok = await sendEmail(
    r.requester_email,
    lr ? "Your Verifi license status request was approved" : "Your Verifi comparison request was approved",
    `<p>Hi ${esc(r.requester_name || "there")},</p><p>The candidate approved your request. ${lr ? "What they shared is a license status report: each license on their account and whether it is verified." : "What they shared is a comparison of their verified record with your copy."}</p><p><a href="${SITE}/employer.html?comparison=${token}">${lr ? "Open your license status report" : "Open your comparison"}</a></p><p>This is a <b>one-time view</b>. Opening the link starts by placing a hold of ${esc(money)} on your card, on Stripe's own page &mdash; <b>this does not charge you yet</b>. The <b>real charge only happens the moment you are actually shown the result</b>: if that is right when you pay, it opens by itself at that moment; if you leave and come back to this same link later instead, it opens (and you are charged) then, not before. Once it opens you can read it for 30 minutes, so have your own copy ready. After that it is gone and cannot be reopened, by you or by us. If you never come back to pay at all, nothing is ever placed on your card. If you place the hold but never return to this link, the hold simply expires on its own within about a week and <b>you are never charged</b>. There is no account: this link is the only way in, so keep this email. The link works until ${esc(new Date(r.snapshot_expires_at).toUTCString())} if you do not pay.</p>`,
  );
  if (!ok) await rest(`comparison_requests?id=eq.${requestId}`, { method: "PATCH", headers: { "Prefer": "return=minimal" }, body: JSON.stringify({ guest_link_sent_at: null, guest_token_hash: null }) });
  return ok;
}

async function noticeRequesterApproved(requestId: string): Promise<boolean> {
  const r = (await rows(`comparison_requests?id=eq.${requestId}&select=requester_email,requester_name,access_method,snapshot_expires_at,kind`))[0];
  if (r && r.access_method === "guest") return await sendGuestLink(requestId);
  if (!r || r.access_method !== "org") return false;
  const lr = r.kind === "license_report";
  return await sendEmail(
    r.requester_email,
    lr ? "Your Verifi license status request was approved" : "Your Verifi comparison request was approved",
    `<p>Hi ${esc(r.requester_name || "there")},</p><p>The candidate approved your request${lr ? ": what they shared is a license status report (each license on their account and whether it is verified)" : ""}. <a href="${SITE}/employer.html">Sign in to your Verifi employer account</a> to open it. It stays available until ${esc(new Date(r.snapshot_expires_at).toUTCString())}; opening it uses one lookup from your organization's plan.</p>`,
  );
}

// ---------------------------------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------------------------------
export default {
  fetch: withSupabase({ auth: "none" }, async (req, _ctx) => {
    if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
    try {
      let body: any = {};
      try { body = await req.json(); } catch (_e) { body = {}; }
      const action = typeof body.action === "string" ? body.action : "";
      const UNAUTHORIZED = () => json({ ok: false, error: "unauthorized" }, 401);

      // ---- internal ----
      if (action === "sweep") {
        const given = req.headers.get("x-comparison-secret") || "";
        const secret = (await rows("internal_job_secrets?name=eq.comparison_sweep&select=value"))[0]?.value || "";
        if (!given || !secret || !safeEqual(given, secret)) return UNAUTHORIZED();
        const exp = await (await fetch(`${SUPABASE_URL}/rest/v1/rpc/expire_comparison_requests`, { method: "POST", headers: JSON_H, body: "{}" })).json();
        // final "not authorized" notices not yet sent (declined by the candidate, timed out, or closed by deactivation)
        const owed = await rows("comparison_requests?status=in.(declined,expired)&approved_at=is.null&requester_notified_at=is.null&select=id&order=created_at.asc&limit=50");
        let noticed = 0;
        for (const o of owed) if (await noticeRequesterNotAuthorized(o.id)) noticed++;
        // "you have a request" emails that failed at creation: retry the ones still pending after 10 minutes
        const cutoff = new Date(Date.now() - 10 * 60 * 1000).toISOString();
        const unnotified = await rows(`comparison_requests?status=eq.pending&candidate_notified_at=is.null&created_at=lt.${encodeURIComponent(cutoff)}&select=id&limit=20`);
        let renotified = 0;
        for (const u of unnotified) if ((await notifyCandidate(u.id)).sent) renotified++;
        // approval links for guests that never went out
        const unlinked = await rows("comparison_requests?status=eq.approved&access_method=eq.guest&guest_link_sent_at=is.null&first_delivered_at=is.null&select=id&limit=20");
        let relinked = 0;
        for (const u of unlinked) if (await sendGuestLink(u.id)) relinked++;
        return json({ ok: true, expired: exp, requester_notices_sent: noticed, candidate_notices_retried: renotified, guest_links_sent: relinked });
      }
      if (action === "notify_candidate") {
        if (!isServiceCaller(req)) return UNAUTHORIZED();
        if (typeof body.request_id !== "string" || !UUID.test(body.request_id)) return json({ ok: false, error: "request_id_invalid" }, 400);
        return json({ ok: true, ...(await notifyCandidate(body.request_id)) });
      }
      // assemble_live (2026-09-22 redesign): the ONE place employer-api.ts (org accounts) and employer-comparison/index.ts
      // (guests) reach to get what a comparison currently shares — assembleSnapshot stays defined in exactly one file (this
      // one, "the ONLY code that decides this", per the header above); those two never duplicate the assembly rule, they
      // just call it. Service-role bearer only: the CALLER (employer-api.ts / employer-comparison/index.ts) is what already
      // verifies the request is approved, owned by the right org/guest token, and inside its access window — this action
      // trusts that check happened and only ever runs after it, exactly like every other internal-only action here.
      if (action === "assemble_live") {
        if (!isServiceCaller(req)) return UNAUTHORIZED();
        if (typeof body.candidate_id !== "string" || !UUID.test(body.candidate_id)) return json({ ok: false, error: "candidate_id_invalid" }, 400);
        const live = await assembleSnapshot(body.candidate_id);
        if (!live.content) return json({ ok: false, error: "unavailable" }, 409);
        return json({ ok: true, content: live.content, assembled_at: live.content.assembled_at });
      }

      // ---- candidate-session actions ----
      const candidateId = typeof body.candidate_id === "string" ? body.candidate_id : "";
      if (!(await isCandidateSession(body, candidateId))) return UNAUTHORIZED();
      const nowIso = () => new Date().toISOString();

      if (action === "list") {
        const [reqs, snaps, tier1, share] = await Promise.all([
          rows(`comparison_requests?candidate_id=eq.${candidateId}&select=id,requester_email,requester_name,requester_company,requester_domain_type,attestation,status,created_at,expires_at,responded_at,approved_at,first_delivered_at,snapshot_expires_at,kind,access_method,document_required&order=created_at.desc&limit=100`),
          rows(`comparison_snapshots?candidate_id=eq.${candidateId}&select=request_id`),
          rows(`employer_lookup_requests?matched_candidate_id=eq.${candidateId}&result_exists=eq.true&select=id,requester_email,requester_company,used_at&order=used_at.desc&limit=100`),
          assembleSnapshot(candidateId),
        ]);
        const hasSnap = new Set(snaps.map((s) => s.request_id));
        // The employer's document for each request: only what the candidate needs to decide whether to open it. The file itself is reached
        // only through action "document_link".
        const docs = reqs.length ? await rows(`comparison_request_documents?request_id=in.(${reqs.map((r) => r.id).join(",")})&select=request_id,file_name,content_type,byte_size,purge_after`) : [];
        const docByRequest = new Map(docs.filter((d) => new Date(d.purge_after).getTime() > Date.now()).map((d) => [d.request_id, d]));
        const now = Date.now();
        const shaped = reqs.map((r) => {
          // a pending request past its window is closed even if the sweep has not run yet
          const status = r.status === "pending" && new Date(r.expires_at).getTime() < now ? "expired" : r.status;
          return {
            id: r.id, kind: r.kind, access_method: r.access_method, status, created_at: r.created_at, expires_at: r.expires_at, responded_at: r.responded_at, approved_at: r.approved_at,
            delivered: !!r.first_delivered_at, first_delivered_at: r.first_delivered_at, snapshot_available: hasSnap.has(r.id), snapshot_expires_at: r.snapshot_expires_at,
            requester: { name: r.requester_name, company: r.requester_company, email: r.requester_email, domain: String(r.requester_email).split("@")[1] || "", domain_type: r.requester_domain_type },
            attestation: r.attestation,
            // 'available' now; 'deleted' = the 21 days ended (or the account was deactivated); 'none' = a request from before documents were required
            document_state: docByRequest.has(r.id) ? "available" : (r.document_required ? "deleted" : "none"),
            document: docByRequest.has(r.id) ? { file_name: docByRequest.get(r.id).file_name, content_type: docByRequest.get(r.id).content_type, byte_size: docByRequest.get(r.id).byte_size, available_until: docByRequest.get(r.id).purge_after } : null,
          };
        });
        return json({
          ok: true,
          pending: shaped.filter((r) => r.status === "pending"),
          history: shaped.filter((r) => r.status !== "pending"),
          tier1: tier1.map((t) => ({ id: t.id, domain: String(t.requester_email).split("@")[1] || "", company: t.requester_company, date: t.used_at })),
          would_share: wouldShare(share, "stored"),
        });
      }

      // A 60-second signed link to the employer's document for one of THIS candidate's requests. The file is served unmodified by Storage from a
      // private bucket; nothing else can reach it. Someone else's request is indistinguishable from one that does not exist.
      if (action === "document_link") {
        if (typeof body.request_id !== "string" || !UUID.test(body.request_id)) return json({ ok: false, error: "request_id_invalid" }, 400);
        const own = (await rows(`comparison_requests?id=eq.${body.request_id}&candidate_id=eq.${candidateId}&select=id`))[0];
        if (!own) return json({ ok: false, error: "not_found" }, 404);
        const d = (await rows(`comparison_request_documents?request_id=eq.${own.id}&select=storage_path,file_name,content_type,purge_after`))[0];
        if (!d || new Date(d.purge_after).getTime() <= Date.now() || !/^[0-9a-f-]{36}\.(pdf|png|jpg)$/.test(d.storage_path)) return json({ ok: false, error: "document_unavailable" }, 404);
        const sres = await fetch(`${SUPABASE_URL}/storage/v1/object/sign/employer-documents/${d.storage_path}`, { method: "POST", headers: JSON_H, body: JSON.stringify({ expiresIn: 60 }) });
        const sj = sres.ok ? await sres.json().catch(() => null) : null;
        if (!sj || typeof sj.signedURL !== "string") return json({ ok: false, error: "link_failed" }, 502);
        return json({ ok: true, url: `${SUPABASE_URL}/storage/v1${sj.signedURL}`, expires_in: 60, file_name: d.file_name, content_type: d.content_type });
      }

      // What an approval would share RIGHT NOW, with a live registry check for a license report (cached for 10 minutes so a preview followed by an
      // approval agrees and the registry is not asked repeatedly).
      if (action === "preview") {
        const share = await assembleSnapshot(candidateId, { fresh: true, maxAge: 600 });
        if (!share.content) return json({ ok: false, error: "unavailable" }, 409);
        return json({ ok: true, would_share: wouldShare(share, "live") });
      }

      if (action === "respond") {
        if (typeof body.request_id !== "string" || !UUID.test(body.request_id)) return json({ ok: false, error: "request_id_invalid" }, 400);
        if (body.decision !== "approve" && body.decision !== "decline") return json({ ok: false, error: "decision_invalid" }, 400);
        // scoped to THIS candidate: someone else's request is indistinguishable from one that does not exist
        const r = (await rows(`comparison_requests?id=eq.${body.request_id}&candidate_id=eq.${candidateId}&select=id,status,expires_at,access_method,kind`))[0];
        if (!r) return json({ ok: false, error: "not_found" }, 404);
        if (r.status !== "pending") return json({ ok: false, error: "not_pending" }, 409);
        if (new Date(r.expires_at).getTime() <= Date.now()) return json({ ok: false, error: "expired" }, 409);
        const stillOpen = `id=eq.${r.id}&status=eq.pending&expires_at=gt.${encodeURIComponent(nowIso())}`;

        if (body.decision === "decline") {
          const p = await rest(`comparison_requests?${stillOpen}`, { method: "PATCH", headers: { "Prefer": "return=representation" }, body: JSON.stringify({ status: "declined", responded_at: nowIso() }) });
          const changed = p.ok ? await p.json() : [];
          if (!Array.isArray(changed) || changed.length === 0) return json({ ok: false, error: "not_pending" }, 409);
          const notified = await noticeRequesterNotAuthorized(r.id); // the sweep retries this if it fails
          return json({ ok: true, status: "declined", employer_notified: notified });
        }

        // approve: assemble FIRST (nothing exists before this point), refuse an empty snapshot, store it, then flip the request atomically.
        // A license report is re-checked live HERE (maxAge 0: at approval time, up to the 30 s registry floor). The kind is re-derived from the
        // candidate's account type and must equal the request's own: if they ever disagree (account changed, row altered) nothing is shared.
        const snap = await assembleSnapshot(candidateId, { fresh: true, maxAge: 0 });
        if (!snap.content || snap.kind !== r.kind) return json({ ok: false, error: "unavailable" }, 409);
        // "Nothing to share" (2026-09-22 redesign): since every item now shows regardless of status, this can only mean the candidate has
        // literally no work/education/certification items (or no licenses) at all — not "nothing verified yet", which used to be the bar.
        const nothing = snap.kind === "license_report" ? snap.counts.summary.total === 0 : snap.counts.total === 0;
        if (nothing) return json({ ok: false, error: "nothing_to_share", would_share: wouldShare(snap, "live") }, 409);
        // comparison_snapshots is still written here (unchanged) as the approval GATE and a historical "what was true when
        // approved" record — but no view of this comparison ever reads its `content` back any more (see the REDESIGN header
        // block above and view_snapshot below): every open re-assembles fresh from current data instead.
        const ins = await rest("comparison_snapshots", { method: "POST", headers: { "Prefer": "return=minimal" }, body: JSON.stringify({ request_id: r.id, candidate_id: candidateId, content: snap.content, counts: snap.counts }) });
        if (ins.status === 409) return json({ ok: false, error: "not_pending" }, 409); // a simultaneous approval already stored one
        if (!ins.ok) return json({ ok: false, error: "assemble_failed" }, 500);
        const approvedAt = nowIso();
        const p = await rest(`comparison_requests?${stillOpen}`, {
          method: "PATCH", headers: { "Prefer": "return=representation" },
          body: JSON.stringify({ status: "approved", responded_at: approvedAt, approved_at: approvedAt, snapshot_expires_at: new Date(Date.now() + SNAPSHOT_DAYS * 24 * 60 * 60 * 1000).toISOString() }),
        });
        const changed = p.ok ? await p.json() : [];
        if (!Array.isArray(changed) || changed.length === 0) {
          await rest(`comparison_snapshots?request_id=eq.${r.id}`, { method: "DELETE" }); // lost a race with a decline/expiry: keep nothing
          return json({ ok: false, error: "not_pending" }, 409);
        }
        const notified = await noticeRequesterApproved(r.id);
        return json({ ok: true, status: "approved", shared: wouldShare(snap, "live"), employer_notified: notified });
      }

      if (action === "view_snapshot") {
        if (typeof body.request_id !== "string" || !UUID.test(body.request_id)) return json({ ok: false, error: "request_id_invalid" }, 400);
        const r = (await rows(`comparison_requests?id=eq.${body.request_id}&candidate_id=eq.${candidateId}&status=eq.approved&select=id`))[0];
        if (!r) return json({ ok: false, error: "not_found" }, 404);
        // comparison_snapshots is only checked for EXISTENCE here (the approval gate) — its stored `content` is never read.
        // What a candidate sees when they check "what was shared" is the same live, current content an employer would see
        // opening this request right now, not a frozen record of what was true at approval (2026-09-22 redesign).
        const has = (await rows(`comparison_snapshots?request_id=eq.${r.id}&candidate_id=eq.${candidateId}&select=id`))[0];
        if (!has) return json({ ok: false, error: "not_found" }, 404);
        const live = await assembleSnapshot(candidateId);
        if (!live.content) return json({ ok: false, error: "not_found" }, 404);
        return json({ ok: true, content: live.content, assembled_at: live.content.assembled_at });
      }

      return json({ ok: false, error: "unknown_action" }, 404);
    } catch (_e) {
      return json({ ok: false, error: "request_failed" }, 500);
    }
  }),
};
