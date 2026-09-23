-- Document lifetime tied to the request's real status, not a fixed clock (2026-09-23).
--
-- Follow-up to 20260923020000, found while verifying that migration's per-kind ceiling against all three kinds,
-- not just the resume_comparison case that originally surfaced the bug. org/resume_comparison (105-day ceiling
-- over a real ~100-day worst case) and org/license_report (45-day ceiling over a real ~40-day worst case) check
-- out: both have the same ~5-day margin, confirmed directly against expire_comparison_requests' own 90-day and
-- 30-day reopen-window constants, not assumed.
--
-- The guest kind (flat 21-day ceiling) does NOT check out, and not merely by an undersized number -- a FIXED
-- ceiling is the wrong shape of fix for it. employer-stripe-events.ts's markGuestAuthorized extends a still-
-- unopened request's snapshot_expires_at to (hold-authorized-at + 7 days) whenever that is later than the
-- current value ("card holds run about 7 days ... never shorten an existing later expiry"). Because that only
-- ever ratchets forward and can fire again on a later retry, a guest's real "still legitimately awaiting first
-- open" window has no fixed upper bound at all -- a determined guest retrying roughly every 7 days could in
-- principle keep a request (and therefore its document) alive far past any ceiling we pick. The realistic
-- (non-adversarial) worst case is about 17 days (72h to approve + a single late hold extension to ~14 days +
-- the 30-minute view window), already past the previous flat 21-day ceiling's comfortable margin -- and the
-- adversarial case has no ceiling at all.
--
-- Real fix: a BOUND document's lifetime is no longer decided by any fixed clock. It is deleted exactly when its
-- owning request reaches a genuinely terminal status (declined or expired) -- which expire_comparison_requests
-- already computes correctly and completely, including every extension mechanism, present or future, because it
-- reads the request's live state directly rather than approximating it with a separately-maintained number that
-- can drift out of sync. An UNBOUND document (never attached to any request -- an upload that was abandoned)
-- keeps its own, unrelated, original 1-hour purge_after clock; that one is a real fixed deadline with no
-- corresponding "still legitimately alive" state to track.
--
-- purge_after on a BOUND row is no longer read by anything that decides whether to serve the document (see the
-- companion edge-function changes to employer-api.ts, employer-comparison/index.ts and
-- candidate-comparison-requests/index.ts) -- it remains only as a generous display estimate (candidate.html's
-- "kept until" text, and the staff abuse-investigation view's OWN deliberately stricter, earlier cutoff, which
-- is intentional and unaffected by this change). create_comparison_request's per-kind ceiling computation
-- (105/45/21 days) is left as-is for that purpose -- it is a reasonable estimate even though it is no longer the
-- source of truth for actual availability.

create or replace function expire_comparison_requests() returns json
language plpgsql security definer set search_path = public as $$
declare a integer; b integer; docs integer;
begin
  update comparison_requests set status = 'expired', responded_at = coalesce(responded_at, now())
   where status = 'pending' and expires_at < now();
  get diagnostics a = row_count;

  with gone as (
    update comparison_requests set status = 'expired', closed_at = coalesce(closed_at, now())
     where status = 'approved'
       and ((first_delivered_at is null and snapshot_expires_at is not null and snapshot_expires_at < now())
         or (access_method = 'org' and kind = 'resume_comparison' and first_delivered_at is not null and first_delivered_at < now() - interval '90 days')
         or (access_method = 'org' and kind = 'license_report' and first_delivered_at is not null and first_delivered_at < now() - interval '30 days')
         or (access_method = 'guest' and first_delivered_at is not null and view_window_ends_at is not null and view_window_ends_at < now()))
    returning id
  ), flagged as (
    update employer_payments set status = 'needs_review'
     where comparison_request_id in (select id from gone) and status = 'paid' and redeemed_at is null
    returning id
  )
  delete from comparison_snapshots where request_id in (select id from gone);
  get diagnostics b = row_count;

  -- Bound documents purge exactly when their owning request is genuinely terminal (declined or expired, from any
  -- path) -- checked live against comparison_requests.status, never against a fixed clock, so this can never be
  -- undersized regardless of how long a request's real access window turns out to be, now or from any future
  -- extension mechanism. Unbound documents (request_id is null: an upload never attached to a request) keep
  -- their own independent 1-hour purge_after, unrelated to any of this.
  delete from comparison_request_documents d
   where (d.request_id is null and d.purge_after < now())
      or (d.request_id is not null and exists (select 1 from comparison_requests r where r.id = d.request_id and r.status in ('declined', 'expired')));
  get diagnostics docs = row_count;
  return json_build_object('pending_expired', a, 'snapshots_purged', b, 'documents_purged', docs);
end $$;
revoke all on function expire_comparison_requests() from public, anon, authenticated;
grant execute on function expire_comparison_requests() to service_role;
