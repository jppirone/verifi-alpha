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

// Tier 1 employer existence check, step 1 of 2: confirm the REQUESTER's email (2026-09-19).
//
// Same mechanism as the candidate email-verification system (send-verification / confirm-verification):
// a plain UUID token in a link, a fixed 60-minute expiry, single use, distinct not_found / already_used /
// expired outcomes — but in its own table (employer_lookup_requests), because a lookup request carries
// the candidate details the requester typed, and the link must confirm THAT request, not a generic email.
//
// The details the requester typed about the candidate (name + email and/or phone) are staged on the row
// here and the lookup runs from the staged row in check-existence when the link is clicked. Nothing about
// the candidate is looked up, or revealed, by this function: it returns {ok:true} identically whether or
// not the candidate exists (it doesn't look). The token is never returned to the browser — it only exists
// in the email — so the confirmation can't be completed without controlling the requester's inbox.
//
// Abuse limiting: at most 5 confirmation emails per requester address per hour (429), so this can't be
// used to mail-bomb an address or to grind lookups against one inbox.
const REQUESTS_PER_HOUR = 5;
const LINK_MINUTES = 60;

const REST = {
  "apikey": SUPABASE_SERVICE_ROLE_KEY,
  "Authorization": `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
};

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
function clip(v: unknown, n: number): string {
  return typeof v === "string" ? v.trim().slice(0, n) : "";
}

export default {
  fetch: withSupabase({ auth: "none" }, async (req, _ctx) => {
    if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
    const json = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    try {
      let body: any = {};
      try { body = await req.json(); } catch (_e) { body = {}; }
      const requesterEmail = clip(body.requester_email, 254).toLowerCase();
      const requesterName = clip(body.requester_name, 120);
      const requesterCompany = clip(body.requester_company, 160);
      const candidateName = clip(body.candidate_name, 160);
      const candidateEmail = clip(body.candidate_email, 254);
      const candidatePhone = clip(body.candidate_phone, 40);

      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(requesterEmail)) return json({ ok: false, error: "requester_email_invalid" }, 400);
      if (!requesterName) return json({ ok: false, error: "requester_name_required" }, 400);
      if (candidateName.split(/\s+/).filter(Boolean).length < 2) return json({ ok: false, error: "candidate_name_required" }, 400);
      const phoneDigits = candidatePhone.replace(/\D/g, "");
      if (!candidateEmail && phoneDigits.length < 10) return json({ ok: false, error: "candidate_contact_required" }, 400);
      if (candidateEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(candidateEmail)) return json({ ok: false, error: "candidate_email_invalid" }, 400);

      // Rate limit per requester address.
      const since = new Date(Date.now() - 60 * 60 * 1000).toISOString();
      const rlRes = await fetch(
        `${SUPABASE_URL}/rest/v1/employer_lookup_requests?requester_email=ilike.${encodeURIComponent(requesterEmail.replace(/[*%]/g, ""))}&created_at=gte.${encodeURIComponent(since)}&select=id`,
        { headers: REST },
      );
      if (!rlRes.ok) return json({ ok: false, error: "request_failed" }, 500);
      const recent = await rlRes.json();
      if (Array.isArray(recent) && recent.length >= REQUESTS_PER_HOUR) return json({ ok: false, error: "rate_limited" }, 429);

      const token = crypto.randomUUID();
      const expiresAt = new Date(Date.now() + LINK_MINUTES * 60 * 1000).toISOString();
      const insRes = await fetch(`${SUPABASE_URL}/rest/v1/employer_lookup_requests`, {
        method: "POST",
        headers: { ...REST, "Content-Type": "application/json", "Prefer": "return=representation" },
        body: JSON.stringify({
          token, requester_email: requesterEmail, requester_name: requesterName || null, requester_company: requesterCompany || null,
          candidate_name: candidateName, candidate_email: candidateEmail || null, candidate_phone: candidatePhone || null,
          expires_at: expiresAt,
        }),
      });
      if (!insRes.ok) return json({ ok: false, error: "request_failed" }, 500);
      const inserted = await insRes.json();
      const rowId = inserted?.[0]?.id;

      const link = `https://alpha.applitrust.com/employer.html?lookup_token=${token}`;
      const who = requesterCompany ? `${esc(requesterName)} at ${esc(requesterCompany)}` : esc(requesterName);
      const emailRes = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": `Bearer ${RESEND_API_KEY}` },
        body: JSON.stringify({
          from: "Verifi <verify@applitrust.com>",
          to: requesterEmail,
          subject: "Confirm your Verifi existence check",
          html: `<p>Hi ${esc(requesterName)},</p><p>${who} asked to run a Verifi existence check. Click the link below to confirm this is your email address and run the check.</p><p><a href="${link}">${link}</a></p><p>This link works once and expires in ${LINK_MINUTES} minutes. If you didn't request this, you can ignore this email.</p>`,
        }),
      });
      if (!emailRes.ok) {
        // The requester never got a link, so the staged row is unreachable — remove it rather than leave
        // third-party details sitting in the table.
        if (rowId) {
          try { await fetch(`${SUPABASE_URL}/rest/v1/employer_lookup_requests?id=eq.${rowId}`, { method: "DELETE", headers: REST }); } catch (_e) { /* best effort */ }
        }
        return json({ ok: false, error: "email_failed" }, 502);
      }
      return json({ ok: true, link_minutes: LINK_MINUTES });
    } catch (_e) {
      return json({ ok: false, error: "request_failed" }, 500);
    }
  }),
};
