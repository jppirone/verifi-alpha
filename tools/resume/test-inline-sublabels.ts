// node --experimental-strip-types tools/resume/test-inline-sublabels.ts   (no network, no model call, no database)
// AP9AI: removeInlineSubLabels (rasterize-pdf-page): job sub-labels such as "Notable Experiences:" / "Responsibilities:" that the boundary step lists as sections
// (category unknown or additional_info) are removed from the list when the page OCR has the label as a line ending with a colon and a job is open at that point.
// The functions under test are cut out of the real sources (rasterize-pdf-page for the rule and resolveContinuationCategory, upload-resume for describeTrailingItem).
// The Donofrio fixture is built from the stored boundary answers of document 031b895c (donofriotest1017.pdf, the Applitrust PDF) and the label, heading and bullet
// lines of its stored page OCR; the Asample and PironeSimple fixtures are the stored boundary answers and OCR of those resumes.
import assert from "node:assert/strict";
import fs from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { sec } from "./fixtures/section-helpers.ts";
import { loadPrivate, skipUnless } from "./private-fixtures.mjs";
const FA: any = await loadPrivate("sample-a.ts");
const { OCR2: ASAMPLE_OCR2, OCR3: ASAMPLE_OCR3, S2: ASAMPLE_S2, S3: ASAMPLE_S3 } = FA ?? ({} as any);

const tests: Array<[string, () => void | Promise<void>]> = [];
const t = (name: string, fn: () => void | Promise<void>) => tests.push([name, fn]);
const tp = (fx: any, name: string, fn: () => void | Promise<void>) => t(name, skipUnless(fx, name, fn));
const read = (p: string) => fs.readFileSync(new URL("../../" + p, import.meta.url), "utf8").replace(/\r\n/g, "\n");
const RAS = read("supabase/functions/rasterize-pdf-page/index.ts"), UPL = read("supabase/functions/upload-resume/index.ts");
function fnText(src: string, name: string): string {
  const start = src.indexOf("function " + name + "(");
  assert.ok(start >= 0, "function " + name + " not found");
  const end = src.indexOf("\n}\n", start);
  return src.slice(start, end + 3);
}
const mod = await import("data:text/javascript;base64," + Buffer.from(stripTypeScriptTypes(
  fnText(RAS, "resolveContinuationCategory") + "\n" + fnText(RAS, "removeInlineSubLabels") + "\n" + fnText(UPL, "describeTrailingItem") + "\nexport { resolveContinuationCategory, removeInlineSubLabels, describeTrailingItem };"), "utf8").toString("base64")) as any;
const { resolveContinuationCategory, removeInlineSubLabels, describeTrailingItem } = mod;

type Log = Array<[string, string]>;
const run = (b: any, ocr: any, ctx: any, log: Log = []) => removeInlineSubLabels(b, ocr, ctx, (kind: string, text: string) => log.push([kind, text]));
const B = (sections: any[], extra: any = {}) => ({ sections, mergeCompanies: [], noMergeCompanies: [], ...extra });
const WH = { kind: "work_history", company: "Thomson Reuters Healthcare & Science", title: "Sr. VP Solution Operations", heading: "", snippet: "x" };
const FF = { kind: "freeform", heading: "Notable Experiences", sectionType: "needs_review", snippet: "x" };
const heads = (b: any) => b.sections.map((s: any) => `${s.heading}|${s.category}|${s.is_continuation_of_previous_page ? "cont" : "new"}`);

// ---------- the stored boundary answers of 031b895c (pages 2 to 5) and the label, heading and bullet lines of their OCR ----------
const TR_HEAD = "Thomson Reuters Healthcare & Science, Sr. VP Solution Operations, Philadelphia, PA (Oct 2008-Mar 2011)";
const P2_SECS = () => [sec("", "work_history", true), sec("Notable Experiences", "unknown"), sec("Responsibilities", "unknown"), sec(TR_HEAD, "work_history"), sec("Notable Experiences", "unknown")];
const P2_OCR = "Notable Experiences:\nDevelopment of a product strategy and technical architecture for transforming\npoint-product content into an integrated data repository to rapidly discover insights\nEstablishment of Truven Health Analytics as an independent entity from Thomson Reuters,\nincluding:\nCarve-out planning and transition services negotiation\nResponsibilities:\nLead an organization of over 500 technology, operations and product management\nprofessionals delivering software, hosting, and data management services to over 6000\nEnsure effective business continuity processes across the enterprise\nThomson Reuters Healthcare & Science, Sr. VP Solution Operations, Philadelphia, PA (Oct\n2008-Mar 2011)\nNotable Experiences:\nTransition of products to a new data processing platform, reducing database update";
const P3_SECS = () => [sec("", "unknown", true)];
const P3_OCR = "turnaround time by several days, developing leading and lagging performance indicators to\nsignificantly improve satisfaction\nMigration of the primary data center to a new facility providing power and environmental\nThomson Healthcare PDR, Vice President Technology, Montvale, NJ (Sep 2006-Oct 2008)\nDesign of a data warehouse containing practitioner data covering most active physicians in\nThomson Healthcare, Vice President Technology, Montvale, NJ (Nov 1998-Jun 2003)\nDesign and delivery of an editorial and web-publication system for reference and media";
const P4_SECS = () => [sec("Notable Experiences", "additional_info", true), sec("FAME Information Systems, Director, Data Product Development, New York, NY (Oct 1996-Nov 1998)", "work_history"), sec("Corning Life Sciences, Director, Technical Services, Teterboro, NJ (Jan 1993-Oct 1996)", "work_history"), sec("Chase Manhattan Bank NA, Systems Programmer, Lake Success, NY (Mar 1986-Apr 1987)", "work_history")];
const P4_OCR = "content delivered to healthcare professionals\nTransition to an integrated (Oracle Financials) general ledger, accounts payable, T&E, and\nFAME Information Systems, Director, Data Product Development, New York, NY (Oct 1996-Nov\n1998)\nNotable Experiences:\nDelivery of a relational query interface for an underlying proprietary time-series\nResponsibilities:\nDevelopment of products and tools for a proprietary high-performance time-series database\nCorning Life Sciences, Director, Technical Services, Teterboro, NJ (Jan 1993-Oct 1996)\nNotable Experiences:\nDesign and development of a lab report system delivering over 100,000 lab results per day\nResponsibilities:\nSoftware development for clinical lab results reporting and customer support systems\nChase Manhattan Bank NA, Systems Programmer, Lake Success, NY (Mar 1986-Apr 1987)\nNotable Experiences:\nMigration of the IBM mainframe data catalog system to an improved platform to support the\nResponsibilities:\nSupport for continuous 24/7 production data processing";
const P5_SECS = () => [sec("EDUCATION", "education"), sec("Leadership Training", "additional_info"), sec("PROFESSIONAL AFFILIATIONS", "additional_info")];
const P5_OCR = "EDUCATION\nBA, New York University (1988)\nLeadership Training\nThomson Leadership in Technology 2002\nThomson Senior Leadership Development Program 2003\nPROFESSIONAL AFFILIATIONS\nSociety of Information Management New Jersey Chapter\nOracle Advanced Computing Systems Advisory Board";

t("page 2: the three label sections are removed; what is left is the continuation section and the Thomson Reuters section; three log entries; employer lists unchanged", () => {
  const log: Log = [];
  const input = B(P2_SECS(), { mergeCompanies: ["Truven Health Analytics"], noMergeCompanies: ["Thomson Healthcare"] });
  const before = JSON.stringify(input);
  const out = run(input, P2_OCR, WH, log);
  assert.deepEqual(heads(out), ["|work_history|cont", TR_HEAD + "|work_history|new"]);
  assert.deepEqual(log, [["removed", "Notable Experiences"], ["removed", "Responsibilities"], ["removed", "Notable Experiences"]]);
  assert.deepEqual(out.mergeCompanies, ["Truven Health Analytics"]); assert.deepEqual(out.noMergeCompanies, ["Thomson Healthcare"]);
  assert.equal(JSON.stringify(input), before, "the input is not modified");
});

t("page 3: no label line, nothing removed; with the context a page 2 without the leftover freeform block gives (a work_history trailing item) the one unknown continuation section resolves to work_history; with the old context (the freeform block) it stayed unknown", () => {
  const rows = [{ company: "Truven Health Analytics", title: "Senior VP, Chief Technology Officer", heading: "", job_responsibilities: "x", position: 0 }, { company: "Thomson Reuters Healthcare & Science", title: "Sr. VP Solution Operations", heading: "", job_responsibilities: "Transition of products to a new data processing platform, reducing database update", position: 1 }];
  const ex = (freeform: any[]) => ({ work_history: rows, education: [], certifications: [], skills: [], skills_position: null, freeform });
  const newCtx = describeTrailingItem(ex([]));
  const oldCtx = describeTrailingItem(ex([{ section_type: "needs_review", heading: "Notable Experiences", content: "Transition of products to a new data processing platform, reducing database update", position: 2 }]));
  assert.equal(newCtx.kind, "work_history"); assert.equal(oldCtx.kind, "freeform", "the leftover block outranked the job (position 2 against 1)");
  const p3 = P3_SECS();
  const same = B(p3); assert.strictEqual(run(same, P3_OCR, newCtx), same, "no label line on page 3: the very same object");
  assert.deepEqual(heads(resolveContinuationCategory(B(P3_SECS()), newCtx)), ["|work_history|cont"]);
  assert.deepEqual(heads(resolveContinuationCategory(B(P3_SECS()), oldCtx)), ["|unknown|cont"]);
});

t("page 4: the first section 'Notable Experiences' (additional_info, continuation) is removed and replaced by a headerless work_history continuation; the three jobs are untouched", () => {
  const log: Log = [];
  const out = run(B(P4_SECS()), P4_OCR, WH, log);
  assert.deepEqual(heads(out).slice(0, 1), ["|work_history|cont"]);
  assert.equal(out.sections.length, 4); assert.deepEqual(out.sections.slice(1).map((s: any) => s.category), ["work_history", "work_history", "work_history"]);
  assert.deepEqual(log, [["removed", "Notable Experiences"]]);
});
t("page 4 with the OLD context (a freeform trailing item): the first-of-page condition is not met, so nothing is removed (the rule depends on the open job)", () => {
  const input = B(P4_SECS());
  assert.strictEqual(run(input, P4_OCR, FF), input);
  assert.strictEqual(run(input, P4_OCR, null), input);
});

t("page 5 is unchanged (EDUCATION, Leadership Training, PROFESSIONAL AFFILIATIONS: no colon lines on the page)", () => {
  const input = B(P5_SECS());
  assert.strictEqual(run(input, P5_OCR, WH), input);
});

t("two label sections at the very top of a page become ONE continuation section", () => {
  const log: Log = [];
  const input = B([sec("Notable Experiences", "unknown", true), sec("Responsibilities", "unknown"), sec("FAME Information Systems, Director (Oct 1996-Nov 1998)", "work_history")]);
  const out = run(input, "Notable Experiences:\nx\nResponsibilities:\ny\nFAME Information Systems, Director (Oct 1996-Nov 1998)\nz", WH, log);
  assert.deepEqual(heads(out), ["|work_history|cont", "FAME Information Systems, Director (Oct 1996-Nov 1998)|work_history|new"]);
  assert.equal(log.length, 2);
});

// ---------- AP9AJ: the continuation flag of a first section ----------
const AWARDS_OCR = "Recognized as top performer in 2019.\nAwards:\nPresident's Club 2018\nSalesperson of the year 2019\nEDUCATION\nBA, New York University (1988)";
t("AP9AJ (a): FIRST section 'Awards' (additional_info), OCR has an 'Awards:' line, the previous page ends in a job, continuation flag FALSE: the section is KEPT (same object)", () => {
  const input = B([sec("Awards", "additional_info", false), sec("EDUCATION", "education")]);
  const log: Log = [];
  assert.strictEqual(run(input, AWARDS_OCR, WH, log), input); assert.deepEqual(log, []);
});
t("AP9AJ (b): the same first section with the continuation flag TRUE is REMOVED and becomes the headerless work_history continuation", () => {
  const log: Log = [];
  const out = run(B([sec("Awards", "additional_info", true), sec("EDUCATION", "education")]), AWARDS_OCR, WH, log);
  assert.deepEqual(heads(out), ["|work_history|cont", "EDUCATION|education|new"]); assert.deepEqual(log, [["removed", "Awards"]]);
});
t("AP9AJ (b2): the flag must be exactly true (missing flag is treated as false)", () => {
  const input = B([{ heading: "Awards", category: "additional_info" }, sec("EDUCATION", "education")]);
  assert.strictEqual(run(input, AWARDS_OCR, WH), input);
});
t("AP9AJ (c): a NON-first section with a colon line inside an open job and continuation flag false is still REMOVED (the page 2 Donofrio case)", () => {
  const log: Log = [];
  const out = run(B(P2_SECS()), P2_OCR, WH, log);
  assert.ok(P2_SECS().slice(1).every((s: any) => s.is_continuation_of_previous_page === false), "the stored page 2 label sections are flagged false");
  assert.equal(out.sections.length, 2); assert.equal(log.length, 3);
  const input = B([sec("Responsibilities", "unknown", false), sec("FAME, Director (Oct 1996-Nov 1998)", "work_history")]);
  const o2 = run(B([sec("", "work_history", true), ...input.sections]), "bullet\nResponsibilities:\nitem\nFAME, Director (Oct 1996-Nov 1998)", null);
  assert.deepEqual(heads(o2), ["|work_history|cont", "FAME, Director (Oct 1996-Nov 1998)|work_history|new"]);
});
t("AP9AJ: the stored Donofrio page 4 section is flagged continuation true, so it is still removed (as in the page 4 test above)", () => {
  assert.equal(P4_SECS()[0].is_continuation_of_previous_page, true);
  assert.equal(run(B(P4_SECS()), P4_OCR, WH).sections[0].category, "work_history");
});

// ---------- negative tests ----------
tp(FA, "Asample pages (stored OCR and boundary answers of docA): no colon-ended line, the same object comes back", () => {
  const a = B(ASAMPLE_S2.map((x: any) => ({ ...x }))), b = B(ASAMPLE_S3.map((x: any) => ({ ...x })));
  assert.strictEqual(run(a, ASAMPLE_OCR2, WH), a); assert.strictEqual(run(b, ASAMPLE_OCR3, WH), b);
});
t("PironeSimple pages (stored boundary answers and OCR heads of 8a8b7717, pages 2 and 4): same object", () => {
  const s2 = B([sec("", "work_history", true), sec("Truven Health Analytics (IBM Watson Health), Business Integration Manager, Ann Arbor, MI (2008-2016)", "work_history"), sec("QPharma, Technical Project Manager, Summit, NJ (2007-2008)", "work_history")], { noMergeCompanies: ["Thomson Reuters"] });
  const o2 = "of 97% in 2024-2025.\nBuilt a rules-based restroom pass system using Power Automate, allowing students to\nTruven Health Analytics (IBM Watson Health), Business Integration Manager, Ann Arbor, MI\n(2008-2016)\nLed integration efforts for 5 enterprise acquisitions over 8 years, coordinating";
  const s4 = B([sec("", "work_history", true), sec("CERTIFICATIONS", "certifications"), sec("EDUCATION", "education")]);
  const o4 = "existing staff capacity across properties to cover backlogs and delays as\nProject Manager, Paramus, NJ (1995-1996)\nProject Management Certificate, Google / Coursera\nAI and Automation (Coursework, 2024-2026): applied GenAl for content creation,";
  assert.strictEqual(run(s2, o2, WH), s2); assert.strictEqual(run(s4, o4, WH), s4);
});
t("a colon-ended line that is NOT inside an open job (right after EDUCATION, no job earlier on the page, previous page not a job) is kept", () => {
  const input = B([sec("EDUCATION", "education"), sec("Leadership Training", "additional_info"), sec("PROFESSIONAL AFFILIATIONS", "additional_info")]);
  const ocr = "EDUCATION\nBA, New York University (1988)\nLeadership Training:\nThomson Leadership in Technology 2002\nPROFESSIONAL AFFILIATIONS:\nSociety of Information Management";
  assert.strictEqual(run(input, ocr, WH), input, "EDUCATION is first: the previous page's job is not 'open' for a later section");
  assert.strictEqual(run(input, ocr, null), input);
});
t("a real heading with the same words but no colon on the page is kept (the section is a heading, not a sub-label)", () => {
  const input = B([sec("", "work_history", true), sec("Notable Experiences", "unknown")]);
  const ocr = "More bullets of the job above.\nNotable Experiences\nA short list of items\nAnother one";
  assert.strictEqual(run(input, ocr, WH), input);
});
t("sections of a recognised category are never removed, even with a colon line: skills, summary, education, certifications, work_history, hobbies_other", () => {
  for (const cat of ["skills", "summary", "education", "certifications", "work_history", "hobbies_other"]) {
    const input = B([sec("", "work_history", true), sec("Key Skills", cat)]);
    assert.strictEqual(run(input, "bullet\nKey Skills:\nSQL\nExcel\nPython", WH), input, cat);
  }
});
t("case and spacing of the label are ignored; a colon in the middle of a line, or text after the colon, does not count", () => {
  const input = () => B([sec("", "work_history", true), sec("Notable  Experiences", "unknown")]);
  assert.equal(run(input(), "bullet\n  NOTABLE EXPERIENCES:  \nitem", WH).sections.length, 1);
  assert.equal(run(input(), "bullet\nNotable Experiences: a list follows\nitem", WH).sections.length, 2);
  assert.equal(run(input(), "bullet\nNotable Experiences : item\nx", WH).sections.length, 2);
});
t("a page read by vision (no OCR text) is returned as it was; empty or missing section lists too", () => {
  const input = B(P2_SECS());
  assert.strictEqual(run(input, undefined, WH), input); assert.strictEqual(run(input, null, WH), input);
  const empty = B([]); assert.strictEqual(run(empty, P2_OCR, WH), empty);
});
t("fail open: a forced throw (the sections getter throws) returns the list as it was and reports 'failed'", () => {
  const bad: any = { get sections() { throw new Error("forced"); }, mergeCompanies: [], noMergeCompanies: [] };
  const log: Log = [];
  assert.strictEqual(removeInlineSubLabels(bad, P2_OCR, WH, (k: string, x: string) => log.push([k, x])), bad);
  assert.deepEqual(log, [["failed", "Error: forced"]]);
});
t("fail open: a report function that throws does not stop the removal", () => {
  const out = removeInlineSubLabels(B(P2_SECS()), P2_OCR, WH, () => { throw new Error("log failed"); });
  assert.equal(out.sections.length, 2);
});

// ---------- wiring (read from the source) ----------
t("wiring: the rule is called once, in the OCR (Haiku) branch directly after resolveContinuationCategory, with the OCR text and the trailing context; the vision branch is untouched", () => {
  const calls = [...RAS.matchAll(/removeInlineSubLabels\(sectionBoundaries, ocrText, trailingContext/g)];
  assert.equal(calls.length, 1);
  const hay = calls[0].index as number;
  const before = RAS.slice(hay - 400, hay);
  assert.ok(before.includes("runBoundaryDetectionHaiku(ocrText, trailingContext, modelCalls), trailingContext)"));
  const visionLine = RAS.slice(RAS.indexOf("const runVisionPath = async () =>"), RAS.indexOf("const runVisionPath = async () =>") + 700);
  assert.ok(!visionLine.includes("removeInlineSubLabels"));
  assert.ok(RAS.includes("inline sub-label removed - page ${pageNum}: ${text}")); assert.ok(RAS.includes("inline sub-label removal FAILED, keeping the boundary list - page ${pageNum}: ${text}"));
  assert.equal(UPL.includes("removeInlineSubLabels"), false, "upload-resume (single image path, no OCR text) is not covered");
});

let failed = 0;
for (const [name, fn] of tests) {
  try { await fn(); console.log("  ok   " + name); } catch (e: any) { failed++; console.log("  FAIL " + name + "\n       " + String(e?.message ?? e).split("\n").slice(0, 8).join("\n       ")); }
}
console.log(`\n${tests.length - failed} passed, ${failed} failed`);
if (failed) process.exit(1);
