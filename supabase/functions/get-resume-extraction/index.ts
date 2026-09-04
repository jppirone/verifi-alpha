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
// extraction_status is returned as-is EXCEPT for one real, confirmed failure mode: a Supabase
// Edge Function CPU-time kill (real limit, confirmed live against a real resume photo tonight —
// 2 seconds CPU time, uniform across every plan tier, verified against Supabase's own current
// docs rather than assumed) terminates the isolate directly. That bypasses upload-resume's own
// catch block entirely, so the row is left at 'pending' (or extract-resume-fields' equivalent
// kill leaves it at 'ocr_done') forever — no exception was ever thrown for anything to catch.
// There is no reachable path back to the client from a dead isolate, so nothing upstream can mark
// this row failed at the moment it happens. This function is the one place that DOES get a chance
// to notice: if a document has sat in 'pending' or 'ocr_done' past STALE_SECONDS, no real run
// legitimately takes that long (every successful OCR+extraction run tonight finished in single-digit
// seconds), so it's treated as dead and corrected to 'failed' right here, in the database, not just
// in this response — an honest self-heal on read, not a client-side illusion of failure while the
// stored row still claims 'pending'. This is what turns "candidate reaches the confirm screen and
// sees 'still processing' forever with no way to know it already died" into a real, accurate
// failed state they can act on.
const STALE_SECONDS = 60;

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

      let effectiveStatus = doc.extraction_status;
      const ageSeconds = (Date.now() - new Date(doc.uploaded_at).getTime()) / 1000;
      if ((effectiveStatus === "pending" || effectiveStatus === "ocr_done") && ageSeconds > STALE_SECONDS) {
        const { error: healErr } = await supabase
          .from("resume_documents")
          .update({ extraction_status: "failed" })
          .eq("id", doc.id)
          .eq("extraction_status", effectiveStatus); // no-op if another request already healed/advanced it
        if (!healErr) effectiveStatus = "failed";
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
        resume_document: { ...doc, extraction_status: effectiveStatus, original_signed_url: signed.data?.signedUrl ?? null },
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
