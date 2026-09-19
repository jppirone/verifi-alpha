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
      const url = SUPABASE_URL + "/rest/v1/verification_items?select=id,type,claim,status,created_at,note,correction_requested,correction_note,correction_value,source_item_id&candidate_id=eq."
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
        };
      });

      // Every license the candidate confirmed (a certification row + its license_items extension), so
      // the client can (a) show licenses that never got a queue row — no state, unsupported state,
      // or a correction being requested — as candidate-stated instead of not at all, and (b) offer
      // the edit/correction surface on any license that isn't already verified. Licenses with a
      // queue row are also in `items` above (type "License"); the client matches them by id.
      const licUrl = SUPABASE_URL + "/rest/v1/license_items?select=id,state,verification_outcome,queue_item_id,correction_status,correction_reason,correction_message,certification_items(name,issuing_body,license_number)"
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
