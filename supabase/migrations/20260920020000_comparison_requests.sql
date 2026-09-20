-- Employer comparison delivery, Stage 1 (2026-09-20): the request -> candidate approval -> snapshot data model.
--
-- FLOW (whole feature; this migration holds the tables for all of it, only the candidate side is built in Stage 1):
--   employer (signed in with a live org subscription, OR a guest with a Tier 1 match) asks to compare a specific candidate
--   -> the candidate, signed in, approves or declines (nothing is assembled or shown to the employer before approval)
--   -> on approval the server assembles a frozen snapshot of ONLY what the candidate confirmed AND Verifi verified
--   -> the employer opens it; that first successful open is "delivery" and is the point the meters fire (Stages 2 and 3).
--
-- WHAT COUNTS AS "VERIFIED ENOUGH" (enforced in candidate-comparison-requests, restated here so the rule lives next to the data):
--   An item is in a snapshot only if the candidate confirmed it (candidate_confirmed = true, on a resume document whose
--   confirmed_at is set) AND a verification_items row points at it (source_item_id) with status = 'Confirmed'
--     work_history_items      <- verification_items.type 'Job Experience'
--     education_items         <- type 'Education'
--     certification_items     <- type 'Certification', OR the linked license_items row's queue row (type 'License') is 'Confirmed'
--   Every other status (New, In Progress, Awaiting Response, Needs Reconciliation, Discrepancy, Unable to Verify), rows of type
--   'Needs Review', items with no queue row, skills, summary, hobbies and other sections, and contact details are NEVER included.
--   Non-Confirmed items appear only as a bare count ("N confirmed, M verified"), never broken down by why.
--
-- verification_items had no record of WHEN a status changed (only created_at, and the timeline table is written by hand). The
-- status_changed_at column below is stamped by a trigger from now on, so a snapshot can say when an item was verified. Rows that
-- existed before this migration are backfilled with created_at (no row was Confirmed at the time, so nothing is misdated).

alter table verification_items add column if not exists status_changed_at timestamptz;
update verification_items set status_changed_at = created_at where status_changed_at is null;

create or replace function verification_items_stamp_status() returns trigger
language plpgsql as $$
begin
  if tg_op = 'INSERT' then
    new.status_changed_at := coalesce(new.status_changed_at, now());
  elsif new.status is distinct from old.status then
    new.status_changed_at := now();
  end if;
  return new;
end $$;
drop trigger if exists verification_items_stamp_status on verification_items;
create trigger verification_items_stamp_status before insert or update on verification_items
  for each row execute function verification_items_stamp_status();

-- A completed Tier 1 lookup can carry a one-time claim token (minted by check-existence in Stage 3, returned only to the browser
-- that completed the lookup) so that a guest's follow-up request needs more than the lookup's id.
alter table employer_lookup_requests add column if not exists claim_token_hash text;

create table if not exists comparison_requests (
  id uuid primary key default gen_random_uuid(),
  candidate_id uuid not null references candidates(id) on delete cascade,
  lookup_id uuid references employer_lookup_requests(id) on delete set null,
  -- Copied from the Tier 1 lookup at creation (the requester's own typed name/company, and the email they proved they control).
  requester_email text not null check (requester_email = lower(requester_email)),
  requester_name text,
  requester_company text,
  requester_domain_type text not null default 'company' check (requester_domain_type in ('personal', 'company')),
  employer_user_id uuid references employer_users(id) on delete set null,
  org_id uuid references employer_orgs(id) on delete set null,
  access_method text not null check (access_method in ('org', 'guest')),
  attestation text not null check (char_length(attestation) between 3 and 500),   -- "how did you obtain this information", shown to the candidate
  -- pending -> approved | declined | expired.  'approved' means a snapshot exists (until it is purged, then 'expired').
  status text not null default 'pending' check (status in ('pending', 'approved', 'declined', 'expired')),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,               -- the candidate's answer window (72 h)
  responded_at timestamptz,
  approved_at timestamptz,
  snapshot_expires_at timestamptz,               -- an approved snapshot the employer has not opened is discarded at this time (7 days)
  guest_token_hash text unique,                  -- guest path only, minted at approval (Stage 3)
  first_delivered_at timestamptz,                -- set once, by the first successful open: the meter point (Stages 2 and 3)
  view_window_ends_at timestamptz,               -- guest one-time view: re-open allowed until this (Stage 3)
  closed_at timestamptz,
  candidate_notified_at timestamptz,             -- claimed before the "you have a request" email is sent, so it goes once
  requester_notified_at timestamptz              -- claimed before the "not authorized" email is sent, so it goes once
);
create index if not exists comparison_requests_candidate_idx on comparison_requests (candidate_id, created_at desc);
create index if not exists comparison_requests_requester_idx on comparison_requests (requester_email, created_at);
create index if not exists comparison_requests_status_idx on comparison_requests (status, expires_at);
-- One open (pending or approved) request per candidate and requester.
create unique index if not exists comparison_requests_one_open on comparison_requests (candidate_id, requester_email) where status in ('pending', 'approved');

create table if not exists comparison_snapshots (
  id uuid primary key default gen_random_uuid(),
  request_id uuid not null unique references comparison_requests(id) on delete cascade,
  candidate_id uuid not null references candidates(id) on delete cascade,
  assembled_at timestamptz not null default now(),
  content jsonb not null,
  counts jsonb not null
);
create index if not exists comparison_snapshots_candidate_idx on comparison_snapshots (candidate_id);

-- Same lock-down as every employer table: RLS on with no policies (the public API keys read and write nothing), service role only.
alter table comparison_requests enable row level security;
alter table comparison_snapshots enable row level security;
revoke all on table comparison_requests, comparison_snapshots from anon, authenticated;
grant select, insert, update, delete on table comparison_requests, comparison_snapshots to service_role;

alter table employer_payments add column if not exists comparison_request_id uuid references comparison_requests(id) on delete set null;

-- ------------------------------------------------------------------------------------------------
-- Creating a request. ONE place for the rules, called by the employer-side endpoints (Stages 2 and 3) with the service role.
-- The reason returned to a caller is deliberately coarse: everything about the CANDIDATE's state (not full-resume, deactivated,
-- not discoverable, declined this requester recently, too many pending requests) comes back as the same 'unavailable', so a
-- request can never be used to learn why. `detail` is for logs and tests and must never be sent to an employer.
-- ------------------------------------------------------------------------------------------------
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
  if not found or c.account_type is distinct from 'full_resume' or c.deletion_scheduled_at is not null or c.discoverable is not true then
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
                                     employer_user_id, org_id, access_method, attestation, expires_at)
    values (c.id, l.id, v_email, l.requester_name, l.requester_company,
            case when split_part(v_email, '@', 2) in ('gmail.com', 'yahoo.com', 'outlook.com', 'hotmail.com', 'icloud.com', 'aol.com') then 'personal' else 'company' end,
            case when p_method = 'org' then u.id end, case when p_method = 'org' then u.org_id end, p_method, v_att, now() + interval '72 hours')
    returning id into v_id;
  exception when unique_violation then
    select r.id into v_id from comparison_requests r where r.candidate_id = c.id and r.requester_email = v_email and r.status in ('pending', 'approved');
    return query select false, 'already_open'::text, null::text, v_id; return;
  end;
  return query select true, 'created'::text, null::text, v_id;
end $$;
revoke all on function create_comparison_request(uuid, text, uuid, text, text) from public, anon, authenticated;
grant execute on function create_comparison_request(uuid, text, uuid, text, text) to service_role;

-- ------------------------------------------------------------------------------------------------
-- Time-based endings. Run every 15 minutes by the candidate-comparison-requests sweep (which then sends the emails).
--   * a pending request the candidate never answered                            -> expired (72 h)
--   * an approved snapshot the employer never opened                            -> expired, content deleted (7 days)
--   * an opened ACCOUNT-path snapshot after 90 days                             -> expired, content deleted
--   * an opened GUEST-path snapshot after its one-time view window closes       -> expired, content deleted (Stage 3 sets the window)
-- Deleting content keeps the request row (who asked, when, outcome) as the record.
-- ------------------------------------------------------------------------------------------------
create or replace function expire_comparison_requests() returns json
language plpgsql security definer set search_path = public as $$
declare a integer; b integer; d integer;
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
  )
  delete from comparison_snapshots where request_id in (select id from gone);
  get diagnostics d = row_count;
  b := d;
  return json_build_object('pending_expired', a, 'snapshots_purged', b);
end $$;
revoke all on function expire_comparison_requests() from public, anon, authenticated;
grant execute on function expire_comparison_requests() to service_role;

-- When a candidate deactivates (deletion_scheduled_at gets set) every snapshot of their data is deleted at once and anything still open
-- is closed. Reactivating does not bring them back: an employer must ask again.
create or replace function purge_candidate_comparisons(p_candidate uuid) returns integer
language plpgsql security definer set search_path = public as $$
declare n integer;
begin
  delete from comparison_snapshots where candidate_id = p_candidate;
  get diagnostics n = row_count;
  update comparison_requests set status = 'expired', closed_at = coalesce(closed_at, now()), responded_at = coalesce(responded_at, now())
   where candidate_id = p_candidate and status in ('pending', 'approved');
  return n;
end $$;
revoke all on function purge_candidate_comparisons(uuid) from public, anon, authenticated;
grant execute on function purge_candidate_comparisons(uuid) to service_role;

create or replace function trg_purge_comparisons_on_deactivation() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  perform purge_candidate_comparisons(new.id);
  return new;
end $$;
drop trigger if exists purge_comparisons_on_deactivation on candidates;
create trigger purge_comparisons_on_deactivation after update of deletion_scheduled_at on candidates
  for each row when (new.deletion_scheduled_at is not null and old.deletion_scheduled_at is null)
  execute function trg_purge_comparisons_on_deactivation();

-- Sweep credentials, same scheme as purge-resume-storage: a random secret kept only in internal_job_secrets, read by the cron
-- command inside the database and by the function with its own service role.
insert into internal_job_secrets (name, value)
  values ('comparison_sweep', replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', ''))
  on conflict (name) do nothing;
