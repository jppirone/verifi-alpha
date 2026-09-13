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
// Edge Function CPU-time kill terminates the isolate directly. That bypasses upload-resume's own
// catch block entirely, so the row is left at 'pending' (or extract-resume-fields' equivalent
// kill leaves it at 'ocr_done') forever — no exception was ever thrown for anything to catch.
// There is no reachable path back to the client from a dead isolate, so nothing upstream can mark
// this row failed at the moment it happens. This function is the one place that DOES get a chance
// to notice: if a document has sat in 'pending' or 'ocr_done' past STALE_SECONDS, it's treated as
// dead and corrected to 'failed' right here, in the database, not just in this response — an
// honest self-heal on read, not a client-side illusion of failure while the stored row still
// claims 'pending'.
//
// Item 1 (2026-09-08 regression session, SEV0): STALE_SECONDS was 60, set from "every successful
// OCR+extraction run tonight finished in single-digit seconds" — that was true for the small
// tesseract-OCR image path this was originally tuned against, but PDFs (upload-resume's PDF
// branch) run the WHOLE pipeline synchronously in the same request — one rasterize-pdf-page call
// per page, each a real network-bound vision/OCR call, merged and inserted before this row ever
// leaves 'pending' — and never pass through 'ocr_done' at all. Reproduced live, directly timed,
// against both real test documents this session: a 2-page PDF ("726," previously verified fast
// and reliable) took 86.7s end-to-end; a 4-page PDF ("626") took 39.5s on one run — real variance
// tied to concurrent platform load (see upload-resume's own RASTERIZE RETRY CONTRACT comment for
// why), not a fixed per-document number. At 60s, this self-heal was firing WHILE the real
// upload-resume invocation was still genuinely in flight and about to succeed: it flipped the row
// to 'failed' in the database, the candidate.html poll immediately showed the "we couldn't read
// that document" screen and (see loadResumeExtraction) stopped polling entirely, and moments later
// the real upload-resume call finished, inserted the real extracted rows, and overwrote
// extraction_status back to 'extracted' — correctly, in the database — but with no one left
// listening. 240s keeps real headroom (2.5x+) above every real timing measured so far while still
// bounding a genuinely dead isolate to a few minutes rather than forever. This alone doesn't fully
// close the race for an even slower document — see candidate.html's loadResumeExtraction for the
// other half of this fix: the client no longer stops polling on 'failed', so even if this
// threshold is still someday too short, a false positive self-corrects instead of stranding the
// candidate on a dead-end screen.
const STALE_SECONDS = 240;

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

      // continued_without_data_at added for candidate.html's checkResumeFlowIncomplete (real dead-
      // end fix, 2026-09-07): the signal that distinguishes "candidate explicitly clicked past this
      // via skip-resume-extraction" from "never got back to it" — without it, applySession's
      // returning-session check has no way to tell those two apart and would keep re-routing an
      // intentional skip back into resumeConfirm forever.
      // employer_contact_resolved_at added for Item C (2026-09-08): same class of signal, one step
      // later in the flow — see checkEmployerContactIncomplete's own header in candidate.html.
      const RESUME_DOC_SELECT = "id, original_storage_path, original_filename, mime_type, extraction_status, uploaded_at, continued_without_data_at, employer_contact_resolved_at, candidate_location, printed_header";

      const { data: doc, error: docErr } = await supabase
        .from("resume_documents")
        .select(RESUME_DOC_SELECT)
        .eq("candidate_id", candidate_id)
        .order("uploaded_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (docErr) {
        return new Response(JSON.stringify({ ok: false, error: "lookup_failed", detail: docErr.message }), {
          status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      let effectiveDoc = doc;

      if (!effectiveDoc) {
        // Item 1 (2026-09-08 regression session) fallback-and-heal — a DEEPER race than the one the
        // re-read-before-insert fix (extract-resume-fields/upload-resume) and the sibling self-heal
        // below both cover, reproduced live with real concurrent timing evidence, not theorized:
        // confirm-verification's backfill_resume_pipeline_candidate_id runs ONCE, at signup
        // confirmation, and is fast (no LLM call) — a real Promise.all race against upload-resume
        // (storage upload + resume_documents insert, itself before any OCR/rasterize work even
        // starts) showed confirm-verification finishing in ~1.3s while upload-resume's own
        // resume_documents insert hadn't happened yet at 30s total. When the backfill runs before
        // the resume_documents ROW ITSELF exists, its own `where email_verification_id = ... and
        // candidate_id is null` matches nothing — not just the children, the resume_documents row
        // never gets linked at all, and nothing else ever re-runs that one-time backfill. The
        // sibling self-heal below can't reach this case either: it only ever runs once a `doc` has
        // already been found by candidate_id, which this exact corruption prevents from ever
        // matching. candidates.verification_id (set at insert time in confirm-verification, see its
        // own header) is the one durable link back to the original email_verifications row that
        // survives this — used here to find the orphaned resume_documents row directly and heal it
        // (parent + every child table) the moment this candidate's very first read reaches it,
        // rather than requiring a second migration/cleanup pass for a class of corruption this fix
        // didn't fully anticipate on the first attempt.
        const { data: cand } = await supabase
          .from("candidates")
          .select("continued_without_resume_at, verification_id")
          .eq("id", candidate_id)
          .maybeSingle();

        if (cand?.verification_id) {
          const { data: orphanDoc } = await supabase
            .from("resume_documents")
            .select(RESUME_DOC_SELECT)
            .eq("email_verification_id", cand.verification_id)
            .is("candidate_id", null)
            .order("uploaded_at", { ascending: false })
            .limit(1)
            .maybeSingle();

          if (orphanDoc) {
            await supabase.from("resume_documents").update({ candidate_id }).eq("id", orphanDoc.id).is("candidate_id", null);
            await Promise.all([
              supabase.from("work_history_items").update({ candidate_id }).eq("resume_document_id", orphanDoc.id).is("candidate_id", null),
              supabase.from("education_items").update({ candidate_id }).eq("resume_document_id", orphanDoc.id).is("candidate_id", null),
              supabase.from("certification_items").update({ candidate_id }).eq("resume_document_id", orphanDoc.id).is("candidate_id", null),
              supabase.from("skill_items").update({ candidate_id }).eq("resume_document_id", orphanDoc.id).is("candidate_id", null),
              supabase.from("candidate_freeform_sections").update({ candidate_id }).eq("resume_document_id", orphanDoc.id).is("candidate_id", null),
            ]).catch(() => {});
            effectiveDoc = orphanDoc;
          }
        }

        if (!effectiveDoc) {
          // continued_without_resume_at (candidates, not resume_documents — there is no
          // resume_documents row to check when no document was ever uploaded, see
          // skip-resume-extraction's "no doc" branch and its migration for the full reasoning) is the
          // zero-upload counterpart to continued_without_data_at above: same purpose, different table,
          // because this is the one candidate.html state where resume_documents structurally cannot
          // hold the signal.
          return new Response(JSON.stringify({
            ok: true, resume_document: null,
            continued_without_resume_at: cand?.continued_without_resume_at ?? null,
          }), {
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        }
      }

      let effectiveStatus = effectiveDoc.extraction_status;
      const ageSeconds = (Date.now() - new Date(effectiveDoc.uploaded_at).getTime()) / 1000;
      if ((effectiveStatus === "pending" || effectiveStatus === "ocr_done") && ageSeconds > STALE_SECONDS) {
        const { error: healErr } = await supabase
          .from("resume_documents")
          .update({ extraction_status: "failed" })
          .eq("id", effectiveDoc.id)
          .eq("extraction_status", effectiveStatus); // no-op if another request already healed/advanced it
        if (!healErr) effectiveStatus = "failed";
      }

      // Item 1 (2026-09-08 regression session) self-heal — the other half of this fix, alongside
      // the race-window shrink in extract-resume-fields/upload-resume (see either's own header for
      // the full mechanism): reproduced live against two real accounts, both permanently stuck on
      // confirm-resume-data because their work_history_items/education_items/certification_items/
      // skill_items/candidate_freeform_sections rows had candidate_id NULL despite THIS resume_
      // documents row's own candidate_id being real (the query above only returns rows where it
      // is). `effectiveDoc` is reached here only when candidate_id already matches the caller's real
      // candidate_id, so it's always correct to backfill any of this specific resume's children
      // still sitting at candidate_id IS NULL — same self-heal-on-read philosophy already
      // established above for stale extraction_status, applied to the other real corruption this
      // session found. Best-effort: a failure here doesn't block the read (the child rows returned
      // below are used to submit confirm-resume-data next, not read directly for correctness), and
      // running this on every read is cheap — each PATCH is a no-op once already healed. Redundant
      // (harmless no-op) on the fallback-and-heal path above, which already did this same repair for
      // that specific document — kept here too since this is the only path a `doc` found directly by
      // candidate_id on the FIRST query ever goes through.
      await Promise.all([
        supabase.from("work_history_items").update({ candidate_id }).eq("resume_document_id", effectiveDoc.id).is("candidate_id", null),
        supabase.from("education_items").update({ candidate_id }).eq("resume_document_id", effectiveDoc.id).is("candidate_id", null),
        supabase.from("certification_items").update({ candidate_id }).eq("resume_document_id", effectiveDoc.id).is("candidate_id", null),
        supabase.from("skill_items").update({ candidate_id }).eq("resume_document_id", effectiveDoc.id).is("candidate_id", null),
        supabase.from("candidate_freeform_sections").update({ candidate_id }).eq("resume_document_id", effectiveDoc.id).is("candidate_id", null),
      ]).catch(() => {});

      const [workHistory, education, certifications, skills, freeform, signed] = await Promise.all([
        supabase.from("work_history_items").select("*").eq("resume_document_id", effectiveDoc.id).order("start_date", { ascending: false }),
        supabase.from("education_items").select("*").eq("resume_document_id", effectiveDoc.id).order("start_date", { ascending: false }),
        supabase.from("certification_items").select("*").eq("resume_document_id", effectiveDoc.id).order("issue_date", { ascending: false }),
        // Ordered by position, not created_at — position is the resume's own original order
        // (see insert_resume_extraction), which matters here since skills are never a "ranking"
        // but candidates and any downstream view should still see them in the order the resume did.
        supabase.from("skill_items").select("*").eq("resume_document_id", effectiveDoc.id).order("position", { ascending: true }),
        supabase.from("candidate_freeform_sections").select("*").eq("resume_document_id", effectiveDoc.id),
        supabase.storage.from(BUCKET).createSignedUrl(effectiveDoc.original_storage_path, 3600),
      ]);

      return new Response(JSON.stringify({
        ok: true,
        resume_document: { ...effectiveDoc, extraction_status: effectiveStatus, original_signed_url: signed.data?.signedUrl ?? null },
        work_history: workHistory.data ?? [],
        education: education.data ?? [],
        certifications: certifications.data ?? [],
        skills: skills.data ?? [],
        freeform: freeform.data ?? [],
      }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
    } catch (e) {
      return new Response(JSON.stringify({ ok: false, error: "unhandled", detail: String(e) }), {
        status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
  }),
};
