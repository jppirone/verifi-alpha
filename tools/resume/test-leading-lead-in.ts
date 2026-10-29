// node --experimental-strip-types tools/resume/test-leading-lead-in.ts   (needs git and the repo history, no network, no model call)
// AP9AD: two additions to applyLeadingBullets (upload-resume), checked on constructed documents shaped like the Asample PDF (the real texts of 0cab3106 and 2f1fdc89 are
// checked in test-leading-work-row.ts and test-leading-bullets.ts):
//  (a) LEAD-IN RESTORE, work row shape only: the OCR text between the start of the page and the start of the moved row's text is put in front of the row's text.
//  (b) MID-SENTENCE JOIN, both shapes: when the target's last line is cut in the middle of a sentence the moved text is joined with one space instead of a line break.
// The REAL merge code is cut out of upload-resume (this commit) and out of 93da379 (AP9AC, not deployed) and compared.
import assert from "node:assert/strict";
import fs from "node:fs";
import { execFileSync } from "node:child_process";
import { stripTypeScriptTypes } from "node:module";

const tests: Array<[string, () => void | Promise<void>]> = [];
const t = (name: string, fn: () => void | Promise<void>) => tests.push([name, fn]);
const SRC = "supabase/functions/upload-resume/index.ts";
const srcNew = fs.readFileSync(new URL("../../" + SRC, import.meta.url), "utf8").replace(/\r\n/g, "\n");
const srcPrev = execFileSync("git", ["show", "93da379:" + SRC], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }).replace(/\r\n/g, "\n");
async function loadMerge(src: string) {
  const cleanHeadingLine = src.split("\n").find((l) => l.startsWith("function cleanHeading("))!;
  const code = src.slice(src.indexOf("const PAGE_POSITION_SPAN"), src.indexOf("const RELAY_CALLS_PER_INVOCATION"));
  const exp = src.includes("function endsMidSentence(") ? "mergeExtractions, endsMidSentence, leadInFromOcr" : "mergeExtractions";
  return await import("data:text/javascript;base64," + Buffer.from(stripTypeScriptTypes(cleanHeadingLine + "\n" + code) + `\nexport { ${exp} };`, "utf8").toString("base64")) as any;
}
const mNew = await loadMerge(srcNew), mPrev = await loadMerge(srcPrev);
type Rep = Array<[string, string]>;
const run = (m: any, pages: any[], rep: Rep = []) => m.mergeExtractions(pages, (lvl: string, msg: string) => rep.push([lvl, msg]));
const emptyEx = (o: any) => ({ candidate_location: "", candidate_phone: "", candidate_email: "", printed_header: "", work_history: [], education: [], certifications: [], skills: [], skills_heading: "", skills_position: null, freeform: [], ...o });
const job = (company: string, title: string, jr: string, o: any = {}) => ({ company, title, location: "Remote", start_date: "2019-01", end_date: "2023-01", heading: "", job_responsibilities: jr, extraction_confidence: "high", position: 0, ...o });
const sec = (heading: string, category: string, cont = false) => ({ heading, category, is_continuation_of_previous_page: cont });
const wh = (m: any, company: string) => m.work_history.find((w: any) => w.company === company)?.job_responsibilities as string;

const endsMid = mNew.endsMidSentence as (prev: string, next: string) => boolean;
const leadIn = mNew.leadInFromOcr as (ocr: string, row: string) => string | null;

// ---------- helpers ----------
t("endsMidSentence: cut sentence yes; terminated no; short no; a noun-ended description no (the AGS case); lowercase continuation yes", () => {
  assert.equal(endsMid("Managed recruiting for many departments, owning full-cycle recruiting solo for both", "TeleVox and Mosaicx (x), and built things."), true);
  assert.equal(endsMid("Managed recruiting for many departments, owning full-cycle recruiting solo for both", "Standardized the SOP."), true);
  for (const end of [".", "!", "?", ":", ";"]) assert.equal(endsMid("Managed recruiting for many departments, owning recruiting solo for both" + end, "More."), false, end);
  assert.equal(endsMid("Led the team of two.\nShort line for", "more text"), false, "last line under 20 characters");
  assert.equal(endsMid("Led the team.\nAGS is a global provider of workforce solutions", "Assisted CDW talent team with full life cycle recruitment."), false, "unterminated noun, capital start: a separate line");
  assert.equal(endsMid("AGS is a global provider of workforce solutions", "and also did other things"), true, "lowercase start continues the sentence");
  assert.equal(endsMid("Recruited solely for the TeleVox business segment, a patient engagement platform", "Promoted into an expanded scope."), false);
  assert.equal(endsMid("", "x"), false);
  assert.equal(endsMid("Line one ends here.\nThis second line is cut right at the", "word"), true, "only the last line counts");
});

const LEADL = "TeleVox and Mosaicx (incl. India), and built\ncross-functional expertise with leaders.";
const LEADOK = "TeleVox and Mosaicx (incl. India), and built cross-functional expertise with leaders.";
const ROW = "Standardized the global recruiting SOP across two countries, replacing ad hoc handoffs.\nCreated standardized intake forms for hiring managers.";
const ROWOCR = "Standardized the global recruiting SOP across two countries,\nreplacing ad hoc handoffs.\nCreated standardized intake forms for hiring managers.";
t("leadInFromOcr: the OCR lines before the row's first words, as one line; none when the row starts the page, is not found, is too long, or a line looks like a job heading", () => {
  assert.equal(leadIn(LEADL + "\n" + ROWOCR, ROW), LEADOK);
  assert.equal(leadIn(ROWOCR, ROW), null, "the row starts the page");
  assert.equal(leadIn(LEADL + "\nsomething else entirely", ROW), null, "row words not found");
  assert.equal(leadIn("x ".repeat(301) + "\n" + ROWOCR, ROW), null, "over 600 characters");
  assert.equal(leadIn("x ".repeat(300) + "\n" + ROWOCR, ROW) !== null, true, "600 characters is allowed");
  assert.equal(leadIn("CDW, Senior Talent Acquisition Specialist\n" + ROWOCR, ROW), null, "all-caps company and comma");
  assert.equal(leadIn("Sourcing Recruiter, Remote (Nov 2020-May 2023)\n" + ROWOCR, ROW), null, "date range in parentheses");
  assert.equal(leadIn(LEADL + "\n" + ROWOCR, "Only two"), null, "fewer than three words");
  assert.equal(leadIn(LEADL + "\n" + ROWOCR.toUpperCase(), ROW), LEADOK, "case of the row words is ignored");
});

// ---------- work row shape ----------
const PREV = "Led the first program with care.\nManaged recruiting for many departments across segments, owning full-cycle recruiting solo for both";
const mk = (o: any = {}) => {
  const p = [
    { pageNumber: 1, ocrText: "page one", sections: [sec("EXPERIENCE", "work_history")], extraction: emptyEx({ work_history: [job("WESTCX", "Recruiter", o.prev ?? PREV, { position: 1 })] }) },
    { pageNumber: 2, ocrText: o.ocr === undefined ? LEADL + "\n" + ROWOCR : o.ocr, sections: [sec("", "unknown", true), sec("CDW, Senior Specialist, Remote (Nov 2015-Sep 2020)", "work_history")], extraction: emptyEx({ work_history: [job("TeleVox and Mosaicx", "Unknown", o.row ?? ROW, { start_date: "", end_date: "", extraction_confidence: "low", position: 0 }), job("CDW", "Senior Specialist", "CDW bullet.", { position: 1 })] }) },
  ];
  return p;
};
t("work row shape: the lead-in is restored in front of the row, joined to the cut sentence with one space, then the row's bullets after a line break; three log lines in order", () => {
  const rep: Rep = [];
  const nw = run(mNew, mk(), rep);
  assert.equal(wh(nw, "WESTCX"), PREV + " " + LEADOK + "\n" + ROW);
  assert.ok(!nw.work_history.some((w: any) => w.company === "TeleVox and Mosaicx"));
  assert.deepEqual(rep, [["log", "lead-in restored from OCR - page 2: " + LEADOK.slice(0, 40)], ["log", "leading join: space (previous line unterminated) - page 2"], ["log", "leading bullets moved to previous job (work row) - page 2: WESTCX, " + ROW.slice(0, 40)]]);
  assert.equal(LEADOK.slice(0, 40), "TeleVox and Mosaicx (incl. India), and b");
});

const noRestore = (name: string, o: any, expectText: string, expectJoinLog = true) => t("work row: no restore when " + name + " (moves as AP9AC did, no lead-in line)", () => {
  const rep: Rep = [];
  const nw = run(mNew, mk(o), rep);
  assert.equal(wh(nw, "WESTCX"), expectText);
  assert.ok(!rep.some(([, m]) => m.startsWith("lead-in")), JSON.stringify(rep));
  assert.equal(rep.some(([, m]) => m.startsWith("leading join")), expectJoinLog);
  assert.ok(rep.some(([, m]) => m.startsWith("leading bullets moved to previous job (work row)")));
});
noRestore("the OCR is unknown (vision routed page)", { ocr: null }, PREV + " " + ROW);
noRestore("the text in front is a job heading line", { ocr: "Sourcing Recruiter, Remote (Nov 2020-May 2023)\n" + ROWOCR }, PREV + " " + ROW);
t("work row: text in front over 200 characters - AP9AC's top-of-page check already stops the move (the row stays a separate job, same output as 93da379); leadInFromOcr's own 600 limit is tested above", () => {
  const p = () => mk({ ocr: "word ".repeat(130) + "\n" + ROWOCR });
  const rep: Rep = [];
  assert.equal(JSON.stringify(run(mNew, p(), rep)), JSON.stringify(run(mPrev, p(), []))); assert.equal(rep.length, 0);
});
noRestore("the lead-in is already in the target's text", { prev: PREV + " " + LEADOK.slice(0, 40) + " cross-functional expertise with leaders.", ocr: "cross-functional expertise with leaders.\n" + ROWOCR }, PREV + " " + LEADOK.slice(0, 40) + " cross-functional expertise with leaders." + "\n" + ROW, false);
noRestore("the lead-in is already in the row's text", { row: LEADOK + "\n" + ROW, ocr: LEADL + "\n" + ROWOCR }, PREV + " " + LEADOK + "\n" + ROW, true);
noRestore("the target ends a sentence (nothing is cut, so the text in front is not its completion)", { prev: "Led the first program with care.\nManaged recruiting for many departments across segments." }, "Led the first program with care.\nManaged recruiting for many departments across segments.\n" + ROW, false);

t("work row: failure injection in the lead-in step (String.prototype.search throws): the row moves as before, the error line is reported", () => {
  const orig = String.prototype.search;
  const rep: Rep = [];
  let nw: any;
  try { (String.prototype as any).search = function () { throw new Error("forced"); }; nw = run(mNew, mk(), rep); } finally { (String.prototype as any).search = orig; }
  assert.equal(wh(nw, "WESTCX"), PREV + " " + ROW);
  assert.ok(rep.some(([l, m]) => l === "error" && m === "lead-in restore FAILED, moving as before: Error: forced"), JSON.stringify(rep));
  assert.ok(rep.some(([, m]) => m.startsWith("leading bullets moved to previous job (work row)")));
});

// ---------- join, freeform shape ----------
const free = (prev: string, block: string, ocrP2?: string) => [
  { pageNumber: 1, ocrText: "one", sections: [sec("EXPERIENCE", "work_history")], extraction: emptyEx({ work_history: [job("WESTCX", "Recruiter", prev, { position: 1 })] }) },
  { pageNumber: 2, ocrText: ocrP2 ?? block, sections: [sec("", "unknown", true), sec("CDW, Senior, Remote (Nov 2015-Sep 2020)", "work_history")], extraction: emptyEx({ work_history: [job("CDW", "Senior", "CDW text.", { position: 1 })], freeform: [{ section_type: "needs_review", heading: "", content: block, position: 0 }] }) },
];
const BLOCK = "TeleVox and Mosaicx (incl. India), and built cross-functional expertise with leaders.\nStandardized the global SOP.";
t("freeform shape: space when the previous line is cut (the 2f1fdc89 case); line break when it ends with a period; line break for a noun-ended description (the ALLEGIS case); line break for a short last line", () => {
  const cases: Array<[string, string, string]> = [
    ["Managed recruiting for many departments, owning recruiting solo for both", " ", "space"],
    ["Managed recruiting for many departments, owning recruiting solo for both.", "\n", "period"],
    ["AGS is a global provider of workforce solutions", "\n", "noun-ended description"],
    ["Led them for both", "\n", "last line under 20 characters"],
  ];
  for (const [prev, sep, why] of cases) {
    const rep: Rep = [];
    const nw = run(mNew, free(prev, BLOCK), rep);
    assert.equal(wh(nw, "WESTCX"), prev + sep + BLOCK, why);
    assert.equal(rep.some(([, m]) => m.startsWith("leading join: space")), sep === " ", why);
    assert.ok(rep.some(([, m]) => m.startsWith("leading bullets moved to previous job - page 2")), why);
  }
  const lower = run(mNew, free("AGS is a global provider of workforce solutions", "and also ran the offsite.\nMore."), []);
  assert.equal(wh(lower, "WESTCX"), "AGS is a global provider of workforce solutions and also ran the offsite.\nMore.", "lowercase start continues the sentence");
});
t("freeform shape: when nothing is cut the output equals AP9AC's (93da379) exactly", () => {
  const prev = "Managed recruiting for many departments, owning recruiting solo for both.";
  assert.equal(JSON.stringify(run(mNew, free(prev, BLOCK))), JSON.stringify(run(mPrev, free(prev, BLOCK))));
});
t("only the join character differs from AP9AC (93da379) when the line is cut (same lengths, same everything else)", () => {
  const prev = "Managed recruiting for many departments, owning recruiting solo for both";
  const a = run(mNew, free(prev, BLOCK)), b = run(mPrev, free(prev, BLOCK));
  assert.equal(wh(b, "WESTCX"), prev + "\n" + BLOCK); assert.equal(wh(a, "WESTCX"), prev + " " + BLOCK);
  assert.equal(wh(a, "WESTCX").length, wh(b, "WESTCX").length);
  assert.equal(JSON.stringify({ ...a, work_history: a.work_history.filter((w: any) => w.company !== "WESTCX") }), JSON.stringify({ ...b, work_history: b.work_history.filter((w: any) => w.company !== "WESTCX") }));
});

t("fail open (whole rule): a forced throw leaves the live merge output and reports the AP9AA line", () => {
  const p = mk(); p[1].sections = new Proxy(p[1].sections, { get(target: any, prop: any) { if (prop === "length") throw new Error("forced"); return target[prop]; } }) as any;
  const rep: Rep = [];
  const nw = run(mNew, p, rep);
  assert.equal(wh(nw, "WESTCX"), PREV); assert.ok(nw.work_history.some((w: any) => w.company === "TeleVox and Mosaicx"));
  assert.deepEqual(rep, [["error", "leading bullets move FAILED, joining as before: Error: forced"]]);
});

// ---------- together with AP9X-2 (repeat) and Fix D (stitch) ----------
const A_PREV = "Led the first project with a lot of care and detail for the whole team of people.\nDesigned and delivered the training for the new hires across three regional offices and ran the follow up sessions";
const A_CONT = "Designed and delivered the training for the new hires across three regional offices and ran the follow up sessions each quarter.\nBuilt a reporting layer for the leadership group.";
t("combination with AP9X-2 case A (1-2 seam) and a work row move with lead-in and space join (2-3 seam)", () => {
  const BPREV = "Beta overview line.\nKept the books and ran the offsite for the whole group and also did both";
  const p = [
    { pageNumber: 1, ocrText: "one", sections: [sec("EXPERIENCE", "work_history")], extraction: emptyEx({ work_history: [job("Acme Corp", "Analyst", A_PREV, { position: 1 })] }) },
    { pageNumber: 2, ocrText: "Designed and delivered the training for the new hires across three regional offices and ran the follow up sessions each quarter.", sections: [sec("Acme Corp, Analyst", "work_history", true), sec("Beta Inc, Lead", "work_history")], extraction: emptyEx({ work_history: [job("Acme Corp", "Analyst", A_CONT, { start_date: "", end_date: "", position: 0 }), job("Beta Inc", "Lead", BPREV, { position: 1 })] }) },
    { pageNumber: 3, ocrText: LEADL + "\n" + ROWOCR, sections: [sec("", "unknown", true), sec("EDUCATION", "education")], extraction: emptyEx({ work_history: [job("TeleVox and Mosaicx", "Unknown", ROW, { start_date: "", end_date: "", position: 0 })] }) },
  ];
  const rep: Rep = [];
  const nw = run(mNew, p, rep);
  assert.equal(wh(nw, "Acme Corp"), A_PREV.split("\n")[0] + "\n" + A_CONT, "case A joined once");
  assert.equal(wh(nw, "Beta Inc"), BPREV + " " + LEADOK + "\n" + ROW);
  assert.ok(rep.some(([, m]) => m.startsWith("seam repeat - page 2: case A"))); assert.ok(rep.some(([, m]) => m.startsWith("lead-in restored from OCR - page 3")));
  assert.ok(rep.some(([, m]) => m === "leading join: space (previous line unterminated) - page 3"));
});
t("combination with Fix D (stitch at the 1-2 seam) and a freeform move with a space join at the 2-3 seam", () => {
  const prev = "Led the first project with care.\nManaged recruiting for many departments and built relationships with";
  const cont = "Built a reporting layer for the leadership group.";
  const BPREV = "Beta overview line.\nKept the books and ran the offsite for the whole group and also did both";
  const p = [
    { pageNumber: 1, ocrText: "one", sections: [sec("EXPERIENCE", "work_history")], extraction: emptyEx({ work_history: [job("Acme Corp", "Analyst", prev, { position: 1 })] }) },
    { pageNumber: 2, ocrText: "hiring managers across teams\nBuilt a reporting layer for the leadership group.", sections: [sec("Acme Corp, Analyst", "work_history", true), sec("Beta Inc, Lead", "work_history")], extraction: emptyEx({ work_history: [job("Acme Corp", "Analyst", cont, { start_date: "", end_date: "", position: 0 }), job("Beta Inc", "Lead", BPREV, { position: 1 })] }) },
    { pageNumber: 3, ocrText: "Kept the beta books in order for four years running.", sections: [sec("", "unknown", true)], extraction: emptyEx({ freeform: [{ section_type: "needs_review", heading: "", content: "Kept the beta books in order for four years running.", position: 0 }] }) },
  ];
  const rep: Rep = [];
  const nw = run(mNew, p, rep);
  assert.equal(wh(nw, "Acme Corp"), "Led the first project with care.\nManaged recruiting for many departments and built relationships with hiring managers across teams\n" + cont);
  assert.equal(wh(nw, "Beta Inc"), BPREV + " Kept the beta books in order for four years running.");
  assert.ok(rep.some(([, m]) => m.startsWith("seam stitch - page 2"))); assert.ok(rep.some(([, m]) => m === "leading join: space (previous line unterminated) - page 3"));
});

let failed = 0;
for (const [name, fn] of tests) {
  try { await fn(); console.log("  ok   " + name); } catch (e: any) { failed++; console.log("  FAIL " + name + "\n       " + String(e?.message ?? e).split("\n").slice(0, 8).join("\n       ")); }
}
console.log(`\n${tests.length - failed} passed, ${failed} failed`);
if (failed) process.exit(1);
