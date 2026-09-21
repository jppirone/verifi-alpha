#!/usr/bin/env node
// Unit tests for the resume-resubmission INSTRUCTION BUILDER (buildOps, the @@ops block) fed by the real matcher: what the SQL apply is told to do.
// No network, no database. Run: node scripts/test-resume-ops.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { stripTypeScriptTypes } from "node:module";

const src = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "../supabase/functions/resume-resubmission/index.ts"), "utf8");
const cut = (a, b) => { const i = src.indexOf(a), j = src.indexOf(b); if (i < 0 || j < 0) throw new Error("markers " + a); return src.slice(i, j); };
const js = stripTypeScriptTypes(cut("// @@matcher-start", "// @@matcher-end") + "\n" + cut("// @@ops-start", "// @@ops-end")) + "\nexport { matchWork, matchEducation, matchCertifications, matchTexts, buildOps };\n";
const tmp = path.join(os.tmpdir(), `ops-${process.pid}.mjs`); fs.writeFileSync(tmp, js);
const M = await import(pathToFileURL(tmp).href); fs.unlinkSync(tmp);

let bad = 0, n = 0;
const t = (name, ok, extra = "") => { n++; if (!ok) bad++; console.log((ok ? "ok   " : "FAIL ") + name.padEnd(100) + (ok ? "" : " " + extra)); };

let seq = 0; const uid = () => `00000000-0000-4000-8000-${String(++seq).padStart(12, "0")}`;
const TS = "2026-09-20T14:42:27.275+00:00";
const wk = (company, title, s, e, x = {}) => ({ id: uid(), company, title, location: null, start_date: s ? s + "-01-01" : null, start_date_precision: s ? "year" : null, end_date: e && e !== "present" ? e + "-01-01" : null, end_date_precision: e === "present" ? "present" : e ? "year" : null, employer_name_override: null, job_responsibilities: null, position: 1, heading: "EXPERIENCE", extraction_confidence: "high", updated_at: TS, ...x });
const ed = (institution, degree, field, x = {}) => ({ id: uid(), institution, degree, field_of_study: field, location: null, start_date: null, start_date_precision: null, end_date: null, end_date_precision: null, position: 5, heading: "EDUCATION", extraction_confidence: "high", updated_at: TS, ...x });
const ce = (name, body, x = {}) => ({ id: uid(), name, issuing_body: body, license_number: null, issue_date: null, issue_date_precision: null, expiration_date: null, expiration_date_precision: null, license_state: null, source_match: "matched", trade_soc_code: "47-2152", position: 9, heading: "CERTIFICATIONS", extraction_confidence: "high", updated_at: TS, ...x });
const vqRow = (type, source, status, claim, x = {}) => ({ id: "VQ-" + ++seq, type, claim, status, status_changed_at: TS, source_item_id: source, assigned_to: null, correction_requested: false, ...x });
const OPT = { work: true, education: true, certifications: true };
const NO = { work: false, education: false, certifications: false };

// build a ctx exactly the way computePlan does (same matchers, same shapes)
function ctx({ aW = [], aE = [], aC = [], aS = [], aF = [], aL = [], sW = [], sE = [], sC = [], sS = [], sF = [], sL = [], vq = [] }) {
  const lic = (rows) => new Map(rows.map((l) => [l.linked_certification_id, l]));
  const aLic = lic(aL), sLic = lic(sL);
  const oldCert = aC.map((c) => ({ ...c, license_state: aLic.get(c.id)?.state ?? null })), newCert = sC.map((c) => ({ ...c, license_state: sLic.get(c.id)?.state ?? null }));
  return {
    cid: "cand", aW, aE, aC, aS, aF, aL, sW, sE, sC, sS, sF, sL, vq, oldCert, newCert,
    W: M.matchWork(aW, sW), E: M.matchEducation(aE, sE), C: M.matchCertifications(oldCert, newCert),
    S: M.matchTexts(aS.map((s) => s.skill_text), sS.map((s) => s.skill_text), 0.92), F: M.matchTexts(aF.map((f) => `${f.section_type} ${f.content}`), sF.map((f) => `${f.section_type} ${f.content}`), 0.95),
  };
}
const build = (c, opt = OPT) => M.buildOps(c, opt, "NEWDOC", "OLDDOC");
const copyOf = (r, x = {}) => ({ ...r, id: uid(), ...x });
const FACTS = ["company", "title", "start_date", "end_date", "location", "institution", "degree", "field_of_study", "name", "issuing_body", "license_number", "issue_date", "expiration_date", "employer_name_override", "contact_phone"];

console.log("== KEPT: descriptive fields and position only; the queue row is not referenced at all");
{
  const job = wk("Acme", "Analyst", "2015", "2018"), q = vqRow("Job Experience", job.id, "Confirmed", "Analyst, Acme, 2015 – 2018");
  const staged = copyOf(job, { position: 7, heading: "WORK", job_responsibilities: "Brand new bullets", location: "Orlando, FL" });
  const { ops } = build(ctx({ aW: [job], sW: [staged], vq: [q] }));
  const k = ops.kept[0];
  t("the job is KEPT, nothing changed/removed/added", ops.kept.length === 1 && ops.changed.length === 0 && ops.removed.length === 0 && ops.added.length === 0);
  t("its update touches ONLY descriptive columns (position, heading, confidence, responsibilities), never a fact column", k.id === job.id && Object.keys(k.fields).every((c) => ["position", "heading", "extraction_confidence", "job_responsibilities"].includes(c)) && !Object.keys(k.fields).some((c) => FACTS.includes(c)), JSON.stringify(k.fields));
  t("the new position and responsibilities text are carried", k.fields.position === 7 && k.fields.job_responsibilities === "Brand new bullets");
  t("the queue row is not named anywhere in the instructions (no reset, delete or insert for it)", !JSON.stringify({ ...ops, guard: null }).includes(q.id));
  t("...but the guard pins its exact status and status_changed_at, so a staff change during review is caught", ops.guard.queue.some((g) => g.id === q.id && g.status === "Confirmed" && g.ts === TS));
  t("the staged duplicate is scheduled for deletion; lineage says 'descriptive_updated'", ops.staged_delete.work.includes(staged.id) && ops.lineage.some((l) => l.id === job.id && l.relation === "descriptive_updated"));
  t("nothing needs the employer contact screen", ops.contact_reset === false);
}

console.log("== CHANGED: facts rewritten, queue row reset to New with a rebuilt claim and a before/after note");
{
  const job = wk("Acme", "Analyst", "2015", "present"), q = vqRow("Job Experience", job.id, "Confirmed", "Analyst, Acme, 2015 – Present");
  const staged = copyOf(job, { end_date: "2018-01-01", end_date_precision: "year", title: "Analyst" });
  const { ops, contactNeeded } = build(ctx({ aW: [job], sW: [staged], vq: [q] }));
  const c = ops.changed[0];
  t("'Present' -> 2018 is CHANGED", ops.changed.length === 1 && ops.kept.length === 0 && c.id === job.id);
  t("only the changed fact's columns are rewritten (end_date + its precision); title/company are not in the update", c.fields.end_date === "2018-01-01" && c.fields.end_date_precision === "year" && !("title" in c.fields) && !("company" in c.fields), JSON.stringify(c.fields));
  t("the queue row is RESET in place: same id, claim rebuilt from the merged record", c.queue.mode === "reset" && c.queue.id === q.id && c.queue.claim === "Analyst, Acme, 2015 – 2018", JSON.stringify(c.queue));
  t("the timeline note carries the before claim + status, the after claim and the field change", /Before: Analyst, Acme, 2015 – Present \(status Confirmed\)/.test(c.queue.note) && /After: Analyst, Acme, 2015 – 2018 \(status New\)/.test(c.queue.note) && /end date: Present → 2018/.test(c.queue.note), c.queue.note);
  t("its old queue rows are all in vq_all (for the archive) and it is listed for the contact-details screen", c.vq_all.includes(q.id) && contactNeeded.work.includes(job.id) && ops.contact_reset);
  t("lineage 'facts_changed'", ops.lineage.some((l) => l.id === job.id && l.relation === "facts_changed"));
}
{
  const job = wk("Truven Health", "Manager", "2014", "2019", { employer_name_override: "Truven Health Analytics", contact_phone: "555-0100", contact_name: "HR" }), q = vqRow("Job Experience", job.id, "Confirmed", "Manager, Truven Health, 2014 – 2019");
  const staged = copyOf(job, { company: "IBM Watson Health", employer_name_override: null, contact_phone: null, contact_name: null });
  const { ops } = build(ctx({ aW: [job], sW: [staged], vq: [q] }));
  const f = ops.changed[0]?.fields || {};
  t("a changed COMPANY clears the old employer name override and contact details (they belonged to the old employer)", ops.changed.length === 1 && f.company === "IBM Watson Health" && f.employer_name_override === null && f.contact_phone === null && f.contact_name === null && f.employer_location_override === null, JSON.stringify(f));
}
{
  const job = wk("Acme", "Analyst", "2015", "2018"), q = vqRow("Job Experience", job.id, "In Progress", "Analyst, Acme, 2015 – 2018", { assigned_to: "Test Worker" });
  const staged = copyOf(job, { title: "Director of Analytics" });
  const on = build(ctx({ aW: [job], sW: [staged], vq: [q] }), OPT).ops.changed[0], off = build(ctx({ aW: [job], sW: [staged], vq: [q] }), { ...OPT, work: false });
  t("changed + opted in: reset (an In Progress item goes back to New, note records the old status)", on.queue.mode === "reset" && /status In Progress/.test(on.queue.note));
  t("changed + category NOT opted in: the stale queue row is removed (the archive holds it), no contact screen", off.ops.changed[0].queue.mode === "delete" && off.ops.changed[0].queue.ids[0] === q.id && off.ops.contact_reset === false);
}
{
  const job = wk("Acme", "Analyst", "2015", "2018"), staged = copyOf(job, { title: "Director of Analytics" });
  const withOpt = build(ctx({ aW: [job], sW: [staged], vq: [] }), OPT).ops.changed[0], without = build(ctx({ aW: [job], sW: [staged], vq: [] }), NO).ops.changed[0];
  t("a changed item that never had a queue row: opted in -> a new queue row is created", withOpt.queue.mode === "insert" && withOpt.queue.row.type === "Job Experience" && withOpt.queue.row.status === "New" && withOpt.queue.row.claim === "Director of Analytics, Acme, 2015 – 2018", JSON.stringify(withOpt.queue));
  t("...and not opted in -> no queue instruction", without.queue === null);
}

console.log("== ADDED: confirmed, queue rows per opt-in (same rules as the first confirmation)");
{
  const job = wk("Acme Robotics", "Senior Analyst", "2026", "present", { location: "Orlando, FL" });
  const on = build(ctx({ sW: [job] }), OPT), off = build(ctx({ sW: [job] }), NO);
  t("added job, opted in: one 'Job Experience' queue row, status New, claim built from the row", on.ops.added[0].queue.type === "Job Experience" && on.ops.added[0].queue.status === "New" && on.ops.added[0].queue.claim === "Senior Analyst, Acme Robotics, Orlando, FL, 2026 – Present", JSON.stringify(on.ops.added[0].queue));
  t("added job, not opted in: confirmed but no queue row", off.ops.added[0].queue === null && off.contactNeeded.work.length === 0);
  t("added job, opted in: listed for the contact-details screen; lineage 'origin'", on.contactNeeded.work.includes(job.id) && on.ops.lineage.some((l) => l.id === job.id && l.relation === "origin"));
  t("an added item is NOT scheduled for deletion (it becomes the active row)", !on.ops.staged_delete.work.includes(job.id));
}
{
  const good = ce("Certified Scrum Master", "Scrum Alliance"), unmatched = ce("Made Up Cert", "Nobody", { source_match: "unmatched" }), noTrade = ce("Trade Cert", "Board", { trade_soc_code: null });
  const off = build(ctx({ sC: [good, unmatched, noTrade] }), NO).ops.added, on = build(ctx({ sC: [good, unmatched, noTrade] }), OPT).ops.added;
  const by = (arr, id) => arr.find((a) => a.staged_id === id);
  t("cert not opted in: an ordinary cert gets NO queue row", by(off, good.id).queue === null);
  t("cert not opted in: an UNMATCHED cert is still flagged (Needs Reconciliation, with the reason), exactly as at first confirmation", by(off, unmatched.id).queue?.status === "Needs Reconciliation" && /did not fuzzy-match/.test(by(off, unmatched.id).queue.internal_note));
  t("cert opted in: ordinary -> New; missing trade -> Needs Reconciliation (no automated check could route)", by(on, good.id).queue.status === "New" && by(on, noTrade.id).queue.status === "Needs Reconciliation" && /no trade/.test(by(on, noTrade.id).queue.internal_note));
  t("cert not opted in and not unmatched, even with no trade: no queue row (unchanged rule)", by(off, noTrade.id).queue === null);
}

console.log("== REMOVED: everything attached to the item goes with it (archive first, in the SQL)");
{
  const cert = ce("Plumber", "DBPR", { license_number: "CFC1425829" }), lic = { id: uid(), linked_certification_id: cert.id, state: "FL", queue_item_id: null, updated_at: TS };
  const cq = vqRow("Certification", cert.id, "Confirmed", "Plumber, Lic #CFC1425829"), lq = vqRow("License", lic.id, "Confirmed", "Plumber, Lic #CFC1425829, FL"); lic.queue_item_id = lq.id;
  const other = ce("Keep Me", "X");
  const { ops } = build(ctx({ aC: [cert, other], aL: [lic], sC: [copyOf(other)], vq: [cq, lq] }));
  const r = ops.removed.find((x) => x.id === cert.id);
  t("a removed licensed certification names its Certification AND License queue rows and the license extension", !!r && r.license_id === lic.id && r.vq.includes(cq.id) && r.vq.includes(lq.id) && r.vq.length === 2, JSON.stringify(r));
  t("the other certification is kept", ops.kept.some((k) => k.id === other.id));
}
{
  const j1 = wk("Acme", "Analyst", "2015", "2018"), j2 = wk("Beta", "Chef", "2010", "2012"), q2 = vqRow("Job Experience", j2.id, "New", "Chef, Beta, 2010 – 2012");
  const { ops } = build(ctx({ aW: [j1, j2], sW: [copyOf(j1)], vq: [q2] }));
  t("a removed job carries its queue row id (open or not)", ops.removed.length === 1 && ops.removed[0].id === j2.id && ops.removed[0].vq[0] === q2.id);
}

console.log("== LICENSES: reset (registry asked again after commit) or attach; new licenses are checked too");
{
  const cert = ce("Plumber", "DBPR", { license_number: "CFC1425829" }), lic = { id: uid(), linked_certification_id: cert.id, state: "FL", queue_item_id: null, updated_at: TS };
  const lq = vqRow("License", lic.id, "Confirmed", "Plumber, Lic #CFC1425829, FL"); lic.queue_item_id = lq.id;
  const sc = copyOf(cert), sl = { id: uid(), linked_certification_id: sc.id, state: "CO", state_source: "resume", state_evidence: "DORA", updated_at: TS };
  const { ops, verifyIds } = build(ctx({ aC: [cert], aL: [lic], sC: [sc], sL: [sl], vq: [lq] }));
  const c = ops.changed[0];
  t("a license whose STATE changed: CHANGED with a 'reset' instruction on the existing license row", c && c.license?.action === "reset" && c.license.id === lic.id && c.license.state === "CO", JSON.stringify(c?.license));
  t("its License queue row is reset with a rebuilt claim and a before/after note", c.license.queue_id === lq.id && c.license.claim === "Plumber, DBPR, Lic #CFC1425829, CO" && /Before: Plumber, Lic #CFC1425829, FL \(status Confirmed\)/.test(c.license.note), JSON.stringify(c.license));
  t("the existing license is scheduled for a real registry re-check after the commit", verifyIds.includes(lic.id));
}
{
  const cert = ce("Plumber", "DBPR", { license_number: "CFC1425829" });
  const sc = copyOf(cert), sl = { id: uid(), linked_certification_id: sc.id, state: "FL", state_source: "resume", state_evidence: "DBPR", updated_at: TS };
  const { ops, verifyIds } = build(ctx({ aC: [cert], sC: [sc], sL: [sl] }));
  t("a state newly detected on an existing certification: ATTACH the staged license row to the existing certification", ops.changed[0]?.license?.action === "attach" && ops.changed[0].license.staged_id === sl.id && verifyIds.includes(sl.id));
}
{
  const sc = ce("Electrician", "DBPR", { license_number: "EC13005111" }), sl = { id: uid(), linked_certification_id: sc.id, state: "FL", updated_at: TS };
  const { ops, verifyIds } = build(ctx({ sC: [sc], sL: [sl] }));
  t("a NEW licensed certification: its staged license row is confirmed with it and checked against the registry", ops.added[0].license_staged_id === sl.id && verifyIds.includes(sl.id));
}
{
  const cert = ce("Plumber", "DBPR", { license_number: "CFC1425829" }), lic = { id: uid(), linked_certification_id: cert.id, state: "FL", updated_at: TS }, lq = vqRow("License", lic.id, "Confirmed", "x");
  const { ops, verifyIds } = build(ctx({ aC: [cert], aL: [lic], sC: [copyOf(cert)], sL: [{ id: uid(), linked_certification_id: "x", state: "FL" }], vq: [lq] }));
  t("an UNCHANGED license is kept: no reset, no re-check, its queue row untouched", ops.kept.length === 1 && ops.changed.length === 0 && verifyIds.length === 0 && !JSON.stringify({ ...ops, guard: null }).includes(lq.id));
}

console.log("== freeform and skills");
{
  const oldNr = { id: uid(), section_type: "needs_review", heading: "AI PROJECTS", content: "Old project text", position: 3, updated_at: TS }, newNr = { id: uid(), section_type: "needs_review", heading: "OTHER", content: "Completely different new text here", position: 4 };
  const q = vqRow("Needs Review", null, "Confirmed", "AI PROJECTS: Old project text");
  const { ops } = build(ctx({ aF: [oldNr], sF: [newNr], vq: [q] }));
  t("a removed needs_review section takes its (source-less) queue row with it, found by claim text", ops.removed[0].kind === "freeform" && ops.removed[0].vq[0] === q.id);
  t("a new needs_review section gets a Needs Reconciliation queue row regardless of opt-in", build(ctx({ aF: [oldNr], sF: [newNr], vq: [q] }), NO).ops.added[0].queue?.status === "Needs Reconciliation");
}
{
  const s1 = { id: uid(), skill_text: "Agile", position: 1, updated_at: TS }, s2 = { id: uid(), skill_text: "Waterfall", position: 2, updated_at: TS };
  const { ops } = build(ctx({ aS: [s1, s2], sS: [{ id: uid(), skill_text: "Agile", position: 4, section_position: 2 }, { id: uid(), skill_text: "Scrum", position: 5, section_position: 2 }] }));
  t("skills: kept (position only), removed (no queue), added (confirmed, no queue)", ops.kept.filter((k) => k.kind === "skill").length === 1 && ops.kept.find((k) => k.kind === "skill").fields.position === 4 && ops.removed.some((r) => r.kind === "skill" && r.id === s2.id && r.vq.length === 0) && ops.added.some((a) => a.kind === "skill" && a.queue === null));
}

console.log("== GUARD: the exact state the plan was computed against");
{
  const job = wk("Acme", "Analyst", "2015", "2018"), edu = ed("U of X", "Bachelor of Science", "Physics"), cert = ce("PMP", "PMI");
  const { ops } = build(ctx({ aW: [job], aE: [edu], aC: [cert], sW: [copyOf(job)], sE: [copyOf(edu)], sC: [copyOf(cert)], vq: [vqRow("Job Experience", job.id, "Confirmed", "c")] }));
  t("every active row is pinned by id and updated_at; counts per table; the whole queue by id/status/status_changed_at", ops.guard.items.length === 3 && ops.guard.items.every((g) => g.ts === TS) && ops.guard.counts.work_history_items === 1 && ops.guard.counts.license_items === 0 && ops.guard.queue.length === 1 && ops.guard.queue_count === 1);
  t("every staged row is listed so the SQL can refuse if the staged upload changed", ops.staged.work_history_items.length === 1 && ops.staged.education_items.length === 1 && ops.staged.certification_items.length === 1);
  const a = JSON.stringify(build(ctx({ aW: [job], sW: [copyOf(job)] })).ops), b = JSON.stringify(build(ctx({ aW: [job], sW: [copyOf(job)] })).ops);
  t("the instruction set is deterministic apart from the staged ids", a.length === b.length);
}

console.log(bad ? `\n${bad} of ${n} FAILED` : `\nall ${n} passed`);
process.exit(bad ? 1 : 0);
