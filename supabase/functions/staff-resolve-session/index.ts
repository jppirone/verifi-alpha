// Setup type definitions for built-in Supabase Runtime APIs
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { withSupabase } from "jsr:@supabase/server@1";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "content-type",
};

// The function that makes a staff session real across visits, not just at the moment it's issued —
// mirrors resolve-session exactly, against staff_sessions/staff_users instead of
// candidate_sessions/candidates. staff.html calls this on every load with whatever raw session
// token it finds in localStorage; no valid session means the login screen, full stop — this is the
// function that makes that true, not just an assumed default.
//
// Only the hash is ever compared — the raw token is never itself stored anywhere (see
// staff_sessions in the migration). A revoked or expired session, or one that simply doesn't match
// any hash, all return the same ok:false — there is no reachable path from "no valid session" into
// the portal.
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
        `${SUPABASE_URL}/rest/v1/staff_sessions?token_hash=eq.${tokenHash}&select=id,staff_user_id,expires_at,revoked_at`,
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

      const staffRes = await fetch(
        `${SUPABASE_URL}/rest/v1/staff_users?id=eq.${session.staff_user_id}&select=id,email,name,role`,
        { headers: { "apikey": SUPABASE_SERVICE_ROLE_KEY, "Authorization": `Bearer ${SUPABASE_SERVICE_ROLE_KEY}` } },
      );
      const staffRows = staffRes.ok ? await staffRes.json() : [];
      const staffUser = staffRows[0];
      if (!staffUser) {
        return new Response(JSON.stringify({ ok: false, error: "staff_user_not_found" }), {
          status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      // Best-effort — a failed last_seen_at update shouldn't fail an otherwise-valid session
      // resolution.
      fetch(`${SUPABASE_URL}/rest/v1/staff_sessions?id=eq.${session.id}`, {
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
        email: staffUser.email,
        name: staffUser.name,
        role: staffUser.role,
      }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
    } catch (e) {
      return new Response(JSON.stringify({ ok: false, error: "unhandled", detail: String(e) }), {
        status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
  }),
};
