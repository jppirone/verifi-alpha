// Setup type definitions for built-in Supabase Runtime APIs
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { withSupabase } from "jsr:@supabase/server@1";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "content-type",
};

// Item B (2026-09-08 session): the "delete" half of the Content Manager's named-summary-versions
// feature — see candidate_summary_versions' own migration header for the full feature history.
// candidate_id is part of the WHERE clause, the same real scoping check update-candidate-summary
// uses — a request naming someone else's summary id can never delete it.
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

export default {
  fetch: withSupabase({ auth: "none" }, async (req, _ctx) => {
    if (req.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }
    try {
      const { candidate_id, id } = await req.json();
      if (!candidate_id || typeof candidate_id !== "string" || !id || typeof id !== "string") {
        return new Response(JSON.stringify({ ok: false, error: "candidate_id and id are required" }), {
          status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      const res = await fetch(
        `${SUPABASE_URL}/rest/v1/candidate_summary_versions?id=eq.${encodeURIComponent(id)}&candidate_id=eq.${encodeURIComponent(candidate_id)}`,
        {
          method: "DELETE",
          headers: {
            "apikey": SUPABASE_SERVICE_ROLE_KEY,
            "Authorization": `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
            "Prefer": "return=representation",
          },
        },
      );
      if (!res.ok) {
        const detail = await res.text();
        return new Response(JSON.stringify({ ok: false, error: "delete_failed", detail }), {
          status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      const rows = await res.json();
      if (!Array.isArray(rows) || rows.length === 0) {
        return new Response(JSON.stringify({ ok: false, error: "not_found" }), {
          status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ ok: true }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    } catch (e) {
      return new Response(JSON.stringify({ ok: false, error: "unhandled", detail: String(e) }), {
        status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
  }),
};
