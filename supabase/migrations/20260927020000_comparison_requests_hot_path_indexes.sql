-- Performance advisor follow-up (2026-09-27, same pass as the security-definer grant fix): flagged 38
-- unindexed foreign keys app-wide. Deliberately NOT doing a blanket pass -- at this database's current
-- near-zero real data volume, adding an index for every FK is optimizing against traffic that doesn't
-- exist yet, and every index has a real ongoing write-side cost. See verifi-perf-advisor-unindexed-fks-open
-- (memory) for the rest, left untouched until there is real usage data to judge them against.
--
-- These two are the exception: not speculative, already the exact columns sitting in hot WHERE clauses in
-- shipped code (employer-api.ts) --
--   list_my_paid_comparisons: comparison_requests?employer_user_id=eq.<id>&access_method=eq.guest&order=created_at.desc
--   list_comparisons (org):   comparison_requests?org_id=eq.<id>&order=created_at.desc  (owner)
--                              comparison_requests?employer_user_id=eq.<id>&org_id=eq.<id>&order=created_at.desc  (member)
-- both called on every employer account-page load. Composite with created_at desc, matching this table's
-- own existing convention (comparison_requests_candidate_idx, comparison_requests_requester_idx), so the
-- index also covers the ORDER BY instead of just the filter.

create index if not exists comparison_requests_employer_user_idx on comparison_requests (employer_user_id, created_at desc);
create index if not exists comparison_requests_org_idx on comparison_requests (org_id, created_at desc);
