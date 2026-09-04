// Setup type definitions for built-in Supabase Runtime APIs
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { withSupabase } from "jsr:@supabase/server@1";
import { createClient } from "jsr:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "content-type",
};

// Resume Upload → OCR → Structured Extraction Pipeline (Alpha) — the read side.
//
// Not in the original build spec's 3-function list, added because none of upload-resume /
// extract-resume-fields / confirm-resume-data return the draft rows themselves — upload-resume
// returns a signed URL and an OCR status, extract-resume-fields returns counts, confirm-resume-data
// only accepts edits. Something has to hand the candidate's browser the actual data to review and
// edit on the "Confirm your resume data" screen, and a signed URL to render the original. This is
// that: read-only, takes a candidate_id (real, backfilled — this screen is reached only after
// confirm-verification succeeds), returns the most recent resume_documents row for that candidate
// plus every draft row tied to it.
//
// extraction_status is returned as-is so the client can show a "still processing" state rather
// than an empty form if the candidate reaches this screen before extract-resume-fields has
// finished (a real race: confirm-verification can complete before the earlier, async
// upload→OCR→extract chain has).

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const BUCKET = "resume-documents";

export default {
  fetch: withSupabase({ auth: "none" }, async (req, _ctx) => {
    if (req.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }
    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
    try {
      const { candidate_id } = await req.json();
      if (!candidate_id) {
        return new Response(JSON.stringify({ ok: false, error: "candidate_id is required" }), {
          status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      const { data: doc, error: docErr } = await supabase
        .from("resume_documents")
        .select("id, original_storage_path, original_filename, mime_type, extraction_status, uploaded_at")
        .eq("candidate_id", candidate_id)
        .order("uploaded_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (docErr) {
        return new Response(JSON.stringify({ ok: false, error: "lookup_failed", detail: docErr.message }), {
          status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      if (!doc) {
        return new Response(JSON.stringify({ ok: true, resume_document: null }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      const [workHistory, education, certifications, freeform, signed] = await Promise.all([
        supabase.from("work_history_items").select("*").eq("resume_document_id", doc.id).order("start_date", { ascending: false }),
        supabase.from("education_items").select("*").eq("resume_document_id", doc.id).order("start_date", { ascending: false }),
        supabase.from("certification_items").select("*").eq("resume_document_id", doc.id).order("issue_date", { ascending: false }),
        supabase.from("candidate_freeform_sections").select("*").eq("resume_document_id", doc.id),
        supabase.storage.from(BUCKET).createSignedUrl(doc.original_storage_path, 3600),
      ]);

      return new Response(JSON.stringify({
        ok: true,
        resume_document: { ...doc, original_signed_url: signed.data?.signedUrl ?? null },
        work_history: workHistory.data ?? [],
        education: education.data ?? [],
        certifications: certifications.data ?? [],
        freeform: freeform.data ?? [],
      }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
    } catch (e) {
      return new Response(JSON.stringify({ ok: false, error: "unhandled", detail: String(e) }), {
        status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
  }),
};
