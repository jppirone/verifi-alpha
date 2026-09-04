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
type CertificationEdit = { id: string; name?: string; issuing_body?: string; issue_date?: string; expiration_date?: string };
type FreeformEdit = { id: string; content?: string };

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
        work_history = [], education = [], certifications = [], freeform = [],
        opt_in = { work_history: false, education: false, certifications: false },
      }: {
        candidate_id: string;
        work_history: WorkHistoryEdit[];
        education: EducationEdit[];
        certifications: CertificationEdit[];
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
      for (const w of work_history) {
        const { error } = await supabase.from("work_history_items").update({
          company: w.company ?? null, title: w.title ?? null,
          start_date: dateOrNull(w.start_date), end_date: dateOrNull(w.end_date),
          job_responsibilities: w.job_responsibilities ?? null,
          candidate_confirmed: true, updated_at: new Date().toISOString(),
        }).eq("id", w.id).eq("candidate_id", candidate_id);
        if (error) {
          return new Response(JSON.stringify({ ok: false, error: "work_history_update_failed", detail: error.message, item_id: w.id }), {
            status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        }
      }
      for (const e of education) {
        const { error } = await supabase.from("education_items").update({
          institution: e.institution ?? null, degree: e.degree ?? null, field_of_study: e.field_of_study ?? null,
          start_date: dateOrNull(e.start_date), end_date: dateOrNull(e.end_date),
          candidate_confirmed: true, updated_at: new Date().toISOString(),
        }).eq("id", e.id).eq("candidate_id", candidate_id);
        if (error) {
          return new Response(JSON.stringify({ ok: false, error: "education_update_failed", detail: error.message, item_id: e.id }), {
            status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        }
      }
      for (const c of certifications) {
        const { error } = await supabase.from("certification_items").update({
          name: c.name ?? null, issuing_body: c.issuing_body ?? null,
          issue_date: dateOrNull(c.issue_date), expiration_date: dateOrNull(c.expiration_date),
          candidate_confirmed: true, updated_at: new Date().toISOString(),
        }).eq("id", c.id).eq("candidate_id", candidate_id);
        if (error) {
          return new Response(JSON.stringify({ ok: false, error: "certification_update_failed", detail: error.message, item_id: c.id }), {
            status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        }
      }
      for (const f of freeform) {
        const { error } = await supabase.from("candidate_freeform_sections").update({
          content: f.content ?? null, candidate_confirmed: true, updated_at: new Date().toISOString(),
        }).eq("id", f.id).eq("candidate_id", candidate_id);
        if (error) {
          return new Response(JSON.stringify({ ok: false, error: "freeform_update_failed", detail: error.message, item_id: f.id }), {
            status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        }
      }

      // Opted-in categories → real staff-queue intake, one verification_items row per confirmed
      // item in that category.
      const today = new Date().toISOString().slice(0, 10);
      const queueInserts: Record<string, unknown>[] = [];

      if (opt_in.work_history) {
        for (const w of work_history) {
          const { data: idRow } = await supabase.rpc("nextval_verification_item_id");
          queueInserts.push({
            id: idRow, candidate_id, type: "Job Experience", claim: claimForWorkHistory(w), received: today,
          });
        }
      }
      if (opt_in.education) {
        for (const e of education) {
          const { data: idRow } = await supabase.rpc("nextval_verification_item_id");
          queueInserts.push({
            id: idRow, candidate_id, type: "Education", claim: claimForEducation(e), received: today,
          });
        }
      }
      if (opt_in.certifications) {
        for (const c of certifications) {
          const { data: idRow } = await supabase.rpc("nextval_verification_item_id");
          queueInserts.push({
            id: idRow, candidate_id, type: "Certification", claim: claimForCertification(c), received: today,
          });
        }
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
        confirmed_counts: { work_history: work_history.length, education: education.length, certifications: certifications.length, freeform: freeform.length },
        queued_for_verification: queueInserts.length,
      }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
    } catch (e) {
      return new Response(JSON.stringify({ ok: false, error: "unhandled", detail: String(e) }), {
        status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
  }),
};
