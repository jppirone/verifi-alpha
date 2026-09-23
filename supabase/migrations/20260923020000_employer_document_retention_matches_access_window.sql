-- Employer document retention now matches the comparison's own access window (2026-09-23).
--
-- Real gap found while closing the document-required audit: the document was purged on a FIXED 21-day clock from
-- request creation, independent of the comparison itself -- but an org resume_comparison request can legitimately
-- stay open and re-openable for up to 90 days after first open (license_report: 30 days), on top of up to 72h to
-- answer plus a 7-day unopened-approval window before that. Worst case, a comparison approved and first opened
-- right at the wire on both of those could still be legitimately reopened up to ~100 days (resume_comparison) /
-- ~40 days (license_report) after the request was originally created -- well past the old 21-day document purge.
-- That meant a properly-submitted, properly-enforced request could still legitimately lose its document before
-- the comparison itself closed, breaking the "the employer's document is guaranteed present every time" guarantee.
--
-- Fixed two ways, together:
--   1. purge_after, set once at bind time (create_comparison_request), is now a generous per-kind CEILING that
--      outlives the longest possible legitimate re-open window with margin, instead of a flat 21 days for every
--      kind. It remains a backstop only -- see (2) for the real cleanup path -- and remains permanent/unbound-
--      only-once per the lock_bound_employer_document trigger (20260923010000), same as before.
--   2. expire_comparison_requests' document purge no longer relies solely on that ceiling: a BOUND document is
--      now also deleted as soon as its owning request reaches a terminal state (declined -- via any path,
--      including the candidate's own decline action -- or expired), checked directly against the request's
--      current status rather than tracked through this function's own same-pass CTEs. This ties bound-document
--      lifetime to the real request lifecycle, not an independent timer, so it can never drift out of sync again
--      even if the access-window durations change later. Unbound documents (never attached to any request) are
--      unaffected -- they still purge on their own original 1-hour clock.

create or replace function expire_comparison_requests() returns json
language plpgsql security definer set search_path = public as $$
declare a integer; b integer; docs integer;
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

  -- Bound documents purge promptly once their owning request is genuinely done (declined or expired, from any
  -- path -- this check re-reads comparison_requests.status directly, not just requests that ended in this same
  -- pass), OR when the per-kind backstop ceiling above is reached, whichever comes first. Unbound documents keep
  -- their own independent 1-hour purge_after, untouched by any of this.
  delete from comparison_request_documents d
   where d.purge_after < now()
      or exists (select 1 from comparison_requests r where r.id = d.request_id and r.status in ('declined', 'expired'));
  get diagnostics docs = row_count;
  return json_build_object('pending_expired', a, 'snapshots_purged', b, 'documents_purged', docs);
end $$;
revoke all on function expire_comparison_requests() from public, anon, authenticated;
grant execute on function expire_comparison_requests() to service_role;

-- create_comparison_request: purge_after at bind time is now a per-kind ceiling with margin, not a flat 21 days.
-- Guest keeps the previous flat 21 days -- its own lifecycle (72h answer + 7-day unopened-approval + a short,
-- single-use view window) never approaches it.
drop function if exists create_comparison_request(uuid, text, uuid, text, text, uuid);
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
            case when p_method = 'org' then u.id end, case when p_method = 'org' then u.org_id end, p_method, v_att, now() + interval '72 hours', v_kind, true)
    returning id into v_id;
  exception when unique_violation then
    select r.id into v_id from comparison_requests r where r.candidate_id = c.id and r.requester_email = v_email and r.status in ('pending', 'approved');
    return query select false, 'already_open'::text, null::text, v_id; return;
  end;
  -- bind the file to the request. purge_after is a per-kind ceiling with margin (2026-09-23) -- a backstop only;
  -- normal cleanup happens promptly in expire_comparison_requests, tied to the request's actual terminal state.
  update comparison_request_documents set request_id = v_id, purge_after = now() + (
    case when p_method = 'org' and v_kind = 'resume_comparison' then interval '105 days'
         when p_method = 'org' and v_kind = 'license_report' then interval '45 days'
         else interval '21 days' end
  ) where id = d.id;
  return query select true, 'created'::text, null::text, v_id;
end $$;
revoke all on function create_comparison_request(uuid, text, uuid, text, text, uuid) from public, anon, authenticated;
grant execute on function create_comparison_request(uuid, text, uuid, text, text, uuid) to service_role;
