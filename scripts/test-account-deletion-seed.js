(() => {
const U = (h) => 'd3d3d3d3-0000-4000-8000-' + String(h).padStart(12, '0');
const q = (s) => s === null ? 'null' : "'" + String(s).replace(/'/g, "''") + "'";
const S = { s1: 'sub_1UI1uQRqPebINCzHYEtPFpAL', s2: 'sub_1UI1uURqPebINCzHB2HPlLps', s3: 'sub_1UI1uXRqPebINCzHl7obpQUj' };
const out = [];
const cand = (n, first, last, email, phone, type, tier, sub, extra = '') =>
  out.push(`insert into candidates (id,email,phone,first_name,last_name,full_name,account_type,discoverable,tier,stripe_subscription_id,tour_completed_at,personal_location,phone_verified_at,verified_phone_number${extra ? ',' + extra.split('=')[0] : ''}) values (${q(U('a' + n))},${q(email)},${q(phone)},${q(first)},${q(last)},${q(first + ' ' + last)},${q(type)},true,${q(tier)},${q(sub)},now(),'DELMARK City, FL',now(),${q(phone)}${extra ? ',' + extra.split('=')[1] : ''});`);
cand(1, 'Zed', 'Deletionmarker', 'delivered+del1@resend.dev', '+15555550511', 'full_resume', 'paid', S.s1, 'stripe_checkout_session_id=' + q('cs_test_DELMARK1'));
cand(2, 'Zoe', 'Deletionmarker', 'delivered+del2@resend.dev', '+15555550512', 'full_resume', 'paid', S.s2);
cand(3, 'Lou', 'Deletionmarker', 'delivered+del3@resend.dev', '+15555550513', 'license_only', 'free', S.s3, 'license_subscription_started_at=now()');
cand(4, 'Rae', 'Deletionmarker', 'delivered+del4@resend.dev', '+15555550514', 'full_resume', 'free', null);
cand(5, 'Ed', 'Deletionmarker', 'delivered+del5@resend.dev', '+15555550515', 'full_resume', 'free', null);
cand(6, 'Bea', 'Deletionmarker', 'delivered+del10@resend.dev', '+15555550520', 'full_resume', 'free', null);
cand(7, 'Gil', 'Deletionmarker', 'delivered+del7@resend.dev', '+15555550517', 'full_resume', 'paid', 'sub_DELMARK_missing0000');
for (const n of [1, 2, 3, 4, 5, 6, 7]) out.push(`insert into candidate_sessions (candidate_id,token_hash,expires_at) values (${q(U('a' + n))}, encode(sha256(convert_to(repeat('a${n}',32),'UTF8')),'hex'), now()+interval '30 days');`);
out.push(`insert into account_deletion_exempt (candidate_id, reason) values (${q(U('a5'))}, 'TEST: exempt check (removed in cleanup)') on conflict do nothing;`);

// email verifications: a1 signup (linked from candidates.verification_id), a1 login-type, a1 unfinished signup with staged doc, a6 control
const ev = (id, email, cid, confirmed) => out.push(`insert into email_verifications (id,email,token,expires_at,confirmed_at,purpose,full_name,phone,first_name,last_name,account_type,existing_candidate_id) values (${q(U(id))},${q(email)},${q('delmark-ev-' + id)},now()+interval '1 hour',${confirmed ? 'now()' : 'null'},'signup','Zed Deletionmarker','+15555550511','Zed','Deletionmarker','full_resume',${cid ? q(U(cid)) : 'null'});`);
ev('11', 'delivered+del1@resend.dev', null, true);
ev('12', 'delivered+del1@resend.dev', 'a1', true);
ev('13', 'DELIVERED+del1@resend.dev', null, false);
ev('14', 'delivered+del10@resend.dev', null, true);
out.push(`update candidates set verification_id=${q(U('11'))} where id=${q(U('a1'))};`);
out.push(`insert into login_tokens (id,email,channel,token,candidate_id,expires_at,confirmed_at) values (${q(U('21'))},'delivered+del1@resend.dev','email','delmark-lt1',${q(U('a1'))},now()+interval '1 hour',now()),(${q(U('22'))},'delivered+del1@resend.dev','email','delmark-lt2',null,now()+interval '1 hour',null),(${q(U('23'))},'delivered+del10@resend.dev','email','delmark-lt3',${q(U('a6'))},now()+interval '1 hour',now());`);
out.push(`insert into candidate_login_attempts (email,kind) values ('delivered+del1@resend.dev','login'),('delivered+del1@resend.dev','login'),('delivered+del10@resend.dev','login');`);

// documents
const A = (n) => U('a' + n);
const doc = (id, cid, evid, path, kind, extra) => out.push(`insert into resume_documents (id,candidate_id,email_verification_id,original_storage_path,original_filename,mime_type,extraction_status,kind,confirmed_at,employer_contact_resolved_at${extra && extra.cols ? ',' + extra.cols : ''}) values (${q(U(id))},${cid ? q(cid) : 'null'},${evid ? q(U(evid)) : 'null'},${q(path)},'DELMARK_resume.pdf','application/pdf','complete',${q(kind)},${extra && extra.conf === false ? 'null' : "now()-interval '20 days'"},${extra && extra.conf === false ? 'null' : 'now()'}${extra && extra.vals ? ',' + extra.vals : ''});`);
doc('b1', A(1), null, `${A(1)}/${U('b1')}/original.pdf`, 'initial', { cols: 'sanitized_render_path', vals: q(`${A(1)}/${U('b1')}/sanitized.jpg`) });
doc('b2', A(1), null, `${A(1)}/${U('b2')}/original.pdf`, 'resubmission');
out.push(`update resume_documents set supersedes_document_id=${q(U('b1'))} where id=${q(U('b2'))};`);
doc('b3', null, '13', `${U('13')}/${U('b3')}/original.pdf`, 'initial', { conf: false });
doc('b4', A(2), null, `${A(2)}/${U('b4')}/original.pdf`, 'initial');
doc('b5', A(3), null, `${A(3)}/${U('b5')}/original.pdf`, 'initial');
doc('b6', A(4), null, `${A(4)}/${U('b6')}/original.pdf`, 'initial');
doc('b7', A(5), null, `${A(5)}/${U('b7')}/original.pdf`, 'initial');
doc('b8', A(6), null, `${A(6)}/${U('b8')}/original.pdf`, 'initial');
doc('b9', null, '14', `${U('14')}/${U('b9')}/original.pdf`, 'initial', { conf: false });
doc('ba', A(7), null, `${A(7)}/${U('ba')}/original.pdf`, 'initial');
out.push(`insert into resume_extraction_pages (resume_document_id,page_number,extraction,ocr_text) values (${q(U('b1'))},1,'{"note":"DELMARK page"}'::jsonb,'DELMARK ocr text Zed Deletionmarker'),(${q(U('b3'))},1,'{}'::jsonb,'DELMARK signup ocr'),(${q(U('b8'))},1,'{}'::jsonb,'DELMARK control ocr');`);

// items on a1's initial doc
const w = (id, cid, did, company, title, conf = true) => out.push(`insert into work_history_items (id,candidate_id,resume_document_id,company,title,job_responsibilities,candidate_confirmed,contact_phone,contact_name) values (${q(U(id))},${cid ? q(cid) : 'null'},${q(U(did))},${q(company)},${q(title)},'DELMARK duties',${conf},'555-DELMARK','Pat DELMARK');`);
w('101', A(1), 'b1', 'DELMARK Robotics', 'Engineer'); w('102', A(1), 'b1', 'DELMARK Systems', 'Lead');
w('111', null, 'b3', 'DELMARK Signup Co', 'Analyst', false);
w('201', A(2), 'b4', 'DELMARK Two Co', 'Tech'); w('401', A(4), 'b6', 'DELMARK Four Co', 'Tech'); w('501', A(5), 'b7', 'DELMARK Five Co', 'Tech');
w('601', A(6), 'b8', 'DELMARK Control A', 'Eng'); w('602', A(6), 'b8', 'DELMARK Control B', 'Eng'); w('701', A(7), 'ba', 'DELMARK Seven Co', 'Tech');
out.push(`insert into education_items (id,candidate_id,resume_document_id,institution,degree,field_of_study,candidate_confirmed) values (${q(U('103'))},${q(A(1))},${q(U('b1'))},'DELMARK University','BS','Studies',true),(${q(U('603'))},${q(A(6))},${q(U('b8'))},'DELMARK Control U','BS','Studies',true);`);
const c = (id, cid, did, name, conf = true) => out.push(`insert into certification_items (id,candidate_id,resume_document_id,name,issuing_body,license_number,candidate_confirmed,contact_phone) values (${q(U(id))},${cid ? q(cid) : 'null'},${q(U(did))},${q(name)},'DELMARK Board','DELMARK-123',${conf},'555-DELMARK');`);
c('104', A(1), 'b1', 'DELMARK Plumber'); c('105', A(1), 'b1', 'DELMARK PMP'); c('112', null, 'b3', 'DELMARK Signup Cert', false);
c('202', A(2), 'b4', 'DELMARK Cert Two'); c('301', A(3), 'b5', 'DELMARK Contractor'); c('604', A(6), 'b8', 'DELMARK Control Cert');
const k = (id, cid, did, txt) => out.push(`insert into skill_items (id,candidate_id,resume_document_id,skill_text,candidate_confirmed) values (${q(U(id))},${cid ? q(cid) : 'null'},${q(U(did))},${q(txt)},${cid ? 'true' : 'false'});`);
k('106', A(1), 'b1', 'DELMARK welding'); k('107', A(1), 'b1', 'DELMARK piping'); k('108', A(1), 'b2', 'DELMARK safety'); k('113', null, 'b3', 'DELMARK signup skill'); k('605', A(6), 'b8', 'DELMARK control skill');
out.push(`insert into candidate_freeform_sections (id,candidate_id,resume_document_id,section_type,content,candidate_confirmed,heading) values (${q(U('109'))},${q(A(1))},${q(U('b1'))},'needs_review','DELMARK freeform text',true,'DELMARK heading');`);
out.push(`insert into license_items (id,candidate_id,resume_document_id,source,linked_certification_id,state,state_source,candidate_confirmed,verification_outcome,queue_item_id,holder_name_guess,source_text) values (${q(U('10a'))},${q(A(1))},${q(U('b1'))},'resume',${q(U('104'))},'FL','candidate',true,'verified','VQ-DL10A','Zed Deletionmarker','DELMARK license text'),(${q(U('302'))},${q(A(3))},${q(U('b5'))},'license_only',${q(U('301'))},'FL','candidate',true,'verified','VQ-DL301','Lou Deletionmarker','DELMARK license text');`);

// verification queue + timeline
const vi = (id, cid, type, claim, src, status = 'New') => out.push(`insert into verification_items (id,candidate_id,type,claim,received,status,source_item_id,internal_note,candidate_note) values (${q(id)},${q(cid)},${q(type)},${q(claim)},current_date,${q(status)},${q(src)},'DELMARK staff note','DELMARK candidate note');`);
vi('VQ-DL101', A(1), 'Job Experience', 'DELMARK Robotics, Engineer', U('101')); vi('VQ-DL102', A(1), 'Job Experience', 'DELMARK Systems, Lead', U('102'), 'In Progress');
vi('VQ-DL103', A(1), 'Education', 'DELMARK University BS', U('103'), 'Confirmed'); vi('VQ-DL104', A(1), 'Certification', 'DELMARK Plumber', U('104'), 'Awaiting Response'); vi('VQ-DL10A', A(1), 'License', 'DELMARK license', U('10a'), 'Confirmed');
vi('VQ-DL201', A(2), 'Job Experience', 'DELMARK Two Co', U('201')); vi('VQ-DL202', A(2), 'Certification', 'DELMARK Cert Two', U('202'));
vi('VQ-DL301', A(3), 'License', 'DELMARK contractor', U('302'), 'Confirmed');
vi('VQ-DL401', A(4), 'Job Experience', 'DELMARK Four Co', U('401')); vi('VQ-DL501', A(5), 'Job Experience', 'DELMARK Five Co', U('501'));
vi('VQ-DL601', A(6), 'Job Experience', 'DELMARK Control A', U('601'), 'Confirmed'); vi('VQ-DL602', A(6), 'Job Experience', 'DELMARK Control B', U('602')); vi('VQ-DL603', A(6), 'Education', 'DELMARK Control U', U('603')); vi('VQ-DL604', A(6), 'Certification', 'DELMARK Control Cert', U('604'));
vi('VQ-DL701', A(7), 'Job Experience', 'DELMARK Seven Co', U('701'));
out.push(`insert into verification_item_timeline (item_id,event_date,actor,action,note) values ('VQ-DL101',now(),'staff','Contacted employer','DELMARK note'),('VQ-DL104',now(),'staff','Emailed board','DELMARK note'),('VQ-DL104',now(),'Candidate','Update','DELMARK'),('VQ-DL601',now(),'staff','Control timeline','DELMARK control note');`);

// resubmission attempt (applied), archive, lineage, summaries, name change
out.push(`insert into resume_resubmissions (id,candidate_id,resume_document_id,base_document_id,status,ack_at,ack_text_version,applied_at,closed_at,counts) values (${q(U('71'))},${q(A(1))},${q(U('b2'))},${q(U('b1'))},'applied',now()-interval '5 days','v1-2026-09-21',now()-interval '5 days',now()-interval '5 days','{"added":1}'::jsonb);`);
out.push(`insert into profile_item_archive (id,candidate_id,item_kind,item_id,reason,item_data,resubmission_id) values (${q(U('61'))},${q(A(1))},'work',${q(U('161'))},'removed','{"company":"DELMARK Old Corp"}'::jsonb,${q(U('71'))}),(${q(U('62'))},${q(A(1))},'certification',${q(U('162'))},'facts_changed','{"name":"DELMARK Old Cert"}'::jsonb,${q(U('71'))});`);
out.push(`insert into profile_item_lineage (id,candidate_id,item_kind,item_id,resume_document_id,relation,resubmission_id) values (${q(U('63'))},${q(A(1))},'work',${q(U('101'))},${q(U('b2'))},'reconfirmed',${q(U('71'))}),(${q(U('64'))},${q(A(1))},'skill',${q(U('108'))},${q(U('b2'))},'origin',${q(U('71'))});`);
out.push(`insert into candidate_summary_versions (id,candidate_id,name,content) values (${q(U('81'))},${q(A(1))},'DELMARK summary','DELMARK summary text for Zed'),(${q(U('83'))},${q(A(6))},'DELMARK control summary','control text');`);
out.push(`insert into candidate_name_changes (id,candidate_id,old_first_name,old_last_name,new_first_name,new_last_name) values (${q(U('82'))},${q(A(1))},'Zeddy','Oldname','Zed','Deletionmarker');`);

// employer-side rows (before deactivation): a declined and an expired request, four lookups, a control request + snapshot
const req = (id, cid, status, email, extra = '') => out.push(`insert into comparison_requests (id,candidate_id,requester_email,requester_name,requester_company,access_method,attestation,status,expires_at,responded_at${extra ? ',' + extra.split('|')[0] : ''}) values (${q(U(id))},${q(cid)},${q(email)},'Req DELMARK','ReqCo DELMARK','guest','DELMARK how I got this',${q(status)},now()+interval '1 day',${status === 'pending' ? 'null' : 'now()'}${extra ? ',' + extra.split('|')[1] : ''});`);
req('43', A(1), 'declined', 'delivered+delreq3@resend.dev'); req('44', A(1), 'expired', 'delivered+delreq4@resend.dev');
req('47', A(6), 'pending', 'delivered+delreq7@resend.dev');
req('48', A(6), 'approved', 'delivered+delreq8@resend.dev', "approved_at,snapshot_expires_at|now(),now()+interval '7 days'");
out.push(`insert into comparison_snapshots (id,request_id,candidate_id,content,counts) values (${q(U('54'))},${q(U('48'))},${q(A(6))},'{"note":"DELMARK control snapshot"}'::jsonb,'{}'::jsonb);`);
const lk = (id, email, name, cn, ce, cp, matched, label, used, claim) => out.push(`insert into employer_lookup_requests (id,token,requester_email,requester_name,requester_company,candidate_name,candidate_email,candidate_phone,expires_at,used_at,result_exists,matched_candidate_id,claim_token_hash,candidate_label) values (${q(U(id))},${q('delmark-lookup-' + id)},${q(email)},${q(name)},'ReqCo DELMARK',${q(cn)},${q(ce)},${q(cp)},now()+interval '2 days',${used ? "now()-interval '2 days'" : 'null'},${used ? 'true' : 'null'},${matched ? q(matched) : 'null'},${claim ? "encode(sha256(convert_to('" + claim + "','UTF8')),'hex')" : 'null'},${q(label)});`);
lk('31', 'delivered+delreq@resend.dev', 'Req DELMARK', null, null, null, A(1), 'Zed DELMARK', true, 'delmark-claim1');
lk('32', 'delivered+delreq2@resend.dev', 'Req DELMARK 2', 'Zed Deletionmarker', 'delivered+del1@resend.dev', '+15555550511', null, null, false, null);
lk('33', 'delivered+delreq5@resend.dev', 'Req DELMARK 5', null, null, null, A(6), 'Bea DELMARK control', true, 'delmark-claim6');
lk('34', 'delivered+delreq6@resend.dev', 'Req DELMARK 6', 'Bea Deletionmarker', 'delivered+del10@resend.dev', '+15555550520', null, null, false, null);
lk('35', 'delivered+delreq9@resend.dev', 'Req DELMARK 9', 'Zoe Deletionmarker', 'delivered+del2@resend.dev', null, null, null, false, null);
out.push(`insert into employer_payments (id,kind,status,amount_cents,payer_email,access_token_hash,comparison_request_id) values (${q(U('c2'))},'guest_comparison','paid',1000,'delivered+delreq8@resend.dev','delmark-hash-control',${q(U('48'))});`);
out.push(`insert into staff_employer_document_views (staff_user_id,staff_email,request_id,candidate_id) values (${q(U('d1'))},'staff-delmark@example.com',${q(U('42'))},${q(A(1))});`);

// storage metadata rows (blobs for the two real uploads come later)
const so = (p) => `('resume-documents',${q(p)})`;
out.push(`insert into storage.objects (bucket_id,name) values ${[`${A(1)}/${U('b1')}/original.pdf`, `${A(1)}/${U('b1')}/sanitized.jpg`, `${A(1)}/${U('b2')}/original.pdf`, `${A(1)}/${U('b0')}/original.pdf`, `${U('13')}/${U('b3')}/original.pdf`, `${A(2)}/${U('b4')}/original.pdf`, `${A(3)}/${U('b5')}/original.pdf`, `${A(4)}/${U('b6')}/original.pdf`, `${A(5)}/${U('b7')}/original.pdf`, `${A(6)}/${U('b8')}/original.pdf`, `${U('14')}/${U('b9')}/original.pdf`, `${A(7)}/${U('ba')}/original.pdf`].map(so).join(',')};`);
return out.join('\n');
})()
