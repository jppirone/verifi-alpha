-- Item B (2026-09-08 session): real backend for the Content Manager's named-summary-versions
-- feature — previously savedSummaries was a pure client-side fixture (seedSummaries(), two
-- hardcoded literals: "Product-minded engineer with 6 years..."), reset to those same two literals
-- on every reload, never persisted anywhere.
--
-- origin distinguishes how a row's content STARTED, not whether it's still identical to that start
-- — set once at insert, never touched by an edit. This is what lets the UI keep pointing at "the
-- one that began as your real resume summary" even after the candidate has since rewritten it,
-- same document-provenance discipline as everywhere else in this build (the starting point traces
-- back to something real, not invented — see resume_document_id's own role elsewhere). A row
-- created directly via "+ New Summary" is 'candidate_created' from the start; nothing in this
-- table is ever re-verified the way work_history/education/certifications are — this is
-- candidate-authored content start to finish, same treatment as job_responsibilities.
--
-- partner_key mirrors candidate.html's own existing convention (PARTNERS = linkedin/indeed/
-- glassdoor, '' = generic/not partner-specific) rather than inventing a new vocabulary — kept as
-- plain text, not a foreign key, since PARTNERS is a fixed in-app constant, not a database table.
create table if not exists candidate_summary_versions (
  id uuid primary key default gen_random_uuid(),
  candidate_id uuid not null references candidates(id) on delete cascade,
  name text not null,
  content text not null default '',
  origin text not null default 'candidate_created' check (origin in ('resume_extracted', 'candidate_created')),
  partner_key text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists candidate_summary_versions_candidate_id_idx on candidate_summary_versions (candidate_id);

-- Confirmed live: unlike this project's other tables (all created earlier, presumably before
-- whatever set the current default-privilege baseline), a brand new table here does NOT
-- automatically pick up service_role's usual read/write access — a real 42501 permission-denied,
-- not a schema-cache lag, reproduced live via the deployed edge functions before this grant existed.
grant select, insert, update, delete on public.candidate_summary_versions to service_role, authenticated, anon;
