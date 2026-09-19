// Setup type definitions for built-in Supabase Runtime APIs
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { withSupabase } from "jsr:@supabase/server@1";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "content-type",
};

// Item 11 (2026-09-13 live-testing session): the License Status tab's real data source for
// license_only accounts. Deliberately NOT get-resume-extraction — that function is keyed entirely
// off a resume_documents row (see its own RESUME_DOC_SELECT/effectiveDoc logic), and a license_only
// candidate structurally never has one; calling it would just return resume_document: null and no
// certifications key at all. This reads certification_items directly by candidate_id instead, the
// same table Item 8's license_number/trade_soc_code fields already live on — a license-only
// candidate's row there always has resume_document_id: null (see confirm-verification's own header),
// so ordering by created_at (not position, which only ever means something relative to a resume's
// own layout) is the right default here.
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

      const res = await fetch(
        `${SUPABASE_URL}/rest/v1/certification_items?candidate_id=eq.${encodeURIComponent(candidate_id)}&select=id,name,issuing_body,license_number,trade_soc_code,issue_date,issue_date_precision,expiration_date,expiration_date_precision,status,candidate_confirmed,created_at&order=created_at.asc`,
        { headers: { "apikey": SUPABASE_SERVICE_ROLE_KEY, "Authorization": `Bearer ${SUPABASE_SERVICE_ROLE_KEY}` } },
      );
      if (!res.ok) {
        const errText = await res.text();
        return new Response(JSON.stringify({ ok: false, error: "fetch_failed", detail: errText }), {
          status: 502, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      const licenses = await res.json();

      // Automatic license verification: a license is this certification row plus its 1:1 license_items
      // extension (see confirm-verification). Joined here so the License Status tab can show a real
      // outcome, and offer the edit / self-correction surface, instead of the never-written
      // certification_items.status.
      const restHeaders = { "apikey": SUPABASE_SERVICE_ROLE_KEY, "Authorization": `Bearer ${SUPABASE_SERVICE_ROLE_KEY}` };
      const liRes = await fetch(
        `${SUPABASE_URL}/rest/v1/license_items?candidate_id=eq.${encodeURIComponent(candidate_id)}&select=id,linked_certification_id,state,verification_outcome,queue_item_id,correction_status,correction_reason,correction_message`,
        { headers: restHeaders },
      );
      const liRows: any[] = liRes.ok ? await liRes.json() : [];
      const queueIds = liRows.map((l) => l.queue_item_id).filter(Boolean);
      const queueRows: any[] = queueIds.length
        ? await fetch(`${SUPABASE_URL}/rest/v1/verification_items?id=in.(${queueIds.map(encodeURIComponent).join(",")})&select=id,status`, { headers: restHeaders }).then((r) => r.ok ? r.json() : [])
        : [];
      const queueStatusById = new Map(queueRows.map((q) => [q.id, q.status]));
      const verificationByCert = new Map(liRows.map((l) => {
        const qStatus = l.queue_item_id ? queueStatusById.get(l.queue_item_id) : null;
        return [l.linked_certification_id, {
          license_item_id: l.id,
          state: l.state || null, outcome: l.verification_outcome || null,
          verified: qStatus === "Confirmed",
          editable: l.verification_outcome !== "verified" && qStatus !== "Confirmed" && qStatus !== "Discrepancy",
          correction: l.correction_status === "requested"
            ? { status: "requested", reason: l.correction_reason || null, message: l.correction_message || null }
            : null,
        }];
      }));
      for (const lic of licenses) lic.verification = verificationByCert.get(lic.id) || null;

      return new Response(JSON.stringify({ ok: true, licenses }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    } catch (e) {
      return new Response(JSON.stringify({ ok: false, error: "unhandled", detail: String(e) }), {
        status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
  }),
};
