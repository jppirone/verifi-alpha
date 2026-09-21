// Setup type definitions for built-in Supabase Runtime APIs
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { withSupabase } from "jsr:@supabase/server@1";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "content-type, authorization, apikey",
};

// get-customization (2026-09-21): the candidate's reconciled resume = the confirmed resume data with their customization applied and each item's
// verification status joined read-only (assemble_customized_resume; see 20260921090000_customization_stage1.sql).
//   POST { candidate_id, session_token, view? }   view 'editor' (default): every item with an `included` flag; view 'delivered': excluded items dropped
//   (what the candidate's PDF and any future feed consume).
// Auth: the candidate's OWN live session, or the service-role key. Anything else is the same 401. Read-only: nothing is written.
// Customization is applied only while the candidate is paid; a free candidate gets the un-customized data with customization.entitled = false.
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const REST = { "apikey": SERVICE_KEY, "Authorization": `Bearer ${SERVICE_KEY}`, "Content-Type": "application/json" };
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
  return !!t && !!SERVICE_KEY && safeEqual(t, SERVICE_KEY);
}
async function isCandidateSession(body: any, candidateId: string): Promise<boolean> {
  const tok = typeof body?.session_token === "string" ? body.session_token : "";
  if (tok.length < 20 || tok.length > 200 || !candidateId) return false;
  const r = await fetch(`${SUPABASE_URL}/rest/v1/candidate_sessions?token_hash=eq.${await sha256Hex(tok)}&select=candidate_id,expires_at,revoked_at`, { headers: REST });
  const sess = r.ok ? (await r.json())[0] : null;
  return !!sess && !sess.revoked_at && new Date(sess.expires_at).getTime() > Date.now() && sess.candidate_id === candidateId;
}
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });

export default {
  fetch: withSupabase({ auth: "none" }, async (req, _ctx) => {
    if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
    try {
      const body = await req.json().catch(() => ({}));
      const candidateId = typeof body?.candidate_id === "string" ? body.candidate_id : "";
      if (!(isServiceCaller(req) || (UUID_RE.test(candidateId) && await isCandidateSession(body, candidateId)))) return json({ ok: false, error: "unauthorized" }, 401);
      if (!UUID_RE.test(candidateId)) return json({ ok: false, error: "candidate_id_required" }, 400);
      if (body.view !== undefined && body.view !== "editor" && body.view !== "delivered") return json({ ok: false, error: "bad_view" }, 400);

      const r = await fetch(`${SUPABASE_URL}/rest/v1/rpc/assemble_customized_resume`, {
        method: "POST", headers: REST,
        body: JSON.stringify({ p_candidate: candidateId, p_ignore_overrides: false, p_delivered_only: body.view === "delivered" }),
      });
      if (!r.ok) return json({ ok: false, error: "assemble_failed" }, 500);
      const resume = await r.json();
      return json({ ok: true, resume });
    } catch (_e) {
      return json({ ok: false, error: "unhandled" }, 500);
    }
  }),
};
