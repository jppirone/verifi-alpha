// Setup type definitions for built-in Supabase Runtime APIs
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { withSupabase } from "jsr:@supabase/server@1";
import { createClient } from "jsr:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "content-type",
};

// Resume Upload → OCR → Structured Extraction Pipeline (Alpha) — step 3 of 3.
//
// Accepts the candidate's edited version of every extracted row plus which categories they opted
// into verification (the same opt-in-checkbox pattern already in candidate.html: optInWorkHistory /
// toggleOptInWorkHistory etc. on the isPreview screen — this reuses that concept, not a new toggle
// model). For each row: write the candidate's (possibly corrected) field values and set
// candidate_confirmed = true. For each category the candidate opted into, insert one
// verification_items row per confirmed item in that category — real staff-queue intake, same table
// staff.html already reads, same 'New' default status every other queue item gets.
//
// verification_items.type uses the real literal strings already live in that table (confirmed via
// direct query before writing this: "Job Experience", "Education", "Certification" — not invented
// here). verification_items.id is `text`, not uuid (also confirmed live) — new ids are generated
// via verification_item_id_seq (see migration) as 'VQ-' || nextval(...), matching the visible shape
// of real existing ids like "VQ-1034"; the exact original generator wasn't reachable before this
// session's browser tool connection dropped mid-build, so this is a considered, documented
// decision, not a reverse-engineered match — flagged plainly, not silently assumed identical.

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

// *_precision: how precisely the SOURCE printed each date (year | month | day, or present for an end date), echoed
// back by the client from get-resume-extraction; see migration 20260919090000_date_precision.sql.
// flagged/flag_note (candidate item-flagging, 2026-09-23): a candidate can flag any individual item
// on the review screen as wrong (or wrongly judged) before ever hitting confirm -- see this
// migration's own header (20260923050000_candidate_item_flag.sql). Present on every editable-item
// type below. Written onto the draft row unconditionally (a flag with no note is not persisted --
// see flagFields()) and, for the three categories that create a verification_items row in the same
// request, carried onto that new row too so staff see it immediately, not just on the draft item.
type FlagEdit = { flagged?: boolean; flag_note?: string };
type WorkHistoryEdit = { id: string; company?: string; title?: string; location?: string; start_date?: string; end_date?: string; start_date_precision?: string | null; end_date_precision?: string | null; job_responsibilities?: string; heading?: string | null } & FlagEdit;
type EducationEdit = { id: string; institution?: string; degree?: string; field_of_study?: string; location?: string; start_date?: string; end_date?: string; start_date_precision?: string | null; end_date_precision?: string | null; heading?: string | null } & FlagEdit;
// source_match is echoed back by the client (candidate.html already has it, straight from
// get-resume-extraction) for the same reason section_type/heading are on FreeformEdit below — this
// function only needs it to decide which certifications get the unconditional staff flag, not to
// validate anything. See the queueInserts loop for why an unmatched cert overrides opt-in rather
// than needing it.
// trade_soc_code (Item 8, 2026-09-12 live-testing session): the candidate's chosen (or auto-suggested
// and left as-is) SOC trade/occupation code, echoed back the same way license_number already is —
// see the queueInserts loop below for what happens when it's missing.
// verification_link (2026-09-22, license/certification confirm screen split): the certification-appropriate
// counterpart to a license's issuing-state check -- offered only for a non-license certification now, but
// accepted here regardless of which the item turns out to be, same as every other field on this row. Same
// validation as the later employer-contact-details screen already applies to the same column: http(s) only,
// capped at 500 chars, blank clears it.
type CertificationEdit = { id: string; name?: string; issuing_body?: string; license_number?: string; verification_link?: string | null; issue_date?: string; expiration_date?: string; issue_date_precision?: string | null; expiration_date_precision?: string | null; source_match?: string; trade_soc_code?: string | null; heading?: string | null } & FlagEdit;
// License edits (automatic license verification): a license is a certification row (edited through
// CertificationEdit above — name, number, dates) plus a 1:1 license_items extension holding only the
// issuing state. state is only ever a 2-letter US state/DC code (validated below) and is never
// required to confirm — a license with no state simply stays unverified. remove:true is the
// candidate's "this isn't a license" dismissal of a false detection: it drops the license extension
// only, the certification row is left exactly as it was.
type LicenseEdit = { id: string; state?: string | null; remove?: boolean };
const VALID_STATE_CODES = new Set("AL AK AZ AR CA CO CT DE DC FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY".split(" "));
function stateOrNull(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const c = v.trim().toUpperCase();
  return VALID_STATE_CODES.has(c) ? c : null;
}
// section_type/heading are echoed back by the client (candidate.html already has them, straight
// from get-resume-extraction) rather than re-fetched here — this function only needs them to decide
// which freeform rows are needs_review for the staff-queue flag below, not to validate anything.
type FreeformEdit = { id: string; content?: string; section_type?: string; heading?: string } & FlagEdit;
type SkillEdit = { id: string; skill_text?: string } & FlagEdit;

// A flag with no (or whitespace-only) note is not persisted as a flag -- an empty flag would give
// staff nothing to act on. max 1000 chars, same cap as the Education-resubmit note.
function flagFields(x: FlagEdit): { flagged_by_candidate: boolean; candidate_flag_note: string | null; note: string } {
  const note = typeof x.flag_note === "string" ? x.flag_note.replace(/\s+/g, " ").trim().slice(0, 1000) : "";
  const flagged = !!x.flagged && !!note;
  return { flagged_by_candidate: flagged, candidate_flag_note: flagged ? note : null, note };
}

function dateOrNull(v: unknown): string | null {
  return typeof v === "string" && v.trim() !== "" ? v : null;
}

// Same rule the employer-contact-details screen already applies to this exact column: http(s) only, capped at
// 500 chars, blank clears it.
function isBadVerificationLink(v: unknown): boolean {
  const t = typeof v === "string" ? v.trim() : "";
  return !!t && !/^https?:\/\//i.test(t);
}
function cleanVerificationLink(v: unknown): string | null {
  const t = typeof v === "string" ? v.trim().slice(0, 500) : "";
  return t || null;
}

// Dates print exactly as precisely as the source did (date precision, 2026-09-19): "2007", "Mar 2007", "Mar 15, 2007",
// or "Present" — never a month or day the source did not show. A row that carries no precision (an older client)
// falls back to the same conservative rule as the database backfill: Jan 1 reads as a year, the 1st of a month as a month.
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
function printDate(date: string | null | undefined, precision: string | null | undefined): string {
  if (precision === "present") return "Present";
  if (!date) return "";
  const m = String(date).match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return "";
  const p = precision === "year" || precision === "month" || precision === "day" ? precision
    : (m[2] === "01" && m[3] === "01" ? "year" : m[3] === "01" ? "month" : "day");
  if (p === "year") return m[1];
  const mon = MONTHS[Number(m[2]) - 1] ?? "";
  return p === "month" ? `${mon} ${m[1]}` : `${mon} ${Number(m[3])}, ${m[1]}`;
}
function cleanPrecision(p: unknown, date: string | null, allowPresent: boolean): string | null {
  if (allowPresent && p === "present" && !date) return "present";
  if (date && (p === "year" || p === "month" || p === "day")) return p;
  return null;
}
function claimForWorkHistory(w: WorkHistoryEdit): string {
  const dates = [printDate(w.start_date, w.start_date_precision), printDate(w.end_date, w.end_date_precision)].filter(Boolean).join(" – ");
  return [w.title, w.company, w.location, dates].filter(Boolean).join(", ");
}
function claimForEducation(e: EducationEdit): string {
  const dates = [printDate(e.start_date, e.start_date_precision), printDate(e.end_date, e.end_date_precision)].filter(Boolean).join(" – ");
  return [e.degree, e.field_of_study, e.institution, e.location, dates].filter(Boolean).join(", ");
}
function claimForCertification(c: CertificationEdit): string {
  // Item 7 (2026-09-12 live-testing session): license_number included in the staff-facing claim
  // text too — this is the field a real state-licensing-board lookup (the DBPR/DORA automated
  // checks already wired into staff.html) actually needs visible at a glance, not just stored.
  const licenseLabel = c.license_number ? `Lic #${c.license_number}` : null;
  return [c.name, c.issuing_body, licenseLabel, printDate(c.issue_date, c.issue_date_precision)].filter(Boolean).join(", ");
}
// Truncated, not the full content — this is a queue-list preview (claim), not the review surface
// itself; internal_note below carries the full, untruncated content plus the reason it's flagged.
//
// Item B (2026-09-26 batch): this used to prepend the section heading ("EDUCATION: ...") ahead of
// the content preview. That's a genuine, confirmed bug, just not the extraction-boundary kind it
// looked like at first: heading and content are each correctly, separately extracted — the bug is
// purely in this concatenation, which has no awareness that content can itself open with its own
// phrase (e.g. "Continuing Education: 55+ hours...", the candidate's own sentence, verbatim) that
// reads as a doubled, run-on label once "EDUCATION: " is glued in front of it. Rather than trying to
// detect an echo (fragile — misses future phrasing variations), the heading is dropped from this
// string entirely and shown as its own separate label in candidate.html instead (see
// list-candidate-verification-items' sectionHeading field, added the same session) — content here is
// now always the verbatim preview, nothing prepended.
function claimForNeedsReview(f: FreeformEdit): string {
  const content = (f.content || "").trim();
  return content.length > 140 ? content.slice(0, 140) + "…" : content || "(no content)";
}
// Gap #18 (2026-09-25): same truncated-preview shape as claimForNeedsReview, reused for the other
// freeform types (additional_info/hobbies_other/summary) now that they get their own queue row too —
// see the queueInserts loop below for why.
function claimForFreeformOther(f: FreeformEdit): string {
  return claimForNeedsReview(f);
}
function claimForSkill(sk: SkillEdit): string {
  return (sk.skill_text || "").trim() || "(no text)";
}
// Gap #18: the candidate-facing category label for each new freeform type's queue row — see
// candidate.html's own VERIFICATION_CATEGORY_LABELS (kept in sync by hand, same convention already
// used for every other type literal shared between this function and that file).
// Item D (2026-09-26): skills_secondary added -- it was never included in the caller's filter below
// (real, confirmed gap: Content Manager/Customization/the PDF already show this content, but it
// could never reach Verification Status at all), same "not independently verifiable" treatment as
// additional_info/hobbies_other/summary, "Additional Skills" to match Customization's own "Additional
// skills" bucket label.
function verificationTypeForFreeform(sectionType: string): string {
  if (sectionType === "additional_info") return "Additional Info";
  if (sectionType === "hobbies_other") return "Hobbies & Other";
  if (sectionType === "summary") return "Summary";
  if (sectionType === "skills_secondary") return "Additional Skills";
  return "Additional Info"; // defensive fallback; every caller below already filters to these four
}

// ---------------------------------------------------------------------------------------------------
// CALLER AUTHENTICATION (candidate-session pass, 2026-09-19).
// This function used to act on whatever candidate_id the request body named, with no check that the caller was that
// candidate (or anyone at all beyond holding the PUBLIC anon key), so anyone who knew or guessed an id could read or
// change that account. It now requires one of:
//   * the service-role key as the bearer token (our own functions calling each other; exact match, constant-time); or
//   * the candidate's OWN live session: the session_token candidate.html holds, checked on every call against
//     candidate_sessions (hashed, unrevoked, unexpired) and required to belong to the candidate_id being acted on.
// Anything else is the same 401 whether the token was missing, wrong, expired, revoked or someone else's.
// ---------------------------------------------------------------------------------------------------
const AUTH_SB_URL = Deno.env.get("SUPABASE_URL")!;
const AUTH_SB_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
async function authSha256Hex(s: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return Array.from(new Uint8Array(d)).map((b) => b.toString(16).padStart(2, "0")).join("");
}
function authSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
function authIsServiceCaller(req: Request): boolean {
  const h = req.headers.get("authorization") || "";
  const t = h.toLowerCase().startsWith("bearer ") ? h.slice(7).trim() : "";
  return !!t && !!AUTH_SB_KEY && authSafeEqual(t, AUTH_SB_KEY);
}
async function authIsCandidateSession(body: any, candidateId: string): Promise<boolean> {
  const tok = typeof body?.session_token === "string" ? body.session_token : "";
  if (tok.length < 20 || tok.length > 200 || !candidateId) return false;
  const rest = { "apikey": AUTH_SB_KEY, "Authorization": `Bearer ${AUTH_SB_KEY}` };
  const r = await fetch(`${AUTH_SB_URL}/rest/v1/candidate_sessions?token_hash=eq.${await authSha256Hex(tok)}&select=candidate_id,expires_at,revoked_at`, { headers: rest });
  const sess = r.ok ? (await r.json())[0] : null;
  return !!sess && !sess.revoked_at && new Date(sess.expires_at).getTime() > Date.now() && sess.candidate_id === candidateId;
}
const UNAUTHORIZED = () => new Response(JSON.stringify({ ok: false, error: "unauthorized" }), { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } });
async function authGateCandidate(req: Request, body: any): Promise<Response | null> {
  const cid = typeof body?.candidate_id === "string" ? body.candidate_id : "";
  if (authIsServiceCaller(req)) return null;
  if (cid && await authIsCandidateSession(body, cid)) return null;
  return UNAUTHORIZED();
}

export default {
  fetch: withSupabase({ auth: "none" }, async (req, _ctx) => {
    if (req.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }
    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

    // Transaction safety (resume resubmission, Stage 1, 2026-09-21). The claim below is committed on its own and everything after it is a series
    // of separate writes, so a failure part-way used to leave the document permanently "confirmed" with only some rows updated, and every retry got
    // 409 (which the client treats as success). Now, if this call fails BEFORE the staff-queue rows are inserted (they go in as one statement, so a
    // failure means none were), the claim is released so the same submission can simply be retried: every earlier write only sets the submitted
    // values again. After the queue insert nothing can fail the request (verification runs in the background), so nothing needs releasing.
    let claimed: { at: string; doc: string; candidate: string } | null = null;
    let queueDone = false;
    const releaseClaim = async () => {
      if (!claimed || queueDone) return;
      await fetch(`${SUPABASE_URL}/rest/v1/resume_documents?id=eq.${claimed.doc}&candidate_id=eq.${claimed.candidate}&confirmed_at=eq.${encodeURIComponent(claimed.at)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", "apikey": SUPABASE_SERVICE_ROLE_KEY, "Authorization": `Bearer ${SUPABASE_SERVICE_ROLE_KEY}` },
        body: JSON.stringify({ confirmed_at: null }),
      }).catch(() => {});
      claimed = null;
    };
    const failReleasing = async (bodyText: BodyInit, init: ResponseInit): Promise<Response> => { await releaseClaim(); return new Response(bodyText, init); };

    try {
      const authBody = await req.clone().json().catch(() => ({}));
      const authDenied = await authGateCandidate(req, authBody);
      if (authDenied) return authDenied;
      const body = await req.json();
      const {
        candidate_id,
        // Item D (2026-09-08 regression session): foundation-only piece of the future "bundle"
        // concept (Item 15) — see the migration's own header. Optional and echoed straight from
        // the client's resumeExtraction.resume_document.id (not re-derived here); absent on any
        // call that predates this field or omits it for another reason, in which case every row
        // this request inserts below simply gets bundle_id: null, same as every pre-Item-D row —
        // an honest "ungrouped," never a guessed value.
        resume_document_id = null,
        // Item 19 (2026-09-12 live-testing session): the candidate's own edit to their extracted
        // personal location (see resume_documents' own migration header) — written in the same
        // atomic claim PATCH below as confirmed_at, since both belong to the same resume_document
        // row and both only ever get set once, at confirm time.
        candidate_location = null,
        work_history = [], education = [], certifications = [], skills = [], freeform = [], licenses = [],
        opt_in = { work_history: false, education: false, certifications: false },
      }: {
        candidate_id: string;
        resume_document_id?: string | null;
        candidate_location?: string | null;
        work_history: WorkHistoryEdit[];
        education: EducationEdit[];
        certifications: CertificationEdit[];
        skills: SkillEdit[];
        freeform: FreeformEdit[];
        licenses?: LicenseEdit[];
        opt_in: { work_history: boolean; education: boolean; certifications: boolean };
      } = body;

      if (!candidate_id) {
        return new Response(JSON.stringify({ ok: false, error: "candidate_id is required" }), {
          status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      // Validated before anything is claimed or written, same as every other malformed-request check on this
      // function: a bad link fails the whole confirm cleanly rather than leaving a partial write behind.
      if (certifications.some((c) => isBadVerificationLink(c.verification_link))) {
        return new Response(JSON.stringify({ ok: false, error: "verification_link_invalid" }), {
          status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      // Cross-tab session awareness (2026-09-11 status-check session): the real, atomic guard
      // against this function running twice for the same resume_document — confirmed live during
      // dual-tab magic-link testing this week, a candidate with two tabs on the same session could
      // confirm in one and then, unaware, confirm again in the other (with whatever stale local
      // edits that tab still had), silently inserting a SECOND full pass of verification_items for
      // the same rows. The conditional UPDATE below (`confirmed_at is null`) is evaluated by
      // Postgres as part of one statement — same single-use-token pattern already proven for
      // confirm-login (see that function's own header) — so the loser of a race, or a genuinely
      // later second submission, gets a real, honest "already confirmed" response instead of
      // silently re-running every insert below. Only guarded when resume_document_id is actually
      // present (it always is from the real client — see submitResumeConfirmation's own body — but
      // stays optional per Item D's own foundation-only framing) so no existing caller breaks.
      // Two more guards, both about a candidate who is ALREADY confirmed:
      //   * a resubmission's document is never confirmed here (its items become the profile only through the resubmission apply, which reconciles
      //     against the verified record); and
      //   * a second, different document is never confirmed here either: it used to be, duplicating every item and queue row.
      if (resume_document_id) {
        const gate = await fetch(`${SUPABASE_URL}/rest/v1/resume_documents?candidate_id=eq.${candidate_id}&or=(id.eq.${resume_document_id},confirmed_at.not.is.null)&select=id,kind,confirmed_at`, {
          headers: { "apikey": SUPABASE_SERVICE_ROLE_KEY, "Authorization": `Bearer ${SUPABASE_SERVICE_ROLE_KEY}` },
        });
        const gateRows: any[] = gate.ok ? await gate.json() : [];
        const thisDoc = gateRows.find((d) => d.id === resume_document_id);
        if (thisDoc && thisDoc.kind === "resubmission") {
          return new Response(JSON.stringify({ ok: false, error: "resubmission_not_confirmable_here" }), { status: 409, headers: { ...corsHeaders, "Content-Type": "application/json" } });
        }
        if (gateRows.some((d) => d.id !== resume_document_id && d.confirmed_at)) {
          return new Response(JSON.stringify({ ok: false, error: "already_confirmed" }), { status: 409, headers: { ...corsHeaders, "Content-Type": "application/json" } });
        }
      }

      if (resume_document_id) {
        const claimAt = new Date().toISOString();
        const claimRes = await fetch(
          `${SUPABASE_URL}/rest/v1/resume_documents?id=eq.${resume_document_id}&candidate_id=eq.${candidate_id}&confirmed_at=is.null`,
          {
            method: "PATCH",
            headers: {
              "Content-Type": "application/json",
              "apikey": SUPABASE_SERVICE_ROLE_KEY,
              "Authorization": `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
              "Prefer": "return=representation",
            },
            body: JSON.stringify({ confirmed_at: claimAt, candidate_location: candidate_location || null }),
          },
        );
        const claimedRows = claimRes.ok ? await claimRes.json() : [];
        if (claimedRows.length) claimed = { at: claimAt, doc: resume_document_id, candidate: candidate_id };
        if (!claimedRows.length) {
          return new Response(JSON.stringify({ ok: false, error: "already_confirmed" }), {
            status: 409, headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        }
      }

      // Shared timestamp for every flagged_by_candidate/candidate_flag_note_at write below (item-flagging, 2026-09-23) --
      // one instant for the whole request, not a fresh Date() per row.
      const nowIso = new Date().toISOString();

      // Write candidate's (possibly corrected) fields and mark each row confirmed. Sequential, not
      // parallel — keeps error reporting attributable to a specific row if one update fails.
      //
      // .select("id") + a zero-row check on every one of these 5 loops — real gap found investigating
      // a session-refresh bug report (2026-09-07): Supabase's update() does NOT set `error` when the
      // filter matches zero rows (a stale id, or a candidate_id mismatch) — it just silently succeeds
      // having changed nothing. Since candidate.html's checkResumeFlowIncomplete relies on every
      // extracted row eventually getting candidate_confirmed=true, a silent zero-row update here would
      // leave that one row permanently "incomplete" — re-routing a genuinely-finished candidate back to
      // resumeConfirm forever, with no error ever surfaced to explain why. Verified live before this
      // was written: a deliberately stale id on one category now returns a real error instead of a
      // false ok:true.
      for (const w of work_history) {
        const { data, error } = await supabase.from("work_history_items").update({
          company: w.company ?? null, title: w.title ?? null,
          location: w.location ?? null,
          start_date: dateOrNull(w.start_date), end_date: dateOrNull(w.end_date),
          ...(w.start_date_precision !== undefined || w.end_date_precision !== undefined ? {
            start_date_precision: cleanPrecision(w.start_date_precision, dateOrNull(w.start_date), false),
            end_date_precision: cleanPrecision(w.end_date_precision, dateOrNull(w.end_date), true),
          } : {}),
          job_responsibilities: w.job_responsibilities ?? null,
          // Item #3 (2026-09-17): heading is candidate-editable now (one shared value per
          // contiguous resumeConfirm group — see candidate.html's updateResumeSectionHeading), so
          // this is the first write this field has ever gotten past initial extraction.
          heading: w.heading ?? null,
          ...(() => { const f = flagFields(w); return { flagged_by_candidate: f.flagged_by_candidate, candidate_flag_note: f.candidate_flag_note, candidate_flag_note_at: f.flagged_by_candidate ? nowIso : null }; })(),
          candidate_confirmed: true, updated_at: nowIso,
        }).eq("id", w.id).eq("candidate_id", candidate_id).select("id");
        if (error || !data || data.length === 0) {
          return await failReleasing(JSON.stringify({ ok: false, error: "work_history_update_failed", detail: error ? error.message : "no matching row for this candidate", item_id: w.id }), {
            status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        }
      }
      for (const e of education) {
        const { data, error } = await supabase.from("education_items").update({
          institution: e.institution ?? null, degree: e.degree ?? null, field_of_study: e.field_of_study ?? null,
          location: e.location ?? null,
          start_date: dateOrNull(e.start_date), end_date: dateOrNull(e.end_date),
          ...(e.start_date_precision !== undefined || e.end_date_precision !== undefined ? {
            start_date_precision: cleanPrecision(e.start_date_precision, dateOrNull(e.start_date), false),
            end_date_precision: cleanPrecision(e.end_date_precision, dateOrNull(e.end_date), true),
          } : {}),
          heading: e.heading ?? null,
          ...(() => { const f = flagFields(e); return { flagged_by_candidate: f.flagged_by_candidate, candidate_flag_note: f.candidate_flag_note, candidate_flag_note_at: f.flagged_by_candidate ? nowIso : null }; })(),
          candidate_confirmed: true, updated_at: nowIso,
        }).eq("id", e.id).eq("candidate_id", candidate_id).select("id");
        if (error || !data || data.length === 0) {
          return await failReleasing(JSON.stringify({ ok: false, error: "education_update_failed", detail: error ? error.message : "no matching row for this candidate", item_id: e.id }), {
            status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        }
      }
      for (const c of certifications) {
        const { data, error } = await supabase.from("certification_items").update({
          name: c.name ?? null, issuing_body: c.issuing_body ?? null, license_number: c.license_number ?? null,
          verification_link: cleanVerificationLink(c.verification_link),
          issue_date: dateOrNull(c.issue_date), expiration_date: dateOrNull(c.expiration_date),
          ...(c.issue_date_precision !== undefined || c.expiration_date_precision !== undefined ? {
            issue_date_precision: cleanPrecision(c.issue_date_precision, dateOrNull(c.issue_date), false),
            expiration_date_precision: cleanPrecision(c.expiration_date_precision, dateOrNull(c.expiration_date), false),
          } : {}),
          trade_soc_code: c.trade_soc_code ?? null,
          heading: c.heading ?? null,
          ...(() => { const f = flagFields(c); return { flagged_by_candidate: f.flagged_by_candidate, candidate_flag_note: f.candidate_flag_note, candidate_flag_note_at: f.flagged_by_candidate ? nowIso : null }; })(),
          candidate_confirmed: true, updated_at: nowIso,
        }).eq("id", c.id).eq("candidate_id", candidate_id).select("id");
        if (error || !data || data.length === 0) {
          return await failReleasing(JSON.stringify({ ok: false, error: "certification_update_failed", detail: error ? error.message : "no matching row for this candidate", item_id: c.id }), {
            status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        }
      }
      // Skills: candidate-self-reported, same trust level as freeform (summary/hobbies_other) —
      // never enters the verification_items staff queue below, matching freeform's own lifecycle.
      // No opt-in flag for skills exists (it was never one of the three categories collected at
      // signup, and this build doesn't add a fourth) — deliberately out of scope, not an oversight.
      for (const sk of skills) {
        const skFlag = flagFields(sk);
        const { data, error } = await supabase.from("skill_items").update({
          skill_text: sk.skill_text ?? "",
          flagged_by_candidate: skFlag.flagged_by_candidate, candidate_flag_note: skFlag.candidate_flag_note, candidate_flag_note_at: skFlag.flagged_by_candidate ? nowIso : null,
          candidate_confirmed: true, updated_at: nowIso,
        }).eq("id", sk.id).eq("candidate_id", candidate_id).select("id");
        if (error || !data || data.length === 0) {
          return await failReleasing(JSON.stringify({ ok: false, error: "skill_update_failed", detail: error ? error.message : "no matching row for this candidate", item_id: sk.id }), {
            status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        }
      }
      for (const f of freeform) {
        const { data, error } = await supabase.from("candidate_freeform_sections").update({
          content: f.content ?? null,
          // Item #3 (2026-09-17): heading is now candidate-editable on resumeConfirm for freeform
          // rows too (summary/hobbies_other/needs_review) — previously echoed back read-only and
          // never actually written here.
          heading: f.heading ?? null,
          ...(() => { const fl = flagFields(f); return { flagged_by_candidate: fl.flagged_by_candidate, candidate_flag_note: fl.candidate_flag_note, candidate_flag_note_at: fl.flagged_by_candidate ? nowIso : null }; })(),
          candidate_confirmed: true, updated_at: nowIso,
        }).eq("id", f.id).eq("candidate_id", candidate_id).select("id");
        if (error || !data || data.length === 0) {
          return await failReleasing(JSON.stringify({ ok: false, error: "freeform_update_failed", detail: error ? error.message : "no matching row for this candidate", item_id: f.id }), {
            status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        }
      }

      // Detected licenses (separate from certifications above). Written here, verified further down
      // once everything else has committed. Nothing about a license with a missing state/number
      // creates a queue row or chases the candidate — it just stays unverified.
      const licenseIdsToVerify: string[] = [];
      if (licenses.length) {
        const { data: prevRows, error: prevErr } = await supabase.from("license_items")
          .select("id, state, state_source, state_evidence")
          .eq("candidate_id", candidate_id).in("id", licenses.map((l) => l.id));
        if (prevErr) {
          return await failReleasing(JSON.stringify({ ok: false, error: "license_lookup_failed", detail: prevErr.message }), {
            status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        }
        const prevById = new Map((prevRows || []).map((r: any) => [r.id, r]));
        for (const l of licenses) {
          const prev: any = prevById.get(l.id);
          if (!prev) {
            return await failReleasing(JSON.stringify({ ok: false, error: "license_update_failed", detail: "no matching row for this candidate", item_id: l.id }), {
              status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
            });
          }
          if (l.remove) {
            const { error: delErr } = await supabase.from("license_items").delete().eq("id", l.id).eq("candidate_id", candidate_id);
            if (delErr) {
              return await failReleasing(JSON.stringify({ ok: false, error: "license_update_failed", detail: delErr.message, item_id: l.id }), {
                status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
              });
            }
            continue;
          }
          const state = stateOrNull(l.state);
          const stateUnchanged = state !== null && state === prev.state;
          const { error: updErr } = await supabase.from("license_items").update({
            state,
            state_source: state ? (stateUnchanged ? prev.state_source : "candidate") : null,
            state_evidence: stateUnchanged ? prev.state_evidence : null,
            candidate_confirmed: true, updated_at: new Date().toISOString(),
          }).eq("id", l.id).eq("candidate_id", candidate_id);
          if (updErr) {
            return await failReleasing(JSON.stringify({ ok: false, error: "license_update_failed", detail: updErr.message, item_id: l.id }), {
              status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
            });
          }
          // verify-license reads the number (and everything else) from the certification row that
          // was just written above and returns "incomplete" without side effects if it's missing.
          if (state) licenseIdsToVerify.push(l.id);
        }
      }

      // Opted-in categories → real staff-queue intake, one verification_items row per confirmed
      // item in that category.
      //
      // status: "New" is set explicitly on every push below, INCLUDING these three, even though
      // "New" is also the column's own DB default — a real bug, caught live testing this exact
      // change: Supabase's PostgREST batches one JS array into a single INSERT built from the
      // UNION of keys across every object in the array. Once the needs_review push further down
      // started setting `status` explicitly (it has to — "Needs Reconciliation", not "New"), that
      // widened the batch's column list to include `status` for every row in the same call, and a
      // row that doesn't supply a key POSTgREST includes in that widened column list gets an
      // explicit NULL, not the column default — NULL only falls back to a DEFAULT when the column
      // is omitted from the statement entirely, which stops being true once a sibling row in the
      // same batch supplies it. That surfaced as a real NOT NULL violation on `status` the moment
      // a needs_review row and an opted-in row were confirmed in the same request. Setting it
      // explicitly here removes the dependency on batch-shape entirely.
      const today = new Date().toISOString().slice(0, 10);
      const queueInserts: Record<string, unknown>[] = [];

      // flagCarry (item-flagging, 2026-09-23): the same flagFields() used for the draft-row write
      // above, reused here so a flagged item's new verification_items row shows the flag and note
      // immediately -- staff never have to separately open the draft row to find it. candidate_note
      // is the same column the pre-existing Education-resubmit note flow already writes; this is a
      // second, independent writer of it (a fresh row, never a competing write to an existing one).
      // flagged_by_candidate is ALWAYS included, explicitly, even when false -- see the identical,
      // already-hard-won lesson on `status` immediately below this comment (PostgREST batches one JS
      // array into a single INSERT from the UNION of keys across every object; a row that omits a key
      // present on a SIBLING row in the same batch gets an explicit NULL, not the column default, the
      // moment any other row in the batch supplies it). candidate_note/candidate_note_at stay omitted
      // when unflagged (nullable columns, no NOT NULL default to violate).
      const flagCarry = (x: FlagEdit) => {
        const f = flagFields(x);
        return f.flagged_by_candidate ? { flagged_by_candidate: true, candidate_note: f.candidate_flag_note, candidate_note_at: nowIso } : { flagged_by_candidate: false };
      };

      if (opt_in.work_history) {
        for (const w of work_history) {
          const { data: idRow } = await supabase.rpc("nextval_verification_item_id");
          queueInserts.push({
            // source_item_id (Item C, 2026-09-08): the real back-reference this table never had —
            // see the migration's own header. w.id is the real work_history_items.id (echoed back
            // from get-resume-extraction, same id this function's own update loop above just wrote
            // to), not a guess or a synthesized value.
            id: idRow, candidate_id, type: "Job Experience", claim: claimForWorkHistory(w), received: today, status: "New",
            source_item_id: w.id, bundle_id: resume_document_id, ...flagCarry(w),
          });
        }
      }
      if (opt_in.education) {
        for (const e of education) {
          const { data: idRow } = await supabase.rpc("nextval_verification_item_id");
          queueInserts.push({
            id: idRow, candidate_id, type: "Education", claim: claimForEducation(e), received: today, status: "New",
            source_item_id: e.id, bundle_id: resume_document_id, ...flagCarry(e),
          });
        }
      }
      // Certifications: one queue row per item, EXCEPT this is the one category where a real
      // structural signal can override plain opt-in — see certification_source_match's own
      // migration for the full reasoning (bug-2 defense-in-depth). An item whose source_match is
      // 'unmatched' (its name isn't traceable, even loosely, to anything in the document's own OCR
      // text) gets flagged UNCONDITIONALLY, the same non-blocking-but-flagged pattern already used
      // for needs_review below — real fabrication risk doesn't become less real just because the
      // candidate happened not to check the "submit for verification" box for that one item. A
      // matched or not-independently-checkable ('matched'/'not_checked'/null) item follows the
      // ordinary opt-in rule exactly as before. Each certification contributes AT MOST one row
      // either way — never both — so opting in never double-inserts.
      //
      // Item 8 (2026-09-12 live-testing session): missingTrade extends the same override — the
      // candidate is never blocked from confirming without a trade_soc_code (see resumeConfirm's
      // own caption on this field), but a certification with no trade/occupation selected has no
      // automated licensing-board check it could ever route to, which is exactly the same kind of
      // silently-uncheckable state 'unmatched' already exists to surface. Deliberately evaluated
      // AFTER the opt-in/unmatched continue above, not instead of it — a certification the candidate
      // never opted into and that isn't independently unmatched still gets skipped entirely
      // regardless of trade_soc_code, since no automated check would ever have been attempted for
      // it in the first place. unmatched and missingTrade are independent and can both be true at
      // once, in which case both reasons land in the same internal_note rather than one overwriting
      // the other.
      //
      // Fix (2026-09-22, license/certification confirm screen work): missingTrade only ever meant
      // anything for a certification that IS a detected license — the trade/occupation field routes
      // to a licensing board, which a genuine certification (PMP, a vendor badge, ...) never has and
      // was never asked to have. Applying it unconditionally silently sent every non-license
      // certification a candidate opted into verification to manual review with a misleading note.
      // Read the definitive, POST-write license linkage (after the license edits above, including
      // any "this isn't a license" removal) rather than trust request-echoed data for this decision.
      const { data: linkedLicenseRows, error: linkedLicenseErr } = await supabase.from("license_items")
        .select("linked_certification_id").eq("candidate_id", candidate_id).not("linked_certification_id", "is", null);
      if (linkedLicenseErr) {
        return await failReleasing(JSON.stringify({ ok: false, error: "license_lookup_failed", detail: linkedLicenseErr.message }), {
          status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      const licenseLinkedCertIds = new Set((linkedLicenseRows || []).map((r: any) => r.linked_certification_id as string));
      for (const c of certifications) {
        const unmatched = c.source_match === "unmatched";
        if (!unmatched && !opt_in.certifications) continue;
        const missingTrade = licenseLinkedCertIds.has(c.id) && !c.trade_soc_code;
        const { data: idRow } = await supabase.rpc("nextval_verification_item_id");
        if (unmatched || missingTrade) {
          const reasons: string[] = [];
          if (unmatched) {
            reasons.push(`this certification's name did not fuzzy-match anything in the candidate's own uploaded document (OCR'd text) — see certification_source_match. Not proof of fabrication (OCR coverage has real, documented gaps: vision-routed pages have no OCR text at all), but real enough to warrant a human look before treating it as verified. Name as extracted: ${JSON.stringify(c.name || "")}`);
          }
          if (missingTrade) {
            reasons.push(`this is a detected license (see license_items.linked_certification_id) but no trade/occupation type (SOC code) was selected — see certification_items.trade_soc_code. No automated licensing-board check can be routed without it, so this needs a human look rather than silently sitting as a normal queue item with no check that will ever fire.`);
          }
          queueInserts.push({
            id: idRow, candidate_id, type: "Certification", claim: claimForCertification(c), received: today,
            status: "Needs Reconciliation",
            internal_note: `Auto-flagged: ${reasons.join(" Also: ")}`,
            source_item_id: c.id, bundle_id: resume_document_id, ...flagCarry(c),
          });
        } else {
          queueInserts.push({
            id: idRow, candidate_id, type: "Certification", claim: claimForCertification(c), received: today, status: "New",
            source_item_id: c.id, bundle_id: resume_document_id, ...flagCarry(c),
          });
        }
      }

      // needs_review → staff visibility, unconditional (NOT gated by any opt_in flag above).
      // needs_review was never one of the three verification categories a candidate opts into —
      // this isn't a verification submission, it's an internal review flag. The reason: needs_review
      // is the one place on this screen that is NOT validated against the uploaded document by a
      // defined schema (company/title/dates etc. all trace back to a real structured field the way
      // Job Responsibilities is the only free-typed field elsewhere in this build) — which makes it
      // also the one place a candidate COULD try to slip in additional job-description-style claims
      // under cover of "content my resume already had." This does not block the candidate (their
      // update above already went through, same as every other category) and does not touch or
      // weaken the document-provenance rule for the validated fields — it only adds staff
      // visibility into this specific catch-all content, using the exact non-blocking-but-flagged
      // pattern already live for automated-check ambiguity: status 'Needs Reconciliation' (see
      // staff.html's own header on that status — never shown to or implied to the candidate).
      // list-candidate-verification-items excludes type 'Needs Review' from what the candidate's own
      // status tab reads back, so this never surfaces to them as a "verification item pending
      // review," which it genuinely isn't.
      for (const f of freeform) {
        if (f.section_type !== "needs_review") continue;
        const { data: idRow } = await supabase.rpc("nextval_verification_item_id");
        queueInserts.push({
          id: idRow,
          candidate_id,
          type: "Needs Review",
          claim: claimForNeedsReview(f),
          received: today,
          status: "Needs Reconciliation",
          internal_note: `Auto-flagged: unstructured content from the candidate's resume that didn't map to a defined category (heading: ${JSON.stringify(f.heading || "(none)")}). Not independently validated against the uploaded document the way the structured fields above it are — review for anything that reads like an inserted job-description-style claim rather than content genuinely present on the original resume. Full content:\n\n${f.content || ""}`,
          // Item B (2026-09-26 batch): source_item_id was missing here — every other category
          // (work_history/education/certifications/skills/the other freeform types just below) sets
          // it, but this needs_review block never did, presumably predating that pattern. Found live
          // while verifying the sectionHeading join this same session: without it,
          // list-candidate-verification-items has nothing to join against, so the one type that
          // originally motivated this whole fix (a needs_review row) would have gotten a null
          // sectionHeading forever, right back to the same "heading nowhere to be found" state the
          // fix exists to solve. Added for the same reason every other category already has it.
          source_item_id: f.id,
          bundle_id: resume_document_id, ...flagCarry(f),
        });
      }

      // Gap #18 (2026-09-25, John's explicit product requirement — see that requirement doc's own
      // header for the full reasoning): validation is free for every candidate, every tier, always;
      // the ONLY thing ever paid-gated is excluding an item from delivery, never whether/what gets
      // shown or flaggable. Skills and the other freeform types (additional_info/hobbies_other/
      // summary — needs_review is already handled above, unconditionally, since before this) were
      // completely invisible on the candidate's own Verification Status tab: no verification_items
      // row of any kind was ever created for them (skills explicitly, "never enters the
      // verification_items staff queue below, matching freeform's own lifecycle" — see the skill_items
      // update loop above, now no longer the whole story). These can never be independently verified
      // the way a Job Experience or Certification can (there's no employer or registry to check a
      // Skill or a Professional Summary sentence against) — status is set directly to "Verification
      // Not Possible" (never "New"/"Needs Reconciliation": there was never a check to attempt, so
      // there's nothing "in progress" or "needing staff attention" about these, unlike needs_review's
      // genuine extraction-confidence concern). That status is already treated as terminal by
      // candidate.html's own verificationIsTerminal() — it won't show as an open/active item — and its
      // own default candidate-facing label ("No way to verify this was found") is overridden client-
      // side to "Not checked" specifically for these new types, the same word already used in this
      // JSON's own 'verification.status' field (assemble_customized_resume, 'not_checked') and in the
      // client's VERIFICATION_STATUS_LABELS convention (see candidate.html's own comment on that map).
      // Unconditional, exactly like needs_review just above — never gated by opt_in (skills/freeform
      // were never one of the three opt-in categories, and gap #18 is explicit that visibility here is
      // never a paid feature). The existing flag+note mechanism (submit-candidate-correction-response's
      // flag_item action) needs no changes at all: it already operates generically on any
      // verification_items row the candidate owns, regardless of type.
      for (const sk of skills) {
        const { data: idRow } = await supabase.rpc("nextval_verification_item_id");
        queueInserts.push({
          id: idRow, candidate_id, type: "Skill", claim: claimForSkill(sk), received: today,
          status: "Verification Not Possible",
          internal_note: `Candidate-stated skill/competency term, not independently verifiable against any outside source. Shown on the candidate's own Verification Status tab as "Not checked."`,
          source_item_id: sk.id, bundle_id: resume_document_id, ...flagCarry(sk),
        });
      }
      for (const f of freeform) {
        // Item D (2026-09-26): skills_secondary added -- see verificationTypeForFreeform's own
        // comment. Same treatment as its three siblings here, nothing else about this loop changes.
        if (f.section_type !== "additional_info" && f.section_type !== "hobbies_other" && f.section_type !== "summary" && f.section_type !== "skills_secondary") continue;
        const { data: idRow } = await supabase.rpc("nextval_verification_item_id");
        queueInserts.push({
          id: idRow, candidate_id, type: verificationTypeForFreeform(f.section_type), claim: claimForFreeformOther(f), received: today,
          status: "Verification Not Possible",
          internal_note: `Candidate-stated resume content (${f.section_type}, heading: ${JSON.stringify(f.heading || "(none)")}), not independently verifiable against any outside source. Shown on the candidate's own Verification Status tab as "Not checked."`,
          source_item_id: f.id, bundle_id: resume_document_id, ...flagCarry(f),
        });
      }

      if (queueInserts.length) {
        const { error: queueErr } = await supabase.from("verification_items").insert(queueInserts);
        if (!queueErr) queueDone = true;
        if (queueErr) {
          return await failReleasing(JSON.stringify({ ok: false, error: "verification_queue_insert_failed", detail: queueErr.message }), {
            status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        }
      }

      queueDone = true; // (also when there was nothing to queue) from here nothing can fail the request
      // Automatic license verification: everything above is committed, so a slow or failing registry lookup can
      // never lose the candidate's confirmation. It also no longer holds the candidate's response: state registry
      // lookups are slow and outside our control (DBPR alone is three sequential requests), and the confirm used to
      // wait for the slowest of them, up to 45 s per license plus 20 s for the email. Verification now runs AFTER the
      // response is returned, as an Edge Runtime background task (EdgeRuntime.waitUntil): same parallel, bounded,
      // idempotent verify-license calls as before, same single bundled correction email once every license has
      // persisted. The candidate sees each license's result on their Verification tab as it lands (that screen
      // already reads verify-license's stored outcome), exactly as they did for a license that was re-checked later.
      // If the runtime offers no background primitive the work is awaited, i.e. the old behaviour: slower, never wrong.
      const runLicenseVerification = async () => {
      const licenseVerification = await Promise.all(licenseIdsToVerify.map(async (license_item_id) => {
        try {
          const vRes = await fetch(`${SUPABASE_URL}/functions/v1/verify-license`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "apikey": SUPABASE_SERVICE_ROLE_KEY,
              "Authorization": `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
            },
            // defer_notice: these run as one burst, so the single bundled "needs correction" email is
            // sent once below, after every license has persisted — naming all of them.
            body: JSON.stringify({ candidate_id, license_item_id, defer_notice: true }),
            signal: AbortSignal.timeout(45000),
          });
          const vData = await vRes.json().catch(() => ({}));
          return { license_item_id, ok: !!vData.ok, status: vData.status ?? null, outcome: vData.outcome ?? null, correction_requested: !!vData.correction };
        } catch (e) {
          return { license_item_id, ok: false, status: "transport_error", outcome: null };
        }
      }));

      // One email covering every license in this burst that now needs the candidate's correction
      // (verify-license flags each as notified only as it puts it in the email).
      if (licenseVerification.some((v) => v.correction_requested)) {
        try {
          await fetch(`${SUPABASE_URL}/functions/v1/verify-license`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "apikey": SUPABASE_SERVICE_ROLE_KEY,
              "Authorization": `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
            },
            body: JSON.stringify({ candidate_id, action: "notify_corrections" }),
            signal: AbortSignal.timeout(20000),
          });
        } catch (_e) { /* best-effort; the candidate still sees each license on their Verification tab */ }
      }
      return licenseVerification;
      };

      let licenseVerification: Array<{ license_item_id: string; ok: boolean; status: string | null; outcome?: string | null; correction_requested?: boolean }>;
      const edgeRuntime = (globalThis as { EdgeRuntime?: { waitUntil?: (p: Promise<unknown>) => void } }).EdgeRuntime;
      if (licenseIdsToVerify.length === 0) {
        licenseVerification = [];
      } else if (edgeRuntime && typeof edgeRuntime.waitUntil === "function") {
        edgeRuntime.waitUntil(runLicenseVerification().catch((e) => console.log("confirm-resume-data: background license verification failed -", String(e))));
        licenseVerification = licenseIdsToVerify.map((license_item_id) => ({ license_item_id, ok: true, status: "queued" }));
      } else {
        licenseVerification = await runLicenseVerification();
      }

      return new Response(JSON.stringify({
        ok: true,
        confirmed_counts: { work_history: work_history.length, education: education.length, certifications: certifications.length, skills: skills.length, freeform: freeform.length, licenses: licenses.filter((l) => !l.remove).length },
        queued_for_verification: queueInserts.length,
        license_verification: licenseVerification,
        license_verification_mode: licenseVerification.some((v) => v.status === "queued") ? "background" : "inline",
      }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
    } catch (e) {
      await releaseClaim();
      return new Response(JSON.stringify({ ok: false, error: "unhandled", detail: String(e) }), {
        status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
  }),
};
