-- Candidate item-flagging (2026-09-23). A candidate reviewing extracted resume data currently has
-- no way to flag or annotate an individual item that's wrong (or that IS correct but reads like the
-- pipeline misjudged it) -- their only recourse is a full resume re-upload, which does nothing when
-- the real problem is a pipeline bug rather than something a re-upload would fix. This adds a real
-- per-item flag+note, usable at two points: pre-confirm (on the draft item itself, right after
-- upload) and post-confirm (on the resulting verification_items row, once one exists).
--
-- Deliberately a separate boolean + note pair, not a new verification_items.status value: status is
-- a single column, so setting it to something like 'Flagged by Candidate' would silently overwrite
-- whatever real status was there (New/Confirmed/Discrepancy/...), with no column to recover it. A
-- flag alongside status keeps the real state visible to staff at all times.
--
-- Scope: the five categories actually rendered as individual, flaggable items on the candidate's
-- review screen -- work_history, education, certifications, skills, freeform sections. License rows
-- are deliberately NOT given their own flag columns here: license_items already has its own, separate
-- correction mechanism (correction_status/correction_reason/correction_message, parallel to this one)
-- and doesn't reliably have a verification_items row to flag post-confirm (verify-license only creates
-- one when a check needs staff attention) -- flagging a license candidate uses the certification card's
-- flag instead, since on the review screen a license IS a certification row plus its state sub-form,
-- one card, one flag.
--
-- verification_items already has candidate_note/candidate_note_at (added 2026-09-20 for the
-- Education-resubmit note flow) -- reused here as the flag's note rather than adding a duplicate
-- column. Only the boolean is new on that table.

alter table public.work_history_items add column if not exists flagged_by_candidate boolean not null default false;
alter table public.work_history_items add column if not exists candidate_flag_note text;
alter table public.work_history_items add column if not exists candidate_flag_note_at timestamptz;

alter table public.education_items add column if not exists flagged_by_candidate boolean not null default false;
alter table public.education_items add column if not exists candidate_flag_note text;
alter table public.education_items add column if not exists candidate_flag_note_at timestamptz;

alter table public.certification_items add column if not exists flagged_by_candidate boolean not null default false;
alter table public.certification_items add column if not exists candidate_flag_note text;
alter table public.certification_items add column if not exists candidate_flag_note_at timestamptz;

alter table public.skill_items add column if not exists flagged_by_candidate boolean not null default false;
alter table public.skill_items add column if not exists candidate_flag_note text;
alter table public.skill_items add column if not exists candidate_flag_note_at timestamptz;

alter table public.candidate_freeform_sections add column if not exists flagged_by_candidate boolean not null default false;
alter table public.candidate_freeform_sections add column if not exists candidate_flag_note text;
alter table public.candidate_freeform_sections add column if not exists candidate_flag_note_at timestamptz;

alter table public.verification_items add column if not exists flagged_by_candidate boolean not null default false;

comment on column public.work_history_items.flagged_by_candidate is 'Candidate flagged this item as wrong (or wrongly judged) during resume review. See candidate_flag_note. Carried forward onto the resulting verification_items row (flagged_by_candidate + candidate_note) by confirm-resume-data when one is created for this item.';
comment on column public.verification_items.flagged_by_candidate is 'Candidate flagged this item (pre-confirm carry-over, or a real-time flag from the Verification Status tab via submit-candidate-correction-response action=flag_item). Independent of status -- never overwrites it. Note is in candidate_note/candidate_note_at (shared with the pre-existing Education-resubmit note flow). Staff clears this via update-verification-item once handled.';
