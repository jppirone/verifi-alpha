-- Cross-category position misordering fix, part 1 of 2 (2026-09-28, live-reported and reproduced on
-- Aurora Clark's resume): a clean, single-column resume with "RECENT TECHNICAL SKILLS" printed
-- directly above "PROFESSIONAL EXPERIENCE" came back with that section wedged between two jobs
-- instead of before all of them. Root cause (see extract-resume-fields/index.ts's dedupePositions
-- header for the full story, mirrored in upload-resume/index.ts's own copy): the per-item "position"
-- integer each extraction call emits is unreliable bookkeeping the model keeps by hand while juggling
-- several JSON arrays at once, unlike each section's CATEGORY, which the separate, already-reliable
-- section-boundary-detection call gets right and which upload-resume already computes per PDF page
-- (rasterize-pdf-page's own boundary-detection call) but never persisted or carried forward past that
-- one request/response — only the already-structured `extraction` was checkpointed, so nothing
-- downstream (the cross-page merge, the final dedup/renumber pass) had that page's own, correctly-
-- ordered section list to cross-check the model's position numbers against. This column lets
-- rasterize-pdf-page's per-page boundary result survive a checkpoint (and a resumed, later
-- invocation reading it back from this table) so upload-resume's merge/dedup step can use it.
alter table public.resume_extraction_pages
  add column if not exists section_boundaries jsonb null;

comment on column public.resume_extraction_pages.section_boundaries is
  'Per-page section-boundary-detection result (BoundaryResult: {sections:[{heading,category}], ...}) from rasterize-pdf-page, checkpointed so a later invocation (or the final merge/dedup pass) can use each page''s own true reading-order section list to correct cross-category position ordering, not just re-derive extraction data. Null for pages read before this column existed.';
