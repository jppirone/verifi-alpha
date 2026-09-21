// Setup type definitions for built-in Supabase Runtime APIs
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { withSupabase } from "jsr:@supabase/server@1";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "content-type, authorization, apikey",
};

// Master feed pause (2026-09-21): reads or sets candidates.feed_paused_at, the one switch that says "do not include my data in any licensed feed".
// Not tied to any partner. Body: { candidate_id, session_token, paused? }: with `paused` (boolean) it sets, without it it only reads.
// Setting is idempotent: pausing an already-paused candidate keeps the original timestamp; un-pausing clears it.
// Auth: the candidate's OWN live session (same check as set-discoverable) or the service-role key. Anything else is the same 401.
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
      if (body.paused !== undefined && typeof body.paused !== "boolean") return json({ ok: false, error: "paused_must_be_boolean" }, 400);

      const read = async () => {
        const r = await fetch(`${SUPABASE_URL}/rest/v1/candidates?id=eq.${candidateId}&select=feed_paused_at`, { headers: REST });
        return r.ok ? ((await r.json())[0] ?? null) : undefined;
      };
      let row = await read();
      if (row === undefined) return json({ ok: false, error: "read_failed" }, 500);
      if (row === null) return json({ ok: false, error: "candidate_not_found" }, 404);

      if (typeof body.paused === "boolean") {
        const want = body.paused;
        if (want !== !!row.feed_paused_at) {
          // Conditional on the state we just read, so two racing requests cannot stamp twice or un-do each other silently.
          const filter = want ? "feed_paused_at=is.null" : "feed_paused_at=not.is.null";
          const r = await fetch(`${SUPABASE_URL}/rest/v1/candidates?id=eq.${candidateId}&${filter}`, {
            method: "PATCH", headers: { ...REST, "Prefer": "return=minimal" },
            body: JSON.stringify({ feed_paused_at: want ? new Date().toISOString() : null }),
          });
          if (!r.ok) return json({ ok: false, error: "update_failed" }, 500);
          row = await read();
          if (!row) return json({ ok: false, error: "read_failed" }, 500);
        }
      }
      return json({ ok: true, paused: !!row.feed_paused_at, paused_at: row.feed_paused_at });
    } catch (_e) {
      return json({ ok: false, error: "unhandled" }, 500);
    }
  }),
};
