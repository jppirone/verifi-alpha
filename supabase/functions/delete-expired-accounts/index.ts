// Setup type definitions for built-in Supabase Runtime APIs
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { withSupabase } from "jsr:@supabase/server@1";

// Real account deletion, the part that talks to Stripe (2026-09-21). See 20260921030000_account_deletion.sql for the whole story.
//
// Run hourly by pg_cron (over pg_net) with a shared secret (x-deletion-secret) that lives only in the database (internal_job_secrets); nothing
// else can call it. For every account whose deletion_scheduled_at is 30 or more days old (due_account_deletions), oldest first, at most 10 a run:
//   1. BILLING FIRST. Deactivation asks Stripe to cancel the subscription, but that request is best effort (the screen has an "unconfirmed"
//      state), so a deactivated account can still be billed on day 30. Here: look the stored subscription up; cancel it if it is not already
//      canceled; also cancel any other live subscription Stripe has tagged with this candidate's id (subscriptions are stamped with it in their
//      metadata since 2026-09-20); then delete the Stripe customer(s) those subscriptions belonged to, so the person's name and email do not
//      linger there once the account is gone (Stripe keeps the payment history for its own records). A failure that leaves billing possible
//      (cannot look the subscription up, cannot cancel it) means "skip this account this run, try again next hour": it is NEVER deleted while
//      it may still be billed. A customer that cannot be deleted does not leave a billing risk (its subscriptions are already canceled), so it
//      is retried on the next runs and, after the third attempt, the deletion goes ahead anyway and the customer id is written to the log so it
//      can be removed by hand.
//   2. Then the ONE database call, delete_candidate_account(candidate, billing_cleared = true), which re-checks the 30 days, the exempt list and
//      the reactivation race under a row lock and deletes everything in one transaction.
//   3. Then the storage purge is nudged so the deleted account's files are gone within seconds rather than at the next 15-minute run.
// Results go to account_deletion_log (no personal data). The response lists candidate ids and outcomes only.
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const STRIPE_SECRET_KEY = Deno.env.get("STRIPE_SECRET_KEY") ?? "";
const REST = { "apikey": SERVICE_KEY, "Authorization": `Bearer ${SERVICE_KEY}`, "Content-Type": "application/json" };
const MAX_PER_RUN = 10;
const CUSTOMER_DELETE_ATTEMPTS = 3;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function rpc(name: string, args: Record<string, unknown>): Promise<{ ok: boolean; data: any; text: string }> {
  try {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${name}`, { method: "POST", headers: REST, body: JSON.stringify(args) });
    const text = await r.text();
    let data: any = null; try { data = JSON.parse(text); } catch (_e) { /* not json */ }
    return { ok: r.ok, data, text };
  } catch (e) { return { ok: false, data: null, text: String(e) }; }
}

// status 0 = the request never got an answer (network / timeout): treated like any other failure by callers.
async function stripe(method: string, path: string): Promise<{ status: number; data: any }> {
  try {
    const r = await fetch(`https://api.stripe.com${path}`, { method, headers: { "Authorization": "Bearer " + STRIPE_SECRET_KEY }, signal: AbortSignal.timeout(20000) });
    return { status: r.status, data: await r.json().catch(() => ({})) };
  } catch (_e) { return { status: 0, data: {} }; }
}
const custId = (c: unknown): string => typeof c === "string" ? c : (c && typeof c === "object" && typeof (c as any).id === "string" ? (c as any).id : "");

type Billing = { cleared: boolean; blocked?: string; detail: Record<string, unknown> };

async function clearBilling(candidateId: string, subId: string | null, attempts: number): Promise<Billing> {
  const detail: Record<string, unknown> = {};
  const subs = new Map<string, { customer: string; status: string }>();

  if (subId) {
    const r = await stripe("GET", `/v1/subscriptions/${encodeURIComponent(subId)}`);
    if (r.status === 404) detail.stored_subscription = "missing_at_stripe";
    else if (r.status !== 200) return { cleared: false, blocked: "stripe_lookup_failed", detail: { stripe_status: r.status } };
    else subs.set(subId, { customer: custId(r.data.customer), status: String(r.data.status || "") });
  }
  // Other subscriptions tagged with this candidate (a replaced plan whose cancel failed, for instance). A failed search does not block: the
  // stored subscription above is the authoritative one; the failure is only recorded.
  {
    const q = encodeURIComponent(`metadata['candidate_id']:'${candidateId}'`);
    const r = await stripe("GET", `/v1/subscriptions/search?query=${q}&limit=20`);
    if (r.status === 200 && Array.isArray(r.data.data)) {
      for (const s of r.data.data) if (s && typeof s.id === "string" && !subs.has(s.id)) subs.set(s.id, { customer: custId(s.customer), status: String(s.status || "") });
    } else detail.tag_search = `failed_${r.status}`;
  }

  let cancelled = 0;
  for (const [id, s] of subs) {
    if (s.status === "canceled") continue;
    const r = await stripe("DELETE", `/v1/subscriptions/${encodeURIComponent(id)}`);
    if (r.status === 404) continue;                                   // already gone
    if (r.status !== 200) return { cleared: false, blocked: "stripe_cancel_failed", detail: { ...detail, stripe_status: r.status, cancelled_before_failure: cancelled } };
    cancelled++;
  }
  detail.subscriptions_seen = subs.size; detail.subscriptions_cancelled = cancelled;

  const customers = new Set<string>(); for (const s of subs.values()) if (s.customer) customers.add(s.customer);
  const residual: string[] = []; let deleted = 0;
  for (const cid of customers) {
    const r = await stripe("DELETE", `/v1/customers/${encodeURIComponent(cid)}`);
    if (r.status === 200) deleted++;
    else if (r.status !== 404) residual.push(cid);
  }
  detail.customers_deleted = deleted;
  if (residual.length) {
    if (attempts + 1 < CUSTOMER_DELETE_ATTEMPTS) return { cleared: false, blocked: "stripe_customer_delete_failed", detail: { ...detail, customers_pending: residual.length } };
    detail.stripe_customers_not_deleted = residual;                   // give up after the third try: no billing risk, id kept for a manual delete
  }
  return { cleared: true, detail };
}

export default {
  fetch: withSupabase({ auth: "none" }, async (req, _ctx) => {
    const provided = req.headers.get("x-deletion-secret") || "";
    const sRes = await fetch(`${SUPABASE_URL}/rest/v1/internal_job_secrets?name=eq.delete_expired_accounts&select=value`, { headers: REST });
    const secret = sRes.ok ? ((await sRes.json())[0]?.value ?? "") : "";
    if (!provided || !secret || !safeEqual(provided, secret)) return json({ ok: false, error: "unauthorized" }, 401);
    if (!STRIPE_SECRET_KEY) return json({ ok: false, error: "stripe_not_configured" }, 500);   // never delete an account we cannot check billing for

    const due = await rpc("due_account_deletions", { p_limit: MAX_PER_RUN });
    if (!due.ok || !Array.isArray(due.data)) return json({ ok: false, error: "due_lookup_failed" }, 500);

    const results: Array<{ candidate_id: string; outcome: string }> = [];
    let deleted = 0;
    for (const d of due.data as Array<{ candidate_id: string; stripe_subscription_id: string | null; attempts: number }>) {
      try {
        const billing = await clearBilling(d.candidate_id, d.stripe_subscription_id, Number(d.attempts) || 0);
        if (!billing.cleared) {
          await rpc("record_account_deletion_attempt", { p_candidate: d.candidate_id, p_outcome: "blocked_billing", p_detail: { reason: billing.blocked, ...billing.detail } });
          results.push({ candidate_id: d.candidate_id, outcome: `blocked_billing:${billing.blocked}` });
          continue;
        }
        const res = await rpc("delete_candidate_account", { p_candidate: d.candidate_id, p_billing_cleared: true, p_billing_detail: billing.detail });
        if (!res.ok || !res.data) {
          await rpc("record_account_deletion_attempt", { p_candidate: d.candidate_id, p_outcome: "error", p_detail: { error: res.text.slice(0, 500), ...billing.detail } });
          results.push({ candidate_id: d.candidate_id, outcome: "error" });
          continue;
        }
        const outcome = String(res.data.outcome || "unknown");
        if (outcome === "deleted") deleted++;   // the SQL function wrote the log row itself, Stripe result included
        results.push({ candidate_id: d.candidate_id, outcome });
      } catch (e) {
        await rpc("record_account_deletion_attempt", { p_candidate: d.candidate_id, p_outcome: "error", p_detail: { error: String(e).slice(0, 500) } });
        results.push({ candidate_id: d.candidate_id, outcome: "error" });
      }
    }

    if (deleted > 0) {
      try {
        const sec = await fetch(`${SUPABASE_URL}/rest/v1/internal_job_secrets?name=eq.purge_resume_storage&select=value`, { headers: REST });
        const ps = sec.ok ? ((await sec.json())[0]?.value ?? "") : "";
        if (ps) await fetch(`${SUPABASE_URL}/functions/v1/purge-resume-storage`, {
          method: "POST", signal: AbortSignal.timeout(30000),
          headers: { "Content-Type": "application/json", "Authorization": `Bearer ${SERVICE_KEY}`, "x-purge-secret": ps },
          body: JSON.stringify({ mode: "queue" }),
        });
      } catch (_e) { /* the scheduled purge still runs */ }
    }
    return json({ ok: true, due: due.data.length, deleted, results });
  }),
};
