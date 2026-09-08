// Setup type definitions for built-in Supabase Runtime APIs
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { withSupabase } from "jsr:@supabase/server@1";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "content-type",
};

// Item C (2026-09-08 session): read-only tier check, keyed by candidate_id alone — no session
// token required. Built for the signup-time paid-tier pop-up checkout (see
// startSignupPaidCheckout's own header in candidate.html): that flow is deliberately a pop-up, not
// a full-page redirect, so the main window's own component instance — and resumeCandidateId — is
// never destroyed, and it can't reuse resolve-session's own re-check loop the way
// handleCheckoutReturn does post-signup (resolve-session needs a session token; this needs only the
// candidate_id already in memory there). This is the same real-webhook-race concern as that
// function's own header — test-stripe-webhook fires independently of the pop-up's redirect back, no
// ordering guarantee — so the signup flow polls this after the pop-up reports success, rather than
// trusting the pop-up's own redirect alone.
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
