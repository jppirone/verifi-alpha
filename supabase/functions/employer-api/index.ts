// Setup type definitions for built-in Supabase Runtime APIs
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { withSupabase } from "jsr:@supabase/server@^1";

const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY")!;
const STRIPE_SECRET_KEY = Deno.env.get("STRIPE_SECRET_KEY")!;
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "content-type",
};

// THE EMPLOYER GATEWAY (2026-09-19). Every action a logged-in employer can take goes through this one function,
// so authentication cannot be forgotten on any individual action: the flow is fixed and every action is a
// registry entry that declares who may call it.
//
//   1. AUTHENTICATE. session_token (body) -> SHA-256 -> employer_sessions.token_hash; must exist, not be revoked,
//      not be expired, and its employer_users row must still exist. A missing, garbage, expired or revoked token
//      all get the same 401 {error:"invalid_session"}, before the action name is even looked at, so an
//      unauthenticated caller cannot learn which actions exist.
//   2. DERIVE identity from the database, never from the request. The caller's org and role are read from
//      employer_users on THIS request (not cached on the session, not accepted as a parameter). Consequence:
//      removing a member from an org cuts their org access on their very next call, and no action takes an org id,
//      so there is nothing to tamper with to reach another org.
//   3. AUTHORIZE against the registry (deny by default): unknown action -> 404; caller not allowed -> 403.
//   4. RUN. Actions that touch another user or an invite look the target up scoped to the caller's own org; a
//      target in another org answers 404, the same as a target that does not exist.
//
// Access levels:  any (signed in) | orgless (signed in, no org) | member (owner or member) | owner | plain_member.
//
// Billing (added 2026-09-19): start_subscription, cancel_subscription, resume_subscription and billing_portal are
// registry entries with access "owner", so they inherit everything above: only the org's single owner (who is also its
// billing owner and only admin) can create, cancel, resume or change the payment method of the org's subscription; a
// member gets 403 before any Stripe call happens. billing_status is "member": members can see whether the org is
// subscribed and how much quota is left (they need that to use it) but never get Stripe ids, payment details or any
// way to change them. Subscription STATE is never written here: these actions only ask Stripe to do something; the
// verified webhook (employer-stripe-events) is what updates the database. Owner handover and the owner leaving are
// still deliberately not built: the owner cannot be removed and cannot leave.
//
// Comparisons (added 2026-09-20, Stage 2 of the comparison delivery; see migrations 20260920020000 and 20260920040000): list_lookups,
// request_comparison, list_comparisons and open_comparison are all access "member" (they need an organization, whose live subscription
// pays for them). Members run and open THEIR OWN requests; the owner can additionally LIST every request in the organization (who asked
// and what state it is in) but cannot open someone else's: opening is bound to the person who asked.
//   * The candidate is never named in a request: the caller picks one of their OWN matched Tier 1 lookups (their sign-in address is the
//     address the lookup link went to), and create_comparison_request (SQL) applies every rule, returning one coarse "unavailable" for
//     anything about the candidate's state.
//   * What the employer sees of the outcome is deliberately undifferentiated: a decline, a timeout and a deactivation are all
//     "not_authorized". "ready"/"opened"/"ended" only exist for requests the candidate approved.
//   * METERING: open_comparison is the delivery point. The first successful open of an approved snapshot calls consume_org_lookup with
//     reference = the request id (counted once no matter how often it is retried or re-opened); if the organization has no active
//     subscription or no lookups left the open is refused (402) and nothing is consumed, and the approved snapshot simply waits until
//     it is discarded (7 days). Re-opening an already-opened snapshot never consumes another lookup.
// This is employer-side only. Candidate and staff endpoints are NOT changed by this and are still identified by
// id in the request body (a separate, already-tracked cleanup).
const REST = { "apikey": SUPABASE_SERVICE_ROLE_KEY, "Authorization": `Bearer ${SUPABASE_SERVICE_ROLE_KEY}` };
const JSON_H = { ...REST, "Content-Type": "application/json" };
const INVITE_DAYS = 14;
const MAX_PENDING_INVITES = 25;
const MAX_INVITES_PER_HOUR = 20;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL = /^[^\s@,()<>]+@[^\s@,()<>]+\.[^\s@,()<>]+$/;

type User = { id: string; email: string; name: string | null; org_id: string | null; role: "owner" | "member" | null };
type Org = { id: string; name: string };
type Ctx = { user: User; org: Org | null; sessionId: string; p: any };
type Out = { status?: number; body: Record<string, unknown> };
type Action = { access: "any" | "orgless" | "member" | "owner" | "plain_member"; run: (c: Ctx) => Promise<Out> };

const ok = (body: Record<string, unknown> = {}): Out => ({ body: { ok: true, ...body } });
const fail = (status: number, error: string, extra: Record<string, unknown> = {}): Out => ({ status, body: { ok: false, error, ...extra } });

async function sha256Hex(raw: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(raw));
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
}
async function rest(path: string, init: RequestInit = {}): Promise<Response> {
  return await fetch(`${SUPABASE_URL}/rest/v1/${path}`, { ...init, headers: { ...JSON_H, ...(init.headers || {}) } });
}
async function rows(path: string): Promise<any[] | null> {
  const r = await rest(path);
  if (!r.ok) return null;
  const j = await r.json();
  return Array.isArray(j) ? j : null;
}
// A read made to AUTHENTICATE a request. null means the read itself failed (a database / network hiccup); [] means the database answered and there is no such
// row. The two must never be confused: only "no such row" is an invalid session. One quick retry, because these are plain idempotent reads.
async function authRead(path: string): Promise<any[] | null> {
  for (let i = 0; i < 2; i++) {
    try { const r = await rows(path); if (r) return r; } catch (_e) { /* retried once below */ }
    if (i === 0) await new Promise((res) => setTimeout(res, 150));
  }
  return null;
}
function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
const RETURN_BASE = "https://alpha.applitrust.com/employer.html";
const LIVE_STATUSES = ["active", "trialing", "past_due", "unpaid", "incomplete"];

async function stripe(method: string, path: string, form?: Record<string, string>, idem?: string): Promise<{ ok: boolean; status: number; data: any }> {
  const body = form ? new URLSearchParams(form).toString() : undefined;
  const r = await fetch(`https://api.stripe.com${path}`, {
    method,
    headers: { "Authorization": `Bearer ${STRIPE_SECRET_KEY}`, ...(body ? { "Content-Type": "application/x-www-form-urlencoded" } : {}), ...(idem ? { "Idempotency-Key": idem } : {}) },
    body,
  });
  return { ok: r.ok, status: r.status, data: await r.json().catch(() => ({})) };
}
// A live subscription whose last renewal could not be charged: lookups are paused until it is paid (see employer-stripe-events).
const PAYMENT_PROBLEM_STATUSES = ["past_due", "unpaid"];
async function hasPaymentProblem(orgId: string): Promise<boolean> {
  const s = (await rows(`employer_org_subscriptions?org_id=eq.${orgId}&select=status,payment_failed_at&order=created_at.desc&limit=1`))?.[0];
  return !!s && (PAYMENT_PROBLEM_STATUSES.includes(s.status) || (LIVE_STATUSES.includes(s.status) && !!s.payment_failed_at));
}
async function liveSubscription(orgId: string): Promise<any | null> {
  return (await rows(`employer_org_subscriptions?org_id=eq.${orgId}&status=in.(${LIVE_STATUSES.join(",")})&select=*&order=created_at.desc&limit=1`))?.[0] || null;
}
function cleanName(v: unknown, min: number, max: number): string | null {
  if (typeof v !== "string") return null;
  const t = v.replace(/\s+/g, " ").trim();
  return t.length >= min && t.length <= max ? t : null;
}

const OPEN_ANSWER_STATUS_NOTE = "not_authorized";
// What an employer is told about a request. A candidate's decline, a timeout and a deactivation are one and the same outcome.
function employerStatus(r: any, hasSnapshot: boolean): string {
  const now = Date.now();
  if (r.status === "pending") return new Date(r.expires_at).getTime() > now ? "awaiting_candidate" : OPEN_ANSWER_STATUS_NOTE;
  if (r.status === "declined") return OPEN_ANSWER_STATUS_NOTE;
  if (r.status === "expired" && !r.approved_at) return OPEN_ANSWER_STATUS_NOTE;
  if (r.status === "approved" && hasSnapshot) return r.first_delivered_at ? "opened" : "ready";
  return "ended";
}

const ACTIONS: Record<string, Action> = {
  // ---- identity ----
  me: {
    access: "any",
    run: async ({ user, org }) => {
      const nowIso = new Date().toISOString();
      const inv = (await rows(`employer_org_invites?email=eq.${encodeURIComponent(user.email)}&status=eq.pending&expires_at=gt.${encodeURIComponent(nowIso)}&select=id,org_id,invited_by,expires_at,created_at&order=created_at.desc&limit=25`)) || [];
      const orgIds = [...new Set(inv.map((i) => i.org_id))];
      const byIds = [...new Set(inv.map((i) => i.invited_by).filter(Boolean))];
      const orgs = orgIds.length ? (await rows(`employer_orgs?id=in.(${orgIds.join(",")})&select=id,name`)) || [] : [];
      const inviters = byIds.length ? (await rows(`employer_users?id=in.(${byIds.join(",")})&select=id,name,email`)) || [] : [];
      return ok({
        user: { id: user.id, email: user.email, name: user.name },
        org: org ? { id: org.id, name: org.name } : null,
        role: user.role,
        pending_invites: inv.map((i) => {
          const o = orgs.find((x) => x.id === i.org_id);
          const by = inviters.find((x) => x.id === i.invited_by);
          return { id: i.id, org_name: o ? o.name : "(organization)", invited_by: by ? (by.name || by.email) : null, expires_at: i.expires_at };
        }),
      });
    },
  },
  logout: {
    access: "any",
    run: async ({ sessionId }) => {
      const r = await rest(`employer_sessions?id=eq.${sessionId}`, { method: "PATCH", headers: { "Prefer": "return=minimal" }, body: JSON.stringify({ revoked_at: new Date().toISOString() }) });
      return r.ok ? ok() : fail(500, "logout_failed");
    },
  },
  // Payment history (2026-09-22): every one-off payment made under the signed-in person's own email, whether or not
  // they had an account at the time -- same trick list_lookups already uses for pre-account activity, matched purely
  // by email string, not by a link recorded at payment time. Read-only.
  list_payments: {
    access: "any",
    run: async ({ user }) => {
      const r = await rest("rpc/list_employer_payments", { method: "POST", body: JSON.stringify({ p_email: user.email }) });
      if (!r.ok) return fail(500, "list_failed");
      const list = await r.json();
      return ok({
        payments: (Array.isArray(list) ? list : []).map((p: any) => ({
          id: p.id, amount_cents: p.amount_cents, currency: p.currency, kind: p.kind || "resume_comparison",
          candidate_label: p.candidate_label || null, company: p.company || null, status: p.status,
          date: p.paid_at || p.created_at, receipt_url: p.receipt_url || null,
        })),
      });
    },
  },
  update_profile: {
    access: "any",
    run: async ({ user, p }) => {
      const name = cleanName(p.name, 1, 120);
      if (!name) return fail(400, "name_invalid");
      const r = await rest(`employer_users?id=eq.${user.id}`, { method: "PATCH", headers: { "Prefer": "return=minimal" }, body: JSON.stringify({ name }) });
      return r.ok ? ok({ name }) : fail(500, "update_failed");
    },
  },

  // ---- org lifecycle ----
  create_org: {
    access: "orgless",
    run: async ({ user, p }) => {
      const name = cleanName(p.name, 2, 120);
      if (!name) return fail(400, "org_name_invalid");
      const orgRes = await rest("employer_orgs", { method: "POST", headers: { "Prefer": "return=representation" }, body: JSON.stringify({ name }) });
      if (!orgRes.ok) return fail(500, "org_create_failed");
      const org = (await orgRes.json())[0];
      // Conditional on the caller still having no org: two simultaneous creates from one user cannot both win.
      const claim = await rest(`employer_users?id=eq.${user.id}&org_id=is.null`, { method: "PATCH", headers: { "Prefer": "return=representation" }, body: JSON.stringify({ org_id: org.id, role: "owner" }) });
      const claimed = claim.ok ? await claim.json() : [];
      if (!Array.isArray(claimed) || claimed.length === 0) {
        await rest(`employer_orgs?id=eq.${org.id}`, { method: "DELETE" });
        return fail(409, "already_in_org");
      }
      return ok({ org: { id: org.id, name: org.name }, role: "owner" });
    },
  },
  rename_org: {
    access: "owner",
    run: async ({ org, p }) => {
      const name = cleanName(p.name, 2, 120);
      if (!name) return fail(400, "org_name_invalid");
      const r = await rest(`employer_orgs?id=eq.${org!.id}`, { method: "PATCH", headers: { "Prefer": "return=minimal" }, body: JSON.stringify({ name }) });
      return r.ok ? ok({ org: { id: org!.id, name } }) : fail(500, "update_failed");
    },
  },
  list_members: {
    access: "member",
    run: async ({ user, org }) => {
      const members = await rows(`employer_users?org_id=eq.${org!.id}&select=id,email,name,role,created_at&order=created_at.asc&limit=500`);
      if (!members) return fail(500, "list_failed");
      let invites: any[] = [];
      if (user.role === "owner") {
        const nowIso = new Date().toISOString();
        invites = (await rows(`employer_org_invites?org_id=eq.${org!.id}&status=eq.pending&expires_at=gt.${encodeURIComponent(nowIso)}&select=id,email,created_at,expires_at&order=created_at.desc&limit=100`)) || [];
      }
      return ok({ org: { id: org!.id, name: org!.name }, members, pending_invites: invites, is_owner: user.role === "owner" });
    },
  },

  // ---- membership (owner only) ----
  invite_member: {
    access: "owner",
    run: async ({ user, org, p }) => {
      const email = typeof p.email === "string" ? p.email.trim().toLowerCase().slice(0, 254) : "";
      if (!EMAIL.test(email)) return fail(400, "email_invalid");
      const mine = await rows(`employer_users?org_id=eq.${org!.id}&email=eq.${encodeURIComponent(email)}&select=id`);
      if (mine && mine.length) return fail(409, "already_member");

      const nowIso = new Date().toISOString();
      const since = new Date(Date.now() - 60 * 60 * 1000).toISOString();
      const [pending, recent] = await Promise.all([
        rows(`employer_org_invites?org_id=eq.${org!.id}&status=eq.pending&expires_at=gt.${encodeURIComponent(nowIso)}&select=id&limit=${MAX_PENDING_INVITES + 1}`),
        rows(`employer_org_invites?org_id=eq.${org!.id}&created_at=gte.${encodeURIComponent(since)}&select=id&limit=${MAX_INVITES_PER_HOUR + 1}`),
      ]);
      if (!pending || !recent) return fail(500, "invite_failed");
      if (pending.length >= MAX_PENDING_INVITES) return fail(429, "too_many_pending_invites");
      if (recent.length >= MAX_INVITES_PER_HOUR) return fail(429, "rate_limited");

      // An invite that ran out its 14 days is still status 'pending' until something closes it, and would block
      // a fresh one through the one-pending-per-(org,email) index: close any such stale row first.
      await rest(`employer_org_invites?org_id=eq.${org!.id}&email=eq.${encodeURIComponent(email)}&status=eq.pending&expires_at=lt.${encodeURIComponent(nowIso)}`, {
        method: "PATCH", headers: { "Prefer": "return=minimal" }, body: JSON.stringify({ status: "revoked", responded_at: nowIso }),
      });
      const expiresAt = new Date(Date.now() + INVITE_DAYS * 24 * 60 * 60 * 1000).toISOString();
      const ins = await rest("employer_org_invites", { method: "POST", headers: { "Prefer": "return=representation" }, body: JSON.stringify({ org_id: org!.id, email, invited_by: user.id, expires_at: expiresAt }) });
      if (ins.status === 409) return ok({ already_pending: true }); // a live invite exists: no second email
      if (!ins.ok) return fail(500, "invite_failed");
      const invite = (await ins.json())[0];

      const who = user.name || user.email;
      const emailRes = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": `Bearer ${RESEND_API_KEY}` },
        body: JSON.stringify({
          from: "Verifi <verify@applitrust.com>",
          to: email,
          subject: `${who} invited you to join ${org!.name} on Verifi`,
          html: `<p>${esc(who)} (${esc(user.email)}) invited you to join <b>${esc(org!.name)}</b> on Verifi employer access.</p><p>Sign in with this email address at <a href="https://alpha.applitrust.com/employer.html">https://alpha.applitrust.com/employer.html</a> and accept the invitation there. Members can run and see the organization's checks; only the owner manages billing and members. The invitation expires in ${INVITE_DAYS} days. If you weren't expecting it, ignore this email.</p>`,
        }),
      });
      if (!emailRes.ok) {
        await rest(`employer_org_invites?id=eq.${invite.id}`, { method: "DELETE" });
        return fail(502, "email_failed");
      }
      return ok({ invite: { id: invite.id, email, expires_at: expiresAt } });
    },
  },
  revoke_invite: {
    access: "owner",
    run: async ({ org, p }) => {
      if (typeof p.invite_id !== "string" || !UUID.test(p.invite_id)) return fail(400, "invite_id_invalid");
      const r = await rest(`employer_org_invites?id=eq.${p.invite_id}&org_id=eq.${org!.id}&status=eq.pending`, {
        method: "PATCH", headers: { "Prefer": "return=representation" }, body: JSON.stringify({ status: "revoked", responded_at: new Date().toISOString() }),
      });
      const changed = r.ok ? await r.json() : [];
      return Array.isArray(changed) && changed.length ? ok() : fail(404, "not_found");
    },
  },
  remove_member: {
    access: "owner",
    run: async ({ user, org, p }) => {
      if (typeof p.user_id !== "string" || !UUID.test(p.user_id)) return fail(400, "user_id_invalid");
      if (p.user_id === user.id) return fail(409, "owner_cannot_be_removed");
      // Scoped to the caller's own org: a user in another org is indistinguishable from one that does not exist.
      const r = await rest(`employer_users?id=eq.${p.user_id}&org_id=eq.${org!.id}&role=eq.member`, {
        method: "PATCH", headers: { "Prefer": "return=representation" }, body: JSON.stringify({ org_id: null, role: null }),
      });
      const changed = r.ok ? await r.json() : [];
      return Array.isArray(changed) && changed.length ? ok() : fail(404, "not_found");
    },
  },
  leave_org: {
    access: "plain_member",
    run: async ({ user, org }) => {
      const r = await rest(`employer_users?id=eq.${user.id}&org_id=eq.${org!.id}&role=eq.member`, {
        method: "PATCH", headers: { "Prefer": "return=representation" }, body: JSON.stringify({ org_id: null, role: null }),
      });
      const changed = r.ok ? await r.json() : [];
      return Array.isArray(changed) && changed.length ? ok() : fail(409, "could_not_leave");
    },
  },

  // ---- invitations (the invitee's side) ----
  accept_invite: {
    access: "any",
    run: async ({ user, p }) => {
      if (typeof p.invite_id !== "string" || !UUID.test(p.invite_id)) return fail(400, "invite_id_invalid");
      if (user.org_id) return fail(409, "already_in_org"); // one org per person
      const nowIso = new Date().toISOString();
      // Claim the invite atomically: it must be MINE (email match), still pending, and unexpired.
      const claim = await rest(`employer_org_invites?id=eq.${p.invite_id}&email=eq.${encodeURIComponent(user.email)}&status=eq.pending&expires_at=gt.${encodeURIComponent(nowIso)}`, {
        method: "PATCH", headers: { "Prefer": "return=representation" }, body: JSON.stringify({ status: "accepted", responded_at: nowIso }),
      });
      const claimed = claim.ok ? await claim.json() : [];
      if (!Array.isArray(claimed) || claimed.length === 0) return fail(404, "not_found");
      const invite = claimed[0];
      // Join only if still without an org; if that lost a race, put the invite back.
      const join = await rest(`employer_users?id=eq.${user.id}&org_id=is.null`, {
        method: "PATCH", headers: { "Prefer": "return=representation" }, body: JSON.stringify({ org_id: invite.org_id, role: "member" }),
      });
      const joined = join.ok ? await join.json() : [];
      if (!Array.isArray(joined) || joined.length === 0) {
        await rest(`employer_org_invites?id=eq.${invite.id}`, { method: "PATCH", headers: { "Prefer": "return=minimal" }, body: JSON.stringify({ status: "pending", responded_at: null }) });
        return fail(409, "already_in_org");
      }
      return ok({ org_id: invite.org_id, role: "member" });
    },
  },
  decline_invite: {
    access: "any",
    run: async ({ user, p }) => {
      if (typeof p.invite_id !== "string" || !UUID.test(p.invite_id)) return fail(400, "invite_id_invalid");
      const nowIso = new Date().toISOString();
      const r = await rest(`employer_org_invites?id=eq.${p.invite_id}&email=eq.${encodeURIComponent(user.email)}&status=eq.pending`, {
        method: "PATCH", headers: { "Prefer": "return=representation" }, body: JSON.stringify({ status: "declined", responded_at: nowIso }),
      });
      const changed = r.ok ? await r.json() : [];
      return Array.isArray(changed) && changed.length ? ok() : fail(404, "not_found");
    },
  },

  // ---- billing ----
  billing_status: {
    access: "member",
    run: async ({ user, org }) => {
      const pricing = (await rows(`employer_pricing?key=eq.org_subscription_monthly&select=amount_cents,currency,included_lookups,note`))?.[0] || null;
      // The live subscription if there is one, otherwise the most recent one (so a just-canceled plan still shows).
      const sub = (await liveSubscription(org!.id)) || (await rows(`employer_org_subscriptions?org_id=eq.${org!.id}&select=*&order=created_at.desc&limit=1`))?.[0] || null;
      let used = 0;
      if (sub) {
        const start = sub.current_period_start || sub.created_at;
        const u = await rows(`employer_lookup_usage?subscription_id=eq.${sub.id}&used_at=gte.${encodeURIComponent(start)}&select=id&limit=10000`);
        used = u ? u.length : 0;
      }
      return ok({
        is_owner: user.role === "owner",
        pricing: pricing ? { amount_cents: pricing.amount_cents, currency: pricing.currency, included_lookups: pricing.included_lookups, placeholder: true } : null,
        subscription: sub ? {
          status: sub.status, current_period_start: sub.current_period_start, current_period_end: sub.current_period_end,
          cancel_at_period_end: sub.cancel_at_period_end, canceled_at: sub.canceled_at,
          included_lookups: sub.included_lookups, unit_amount_cents: sub.unit_amount_cents, currency: sub.currency,
          used, remaining: Math.max(sub.included_lookups - used, 0), live: LIVE_STATUSES.includes(sub.status),
          // the last renewal could not be charged: lookups are paused until it is paid
          payment_problem: LIVE_STATUSES.includes(sub.status) && (PAYMENT_PROBLEM_STATUSES.includes(sub.status) || !!sub.payment_failed_at),
          payment_failed_at: sub.payment_failed_at || null,
        } : null,
      });
    },
  },
  start_subscription: {
    access: "owner",
    run: async ({ user, org }) => {
      if (await liveSubscription(org!.id)) return fail(409, "already_subscribed");
      const pricing = (await rows(`employer_pricing?key=eq.org_subscription_monthly&select=amount_cents,currency,included_lookups`))?.[0];
      if (!pricing || !pricing.included_lookups) return fail(500, "pricing_unavailable");

      // One Stripe customer per org, created once. The idempotency key makes two simultaneous creates return the same
      // customer, and the conditional PATCH keeps whichever id got stored first.
      const o = (await rows(`employer_orgs?id=eq.${org!.id}&select=stripe_customer_id`))?.[0];
      let customerId: string | null = o?.stripe_customer_id || null;
      // Two clicks at once: Stripe answers the second create (same idempotency key, first still in flight) with a 409
      // "in use". That is not a failure: wait for the first to store its customer id and use that.
      for (let attempt = 0; !customerId && attempt < 6; attempt++) {
        const c = await stripe("POST", "/v1/customers", {
          email: user.email, name: org!.name, "metadata[org_id]": org!.id, "metadata[product]": "employer_org_subscription", "metadata[owner_user_id]": user.id,
        }, `employer-org-customer-${org!.id}`);
        if (c.ok) {
          customerId = c.data.id as string;
          const stored = await rest(`employer_orgs?id=eq.${org!.id}&stripe_customer_id=is.null`, { method: "PATCH", headers: { "Prefer": "return=representation" }, body: JSON.stringify({ stripe_customer_id: customerId }) });
          const storedRows = stored.ok ? await stored.json() : [];
          if (!Array.isArray(storedRows) || storedRows.length === 0) customerId = (await rows(`employer_orgs?id=eq.${org!.id}&select=stripe_customer_id`))?.[0]?.stripe_customer_id || customerId;
        } else if (c.status === 409) {
          await new Promise((r) => setTimeout(r, 400));
          customerId = (await rows(`employer_orgs?id=eq.${org!.id}&select=stripe_customer_id`))?.[0]?.stripe_customer_id || null;
        } else {
          return fail(502, "stripe_error");
        }
      }
      if (!customerId) return fail(503, "try_again");

      const meta = { product: "employer_org_subscription", org_id: org!.id, owner_user_id: user.id, included_lookups: String(pricing.included_lookups), unit_amount_cents: String(pricing.amount_cents) };
      const form: Record<string, string> = {
        mode: "subscription", customer: customerId!, client_reference_id: org!.id,
        success_url: `${RETURN_BASE}?billing=success`, cancel_url: `${RETURN_BASE}?billing=cancel`,
        "line_items[0][quantity]": "1",
        "line_items[0][price_data][currency]": pricing.currency,
        "line_items[0][price_data][unit_amount]": String(pricing.amount_cents),
        "line_items[0][price_data][recurring][interval]": "month",
        "line_items[0][price_data][product_data][name]": "Verifi employer comparisons (monthly)",
        "line_items[0][price_data][product_data][description]": `${pricing.included_lookups} comparison lookups per billing period, shared by everyone in ${org!.name}. Billed monthly; the organization owner can cancel any time.`,
      };
      for (const [k, v] of Object.entries(meta)) { form[`metadata[${k}]`] = v; form[`subscription_data[metadata][${k}]`] = v; }
      let sess = await stripe("POST", "/v1/checkout/sessions", form);
      if (!sess.ok && sess.data?.error?.code === "resource_missing" && String(sess.data?.error?.param || "").includes("customer")) {
        // The stored Stripe customer no longer exists (deleted on the Stripe side). Without this the org could never
        // subscribe again: make a fresh customer (a NEW idempotency key, since the old one would replay the dead
        // customer for 24 hours), store it, and retry once.
        const c = await stripe("POST", "/v1/customers", {
          email: user.email, name: org!.name, "metadata[org_id]": org!.id, "metadata[product]": "employer_org_subscription", "metadata[owner_user_id]": user.id,
        }, `employer-org-customer-${org!.id}-${Date.now()}`);
        if (!c.ok) return fail(502, "stripe_error");
        await rest(`employer_orgs?id=eq.${org!.id}`, { method: "PATCH", headers: { "Prefer": "return=minimal" }, body: JSON.stringify({ stripe_customer_id: c.data.id }) });
        form.customer = c.data.id as string;
        sess = await stripe("POST", "/v1/checkout/sessions", form);
      }
      if (!sess.ok || !sess.data.url) return fail(502, "stripe_error");
      return ok({ url: sess.data.url });
    },
  },
  cancel_subscription: {
    access: "owner",
    run: async ({ org, p }) => {
      const sub = await liveSubscription(org!.id);
      if (!sub || !["active", "trialing", "past_due"].includes(sub.status)) return fail(404, "no_subscription");
      const now = p.when === "now";
      // Only ASKS Stripe. The subscription row changes when the verified webhook says so.
      const r = now
        ? await stripe("DELETE", `/v1/subscriptions/${encodeURIComponent(sub.stripe_subscription_id)}`)
        : await stripe("POST", `/v1/subscriptions/${encodeURIComponent(sub.stripe_subscription_id)}`, { cancel_at_period_end: "true" });
      if (!r.ok) return fail(502, "stripe_error");
      return ok({ requested: now ? "cancel_now" : "cancel_at_period_end" });
    },
  },
  resume_subscription: {
    access: "owner",
    run: async ({ org }) => {
      const sub = await liveSubscription(org!.id);
      if (!sub || sub.status !== "active" || !sub.cancel_at_period_end) return fail(404, "nothing_to_resume");
      const r = await stripe("POST", `/v1/subscriptions/${encodeURIComponent(sub.stripe_subscription_id)}`, { cancel_at_period_end: "false" });
      return r.ok ? ok({ requested: "resume" }) : fail(502, "stripe_error");
    },
  },
  billing_portal: {
    access: "owner",
    run: async ({ org }) => {
      const o = (await rows(`employer_orgs?id=eq.${org!.id}&select=stripe_customer_id`))?.[0];
      if (!o?.stripe_customer_id) return fail(409, "no_billing_account");
      // Payment-method changes go through Stripe's hosted portal. It is configured once (payment method + invoice history
      // only; cancellation stays with cancel_subscription so it is handled the same way everywhere) and the id remembered.
      let configId = (await rows(`employer_pricing?key=eq.portal_configuration&select=note`))?.[0]?.note || null;
      if (!configId) {
        const c = await stripe("POST", "/v1/billing_portal/configurations", {
          "business_profile[headline]": "Verifi employer billing",
          "features[payment_method_update][enabled]": "true",
          "features[invoice_history][enabled]": "true",
          "features[customer_update][enabled]": "false",
          "features[subscription_cancel][enabled]": "false",
        });
        if (!c.ok) return fail(502, "stripe_error");
        configId = c.data.id as string;
        await rest("employer_pricing", { method: "POST", headers: { "Prefer": "resolution=merge-duplicates,return=minimal" }, body: JSON.stringify({ key: "portal_configuration", amount_cents: 0, note: configId }) });
      }
      const s = await stripe("POST", "/v1/billing_portal/sessions", { customer: o.stripe_customer_id, return_url: `${RETURN_BASE}?billing=return`, configuration: configId! });
      return s.ok && s.data.url ? ok({ url: s.data.url }) : fail(502, "stripe_error");
    },
  },

  // ---- comparisons (Stage 2) ----
  list_lookups: {
    access: "member",
    run: async ({ user }) => {
      const r = await rest("rpc/list_employer_lookups", { method: "POST", body: JSON.stringify({ p_email: user.email }) });
      if (!r.ok) return fail(500, "list_failed");
      const list = await r.json();
      return ok({
        lookups: (Array.isArray(list) ? list : []).map((l: any) => ({
          lookup_id: l.lookup_id, candidate_label: l.candidate_label || "Candidate", completed_at: l.completed_at,
          open_request_id: l.open_request_id || null,
        })),
      });
    },
  },
  request_comparison: {
    access: "member",
    run: async ({ user, p }) => {
      if (typeof p.lookup_id !== "string" || !UUID.test(p.lookup_id)) return fail(400, "lookup_id_invalid");
      const attestation = typeof p.attestation === "string" ? p.attestation : "";
      // the employer's own document, uploaded first through employer-document; create_comparison_request binds it to the request atomically
      const documentId = typeof p.document_id === "string" && UUID.test(p.document_id) ? p.document_id : null;
      const r = await rest("rpc/create_comparison_request", { method: "POST", body: JSON.stringify({ p_lookup_id: p.lookup_id, p_method: "org", p_employer_user: user.id, p_attestation: attestation, p_document_id: documentId }) });
      if (!r.ok) return fail(500, "request_failed");
      const res = (await r.json())?.[0];
      if (!res) return fail(500, "request_failed");
      // `detail` (why the candidate was unavailable) is never forwarded.
      if (!res.ok) {
        if (res.reason === "attestation_invalid") return fail(400, "attestation_invalid");
        if (res.reason === "document_required") return fail(400, "document_required");
        if (res.reason === "document_invalid") return fail(400, "document_invalid");
        if (res.reason === "subscription_required") return fail(402, (await hasPaymentProblem(user.org_id!)) ? "payment_problem" : "subscription_required");
        if (res.reason === "rate_limited") return fail(429, "rate_limited");
        if (res.reason === "already_open") return fail(409, "already_requested", { request_id: res.request_id });
        return fail(409, "unavailable");
      }
      // Tell the candidate. Never fails the request: the candidate function's sweep retries an unsent notice.
      let notified = false;
      try {
        const n = await fetch(`${SUPABASE_URL}/functions/v1/candidate-comparison-requests`, {
          method: "POST", headers: { "Authorization": `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`, "Content-Type": "application/json" },
          body: JSON.stringify({ action: "notify_candidate", request_id: res.request_id }),
        });
        notified = n.ok && (await n.json().catch(() => ({})))?.sent === true;
      } catch (_e) { /* the sweep retries */ }
      return ok({ request_id: res.request_id, status: "awaiting_candidate", candidate_notified: notified });
    },
  },
  list_comparisons: {
    access: "member",
    run: async ({ user, org }) => {
      // A member sees their own requests made for THIS organization: leaving an organization cuts access to what was requested for it.
      const scope = user.role === "owner" ? `org_id=eq.${org!.id}` : `employer_user_id=eq.${user.id}&org_id=eq.${org!.id}`;
      const reqs = await rows(`comparison_requests?${scope}&select=id,status,created_at,expires_at,approved_at,snapshot_expires_at,first_delivered_at,employer_user_id,lookup_id,attestation,kind&order=created_at.desc&limit=100`);
      if (!reqs) return fail(500, "list_failed");
      const ids = reqs.map((r) => r.id);
      const snaps = ids.length ? await rows(`comparison_snapshots?request_id=in.(${ids.join(",")})&select=request_id`) : [];
      const lookupIds = [...new Set(reqs.map((r) => r.lookup_id).filter(Boolean))];
      const lookups = lookupIds.length ? await rows(`employer_lookup_requests?id=in.(${lookupIds.join(",")})&select=id,candidate_label`) : [];
      const userIds = [...new Set(reqs.map((r) => r.employer_user_id).filter(Boolean))];
      const users = user.role === "owner" && userIds.length ? await rows(`employer_users?id=in.(${userIds.join(",")})&select=id,name,email`) : [];
      const hasSnap = new Set((snaps || []).map((s) => s.request_id));
      return ok({
        is_owner: user.role === "owner",
        comparisons: reqs.map((r) => {
          const status = employerStatus(r, hasSnap.has(r.id));
          const lk = (lookups || []).find((l) => l.id === r.lookup_id);
          const by = (users || []).find((u) => u.id === r.employer_user_id);
          return {
            // the kind is disclosed only once the candidate approved (ready / opened): before that it would reveal the candidate's account type
            id: r.id, status, kind: status === "ready" || status === "opened" ? (r.kind || "resume_comparison") : null, candidate_label: lk?.candidate_label || "Candidate", requested_at: r.created_at,
            answer_by: status === "awaiting_candidate" ? r.expires_at : null,
            available_until: status === "ready" ? r.snapshot_expires_at : null,
            opened_at: r.first_delivered_at, mine: r.employer_user_id === user.id,
            can_open: r.employer_user_id === user.id && (status === "ready" || status === "opened"),
            requested_by: user.role === "owner" ? (by ? (by.name || by.email) : "(former member)") : null,
            attestation: r.employer_user_id === user.id ? r.attestation : null,
          };
        }),
      });
    },
  },
  open_comparison: {
    access: "member",
    run: async ({ user, org, p }) => {
      if (typeof p.request_id !== "string" || !UUID.test(p.request_id)) return fail(400, "request_id_invalid");
      // Only the person who asked can open it, and only while still in the organization the request was made for.
      const r = (await rows(`comparison_requests?id=eq.${p.request_id}&employer_user_id=eq.${user.id}&select=id,status,org_id,first_delivered_at,snapshot_expires_at`))?.[0];
      if (!r || r.org_id !== org!.id) return fail(404, "not_found");
      if (r.status !== "approved") return fail(404, "not_available");
      const snap = (await rows(`comparison_snapshots?request_id=eq.${r.id}&select=content,assembled_at`))?.[0];
      if (!snap) return fail(404, "not_available");

      let quota: { used: number; included: number; remaining: number } | null = null;
      let metered = false;
      if (!r.first_delivered_at) {
        // DELIVERY: the first open. Spend one lookup from the organization's current period, keyed by this request so it counts once.
        const mr = await rest("rpc/consume_org_lookup", { method: "POST", body: JSON.stringify({ p_org: r.org_id, p_user: user.id, p_reference: r.id }) });
        if (!mr.ok) return fail(500, "metering_failed");
        const m = (await mr.json())?.[0];
        if (!m) return fail(500, "metering_failed");
        if (!m.ok) {
          // Nothing was consumed and nothing is delivered; the approved snapshot keeps waiting.
          if (m.reason !== "quota_exhausted" && await hasPaymentProblem(r.org_id)) return fail(402, "payment_problem", { reason: m.reason });
          return fail(402, m.reason === "quota_exhausted" ? "quota_exhausted" : "no_active_subscription", { reason: m.reason, used: m.used, included: m.included });
        }
        metered = m.reason === "counted";
        quota = { used: m.used, included: m.included, remaining: m.remaining };
        // Stamp the first delivery once (a concurrent open that lost this race is still served: the lookup was counted once above).
        await rest(`comparison_requests?id=eq.${r.id}&first_delivered_at=is.null`, { method: "PATCH", headers: { "Prefer": "return=minimal" }, body: JSON.stringify({ first_delivered_at: new Date().toISOString() }) });
      }
      return ok({ content: snap.content, assembled_at: snap.assembled_at, metered, quota, first_open: !r.first_delivered_at });
    },
  },
};

export default {
  fetch: withSupabase({ auth: "none" }, async (req, _ctx) => {
    if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
    const send = (o: Out) => new Response(JSON.stringify(o.body), { status: o.status || 200, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    try {
      let body: any = {};
      try { body = await req.json(); } catch (_e) { body = {}; }

      // 1. AUTHENTICATE
      const raw = typeof body.session_token === "string" ? body.session_token : "";
      if (!raw || raw.length > 200) return send(fail(401, "invalid_session"));
      const hash = await sha256Hex(raw);
      // 401 invalid_session ONLY when the database positively says the session is not valid. If the lookup itself failed we do not know, so 503: the client
      // keeps its stored session and tries again instead of signing the person out.
      const sessRows = await authRead(`employer_sessions?token_hash=eq.${hash}&select=id,employer_user_id,expires_at,revoked_at`);
      if (!sessRows) return send(fail(503, "temporarily_unavailable"));
      const sess = sessRows[0];
      if (!sess || sess.revoked_at || new Date(sess.expires_at) < new Date()) return send(fail(401, "invalid_session"));

      // 2. DERIVE identity (org + role) from the database on this request
      const userRows = await authRead(`employer_users?id=eq.${sess.employer_user_id}&select=id,email,name,org_id,role`);
      if (!userRows) return send(fail(503, "temporarily_unavailable"));
      const user = userRows[0] as User | undefined;
      if (!user) return send(fail(401, "invalid_session"));
      let org: Org | null = null;
      if (user.org_id) {
        const orgRows = await authRead(`employer_orgs?id=eq.${user.org_id}&select=id,name`);
        if (!orgRows) return send(fail(503, "temporarily_unavailable"));
        const o = orgRows[0];
        if (!o) return send(fail(401, "invalid_session"));
        org = o as Org;
      }

      // 3. AUTHORIZE (deny by default)
      const name = typeof body.action === "string" ? body.action : "";
      const action = Object.prototype.hasOwnProperty.call(ACTIONS, name) ? ACTIONS[name] : null;
      if (!action) return send(fail(404, "unknown_action"));
      const allowed =
        action.access === "any" ? true :
        action.access === "orgless" ? !user.org_id :
        action.access === "member" ? !!user.org_id :
        action.access === "owner" ? user.role === "owner" :
        action.access === "plain_member" ? user.role === "member" : false;
      if (!allowed) {
        if (action.access === "owner") return send(fail(403, "forbidden", { required: "owner" }));
        if (action.access === "orgless") return send(fail(409, "already_in_org"));
        return send(fail(403, "forbidden", { required: action.access === "plain_member" && user.role === "owner" ? "not_owner" : "org_member" }));
      }

      // Best-effort activity touch; never fails a valid request.
      fetch(`${SUPABASE_URL}/rest/v1/employer_sessions?id=eq.${sess.id}`, { method: "PATCH", headers: { ...JSON_H, "Prefer": "return=minimal" }, body: JSON.stringify({ last_seen_at: new Date().toISOString() }) }).catch(() => {});

      // 4. RUN
      const params = body.params && typeof body.params === "object" ? body.params : {};
      return send(await action.run({ user, org, sessionId: sess.id, p: params }));
    } catch (_e) {
      return send(fail(500, "request_failed"));
    }
  }),
};
