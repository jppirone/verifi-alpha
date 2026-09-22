-- Payment history for one-off guest employers (2026-09-22, Stage 1: schema).
--
-- A guest's "payment history" is read by matching their signed-in email against employer_payments.payer_email (the
-- same pattern list_employer_lookups already uses for pre-account Tier 1 lookups: no new identity table, no link
-- recorded at payment time -- the existing employer_users passwordless login is reused as-is).
--
-- What a history row needs to describe "what this was for" cannot safely be reconstructed by joining live tables at
-- read time, because two things already delete/scrub the rows a join would depend on:
--   * cleanup_expired_employer_lookups() nulls employer_lookup_requests.candidate_label after 30 days;
--   * delete_candidate_account() hard-deletes the candidate's own comparison_requests rows outright (comparison_request_id
--     is ON DELETE SET NULL, so the payment row survives, but everything joined through it disappears).
-- So the essential facts are snapshotted onto employer_payments AT PAYMENT-CREATION TIME, the same principle a real
-- receipt/invoice snapshots its line-item description instead of dereferencing a mutable, deletable catalog forever.
alter table employer_payments add column if not exists request_kind text check (request_kind in ('resume_comparison', 'license_report'));
alter table employer_payments add column if not exists candidate_label text;
alter table employer_payments add column if not exists requester_company text;

-- payer_email already is lowercase in every real row today (comparison_requests.requester_email, its source, already
-- enforces this), but was never enforced ON THIS table. Add the same constraint here for defense in depth, matching
-- comparison_requests.requester_email and employer_users.email.
alter table employer_payments add constraint employer_payments_payer_email_lower check (payer_email = lower(payer_email));

-- One-time backfill for any existing row that predates this column and still has a live comparison_request_id to
-- join through. Idempotent (only fills nulls) and safe to re-run.
update employer_payments p set
  request_kind = c.kind,
  requester_company = c.requester_company,
  candidate_label = coalesce(l.candidate_label, p.candidate_label)
from comparison_requests c
left join employer_lookup_requests l on l.id = c.lookup_id
where p.comparison_request_id = c.id
  and p.request_kind is null;
