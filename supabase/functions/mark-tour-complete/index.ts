// Setup type definitions for built-in Supabase Runtime APIs
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { withSupabase } from "jsr:@supabase/server@1";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "content-type",
};

// Item 8 (2026-09-11 status-check session): the write side of tour_completed_at (see the
// migration's own header for the full root-cause story — tourEverShown used to be pure
// in-memory React state, reset to false on every fresh mount, which is what actually forced the
// onboarding tour to reactivate and accountTab to reset on every page load, not just after
// checkout). Called once, from candidate.html's tourExit, the moment a candidate actually
// finishes or explicitly exits the tour — never set any other way, and never unset (finishing
// the tour is a one-time, one-directional fact, same as employer_contact_resolved_at).
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

      const res = await fetch(`${SUPABASE_URL}/rest/v1/candidates?id=eq.${encodeURIComponent(candidate_id)}`, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          "apikey": SUPABASE_SERVICE_ROLE_KEY,
          "Authorization": `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
          "Prefer": "return=representation",
        },
        body: JSON.stringify({ tour_completed_at: new Date().toISOString() }),
      });
      if (!res.ok) {
        const detail = await res.text();
        return new Response(JSON.stringify({ ok: false, error: "update_failed", detail }), {
          status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      const rows = await res.json();
      if (!Array.isArray(rows) || rows.length === 0) {
        return new Response(JSON.stringify({ ok: false, error: "candidate_not_found" }), {
          status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      return new Response(JSON.stringify({ ok: true, tour_completed_at: rows[0].tour_completed_at }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    } catch (e) {
      return new Response(JSON.stringify({ ok: false, error: "unhandled", detail: String(e) }), {
        status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
  }),
};
