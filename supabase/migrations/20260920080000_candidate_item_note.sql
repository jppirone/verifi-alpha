-- A candidate can add a note for staff on an Education queue item and edit + resubmit it (2026-09-20).
--
-- candidate_note: the candidate's latest explanation, shown to staff on the item and back to the candidate on their own row.
-- Every edit / note is ALSO written to verification_item_timeline (actor "Candidate", fixed server-side) so the history stays append-only;
-- this column only holds the latest text so the queue can flag "has a candidate note" without reading every timeline row.
alter table public.verification_items
  add column if not exists candidate_note text,
  add column if not exists candidate_note_at timestamptz;

comment on column public.verification_items.candidate_note is 'Latest note the candidate left for staff on this item (max 1000 chars, written only by submit-candidate-correction-response). Full history is in verification_item_timeline.';
