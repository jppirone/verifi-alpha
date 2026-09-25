-- Gap #21 (2026-09-26), headline requirement: list_employer_payments now also returns comparison_request_id,
-- so employer-api's list_payments can tell the client which past payments still have an openable comparison
-- behind them (via open_paid_comparison) instead of only ever linking to the Stripe receipt.
drop function if exists list_employer_payments(text);
create or replace function list_employer_payments(p_email text)
returns table(id uuid, amount_cents integer, currency text, kind text, candidate_label text, company text, status text, paid_at timestamptz, created_at timestamptz, receipt_url text, comparison_request_id uuid)
language sql stable security definer set search_path = public as $$
  select p.id, p.amount_cents, p.currency, p.request_kind, p.candidate_label, p.requester_company, p.status, p.paid_at, p.created_at, p.receipt_url, p.comparison_request_id
  from employer_payments p
  where lower(p.payer_email) = lower(p_email)
    and p.status in ('paid', 'refunded', 'needs_review')
  order by coalesce(p.paid_at, p.created_at) desc
  limit 200
$$;
revoke all on function list_employer_payments(text) from public, anon, authenticated;
grant execute on function list_employer_payments(text) to service_role;
