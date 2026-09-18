-- Verification-status persistence gap (2026-09-18): confirmed live, phone/KYC/cross-validation
-- confirmation status for full-resume accounts is PURE client state today -- confirmPhoneModal,
-- confirmCvPhoneEntry, confirmKycModal, confirmCvEmailCode, and confirmCvSmsCode in candidate.html
-- all only ever call this.setState(...), no server call anywhere. Resets to false/'' on every fresh
-- mount, so a candidate who verifies from Personal Info sees it hold only until they close the tab
-- or navigate in a way that remounts -- not a case of a value existing but not being read back, per
-- the same finding already confirmed once before for KYC specifically (Item 10/11, 2026-09-13 --
-- see that migration's own header) and left unfixed there because KYC was "purely informational" and
-- "never gates anything" for full-resume accounts at the time. That's no longer true: Sharing tab's
-- LinkedIn/Indeed/Glassdoor enable-toggles gate on this exact client-only state today.
--
-- phone_verified_at: new column, no prior field existed for this at all (candidates.phone is a
-- different thing -- the original signup-time phone, set once, never re-verified).
--
-- verified_phone_number: the actual number that was verified, not just when -- a timestamp alone
-- can't answer "does the candidate's CURRENTLY entered number still match what was last verified,"
-- which candidate.html's own UI depends on throughout (phonePendingVerification, notifySmsEnabled,
-- the printed-phone-copy prompt, etc. all compare the live entry against the last confirmed value).
-- Deliberately its own column, not a repurposing of candidates.phone (that column is a different,
-- older concept -- the original signup-time phone, set once and never re-verified).
alter table candidates add column if not exists phone_verified_at timestamptz;
alter table candidates add column if not exists verified_phone_number text;

-- cross_validation_completed_at: new column, no prior field existed for this at all.
alter table candidates add column if not exists cross_validation_completed_at timestamptz;

-- kyc_verified_at: REUSED, not new -- already exists (Item 10 migration), written today only once,
-- at confirm-verification time, only for account_type = 'license_only'. This fix adds a second write
-- path (record-verification-event, post-signup, any account type) to the SAME column -- confirmed
-- with the user before building: same underlying meaning ("identity verified as of this timestamp")
-- for both account types, "reverify" just overwrites it, no new column needed.
