-- certification_items schema groundwork (2026-09-11 status-check session): confirmed by direct
-- query earlier this session that certification_items had no issuer-type/category column, and that
-- expiration_date is written only from resume-text extraction (upload-resume/extract-resume-fields/
-- rasterize-pdf-page) or a candidate's own edit (confirm-resume-data) -- never from any verification
-- source. Both gaps block the same underlying capability: knowing, per certification, which
-- automated check (if any) actually applies to it, and knowing whether its expiration is a real,
-- checked fact or just what the resume said. This migration adds the columns only -- no application
-- code reads or writes them yet, so nothing here changes current behavior; it's the schema the
-- wiring can build on next.
--
-- issuer_category: nullable, free-text rather than an enum/check constraint for now -- the real set
-- of categories (credly-badge vs state-license vs "no automated check applies") will get firmer once
-- more than two states' worth of checks exist (see the Colorado wiring landing alongside this same
-- migration); a hard constraint today would just get altered again immediately after.
--
-- expiration_source / expiration_verified_at: separate from expiration_date itself so a future write
-- from a real automated check (e.g. a DBPR/DORA license lookup, which often returns its own
-- expiration date) can be distinguished from the resume-parsed or candidate-edited value already
-- there, without silently overwriting one with the other or losing provenance.
alter table certification_items add column if not exists issuer_category text;
alter table certification_items add column if not exists expiration_source text;
alter table certification_items add column if not exists expiration_verified_at timestamptz;
