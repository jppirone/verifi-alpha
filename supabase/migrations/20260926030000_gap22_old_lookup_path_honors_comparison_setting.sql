-- Gap #22 follow-up: the pre-existing lookup-id-based create_comparison_request (still the only path for the
-- ORG plan flow, and reachable for guest/pay-per-use via the old "Check for account" -> "Request" two-step UI)
-- only ever checked c.discoverable, never the new allow_comparison_requests. Since that path is reached via a
-- lookup that already required discoverable = true, existence is already known to this caller -- so a distinct
-- 'comparison_not_allowed' reason here is safe (matches the matrix's Lookup=ON, Comparison=OFF cell: an honest,
-- different answer, not the no-oracle 'unavailable' blur used for everything else on this path).
create or replace function create_comparison_request(
  p_lookup_id uuid, p_method text, p_employer_user uuid, p_attestation text,
  p_claim_hash text default null, p_document_id uuid default null
) returns table(ok boolean, reason text, detail text, request_id uuid)
language plpgsql
security definer
set search_path to 'public'
as $$
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
    if v_email <> u.email then return query select false, 'unavailable'::text, 'lookup_not_yours'::text, null::uuid; return; end if;
    if not exists (select 1 from employer_org_subscriptions s where s.org_id = u.org_id and s.status in ('active', 'trialing')) then
      return query select false, 'subscription_required'::text, null::text, null::uuid; return;
    end if;
  elsif p_method = 'guest' then
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
  v_kind := case c.account_type when 'full_resume' then 'resume_comparison' when 'license_only' then 'license_report' else null end;
  if not found or v_kind is null or c.deletion_scheduled_at is not null or c.discoverable is not true then
    return query select false, 'unavailable'::text, 'candidate_ineligible'::text, null::uuid; return;
  end if;
  -- Gap #22: a second, independent gate -- distinguishable from the block above because existence is ALREADY
  -- known on this path (see header).
  if c.allow_comparison_requests is not true then
    return query select false, 'comparison_not_allowed'::text, null::text, null::uuid; return;
  end if;

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
