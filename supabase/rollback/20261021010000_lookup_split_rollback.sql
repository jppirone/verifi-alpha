-- Rollback of 20261021010000_lookup_split.sql. Run by hand, only on John's word.
-- Deploy the previous employer-api, candidate-comparison-requests and list-candidate-activity FIRST (or at least make sure nothing selects or writes created_for_request): they use the column.
-- Order: put both functions back as they were (they do not mention the column), then drop the column.

create or replace function list_employer_lookups(p_email text)
returns table(lookup_id uuid, candidate_label text, completed_at timestamptz, open_request_id uuid, open_request_status text)
language sql stable security definer set search_path = public as $$
  select l.id, l.candidate_label, l.used_at, r.id, r.status
  from employer_lookup_requests l
  left join lateral (
    select cr.id, cr.status from comparison_requests cr
     where cr.candidate_id = l.matched_candidate_id and cr.requester_email = lower(l.requester_email) and cr.status in ('pending', 'approved')
     limit 1
  ) r on true
  where lower(l.requester_email) = lower(p_email)
    and l.result_exists is true and l.matched_candidate_id is not null
    and l.used_at > now() - interval '30 days'
  order by l.used_at desc
  limit 50
$$;
revoke all on function list_employer_lookups(text) from public, anon, authenticated;
grant execute on function list_employer_lookups(text) to service_role;

create or replace function cleanup_expired_employer_lookups() returns integer
language plpgsql security definer set search_path = public as $$
declare n integer;
begin
  update employer_lookup_requests set candidate_label = null where candidate_label is not null and used_at < now() - interval '30 days';
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

alter table public.employer_lookup_requests drop column if exists created_for_request;
