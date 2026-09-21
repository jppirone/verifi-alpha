-- Periodic re-check of already-Confirmed licenses on the resume-comparison side (2026-09-21).
--
-- THE GAP. A license that passed the automatic registry check stayed Confirmed forever. If it later lapsed, expired or was revoked, a resume
-- comparison would still list it as verified, indefinitely, because nothing ever looked at the registry again unless someone re-ran it by hand.
-- (The license-REPORT product already re-checks live at approval; the resume comparison is assembled from stored state, so it needs the stored
-- state to be true.)
--
-- WHAT THIS ADDS. A scheduled job (Edge Function recheck-licenses, hourly at :42) that asks the registry again about licenses that are
-- currently a registry pass, at a bounded rate, oldest first, and can only ever DOWNGRADE:
--   * ELIGIBLE = license_items.verification_outcome = 'verified' AND its License queue row is 'Confirmed' AND that status has not been changed
--     since the automatic pass (a staff hand-confirmation, or any staff status change after the pass, is a determination: skipped entirely, no
--     registry call), on a full-resume account that is not deactivated. Same definition of "registry pass" as the license-report product.
--   * DECISION reuses verify-license's adapter and decide() (action recheck_lookup, read-only, service-only). A result that is not a clean pass must
--     be seen TWICE in the same run (20 s apart) with the same reason before anything changes: one odd registry response never downgrades anyone.
--   * DOWNGRADE (apply_license_downgrade) is the only write, one transaction under row locks: License queue row Confirmed -> Needs Reconciliation
--     (NOT Discrepancy: that stays a human determination), license_items outcome/reason updated, a System timeline entry and an automated-check note
--     added. It refuses anything that is not exactly "verified + Confirmed + untouched since", refuses an outcome of 'verified' (it cannot upgrade),
--     and refuses if the license number, state, account name or verification changed since the lookup. A lapse is recorded with its own reason,
--     'lapsed_since_verified' (a license that WAS valid and now is not is a different finding from one that never was).
--   * NEVER UPGRADES. A license that is Needs Reconciliation / Discrepancy / held for a name change is not eligible, so the job cannot lift the
--     48-hour name-change hold or any staff determination; getting back to Confirmed takes the normal paths (a staff re-run, or the candidate
--     correcting and the standard check passing).
--   * NO NOTIFICATION to the candidate (no email). The finding is stored and shown on their own verification screen like any other license finding.
--
-- CADENCE. Each license is due 7 days after its last check (first check 7 days after it verified), sooner right after the registry's own expiration
-- date passes, later after failures (2 h doubling to 3 days). 25 licenses per hourly run, ~3 s apart (about 100 s), most overdue first: ~600 a day,
-- enough for ~4,000 licenses on a weekly cycle; past that the cycle simply stretches (the run log records how overdue the oldest is).

alter table license_items add column if not exists last_recheck_at timestamptz;
alter table license_items add column if not exists last_recheck_result text;
alter table license_items add column if not exists recheck_error_count integer not null default 0;
alter table license_items add column if not exists next_recheck_at timestamptz;
alter table license_items add column if not exists recheck_downgraded_at timestamptz;   -- set when a periodic re-check moved this license out of Confirmed

create table if not exists license_recheck_runs (
  id uuid primary key default gen_random_uuid(),
  started_at timestamptz not null default now(),
  finished_at timestamptz not null default now(),
  due_total integer not null default 0,        -- licenses due when the run started
  attempted integer not null default 0,
  still_verified integer not null default 0,
  downgraded integer not null default 0,
  errors integer not null default 0,
  skipped integer not null default 0,
  oldest_overdue_days numeric,                 -- how far behind the most overdue license was
  aborted text,                                -- e.g. registry_unreachable
  detail jsonb                                 -- per-license outcome codes (license item ids only, no personal data)
);
alter table license_recheck_runs enable row level security;
revoke all on table license_recheck_runs from anon, authenticated;
grant select on table license_recheck_runs to service_role;

-- The registry's own expiration date for a license (ISO), when a stored check captured one.
create or replace function license_registry_expiry(p_detail jsonb) returns date
language sql immutable as $$
  select case when p_detail #>> '{matched_record,expiration}' ~ '^\d{4}-\d{2}-\d{2}$' then (p_detail #>> '{matched_record,expiration}')::date end
$$;

-- When a license is next due, given its row. Weekly; the first check is 7 days after it verified; if the registry gave an expiration date that is
-- still ahead, no later than shortly after that date passes. A stored next_recheck_at from before the license's latest verification is ignored.
create or replace function license_recheck_due_at(li license_items) returns timestamptz
language sql immutable as $$
  select case
    when li.next_recheck_at is not null and li.next_recheck_at > li.verified_at then li.next_recheck_at
    else least(li.verified_at + interval '7 days',
               coalesce(license_registry_expiry(li.verification_detail)::timestamptz + interval '1 day 4 hours', li.verified_at + interval '7 days'))
  end
$$;

create or replace function due_license_rechecks(p_limit integer default 25)
returns table(license_item_id uuid, candidate_id uuid, total_due bigint, overdue_days numeric)
language sql stable security definer set search_path = public as $$
  with due as (
    select li.id, li.candidate_id, license_recheck_due_at(li) as due_at
      from license_items li
      join candidates c on c.id = li.candidate_id
      join verification_items vi on vi.id = li.queue_item_id and vi.type = 'License'
     where li.verification_outcome = 'verified' and li.candidate_confirmed is true and li.verified_at is not null
       and vi.status = 'Confirmed'
       and vi.status_changed_at <= li.verified_at + interval '2 minutes'      -- no staff status change since the automatic pass
       and c.account_type = 'full_resume' and c.deletion_scheduled_at is null
  )
  select d.id, d.candidate_id, count(*) over (), round((extract(epoch from (now() - d.due_at)) / 86400)::numeric, 2)
    from due d where d.due_at <= now()
   order by d.due_at
   limit greatest(1, least(p_limit, 100))
$$;
revoke all on function due_license_rechecks(integer) from public, anon, authenticated;
grant execute on function due_license_rechecks(integer) to service_role;

-- Bookkeeping only (no status change): the result of a re-check that did NOT downgrade.
create or replace function record_license_recheck(p_license uuid, p_result text) returns void
language plpgsql security definer set search_path = public as $$
declare li license_items%rowtype; v_next timestamptz; v_errors integer;
begin
  select * into li from license_items where id = p_license for update;
  if not found then return; end if;
  v_errors := case when p_result = 'error' then li.recheck_error_count + 1 when p_result = 'still_verified' then 0 else li.recheck_error_count end;
  v_next := case
    when p_result = 'still_verified' then least(now() + interval '7 days',
                                                coalesce(case when license_registry_expiry(li.verification_detail) >= current_date then license_registry_expiry(li.verification_detail)::timestamptz + interval '1 day 4 hours' end, now() + interval '7 days'))
    when p_result = 'error' then now() + least(power(2, v_errors) * interval '1 hour', interval '3 days')
    else now() + interval '1 day'                                  -- skipped / unstable / refused: look again tomorrow
  end;
  update license_items set last_recheck_at = now(), last_recheck_result = left(p_result, 40), recheck_error_count = v_errors, next_recheck_at = v_next
   where id = p_license;
end $$;
revoke all on function record_license_recheck(uuid, text) from public, anon, authenticated;
grant execute on function record_license_recheck(uuid, text) to service_role;

-- The ONLY status write of the whole job. Confirmed -> Needs Reconciliation, nothing else, and only if everything the lookup was based on is
-- still true under row locks.
--   p_expect   what the lookup used: {license_number, state, first_name, last_name, verified_at}
--   p_decision {outcome, reason, detail}  (detail = the same shape verify-license stores: searched, records, capped, matched_record, ...)
create or replace function apply_license_downgrade(p_license uuid, p_expect jsonb, p_decision jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  li license_items%rowtype; vi verification_items%rowtype; c candidates%rowtype; cert certification_items%rowtype;
  v_outcome text := p_decision ->> 'outcome';
  v_reason text := p_decision ->> 'reason';
  v_new_reason text;
  v_first text; v_last text; v_num text;
  v_matched jsonb := p_decision #> '{detail,matched_record}';
  v_now timestamptz := now();
  v_head text; v_hist text; v_internal text; v_detail jsonb;
begin
  -- it can only ever downgrade
  if v_outcome is null or v_outcome not in ('ambiguous', 'not_found') then return jsonb_build_object('result', 'refused', 'why', 'not_a_downgrade'); end if;
  if v_reason is null or v_reason not in ('exact_match_not_active', 'no_records', 'no_exact_name_match', 'multiple_exact_matches', 'result_cap_reached', 'exact_match_status_indeterminate') then
    return jsonb_build_object('result', 'refused', 'why', 'reason_not_allowed');   -- a failed lookup or a hold is never a finding
  end if;

  select * into li from license_items where id = p_license for update;
  if not found then return jsonb_build_object('result', 'not_applicable', 'why', 'license_not_found'); end if;
  select * into c from candidates where id = li.candidate_id for share;
  if not found or c.account_type <> 'full_resume' or c.deletion_scheduled_at is not null then return jsonb_build_object('result', 'not_applicable', 'why', 'account_not_eligible'); end if;
  select * into vi from verification_items where id = li.queue_item_id for update;
  if not found or vi.type <> 'License' or vi.status <> 'Confirmed' then return jsonb_build_object('result', 'not_applicable', 'why', 'not_confirmed'); end if;
  if li.verification_outcome <> 'verified' or li.verified_at is null then return jsonb_build_object('result', 'not_applicable', 'why', 'not_a_registry_pass'); end if;
  if vi.status_changed_at > li.verified_at + interval '2 minutes' then return jsonb_build_object('result', 'not_applicable', 'why', 'staff_touched'); end if;

  -- everything the lookup used is still what is on file
  if li.verified_at is distinct from (p_expect ->> 'verified_at')::timestamptz then return jsonb_build_object('result', 'not_applicable', 'why', 'reverified_since_lookup'); end if;
  select * into cert from certification_items where id = li.linked_certification_id and candidate_id = li.candidate_id;
  if not found then return jsonb_build_object('result', 'not_applicable', 'why', 'certification_not_found'); end if;
  v_num := upper(regexp_replace(btrim(coalesce(cert.license_number, '')), '[\s\-‐-―]', '', 'g'));
  v_first := btrim(coalesce(c.first_name, '')); v_last := btrim(coalesce(c.last_name, ''));
  if v_last = '' and coalesce(btrim(c.full_name), '') <> '' then
    v_first := split_part(btrim(c.full_name), ' ', 1); v_last := btrim(substr(btrim(c.full_name), length(split_part(btrim(c.full_name), ' ', 1)) + 1));
  end if;
  if v_num is distinct from (p_expect ->> 'license_number') or li.state is distinct from (p_expect ->> 'state')
     or v_first is distinct from (p_expect ->> 'first_name') or v_last is distinct from (p_expect ->> 'last_name') then
    return jsonb_build_object('result', 'not_applicable', 'why', 'inputs_changed_since_lookup');
  end if;

  v_new_reason := case when v_reason = 'exact_match_not_active' then 'lapsed_since_verified' else v_reason end;
  v_head := case when v_new_reason = 'lapsed_since_verified'
                 then 'This license was verified earlier. The registry now lists it under this name as not currently active' || coalesce(' (status "' || (v_matched ->> 'statusText') || '"', '') || case when v_matched ->> 'statusText' is not null then ')' else '' end || '.'
                 else 'This license was verified earlier. A fresh registry check no longer supports that (' || v_reason || ').' end;
  v_hist := 'Automated check result (not a determination) — periodic re-check of an already-confirmed license, ' || v_now::text || E':\n' || v_head
            || E'\nThe same result was seen on two lookups in the same run. Status returned to Needs Reconciliation for staff review; nothing was sent to the candidate.';
  v_internal := 'Periodic re-check (' || v_now::date::text || '): ' || v_head || ' Returned to Needs Reconciliation automatically. Not a determination: a staff re-run of the check decides Discrepancy.';
  v_detail := coalesce(p_decision -> 'detail', '{}'::jsonb) || jsonb_build_object('previously_verified_at', li.verified_at, 'recheck', jsonb_build_object('at', v_now, 'reason', v_reason));

  update verification_items
     set status = 'Needs Reconciliation',
         automated_check = v_hist || case when coalesce(vi.automated_check, '') <> '' then E'\n\n---\n\n' || vi.automated_check else '' end,
         internal_note = concat_ws(E'\n', nullif(vi.internal_note, ''), v_internal)
   where id = vi.id;
  insert into verification_item_timeline (item_id, event_date, actor, action, note)
    values (vi.id, v_now, 'System', 'Periodic re-check: ' || case when v_new_reason = 'lapsed_since_verified' then 'a license verified earlier is no longer active in the registry; returned to Needs Reconciliation.' else 'the registry no longer supports the earlier verification; returned to Needs Reconciliation.' end, v_hist);
  update license_items
     set verification_outcome = v_outcome, verification_reason = v_new_reason, verification_detail = v_detail, verified_at = null,
         recheck_downgraded_at = v_now, last_recheck_at = v_now, last_recheck_result = 'downgraded', next_recheck_at = null, recheck_error_count = 0, updated_at = v_now
   where id = li.id;
  return jsonb_build_object('result', 'downgraded', 'queue_item_id', vi.id, 'reason', v_new_reason);
end $$;
revoke all on function apply_license_downgrade(uuid, jsonb, jsonb) from public, anon, authenticated;
grant execute on function apply_license_downgrade(uuid, jsonb, jsonb) to service_role;

create or replace function finish_license_recheck_run(p_summary jsonb) returns void
language plpgsql security definer set search_path = public as $$
begin
  insert into license_recheck_runs (started_at, due_total, attempted, still_verified, downgraded, errors, skipped, oldest_overdue_days, aborted, detail)
    values (coalesce((p_summary ->> 'started_at')::timestamptz, now()), coalesce((p_summary ->> 'due_total')::int, 0), coalesce((p_summary ->> 'attempted')::int, 0),
            coalesce((p_summary ->> 'still_verified')::int, 0), coalesce((p_summary ->> 'downgraded')::int, 0), coalesce((p_summary ->> 'errors')::int, 0),
            coalesce((p_summary ->> 'skipped')::int, 0), (p_summary ->> 'oldest_overdue_days')::numeric, p_summary ->> 'aborted', p_summary -> 'detail');
  delete from license_recheck_runs where started_at < now() - interval '90 days';
end $$;
revoke all on function finish_license_recheck_run(jsonb) from public, anon, authenticated;
grant execute on function finish_license_recheck_run(jsonb) to service_role;

insert into internal_job_secrets (name, value)
  values ('recheck_licenses', replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', ''))
  on conflict (name) do nothing;

select cron.schedule(
  'recheck-confirmed-licenses',
  '42 * * * *',
  $$select net.http_post(
      url := 'https://ihmypoduvrzymasgactc.supabase.co/functions/v1/recheck-licenses',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'apikey', 'sb_publishable_o3S1LP0utVvxTXPRb2aZxg_Fz2FWwBj',
        'Authorization', 'Bearer sb_publishable_o3S1LP0utVvxTXPRb2aZxg_Fz2FWwBj',
        'x-recheck-secret', (select value from public.internal_job_secrets where name = 'recheck_licenses')
      ),
      body := '{}'::jsonb,
      timeout_milliseconds := 120000
    )$$
);
