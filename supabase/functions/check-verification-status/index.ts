// Setup type definitions for built-in Supabase Runtime APIs
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { withSupabase } from "jsr:@supabase/server@1";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "content-type",
};

// Signup confirmation, read-only status check — polled by the device that stayed on "Check your
// email" (Device A), reusing the exact pattern already proven tonight for resume-extraction status
// and the passwordless-login flow (startResumePolling / startLoginPolling): a live interval poll,
// started the moment the screen is entered and stopped once it resolves. Real gap this closes: the
// checkEmail screen predates every one of tonight's polling patterns and never checked its own
// status at all — a candidate confirming via the email link on a different device left it sitting
// there forever with zero automatic feedback (confirmed live: signed up on desktop, confirmed on
// phone, desktop never moved).
//
// Never inserts a candidate or consumes the email_verifications token itself — unlike
// confirm-verification, that side of this stays entirely read-only, and by the time confirmed_at is
// set here, confirm-verification has already inserted the candidates row with verification_id = this
// row's id (see its own header), so that link is always present, never a race.
//
// Item 20 (2026-09-12 live-testing session): the one real mutation this function now performs —
// issuing THIS device's own session once confirmed is observed — see issue_verification_requester_
// session's own migration header for the full gap and the atomic claim-once-then-reserve mechanism
// (identical to passwordless login's own Device A fix) that makes it safe to call on every poll
// after confirmation, not just the first.
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

// Item 20 (2026-09-12 live-testing session): identical to confirm-login's/check-login-status's own
// hashToken/randomToken — this function needed no session-issuing capability before now because its
// response never carried one at all (a real, confirmed gap — see the real session-issuing block
// below for the full story), unlike every other session-establishing path in this build.
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

export default {
  fetch: withSupabase({ auth: "none" }, async (req, _ctx) => {
    if (req.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }
    try {
      const { email_verification_id } = await req.json();
      if (!email_verification_id || typeof email_verification_id !== "string") {
        return new Response(JSON.stringify({ ok: false, error: "email_verification_id_required" }), {
          status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      const lookupRes = await fetch(
        `${SUPABASE_URL}/rest/v1/email_verifications?id=eq.${email_verification_id}&select=*`,
        { headers: { "apikey": SUPABASE_SERVICE_ROLE_KEY, "Authorization": `Bearer ${SUPABASE_SERVICE_ROLE_KEY}` } },
      );
      if (!lookupRes.ok) {
        return new Response(JSON.stringify({ ok: false, error: "lookup_failed" }), {
          status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      const rows = await lookupRes.json();
      const record = rows[0];
      if (!record) {
        return new Response(JSON.stringify({ ok: false, error: "not_found" }), {
          status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      if (!record.confirmed_at) {
        const expired = new Date(record.expires_at) < new Date();
        return new Response(JSON.stringify({ ok: true, confirmed: false, expired }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      // Only 'signup' confirmations ever create a candidates row (see confirm-verification's own
      // header) — other purposes (e.g. a future 'email_change') have nothing to link to here.
      let candidateId: string | null = null;
      if (record.purpose === "signup") {
        const candRes = await fetch(
          `${SUPABASE_URL}/rest/v1/candidates?verification_id=eq.${email_verification_id}&select=id`,
          { headers: { "apikey": SUPABASE_SERVICE_ROLE_KEY, "Authorization": `Bearer ${SUPABASE_SERVICE_ROLE_KEY}` } },
        );
        const candRows = candRes.ok ? await candRes.json() : [];
        candidateId = candRows[0]?.id ?? null;
      }

      // Item 20 (2026-09-12 live-testing session): real, persisted session for THIS device — see the
      // migration's own header for the full gap and why the atomic RPC (not a raw insert here) is
      // what makes this safe to run on every poll after confirmation, not just the first. Gated on
      // candidateId the same way confirm-verification gates its own session issuance — nothing to
      // attach a session to for a non-'signup' purpose or a not-yet-linked row.
      let sessionToken: string | null = null;
      let candidateTier: string | null = null;
      if (candidateId) {
        const rawSessionToken = randomToken();
        const tokenHash = await hashToken(rawSessionToken);
        const newSessionId = crypto.randomUUID();
        const sessionExpiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
        const rpcRes = await fetch(`${SUPABASE_URL}/rest/v1/rpc/issue_verification_requester_session`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "apikey": SUPABASE_SERVICE_ROLE_KEY,
            "Authorization": `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
          },
          body: JSON.stringify({
            p_email_verification_id: email_verification_id,
            p_candidate_id: candidateId,
            p_session_id: newSessionId,
            p_raw_token: rawSessionToken,
            p_token_hash: tokenHash,
            p_expires_at: sessionExpiresAt,
          }),
        });
        if (rpcRes.ok) {
          const rpcRows = await rpcRes.json();
          sessionToken = rpcRows?.[0]?.session_token ?? null;
          const candRes = await fetch(`${SUPABASE_URL}/rest/v1/candidates?id=eq.${candidateId}&select=tier`, {
            headers: { "apikey": SUPABASE_SERVICE_ROLE_KEY, "Authorization": `Bearer ${SUPABASE_SERVICE_ROLE_KEY}` },
          });
          const candRows = candRes.ok ? await candRes.json() : [];
          candidateTier = candRows[0]?.tier ?? null;
        }
        // A failed session issue does NOT fail this status check itself — same posture as
        // confirm-verification's own resumeBackfillError/session block: the confirmation already
        // happened (on Device B), a missing session here just means this device falls back to
        // whatever pre-Item-20 behavior existed rather than losing the confirmed status entirely.
      }

      return new Response(JSON.stringify({
        ok: true,
        confirmed: true,
        candidate_id: candidateId,
        email: record.email,
        phone: record.phone,
        // Item 12/15 (2026-09-12 live-testing session): same gap, same fix as confirm-verification's
        // own header explains — this is the "stayed on Check your email and polled" device's
        // equivalent of that response, feeding the exact same applySignupConfirmation/applySession
        // path, so it needs the exact same fields.
        first_name: record.first_name,
        last_name: record.last_name,
        purpose: record.purpose,
        opt_in_work_history: !!record.opt_in_work_history,
        opt_in_education: !!record.opt_in_education,
        opt_in_certifications: !!record.opt_in_certifications,
        session_token: sessionToken,
        tier: candidateTier,
      }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
    } catch (e) {
      return new Response(JSON.stringify({ ok: false, error: "unhandled", detail: String(e) }), {
        status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
  }),
};
