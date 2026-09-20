-- License-status report (Stage 1, 2026-09-20): a second kind of comparison request, for LICENSE-ONLY candidates, who have no resume to compare.
--
-- The kind is DERIVED FROM THE CANDIDATE'S ACCOUNT TYPE by create_comparison_request, never supplied by a caller:
--   full_resume  -> 'resume_comparison'
--   license_only -> 'license_report'
-- so an employer cannot pick or spoof it (choosing would also reveal, before approval, that a candidate has no resume). The function has no
-- kind parameter, and the employer-facing endpoints never read one. Everything else (the 72 h answer window, the one-open-request rule, the
-- 30 day decline cool-down, caps, org metering at first open, the guest payment, the expiry sweep, deactivation purge) is shared unchanged.
alter table comparison_requests
  add column if not exists kind text not null default 'resume_comparison' check (kind in ('resume_comparison', 'license_report'));

-- The last LIVE registry check made for a report (verify-license action status_report). It is a cache, not a determination: it lets a
-- candidate preview and then approve without hitting the registry twice, and rate-limits how often anyone can make the registry be asked
-- about a license. It never changes verification_outcome, the queue row, or anything staff see.
alter table license_items
  add column if not exists status_check_at timestamptz,
  add column if not exists status_check jsonb;

create or replace function create_comparison_request(
  p_lookup_id uuid, p_method text, p_employer_user uuid, p_attestation text, p_claim_hash text default null
) returns table(ok boolean, reason text, detail text, request_id uuid)
language plpgsql security definer set search_path = public as $$
declare
  l employer_lookup_requests%rowtype;
  c candidates%rowtype;
  u employer_users%rowtype;
  v_att text := btrim(coalesce(p_attestation, ''));
  v_email text;
  v_id uuid;
  v_kind text;
begin
  if char_length(v_att) < 3 or char_length(v_att) > 500 then
    return query select false, 'attestation_invalid'::text, null::text, null::uuid; return;
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
    if p_claim_hash is null or l.claim_token_hash is null or l.claim_token_hash <> p_claim_hash then
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

  begin
    insert into comparison_requests (candidate_id, lookup_id, requester_email, requester_name, requester_company, requester_domain_type,
                                     employer_user_id, org_id, access_method, attestation, expires_at, kind)
    values (c.id, l.id, v_email, l.requester_name, l.requester_company,
            case when split_part(v_email, '@', 2) in ('gmail.com', 'yahoo.com', 'outlook.com', 'hotmail.com', 'icloud.com', 'aol.com') then 'personal' else 'company' end,
            case when p_method = 'org' then u.id end, case when p_method = 'org' then u.org_id end, p_method, v_att, now() + interval '72 hours', v_kind)
    returning id into v_id;
  exception when unique_violation then
    select r.id into v_id from comparison_requests r where r.candidate_id = c.id and r.requester_email = v_email and r.status in ('pending', 'approved');
    return query select false, 'already_open'::text, null::text, v_id; return;
  end;
  return query select true, 'created'::text, null::text, v_id;
end $$;
revoke all on function create_comparison_request(uuid, text, uuid, text, text) from public, anon, authenticated;
grant execute on function create_comparison_request(uuid, text, uuid, text, text) to service_role;

-- Endings: as before, except an OPENED account-path LICENSE REPORT is discarded 30 days after it was opened (a status report goes stale
-- much faster than a resume comparison, which keeps its 90 days).
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
         or (access_method = 'org' and kind = 'resume_comparison' and first_delivered_at is not null and first_delivered_at < now() - interval '90 days')
         or (access_method = 'org' and kind = 'license_report' and first_delivered_at is not null and first_delivered_at < now() - interval '30 days')
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
