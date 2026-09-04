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

      let candidate: { email?: string; phone?: string; full_name?: string } = {};
      if (record.candidate_id) {
        const candRes = await fetch(
          `${SUPABASE_URL}/rest/v1/candidates?id=eq.${record.candidate_id}&select=email,phone,full_name`,
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
      }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
    } catch (e) {
      return new Response(JSON.stringify({ ok: false, error: "unhandled", detail: String(e) }), {
        status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
  }),
};
