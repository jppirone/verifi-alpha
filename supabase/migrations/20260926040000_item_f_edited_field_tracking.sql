-- Item F (2026-09-26): durable, per-field record of which fields on a confirmed item the candidate
-- actually edited on the resumeConfirm review screen, before submitting -- previously this distinction
-- existed nowhere at all (not even for dates/headings, whose "_edited" flags were purely client-side
-- and never transmitted). See confirm-resume-data's own whitelistEditedFields()/EDITABLE_FIELDS for
-- what gets written here, and candidate.html's editAckOpen modal for the recorded acknowledgment this
-- pairs with. Building the staff-facing surface for this, and any routing it triggers, is explicitly
-- out of scope (Item G) -- this migration only adds the place to durably record it.
--
-- One jsonb column per table rather than one boolean column per field: same information
-- ({"company": true, "start_date": true}, only edited fields present as keys), far smaller migration
-- surface across five tables and however many fields each has, and still fully queryable
-- (candidate_edited_fields ? 'company'). Nullable, default null: null means "nothing was edited",
-- distinct from an empty object, so a caller can tell "no edits" apart from "the column was touched"
-- without a second check.
alter table work_history_items add column if not exists candidate_edited_fields jsonb;
alter table education_items add column if not exists candidate_edited_fields jsonb;
alter table certification_items add column if not exists candidate_edited_fields jsonb;
alter table skill_items add column if not exists candidate_edited_fields jsonb;
alter table candidate_freeform_sections add column if not exists candidate_edited_fields jsonb;

-- The acknowledgment itself, recorded once per resume_document at confirm time -- same shape and same
-- reasoning as resume_resubmissions' own ack_at/ack_text_version (resume-resubmission's "start" action):
-- a real, durable record that this specific wording was shown and accepted, not just a client-side
-- modal dismissal. Stays null on any document where nothing was edited (no acknowledgment was ever
-- required).
alter table resume_documents add column if not exists edit_ack_at timestamptz;
alter table resume_documents add column if not exists edit_ack_text_version text;
