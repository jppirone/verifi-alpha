-- Resume resubmission, STAGE 2 (2026-09-21): the single-transaction APPLY.
--
-- apply_resume_resubmission(attempt, ops) executes an instruction set that the resume-resubmission function computed from a FRESH plan (the
-- plan the candidate reviewed is re-derived at apply time and must hash the same). It runs entirely inside one transaction: any exception rolls
-- back every write, so a candidate's profile is either fully updated or exactly as it was.
--
-- Nothing here decides anything: matching, "kept / changed / removed / added", claim text and opt-in handling are computed in TypeScript and
-- arrive as explicit instructions. What this function adds is the guarantee that NOTHING UNREVIEWED APPLIES: under row locks it re-checks that
-- the active profile, the verification queue and the staged upload are exactly what the plan was computed against, and raises 'plan_changed'
-- otherwise (staff resolving an item mid-review, a second tab, anything).
--
-- Order of work (each step only touches rows named in the instructions):
--   1 lock + guards   2 archive then delete REMOVED items (queue rows, timeline, license extension, item)   3 CHANGED: archive the pre-image, apply
--   the changed facts, reset the queue row to New with a rebuilt claim and a before/after timeline entry (or delete / insert it per the opt-in),
--   reset or attach the license extension   4 KEPT: descriptive fields and position only; queue rows are NOT touched   5 ADDED: confirm the staged
--   rows and create their queue rows   6 delete the staged duplicates of kept/changed items   7 re-home every active row to the new document
--   8 lineage, the document, the attempt.

-- Archive one item with everything attached to it, as JSON (Stage 1's profile_item_archive).
create or replace function _resub_archive(
  p_cand uuid, p_resub uuid, p_kind text, p_tbl text, p_id uuid, p_reason text, p_vq text[], p_license uuid, p_doc uuid
) returns void language plpgsql security definer set search_path = public as $$
declare item jsonb; vq jsonb; tl jsonb; lic jsonb;
begin
  execute format('select to_jsonb(t) from %I t where t.id = $1', p_tbl) into item using p_id;
  if item is null then raise exception 'archive_source_missing: % %', p_tbl, p_id; end if;
  select coalesce(jsonb_agg(to_jsonb(v) order by v.id), '[]'::jsonb) into vq from verification_items v where v.id = any(coalesce(p_vq, '{}'));
  select coalesce(jsonb_agg(to_jsonb(e) order by e.event_date), '[]'::jsonb) into tl from verification_item_timeline e where e.item_id = any(coalesce(p_vq, '{}'));
  select to_jsonb(l) into lic from license_items l where l.id = p_license;
  insert into profile_item_archive (candidate_id, resubmission_id, item_kind, item_id, from_document_id, reason, item_data, verification, timeline, license)
  values (p_cand, p_resub, p_kind, p_id, p_doc, p_reason, item, vq, tl, lic);
end $$;

create or replace function apply_resume_resubmission(p_resubmission_id uuid, p_ops jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  o jsonb := p_ops;
  cand uuid := (o->>'candidate_id')::uuid;
  newd uuid := (o->>'new_document_id')::uuid;
  oldd uuid := nullif(o->>'base_document_id', '')::uuid;
  rs resume_resubmissions%rowtype;
  d resume_documents%rowtype;
  x jsonb; q jsonb; k text; tbl text; n int; vqs text[]; lid uuid; nid text; kind text;
  tables constant text[] := array['work_history_items', 'education_items', 'certification_items', 'skill_items', 'candidate_freeform_sections'];
  tmap constant jsonb := '{"work":"work_history_items","education":"education_items","certification":"certification_items","skill":"skill_items","freeform":"candidate_freeform_sections"}';
  allowed constant jsonb := '{
    "work_history_items": ["company","title","location","start_date","start_date_precision","end_date","end_date_precision","job_responsibilities","extraction_confidence","position","heading","employer_name_override","employer_location_override","contact_phone","contact_name"],
    "education_items": ["institution","degree","field_of_study","location","start_date","start_date_precision","end_date","end_date_precision","extraction_confidence","position","heading"],
    "certification_items": ["name","issuing_body","license_number","issue_date","issue_date_precision","expiration_date","expiration_date_precision","extraction_confidence","position","heading","trade_soc_code"],
    "skill_items": ["position","section_position"],
    "candidate_freeform_sections": ["position","heading"]}';
  new_queue jsonb := '[]'::jsonb;
  archived int := 0;
  today date := current_date;
begin
  -- 1. lock and guard -------------------------------------------------------------------------------------------------------------------
  perform 1 from candidates where id = cand for update;
  select * into rs from resume_resubmissions where id = p_resubmission_id and candidate_id = cand for update;
  if not found or rs.status <> 'ready' then raise exception 'attempt_not_ready'; end if;
  select * into d from resume_documents where id = newd and candidate_id = cand for update;
  if not found or d.kind <> 'resubmission' or d.confirmed_at is not null or d.id is distinct from rs.resume_document_id then raise exception 'document_not_applicable'; end if;

  for x in select * from jsonb_array_elements(o->'guard'->'items') loop
    tbl := x->>'t';
    execute format('select count(*) from (select 1 from %I where id = $1 and candidate_id = $2 and candidate_confirmed and updated_at is not distinct from $3::timestamptz for update) s', tbl)
      into n using (x->>'id')::uuid, cand, nullif(x->>'ts', '');
    if n <> 1 then raise exception 'plan_changed'; end if;
  end loop;
  foreach tbl in array tables || array['license_items'] loop
    execute format('select count(*) from %I where candidate_id = $1 and candidate_confirmed and resume_document_id in (select id from resume_documents where candidate_id = $1 and confirmed_at is not null)', tbl) into n using cand;
    if n <> coalesce((o->'guard'->'counts'->>tbl)::int, 0) then raise exception 'plan_changed'; end if;
  end loop;
  perform 1 from verification_items where candidate_id = cand for update;
  for x in select * from jsonb_array_elements(o->'guard'->'queue') loop
    select count(*) into n from verification_items where id = x->>'id' and candidate_id = cand and status = x->>'status' and status_changed_at is not distinct from nullif(x->>'ts', '')::timestamptz;
    if n <> 1 then raise exception 'plan_changed'; end if;
  end loop;
  select count(*) into n from verification_items where candidate_id = cand;
  if n <> (o->'guard'->>'queue_count')::int then raise exception 'plan_changed'; end if;
  -- the staged upload is exactly what was planned (nothing added to or removed from it since)
  foreach tbl in array tables loop
    execute format('select count(*) from %I where resume_document_id = $1', tbl) into n using newd;
    if n <> jsonb_array_length(coalesce(o->'staged'->tbl, '[]'::jsonb)) then raise exception 'plan_changed'; end if;
    execute format('select count(*) from %I where resume_document_id = $1 and not candidate_confirmed and id in (select (jsonb_array_elements_text($2))::uuid)', tbl) into n using newd, coalesce(o->'staged'->tbl, '[]'::jsonb);
    if n <> jsonb_array_length(coalesce(o->'staged'->tbl, '[]'::jsonb)) then raise exception 'plan_changed'; end if;
  end loop;

  -- 2. REMOVED: archive, then delete (timeline -> queue rows -> license extension -> item) ---------------------------------------------------
  for x in select * from jsonb_array_elements(coalesce(o->'removed', '[]'::jsonb)) loop
    kind := x->>'kind'; tbl := tmap->>kind;
    vqs := array(select jsonb_array_elements_text(coalesce(x->'vq', '[]'::jsonb)));
    lid := nullif(x->>'license_id', '')::uuid;
    perform _resub_archive(cand, p_resubmission_id, kind, tbl, (x->>'id')::uuid, 'removed', vqs, lid, oldd);
    archived := archived + 1;   -- the license extension travels inside the certification's archive record
    delete from verification_item_timeline where item_id = any(vqs);
    delete from verification_items where id = any(vqs) and candidate_id = cand;
    if lid is not null then delete from license_items where id = lid and candidate_id = cand; end if;
    execute format('delete from %I where id = $1 and candidate_id = $2', tbl) using (x->>'id')::uuid, cand;
  end loop;

  -- 3. CHANGED ---------------------------------------------------------------------------------------------------------------------------
  for x in select * from jsonb_array_elements(coalesce(o->'changed', '[]'::jsonb)) loop
    kind := x->>'kind'; tbl := tmap->>kind;
    vqs := array(select jsonb_array_elements_text(coalesce(x->'vq_all', '[]'::jsonb)));
    lid := nullif(x->'license'->>'id', '')::uuid;
    perform _resub_archive(cand, p_resubmission_id, kind, tbl, (x->>'id')::uuid, 'facts_changed', vqs, lid, oldd);
    archived := archived + 1;
    for k in select jsonb_object_keys(coalesce(x->'fields', '{}'::jsonb)) loop
      if not (allowed->tbl) ? k then raise exception 'field_not_allowed: %.%', tbl, k; end if;
      execute format('update %1$I set %2$I = (jsonb_populate_record(null::%1$I, $1)).%2$I, updated_at = now() where id = $2 and candidate_id = $3', tbl, k)
        using x->'fields', (x->>'id')::uuid, cand;
    end loop;
    execute format('update %I set updated_at = now() where id = $1 and candidate_id = $2', tbl) using (x->>'id')::uuid, cand;

    -- the queue row: reset in place (status New, claim rebuilt, correction cleared, before/after on the timeline), or, when the candidate did not
    -- opt this category into verification, removed (the archive above holds it); or created when there was none and they did opt in
    q := x->'queue';
    if q->>'mode' = 'reset' then
      update verification_items set claim = q->>'claim', status = coalesce(nullif(q->>'status', ''), 'New'), correction_requested = false, correction_note = null,
        correction_field = null, correction_value = null, bundle_id = newd where id = q->>'id' and candidate_id = cand;
      insert into verification_item_timeline (item_id, event_date, actor, action, note)
        values (q->>'id', now(), 'Candidate', 'Candidate resubmitted their resume; a verified fact changed, so this item was reset to ' || coalesce(nullif(q->>'status', ''), 'New') || '.', q->>'note');
    elsif q->>'mode' = 'delete' then
      delete from verification_item_timeline where item_id = any(array(select jsonb_array_elements_text(q->'ids')));
      delete from verification_items where id = any(array(select jsonb_array_elements_text(q->'ids'))) and candidate_id = cand;
    elsif q->>'mode' = 'insert' then
      nid := nextval_verification_item_id();
      insert into verification_items (id, candidate_id, type, claim, received, status, internal_note, source_item_id, bundle_id)
        values (nid, cand, q->'row'->>'type', q->'row'->>'claim', today, q->'row'->>'status', q->'row'->>'internal_note', (x->>'id')::uuid, newd);
      new_queue := new_queue || jsonb_build_object('id', nid, 'type', q->'row'->>'type', 'source_item_id', x->>'id');
    end if;

    -- the license extension: RESET (its result is stale, so the registry is asked again after commit) or ATTACH the newly detected one
    if x->'license'->>'action' = 'reset' then
      update license_items set
        state = coalesce(nullif(x->'license'->>'state', ''), state),
        state_source = coalesce(nullif(x->'license'->>'state_source', ''), state_source),
        state_evidence = case when nullif(x->'license'->>'state', '') is not null then x->'license'->>'state_evidence' else state_evidence end,
        verification_outcome = null, verification_reason = null, verification_detail = null, verification_attempted_at = null, verified_at = null,
        verification_source = null, verification_attempts = 0, checked_state = null, checked_number = null, correction_status = null,
        correction_reason = null, correction_message = null, correction_requested_at = null, correction_notified_at = null, status_check_at = null,
        status_check = null, updated_at = now()
        where id = lid and candidate_id = cand;
      if x->'license'->>'queue_id' is not null then
        update verification_items set claim = x->'license'->>'claim', status = 'New', correction_requested = false, correction_note = null, correction_field = null,
          correction_value = null, bundle_id = newd where id = x->'license'->>'queue_id' and candidate_id = cand;
        insert into verification_item_timeline (item_id, event_date, actor, action, note)
          values (x->'license'->>'queue_id', now(), 'Candidate', 'Candidate resubmitted their resume; the license details changed, so the registry check was reset and will run again.', x->'license'->>'note');
      end if;
    elsif x->'license'->>'action' = 'attach' then
      update license_items set linked_certification_id = (x->>'id')::uuid, candidate_confirmed = true, updated_at = now()
        where id = (x->'license'->>'staged_id')::uuid and candidate_id = cand;
    end if;
  end loop;

  -- 4. KEPT: descriptive fields and position only. Queue rows are not touched. ------------------------------------------------------------
  for x in select * from jsonb_array_elements(coalesce(o->'kept', '[]'::jsonb)) loop
    kind := x->>'kind'; tbl := tmap->>kind;
    for k in select jsonb_object_keys(coalesce(x->'fields', '{}'::jsonb)) loop
      if not (allowed->tbl) ? k then raise exception 'field_not_allowed: %.%', tbl, k; end if;
      execute format('update %1$I set %2$I = (jsonb_populate_record(null::%1$I, $1)).%2$I where id = $2 and candidate_id = $3', tbl, k)
        using x->'fields', (x->>'id')::uuid, cand;
    end loop;
  end loop;

  -- 5. ADDED: confirm the staged rows, create their queue rows --------------------------------------------------------------------------
  for x in select * from jsonb_array_elements(coalesce(o->'added', '[]'::jsonb)) loop
    kind := x->>'kind'; tbl := tmap->>kind;
    execute format('update %I set candidate_confirmed = true, updated_at = now() where id = $1 and candidate_id = $2 and resume_document_id = $3 and not candidate_confirmed', tbl)
      using (x->>'staged_id')::uuid, cand, newd;
    get diagnostics n = row_count;
    if n <> 1 then raise exception 'staged_row_missing: %', x->>'staged_id'; end if;
    if kind = 'certification' and nullif(x->>'trade_soc_code', '') is not null then
      update certification_items set trade_soc_code = x->>'trade_soc_code' where id = (x->>'staged_id')::uuid and candidate_id = cand;
    end if;
    if x->>'license_staged_id' is not null then
      update license_items set candidate_confirmed = true, updated_at = now() where id = (x->>'license_staged_id')::uuid and candidate_id = cand and resume_document_id = newd;
    end if;
    q := x->'queue';
    if q is not null and jsonb_typeof(q) = 'object' then
      nid := nextval_verification_item_id();
      insert into verification_items (id, candidate_id, type, claim, received, status, internal_note, source_item_id, bundle_id)
        values (nid, cand, q->>'type', q->>'claim', today, q->>'status', q->>'internal_note', case when kind = 'freeform' then null else (x->>'staged_id')::uuid end, newd);
      new_queue := new_queue || jsonb_build_object('id', nid, 'type', q->>'type', 'source_item_id', x->>'staged_id');
    end if;
  end loop;

  -- 6. delete the staged duplicates of kept / changed items (their license extensions first) ------------------------------------------------
  delete from license_items where candidate_id = cand and resume_document_id = newd and not candidate_confirmed
    and linked_certification_id = any(array(select (jsonb_array_elements_text(coalesce(o->'staged_delete'->'certification', '[]'::jsonb)))::uuid));
  foreach tbl in array tables loop
    kind := (select key from jsonb_each_text(tmap) where value = tbl);
    execute format('delete from %I where candidate_id = $1 and resume_document_id = $2 and not candidate_confirmed and id in (select (jsonb_array_elements_text($3))::uuid)', tbl)
      using cand, newd, coalesce(o->'staged_delete'->kind, '[]'::jsonb);
  end loop;
  -- nothing may remain staged
  foreach tbl in array tables || array['license_items'] loop
    execute format('select count(*) from %I where candidate_id = $1 and resume_document_id = $2 and not candidate_confirmed', tbl) into n using cand, newd;
    if n <> 0 then raise exception 'staged_rows_left: % %', tbl, n; end if;
  end loop;

  -- 7. re-home: the new document owns the complete current record --------------------------------------------------------------------------
  foreach tbl in array tables || array['license_items'] loop
    execute format('update %I set resume_document_id = $2 where candidate_id = $1 and candidate_confirmed and resume_document_id is distinct from $2', tbl) using cand, newd;
  end loop;

  -- 8. lineage, the document, the attempt ---------------------------------------------------------------------------------------------------
  insert into profile_item_lineage (candidate_id, item_kind, item_id, resume_document_id, resubmission_id, relation)
    select cand, e->>'kind', (e->>'id')::uuid, newd, p_resubmission_id, e->>'relation' from jsonb_array_elements(coalesce(o->'lineage', '[]'::jsonb)) e;
  update resume_documents set confirmed_at = now(),
    employer_contact_resolved_at = case when (o->>'contact_reset')::boolean then null else (select employer_contact_resolved_at from resume_documents where id = oldd) end
    where id = newd;
  update resume_resubmissions set status = 'applied', applied_at = now(), closed_at = now(), updated_at = now(), opt_in = o->'opt_in', counts = o->'counts' where id = p_resubmission_id;

  return jsonb_build_object('new_queue', new_queue, 'archived', archived);
end $$;

revoke all on function apply_resume_resubmission(uuid, jsonb), _resub_archive(uuid, uuid, text, text, uuid, text, text[], uuid, uuid) from public, anon, authenticated;
grant execute on function apply_resume_resubmission(uuid, jsonb), _resub_archive(uuid, uuid, text, text, uuid, text, text[], uuid, uuid) to service_role;
