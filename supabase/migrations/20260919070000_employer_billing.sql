-- Employer billing (2026-09-19): guest one-off payments, per-org subscriptions with a lookup quota, and the
-- webhook plumbing (replay protection + routing) that keeps employer Stripe events out of candidate billing.
-- Everything here is separate from the candidate billing columns (candidates.tier, stripe_subscription_id, ...).

-- ------------------------------------------------------------------------------------------------
-- 1. Webhook idempotency. Every Stripe event id is claimed before it is processed and marked done after. The
--    candidate webhook (test-stripe-webhook) used to process a re-delivered event again every time; that was
--    harmless for setting flags, but a one-off payment that grants data access must not be applied twice.
--    A claim expires after 2 minutes so a delivery that crashed mid-processing can be retried by Stripe.
-- ------------------------------------------------------------------------------------------------
create table if not exists stripe_webhook_events (
  event_id text primary key,
  event_type text not null,
  kind text not null,                 -- 'candidate' | 'employer'
  received_at timestamptz not null default now(),
  claimed_at timestamptz,
  processed_at timestamptz,
  outcome text
);
grant select, insert, update, delete on table stripe_webhook_events to service_role;

create or replace function claim_stripe_event(p_event_id text, p_type text, p_kind text) returns boolean
language plpgsql security definer set search_path = public as $$
declare v_claimed boolean;
begin
  insert into stripe_webhook_events (event_id, event_type, kind, claimed_at)
  values (p_event_id, p_type, p_kind, now())
  on conflict (event_id) do update set claimed_at = now(), kind = excluded.kind
    where stripe_webhook_events.processed_at is null
      and (stripe_webhook_events.claimed_at is null or stripe_webhook_events.claimed_at < now() - interval '2 minutes')
  returning true into v_claimed;
  return coalesce(v_claimed, false);
end $$;

create or replace function finish_stripe_event(p_event_id text, p_outcome text) returns void
language sql security definer set search_path = public as $$
  update stripe_webhook_events set processed_at = now(), outcome = p_outcome where event_id = p_event_id;
$$;

create or replace function release_stripe_event(p_event_id text, p_outcome text) returns void
language sql security definer set search_path = public as $$
  update stripe_webhook_events set claimed_at = null, outcome = p_outcome where event_id = p_event_id and processed_at is null;
$$;

grant execute on function claim_stripe_event(text, text, text) to service_role;
grant execute on function finish_stripe_event(text, text) to service_role;
grant execute on function release_stripe_event(text, text) to service_role;

-- ------------------------------------------------------------------------------------------------
-- 2. Pricing / plan configuration. The numbers are DATA, not code. The values seeded below are PLACEHOLDERS,
--    chosen only so the flows can run: there is no real usage yet to size them against. Change a row to change a
--    price; nothing else needs redeploying. Existing subscriptions keep the price and quota they signed up with
--    (snapshotted on the subscription), so editing this table never changes what a current subscriber has paid for.
-- ------------------------------------------------------------------------------------------------
create table if not exists employer_pricing (
  key text primary key,
  amount_cents integer not null check (amount_cents >= 0),
  currency text not null default 'usd',
  included_lookups integer check (included_lookups is null or included_lookups >= 1),
  note text,
  updated_at timestamptz not null default now()
);
grant select, insert, update, delete on table employer_pricing to service_role;
insert into employer_pricing (key, amount_cents, included_lookups, note) values
  ('guest_comparison', 1000, null, 'PLACEHOLDER: one-time comparison access for a guest, $10 (the prototype''s own default price).'),
  ('org_subscription_monthly', 25000, 50, 'PLACEHOLDER: monthly org plan, 50 included lookups per billing period (the prototype''s 50) at $250 = half the guest price per lookup. Arbitrary; set from real demand.')
on conflict (key) do nothing;

-- ------------------------------------------------------------------------------------------------
-- 3. Org subscriptions. One Stripe customer per org; the subscription row mirrors Stripe (webhook is the source
--    of truth) and carries a snapshot of the quota and price it was sold with.
-- ------------------------------------------------------------------------------------------------
alter table employer_orgs add column if not exists stripe_customer_id text unique;

create table if not exists employer_org_subscriptions (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references employer_orgs(id) on delete cascade,
  owner_user_id uuid references employer_users(id) on delete set null,
  stripe_subscription_id text not null unique,
  status text not null,
  current_period_start timestamptz,
  current_period_end timestamptz,
  cancel_at_period_end boolean not null default false,
  canceled_at timestamptz,
  included_lookups integer not null check (included_lookups >= 1),
  unit_amount_cents integer not null,
  currency text not null default 'usd',
  last_event_created bigint not null default 0,   -- Stripe event time of the last applied update: older events are ignored
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
-- At most one live subscription per org.
create unique index if not exists employer_org_one_live_subscription on employer_org_subscriptions (org_id)
  where status in ('active', 'trialing', 'past_due', 'unpaid', 'incomplete');
grant select, insert, update, delete on table employer_org_subscriptions to service_role;

-- Lookup quota: an append-only ledger, counted within the subscription's CURRENT billing period (so it resets with
-- Stripe's period, with no reset job). Hard stop at the included number: there is no overage billing.
create table if not exists employer_lookup_usage (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references employer_orgs(id) on delete cascade,
  subscription_id uuid not null references employer_org_subscriptions(id) on delete cascade,
  employer_user_id uuid references employer_users(id) on delete set null,
  reference text,                                   -- what the lookup was for (idempotency key for the caller)
  used_at timestamptz not null default now()
);
create unique index if not exists employer_lookup_usage_reference on employer_lookup_usage (subscription_id, reference) where reference is not null;
create index if not exists employer_lookup_usage_period on employer_lookup_usage (subscription_id, used_at);
grant select, insert, update, delete on table employer_lookup_usage to service_role;

-- Atomically spend one lookup from an org's current period. Serialized per org by locking the subscription row, so
-- concurrent callers can never overspend. Same reference twice = counted once.
create or replace function consume_org_lookup(p_org uuid, p_user uuid, p_reference text default null)
returns table(ok boolean, reason text, used integer, included integer, remaining integer)
language plpgsql security definer set search_path = public as $$
declare s employer_org_subscriptions%rowtype; v_used integer; v_start timestamptz;
begin
  select * into s from employer_org_subscriptions
   where org_id = p_org and status in ('active', 'trialing') order by created_at desc limit 1 for update;
  if not found then return query select false, 'no_active_subscription'::text, 0, 0, 0; return; end if;
  if s.current_period_end is not null and s.current_period_end + interval '1 hour' < now() then
    return query select false, 'period_ended'::text, 0, s.included_lookups, 0; return;
  end if;
  v_start := coalesce(s.current_period_start, s.created_at);
  select count(*) into v_used from employer_lookup_usage where subscription_id = s.id and used_at >= v_start;
  if p_reference is not null and exists (select 1 from employer_lookup_usage where subscription_id = s.id and reference = p_reference) then
    return query select true, 'already_counted'::text, v_used, s.included_lookups, greatest(s.included_lookups - v_used, 0); return;
  end if;
  if v_used >= s.included_lookups then
    return query select false, 'quota_exhausted'::text, v_used, s.included_lookups, 0; return;
  end if;
  insert into employer_lookup_usage (org_id, subscription_id, employer_user_id, reference) values (p_org, s.id, p_user, p_reference);
  return query select true, 'counted'::text, v_used + 1, s.included_lookups, s.included_lookups - v_used - 1;
end $$;
grant execute on function consume_org_lookup(uuid, uuid, text) to service_role;

-- ------------------------------------------------------------------------------------------------
-- 4. Guest one-off payments. No employer identity: the browser that starts the payment gets a random access token
--    (only its SHA-256 is stored) that is just enough to check that one payment's status and, later, to redeem it.
--    lookup_id is optional and unbound for now: the comparison flow will bind a payment to an approved request.
-- ------------------------------------------------------------------------------------------------
create table if not exists employer_payments (
  id uuid primary key default gen_random_uuid(),
  kind text not null default 'guest_comparison' check (kind in ('guest_comparison')),
  status text not null default 'created' check (status in ('created', 'paid', 'failed', 'refunded', 'needs_review')),
  amount_cents integer not null check (amount_cents > 0),
  currency text not null default 'usd',
  payer_email text not null,
  access_token_hash text not null,
  lookup_id uuid references employer_lookup_requests(id) on delete set null,
  stripe_checkout_session_id text unique,
  stripe_payment_intent_id text unique,
  stripe_charge_id text,
  receipt_url text,
  receipt_email_sent_at timestamptz,
  paid_at timestamptz,
  refunded_at timestamptz,
  redeemed_at timestamptz,
  redeemed_reference text,
  created_at timestamptz not null default now()
);
create index if not exists employer_payments_email_idx on employer_payments (lower(payer_email), created_at);
grant select, insert, update, delete on table employer_payments to service_role;

-- One-time redemption of a paid guest payment (the "one view"): succeeds exactly once, only while paid and not refunded.
create or replace function redeem_employer_payment(p_payment uuid, p_reference text) returns boolean
language plpgsql security definer set search_path = public as $$
declare v boolean;
begin
  update employer_payments set redeemed_at = now(), redeemed_reference = p_reference
   where id = p_payment and status = 'paid' and redeemed_at is null and refunded_at is null
  returning true into v;
  return coalesce(v, false);
end $$;
grant execute on function redeem_employer_payment(uuid, text) to service_role;

-- ------------------------------------------------------------------------------------------------
-- 5. Routing helper for the candidate webhook: does any Stripe object id on an event belong to an employer?
-- ------------------------------------------------------------------------------------------------
create or replace function employer_owns_stripe_ids(p_customer text, p_subscription text, p_payment_intent text) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from employer_orgs where p_customer is not null and stripe_customer_id = p_customer)
      or exists (select 1 from employer_org_subscriptions where p_subscription is not null and stripe_subscription_id = p_subscription)
      or exists (select 1 from employer_payments where p_payment_intent is not null and stripe_payment_intent_id = p_payment_intent);
$$;
grant execute on function employer_owns_stripe_ids(text, text, text) to service_role;

-- ------------------------------------------------------------------------------------------------
-- 6. Housekeeping: abandoned guest checkouts after 3 days, processed webhook records after 60.
-- ------------------------------------------------------------------------------------------------
create or replace function cleanup_employer_billing() returns integer
language plpgsql security definer set search_path = public as $$
declare n integer := 0; k integer;
begin
  delete from employer_payments where status in ('created', 'failed') and created_at < now() - interval '3 days';
  get diagnostics k = row_count; n := n + k;
  delete from stripe_webhook_events where processed_at is not null and processed_at < now() - interval '60 days';
  get diagnostics k = row_count; n := n + k;
  return n;
end $$;
grant execute on function cleanup_employer_billing() to service_role;
select cron.schedule('cleanup-employer-billing', '37 * * * *', $$select public.cleanup_employer_billing()$$);
