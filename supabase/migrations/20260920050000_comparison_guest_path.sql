-- Employer comparison delivery, Stage 3 (2026-09-20): the guest path (no employer account; pay once, one time view).
--
-- FLOW. A guest completes a Tier 1 lookup (free); the browser that completed it is handed a one-time claim token (only its hash is stored,
-- on the lookup). They request a comparison with lookup id + claim token + how they got the candidate's information. The candidate
-- approves or declines exactly as for the org path. On approval the server emails the requester's CONFIRMED address a link carrying a
-- random token (only its hash is stored on the request). That link, and nothing else, is the guest's capability: it shows the request's
-- state, starts ONE payment bound to THIS request, and opens the snapshot.
--
-- METERING. The payment is the meter. open_guest_comparison() below is the delivery point: in ONE transaction, holding the request row
-- locked, it requires a PAID, unrefunded payment bound to this request, calls redeem_employer_payment (which succeeds exactly once) and
-- stamps first_delivered_at plus a 30 minute view window. Every later open inside the window is free and just re-serves the snapshot;
-- after the window it is refused and the snapshot is deleted (expire_comparison_requests, or close_guest_comparison immediately).
--
-- Payment binding: at most one live payment per request (unique index below), created only for an approved, unopened request, for the
-- server's current guest price. A paid payment that is never redeemed before the snapshot expires is flagged needs_review (refund by hand).

alter table comparison_requests add column if not exists guest_link_sent_at timestamptz;   -- claimed before the approval link is emailed, so it goes once

create unique index if not exists employer_payments_one_live_per_request on employer_payments (comparison_request_id)
  where comparison_request_id is not null and status in ('created', 'paid', 'needs_review');

-- ------------------------------------------------------------------------------------------------
-- The delivery point for a guest. Returns why it refused, or ok with the view window. Safe to call concurrently and repeatedly.
-- ------------------------------------------------------------------------------------------------
create or replace function open_guest_comparison(p_token_hash text)
returns table(ok boolean, reason text, request_id uuid, first_open boolean, window_ends_at timestamptz)
language plpgsql security definer set search_path = public as $$
declare r comparison_requests%rowtype; p employer_payments%rowtype;
begin
  select * into r from comparison_requests where guest_token_hash = p_token_hash and access_method = 'guest' for update;
  if not found then return query select false, 'not_found'::text, null::uuid, false, null::timestamptz; return; end if;

  -- Already delivered: a re-open, free, but only inside the window (and only while the snapshot still exists).
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

  -- Spend the payment: exactly once, for exactly this request.
  if not redeem_employer_payment(p.id, r.id::text) then
    return query select false, 'payment_unavailable'::text, r.id, false, null::timestamptz; return;
  end if;
  update comparison_requests set first_delivered_at = now(), view_window_ends_at = now() + interval '30 minutes'
   where id = r.id returning comparison_requests.view_window_ends_at into window_ends_at;
  return query select true, 'delivered'::text, r.id, true, window_ends_at;
end $$;
revoke all on function open_guest_comparison(text) from public, anon, authenticated;
grant execute on function open_guest_comparison(text) to service_role;

-- The guest ends the view early: the window closes now and the snapshot is deleted.
create or replace function close_guest_comparison(p_token_hash text) returns boolean
language plpgsql security definer set search_path = public as $$
declare r comparison_requests%rowtype;
begin
  select * into r from comparison_requests where guest_token_hash = p_token_hash and access_method = 'guest' and first_delivered_at is not null for update;
  if not found then return false; end if;
  update comparison_requests set view_window_ends_at = now(), closed_at = coalesce(closed_at, now()), status = 'expired' where id = r.id;
  delete from comparison_snapshots where request_id = r.id;
  return true;
end $$;
revoke all on function close_guest_comparison(text) from public, anon, authenticated;
grant execute on function close_guest_comparison(text) to service_role;

-- ------------------------------------------------------------------------------------------------
-- Endings: as in Stage 1, plus a guest who PAID but never opened before the snapshot ended is flagged for a manual refund.
-- ------------------------------------------------------------------------------------------------
create or replace function expire_comparison_requests() returns json
language plpgsql security definer set search_path = public as $$
declare a integer; b integer;
begin
  update comparison_requests set status = 'expired', responded_at = coalesce(responded_at, now())
   where status = 'pending' and expires_at < now();
  get diagnostics a = row_count;

  with gone as (
    update comparison_requests set status = 'expired', closed_at = coalesce(closed_at, now())
     where status = 'approved'
       and ((first_delivered_at is null and snapshot_expires_at is not null and snapshot_expires_at < now())
         or (access_method = 'org' and first_delivered_at is not null and first_delivered_at < now() - interval '90 days')
         or (access_method = 'guest' and first_delivered_at is not null and view_window_ends_at is not null and view_window_ends_at < now()))
    returning id
  ), flagged as (
    update employer_payments set status = 'needs_review'
     where comparison_request_id in (select id from gone) and status = 'paid' and redeemed_at is null
    returning id
  )
  delete from comparison_snapshots where request_id in (select id from gone);
  get diagnostics b = row_count;
  return json_build_object('pending_expired', a, 'snapshots_purged', b);
end $$;
revoke all on function expire_comparison_requests() from public, anon, authenticated;
grant execute on function expire_comparison_requests() to service_role;

create or replace function purge_candidate_comparisons(p_candidate uuid) returns integer
language plpgsql security definer set search_path = public as $$
declare n integer;
begin
  update employer_payments set status = 'needs_review'
   where status = 'paid' and redeemed_at is null
     and comparison_request_id in (select id from comparison_requests where candidate_id = p_candidate and status = 'approved' and first_delivered_at is null);
  delete from comparison_snapshots where candidate_id = p_candidate;
  get diagnostics n = row_count;
  update comparison_requests set status = 'expired', closed_at = coalesce(closed_at, now()), responded_at = coalesce(responded_at, now())
   where candidate_id = p_candidate and status in ('pending', 'approved');
  return n;
end $$;
revoke all on function purge_candidate_comparisons(uuid) from public, anon, authenticated;
grant execute on function purge_candidate_comparisons(uuid) to service_role;
