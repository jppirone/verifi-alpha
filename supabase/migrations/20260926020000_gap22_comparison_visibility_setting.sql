-- Gap #22 (2026-09-25/26): two independent candidate settings instead of one.
--
-- `candidates.discoverable` already existed and keeps its exact meaning: "Allow lookup" -- governs only the
-- anonymous/casual existence-check feature (check-existence). It is unchanged by this migration.
--
-- New: `allow_comparison_requests` governs whether an employer who already has the candidate's resume can
-- send a comparison request AT ALL. Before this migration there was no such setting -- a comparison request
-- has always been creatable (subject to create_comparison_request's other rules) with no opt-out. Defaulting
-- this to true preserves that existing behavior for every candidate who has never seen the new setting; it is
-- not a privacy tightening by itself, only a new opt-out surface.
alter table candidates add column if not exists allow_comparison_requests boolean not null default true;

-- The old create_comparison_request (lookup_id-based) is UNCHANGED and keeps working exactly as before, for
-- anything already using it (the org-plan flow's existing lookup-first UI, and any in-flight anonymous-guest
-- request). It still gates on c.discoverable, which is correct for that path: it can only ever be reached
-- via a lookup that itself already required discoverable = true, so c.discoverable there is defense in depth,
-- not the new setting's job.
--
-- This new sibling RPC is the direct-request path (Gap #22): it is NOT reached via any prior lookup row, so
-- it takes the matched candidate directly (resolved server-side by employer-api's request_comparison_direct,
-- via its own matching that does NOT require discoverable = true -- that is the whole point: Lookup=OFF must
-- not block Comparison=ON). Eligibility here is allow_comparison_requests, not discoverable.
create or replace function create_comparison_request_direct(
  p_candidate_id uuid,
  p_method text,
  p_employer_user uuid,
  p_attestation text,
  p_document_id uuid,
  p_lookup_id uuid default null,
  p_requester_company text default null
) returns table(ok boolean, reason text, detail text, request_id uuid)
language plpgsql
security definer
set search_path to 'public'
as $$
declare
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
  if p_employer_user is null then
    return query select false, 'unavailable'::text, 'no_employer_user'::text, null::uuid; return;
  end if;
  select * into u from employer_users where id = p_employer_user;
  if not found then return query select false, 'unavailable'::text, 'no_such_user'::text, null::uuid; return; end if;
  v_email := lower(u.email);

  if p_method = 'org' then
    if u.org_id is null then return query select false, 'unavailable'::text, 'no_org'::text, null::uuid; return; end if;
    if not exists (select 1 from employer_org_subscriptions s where s.org_id = u.org_id and s.status in ('active', 'trialing')) then
      return query select false, 'subscription_required'::text, null::text, null::uuid; return;
    end if;
  elsif p_method != 'guest' then
    return query select false, 'unavailable'::text, 'bad_method'::text, null::uuid; return;
  end if;

  select * into c from candidates where id = p_candidate_id;
  v_kind := case c.account_type when 'full_resume' then 'resume_comparison' when 'license_only' then 'license_report' else null end;
  -- allow_comparison_requests, NOT discoverable, is this path's eligibility gate -- a candidate with Lookup
  -- off and Comparison on must still be reachable here (the caller already resolved the match without
  -- requiring discoverable; this is the second, independent half of that same setting split).
  if not found or v_kind is null or c.deletion_scheduled_at is not null or c.allow_comparison_requests is not true then
    return query select false, 'unavailable'::text, 'candidate_ineligible'::text, null::uuid; return;
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

  -- The document must be this employer's own (uploaded via employer-document's 'employer' mode -- session
  -- based, no lookup_id -- see that function's own header), not yet used by any request, and not past its hour.
  select * into d from comparison_request_documents x
   where x.id = p_document_id and x.request_id is null and x.purge_after > now()
     and x.uploader_kind = 'employer'
     and x.uploader_ref = p_employer_user::text
   for update;
  if not found then return query select false, 'document_invalid'::text, null::text, null::uuid; return; end if;

  begin
    insert into comparison_requests (candidate_id, lookup_id, requester_email, requester_name, requester_company, requester_domain_type,
                                     employer_user_id, org_id, access_method, attestation, expires_at, kind, document_required)
    values (c.id, p_lookup_id, v_email, u.name, p_requester_company,
            case when split_part(v_email, '@', 2) in ('gmail.com', 'yahoo.com', 'outlook.com', 'hotmail.com', 'icloud.com', 'aol.com') then 'personal' else 'company' end,
            u.id,
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
