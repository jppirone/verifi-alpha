// Setup type definitions for built-in Supabase Runtime APIs
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { withSupabase } from "jsr:@supabase/server@1";
import { createClient } from "jsr:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "content-type",
};

// Resume Upload → OCR → Structured Extraction Pipeline (Alpha) — step 3 of 3.
//
// Accepts the candidate's edited version of every extracted row plus which categories they opted
// into verification (the same opt-in-checkbox pattern already in candidate.html: optInWorkHistory /
// toggleOptInWorkHistory etc. on the isPreview screen — this reuses that concept, not a new toggle
// model). For each row: write the candidate's (possibly corrected) field values and set
// candidate_confirmed = true. For each category the candidate opted into, insert one
// verification_items row per confirmed item in that category — real staff-queue intake, same table
// staff.html already reads, same 'New' default status every other queue item gets.
//
// verification_items.type uses the real literal strings already live in that table (confirmed via
// direct query before writing this: "Job Experience", "Education", "Certification" — not invented
// here). verification_items.id is `text`, not uuid (also confirmed live) — new ids are generated
// via verification_item_id_seq (see migration) as 'VQ-' || nextval(...), matching the visible shape
// of real existing ids like "VQ-1034"; the exact original generator wasn't reachable before this
// session's browser tool connection dropped mid-build, so this is a considered, documented
// decision, not a reverse-engineered match — flagged plainly, not silently assumed identical.

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

type WorkHistoryEdit = { id: string; company?: string; title?: string; start_date?: string; end_date?: string; job_responsibilities?: string };
type EducationEdit = { id: string; institution?: string; degree?: string; field_of_study?: string; start_date?: string; end_date?: string };
// source_match is echoed back by the client (candidate.html already has it, straight from
// get-resume-extraction) for the same reason section_type/heading are on FreeformEdit below — this
// function only needs it to decide which certifications get the unconditional staff flag, not to
// validate anything. See the queueInserts loop for why an unmatched cert overrides opt-in rather
// than needing it.
type CertificationEdit = { id: string; name?: string; issuing_body?: string; issue_date?: string; expiration_date?: string; source_match?: string };
// section_type/heading are echoed back by the client (candidate.html already has them, straight
// from get-resume-extraction) rather than re-fetched here — this function only needs them to decide
// which freeform rows are needs_review for the staff-queue flag below, not to validate anything.
type FreeformEdit = { id: string; content?: string; section_type?: string; heading?: string };
type SkillEdit = { id: string; skill_text?: string };

function dateOrNull(v: unknown): string | null {
  return typeof v === "string" && v.trim() !== "" ? v : null;
}

function claimForWorkHistory(w: WorkHistoryEdit): string {
  const dates = [w.start_date, w.end_date || "Present"].filter(Boolean).join(" – ");
  return [w.title, w.company, dates].filter(Boolean).join(", ");
}
function claimForEducation(e: EducationEdit): string {
  const dates = [e.start_date, e.end_date].filter(Boolean).join(" – ");
  return [e.degree, e.field_of_study, e.institution, dates].filter(Boolean).join(", ");
}
function claimForCertification(c: CertificationEdit): string {
  return [c.name, c.issuing_body, c.issue_date].filter(Boolean).join(", ");
}
// Truncated, not the full content — this is a queue-list preview (claim), not the review surface
// itself; internal_note below carries the full, untruncated content plus the reason it's flagged.
function claimForNeedsReview(f: FreeformEdit): string {
  const heading = (f.heading || "").trim();
  const content = (f.content || "").trim();
  const preview = content.length > 140 ? content.slice(0, 140) + "…" : content;
  return heading ? `${heading}: ${preview}` : preview || "(no heading, no content)";
}

export default {
  fetch: withSupabase({ auth: "none" }, async (req, _ctx) => {
    if (req.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }
    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

    try {
      const body = await req.json();
      const {
        candidate_id,
        work_history = [], education = [], certifications = [], skills = [], freeform = [],
        opt_in = { work_history: false, education: false, certifications: false },
      }: {
        candidate_id: string;
        work_history: WorkHistoryEdit[];
        education: EducationEdit[];
        certifications: CertificationEdit[];
        skills: SkillEdit[];
        freeform: FreeformEdit[];
        opt_in: { work_history: boolean; education: boolean; certifications: boolean };
      } = body;

      if (!candidate_id) {
        return new Response(JSON.stringify({ ok: false, error: "candidate_id is required" }), {
          status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      // Write candidate's (possibly corrected) fields and mark each row confirmed. Sequential, not
      // parallel — keeps error reporting attributable to a specific row if one update fails.
      //
      // .select("id") + a zero-row check on every one of these 5 loops — real gap found investigating
      // a session-refresh bug report (2026-09-07): Supabase's update() does NOT set `error` when the
      // filter matches zero rows (a stale id, or a candidate_id mismatch) — it just silently succeeds
      // having changed nothing. Since candidate.html's checkResumeFlowIncomplete relies on every
      // extracted row eventually getting candidate_confirmed=true, a silent zero-row update here would
      // leave that one row permanently "incomplete" — re-routing a genuinely-finished candidate back to
      // resumeConfirm forever, with no error ever surfaced to explain why. Verified live before this
      // was written: a deliberately stale id on one category now returns a real error instead of a
      // false ok:true.
      for (const w of work_history) {
        const { data, error } = await supabase.from("work_history_items").update({
          company: w.company ?? null, title: w.title ?? null,
          start_date: dateOrNull(w.start_date), end_date: dateOrNull(w.end_date),
          job_responsibilities: w.job_responsibilities ?? null,
          candidate_confirmed: true, updated_at: new Date().toISOString(),
        }).eq("id", w.id).eq("candidate_id", candidate_id).select("id");
        if (error || !data || data.length === 0) {
          return new Response(JSON.stringify({ ok: false, error: "work_history_update_failed", detail: error ? error.message : "no matching row for this candidate", item_id: w.id }), {
            status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        }
      }
      for (const e of education) {
        const { data, error } = await supabase.from("education_items").update({
          institution: e.institution ?? null, degree: e.degree ?? null, field_of_study: e.field_of_study ?? null,
          start_date: dateOrNull(e.start_date), end_date: dateOrNull(e.end_date),
          candidate_confirmed: true, updated_at: new Date().toISOString(),
        }).eq("id", e.id).eq("candidate_id", candidate_id).select("id");
        if (error || !data || data.length === 0) {
          return new Response(JSON.stringify({ ok: false, error: "education_update_failed", detail: error ? error.message : "no matching row for this candidate", item_id: e.id }), {
            status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        }
      }
      for (const c of certifications) {
        const { data, error } = await supabase.from("certification_items").update({
          name: c.name ?? null, issuing_body: c.issuing_body ?? null,
          issue_date: dateOrNull(c.issue_date), expiration_date: dateOrNull(c.expiration_date),
          candidate_confirmed: true, updated_at: new Date().toISOString(),
        }).eq("id", c.id).eq("candidate_id", candidate_id).select("id");
        if (error || !data || data.length === 0) {
          return new Response(JSON.stringify({ ok: false, error: "certification_update_failed", detail: error ? error.message : "no matching row for this candidate", item_id: c.id }), {
            status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        }
      }
      // Skills: candidate-self-reported, same trust level as freeform (summary/hobbies_other) —
      // never enters the verification_items staff queue below, matching freeform's own lifecycle.
      // No opt-in flag for skills exists (it was never one of the three categories collected at
      // signup, and this build doesn't add a fourth) — deliberately out of scope, not an oversight.
      for (const sk of skills) {
        const { data, error } = await supabase.from("skill_items").update({
          skill_text: sk.skill_text ?? "", candidate_confirmed: true, updated_at: new Date().toISOString(),
        }).eq("id", sk.id).eq("candidate_id", candidate_id).select("id");
        if (error || !data || data.length === 0) {
          return new Response(JSON.stringify({ ok: false, error: "skill_update_failed", detail: error ? error.message : "no matching row for this candidate", item_id: sk.id }), {
            status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        }
      }
      for (const f of freeform) {
        const { data, error } = await supabase.from("candidate_freeform_sections").update({
          content: f.content ?? null, candidate_confirmed: true, updated_at: new Date().toISOString(),
        }).eq("id", f.id).eq("candidate_id", candidate_id).select("id");
        if (error || !data || data.length === 0) {
          return new Response(JSON.stringify({ ok: false, error: "freeform_update_failed", detail: error ? error.message : "no matching row for this candidate", item_id: f.id }), {
            status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        }
      }

      // Opted-in categories → real staff-queue intake, one verification_items row per confirmed
      // item in that category.
      //
      // status: "New" is set explicitly on every push below, INCLUDING these three, even though
      // "New" is also the column's own DB default — a real bug, caught live testing this exact
      // change: Supabase's PostgREST batches one JS array into a single INSERT built from the
      // UNION of keys across every object in the array. Once the needs_review push further down
      // started setting `status` explicitly (it has to — "Needs Reconciliation", not "New"), that
      // widened the batch's column list to include `status` for every row in the same call, and a
      // row that doesn't supply a key POSTgREST includes in that widened column list gets an
      // explicit NULL, not the column default — NULL only falls back to a DEFAULT when the column
      // is omitted from the statement entirely, which stops being true once a sibling row in the
      // same batch supplies it. That surfaced as a real NOT NULL violation on `status` the moment
      // a needs_review row and an opted-in row were confirmed in the same request. Setting it
      // explicitly here removes the dependency on batch-shape entirely.
      const today = new Date().toISOString().slice(0, 10);
      const queueInserts: Record<string, unknown>[] = [];

      if (opt_in.work_history) {
        for (const w of work_history) {
          const { data: idRow } = await supabase.rpc("nextval_verification_item_id");
          queueInserts.push({
            id: idRow, candidate_id, type: "Job Experience", claim: claimForWorkHistory(w), received: today, status: "New",
          });
        }
      }
      if (opt_in.education) {
        for (const e of education) {
          const { data: idRow } = await supabase.rpc("nextval_verification_item_id");
          queueInserts.push({
            id: idRow, candidate_id, type: "Education", claim: claimForEducation(e), received: today, status: "New",
          });
        }
      }
      // Certifications: one queue row per item, EXCEPT this is the one category where a real
      // structural signal can override plain opt-in — see certification_source_match's own
      // migration for the full reasoning (bug-2 defense-in-depth). An item whose source_match is
      // 'unmatched' (its name isn't traceable, even loosely, to anything in the document's own OCR
      // text) gets flagged UNCONDITIONALLY, the same non-blocking-but-flagged pattern already used
      // for needs_review below — real fabrication risk doesn't become less real just because the
      // candidate happened not to check the "submit for verification" box for that one item. A
      // matched or not-independently-checkable ('matched'/'not_checked'/null) item follows the
      // ordinary opt-in rule exactly as before. Each certification contributes AT MOST one row
      // either way — never both — so opting in never double-inserts.
      for (const c of certifications) {
        const unmatched = c.source_match === "unmatched";
        if (!unmatched && !opt_in.certifications) continue;
        const { data: idRow } = await supabase.rpc("nextval_verification_item_id");
        queueInserts.push(unmatched ? {
          id: idRow, candidate_id, type: "Certification", claim: claimForCertification(c), received: today,
          status: "Needs Reconciliation",
          internal_note: `Auto-flagged: this certification's name did not fuzzy-match anything in the candidate's own uploaded document (OCR'd text) — see certification_source_match. Not proof of fabrication (OCR coverage has real, documented gaps: vision-routed pages have no OCR text at all), but real enough to warrant a human look before treating it as verified. Name as extracted: ${JSON.stringify(c.name || "")}`,
        } : {
          id: idRow, candidate_id, type: "Certification", claim: claimForCertification(c), received: today, status: "New",
        });
      }

      // needs_review → staff visibility, unconditional (NOT gated by any opt_in flag above).
      // needs_review was never one of the three verification categories a candidate opts into —
      // this isn't a verification submission, it's an internal review flag. The reason: needs_review
      // is the one place on this screen that is NOT validated against the uploaded document by a
      // defined schema (company/title/dates etc. all trace back to a real structured field the way
      // Job Responsibilities is the only free-typed field elsewhere in this build) — which makes it
      // also the one place a candidate COULD try to slip in additional job-description-style claims
      // under cover of "content my resume already had." This does not block the candidate (their
      // update above already went through, same as every other category) and does not touch or
      // weaken the document-provenance rule for the validated fields — it only adds staff
      // visibility into this specific catch-all content, using the exact non-blocking-but-flagged
      // pattern already live for automated-check ambiguity: status 'Needs Reconciliation' (see
      // staff.html's own header on that status — never shown to or implied to the candidate).
      // list-candidate-verification-items excludes type 'Needs Review' from what the candidate's own
      // status tab reads back, so this never surfaces to them as a "verification item pending
      // review," which it genuinely isn't.
      for (const f of freeform) {
        if (f.section_type !== "needs_review") continue;
        const { data: idRow } = await supabase.rpc("nextval_verification_item_id");
        queueInserts.push({
          id: idRow,
          candidate_id,
          type: "Needs Review",
          claim: claimForNeedsReview(f),
          received: today,
          status: "Needs Reconciliation",
          internal_note: `Auto-flagged: unstructured content from the candidate's resume that didn't map to a defined category (heading: ${JSON.stringify(f.heading || "(none)")}). Not independently validated against the uploaded document the way the structured fields above it are — review for anything that reads like an inserted job-description-style claim rather than content genuinely present on the original resume. Full content:\n\n${f.content || ""}`,
        });
      }

      if (queueInserts.length) {
        const { error: queueErr } = await supabase.from("verification_items").insert(queueInserts);
        if (queueErr) {
          return new Response(JSON.stringify({ ok: false, error: "verification_queue_insert_failed", detail: queueErr.message }), {
            status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        }
      }

      return new Response(JSON.stringify({
        ok: true,
        confirmed_counts: { work_history: work_history.length, education: education.length, certifications: certifications.length, skills: skills.length, freeform: freeform.length },
        queued_for_verification: queueInserts.length,
      }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
    } catch (e) {
      return new Response(JSON.stringify({ ok: false, error: "unhandled", detail: String(e) }), {
        status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
  }),
};
