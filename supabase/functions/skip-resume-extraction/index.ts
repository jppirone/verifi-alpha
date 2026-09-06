// Setup type definitions for built-in Supabase Runtime APIs
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { withSupabase } from "jsr:@supabase/server@1";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "content-type",
};

// The real write behind candidate.html's "Continue without resume data" button (skipResumeConfirm,
// shown after an extraction failure). Before this function existed, that button was a pure
// client-side screen transition with no network call at all — confirmed directly against
// production: two real candidates (john.pirone@gmail.com, jpirone@yahoo.com) sit today with
// resume_documents.extraction_status = 'failed' and zero verification_items, with nothing in the
// database able to say whether they explicitly chose to continue or simply never came back. This
// closes that: marks the candidate's most recent resume_documents row with a real timestamp the
// moment they click through, so list-resume-extraction-failures (and anyone querying directly) can
// tell "explicitly continued anyway" from "never acknowledged" — see
// 20260906010000_resume_extraction_failure_visibility.sql for the column itself.
//
// Deliberately narrow: this does not touch extraction_status, does not retry anything, and does
// not attempt to fix the failure — it only records that the candidate chose to move on. Fixing the
// failure itself stays exactly what it already is (candidate emails the document directly),
// explicitly out of scope for this task.
//
// Best-effort by design, matching this codebase's existing convention for this kind of bookkeeping
// write (see resolve-session's last_seen_at update): candidate.html calls this after already
// transitioning the screen, not before, so a slow or failed request here never blocks or breaks
// the candidate's own flow. A missed write here costs staff a slightly stale signal, not a broken
// experience for the candidate.
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

export default {
  fetch: withSupabase({ auth: "none" }, async (req, _ctx) => {
    if (req.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }
    try {
      const { candidate_id } = await req.json();
      if (!candidate_id || typeof candidate_id !== "string") {
        return new Response(JSON.stringify({ ok: false, error: "candidate_id_required" }), {
          status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      const docRes = await fetch(
        `${SUPABASE_URL}/rest/v1/resume_documents?candidate_id=eq.${encodeURIComponent(candidate_id)}&select=id&order=uploaded_at.desc&limit=1`,
        { headers: { "apikey": SUPABASE_SERVICE_ROLE_KEY, "Authorization": `Bearer ${SUPABASE_SERVICE_ROLE_KEY}` } },
      );
      if (!docRes.ok) {
        return new Response(JSON.stringify({ ok: false, error: "lookup_failed" }), {
          status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      const docRows = await docRes.json();
      const doc = docRows[0];
      if (!doc) {
        // No resume_documents row at all for this candidate — nothing to mark. Not an error the
        // candidate did anything wrong about; just nothing for this function to do.
        return new Response(JSON.stringify({ ok: true, marked: false }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      const patchRes = await fetch(
        `${SUPABASE_URL}/rest/v1/resume_documents?id=eq.${doc.id}`,
        {
          method: "PATCH",
          headers: {
            "Content-Type": "application/json",
            "apikey": SUPABASE_SERVICE_ROLE_KEY,
            "Authorization": `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
            "Prefer": "return=minimal",
          },
          body: JSON.stringify({ continued_without_data_at: new Date().toISOString() }),
        },
      );
      if (!patchRes.ok) {
        const errText = await patchRes.text();
        return new Response(JSON.stringify({ ok: false, error: "update_failed", detail: errText }), {
          status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      return new Response(JSON.stringify({ ok: true, marked: true }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    } catch (e) {
      return new Response(JSON.stringify({ ok: false, error: "unhandled", detail: String(e) }), {
        status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
  }),
};
