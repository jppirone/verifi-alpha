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
// Deliberately never mutates anything — unlike confirm-verification (which inserts the candidate
// and consumes the token), this only ever reads. Safe to poll on a fixed interval with zero side
// effects. By the time confirmed_at is set on the email_verifications row, confirm-verification has
// already inserted the candidates row with verification_id = this row's id (see its own header), so
// that link is always present here, never a race.
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

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

      return new Response(JSON.stringify({
        ok: true,
        confirmed: true,
        candidate_id: candidateId,
        email: record.email,
        phone: record.phone,
        purpose: record.purpose,
        opt_in_work_history: !!record.opt_in_work_history,
        opt_in_education: !!record.opt_in_education,
        opt_in_certifications: !!record.opt_in_certifications,
      }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
    } catch (e) {
      return new Response(JSON.stringify({ ok: false, error: "unhandled", detail: String(e) }), {
        status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
  }),
};
