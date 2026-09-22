-- Customization rebuild closeout, minor follow-up 2 of 2 (2026-09-22): delete_candidate_account already correctly removes
-- candidate_customization and candidate_item_overrides (both FK candidate_id on delete cascade -- confirmed by a real live
-- delete test against a real override during the Stage 3 pre-check), but its own audit counts never mentioned them, so a
-- future review of account_deletion_log.detail could not see they were ever there. Purely additive logging, changes
-- nothing about what is deleted or when -- but it has to count them FIRST, before anything else runs: a 'work' / 'education'
-- / 'certification' / 'skill' / 'freeform' override is often already gone well before the end of this function, cleaned up
-- by the per-item AFTER DELETE trigger the moment its own item row is deleted a few statements below (correct, and already
-- the case before this change); counting late would silently under-report exactly the rows this is meant to make visible.
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

  -- Customization (2026-09-22): counted here, read-only, BEFORE anything else runs. Their eventual removal is unchanged (still the
  -- candidate_id FK cascade on the final `delete from candidates`, or, for a 'work'/'education'/'certification'/'skill'/'freeform' override,
  -- often earlier still -- the per-item AFTER DELETE trigger fires the moment its own item row is deleted a few statements below). Counting
  -- late would silently undercount (that trigger already runs before the bottom of this function), so this has to happen first to be honest.
  select count(*) into n from candidate_item_overrides where candidate_id = p_candidate;
  counts := counts || jsonb_build_object('candidate_item_overrides', n);
  select count(*) into n from candidate_customization where candidate_id = p_candidate;
  counts := counts || jsonb_build_object('candidate_customization', n);

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
