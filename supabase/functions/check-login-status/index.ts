// Setup type definitions for built-in Supabase Runtime APIs
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { withSupabase } from "jsr:@supabase/server@1";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "content-type",
};

// Passwordless login, step 3 of 3 — polled by the REQUESTING device (Device A), reusing the exact
// pattern proven tonight for the resume-extraction status screen (get-resume-extraction +
// candidate.html's startResumePolling/stopResumePolling): a live interval poll that starts when
// the flow begins and stops once it resolves, no push infrastructure.
//
// The real point of this function, not just a status read: Device A needs its OWN persisted
// session the moment it observes confirmation — not a copy of Device B's, and not a transient
// flag that vanishes on refresh. issue_requester_session() (see the migration) does that
// atomically: the first poll to see confirmed_at set claims a brand new candidate_sessions row for
// Device A; every poll after that (including a genuine retry if the first response was lost in
// transit) gets the SAME already-issued token back rather than a second session or an error.
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

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
      const { login_token_id } = await req.json();
      if (!login_token_id || typeof login_token_id !== "string") {
        return new Response(JSON.stringify({ ok: false, error: "login_token_id_required" }), {
          status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      const lookupRes = await fetch(
        `${SUPABASE_URL}/rest/v1/login_tokens?id=eq.${login_token_id}&select=*`,
        { headers: { "apikey": SUPABASE_SERVICE_ROLE_KEY, "Authorization": `Bearer ${SUPABASE_SERVICE_ROLE_KEY}` } },
      );
      if (!lookupRes.ok) {
        return new Response(JSON.stringify({ ok: false, error: "lookup_failed" }), {
          status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      const rows = await lookupRes.json();
      const record = rows[0];
      // No existence oracle (2026-09-19): request-login returns the id of a candidate_login_attempts row for EVERY address, and only a
      // real candidate gets a login_tokens row (created with that same id, after the response). So "no login_tokens row" is not
      // "not found" here: an attempt row means a request was made, and it polls exactly like a real, still-unconfirmed link. Both
      // kinds answer pending for 15 minutes, expired until an hour after the request, and 404 after that.
      const HOUR_MS = 60 * 60 * 1000, LINK_MS = 15 * 60 * 1000;
      const notFound = () => new Response(JSON.stringify({ ok: false, error: "not_found" }), {
        status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
      const pending = (requestedAtMs: number) => {
        const age = Date.now() - requestedAtMs;
        if (age > HOUR_MS) return notFound();
        return new Response(JSON.stringify({ ok: true, confirmed: false, expired: age > LINK_MS }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      };
      if (!record) {
        const aRes = await fetch(
          `${SUPABASE_URL}/rest/v1/candidate_login_attempts?id=eq.${login_token_id}&kind=eq.login&select=requested_at`,
          { headers: { "apikey": SUPABASE_SERVICE_ROLE_KEY, "Authorization": `Bearer ${SUPABASE_SERVICE_ROLE_KEY}` } },
        );
        const attempt = aRes.ok ? (await aRes.json())[0] : null;
        if (!attempt) return notFound();
        return pending(new Date(attempt.requested_at).getTime());
      }

      if (!record.confirmed_at) {
        // A real link's clock starts when the request was made, same as an attempt row's (its expiry is request time + 15 minutes).
        return pending(new Date(record.expires_at).getTime() - LINK_MS);
      }

      // Confirmed. Claim (or re-fetch) Device A's own session via the atomic RPC — never a raw
      // DB write done directly here, so the "only ever issue this once" guarantee lives in one
      // place (the migration's issue_requester_session), not duplicated in this function's logic.
      const rawSessionToken = randomToken();
      const tokenHash = await hashToken(rawSessionToken);
      const newSessionId = crypto.randomUUID();
      const sessionExpiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();

      const rpcRes = await fetch(`${SUPABASE_URL}/rest/v1/rpc/issue_requester_session`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "apikey": SUPABASE_SERVICE_ROLE_KEY,
          "Authorization": `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
        },
        body: JSON.stringify({
          p_login_token_id: login_token_id,
          p_candidate_id: record.candidate_id,
          p_session_id: newSessionId,
          p_raw_token: rawSessionToken,
          p_token_hash: tokenHash,
          p_expires_at: sessionExpiresAt,
        }),
      });
      if (!rpcRes.ok) {
        const errText = await rpcRes.text();
        return new Response(JSON.stringify({ ok: false, error: "session_issue_failed", detail: errText }), {
          status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      const rpcRows = await rpcRes.json();
      const sessionToken = rpcRows?.[0]?.session_token ?? null;

      let candidate: { email?: string; phone?: string; full_name?: string; first_name?: string; last_name?: string; deletion_scheduled_at?: string | null; tier?: string; tour_completed_at?: string | null; header_display_mode?: string; personal_location?: string | null; account_type?: string; kyc_verified_at?: string | null; license_subscription_started_at?: string | null; phone_verified_at?: string | null; cross_validation_completed_at?: string | null } = {};
      if (record.candidate_id) {
        const candRes = await fetch(
          `${SUPABASE_URL}/rest/v1/candidates?id=eq.${record.candidate_id}&select=email,phone,full_name,first_name,last_name,deletion_scheduled_at,tier,tour_completed_at,header_display_mode,personal_location,account_type,kyc_verified_at,license_subscription_started_at,phone_verified_at,cross_validation_completed_at,verified_phone_number`,
          { headers: { "apikey": SUPABASE_SERVICE_ROLE_KEY, "Authorization": `Bearer ${SUPABASE_SERVICE_ROLE_KEY}` } },
        );
        const candRows = candRes.ok ? await candRes.json() : [];
        candidate = candRows[0] ?? {};
      }

      return new Response(JSON.stringify({
        ok: true,
        confirmed: true,
        session_token: sessionToken,
        candidate_id: record.candidate_id,
        email: candidate.email,
        phone: candidate.phone,
        full_name: candidate.full_name,
        first_name: candidate.first_name,
        last_name: candidate.last_name,
        // See confirm-login's own header — same reasoning, same field, same "session issued
        // regardless, client decides the screen" split of responsibility.
        deletion_scheduled_at: candidate.deletion_scheduled_at,
        // Item B: real tier state — see resolve-session's own comment on this same field.
        tier: candidate.tier,
        // Item 8 (2026-09-11 status-check session): see resolve-session's own comment on this
        // same field.
        tour_completed_at: candidate.tour_completed_at,
        // Item 6 (2026-09-12 live-testing session, follow-up build): see resolve-session's own
        // comment on these same two fields.
        header_display_mode: candidate.header_display_mode,
        personal_location: candidate.personal_location,
        // Items 9/10/11: see resolve-session's own comment on these same three fields.
        account_type: candidate.account_type,
        kyc_verified_at: candidate.kyc_verified_at,
        license_subscription_started_at: candidate.license_subscription_started_at,
        // Verification-status persistence fix (2026-09-18): see resolve-session's own comment on
        // these same two fields.
        phone_verified_at: candidate.phone_verified_at,
        cross_validation_completed_at: candidate.cross_validation_completed_at,
        verified_phone_number: candidate.verified_phone_number,
      }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
    } catch (e) {
      return new Response(JSON.stringify({ ok: false, error: "unhandled", detail: String(e) }), {
        status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
  }),
};
