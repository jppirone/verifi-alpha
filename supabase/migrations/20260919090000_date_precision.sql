-- Date precision (2026-09-19).
--
-- Why: extraction stored every date as a full DATE, writing a bare year (source: "2007 – 2008") as 2007-01-01 and a
-- month-and-year as YYYY-MM-01. Once stored, "the resume printed only a year" was indistinguishable from "January 1",
-- and the app's labels invented the rest: "Graduated Jan 1990" for an attendance range 1985 – 1990, "(Jan 2007-Jan 2008)"
-- for years, "(Issued Jan 2020)". These columns record how precisely the SOURCE printed each date, so every surface can
-- print it exactly that precisely and never fill in a month or day.
--
--   year  -> only the year was printed         (stored date is Jan 1 of that year; do not show a month)
--   month -> month and year were printed       (stored date is the 1st of that month; do not show a day)
--   day   -> a full date was printed
--   present (end dates only) -> the source said Present / Current, which is not a date at all
--
-- Extraction now writes dates as printed ("1990", "1990-03", "1990-03-15", or the word Present); the two helpers below turn
-- that text into (date, precision) inside insert_resume_extraction, so every extraction path (PDF pages, image OCR,
-- vision fallback) gets it from one place.
--
-- Backfill of rows extracted before this existed (deliberately conservative, never invents): a stored date on Jan 1 is
-- treated as year-only, on the 1st of another month as month-only, anything else as a full date. A genuine "Jan 2019"
-- extracted under the old convention therefore reads as "2019" (a real month is dropped, none is made up). A work-history
-- row with a start date and no end date is marked 'present': that is what the old prompt wrote for a current role and
-- what the old labels already printed.

alter table work_history_items
  add column if not exists start_date_precision text check (start_date_precision in ('year','month','day')),
  add column if not exists end_date_precision   text check (end_date_precision   in ('year','month','day','present'));
alter table education_items
  add column if not exists start_date_precision text check (start_date_precision in ('year','month','day')),
  add column if not exists end_date_precision   text check (end_date_precision   in ('year','month','day','present'));
alter table certification_items
  add column if not exists issue_date_precision      text check (issue_date_precision      in ('year','month','day')),
  add column if not exists expiration_date_precision text check (expiration_date_precision in ('year','month','day'));

-- Parses "YYYY", "YYYY-MM" or "YYYY-MM-DD" (anything else, including the word Present and impossible dates, is null).
create or replace function parse_partial_date(t text) returns date
language plpgsql immutable as $$
declare s text := btrim(coalesce(t, ''));
begin
  if s ~ '^\d{4}$' then return make_date(s::int, 1, 1);
  elsif s ~ '^\d{4}-(0[1-9]|1[0-2])$' then return make_date(left(s, 4)::int, substr(s, 6, 2)::int, 1);
  elsif s ~ '^\d{4}-(0[1-9]|1[0-2])-\d{2}$' then return s::date;
  end if;
  return null;
exception when others then
  return null;
end $$;

-- How precisely that text says the date was printed. A full YYYY-MM-DD on the 1st is treated as month-only (or year-only
-- on Jan 1): that is how a partial date used to be written, and a genuine "January 1" is far rarer than the habit.
create or replace function partial_date_precision(t text) returns text
language sql immutable as $$
  select case
    when lower(btrim(coalesce(t, ''))) in ('present', 'current', 'now', 'ongoing') then 'present'
    when parse_partial_date(t) is null then null
    when btrim(t) ~ '^\d{4}$' then 'year'
    when btrim(t) ~ '^\d{4}-\d{2}$' then 'month'
    when right(btrim(t), 2) <> '01' then 'day'
    when substr(btrim(t), 6, 2) = '01' then 'year'
    else 'month'
  end
$$;

grant execute on function parse_partial_date(text) to service_role;
grant execute on function partial_date_precision(text) to service_role;

-- Backfill (see header).
update work_history_items set start_date_precision = case when extract(month from start_date) = 1 and extract(day from start_date) = 1 then 'year' when extract(day from start_date) = 1 then 'month' else 'day' end where start_date is not null and start_date_precision is null;
update work_history_items set end_date_precision = case when end_date is null then 'present' when extract(month from end_date) = 1 and extract(day from end_date) = 1 then 'year' when extract(day from end_date) = 1 then 'month' else 'day' end where (end_date is not null or start_date is not null) and end_date_precision is null;
update education_items set start_date_precision = case when extract(month from start_date) = 1 and extract(day from start_date) = 1 then 'year' when extract(day from start_date) = 1 then 'month' else 'day' end where start_date is not null and start_date_precision is null;
update education_items set end_date_precision = case when extract(month from end_date) = 1 and extract(day from end_date) = 1 then 'year' when extract(day from end_date) = 1 then 'month' else 'day' end where end_date is not null and end_date_precision is null;
update certification_items set issue_date_precision = case when extract(month from issue_date) = 1 and extract(day from issue_date) = 1 then 'year' when extract(day from issue_date) = 1 then 'month' else 'day' end where issue_date is not null and issue_date_precision is null;
update certification_items set expiration_date_precision = case when extract(month from expiration_date) = 1 and extract(day from expiration_date) = 1 then 'year' when extract(day from expiration_date) = 1 then 'month' else 'day' end where expiration_date is not null and expiration_date_precision is null;

-- insert_resume_extraction: same signature as the live version (heading capture, source_match, skills); only the date
-- handling changes, from a blind ::date cast (which would reject "1990") to the two helpers above.
create or replace function insert_resume_extraction(
  p_resume_document_id uuid,
  p_candidate_id uuid,
  p_work_history jsonb,
  p_education jsonb,
  p_certifications jsonb,
  p_skills jsonb,
  p_skills_position integer,
  p_freeform jsonb,
  p_ocr_text text default null,
  p_candidate_location text default null,
  p_printed_header text default null
) returns void
language plpgsql
security definer
set search_path = public
as $function$
begin
  insert into work_history_items (candidate_id, resume_document_id, company, title, location, start_date, start_date_precision, end_date, end_date_precision, job_responsibilities, extraction_confidence, position, heading)
  select p_candidate_id, p_resume_document_id, r.company, r.title, nullif(r.location, ''),
         parse_partial_date(r.start_date), nullif(partial_date_precision(r.start_date), 'present'),
         parse_partial_date(r.end_date), partial_date_precision(r.end_date),
         r.job_responsibilities, r.extraction_confidence, r.position, nullif(r.heading, '')
  from jsonb_to_recordset(p_work_history) as r(company text, title text, location text, start_date text, end_date text, job_responsibilities text, extraction_confidence text, position integer, heading text);

  insert into education_items (candidate_id, resume_document_id, institution, degree, field_of_study, location, start_date, start_date_precision, end_date, end_date_precision, extraction_confidence, position, heading)
  select p_candidate_id, p_resume_document_id, r.institution, r.degree, r.field_of_study, nullif(r.location, ''),
         parse_partial_date(r.start_date), nullif(partial_date_precision(r.start_date), 'present'),
         parse_partial_date(r.end_date), partial_date_precision(r.end_date),
         r.extraction_confidence, r.position, nullif(r.heading, '')
  from jsonb_to_recordset(p_education) as r(institution text, degree text, field_of_study text, location text, start_date text, end_date text, extraction_confidence text, position integer, heading text);

  insert into certification_items (candidate_id, resume_document_id, name, issuing_body, license_number, issue_date, issue_date_precision, expiration_date, expiration_date_precision, extraction_confidence, position, source_match, heading)
  select p_candidate_id, p_resume_document_id, r.name, r.issuing_body, nullif(r.license_number, ''),
         parse_partial_date(r.issue_date), nullif(partial_date_precision(r.issue_date), 'present'),
         parse_partial_date(r.expiration_date), nullif(partial_date_precision(r.expiration_date), 'present'),
         r.extraction_confidence, r.position,
         certification_source_match(r.name, p_ocr_text), nullif(r.heading, '')
  from jsonb_to_recordset(p_certifications) as r(name text, issuing_body text, license_number text, issue_date text, expiration_date text, extraction_confidence text, position integer, heading text);

  insert into skill_items (candidate_id, resume_document_id, skill_text, position, section_position)
  select p_candidate_id, p_resume_document_id, s.skill_text, (s.ord - 1)::int, p_skills_position
  from jsonb_array_elements_text(coalesce(p_skills, '[]'::jsonb)) with ordinality as s(skill_text, ord)
  where trim(s.skill_text) <> '';

  insert into candidate_freeform_sections (candidate_id, resume_document_id, section_type, heading, content, position)
  select p_candidate_id, p_resume_document_id, r.section_type, nullif(r.heading, ''), r.content, r.position
  from jsonb_to_recordset(p_freeform) as r(section_type text, heading text, content text, position integer);

  update resume_documents set candidate_location = nullif(p_candidate_location, ''), printed_header = nullif(p_printed_header, '') where id = p_resume_document_id;
end;
$function$;

grant execute on function insert_resume_extraction(uuid, uuid, jsonb, jsonb, jsonb, jsonb, integer, jsonb, text, text, text) to service_role;
