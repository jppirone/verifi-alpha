-- Overlapping employment detection (2026-09-27): Design_Principles.docx P142 / Business_Model_Decision_
-- Log.docx Decision 40. Universal (every role type counts identically, no exclusivity carve-out),
-- blocking (candidate cannot pass resume-confirmation or a resubmission apply with an unresolved
-- overlap and no action recorded), staff-resolved only (neither explaining nor ignoring clears
-- anything by itself).
--
-- New schema, not a reuse of customization_edit_ack_at/customization_edit_ack_text_version
-- (20260927030000_customization_edit_tracking.sql): that pattern is a single scalar ack per
-- CANDIDATE, with no item-scoping, no multi-pair structure, and no resolution/queue-priority state --
-- it fits "did you see and accept this one disclosure," not "here are N flagged item-pairs, staff
-- must individually resolve them, and every pair needs its own audit trail." Checked and rejected,
-- not skipped.
--
-- Deliberately NOT reusing staff_blocked_at/staff_blocked_by/staff_block_note/staff_block_reason_code
-- (20260926060000_staff_content_block.sql) either, even though the enforcement shape (excluded from
-- delivery, visible+tagged in the candidate's own record, staff clears it) is the same family: that
-- flag is STAFF-initiated with a closed candidate-facing reason-code set and auto-clears the moment a
-- resubmission changes or removes the item (apply_resume_resubmission's own CHANGED/REMOVED loops).
-- This feature is SYSTEM-detected, carries a candidate free-text explanation (never staff-authored),
-- and per spec must NEVER auto-clear on any resubmission -- only an explicit staff resolution ends a
-- hold. Reusing the same four columns would conflate two different triggers with two different
-- clearing rules under one flag, and staff-block's own resubmission auto-clear would silently release
-- an overlap hold the very first time the candidate edited anything unrelated on that item. A
-- one-row-per-item design doesn't fit either: one incident can (and, per the recurring-pattern test
-- case, often will) span many pairs and many items at once, sharing ONE candidate explanation across
-- all of them -- staff_block's columns are scalar-per-item by design, this is inherently one-row-per-
-- INCIDENT with a child table of pairs.
--
-- work_overlap_holds: one row per detection run that found at least one overlap. `action`/`explanation`
-- record what the candidate chose; `resolved_at`/`resolved_by`/`resolution_note` record staff's own,
-- separate act of clearing it -- action alone never sets these. verification_item_id is the plug-in
-- point into the EXISTING staff queue (verification_items, staff.html's own list/detail UI) rather
-- than a parallel queue: one verification_items row (type 'Overlap') is created per incident, giving
-- staff the same list/filter/detail-panel machinery they already use for everything else, with its own
-- bespoke resolve action (see resolve_work_overlap_hold below) rather than forcing this into the
-- Confirmed/Discrepancy/etc. verification-status vocabulary, which doesn't semantically fit "staff
-- decided this date conflict is resolved."
create table work_overlap_holds (
  id uuid primary key default gen_random_uuid(),
  candidate_id uuid not null references candidates(id),
  detected_at timestamptz not null default now(),
  source text not null check (source in ('resumeConfirm', 'resubmission')),
  action text not null default 'pending' check (action in ('pending', 'explained', 'ignored')),
  explanation text,
  action_at timestamptz,
  -- Queue priority is the one functional difference between the two candidate actions (spec's own
  -- words): normal for an explanation, urgent for an ignore. Stored, not recomputed from `action`,
  -- so staff.html's own queue can sort/filter on it directly without re-deriving the rule.
  queue_priority text not null default 'normal' check (queue_priority in ('normal', 'urgent')),
  resolved_at timestamptz,
  resolved_by uuid references staff_users(id),
  resolution_note text,
  verification_item_id text references verification_items(id)
);
create index work_overlap_holds_candidate_idx on work_overlap_holds (candidate_id);
create index work_overlap_holds_verification_item_idx on work_overlap_holds (verification_item_id);
create index work_overlap_holds_unresolved_idx on work_overlap_holds (candidate_id) where resolved_at is null;

-- One row per flagged pair within an incident; also doubles as the membership record for "which items
-- are currently held" (a work_history_items.id counts as held iff it appears as item_a_id or item_b_id
-- in any pair belonging to an UNRESOLVED hold) -- no separate membership table needed.
create table work_overlap_pairs (
  id uuid primary key default gen_random_uuid(),
  hold_id uuid not null references work_overlap_holds(id) on delete cascade,
  item_a_id uuid not null references work_history_items(id),
  item_b_id uuid not null references work_history_items(id),
  overlap_days integer not null
);
create index work_overlap_pairs_hold_idx on work_overlap_pairs (hold_id);
create index work_overlap_pairs_item_a_idx on work_overlap_pairs (item_a_id);
create index work_overlap_pairs_item_b_idx on work_overlap_pairs (item_b_id);

revoke all on work_overlap_holds from public, anon, authenticated;
revoke all on work_overlap_pairs from public, anon, authenticated;
grant select, insert, update on work_overlap_holds to service_role;
grant select, insert on work_overlap_pairs to service_role;

-- create_work_overlap_hold: called from confirm-resume-data and resume-resubmission right after the
-- real write it's reporting on has already committed (an overlap hold documents a real detected
-- state; it's never itself the thing that could roll back the confirm/apply it followed). p_pairs is a
-- jsonb array of {"a": uuid, "b": uuid, "days": int}. Returns the new verification_items.id so the
-- caller can log/return it.
create or replace function create_work_overlap_hold(p_candidate uuid, p_pairs jsonb, p_source text, p_action text, p_explanation text)
returns text
language plpgsql security definer set search_path = public as $$
declare
  v_hold_id uuid;
  v_qid text;
  v_priority text := case when p_action = 'ignored' then 'urgent' else 'normal' end;
  v_pair jsonb;
  v_claim text;
  v_count integer;
  v_first_label text;
begin
  if p_action not in ('explained', 'ignored') then raise exception 'bad_action'; end if;
  if p_action = 'explained' and coalesce(btrim(p_explanation), '') = '' then raise exception 'explanation_required'; end if;
  select count(*) into v_count from jsonb_array_elements(p_pairs);
  if v_count = 0 then raise exception 'no_pairs'; end if;

  insert into work_overlap_holds (candidate_id, source, action, explanation, action_at, queue_priority)
    values (p_candidate, p_source, p_action, case when p_action = 'explained' then btrim(p_explanation) else null end, now(), v_priority)
    returning id into v_hold_id;

  for v_pair in select * from jsonb_array_elements(p_pairs) loop
    insert into work_overlap_pairs (hold_id, item_a_id, item_b_id, overlap_days)
      values (v_hold_id, (v_pair->>'a')::uuid, (v_pair->>'b')::uuid, (v_pair->>'days')::integer);
  end loop;

  -- A short, staff-facing summary claim: the first pair's two titles/companies, plus a count of any more.
  select (coalesce(nullif(btrim(w1.title), ''), 'Untitled') || ' at ' || coalesce(nullif(btrim(w1.company), ''), 'unknown employer')
          || ' overlaps ' || (v_pair->>'days')::text || 'd with ' || coalesce(nullif(btrim(w2.title), ''), 'Untitled') || ' at ' || coalesce(nullif(btrim(w2.company), ''), 'unknown employer'))
    into v_first_label
    from (select * from jsonb_array_elements(p_pairs) limit 1) p(v_pair)
    join work_history_items w1 on w1.id = (p.v_pair->>'a')::uuid
    join work_history_items w2 on w2.id = (p.v_pair->>'b')::uuid;
  v_claim := v_first_label || case when v_count > 1 then ' (+' || (v_count - 1)::text || ' more pair' || case when v_count - 1 = 1 then '' else 's' end || ')' else '' end;

  v_qid := nextval_verification_item_id();
  insert into verification_items (id, candidate_id, type, claim, received, status, internal_note)
    values (v_qid, p_candidate, 'Overlap', v_claim, current_date, 'New',
      case when p_action = 'ignored' then 'Candidate chose to ignore this overlap without an explanation. Elevated priority.' else null end);

  update work_overlap_holds set verification_item_id = v_qid where id = v_hold_id;
  return v_qid;
end;
$$;
revoke all on function create_work_overlap_hold(uuid, jsonb, text, text, text) from public, anon, authenticated;
grant execute on function create_work_overlap_hold(uuid, jsonb, text, text, text) to service_role;

-- resolve_work_overlap_hold: staff/admin action, called from the new resolve-work-overlap-hold edge
-- function. Sets the hold resolved AND flips its linked verification_items row to 'Resolved' (a new
-- status value used only by type='Overlap' rows -- staff.html's own generic status dropdown is hidden
-- for this type; 'Resolved' only reaches the row through this function, never the shared
-- update-verification-item endpoint) in one transaction, with a timeline entry for the same audit
-- trail every other status change already gets. Returns false (no-op) if the hold was already
-- resolved or does not exist, so the caller can tell "nothing happened" from a real error.
create or replace function resolve_work_overlap_hold(p_hold_id uuid, p_staff_id uuid, p_note text)
returns boolean
language plpgsql security definer set search_path = public as $$
declare
  v_qid text;
  v_n integer;
begin
  update work_overlap_holds set resolved_at = now(), resolved_by = p_staff_id, resolution_note = nullif(btrim(coalesce(p_note, '')), '')
    where id = p_hold_id and resolved_at is null
    returning verification_item_id into v_qid;
  get diagnostics v_n = row_count;
  if v_n = 0 then return false; end if;

  if v_qid is not null then
    update verification_items set status = 'Resolved', status_changed_at = now() where id = v_qid;
    insert into verification_item_timeline (item_id, event_date, actor, action, note)
      values (v_qid, now(), (select name from staff_users where id = p_staff_id), 'Overlap hold resolved.', p_note);
  end if;
  return true;
end;
$$;
revoke all on function resolve_work_overlap_hold(uuid, uuid, text) from public, anon, authenticated;
grant execute on function resolve_work_overlap_hold(uuid, uuid, text) to service_role;

-- assemble_customized_resume: excludes a work item currently held by an UNRESOLVED overlap, from the
-- work category's own query, the same "one line in the WHERE clause" shape staff_blocked_at already
-- uses just above it. Covers PDF delivery, Customization, and Content Manager in one place, same as
-- staff-block's own change did. Every other line in this function is unchanged from the staff-block
-- migration (20260926060000_staff_content_block.sql).
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
      and not exists (
        select 1 from work_overlap_pairs p join work_overlap_holds h on h.id = p.hold_id
        where h.resolved_at is null and (p.item_a_id = w.id or p.item_b_id = w.id)
      )
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
  v_summary_heading := case when v_summary is not null and v_ff_summary.id is not null and v_ff_summary.content = v_summary then nullif(btrim(v_ff_summary.heading), '') end;

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
