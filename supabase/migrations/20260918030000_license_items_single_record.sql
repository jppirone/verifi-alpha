-- license_items becomes a strict 1:1 verification extension of a certification_items row.
-- certification_items stays the single record of the credential's descriptive fields (name, issuing
-- body, number, dates, heading, position, trade) because Customization, the PDF build, the employer-
-- contact screen and the certification queue path all read it. license_items keeps only what is
-- specific to being a state-verifiable license: state (+ evidence), verification outcome, and the
-- candidate self-correction loop state. Safe to drop the duplicated columns: the table is verified
-- empty below (only test rows existed, already cleaned up).
do $$
begin
  if (select count(*) from license_items) > 0 then
    raise exception 'license_items is not empty; refusing to drop columns';
  end if;
end $$;

alter table license_items
  drop column if exists license_number,
  drop column if exists license_name,
  drop column if exists issuing_body,
  drop column if exists trade_soc_code,
  drop column if exists issue_date,
  drop column if exists expiration_date;

alter table license_items alter column linked_certification_id set not null;
alter table license_items add constraint license_items_linked_certification_id_key unique (linked_certification_id);

-- Self-correction loop (wrong state / wrong number): a clean not_found or an unsupported jurisdiction
-- on a first check is returned to the candidate rather than queued for staff.
alter table license_items add column if not exists verification_attempts integer not null default 0;
alter table license_items add column if not exists checked_state text;
alter table license_items add column if not exists checked_number text;
alter table license_items add column if not exists correction_status text;      -- null | requested | dismissed
alter table license_items add column if not exists correction_reason text;      -- not_found | unsupported_jurisdiction
alter table license_items add column if not exists correction_message text;
alter table license_items add column if not exists correction_requested_at timestamptz;
