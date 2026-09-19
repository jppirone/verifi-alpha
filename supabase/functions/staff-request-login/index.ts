// Setup type definitions for built-in Supabase Runtime APIs
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { withSupabase } from "jsr:@supabase/server@1";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "content-type",
};

// Real staff login, step 1 of 2 — mirrors request-login's shape (real token, real Resend email,
// real expiry) against a parallel staff_login_tokens table, not candidates' login_tokens: that
// table's candidate_id carries a real NOT NULL foreign key to candidates(id), so a staff identity
// could never be inserted there without weakening a working, tested guarantee. See
// 20260906000000_staff_auth.sql for the full reasoning.
//
// No cross-device polling step exists for staff (compare candidate's check-login-status /
// issue_requester_session): an internal tool's users overwhelmingly click the link on the same
// device that requested it — a deliberate, confirmed scope reduction, not an oversight. Clicking
// the link (staff-confirm-login) is the only way this ever produces a session.
//
// NO EXISTENCE ORACLE (2026-09-19). This used to answer 404 "no account found" for an address with no staff_users row, with
// no rate limit, which told anyone which addresses are staff accounts. It now behaves exactly like employer-request-login
// from the caller's side:
//   * The response never depends on whether the address is a staff account: always {ok:true, link_minutes} once the request
//     is accepted, same status, same body, same headers.
//   * The work that does depend on it (creating the login token and sending the email, which only a real staff account gets)
//     runs AFTER the response is returned, as an Edge Runtime background task, so the response TIME does not depend on it
//     either. Everything the caller can observe (the two limit lookups, the attempt insert, the staff lookup) is the same
//     work for a known and an unknown address. The consequence: a real staff member whose email fails to send is no longer
//     told so in the response (it is logged here); they simply request another link.
//   * Abuse limits: at most 5 requests per address per hour (429) and a global ceiling per hour (429), counted from
//     staff_login_attempts, which records EVERY request, known address or not (staff_login_tokens only ever holds real
//     staff, so it could not be the thing counted without the limit itself becoming an oracle).
// Only the input SHAPE is ever rejected with a 400 (an obviously malformed address), never anything that depends on the account.
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY")!;

const LINK_MINUTES = 15;
const PER_EMAIL_PER_HOUR = 5;
const GLOBAL_PER_HOUR = 200;
const REST = { "apikey": SUPABASE_SERVICE_ROLE_KEY, "Authorization": `Bearer ${SUPABASE_SERVICE_ROLE_KEY}` };

async function sendLoginLinkIfStaff(email: string): Promise<void> {
  try {
    const staffRes = await fetch(`${SUPABASE_URL}/rest/v1/staff_users?email=eq.${encodeURIComponent(email)}&select=id`, { headers: REST });
    if (!staffRes.ok) { console.error("staff-request-login: staff lookup failed", staffRes.status); return; }
    const staffUser = (await staffRes.json())[0];
    if (!staffUser) return; // not a staff account: nothing is sent, and nothing about that is observable to the caller

    const token = crypto.randomUUID();
    const expiresAt = new Date(Date.now() + LINK_MINUTES * 60 * 1000).toISOString();
    const insertRes = await fetch(`${SUPABASE_URL}/rest/v1/staff_login_tokens`, {
      method: "POST",
      headers: { ...REST, "Content-Type": "application/json", "Prefer": "return=representation" },
      body: JSON.stringify({ email, token, staff_user_id: staffUser.id, expires_at: expiresAt }),
    });
    if (!insertRes.ok) { console.error("staff-request-login: could not create login token", insertRes.status, await insertRes.text()); return; }
    const rowId = (await insertRes.json())?.[0]?.id;

    const loginLink = `https://alpha.applitrust.com/staff.html?login_token=${token}`;
    const emailRes = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${RESEND_API_KEY}` },
      body: JSON.stringify({
        from: "Verifi <verify@applitrust.com>",
        to: email,
        subject: "Your Verifi staff login link",
        html: `<p>Click the link below to log in to the staff queue.</p><p><a href="${loginLink}">${loginLink}</a></p><p>This link expires in ${LINK_MINUTES} minutes and can only be used once.</p>`,
      }),
    });
    if (!emailRes.ok) {
      console.error("staff-request-login: could not send email", emailRes.status, await emailRes.text());
      // Nothing was delivered, so the token is unreachable: remove it.
      if (rowId) { try { await fetch(`${SUPABASE_URL}/rest/v1/staff_login_tokens?id=eq.${rowId}`, { method: "DELETE", headers: REST }); } catch (_e) { /* best effort */ } }
    }
  } catch (e) {
    console.error("staff-request-login: background send failed -", String(e));
  }
}

export default {
  fetch: withSupabase({ auth: "none" }, async (req, _ctx) => {
    if (req.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }
    const json = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    try {
      let body: any = {};
      try { body = await req.json(); } catch (_e) { body = {}; }
      const email = typeof body.email === "string" ? body.email.trim().toLowerCase().slice(0, 254) : "";
      if (!/^[^\s@,()<>]+@[^\s@,()<>]+\.[^\s@,()<>]+$/.test(email)) return json({ ok: false, error: "email_invalid" }, 400);

      // Limits, counted over EVERY request for the address (known or not).
      const since = new Date(Date.now() - 60 * 60 * 1000).toISOString();
      const [perEmailRes, globalRes] = await Promise.all([
        fetch(`${SUPABASE_URL}/rest/v1/staff_login_attempts?email=eq.${encodeURIComponent(email)}&requested_at=gte.${encodeURIComponent(since)}&select=id&limit=${PER_EMAIL_PER_HOUR + 1}`, { headers: REST }),
        fetch(`${SUPABASE_URL}/rest/v1/staff_login_attempts?requested_at=gte.${encodeURIComponent(since)}&select=id&limit=${GLOBAL_PER_HOUR + 1}`, { headers: REST }),
      ]);
      if (!perEmailRes.ok || !globalRes.ok) return json({ ok: false, error: "request_failed" }, 500);
      const perEmail = await perEmailRes.json();
      const global = await globalRes.json();
      if (Array.isArray(perEmail) && perEmail.length >= PER_EMAIL_PER_HOUR) return json({ ok: false, error: "rate_limited" }, 429);
      if (Array.isArray(global) && global.length >= GLOBAL_PER_HOUR) return json({ ok: false, error: "busy" }, 429);

      const attemptRes = await fetch(`${SUPABASE_URL}/rest/v1/staff_login_attempts`, {
        method: "POST",
        headers: { ...REST, "Content-Type": "application/json" },
        body: JSON.stringify({ email }),
      });
      if (!attemptRes.ok) return json({ ok: false, error: "request_failed" }, 500);

      // Housekeeping + the part that depends on the account, both after the response. Falling back to awaiting them would
      // reintroduce a timing difference, so only do that if the runtime offers no background hook at all.
      const work = (async () => {
        try { await fetch(`${SUPABASE_URL}/rest/v1/staff_login_attempts?requested_at=lt.${encodeURIComponent(new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString())}`, { method: "DELETE", headers: REST }); } catch (_e) { /* best effort */ }
        await sendLoginLinkIfStaff(email);
      })();
      const edgeRuntime = (globalThis as { EdgeRuntime?: { waitUntil?: (p: Promise<unknown>) => void } }).EdgeRuntime;
      if (edgeRuntime && typeof edgeRuntime.waitUntil === "function") edgeRuntime.waitUntil(work);
      else await work;

      return json({ ok: true, link_minutes: LINK_MINUTES });
    } catch (_e) {
      return json({ ok: false, error: "request_failed" }, 500);
    }
  }),
};
