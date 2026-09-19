-- Retention change for employer_lookup_requests, needed by the license_only Activity tab.
--
-- A completed lookup that MATCHED a candidate is part of that candidate's own activity history ("an
-- employer confirmed a lookup of you"). The earlier cleanup deleted every row after 30 days, which would
-- silently truncate that history. What a matched row still holds is the requester's own name / company /
-- email and the outcome; the third-party details the requester typed about the candidate were already
-- nulled when the lookup completed.
--
-- New rule:
--   * unconfirmed requests (link never used): deleted 1 day after their link expired (unchanged)
--   * completed lookups that did NOT match anyone: deleted after 30 days (unchanged)
--   * completed lookups that matched a candidate who still exists: kept, for that candidate's Activity
--   * matched, but the candidate has since been deleted (matched_candidate_id set null): deleted after 30 days
create or replace function cleanup_expired_employer_lookups() returns integer
language plpgsql
security definer
set search_path = public
as $$
declare n integer;
begin
  delete from employer_lookup_requests
   where (used_at is null and expires_at < now() - interval '1 day')
      or (used_at is not null
          and created_at < now() - interval '30 days'
          and (result_exists is not true or matched_candidate_id is null));
  get diagnostics n = row_count;
  return n;
end;
$$;
grant execute on function cleanup_expired_employer_lookups() to service_role;
