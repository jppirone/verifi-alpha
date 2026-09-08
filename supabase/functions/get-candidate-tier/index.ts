// Setup type definitions for built-in Supabase Runtime APIs
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { withSupabase } from "jsr:@supabase/server@1";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "content-type",
};

// Item C (2026-09-08 session): read-only tier check, keyed by candidate_id alone — no session
// token required. Originally built for the signup-time paid-tier pop-up checkout, which couldn't
// reuse resolve-session's own re-check loop (resolve-session needs a session token; a pop-up-based
// flow only ever has the candidate_id in memory). candidate.html no longer calls this: that flow was
// switched from a pop-up to a full-page redirect (see startRealCheckout's own header) once it turned
// out a session token genuinely does exist by that point in signup, so it now reuses
// resolve-session's own retry loop directly, same as every other real checkout return in this file.
// Left deployed as a small, real, standalone read-only utility — useful for exactly this kind of
// live verification independent of a session (candidate_id in, tier out), and a plausible template
// for employer.html's own future payment-paths session if it ends up needing the same id-only shape
// keyed by whatever its own id is.
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

export default {
  fetch: withSupabase({ auth: "none" }, async (req, _ctx) => {
    if (req.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }
    try {
      const { candidate_id } = await req.json();
      if (!candidate_id || typeof candidate_id !== "string") {
        return new Response(JSON.stringify({ ok: false, error: "candidate_id_required" }), {
          status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      const res = await fetch(
        `${SUPABASE_URL}/rest/v1/candidates?id=eq.${encodeURIComponent(candidate_id)}&select=tier`,
        { headers: { "apikey": SUPABASE_SERVICE_ROLE_KEY, "Authorization": `Bearer ${SUPABASE_SERVICE_ROLE_KEY}` } },
      );
      if (!res.ok) {
        return new Response(JSON.stringify({ ok: false, error: "lookup_failed" }), {
          status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      const rows = await res.json();
      const candidate = rows[0];
      if (!candidate) {
        return new Response(JSON.stringify({ ok: false, error: "candidate_not_found" }), {
          status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      return new Response(JSON.stringify({ ok: true, tier: candidate.tier }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    } catch (e) {
      return new Response(JSON.stringify({ ok: false, error: "unhandled", detail: String(e) }), {
        status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
  }),
};
