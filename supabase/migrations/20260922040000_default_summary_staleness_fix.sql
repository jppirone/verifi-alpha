-- Default-summary staleness fix (2026-09-22).
--
-- Real, confirmed bug (live-tested Donofrio resume, resubmission candidate 444a007b-e735-4c5b-bd91-
-- 1670c13e174c): candidate_summary_versions' auto-seeded "Default summary" row (list-candidate-
-- summaries, origin='resume_extracted', partner_key='') is captured ONCE, the first time a candidate
-- visits a screen that needs it, and never touched again -- not even by resume-resubmission's apply,
-- which was already noted (Customization Stage 3 pre-check, 2026-09-22) as "not touched by apply" but
-- not treated as urgent at the time. assemble_customized_resume's summary resolution always prefers
-- this frozen snapshot over the resume's own live, current candidate_freeform_sections content
-- whenever one exists (summary_mode = 'default', the common case) -- by design, so a candidate's own
-- summary edits survive a later resubmission. But an UNEDITED default has no edits worth protecting,
-- and freezing it means any bug or non-determinism in the boundary-detection/extraction step that
-- happened to affect ONE extraction attempt (this candidate's initial upload didn't cleanly split an
-- inline "Experience Areas:" list out of Summary -- see verifi-inline-label-list-boundary-fix memory --
-- even though the SAME candidate's later resubmission, run through the identical fixed code, correctly
-- did) gets baked into the PDF/delivered view forever, alongside the newly-correct Skills section split
-- out of the SAME text: the candidate's downloaded PDF showed "Experience Areas" twice -- once as the
-- stale, un-split raw list still sitting in the frozen default summary, once as the freshly and
-- correctly extracted Skills section.
--
-- Fix: a summary version now records whether the candidate has ever actually edited its content.
-- assemble_customized_resume's 'default' branch uses the frozen snapshot only when it has genuinely
-- been edited (the candidate's own words, never silently overwritten); an untouched default instead
-- shows the resume's own current, live Summary text, so it can never be stale independent of the
-- resume itself. list-candidate-summaries lazily repairs the stored row's content the same way, so
-- the Content Manager edit box and the PDF always agree.

alter table candidate_summary_versions add column if not exists candidate_edited boolean not null default false;

create or replace function assemble_customized_resume(p_candidate uuid, p_ignore_overrides boolean default false, p_delivered_only boolean default false)
returns jsonb language plpgsql stable security definer set search_path = public as $$
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
    where w.candidate_id = p_candidate and w.candidate_confirmed and w.resume_document_id = any (v_docs)
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
    where e.candidate_id = p_candidate and e.candidate_confirmed and e.resume_document_id = any (v_docs)
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
    where ce.candidate_id = p_candidate and ce.candidate_confirmed and ce.resume_document_id = any (v_docs)
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
    where s.candidate_id = p_candidate and s.candidate_confirmed and s.resume_document_id = any (v_docs)
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
      'included', coalesce(o.included, f.section_type <> 'needs_review'))) o
    from candidate_freeform_sections f
    left join candidate_item_overrides o on v_apply and o.candidate_id = p_candidate and o.kind = 'freeform' and o.item_id = f.id
    where f.candidate_id = p_candidate and f.candidate_confirmed and f.resume_document_id = any (v_docs) and f.section_type <> 'summary'
      and (not p_delivered_only or coalesce(o.included, f.section_type <> 'needs_review'))
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
end $$;
revoke all on function assemble_customized_resume(uuid, boolean, boolean) from public, anon, authenticated;
grant execute on function assemble_customized_resume(uuid, boolean, boolean) to service_role;
