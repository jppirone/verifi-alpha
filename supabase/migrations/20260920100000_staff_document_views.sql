-- Staff view of employer documents (2026-09-20): an ADMIN-only page (function staff-employer-documents) that lists, per candidate, the approved
-- requests whose employer document is still stored, and opens a file through a 60-second signed link. It reads the real state of
-- comparison_request_documents (so a purged file's row is gone from the page too); it has no retention of its own.
--
-- Looking at a candidate's third-party documents is itself sensitive, so every link a staff member opens is recorded here: who, which request,
-- which candidate, when. Only ids and the staff identity are stored (no file name, no file content, nothing from the document). The rows are
-- deliberately NOT tied to the request by a foreign key: the record of who looked must outlive the 21-day file and a deleted request.
create table if not exists staff_employer_document_views (
  id uuid primary key default gen_random_uuid(),
  staff_user_id uuid not null,
  staff_email text not null,
  request_id uuid not null,
  candidate_id uuid not null,
  viewed_at timestamptz not null default now()
);
create index if not exists staff_employer_document_views_request_idx on staff_employer_document_views (request_id, viewed_at);
alter table staff_employer_document_views enable row level security;   -- no policies: no API role can read or write it
revoke all on table staff_employer_document_views from anon, authenticated;
grant select, insert on table staff_employer_document_views to service_role;
