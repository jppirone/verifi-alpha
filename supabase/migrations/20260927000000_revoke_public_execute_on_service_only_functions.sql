-- Security hardening (2026-09-27): the Supabase security advisor flags 21 SECURITY DEFINER functions as
-- directly callable via /rest/v1/rpc/<name> by the anon AND authenticated roles -- i.e. by anyone holding
-- just the public anon key, no session, no edge-function-level auth/ownership/rate-limit check at all.
--
-- ROOT CAUSE, confirmed per-function against migration history, not assumed: every one of these functions
-- is a server-only helper meant to be called ONLY by this project's own edge functions, which always use
-- the service_role key. Every function EXCEPT create_comparison_request_direct and the current 14-arg
-- insert_resume_extraction was already given an explicit `grant execute ... to service_role` at creation --
-- proving the original author's intent was service_role-only every time. Postgres grants EXECUTE to PUBLIC
-- on every new function by default; a migration that adds the service_role grant but never REVOKEs the
-- PUBLIC default leaves both anon and authenticated (both of which are members of PUBLIC) able to call it
-- directly too. That is the actual bug: a missing REVOKE, not a missing GRANT -- this migration adds
-- exactly that missing REVOKE, function by function, to every one that should never have had it.
--
-- create_comparison_request_direct (20260926020000_gap22_comparison_visibility_setting.sql) and the
-- current insert_resume_extraction(...,p_candidate_phone,p_candidate_email) overload
-- (20260923040000_resume_contact_extraction.sql) never had ANY grant statement at all -- both are genuine
-- oversights from those migrations, not something this file is second-guessing; every EARLIER overload of
-- insert_resume_extraction already carries its own service_role-only grant, confirming the pattern held
-- until these two slipped.
--
-- NOT touched here: create_comparison_request, expire_comparison_requests, purge_candidate_comparisons,
-- list_orphan_employer_objects and every other function already carrying an explicit service_role grant
-- with no anon/authenticated advisor flag -- they were already correctly locked down and are not in scope.
-- Also not touched: rls_auto_enable(), a Supabase-platform-owned event trigger function (not authored in
-- this project's own migrations) -- see this migration's own tail comment for why it is deliberately left
-- as-is despite still appearing in the advisor.

-- ---- real, directly-callable helpers (the actual exploitable surface) ----
revoke execute on function public.backfill_resume_pipeline_candidate_id(uuid, uuid) from anon, authenticated;
revoke execute on function public.claim_stripe_event(text, text, text) from anon, authenticated;
revoke execute on function public.cleanup_employer_auth() from anon, authenticated;
revoke execute on function public.cleanup_employer_billing() from anon, authenticated;
revoke execute on function public.cleanup_expired_employer_lookups() from anon, authenticated;
revoke execute on function public.cleanup_expired_unconfirmed_resume_data() from anon, authenticated;
revoke execute on function public.consume_org_lookup(uuid, uuid, text) from anon, authenticated;
revoke execute on function public.create_comparison_request_direct(uuid, text, uuid, text, uuid, uuid, text) from anon, authenticated;
revoke execute on function public.discard_resume_document(uuid, uuid) from anon, authenticated;
revoke execute on function public.employer_owns_stripe_ids(text, text, text) from anon, authenticated;
revoke execute on function public.finish_stripe_event(text, text) from anon, authenticated;
revoke execute on function public.insert_resume_extraction(uuid, uuid, jsonb, jsonb, jsonb, jsonb, integer, jsonb, text, text, text, text, text, text) from anon, authenticated;
revoke execute on function public.issue_requester_session(uuid, uuid, uuid, text, text, timestamptz) from anon, authenticated;
revoke execute on function public.issue_verification_requester_session(uuid, uuid, uuid, text, text, timestamptz) from anon, authenticated;
revoke execute on function public.nextval_verification_item_id() from anon, authenticated;
revoke execute on function public.redeem_employer_payment(uuid, text) from anon, authenticated;
revoke execute on function public.release_stripe_event(text, text) from anon, authenticated;

-- ---- this project's own trigger functions (return type `trigger`): Postgres refuses to invoke these
-- directly outside real trigger context regardless of grants, so there is no real exploitable path here --
-- this is pure hygiene to clear the advisor's (technically accurate, practically inert) flag, and it cannot
-- break the triggers themselves: trigger firing is not gated by the firing role's own EXECUTE privilege on
-- the trigger function, only by DML privilege on the table, so every deactivation/reactivation/document-
-- purge trigger keeps working unchanged for every role after this. ----
revoke execute on function public.trg_account_deletion_log_on_reactivation() from anon, authenticated;
revoke execute on function public.trg_purge_comparisons_on_deactivation() from anon, authenticated;
revoke execute on function public.trg_queue_employer_document_purge() from anon, authenticated;

-- rls_auto_enable() is intentionally NOT revoked here: it is a Supabase-platform-installed event trigger
-- function (return type `event_trigger`, not created by any migration in this repo), so it is not this
-- project's function to modify, and -- like the trigger functions above -- Postgres already refuses to
-- invoke an event-trigger-returning function directly outside real event-trigger context, so the advisor's
-- flag on it was never a real exploitable path either.
