-- Gap #21 (2026-09-26): employer comparison-request flow redesign, schema piece.
--
-- Three structural changes, all agreed with John before building:
--   1. HEADLINE: guest (pay-per-use) comparisons get real persistent access instead of a 30-minute single view.
--      Mechanically this is the smallest possible change -- open_guest_comparison already stamps
--      view_window_ends_at on first open and every expiry/status check already just compares against that
--      column, so widening it from 30 minutes to 21 days (matching document retention) is the whole fix;
--      nothing downstream needs to know the number changed.
--   2. Finding 7: card collection moves to REQUEST time via a Stripe SetupIntent (no hold yet, nothing
--      charged), and the actual hold is placed AUTOMATICALLY the instant the candidate approves, using the
--      saved payment method -- no second "enter your card" prompt. Decided directly with John: give the
--      employer a full 7 days from APPROVAL to open the result (this already falls out of the existing
--      SNAPSHOT_DAYS=7 in candidate-comparison-requests, which was already computed from approved_at, not
--      request time -- so no change needed there either).
--   3. "One verification": a comparison request now requires a signed-in employer_user (the existing
--      employer_users/employer_sessions email-link login -- orgless is fine, no subscription required) instead
--      of the separate, anonymous Tier-1-lookup email-confirmation step. That single sign-in also gives every
--      guest-billed (pay-per-use) request a real, persistent identity: Payment History can now link straight to
--      the comparison's own open action, not just the Stripe receipt, and the organization/company name typed
--      on one request can be remembered for the next (employer_users.last_company below).
--
-- comparison_requests keeps access_method='guest' as the BILLING label (one-off Stripe payment, not a
-- subscription quota) even though it now always carries a real employer_user_id -- 'guest' stopped meaning
-- "no identity" and started meaning "pay per use" the moment identity became mandatory for this path too.

alter table employer_users add column if not exists last_company text;

alter table comparison_requests add column if not exists stripe_customer_id text;
alter table comparison_requests add column if not exists stripe_setup_intent_id text;
alter table comparison_requests add column if not exists stripe_payment_method_id text;
alter table comparison_requests add column if not exists card_saved_at timestamptz;
alter table comparison_requests add column if not exists hold_attempted_at timestamptz;

-- ------------------------------------------------------------------------------------------------
-- create_comparison_request: the 'guest' branch now accepts (optionally) an employer_user, same as 'org'
-- already did, WITHOUT requiring an org or a subscription -- org_id stays null unless p_method='org'.
-- Everything else (document requirement, rate limits, decline-stands-for-30-days, one-open-request-per-
-- pair) is byte-identical to the live version; only the employer_user_id assignment changed.
-- ------------------------------------------------------------------------------------------------
create or replace function create_comparison_request(
  p_lookup_id uuid, p_method text, p_employer_user uuid, p_attestation text, p_claim_hash text default null, p_document_id uuid default null
) returns table(ok boolean, reason text, detail text, request_id uuid)
language plpgsql security definer set search_path = public as $$
declare
  l employer_lookup_requests%rowtype;
  c candidates%rowtype;
  u employer_users%rowtype;
  d comparison_request_documents%rowtype;
  v_att text := btrim(coalesce(p_attestation, ''));
  v_email text;
  v_id uuid;
  v_kind text;
begin
  if char_length(v_att) < 10 or char_length(v_att) > 500 then
    return query select false, 'attestation_invalid'::text, null::text, null::uuid; return;
  end if;
  if p_document_id is null then
    return query select false, 'document_required'::text, null::text, null::uuid; return;
  end if;
  select * into l from employer_lookup_requests
   where id = p_lookup_id and result_exists is true and used_at is not null and matched_candidate_id is not null
     and used_at > now() - interval '30 days';
  if not found then return query select false, 'unavailable'::text, 'no_valid_lookup'::text, null::uuid; return; end if;
  v_email := lower(l.requester_email);

  if p_method = 'org' then
    select * into u from employer_users where id = p_employer_user;
    if not found or u.org_id is null then return query select false, 'unavailable'::text, 'no_org'::text, null::uuid; return; end if;
    -- the lookup must be the caller's own: their verified sign-in address is the address the lookup link went to
    if v_email <> u.email then return query select false, 'unavailable'::text, 'lookup_not_yours'::text, null::uuid; return; end if;
    if not exists (select 1 from employer_org_subscriptions s where s.org_id = u.org_id and s.status in ('active', 'trialing')) then
      return query select false, 'subscription_required'::text, null::text, null::uuid; return;
    end if;
  elsif p_method = 'guest' then
    -- Gap #21: a guest (pay-per-use) request now ALSO accepts a signed-in employer_user (session-authenticated,
    -- org optional) in place of the old anonymous claim-token proof. Either proof is accepted so the sweep of
    -- in-flight requests from before this migration keeps working; new requests always carry one.
    if p_employer_user is not null then
      select * into u from employer_users where id = p_employer_user;
      if not found then return query select false, 'unavailable'::text, 'no_such_user'::text, null::uuid; return; end if;
      if v_email <> u.email then return query select false, 'unavailable'::text, 'lookup_not_yours'::text, null::uuid; return; end if;
    elsif p_claim_hash is null or l.claim_token_hash is null or l.claim_token_hash <> p_claim_hash then
      return query select false, 'unavailable'::text, 'bad_claim'::text, null::uuid; return;
    end if;
  else
    return query select false, 'unavailable'::text, 'bad_method'::text, null::uuid; return;
  end if;

  select * into c from candidates where id = l.matched_candidate_id;
  -- the kind comes from the candidate's own account type and from nothing the caller sent
  v_kind := case c.account_type when 'full_resume' then 'resume_comparison' when 'license_only' then 'license_report' else null end;
  if not found or v_kind is null or c.deletion_scheduled_at is not null or c.discoverable is not true then
    return query select false, 'unavailable'::text, 'candidate_ineligible'::text, null::uuid; return;
  end if;

  -- a decline stands for 30 days (per candidate and requester)
  if exists (select 1 from comparison_requests r where r.candidate_id = c.id and r.requester_email = v_email and r.status = 'declined' and r.responded_at > now() - interval '30 days') then
    return query select false, 'unavailable'::text, 'declined_recently'::text, null::uuid; return;
  end if;
  select r.id into v_id from comparison_requests r where r.candidate_id = c.id and r.requester_email = v_email and r.status in ('pending', 'approved');
  if found then return query select false, 'already_open'::text, null::text, v_id; return; end if;
  if (select count(*) from comparison_requests r where r.candidate_id = c.id and r.status = 'pending') >= 10 then
    return query select false, 'unavailable'::text, 'candidate_busy'::text, null::uuid; return;
  end if;
  if (select count(*) from comparison_requests r where r.requester_email = v_email and r.created_at > now() - interval '24 hours') >= 5 then
    return query select false, 'rate_limited'::text, null::text, null::uuid; return;
  end if;

  -- the document must be this caller's own, not yet used by any request, and not past its hour
  select * into d from comparison_request_documents x
   where x.id = p_document_id and x.request_id is null and x.purge_after > now()
     and x.uploader_kind = p_method
     and x.uploader_ref = case when p_method = 'org' then p_employer_user::text else p_lookup_id::text end
   for update;
  if not found then return query select false, 'document_invalid'::text, null::text, null::uuid; return; end if;

  begin
    insert into comparison_requests (candidate_id, lookup_id, requester_email, requester_name, requester_company, requester_domain_type,
                                     employer_user_id, org_id, access_method, attestation, expires_at, kind, document_required)
    values (c.id, l.id, v_email, l.requester_name, l.requester_company,
            case when split_part(v_email, '@', 2) in ('gmail.com', 'yahoo.com', 'outlook.com', 'hotmail.com', 'icloud.com', 'aol.com') then 'personal' else 'company' end,
            case when p_method = 'org' then u.id when p_method = 'guest' then p_employer_user end,
            case when p_method = 'org' then u.org_id end,
            p_method, v_att, now() + interval '72 hours', v_kind, true)
    returning id into v_id;
  exception when unique_violation then
    select r.id into v_id from comparison_requests r where r.candidate_id = c.id and r.requester_email = v_email and r.status in ('pending', 'approved');
    return query select false, 'already_open'::text, null::text, v_id; return;
  end;
  update comparison_request_documents set request_id = v_id, purge_after = now() + (
    case when p_method = 'org' and v_kind = 'resume_comparison' then interval '105 days'
         when p_method = 'org' and v_kind = 'license_report' then interval '45 days'
         else interval '21 days' end
  ) where id = d.id;
  return query select true, 'created'::text, null::text, v_id;
end $$;

-- ------------------------------------------------------------------------------------------------
-- open_guest_comparison: HEADLINE fix. Was interval '30 minutes'; now interval '21 days', matching document
-- retention. Nothing else in this function changes -- it is still the payment-redemption + first-open stamp,
-- still callable by the emailed guest_token_hash link (kept working for anything already in flight).
-- ------------------------------------------------------------------------------------------------
create or replace function open_guest_comparison(p_token_hash text)
 returns table(ok boolean, reason text, request_id uuid, first_open boolean, window_ends_at timestamp with time zone)
 language plpgsql security definer set search_path = public as $$
declare r comparison_requests%rowtype; p employer_payments%rowtype;
begin
  select * into r from comparison_requests where guest_token_hash = p_token_hash and access_method = 'guest' for update;
  if not found then return query select false, 'not_found'::text, null::uuid, false, null::timestamptz; return; end if;

  if r.first_delivered_at is not null then
    if r.status = 'approved' and r.view_window_ends_at is not null and r.view_window_ends_at > now()
       and exists (select 1 from comparison_snapshots s where s.request_id = r.id) then
      return query select true, 'reopen'::text, r.id, false, r.view_window_ends_at; return;
    end if;
    return query select false, 'window_closed'::text, r.id, false, r.view_window_ends_at; return;
  end if;

  if r.status <> 'approved' or not exists (select 1 from comparison_snapshots s where s.request_id = r.id) then
    return query select false, 'not_available'::text, r.id, false, null::timestamptz; return;
  end if;

  select * into p from employer_payments
   where comparison_request_id = r.id and status = 'paid' and refunded_at is null
   order by paid_at limit 1 for update;
  if not found then return query select false, 'payment_required'::text, r.id, false, null::timestamptz; return; end if;

  if not redeem_employer_payment(p.id, r.id::text) then
    return query select false, 'payment_unavailable'::text, r.id, false, null::timestamptz; return;
  end if;
  update comparison_requests set first_delivered_at = now(), view_window_ends_at = now() + interval '21 days'
   where id = r.id returning comparison_requests.view_window_ends_at into window_ends_at;
  return query select true, 'delivered'::text, r.id, true, window_ends_at;
end $$;

-- ------------------------------------------------------------------------------------------------
-- open_paid_comparison: the session-identified equivalent of open_guest_comparison, for the HEADLINE
-- requirement -- a signed-in employer opening (or re-opening) their OWN guest-billed request straight from
-- Payment History / My Comparisons, by request id + their own employer_user id, no emailed token needed.
-- Same capture-then-redeem shape, same 21-day window, same one-payment-spent-once rule.
-- ------------------------------------------------------------------------------------------------
create or replace function open_paid_comparison(p_request_id uuid, p_employer_user uuid)
 returns table(ok boolean, reason text, first_open boolean, window_ends_at timestamp with time zone)
 language plpgsql security definer set search_path = public as $$
declare r comparison_requests%rowtype; p employer_payments%rowtype;
begin
  select * into r from comparison_requests where id = p_request_id and employer_user_id = p_employer_user and access_method = 'guest' for update;
  if not found then return query select false, 'not_found'::text, false, null::timestamptz; return; end if;

  if r.first_delivered_at is not null then
    if r.status = 'approved' and r.view_window_ends_at is not null and r.view_window_ends_at > now()
       and exists (select 1 from comparison_snapshots s where s.request_id = r.id) then
      return query select true, 'reopen'::text, false, r.view_window_ends_at; return;
    end if;
    return query select false, 'window_closed'::text, false, r.view_window_ends_at; return;
  end if;

  if r.status <> 'approved' or not exists (select 1 from comparison_snapshots s where s.request_id = r.id) then
    return query select false, 'not_available'::text, false, null::timestamptz; return;
  end if;

  select * into p from employer_payments
   where comparison_request_id = r.id and status = 'paid' and refunded_at is null
   order by paid_at limit 1 for update;
  if not found then return query select false, 'payment_required'::text, false, null::timestamptz; return; end if;

  if not redeem_employer_payment(p.id, r.id::text) then
    return query select false, 'payment_unavailable'::text, false, null::timestamptz; return;
  end if;
  update comparison_requests set first_delivered_at = now(), view_window_ends_at = now() + interval '21 days'
   where id = r.id returning comparison_requests.view_window_ends_at into window_ends_at;
  return query select true, 'delivered'::text, true, window_ends_at;
end $$;
revoke all on function open_paid_comparison(uuid, uuid) from public, anon, authenticated;
grant execute on function open_paid_comparison(uuid, uuid) to service_role;
