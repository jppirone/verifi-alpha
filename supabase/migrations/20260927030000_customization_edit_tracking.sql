-- Item F/G extension (2026-09-27): closes the blind spot found live-verifying the free-lookup unification
-- -- job_responsibilities rewrites and add_skill ops in save-customization/apply_customization_ops
-- currently bypass candidate_edited_fields, the acknowledgment requirement, and Item G's staff signal
-- entirely. See the spec discussion this migration implements for the full reasoning; summary:
--
--   * job_responsibilities: mirror confirm-resume-data's own candidate_edited_fields write onto
--     work_history_items, but MERGED not replaced (this save path runs on every keystroke-blur,
--     indefinitely, unlike confirm-resume-data's one-shot write -- an earlier resumeConfirm edit to a
--     different field on the same row must survive a later Customization edit to this one), and CLEARED
--     (the job_responsibilities key removed, not just left true) when the candidate reverts the override
--     back to null -- "edited" means currently diverged from the original extraction, not "was ever
--     touched", matching Item F's own intent.
--   * add_skill: no base work_history_items/skill_items row exists for a candidate-added skill at all (by
--     design -- see apply_customization_ops's own 'add_skill' branch), so there is nothing to attach
--     candidate_edited_fields to. Surfaced instead via a 6th union arm on list_unqueued_edited_items,
--     reading candidate_item_overrides directly -- these can never have a verification_items row (never
--     extracted, never opted into verification), so they were always a Part-2 "unqueued spot-check" item,
--     never a Part-1 main-queue one, regardless of how they're tracked.
--   * the acknowledgment itself is a new, candidate-scoped pair of columns (not resume_documents, which
--     Item F used) -- Customization isn't tied to any one document/submit event, so an ack recorded there
--     could go stale or vanish on resubmission. Enforced server-side in save-customization (edge function),
--     not here: this migration only adds the columns the edge function reads/writes.

alter table candidates add column if not exists customization_edit_ack_at timestamptz;
alter table candidates add column if not exists customization_edit_ack_text_version text;

-- ---- apply_customization_ops: adds v_work_touched tracking + the post-loop candidate_edited_fields
-- merge/clear pass. Everything else in this function is unchanged from 20260921090000_customization_stage1.sql.
create or replace function apply_customization_ops(p_candidate uuid, p_base_version integer, p_ops jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  c candidates%rowtype;
  cust candidate_customization%rowtype;
  v_docs uuid[];
  op jsonb; i integer := 0; v_kind text; v_id uuid; v_tbl text; v_ok boolean; v_text text; v_included boolean; v_base text; v_pos integer;
  v_delivered integer; v_base_count integer; v_added integer;
  v_work_touched uuid[] := '{}';
begin
  if p_ops is null or jsonb_typeof(p_ops) <> 'array' or jsonb_array_length(p_ops) = 0 or jsonb_array_length(p_ops) > 200 then
    raise exception 'bad_ops' using hint = '0';
  end if;
  select * into c from candidates where id = p_candidate for share;
  if not found then raise exception 'candidate_not_found'; end if;
  if c.deletion_scheduled_at is not null then raise exception 'account_deactivated'; end if;
  if c.account_type is distinct from 'full_resume' then raise exception 'not_full_resume'; end if;
  if c.tier is distinct from 'paid' then raise exception 'tier_required'; end if;

  insert into candidate_customization (candidate_id) values (p_candidate) on conflict (candidate_id) do nothing;
  select * into cust from candidate_customization where candidate_id = p_candidate for update;
  if p_base_version is null or p_base_version <> cust.version then
    raise exception 'version_conflict' using detail = cust.version::text;
  end if;
  select coalesce(array_agg(id), '{}') into v_docs from resume_documents where candidate_id = p_candidate and confirmed_at is not null;

  for op in select value from jsonb_array_elements(p_ops) loop
    i := i + 1;
    case op ->> 'op'
      when 'include', 'text' then
        v_kind := op ->> 'kind';
        begin v_id := (op ->> 'item_id')::uuid; exception when others then raise exception 'bad_item_id' using hint = i::text; end;
        if v_kind = 'skill_added' then
          v_ok := exists (select 1 from candidate_item_overrides where candidate_id = p_candidate and kind = 'skill_added' and item_id = v_id);
        else
          v_tbl := case v_kind when 'work' then 'work_history_items' when 'education' then 'education_items' when 'certification' then 'certification_items'
                               when 'skill' then 'skill_items' when 'freeform' then 'candidate_freeform_sections' end;
          if v_tbl is null then raise exception 'bad_kind' using hint = i::text; end if;
          execute format('select exists (select 1 from %I t where t.id = $1 and t.candidate_id = $2 and t.candidate_confirmed and t.resume_document_id = any ($3)%s)', v_tbl,
                         case when v_kind = 'freeform' then ' and t.section_type <> ''summary''' else '' end)
            into v_ok using v_id, p_candidate, v_docs;
        end if;
        if not v_ok then raise exception 'item_not_found' using hint = i::text; end if;

        if op ->> 'op' = 'include' then
          if jsonb_typeof(op -> 'included') <> 'boolean' then raise exception 'bad_value' using hint = i::text; end if;
          if v_kind = 'skill_added' then
            update candidate_item_overrides set included = (op ->> 'included')::boolean, updated_at = now() where candidate_id = p_candidate and kind = 'skill_added' and item_id = v_id;
          else
            insert into candidate_item_overrides (candidate_id, kind, item_id, included) values (p_candidate, v_kind, v_id, (op ->> 'included')::boolean)
              on conflict (candidate_id, kind, item_id) do update set included = excluded.included, updated_at = now();
          end if;
        else
          if v_kind not in ('work', 'skill', 'skill_added') then raise exception 'field_locked' using hint = i::text; end if;
          if op -> 'value' is null or jsonb_typeof(op -> 'value') = 'null' then
            if v_kind = 'skill_added' then raise exception 'bad_value' using hint = i::text; end if;
            update candidate_item_overrides set text_override = null, base_text_hash = null, updated_at = now()
             where candidate_id = p_candidate and kind = v_kind and item_id = v_id;
            if v_kind = 'work' then v_work_touched := array_append(v_work_touched, v_id); end if;
          else
            if jsonb_typeof(op -> 'value') <> 'string' then raise exception 'bad_value' using hint = i::text; end if;
            v_text := op ->> 'value';
            v_base := case v_kind
              when 'work' then (select md5(coalesce(job_responsibilities, '')) from work_history_items where id = v_id)
              when 'skill' then (select md5(coalesce(skill_text, '')) from skill_items where id = v_id)
              else null end;
            insert into candidate_item_overrides (candidate_id, kind, item_id, text_override, base_text_hash) values (p_candidate, v_kind, v_id, v_text, v_base)
              on conflict (candidate_id, kind, item_id) do update set text_override = excluded.text_override, base_text_hash = excluded.base_text_hash, updated_at = now();
            if v_kind = 'work' then v_work_touched := array_append(v_work_touched, v_id); end if;
          end if;
        end if;

      when 'add_skill' then
        if jsonb_typeof(op -> 'text') <> 'string' then raise exception 'bad_value' using hint = i::text; end if;
        select coalesce(max(position), -1) + 1, count(*) into v_pos, v_added from candidate_item_overrides where candidate_id = p_candidate and kind = 'skill_added';
        if v_added >= 30 then raise exception 'skill_cap' using hint = i::text; end if;
        insert into candidate_item_overrides (candidate_id, kind, item_id, included, text_override, position)
          values (p_candidate, 'skill_added', gen_random_uuid(), true, op ->> 'text', v_pos);

      when 'remove_added_skill' then
        begin v_id := (op ->> 'item_id')::uuid; exception when others then raise exception 'bad_item_id' using hint = i::text; end;
        delete from candidate_item_overrides where candidate_id = p_candidate and kind = 'skill_added' and item_id = v_id;
        if not found then raise exception 'item_not_found' using hint = i::text; end if;

      when 'summary' then
        if (op ->> 'mode') not in ('default', 'none', 'version') then raise exception 'bad_value' using hint = i::text; end if;
        if op ->> 'mode' = 'version' then
          begin v_id := (op ->> 'summary_id')::uuid; exception when others then raise exception 'bad_item_id' using hint = i::text; end;
          if not exists (select 1 from candidate_summary_versions where id = v_id and candidate_id = p_candidate) then raise exception 'item_not_found' using hint = i::text; end if;
          update candidate_customization set summary_mode = 'version', selected_summary_id = v_id where candidate_id = p_candidate;
        else
          update candidate_customization set summary_mode = op ->> 'mode', selected_summary_id = null where candidate_id = p_candidate;
        end if;

      when 'contact' then
        if op ? 'printed_phone' then
          update candidate_customization set printed_phone = nullif(btrim(op ->> 'printed_phone'), '') where candidate_id = p_candidate;
        end if;
        if op ? 'printed_email' then
          update candidate_customization set printed_email = nullif(btrim(op ->> 'printed_email'), '') where candidate_id = p_candidate;
        end if;

      when 'reset_items' then
        delete from candidate_item_overrides where candidate_id = p_candidate;

      else raise exception 'bad_op' using hint = i::text;
    end case;
  end loop;

  -- keep the table sparse: an override that says nothing (included, no text, not an added skill) is deleted
  -- (a flagged / needs_review section defaults to EXCLUDED, so for those an override saying "included" is the deviation and "excluded" is the default)
  delete from candidate_item_overrides o where o.candidate_id = p_candidate and o.kind not in ('skill_added', 'freeform') and o.included and o.text_override is null;
  delete from candidate_item_overrides o using candidate_freeform_sections f
   where o.candidate_id = p_candidate and o.kind = 'freeform' and f.id = o.item_id and o.text_override is null and o.included = (f.section_type <> 'needs_review');

  -- Item F/G extension: for every work_history item a 'text' op touched this call, resolve the FINAL
  -- override state (a 'text' op setting a value, then a sparse-cleanup delete, then another 'text' op
  -- clearing it, could all land in one 200-op batch -- checking final state, not per-op, is correct) and
  -- merge/clear the job_responsibilities key accordingly. Merge (||), not replace: an earlier resumeConfirm
  -- edit to a different field on this same row (candidate_edited_fields already holds e.g. {"start_date":true})
  -- must survive this. Normalized back to null when the merge leaves an empty object, so the `candidate_edited_fields
  -- is not null` check every other Item F/G query already relies on stays a correct "something is edited" test.
  if array_length(v_work_touched, 1) > 0 then
    update work_history_items w set
      candidate_edited_fields = case
        when exists (select 1 from candidate_item_overrides o where o.candidate_id = p_candidate and o.kind = 'work' and o.item_id = w.id and o.text_override is not null)
          then coalesce(w.candidate_edited_fields, '{}'::jsonb) || jsonb_build_object('job_responsibilities', true)
        else (coalesce(w.candidate_edited_fields, '{}'::jsonb) - 'job_responsibilities')
      end,
      updated_at = now()
     where w.candidate_id = p_candidate and w.id = any (v_work_touched);
    update work_history_items w set candidate_edited_fields = null
     where w.candidate_id = p_candidate and w.id = any (v_work_touched) and w.candidate_edited_fields = '{}'::jsonb;
  end if;

  -- the delivered skill count may not exceed max(15, extracted count)
  select count(*) into v_base_count from skill_items s where s.candidate_id = p_candidate and s.candidate_confirmed and s.resume_document_id = any (v_docs);
  select (select count(*) from skill_items s where s.candidate_id = p_candidate and s.candidate_confirmed and s.resume_document_id = any (v_docs)
                and not exists (select 1 from candidate_item_overrides o where o.candidate_id = p_candidate and o.kind = 'skill' and o.item_id = s.id and not o.included))
       + (select count(*) from candidate_item_overrides o where o.candidate_id = p_candidate and o.kind = 'skill_added' and o.included)
    into v_delivered;
  if v_delivered > greatest(15, v_base_count) then raise exception 'skill_cap'; end if;

  update candidate_customization set version = version + 1, updated_at = now() where candidate_id = p_candidate returning * into cust;
  return jsonb_build_object('version', cust.version);
end $$;
revoke execute on function apply_customization_ops(uuid, integer, jsonb) from public;
grant execute on function apply_customization_ops(uuid, integer, jsonb) to service_role;

-- ---- list_unqueued_edited_items: adds a 6th union arm for candidate-added skills (add_skill), which have
-- no base skill_items row to hold candidate_edited_fields at all -- read straight from
-- candidate_item_overrides instead. Everything else unchanged from 20260926050000_item_g_unqueued_edited_items.sql.
create or replace function list_unqueued_edited_items()
returns jsonb
language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(x order by x->>'candidate_name', x->>'category', x->>'claim'), '[]'::jsonb) from (
    select jsonb_build_object(
      'source_item_id', w.id, 'category', 'Job Experience',
      'claim', nullif(concat_ws(', ', nullif(w.title, ''), nullif(w.company, ''), nullif(w.location, '')), ''),
      'edited_fields', (select coalesce(jsonb_agg(k order by k), '[]'::jsonb) from jsonb_object_keys(w.candidate_edited_fields) k),
      'candidate_id', w.candidate_id,
      'candidate_name', nullif(coalesce(nullif(concat_ws(' ', c.first_name, c.last_name), ''), c.full_name), ''),
      'candidate_email', c.email
    ) as x
    from work_history_items w join candidates c on c.id = w.candidate_id
    where w.candidate_confirmed and w.candidate_edited_fields is not null
      and not exists (select 1 from verification_items v where v.source_item_id = w.id)
    union all
    select jsonb_build_object(
      'source_item_id', e.id, 'category', 'Education',
      'claim', nullif(concat_ws(', ', nullif(e.degree, ''), nullif(e.field_of_study, ''), nullif(e.institution, '')), ''),
      'edited_fields', (select coalesce(jsonb_agg(k order by k), '[]'::jsonb) from jsonb_object_keys(e.candidate_edited_fields) k),
      'candidate_id', e.candidate_id,
      'candidate_name', nullif(coalesce(nullif(concat_ws(' ', c.first_name, c.last_name), ''), c.full_name), ''),
      'candidate_email', c.email
    )
    from education_items e join candidates c on c.id = e.candidate_id
    where e.candidate_confirmed and e.candidate_edited_fields is not null
      and not exists (select 1 from verification_items v where v.source_item_id = e.id)
    union all
    select jsonb_build_object(
      'source_item_id', ce.id, 'category', 'Certification',
      'claim', nullif(concat_ws(', ', nullif(ce.name, ''), nullif(ce.issuing_body, '')), ''),
      'edited_fields', (select coalesce(jsonb_agg(k order by k), '[]'::jsonb) from jsonb_object_keys(ce.candidate_edited_fields) k),
      'candidate_id', ce.candidate_id,
      'candidate_name', nullif(coalesce(nullif(concat_ws(' ', c.first_name, c.last_name), ''), c.full_name), ''),
      'candidate_email', c.email
    )
    from certification_items ce join candidates c on c.id = ce.candidate_id
    where ce.candidate_confirmed and ce.candidate_edited_fields is not null
      and not exists (select 1 from verification_items v where v.source_item_id = ce.id)
    union all
    select jsonb_build_object(
      'source_item_id', s.id, 'category', 'Skill',
      'claim', nullif(s.skill_text, ''),
      'edited_fields', (select coalesce(jsonb_agg(k order by k), '[]'::jsonb) from jsonb_object_keys(s.candidate_edited_fields) k),
      'candidate_id', s.candidate_id,
      'candidate_name', nullif(coalesce(nullif(concat_ws(' ', c.first_name, c.last_name), ''), c.full_name), ''),
      'candidate_email', c.email
    )
    from skill_items s join candidates c on c.id = s.candidate_id
    where s.candidate_confirmed and s.candidate_edited_fields is not null
      and not exists (select 1 from verification_items v where v.source_item_id = s.id)
    union all
    select jsonb_build_object(
      'source_item_id', f.id, 'category', 'Freeform (' || f.section_type || ')',
      'claim', nullif(concat_ws(': ', nullif(f.heading, ''), left(coalesce(f.content, ''), 160)), ''),
      'edited_fields', (select coalesce(jsonb_agg(k order by k), '[]'::jsonb) from jsonb_object_keys(f.candidate_edited_fields) k),
      'candidate_id', f.candidate_id,
      'candidate_name', nullif(coalesce(nullif(concat_ws(' ', c.first_name, c.last_name), ''), c.full_name), ''),
      'candidate_email', c.email
    )
    from candidate_freeform_sections f join candidates c on c.id = f.candidate_id
    where f.candidate_confirmed and f.candidate_edited_fields is not null
      and not exists (select 1 from verification_items v where v.source_item_id = f.id)
    union all
    -- Item F/G extension (2026-09-27): candidate-added skills (Customization's add_skill op). No base
    -- skill_items row exists for these at all -- item_id is a fresh gen_random_uuid() minted only inside
    -- candidate_item_overrides (see apply_customization_ops's own 'add_skill' branch) -- so there is
    -- nothing for the anti-join above to even check: a skill_added row can never have a verification_items
    -- row (it never went through confirm-resume-data, never was extracted, never was opted into
    -- verification), so every one is unconditionally "unqueued" by construction.
    select jsonb_build_object(
      'source_item_id', o.item_id, 'category', 'Skill (added)',
      'claim', nullif(o.text_override, ''),
      'edited_fields', jsonb_build_array('skill_text'),
      'candidate_id', o.candidate_id,
      'candidate_name', nullif(coalesce(nullif(concat_ws(' ', c.first_name, c.last_name), ''), c.full_name), ''),
      'candidate_email', c.email
    )
    from candidate_item_overrides o join candidates c on c.id = o.candidate_id
    where o.kind = 'skill_added'
  ) t;
$$;

revoke execute on function list_unqueued_edited_items() from public;
grant execute on function list_unqueued_edited_items() to service_role;
