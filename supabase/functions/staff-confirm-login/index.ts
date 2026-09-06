// Setup type definitions for built-in Supabase Runtime APIs
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { withSupabase } from "jsr:@supabase/server@1";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "content-type",
};

// Real staff login, step 2 of 2 — the device that clicks the emailed link. Same atomic single-use
// guard as confirm-login (the consuming PATCH carries confirmed_at=is.null&expires_at=gt.<now> in
// its own WHERE clause, so it executes as one UPDATE statement in Postgres, not a check-then-write
// race), against the parallel staff_login_tokens/staff_sessions tables. Returns email/name/role —
// name and role are what staff.html needs to replace the current self-selected "Sign in as"
// picker with real, server-confirmed identity.
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
      const { token } = await req.json();
      if (!token || typeof token !== "string") {
        return new Response(JSON.stringify({ ok: false, error: "token_required" }), {
          status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      // Diagnostic-only lookup — never the source of truth for whether this request is allowed to
      // consume the token. Only used to give the client an accurate reason if the atomic consume
      // below fails.
      const lookupRes = await fetch(
        `${SUPABASE_URL}/rest/v1/staff_login_tokens?token=eq.${encodeURIComponent(token)}&select=*`,
        { headers: { "apikey": SUPABASE_SERVICE_ROLE_KEY, "Authorization": `Bearer ${SUPABASE_SERVICE_ROLE_KEY}` } },
      );
      if (!lookupRes.ok) {
        return new Response(JSON.stringify({ ok: false, error: "lookup_failed" }), {
          status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      const lookupRows = await lookupRes.json();
      const record = lookupRows[0];
      if (!record) {
        return new Response(JSON.stringify({ ok: false, error: "not_found" }), {
          status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      const nowIso = new Date().toISOString();

      // The real, atomic single-use guard. See confirm-login's own header for why this is what
      // actually makes the token single-use under concurrency, not the lookup above.
      const consumeRes = await fetch(
        `${SUPABASE_URL}/rest/v1/staff_login_tokens?token=eq.${encodeURIComponent(token)}&confirmed_at=is.null&expires_at=gt.${encodeURIComponent(nowIso)}`,
        {
          method: "PATCH",
          headers: {
            "Content-Type": "application/json",
            "apikey": SUPABASE_SERVICE_ROLE_KEY,
            "Authorization": `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
            "Prefer": "return=representation",
          },
          body: JSON.stringify({ confirmed_at: nowIso }),
        },
      );
      if (!consumeRes.ok) {
        return new Response(JSON.stringify({ ok: false, error: "consume_failed" }), {
          status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      const consumedRows = await consumeRes.json();
      if (!consumedRows.length) {
        // We lost the race, or the token was already used/expired before we even got here.
        // record (from the diagnostic lookup) tells us which, honestly.
        if (record.confirmed_at) {
          return new Response(JSON.stringify({ ok: false, error: "already_used" }), {
            status: 409, headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        }
        return new Response(JSON.stringify({ ok: false, error: "expired" }), {
          status: 410, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      // We won. Exactly one request ever reaches this point for a given token.
      const staffUserId = record.staff_user_id;
      if (!staffUserId) {
        return new Response(JSON.stringify({ ok: false, error: "no_staff_user_linked" }), {
          status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      const staffRes = await fetch(
        `${SUPABASE_URL}/rest/v1/staff_users?id=eq.${staffUserId}&select=id,email,name,role`,
        { headers: { "apikey": SUPABASE_SERVICE_ROLE_KEY, "Authorization": `Bearer ${SUPABASE_SERVICE_ROLE_KEY}` } },
      );
      const staffRows = staffRes.ok ? await staffRes.json() : [];
      const staffUser = staffRows[0];
      if (!staffUser) {
        return new Response(JSON.stringify({ ok: false, error: "staff_user_not_found" }), {
          status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      const rawSessionToken = randomToken();
      const tokenHash = await hashToken(rawSessionToken);
      const sessionExpiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();

      const sessionRes = await fetch(`${SUPABASE_URL}/rest/v1/staff_sessions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "apikey": SUPABASE_SERVICE_ROLE_KEY,
          "Authorization": `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
          "Prefer": "return=minimal",
        },
        body: JSON.stringify({ staff_user_id: staffUserId, token_hash: tokenHash, expires_at: sessionExpiresAt }),
      });
      if (!sessionRes.ok) {
        const errText = await sessionRes.text();
        return new Response(JSON.stringify({ ok: false, error: "could_not_create_session", detail: errText }), {
          status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      return new Response(JSON.stringify({
        ok: true,
        session_token: rawSessionToken,
        email: staffUser.email,
        name: staffUser.name,
        role: staffUser.role,
      }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
    } catch (e) {
      return new Response(JSON.stringify({ ok: false, error: "unhandled", detail: String(e) }), {
        status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
  }),
};
