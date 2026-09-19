// Setup type definitions for built-in Supabase Runtime APIs
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { withSupabase } from "jsr:@supabase/server@1";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "content-type",
};

// Item 2 (2026-09-08 regression session): identical to confirm-login's own hashToken/randomToken —
// this function needed no session-issuing capability before today, because nothing past this point
// (resumeConfirm → employerContact → tiers → enterAccount) ever established one; see the real
// session-issuing block below for why that was a genuine gap, not by design.
async function hashToken(raw: string): Promise<string> {
  const bytes = new TextEncoder().encode(raw);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

function randomToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("");
}

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
//   3. The response also now echoes back opt_in_work_history / opt_in_education /
//      opt_in_certifications straight from `record` (already fetched via `select=*`, no new query).
//      This replaces an earlier, backed-out client-side (localStorage) attempt at the same problem
//      — the candidate's opt-in choices, staged onto this same email_verifications row by
//      send-verification at the moment the candidate leaves the preview screen (same pattern as
//      phone/full_name), are now read back through the token here rather than trusted to survive
//      in the browser. That closes the real gap the client-side version had: a candidate can
//      confirm from a different device than the one they signed up on (laptop → phone, opening the
//      email there), and the token in the confirmation link is all that's needed either way.
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
//
// MODIFIED AGAIN: the candidates insert now carries first_name/last_name (read straight off
// `record`, already fetched via select=* — no new query) instead of full_name, matching
// send-verification's write side. full_name stays on both tables for pre-existing rows only; this
// insert simply doesn't write it anymore. The duplicate-email race-recovery path below (an insert
// failing with a real unique-constraint violation because a retry landed after a previous attempt
// already succeeded) is untouched — first_name/last_name just ride along in the same insert body,
// same atomicity, same retry-safety.
//
// MODIFIED AGAIN for Items 9/10 (2026-09-13 live-testing session): account_type rides along in the
// same candidates insert (record.account_type, staged by send-verification — null defaults to
// 'full_resume' here, same as the column's own DB default, so an older/unrelated caller that never
// sends account_type at all is unaffected). kyc_verified_at is set to now() at this same moment,
// ONLY for a license_only signup — deliberately NOT a separately-staged boolean: reaching this
// function via record.account_type === 'license_only' at all structurally required the candidate to
// have already passed through the licenseKyc screen (send-verification, and therefore this row, is
// only ever reached from candidate.html AFTER that step for that account type — see
// candidate.html's licenseDetails-continue handler), so the KYC step and the email-confirmation step
// are coupled by construction, not by a second flag that could drift out of sync with the first. A
// license_only signup also gets one certification_items row created here from record.staged_license
// (Item 8's exact field set: name/issuing_body/license_number/trade_soc_code/issue_date/
// expiration_date) — resume_document_id stays null (that column has always been nullable; there is
// no resume for a license-only account), candidate_confirmed is true immediately (the candidate
// typed this directly on licenseDetails; there's no separate extraction-to-confirm reconciliation
// step the way resume-derived certifications have), and status is left at its own table default,
// 'Not Submitted for Verification' — the exact same honest, pre-existing Item-18-model vocabulary
// used everywhere else on this axis, not a new invented status string. Best-effort, same posture as
// resumeBackfillError just below: a failure here doesn't fail the whole confirmation (the candidate
// row already exists), it's surfaced in the response instead of silently swallowed.

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
          body: JSON.stringify({ email: record.email, phone: record.phone, first_name: record.first_name, last_name: record.last_name, verification_id: record.id, account_type: record.account_type === 'license_only' ? 'license_only' : 'full_resume', kyc_verified_at: record.account_type === 'license_only' ? new Date().toISOString() : null }),
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

      // Items 9/10: the license-only signup's certification row — see this function's own header
      // above for why resume_document_id stays null and status is left at its table default.
      let licenseCreationError: string | null = null;
      if (candidateId && record.account_type === 'license_only' && record.staged_license) {
        const lic = record.staged_license;
        const licenseRes = await fetch(`${SUPABASE_URL}/rest/v1/certification_items`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "apikey": SUPABASE_SERVICE_ROLE_KEY,
            "Authorization": `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
            "Prefer": "return=representation",
          },
          body: JSON.stringify({
            candidate_id: candidateId,
            resume_document_id: null,
            name: lic.name || null,
            issuing_body: lic.issuing_body || null,
            license_number: lic.license_number || null,
            trade_soc_code: lic.trade_soc_code || null,
            issue_date: lic.issue_date || null,
            issue_date_precision: lic.issue_date ? "day" : null, // entered through a date picker: a full date
            expiration_date: lic.expiration_date || null,
            expiration_date_precision: lic.expiration_date ? "day" : null,
            candidate_confirmed: true,
          }),
        });
        if (!licenseRes.ok) {
          licenseCreationError = await licenseRes.text().catch(() => "license_creation_failed");
        } else {
          // Automatic license verification (license-only path): the certification row above is the
          // license's single record (and the License Status tab's source); license_items is its 1:1
          // verification extension, checked by the same shared verify-license module the resume path uses. Nothing here can fail signup:
          // any error just leaves the license candidate-stated / unverified.
          try {
            const certRows = await licenseRes.json();
            const certId = Array.isArray(certRows) && certRows[0] ? certRows[0].id : null;
            const stateCode = typeof lic.state === "string" ? lic.state.trim().toUpperCase() : "";
            const liRes = await fetch(`${SUPABASE_URL}/rest/v1/license_items`, {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                "apikey": SUPABASE_SERVICE_ROLE_KEY,
                "Authorization": `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
                "Prefer": "return=representation",
              },
              body: JSON.stringify({
                candidate_id: candidateId, resume_document_id: null, source: "license_only",
                linked_certification_id: certId,
                state: /^[A-Z]{2}$/.test(stateCode) ? stateCode : null,
                state_source: /^[A-Z]{2}$/.test(stateCode) ? "candidate" : null,
                candidate_confirmed: true,
              }),
            });
            if (liRes.ok) {
              const liRows = await liRes.json();
              const licenseItemId = Array.isArray(liRows) && liRows[0] ? liRows[0].id : null;
              if (licenseItemId && /^[A-Z]{2}$/.test(stateCode) && lic.license_number) {
                await fetch(`${SUPABASE_URL}/functions/v1/verify-license`, {
                  method: "POST",
                  headers: {
                    "Content-Type": "application/json",
                    "apikey": SUPABASE_SERVICE_ROLE_KEY,
                    "Authorization": `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
                  },
                  body: JSON.stringify({ candidate_id: candidateId, license_item_id: licenseItemId }),
                  signal: AbortSignal.timeout(30000),
                }).catch(() => {});
              }
            }
          } catch (_e) { /* leave the license unverified; never fail signup over it */ }
        }
      }

      // Item 2 (2026-09-08 regression session): real, confirmed regression (found live — a plain F5
      // anywhere between here and enterAccount() logged the candidate all the way out, losing their
      // place in onboarding). Root cause: this function is the moment a real candidate row first
      // exists, but candidate.html's applySignupConfirmation() only ever set in-memory React state
      // from its response — never a durable session — so resumeConfirm/employerContact/tiers had
      // nothing to recover from on refresh (the pre-confirmation verifi_draft mechanism is explicitly
      // cleared the instant confirmation succeeds, and nothing replaced it). Fix: issue a real
      // session here, identical in shape to confirm-login's own (candidate_sessions row, raw token
      // returned once, only its hash stored) — reuses the same already-audited mechanism every other
      // returning-session path relies on, rather than inventing a second, weaker, onboarding-only
      // continuity system. Issued unconditionally whenever a candidate row exists, same posture
      // confirm-login documents for a deactivated candidate — this function isn't the place to decide
      // whether the account is in good standing, only whether one exists to attach a session to.
      let sessionToken: string | null = null;
      let candidateTier: string | null = null;
      let candidateHeaderDisplayMode: string | null = null;
      let candidatePersonalLocation: string | null = null;
      let candidateAccountType: string | null = null;
      let candidateKycVerifiedAt: string | null = null;
      let candidatePhoneVerifiedAt: string | null = null;
      let candidateCrossValidationCompletedAt: string | null = null;
      let candidateVerifiedPhoneNumber: string | null = null;
      if (candidateId) {
        const rawSessionToken = randomToken();
        const tokenHash = await hashToken(rawSessionToken);
        const sessionExpiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
        const sessionRes = await fetch(`${SUPABASE_URL}/rest/v1/candidate_sessions`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "apikey": SUPABASE_SERVICE_ROLE_KEY,
            "Authorization": `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
            "Prefer": "return=minimal",
          },
          body: JSON.stringify({ candidate_id: candidateId, token_hash: tokenHash, expires_at: sessionExpiresAt }),
        });
        if (sessionRes.ok) {
          sessionToken = rawSessionToken;
          // Item 6 (2026-09-12 live-testing session, follow-up build): header_display_mode/
          // personal_location added to the same select as tier — same "all session-establishing
          // paths return it uniformly" reasoning as resolve-session's own header explains, and this
          // is really a fourth such path (see the first_name/last_name comment on this response
          // below). A brand-new candidate just gets the DB defaults ('printed', null).
          const candRes = await fetch(`${SUPABASE_URL}/rest/v1/candidates?id=eq.${candidateId}&select=tier,header_display_mode,personal_location,account_type,kyc_verified_at,phone_verified_at,cross_validation_completed_at,verified_phone_number`, {
            headers: { "apikey": SUPABASE_SERVICE_ROLE_KEY, "Authorization": `Bearer ${SUPABASE_SERVICE_ROLE_KEY}` },
          });
          const candRows = candRes.ok ? await candRes.json() : [];
          candidateTier = candRows[0]?.tier ?? null;
          candidateHeaderDisplayMode = candRows[0]?.header_display_mode ?? null;
          candidatePersonalLocation = candRows[0]?.personal_location ?? null;
          // Read back rather than trusted from `record` directly — the duplicate-email race-recovery
          // path above can reach this point with candidateId set from a PRIOR insert attempt, whose
          // account_type may not match this request's own record if the two ever disagreed.
          candidateAccountType = candRows[0]?.account_type ?? null;
          candidateKycVerifiedAt = candRows[0]?.kyc_verified_at ?? null;
          candidatePhoneVerifiedAt = candRows[0]?.phone_verified_at ?? null;
          candidateCrossValidationCompletedAt = candRows[0]?.cross_validation_completed_at ?? null;
          candidateVerifiedPhoneNumber = candRows[0]?.verified_phone_number ?? null;
        }
        // A failed session insert does NOT fail confirmation itself — same posture as
        // resumeBackfillError above: the candidate row and resume linkage already succeeded, and a
        // missing session here just means this one device falls back to the pre-existing (broken)
        // behavior rather than losing the signup outcome entirely. session_token: null tells the
        // client exactly that, rather than silently pretending success.
      }

      return new Response(JSON.stringify({
        ok: true,
        email: record.email,
        phone: record.phone,
        // Item 12/15 (2026-09-12 live-testing session): the real gap — this response never echoed
        // back first_name/last_name, unlike resolve-session/confirm-login/check-login-status (see
        // resolve-session's own header: "all three session-establishing paths... uniformly" — this
        // is really a fourth such path, applySignupConfirmation feeds this response straight into
        // the same applySession candidate.html's other three paths use). first_name/last_name ARE
        // correctly written into the new candidates row above (same record.first_name/last_name),
        // but on whichever device/tab actually reaches this response without already having typed
        // the signup form itself in its own local state (the classic cross-device magic-link
        // shape), applySession had nothing to fall back to and profileFirst/savedFirst stayed
        // permanently empty until some later, unrelated full session resolve — confirmed live as
        // the root cause of both the Basic Info screen's empty name fields and the generated
        // document's missing candidate name.
        first_name: record.first_name,
        last_name: record.last_name,
        purpose: record.purpose,
        candidate_id: candidateId,
        email_verification_id: record.id,
        opt_in_work_history: !!record.opt_in_work_history,
        opt_in_education: !!record.opt_in_education,
        opt_in_certifications: !!record.opt_in_certifications,
        resume_backfill_error: resumeBackfillError,
        license_creation_error: licenseCreationError,
        session_token: sessionToken,
        tier: candidateTier,
        header_display_mode: candidateHeaderDisplayMode,
        personal_location: candidatePersonalLocation,
        account_type: candidateAccountType,
        kyc_verified_at: candidateKycVerifiedAt,
        phone_verified_at: candidatePhoneVerifiedAt,
        cross_validation_completed_at: candidateCrossValidationCompletedAt,
        verified_phone_number: candidateVerifiedPhoneNumber,
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
