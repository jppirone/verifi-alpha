-- Gap #23 residual follow-up (2026-09-27): resume_extraction_pages used to be deleted immediately on
-- successful finalization (upload-resume/index.ts, right after the merged result was inserted) -- by design,
-- per its own original header comment ("Rows are deleted once the resume is merged ... this is scratch
-- space"). That made the raw per-page extraction (the actual model output before merge, including the
-- per-page `position` values a same-page cross-category ordering bug traces back to) permanently
-- unrecoverable the moment a resume finished processing, which is exactly what blocked investigating the
-- Gap #23 residual (Workplace Strengths sometimes sorting after Education instead of before, a same-page
-- position misassignment -- see that item's own memory note; still open, still deprioritized, NOT fixed by
-- this migration).
--
-- This does not change extraction, merging, or delivery in any way -- only how long the scratch rows survive
-- afterward. Deliberately NOT an automatic reordering fix (a hardcoded section-priority rule would be
-- deterministic but wrong for other documents with a genuinely different true order -- see that
-- investigation's own conclusion); this only turns "permanently unrecoverable" into "investigable for 7 days"
-- if a real case gets reported, matching the same bounded-retention-plus-sweep pattern already used
-- everywhere else in this project (cleanup_expired_unconfirmed_resume_data, cleanup_expired_employer_lookups,
-- purge-resume-storage) rather than inventing a new one.
--
-- created_at (already on every row, set at checkpoint time) is the retention clock: a page is swept once it
-- is more than 7 days old, regardless of the owning document's extraction_status (extracted or failed both
-- count -- both are equally "scratch" once processing has stopped). Safe against ever touching a still-active
-- extraction: EXTRACTION_LEASE_MS (150s) and MAX_EXTRACTION_STALLS (3 claims) together bound how long a
-- document can remain genuinely mid-extraction to well under a day, nowhere near the 7-day window.

create or replace function cleanup_expired_resume_extraction_pages() returns integer
language plpgsql security definer set search_path = public as $$
declare n integer;
begin
  delete from resume_extraction_pages where created_at < now() - interval '7 days';
  get diagnostics n = row_count;
  return n;
end;
$$;
revoke execute on function cleanup_expired_resume_extraction_pages() from public;
grant execute on function cleanup_expired_resume_extraction_pages() to service_role;

select cron.schedule(
  'cleanup-expired-resume-extraction-pages',
  '7 * * * *',
  $$select public.cleanup_expired_resume_extraction_pages()$$
);
