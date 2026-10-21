-- Lookup split (BA follow up, option B), October 21, 2026.
--
-- THE RULE: John built two SEPARATE candidate choices on purpose: "Let employers confirm I have an account here" (existence lookup) and allowing comparison requests. A comparison
-- request must not appear as an existence lookup anywhere: not in the employer's "Your lookups (last 30 days, matched)" list and not in the candidate's activity list.
--
-- WHY A MARKER: request_comparison_direct (employer-api) stages a row in employer_lookup_requests on every comparison request. That row keeps doing two other jobs and must stay:
-- it is counted by the shared 5 per hour limit, and it holds the candidate label the employer's comparison lists show (comparison_requests.lookup_id points at it). But it is burned
-- with result_exists = true and matched_candidate_id = the candidate even when the candidate has Lookup OFF, so list_employer_lookups showed it as a lookup. A marker column says
-- "this row was staged for a comparison request, it is not an existence lookup".
--
-- 1. employer_lookup_requests.created_for_request boolean not null default false. Naming follows the table's own style (result_exists, used_at, claim_token_hash: plain snake_case
--    facts about the row). Every ordinary lookup (check-existence, send-lookup-confirmation) keeps the default false; request_comparison_direct sets true.
-- 2. Backfill. A row that comparison_requests.lookup_id points to is NOT always a staged row: the older lookup-first path (a real lookup, then a request made from it with the claim
--    token) also points at its lookup, and that lookup is real and must stay in the list (the list shows whether a request is open for it). The two are told apart by time: the staged
--    row is burned and the request is created in the same call (well under a second apart; the live rows were about 0.4 s), while a real lookup is followed by an employer typing an
--    attestation and uploading a document (minutes). So the backfill marks a row only when a request points to it AND that request was created within 5 seconds of the row being used.
--    Live project on October 21, 2026: 2 comparison requests, 2 lookup rows pointed to, both created a fraction of a second apart: the backfill marks 2.
-- 3. list_employer_lookups skips marked rows (everything else in it is unchanged).
-- 4. cleanup_expired_employer_lookups keeps a row while any comparison request still points to it, so it can never null an open request's lookup_id. (The candidate_label scrub after
--    30 days is unchanged. A row with result_exists true and a matched candidate was never deleted by it; the new guard also protects a row whose candidate link was cleared.)
--
-- Readers of employer_lookup_requests and what they do with marked rows (decided in the build report): the rate limit counts (check-existence, send-lookup-confirmation,
-- request_comparison_direct) KEEP counting them; label readers keep reading them; the claim token paths never see them; the candidate lists skip them (edge functions).
-- Idempotent: safe to run twice. Rollback: supabase/rollback/20261021010000_lookup_split_rollback.sql

alter table public.employer_lookup_requests add column if not exists created_for_request boolean not null default false;
comment on column public.employer_lookup_requests.created_for_request is 'True when this row was staged by a comparison request (request_comparison_direct), not by an existence lookup. Such a row is never listed as a lookup; it only carries the rate limit count and the candidate label.';

update public.employer_lookup_requests l
   set created_for_request = true
 where l.created_for_request = false
   and exists (select 1 from public.comparison_requests cr
                where cr.lookup_id = l.id
                  and l.used_at is not null
                  and abs(extract(epoch from (cr.created_at - l.used_at))) < 5);

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
    and l.created_for_request is not true
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
  delete from employer_lookup_requests l
   where not exists (select 1 from comparison_requests cr where cr.lookup_id = l.id)
     and ((l.used_at is null and l.expires_at < now() - interval '1 day')
          or (l.used_at is not null
              and l.created_at < now() - interval '30 days'
              and (l.result_exists is not true or l.matched_candidate_id is null)));
  get diagnostics n = row_count;
  return n;
end;
$$;
grant execute on function cleanup_expired_employer_lookups() to service_role;
