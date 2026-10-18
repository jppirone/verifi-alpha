// node --experimental-strip-types tools/resume/test-seam-repeat.ts   (needs git and the repo history, no network, no model call)
// AP9X-2: two repeat cases at a page seam in mergeBoundaryContinuations (upload-resume), applied before Fix D's fragment stitch:
//  Case A (partial then full): the previous last line (20+ characters, unterminated) is the start of the continuation's first line, which is longer -> the previous
//    last line is replaced by the continuation's first line.
//  Case B (repeat): the continuation's first line (60+ characters) already sits at the end of the previous text (its last 60 characters occur in the last 600
//    characters) -> that first line is dropped.
// The REAL merge code is cut out of upload-resume (this commit) and out of 286d5f4 (deployed) and compared on the exact stored results of the two documents
// (8a8b7717 Teacher job, 13537c49 Truven job) and on every distinct stored work history seam (read from resume_extraction_pages).
import assert from "node:assert/strict";
import fs from "node:fs";
import { execFileSync } from "node:child_process";
import { stripTypeScriptTypes } from "node:module";
import { repairRoleBuckets, orderRoleGroupsLatestFirst } from "../../supabase/functions/_shared/resume-role-buckets.ts";
import { restoreSkillText } from "../../supabase/functions/_shared/resume-skill-text.ts";

const tests: Array<[string, () => void | Promise<void>]> = [];
const t = (name: string, fn: () => void | Promise<void>) => tests.push([name, fn]);
const SRC = "supabase/functions/upload-resume/index.ts";
const srcNew = fs.readFileSync(new URL("../../" + SRC, import.meta.url), "utf8").replace(/\r\n/g, "\n");
const srcOld = execFileSync("git", ["show", "286d5f4:" + SRC], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }).replace(/\r\n/g, "\n");
async function loadMerge(src: string) {
  const cleanHeadingLine = src.split("\n").find((l) => l.startsWith("function cleanHeading("))!;
  const code = src.slice(src.indexOf("const PAGE_POSITION_SPAN"), src.indexOf("const RELAY_CALLS_PER_INVOCATION"));
  const exp = src.includes("function repeatSeamRule(") ? "mergeExtractions, dedupePositions, repeatSeamRule" : "mergeExtractions, dedupePositions";
  return await import("data:text/javascript;base64," + Buffer.from(stripTypeScriptTypes(cleanHeadingLine + "\n" + code) + `\nexport { ${exp} };`, "utf8").toString("base64")) as any;
}
const mNew = await loadMerge(srcNew), mOld = await loadMerge(srcOld);
const rule = mNew.repeatSeamRule as (prev: string, cont: string) => { text: string; kase: "A" | "B"; first: string } | null;
const EM = String.fromCharCode(8212);

const emptyEx = (o: any) => ({ candidate_location: "", candidate_phone: "", candidate_email: "", printed_header: "", work_history: [], education: [], certifications: [], skills: [], skills_heading: "", skills_position: null, freeform: [], ...o });
const job = (company: string, title: string, jr: string, o: any = {}) => ({ company, title, location: "", start_date: "2019", end_date: "2023", heading: "PROFESSIONAL EXPERIENCE", job_responsibilities: jr, extraction_confidence: "high", position: 0, ...o });
type Rep = Array<[string, string]>;
const run = (m: any, pages: any[], rep: Rep = []) => m.mergeExtractions(pages, (lvl: string, msg: string) => rep.push([lvl, msg]));
const twoPages = (prev: string, cont: string, ocr2: string | null | undefined = "next page text", company = "Acme Corp", title = "Analyst") => [
  { pageNumber: 1, extraction: emptyEx({ work_history: [job(company, title, prev, { position: 1 })] }), ocrText: "page one" },
  { pageNumber: 2, extraction: emptyEx({ work_history: [job(company, title, cont, { start_date: "", end_date: "", heading: "", position: 0 })] }), ocrText: ocr2 },
];
const textOf = (m: any, co = "Acme Corp") => m.work_history.find((w: any) => w.company === co).job_responsibilities as string;

// ---------- exact stored results ----------
const TEACHER_PREV = "Designed and delivered curriculum across three instructional tracks Microsoft Office, WordPress, and foundational computer skills and administered annual certification testing for all three.\nAchieved certification pass rates above 90% every year, improving year over year to a high";
const TEACHER_CONT = "Achieved certification pass rates above 90% every year, improving year over year to a high of 97% in 2024-2025.\nBuilt a rules-based restroom pass system using Power Automate, allowing students to request and print passes on demand while enforcing eligibility automatically based on school policy; added a tracking layer for reporting visibility.";
const SCHOOL = "School District of Indian River County", TEACHER = "Business Education Teacher";
const TRUVEN_PREV = "Led integration efforts for 5 enterprise acquisitions over 8 years, coordinating cross-functional teams ranging from 50 to 200+ stakeholders depending on the structure of each acquired organization.\nDesigned integration and rollout sequencing across Sales, Finance, Operations, and Technology, aligning stakeholders on scope, timeline, and success criteria before go-live.\nRedesigned sales-to-contract and invoicing workflows, reducing sale: support effort by an estimated 20 hours per contract across approximately 200 contracts annually, and cutting 5" + EM + "10 hours of client-facing invoice/AP clarification work per contract through end-to-end billing cleanup.\nBuilt process documentation and SOPs that served as the onboarding foundation for enterprise system implementations at scale.\nManaged cross-functional delivery and governance to bring complex implementations in on schedule and budget.\nDeveloped and executed API-based data mapping strategies across Salesforce, Pramata (contract management), and Oracle, plus one-off integrations for custom CRM and AP systems inherited through acquisitions, bringing sales, contract, and AP data onto standardized enterprise systems.\nLed a company-wide identity and access management rollout (Fischer Identity, layered over Microsoft Active Directory/Exchange) for 5,000+ employees across multiple geographies, including self-service provisioning for managers overseeing contractor access; audited and pruned approximately 500 dormant accounts with lingering post-termination access, closing a significant security gap. Built training curricula for both a Tier 1 offshore support team and company-wide self-service adoption.";
const TRUVEN_CONT = "Pruned approximately 500 dormant accounts with lingering post-termination access, closing a significant security gap. Built training curricula for both a Tier 1 offshore support team and company-wide self-service adoption.";
const TRUVEN = "Truven Health Analytics (IBM Watson Health)", BIM = "Business Integration Manager";

t("fixtures match the database lengths (Teacher 281 + 345, Truven 1667 + 222)", () => {
  assert.equal(TEACHER_PREV.length, 281); assert.equal(TEACHER_CONT.length, 345);
  assert.equal(TRUVEN_PREV.length, 1667); assert.equal(TRUVEN_CONT.length, 222);
});

t("Teacher job (8a8b7717): today's merge gives the stored 628 characters (partial bullet, blank line, full bullet); with AP9X-2 the bullet appears once in full", () => {
  const pages = twoPages(TEACHER_PREV, TEACHER_CONT, "of 97% in 2024-2025.\nBuilt a rules-based restroom pass system", SCHOOL, TEACHER);
  const before = textOf(run(mOld, pages), SCHOOL);
  assert.equal(before, TEACHER_PREV + "\n\n" + TEACHER_CONT); assert.equal(before.length, 628);
  const rep: Rep = [];
  const after = textOf(run(mNew, pages, rep), SCHOOL);
  assert.equal(after, TEACHER_PREV.split("\n")[0] + "\n" + TEACHER_CONT);
  assert.equal(after.split("Achieved certification pass rates above 90%").length - 1, 1, "the bullet appears once");
  assert.ok(after.includes("to a high of 97% in 2024-2025.\nBuilt a rules-based restroom pass system"));
  assert.ok(!after.includes("\n\n"), "no blank line left");
  assert.equal(rep.length, 1); assert.equal(rep[0][0], "log");
  assert.equal(rep[0][1], "seam repeat - page 2: case A, first 40 chars: Achieved certification pass rates above ");
  console.log("      TEACHER BEFORE (" + before.length + " chars): ..." + JSON.stringify(before.slice(before.indexOf("to a high") - 5, before.indexOf("to a high") + 120)));
  console.log("      TEACHER AFTER  (" + after.length + " chars): ..." + JSON.stringify(after.slice(after.indexOf("to a high") - 5, after.indexOf("to a high") + 120)));
});

t("Truven job (13537c49): today's merge gives 1891 characters (the repeated tail appended); with AP9X-2 the text is back to 1667", () => {
  const pages = twoPages(TRUVEN_PREV, TRUVEN_CONT, "Technical Project Manager | QPharma | Summit, NJ | 2007 " + EM + " 2008", TRUVEN, BIM);
  const before = textOf(run(mOld, pages), TRUVEN);
  assert.equal(before, TRUVEN_PREV + "\n\n" + TRUVEN_CONT); assert.equal(before.length, 1891);
  const rep: Rep = [];
  const after = textOf(run(mNew, pages, rep), TRUVEN);
  assert.equal(after, TRUVEN_PREV); assert.equal(after.length, 1667);
  assert.equal(rep.length, 1); assert.equal(rep[0][1], "seam repeat - page 2: case B, first 40 chars: Pruned approximately 500 dormant account");
});

// ---------- every distinct stored work history seam (RAN SQL on resume_extraction_pages; the decision looks only at the previous last line, the previous last 600
// characters and the continuation first line, which are exact here; the rest of each continuation is replaced by a marker line) ----------
const SEAMS: Array<{ name: string; n: number; prevTail: string; contFirst: string; change: "A" | "B" | null }> = [
  { name: "PironeSimple gen p2 to p3 (previous entry text empty)", n: 1, prevTail: "", contFirst: "Led customer implementations for a large-scale field platform rollout following an acquisition, growing the active customer base from approximately 15 to over 30 companies in just over a year.", change: null },
  { name: "PironeSimple gen p1 to p2 (Teacher, the defect)", n: 1, prevTail: TEACHER_PREV, contFirst: "Achieved certification pass rates above 90% every year, improving year over year to a high of 97% in 2024-2025.", change: "A" },
  { name: "Donofrio p2 to p3 (10 documents)", n: 10, prevTail: "Notable Experiences:\nTransition of products to a new data processing platform, reducing database update turnaround time by several days, developing leading and lagging performance indicators to significantly improve satisfaction\nMigration of the primary data center to a new facility providing power and environmental expansion Capacity with no impact on service levels to customers", contFirst: "Implementation of network-based application utilization and performance monitoring and reporting for high-scale web-based reference and analytic products, providing significant insights on user behavior to inform feature and interface enhancements and improve the customer experience", change: null },
  { name: "Beast p2 to p3 (original, 9 documents)", n: 9, prevTail: "Designed and delivered digital literacy and technology training curricula for diverse adult learner populations, consistently translating complex concepts into accessible, actionable instruction that improved technical competency outcomes.\nIntegrated AI-powered tools and enterprise productivity platforms into training programs, improving learner engagement scores and measurably increasing knowledge retention across cohorts.", contFirst: "Developed comprehensive blended learning materials including interactive modules, step-by-step guides, and video content supporting both in-person and remote delivery at scale.", change: null },
  { name: "Donofrio p3 to p4 (10 documents)", n: 10, prevTail: "Design and delivery of an editorial and web-publication system for reference and media content delivered to healthcare professionals\nTransition to an integrated (Oracle Financials) general ledger, accounts payable, T&E, and procurement system which cut administrative overhead while significantly augmenting operating controls required to ensure Sarbanes Oxley compliance\nDivestiture and disentanglement of a $100M business unit (Medical Economics)", contFirst: "Lead an organization of over 80 technology professionals delivering software product and internal systems development", change: null },
  { name: "Beast round trip p2 to p3 (2 documents; the fragment case for Fix D)", n: 2, prevTail: "Designed and delivered digital literacy and technology training curricula for diverse adult learner populations, consistently translating complex concepts into accessible, actionable instruction that improved technical competency outcomes.\nIntegrated AI-powered tools and enterprise productivity platforms into training programs, improving learner engagement scores and measurably increasing knowledge retention across cohorts.\nDeveloped comprehensive blended learning materials including interactive modules, step-by-step guides, and video content supporting both in-person and remote delivery at", contFirst: "Managed learner performance data and continuously adapted instructional strategies using data-driven insights, ensuring alignment between training objectives and measurable skill acquisition outcomes.", change: null },
  { name: "PironeSimple gen p3 to p4 (Thomson Reuters)", n: 1, prevTail: "Delivered the full platform RFP through rollout in 13 months against a 16-month target.\nConsolidated 40+ legacy tracking, indexing, and workflow applications into one enterprise platform serving 15 journals, cutting editing-to-layout throughput from 3-4 months to 1 month or less per issue cycle.", contFirst: "Redeployed existing staff capacity across properties to cover backlogs and delays as needed an operational flexibility that didn't exist before the platform consolidation.", change: null },
  { name: "PironeSimple p1 to p2, no continuation row (4 documents)", n: 4, prevTail: TRUVEN_PREV.slice(-700), contFirst: "", change: null },
  { name: "PironeSimple p1 to p2 (Truven, 5 documents, repeated tail)", n: 5, prevTail: TRUVEN_PREV.slice(-700), contFirst: TRUVEN_CONT, change: "B" },
];
t("stored seams: 43 merged seams in 57 stored documents fall in 9 distinct groups; exactly 6 change (1 by case A, 5 by case B) and 37 are byte for byte unchanged", () => {
  assert.equal(SEAMS.reduce((s, x) => s + x.n, 0), 43);
  let changedN = 0, A = 0, B = 0;
  for (const s of SEAMS) {
    const cont = s.contFirst ? s.contFirst + "\nREST OF THE CONTINUATION" : "";
    const pages = cont ? twoPages(s.prevTail, cont, "next") : [twoPages(s.prevTail, "x", "next")[0], { pageNumber: 2, extraction: emptyEx({ work_history: [] }), ocrText: "next" }];
    const a = run(mOld, pages), b = run(mNew, pages);
    const differs = JSON.stringify(a) !== JSON.stringify(b);
    const r = cont && s.prevTail ? rule(s.prevTail, cont) : null;
    assert.equal(differs, s.change !== null, s.name);
    assert.equal(r ? r.kase : null, s.change, s.name);
    if (differs) { changedN += s.n; if (s.change === "A") A += s.n; else B += s.n; }
  }
  assert.equal(changedN, 6); assert.equal(A, 1); assert.equal(B, 5);
});

// ---------- the rule, case by case ----------
const LONG_PREV = "Built the first thing and shipped it to every customer in the region\nLed the migration of the legacy billing platform to the new stack across";
t("case A: prev last line (20+ chars, unterminated) is the start of the continuation's first line, which is longer: replaced, rest of the continuation after one line break", () => {
  const r = rule(LONG_PREV, "Led the migration of the legacy billing platform to the new stack across three regions.\nTrained 40 people.");
  assert.deepEqual(r && [r.kase, r.text], ["A", "Built the first thing and shipped it to every customer in the region\nLed the migration of the legacy billing platform to the new stack across three regions.\nTrained 40 people."]);
});
t("case A with different case and spacing still matches (comparison ignores case and spacing)", () => {
  const r = rule(LONG_PREV, "LED  the  migration of the legacy billing platform to the new stack ACROSS three regions.");
  assert.ok(r && r.kase === "A");
});
t("terminated previous variant does not fire (previous last line ends with a full stop, ! ? ) ] quote)", () => {
  for (const end of [".", "!", "?", ")", "]", '"', "'"]) {
    const prev = "Built the first thing\nLed the migration of the legacy billing platform to the new stack across" + end;
    assert.equal(rule(prev, "Led the migration of the legacy billing platform to the new stack across" + end + " three regions."), null, end);
  }
});
t("short prefix variant (previous last line under 20 characters) does not fire", () => {
  assert.equal(rule("Built it\nLed the team", "Led the team and then some more words here to make it longer, also."), null);
  assert.ok(rule("Led the teams of ten", "Led the teams of ten people across three regions.")?.kase === "A");
  assert.equal(rule("Led the teams of te", "Led the teams of ten people across three regions."), null);
});
t("a continuation first line equal to the previous last line is not case A (not longer): a 72 character exact repeat is case B (dropped), a short one fires nothing; a 59 character repeat is not case B", () => {
  const same = "Led the migration of the legacy billing platform to the new stack across";
  const rb = rule("x\n" + same, same);
  assert.ok(rb && rb.kase === "B" && rb.text === "x\n" + same);
  assert.equal(rule("x\nLed the migration of the platform", "Led the migration of the platform"), null);
  const s59 = "Reduced the cost of operations for the whole group by a lot"; // 59 characters
  assert.equal(s59.length, 59);
  assert.equal(rule("Intro line\nOther words that are different from the repeat\n" + s59 + "\nAnd then something else entirely different here.", s59), null);
});
t("case B boundary: a repeated first line of exactly 60 characters inside the last 600 characters of the previous text is dropped; one not inside is kept", () => {
  const s60 = "Reduced the cost of operations for the whole group by a lot!"; // 60 characters
  assert.equal(s60.length, 60);
  const r = rule("Intro.\n" + s60 + "\nClosing line.", s60);
  assert.ok(r && r.kase === "B"); assert.equal(r!.text, "Intro.\n" + s60 + "\nClosing line.");
  assert.equal(rule("Intro.\nSomething else entirely, nothing in common.\nClosing line.", s60), null);
  const far = "Intro.\n" + s60 + "\n" + "Other bullet text goes here and there. ".repeat(20) + "\nClosing.";
  assert.equal(rule(far, s60), null, "the repeat is more than 600 characters from the end");
});
t("a continuation with several bullets: only the first line is touched (case A and case B); later lines are kept", () => {
  const a = rule(LONG_PREV, "Led the migration of the legacy billing platform to the new stack across three regions.\nSecond bullet.\nThird bullet.");
  assert.equal(a!.text.split("\n").slice(-2).join("|"), "Second bullet.|Third bullet.");
  const b = rule("Intro.\n" + TRUVEN_CONT, TRUVEN_CONT + "\nSecond bullet.\nThird bullet.");
  assert.equal(b!.kase, "B"); assert.equal(b!.text, "Intro.\n" + TRUVEN_CONT + "\n\nSecond bullet.\nThird bullet.");
});
t("neither case: the join is exactly today's (blank line), through the real merge", () => {
  const pages = twoPages("Built the thing.", "Managed the next thing well and fully, with many words in the line.");
  assert.deepEqual(run(mNew, pages), run(mOld, pages));
});
t("combination with Fix D: a fragment seam still stitches; when case A applies Fix D does not run (one log line only)", () => {
  const frag = twoPages("Built the thing and delivered it at", "Managed the next bullet well.", "scale.\nManaged");
  const repF: Rep = [];
  assert.equal(textOf(run(mNew, frag, repF)), "Built the thing and delivered it at scale.\nManaged the next bullet well.");
  assert.equal(repF.length, 1); assert.ok(repF[0][1].startsWith("seam stitch - page 2"));
  const both = twoPages(LONG_PREV, "Led the migration of the legacy billing platform to the new stack across scale.", "scale.\nnext");
  const repB: Rep = [];
  const out = textOf(run(mNew, both, repB));
  assert.equal(out, "Built the first thing and shipped it to every customer in the region\nLed the migration of the legacy billing platform to the new stack across scale.");
  assert.equal(repB.length, 1); assert.ok(repB[0][1].startsWith("seam repeat - page 2: case A"));
});
t("page adjacency and header guards stay: a row of another job is not merged and the rules do not run", () => {
  const pages = [
    { pageNumber: 1, extraction: emptyEx({ work_history: [job("Acme Corp", "Analyst", LONG_PREV, { position: 1 })] }), ocrText: "p1" },
    { pageNumber: 2, extraction: emptyEx({ work_history: [job("Other Co", "Other Role", "Led the migration of the legacy billing platform to the new stack across three regions.", { position: 0 })] }), ocrText: "p2" },
  ];
  assert.deepEqual(run(mNew, pages), run(mOld, pages));
  const gap = [pages[0], { ...pages[1], pageNumber: 3 }];
  assert.deepEqual(run(mNew, gap), run(mOld, gap));
});
t("without a report function (older callers) the rules are off: the old merge, exactly", () => {
  const pages = twoPages(TEACHER_PREV, TEACHER_CONT, "of 97%", SCHOOL, TEACHER);
  assert.deepEqual(mNew.mergeExtractions(pages), mOld.mergeExtractions(pages));
});

// ---------- fail open ----------
t("forced throw: the report function throws on the 'log' call inside the guarded rule: joins as before and reports 'seam repeat FAILED'", () => {
  const pages = twoPages(TEACHER_PREV, TEACHER_CONT, "of 97% in 2024-2025.\nBuilt", SCHOOL, TEACHER);
  const lines: Rep = [];
  const out = mNew.mergeExtractions(pages, (lvl: string, msg: string) => { lines.push([lvl, msg]); if (lvl === "log") throw new Error("boom in report"); });
  assert.equal(textOf(out, SCHOOL), TEACHER_PREV + "\n\n" + TEACHER_CONT, "today's text");
  assert.equal(lines.filter(([l, m]) => l === "error" && m.startsWith("seam repeat FAILED, joining as before:") && m.includes("boom in report")).length, 1);
});
t("a non-string previous or continuation text: the rule returns null, nothing breaks", () => {
  for (const [a, b] of [[undefined, "x"], ["x", undefined], [12345, "abc"], [null, null]] as any[]) assert.equal(rule(a, b), null);
  assert.equal(rule("", "Some text here"), null); assert.equal(rule("Some text here that is long enough", ""), null);
});

// ---------- upload-resume's real block ----------
const start = srcNew.indexOf("  let pagesForMerge");
const end = srcNew.indexOf("  // OCR text per page, in page order");
const block = srcNew.slice(start, end);
const runBlock = new Function("ordered", "restoreSkillText", "repairRoleBuckets", "orderRoleGroupsLatestFirst", "dedupePositions", "mergeExtractions", "docId", "mergedBoundaries", "console",
  stripTypeScriptTypes(block) + "\nreturn merged;") as any;
const row = (n: number, ocr: string | null, ex: any) => ({ page_number: n, ocr_text: ocr, extraction: ex, sectionBoundaries: { sections: [] } });
const rows = (prev: string, cont: string, ocr2: string | null, co: string, ti: string) => { const p = twoPages(prev, cont, ocr2, co, ti); return [row(1, p[0].ocrText as string, p[0].extraction), row(2, ocr2, p[1].extraction)]; };
const logs: string[] = [], errors: string[] = [];
const fake = { log: (s: string) => logs.push(s), error: (s: string) => errors.push(s) };
const callBlock = (r: any[], merge: any = mNew.mergeExtractions, repair: any = repairRoleBuckets) => { logs.length = 0; errors.length = 0; return runBlock(r, restoreSkillText, repair, orderRoleGroupsLatestFirst, mNew.dedupePositions, merge, "doc-test", { sections: [] }, fake); };
t("upload-resume block: one log line with the document id, text fixed; nothing logged for a seam where no case applies; the line is printed once when the role bucket repair fails", () => {
  const merged = callBlock(rows(TEACHER_PREV, TEACHER_CONT, "of 97% in 2024-2025.", SCHOOL, TEACHER));
  assert.equal(textOf(merged, SCHOOL), TEACHER_PREV.split("\n")[0] + "\n" + TEACHER_CONT);
  const l = logs.filter((x) => x.includes("seam repeat"));
  assert.equal(l.length, 1); assert.ok(l[0].startsWith("upload-resume: doc-test seam repeat - page 2: case A"), l[0]); assert.equal(errors.length, 0);
  callBlock(rows("Built the thing.", "Managed the next thing well and fully, with many words in the line.", "next", "Acme Corp", "Analyst"));
  assert.equal(logs.filter((x) => x.includes("seam repeat")).length, 0);
  callBlock(rows(TEACHER_PREV, TEACHER_CONT, "of 97%", SCHOOL, TEACHER), mNew.mergeExtractions, () => { throw new Error("repair down"); });
  assert.equal(logs.filter((x) => x.includes("seam repeat")).length, 1);
});
t("upload-resume block: a failure inside the rule reaches the log as 'seam repeat FAILED' with the document id, and the text is today's", () => {
  const failing = (pg: any[], report: any) => mNew.mergeExtractions(pg, (lvl: string, msg: string) => { if (lvl === "log" && msg.includes("seam repeat")) throw new Error("hook down"); report(lvl, msg); });
  const merged = callBlock(rows(TEACHER_PREV, TEACHER_CONT, "of 97%", SCHOOL, TEACHER), failing);
  assert.equal(textOf(merged, SCHOOL), TEACHER_PREV + "\n\n" + TEACHER_CONT);
  assert.equal(errors.filter((e) => e.startsWith("upload-resume: doc-test seam repeat FAILED")).length, 1);
});
t("wiring: the rule is called in exactly one place (the work history seam merge), before Fix D's stitch", () => {
  assert.equal(srcNew.split("repeatSeamRule(prev.job_responsibilities").length - 1, 1);
  assert.ok(srcNew.indexOf("repeatSeamRule(prev.job_responsibilities") < srcNew.indexOf("stitchSeamFragment(prev.job_responsibilities"));
});

for (const [name, fn] of tests) { await fn(); console.log("ok  ", name); }
console.log(`\n${tests.length} tests passed`);
