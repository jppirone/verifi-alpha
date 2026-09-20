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

// EMPLOYER COMPARISON REQUESTS, CANDIDATE SIDE (2026-09-20, Stage 1). An employer asks (rows are created by the employer-side
// endpoints through create_comparison_request); the candidate, signed in, approves or declines here. NOTHING IS ASSEMBLED OR SHOWN TO
// THE EMPLOYER BEFORE APPROVAL: the snapshot is built inside the approve action and not before. See the migration
// 20260920020000_comparison_requests.sql for the full flow, retention rules and the "verified enough" definition restated below.
//
// Actions (POST {action, ...}). The first three need the candidate's OWN live session (session_token + candidate_id, checked against
// candidate_sessions on every call; every request is also scoped to that candidate, so another candidate's request id is a 404):
//   list           pending requests, history, real Tier 1 lookups that matched this candidate, and how many verified items an approval
//                  would share (counts only, never content)
//   respond        {request_id, decision: "approve" | "decline"}
//   view_snapshot  {request_id}: exactly what an approved request shared
// Internal (never reachable by a candidate or an employer):
//   notify_candidate  {request_id}: the "you have a request" email; service-role bearer only; sent at most once (claimed first)
//   sweep             cron: expire what timed out (expire_comparison_requests), send the undifferentiated "not authorized" emails,
//                     retry candidate notices that never went out; authenticated by the secret in internal_job_secrets
//
// WHAT COUNTS AS "VERIFIED ENOUGH" (assembleSnapshot below is the ONLY code that decides this):
//   An item is included only if ALL of:
//     * the candidate is a full-resume account that is not deactivated;
//     * the item's row is candidate_confirmed = true, on a resume_documents row whose confirmed_at is set;
//     * a verification_items row for this candidate has status = 'Confirmed' AND points at the row via source_item_id, where
//         work_history_items  <- type 'Job Experience'
//         education_items     <- type 'Education'
//         certification_items <- type 'Certification', OR the license_items row linked to the certification has a queue_item_id
//                                whose verification_items row (type 'License') is 'Confirmed'.
//   Excluded, always: statuses New, In Progress, Awaiting Response, Needs Reconciliation, Discrepancy, Unable to Verify; rows of type
//   'Needs Review'; items with no queue row (candidate-stated); job responsibilities (not part of what staff verify); skills, summary,
//   hobbies and other sections; contact details. Non-included items are reported as counts ("confirmed" vs "verified"), so an employer
//   cannot tell "unable to verify" from "still in review" from "not submitted", with ONE bounded exception (2026-09-20, snapshot
//   version 2): an item where a check was actually run and did not clear is also listed by name in content.not_cleared, with a fixed-
//   vocabulary status and, for licenses, a fixed one-sentence reason. That is: a Job / Education / Certification queue row at
//   'Discrepancy' or 'Unable to Verify', or a license whose automatic check came back ambiguous / not found / inactive (queue row
//   'Needs Reconciliation', 'Discrepancy' or 'Unable to Verify'). NEVER listed: rows still New / In Progress / Awaiting Response,
//   'Needs Review' rows, a license whose check could not run (lookup_failed) or was held (recent_name_change), candidate-stated
//   licenses with no check. Never included in a line: staff notes, the registry's own text, license numbers, other people's names.
//   The candidate sees the exact same lines in the approval card BEFORE approving (would_share.not_cleared).
//
// Deletion rules live in the migration (expire_comparison_requests, purge_candidate_comparisons + the deactivation trigger).
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

type NotCleared = { kind: "license" | "job" | "education" | "certification"; label: string; status: "not_verified" | "discrepancy"; reason?: string };
type Assembled = { content: any; notCleared: NotCleared[]; counts: { work: { confirmed: number; verified: number }; education: { confirmed: number; verified: number }; certifications: { confirmed: number; verified: number }; verified_total: number; not_cleared_total: number } };

// The ONLY sentences an employer can ever see about WHY a license did not clear. Keyed by license_items.verification_reason; anything
// not listed gets the generic sentence. Deliberately says nothing about name changes, lookup failures, the registry's own status text,
// or who the registry says the license belongs to.
const LICENSE_REASON: Record<string, string> = {
  no_exact_name_match: "The state registry record for this license number is under a different name than the one on this account.",
  exact_match_not_active: "Found in the state registry, but not currently active.",
  no_records: "No record was found in the state registry for this license number.",
};
const LICENSE_REASON_GENERIC = "The automatic check could not confirm this license.";
// checks that did not run to a result, or a clean result held for review: not "checked and did not clear", so never listed
const LICENSE_NEVER_LISTED_REASONS = new Set(["lookup_failed", "recent_name_change"]);

async function assembleSnapshot(candidateId: string): Promise<Assembled> {
  const empty = { confirmed: 0, verified: 0 };
  const cand = (await rows(`candidates?id=eq.${candidateId}&select=id,first_name,last_name,account_type,deletion_scheduled_at`))[0];
  const emptyResult = (): Assembled => ({
    content: null,
    notCleared: [],
    counts: { work: { ...empty }, education: { ...empty }, certifications: { ...empty }, verified_total: 0, not_cleared_total: 0 },
  });
  if (!cand || cand.account_type !== "full_resume" || cand.deletion_scheduled_at) return emptyResult();

  // Only rows on a document the candidate has confirmed.
  const docs = await rows(`resume_documents?candidate_id=eq.${candidateId}&confirmed_at=not.is.null&select=id`);
  const docList = docs.map((d) => d.id).join(",");
  const base = `candidate_id=eq.${candidateId}&candidate_confirmed=eq.true&resume_document_id=in.(${docList})`; // only used when docList is non-empty
  const [work, edu, certs, vis, lics, notClearedQ] = await Promise.all([
    docList ? rows(`work_history_items?${base}&select=id,company,title,location,start_date,start_date_precision,end_date,end_date_precision,position&order=position.asc`) : Promise.resolve([]),
    docList ? rows(`education_items?${base}&select=id,institution,degree,field_of_study,location,start_date,start_date_precision,end_date,end_date_precision,position&order=position.asc`) : Promise.resolve([]),
    docList ? rows(`certification_items?${base}&select=id,name,issuing_body,license_number,issue_date,issue_date_precision,position&order=position.asc`) : Promise.resolve([]),
    rows(`verification_items?candidate_id=eq.${candidateId}&status=eq.Confirmed&type=in.(Job%20Experience,Education,Certification,License)&select=id,type,source_item_id,status_changed_at`),
    rows(`license_items?candidate_id=eq.${candidateId}&select=id,linked_certification_id,state,queue_item_id,verified_at,verification_outcome,verification_reason`),
    // rows where a check was run and did not clear (see the header: only these can ever become a named line)
    rows(`verification_items?candidate_id=eq.${candidateId}&status=in.(Discrepancy,Unable%20to%20Verify,Needs%20Reconciliation)&type=in.(Job%20Experience,Education,Certification,License)&select=id,type,status,source_item_id`),
  ]);
  const confirmedBySource = (type: string) => new Map(vis.filter((v) => v.type === type && v.source_item_id).map((v) => [v.source_item_id as string, v]));
  const jobV = confirmedBySource("Job Experience");
  const eduV = confirmedBySource("Education");
  const certV = confirmedBySource("Certification");
  const licenseQueueV = new Map(vis.filter((v) => v.type === "License").map((v) => [v.id as string, v]));
  const licByCert = new Map(lics.filter((l) => l.linked_certification_id).map((l) => [l.linked_certification_id as string, l]));

  const workOut: any[] = [];
  for (const w of work) {
    const v = jobV.get(w.id);
    if (!v) continue;
    workOut.push(clean({
      employer: w.company, title: w.title, location: w.location,
      start: partialDate(w.start_date, w.start_date_precision),
      end: w.end_date_precision === "present" ? null : partialDate(w.end_date, w.end_date_precision),
      current: w.end_date_precision === "present" ? true : null,
      verification: clean({ status: "verified", method: "verifi_review", verified_on: dayOf(v.status_changed_at) }),
    }));
  }
  const eduOut: any[] = [];
  for (const e of edu) {
    const v = eduV.get(e.id);
    if (!v) continue;
    eduOut.push(clean({
      institution: e.institution, degree: e.degree, field_of_study: e.field_of_study, location: e.location,
      start: partialDate(e.start_date, e.start_date_precision), end: partialDate(e.end_date, e.end_date_precision),
      verification: clean({ status: "verified", method: "verifi_review", verified_on: dayOf(v.status_changed_at) }),
    }));
  }
  const certOut: any[] = [];
  const verifiedCertIds = new Set<string>();
  for (const c of certs) {
    const own = certV.get(c.id);
    const lic = licByCert.get(c.id);
    const licQ = lic && lic.queue_item_id ? licenseQueueV.get(lic.queue_item_id) : null;
    if (!own && !licQ) continue;
    verifiedCertIds.add(c.id);
    certOut.push(clean({
      name: c.name, issuer: c.issuing_body, license_number: c.license_number, license_state: lic ? lic.state : null,
      issued: partialDate(c.issue_date, c.issue_date_precision),
      // A License queue row is 'Confirmed' either because the state registry matched (license_items.verification_outcome = 'verified')
      // or because staff confirmed it by hand after an ambiguous or failed check. Only the first is a registry verification.
      verification: licQ
        ? clean({ status: "verified", method: lic!.verification_outcome === "verified" ? "state_registry" : "verifi_review", verified_on: dayOf(lic!.verified_at) || dayOf(licQ.status_changed_at) })
        : clean({ status: "verified", method: "verifi_review", verified_on: dayOf(own.status_changed_at) }),
    }));
  }

  // ---- checked and did not clear: named lines (bounded; see the header) ----
  const notCleared: NotCleared[] = [];
  const ncBySource = (type: string) => new Map(notClearedQ.filter((v) => v.type === type && v.source_item_id).map((v) => [v.source_item_id as string, v]));
  const ncById = new Map(notClearedQ.filter((v) => v.type === "License").map((v) => [v.id as string, v]));
  const statusOf = (queueStatus: string): "not_verified" | "discrepancy" => (queueStatus === "Discrepancy" ? "discrepancy" : "not_verified");
  const certById = new Map(certs.map((c) => [c.id as string, c]));
  const licenseCertIds = new Set<string>();
  for (const l of lics) {
    const q = l.queue_item_id ? ncById.get(l.queue_item_id) : null;
    const c = l.linked_certification_id ? certById.get(l.linked_certification_id) : null;
    if (!q || !c || verifiedCertIds.has(c.id)) continue;
    licenseCertIds.add(c.id);
    // a Needs Reconciliation row is only a "did not clear" when the automatic check produced a result; Discrepancy / Unable to Verify are
    // human determinations and always listed
    if (q.status === "Needs Reconciliation" && (LICENSE_NEVER_LISTED_REASONS.has(String(l.verification_reason)) || (l.verification_outcome !== "ambiguous" && l.verification_outcome !== "not_found"))) continue;
    const base = String(c.name || "License").trim();
    notCleared.push({
      kind: "license",
      label: `${/licen[sc]e/i.test(base) ? base : base + " license"}${l.state ? ` (${l.state})` : ""}`,
      status: statusOf(q.status),
      reason: LICENSE_REASON[String(l.verification_reason)] || LICENSE_REASON_GENERIC,
    });
  }
  const humanOnly = (q: any) => q && (q.status === "Discrepancy" || q.status === "Unable to Verify");
  const jobN = ncBySource("Job Experience"), eduN = ncBySource("Education"), certN = ncBySource("Certification");
  for (const w of work) { const q = jobN.get(w.id); if (humanOnly(q)) notCleared.push({ kind: "job", label: [w.title, w.company].filter(Boolean).join(" at ") || "Job", status: statusOf(q!.status) }); }
  for (const e of edu) { const q = eduN.get(e.id); if (humanOnly(q)) notCleared.push({ kind: "education", label: [[e.degree, e.field_of_study].filter(Boolean).join(", "), e.institution].filter(Boolean).join(" - ") || "Education", status: statusOf(q!.status) }); }
  for (const c of certs) { const q = certN.get(c.id); if (humanOnly(q) && !verifiedCertIds.has(c.id) && !licenseCertIds.has(c.id)) notCleared.push({ kind: "certification", label: String(c.name || "Certification"), status: statusOf(q!.status) }); }

  const counts = {
    work: { confirmed: work.length, verified: workOut.length },
    education: { confirmed: edu.length, verified: eduOut.length },
    certifications: { confirmed: certs.length, verified: certOut.length },
    verified_total: workOut.length + eduOut.length + certOut.length,
    not_cleared_total: notCleared.length,
  };
  const name = [cand.first_name, cand.last_name].filter(Boolean).join(" ");
  return {
    counts,
    notCleared,
    content: {
      version: 2,
      assembled_at: new Date().toISOString(),
      candidate: { name },
      basis: "Items the candidate confirmed and that Verifi verified are shown as verified. Items where a check was run and did not clear are listed separately by name. Any other item that is not shown was not verified, for any reason; that is not evidence either way. This is the record as of the assembly time above.",
      coverage: { work: counts.work, education: counts.education, certifications: counts.certifications },
      work: workOut, education: eduOut, certifications: certOut,
      not_cleared: notCleared,
    },
  };
}

// ---------------------------------------------------------------------------------------------------
// EMAIL. Everything an employer typed (name, company, email, source) is escaped before it goes into HTML.
// ---------------------------------------------------------------------------------------------------
async function notifyCandidate(requestId: string): Promise<{ sent: boolean; reason?: string }> {
  const r = (await rows(`comparison_requests?id=eq.${requestId}&select=id,candidate_id,requester_name,requester_company,requester_email,attestation,expires_at,status,candidate_notified_at`))[0];
  if (!r) return { sent: false, reason: "not_found" };
  if (r.status !== "pending") return { sent: false, reason: "not_pending" };
  const c = (await rows(`candidates?id=eq.${r.candidate_id}&select=email,first_name`))[0];
  if (!c) return { sent: false, reason: "no_candidate" };
  // Claim first, so two callers can never both send.
  const claim = await rest(`comparison_requests?id=eq.${requestId}&candidate_notified_at=is.null`, { method: "PATCH", headers: { "Prefer": "return=representation" }, body: JSON.stringify({ candidate_notified_at: new Date().toISOString() }) });
  const claimed = claim.ok ? await claim.json() : [];
  if (!Array.isArray(claimed) || claimed.length === 0) return { sent: false, reason: "already_sent" };
  const who = r.requester_company ? `${esc(r.requester_name || "Someone")} at ${esc(r.requester_company)}` : esc(r.requester_name || "Someone");
  const ok = await sendEmail(
    c.email,
    "An employer asked to compare a resume with your verified record",
    `<p>Hi${c.first_name ? " " + esc(c.first_name) : ""},</p><p>${who} (${esc(r.requester_email)}, confirmed by a link sent to that address) asked to compare their copy of your resume with your verified record on Verifi.</p><p><b>How they say they got your information:</b> ${esc(r.attestation)}</p><p><b>Nothing is shared unless you approve.</b> If you approve, they see the items you confirmed that Verifi has verified, plus the name and status of any item that was checked and did not clear (the approval screen lists exactly which, before you decide). Nothing else about your other items is shown. If you decline, or do nothing, they are told only that the request was not authorized.</p><p><a href="${SITE}/candidate.html">Sign in and open the Activity tab</a> to review it. The request closes automatically at ${esc(new Date(r.expires_at).toUTCString())}.</p>`,
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
  const r = (await rows(`comparison_requests?id=eq.${requestId}&select=id,access_method,status,requester_email,requester_name,first_delivered_at,guest_link_sent_at,snapshot_expires_at`))[0];
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
  const ok = await sendEmail(
    r.requester_email,
    "Your Verifi comparison request was approved",
    `<p>Hi ${esc(r.requester_name || "there")},</p><p>The candidate approved your comparison request.</p><p><a href="${SITE}/employer.html?comparison=${token}">Open your comparison</a></p><p>This is a <b>one-time view</b>. Nothing is charged until you choose to open it: opening costs ${esc(money)}, and once you do you can read it for 30 minutes. After that it is gone and cannot be reopened, by you or by us. There is no account: this link is the only way in, so keep this email. The link works until ${esc(new Date(r.snapshot_expires_at).toUTCString())} if you do not open it.</p>`,
  );
  if (!ok) await rest(`comparison_requests?id=eq.${requestId}`, { method: "PATCH", headers: { "Prefer": "return=minimal" }, body: JSON.stringify({ guest_link_sent_at: null, guest_token_hash: null }) });
  return ok;
}

async function noticeRequesterApproved(requestId: string): Promise<boolean> {
  const r = (await rows(`comparison_requests?id=eq.${requestId}&select=requester_email,requester_name,access_method,snapshot_expires_at`))[0];
  if (r && r.access_method === "guest") return await sendGuestLink(requestId);
  if (!r || r.access_method !== "org") return false;
  return await sendEmail(
    r.requester_email,
    "Your Verifi comparison request was approved",
    `<p>Hi ${esc(r.requester_name || "there")},</p><p>The candidate approved your comparison request. <a href="${SITE}/employer.html">Sign in to your Verifi employer account</a> to open it. It stays available until ${esc(new Date(r.snapshot_expires_at).toUTCString())}; opening it uses one lookup from your organization's plan.</p>`,
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

      // ---- candidate-session actions ----
      const candidateId = typeof body.candidate_id === "string" ? body.candidate_id : "";
      if (!(await isCandidateSession(body, candidateId))) return UNAUTHORIZED();
      const nowIso = () => new Date().toISOString();

      if (action === "list") {
        const [reqs, snaps, tier1, share] = await Promise.all([
          rows(`comparison_requests?candidate_id=eq.${candidateId}&select=id,requester_email,requester_name,requester_company,requester_domain_type,attestation,status,created_at,expires_at,responded_at,approved_at,first_delivered_at,snapshot_expires_at&order=created_at.desc&limit=100`),
          rows(`comparison_snapshots?candidate_id=eq.${candidateId}&select=request_id`),
          rows(`employer_lookup_requests?matched_candidate_id=eq.${candidateId}&result_exists=eq.true&select=id,requester_email,requester_company,used_at&order=used_at.desc&limit=100`),
          assembleSnapshot(candidateId),
        ]);
        const hasSnap = new Set(snaps.map((s) => s.request_id));
        const now = Date.now();
        const shaped = reqs.map((r) => {
          // a pending request past its window is closed even if the sweep has not run yet
          const status = r.status === "pending" && new Date(r.expires_at).getTime() < now ? "expired" : r.status;
          return {
            id: r.id, status, created_at: r.created_at, expires_at: r.expires_at, responded_at: r.responded_at, approved_at: r.approved_at,
            delivered: !!r.first_delivered_at, first_delivered_at: r.first_delivered_at, snapshot_available: hasSnap.has(r.id), snapshot_expires_at: r.snapshot_expires_at,
            requester: { name: r.requester_name, company: r.requester_company, email: r.requester_email, domain: String(r.requester_email).split("@")[1] || "", domain_type: r.requester_domain_type },
            attestation: r.attestation,
          };
        });
        return json({
          ok: true,
          pending: shaped.filter((r) => r.status === "pending"),
          history: shaped.filter((r) => r.status !== "pending"),
          tier1: tier1.map((t) => ({ id: t.id, domain: String(t.requester_email).split("@")[1] || "", company: t.requester_company, date: t.used_at })),
          would_share: { ...share.counts, not_cleared: share.notCleared },
        });
      }

      if (action === "respond") {
        if (typeof body.request_id !== "string" || !UUID.test(body.request_id)) return json({ ok: false, error: "request_id_invalid" }, 400);
        if (body.decision !== "approve" && body.decision !== "decline") return json({ ok: false, error: "decision_invalid" }, 400);
        // scoped to THIS candidate: someone else's request is indistinguishable from one that does not exist
        const r = (await rows(`comparison_requests?id=eq.${body.request_id}&candidate_id=eq.${candidateId}&select=id,status,expires_at,access_method`))[0];
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
        const snap = await assembleSnapshot(candidateId);
        if (!snap.content) return json({ ok: false, error: "unavailable" }, 409);
        if (snap.counts.verified_total === 0) return json({ ok: false, error: "nothing_to_share", would_share: snap.counts }, 409);
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
        return json({ ok: true, status: "approved", shared: { ...snap.counts, not_cleared: snap.notCleared }, employer_notified: notified });
      }

      if (action === "view_snapshot") {
        if (typeof body.request_id !== "string" || !UUID.test(body.request_id)) return json({ ok: false, error: "request_id_invalid" }, 400);
        const r = (await rows(`comparison_requests?id=eq.${body.request_id}&candidate_id=eq.${candidateId}&status=eq.approved&select=id`))[0];
        if (!r) return json({ ok: false, error: "not_found" }, 404);
        const s = (await rows(`comparison_snapshots?request_id=eq.${r.id}&candidate_id=eq.${candidateId}&select=content,assembled_at`))[0];
        if (!s) return json({ ok: false, error: "not_found" }, 404);
        return json({ ok: true, content: s.content, assembled_at: s.assembled_at });
      }

      return json({ ok: false, error: "unknown_action" }, 404);
    } catch (_e) {
      return json({ ok: false, error: "request_failed" }, 500);
    }
  }),
};
