-- Server-side staging for the resume-confirm opt-in selections (work history / education /
-- certifications), replacing an earlier client-side (localStorage) attempt at the same problem.
--
-- Why this table: email_verifications is already the staging table for phone/full_name (set on
-- an early signup screen, carried on the row itself until confirm-verification promotes them to
-- the real candidates row) and, more recently tonight, the anchor resume_documents.
-- email_verification_id stages against. The candidate's opt-in choices, made on the same
-- pre-account "preview" screen as everything else staged here, belong in exactly the same place —
-- not in browser storage, which has two real gaps this table doesn't: it can't survive the
-- candidate confirming from a different device than the one they signed up on (laptop → phone,
-- a real and common case for an email confirmation link), and even on the same device a cleared
-- site data / private window loses it same as a reload would.
--
-- Read back by confirm-verification (already SELECTs the full row via `select=*` keyed on the
-- token) and returned to the client in its response — so the resumeConfirm screen's initial
-- checkbox state comes from the row via the token in the confirmation link itself, not from
-- anything the browser remembers.
alter table email_verifications
  add column if not exists opt_in_work_history boolean not null default false,
  add column if not exists opt_in_education boolean not null default false,
  add column if not exists opt_in_certifications boolean not null default false;
