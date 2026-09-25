-- Gap #18 follow-up fix (2026-09-25, found during live verification of 20260925000000): the "keep the
-- table sparse" cleanup at the end of apply_customization_ops() still encoded the PRE-gap-18 freeform
-- default ("needs_review defaults to excluded, everything else defaults to included"). assemble_customized_
-- resume's own default flipped to a uniform included=true for every freeform section_type in the prior
-- migration, but this cleanup line was never updated to match — so the moment a paid candidate unticked a
-- "Flagged content" (needs_review) item, the exclusion override (included=false) was written correctly by
-- the op loop above, then IMMEDIATELY deleted by this stale cleanup on the very same call, because it still
-- treated included=false as "the redundant default, safe to garbage-collect" for that section_type. The
-- save silently no-op'd: the endpoint returned ok:true, but the item stayed included. Confirmed live against
-- a real paid-tier throwaway account before this fix (save-customization returned included:true right back).
--
-- Fix: the cleanup now matches the single uniform default exactly the way assemble_customized_resume does
-- (coalesce(o.included, true) for every freeform row, regardless of section_type) -- delete a freeform
-- override only when it says included=true and carries no text override, full stop. No join to
-- candidate_freeform_sections needed anymore since section_type no longer changes what "default" means.
create or replace function public.apply_customization_ops(p_candidate uuid, p_base_version integer, p_ops jsonb)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  c candidates%rowtype;
  cust candidate_customization%rowtype;
  v_docs uuid[];
  op jsonb; i integer := 0; v_kind text; v_id uuid; v_tbl text; v_ok boolean; v_text text; v_included boolean; v_base text; v_pos integer;
  v_delivered integer; v_base_count integer; v_added integer;
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
          else
            if jsonb_typeof(op -> 'value') <> 'string' then raise exception 'bad_value' using hint = i::text; end if;
            v_text := op ->> 'value';
            v_base := case v_kind
              when 'work' then (select md5(coalesce(job_responsibilities, '')) from work_history_items where id = v_id)
              when 'skill' then (select md5(coalesce(skill_text, '')) from skill_items where id = v_id)
              else null end;
            insert into candidate_item_overrides (candidate_id, kind, item_id, text_override, base_text_hash) values (p_candidate, v_kind, v_id, v_text, v_base)
              on conflict (candidate_id, kind, item_id) do update set text_override = excluded.text_override, base_text_hash = excluded.base_text_hash, updated_at = now();
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

  -- keep the table sparse: an override that says nothing is deleted.
  -- Gap #18 fix (2026-09-25): every kind other than skill_added/freeform defaults to included=true, so an
  -- override saying included=true with no text is the redundant one there. freeform now ALSO defaults to
  -- included=true uniformly for every section_type (including needs_review, since the prior migration) --
  -- previously this second line only matched that for non-needs_review types and, for needs_review, deleted
  -- the OPPOSITE (an included=false override, i.e. the one real exclusion a candidate could make), silently
  -- reverting every attempt to exclude a Flagged-content item. No more per-section_type branching needed.
  delete from candidate_item_overrides o where o.candidate_id = p_candidate and o.kind not in ('skill_added') and o.included and o.text_override is null;

  -- the delivered skill count may not exceed max(15, extracted count)
  select count(*) into v_base_count from skill_items s where s.candidate_id = p_candidate and s.candidate_confirmed and s.resume_document_id = any (v_docs);
  select (select count(*) from skill_items s where s.candidate_id = p_candidate and s.candidate_confirmed and s.resume_document_id = any (v_docs)
                and not exists (select 1 from candidate_item_overrides o where o.candidate_id = p_candidate and o.kind = 'skill' and o.item_id = s.id and not o.included))
       + (select count(*) from candidate_item_overrides o where o.candidate_id = p_candidate and o.kind = 'skill_added' and o.included)
    into v_delivered;
  if v_delivered > greatest(15, v_base_count) then raise exception 'skill_cap'; end if;

  update candidate_customization set version = version + 1, updated_at = now() where candidate_id = p_candidate returning * into cust;
  return jsonb_build_object('version', cust.version);
end $function$;
