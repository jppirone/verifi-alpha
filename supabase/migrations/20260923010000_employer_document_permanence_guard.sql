-- Employer document permanence guard (2026-09-23).
--
-- Explicit product requirement: once an employer's document is bound to a comparison_requests row
-- (comparison_request_documents.request_id set, done exactly once by create_comparison_request at
-- request-submission time), it is the ONLY document that will ever be associated with that
-- comparison, permanently, for the life of the comparison. There must be no way -- today or from any
-- future code change -- to re-upload or rebind a different document to an already-bound request.
--
-- An audit confirmed no code path currently does this: the UNIQUE constraint on request_id already
-- makes it impossible for two rows to hold the same request_id at once, and the only writer of this
-- column is create_comparison_request's one-time bind (only when the row's request_id is still null).
-- But that guarantee lived only in "no code happens to violate it today", not in the schema itself --
-- a later feature (an "edit request" flow, a staff tool, anything) could legally null out a bound
-- request_id and rebind a fresh document with two individually-constraint-legal writes. This trigger
-- makes the permanence guarantee enforced by Postgres itself, not just by current application code:
-- once request_id is non-null, no UPDATE may change it (to a different request, or to null) and no
-- UPDATE may change a bound row's storage_path either (the same document must stay the same file).
create or replace function trg_lock_bound_employer_document() returns trigger
language plpgsql as $$
begin
  if old.request_id is not null then
    if new.request_id is distinct from old.request_id then
      raise exception 'comparison_request_documents.request_id is permanent once bound (id=%)', old.id;
    end if;
    if new.storage_path is distinct from old.storage_path then
      raise exception 'comparison_request_documents.storage_path is permanent once bound (id=%)', old.id;
    end if;
  end if;
  return new;
end $$;
drop trigger if exists lock_bound_employer_document on comparison_request_documents;
create trigger lock_bound_employer_document before update on comparison_request_documents
  for each row execute function trg_lock_bound_employer_document();

comment on column comparison_request_documents.request_id is
  'Set exactly once by create_comparison_request''s one-time bind. Permanent from then on -- enforced by the lock_bound_employer_document trigger, not just by application code. Never update or null this out to rebind a different document to an existing request.';
