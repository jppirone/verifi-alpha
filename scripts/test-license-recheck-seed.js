// Seed generator for the live tests of the periodic license re-check (2026-09-21). FAKE ACCOUNTS ONLY (prefix e5e5e5e5, emails delivered+rc*@resend.dev).
// Evaluated in the Supabase SQL editor tab: `eval(scriptText)` returns one SQL string. The two REAL registry records used are public DBPR entries:
//   SCC131151265  Christopher Whitfield  Current, Active (the same real license the License-Only demo account uses)
//   CGC1518507    SMITH, JOHN A          Current, Inactive  (a real license that is NOT active in the registry today)
// Each account is "verified N days ago" by the automatic check, exactly as verify-license writes it: license_items outcome verified + verified_at, a
// Confirmed License queue row whose status_changed_at is just after verified_at, and a System timeline entry.
(() => {
  const U = (h) => 'e5e5e5e5-0000-4000-8000-' + String(h).padStart(12, '0');
  const q = (s) => s === null || s === undefined ? 'null' : "'" + String(s).replace(/'/g, "''") + "'";
  const out = [];
  const LAPSED = 'CGC1518507', ACTIVE = 'SCC131151265';
  // n = account number (hex), spec: who, what, and what state the license is in
  const acct = (n, s) => {
    const cid = U('a' + n), cert = U('c' + n), lic = U('1' + n), qid = 'VQ-RC' + n.toUpperCase();
    const type = s.accountType || 'full_resume';
    out.push(`insert into candidates (id,email,phone,first_name,last_name,full_name,account_type,discoverable,tier,tour_completed_at${s.deactivated ? ',deletion_scheduled_at' : ''}) values (${q(cid)},${q('delivered+rc' + n + '@resend.dev')},${q('+1555555070' + n)},${q(s.first)},${q(s.last)},${q(s.first + ' ' + s.last)},${q(type)},true,'free',now()${s.deactivated ? ",now()-interval '1 day'" : ''});`);
    const doc = U('b' + n);
    if (type === 'full_resume') out.push(`insert into resume_documents (id,candidate_id,original_storage_path,original_filename,mime_type,extraction_status,kind,confirmed_at,employer_contact_resolved_at) values (${q(doc)},${q(cid)},${q('rc-test/' + doc + '/original.pdf')},'RCMARK_resume.pdf','application/pdf','complete','initial',now()-interval '40 days',now());`);
    out.push(`insert into certification_items (id,candidate_id,resume_document_id,name,issuing_body,license_number,candidate_confirmed) values (${q(cert)},${q(cid)},${type === 'full_resume' ? q(doc) : 'null'},${q(s.certName || 'Certified General Contractor')},'State of Florida (DBPR)',${q(s.number)},true);`);
    const vAge = s.verifiedDaysAgo ?? 30;
    const detail = { searched: { license_number: s.number, state: 'FL' }, matched_record: { name: 'RC TEST', nameMatches: true, standing: 'active', statusText: 'Current, Active', licenseType: 'Certified General Contractor', expiration: s.storedExpiry || '2028-08-31' }, registry_expiration: s.storedExpiry || '2028-08-31' };
    out.push(`insert into license_items (id,candidate_id,resume_document_id,source,linked_certification_id,state,state_source,candidate_confirmed,verification_outcome,verification_reason,verification_detail,verification_source,verified_at,verification_attempted_at,queue_item_id,checked_state,checked_number${s.extra ? ',' + s.extra.cols : ''}) values (${q(lic)},${q(cid)},${type === 'full_resume' ? q(doc) : 'null'},${q(type === 'license_only' ? 'license_only' : 'resume')},${q(cert)},'FL','candidate',true,${q(s.outcome || 'verified')},${q(s.reason || 'exact_match_active')},${q(JSON.stringify(detail))}::jsonb,'fl_dbpr',${s.outcome && s.outcome !== 'verified' ? 'null' : `now()-interval '${vAge} days'`},now()-interval '${vAge} days',${q(qid)},'FL',${q(s.number)}${s.extra ? ',' + s.extra.vals : ''});`);
    // the queue row: status_changed_at just after the automatic pass unless the scenario says a person changed it later
    const changedAt = s.statusChangedDaysAgo !== undefined ? `now()-interval '${s.statusChangedDaysAgo} days'` : `now()-interval '${vAge} days' + interval '1 second'`;
    out.push(`insert into verification_items (id,candidate_id,type,claim,received,status,source_item_id,status_changed_at,automated_check,internal_note) values (${q(qid)},${q(cid)},'License',${q((s.certName || 'Certified General Contractor') + ', State of Florida (DBPR), Lic #' + s.number + ', FL')},current_date,${q(s.qstatus || 'Confirmed')},${q(lic)},${changedAt},${q('Automated check result — Florida DBPR (automatic): one exact name match with active status.')},${q(s.internalNote || null)});`);
    out.push(`insert into verification_item_timeline (item_id,event_date,actor,action,note) values (${q(qid)},now()-interval '${vAge} days','System','License check passed (Florida DBPR, automatic): confirmed.','RC seed')${s.staffTimeline ? `,(${q(qid)},now()-interval '${s.statusChangedDaysAgo ?? 1} days','Staff','Staff confirmed the license by hand.','RC seed staff note')` : ''};`);
  };
  // 1 lapsed since verified (real inactive license, name matches)                      -> DOWNGRADED, reason lapsed_since_verified
  acct('01', { first: 'John', last: 'Smith', number: LAPSED });
  // 2 unaffected (real active license, name matches)                                   -> stays Confirmed, re-checked
  acct('02', { first: 'Christopher', last: 'Whitfield', number: ACTIVE });
  // 3 STAFF-confirmed lapsed license (outcome not 'verified', a person set Confirmed)  -> skipped entirely
  acct('03', { first: 'John', last: 'Smith', number: LAPSED, outcome: 'ambiguous', reason: 'exact_match_not_active', statusChangedDaysAgo: 2, staffTimeline: true, internalNote: 'Staff: confirmed by hand.' });
  // 4 auto-verified, then a person changed the queue status later                       -> skipped entirely
  acct('04', { first: 'John', last: 'Smith', number: LAPSED, statusChangedDaysAgo: 3, staffTimeline: true });
  // 5 renamed after verification (registry has the old name)                           -> DOWNGRADED, reason no_exact_name_match
  acct('05', { first: 'Sam', last: 'Renamed', number: ACTIVE });
  out.push(`insert into candidate_name_changes (candidate_id,old_first_name,old_last_name,new_first_name,new_last_name,changed_at) values (${q(U('a05'))},'Christopher','Whitfield','Sam','Renamed',now()-interval '20 days');`);
  // 6 registry lookup cannot be made (number the registry rejects)                     -> error + back-off, NOT downgraded
  acct('06', { first: 'Erin', last: 'Errorcase', number: '<b>x</b>' });
  // 7 license-only account (out of scope: its report already re-checks live)           -> never looked at
  acct('07', { first: 'John', last: 'Smith', number: LAPSED, accountType: 'license_only' });
  // 8 deactivated account                                                              -> never looked at
  acct('08', { first: 'John', last: 'Smith', number: LAPSED, deactivated: true });
  // 9 never upgrade: Needs Reconciliation / Discrepancy / name-change hold, all with a real ACTIVE license and a matching name -> untouched
  acct('09', { first: 'Christopher', last: 'Whitfield', number: ACTIVE, outcome: 'ambiguous', reason: 'no_exact_name_match', qstatus: 'Needs Reconciliation', statusChangedDaysAgo: 5 });
  acct('0a', { first: 'Christopher', last: 'Whitfield', number: ACTIVE, outcome: 'ambiguous', reason: 'exact_match_not_active', qstatus: 'Discrepancy', statusChangedDaysAgo: 5 });
  acct('0b', { first: 'Christopher', last: 'Whitfield', number: ACTIVE, outcome: 'ambiguous', reason: 'recent_name_change', qstatus: 'Needs Reconciliation', statusChangedDaysAgo: 5 });
  // 10 verified only 2 days ago: not due yet                                           -> untouched
  acct('0c', { first: 'John', last: 'Smith', number: LAPSED, verifiedDaysAgo: 2 });
  // 11 verified 2 days ago but the stored registry expiration date has passed: due now (expiry-driven), the live registry says still active -> stays Confirmed
  acct('0d', { first: 'Christopher', last: 'Whitfield', number: ACTIVE, verifiedDaysAgo: 2, storedExpiry: '2026-09-19' });
  // timing tests (transient / unstable second lookup): parked out of the due list until a test brings them in
  acct('0e', { first: 'Christopher', last: 'Whitfield', number: ACTIVE, extra: { cols: 'next_recheck_at', vals: "now()+interval '30 days'" } });
  acct('0f', { first: 'Christopher', last: 'Whitfield', number: ACTIVE, extra: { cols: 'next_recheck_at', vals: "now()+interval '30 days'" } });
  return out.join('\n');
})()
