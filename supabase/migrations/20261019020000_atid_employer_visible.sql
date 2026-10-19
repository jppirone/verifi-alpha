-- ATID employer visibility (AR), October 19, 2026. Builds on 20261019010000_atid.sql (apply that one first).
--
-- ONE switch per candidate, default OFF, decides whether employers may use the ATID at all:
--   (1) the employer lookup may match on candidate name + ATID, and
--   (2) the ATID appears on the employer comparison document.
-- Off means neither. Both are enforced in the Edge Functions (check-existence, candidate-comparison-requests); this file only adds the storage.
--
-- 1. candidates.atid_employer_visible boolean NOT NULL DEFAULT false. Every existing row becomes false (the column default fills them).
--    Changing this column does not touch candidates.atid (the atid triggers fire only when atid itself changes) and it is not a credential.
-- 2. employer_lookup_requests.candidate_atid text: the ATID the requester typed, staged exactly like the typed email or phone (nullable).
--    It is scrubbed the moment the lookup completes (check-existence nulls it) and unconfirmed rows are already removed a day after they expire
--    by cleanup_expired_employer_lookups(), so the typed value is never kept.
--
-- Not done here: delete_candidate_account is not edited. It scrubs staged lookup rows by the candidate's email or phone; a staged ATID row has neither and is
-- removed by the same retention rules (scrubbed at completion, deleted a day after expiry when never completed).
--
-- Rollback: supabase/rollback/20261019020000_atid_employer_visible_rollback.sql

alter table public.candidates add column if not exists atid_employer_visible boolean not null default false;
comment on column public.candidates.atid_employer_visible is 'The candidate allows employers to use the ATID: name + ATID lookup, and the ATID on the employer comparison document. Default false.';

alter table public.employer_lookup_requests add column if not exists candidate_atid text;
comment on column public.employer_lookup_requests.candidate_atid is 'The ATID the requester typed (staged like candidate_email). Scrubbed when the lookup completes.';
