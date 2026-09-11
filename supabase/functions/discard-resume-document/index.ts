// Setup type definitions for built-in Supabase Runtime APIs
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { withSupabase } from "jsr:@supabase/server@1";
import { createClient } from "jsr:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "content-type",
};

// Item 1 (2026-09-11 status-check session, CRITICAL) — the real backend behind "reject this /
// start over" on resumeConfirm. Real sequence reproduced this week: a candidate saw content
// misclassified into needs_review and wanted to reject/restart, but Confirm was the only
// available forward action on the screen — forced to click Confirm just to escape a bad state,
// not because the data was approved. This closes that gap: a candidate can now discard the
// current resume_document and everything extracted from it BEFORE ever confirming, and get a
// genuinely clean slate to upload a different file into.
//
// Deletes real rows, not a soft flag — discard_resume_document (see its own migration) does the
// atomic multi-table delete (work_history_items/education_items/certification_items/skill_items/
// candidate_freeform_sections, then resume_documents itself), scoped to (resume_document_id,
// candidate_id) so a candidate can only ever discard their own document. Storage objects
// (original_storage_path / sanitized_render_path) are deleted here, best-effort, immediately
// after — a Postgres function can't reach Supabase Storage directly (see the RPC's own note), and
// a failure here doesn't fail the discard itself: the DB rows are already gone, which is what
// actually matters for "restarts extraction cleanly on the new upload" — an orphaned storage
// object with no DB row pointing to it is inert, not a functional bug.
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const BUCKET = "resume-documents";

export default {
  fetch: withSupabase({ auth: "none" }, async (req, _ctx) => {
    if (req.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }
    try {
      const { candidate_id, resume_document_id } = await req.json();
      if (!candidate_id || typeof candidate_id !== "string") {
        return new Response(JSON.stringify({ ok: false, error: "candidate_id_required" }), {
          status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      if (!resume_document_id || typeof resume_document_id !== "string") {
        return new Response(JSON.stringify({ ok: false, error: "resume_document_id_required" }), {
          status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      // Look up storage paths BEFORE the RPC deletes the row — nothing to read them from after.
      const lookupRes = await fetch(
        `${SUPABASE_URL}/rest/v1/resume_documents?id=eq.${resume_document_id}&candidate_id=eq.${candidate_id}&select=original_storage_path,sanitized_render_path`,
        { headers: { "apikey": SUPABASE_SERVICE_ROLE_KEY, "Authorization": `Bearer ${SUPABASE_SERVICE_ROLE_KEY}` } },
      );
      const lookupRows = lookupRes.ok ? await lookupRes.json() : [];
      const doc = lookupRows[0];
      if (!doc) {
        return new Response(JSON.stringify({ ok: false, error: "not_found" }), {
          status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      const rpcRes = await fetch(`${SUPABASE_URL}/rest/v1/rpc/discard_resume_document`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "apikey": SUPABASE_SERVICE_ROLE_KEY,
          "Authorization": `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
        },
        body: JSON.stringify({ p_resume_document_id: resume_document_id, p_candidate_id: candidate_id }),
      });
      if (!rpcRes.ok) {
        const errText = await rpcRes.text();
        return new Response(JSON.stringify({ ok: false, error: "discard_failed", detail: errText }), {
          status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      const paths = [doc.original_storage_path, doc.sanitized_render_path].filter(Boolean);
      if (paths.length) {
        const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
        await supabase.storage.from(BUCKET).remove(paths).catch(() => {});
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
