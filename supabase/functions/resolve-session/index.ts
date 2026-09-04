// Setup type definitions for built-in Supabase Runtime APIs
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { withSupabase } from "jsr:@supabase/server@1";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "content-type",
};

// The function that makes a persisted session real across visits, not just at the moment it's
// issued: candidate.html calls this on every page load with whatever raw session token it finds
// in localStorage. This is the direct fix for the real gap Part 1 confirmed — before tonight,
// nothing on load ever checked for return access at all; everyone landed on signupDetails
// regardless of whether a real, confirmed candidate was sitting right there.
//
// Only the hash is ever compared — the raw token this function receives is never itself stored
// anywhere (see candidate_sessions in the migration). A revoked or expired session, or one that
// simply doesn't match any hash, all return the same ok:false — the client's only correct response
// to any of them is "you're not logged in," not a reason to distinguish and act on differently.
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

async function hashToken(raw: string): Promise<string> {
  const bytes = new TextEncoder().encode(raw);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

export default {
  fetch: withSupabase({ auth: "none" }, async (req, _ctx) => {
    if (req.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }
    try {
      const { session_token } = await req.json();
      if (!session_token || typeof session_token !== "string") {
        return new Response(JSON.stringify({ ok: false, error: "session_token_required" }), {
          status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      const tokenHash = await hashToken(session_token);

      const sessRes = await fetch(
        `${SUPABASE_URL}/rest/v1/candidate_sessions?token_hash=eq.${tokenHash}&select=id,candidate_id,expires_at,revoked_at`,
        { headers: { "apikey": SUPABASE_SERVICE_ROLE_KEY, "Authorization": `Bearer ${SUPABASE_SERVICE_ROLE_KEY}` } },
      );
      if (!sessRes.ok) {
        return new Response(JSON.stringify({ ok: false, error: "lookup_failed" }), {
          status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      const sessRows = await sessRes.json();
      const session = sessRows[0];

      if (!session || session.revoked_at || new Date(session.expires_at) < new Date()) {
        return new Response(JSON.stringify({ ok: false, error: "invalid_session" }), {
          status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      const candRes = await fetch(
        `${SUPABASE_URL}/rest/v1/candidates?id=eq.${session.candidate_id}&select=id,email,phone,full_name`,
        { headers: { "apikey": SUPABASE_SERVICE_ROLE_KEY, "Authorization": `Bearer ${SUPABASE_SERVICE_ROLE_KEY}` } },
      );
      const candRows = candRes.ok ? await candRes.json() : [];
      const candidate = candRows[0];
      if (!candidate) {
        return new Response(JSON.stringify({ ok: false, error: "candidate_not_found" }), {
          status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      // Best-effort — a failed last_seen_at update shouldn't fail an otherwise-valid session
      // resolution.
      fetch(`${SUPABASE_URL}/rest/v1/candidate_sessions?id=eq.${session.id}`, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          "apikey": SUPABASE_SERVICE_ROLE_KEY,
          "Authorization": `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
          "Prefer": "return=minimal",
        },
        body: JSON.stringify({ last_seen_at: new Date().toISOString() }),
      }).catch(() => {});

      return new Response(JSON.stringify({
        ok: true,
        candidate_id: candidate.id,
        email: candidate.email,
        phone: candidate.phone,
        full_name: candidate.full_name,
      }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
    } catch (e) {
      return new Response(JSON.stringify({ ok: false, error: "unhandled", detail: String(e) }), {
        status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
  }),
};
