-- Bug 2 defense-in-depth: a structural, non-prompt-dependent safeguard against certification
-- fabrication, on top of (not instead of) the anti-fabrication prompt rule already shipped.
--
-- WHY THIS EXISTS: the prompt fix (2406b3e / this session's earlier commit) is a real fix for the
-- one real instance that surfaced it, verified by re-running that exact page and confirming a
-- clean requery — but it's a probabilistic guardrail, not a hard constraint, since LLM extraction
-- is not deterministic. This adds a second, independent layer: after extraction, check whether
-- each certification's name is actually traceable to real text somewhere in the document's OCR'd
-- output, and flag (never block) any that isn't a clean match — the same non-blocking-but-flagged
-- pattern already live for automated-check ambiguity (verification_items.status =
-- 'Needs Reconciliation') and for needs_review staff flagging (see the prior migration).
--
-- FEASIBILITY, investigated before writing any of this: OCR text was NOT actually retained per
-- document for the real, common case. Confirmed directly against the deployed code before touching
-- it: resume_documents.ocr_raw_text was written ONLY by upload-resume's single-image tesseract
-- branch. rasterize-pdf-page (the PDF path — the real document that surfaced bug 2 in the first
-- place) returns ocr_raw_text in its own HTTP response, but upload-resume's PDF loop only ever
-- read `.extraction` off that response and discarded `.ocr_raw_text` — meaning for a multi-page PDF,
-- no OCR text existed anywhere in the database once extraction finished. Fixed as part of this same
-- change (see upload-resume): the PDF branch now concatenates every page's ocr_raw_text and writes
-- it to the same, already-existing resume_documents.ocr_raw_text column — no new column needed for
-- storage, just an actual write where there was previously a silent discard.
--
-- REAL, DOCUMENTED LIMITATION, not silently glossed over: vision-routed pages (and the single-image
-- vision-fallback path) have no OCR text at all, by architecture — vision reads the image directly,
-- there is no OCR step to retain output from. A certification extracted from a vision-routed page
-- has nothing to fuzzy-match against. This function returns 'not_checked' for that case (see below)
-- rather than a false 'unmatched' — an honest "we couldn't verify this either way," not a false
-- accusation. Page 3 of john.pirone@proton.me's real resume (force_vision-routed under real
-- concurrent load earlier this session) is a live example: any certification from that page would
-- correctly land at 'not_checked', not 'unmatched'.
--
-- ALGORITHM: normalized token-containment, not exact substring match — deliberately, because real
-- OCR noise already observed this session (e.g. "AI" read as "Al") means exact substring matching
-- would false-flag genuinely real certifications constantly. A certification name is split into
-- significant words (stopwords and very short tokens dropped); it's judged 'matched' if most of
-- those words appear as whole words anywhere in the document's OCR text — tolerant of one or two
-- OCR-garbled tokens in an otherwise-real name, while still catching a name invented from whole
-- cloth (bug 2's real fabricated entry, "AI & emerging technology certification coursework", shares
-- almost no real tokens with the actual OCR'd "Continuing Education" note it was fabricated from —
-- confirmed by hand against the real captured OCR text before this threshold was chosen, not
-- guessed). Order- and position-insensitive: the task ask is "traceable somewhere in the source
-- document," not "on the same page it was extracted from."
create or replace function certification_source_match(p_name text, p_ocr_text text) returns text
language plpgsql
immutable
as $$
declare
  v_name text;
  v_haystack text;
  v_tokens text[];
  v_significant text[];
  v_token text;
  v_matched_count integer := 0;
  v_total integer;
  v_threshold numeric;
begin
  if p_ocr_text is null or trim(p_ocr_text) = '' then
    return 'not_checked';
  end if;
  if p_name is null or trim(p_name) = '' then
    return 'not_checked';
  end if;

  -- Normalize both sides identically: lowercase, collapse anything non-alphanumeric to a single
  -- space. Padded with a leading/trailing space so a plain position() check can require whole-word
  -- boundaries (position(' ai ' in ' training ') correctly does NOT match 'training' on 'ai').
  v_name := lower(regexp_replace(p_name, '[^a-zA-Z0-9]+', ' ', 'g'));
  v_haystack := ' ' || lower(regexp_replace(p_ocr_text, '[^a-zA-Z0-9]+', ' ', 'g')) || ' ';

  v_tokens := regexp_split_to_array(trim(v_name), '\s+');

  -- Real, measured stopword list, not exhaustive by design — dropping these avoids a short common
  -- word inflating the match ratio (e.g. "for" appearing incidentally elsewhere in a fabricated
  -- name shouldn't count toward "this is real").
  v_significant := array(
    select t from unnest(v_tokens) as t
    where length(t) > 2
      and t not in ('the','and','for','with','from','into','your','this','that','are','was')
  );

  if v_significant is null or array_length(v_significant, 1) is null then
    -- Name was only short/stopword tokens (e.g. a two-letter acronym on its own) — real signal
    -- either way would be unreliable at that size; say so honestly rather than guess.
    return 'not_checked';
  end if;

  v_total := array_length(v_significant, 1);
  foreach v_token in array v_significant loop
    if position(' ' || v_token || ' ' in v_haystack) > 0 then
      v_matched_count := v_matched_count + 1;
    end if;
  end loop;

  -- Very short names (<=2 significant tokens) need every token present — a percentage threshold is
  -- unstable at that size (one miss on a 2-token name is a 50% swing). Longer names tolerate real
  -- OCR noise on any one token as long as most of the name is genuinely present — 70% sits with
  -- real headroom above what a single garbled token costs on a typical 5-7-token certification
  -- name, the same evidence-based-threshold approach already used elsewhere in this pipeline
  -- (MIN_COLUMN_GAP_PX, PIXEL_COUNT_THRESHOLD).
  v_threshold := case when v_total <= 2 then v_total else ceil(v_total * 0.7) end;

  if v_matched_count >= v_threshold then
    return 'matched';
  else
    return 'unmatched';
  end if;
end;
$$;

grant execute on function certification_source_match(text, text) to service_role;

-- source_match: the persisted result of the check above, one value per certification_items row.
-- 'matched' | 'unmatched' | 'not_checked' | null (rows inserted before this migration — left null
-- rather than backfilled with a guess, same convention as position/heading before it).
alter table certification_items add column if not exists source_match text;

-- === insert_resume_extraction: accept p_ocr_text, compute source_match per certification ===
drop function if exists insert_resume_extraction(uuid, uuid, jsonb, jsonb, jsonb, jsonb, integer, jsonb);

create or replace function insert_resume_extraction(
  p_resume_document_id uuid,
  p_candidate_id uuid,
  p_work_history jsonb,
  p_education jsonb,
  p_certifications jsonb,
  p_skills jsonb,
  p_skills_position integer,
  p_freeform jsonb,
  p_ocr_text text default null  -- full document OCR text (concatenated across pages for a PDF;
                                 -- null for a vision-only document — see this migration's own
                                 -- header for exactly which paths have this and which don't)
) returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into work_history_items (candidate_id, resume_document_id, company, title, start_date, end_date, job_responsibilities, extraction_confidence, position)
  select p_candidate_id, p_resume_document_id, r.company, r.title,
         nullif(r.start_date,'')::date, nullif(r.end_date,'')::date, r.job_responsibilities, r.extraction_confidence, r.position
  from jsonb_to_recordset(p_work_history) as r(company text, title text, start_date text, end_date text, job_responsibilities text, extraction_confidence text, position integer);

  insert into education_items (candidate_id, resume_document_id, institution, degree, field_of_study, start_date, end_date, extraction_confidence, position)
  select p_candidate_id, p_resume_document_id, r.institution, r.degree, r.field_of_study,
         nullif(r.start_date,'')::date, nullif(r.end_date,'')::date, r.extraction_confidence, r.position
  from jsonb_to_recordset(p_education) as r(institution text, degree text, field_of_study text, start_date text, end_date text, extraction_confidence text, position integer);

  insert into certification_items (candidate_id, resume_document_id, name, issuing_body, issue_date, expiration_date, extraction_confidence, position, source_match)
  select p_candidate_id, p_resume_document_id, r.name, r.issuing_body,
         nullif(r.issue_date,'')::date, nullif(r.expiration_date,'')::date, r.extraction_confidence, r.position,
         certification_source_match(r.name, p_ocr_text)
  from jsonb_to_recordset(p_certifications) as r(name text, issuing_body text, issue_date text, expiration_date text, extraction_confidence text, position integer);

  insert into skill_items (candidate_id, resume_document_id, skill_text, position, section_position)
  select p_candidate_id, p_resume_document_id, s.skill_text, (s.ord - 1)::int, p_skills_position
  from jsonb_array_elements_text(coalesce(p_skills, '[]'::jsonb)) with ordinality as s(skill_text, ord)
  where trim(s.skill_text) <> '';

  insert into candidate_freeform_sections (candidate_id, resume_document_id, section_type, heading, content, position)
  select p_candidate_id, p_resume_document_id, r.section_type, nullif(r.heading, ''), r.content, r.position
  from jsonb_to_recordset(p_freeform) as r(section_type text, heading text, content text, position integer);
end;
$$;

grant execute on function insert_resume_extraction(uuid, uuid, jsonb, jsonb, jsonb, jsonb, integer, jsonb, text) to service_role;
