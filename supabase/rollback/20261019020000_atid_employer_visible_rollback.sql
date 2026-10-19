-- Rollback of 20261019020000_atid_employer_visible.sql. Run by hand, only on John's word.
-- Deploy the previous versions of check-existence, send-lookup-confirmation, candidate-comparison-requests, set-discoverable and the five session
-- functions FIRST (or at the same time): they read these columns.
alter table public.employer_lookup_requests drop column if exists candidate_atid;
alter table public.candidates drop column if exists atid_employer_visible;
