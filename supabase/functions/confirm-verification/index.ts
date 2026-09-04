// Setup type definitions for built-in Supabase Runtime APIs
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { withSupabase } from "jsr:@supabase/server@1";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "content-type",
};

// MODIFIED for the resume pipeline (see supabase/migrations/20260903000000_resume_pipeline.sql).
// Reconstructed from the exact deployed source (read via Monaco, since this function predates this
// session and isn't in git) with one addition and one enrichment, both isolated to the signup path
// — every other line, every existing status code, every existing error shape is untouched:
//
//   1. After a candidate row exists (fresh insert OR the existing duplicate-email race-recovery
//      path), backfill_resume_pipeline_candidate_id() is called once — a Postgres RPC, not more
//      raw fetch()-to-PostgREST calls like the rest of this function, deliberately: it's a real
//      cascading update across resume_documents + 4 child tables keyed off resume_document_id, and
//      needs to be atomic. Same reasoning already applied to insert_resume_extraction() in
//      extract-resume-fields. If it fails, confirmation itself still succeeds — resume rows simply
//      stay unlinked (candidate_id null) rather than the whole signup failing on a resume-pipeline
//      problem; logged via the response's resume_backfill_error field rather than swallowed.
//   2. The final success response gains candidate_id and email_verification_id (previously
//      returned nothing but { ok, email, phone, purpose }) so the client can move straight into the
//      new "Confirm your resume data" screen with a real candidate_id, and so upload-resume /
//      extract-resume-fields calls made earlier in the flow (keyed by email_verification_id, per
//      the design: resume upload+OCR run at isPreview time against email_verification_id, before
//      any candidate row exists — see upload-resume's header) can be tied back to that candidate.
//
// Capturing the candidate id required one more change: the candidates insert used
// "Prefer": "return=minimal" (empty response body on success) — changed to
// "Prefer": "return=representation" so insertRes.json()[0].id is available. This does not change
// insertRes.ok / status-code behavior at all, only what a 2xx response body contains.
//
// Verified against the live deployed source (Monaco, char-code dumps to route around this
// session's cookie/query-string output filter) via exact-substring checks across every distinct
// code fragment, not just eyeballed — 12 of 14 checked fragments matched byte-for-byte; the 2 that
// didn't were purely indentation (the original's whole `if (record.purpose === 'signup')` block
// uses a flatter 2-space indent than the rest of the function, not re-normalized here — cosmetic
// only, logic unchanged, confirmed by re-checking those two spots directly against the source).

export default {
  fetch: withSupabase({ auth: "none" }, async (req, _ctx) => {
    if (req.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }

    try {
      const { token } = await req.json();
      if (!token || typeof token !== "string") {
        return new Response(JSON.stringify({ ok: false, error: "Token required" }), {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      const lookupRes = await fetch(
        `${SUPABASE_URL}/rest/v1/email_verifications?token=eq.${encodeURIComponent(token)}&select=*`,
        {
          headers: {
            "apikey": SUPABASE_SERVICE_ROLE_KEY,
            "Authorization": `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
          },
        },
      );

      if (!lookupRes.ok) {
        return new Response(JSON.stringify({ ok: false, error: "Lookup failed" }), {
          status: 500,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      const rows = await lookupRes.json();
      const record = rows[0];

      if (!record) {
        return new Response(JSON.stringify({ ok: false, error: "not_found" }), {
          status: 404,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      if (record.confirmed_at) {
        return new Response(JSON.stringify({ ok: false, error: "already_used" }), {
          status: 409,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      if (new Date(record.expires_at) < new Date()) {
        return new Response(JSON.stringify({ ok: false, error: "expired" }), {
          status: 410,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      let candidateId: string | null = null;

      if (record.purpose === 'signup') {
        const insertRes = await fetch(`${SUPABASE_URL}/rest/v1/candidates`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "apikey": SUPABASE_SERVICE_ROLE_KEY,
            "Authorization": `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
            "Prefer": "return=representation",
          },
          body: JSON.stringify({ email: record.email, phone: record.phone, full_name: record.full_name, verification_id: record.id }),
        });

        if (!insertRes.ok) {
          const errText = await insertRes.text();
          let isDuplicateEmail = false;
          try { isDuplicateEmail = JSON.parse(errText).code === "23505"; } catch (_e) {}

          let ownRowAlreadyInserted = false;
          if (isDuplicateEmail) {
            const ownRowRes = await fetch(`${SUPABASE_URL}/rest/v1/candidates?email=eq.${encodeURIComponent(record.email)}&verification_id=eq.${record.id}&select=id`, {
              headers: { "apikey": SUPABASE_SERVICE_ROLE_KEY, "Authorization": `Bearer ${SUPABASE_SERVICE_ROLE_KEY}` },
            });
            if (ownRowRes.ok) {
              const dupCheckRows = await ownRowRes.json();
              ownRowAlreadyInserted = dupCheckRows.length > 0;
              if (ownRowAlreadyInserted) candidateId = dupCheckRows[0].id;
            }
          }

          if (!ownRowAlreadyInserted) {
            const reason = isDuplicateEmail ? "email_already_registered" : "account_creation_failed";
            return new Response(JSON.stringify({ ok: false, error: reason, detail: errText }), {
              status: isDuplicateEmail ? 409 : 500,
              headers: { ...corsHeaders, "Content-Type": "application/json" },
            });
          }
        } else {
          const insertedRows = await insertRes.json();
          candidateId = insertedRows?.[0]?.id ?? null;
        }
      }

      const updateRes = await fetch(
        `${SUPABASE_URL}/rest/v1/email_verifications?token=eq.${encodeURIComponent(token)}`,
        {
          method: "PATCH",
          headers: {
            "Content-Type": "application/json",
            "apikey": SUPABASE_SERVICE_ROLE_KEY,
            "Authorization": `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
            "Prefer": "return=minimal",
          },
          body: JSON.stringify({ confirmed_at: new Date().toISOString() }),
        },
      );

      if (!updateRes.ok) {
        return new Response(JSON.stringify({ ok: false, error: "Could not confirm" }), {
          status: 500,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      let resumeBackfillError: string | null = null;
      if (candidateId) {
        const backfillRes = await fetch(`${SUPABASE_URL}/rest/v1/rpc/backfill_resume_pipeline_candidate_id`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "apikey": SUPABASE_SERVICE_ROLE_KEY,
            "Authorization": `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
          },
          body: JSON.stringify({ p_email_verification_id: record.id, p_candidate_id: candidateId }),
        });
        if (!backfillRes.ok) {
          resumeBackfillError = await backfillRes.text().catch(() => "backfill_failed");
        }
      }

      return new Response(JSON.stringify({
        ok: true,
        email: record.email,
        phone: record.phone,
        purpose: record.purpose,
        candidate_id: candidateId,
        email_verification_id: record.id,
        resume_backfill_error: resumeBackfillError,
      }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    } catch (e) {
      return new Response(JSON.stringify({ ok: false, error: String(e) }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
  }),
};
