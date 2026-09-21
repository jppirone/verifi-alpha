#!/usr/bin/env node
// Unit tests for the resume-resubmission matcher (the block between @@matcher-start / @@matcher-end in
// supabase/functions/resume-resubmission/index.ts). Pure functions, no network, no database.
//
// The corpus is REAL extracted rows: the Full Resume demo (F), the Hybrid demo (H) and the owner's own resume (Y), copied from the live database
// on 2026-09-21, plus controlled mutations of them. What it protects, in order of importance:
//   1. INTEGRITY: nothing may come out "kept" (verification preserved) unless every verified fact agrees. Zero false kept.
//   2. Real extraction noise must not cause false re-verification ("AI" vs "Al", blank companies, abbreviations, date precision).
// Run: node scripts/test-resume-matcher.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { stripTypeScriptTypes } from "node:module";

const src = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "../supabase/functions/resume-resubmission/index.ts"), "utf8");
const a = src.indexOf("// @@matcher-start"), b = src.indexOf("// @@matcher-end");
if (a < 0 || b < 0) throw new Error("matcher markers not found");
const block = src.slice(a, b);
const js = stripTypeScriptTypes(block) + "\nexport { matchWork, matchEducation, matchCertifications, matchTexts, presentInText, fold, sim, dv, dateRel, clean, companySim };\n";
const tmp = path.join(os.tmpdir(), `matcher-${process.pid}.mjs`);
fs.writeFileSync(tmp, js);
const M = await import(pathToFileURL(tmp).href);
fs.unlinkSync(tmp);

let bad = 0, n = 0;
const t = (name, ok, extra = "") => { n++; if (!ok) bad++; console.log((ok ? "ok   " : "FAIL ") + name.padEnd(92) + (ok ? "" : extra)); };
const cls = (sec) => sec.pairs.map((p) => p.cls).join(",");
const kept = (sec) => sec.pairs.filter((p) => p.cls === "kept").length;
const changed = (sec) => sec.pairs.filter((p) => p.cls === "changed").length;

// ---- real rows (columns as stored) ----
const wk = (company, title, s, e, extra = {}) => ({ company, title, location: null, start_date: s ? s + "-01-01" : null, start_date_precision: s ? "year" : null, end_date: e && e !== "present" ? e + "-01-01" : null, end_date_precision: e === "present" ? "present" : e ? "year" : null, employer_name_override: null, job_responsibilities: null, ...extra });
const F_W = [
  wk("Independent / Freelance", "AI Solutions Consultant & Customer Success Advisor", "2023", "present", { location: "Sebastian, FL" }),
  wk("School District of Indian River County, Florida", "Technical Training & Digital Skills Enablement Specialist", "2019", "2023"),
  wk("Thomson Healthcare/Truven Health", "Business Operations & Portfolio Manager", "2014", "2019"),
];
const H_W = [wk("", "Technical Training & Digital Skills Enablement Specialist", "2019", "2023"), wk("", "Business Operations & Portfolio Manager", "2014", "2019")];
const Y_W = [
  wk("School District of Indian River County", "Associate Dean of Discipline", "2025", "2026", { location: "Sebastian, FL" }),
  wk("School District of Indian River County", "Business Education Teacher", "2018", "2025", { location: "Sebastian, FL" }),
  wk("Truven Health Analytics (IBM Watson Health)", "Business Integration Manager", "2008", "2016", { location: "Ann Arbor, MI" }),
  wk("QPharma", "Technical Project Manager", "2007", "2008"), wk("WorkWave", "Handheld Product Support Specialist / Project Manager", "2006", "2007"),
  wk("Thomson Healthcare", "Manager of Handheld Application Development", "2001", "2003"),
  wk("Thomson Reuters", "Manager of Business Analysis and Publishing Systems", "1996", "1998"), wk("Letraset", "Project Manager", "1995", "1996"),
];
const ed = (institution, degree, field_of_study, extra = {}) => ({ institution, degree, field_of_study, location: null, start_date: null, start_date_precision: null, end_date: null, end_date_precision: null, ...extra });
const F_E = [ed("University of Delaware", "Bachelor's Degree", "Education", { location: "Newark, DE" })];
const H_E = [ed("[Institution Name]", "Bachelor's Degree", "[Field of Study]", { location: "[City, State]" })];
const Y_E = [ed("University of Delaware", "Bachelor of Science", "Exercise Science", { location: "Newark, DE", start_date: "1985-01-01", start_date_precision: "year", end_date: "1990-01-01", end_date_precision: "year" })];
const ce = (name, issuing_body, extra = {}) => ({ name, issuing_body, license_number: null, issue_date: null, issue_date_precision: null, expiration_date: null, expiration_date_precision: null, license_state: null, ...extra });
const coursiv = ["Generative Al Fundamentals & Advanced Applications (ChatGPT)", "Conversational Al & Workflow Automation (Claude)", "Al Model Strategy & Comparative Analysis (DeepSeek)", "Multimodal Al & Productivity Integration (Gemini)", "AlContent Creation & Marketing Automation (Jasper)", "Rapid Web App Prototyping with Al (Lovable)", "Al Visual Design & Image Generation (MidJourney)", "Diffusion Models & Creative Al (Stable Diffusion)"];
const F_C = [...coursiv.map((x) => ce(x, "Coursiv")), ce("AI Video Generation & Cinematic Workflows (Veo)", "Coursiv"), ...["Business Operations Management", "Portfolio Management", "Product Development", "Workplace Productivity"].map((x) => ce(x, ""))];
const H_C = [...coursiv.map((x) => ce(x, "Coursiv")), ce("Al Video Generation & Cinematic Workflows (Veo)", "Coursiv"), ...["Business Operations Management", "Portfolio Management", "Product Development", "Workplace Productivity"].map((x) => ce(x, "")), ce("Plumber", "", { license_number: "CFC1425829" })];
const F_S = ["Al Solutions Architecture & Deployment", "CRM & Customer Lifecycle Management", "Generative Al Tool Integration", "Al Prompt Engineering", "Enterprise Customer Success", "Change Management & Adoption"];
const H_S = ["AI Solutions Architecture & Deployment", "CRM & Customer Lifecycle Management", "Generative AI Tool Integration", "Al Prompt Engineering", "Enterprise Customer Success", "Change Management & Adoption"];
const copy = (a) => a.map((x) => ({ ...x }));
const mut = (a, i, patch) => a.map((x, k) => (k === i ? { ...x, ...patch } : { ...x }));

console.log("== REAL PAIR: Full Resume demo (verified record)  ->  Hybrid demo resume (new file)");
let r = M.matchWork(F_W, H_W);
t("jobs: the two jobs in both files are KEPT (new file states no company: omission is not a change)", kept(r) === 2 && changed(r) === 0, cls(r));
t("jobs: the dropped job is REMOVED", r.removed.length === 1 && F_W[r.removed[0]].title.startsWith("AI Solutions"));
t("jobs: kept pairs carry the 'company not stated' flag so the review screen can say so", r.pairs.every((p) => p.flags.includes("company_not_stated")));
r = M.matchEducation(F_E, H_E);
t("education: a template placeholder has no institution, so the verified degree is REMOVED and the placeholder ADDED", r.pairs.length === 0 && r.removed.length === 1 && r.added.length === 1);
r = M.matchCertifications(F_C, H_C);
t("certs: 13 KEPT (incl. the 'AI'/'Al' OCR variant), 0 changed, 0 removed, 1 ADDED (the Plumber license)", kept(r) === 13 && changed(r) === 0 && r.removed.length === 0 && r.added.length === 1 && H_C[r.added[0]].name === "Plumber", cls(r));
t("certs: the OCR-variant title alone: exact-string matching would have called it removed+added; here it is kept", F_C[8].name !== H_C[8].name && r.pairs.some((p) => p.oldIdx === 8 && p.newIdx === 8 && p.cls === "kept"));
const sk = M.matchTexts(F_S, H_S, 0.92);
t("skills: 'AI'/'Al' variants of the same skill match; nothing added or removed", sk.pairs.length === 6 && sk.added.length === 0 && sk.removed.length === 0);

console.log("== IDENTITY / REORDER");
r = M.matchWork(F_W, copy(F_W)); t("the same file again: every job KEPT, none changed", kept(r) === 3 && changed(r) === 0);
r = M.matchWork(F_W, [F_W[2], F_W[0], F_W[1]].map((x) => ({ ...x }))); t("sections reordered: every job KEPT", kept(r) === 3 && r.removed.length === 0 && r.added.length === 0);
r = M.matchCertifications(F_C, [...F_C].reverse().map((x) => ({ ...x }))); t("certifications reversed: all 13 KEPT", kept(r) === 13);

console.log("== INTEGRITY: unrelated resumes must produce ZERO kept");
r = M.matchWork(Y_W, F_W); t("owner's resume -> Full Resume demo jobs: nothing kept", kept(r) === 0, cls(r));
r = M.matchEducation(Y_E, F_E);
t("education: same school, same level, but the verified record has dates/field the new one contradicts or adds -> CHANGED, never kept", r.pairs.length === 1 && r.pairs[0].cls === "changed" && r.pairs[0].changes.some((c) => c.field === "field_of_study"), JSON.stringify(r.pairs[0]?.changes));

console.log("== WORK: changed facts vs cosmetic");
r = M.matchWork(F_W, mut(F_W, 2, { title: "Business Operations & Portfolio Mgr" })); t("title abbreviation 'Manager' -> 'Mgr' is cosmetic: KEPT", kept(r) === 3, cls(r));
r = M.matchWork(F_W, mut(F_W, 2, { title: "Director of Business Operations" })); t("title materially changed (promotion): CHANGED", r.pairs[2].cls === "changed" && r.pairs[2].changes[0].field === "title" && kept(r) === 2, cls(r));
r = M.matchWork(F_W, mut(F_W, 0, { end_date: "2025-01-01", end_date_precision: "year" })); t("end date 'Present' -> a specific year: CHANGED", r.pairs[0].cls === "changed" && r.pairs[0].changes[0].field === "end_date");
r = M.matchWork(F_W, mut(F_W, 1, { end_date: null, end_date_precision: "present" })); t("end date 2023 -> explicit 'Present': CHANGED", r.pairs[1].cls === "changed" && r.pairs[1].changes[0].after === "Present");
r = M.matchWork(F_W, mut(F_W, 1, { end_date: null, end_date_precision: null })); t("end date 2023 -> not stated at all: KEPT with a 'not stated' flag (omission is not an assertion)", r.pairs[1].cls === "kept" && r.pairs[1].flags.includes("end_date_not_stated"));
r = M.matchWork(F_W, mut(F_W, 1, { start_date: "2019-03-01", start_date_precision: "month" })); t("start date 2019 -> Mar 2019 (consistent, finer): KEPT as verified, precision difference noted", r.pairs[1].cls === "kept" && r.pairs[1].flags.includes("date_precision_differs_kept_as_verified"));
r = M.matchWork(F_W, mut(F_W, 2, { company: "IBM Watson Health" })); t("company renamed, same title and dates: CHANGED (company)", r.pairs[2].cls === "changed" && r.pairs[2].changes[0].field === "company", cls(r));
r = M.matchWork(F_W, mut(F_W, 2, { start_date: "2015-01-01" })); t("start date shifted 2014 -> 2015: CHANGED (start_date)", r.pairs[2].cls === "changed" && r.pairs[2].changes[0].field === "start_date");
r = M.matchWork(F_W, mut(F_W, 1, { job_responsibilities: "Completely rewritten bullet text." })); t("only the responsibilities text differs: KEPT, listed as a descriptive update", r.pairs[1].cls === "kept" && r.pairs[1].descriptive.includes("responsibilities"));
r = M.matchWork(F_W, mut(F_W, 0, { location: "Sebastian, Florida" })); t("location 'FL' vs 'Florida': same, KEPT", r.pairs[0].cls === "kept");
r = M.matchWork(F_W, mut(F_W, 0, { location: "Ann Arbor, MI" })); t("location both stated and different: CHANGED", r.pairs[0].cls === "changed" && r.pairs[0].changes[0].field === "location");
r = M.matchWork(F_W, mut(F_W, 1, { location: "Vero Beach, FL" })); t("location ADDED where the verified record had none: not a re-verification (exception), KEPT", r.pairs[1].cls === "kept");
r = M.matchWork(F_W, mut(F_W, 0, { location: null })); t("location dropped in the new file: KEPT", r.pairs[0].cls === "kept");
r = M.matchWork([{ ...F_W[1], employer_name_override: "Indian River County School District" }], [{ ...F_W[1], company: "Indian River County School District" }]); t("the staff-set employer name override counts as the verified company: KEPT", kept(r) === 1);
r = M.matchWork([wk("Acme", "Analyst", "2010", "2012")], [wk("Acme", "Analyst", "2010", "2012"), wk("Acme", "Analyst", "2015", "2018")]); t("two stints at one employer, old has one: the exact stint is KEPT, the second ADDED", kept(r) === 1 && r.added.length === 1 && r.pairs[0].newIdx === 0);
r = M.matchWork([wk("Acme", "Analyst", "2010", "2012"), wk("Acme", "Analyst", "2010", "2012")], [wk("Acme", "Analyst", "2010", "2012")]);
t("AMBIGUOUS: two identical verified stints, one new: never KEPT (flagged and CHANGED), the other REMOVED", r.pairs.length === 1 && r.pairs[0].cls === "changed" && r.pairs[0].ambiguous && r.removed.length === 1);
r = M.matchWork([wk("Acme", "Analyst", "2010", "2012")], [wk("Beta Corp", "Chef", "2010", "2012")]); t("different company AND title, same dates: not the same job (removed + added)", r.pairs.length === 0 && r.removed.length === 1 && r.added.length === 1);
r = M.matchWork([wk("Acme, Florida", "Analyst", "2010", "2012")], [wk("Beta, Florida", "Cook", "2010", "2012")]); t("two different employers that both end ', Florida' do not match on the shared state", r.pairs.length === 0);
r = M.matchWork([wk("Acme", "Analyst", "2010", "2012")], [wk("Acme", "Analyst", "2010", "2012", { company: "[Company Name]" })]); t("a template placeholder company is blank, not a change", r.pairs.length === 1 && r.pairs[0].cls === "kept");

console.log("== EDUCATION");
const EDU = ed("University of Delaware", "Bachelor's Degree", "Education");
r = M.matchEducation([EDU], [ed("Univ. of Delaware", "Bachelor's Degree", "Education")]); t("'Univ.' abbreviation: KEPT", kept(r) === 1);
r = M.matchEducation([EDU], [ed("University of Delaware", "Bachelor's Degree", "Education", { start_date: "1985-01-01", start_date_precision: "year" })]); t("new file adds dates the verified record lacked: CHANGED (an unverified claim), start_date 'added'", r.pairs[0].cls === "changed" && r.pairs[0].changes[0].kind === "added");
r = M.matchEducation([EDU], [ed("University of Delaware", "Bachelor of Science", "Education")]); t("generic 'Bachelor's Degree' -> specific 'Bachelor of Science': the specificity is new: CHANGED", r.pairs[0].cls === "changed" && r.pairs[0].changes[0].field === "degree");
r = M.matchEducation([ed("University of Delaware", "Bachelor of Science", "Exercise Science")], [ed("University of Delaware", "Bachelor's Degree", "Exercise Science")]); t("specific -> generic: KEPT (the verified detail stays)", r.pairs[0].cls === "kept" && r.pairs[0].flags.includes("degree_not_stated") === false);
r = M.matchEducation([EDU], [ed("University of Delaware", "Master of Science", "Education")]); t("same school, different degree level: two different items (no pair)", r.pairs.length === 0 && r.removed.length === 1 && r.added.length === 1);
r = M.matchEducation([EDU, ed("University of Delaware", "Master of Science", "Physics")], [ed("University of Delaware", "Master of Science", "Physics"), EDU]); t("bachelor's and master's at one school, reordered: both KEPT", kept(r) === 2);

console.log("== CERTIFICATIONS AND LICENSES");
const LIC = ce("Certified Plumbing Contractor", "DBPR", { license_number: "CFC1425829", license_state: "FL" });
r = M.matchCertifications([LIC], [{ ...LIC, name: "Plumber (Contractor)" }]); t("same license number, differently worded name: the number decides, KEPT (name similarity is not needed)", kept(r) === 1, cls(r));
r = M.matchCertifications([LIC], [{ ...LIC, license_number: "CFC 142 5829" }]); t("license number with spaces/punctuation: same number, KEPT", kept(r) === 1);
r = M.matchCertifications([LIC], [{ ...LIC, license_number: "CFC1425830" }]); t("a DIFFERENT number with the same name is a different license (removed + added)", r.pairs.length === 0);
r = M.matchCertifications([LIC], [{ ...LIC, expiration_date: "2027-08-31", expiration_date_precision: "day" }]); t("expiration date newly stated (renewal): CHANGED", r.pairs[0].cls === "changed" && r.pairs[0].changes[0].field === "expiration_date");
r = M.matchCertifications([{ ...LIC, expiration_date: "2025-08-31", expiration_date_precision: "day" }], [{ ...LIC, expiration_date: "2027-08-31", expiration_date_precision: "day" }]); t("expiration date changed: CHANGED", r.pairs[0].cls === "changed");
r = M.matchCertifications([LIC], [{ ...LIC, license_state: "GA" }]); t("license state changed: CHANGED", r.pairs[0].cls === "changed" && r.pairs[0].changes[0].field === "license_state");
r = M.matchCertifications([{ ...LIC, license_state: null }], [LIC]); t("state newly detected where the verified record had none: CHANGED (additive)", r.pairs[0].cls === "changed");
r = M.matchCertifications([LIC], [{ ...LIC, license_state: null }]); t("state not detected in the new file: KEPT with a flag", r.pairs[0].cls === "kept" && r.pairs[0].flags.includes("license_state_not_stated"));
r = M.matchCertifications([ce("PMP", "PMI")], [ce("PMP", "")]); t("issuer not stated in the new file: KEPT", kept(r) === 1);
r = M.matchCertifications([ce("PMP", "")], [ce("PMP", "PMI")]); t("issuer newly stated: CHANGED (additive)", r.pairs[0].cls === "changed");
r = M.matchCertifications([ce("PMP", "PMI")], [ce("Scrum Master", "PMI")]); t("different certifications from one issuer: not the same", r.pairs.length === 0);

console.log("== EXTRACTION-MISS CHECK (a removal whose text is still in the new file)");
const doc = M.fold("Experience  Truven Health Analytics  Business Integration Manager 2008 - 2016. QPharma. Skills: Agile Waterfall");
t("company name present in the new file's text -> true", M.presentInText(doc, "QPharma") === true);
t("OCR variant of the name still found (l/I fold)", M.presentInText(M.fold("Workplace Productivity certificate"), "Workpiace Productivity") === true);
t("not present -> false", M.presentInText(doc, "Letraset") === false);
t("no document text to check against -> null (unknown, said so)", M.presentInText(null, "QPharma") === null);
t("needles under 5 characters are not trusted", M.presentInText(doc, "Lab") === false);

console.log("== INTEGRITY FUZZ: no factual mutation of a real row may ever come out KEPT (deterministic seed)");
{
  let seed = 20260921; const rnd = () => ((seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296);
  const pick = (a) => a[Math.floor(rnd() * a.length)];
  const jobs = [...F_W, ...Y_W]; const titles = jobs.map((j) => j.title); const cos = jobs.map((j) => j.company);
  let runs = 0, falseKept = 0, falseChanged = 0;
  for (let k = 0; k < 4000; k++) {
    const base = pick(jobs); const others = jobs.filter((j) => j !== base);
    const m = { ...base }; const kind = Math.floor(rnd() * 6);
    if (kind === 0) m.title = pick(titles.filter((x) => x !== base.title));
    else if (kind === 1) m.company = pick(cos.filter((x) => M.companySim(x, base.company) < 0.6));
    else if (kind === 2 && base.start_date) { m.start_date = `${Number(base.start_date.slice(0, 4)) + 1 + Math.floor(rnd() * 3)}-01-01`; }
    else if (kind === 3) { if (base.end_date_precision === "present") { m.end_date = "2025-01-01"; m.end_date_precision = "year"; } else { m.end_date = null; m.end_date_precision = "present"; } }
    else if (kind === 4 && base.end_date) { m.end_date = `${Number(base.end_date.slice(0, 4)) + 1 + Math.floor(rnd() * 3)}-01-01`; }
    else continue;
    runs++;
    const r = M.matchWork([base, ...others.slice(0, 2)], [m, ...others.slice(0, 2).map((x) => ({ ...x }))]);
    const p0 = r.pairs.find((p) => p.oldIdx === 0);
    if (p0 && p0.cls === "kept") falseKept++;
  }
  t(`${runs} random factual mutations of real jobs (title, company, start, end, present-flip): zero came out KEPT`, runs > 500 && falseKept === 0, `false kept: ${falseKept}`);
  // the opposite direction: pure noise must not cause re-verification
  let noise = 0, noiseChanged = 0;
  for (let k = 0; k < 2000; k++) {
    const base = pick(jobs); const m = { ...base };
    const kind = Math.floor(rnd() * 4);
    if (kind === 0) m.title = base.title.toUpperCase();
    else if (kind === 1) m.company = (base.company || "").replace(/ /g, "  ") + " ";
    else if (kind === 2) m.title = base.title.replace(/ai/gi, "Al");
    else m.job_responsibilities = "brand new bullet " + k;
    noise++;
    const r = M.matchWork([base], [m]); if (!(r.pairs.length === 1 && r.pairs[0].cls === "kept")) noiseChanged++;
  }
  t(`${noise} noise-only variants (case, spacing, AI/Al, new bullet text): zero flagged as changed`, noiseChanged === 0, `flagged: ${noiseChanged}`);
}

console.log("== NORMALISATION");
t("fold: 'AI' and 'Al' are the same", M.fold("AI Video") === M.fold("Al Video"));
t("placeholders clean to blank", M.clean("[Institution Name]") === "" && M.clean(" Acme  Corp ") === "Acme Corp");
t("dateRel: year vs month consistent = same; conflict; present vs date = conflict; omitted; added", M.dateRel("2019", "2019-03") === "same" && M.dateRel("2019", "2020") === "conflict" && M.dateRel("present", "2020") === "conflict" && M.dateRel("2019", null) === "omitted" && M.dateRel(null, "2019") === "added");

console.log(bad ? `\n${bad} of ${n} FAILED` : `\nall ${n} passed`);
process.exit(bad ? 1 : 0);
