-- Resume resubmission, STAGE 1 (2026-09-21): schema only. A confirmed candidate can submit a NEW resume that is treated as their complete
-- current record; nothing in this migration changes the live profile. Stage 1 also adds the read-only plan step (function resume-resubmission);
-- the apply step is Stage 2.
--
-- Design (see the plan reported 2026-09-20): the new upload is its own immutable original (a resume_documents row + file in the private bucket,
-- exactly like the first one). Its extraction is STAGED in the ordinary item tables as unconfirmed rows (candidate_confirmed = false) on that
-- document, so the existing extraction, license-detection and read paths are reused unchanged. Every reader of the active profile already keys
-- on candidate_confirmed = true, and the staged rows never satisfy that until Stage 2's single-transaction apply.

-- 1. Which upload is which. 'initial' = the signup/first resume (every existing row); 'resubmission' = an upload made after confirmation.
alter table resume_documents add column if not exists kind text not null default 'initial';
alter table resume_documents drop constraint if exists resume_documents_kind_check;
alter table resume_documents add constraint resume_documents_kind_check check (kind in ('initial', 'resubmission'));
-- The confirmed document this one would replace (set when the resubmission is applied; recorded at upload for traceability).
alter table resume_documents add column if not exists supersedes_document_id uuid references resume_documents(id) on delete set null;

-- 2. The resubmission workflow: one row per attempt. The acknowledgement of the "this becomes your complete record" modal is recorded here
-- (when, and which wording), and the upload is refused without it.
create table if not exists resume_resubmissions (
  id uuid primary key default gen_random_uuid(),
  candidate_id uuid not null references candidates(id),
  resume_document_id uuid unique references resume_documents(id) on delete set null,
  base_document_id uuid references resume_documents(id) on delete set null,   -- the confirmed document current when this started
  status text not null default 'uploading'
    check (status in ('uploading', 'extracting', 'detecting_licenses', 'ready', 'applied', 'cancelled', 'failed', 'expired')),
  ack_at timestamptz not null,
  ack_text_version text not null,
  detect_attempts integer not null default 0,        -- license-detection runs fired for the staged document (capped at 2)
  plan jsonb,                                        -- the review data the candidate is shown; Stage 2 applies exactly this
  plan_hash text,
  base_fingerprint text,                             -- fingerprint of the active profile the plan was computed against (Stage 2 refuses a stale plan)
  opt_in jsonb,
  counts jsonb,
  failure_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  applied_at timestamptz,
  closed_at timestamptz
);
-- At most one open attempt per candidate.
create unique index if not exists resume_resubmissions_one_open
  on resume_resubmissions (candidate_id) where status in ('uploading', 'extracting', 'detecting_licenses', 'ready');
create index if not exists resume_resubmissions_candidate_created on resume_resubmissions (candidate_id, created_at);

-- 3. The archive of what a resubmission removed or changed (used by Stage 2). Structured so a smarter "restore on return" can be added later:
-- the item row, its queue row(s), the timeline and the license extension are kept whole as JSON. No retention window of its own: it lives and
-- is deleted with the candidate's other data (today nothing hard-deletes a deactivated account; see the Stage 1 report).
create table if not exists profile_item_archive (
  id uuid primary key default gen_random_uuid(),
  candidate_id uuid not null references candidates(id),
  resubmission_id uuid references resume_resubmissions(id) on delete set null,
  item_kind text not null check (item_kind in ('work', 'education', 'certification', 'license', 'skill', 'freeform')),
  item_id uuid not null,                              -- the original row's id (no FK: the row is gone)
  from_document_id uuid,
  reason text not null check (reason in ('removed', 'facts_changed')),
  item_data jsonb not null,
  verification jsonb,                                 -- array of the item's verification_items rows at the time
  timeline jsonb,
  license jsonb,
  archived_at timestamptz not null default now()
);
create index if not exists profile_item_archive_candidate on profile_item_archive (candidate_id, archived_at);

-- 4. Which uploads support each active item over time (the reconciled view across uploads).
create table if not exists profile_item_lineage (
  id uuid primary key default gen_random_uuid(),
  candidate_id uuid not null references candidates(id),
  item_kind text not null check (item_kind in ('work', 'education', 'certification', 'license', 'skill', 'freeform')),
  item_id uuid not null,
  resume_document_id uuid not null references resume_documents(id),
  resubmission_id uuid references resume_resubmissions(id) on delete set null,
  relation text not null check (relation in ('origin', 'reconfirmed', 'descriptive_updated', 'facts_changed')),
  created_at timestamptz not null default now()
);
create index if not exists profile_item_lineage_item on profile_item_lineage (item_id, created_at);

-- Server-side only: no API role can read or write these.
alter table resume_resubmissions enable row level security;
alter table profile_item_archive enable row level security;
alter table profile_item_lineage enable row level security;
revoke all on table resume_resubmissions, profile_item_archive, profile_item_lineage from anon, authenticated;
grant select, insert, update, delete on table resume_resubmissions, profile_item_archive, profile_item_lineage to service_role;

-- 5. cleanup_expired_unconfirmed_resume_data (hourly) only touches documents with no candidate_id, so a candidate's staged resubmission is never
-- swept by it; unreviewed attempts are expired by Stage 3's own job.
