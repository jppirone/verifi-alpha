-- Resumable PDF extraction (2026-09-19).
--
-- Why: upload-resume ran every page of a PDF inside ONE Edge Function invocation, and the platform kills an
-- invocation at ~150 s of wall clock. Measured on a real 2-page resume whose pages take the Sonnet-vision route
-- (tesseract cannot run on it), extraction took ~139 s: a 3rd page, or any slow model call, loses the WHOLE
-- resume, including the pages already read. Each page is now checkpointed as soon as it is read, an invocation
-- stops before it would run out of time, and the client calls back to continue.
--
--   resume_extraction_pages   one row per finished page: the page's own extraction exactly as the model returned it
--                             (local positions, before merging), so a later invocation can rebuild the
--                             previous-page context the next page needs and, at the end, merge every page in order.
--                             Rows are deleted once the resume is merged (the merged result and the OCR text are
--                             the record; this is scratch space) and cascade away with the document.
--   extraction_lease_until    a run holds this while it works. A continuation claims the document only when the
--                             lease is empty or expired, so two overlapping calls can never both process it.
--   extraction_progress_at    last time a page was checkpointed (stale-detection measures from here, not upload).
--   extraction_page_count     known once page 1 has been read.
--   extraction_stalls         consecutive runs that ended without checkpointing any page; 3 => 'failed'.
--   extraction_timing         per-page timing/routing summary written when extraction finishes (also readable
--                             mid-run from the checkpoint rows): model call ms, tokens, attempts, QA retry.

alter table resume_documents add column if not exists extraction_page_count int;
alter table resume_documents add column if not exists extraction_lease_until timestamptz;
alter table resume_documents add column if not exists extraction_progress_at timestamptz;
alter table resume_documents add column if not exists extraction_stalls int not null default 0;
alter table resume_documents add column if not exists extraction_timing jsonb;

create table if not exists resume_extraction_pages (
  resume_document_id uuid not null references resume_documents(id) on delete cascade,
  page_number int not null check (page_number >= 1),
  extraction jsonb not null,
  ocr_text text,
  -- 'not_needed' | 'pending' (flagged by the structural QA check, retry deferred to the next run) | 'done'
  qa_retry text not null default 'not_needed' check (qa_retry in ('not_needed', 'pending', 'done')),
  timing jsonb,
  created_at timestamptz not null default now(),
  primary key (resume_document_id, page_number)
);

-- Every table this project adds needs this explicit grant: the API roles get no default table privileges here, and
-- the Edge Functions talk to the database as service_role. (Found live: without it the first checkpoint write is
-- denied.) anon/authenticated deliberately get nothing.
grant select, insert, update, delete on table resume_extraction_pages to service_role;
