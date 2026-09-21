-- Account deletion, redesign after the first live race test (2026-09-21). Replaces the function shapes in 20260921030000_account_deletion.sql.
--
-- WHAT THE RACE TEST FOUND. The first design had the Edge Function call delete_candidate_account through PostgREST (an RPC). Every PostgREST
-- request runs under the `authenticator` role's statement_timeout of 8 seconds. The race test held a "reactivation" transaction open on an
-- account while the job tried to delete it: the deletion waited on the row lock past 8 s, was cancelled (statement timeout), rolled back with
-- the account untouched and was logged as an error. That outcome was SAFE, but it showed a real defect: a large account (a long history, many
-- resume pages) can take longer than 8 s to delete, and it would time out and roll back on EVERY hourly retry, never deleting.
--
-- THE FIX splits the work by what each half can do:
--   * The Edge Function (delete-expired-accounts) does only what needs the network: cancel the Stripe subscription(s), delete the Stripe customer(s),
--     and record "billing cleared for deactivation X" in account_deletion_log (record_account_billing_cleared).
--   * The database deletes, by itself, from pg_cron (run_account_deletions, hourly, ten minutes after the Edge Function): no PostgREST in the way,
--     so no 8-second cap, and a lock wait behind a racing reactivation simply waits it out.
--   * delete_candidate_account no longer takes a caller-supplied "billing cleared" flag. It looks up the recorded clearance itself and refuses any
--     account whose clearance is not for its CURRENT deactivation (so a clearance from an earlier deactivate/reactivate cycle can never be reused).
--     No caller, human or job, can delete a billed account by passing true.
--   * due_account_deletions (what the Edge Function works on) now skips exempt accounts BEFORE any Stripe call: the owner's own account has a live
--     Stripe test subscription, and the first design would have cancelled it before the exempt check ever ran.

alter table account_deletion_log add column if not exists billing_cleared_for timestamptz;   -- the deletion_scheduled_at this clearance belongs to
alter table account_deletion_log add column if not exists billing_detail jsonb;               -- Stripe result (counts and ids only, never personal data)

drop function if exists delete_candidate_account(uuid, boolean, jsonb);
drop function if exists due_account_deletions(integer);

-- Accounts the Edge Function still has to clear billing for: 30+ days past deactivation, not exempt, not already cleared for this deactivation.
create or replace function due_account_deletions(p_limit integer default 10)
returns table(candidate_id uuid, deactivated_at timestamptz, stripe_subscription_id text, attempts integer)
language sql stable security definer set search_path = public as $$
  select c.id, c.deletion_scheduled_at, c.stripe_subscription_id, coalesce(l.attempts, 0)
    from candidates c left join account_deletion_log l on l.candidate_id = c.id
   where c.deletion_scheduled_at is not null and c.deletion_scheduled_at <= now() - interval '30 days'
     and not exists (select 1 from account_deletion_exempt e where e.candidate_id = c.id)
     and l.billing_cleared_for is distinct from c.deletion_scheduled_at
   order by c.deletion_scheduled_at
   limit greatest(1, least(p_limit, 50))
$$;
revoke all on function due_account_deletions(integer) from public, anon, authenticated;
grant execute on function due_account_deletions(integer) to service_role;

create or replace function record_account_billing_cleared(p_candidate uuid, p_detail jsonb default null)
returns void language plpgsql security definer set search_path = public as $$
begin
  insert into account_deletion_log (candidate_id, deactivated_at, outcome, billing_cleared_for, billing_detail)
    select c.id, c.deletion_scheduled_at, 'billing_cleared', c.deletion_scheduled_at, p_detail
      from candidates c where c.id = p_candidate and c.deletion_scheduled_at is not null
  on conflict (candidate_id) do update
    set billing_cleared_for = excluded.billing_cleared_for, billing_detail = excluded.billing_detail, deactivated_at = excluded.deactivated_at,
        outcome = 'billing_cleared', last_attempt_at = now()
    where account_deletion_log.outcome <> 'deleted';
end $$;
revoke all on function record_account_billing_cleared(uuid, jsonb) from public, anon, authenticated;
grant execute on function record_account_billing_cleared(uuid, jsonb) to service_role;

create or replace function delete_candidate_account(p_candidate uuid)
returns jsonb
language plpgsql security definer set search_path = public, storage as $$
declare
  c candidates%rowtype;
  v_email text;
  v_digits text;
  v_evs uuid[];
  v_docs uuid[];
  v_reqs uuid[];
  v_bill jsonb;
  n integer;
  counts jsonb := '{}'::jsonb;
begin
  -- The lock that makes reactivation safe: from here to commit nothing can change or reactivate this account.
  select * into c from candidates where id = p_candidate for update;
  if not found then return jsonb_build_object('outcome', 'not_found'); end if;

  if exists (select 1 from account_deletion_exempt e where e.candidate_id = p_candidate) then
    insert into account_deletion_log (candidate_id, deactivated_at, outcome) values (c.id, c.deletion_scheduled_at, 'exempt')
      on conflict (candidate_id) do update set attempts = account_deletion_log.attempts + 1, last_attempt_at = now(), outcome = 'exempt';
    return jsonb_build_object('outcome', 'exempt');
  end if;

  if c.deletion_scheduled_at is null or c.deletion_scheduled_at > now() - interval '30 days' then
    -- Reactivated (the safeguard this whole feature must not break) or simply not due yet.
    update account_deletion_log set outcome = 'not_due', last_attempt_at = now() where candidate_id = p_candidate and outcome <> 'deleted';
    return jsonb_build_object('outcome', 'not_due');
  end if;

  -- Billing must have been cleared (Stripe subscription cancelled, customer deleted) for THIS deactivation.
  select l.billing_detail into v_bill from account_deletion_log l where l.candidate_id = p_candidate and l.billing_cleared_for = c.deletion_scheduled_at;
  if not found then
    perform record_account_deletion_attempt(p_candidate, 'blocked_billing', jsonb_build_object('reason', 'billing_not_cleared'));
    return jsonb_build_object('outcome', 'blocked_billing');
  end if;

  v_email := lower(btrim(coalesce(c.email, '')));
  v_digits := regexp_replace(coalesce(c.phone, ''), '\D', '', 'g');

  select coalesce(array_agg(distinct x), '{}') into v_evs from (
    select ev.id x from email_verifications ev where ev.existing_candidate_id = p_candidate or (v_email <> '' and lower(btrim(ev.email)) = v_email)
    union select c.verification_id where c.verification_id is not null
  ) s;
  select coalesce(array_agg(d.id), '{}') into v_docs from resume_documents d where d.candidate_id = p_candidate or d.email_verification_id = any (v_evs);
  select coalesce(array_agg(r.id), '{}') into v_reqs from comparison_requests r where r.candidate_id = p_candidate;

  -- Employer side, before anything is removed. A guest who PAID for a view that will now never happen is flagged for a manual refund (the same
  -- thing deactivation does); a payment row outlives the request row it pointed at.
  update employer_payments set status = 'needs_review'
   where status = 'paid' and redeemed_at is null and comparison_request_id = any (v_reqs);
  get diagnostics n = row_count; counts := counts || jsonb_build_object('employer_payments_flagged', n);

  update employer_lookup_requests set matched_candidate_id = null, candidate_label = null, claim_token_hash = null where matched_candidate_id = p_candidate;
  get diagnostics n = row_count; counts := counts || jsonb_build_object('employer_lookups_unlinked', n);
  update employer_lookup_requests set candidate_name = null, candidate_email = null, candidate_phone = null
   where used_at is null
     and ((v_email <> '' and lower(btrim(coalesce(candidate_email, ''))) = v_email)
       or (length(v_digits) >= 10 and right(regexp_replace(coalesce(candidate_phone, ''), '\D', '', 'g'), 10) = right(v_digits, 10)));
  get diagnostics n = row_count; counts := counts || jsonb_build_object('employer_lookups_scrubbed', n);

  delete from comparison_snapshots where candidate_id = p_candidate or request_id = any (v_reqs);
  get diagnostics n = row_count; counts := counts || jsonb_build_object('comparison_snapshots', n);
  delete from comparison_request_documents where request_id = any (v_reqs);       -- the trigger queues each employer file for the purge job
  get diagnostics n = row_count; counts := counts || jsonb_build_object('comparison_request_documents', n);
  delete from comparison_requests where id = any (v_reqs);
  get diagnostics n = row_count; counts := counts || jsonb_build_object('comparison_requests', n);

  -- Files: every path the account's documents name, plus anything in the bucket sitting in the account's own (or its signup rows') folder.
  insert into resume_storage_purge_queue (bucket, path)
    select 'resume-documents', p from (
      select d.original_storage_path p from resume_documents d where d.id = any (v_docs)
      union select d.sanitized_render_path from resume_documents d where d.id = any (v_docs)
      union select o.name from storage.objects o
             where o.bucket_id = 'resume-documents'
               and (split_part(o.name, '/', 1) = p_candidate::text
                    or split_part(o.name, '/', 1) in (select unnest(v_evs)::text)
                    or split_part(o.name, '/', 2) in (select unnest(v_docs)::text))
    ) s where p is not null
  on conflict (bucket, path) do nothing;
  get diagnostics n = row_count; counts := counts || jsonb_build_object('files_queued', n);

  delete from verification_item_timeline where item_id in (select vi.id from verification_items vi where vi.candidate_id = p_candidate or vi.bundle_id = any (v_docs));
  get diagnostics n = row_count; counts := counts || jsonb_build_object('verification_item_timeline', n);
  delete from profile_item_lineage where candidate_id = p_candidate;
  get diagnostics n = row_count; counts := counts || jsonb_build_object('profile_item_lineage', n);
  delete from profile_item_archive where candidate_id = p_candidate;
  get diagnostics n = row_count; counts := counts || jsonb_build_object('profile_item_archive', n);
  delete from verification_items where candidate_id = p_candidate or bundle_id = any (v_docs);
  get diagnostics n = row_count; counts := counts || jsonb_build_object('verification_items', n);
  delete from license_items where candidate_id = p_candidate or resume_document_id = any (v_docs);
  get diagnostics n = row_count; counts := counts || jsonb_build_object('license_items', n);
  delete from skill_items where candidate_id = p_candidate or resume_document_id = any (v_docs);
  get diagnostics n = row_count; counts := counts || jsonb_build_object('skill_items', n);
  delete from work_history_items where candidate_id = p_candidate or resume_document_id = any (v_docs);
  get diagnostics n = row_count; counts := counts || jsonb_build_object('work_history_items', n);
  delete from education_items where candidate_id = p_candidate or resume_document_id = any (v_docs);
  get diagnostics n = row_count; counts := counts || jsonb_build_object('education_items', n);
  delete from certification_items where candidate_id = p_candidate or resume_document_id = any (v_docs);
  get diagnostics n = row_count; counts := counts || jsonb_build_object('certification_items', n);
  delete from candidate_freeform_sections where candidate_id = p_candidate or resume_document_id = any (v_docs);
  get diagnostics n = row_count; counts := counts || jsonb_build_object('candidate_freeform_sections', n);
  delete from resume_resubmissions where candidate_id = p_candidate;
  get diagnostics n = row_count; counts := counts || jsonb_build_object('resume_resubmissions', n);
  delete from resume_extraction_pages where resume_document_id = any (v_docs);
  get diagnostics n = row_count; counts := counts || jsonb_build_object('resume_extraction_pages', n);
  delete from resume_documents where id = any (v_docs);
  get diagnostics n = row_count; counts := counts || jsonb_build_object('resume_documents', n);
  delete from candidate_summary_versions where candidate_id = p_candidate;
  get diagnostics n = row_count; counts := counts || jsonb_build_object('candidate_summary_versions', n);
  delete from candidate_name_changes where candidate_id = p_candidate;
  get diagnostics n = row_count; counts := counts || jsonb_build_object('candidate_name_changes', n);

  delete from candidate_sessions where candidate_id = p_candidate;
  get diagnostics n = row_count; counts := counts || jsonb_build_object('candidate_sessions', n);
  delete from login_tokens where candidate_id = p_candidate or (v_email <> '' and lower(btrim(email)) = v_email);
  get diagnostics n = row_count; counts := counts || jsonb_build_object('login_tokens', n);
  delete from candidate_login_attempts where v_email <> '' and lower(btrim(email)) = v_email;
  get diagnostics n = row_count; counts := counts || jsonb_build_object('candidate_login_attempts', n);
  delete from email_verifications where id = any (v_evs);
  get diagnostics n = row_count; counts := counts || jsonb_build_object('email_verifications', n);

  delete from candidates where id = p_candidate;
  get diagnostics n = row_count; counts := counts || jsonb_build_object('candidates', n);

  if v_bill is not null then counts := counts || jsonb_build_object('stripe', v_bill); end if;
  insert into account_deletion_log (candidate_id, deactivated_at, outcome, detail, deleted_at)
    values (p_candidate, c.deletion_scheduled_at, 'deleted', counts, now())
  on conflict (candidate_id) do update
    set attempts = account_deletion_log.attempts + 1, last_attempt_at = now(), outcome = 'deleted', detail = excluded.detail,
        deleted_at = now(), deactivated_at = excluded.deactivated_at;
  return jsonb_build_object('outcome', 'deleted', 'counts', counts);
end $$;
revoke all on function delete_candidate_account(uuid) from public, anon, authenticated;
grant execute on function delete_candidate_account(uuid) to service_role;

-- The deletion pass pg_cron runs. Each account is its own subtransaction: one account failing (logged as 'error', retried next hour) never
-- blocks or rolls back another.
create or replace function run_account_deletions(p_limit integer default 10)
returns jsonb language plpgsql security definer set search_path = public as $$
declare r record; res jsonb; results jsonb := '{}'::jsonb;
begin
  for r in
    select c.id from candidates c join account_deletion_log l on l.candidate_id = c.id
     where c.deletion_scheduled_at is not null and c.deletion_scheduled_at <= now() - interval '30 days'
       and l.billing_cleared_for = c.deletion_scheduled_at
       and not exists (select 1 from account_deletion_exempt e where e.candidate_id = c.id)
     order by c.deletion_scheduled_at
     limit greatest(1, least(p_limit, 50))
  loop
    begin
      res := delete_candidate_account(r.id);
      results := results || jsonb_build_object(r.id::text, res ->> 'outcome');
    exception when others then
      perform record_account_deletion_attempt(r.id, 'error', jsonb_build_object('error', left(sqlerrm, 300)));
      results := results || jsonb_build_object(r.id::text, 'error');
    end;
  end loop;
  return results;
end $$;
revoke all on function run_account_deletions(integer) from public, anon, authenticated;
grant execute on function run_account_deletions(integer) to service_role;

select cron.schedule('run-account-deletions', '22 * * * *', 'select public.run_account_deletions()');
