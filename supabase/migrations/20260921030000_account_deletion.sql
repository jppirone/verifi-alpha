-- Real account deletion (2026-09-21).
--
-- THE PROMISE. The Deactivation screen has said for weeks: "Your account and verified data are retained for 30 days in case you change your mind,
-- then permanently deleted." Deactivation (deactivate-account) has always stamped candidates.deletion_scheduled_at = the moment of deactivation
-- (a "when deactivated", not a purge date) and revoked every session; reactivation (reactivate-account) clears it. NOTHING ever deleted the account
-- when the 30 days ran out: 7 cron jobs and every deployed function were checked twice and none touched a deactivated account.
--
-- THE FIX has three parts.
--   1. delete_candidate_account(candidate, billing_cleared): ONE transaction that deletes everything the account owns, in foreign-key order, and
--      the candidates row last. It locks the candidate row first (FOR UPDATE), so a reactivation racing the deletion either commits first (the
--      account is no longer due: nothing is deleted) or waits and finds the account gone. It re-checks every guard itself, so no caller, the
--      cron job or a person at a SQL prompt, can delete an account that is not 30 days past deactivation.
--   2. delete-expired-accounts (Edge Function, hourly by cron): the part a Postgres function cannot do. Before any row is touched it makes sure
--      the account's Stripe subscription is cancelled and its Stripe customer deleted, and only then calls the SQL function. Stripe trouble means
--      "not this run", never "delete anyway" (a candidate must never be deleted while still being billed).
--   3. account_deletion_log: one row per account the job ever looked at (outcome, per-table counts, Stripe result). It holds NO personal data
--      (an id, dates, numbers); it is the proof that a deletion happened and the place a stuck one shows up.
--
-- WHAT IS DELETED (the inventory; every one of these was checked against a live account seeded with rows in all of them):
--   candidates; candidate_sessions; login_tokens (by candidate id AND by email); candidate_login_attempts (by email); email_verifications (by
--   existing_candidate_id, by the candidate's own verification_id, AND by email: signup rows hold name, phone and email); resume_documents (every
--   kind: initial, confirmed, staged resubmission) with resume_extraction_pages (OCR text); work_history_items, education_items,
--   certification_items, skill_items, candidate_freeform_sections, license_items (by candidate id AND by document, so unfinished-signup rows go
--   too); verification_items and verification_item_timeline; resume_resubmissions (open, applied, failed, expired) with the staged rows they
--   hold; profile_item_archive and profile_item_lineage; candidate_summary_versions; candidate_name_changes; comparison_requests (pending,
--   approved, declined, expired; also license reports, which are comparison_requests of another kind), comparison_snapshots and
--   comparison_request_documents (each employer-uploaded file is queued for the storage purge by the existing trigger); every file in the
--   resume-documents bucket the account or its signup rows own, queued for the existing 15-minute purge job.
--   Scrubbed, not deleted, because the row belongs to the EMPLOYER: employer_lookup_requests that matched this candidate lose the link, the
--   claim token and the name the requester typed (the existing retention job then removes the orphaned row), and a lookup still in flight whose
--   typed email or phone is this candidate's loses those typed details (it completes as "no record").
--   KEPT on purpose: employer_payments (the employer's financial record; a paid, unredeemed guest payment tied to this candidate is flagged
--   needs_review first, exactly as deactivation does, so the money trail survives the request row), employer_lookup_usage, stripe_webhook_events
--   (no candidate data), staff_employer_document_views (the audit of which staff member opened which document; it was designed to outlive the
--   request and holds only random ids and the staff identity, nothing about the person), resume_storage_purge_queue audit rows (paths made of
--   random ids; the queue trims itself after 30 days), and account_deletion_log.
--
-- SAFETY NETS. (a) Only accounts whose deletion_scheduled_at is at least 30 days old. (b) account_deletion_exempt lists accounts the job must
-- never delete whatever their state (the owner's own account and the three demo accounts); an exempt account that is somehow due is logged and
-- skipped. (c) An account with a Stripe subscription id is refused unless the caller says billing is cleared (the Edge Function says so only
-- after Stripe confirmed). (d) Any error rolls the whole account back; the next hourly run tries again.

create table if not exists account_deletion_exempt (
  candidate_id uuid primary key,
  reason text not null,
  created_at timestamptz not null default now()
);
alter table account_deletion_exempt enable row level security;
revoke all on table account_deletion_exempt from anon, authenticated;
grant select on table account_deletion_exempt to service_role;

insert into account_deletion_exempt (candidate_id, reason) values
  ('5c2f5a2c-f506-4c52-a7c2-071a6e4f0975', 'owner''s own account (has a live Stripe test subscription used in testing)'),
  ('88d58ea4-1d6d-445c-8135-ead40f7f1667', 'demo account: Full Resume'),
  ('b674f10f-bab4-46a2-a79b-b7e4d9659e26', 'demo account: Hybrid'),
  ('e4d2b572-6b41-40b6-b770-992ee8d92391', 'demo account: License-only')
on conflict (candidate_id) do nothing;

create table if not exists account_deletion_log (
  candidate_id uuid primary key,              -- deliberately no foreign key: the row must outlive the candidate
  deactivated_at timestamptz,
  first_attempt_at timestamptz not null default now(),
  last_attempt_at timestamptz not null default now(),
  attempts integer not null default 1,
  outcome text not null,                      -- deleted | blocked_billing | error | exempt | not_due (came back / not yet due)
  detail jsonb,                               -- per-table counts, Stripe outcome; never personal data
  deleted_at timestamptz
);
alter table account_deletion_log enable row level security;
revoke all on table account_deletion_log from anon, authenticated;
grant select on table account_deletion_log to service_role;

create index if not exists candidates_deletion_scheduled_idx on candidates (deletion_scheduled_at) where deletion_scheduled_at is not null;

-- Accounts that are due, oldest first. The Edge Function reads this (it must deal with Stripe before the SQL deletion runs).
create or replace function due_account_deletions(p_limit integer default 10)
returns table(candidate_id uuid, deactivated_at timestamptz, stripe_subscription_id text, attempts integer)
language sql stable security definer set search_path = public as $$
  select c.id, c.deletion_scheduled_at, c.stripe_subscription_id, coalesce(l.attempts, 0)
    from candidates c left join account_deletion_log l on l.candidate_id = c.id
   where c.deletion_scheduled_at is not null and c.deletion_scheduled_at <= now() - interval '30 days'
   order by c.deletion_scheduled_at
   limit greatest(1, least(p_limit, 50))
$$;
revoke all on function due_account_deletions(integer) from public, anon, authenticated;
grant execute on function due_account_deletions(integer) to service_role;

-- The Edge Function records a NON-deleting outcome here (billing blocked, Stripe error). Attempts count up so a stuck account is visible.
create or replace function record_account_deletion_attempt(p_candidate uuid, p_outcome text, p_detail jsonb default null)
returns void language plpgsql security definer set search_path = public as $$
begin
  insert into account_deletion_log (candidate_id, deactivated_at, outcome, detail)
    select c.id, c.deletion_scheduled_at, p_outcome, p_detail from candidates c where c.id = p_candidate
  on conflict (candidate_id) do update
    set attempts = account_deletion_log.attempts + 1, last_attempt_at = now(), outcome = excluded.outcome, detail = excluded.detail
    where account_deletion_log.outcome <> 'deleted';
end $$;
revoke all on function record_account_deletion_attempt(uuid, text, jsonb) from public, anon, authenticated;
grant execute on function record_account_deletion_attempt(uuid, text, jsonb) to service_role;

create or replace function delete_candidate_account(p_candidate uuid, p_billing_cleared boolean default false, p_billing_detail jsonb default null)
returns jsonb
language plpgsql security definer set search_path = public, storage as $$
declare
  c candidates%rowtype;
  v_email text;
  v_digits text;
  v_evs uuid[];
  v_docs uuid[];
  v_reqs uuid[];
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

  if c.stripe_subscription_id is not null and not coalesce(p_billing_cleared, false) then
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

  if p_billing_detail is not null then counts := counts || jsonb_build_object('stripe', p_billing_detail); end if;
  insert into account_deletion_log (candidate_id, deactivated_at, outcome, detail, deleted_at)
    values (p_candidate, c.deletion_scheduled_at, 'deleted', counts, now())
  on conflict (candidate_id) do update
    set attempts = account_deletion_log.attempts + 1, last_attempt_at = now(), outcome = 'deleted', detail = excluded.detail,
        deleted_at = now(), deactivated_at = excluded.deactivated_at;
  return jsonb_build_object('outcome', 'deleted', 'counts', counts);
end $$;
revoke all on function delete_candidate_account(uuid, boolean, jsonb) from public, anon, authenticated;
grant execute on function delete_candidate_account(uuid, boolean, jsonb) to service_role;

-- Cron credentials, same scheme as purge-resume-storage: a random secret that lives only in internal_job_secrets.
insert into internal_job_secrets (name, value)
  values ('delete_expired_accounts', replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', ''))
  on conflict (name) do nothing;

select cron.schedule(
  'delete-expired-accounts',
  '12 * * * *',
  $$select net.http_post(
      url := 'https://ihmypoduvrzymasgactc.supabase.co/functions/v1/delete-expired-accounts',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'apikey', 'sb_publishable_o3S1LP0utVvxTXPRb2aZxg_Fz2FWwBj',
        'Authorization', 'Bearer sb_publishable_o3S1LP0utVvxTXPRb2aZxg_Fz2FWwBj',
        'x-deletion-secret', (select value from public.internal_job_secrets where name = 'delete_expired_accounts')
      ),
      body := '{}'::jsonb,
      timeout_milliseconds := 60000
    )$$
);
