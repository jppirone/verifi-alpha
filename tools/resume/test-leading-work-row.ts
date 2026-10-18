// node --experimental-strip-types tools/resume/test-leading-work-row.ts   (needs git and the repo history, no network, no model call)
// AP9AC: the work row shape of the leading bullets move (applyLeadingBullets in upload-resume). On a live upload of the Aclark PDF (document 0cab3106) the page 2
// opening bullets came back as a WORK ROW (company "TeleVox and Mosaicx", title "Unknown", no dates, low confidence) instead of a freeform block, so the AP9AA-1 rule
// did not fire. The REAL merge code is cut out of upload-resume (this commit) and out of d9a875f (AP9AA-1/2, live) and compared on the exact stored page results of
// 0cab3106 (real extraction text, real boundary sections, OCR heads) and on constructed cases.
import assert from "node:assert/strict";
import fs from "node:fs";
import { execFileSync } from "node:child_process";
import { stripTypeScriptTypes } from "node:module";

const tests: Array<[string, () => void | Promise<void>]> = [];
const t = (name: string, fn: () => void | Promise<void>) => tests.push([name, fn]);
const SRC = "supabase/functions/upload-resume/index.ts";
const srcNew = fs.readFileSync(new URL("../../" + SRC, import.meta.url), "utf8").replace(/\r\n/g, "\n");
const srcOld = execFileSync("git", ["show", "d9a875f:" + SRC], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }).replace(/\r\n/g, "\n");
async function loadMerge(src: string) {
  const cleanHeadingLine = src.split("\n").find((l) => l.startsWith("function cleanHeading("))!;
  const code = src.slice(src.indexOf("const PAGE_POSITION_SPAN"), src.indexOf("const RELAY_CALLS_PER_INVOCATION"));
  return await import("data:text/javascript;base64," + Buffer.from(stripTypeScriptTypes(cleanHeadingLine + "\n" + code) + "\nexport { mergeExtractions };", "utf8").toString("base64")) as any;
}
const mNew = await loadMerge(srcNew), mOld = await loadMerge(srcOld);
type Rep = Array<[string, string]>;
const run = (m: any, pages: any[], rep: Rep = []) => m.mergeExtractions(pages, (lvl: string, msg: string) => rep.push([lvl, msg]));
const emptyEx = (o: any) => ({ candidate_location: "", candidate_phone: "", candidate_email: "", printed_header: "", work_history: [], education: [], certifications: [], skills: [], skills_heading: "", skills_position: null, freeform: [], ...o });
const job = (company: string, title: string, jr: string, o: any = {}) => ({ company, title, location: "Remote", start_date: "2019-01", end_date: "2023-01", heading: "", job_responsibilities: jr, extraction_confidence: "high", position: 0, ...o });
const sec = (heading: string, category: string, cont = false) => ({ heading, category, is_continuation_of_previous_page: cont });
const wh = (m: any, company: string) => m.work_history.find((w: any) => w.company === company)?.job_responsibilities as string;

// ---------- the real stored document 0cab3106 (uploaded 13:28 UTC October 18, 2026) ----------
const WESTCX = "WestCx is a cloud-based technology partner that delivers AI-powered solutions for regulated industries like healthcare, pharmacy, and financial services. The company was acquired in July 2026.\nRecruiter, September 2023 - June 2024:\nRecruited solely for the TeleVox business segment, a patient engagement platform\nPromoted into an expanded Senior Recruiter scope after the manager role was eliminated, reporting directly to the CHRO with added ownership across HR Operations and Vendor Management.\nEstablished the initial APAC agency relationships and operating frameworks for a new India-based office, hiring 25 technical and product professionals against a 3-month deliverable SLA the foundation that later scaled into the company's current international hiring operations.\nSenior Recruiter, July 2024 - August 2026:\nPE-backed, cloud-based AI customer & patient experience platform\nManaged recruiting for multiple departments across dual company segments, including GTM sales teams, product, engineering, and IT, owning full-cycle recruiting solo for both";
const TV = "Standardized the global recruiting SOP by streamlining the end-to-end process across two countries, replacing ad hoc handoffs with defined approval gates and clear ownership, reducing requisition-to-offer cycle time by 7-10 days at the front end.\nCreated standardized intake forms for hiring managers that eliminated the stalled-request cycle and established a clear, auditable approval trail for every hire and every dollar of contractor spend.\nConsolidated four separate corporate contractor request types (new vendor, new contractor, extension, add-funds) into a unified cross-functional workflow connecting HR, finance, procurement, and compliance, eliminating 4-6 hours of manual reconciliation per request and amplifying time savings for multi-contractor requests.";
const CONTRACT = "Various short term contracts allowing flexibility while caring for my mother in her final months\nSourced and hired 70+ sales, engineering, and operations professionals across three enterprise businesses, managing a requisition load of 5-15 open roles at a time.";
const CDW = "CDW is a major provider of information technology (IT) hardware, software, and services.\nOwned the complete hiring life cycle for CDW's prestigious Associate Consulting Engineer program in the US";
const AGS = "AGS is a global provider of workforce solutions";
const ALL3 = "Assisted CDW talent team with full life cycle recruitment for hard to fill senior level consulting engineer teams.\nRecognized across enterprise-wide accounts for resourceful, high-caliber sourcing consistently locating hard-to-reach candidates and contact information to exceed hiring targets despite varying client SLAs, four consecutive years running.\nManaged relationships with 50+ hiring managers, influencing critical hiring decisions and driving measurable improvements in process efficiency.\nEarned promotion to a direct-hire role at CDW after four consecutive years of top performance.";
const RANDSTAD = "Randstad is a global human resources consulting and recruitment firm.\nAssisted Honeywell leadership with full life cycle recruitment for critical engineering roles in various states.";
const OCR1 = "AURORA CLARK\nRensselaer, IN | (219) 204-2607\nalc.recruits@gmail.com | linkedin.com/in/auroraclarkindiana\nSENIOR RECRUITER & TALENT ACQUISITION PARTNER";
const OCR2 = "TeleVox and Mosaicx (including the India entity, TVX Private Ltd.), and built\ncross-functional expertise by partnering with technical, operational, and executive\nleaders.\nStandardized the global recruiting SOP by streamlining the end-to-end process across two\ncountries, replacing ad hoc handoffs with defined approval gates and clear ownership,\nreducing requisition-to-offer cycle time by 7-10 days ";
const OCR3 = "Assisted CDW talent team with full life cycle recruitment for hard to fill senior level\nconsulting engineer teams.\nRecognized across enterprise-wide accounts for resourceful, high-caliber sourcing\nconsistently locating hard-to-reach candidates and contact information to exceed hiring\ntargets despite varying client SLAs, four consecutive years running.\nManaged relationships with 50+ hiring managers";
const S1 = [sec("", "unknown"), sec("SENIOR RECRUITER & TALENT ACQUISITION PARTNER", "summary"), sec("CORE COMPETENCIES", "skills"), sec("RECENT TECHNICAL SKILLS", "skills"), sec("PROFESSIONAL EXPERIENCE", "work_history")];
const S2 = [sec("", "unknown", true), sec("CONTRACT ENGAGEMENTS, Sourcing Recruiter, Remote (Nov 2020-May 2023)", "work_history"), sec("CDW, Senior Talent Acquisition Specialist, Remote (Nov 2015-Sep 2020)", "work_history"), sec("ALLEGIS GLOBAL SOLUTIONS, Senior Technical Recruiter, Remote (Jan 2011-Nov 2015)", "work_history")];
const S3 = [sec("", "work_history", true), sec("RANDSTAD STAFFING (FORMERLY SPHERION), Senior Recruiter, Remote (Oct 2006-Dec 2010)", "work_history"), sec("EDUCATION", "education")];
const tvRow = (o: any = {}) => job("TeleVox and Mosaicx", "Unknown", TV, { start_date: "", end_date: "", extraction_confidence: "low", position: 0, ...o });
const pages = (mut?: (p: any[]) => void) => {
  const p = [
    { pageNumber: 1, ocrText: OCR1, sections: S1.map((x) => ({ ...x })), extraction: emptyEx({ work_history: [job("WESTCX", "Recruiter to Senior Recruiter", WESTCX, { start_date: "2023-09", end_date: "2026-08", heading: "PROFESSIONAL EXPERIENCE", position: 2, extraction_confidence: "medium" })], skills: ["Full-Cycle Recruitment Leadership"], skills_heading: "CORE COMPETENCIES", skills_position: 1 }) },
    { pageNumber: 2, ocrText: OCR2, sections: S2.map((x) => ({ ...x })), extraction: emptyEx({ work_history: [tvRow(), job("CONTRACT ENGAGEMENTS", "Sourcing Recruiter", CONTRACT, { start_date: "2020-11", end_date: "2023-05", position: 1 }), job("CDW", "Senior Talent Acquisition Specialist", CDW, { start_date: "2015-11", end_date: "2020-09", position: 2 }), job("ALLEGIS GLOBAL SOLUTIONS", "Senior Technical Recruiter", AGS, { start_date: "2011-01", end_date: "2015-11", position: 3 })] }) },
    { pageNumber: 3, ocrText: OCR3, sections: S3.map((x) => ({ ...x })), extraction: emptyEx({ work_history: [job("ALLEGIS GLOBAL SOLUTIONS", "Senior Technical Recruiter", ALL3, { start_date: "", end_date: "", position: 0 }), job("RANDSTAD STAFFING (FORMERLY SPHERION)", "Senior Recruiter", RANDSTAD, { start_date: "2006-10", end_date: "2010-12", position: 1 })] }) },
  ];
  if (mut) mut(p);
  return p;
};

t("fixtures match the stored lengths (WESTCX 1056, the TeleVox row text 770)", () => { assert.equal(WESTCX.length, 1056); assert.equal(TV.length, 770); });

t("document 0cab3106: today's live merge leaves WESTCX at 1056 and a separate TeleVox and Mosaicx job; now the text goes onto WESTCX (1827) and the row is gone", () => {
  const old = run(mOld, pages());
  assert.equal(wh(old, "WESTCX").length, 1056); assert.ok(old.work_history.some((w: any) => w.company === "TeleVox and Mosaicx"));
  const rep: Rep = [];
  const nw = run(mNew, pages(), rep);
  assert.equal(wh(nw, "WESTCX"), WESTCX + "\n" + TV); assert.equal(wh(nw, "WESTCX").length, 1056 + 1 + 770); assert.equal(wh(nw, "WESTCX").length, 1827);
  assert.ok(wh(nw, "WESTCX").endsWith("amplifying time savings for multi-contractor requests."));
  assert.ok(!nw.work_history.some((w: any) => w.company === "TeleVox and Mosaicx"));
  assert.equal(nw.work_history.length, old.work_history.length - 1);
  assert.deepEqual(rep, [["log", "leading bullets moved to previous job (work row) - page 2: WESTCX, " + TV.slice(0, 40)]]);
  assert.equal(TV.slice(0, 40), "Standardized the global recruiting SOP b");
  // everything else equal to today's merge: the other jobs (ALLEGIS page 3 continuation is joined by the existing work merge exactly as before)
  const strip = (m: any) => JSON.stringify({ ...m, work_history: m.work_history.filter((w: any) => w.company !== "WESTCX" && w.company !== "TeleVox and Mosaicx") });
  assert.equal(strip(nw), strip(old));
  console.log("      WESTCX BEFORE " + wh(old, "WESTCX").length + " chars, AFTER " + wh(nw, "WESTCX").length + " chars; work rows " + old.work_history.length + " -> " + nw.work_history.length + "; ALLEGIS " + wh(nw, "ALLEGIS GLOBAL SOLUTIONS").length + " chars (joined by the existing page 3 merge, same as before)");
});

const noMove = (name: string, mut: (p: any[]) => void) => t("guard: " + name + " (same output as today's merge, no leading bullets line)", () => {
  const rep: Rep = [];
  const nw = run(mNew, pages(mut), rep), old = run(mOld, pages(mut));
  assert.equal(JSON.stringify(nw), JSON.stringify(old)); assert.ok(!rep.some(([, m]) => m.startsWith("leading bullets")), JSON.stringify(rep));
});
noMove("a real job with a heading (the row's heading field is set)", (p) => { p[1].extraction.work_history[0].heading = "PROFESSIONAL EXPERIENCE"; });
noMove("a real job heading in the boundary sections contains the row's company", (p) => { p[1].extraction.work_history[0].company = "CONTRACT ENGAGEMENTS"; });
noMove("a row with dates (start date)", (p) => { p[1].extraction.work_history[0].start_date = "2020-11"; });
noMove("a row with dates (end date only)", (p) => { p[1].extraction.work_history[0].end_date = "2023-05"; });
noMove("a row with a real title", (p) => { p[1].extraction.work_history[0].title = "Sourcing Recruiter"; });
noMove("no previous work row (page 1 has a work_history section but no row)", (p) => { p[0].extraction.work_history = []; });
noMove("the previous page's last section is not work_history", (p) => { p[0].sections = [sec("SUMMARY", "summary")]; });
noMove("first section of page 2 is not unknown (a headed work section)", (p) => { p[1].sections[0] = sec("CONTRACT ENGAGEMENTS", "work_history", true); });
noMove("first section of page 2 is a work_history section with an empty heading (no stored example, left alone)", (p) => { p[1].sections[0] = sec("", "work_history", true); });
noMove("first section of page 2 is not a continuation", (p) => { p[1].sections[0] = sec("", "unknown", false); });
noMove("the row text is over 3000 characters", (p) => { p[1].extraction.work_history[0].job_responsibilities = TV + "\n" + ("Did one more thing at work.\n").repeat(120); });
noMove("the row text is empty", (p) => { p[1].extraction.work_history[0].job_responsibilities = "  "; });
noMove("the row text is not at the top of the page OCR", (p) => { p[1].ocrText = "A completely different first line on the page that does not match the row text at all. ".repeat(3) + "\n" + OCR2; });
noMove("the row's first line looks like a job heading (all-capitals company, comma)", (p) => { const w = p[1].extraction.work_history[0]; w.job_responsibilities = "CDW, Senior Talent Acquisition Specialist, Remote\n" + TV; p[1].ocrText = "CDW, Senior Talent Acquisition Specialist, Remote\n" + OCR2; });
noMove("the row's first line ends with a date range in parentheses", (p) => { const w = p[1].extraction.work_history[0]; w.job_responsibilities = "Sourcing Recruiter, Remote (Nov 2020-May 2023)\n" + TV; p[1].ocrText = "Sourcing Recruiter, Remote (Nov 2020-May 2023)\n" + OCR2; });
noMove("a second row of the page continues the target (same company and title)", (p) => { p[1].extraction.work_history.push(job("WESTCX", "Recruiter to Senior Recruiter", "More WestCx text.", { start_date: "", end_date: "", position: 9 })); });
noMove("both company and title are empty (the existing blank continuation merge owns that case)", (p) => { const w = p[1].extraction.work_history[0]; w.company = ""; w.title = ""; });
noMove("no sections at all (older caller)", (p) => { for (const x of p) delete x.sections; });
noMove("not the lowest position row of the page (the Unknown row is second)", (p) => { p[1].extraction.work_history[0].position = 5; });

t("a row with an EMPTY title and a company moves (same as 'Unknown'); a company-less 'Unknown' row also moves", () => {
  for (const mut of [(p: any[]) => { p[1].extraction.work_history[0].title = ""; }, (p: any[]) => { p[1].extraction.work_history[0].company = ""; }]) {
    const rep: Rep = [];
    const nw = run(mNew, pages(mut), rep);
    assert.equal(wh(nw, "WESTCX").length, 1827, "rep=" + JSON.stringify(rep));
    assert.equal(wh(nw, "WESTCX"), WESTCX + "\n" + TV); assert.equal(rep.length, 1);
  }
});

t("the freeform shape (2f1fdc89) still moves exactly as before: same output as the live merge of d9a875f", () => {
  const BLOCK = "TeleVox and Mosaicx (including the India entity, TVX Private Ltd.), and built cross-functional expertise by partnering with technical, operational, and executive leaders.\n" + TV;
  const fp = () => [
    { pageNumber: 1, ocrText: OCR1, sections: S1, extraction: emptyEx({ work_history: [job("WESTCX", "Recruiter to Senior Recruiter", WESTCX, { position: 2 })], skills: ["Full-Cycle Recruitment Leadership"], skills_heading: "CORE COMPETENCIES", skills_position: 1, freeform: [{ section_type: "skills_secondary", heading: "RECENT TECHNICAL SKILLS", content: "Workday, iCIMS", position: 3 }] }) },
    { pageNumber: 2, ocrText: OCR2, sections: [sec("CONTRACT ENGAGEMENTS, Sourcing Recruiter, Remote (Nov 2020-May 2023)", "work_history", true), sec("CDW, Senior", "work_history")], extraction: emptyEx({ work_history: [job("CONTRACT ENGAGEMENTS", "Sourcing Recruiter", CONTRACT, { position: 0 }), job("CDW", "Senior Talent Acquisition Specialist", CDW, { position: 1 })], freeform: [{ section_type: "needs_review", heading: "", content: BLOCK, position: 3 }] }) },
  ];
  const rep: Rep = [];
  const nw = run(mNew, fp(), rep), old = run(mOld, fp(), []);
  assert.equal(JSON.stringify(nw), JSON.stringify(old));
  assert.equal(wh(nw, "WESTCX"), WESTCX + "\n" + BLOCK); assert.equal(rep.length, 1); assert.equal(rep[0][1], "leading bullets moved to previous job - page 2: WESTCX, " + BLOCK.slice(0, 40));
});

t("fail open: a forced throw inside the rule leaves today's output and reports the error", () => {
  const p = pages(); p[1].sections = new Proxy(S2, { get(target: any, prop: any) { if (prop === "length") throw new Error("forced"); return target[prop]; } }) as any;
  const rep: Rep = [];
  const nw = run(mNew, p, rep), old = run(mOld, pages(), []);
  assert.equal(JSON.stringify(nw), JSON.stringify(old));
  assert.deepEqual(rep, [["error", "leading bullets move FAILED, joining as before: Error: forced"]]);
  assert.equal(wh(nw, "WESTCX").length, 1056);
});

t("the move works together with AP9X-2 case A at another seam: both fire in one document", () => {
  const PREV = "Led the first project with a lot of care and detail for the whole team of people.\nDesigned and delivered the training for the new hires across three regional offices and ran the follow up sessions";
  const CONT = "Designed and delivered the training for the new hires across three regional offices and ran the follow up sessions each quarter.\nBuilt a reporting layer for the leadership group.";
  const p = () => [
    { pageNumber: 1, ocrText: "one", sections: [sec("EXPERIENCE", "work_history")], extraction: emptyEx({ work_history: [job("Acme Corp", "Analyst", PREV, { position: 1 })] }) },
    { pageNumber: 2, ocrText: "Designed and delivered the training for the new hires across three regional offices and ran the follow up sessions each quarter.", sections: [sec("Acme Corp, Analyst", "work_history", true), sec("Beta Inc, Lead", "work_history")], extraction: emptyEx({ work_history: [job("Acme Corp", "Analyst", CONT, { start_date: "", end_date: "", position: 0 }), job("Beta Inc", "Lead", "Beta overview line.", { position: 1 })] }) },
    { pageNumber: 3, ocrText: "Kept the beta books in order for four years running.\nRan the offsite.", sections: [sec("", "unknown", true), sec("EDUCATION", "education")], extraction: emptyEx({ work_history: [job("Beta and Gamma", "Unknown", "Kept the beta books in order for four years running.\nRan the offsite.", { start_date: "", end_date: "", position: 0 })] }) },
  ];
  const rep: Rep = [];
  const nw = run(mNew, p(), rep);
  assert.equal(wh(nw, "Acme Corp"), PREV.split("\n")[0] + "\n" + CONT);
  assert.equal(wh(nw, "Beta Inc"), "Beta overview line.\nKept the beta books in order for four years running.\nRan the offsite.");
  assert.ok(!nw.work_history.some((w: any) => w.company === "Beta and Gamma"));
  assert.ok(rep.some(([, m]) => m.startsWith("seam repeat - page 2: case A"))); assert.ok(rep.some(([, m]) => m.startsWith("leading bullets moved to previous job (work row) - page 3: Beta Inc")));
});

let failed = 0;
for (const [name, fn] of tests) {
  try { await fn(); console.log("  ok   " + name); } catch (e: any) { failed++; console.log("  FAIL " + name + "\n       " + String(e?.message ?? e).split("\n").slice(0, 6).join("\n       ")); }
}
console.log(`\n${tests.length - failed} passed, ${failed} failed`);
if (failed) process.exit(1);
