// Setup type definitions for built-in Supabase Runtime APIs
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { withSupabase } from "jsr:@supabase/server@^1";

const STRIPE_SECRET_KEY = Deno.env.get("STRIPE_SECRET_KEY")!;
const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY")!;
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

// EMPLOYER BILLING EVENTS (2026-09-19). Not a public webhook: Stripe delivers to ONE endpoint (test-stripe-webhook),
// which verifies the signature, enforces the timestamp tolerance, claims the event id (replay protection) and decides
// candidate-vs-employer BEFORE any candidate logic runs. It hands employer events here, authenticated with the service
// role key (this function refuses anything else). So this code only ever sees verified, first-time employer events and
// shares no code path with candidate billing. Never writes to `candidates`.
//
// State is driven by webhooks, not by browser return trips (same principle as the candidate flow): a payment is "paid"
// only when Stripe says so and the amount matches; a subscription's status/period/cancel flag is whatever the latest
// customer.subscription.* event says, and older events cannot overwrite newer state (last_event_created).
//
// Handled:
//   checkout.session.completed                 guest payment: link the session's PaymentIntent (paid -> mark paid)
//   payment_intent.succeeded                   guest payment: mark paid, fetch the receipt, email it once
//   payment_intent.payment_failed              guest payment: mark failed (only while still unpaid)
//   charge.refunded                            guest payment: mark refunded when FULLY refunded
//   customer.subscription.created|updated|deleted   org subscription: upsert status, period, cancel flag
//   invoice.payment_failed                     org subscription RENEWAL failed: record it (banner), email the org owner ONCE per invoice
//   invoice.paid                               org subscription invoice paid: clear the failure record
// Everything else is acknowledged and ignored.
const REST = { "apikey": SUPABASE_SERVICE_ROLE_KEY, "Authorization": `Bearer ${SUPABASE_SERVICE_ROLE_KEY}` };
const JSON_H = { ...REST, "Content-Type": "application/json" };
const GUEST = "employer_guest_comparison";
const ORG = "employer_org_subscription";

const rest = (path: string, init: RequestInit = {}) => fetch(`${SUPABASE_URL}/rest/v1/${path}`, { ...init, headers: { ...JSON_H, ...(init.headers || {}) } });
const rows = async (path: string): Promise<any[]> => { const r = await rest(path); if (!r.ok) throw new Error(`db ${path.split("?")[0]} ${r.status}`); const j = await r.json(); return Array.isArray(j) ? j : []; };
async function stripe(method: string, path: string, form?: Record<string, string>): Promise<any> {
  const body = form ? new URLSearchParams(form).toString() : undefined;
  const r = await fetch(`https://api.stripe.com${path}`, { method, headers: { "Authorization": `Bearer ${STRIPE_SECRET_KEY}`, ...(body ? { "Content-Type": "application/x-www-form-urlencoded" } : {}) }, body });
  const j = await r.json();
  if (!r.ok) throw new Error(`stripe ${path} ${r.status} ${j?.error?.message || ""}`);
  return j;
}
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const iso = (sec: unknown) => (typeof sec === "number" && isFinite(sec) ? new Date(sec * 1000).toISOString() : null);

// ---------- guest payments ----------
async function sendReceipt(paymentId: string): Promise<string> {
  const p = (await rows(`employer_payments?id=eq.${paymentId}&select=*`))[0];
  if (!p || p.status !== "paid") return "receipt_skipped_not_paid";
  // Claim the send first (only one delivery/event wins), so a duplicate can never email twice.
  const claim = await rest(`employer_payments?id=eq.${paymentId}&receipt_email_sent_at=is.null`, { method: "PATCH", headers: { "Prefer": "return=representation" }, body: JSON.stringify({ receipt_email_sent_at: new Date().toISOString() }) });
  const claimed = claim.ok ? await claim.json() : [];
  if (!Array.isArray(claimed) || claimed.length === 0) return "receipt_already_sent";
  const dollars = (p.amount_cents / 100).toFixed(2);
  const when = new Date(p.paid_at || Date.now()).toUTCString();
  const link = p.receipt_url ? `<p><a href="${esc(p.receipt_url)}">View your Stripe receipt</a></p>` : "";
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${RESEND_API_KEY}` },
    body: JSON.stringify({
      from: "Verifi <verify@applitrust.com>",
      to: p.payer_email,
      subject: "Your Verifi payment receipt",
      html: `<p>Thank you. We received your payment for one-time comparison access.</p><p><b>Amount:</b> ${esc(p.currency.toUpperCase())} ${esc(dollars)}<br><b>Date:</b> ${esc(when)}<br><b>Reference:</b> ${esc(p.id)}</p>${link}<p>This is a one-time purchase: it is not a subscription and will not renew. If you have a question about this charge, reply with the reference above.</p>`,
    }),
  });
  if (!res.ok) {
    // Undo the claim so a retry can send it; report failure so the event is retried.
    await rest(`employer_payments?id=eq.${paymentId}`, { method: "PATCH", headers: { "Prefer": "return=minimal" }, body: JSON.stringify({ receipt_email_sent_at: null }) });
    throw new Error("receipt_email_failed");
  }
  return "receipt_sent";
}

async function markGuestPaid(paymentId: string, piId: string): Promise<string> {
  const p = (await rows(`employer_payments?id=eq.${paymentId}&select=*`))[0];
  if (!p) return "unknown_payment";
  const pi = await stripe("GET", `/v1/payment_intents/${encodeURIComponent(piId)}?expand[]=latest_charge`);
  if (pi.status !== "succeeded") return `payment_intent_${pi.status}`;
  if (pi.amount_received !== p.amount_cents || String(pi.currency).toLowerCase() !== String(p.currency).toLowerCase()) {
    await rest(`employer_payments?id=eq.${paymentId}&status=eq.created`, { method: "PATCH", headers: { "Prefer": "return=minimal" }, body: JSON.stringify({ status: "needs_review", stripe_payment_intent_id: piId }) });
    return "amount_mismatch_needs_review";
  }
  const charge = pi.latest_charge && typeof pi.latest_charge === "object" ? pi.latest_charge : null;
  await rest(`employer_payments?id=eq.${paymentId}&status=in.(created,failed)`, {
    method: "PATCH", headers: { "Prefer": "return=minimal" },
    body: JSON.stringify({ status: "paid", paid_at: new Date().toISOString(), stripe_payment_intent_id: piId, stripe_charge_id: charge ? charge.id : null, receipt_url: charge ? charge.receipt_url || null : null }),
  });
  // Comparison Stage 3: a guest who has PAID must be able to open. Keep their approved, unopened snapshot alive for at least 24 more hours
  // (it would otherwise be discarded 7 days after approval, possibly right after they paid).
  if (p.comparison_request_id) {
    const cr = (await rows(`comparison_requests?id=eq.${p.comparison_request_id}&status=eq.approved&first_delivered_at=is.null&select=id,snapshot_expires_at`))[0];
    const floor = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    if (cr && (!cr.snapshot_expires_at || cr.snapshot_expires_at < floor)) await rest(`comparison_requests?id=eq.${cr.id}&first_delivered_at=is.null`, { method: "PATCH", headers: { "Prefer": "return=minimal" }, body: JSON.stringify({ snapshot_expires_at: floor }) });
  }
  // Receipt details may arrive after the status flips; make sure they are stored even if another event won the transition.
  if (charge && charge.receipt_url) await rest(`employer_payments?id=eq.${paymentId}&receipt_url=is.null`, { method: "PATCH", headers: { "Prefer": "return=minimal" }, body: JSON.stringify({ receipt_url: charge.receipt_url, stripe_charge_id: charge.id }) });
  return "paid:" + (await sendReceipt(paymentId));
}

// ---------- org subscriptions ----------
function periodOf(sub: any): { start: string | null; end: string | null } {
  // The account's API version keeps the billing period on the subscription ITEM; older versions had it on the
  // subscription. Accept either.
  const item = sub?.items?.data?.[0];
  return { start: iso(sub?.current_period_start ?? item?.current_period_start), end: iso(sub?.current_period_end ?? item?.current_period_end) };
}

async function syncSubscription(sub: any, eventCreated: number, deleted: boolean): Promise<string> {
  let orgId: string | null = sub?.metadata?.org_id || null;
  if (!orgId && typeof sub?.customer === "string") orgId = (await rows(`employer_orgs?stripe_customer_id=eq.${encodeURIComponent(sub.customer)}&select=id`))[0]?.id || null;
  if (!orgId) return "subscription_without_org";
  const status = deleted ? "canceled" : String(sub.status);
  const { start, end } = periodOf(sub);
  const fields = {
    status, current_period_start: start, current_period_end: end,
    cancel_at_period_end: !!sub.cancel_at_period_end, canceled_at: iso(sub.canceled_at), last_event_created: eventCreated, updated_at: new Date().toISOString(),
  };
  const existing = (await rows(`employer_org_subscriptions?stripe_subscription_id=eq.${encodeURIComponent(sub.id)}&select=id,last_event_created`))[0];
  const patchExisting = async () => {
    // Only apply an event that is not older than what is already stored.
    const r = await rest(`employer_org_subscriptions?stripe_subscription_id=eq.${encodeURIComponent(sub.id)}&last_event_created=lte.${eventCreated}`, { method: "PATCH", headers: { "Prefer": "return=representation" }, body: JSON.stringify(fields) });
    const changed = r.ok ? await r.json() : [];
    return Array.isArray(changed) && changed.length ? `subscription_updated:${status}` : "stale_event_ignored";
  };
  if (existing) return await patchExisting();

  // A subscription we have never recorded is only worth recording if it is live. A canceled/expired one we never saw
  // (e.g. the duplicate this handler itself canceled, whose 'deleted' event arrives next) must not become a history row:
  // it would be newer than the real subscription and be mistaken for it.
  if (!["active", "trialing", "past_due", "unpaid", "incomplete"].includes(status)) return `unknown_nonlive_subscription_ignored:${status}`;

  // First sight of this subscription: snapshot the plan it was sold with (from the metadata set at checkout).
  const pricing = (await rows(`employer_pricing?key=eq.org_subscription_monthly&select=amount_cents,included_lookups,currency`))[0];
  const included = Number(sub?.metadata?.included_lookups) || pricing?.included_lookups || 1;
  const unit = Number(sub?.metadata?.unit_amount_cents) || pricing?.amount_cents || 0;
  const ins = await rest("employer_org_subscriptions", {
    method: "POST", headers: { "Prefer": "return=minimal" },
    body: JSON.stringify({ org_id: orgId, owner_user_id: sub?.metadata?.owner_user_id || null, stripe_subscription_id: sub.id, included_lookups: included, unit_amount_cents: unit, currency: String(sub?.currency || "usd"), ...fields }),
  });
  if (ins.ok) return `subscription_created:${status}`;
  if (ins.status === 409) {
    // Either a concurrent event inserted the same subscription (then just apply this one), or the org already has a
    // DIFFERENT live subscription: never let an org hold two, cancel the newer one with Stripe.
    const again = (await rows(`employer_org_subscriptions?stripe_subscription_id=eq.${encodeURIComponent(sub.id)}&select=id`))[0];
    if (again) return await patchExisting();
    if (!deleted && ["active", "trialing", "past_due", "unpaid", "incomplete"].includes(status)) {
      await stripe("DELETE", `/v1/subscriptions/${encodeURIComponent(sub.id)}`);
      return "duplicate_subscription_canceled";
    }
    return "duplicate_ignored";
  }
  throw new Error(`subscription insert ${ins.status}`);
}

// ---------- failed renewals (Stage 4, 2026-09-20) ----------
// The subscription STATUS (past_due, then active again) is still driven only by customer.subscription.*; these two events add the parts
// status cannot say: which invoice failed, since when, and whether the owner has been told. A failed FIRST payment
// (billing_reason subscription_create) is not tracked: the hosted Checkout page already told the person, and no plan existed yet.
const SITE = "https://alpha.applitrust.com";
function invoiceSubscriptionId(inv: any): string | null {
  // this account's API version keeps it under parent.subscription_details; older versions have it on the invoice
  const s = inv?.subscription ?? inv?.parent?.subscription_details?.subscription ?? null;
  return typeof s === "string" ? s : (s && typeof s.id === "string" ? s.id : null);
}
const enc = encodeURIComponent;

async function invoiceFailed(inv: any, eventCreated: number): Promise<string> {
  if (inv?.billing_reason === "subscription_create") return "first_invoice_failure_not_tracked";
  const subId = invoiceSubscriptionId(inv);
  if (!subId || typeof inv?.id !== "string") return "invoice_without_subscription";
  const sub = (await rows(`employer_org_subscriptions?stripe_subscription_id=eq.${enc(subId)}&select=id,org_id,payment_failed_at,last_failed_invoice_id,failure_notified_invoice_id,last_invoice_event_created`))[0];
  if (!sub) return "invoice_for_unknown_subscription";
  if (Number(sub.last_invoice_event_created) > eventCreated) return "stale_event_ignored";

  const nowIso = new Date().toISOString();
  const sameInvoice = sub.last_failed_invoice_id === inv.id && sub.payment_failed_at;
  const upd = await rest(`employer_org_subscriptions?id=eq.${sub.id}&last_invoice_event_created=lte.${eventCreated}`, {
    method: "PATCH", headers: { "Prefer": "return=minimal" },
    body: JSON.stringify({ payment_failed_at: sameInvoice ? sub.payment_failed_at : nowIso, last_failed_invoice_id: inv.id, last_invoice_event_created: eventCreated, updated_at: nowIso }),
  });
  if (!upd.ok) throw new Error(`record failed invoice ${upd.status}`);

  // Claim the email for THIS invoice first, so a retry of the same invoice (or a duplicate event) can never send a second one.
  const claim = await rest(`employer_org_subscriptions?id=eq.${sub.id}&or=(failure_notified_invoice_id.is.null,failure_notified_invoice_id.neq.${enc(inv.id)})`, {
    method: "PATCH", headers: { "Prefer": "return=representation" }, body: JSON.stringify({ failure_notified_invoice_id: inv.id }),
  });
  const claimed = claim.ok ? await claim.json() : [];
  if (!Array.isArray(claimed) || claimed.length === 0) return "payment_failed_recorded:already_emailed";

  const owner = (await rows(`employer_users?org_id=eq.${sub.org_id}&role=eq.owner&select=email,name`))[0];
  const org = (await rows(`employer_orgs?id=eq.${sub.org_id}&select=name`))[0];
  if (!owner) return "payment_failed_recorded:no_owner";
  const money = typeof inv.amount_due === "number" ? new Intl.NumberFormat("en-US", { style: "currency", currency: String(inv.currency || "usd").toUpperCase() }).format(inv.amount_due / 100) : "the renewal";
  const retry = typeof inv.next_payment_attempt === "number" ? new Date(inv.next_payment_attempt * 1000).toUTCString() : null;
  const pay = typeof inv.hosted_invoice_url === "string" && inv.hosted_invoice_url.startsWith("https://") ? inv.hosted_invoice_url : null;
  const payLine = pay ? `, or <a href="${esc(pay)}">pay this invoice directly</a>` : "";
  const retryLine = retry ? `Stripe will also try the card again on ${esc(retry)}. ` : "";
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${RESEND_API_KEY}` },
    body: JSON.stringify({
      from: "Verifi <verify@applitrust.com>",
      to: owner.email,
      subject: "Payment failed for your Verifi employer plan",
      html: `<p>Hi ${esc(owner.name || "there")},</p><p>We could not collect the renewal (${esc(money)}) for <b>${esc(org?.name || "your organization")}</b>'s Verifi employer plan.</p><p><b>Until it is paid, your organization's comparison lookups are paused:</b> nobody in the organization can open a comparison or start a new request. Nothing already opened is affected, and no lookups are used while it is paused.</p><p>To fix it, <a href="${SITE}/employer.html">sign in</a> and use Change payment method under Billing${payLine}. ${retryLine}Lookups resume by themselves once the payment goes through.</p>`,
    }),
  });
  if (!res.ok) {
    // Undo the claim and fail the event so Stripe delivers it again: the owner must not silently miss this.
    await rest(`employer_org_subscriptions?id=eq.${sub.id}&failure_notified_invoice_id=eq.${enc(inv.id)}`, { method: "PATCH", headers: { "Prefer": "return=minimal" }, body: JSON.stringify({ failure_notified_invoice_id: sub.failure_notified_invoice_id }) });
    throw new Error("failure_email_failed");
  }
  return "payment_failed_recorded:owner_emailed";
}

async function invoicePaid(inv: any, eventCreated: number): Promise<string> {
  const subId = invoiceSubscriptionId(inv);
  if (!subId) return "invoice_without_subscription";
  const sub = (await rows(`employer_org_subscriptions?stripe_subscription_id=eq.${enc(subId)}&select=id,payment_failed_at,last_invoice_event_created`))[0];
  if (!sub) return "invoice_for_unknown_subscription";
  if (Number(sub.last_invoice_event_created) > eventCreated) return "stale_event_ignored";
  const r = await rest(`employer_org_subscriptions?id=eq.${sub.id}&last_invoice_event_created=lte.${eventCreated}`, {
    method: "PATCH", headers: { "Prefer": "return=minimal" },
    body: JSON.stringify({ payment_failed_at: null, last_failed_invoice_id: null, failure_notified_invoice_id: null, last_invoice_event_created: eventCreated, updated_at: new Date().toISOString() }),
  });
  if (!r.ok) throw new Error(`clear failed invoice ${r.status}`);
  return sub.payment_failed_at ? "invoice_paid:failure_cleared" : "invoice_paid:nothing_to_clear";
}

// ---------- dispatch ----------
async function handle(event: any): Promise<string> {
  const obj = event?.data?.object || {};
  switch (event.type) {
    case "checkout.session.completed": {
      if (obj.metadata?.product !== GUEST) return obj.metadata?.product === ORG ? "org_checkout_noted" : "ignored";
      const paymentId = obj.metadata?.payment_id;
      if (!paymentId) return "guest_session_without_payment_id";
      const piId = typeof obj.payment_intent === "string" ? obj.payment_intent : obj.payment_intent?.id;
      if (piId) await rest(`employer_payments?id=eq.${paymentId}&stripe_payment_intent_id=is.null`, { method: "PATCH", headers: { "Prefer": "return=minimal" }, body: JSON.stringify({ stripe_payment_intent_id: piId, stripe_checkout_session_id: obj.id }) });
      return obj.payment_status === "paid" && piId ? await markGuestPaid(paymentId, piId) : "guest_session_completed_unpaid";
    }
    case "payment_intent.succeeded": {
      if (obj.metadata?.product !== GUEST || !obj.metadata?.payment_id) return "ignored";
      return await markGuestPaid(obj.metadata.payment_id, obj.id);
    }
    case "payment_intent.payment_failed": {
      if (obj.metadata?.product !== GUEST || !obj.metadata?.payment_id) return "ignored";
      await rest(`employer_payments?id=eq.${obj.metadata.payment_id}&status=eq.created`, { method: "PATCH", headers: { "Prefer": "return=minimal" }, body: JSON.stringify({ status: "failed", stripe_payment_intent_id: obj.id }) });
      return "payment_failed";
    }
    case "charge.refunded": {
      const piId = typeof obj.payment_intent === "string" ? obj.payment_intent : obj.payment_intent?.id;
      if (!piId || obj.refunded !== true) return obj.refunded === false ? "partial_refund_ignored" : "ignored";
      const r = await rest(`employer_payments?stripe_payment_intent_id=eq.${encodeURIComponent(piId)}&status=in.(paid,needs_review)`, { method: "PATCH", headers: { "Prefer": "return=representation" }, body: JSON.stringify({ status: "refunded", refunded_at: new Date().toISOString() }) });
      const changed = r.ok ? await r.json() : [];
      return Array.isArray(changed) && changed.length ? "payment_refunded" : "refund_no_matching_payment";
    }
    case "invoice.payment_failed":
      return await invoiceFailed(obj, Number(event.created) || 0);
    case "invoice.paid":
      return await invoicePaid(obj, Number(event.created) || 0);
    case "customer.subscription.created":
    case "customer.subscription.updated":
    case "customer.subscription.deleted":
      return await syncSubscription(obj, Number(event.created) || 0, event.type === "customer.subscription.deleted");
    default:
      return "ignored";
  }
}

export default {
  fetch: withSupabase({ auth: "none" }, async (req, _ctx) => {
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
    // Internal only: the candidate webhook forwards verified employer events with the service role key.
    if (req.headers.get("authorization") !== `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`) return json({ ok: false, error: "forbidden" }, 403);
    try {
      const { event } = await req.json();
      if (!event || typeof event.type !== "string") return json({ ok: false, error: "bad_event" }, 400);
      const outcome = await handle(event);
      return json({ ok: true, outcome });
    } catch (e) {
      return json({ ok: false, error: "handler_failed", detail: String(e).slice(0, 300) }, 500);
    }
  }),
};
