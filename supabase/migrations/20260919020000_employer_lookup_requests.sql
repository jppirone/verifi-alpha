-- Tier 1 existence-check hardening: a real, server-side, single-use confirmation token for the
-- REQUESTER (the employer), modeled on email_verifications (candidate signup): plain UUID token in the
-- link, fixed expiry, single-use marker, distinct not_found / already_used / expired outcomes.
--
-- The candidate details the requester typed (name / email / phone) are STAGED here at request time and
-- the lookup runs from the staged row when the link is used, so what gets checked cannot be changed
-- between the confirmation email and the click. Those typed details are personal data about a third
-- party, so they are scrubbed (nulled) the moment the lookup completes; rows that never complete are
-- removed (1 day after expiry) by cleanup_expired_employer_lookups() (callable now, not yet on a scheduler — same
-- standing as cleanup_expired_unconfirmed_resume_data).
--
-- used_at is set ONLY by a real, completed lookup (never by a failed attempt), so an error never burns
-- the link. result_exists / matched_candidate_id record the outcome; a "no" result is deliberately the
-- same value whether the candidate doesn't exist, opted out, is being deleted, or the name didn't match.
create table if not exists employer_lookup_requests (
  id uuid primary key default gen_random_uuid(),
  token text not null unique,
  requester_email text not null,
  requester_name text,
  requester_company text,
  candidate_name text,
  candidate_email text,
  candidate_phone text,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  used_at timestamptz,
  result_exists boolean,
  matched_candidate_id uuid references candidates(id) on delete set null
);
create index if not exists employer_lookup_requests_requester_idx on employer_lookup_requests (lower(requester_email), created_at);
grant select, insert, update, delete on table employer_lookup_requests to service_role;

create or replace function cleanup_expired_employer_lookups() returns integer
language plpgsql
security definer
set search_path = public
as $$
declare n integer;
begin
  -- Unconfirmed requests still hold the typed candidate details: drop them a day after they expire.
  -- Completed rows (details already scrubbed) are kept 30 days as the requester-side lookup record.
  delete from employer_lookup_requests
   where (used_at is null and expires_at < now() - interval '1 day')
      or created_at < now() - interval '30 days';
  get diagnostics n = row_count;
  return n;
end;
$$;
grant execute on function cleanup_expired_employer_lookups() to service_role;
