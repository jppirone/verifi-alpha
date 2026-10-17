// node --experimental-strip-types tools/resume/test-seam-stitch.ts   (needs git and the repo history, no network, no model call)
// AP9U (Fix D): a bullet cut by the page break whose last word(s) the page extraction left out is completed from the next page's OCR first line.
// The REAL merge code is cut out of upload-resume (this commit) and out of 6135d7c (what is deployed) and compared on:
//  - the round trip School District job (document a2903452), with the exact stored page 2 and page 3 results
//  - every distinct work history page seam that exists in the stored documents of the six hand-test resumes (read from resume_extraction_pages)
//  - the cases named in the task, and the fail open paths, and upload-resume's real block (log lines)
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
const srcOld = execFileSync("git", ["show", "6135d7c:" + SRC], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }).replace(/\r\n/g, "\n");
async function loadMerge(src: string) {
  const cleanHeadingLine = src.split("\n").find((l) => l.startsWith("function cleanHeading("))!;
  const code = src.slice(src.indexOf("const PAGE_POSITION_SPAN"), src.indexOf("const RELAY_CALLS_PER_INVOCATION"));
  const exports = src.includes("function stitchSeamFragment(") ? "mergeExtractions, dedupePositions, stitchSeamFragment" : "mergeExtractions, dedupePositions";
  return await import("data:text/javascript;base64," + Buffer.from(stripTypeScriptTypes(cleanHeadingLine + "\n" + code) + `\nexport { ${exports} };`, "utf8").toString("base64")) as any;
}
const mNew = await loadMerge(srcNew), mOld = await loadMerge(srcOld);
const stitch = mNew.stitchSeamFragment as (prev: string, cont: string, ocr: string | undefined) => { text: string; fragment: string } | null;

const emptyEx = (o: any) => ({ candidate_location: "", candidate_phone: "", candidate_email: "", printed_header: "", work_history: [], education: [], certifications: [], skills: [], skills_heading: "", skills_position: null, freeform: [], ...o });
const job = (company: string, title: string, jr: string, o: any = {}) => ({ company, title, location: "", start_date: "2019", end_date: "2023", heading: "PROFESSIONAL EXPERIENCE", job_responsibilities: jr, extraction_confidence: "high", position: 0, ...o });

// ---------- the round trip School District job, exact stored page results (document a2903452) ----------
const SD_P2 = "Designed and delivered digital literacy and technology training curricula for diverse adult learner populations, consistently translating complex concepts into accessible, actionable instruction that improved technical competency outcomes.\nIntegrated AI-powered tools and enterprise productivity platforms into training programs, improving learner engagement scores and measurably increasing knowledge retention across cohorts.\nDeveloped comprehensive blended learning materials including interactive modules, step-by-step guides, and video content supporting both in-person and remote delivery at";
const SD_P3 = "Managed learner performance data and continuously adapted instructional strategies using data-driven insights, ensuring alignment between training objectives and measurable skill acquisition outcomes.";
const STORED_FINAL = SD_P2 + "\n\n" + SD_P3; // the 799 character text stored today (work_history_items, a2903452)
const P3_OCR = "scale.\nManaged learner performance data and continuously adapted instructional strategies using\ndata-driven insights, ensuring alignment between training objectives and measurable skill\nacquisition outcomes.\nThomson Healthcare/Truven Health, Business Operations & Portfolio Manager (2014-2019)";
const SD = "School District of Indian River County, Florida", SDT = "Technical Training & Digital Skills Enablement Specialist";
const beastPages = (ocr3: string | null | undefined) => [
  { pageNumber: 2, extraction: emptyEx({ work_history: [job(SD, SDT, SD_P2, { position: 5 })] }), ocrText: "AI Visual Design...\nPROFESSIONAL EXPERIENCE\nIndependent / Freelance" },
  { pageNumber: 3, extraction: emptyEx({ work_history: [job(SD, SDT, SD_P3, { start_date: "", end_date: "", heading: "", position: 0 }), job("Thomson Healthcare/Truven Health", "Business Operations & Portfolio Manager", "Oversaw end-to-end portfolio.", { start_date: "2014", end_date: "2019", position: 1 })] }), ocrText: ocr3 },
];
const sdOf = (merged: any) => merged.work_history.find((w: any) => w.company === SD);
type Rep = Array<[string, string]>;
const run = (m: any, pages: any[], rep: Rep = []) => m.mergeExtractions(pages, (lvl: string, msg: string) => rep.push([lvl, msg]));

t("round trip: today's merge reproduces the stored 799 character text (harness check); with Fix D the bullet ends 'at scale.' with no blank line and the next bullet is unchanged", () => {
  const before = sdOf(run(mOld, beastPages(P3_OCR))).job_responsibilities;
  assert.equal(before, STORED_FINAL); assert.equal(before.length, 799);
  const rep: Rep = [];
  const after = sdOf(run(mNew, beastPages(P3_OCR), rep)).job_responsibilities;
  assert.equal(after, SD_P2 + " scale.\n" + SD_P3);
  assert.equal(after.length, 805);
  assert.ok(after.includes("remote delivery at scale.\nManaged learner performance data"));
  assert.ok(!after.includes("at\n\n"));
  assert.equal(after.split("\n").pop(), SD_P3, "the following bullet is unchanged");
  assert.equal(rep.length, 1); assert.equal(rep[0][0], "log"); assert.ok(rep[0][1].includes("page 3") && rep[0][1].includes('"scale."'));
  console.log("      BEFORE: ..." + JSON.stringify(before.slice(before.indexOf("remote delivery at") - 10, before.indexOf("remote delivery at") + 60)));
  console.log("      AFTER:  ..." + JSON.stringify(after.slice(after.indexOf("remote delivery at") - 10, after.indexOf("remote delivery at") + 60)));
});

t("round trip: everything else in the merge result is deep-equal to today's (entry count, other jobs, all other fields, only the School District text differs)", () => {
  const a = run(mOld, beastPages(P3_OCR)), b = run(mNew, beastPages(P3_OCR));
  assert.equal(a.work_history.length, b.work_history.length);
  const strip = (m: any) => ({ ...m, work_history: m.work_history.map((w: any) => (w.company === SD ? { ...w, job_responsibilities: "X" } : w)) });
  assert.deepEqual(strip(b), strip(a));
});

// ---------- every distinct work history page seam in the stored documents of the six resumes (RAN SQL; prev tail, continuation head, first OCR line) ----------
const SEAMS = [
  { name: "PironeSimple p1 to p2 (5 docs, with the model's repeated tail)", prevTail: " for both a Tier 1 offshore support team and company-wide self-service adoption.", cont: "Pruned approximately 500 dormant accounts with lingering post-termination access, closing a significant security gap. Built training curricula for both a Tier 1 offshore support team and company-wide ", ocr: "Technical Project Manager | QPharma | Summit, NJ | 2007 — 2008", expectStitch: false },
  { name: "PironeSimple p1 to p2 (4 docs, no continuation row)", prevTail: " for both a Tier 1 offshore support team and company-wide self-service adoption.", cont: "", ocr: "Technical Project Manager | QPharma | Summit, NJ | 2007 — 2008", expectStitch: false },
  { name: "Beast p2 to p3 (original, bullets whole)", prevTail: " engagement scores and measurably increasing knowledge retention across cohorts.", cont: "Developed comprehensive blended learning materials including interactive modules, step-by-step guides, and video content supporting both in-person and remote delivery at scale.\nManaged learner perform", ocr: "© Developed comprehensive blended learning materials including interactive modules, step-by-step guides,", expectStitch: false },
  { name: "Donofrio p2 to p3 (9 docs; unterminated bullet, next head is a page header)", prevTail: "d environmental expansion Capacity with no impact on service levels to customers", cont: "Implementation of network-based application utilization and performance monitoring and reporting for high-scale web-based reference and analytic products, providing significant insights on user behavi", ocr: "Tony Donofrio Page 3 of 3 donofrio01@yahoo.com", expectStitch: false },
  { name: "Donofrio p3 to p4 (9 docs; unterminated bullet, next head is a page header)", prevTail: "nce\nDivestiture and disentanglement of a $100M business unit (Medical Economics)", cont: "Lead an organization of over 80 technology professionals delivering software product and internal systems development\nGuidance and support for development of enterprise resource planning and order-to-", ocr: "Tony Donofrio Page 4 of 5 donofrio01@yahoo.com", expectStitch: false },
  { name: "Beast round trip p2 to p3 (the defect)", prevTail: "-step guides, and video content supporting both in-person and remote delivery at", cont: "Managed learner performance data and continuously adapted instructional strategies using data-driven insights, ensuring alignment between training objectives and measurable skill acquisition outcomes.", ocr: "scale.", expectStitch: true },
];
t("stored seams (the 6 distinct work history seams across all stored documents of the six resumes plus the round trip): only the round trip seam changes", () => {
  let changed = 0;
  for (const s of SEAMS) {
    const pad = "x".repeat(40) + s.prevTail;
    const pages = [
      { pageNumber: 1, extraction: emptyEx({ work_history: [job("Acme", "Role", pad, { position: 1 })] }), ocrText: "page one" },
      { pageNumber: 2, extraction: emptyEx({ work_history: s.cont ? [job("", "", s.cont, { start_date: "", end_date: "", heading: "", position: 0 })] : [] }), ocrText: s.ocr },
    ];
    const a = run(mOld, pages), b = run(mNew, pages);
    if (JSON.stringify(a) !== JSON.stringify(b)) { changed++; assert.ok(s.expectStitch, "unexpected change for: " + s.name); }
    else assert.ok(!s.expectStitch || !s.cont, "the defect seam must change: " + s.name);
  }
  assert.equal(changed, 1);
});

// ---------- the rule, case by case ----------
const PREV = "Built the thing and delivered it at";
const CONT = "Managed the next bullet well.";
t("Beast seam: single space, no blank line, continuation on the next line", () => {
  assert.deepEqual(stitch(PREV, CONT, "scale.\nManaged"), { text: "Built the thing and delivered it at scale.\nManaged the next bullet well.", fragment: "scale." });
});
t("previous bullet unterminated but the next OCR head is not a lowercase fragment: unchanged (page header, title case, bullet glyph, digits, e-mail, long line, empty line)", () => {
  for (const head of ["Tony Donofrio Page 3 of 3 donofrio01@yahoo.com", "Scale.", "© scale.", "page 3 of 5", "see jpirone@yahoo.com", "scale 2.0", "this is a much longer first line that is not a fragment at all really", "one two three four five six seven", "", "   ", "https://x.example/a", "scale/"]) {
    assert.equal(stitch(PREV, CONT, head + "\nnext line"), null, JSON.stringify(head));
  }
});
t("previous bullet terminated and the next head is a lowercase fragment: unchanged", () => {
  for (const end of ["Built the thing.", "Did it!", "Why?", "(see above)", 'He said "done"', "done]", "the clients’", "ok'"]) assert.equal(stitch(end, CONT, "scale.\nx"), null, end);
});
t("fragment already contained in the continuation: no stitch, no duplication", () => {
  assert.equal(stitch(PREV, "scale. Managed the next bullet.", "scale.\nManaged"), null);
  assert.equal(stitch(PREV, "  SCALE.   Managed", "scale.\nManaged"), null);
  assert.equal(stitch(PREV, "Managed the next bullet well, at scale. Then more.", "scale.\nManaged"), null);
});
t("no OCR for the next page (vision routed page, missing page, wrong type): unchanged", () => {
  for (const ocr of [undefined, null as any, 5 as any, ""]) assert.equal(stitch(PREV, CONT, ocr), null);
  const pages = beastPages(null);
  assert.deepEqual(run(mNew, pages), run(mOld, pages));
  assert.deepEqual(run(mNew, beastPages(undefined)), run(mOld, beastPages(undefined)));
});
t("a fragment of up to 6 words and 40 characters is taken; 7 words or 41 characters is not", () => {
  assert.ok(stitch(PREV, CONT, "one two three four five six.\nx"));
  assert.equal(stitch(PREV, CONT, "one two three four five six seven.\nx"), null);
  assert.ok(stitch(PREV, CONT, "a".repeat(40) + "\nx"));
  assert.equal(stitch(PREV, CONT, "a".repeat(41) + "\nx"), null);
});
t("only work history seams are stitched: a freeform page seam and an unmatched continuation are left alone", () => {
  const pages = [
    { pageNumber: 1, extraction: emptyEx({ work_history: [job("Acme", "Role", PREV, { position: 1 })], freeform: [{ section_type: "additional_info", heading: "AWARDS", content: "Won the thing at", position: 2 }] }), ocrText: "p1" },
    { pageNumber: 2, extraction: emptyEx({ work_history: [job("Other Co", "Other Role", CONT, { position: 0 })], freeform: [{ section_type: "additional_info", heading: "AWARDS", content: "next", position: 0 }] }), ocrText: "scale.\nmore" },
  ];
  assert.deepEqual(run(mNew, pages), run(mOld, pages));
});
t("without a report function (older callers) the stitch is off: the old merge, exactly", () => {
  assert.deepEqual(mNew.mergeExtractions(beastPages(P3_OCR)), mOld.mergeExtractions(beastPages(P3_OCR)));
});

// ---------- fail open ----------
t("logic forced to throw: the report function throws on the 'log' call (inside the guarded stitch): joins as before and reports 'seam stitch FAILED'", () => {
  const lines: Rep = [];
  const out = mNew.mergeExtractions(beastPages(P3_OCR), (lvl: string, msg: string) => { lines.push([lvl, msg]); if (lvl === "log") throw new Error("boom in report"); });
  assert.equal(sdOf(out).job_responsibilities, STORED_FINAL);
  assert.equal(lines.filter(([l, m]) => l === "error" && m.includes("seam stitch FAILED") && m.includes("boom in report")).length, 1);
});
t("logic forced to throw: a page whose OCR text getter throws while the seam map is built: no stitch, today's result, one 'seam stitch FAILED' line", () => {
  const pages = beastPages(P3_OCR);
  Object.defineProperty(pages[1], "ocrText", { get() { throw new Error("ocr getter down"); }, enumerable: true });
  const lines: Rep = [];
  const out = mNew.mergeExtractions(pages, (lvl: string, msg: string) => lines.push([lvl, msg]));
  assert.equal(sdOf(out).job_responsibilities, STORED_FINAL);
  assert.equal(lines.filter(([l, m]) => l === "error" && m.includes("seam stitch FAILED") && m.includes("ocr getter down")).length, 1);
});
t("the previous text is not a string (a bug upstream): no stitch, the merge result is the old one", () => {
  const a = beastPages(P3_OCR), b = beastPages(P3_OCR);
  (a[0].extraction.work_history[0] as any).job_responsibilities = 12345; (b[0].extraction.work_history[0] as any).job_responsibilities = 12345;
  assert.deepEqual(mNew.mergeExtractions(a, () => {}), mOld.mergeExtractions(b));
});

// ---------- upload-resume's real block ----------
const start = srcNew.indexOf("  let pagesForMerge");
const end = srcNew.indexOf("  // OCR text per page, in page order");
const block = srcNew.slice(start, end);
const runBlock = new Function("ordered", "restoreSkillText", "repairRoleBuckets", "orderRoleGroupsLatestFirst", "dedupePositions", "mergeExtractions", "docId", "mergedBoundaries", "console",
  stripTypeScriptTypes(block) + "\nreturn merged;") as any;
const row = (n: number, ocr: string | null, ex: any) => ({ page_number: n, ocr_text: ocr, extraction: ex, sectionBoundaries: { sections: [] } });
const rows = (ocr3: string | null) => [row(2, "page two text", beastPages(ocr3)[0].extraction), row(3, ocr3, beastPages(ocr3)[1].extraction)];
const logs: string[] = [], errors: string[] = [];
const fake = { log: (s: string) => logs.push(s), error: (s: string) => errors.push(s) };
const callBlock = (r: any[], merge: any = mNew.mergeExtractions, repair: any = repairRoleBuckets) => { logs.length = 0; errors.length = 0; return runBlock(r, restoreSkillText, repair, orderRoleGroupsLatestFirst, mNew.dedupePositions, merge, "doc-test", { sections: [] }, fake); };

t("upload-resume block: the stitch gives the completed bullet and ONE log line with the document id, page number and the fragment; the old merge gives today's text and no line", () => {
  const merged = callBlock(rows(P3_OCR));
  assert.equal(sdOf(merged).job_responsibilities, SD_P2 + " scale.\n" + SD_P3);
  const l = logs.filter((x) => x.includes("seam stitch"));
  assert.equal(l.length, 1); assert.ok(l[0].startsWith("upload-resume: doc-test seam stitch - page 3:") && l[0].includes('"scale."'));
  assert.equal(errors.length, 0);
  const today = callBlock(rows(P3_OCR), mOld.mergeExtractions);
  assert.equal(sdOf(today).job_responsibilities, STORED_FINAL);
});
t("upload-resume block: nothing is logged when no stitch happens (Donofrio style seam, vision routed page)", () => {
  callBlock(rows("Tony Donofrio Page 3 of 3 donofrio01@yahoo.com\nrest")); assert.equal(logs.filter((x) => x.includes("seam stitch")).length, 0);
  callBlock(rows(null)); assert.equal(logs.filter((x) => x.includes("seam stitch")).length, 0);
});
t("upload-resume block: when the role bucket repair fails the merge runs again and the stitch line is printed once", () => {
  const merged = callBlock(rows(P3_OCR), mNew.mergeExtractions, () => { throw new Error("repair down"); });
  assert.equal(sdOf(merged).job_responsibilities, SD_P2 + " scale.\n" + SD_P3);
  assert.equal(logs.filter((x) => x.includes("seam stitch")).length, 1);
});
t("upload-resume block: a failure inside the stitch reaches the log as 'seam stitch FAILED' with the document id, and the text is today's", () => {
  const failing = (pg: any[], report: any) => mNew.mergeExtractions(pg, (lvl: string, msg: string) => { if (lvl === "log" && msg.includes("seam stitch")) throw new Error("hook down"); report(lvl, msg); });
  const merged = callBlock(rows(P3_OCR), failing);
  assert.equal(sdOf(merged).job_responsibilities, STORED_FINAL);
  assert.equal(errors.filter((e) => e.startsWith("upload-resume: doc-test seam stitch FAILED")).length, 1);
});
t("wiring: the stitch is called in exactly one place (the work history page seam merge); both merge calls pass the page OCR text", () => {
  assert.equal(srcNew.split("stitchSeamFragment(prev.job_responsibilities").length - 1, 1);
  assert.equal(srcNew.split("ocrText: r.ocr_text").length - 1, 2);
});

for (const [name, fn] of tests) { await fn(); console.log("ok  ", name); }
console.log(`\n${tests.length} tests passed`);
