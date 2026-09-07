-- Item C (2026-09-08 regression session): the new, optional "employer/certification contact
-- details" interim screen — shown once, after resumeConfirm's confirmation completes and before
-- the candidate reaches the account screen. Every field here is candidate-stated and never
-- validated (that's the whole point — it's a hint for staff outreach, not a claim staff verify
-- against). No education section: National Student Clearinghouse already covers the large majority
-- of institutions under a canonical name, and the ambiguous remainder already routes through the
-- existing human-review rule.

-- Employer section fields, per work_history_items row. contact_name is deliberately independent of
-- contact_phone (a candidate may know a phone number — HR line, front desk, main number — with no
-- specific person's name attached, or the person they once knew there may no longer work there) —
-- neither field requires the other.
alter table work_history_items add column if not exists employer_name_override text;
alter table work_history_items add column if not exists employer_location_override text;
alter table work_history_items add column if not exists contact_phone text;
alter table work_history_items add column if not exists contact_name text;

-- Certification section fields, per certification_items row. No contact_name here (not asked for —
-- see the item's own spec): a badge/verification link plus a phone number at the issuing body is
-- the whole ask.
alter table certification_items add column if not exists verification_link text;
alter table certification_items add column if not exists contact_phone text;

-- The real "was this optional step reached and resolved" signal this screen needs — same class of
-- gap Item 1 (Priority 1, this morning) fixed for "continue without resume data"
-- (continued_without_data_at): without a real tracked signal, a refresh or browser close mid-entry
-- has no way to distinguish "never reached this screen," "reached it and is still filling it in,"
-- and "explicitly skipped or submitted it" — session-routing logic needs to tell those apart. Set
-- on EITHER a real submission (resolve-employer-contact-details with data) or an explicit Skip
-- (same endpoint, empty arrays) — both count as "resolved," matching skip-resume-extraction's own
-- precedent that skipping is a real, tracked choice, not silently indistinguishable from never
-- having been asked.
alter table resume_documents add column if not exists employer_contact_resolved_at timestamptz;

-- Real dead end this closes, discovered building this item's staff-visibility requirement (not
-- speculative — this is what makes it possible, not future scope): verification_items had no way
-- at all to trace a row back to the specific work_history_items/certification_items row it came
-- from (confirmed before writing this: no such column existed anywhere on the table). Without it,
-- "surface a known contact/entity hint in the staff queue item detail view" has nothing to join on.
-- Deliberately no foreign-key constraint: this is polymorphic (a "Job Experience" row's
-- source_item_id points into work_history_items; a "Certification" row's points into
-- certification_items; an "Education" row's into education_items; "Needs Review" rows have no
-- source item at all and stay null) — a single FK target isn't possible, and list-verification-items
-- (see its own header) is what actually needs verification_items.type to know which table to look
-- in, which single-target FK enforcement can't express anyway.
alter table verification_items add column if not exists source_item_id uuid;
