-- Fix real bug found during this feature's own live verification (2026-09-27): create_work_overlap_hold's
-- claim-building query aliased its derived table's column as `v_pair`, the exact same name as the
-- PL/pgSQL loop variable declared above it -- Postgres raised "column reference v_pair is ambiguous" on
-- every real call, so no hold (and no linked verification_items row) was EVER actually created; the main
-- confirm/apply commit that precedes this call had already succeeded by that point, so the candidate saw
-- a real 500 (overlap_hold_failed / their resubmission's own apply_failed) with their profile confirmed
-- underneath it and no hold protecting it -- confirmed live via a direct RPC call reproducing the exact
-- error before this fix. Renamed the derived table's column alias to `pair_data` (only reference inside
-- this function; no other caller touches it), no behavior change otherwise.
create or replace function create_work_overlap_hold(p_candidate uuid, p_pairs jsonb, p_source text, p_action text, p_explanation text)
returns text
language plpgsql security definer set search_path = public as $$
declare
  v_hold_id uuid;
  v_qid text;
  v_priority text := case when p_action = 'ignored' then 'urgent' else 'normal' end;
  v_pair jsonb;
  v_claim text;
  v_count integer;
  v_first_label text;
begin
  if p_action not in ('explained', 'ignored') then raise exception 'bad_action'; end if;
  if p_action = 'explained' and coalesce(btrim(p_explanation), '') = '' then raise exception 'explanation_required'; end if;
  select count(*) into v_count from jsonb_array_elements(p_pairs);
  if v_count = 0 then raise exception 'no_pairs'; end if;

  insert into work_overlap_holds (candidate_id, source, action, explanation, action_at, queue_priority)
    values (p_candidate, p_source, p_action, case when p_action = 'explained' then btrim(p_explanation) else null end, now(), v_priority)
    returning id into v_hold_id;

  for v_pair in select * from jsonb_array_elements(p_pairs) loop
    insert into work_overlap_pairs (hold_id, item_a_id, item_b_id, overlap_days)
      values (v_hold_id, (v_pair->>'a')::uuid, (v_pair->>'b')::uuid, (v_pair->>'days')::integer);
  end loop;

  select (coalesce(nullif(btrim(w1.title), ''), 'Untitled') || ' at ' || coalesce(nullif(btrim(w1.company), ''), 'unknown employer')
          || ' overlaps ' || (p.pair_data->>'days')::text || 'd with ' || coalesce(nullif(btrim(w2.title), ''), 'Untitled') || ' at ' || coalesce(nullif(btrim(w2.company), ''), 'unknown employer'))
    into v_first_label
    from (select * from jsonb_array_elements(p_pairs) limit 1) p(pair_data)
    join work_history_items w1 on w1.id = (p.pair_data->>'a')::uuid
    join work_history_items w2 on w2.id = (p.pair_data->>'b')::uuid;
  v_claim := v_first_label || case when v_count > 1 then ' (+' || (v_count - 1)::text || ' more pair' || case when v_count - 1 = 1 then '' else 's' end || ')' else '' end;

  v_qid := nextval_verification_item_id();
  insert into verification_items (id, candidate_id, type, claim, received, status, internal_note)
    values (v_qid, p_candidate, 'Overlap', v_claim, current_date, 'New',
      case when p_action = 'ignored' then 'Candidate chose to ignore this overlap without an explanation. Elevated priority.' else null end);

  update work_overlap_holds set verification_item_id = v_qid where id = v_hold_id;
  return v_qid;
end;
$$;
revoke all on function create_work_overlap_hold(uuid, jsonb, text, text, text) from public, anon, authenticated;
grant execute on function create_work_overlap_hold(uuid, jsonb, text, text, text) to service_role;
