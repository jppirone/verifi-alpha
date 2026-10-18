// node --experimental-strip-types tools/resume/test-leading-bullets.ts   (needs git and the repo history, no network, no model call)
// AP9AA-1: leading continuation bullets that the page answer put in a freeform block go onto the previous page's last job (applyLeadingBullets, called first in
// mergeBoundaryContinuations of upload-resume). The REAL merge code is cut out of upload-resume (this commit) and out of acaafbe (deployed) and compared on the
// exact stored results of document 2f1fdc89 (generated Aclark PDF, pages 1 to 3: real extraction text, real boundary sections, OCR heads of the real pages).
import assert from "node:assert/strict";
import fs from "node:fs";
import { execFileSync } from "node:child_process";
import { stripTypeScriptTypes } from "node:module";

const tests: Array<[string, () => void | Promise<void>]> = [];
const t = (name: string, fn: () => void | Promise<void>) => tests.push([name, fn]);
const SRC = "supabase/functions/upload-resume/index.ts";
const srcNew = fs.readFileSync(new URL("../../" + SRC, import.meta.url), "utf8").replace(/\r\n/g, "\n");
const srcOld = execFileSync("git", ["show", "acaafbe:" + SRC], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }).replace(/\r\n/g, "\n");
async function loadMerge(src: string) {
  const cleanHeadingLine = src.split("\n").find((l) => l.startsWith("function cleanHeading("))!;
  const code = src.slice(src.indexOf("const PAGE_POSITION_SPAN"), src.indexOf("const RELAY_CALLS_PER_INVOCATION"));
  const exp = src.includes("function applyLeadingBullets(") ? "mergeExtractions, applyLeadingBullets, looksLikeJobHeadingLine" : "mergeExtractions";
  return await import("data:text/javascript;base64," + Buffer.from(stripTypeScriptTypes(cleanHeadingLine + "\n" + code) + `\nexport { ${exp} };`, "utf8").toString("base64")) as any;
}
const mNew = await loadMerge(srcNew), mOld = await loadMerge(srcOld);
type Rep = Array<[string, string]>;
const run = (m: any, pages: any[], rep: Rep = []) => m.mergeExtractions(pages, (lvl: string, msg: string) => rep.push([lvl, msg]));
const emptyEx = (o: any) => ({ candidate_location: "", candidate_phone: "", candidate_email: "", printed_header: "", work_history: [], education: [], certifications: [], skills: [], skills_heading: "", skills_position: null, freeform: [], ...o });
const job = (company: string, title: string, jr: string, o: any = {}) => ({ company, title, location: "Remote", start_date: "2019", end_date: "2023", heading: "", job_responsibilities: jr, extraction_confidence: "high", position: 0, ...o });
const blockOf = (content: string, o: any = {}) => ({ section_type: "needs_review", heading: "", content, position: 0, ...o });
const sec = (heading: string, category: string, cont = false) => ({ heading, category, is_continuation_of_previous_page: cont });
const wh = (m: any, company: string) => m.work_history.find((w: any) => w.company === company).job_responsibilities as string;
const ff = (m: any, type: string) => m.freeform.find((f: any) => f.section_type === type);

// ---------- the real stored document 2f1fdc89 ----------
const WESTCX = "WestCx is a cloud-based technology partner that delivers AI-powered solutions for regulated industries like healthcare, pharmacy, and financial services. The company was acquired in July 2026.\nRecruiter, September 2023 - June 2024:\nRecruited solely for the TeleVox business segment, a patient engagement platform\nPromoted into an expanded Senior Recruiter scope after the manager role was eliminated, reporting directly to the CHRO with added ownership across HR Operations and Vendor Management.\nEstablished the initial APAC agency relationships and operating frameworks for a new India-based office, hiring 25 technical and product professionals against a 3-month deliverable SLA the foundation that later scaled into the company's current international hiring operations.\nSenior Recruiter, July 2024 - August 2026:\nPE-backed, cloud-based AI customer & patient experience platform\nManaged recruiting for multiple departments across dual company segments, including GTM sales teams, product, engineering, and IT, owning full-cycle recruiting solo for both";
const P2_BLOCK = "TeleVox and Mosaicx (including the India entity, TVX Private Ltd.), and built cross-functional expertise by partnering with technical, operational, and executive leaders.\nStandardized the global recruiting SOP by streamlining the end-to-end process across two countries, replacing ad hoc handoffs with defined approval gates and clear ownership, reducing requisition-to-offer cycle time by 7-10 days at the front end.\nCreated standardized intake forms for hiring managers that eliminated the stalled-request cycle and established a clear, auditable approval trail for every hire and every dollar of contractor spend.\nConsolidated four separate corporate contractor request types (new vendor, new contractor, extension, add-funds) into a unified cross-functional workflow connecting HR, finance, procurement, and compliance, eliminating 4-6 hours of manual reconciliation per request and amplifying time savings for multi-contractor requests.";
const CONTRACT = "Various short term contracts allowing flexibility while caring for my mother in her final months\nSourced niche professional roles in financial, technical, healthtech, and scientific verticals for enterprise clients including NRUCFC ($31B+ utilities financial cooperative), NXP Semiconductors ($13B+ global technology company, NASDAQ: NXPI), Athletico ($340M+ healthcare organization), and Waters Corporation ($3B+ life sciences company, NYSE: WAT).\nSourced and hired 70+ sales, engineering, and operations professionals across three enterprise businesses, managing a requisition load of 5-15 open roles at a time.\nLed full-cycle recruiting at Athletico and Waters Corporation across technical, healthcare, and corporate functions in complex, matrixed environments, advising hiring leaders on talent market trends, sourcing strategy, and candidate experience improvements, enhancing sourcing strategy effectiveness by 20%.";
const CDW = "CDW is a major provider of information technology (IT) hardware, software, and services.\nOwned the complete hiring life cycle for CDW's prestigious Associate Consulting Engineer program in the US\nBuilt and scaled the Associate Consulting Engineer (ACE) program from the ground up, hiring 30-50 early-career engineers annually across network and information security roles, Associate through Principal level.\nDrove high-volume and specialized technical hiring across the US and Canada, delivering 60+ hires annually in critical engineering functions.\nElevated candidate experience scores from 3.8 to a perfect 5.0 through process redesign, stakeholder alignment, and proactive communication selected by leadership to present the strategy on a company-wide talent acquisition call.\nRanked highest on the team in satisfaction scores from both hiring leaders and candidates over a four-year tenure, reflecting consistent execution and stakeholder trust.";
const ALLEGIS = "AGS is a global provider of workforce solutions";
const P3_BLOCK = "Assisted CDW talent team with full life cycle recruitment for hard to fill senior level consulting engineer teams.\nRecognized across enterprise-wide accounts for resourceful, high-caliber sourcing consistently locating hard-to-reach candidates and contact information to exceed hiring targets despite varying client SLAs, four consecutive years running.\nManaged relationships with 50+ hiring managers, influencing critical hiring decisions and driving measurable improvements in process efficiency.\nEarned promotion to a direct-hire role at CDW after four consecutive years of top performance.";
const RANDSTAD = "Randstad is a global human resources consulting and recruitment firm.\nAssisted Honeywell leadership with full life cycle recruitment for critical engineering roles in various states.\nFilled specialized mechanical and electrical engineering positions at Honeywell by developing a referral-driven pipeline from existing employees and candidates when LinkedIn and Dice produced few viable applicants, reducing time-to-fill by 50% while managing 15-25 open requisitions.";
const TECH = "Workday, iCIMS, Taleo, Oracle HCM, SeekOut, JuiceBox/People GPT, Chat GPT\nMetaview AI, Claude, Glean Enterprise\nLusha, LinkedIn Recruiter, HireEZ, DeGarmo, HireVue";
const OCR2 = "TeleVox and Mosaicx (including the India entity, TVX Private Ltd.), and built\ncross-functional expertise by partnering with technical, operational, and executive\nleaders.\nStandardized the global recruiting SOP by streamlining the end-to-end process across two\ncountries, replacing ad hoc handoffs with defined approval gates and clear ownership,\nreducing requisition-to-offer cycle time by 7-10 days ";
const OCR3 = "Assisted CDW talent team with full life cycle recruitment for hard to fill senior level\nconsulting engineer teams.\nRecognized across enterprise-wide accounts for resourceful, high-caliber sourcing\nconsistently locating hard-to-reach candidates and contact information to exceed hiring\ntargets despite varying client SLAs, four consecutive years running.\nManaged relationships with 50+ hiring managers";
const OCR1 = "AURORA CLARK\nRensselaer, IN | (219) 204-2607\nalc.recruits@gmail.com | linkedin.com/in/auroraclarkindiana\nSENIOR RECRUITER & TALENT ACQUISITION PARTNER\nSenior Recruiter & Talent Acquisition Partner who fills roles other channels can't reach";
const S1 = [sec("", "unknown"), sec("SENIOR RECRUITER & TALENT ACQUISITION PARTNER", "summary"), sec("CORE COMPETENCIES", "skills"), sec("RECENT TECHNICAL SKILLS", "skills"), sec("PROFESSIONAL EXPERIENCE", "work_history")];
const S2 = [sec("CONTRACT ENGAGEMENTS, Sourcing Recruiter, Remote (Nov 2020-May 2023)", "work_history", true), sec("CDW, Senior Talent Acquisition Specialist, Remote (Nov 2015-Sep 2020)", "work_history"), sec("ALLEGIS GLOBAL SOLUTIONS, Senior Technical Recruiter, Remote (Jan 2011-Nov 2015)", "work_history")];
const S3 = [sec("", "unknown", true), sec("RANDSTAD STAFFING (FORMERLY SPHERION), Senior Recruiter, Remote (Oct 2006-Dec 2010)", "work_history"), sec("EDUCATION", "education")];
const aclarkPages = () => [
  { pageNumber: 1, ocrText: OCR1, sections: S1, extraction: emptyEx({
    work_history: [job("WESTCX", "Recruiter to Senior Recruiter", WESTCX, { start_date: "2023-09", end_date: "2026-08", heading: "PROFESSIONAL EXPERIENCE", position: 2, extraction_confidence: "medium" })],
    skills: ["Full-Cycle Recruitment Leadership", "Sourcing & Pipeline Management", "AI-Enabled Recruiting Workflows", "Employer Branding", "Vendor Management & Procurement Strategy", "Global Expansion & International Hiring Infrastructure", "DEI & Inclusive Hiring Strategy", "Team Leadership & Mentorship"], skills_heading: "CORE COMPETENCIES", skills_position: 1,
    freeform: [{ section_type: "summary", heading: "SENIOR RECRUITER & TALENT ACQUISITION PARTNER", content: "Senior Recruiter & Talent Acquisition Partner who fills roles other channels can't reach building referral pipelines and AI-enabled sourcing strategies when standard recruiting falls short. Full-cycle ownership from sourcing through close across agency, RPO, consulting, and corporate environments, with a 97% offer acceptance rate and global recruiting infrastructure built from the ground up.", position: 0 }, { section_type: "skills_secondary", heading: "RECENT TECHNICAL SKILLS", content: TECH, position: 3 }] }) },
  { pageNumber: 2, ocrText: OCR2, sections: S2, extraction: emptyEx({
    work_history: [job("CONTRACT ENGAGEMENTS", "Sourcing Recruiter", CONTRACT, { start_date: "Nov 2020", end_date: "May 2023", position: 0 }), job("CDW", "Senior Talent Acquisition Specialist", CDW, { start_date: "Nov 2015", end_date: "Sep 2020", position: 1 }), job("ALLEGIS GLOBAL SOLUTIONS", "Senior Technical Recruiter", ALLEGIS, { start_date: "Jan 2011", end_date: "Nov 2015", position: 2 })],
    freeform: [blockOf(P2_BLOCK, { position: 3 })] }) },
  { pageNumber: 3, ocrText: OCR3, sections: S3, extraction: emptyEx({
    work_history: [job("RANDSTAD STAFFING (FORMERLY SPHERION)", "Senior Recruiter", RANDSTAD, { start_date: "2006-10", end_date: "2010-12", position: 0 })],
    education: [{ institution: "Brigham Young University", degree: "coursework toward Bachelor of Science (60 credits completed)", field_of_study: "Travel and Tourism", location: "Provo UT", start_date: "", end_date: "", heading: "EDUCATION", extraction_confidence: "high", position: 1 }],
    freeform: [blockOf(P3_BLOCK, { position: 0 })] }) },
];

t("fixtures match the stored lengths (WESTCX 1056, page 2 block 941, ALLEGIS 47, page 3 block 593, skills text 163)", () => {
  assert.equal(WESTCX.length, 1056); assert.equal(P2_BLOCK.length, 941); assert.equal(ALLEGIS.length, 47); assert.equal(P3_BLOCK.length, 593); assert.equal(TECH.length, 163);
});

t("document 2f1fdc89: today's merge puts both blocks in skills_secondary (1701 chars); now they go onto WESTCX and ALLEGIS and skills_secondary is the real 163 characters", () => {
  const old = run(mOld, aclarkPages());
  assert.equal(ff(old, "skills_secondary").content.length, 1701); assert.equal(wh(old, "WESTCX").length, 1056); assert.equal(wh(old, "ALLEGIS GLOBAL SOLUTIONS").length, 47);
  const rep: Rep = [];
  const nw = run(mNew, aclarkPages(), rep);
  assert.equal(ff(nw, "skills_secondary").content, TECH); assert.equal(ff(nw, "skills_secondary").content.length, 163);
  assert.equal(wh(nw, "WESTCX"), WESTCX + "\n" + P2_BLOCK); assert.equal(wh(nw, "WESTCX").length, 1056 + 1 + 941);
  assert.ok(wh(nw, "WESTCX").endsWith("amplifying time savings for multi-contractor requests."));
  assert.equal(wh(nw, "ALLEGIS GLOBAL SOLUTIONS"), ALLEGIS + "\n" + P3_BLOCK); assert.equal(wh(nw, "ALLEGIS GLOBAL SOLUTIONS").split("\n").length, 5, "description line plus four bullets");
  assert.equal(wh(nw, "CONTRACT ENGAGEMENTS"), CONTRACT); assert.equal(wh(nw, "CDW"), CDW); assert.equal(wh(nw, "RANDSTAD STAFFING (FORMERLY SPHERION)"), RANDSTAD);
  assert.equal(nw.freeform.length, old.freeform.length); assert.ok(!nw.freeform.some((f: any) => f.content.includes("TeleVox")));
  assert.deepEqual(rep, [["log", "leading bullets moved to previous job - page 2: WESTCX, " + P2_BLOCK.slice(0, 40)], ["log", "leading bullets moved to previous job - page 3: ALLEGIS GLOBAL SOLUTIONS, " + P3_BLOCK.slice(0, 40)]]);
  assert.equal(P2_BLOCK.slice(0, 40), "TeleVox and Mosaicx (including the India"); assert.equal(P3_BLOCK.slice(0, 40), "Assisted CDW talent team with full life ");
  const before = (s: string) => JSON.stringify(s.slice(-110)), tail = (s: string) => JSON.stringify(s.slice(-110));
  console.log("      WESTCX BEFORE (" + wh(old, "WESTCX").length + " chars) ends: " + before(wh(old, "WESTCX")));
  console.log("      WESTCX AFTER  (" + wh(nw, "WESTCX").length + " chars) ends: " + tail(wh(nw, "WESTCX")));
  console.log("      ALLEGIS BEFORE (" + wh(old, "ALLEGIS GLOBAL SOLUTIONS").length + " chars): " + JSON.stringify(wh(old, "ALLEGIS GLOBAL SOLUTIONS")));
  console.log("      ALLEGIS AFTER  (" + wh(nw, "ALLEGIS GLOBAL SOLUTIONS").length + " chars): first 120 " + JSON.stringify(wh(nw, "ALLEGIS GLOBAL SOLUTIONS").slice(0, 120)) + " ... last 80 " + JSON.stringify(wh(nw, "ALLEGIS GLOBAL SOLUTIONS").slice(-80)));
  console.log("      skills_secondary BEFORE " + ff(old, "skills_secondary").content.length + " chars, AFTER " + ff(nw, "skills_secondary").content.length + " chars");
});

t("the rest of the merge output is byte for byte what it was (everything except WESTCX, ALLEGIS and the two freeform blocks)", () => {
  const a = run(mOld, aclarkPages()), b = run(mNew, aclarkPages());
  const strip = (m: any) => JSON.stringify({ ...m, work_history: m.work_history.filter((w: any) => !["WESTCX", "ALLEGIS GLOBAL SOLUTIONS"].includes(w.company)), freeform: m.freeform.filter((f: any) => f.section_type !== "skills_secondary") });
  assert.equal(strip(b), strip(a));
  assert.equal(JSON.stringify(b.work_history.map((w: any) => [w.company, w.title, w.start_date, w.end_date, w.position])), JSON.stringify(a.work_history.map((w: any) => [w.company, w.title, w.start_date, w.end_date, w.position])));
});

// ---------- a headed continuation whose heading is at the top of the OCR must NOT move ----------
t("14-style shape: headed work continuation, heading at the top of the page OCR (a real new job): nothing moves, output byte for byte today's", () => {
  const pages = () => [
    { pageNumber: 1, ocrText: "page one", sections: [sec("PROFESSIONAL EXPERIENCE", "work_history")], extraction: emptyEx({ work_history: [job("Acme Corp", "Analyst", "Did the first things.", { position: 1 })] }) },
    { pageNumber: 2, ocrText: "Tony Donofrio Page 2 of 5\nSenior VP, Chief Technology Officer | Truven Health\nLed the platform.", sections: [sec("Senior VP, Chief Technology Officer e Truven Health", "work_history", true)], extraction: emptyEx({ work_history: [job("Truven Health", "Senior VP, Chief Technology Officer", "Led the platform.", { position: 0 })] }) },
  ];
  const rep: Rep = [];
  assert.equal(JSON.stringify(run(mNew, pages(), rep)), JSON.stringify(run(mOld, pages()))); assert.equal(rep.length, 0);
});
t("14-style shape WITH an empty-heading block (hypothetical): heading at the top of the OCR means a new job, so the block does not move", () => {
  const pages = () => {
    const p = aclarkPages().slice(0, 2); p[1].ocrText = "CONTRACT ENGAGEMENTS, Sourcing Recruiter, Remote\nTeleVox and Mosaicx (including the India entity"; return p;
  };
  const rep: Rep = [];
  const nw = run(mNew, pages(), rep); const old = run(mOld, pages());
  assert.equal(JSON.stringify(nw.freeform.filter((f: any) => f.section_type === "skills_secondary")), JSON.stringify(old.freeform.filter((f: any) => f.section_type === "skills_secondary")));
  assert.equal(wh(nw, "WESTCX"), WESTCX); assert.ok(!rep.some(([, m]) => m.includes("page 2:")), "page 2 not moved");
});

// ---------- guards ----------
const noMove = (name: string, mutate: (p: any[]) => void) => t("guard: " + name + " (nothing moves for page 2; same output as today's merge)", () => {
  const p = aclarkPages().slice(0, 2); mutate(p);
  const rep: Rep = [];
  const nw = run(mNew, p, rep), old = run(mOld, p);
  assert.equal(JSON.stringify(nw), JSON.stringify(old)); assert.ok(!rep.some(([, m]) => m.startsWith("leading bullets")), JSON.stringify(rep));
});
noMove("the block has a real heading", (p) => { p[1].extraction.freeform[0].heading = "SOMETHING"; });
noMove("the block is of another type (skills_secondary)", (p) => { p[1].extraction.freeform[0].section_type = "skills_secondary"; });
noMove("the block is empty", (p) => { p[1].extraction.freeform[0].content = "  \n "; });
noMove("the block is over 3000 characters", (p) => { p[1].extraction.freeform[0].content = ("Did one more thing at work.\n").repeat(120); });
noMove("the previous page's last section is not work_history", (p) => { p[0].sections = [sec("SUMMARY", "summary")]; });
noMove("no work row on the previous page (a work_history section but no row)", (p) => { p[0].extraction.work_history = []; });
noMove("page 2 has a continuation row for the same company and title as the target", (p) => { p[1].extraction.work_history.push(job("WESTCX", "Recruiter to Senior Recruiter", "More WestCx text.", { start_date: "", end_date: "", position: 5 })); });
noMove("page 2 has a blank continuation row (no company, no title)", (p) => { p[1].extraction.work_history.push(job("", "", "More text.", { start_date: "", end_date: "", position: 5 })); });
noMove("first section of page 2 is a plain new section (not a continuation)", (p) => { p[1].sections = [sec("CONTRACT ENGAGEMENTS, Sourcing Recruiter, Remote (Nov 2020-May 2023)", "work_history", false)]; });
noMove("first section of page 2 is unknown with a heading", (p) => { p[1].sections = [sec("SOMETHING", "unknown", true)]; });
noMove("shape B but the page OCR is missing (vision routed page)", (p) => { p[1].ocrText = null; });
noMove("the block is not at the top of the page OCR (its start is beyond the first 200 characters)", (p) => { p[1].ocrText = "A completely different first line on the page that does not match the block text at all. ".repeat(3) + "\n" + OCR2; });
noMove("no sections at all (older caller)", (p) => { for (const x of p) delete x.sections; });
noMove("the block's first line looks like a job heading (all-capitals company, comma)", (p) => { p[1].extraction.freeform[0].content = "CDW, Senior Talent Acquisition Specialist, Remote\n" + P2_BLOCK; p[1].ocrText = "CDW, Senior Talent Acquisition Specialist, Remote\n" + OCR2; p[1].sections[0] = sec("CONTRACT ENGAGEMENTS, Sourcing Recruiter", "work_history", true); });
noMove("the block's first line ends with a date range in parentheses", (p) => { p[1].extraction.freeform[0].content = "Sourcing Recruiter, Remote (Nov 2020-May 2023)\n" + P2_BLOCK; p[1].ocrText = "Sourcing Recruiter, Remote (Nov 2020-May 2023)\n" + OCR2; });
t("looksLikeJobHeadingLine: all-caps company + comma, date range in parentheses; not plain bullets", () => {
  const f = mNew.looksLikeJobHeadingLine as (s: string) => boolean;
  for (const s of ["CDW, Senior Talent Acquisition Specialist", "ALLEGIS GLOBAL SOLUTIONS, Senior Technical Recruiter, Remote", "Senior Recruiter (Oct 2006-Dec 2010)", "Analyst (2011-2015)", "Analyst (Jan 2011 - Present)", "Analyst (Sept. 2011 to Nov 2015)"]) assert.equal(f(s), true, s);
  for (const s of ["TeleVox and Mosaicx (including the India entity, TVX Private Ltd.), and built", "Assisted CDW talent team with full life cycle recruitment", "Led 12 people, grew revenue", "Built a plan (2020 budget) for the team", ""]) assert.equal(f(s), false, s);
});

t("a block that is not first on its page is left alone (only the first freeform block of the page can move)", () => {
  const p = aclarkPages().slice(0, 2);
  p[1].extraction.freeform = [blockOf("Some earlier unrelated needs review text.", { position: 1, heading: "SOMETHING ELSE" }), blockOf(P2_BLOCK, { position: 3 })];
  const nw = run(mNew, p), old = run(mOld, p);
  assert.equal(JSON.stringify(nw), JSON.stringify(old));
});

// ---------- fail open ----------
t("fail open: a forced throw inside the rule leaves today's output and reports the error", () => {
  const p = aclarkPages(); const bad: any = new Proxy([sec("", "unknown", true)], { get(target: any, prop: any) { if (prop === "length") throw new Error("forced"); return target[prop]; } });
  p[2].sections = bad;
  const rep: Rep = [];
  const nw = run(mNew, p, rep), old = run(mOld, aclarkPages());
  assert.equal(JSON.stringify(nw), JSON.stringify(old));
  assert.deepEqual(rep, [["error", "leading bullets move FAILED, joining as before: Error: forced"]]);
});

// ---------- together with Fix D (stitch) and AP9X-2 (repeat) ----------
const PREV_A = "Led the first project with a lot of care and detail for the whole team of people.\nDesigned and delivered the training for the new hires across three regional offices and ran the follow up sessions";
const CONT_A = "Designed and delivered the training for the new hires across three regional offices and ran the follow up sessions each quarter.\nBuilt a reporting layer for the leadership group.";
t("combination: AP9X-2 case A at the 1-2 seam and a leading block at the 2-3 seam both work in one document; without a block the output equals today's", () => {
  const pages = (withBlock: boolean) => [
    { pageNumber: 1, ocrText: "one", sections: [sec("EXPERIENCE", "work_history")], extraction: emptyEx({ work_history: [job("Acme Corp", "Analyst", PREV_A, { position: 1 })] }) },
    { pageNumber: 2, ocrText: "Designed and delivered the training for the new hires across three regional offices and ran the follow up sessions each quarter.", sections: [sec("Acme Corp, Analyst", "work_history", true), sec("Beta Inc, Lead", "work_history")], extraction: emptyEx({ work_history: [job("Acme Corp", "Analyst", CONT_A, { start_date: "", end_date: "", position: 0 }), job("Beta Inc", "Lead", "Beta overview line.", { position: 1 })] }) },
    { pageNumber: 3, ocrText: "Kept the beta books in order for four years running and more.\nRan the offsite.", sections: [sec("", "unknown", true), sec("EDUCATION", "education")], extraction: emptyEx({ freeform: withBlock ? [blockOf("Kept the beta books in order for four years running and more.\nRan the offsite.", { position: 0 })] : [] }) },
  ];
  const repA: Rep = [], repB: Rep = [];
  const withB = run(mNew, pages(true), repA);
  assert.equal(wh(withB, "Acme Corp"), PREV_A.split("\n")[0] + "\n" + CONT_A, "case A joined once");
  assert.equal(wh(withB, "Beta Inc"), "Beta overview line.\nKept the beta books in order for four years running and more.\nRan the offsite.");
  assert.ok(repA.some(([, m]) => m.startsWith("seam repeat - page 2: case A"))); assert.ok(repA.some(([, m]) => m.startsWith("leading bullets moved to previous job - page 3: Beta Inc")));
  const noBlock = run(mNew, pages(false), repB), old = run(mOld, pages(false), []);
  assert.equal(JSON.stringify(noBlock), JSON.stringify(old)); assert.ok(!repB.some(([, m]) => m.startsWith("leading bullets")));
});
t("combination: Fix D stitch at the 1-2 seam and a leading block at the 2-3 seam; without a block the output equals today's", () => {
  const prev = "Led the first project with care.\nManaged recruiting for many departments and built relationships with";
  const cont = "Built a reporting layer for the leadership group.";
  const pages = (withBlock: boolean) => [
    { pageNumber: 1, ocrText: "one", sections: [sec("EXPERIENCE", "work_history")], extraction: emptyEx({ work_history: [job("Acme Corp", "Analyst", prev, { position: 1 })] }) },
    { pageNumber: 2, ocrText: "hiring managers across teams\nBuilt a reporting layer for the leadership group.", sections: [sec("Acme Corp, Analyst", "work_history", true), sec("Beta Inc, Lead", "work_history")], extraction: emptyEx({ work_history: [job("Acme Corp", "Analyst", cont, { start_date: "", end_date: "", position: 0 }), job("Beta Inc", "Lead", "Beta overview line.", { position: 1 })] }) },
    { pageNumber: 3, ocrText: "Kept the beta books in order for four years running.", sections: [sec("", "unknown", true)], extraction: emptyEx({ freeform: withBlock ? [blockOf("Kept the beta books in order for four years running.", { position: 0 })] : [] }) },
  ];
  const rep: Rep = [];
  const withB = run(mNew, pages(true), rep);
  assert.equal(wh(withB, "Acme Corp"), "Led the first project with care.\nManaged recruiting for many departments and built relationships with hiring managers across teams\n" + cont, "stitched once");
  assert.equal(wh(withB, "Beta Inc"), "Beta overview line.\nKept the beta books in order for four years running.");
  assert.ok(rep.some(([, m]) => m.startsWith("seam stitch - page 2"))); assert.ok(rep.some(([, m]) => m.startsWith("leading bullets moved to previous job - page 3")));
  assert.equal(JSON.stringify(run(mNew, pages(false))), JSON.stringify(run(mOld, pages(false))));
});

let failed = 0;
for (const [name, fn] of tests) {
  try { await fn(); console.log("  ok   " + name); } catch (e: any) { failed++; console.log("  FAIL " + name + "\n       " + String(e?.message ?? e).split("\n").slice(0, 6).join("\n       ")); }
}
console.log(`\n${tests.length - failed} passed, ${failed} failed`);
if (failed) process.exit(1);
