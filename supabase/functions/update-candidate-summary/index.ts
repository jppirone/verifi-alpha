// Setup type definitions for built-in Supabase Runtime APIs
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { withSupabase } from "jsr:@supabase/server@1";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "content-type",
};

// Item B (2026-09-08 session): the "edit" half of the Content Manager's named-summary-versions
// feature — see candidate_summary_versions' own migration header for the full feature history.
// origin is deliberately NOT accepted here and never touched by this update: it's an immutable
// provenance flag set once at creation (list-candidate-summaries' auto-seed, or create-candidate-
// summary) so a candidate can edit a version's name/content/partner freely — including the one
// that started as their real extracted summary — while still being able to trace which row that
// was. Same treatment as job_responsibilities elsewhere in this build: candidate-authored content,
// never re-verified, edited in place.
//
// candidate_id is included in the WHERE clause, not just the row lookup by id — a real scoping
// check, not just a courtesy: a request naming someone else's summary id can never touch it,
// same discipline confirm-resume-data's own update loop already established (a zero-row PostgREST
// update is NOT an error on its own, so this checks the returned row count explicitly rather than
// trusting a 200 with an empty body).
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

export default {
  fetch: withSupabase({ auth: "none" }, async (req, _ctx) => {
    if (req.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }
    try {
      const { candidate_id, id, name, content, partner_key } = await req.json();
      if (!candidate_id || typeof candidate_id !== "string" || !id || typeof id !== "string") {
        return new Response(JSON.stringify({ ok: false, error: "candidate_id and id are required" }), {
          status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
      if (typeof name === "string") patch.name = name.trim() || "Untitled summary";
      if (typeof content === "string") patch.content = content;
      if (typeof partner_key === "string") patch.partner_key = partner_key;

      const res = await fetch(
        `${SUPABASE_URL}/rest/v1/candidate_summary_versions?id=eq.${encodeURIComponent(id)}&candidate_id=eq.${encodeURIComponent(candidate_id)}`,
        {
          method: "PATCH",
          headers: {
            "apikey": SUPABASE_SERVICE_ROLE_KEY,
            "Authorization": `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
            "Content-Type": "application/json",
            "Prefer": "return=representation",
          },
          body: JSON.stringify(patch),
        },
      );
      if (!res.ok) {
        const detail = await res.text();
        return new Response(JSON.stringify({ ok: false, error: "update_failed", detail }), {
          status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      const rows = await res.json();
      if (!Array.isArray(rows) || rows.length === 0) {
        return new Response(JSON.stringify({ ok: false, error: "not_found" }), {
          status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ ok: true, summary: rows[0] }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    } catch (e) {
      return new Response(JSON.stringify({ ok: false, error: "unhandled", detail: String(e) }), {
        status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
  }),
};
