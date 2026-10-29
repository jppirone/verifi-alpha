// node --experimental-strip-types tools/resume/test-resume-role-buckets.ts   (no dependencies, no network, no model call)
// Feeds stored OCR text and stored page-extraction output of the Oct 15 test uploads (PironeSimple, Asampletest) and OCR text of the
// other test documents into the role bucket check (AP9, John's rule of Oct 16, 2026). Expected results: docs/ap9-expected.txt.
import assert from "node:assert/strict";
import { repairRoleBuckets, orderRoleGroupsLatestFirst, type RoleEntry } from "../../supabase/functions/_shared/resume-role-buckets.ts";
// The check writes a repaired group in the order the page merge needs; orderRoleGroupsLatestFirst gives the final order (latest first).
const fin = (r: { work_history: RoleEntry[] }) => orderRoleGroupsLatestFirst(r.work_history.map((w) => ({ ...w })));

let n = 0; const t = (name: string, fn: () => void) => { fn(); n++; console.log("ok  ", name); };

// ---------- PironeSimple, page 2 (stored OCR text, tesseract) ----------
const TR_BULLETS = [
  "Led cross-functional discovery across 15 professional medical journals, aligning a core decision-making team of 45-50 stakeholders (within a broader project team of approximately 250) on requirements, constraints, and success criteria for a unified editorial workflow platform.",
  "Ran a 4-month RFP process; when no external vendor met business requirements, authored and delivered an internal proposal in place of a vendor response, which the business selected over the finalist vendor solutions.",
  "Delivered the full platform RFP through rollout in 13 months against a 16-month target.",
  "Consolidated 40+ legacy tracking, indexing, and workflow applications into one enterprise platform serving 15 journals, cutting editing-to-layout throughput from 3-4 months to 1 month or less per issue cycle.",
  "Redeployed existing staff capacity across properties to cover backlogs and delays as needed an operational flexibility that didn't exist before the platform consolidation.",
].join("\n");
const SIMPLE_P2 = `Developed APIs enabling other internal teams to hook into the platform's content engine and generate content for the shell
application, extending platform reuse beyond the original development team.
Manager of Business Analysis and Publishing Systems | Thomson Reuters | Montvale, NJ | 1996 1998
—
Promoted mid-year from Desktop Publishing Manager (1996-1997)
+ Led cross-functional discovery across 15 professional medical journals, aligning a core decision-making team of 45-50
stakeholders (within a broader project team of approximately 250) on requirements, constraints, and success criteria for a
unified editorial workflow platform.
Ran a 4-month RFP process; when no external vendor met business requirements, authored and delivered an internal proposal
in place of a vendor response, which the business selected over the finalist vendor solutions.
Delivered the full platform RFP through rollout in 13 months against a 16-month target.
— —
Consolidated 40+ legacy tracking, indexing, and workflow applications into one enterprise platform serving 15 journals,
cutting editing-to-layout throughput from 3-4 months to 1 month or less per issue cycle.
+ Redeployed existing staff capacity across properties to cover backlogs and delays as needed an operational flexibility that
—
didn't exist before the platform consolidation.
Project Manager | Letraset | Paramus, NJ | 1995 — 1996
+ Managed delivery of an HTML-based CD-ROM product platform to a customer base in the thousands, including vendor`;
const NOTE = "Promoted mid-year from Desktop Publishing Manager (1996-1997)";
const base = { location: "Montvale, NJ", heading: "PROFESSIONAL EXPERIENCE", extraction_confidence: "high" };
const storedSplit = (): RoleEntry[] => [
  { company: "Thomson Healthcare", title: "Manager of Handheld Application Development", start_date: "2001", end_date: "2003", job_responsibilities: "Designed the initial architecture for a mobile product delivery platform.", location: "Montvale, NJ", heading: "PROFESSIONAL EXPERIENCE", position: 3 },
  { ...base, company: "Thomson Reuters", title: "Desktop Publishing Manager", start_date: "1996", end_date: "1997", job_responsibilities: "", position: 4 },
  { ...base, company: "Thomson Reuters", title: "Manager of Business Analysis and Publishing Systems", start_date: "1997", end_date: "1998", job_responsibilities: TR_BULLETS, position: 5 },
  { company: "Letraset", title: "Project Manager", start_date: "1995", end_date: "1996", job_responsibilities: "Managed delivery of an HTML-based CD-ROM product platform.", location: "Paramus, NJ", heading: "PROFESSIONAL EXPERIENCE", position: 6 },
];
const tr = (r: ReturnType<typeof repairRoleBuckets>) => fin(r).filter((w) => w.company === "Thomson Reuters");

t("PironeSimple stored split: header role keeps the header dates and gets the note line first, the earlier role is its own empty entry", () => {
  const r = repairRoleBuckets(SIMPLE_P2, storedSplit());
  const rows = tr(r);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].title, "Manager of Business Analysis and Publishing Systems");
  assert.equal(rows[0].start_date, "1996");
  assert.equal(rows[0].end_date, "1998");
  assert.equal(rows[0].job_responsibilities, `${NOTE}\n${TR_BULLETS}`);
  assert.equal(rows[1].title, "Desktop Publishing Manager");
  assert.equal(rows[1].start_date, "1996");
  assert.equal(rows[1].end_date, "1997");
  assert.equal(rows[1].job_responsibilities, "");
  assert.equal(rows[0].company, "Thomson Reuters"); assert.equal(rows[1].company, "Thomson Reuters");
  assert.equal(r.needsReview.length, 0);
  assert.equal(r.work_history.length, 4); // the other jobs are untouched and still there
  assert.deepEqual(r.work_history.filter((w) => w.company !== "Thomson Reuters"), storedSplit().filter((w) => w.company !== "Thomson Reuters"));
});

t("PironeSimple: the input array is not changed (the check works on copies)", () => {
  const input = storedSplit(); const copy = JSON.parse(JSON.stringify(input));
  repairRoleBuckets(SIMPLE_P2, input);
  assert.deepEqual(input, copy);
});

t("PironeSimple: running the check twice gives the same result (idempotent)", () => {
  const once = repairRoleBuckets(SIMPLE_P2, storedSplit());
  const twice = repairRoleBuckets(SIMPLE_P2, once.work_history);
  assert.deepEqual(twice.work_history, once.work_history);
  assert.equal(twice.needsReview.length, 0);
});

t("one correct header entry and no earlier role (the model followed the new prompt but missed the dated note): earlier role added", () => {
  const one = storedSplit().filter((w) => w.title !== "Desktop Publishing Manager");
  one.find((w) => w.company === "Thomson Reuters")!.start_date = "1996";
  const r = repairRoleBuckets(SIMPLE_P2, one);
  const rows = tr(r);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].job_responsibilities, `${NOTE}\n${TR_BULLETS}`);
  assert.equal(rows[1].title, "Desktop Publishing Manager");
  assert.equal(rows[1].job_responsibilities, "");
});

t("an old style joined title entry is NOT guessed at: nothing changes, a needs_review entry with the literal lines is added", () => {
  const joined = [{ ...base, company: "Thomson Reuters", title: "Desktop Publishing Manager to Manager of Business Analysis and Publishing Systems", start_date: "1996", end_date: "1998", job_responsibilities: TR_BULLETS, position: 1 }];
  const r = repairRoleBuckets(SIMPLE_P2, joined);
  assert.deepEqual(r.work_history, joined);
  assert.equal(r.needsReview.length, 1);
  assert.equal(r.needsReview[0].section_type, "needs_review");
  assert.ok(r.needsReview[0].content.includes(NOTE));
  assert.ok(r.needsReview[0].content.includes("Manager of Business Analysis and Publishing Systems | Thomson Reuters | Montvale, NJ | 1996 1998"));
});

// ---------- PironeSimple, page 1: the Indian River pair must stay two entries (rule 10) ----------
const SIMPLE_P1 = `PROFESSIONAL EXPERIENCE
Associate Dean of Discipline | School District of Indian River County | Sebastian, FL | 2025 2026
—
Role transition; retained Business Education Teacher title of record per district process
* Took on discipline administration responsibilities with no formal job description or existing process in place; built the role's
core operating procedures from the ground up.
+ Designed and implemented a system to collect coursework from teachers for students placed in In-School Suspension and
track assignment completion, coordinating with the district's full teaching staff (110+ teachers) to support 15-25 students
weekly.
Business Education Teacher | School District of Indian River County | Sebastian, FL | 2018 2025
—
Designed and delivered curriculum across three instructional tracks Microsoft Office, WordPress, and foundational
—
computer skills and administered annual certification testing for all three.
—
Achieved certification pass rates above 90% every year, improving year over year to a high of 97% in 2024-2025.
Business Integration Manager | Truven Health Analytics (IBM Watson Health) | Ann Arbor, MI | 2008 2016
—
+ Led integration efforts for 5 enterprise acquisitions over 8 years, coordinating cross-functional teams ranging from 50 to`;
t("Indian River pair (two complete headers, a Role transition caption) is never merged or changed", () => {
  const sd = (title: string, s: string, e: string, text: string): RoleEntry => ({ company: "School District of Indian River County", title, start_date: s, end_date: e, job_responsibilities: text, location: "Sebastian, FL", heading: "PROFESSIONAL EXPERIENCE" });
  const input = [
    sd("Associate Dean of Discipline", "2025", "2026", "Role transition; retained Business Education Teacher title of record per district process\nTook on discipline administration responsibilities."),
    sd("Business Education Teacher", "2018", "2025", "Designed and delivered curriculum."),
    { company: "Truven Health Analytics (IBM Watson Health)", title: "Business Integration Manager", start_date: "2008", end_date: "2016", job_responsibilities: "Led integration efforts.", location: "Ann Arbor, MI", heading: "PROFESSIONAL EXPERIENCE" },
  ];
  const r = repairRoleBuckets(SIMPLE_P1, input);
  assert.deepEqual(r.work_history, input);
  assert.equal(r.needsReview.length, 0);
  assert.deepEqual(r.actions, []);
});

// ---------- Asampletest, page 1 (stored OCR text and stored merged model output) ----------
const ASAMPLE_P1 = `PROFESSIONAL EXPERIENCE
WESTCX, Remote September 2023 August 2026
-
WestCx is a cloud-based technology partner that delivers AI-powered solutions for regulated industries like
healthcare, pharmacy, and financial services. The company was acquired in July 2026.
Senior Recruiter, July 2024 August 2026
-
PE-backed, cloud-based AI customer & patient experience platform
e = =Managed recruiting for multiple departments across dual company segments, including GTM sales teams,
product, engineering, and IT, owning full-cycle recruiting solo for both TeleVox and Mosaicx (including the
India entity, TVX Private Ltd.), and built cross-functional expertise by partnering with technical, operational,
and executive leaders.
Standardized the global recruiting SOP by streamlining the end-to-end process across two countries,
replacing ad hoc handoffs with defined approval gates and clear ownership, reducing requisition-to-offer
cycle time by 7-10 days at the front end.
Created standardized intake forms for hiring managers that eliminated the stalled-request cycle and
established a clear, auditable approval trail for every hire and every dollar of contractor spend.
e Consolidated four separate corporate contractor request types (new vendor, new contractor, extension,
add-funds) into a unified cross-functional workflow connecting HR, finance, procurement, and compliance,
eliminating 4-6 hours of manual reconciliation per request and amplifying time savings for multi-contractor
requests.
Recruiter, September 2023 June 2024
-
Recruited solely for the TeleVox business segment, a patient engagement platform
¢ Promoted into an expanded Senior Recruiter scope after the manager role was eliminated, reporting directly
to the CHRO with added ownership across HR Operations and Vendor Management.
e Established the initial APAC agency relationships and operating frameworks for a new India-based office,
hiring 25 technical and product professionals against a 3-month deliverable SLA the foundation that later
-
scaled into the company's current international hiring operations.`;
const WC_DESC = "WestCx is a cloud-based technology partner that delivers AI-powered solutions for regulated industries like healthcare, pharmacy, and financial services. The company was acquired in July 2026.";
const WC_REC = "Recruited solely for the TeleVox business segment, a patient engagement platform\nPromoted into an expanded Senior Recruiter scope after the manager role was eliminated, reporting directly to the CHRO with added ownership across HR Operations and Vendor Management.\nEstablished the initial APAC agency relationships and operating frameworks for a new India-based office, hiring 25 technical and product professionals against a 3-month deliverable SLA the foundation that later scaled into the company's current international hiring operations.";
const WC_SR = "PE-backed, cloud-based AI customer & patient experience platform\nManaged recruiting for multiple departments across dual company segments, including GTM sales teams, product, engineering, and IT, owning full-cycle recruiting solo for both TeleVox and Mosaicx (including the India entity, TVX Private Ltd.), and built cross-functional expertise by partnering with technical, operational, and executive leaders.\nStandardized the global recruiting SOP by streamlining the end-to-end process across two countries, replacing ad hoc handoffs with defined approval gates and clear ownership, reducing requisition-to-offer cycle time by 7-10 days at the front end.\nCreated standardized intake forms for hiring managers that eliminated the stalled-request cycle and established a clear, auditable approval trail for every hire and every dollar of contractor spend.\nConsolidated four separate corporate contractor request types (new vendor, new contractor, extension, add-funds) into a unified cross-functional workflow connecting HR, finance, procurement, and compliance, eliminating 4-6 hours of manual reconciliation per request and amplifying time savings for multi-contractor requests.";
const westStored = (): RoleEntry[] => [
  { company: "WESTCX", title: "Recruiter to Senior Recruiter", location: "Remote", start_date: "2023-09", end_date: "2026-08", heading: "PROFESSIONAL EXPERIENCE", extraction_confidence: "high", position: 2,
    job_responsibilities: `${WC_DESC}\n\nRecruiter, September 2023 - June 2024:\n${WC_REC}\n\nSenior Recruiter, July 2024 - August 2026:\n${WC_SR}` },
];
t("Asampletest WESTCX stored merged entry: two entries, one per dated role, no combined title, company copied, description on the latest role only", () => {
  const r = repairRoleBuckets(ASAMPLE_P1, westStored());
  assert.equal(r.work_history.length, 2);
  const [sr, rec] = r.work_history;
  assert.equal(sr.title, "Senior Recruiter"); assert.equal(sr.start_date, "2024-07"); assert.equal(sr.end_date, "2026-08");
  assert.equal(rec.title, "Recruiter"); assert.equal(rec.start_date, "2023-09"); assert.equal(rec.end_date, "2024-06");
  for (const w of r.work_history) { assert.equal(w.company, "WESTCX"); assert.equal(w.location, "Remote"); assert.equal(w.heading, "PROFESSIONAL EXPERIENCE"); assert.ok(!/ to /i.test(String(w.title))); }
  assert.equal(sr.job_responsibilities, `${WC_DESC}\n${WC_SR}`);
  assert.equal(rec.job_responsibilities, WC_REC);
  assert.ok(!String(rec.job_responsibilities).includes("WestCx is a cloud-based"));
  assert.equal(r.needsReview.length, 0);
});

t("WESTCX: the repaired entries are kept as they are when the check runs again", () => {
  const once = repairRoleBuckets(ASAMPLE_P1, westStored());
  const twice = repairRoleBuckets(ASAMPLE_P1, once.work_history);
  assert.deepEqual(twice.work_history, once.work_history);
});

// ---------- Asampletest page 2: single role jobs with a company line carrying the dates and an undated title line ----------
const ASAMPLE_P2 = `CONTRACT ENGAGEMENTS, Remote November 2020 May 2023
Various short term contracts allowing flexibility while caring for my mother in her final months
Sourcing Recruiter
Sourced niche professional roles in financial, technical, healthtech, and scientific verticals for enterprise clients
including NRUCFC ($31B+ utilities financial cooperative), NXP Semiconductors ($13B+ global technology company,
 Sourced and hired 70+ sales, engineering, and operations professionals across three enterprise businesses,
CDW, Remote November 2015 September 2020
CDW is a major provider of information technology (IT) hardware, software, and services.
Senior Talent Acquisition Specialist
Owned the complete hiring life cycle for CDW's prestigious Associate Consulting Engineer program in the US
 Built and scaled the Associate Consulting Engineer (ACE) program from the ground up, hiring 30-50 early-
EDUCATION
Bachelor of Science, Example University`;
t("Asampletest single role jobs (company line with dates, a title line with no dates of its own) are not role blocks and stay as extracted", () => {
  const input: RoleEntry[] = [
    { company: "CONTRACT ENGAGEMENTS", title: "Sourcing Recruiter", location: "Remote", start_date: "2020-11", end_date: "2023-05", job_responsibilities: "Various short term contracts.", heading: "" },
    { company: "CDW", title: "Senior Talent Acquisition Specialist", location: "Remote", start_date: "2015-11", end_date: "2020-09", job_responsibilities: "CDW is a major provider.", heading: "" },
  ];
  const r = repairRoleBuckets(ASAMPLE_P2, input);
  assert.deepEqual(r.work_history, input);
  assert.deepEqual(r.actions, []);
});

// ---------- Donofrio shape: one header, two sub-groups of bullets, an Affiliations style list (rules 7, false trigger risk) ----------
const DON = `Chief Technology Officer  Veritext LLC  Livingston, NJ  September 2015 -Present
Notable Experiences:
    - Transitioned all internal and external systems and products to a secure cloud hosting environment, driving
Senior VP, Chief Technology Officer  Truven Health Analytics  New York, NY  Apr 2011-Aug 2015
Notable Experiences:
    - Establishment of Truven Health Analytics as an independent entity from Thomson Reuters, including:
              o Carve-out planning and transition services negotiation
Responsibilities:
    - Lead an organization of over 500 technology, operations and product management professionals
Sr. VP Solution Operations  Thomson Reuters Healthcare & Science  Philadelphia, PA  Oct 2008-Mar 2011
Vice President Technology  Thomson Healthcare PDR  Montvale, NJ  Sep 2006-Oct 2008
Vice President Technology Operations  Thomson Scientific & Healthcare  Stamford, CT  Jun 2003-Oct 2006
Vice President Technology  Thomson Healthcare  Montvale, NJ  Nov 1998-Jun 2003
PROFESSIONAL AFFILIATIONS
Member, Technology Council 2010 2015
Thomson Leadership in Technology - 2002`;
t("Donofrio shape: one header with Notable Experiences and Responsibilities groups, similar Thomson names, an affiliations list: nothing triggers", () => {
  const e = (company: string, title: string, s: string, en: string): RoleEntry => ({ company, title, start_date: s, end_date: en, job_responsibilities: "Notable Experiences:\nResponsibilities:", heading: "" });
  const input = [
    e("Veritext LLC", "Chief Technology Officer", "2015-09", ""),
    e("Truven Health Analytics", "Senior VP, Chief Technology Officer", "2011-04", "2015-08"),
    e("Thomson Reuters Healthcare & Science", "Sr. VP Solution Operations", "2008-10", "2011-03"),
    e("Thomson Healthcare PDR", "Vice President Technology", "2006-09", "2008-10"),
    e("Thomson Scientific & Healthcare", "Vice President Technology Operations", "2003-06", "2006-10"),
    e("Thomson Healthcare", "Vice President Technology", "1998-11", "2003-06"),
  ];
  const r = repairRoleBuckets(DON, input);
  assert.deepEqual(r.work_history, input);
  assert.equal(r.needsReview.length, 0);
  assert.deepEqual(r.actions, []);
});

// ---------- Rule 3: a prose progression line with no date range of its own stays in the text ----------
t("rule 3: a bullet saying the person was promoted, with no date range, changes nothing", () => {
  const ocr = `Senior Analyst | Acme Corp | Austin, TX | 2015 2020
• Promoted from Analyst to Senior Analyst in 2017 after leading the reporting redesign.
• Built the forecasting model used by finance.`;
  const input: RoleEntry[] = [{ company: "Acme Corp", title: "Senior Analyst", start_date: "2015", end_date: "2020", job_responsibilities: "Promoted from Analyst to Senior Analyst in 2017 after leading the reporting redesign.\nBuilt the forecasting model used by finance." }];
  const r = repairRoleBuckets(ocr, input);
  assert.deepEqual(r.work_history, input);
  assert.deepEqual(r.actions, []);
});

t("rule 3: a line under the header with the words from <Title> but no years in parentheses changes nothing", () => {
  const ocr = `Senior Analyst | Acme Corp | Austin, TX | 2015 2020
Promoted mid-year from Analyst
• Built the forecasting model used by finance.`;
  const input: RoleEntry[] = [{ company: "Acme Corp", title: "Senior Analyst", start_date: "2015", end_date: "2020", job_responsibilities: "Promoted mid-year from Analyst\nBuilt the forecasting model used by finance." }];
  assert.deepEqual(repairRoleBuckets(ocr, input).work_history, input);
});

// ---------- Rule 4 variants ----------
t("rule 4: Previously <Title> (years) note also creates the empty earlier role", () => {
  const ocr = `Senior Analyst | Acme Corp | Austin, TX | 2015 2020
Previously Analyst (2012-2015)
• Built the forecasting model used by finance.`;
  const input: RoleEntry[] = [{ company: "Acme Corp", title: "Senior Analyst", start_date: "2015", end_date: "2020", job_responsibilities: "Built the forecasting model used by finance.", location: "Austin, TX" }];
  const f = fin(repairRoleBuckets(ocr, input));
  assert.equal(f.length, 2);
  assert.equal(f[0].job_responsibilities, "Previously Analyst (2012-2015)\nBuilt the forecasting model used by finance.");
  assert.deepEqual([f[1].title, f[1].start_date, f[1].end_date, f[1].job_responsibilities, f[1].company], ["Analyst", "2012", "2015", "", "Acme Corp"]);
});

t("rule 4: a header whose end is Present keeps an empty end date, never an invented one", () => {
  const ocr = `Director | Acme Corp | Austin, TX | March 2020 Present
Promoted from Manager (2017-2020)
• Built the forecasting model used by finance.`;
  const input: RoleEntry[] = [{ company: "Acme Corp", title: "Director", start_date: "2020-03", end_date: "", job_responsibilities: "Built the forecasting model used by finance." }];
  const f = fin(repairRoleBuckets(ocr, input));
  assert.equal(f[0].start_date, "2020-03"); assert.equal(f[0].end_date, "");
  assert.equal(f[1].title, "Manager"); assert.equal(f[1].end_date, "2020");
});

// ---------- Rule 2: roles with their own years and ONE pooled bullet list ----------
t("rule 2: dated role lines together, one pooled list: the latest role gets all of it, the other role is an empty entry", () => {
  const ocr = `NORTHWIND SUPPLY CO., Austin, TX 2017 2023
Senior Manager, 2020 2023
Manager, 2017 2020
• Managed daily operations for a team of twelve and reduced order errors by 18%.
• Introduced a weekly review process that shortened onboarding time for new staff.
EDUCATION`;
  const input: RoleEntry[] = [{ company: "NORTHWIND SUPPLY CO.", title: "Senior Manager", location: "Austin, TX", start_date: "2017", end_date: "2023", job_responsibilities: "Managed daily operations for a team of twelve and reduced order errors by 18%.\nIntroduced a weekly review process that shortened onboarding time for new staff.", heading: "EXPERIENCE" }];
  const r = repairRoleBuckets(ocr, input);
  assert.equal(r.work_history.length, 2);
  // written for the page merge: the role that holds the text is LAST; final order after the merge: latest role first
  assert.deepEqual(r.work_history.map((w) => w.title), ["Manager", "Senior Manager"]);
  const f = fin(r);
  assert.deepEqual(f.map((w) => [w.title, w.start_date, w.end_date]), [["Senior Manager", "2020", "2023"], ["Manager", "2017", "2020"]]);
  assert.ok(String(f[0].job_responsibilities).startsWith("Managed daily operations"));
  assert.equal(f[1].job_responsibilities, "");
});

// ---------- Unsettled ----------
t("dated role lines with bullets between them and no label lines in the entry text: nothing changes, flagged with the literal lines", () => {
  const ocr = `NORTHWIND SUPPLY CO., Austin, TX 2017 2023
Senior Manager, 2020 2023
• Managed daily operations for a team of twelve.
Manager, 2017 2020
• Introduced a weekly review process.
EDUCATION`;
  const input: RoleEntry[] = [{ company: "NORTHWIND SUPPLY CO.", title: "Manager to Senior Manager", start_date: "2017", end_date: "2023", job_responsibilities: "Managed daily operations for a team of twelve. Introduced a weekly review process.", position: 4 }];
  const r = repairRoleBuckets(ocr, input);
  assert.deepEqual(r.work_history, input);
  assert.equal(r.needsReview.length, 1);
  assert.equal(r.needsReview[0].position, 4);
  assert.ok(r.needsReview[0].content.includes("Senior Manager, 2020 2023") && r.needsReview[0].content.includes("Manager, 2017 2020"));
});

t("a bullet or a dated phrase inside bullet text is never a role line", () => {
  const ocr = `NORTHWIND SUPPLY CO., Austin, TX 2017 2023
Operations Manager, 2017 2023
• Led migration to the new ERP, 2019 2021
• Mentor, Rotary Club 2010 2015
EDUCATION`;
  const input: RoleEntry[] = [{ company: "NORTHWIND SUPPLY CO.", title: "Operations Manager", start_date: "2017", end_date: "2023", job_responsibilities: "Led migration to the new ERP, 2019 2021\nMentor, Rotary Club 2010 2015" }];
  const r = repairRoleBuckets(ocr, input);
  assert.deepEqual(r.work_history, input);
  assert.deepEqual(r.actions, []);
});

t("a bulleted line shaped like a title and a date range is not a role line (glyph check)", () => {
  const ocr = `NORTHWIND SUPPLY CO., Austin, TX 2017 2023
Operations Manager, 2017 2023
• Senior Analyst, 2019 2021
© Team Lead, 2018 2019
EDUCATION`;
  const input: RoleEntry[] = [{ company: "NORTHWIND SUPPLY CO.", title: "Operations Manager", start_date: "2017", end_date: "2023", job_responsibilities: "Senior Analyst, 2019 2021" }];
  assert.deepEqual(repairRoleBuckets(ocr, input).work_history, input);
});

t("a wrapped bullet line (no glyph) ending in a year range is not a role line (title shape check)", () => {
  const ocr = `NORTHWIND SUPPLY CO., Austin, TX 2017 2023
Operations Manager, 2017 2023
• Reduced order errors and led the migration to the new ERP platform across all sites,
and then trained the whole team on it, 2019 2021
Led migration to the new ERP, 2019 2021
EDUCATION`;
  const input: RoleEntry[] = [{ company: "NORTHWIND SUPPLY CO.", title: "Operations Manager", start_date: "2017", end_date: "2023", job_responsibilities: "Reduced order errors." }];
  const r = repairRoleBuckets(ocr, input);
  assert.deepEqual(r.work_history, input); assert.deepEqual(r.actions, []);
});

t("a note with from <Title> but years that are not a date range in parentheses changes nothing", () => {
  const ocr = `Senior Analyst | Acme Corp | Austin, TX | 2015 2020
Promoted from Analyst (see below)
• Built the model.`;
  const input: RoleEntry[] = [{ company: "Acme Corp", title: "Senior Analyst", start_date: "2015", end_date: "2020", job_responsibilities: "Promoted from Analyst (see below)\nBuilt the model." }];
  assert.deepEqual(repairRoleBuckets(ocr, input).work_history, input);
});

t("a sentence that merely starts with the company name is not a company line", () => {
  const ocr = `Northwind Supply Co. built a new onboarding program for twelve hires and trained them on the new process 2019 2021
Operations Manager, 2017 2020
Senior Manager, 2020 2023
EDUCATION`;
  const input: RoleEntry[] = [{ company: "Northwind Supply Co.", title: "Operations Manager", start_date: "2017", end_date: "2023", job_responsibilities: "Built." }];
  const r = repairRoleBuckets(ocr, input);
  assert.deepEqual(r.work_history, input); assert.deepEqual(r.actions, []);
});

t("no OCR text (a page read by vision): nothing is changed", () => {
  const input = storedSplit();
  assert.deepEqual(repairRoleBuckets(null, input).work_history, input);
  assert.deepEqual(repairRoleBuckets("", input).work_history, input);
});

// ---------- The other test documents: byte for byte unchanged ----------
const BEAST_P3 = `Business Operations & Portfolio Manager
Thomson Healthcare/Truven Health 2014 2019
—
© —Oversaw end-to-end portfolio and program management across multiple concurrent initiatives, coordinating
Managed enterprise client accounts and long-term relationship lifecycles, achieving 95%+ retention rates
SELECTED CAREER HIGHLIGHTS
* Led multi-stakeholder product development initiatives = Spearheaded process improvement projects reducing
WORKPLACE STRENGTHS
Strategic Thinking & Analytical Problem Solving approaches challenges with a big-picture mindset while`;
const BEAST_P2 = `PROFESSIONAL EXPERIENCE
AI Solutions Consultant & Customer Success Advisor
Independent / Freelance | 2023—Present | Sebastian, FL
Deliver AI tool evaluations, implementation roadmaps, and adoption playbooks for SMB and enterprise clients
Technical Training & Digital Skills Enablement Specialist
School District of Indian River County, Florida 2019 2023
—
© Designed and delivered digital literacy and technology training curricula for diverse adult learner populations,`;
const LISA = `PROFESSIONAL EXPERIENCE
VP, People & Talent Strategy, Luminary Labs | Baltimore, MD March 2021 Present
—
Recruited by rapidly scaling SaaS startup to build and operationalize the company’s first formal People function,
Director of Talent Acquisition, NorthBridge Technologies | Annapolis, MD June 2014 March 2021
—
Joined a mid-sized enterprise software company to modernize recruiting strategy and strengthen employer brand
EDUCATION`;
t("PironeBeast (pages 2 and 3), PironeBeastHybrid-style entries and Lisa Tom: no company has dated roles under it, nothing changes", () => {
  const beast: RoleEntry[] = [
    { company: "Independent / Freelance", title: "AI Solutions Consultant & Customer Success Advisor", start_date: "2023", end_date: "", job_responsibilities: "Deliver AI tool evaluations." },
    { company: "School District of Indian River County, Florida", title: "Technical Training & Digital Skills Enablement Specialist", start_date: "2019", end_date: "2023", job_responsibilities: "Designed and delivered digital literacy." },
  ];
  assert.deepEqual(repairRoleBuckets(BEAST_P2, beast).work_history, beast);
  const b3: RoleEntry[] = [{ company: "Thomson Healthcare/Truven Health", title: "Business Operations & Portfolio Manager", start_date: "2014", end_date: "2019", job_responsibilities: "Oversaw end-to-end portfolio." }];
  const r3 = repairRoleBuckets(BEAST_P3, b3);
  assert.deepEqual(r3.work_history, b3); assert.deepEqual(r3.actions, []);
  const hybrid: RoleEntry[] = [{ company: "", title: "Technical Training & Digital Skills Enablement Specialist", start_date: "2019", end_date: "2023", job_responsibilities: "Designed." }];
  assert.deepEqual(repairRoleBuckets(BEAST_P2, hybrid).work_history, hybrid);
  const lisa: RoleEntry[] = [
    { company: "Luminary Labs", title: "VP, People & Talent Strategy", location: "Baltimore, MD", start_date: "2021-03", end_date: "", job_responsibilities: "Recruited by rapidly scaling." },
    { company: "NorthBridge Technologies", title: "Director of Talent Acquisition", location: "Annapolis, MD", start_date: "2014-06", end_date: "2021-03", job_responsibilities: "Joined a mid-sized." },
  ];
  const rl = repairRoleBuckets(LISA, lisa);
  assert.deepEqual(rl.work_history, lisa); assert.deepEqual(rl.actions, []); assert.equal(rl.needsReview.length, 0);
});

// ---------- ordering: latest role first (AP9 phase D) ----------
t("ordering: the Thomson Reuters pair comes out latest role first (header role, then the empty earlier role), marker removed", () => {
  const r = repairRoleBuckets(SIMPLE_P2, storedSplit(), 2);
  assert.deepEqual(r.work_history.filter((w) => w.company === "Thomson Reuters").map((w) => w.title), ["Desktop Publishing Manager", "Manager of Business Analysis and Publishing Systems"]); // written for the page merge: header role last
  const f = fin(r).filter((w) => w.company === "Thomson Reuters");
  assert.deepEqual(f.map((w) => w.title), ["Manager of Business Analysis and Publishing Systems", "Desktop Publishing Manager"]);
  assert.ok(f.every((w) => !("_role_group" in w)));
});

t("ordering: the WESTCX pair comes out Senior Recruiter first, then Recruiter", () => {
  const f = fin(repairRoleBuckets(ASAMPLE_P1, westStored(), 1));
  assert.deepEqual(f.map((w) => w.title), ["Senior Recruiter", "Recruiter"]);
});

t("ordering: roles printed oldest first still come out latest first; an ongoing role (empty end date) comes first; entries outside a repaired group never move", () => {
  const ocr = `NORTHWIND SUPPLY CO., Austin, TX 2012 Present
Analyst, 2012 2016
• Prepared the monthly sales report.
Director, 2020 Present
• Led the regional operations team.
Manager, 2016 2020
• Introduced the new vendor onboarding checklist.
EDUCATION`;
  const before: RoleEntry = { company: "Other Co", title: "Clerk", start_date: "2000", end_date: "2005", job_responsibilities: "x", position: 0 };
  const merged: RoleEntry = { company: "NORTHWIND SUPPLY CO.", title: "Analyst to Director", location: "Austin, TX", start_date: "2012", end_date: "", job_responsibilities: "Analyst, 2012 - 2016:\nPrepared the monthly sales report.\n\nDirector, 2020 - Present:\nLed the regional operations team.\n\nManager, 2016 - 2020:\nIntroduced the new vendor onboarding checklist.", position: 1 };
  const after: RoleEntry = { company: "Last Co", title: "Intern", start_date: "1998", end_date: "1999", job_responsibilities: "y", position: 2 };
  const r = repairRoleBuckets(ocr, [before, merged, after], 1);
  assert.deepEqual(r.work_history.map((w) => w.title), ["Clerk", "Analyst", "Director", "Manager", "Intern"]); // written in printed order
  const f = fin(r);
  assert.deepEqual(f.map((w) => w.title), ["Clerk", "Director", "Manager", "Analyst", "Intern"]);
  assert.deepEqual(f.map((w) => w.position), [0, 1, 1, 1, 2]);
});

console.log(`\n${n} tests passed`);
