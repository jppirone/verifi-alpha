-- (A) One-time "your license needs a correction" email.
-- correction_notified_at: set atomically the first time a license enters the correction-needed state
-- and an email is sent; never cleared on success, so a second failed attempt, a re-check, or a later
-- correction request on the same license never sends another email.
alter table license_items add column if not exists correction_notified_at timestamptz;
-- last_license_notice_at: candidate-level coalescing so several licenses failing in the same confirm
-- produce ONE email (it points at the tab that lists all of them) instead of one per license.
alter table candidates add column if not exists last_license_notice_at timestamptz;

-- (B) Profile Info name edits are now persisted (update-profile-name). The name feeds license
-- verification, so every change leaves an audit row.
create table if not exists candidate_name_changes (
  id uuid primary key default gen_random_uuid(),
  candidate_id uuid not null references candidates(id) on delete cascade,
  old_first_name text,
  old_last_name text,
  new_first_name text,
  new_last_name text,
  changed_at timestamptz not null default now()
);
create index if not exists candidate_name_changes_candidate_idx on candidate_name_changes (candidate_id);
grant select, insert on table candidate_name_changes to service_role;
