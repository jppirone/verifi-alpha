-- Gap #22: employer-document's new 'employer' upload mode (session-based, no lookup_id -- see that
-- function's own header) needs a matching uploader_kind value; the old constraint only allowed the two
-- pre-existing modes ('org', 'guest'). Found live: the first real test upload through the new mode failed
-- with store_failed (the storage object was written, then rolled back, because the row insert into
-- comparison_request_documents was rejected by this constraint).
alter table comparison_request_documents drop constraint comparison_request_documents_uploader_kind_check;
alter table comparison_request_documents add constraint comparison_request_documents_uploader_kind_check
  check (uploader_kind = any (array['org', 'guest', 'employer']));
