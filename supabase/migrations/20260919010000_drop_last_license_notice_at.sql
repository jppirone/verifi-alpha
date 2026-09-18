-- The 10-minute per-candidate email coalescing window is gone: correction notices are now bundled
-- structurally (one email names every license awaiting notification, and a license is flagged
-- notified only in the same atomic step that puts it in an email), so this column has no readers.
alter table candidates drop column if exists last_license_notice_at;
