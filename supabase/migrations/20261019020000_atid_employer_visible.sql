-- ATID employer visibility (AR, amended by AS), October 19, 2026. Builds on 20261019010000_atid.sql (apply that one first).
--
-- ONE switch per candidate, default OFF, decides whether employers may use the ATID at all:
--   (1) the employer lookup may match on candidate name + ATID (and only while "Allow lookup" is also on and the account is not scheduled for deletion), and
--   (2) the ATID appears on the employer comparison document.
-- Off means neither. Both are enforced in the Edge Functions (check-existence, candidate-comparison-requests); this file only adds the storage.
--
-- candidates.atid_employer_visible boolean NOT NULL DEFAULT false. Every existing row becomes false (the column default fills them).
-- Changing this column does not touch candidates.atid (the atid triggers fire only when atid itself changes) and it is not a credential.
--
-- AS (same day, nothing had been applied): an earlier draft of this file also added employer_lookup_requests.candidate_atid to hold the ATID an employer typed.
-- That column is GONE. The typed ATID is not saved anywhere: it is turned into a candidate id when it is typed (stored in the existing matched_candidate_id column, which
-- delete_candidate_account already unlinks and whose foreign key already sets it null), and the lookup works from the id alone. delete_candidate_account is not edited.
--
-- Rollback: supabase/rollback/20261019020000_atid_employer_visible_rollback.sql

alter table public.candidates add column if not exists atid_employer_visible boolean not null default false;
comment on column public.candidates.atid_employer_visible is 'The candidate allows employers to use the ATID: name + ATID lookup, and the ATID on the employer comparison document. Default false.';
