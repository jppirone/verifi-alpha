-- reset-test-candidate.sql
--
-- Fully wipes a candidate's test data across every table the resume-pipeline signup flow
-- touches, keyed off one or more email addresses. Built for exactly this need: clearing out
-- your own personal test-account footprint (candidates row, email_verifications history,
-- resume upload/OCR/extraction rows, and any staff-queue verification_items + their timeline)
-- before a fresh real test run, without leaving stray data behind under a different axis
-- (e.g. a resume_documents row still staged against an old email_verification_id with no
-- candidate_id yet — see upload-resume's header for why that staging key exists at all).
--
-- DESTRUCTIVE. MANUAL-RUN-ONLY. This file is never read or executed by the app itself — it is
-- a script you paste into the Supabase SQL Editor by hand, on purpose, when you mean it. There
-- is no confirmation step beyond Supabase's own "destructive operation" prompt on the DELETE
-- section, so treat pasting the DELETE section in as the point of no return.
--
-- HOW TO USE:
--   1. In whichever section you're about to run, edit the single `values (...)` list under
--      "-- EDIT THIS: target email(s)" to the real address(es) you want. Each section has its
--      own copy of that list (so the two sections stay independently copy-pasteable — see below)
--      but within a section there is exactly one place to edit; everything else in that section
--      reads from it.
--   2. Paste ONLY the REPORT section (down to its closing `;`, before the line of `=` that opens
--      the DELETE section) into the SQL Editor and run it. Review the row counts per table per
--      email. If anything looks wrong — a count you didn't expect, an email that shouldn't be in
--      scope — stop here and figure out why before touching the DELETE section.
--   3. Once the report looks right, paste ONLY the DELETE section into a fresh query and run it.
--      Supabase will show its own "Potential issue detected" destructive-operation prompt —
--      confirm it only if you mean to proceed.
--   4. Re-run the REPORT section again (same email list). Every count for every listed email
--      must read 0 across all nine tables. Don't take "Success" on the DELETE statements as
--      proof by itself — confirm with a real SELECT, the same way this section always has.
--
-- Table order in both sections follows the real foreign-key graph, children before parents:
--   verification_item_timeline -> verification_items -> {work_history_items, education_items,
--   certification_items, candidate_freeform_sections} -> resume_documents -> candidate_sessions
--   -> login_tokens -> candidates -> email_verifications
-- resume_documents is linked to a candidate two ways — candidate_id (once backfilled at
-- confirm-verification time) and email_verification_id (the staging key used before that, for
-- an abandoned or still-mid-signup upload) — so both are checked everywhere a "does this row
-- belong to this candidate" test is needed. verification_items.candidate_id is the only link
-- into the staff queue; verification_item_timeline hangs off verification_items.id (text,
-- "VQ-####") via its item_id column, not off candidates directly.
--
-- candidate_sessions.candidate_id and login_tokens.candidate_id are real foreign keys with no
-- ON DELETE CASCADE (see the passwordless-login migration), so both MUST be cleared before
-- candidates or the delete fails outright with a foreign-key violation, not just leaves stray
-- rows behind. login_tokens also carries its own email column directly (a login link can predate
-- any candidate match — see request-login's header), so it's matched by email as well as via any
-- candidate_id link, unlike candidate_sessions which only ever exists tied to a real candidate.


-- ============================================================================
-- SECTION 1: REPORT (read-only) — run this first, review it, then run it again
-- after the delete to confirm zero rows remain. Safe to run any number of times.
-- ============================================================================

with target_emails as (
  -- EDIT THIS: target email(s). Add or remove rows as needed; nothing else in this
  -- section needs to change.
  select * from (values
    ('jpirone@yahoo.com'),
    ('john.pirone@gmail.com'),
    ('john.pirone@proton.me')
  ) as t(email)
),
cand as (
  select te.email, c.id as candidate_id
  from target_emails te
  join candidates c on c.email = te.email
),
ev as (
  select te.email, e.id as email_verification_id
  from target_emails te
  join email_verifications e on e.email = te.email
),
rd as (
  select te.email, r.id as resume_document_id
  from target_emails te
  join resume_documents r
    on r.candidate_id in (select candidate_id from cand where cand.email = te.email)
    or r.email_verification_id in (select email_verification_id from ev where ev.email = te.email)
),
vi as (
  select te.email, v.id as verification_item_id
  from target_emails te
  join verification_items v on v.candidate_id in (select candidate_id from cand where cand.email = te.email)
)
select
  te.email,
  (select count(*) from cand where cand.email = te.email) as candidates,
  (select count(*) from ev where ev.email = te.email) as email_verifications,
  (select count(*) from login_tokens lt
     where lt.email = te.email
        or lt.candidate_id in (select candidate_id from cand where cand.email = te.email)) as login_tokens,
  (select count(*) from candidate_sessions cs
     where cs.candidate_id in (select candidate_id from cand where cand.email = te.email)) as candidate_sessions,
  (select count(*) from rd where rd.email = te.email) as resume_documents,
  (select count(*) from work_history_items w
     where w.candidate_id in (select candidate_id from cand where cand.email = te.email)
        or w.resume_document_id in (select resume_document_id from rd where rd.email = te.email)) as work_history_items,
  (select count(*) from education_items x
     where x.candidate_id in (select candidate_id from cand where cand.email = te.email)
        or x.resume_document_id in (select resume_document_id from rd where rd.email = te.email)) as education_items,
  (select count(*) from certification_items c
     where c.candidate_id in (select candidate_id from cand where cand.email = te.email)
        or c.resume_document_id in (select resume_document_id from rd where rd.email = te.email)) as certification_items,
  (select count(*) from candidate_freeform_sections f
     where f.candidate_id in (select candidate_id from cand where cand.email = te.email)
        or f.resume_document_id in (select resume_document_id from rd where rd.email = te.email)) as candidate_freeform_sections,
  (select count(*) from vi where vi.email = te.email) as verification_items,
  (select count(*) from verification_item_timeline t
     where t.item_id in (select verification_item_id from vi where vi.email = te.email)) as verification_item_timeline
from target_emails te
order by te.email;


-- ============================================================================
-- SECTION 2: DELETE (destructive) — run only after reviewing the report above.
-- A temp table holds the target list once, so every delete below reads from the
-- same single source instead of repeating the email list per statement — edit
-- the "EDIT THIS" block and every statement in this section follows it.
-- ============================================================================

-- EDIT THIS: target email(s). Must match what you reviewed in the report above.
create temporary table _reset_target_emails (email text primary key) on commit drop;
insert into _reset_target_emails (email) values
  ('jpirone@yahoo.com'),
  ('john.pirone@gmail.com'),
  ('john.pirone@proton.me');

delete from verification_item_timeline
where item_id in (
  select id from verification_items
  where candidate_id in (
    select id from candidates where email in (select email from _reset_target_emails)
  )
);

delete from verification_items
where candidate_id in (
  select id from candidates where email in (select email from _reset_target_emails)
);

delete from work_history_items
where candidate_id in (
  select id from candidates where email in (select email from _reset_target_emails)
) or resume_document_id in (
  select id from resume_documents
  where candidate_id in (select id from candidates where email in (select email from _reset_target_emails))
     or email_verification_id in (select id from email_verifications where email in (select email from _reset_target_emails))
);

delete from education_items
where candidate_id in (
  select id from candidates where email in (select email from _reset_target_emails)
) or resume_document_id in (
  select id from resume_documents
  where candidate_id in (select id from candidates where email in (select email from _reset_target_emails))
     or email_verification_id in (select id from email_verifications where email in (select email from _reset_target_emails))
);

delete from certification_items
where candidate_id in (
  select id from candidates where email in (select email from _reset_target_emails)
) or resume_document_id in (
  select id from resume_documents
  where candidate_id in (select id from candidates where email in (select email from _reset_target_emails))
     or email_verification_id in (select id from email_verifications where email in (select email from _reset_target_emails))
);

delete from candidate_freeform_sections
where candidate_id in (
  select id from candidates where email in (select email from _reset_target_emails)
) or resume_document_id in (
  select id from resume_documents
  where candidate_id in (select id from candidates where email in (select email from _reset_target_emails))
     or email_verification_id in (select id from email_verifications where email in (select email from _reset_target_emails))
);

delete from resume_documents
where candidate_id in (
  select id from candidates where email in (select email from _reset_target_emails)
) or email_verification_id in (
  select id from email_verifications where email in (select email from _reset_target_emails)
);

delete from candidate_sessions
where candidate_id in (
  select id from candidates where email in (select email from _reset_target_emails)
);

delete from login_tokens
where email in (select email from _reset_target_emails)
   or candidate_id in (
     select id from candidates where email in (select email from _reset_target_emails)
   );

delete from candidates
where email in (select email from _reset_target_emails);

delete from email_verifications
where email in (select email from _reset_target_emails);

drop table _reset_target_emails;
