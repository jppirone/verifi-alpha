// Setup type definitions for built-in Supabase Runtime APIs
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { withSupabase } from "jsr:@supabase/server@1";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "content-type",
};

// Candidate-facing read of a candidate's own verification queue rows — the real data source for
// the "Verification Status" account tab, which previously rendered 100% hardcoded prototype
// content (fake companies, fixed counts, zero backend calls).
//
// Deliberately separate from list-verification-items (staff.html's function): that one returns
// every candidate's items plus name/email/phone for the staff queue, which is exactly the wrong
// shape to hand to a candidate's own browser. This returns only one candidate's own rows, and only
// the fields a candidate is safe to see about their own item — no assigned_to (an internal worker
// identity), never the raw internal `status` value itself, and never `internal_note` or
// `automated_check` (staff-only / out of scope; see the candidate-discrepancy-response task's own
// header). Raw status stays server-side in this response; candidate.html's own safe-label allowlist
// (see verificationSafeLabel) is what ever reaches the rendered page, so there's still a second,
// independent layer between "whatever staff typed into the dropdown" and what a candidate sees,
// not just a client-side filter that could be bypassed by reading the network response directly.
// (Note: mapping happens client-side today, matching this codebase's existing convention of doing
// response shaping in candidate.html rather than duplicating it wallet-to-wallet in every function;
// the raw `status` value is still included below for that mapping to work from, same trust
// boundary as everything else this candidate-facing endpoint already exposes about their own row.)
//
// `note` (relabeled "Note to candidate" in staff.html as of this same change) and the
// correction_requested/correction_note/correction_value trio are now included, but only populated
// for a row with status === 'Discrepancy' — the only state a candidate has anything to read or
// respond to. correction_requested/correction_note/correction_value are the candidate's own past
// submission (via submit-candidate-correction-response) being read back, not someone else's data;
// safe to return as-is.
//
// candidate_id is taken directly from the request body, matching the established pattern in this
// codebase (get-resume-extraction, confirm-resume-data): the candidate_id is only ever reachable
// from resumeCandidateId, itself only ever set from a real session (see applySession's own
// header) — not a new trust boundary, the same one already in place everywhere else in this app.
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

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

// ---------------------------------------------------------------------------------------------------
// WHAT THE CHECK FOUND, for the license holder (2026-09-20). The correction form used to let a candidate edit state / number without
// ever saying what had not matched. This maps the stored check result to ONE sentence from a fixed vocabulary: not-found, name mismatch,
// not active, held, unsupported, not checked. Nothing free-form from the registry ever passes through: the only registry text used is the
// status label and expiration of the candidate's OWN name-matched record (validated against a strict pattern); the other rows the
// registry returned (other people's names) stay in verification_detail and never leave the server. Returns null for a verified license.
// ---------------------------------------------------------------------------------------------------
function licenseFinding(l: any, verifiedByStaff: boolean): { code: string; text: string } | null {
  if (verifiedByStaff || l.verification_outcome === "verified") return null;
  const st = l.state ? String(l.state).toUpperCase() : "";
  const reg = st ? `the ${st} state registry` : "the state registry";
  const reason = String(l.verification_reason || "");
  const outcome = String(l.verification_outcome || "");
  const mr = l.verification_detail && typeof l.verification_detail === "object" ? l.verification_detail.matched_record : null;
  const status = mr && typeof mr.statusText === "string" && /^[A-Za-z ,&'\/()\-]{1,60}$/.test(mr.statusText) ? mr.statusText : null;
  const exp = mr && typeof mr.expiration === "string" && /^\d{4}-\d{2}-\d{2}$/.test(mr.expiration) ? mr.expiration : null;
  const f = (code: string, text: string) => ({ code, text });
  if (!st) return f("no_state", "This license has not been checked: no issuing state was given. Choose the state to run the check.");
  if (outcome === "unsupported_jurisdiction" || reason.startsWith("no_adapter_for_")) return f("unsupported_state", `Automatic checks are not available for ${st} yet, so this license cannot be verified automatically.`);
  if (reason === "no_state" || reason.startsWith("missing_") || outcome === "incomplete") return f("missing_detail", "The check could not run because the license number or state is missing.");
  if (!outcome && !reason) return f("not_checked", "This license has not been checked against the registry yet.");
  if (reason === "no_records" || outcome === "not_found") return f("not_found", `No license with this number was found in ${reg}. Check the number and the state.`);
  if (reason === "no_exact_name_match") return f("name_mismatch", `${reg.charAt(0).toUpperCase() + reg.slice(1)} has a license with this number, but it is not under the name on your account. Either the number differs from the one on your license, or the name on your account differs from the name on the license.`);
  // a license that WAS verified and a periodic re-check found no longer active (2026-09-21): its own finding, not the first-check one
  if (reason === "lapsed_since_verified") return f("lapsed", `This license was verified earlier. ${reg.charAt(0).toUpperCase() + reg.slice(1)} now lists it under your name as not currently active${status ? ` (registry status: ${status})` : ""}${exp ? `; expiration date ${exp}` : ""}. Our team is reviewing it.`);
  if (reason === "exact_match_not_active") return f("not_active", `${reg.charAt(0).toUpperCase() + reg.slice(1)} has this license under your name, but it is not currently active${status ? ` (registry status: ${status})` : ""}${exp ? `; expiration date ${exp}` : ""}.`);
  if (reason === "exact_match_status_indeterminate") return f("status_unclear", `${reg.charAt(0).toUpperCase() + reg.slice(1)} has this license under your name, but its status${status ? ` (${status})` : ""} is not one we can confirm automatically. Our team is reviewing it.`);
  if (reason === "multiple_exact_matches") return f("multiple_matches", "More than one registry record matches your name and this license number, so our team is reviewing it.");
  if (reason === "lookup_failed") return f("registry_unreachable", "The state registry could not be reached when we checked. Our team will review it.");
  if (reason === "result_cap_reached") return f("too_many_results", "The registry returned too many results to tell which one is yours, so our team is reviewing it.");
  if (reason === "recent_name_change") return f("name_change_hold", "This license is held for review because the name on your account was changed recently.");
  return f("in_review", "This license could not be verified automatically and is with our team for review.");
}

export default {
  fetch: withSupabase({ auth: "none" }, async (req, _ctx) => {
    if (req.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }
    try {
      const authBody = await req.clone().json().catch(() => ({}));
      const authDenied = await authGateCandidate(req, authBody);
      if (authDenied) return authDenied;
      const { candidate_id } = await req.json();
      if (!candidate_id || typeof candidate_id !== "string") {
        return new Response(JSON.stringify({ ok: false, error: "candidate_id_required" }), {
          status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      // Item 14 (2026-09-12 live-testing session): type='Needs Review' rows used to be excluded
      // entirely here — real content flagged from the candidate's own resume (a section that didn't
      // fit work_history/education/certifications — see confirm-resume-data's own header on why
      // needs_review is a real, by-design, ongoing category, not just a bug artifact) was visible to
      // staff in the queue but the candidate had no way to know it existed at all. Confirmed live:
      // Item 7/10 collapsed the SPECIFIC duplicate-item failure mode that originally motivated this
      // (a disconnected needs_review entry alongside an already-fully-captured structured item), but
      // genuine needs_review content is still a normal, permanent outcome for real unclassifiable
      // resume content — this filter was hiding that category outright, not just deduplicating it.
      // Still never returns internal_note or automated_check (staff-only, unchanged) — `claim` is
      // the same short, candidate-derived preview text already used in the staff queue list
      // (claimForNeedsReview), safe to reuse here since it's built from the candidate's own resume
      // content, not staff commentary.
      // Item 7 (2026-09-12 live-testing session, follow-up build): source_item_id added —
      // candidate.html's new durable "add/edit contact details" entry point (per-item, from this
      // candidate's own Verification Status tab) needs to know which real work_history_items/
      // certification_items row a given verification_items row came from, the same real back-
      // reference confirm-resume-data has written since Item C. Not staff-only or sensitive — it's
      // the id of the candidate's own row, same trust boundary as everything else already returned
      // here.
      const url = SUPABASE_URL + "/rest/v1/verification_items?select=id,type,claim,status,created_at,note,correction_requested,correction_note,correction_value,source_item_id,candidate_note&candidate_id=eq."
        + encodeURIComponent(candidate_id) + "&order=created_at.asc,id.asc";
      const res = await fetch(url, {
        headers: {
          "apikey": SUPABASE_SERVICE_ROLE_KEY,
          "Authorization": "Bearer " + SUPABASE_SERVICE_ROLE_KEY,
        },
      });
      if (!res.ok) {
        const errText = await res.text();
        return new Response(JSON.stringify({ ok: false, error: "fetch_failed", detail: errText }), {
          status: 502, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      const rows = await res.json();
      // Education rows carry the printed fields so the candidate can edit and resubmit an entry still in review (2026-09-20). Only the
      // candidate's own education_items are read, and only for rows whose queue item is open.
      const eduIds = rows.filter((r: any) => r.type === "Education" && r.source_item_id).map((r: any) => r.source_item_id);
      const eduRows: any[] = eduIds.length
        ? await fetch(SUPABASE_URL + "/rest/v1/education_items?select=id,degree,field_of_study,institution,location&candidate_id=eq." + encodeURIComponent(candidate_id) + "&id=in.(" + eduIds.map(encodeURIComponent).join(",") + ")", {
          headers: { "apikey": SUPABASE_SERVICE_ROLE_KEY, "Authorization": "Bearer " + SUPABASE_SERVICE_ROLE_KEY },
        }).then((r) => r.ok ? r.json() : []).catch(() => [])
        : [];
      const eduById = new Map(eduRows.map((e: any) => [e.id, e]));
      const items = rows.map((r: any) => {
        const isDiscrepancy = r.status === "Discrepancy";
        return {
          id: r.id,
          type: r.type,
          claim: r.claim,
          status: r.status,
          createdAt: r.created_at,
          sourceItemId: r.source_item_id || null,
          note: isDiscrepancy ? (r.note || null) : null,
          correctionRequested: isDiscrepancy ? !!r.correction_requested : false,
          correctionNote: isDiscrepancy ? (r.correction_note || null) : null,
          correctionValue: isDiscrepancy ? (r.correction_value || null) : null,
          candidateNote: r.candidate_note || null,
          education: r.type === "Education" && r.source_item_id && eduById.get(r.source_item_id)
            ? { degree: eduById.get(r.source_item_id).degree || "", fieldOfStudy: eduById.get(r.source_item_id).field_of_study || "", institution: eduById.get(r.source_item_id).institution || "", location: eduById.get(r.source_item_id).location || "" }
            : null,
        };
      });

      // Every license the candidate confirmed (a certification row + its license_items extension), so
      // the client can (a) show licenses that never got a queue row — no state, unsupported state,
      // or a correction being requested — as candidate-stated instead of not at all, and (b) offer
      // the edit/correction surface on any license that isn't already verified. Licenses with a
      // queue row are also in `items` above (type "License"); the client matches them by id.
      const licUrl = SUPABASE_URL + "/rest/v1/license_items?select=id,linked_certification_id,state,verification_outcome,verification_reason,verification_detail,queue_item_id,correction_status,correction_reason,correction_message,certification_items(name,issuing_body,license_number)"
        + "&candidate_confirmed=eq.true&candidate_id=eq." + encodeURIComponent(candidate_id) + "&order=created_at.asc,id.asc";
      const licRes = await fetch(licUrl, {
        headers: { "apikey": SUPABASE_SERVICE_ROLE_KEY, "Authorization": "Bearer " + SUPABASE_SERVICE_ROLE_KEY },
      });
      const licRows: any[] = licRes.ok ? await licRes.json() : [];
      const queueStatusById = new Map(rows.map((r: any) => [r.id, r.status]));
      const licenses = licRows.map((l: any) => {
        const qStatus = l.queue_item_id ? queueStatusById.get(l.queue_item_id) : null;
        return {
          id: l.id,
          linkedCertificationId: l.linked_certification_id || null,
          name: l.certification_items?.name || null,
          issuingBody: l.certification_items?.issuing_body || null,
          licenseNumber: l.certification_items?.license_number || null,
          state: l.state || null,
          outcome: l.verification_outcome || null,
          queueItemId: l.queue_item_id || null,
          // Locked once verified / confirmed / a discrepancy is open (matches update-license-details).
          editable: l.verification_outcome !== "verified" && qStatus !== "Confirmed" && qStatus !== "Discrepancy",
          correction: l.correction_status === "requested"
            ? { status: "requested", reason: l.correction_reason || null, message: l.correction_message || null }
            : null,
          finding: licenseFinding(l, qStatus === "Confirmed"),
        };
      });

      return new Response(JSON.stringify({ ok: true, items, licenses }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    } catch (e) {
      return new Response(JSON.stringify({ ok: false, error: "unhandled", detail: String(e) }), {
        status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
  }),
};
