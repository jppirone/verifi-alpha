-- Candidate customization, STAGE 1 (2026-09-21): persisted include/exclude + text edits, the one server-side assembler, and the atomic write.
--
-- WHAT THIS IS. One persisted customization state per candidate, with two consumers: the candidate's own PDF/view (now) and a future licensed feed
-- (later). It is an OVERLAY on the candidate's confirmed resume data, never a copy of it and never a second verification status:
--   * candidate_item_overrides is SPARSE: a row exists only where the candidate deviated from the default (excluded an item, edited a job description,
--     edited or added a skill). Absence of a row means "included, exactly as extracted".
--   * candidate_customization holds the per-candidate settings that are not per item: which summary (default / none / a chosen version), the printed
--     phone and email, and a version counter for optimistic concurrency.
--   * Verification status is NEVER stored here. assemble_customized_resume joins it read-only from verification_items / license_items with the same
--     rule the employer comparison uses (assembleResumeSnapshot in candidate-comparison-requests): an item is "verified" iff its verification_items
--     row is Confirmed (a certification also when its linked License queue row is Confirmed). Customization decides what is SHOWN, not what is TRUE.
--   * Comparison snapshots and license reports do not read these tables at all (decision 2026-09-21: they reflect what was submitted and verified).
--
-- WHAT THE CANDIDATE MAY CHANGE (and nothing else): include/exclude any item; the text of a job's responsibilities; the text of a skill (edit / add /
-- remove an added one); which summary is used; the printed phone and email. Company, title, dates, location, institution, degree, license fields and
-- everything else stay locked to the verified data: apply_customization_ops has no operation that can touch them, and the endpoint rejects a request
-- that names one (never silently ignores it).
--
-- TIER. Customization is a paid feature. Writes are refused unless candidates.tier = 'paid' (checked under a row lock, inside the write). Reads apply
-- the overrides only while the candidate is paid; after a downgrade they go DORMANT (kept, ignored) and take effect again on re-upgrade.
--
-- Integrity. item_id is polymorphic (five item tables), so there is no FK on it: the write validates ownership and confirmation, and an AFTER DELETE
-- trigger on each item table removes the overrides of a deleted item (a resubmission that removes a job, account deletion, a discarded document).
-- Kept and changed items keep their ids on resubmission (updated in place), so their overrides survive; base_text_hash records what the extracted text
-- was when the candidate edited it, so an edit written against an older text is flagged (description_stale), never silently applied as if current.
-- The candidate_id foreign keys cascade, so account deletion needs no change to delete_candidate_account (which removes the items first anyway).

create table if not exists candidate_customization (
  candidate_id uuid primary key references candidates(id) on delete cascade,
  version integer not null default 0,
  summary_mode text not null default 'default' check (summary_mode in ('default', 'none', 'version')),
  selected_summary_id uuid references candidate_summary_versions(id) on delete set null,
  printed_phone text check (printed_phone is null or (char_length(printed_phone) <= 40)),
  printed_email text check (printed_email is null or (char_length(printed_email) <= 254)),
  updated_at timestamptz not null default now(),
  check (summary_mode <> 'version' or selected_summary_id is not null)
);

create table if not exists candidate_item_overrides (
  id uuid primary key default gen_random_uuid(),
  candidate_id uuid not null references candidates(id) on delete cascade,
  kind text not null check (kind in ('work', 'education', 'certification', 'skill', 'skill_added', 'freeform')),
  item_id uuid not null,
  included boolean not null default true,
  text_override text,
  base_text_hash text,
  position integer,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (candidate_id, kind, item_id),
  -- only these carry candidate text; the caps are the same as the endpoint's (defense in depth)
  check (text_override is null or kind in ('work', 'skill', 'skill_added')),
  check (kind <> 'work' or text_override is null or char_length(text_override) <= 8000),
  check (kind not in ('skill', 'skill_added') or text_override is null or (char_length(btrim(text_override)) between 1 and 100 and text_override !~ '[\r\n]')),
  check (kind <> 'skill_added' or (text_override is not null and included is not null))
);
create index if not exists candidate_item_overrides_item_idx on candidate_item_overrides (kind, item_id);

alter table candidate_customization enable row level security;
alter table candidate_item_overrides enable row level security;
revoke all on table candidate_customization from anon, authenticated;
revoke all on table candidate_item_overrides from anon, authenticated;
grant select, insert, update, delete on table candidate_customization to service_role;
grant select, insert, update, delete on table candidate_item_overrides to service_role;

-- an item that is deleted takes its overrides with it
create or replace function _cz_drop_item_overrides() returns trigger language plpgsql security definer set search_path = public as $$
begin
  delete from candidate_item_overrides where kind = tg_argv[0] and item_id = old.id;
  return old;
end $$;
revoke all on function _cz_drop_item_overrides() from public, anon, authenticated;

drop trigger if exists cz_drop_overrides on work_history_items;
create trigger cz_drop_overrides after delete on work_history_items for each row execute function _cz_drop_item_overrides('work');
drop trigger if exists cz_drop_overrides on education_items;
create trigger cz_drop_overrides after delete on education_items for each row execute function _cz_drop_item_overrides('education');
drop trigger if exists cz_drop_overrides on certification_items;
create trigger cz_drop_overrides after delete on certification_items for each row execute function _cz_drop_item_overrides('certification');
drop trigger if exists cz_drop_overrides on skill_items;
create trigger cz_drop_overrides after delete on skill_items for each row execute function _cz_drop_item_overrides('skill');
drop trigger if exists cz_drop_overrides on candidate_freeform_sections;
create trigger cz_drop_overrides after delete on candidate_freeform_sections for each row execute function _cz_drop_item_overrides('freeform');

-- ---------------------------------------------------------------------------------------------------------------------------------------------
-- helpers
-- ---------------------------------------------------------------------------------------------------------------------------------------------
-- A date exactly as precisely as the source printed it (same rule as partialDate in candidate-comparison-requests): year / year-month / day.
create or replace function _cz_pdate(d date, prec text) returns text language sql stable set search_path = public as $$
  select case when d is null then null else
    case coalesce(nullif(prec, ''), case when to_char(d, 'MMDD') = '0101' then 'year' when to_char(d, 'DD') = '01' then 'month' else 'day' end)
      when 'year' then to_char(d, 'YYYY') when 'month' then to_char(d, 'YYYY-MM') when 'day' then to_char(d, 'YYYY-MM-DD')
      else case when to_char(d, 'MMDD') = '0101' then to_char(d, 'YYYY') when to_char(d, 'DD') = '01' then to_char(d, 'YYYY-MM') else to_char(d, 'YYYY-MM-DD') end
    end end
$$;

-- The candidate-safe vocabulary for a verification queue status (same allowlist the Verification Status tab uses): no internal status ever leaves.
create or replace function _cz_vstatus(s text) returns text language sql immutable set search_path = public as $$
  select case s when 'Confirmed' then 'verified' when 'Unable to Verify' then 'unable_to_verify' when 'Discrepancy' then 'under_review'
                when null then 'not_checked' else 'submitted_pending_review' end
$$;

create or replace function _cz_norm(v text) returns text language sql immutable set search_path = public as $$
  select lower(regexp_replace(coalesce(v, ''), '[^0-9a-zA-Z@.]', '', 'g'))
$$;

-- ---------------------------------------------------------------------------------------------------------------------------------------------
-- THE ASSEMBLER. One statement-level read of the candidate's confirmed resume data with the overrides applied (while paid) and verification joined.
--   p_ignore_overrides: return the un-customized data (the parity test against the comparison snapshot uses it; nothing else should).
--   p_delivered_only:   drop excluded items (what the candidate's PDF and any feed consume); false returns everything with an `included` flag (the editor).
-- Confirmed-data rule (identical to assembleResumeSnapshot): only rows with candidate_confirmed = true on a resume document the candidate confirmed.
-- ---------------------------------------------------------------------------------------------------------------------------------------------
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
      'included', coalesce(o.included, true))) o
    from candidate_freeform_sections f
    left join candidate_item_overrides o on v_apply and o.candidate_id = p_candidate and o.kind = 'freeform' and o.item_id = f.id
    where f.candidate_id = p_candidate and f.candidate_confirmed and f.resume_document_id = any (v_docs) and f.section_type <> 'summary'
      and (not p_delivered_only or coalesce(o.included, true))
  ) x;

  -- ---- summary: 'none' / a chosen version (both only while paid) / the default (the generic version, else the resume's own summary)
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
  elsif v_generic.id is not null then
    v_summary := v_generic.content; v_summary_id := v_generic.id; v_summary_source := 'default';
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
                                 'base_count', v_base_skills, 'max', greatest(15, v_base_skills), 'items', j_skills),
    'other_sections', j_free
  );
end $$;
revoke all on function assemble_customized_resume(uuid, boolean, boolean) from public, anon, authenticated;
grant execute on function assemble_customized_resume(uuid, boolean, boolean) to service_role;

-- ---------------------------------------------------------------------------------------------------------------------------------------------
-- THE WRITE. One transaction: every operation validates against the database (ownership, confirmed data, tier, version) or the whole request is
-- refused and nothing is written. Shape / normalization / locked-field checks happen in the endpoint before this is called; this function
-- accepts ONLY the operations below, so there is no way to reach a locked column through it.
--   {"op":"include","kind":"work|education|certification|skill|skill_added|freeform","item_id":uuid,"included":bool}
--   {"op":"text","kind":"work|skill|skill_added","item_id":uuid,"value":text|null}       null = back to the extracted text
--   {"op":"add_skill","text":text}
--   {"op":"remove_added_skill","item_id":uuid}
--   {"op":"summary","mode":"default|none|version","summary_id":uuid|null}
--   {"op":"contact","printed_phone":text|null,"printed_email":text|null}                  only the keys present are changed
--   {"op":"reset_items"}                                                                   every include/text override back to default
-- Errors are raised as exceptions whose message is a code (tier_required, version_conflict, item_not_found, ...); hint carries the op index.
-- ---------------------------------------------------------------------------------------------------------------------------------------------
create or replace function apply_customization_ops(p_candidate uuid, p_base_version integer, p_ops jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
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

  -- keep the table sparse: an override that says nothing (included, no text, not an added skill) is deleted
  delete from candidate_item_overrides where candidate_id = p_candidate and kind <> 'skill_added' and included and text_override is null;

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
revoke all on function apply_customization_ops(uuid, integer, jsonb) from public, anon, authenticated;
grant execute on function apply_customization_ops(uuid, integer, jsonb) to service_role;
