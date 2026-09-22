-- Payment history, Stage 2 (2026-09-22): list a signed-in employer's own one-off payments, matched by email exactly
-- the way list_employer_lookups already matches pre-account Tier 1 lookups. Read-only. Only payments where real money
-- actually moved (paid, refunded, or the rare amount-mismatch needs_review) are "payment history" -- a placed-but-
-- uncaptured hold ('authorized') or a hold that expired uncaptured ('expired') never charged anything and is not a
-- payment made.
create or replace function list_employer_payments(p_email text)
returns table(id uuid, amount_cents integer, currency text, kind text, candidate_label text, company text, status text, paid_at timestamptz, created_at timestamptz, receipt_url text)
language sql stable security definer set search_path = public as $$
  select p.id, p.amount_cents, p.currency, p.request_kind, p.candidate_label, p.requester_company, p.status, p.paid_at, p.created_at, p.receipt_url
  from employer_payments p
  where lower(p.payer_email) = lower(p_email)
    and p.status in ('paid', 'refunded', 'needs_review')
  order by coalesce(p.paid_at, p.created_at) desc
  limit 200
$$;
revoke all on function list_employer_payments(text) from public, anon, authenticated;
grant execute on function list_employer_payments(text) to service_role;
