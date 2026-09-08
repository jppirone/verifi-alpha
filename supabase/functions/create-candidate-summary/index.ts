// Setup type definitions for built-in Supabase Runtime APIs
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { withSupabase } from "jsr:@supabase/server@1";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "content-type",
};

// Item B (2026-09-08 session): the "+ New Summary" half of the Content Manager's named-summary-
// versions feature — see candidate_summary_versions' own migration header for the full feature
// history. origin is always 'candidate_created' here: the one 'resume_extracted' row per candidate
// is only ever made by list-candidate-summaries' own auto-seed path, never by this function —
// creating a new version is always a candidate action, never a re-import of the extraction.
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

export default {
  fetch: withSupabase({ auth: "none" }, async (req, _ctx) => {
    if (req.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }
    try {
      const { candidate_id, name, content, partner_key } = await req.json();
      if (!candidate_id || typeof candidate_id !== "string") {
        return new Response(JSON.stringify({ ok: false, error: "candidate_id is required" }), {
          status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      const res = await fetch(`${SUPABASE_URL}/rest/v1/candidate_summary_versions`, {
        method: "POST",
        headers: {
          "apikey": SUPABASE_SERVICE_ROLE_KEY,
          "Authorization": `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
          "Content-Type": "application/json",
          "Prefer": "return=representation",
        },
        body: JSON.stringify({
          candidate_id,
          name: (typeof name === "string" && name.trim()) || "Untitled summary",
          content: typeof content === "string" ? content : "",
          origin: "candidate_created",
          partner_key: typeof partner_key === "string" ? partner_key : "",
        }),
      });
      if (!res.ok) {
        const detail = await res.text();
        return new Response(JSON.stringify({ ok: false, error: "insert_failed", detail }), {
          status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      const rows = await res.json();
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
