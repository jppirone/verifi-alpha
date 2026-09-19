// Setup type definitions for built-in Supabase Runtime APIs
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { withSupabase } from "jsr:@supabase/server@^1";

const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY")!;
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "content-type",
};

// Employer login, step 1 of 2 (2026-09-19). One "enter your email" flow for BOTH signup and login: the
// account is created when the link is confirmed (employer-confirm-login), not here.
//
// NO EXISTENCE LEAK, unlike request-login / staff-request-login (which answer "no account found"): this
// function never looks up employer_users at all, so it cannot behave differently for a known and an unknown
// address. It always answers {ok:true}, sends the same email, and takes the same code path. Anyone can request
// a link for any address; the only thing that ever comes of it is an email to that address.
//
// Abuse limits (the older logins have none): at most 5 links per address per hour (429), and a global ceiling on
// links per hour so this cannot be used as a mail cannon. Neither limit depends on whether the address has an
// account.
//
// Links work in the browser that opens them (same-browser, as staff): there is deliberately no cross-device
// polling. The link is single-use with a 15-minute life, claimed atomically in employer-confirm-login.
const LINK_MINUTES = 15;
const PER_EMAIL_PER_HOUR = 5;
const GLOBAL_PER_HOUR = 500;
const REST = { "apikey": SUPABASE_SERVICE_ROLE_KEY, "Authorization": `Bearer ${SUPABASE_SERVICE_ROLE_KEY}` };

export default {
  fetch: withSupabase({ auth: "none" }, async (req, _ctx) => {
    if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
    const json = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    try {
      let body: any = {};
      try { body = await req.json(); } catch (_e) { body = {}; }
      const email = typeof body.email === "string" ? body.email.trim().toLowerCase().slice(0, 254) : "";
      const name = typeof body.name === "string" ? body.name.trim().slice(0, 120) : "";
      if (!/^[^\s@,()<>]+@[^\s@,()<>]+\.[^\s@,()<>]+$/.test(email)) return json({ ok: false, error: "email_invalid" }, 400);

      const since = new Date(Date.now() - 60 * 60 * 1000).toISOString();
      const [perEmailRes, globalRes] = await Promise.all([
        fetch(`${SUPABASE_URL}/rest/v1/employer_login_tokens?email=eq.${encodeURIComponent(email)}&requested_at=gte.${encodeURIComponent(since)}&select=id&limit=${PER_EMAIL_PER_HOUR + 1}`, { headers: REST }),
        fetch(`${SUPABASE_URL}/rest/v1/employer_login_tokens?requested_at=gte.${encodeURIComponent(since)}&select=id&limit=${GLOBAL_PER_HOUR + 1}`, { headers: REST }),
      ]);
      if (!perEmailRes.ok || !globalRes.ok) return json({ ok: false, error: "request_failed" }, 500);
      const perEmail = await perEmailRes.json();
      const global = await globalRes.json();
      if (Array.isArray(perEmail) && perEmail.length >= PER_EMAIL_PER_HOUR) return json({ ok: false, error: "rate_limited" }, 429);
      if (Array.isArray(global) && global.length >= GLOBAL_PER_HOUR) return json({ ok: false, error: "busy" }, 429);

      const token = crypto.randomUUID();
      const expiresAt = new Date(Date.now() + LINK_MINUTES * 60 * 1000).toISOString();
      const insRes = await fetch(`${SUPABASE_URL}/rest/v1/employer_login_tokens`, {
        method: "POST",
        headers: { ...REST, "Content-Type": "application/json", "Prefer": "return=representation" },
        body: JSON.stringify({ email, requested_name: name || null, token, expires_at: expiresAt }),
      });
      if (!insRes.ok) return json({ ok: false, error: "request_failed" }, 500);
      const rowId = (await insRes.json())?.[0]?.id;

      const link = `https://alpha.applitrust.com/employer.html?employer_login=${token}`;
      const emailRes = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": `Bearer ${RESEND_API_KEY}` },
        body: JSON.stringify({
          from: "Verifi <verify@applitrust.com>",
          to: email,
          subject: "Your Verifi employer sign-in link",
          html: `<p>Click the link below to sign in to Verifi employer access. If you don't have an account yet, this creates one.</p><p><a href="${link}">${link}</a></p><p>This link works once and expires in ${LINK_MINUTES} minutes. Open it in the same browser you started from. If you didn't ask for it, you can ignore this email.</p>`,
        }),
      });
      if (!emailRes.ok) {
        // Nothing was delivered, so the token is unreachable: remove it. The failure says nothing about the address.
        if (rowId) { try { await fetch(`${SUPABASE_URL}/rest/v1/employer_login_tokens?id=eq.${rowId}`, { method: "DELETE", headers: REST }); } catch (_e) { /* best effort */ } }
        return json({ ok: false, error: "email_failed" }, 502);
      }
      return json({ ok: true, link_minutes: LINK_MINUTES });
    } catch (_e) {
      return json({ ok: false, error: "request_failed" }, 500);
    }
  }),
};
