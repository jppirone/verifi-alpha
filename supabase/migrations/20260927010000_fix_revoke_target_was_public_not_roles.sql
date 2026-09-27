-- Fix for 20260927000000: verified after applying it that the REVOKE had NO effect -- anon and
-- authenticated still show has_function_privilege(...) = true for every one of the 20 functions.
--
-- Root cause of that no-op: none of these functions was ever granted EXECUTE directly to anon or
-- authenticated. Postgres grants EXECUTE to the PUBLIC pseudo-role on every new function by default, and
-- anon/authenticated exercise that as ordinary members of PUBLIC (every role is). `revoke ... from anon,
-- authenticated` only removes a grant made DIRECTLY to those role names -- since none existed, there was
-- nothing to remove, and the PUBLIC-level default kept granting access regardless. The actual fix is
-- `revoke ... from public`, which removes the default itself.
--
-- Two of these (create_comparison_request_direct, insert_resume_extraction's current 14-arg overload)
-- never had ANY explicit grant to service_role either (see 20260927000000's own header) -- they have been
-- running purely on the same PUBLIC default this whole time. Revoking from PUBLIC without also granting
-- service_role explicitly would have broken their real, legitimate edge-function callers (employer-api's
-- create_comparison_request_direct calls, upload-resume's insert_resume_extraction calls) the moment this
-- migration ran. This migration adds that explicit grant in the same breath as the corrected revoke, so
-- service_role's access is never interrupted for either function.

-- ---- real, directly-callable helpers ----
revoke execute on function public.backfill_resume_pipeline_candidate_id(uuid, uuid) from public;
revoke execute on function public.claim_stripe_event(text, text, text) from public;
revoke execute on function public.cleanup_employer_auth() from public;
revoke execute on function public.cleanup_employer_billing() from public;
revoke execute on function public.cleanup_expired_employer_lookups() from public;
revoke execute on function public.cleanup_expired_unconfirmed_resume_data() from public;
revoke execute on function public.consume_org_lookup(uuid, uuid, text) from public;
revoke execute on function public.discard_resume_document(uuid, uuid) from public;
revoke execute on function public.employer_owns_stripe_ids(text, text, text) from public;
revoke execute on function public.finish_stripe_event(text, text) from public;
revoke execute on function public.issue_requester_session(uuid, uuid, uuid, text, text, timestamptz) from public;
revoke execute on function public.issue_verification_requester_session(uuid, uuid, uuid, text, text, timestamptz) from public;
revoke execute on function public.nextval_verification_item_id() from public;
revoke execute on function public.redeem_employer_payment(uuid, text) from public;
revoke execute on function public.release_stripe_event(text, text) from public;

-- these two never had an explicit service_role grant -- revoke from PUBLIC, then grant service_role
-- explicitly in the same statement group so there is no gap where NO role can call them.
revoke execute on function public.create_comparison_request_direct(uuid, text, uuid, text, uuid, uuid, text) from public;
grant execute on function public.create_comparison_request_direct(uuid, text, uuid, text, uuid, uuid, text) to service_role;
revoke execute on function public.insert_resume_extraction(uuid, uuid, jsonb, jsonb, jsonb, jsonb, integer, jsonb, text, text, text, text, text, text) from public;
grant execute on function public.insert_resume_extraction(uuid, uuid, jsonb, jsonb, jsonb, jsonb, integer, jsonb, text, text, text, text, text, text) to service_role;

-- ---- this project's own trigger functions: still pure hygiene (see 20260927000000's own comment on why
-- these were never actually exploitable regardless of grant), corrected to the right target the same way.
revoke execute on function public.trg_account_deletion_log_on_reactivation() from public;
revoke execute on function public.trg_purge_comparisons_on_deactivation() from public;
revoke execute on function public.trg_queue_employer_document_purge() from public;
