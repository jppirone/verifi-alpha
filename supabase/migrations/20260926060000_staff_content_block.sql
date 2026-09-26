-- Staff content-block (2026-09-26): staff authority to block content anywhere in the system, with a
-- short instructional reason back to the candidate. Universal (any field, any category -- work
-- history, education, certifications, skills, freeform), and a full block: once applied, the item
-- must not appear in the delivered PDF, Customization, Content Manager, any employer comparison
-- output, or count as a normal verification item, until resolved. The candidate still sees, in their
-- own account, that the specific item is held pending correction.
--
-- Lives alongside Item F's candidate_edited_fields, on the same five tables -- not on verification_items,
-- since scope is universal and a blockable item may never have a queue row at all (never opted into
-- verification). staff_block_note is internal-only (same trust tier as verification_items.internal_note
-- -- never shown to the candidate, under any status); staff_block_reason_code selects the ONE candidate-
-- facing sentence candidate.html renders (a closed set, not free text, precisely so staff can never
-- accidentally write something explanatory or accusatory into a candidate-facing surface).
alter table work_history_items add column if not exists staff_blocked_at timestamptz;
alter table work_history_items add column if not exists staff_blocked_by uuid references staff_users(id);
alter table work_history_items add column if not exists staff_block_note text;
alter table work_history_items add column if not exists staff_block_reason_code text;

alter table education_items add column if not exists staff_blocked_at timestamptz;
alter table education_items add column if not exists staff_blocked_by uuid references staff_users(id);
alter table education_items add column if not exists staff_block_note text;
alter table education_items add column if not exists staff_block_reason_code text;

alter table certification_items add column if not exists staff_blocked_at timestamptz;
alter table certification_items add column if not exists staff_blocked_by uuid references staff_users(id);
alter table certification_items add column if not exists staff_block_note text;
alter table certification_items add column if not exists staff_block_reason_code text;

alter table skill_items add column if not exists staff_blocked_at timestamptz;
alter table skill_items add column if not exists staff_blocked_by uuid references staff_users(id);
alter table skill_items add column if not exists staff_block_note text;
alter table skill_items add column if not exists staff_block_reason_code text;

alter table candidate_freeform_sections add column if not exists staff_blocked_at timestamptz;
alter table candidate_freeform_sections add column if not exists staff_blocked_by uuid references staff_users(id);
alter table candidate_freeform_sections add column if not exists staff_block_note text;
alter table candidate_freeform_sections add column if not exists staff_block_reason_code text;

-- History: a lightweight, polymorphic (item_kind + item_id, same convention as profile_item_archive)
-- audit trail so a block/clear is never silently lost when the four columns above get overwritten or
-- nulled out -- staff can see when an item was blocked, by whom, why (both the internal note and the
-- candidate-facing reason code at that time), and how/when it was cleared (staff action, or
-- automatically by a resubmission that actually changed or removed the item).
create table if not exists staff_block_events (
  id uuid primary key default gen_random_uuid(),
  candidate_id uuid not null references candidates(id),
  item_kind text not null,
  item_id uuid not null,
  event_date timestamptz not null default now(),
  actor text not null,
  action text not null,
  reason_code text,
  note text
);
create index if not exists staff_block_events_candidate_idx on staff_block_events (candidate_id);
create index if not exists staff_block_events_item_idx on staff_block_events (item_kind, item_id);

revoke all on staff_block_events from public, anon, authenticated;
grant select, insert on staff_block_events to service_role;

-- assemble_customized_resume: excludes a blocked item from every category's own query -- this single
-- function already feeds PDF delivery, Customization, and Content Manager (via get-customization), plus
-- the employer-comparison feature's own plain-document PDF (assemble_plain_document, overrides forced
-- off) -- one change here covers all four. The only line changed per category is the WHERE clause; the
-- rest of the function is unchanged from the Gap #18 migration.
create or replace function assemble_customized_resume(p_candidate uuid, p_ignore_overrides boolean default false, p_delivered_only boolean default false)
returns jsonb
language plpgsql
stable security definer
set search_path to 'public'
as $function$
declare
  c candidates%rowtype;
  cust candidate_customization%rowtype;
  v_docs uuid[];
  v_apply boolean;
  v_dormant integer := 0;
  j_work jsonb; j_edu jsonb; j_cert jsonb; j_skills jsonb; j_free jsonb;
  v_summary text; v_summary_source text := 'none'; v_summary_heading text; v_summary_id uuid;
  v_generic candidate_summary_versions%rowtype;
  v_ff_summary candidate_freeform_sections%rowtype;
  v_printed_header text;
  v_vphone text; v_pphone text; v_pemail text;
  v_phone jsonb; v_email jsonb;
  v_base_skills integer;
begin
  select * into c from candidates where id = p_candidate;
  if not found then return jsonb_build_object('available', false, 'reason', 'candidate_not_found'); end if;
  if c.deletion_scheduled_at is not null then return jsonb_build_object('available', false, 'reason', 'account_deactivated'); end if;
  if c.account_type is distinct from 'full_resume' then return jsonb_build_object('available', false, 'reason', 'not_full_resume'); end if;

  select coalesce(array_agg(id), '{}') into v_docs from resume_documents where candidate_id = p_candidate and confirmed_at is not null;
  select * into cust from candidate_customization where candidate_id = p_candidate;
  v_apply := (c.tier = 'paid') and not p_ignore_overrides;
  if c.tier <> 'paid' then
    select count(*) into v_dormant from candidate_item_overrides where candidate_id = p_candidate;
    if cust.candidate_id is not null and (cust.summary_mode <> 'default' or cust.printed_phone is not null or cust.printed_email is not null) then v_dormant := v_dormant + 1; end if;
  end if;

  -- ---- work
  select coalesce(jsonb_agg(x.o order by x.pos nulls last, x.id), '[]'::jsonb) into j_work from (
    select w.id, w.position pos, jsonb_strip_nulls(jsonb_build_object(
      'id', w.id, 'position', w.position, 'heading', nullif(w.heading, ''),
      'employer', nullif(w.company, ''), 'title', nullif(w.title, ''), 'location', nullif(w.location, ''),
      'start', _cz_pdate(w.start_date, w.start_date_precision),
      'end', case when w.end_date_precision = 'present' then null else _cz_pdate(w.end_date, w.end_date_precision) end,
      'current', case when w.end_date_precision = 'present' then true else null end,
      'description', case when o.text_override is not null then o.text_override else w.job_responsibilities end,
      'description_edited', (o.text_override is not null),
      'description_stale', (o.text_override is not null and o.base_text_hash is distinct from md5(coalesce(w.job_responsibilities, ''))),
      'included', coalesce(o.included, true),
      'verification', case when vv.status is null then jsonb_build_object('status', 'not_checked')
        else jsonb_strip_nulls(jsonb_build_object('status', _cz_vstatus(vv.status), 'method', case when vv.status = 'Confirmed' then 'verifi_review' end,
               'verified_on', case when vv.status = 'Confirmed' then to_char(vv.status_changed_at at time zone 'UTC', 'YYYY-MM-DD') end)) end
    )) o
    from work_history_items w
    left join candidate_item_overrides o on v_apply and o.candidate_id = p_candidate and o.kind = 'work' and o.item_id = w.id
    left join lateral (select status, status_changed_at from verification_items v where v.candidate_id = p_candidate and v.type = 'Job Experience' and v.source_item_id = w.id
                        order by (v.status = 'Confirmed') desc, v.status_changed_at desc limit 1) vv on true
    where w.candidate_id = p_candidate and w.candidate_confirmed and w.resume_document_id = any (v_docs) and w.staff_blocked_at is null
      and (not p_delivered_only or coalesce(o.included, true))
  ) x;

  -- ---- education
  select coalesce(jsonb_agg(x.o order by x.pos nulls last, x.id), '[]'::jsonb) into j_edu from (
    select e.id, e.position pos, jsonb_strip_nulls(jsonb_build_object(
      'id', e.id, 'position', e.position, 'heading', nullif(e.heading, ''),
      'institution', nullif(e.institution, ''), 'degree', nullif(e.degree, ''), 'field_of_study', nullif(e.field_of_study, ''), 'location', nullif(e.location, ''),
      'start', _cz_pdate(e.start_date, e.start_date_precision), 'end', _cz_pdate(e.end_date, e.end_date_precision),
      'included', coalesce(o.included, true),
      'verification', case when vv.status is null then jsonb_build_object('status', 'not_checked')
        else jsonb_strip_nulls(jsonb_build_object('status', _cz_vstatus(vv.status), 'method', case when vv.status = 'Confirmed' then 'verifi_review' end,
               'verified_on', case when vv.status = 'Confirmed' then to_char(vv.status_changed_at at time zone 'UTC', 'YYYY-MM-DD') end)) end
    )) o
    from education_items e
    left join candidate_item_overrides o on v_apply and o.candidate_id = p_candidate and o.kind = 'education' and o.item_id = e.id
    left join lateral (select status, status_changed_at from verification_items v where v.candidate_id = p_candidate and v.type = 'Education' and v.source_item_id = e.id
                        order by (v.status = 'Confirmed') desc, v.status_changed_at desc limit 1) vv on true
    where e.candidate_id = p_candidate and e.candidate_confirmed and e.resume_document_id = any (v_docs) and e.staff_blocked_at is null
      and (not p_delivered_only or coalesce(o.included, true))
  ) x;

  -- ---- certifications (verified by their own row OR by a Confirmed License queue row on a linked license: same as the comparison snapshot)
  select coalesce(jsonb_agg(x.o order by x.pos nulls last, x.id), '[]'::jsonb) into j_cert from (
    select ce.id, ce.position pos, jsonb_strip_nulls(jsonb_build_object(
      'id', ce.id, 'position', ce.position, 'heading', nullif(ce.heading, ''),
      'name', nullif(ce.name, ''), 'issuer', nullif(ce.issuing_body, ''), 'license_number', nullif(ce.license_number, ''), 'license_state', l.state,
      'issued', _cz_pdate(ce.issue_date, ce.issue_date_precision),
      'included', coalesce(o.included, true),
      'verification',
        case
          when lq.status = 'Confirmed' then jsonb_strip_nulls(jsonb_build_object('status', 'verified',
              'method', case when l.verification_outcome = 'verified' then 'state_registry' else 'verifi_review' end,
              'verified_on', coalesce(to_char(l.verified_at at time zone 'UTC', 'YYYY-MM-DD'), to_char(lq.status_changed_at at time zone 'UTC', 'YYYY-MM-DD'))))
          when own.status = 'Confirmed' then jsonb_strip_nulls(jsonb_build_object('status', 'verified', 'method', 'verifi_review',
              'verified_on', to_char(own.status_changed_at at time zone 'UTC', 'YYYY-MM-DD')))
          else jsonb_build_object('status', _cz_vstatus(coalesce(lq.status, own.status)))
        end
    )) o
    from certification_items ce
    left join candidate_item_overrides o on v_apply and o.candidate_id = p_candidate and o.kind = 'certification' and o.item_id = ce.id
    left join lateral (select * from verification_items v where v.candidate_id = p_candidate and v.type = 'Certification' and v.source_item_id = ce.id
                        order by (v.status = 'Confirmed') desc, v.status_changed_at desc limit 1) own on true
    left join lateral (select * from license_items li where li.candidate_id = p_candidate and li.linked_certification_id = ce.id order by li.id limit 1) l on true
    left join lateral (select * from verification_items v where v.candidate_id = p_candidate and v.type = 'License' and v.id = l.queue_item_id) lq on true
    where ce.candidate_id = p_candidate and ce.candidate_confirmed and ce.resume_document_id = any (v_docs) and ce.staff_blocked_at is null
      and (not p_delivered_only or coalesce(o.included, true))
  ) x;

  -- ---- skills: the extracted rows (edit / exclude) followed by the ones the candidate added
  select count(*) into v_base_skills from skill_items s where s.candidate_id = p_candidate and s.candidate_confirmed and s.resume_document_id = any (v_docs);
  select coalesce(jsonb_agg(x.o order by x.grp, x.pos nulls last, x.id), '[]'::jsonb) into j_skills from (
    select 0 grp, s.position pos, s.id, jsonb_strip_nulls(jsonb_build_object(
      'id', s.id, 'kind', 'skill', 'position', s.position,
      'text', coalesce(o.text_override, s.skill_text),
      'source', case when o.text_override is not null then 'candidate_edited' else 'extracted' end,
      'stale', (o.text_override is not null and o.base_text_hash is distinct from md5(coalesce(s.skill_text, ''))),
      'included', coalesce(o.included, true))) o
    from skill_items s
    left join candidate_item_overrides o on v_apply and o.candidate_id = p_candidate and o.kind = 'skill' and o.item_id = s.id
    where s.candidate_id = p_candidate and s.candidate_confirmed and s.resume_document_id = any (v_docs) and s.staff_blocked_at is null
      and (not p_delivered_only or coalesce(o.included, true))
    union all
    select 1, a.position, a.item_id, jsonb_build_object('id', a.item_id, 'kind', 'skill_added', 'position', a.position, 'text', a.text_override, 'source', 'candidate_added', 'included', a.included)
    from candidate_item_overrides a
    where v_apply and a.candidate_id = p_candidate and a.kind = 'skill_added' and (not p_delivered_only or a.included)
  ) x;

  -- ---- other freeform sections (flagged / hobbies); the summary section is handled below
  -- Gap #18: 'included' now defaults to true unconditionally (was: section_type <> 'needs_review') --
  -- see this migration's own header. A 'verification' block (status 'not_checked', uniform across every
  -- section_type) is new -- freeform never carried one before this.
  select coalesce(jsonb_agg(x.o order by x.pos nulls last, x.id), '[]'::jsonb) into j_free from (
    select f.id, f.position pos, jsonb_strip_nulls(jsonb_build_object(
      'id', f.id, 'position', f.position, 'section_type', f.section_type, 'heading', nullif(f.heading, ''), 'content', f.content,
      'included', coalesce(o.included, true),
      'verification', jsonb_build_object('status', 'not_checked')
    )) o
    from candidate_freeform_sections f
    left join candidate_item_overrides o on v_apply and o.candidate_id = p_candidate and o.kind = 'freeform' and o.item_id = f.id
    where f.candidate_id = p_candidate and f.candidate_confirmed and f.resume_document_id = any (v_docs) and f.section_type <> 'summary' and f.staff_blocked_at is null
      and (not p_delivered_only or coalesce(o.included, true))
  ) x;

  -- ---- summary: 'none' / a chosen version (both only while paid) / the default. The default itself has two sub-cases (2026-09-22 fix): the
  -- candidate has genuinely edited it (candidate_edited) -- their own words, shown as-is, never silently overwritten -- or it's still the
  -- untouched auto-seeded snapshot, in which case the resume's own CURRENT summary content is used instead of the frozen one, so an untouched
  -- default can never diverge from (or duplicate) whatever the resume's own Summary/Skills split currently says. Only when there is no live
  -- freeform Summary at all does an untouched default fall back to showing its own (necessarily still-original) snapshot.
  select * into v_ff_summary from candidate_freeform_sections f
   where f.candidate_id = p_candidate and f.candidate_confirmed and f.resume_document_id = any (v_docs) and f.section_type = 'summary'
   order by f.position nulls last limit 1;
  select * into v_generic from candidate_summary_versions where candidate_id = p_candidate and partner_key = '' order by created_at limit 1;
  if v_apply and cust.candidate_id is not null and cust.summary_mode = 'none' then
    v_summary := null; v_summary_source := 'none';
  elsif v_apply and cust.candidate_id is not null and cust.summary_mode = 'version'
        and exists (select 1 from candidate_summary_versions where id = cust.selected_summary_id and candidate_id = p_candidate) then
    select content, id into v_summary, v_summary_id from candidate_summary_versions where id = cust.selected_summary_id;
    v_summary_source := 'candidate_selected';
  elsif v_generic.id is not null and (v_generic.candidate_edited or v_ff_summary.id is null) then
    v_summary := v_generic.content; v_summary_id := v_generic.id; v_summary_source := 'default';
  elsif v_generic.id is not null then
    v_summary := v_ff_summary.content; v_summary_id := v_generic.id; v_summary_source := 'default';
  elsif v_ff_summary.id is not null then
    v_summary := v_ff_summary.content; v_summary_source := 'resume';
  end if;
  if v_summary is not null and btrim(v_summary) = '' then v_summary := null; v_summary_source := 'none'; end if;
  -- the resume's own heading is only shown over the resume's own words (same rule as the PDF has always used)
  v_summary_heading := case when v_summary is not null and v_ff_summary.id is not null and v_ff_summary.content = v_summary then nullif(btrim(v_ff_summary.heading), '') end;

  -- ---- header + contact (the printed value only ever prints as the candidate stated it; verified-on-file never prints unless the candidate printed it)
  select printed_header into v_printed_header from resume_documents where candidate_id = p_candidate and confirmed_at is not null order by confirmed_at desc limit 1;
  v_vphone := case when c.phone_verified_at is not null then coalesce(c.verified_phone_number, '') else '' end;
  v_pphone := case when v_apply and cust.candidate_id is not null then btrim(coalesce(cust.printed_phone, '')) else '' end;
  v_pemail := case when v_apply and cust.candidate_id is not null then btrim(coalesce(cust.printed_email, '')) else '' end;
  v_phone := case when v_pphone = '' then jsonb_build_object('state', 'private', 'verified_on_file', v_vphone <> '')
                  else jsonb_build_object('state', case when v_vphone <> '' and _cz_norm(v_pphone) = _cz_norm(v_vphone) then 'verified' else 'stated' end,
                                          'value', v_pphone, 'verified_on_file', v_vphone <> '') end;
  v_email := case when v_pemail = '' then jsonb_build_object('state', 'private', 'verified_on_file', true)
                  else jsonb_build_object('state', case when _cz_norm(v_pemail) = _cz_norm(c.email) then 'verified' else 'stated' end,
                                          'value', v_pemail, 'verified_on_file', true) end;

  return jsonb_build_object(
    'available', true,
    'assembled_at', now(),
    'customization', jsonb_build_object('active', v_apply, 'entitled', c.tier = 'paid', 'version', coalesce(cust.version, 0),
                                        'dormant', case when c.tier <> 'paid' and v_dormant > 0 then true else false end),
    'candidate', jsonb_strip_nulls(jsonb_build_object('name', nullif(btrim(concat_ws(' ', c.first_name, c.last_name)), ''))),
    'header', jsonb_strip_nulls(jsonb_build_object('mode', c.header_display_mode, 'printed_header', nullif(v_printed_header, ''), 'location', nullif(c.personal_location, ''))),
    'contact', jsonb_build_object('phone', v_phone, 'email', v_email),
    'summary', jsonb_strip_nulls(jsonb_build_object('id', v_summary_id, 'content', v_summary, 'source', v_summary_source, 'heading', v_summary_heading)),
    'work', j_work, 'education', j_edu, 'certifications', j_cert,
    'skills', jsonb_build_object('heading', (select nullif(btrim(s.heading), '') from skill_items s where s.candidate_id = p_candidate and s.candidate_confirmed and s.resume_document_id = any (v_docs) and nullif(btrim(s.heading), '') is not null order by s.position nulls last limit 1),
                                 'section_position', (select min(s.section_position) from skill_items s where s.candidate_id = p_candidate and s.candidate_confirmed and s.resume_document_id = any (v_docs)),
                                 'base_count', v_base_skills, 'max', greatest(15, v_base_skills), 'items', j_skills),
    'other_sections', j_free
  );
end $function$;

-- apply_resume_resubmission: auto-clears a block when a resubmission genuinely changes or removes the
-- blocked item -- "kept" (unchanged) never clears anything. Only the REMOVED and CHANGED loops are
-- touched; every other line is unchanged from the Item B/D fix (20260926010000_resubmission_freeform_source_item_id_fix.sql).
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
  v_was_blocked boolean;
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
    -- staff content-block: a removed item that was blocked has the block cleared automatically (the
    -- content it applied to no longer exists) -- logged before the row itself is archived and deleted.
    execute format('select staff_blocked_at is not null from %I where id = $1 and candidate_id = $2', tbl) into v_was_blocked using (x->>'id')::uuid, cand;
    if v_was_blocked then
      insert into staff_block_events (candidate_id, item_kind, item_id, actor, action, note)
        values (cand, kind, (x->>'id')::uuid, 'system', 'cleared_by_resubmission', 'Cleared automatically: the item was removed in a resubmission.');
    end if;
    perform _resub_archive(cand, p_resubmission_id, kind, tbl, (x->>'id')::uuid, 'removed', vqs, lid, oldd);
    archived := archived + 1;
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

    -- staff content-block: the fields above just changed, so any existing block is cleared automatically
    -- -- a candidate who genuinely edits the flagged content in a resubmission doesn't need staff to
    -- manually unblock it. Only fires when a block actually existed (row_count = 1), so this never writes
    -- a spurious event for an unblocked item.
    execute format('update %I set staff_blocked_at = null, staff_blocked_by = null, staff_block_note = null, staff_block_reason_code = null where id = $1 and candidate_id = $2 and staff_blocked_at is not null', tbl)
      using (x->>'id')::uuid, cand;
    get diagnostics n = row_count;
    if n = 1 then
      insert into staff_block_events (candidate_id, item_kind, item_id, actor, action, note)
        values (cand, kind, (x->>'id')::uuid, 'system', 'cleared_by_resubmission', 'Cleared automatically: the item was changed in a resubmission.');
    end if;

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

  -- 4. KEPT: descriptive fields and position only. Queue rows are not touched. Blocks are not touched either. -----------------------------
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
        values (nid, cand, q->>'type', q->>'claim', today, q->>'status', q->>'internal_note', case when kind = 'freeform' then nullif(q->>'source_item_id', '')::uuid else (x->>'staged_id')::uuid end, newd);
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

revoke all on function apply_resume_resubmission(uuid, jsonb) from public, anon, authenticated;
grant execute on function apply_resume_resubmission(uuid, jsonb) to service_role;
