// Setup type definitions for built-in Supabase Runtime APIs
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { withSupabase } from "jsr:@supabase/server@^1";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "content-type",
};

// Employer login, step 2 of 2 (2026-09-19): the ONLY place an employer session is ever created.
//
// Single-use is enforced by one conditional UPDATE (confirmed_at is null AND not expired) whose returned
// rows decide who won, the same guarantee as confirm-login / staff-confirm-login, not a look-then-write race:
// two simultaneous clicks on the same link produce exactly one session. The lookup before it is diagnostic
// only, to give a lost race an honest reason (used vs expired).
//
// Signup and login are the same step: if no employer_users row exists for the confirmed address, one is
// created here (open self-serve signup; the address is proven by the click). Creation is race-safe: the email
// column is unique, the insert ignores a duplicate, and the row is then read back, so two different links for
// the same new address can never make two users.
//
// The session token is 32 random bytes; only its SHA-256 is stored (employer_sessions.token_hash). It is
// returned here once and never again. Sessions live 30 days, fixed (not sliding), like staff.
const REST = { "apikey": SUPABASE_SERVICE_ROLE_KEY, "Authorization": `Bearer ${SUPABASE_SERVICE_ROLE_KEY}` };
const SESSION_DAYS = 30;

async function sha256Hex(raw: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(raw));
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
}
function randomToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("");
}

export default {
  fetch: withSupabase({ auth: "none" }, async (req, _ctx) => {
    if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
    const json = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    try {
      let body: any = {};
      try { body = await req.json(); } catch (_e) { body = {}; }
      const token = typeof body.token === "string" ? body.token.trim() : "";
      if (!token) return json({ ok: false, error: "token_required" }, 400);

      const lookupRes = await fetch(`${SUPABASE_URL}/rest/v1/employer_login_tokens?token=eq.${encodeURIComponent(token)}&select=*`, { headers: REST });
      if (!lookupRes.ok) return json({ ok: false, error: "lookup_failed" }, 500);
      const record = (await lookupRes.json())[0];
      if (!record) return json({ ok: false, error: "not_found" }, 404);

      const nowIso = new Date().toISOString();
      const claimRes = await fetch(
        `${SUPABASE_URL}/rest/v1/employer_login_tokens?token=eq.${encodeURIComponent(token)}&confirmed_at=is.null&expires_at=gt.${encodeURIComponent(nowIso)}`,
        { method: "PATCH", headers: { ...REST, "Content-Type": "application/json", "Prefer": "return=representation" }, body: JSON.stringify({ confirmed_at: nowIso }) },
      );
      if (!claimRes.ok) return json({ ok: false, error: "consume_failed" }, 500);
      const claimed = await claimRes.json();
      if (!Array.isArray(claimed) || claimed.length === 0) {
        // Lost the claim. The row read above predates the race, so it can't say why: re-read it. If someone else
        // confirmed it in the meantime it is "already used"; only a link that is genuinely past its expiry is "expired".
        const againRes = await fetch(`${SUPABASE_URL}/rest/v1/employer_login_tokens?token=eq.${encodeURIComponent(token)}&select=confirmed_at`, { headers: REST });
        const again = againRes.ok ? (await againRes.json())[0] : null;
        return (again && again.confirmed_at) || record.confirmed_at ? json({ ok: false, error: "already_used" }, 409) : json({ ok: false, error: "expired" }, 410);
      }

      // Exactly one request reaches here per token. Find or create the user.
      const email = String(record.email).toLowerCase();
      const readUser = async () => {
        const r = await fetch(`${SUPABASE_URL}/rest/v1/employer_users?email=eq.${encodeURIComponent(email)}&select=id,email,name`, { headers: REST });
        return r.ok ? ((await r.json())[0] || null) : null;
      };
      let user = await readUser();
      if (!user) {
        await fetch(`${SUPABASE_URL}/rest/v1/employer_users?on_conflict=email`, {
          method: "POST",
          headers: { ...REST, "Content-Type": "application/json", "Prefer": "resolution=ignore-duplicates,return=minimal" },
          body: JSON.stringify({ email, name: record.requested_name || null }),
        });
        user = await readUser();
      }
      if (!user) return json({ ok: false, error: "account_failed" }, 500);
      if (!user.name && record.requested_name) {
        await fetch(`${SUPABASE_URL}/rest/v1/employer_users?id=eq.${user.id}&name=is.null`, {
          method: "PATCH", headers: { ...REST, "Content-Type": "application/json", "Prefer": "return=minimal" }, body: JSON.stringify({ name: record.requested_name }),
        });
        user.name = record.requested_name;
      }

      const sessionToken = randomToken();
      const expiresAt = new Date(Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000).toISOString();
      const sessRes = await fetch(`${SUPABASE_URL}/rest/v1/employer_sessions`, {
        method: "POST",
        headers: { ...REST, "Content-Type": "application/json", "Prefer": "return=minimal" },
        body: JSON.stringify({ employer_user_id: user.id, token_hash: await sha256Hex(sessionToken), expires_at: expiresAt }),
      });
      if (!sessRes.ok) return json({ ok: false, error: "session_failed" }, 500);
      fetch(`${SUPABASE_URL}/rest/v1/employer_users?id=eq.${user.id}`, {
        method: "PATCH", headers: { ...REST, "Content-Type": "application/json", "Prefer": "return=minimal" }, body: JSON.stringify({ last_login_at: nowIso }),
      }).catch(() => {});

      return json({ ok: true, session_token: sessionToken, expires_at: expiresAt, user: { id: user.id, email: user.email, name: user.name || null } });
    } catch (_e) {
      return json({ ok: false, error: "confirm_failed" }, 500);
    }
  }),
};
