-- Item G, Part 2 (2026-09-26): a candidate can edit a field on resumeConfirm without ever opting that
-- category into verification (Item F now records exactly which field on candidate_edited_fields), and
-- confirm-resume-data only ever creates a verification_items row for a category the candidate opted
-- into (or, for a handful of freeform types, unconditionally -- see that function's own header). So an
-- edited-but-never-opted-in item has no verification_items row at all, ever -- nothing for Part 1's
-- badge/filter to attach to, and no way for staff to see it on the normal queue no matter how that
-- queue is filtered. This function is the deliberately separate, on-demand surface for exactly that
-- case: every confirmed item, across all five item tables, that was edited and was never queued.
--
-- One UNION ALL across the five tables Item F added candidate_edited_fields to, each with a
-- `not exists (select 1 from verification_items v where v.source_item_id = <row>.id)` anti-join --
-- correct and index-friendly (source_item_id already has real query patterns against it elsewhere in
-- this codebase), and far simpler than trying to express a five-way anti-join through PostgREST query
-- params from the edge function. No candidate_id parameter: the caller (list-unqueued-edited-items,
-- admin/service only) fetches everything and lets staff.html's own name/id filters narrow it the same
-- way the main queue already does -- this is a spot-check surface, not a per-candidate lookup.
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
  ) t;
$$;

revoke all on function list_unqueued_edited_items() from public, anon, authenticated;
grant execute on function list_unqueued_edited_items() to service_role;
