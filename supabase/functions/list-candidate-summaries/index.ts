// Setup type definitions for built-in Supabase Runtime APIs
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { withSupabase } from "jsr:@supabase/server@1";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "content-type",
};

// Item B (2026-09-08 session): read side of the Content Manager's named-summary-versions feature —
// real backend for what used to be seedSummaries(), a pure client fixture (two hardcoded literals,
// reset every reload, see candidate_summary_versions' own migration header for the full history).
//
// Auto-seed-on-first-visit: a candidate's very first call here (zero rows in
// candidate_summary_versions) creates ONE default version for them, seeded from the real,
// already-wired resume-extracted summary (candidate_freeform_sections where section_type =
// 'summary') — never blank, never invented, same document-provenance discipline as everywhere
// else in this build: the starting point traces back to something real from the uploaded
// document. origin = 'resume_extracted' marks this row's content as having started there — set
// once, at this insert, and never touched again by any later edit (see the migration's own
// header for why that matters). If this candidate genuinely has no extracted summary (skipped
// resume upload, or the resume had no professional-summary section), the default version is
// still created — an honest empty starting point, same convention already used elsewhere in this
// build for "nothing was actually printed" (e.g. education/work_history location) — rather than
// fabricating placeholder text just to have something to show.
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const SB_HEADERS = {
  "apikey": SUPABASE_SERVICE_ROLE_KEY,
  "Authorization": `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
};

export default {
  fetch: withSupabase({ auth: "none" }, async (req, _ctx) => {
    if (req.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }
    try {
      const { candidate_id } = await req.json();
      if (!candidate_id || typeof candidate_id !== "string") {
        return new Response(JSON.stringify({ ok: false, error: "candidate_id is required" }), {
          status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      const listRes = await fetch(
        `${SUPABASE_URL}/rest/v1/candidate_summary_versions?candidate_id=eq.${encodeURIComponent(candidate_id)}&order=created_at.asc`,
        { headers: SB_HEADERS },
      );
      if (!listRes.ok) {
        const detail = await listRes.text();
        return new Response(JSON.stringify({ ok: false, error: "lookup_failed", detail }), {
          status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      let summaries = await listRes.json();

      if (Array.isArray(summaries) && summaries.length === 0) {
        // First visit — seed the one default version from the real extracted summary.
        const freeformRes = await fetch(
          `${SUPABASE_URL}/rest/v1/candidate_freeform_sections?candidate_id=eq.${encodeURIComponent(candidate_id)}&section_type=eq.summary&select=content&limit=1`,
          { headers: SB_HEADERS },
        );
        let extractedContent = "";
        if (freeformRes.ok) {
          const rows = await freeformRes.json();
          if (Array.isArray(rows) && rows.length > 0 && typeof rows[0].content === "string") {
            extractedContent = rows[0].content;
          }
        }

        const insertRes = await fetch(`${SUPABASE_URL}/rest/v1/candidate_summary_versions`, {
          method: "POST",
          headers: {
            ...SB_HEADERS,
            "Content-Type": "application/json",
            "Prefer": "return=representation",
          },
          body: JSON.stringify({
            candidate_id,
            name: "Default summary",
            content: extractedContent,
            origin: "resume_extracted",
            partner_key: "",
          }),
        });
        if (!insertRes.ok) {
          const detail = await insertRes.text();
          return new Response(JSON.stringify({ ok: false, error: "seed_failed", detail }), {
            status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        }
        summaries = await insertRes.json();
      }

      return new Response(JSON.stringify({ ok: true, summaries }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    } catch (e) {
      return new Response(JSON.stringify({ ok: false, error: "unhandled", detail: String(e) }), {
        status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
  }),
};
