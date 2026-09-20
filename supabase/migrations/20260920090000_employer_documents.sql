-- The employer's own document is now uploaded and kept (2026-09-20), so a candidate can judge who is really asking (for example a recruiter
-- they had forgotten, not the company itself). It used to exist only in the employer's browser.
--
--   * A request CANNOT be created without one: create_comparison_request now requires p_document_id and binds that upload to the new request
--     in the SAME transaction. There is no other way to create a request, so the rule is enforced here and not only in the forms.
--   * The exact uploaded bytes are stored in a PRIVATE bucket (no policies: only the service role can touch it) and served back unmodified,
--     to the candidate only, through short-lived signed links minted by candidate-comparison-requests.
--   * Retention: 21 days from the request, identically for approved, declined and expired requests. A candidate who deactivates loses it at
--     once. Deleting a row here queues the file in resume_storage_purge_queue (bucket 'employer-documents'), and the existing 15-minute
--     purge-resume-storage job removes it with the same "re-check before deleting" rules it uses for resumes.
--   * The uploader must tick the disclosure (consent_at / consent_version are stored with the file).
--   * The how-obtained text must now be at least 10 characters (was 3). The table CHECK stays 3..500 so older rows remain valid.

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('employer-documents', 'employer-documents', false, 10485760, array['application/pdf', 'image/png', 'image/jpeg'])
on conflict (id) do update set public = false, file_size_limit = 10485760, allowed_mime_types = array['application/pdf', 'image/png', 'image/jpeg'];

create table if not exists comparison_request_documents (
  id uuid primary key default gen_random_uuid(),                      -- also the stem of the storage file name
  request_id uuid unique references comparison_requests(id) on delete cascade,   -- null until the request that uses it is created
  storage_path text not null unique,                                  -- <id>.<pdf|png|jpg> in the employer-documents bucket
  content_type text not null check (content_type in ('application/pdf', 'image/png', 'image/jpeg')),   -- decided from the file's own signature
  byte_size integer not null check (byte_size between 1 and 10485760),
  sha256 text not null,
  file_name text,                                                     -- display name only (sanitized), never used as a path
  uploader_kind text not null check (uploader_kind in ('org', 'guest')),
  uploader_ref text not null,                                         -- org: employer_users.id; guest: the lookup id the claim token belongs to
  consent_at timestamptz not null,
  consent_version text not null,
  created_at timestamptz not null default now(),
  purge_after timestamptz not null                                    -- unbound upload: +1 hour; bound to a request: request time +21 days
);
create index if not exists comparison_request_documents_purge_after_idx on comparison_request_documents (purge_after);
create index if not exists comparison_request_documents_uploader_idx on comparison_request_documents (uploader_kind, uploader_ref, created_at);
alter table comparison_request_documents enable row level security;   -- no policies: no API role can read or write it
revoke all on table comparison_request_documents from anon, authenticated;
grant select, insert, update, delete on table comparison_request_documents to service_role;

-- Requests made from now on always had a document; older ones (created before this) did not, and the candidate screen says so.
alter table comparison_requests add column if not exists document_required boolean not null default false;

-- Deleting a document row (retention, deactivation, a deleted request or account) queues its file for the purge job.
create or replace function trg_queue_employer_document_purge() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into resume_storage_purge_queue (bucket, path) values ('employer-documents', old.storage_path) on conflict (bucket, path) do nothing;
  return old;
end $$;
drop trigger if exists queue_employer_document_purge on comparison_request_documents;
create trigger queue_employer_document_purge after delete on comparison_request_documents
  for each row execute function trg_queue_employer_document_purge();

-- Files in the bucket that no row names (an upload whose row insert failed, or a leftover). The sweep mode of purge-resume-storage deletes
-- them after a minimum age, re-checking each one first.
create or replace function list_orphan_employer_objects(p_min_age interval default interval '24 hours')
returns table(name text, created_at timestamptz, size bigint, standard_layout boolean)
language sql stable security definer set search_path = public, storage as $$
  select o.name, o.created_at, nullif(o.metadata->>'size', '')::bigint,
         o.name ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(pdf|png|jpg)$'
  from storage.objects o
  where o.bucket_id = 'employer-documents'
    and o.created_at < now() - p_min_age
    and not exists (select 1 from comparison_request_documents d where d.storage_path = o.name)
$$;
revoke all on function list_orphan_employer_objects(interval) from public, anon, authenticated;
grant execute on function list_orphan_employer_objects(interval) to service_role;

-- create_comparison_request: new p_document_id (required) and a real minimum for the how-obtained text.
drop function if exists create_comparison_request(uuid, text, uuid, text, text);
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
  -- bind the file to the request; from here the 21 days run
  update comparison_request_documents set request_id = v_id, purge_after = now() + interval '21 days' where id = d.id;
  return query select true, 'created'::text, null::text, v_id;
end $$;
revoke all on function create_comparison_request(uuid, text, uuid, text, text, uuid) from public, anon, authenticated;
grant execute on function create_comparison_request(uuid, text, uuid, text, text, uuid) to service_role;

-- Endings: as before, plus documents past their time (bound: 21 days after the request; never bound: 1 hour after upload).
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

  delete from comparison_request_documents where purge_after < now();   -- the trigger queues each file for the purge job
  get diagnostics docs = row_count;
  return json_build_object('pending_expired', a, 'snapshots_purged', b, 'documents_purged', docs);
end $$;
revoke all on function expire_comparison_requests() from public, anon, authenticated;
grant execute on function expire_comparison_requests() to service_role;

-- Deactivation: every document of every request of that candidate goes at once (rows now; files at the next purge run, which
-- deactivate-account also triggers immediately).
create or replace function purge_candidate_comparisons(p_candidate uuid) returns integer
language plpgsql security definer set search_path = public as $$
declare n integer;
begin
  delete from comparison_snapshots where candidate_id = p_candidate;
  get diagnostics n = row_count;
  delete from comparison_request_documents where request_id in (select id from comparison_requests where candidate_id = p_candidate);
  update comparison_requests set status = 'expired', closed_at = coalesce(closed_at, now()), responded_at = coalesce(responded_at, now())
   where candidate_id = p_candidate and status in ('pending', 'approved');
  return n;
end $$;
revoke all on function purge_candidate_comparisons(uuid) from public, anon, authenticated;
grant execute on function purge_candidate_comparisons(uuid) to service_role;
