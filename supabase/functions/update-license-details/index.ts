// Setup type definitions for built-in Supabase Runtime APIs
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { withSupabase } from "jsr:@supabase/server@1";
import { createClient } from "jsr:@supabase/supabase-js@2";

// update-license-details: the candidate's post-confirm edit surface for the two fields automatic
// license verification depends on — the issuing STATE and the LICENSE NUMBER — and the resubmit half
// of the self-correction loop (see verify-license's routing notes). Not tier-gated: this is a
// functional correction path, available to every account (full-resume of either tier, and
// license-only).
//
// Record model: the number lives on the license's certification_items row (the single record of the
// credential); the state lives on the 1:1 license_items extension. Saving writes both, then re-runs
// verify-license exactly as the first attempt would. A save that changes neither the state nor the
// number after an earlier attempt is rejected (nothing new to check) — the candidate's other option
// is action "dismiss": "these details are correct", which leaves the license candidate-stated and
// asks staff for nothing.
//
// Locked once verified (or once staff have confirmed / raised a discrepancy on it): editing a
// verified license's number or state would let a candidate swap what was verified.

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "content-type",
};

const VALID_STATE_CODES = new Set("AL AK AZ AR CA CO CT DE DC FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY".split(" "));

function normNumber(s: unknown): string {
  return typeof s === "string" ? s.replace(/[\s\-‐-―]/g, "").toUpperCase() : "";
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
    if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
    const json = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
    try {
      const authBody = await req.clone().json().catch(() => ({}));
      const authDenied = await authGateCandidate(req, authBody);
      if (authDenied) return authDenied;
      const body = await req.json();
      const { candidate_id, license_item_id } = body;
      const action = body.action === "dismiss" ? "dismiss" : "save";
      if (!candidate_id || !license_item_id) return json({ ok: false, error: "candidate_id and license_item_id are required" }, 400);

      const { data: item } = await supabase.from("license_items").select("*")
        .eq("id", license_item_id).eq("candidate_id", candidate_id).maybeSingle();
      if (!item) return json({ ok: false, error: "license_item_not_found" }, 404);
      const { data: cert } = await supabase.from("certification_items").select("id, license_number")
        .eq("id", item.linked_certification_id).eq("candidate_id", candidate_id).maybeSingle();
      if (!cert) return json({ ok: false, error: "certification_not_found" }, 404);

      let queueStatus: string | null = null;
      if (item.queue_item_id) {
        const { data: q } = await supabase.from("verification_items").select("status").eq("id", item.queue_item_id).maybeSingle();
        queueStatus = q?.status ?? null;
      }
      if (item.verification_outcome === "verified" || queueStatus === "Confirmed" || queueStatus === "Discrepancy") {
        return json({ ok: false, error: "locked" }, 409);
      }

      if (action === "dismiss") {
        if (item.correction_status !== "requested") return json({ ok: false, error: "nothing_to_dismiss" }, 409);
        await supabase.from("license_items").update({ correction_status: "dismissed", updated_at: new Date().toISOString() }).eq("id", item.id);
        return json({ ok: true, dismissed: true });
      }

      const stateProvided = typeof body.state === "string";
      const numberProvided = typeof body.license_number === "string";
      if (!stateProvided && !numberProvided) return json({ ok: false, error: "state or license_number is required" }, 400);

      let newState: string | null = item.state;
      if (stateProvided) {
        const c = body.state.trim().toUpperCase();
        if (c && !VALID_STATE_CODES.has(c)) return json({ ok: false, error: "invalid_state" }, 400);
        newState = c || null;
      }
      const newNumberRaw: string | null = numberProvided ? (body.license_number.trim() || null) : cert.license_number;

      const hadAttempt = (item.verification_attempts || 0) > 0;
      const changed = (newState || null) !== (item.checked_state || null) || normNumber(newNumberRaw) !== (item.checked_number || "");
      // An untouched resubmission after a check has nothing new to verify; and note item.checked_*
      // hold the NORMALIZED number the last check actually used, so formatting-only edits (adding a
      // hyphen or space) also count as no change.
      if (hadAttempt && !changed) return json({ ok: false, error: "no_change" }, 409);

      const now = new Date().toISOString();
      if (numberProvided) {
        const { error: certErr } = await supabase.from("certification_items")
          .update({ license_number: newNumberRaw, updated_at: now }).eq("id", cert.id).eq("candidate_id", candidate_id);
        if (certErr) return json({ ok: false, error: "save_failed", detail: certErr.message }, 500);
      }
      const stateChanged = (newState || null) !== (item.state || null);
      const { error: liErr } = await supabase.from("license_items").update({
        state: newState,
        state_source: newState ? (stateChanged ? "candidate" : item.state_source) : null,
        state_evidence: stateChanged ? null : item.state_evidence,
        correction_status: null, correction_reason: null, correction_message: null, correction_requested_at: null,
        updated_at: now,
      }).eq("id", item.id);
      if (liErr) return json({ ok: false, error: "save_failed", detail: liErr.message }, 500);

      // Re-run the same check the first attempt used. A no-match that survives a genuine correction
      // goes to staff (after_correction), everything else routes exactly as before.
      let result: unknown = null;
      try {
        const vRes = await fetch(`${SUPABASE_URL}/functions/v1/verify-license`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "apikey": SUPABASE_SERVICE_ROLE_KEY,
            "Authorization": `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
          },
          body: JSON.stringify({ candidate_id, license_item_id: item.id, after_correction: hadAttempt && changed }),
          signal: AbortSignal.timeout(45000),
        });
        result = await vRes.json().catch(() => null);
      } catch (_e) {
        result = null;
      }
      return json({ ok: true, saved: true, result });
    } catch (e) {
      return json({ ok: false, error: "unhandled", detail: String(e) }, 500);
    }
  }),
};
