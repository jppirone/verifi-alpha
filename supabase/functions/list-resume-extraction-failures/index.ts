// Setup type definitions for built-in Supabase Runtime APIs
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { withSupabase } from "jsr:@supabase/server@1";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "content-type",
};

// Real, minimal staff visibility for a confirmed-live gap: a candidate whose resume extraction
// fails and who never reaches the verification queue had zero trace visible to staff before this —
// confirmed by querying production directly and finding two real candidates in exactly this state
// (john.pirone@gmail.com, jpirone@yahoo.com), and by confirming staff.html never read
// resume_documents at all. Deliberately narrow, per this task's own scope: a list of candidates
// whose most recent resume_documents row failed AND who have zero verification_items rows at all
// (nothing ever got far enough to reach the staff queue) — not a UI for fixing the extraction
// failure itself, and not a manual-entry/side-by-side editing interface. That stays exactly what it
// already is: the candidate emails the document directly. This is only the "staff knows a failure
// happened" half of the gap.
//
// continued_without_data_at (see 20260906010000_resume_extraction_failure_visibility.sql and
// skip-resume-extraction) is returned as-is, null or set, so staff can tell "candidate explicitly
// continued anyway" from "never acknowledged the failure at all" — both need outreach, but they're
// no longer indistinguishable.
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

export default {
  fetch: withSupabase({ auth: "none" }, async (req, _ctx) => {
    if (req.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }
    try {
      const headers = { "apikey": SUPABASE_SERVICE_ROLE_KEY, "Authorization": `Bearer ${SUPABASE_SERVICE_ROLE_KEY}` };

      const docsRes = await fetch(
        `${SUPABASE_URL}/rest/v1/resume_documents?select=id,candidate_id,uploaded_at,continued_without_data_at&extraction_status=eq.failed&order=uploaded_at.desc`,
        { headers },
      );
      if (!docsRes.ok) {
        const detail = await docsRes.text();
        return new Response(JSON.stringify({ ok: false, error: "fetch_failed", detail }), {
          status: 502, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      const docs = await docsRes.json();
      if (docs.length === 0) {
        return new Response(JSON.stringify({ ok: true, items: [] }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      // One row per candidate — their most recent failed document, since docs is already ordered
      // newest-first and this keeps only the first (most recent) row seen per candidate_id. Rows
      // with no candidate_id at all (a real case found live: an upload attempt that never got tied
      // to an account) are skipped here — there's no candidate to reach out to, and leaving one in
      // would poison every "in.(...)" filter built from candidateIds below with a literal "null",
      // which fails the whole request rather than just that one row (confirmed live: this silently
      // zeroed out candidateName/candidateEmail/candidatePhone for every real candidate, not just
      // the null one, until this filter was added).
      const latestByCandidate = new Map<string, any>();
      for (const d of docs) {
        if (!d.candidate_id) continue;
        if (!latestByCandidate.has(d.candidate_id)) latestByCandidate.set(d.candidate_id, d);
      }
      const candidateIds = Array.from(latestByCandidate.keys());

      // Excluded entirely once a candidate has ANY verification_items row — the moment even one
      // real item exists, they've reached the staff queue some other way (a later successful
      // upload, opting into a category, etc.) and this list's whole point — nothing to see — no
      // longer applies to them.
      const vqRes = await fetch(
        `${SUPABASE_URL}/rest/v1/verification_items?select=candidate_id&candidate_id=in.(${candidateIds.map(encodeURIComponent).join(",")})`,
        { headers },
      );
      const vqRows = vqRes.ok ? await vqRes.json() : [];
      const hasQueueItems = new Set(vqRows.map((r: any) => r.candidate_id));

      const relevantIds = candidateIds.filter((id) => !hasQueueItems.has(id));
      if (relevantIds.length === 0) {
        return new Response(JSON.stringify({ ok: true, items: [] }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      const candRes = await fetch(
        `${SUPABASE_URL}/rest/v1/candidates?select=id,email,phone,full_name,first_name,last_name&id=in.(${relevantIds.map(encodeURIComponent).join(",")})`,
        { headers },
      );
      const candRows = candRes.ok ? await candRes.json() : [];
      const candidateById = new Map(candRows.map((c: any) => [c.id, c]));

      const items = relevantIds.map((id) => {
        const doc = latestByCandidate.get(id);
        const cand: any = candidateById.get(id) || {};
        return {
          candidateId: id,
          // Same first_name/last_name-preferred, full_name-fallback convention as
          // list-verification-items — first_name/last_name is what a real signup writes now,
          // full_name is what every candidate who signed up before that change has instead.
          candidateName: [cand.first_name, cand.last_name].filter(Boolean).join(" ") || cand.full_name || null,
          candidateEmail: cand.email || null,
          candidatePhone: cand.phone || null,
          uploadedAt: doc.uploaded_at,
          continuedWithoutDataAt: doc.continued_without_data_at,
        };
      });

      return new Response(JSON.stringify({ ok: true, items }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    } catch (e) {
      return new Response(JSON.stringify({ ok: false, error: "unhandled", detail: String(e) }), {
        status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
  }),
};
