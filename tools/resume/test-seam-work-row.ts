// node --experimental-strip-types tools/resume/test-seam-work-row.ts   (needs git and the repo history, no network, no model call)
// AP9AF-2: a work row that continues the previous page's job and starts with a lowercase letter, after a previous text that ends without terminal punctuation, is joined
// with ONE space instead of a blank line (joinLowercaseContinuation, called in the work history seam merge of upload-resume after AP9X-2's repeat rule and Fix D's stitch).
// The REAL merge code is cut out of upload-resume (this commit) and out of 6438729 (AP9AF-1, the commit below it) and compared on the exact stored pages of docA.
import assert from "node:assert/strict";
import fs from "node:fs";
import { execFileSync } from "node:child_process";
import { stripTypeScriptTypes } from "node:module";
import { emptyEx, sec } from "./fixtures/section-helpers.ts";
import { loadPrivate, skipUnless } from "./private-fixtures.mjs";
const FA: any = await loadPrivate("sample-a.ts"), FB: any = await loadPrivate("sample-b.ts");
const { pages6fc, ALLEGIS2, ALLEGIS3 } = FA ?? ({} as any);
const { pages797 } = FB ?? ({} as any);

const tests: Array<[string, () => void | Promise<void>]> = [];
const t = (name: string, fn: () => void | Promise<void>) => tests.push([name, fn]);
const tp = (fx: any, name: string, fn: () => void | Promise<void>) => t(name, skipUnless(fx, name, fn));
const SRC = "supabase/functions/upload-resume/index.ts";
const srcNew = fs.readFileSync(new URL("../../" + SRC, import.meta.url), "utf8").replace(/\r\n/g, "\n");
const srcOld = execFileSync("git", ["show", "6438729:" + SRC], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }).replace(/\r\n/g, "\n");
async function loadMerge(src: string) {
  const cleanHeadingLine = src.split("\n").find((l) => l.startsWith("function cleanHeading("))!;
  const code = src.slice(src.indexOf("const PAGE_POSITION_SPAN"), src.indexOf("const RELAY_CALLS_PER_INVOCATION"));
  const exp = src.includes("function joinLowercaseContinuation(") ? "mergeExtractions, joinLowercaseContinuation" : "mergeExtractions";
  return await import("data:text/javascript;base64," + Buffer.from(stripTypeScriptTypes(cleanHeadingLine + "\n" + code) + `\nexport { ${exp} };`, "utf8").toString("base64")) as any;
}
const mNew = await loadMerge(srcNew), mOld = await loadMerge(srcOld);
type Rep = Array<[string, string]>;
const run = (m: any, pages: any[], rep: Rep = []) => m.mergeExtractions(pages, (lvl: string, msg: string) => rep.push([lvl, msg]));
const job = (company: string, title: string, jr: string, o: any = {}) => ({ company, title, location: "Remote", start_date: "2019-01", end_date: "2023-01", heading: "", job_responsibilities: jr, extraction_confidence: "high", position: 0, ...o });
const find = (m: any, company: string) => m.work_history.find((w: any) => w.company === company);
const join = mNew.joinLowercaseContinuation as (prev: string, cont: string) => string | null;

// ---------- the real stored document docA ----------
tp(FA, "docA: the live merge joins the cut bullet with a blank line (642 characters); now with one space (641), the same as the clean upload 52734f63 (641)", () => {
  const old = run(mOld, pages6fc());
  const a = find(old, "ALLEGIS GLOBAL SOLUTIONS").job_responsibilities;
  assert.equal(a, ALLEGIS2 + "\n\n" + ALLEGIS3); assert.equal(a.length, 642);
  const rep: Rep = [];
  const nw = run(mNew, pages6fc(), rep);
  const b = find(nw, "ALLEGIS GLOBAL SOLUTIONS").job_responsibilities;
  assert.equal(b, ALLEGIS2 + " " + ALLEGIS3); assert.equal(b.length, 641);
  assert.ok(b.includes("high-caliber sourcing consistently locating hard-to-reach candidates and contact information"));
  assert.ok(!b.includes("\n\n"));
  assert.deepEqual(rep.filter(([, m]) => m.startsWith("seam stitch (work row)")), [["log", "seam stitch (work row) - page 3: joined with one space, continuation starts \"consistently locating hard-to-reach cand\""]]);
  const strip = (m: any) => JSON.stringify({ ...m, work_history: m.work_history.filter((w: any) => w.company !== "ALLEGIS GLOBAL SOLUTIONS") });
  assert.equal(strip(nw), strip(old), "every other job and section is byte for byte what it was");
  console.log("      ALLEGIS BEFORE " + a.length + " chars, AFTER " + b.length + " chars; joined sentence: " + JSON.stringify(b.slice(b.indexOf("Recognized"), b.indexOf("Recognized") + 190)));
});

// ---------- the rule ----------
const PREV = "Led the first program with care.\nRecognized across enterprise-wide accounts for resourceful, high-caliber sourcing";
t("joinLowercaseContinuation: joins when the last line is cut and the continuation starts lowercase", () => {
  assert.equal(join(PREV, "consistently locating candidates.\nMore."), PREV + " consistently locating candidates.\nMore.");
  assert.equal(join(PREV + "  \n", "  consistently locating"), PREV + " consistently locating", "outer spacing ignored");
});
t("joinLowercaseContinuation: null for terminal punctuation, an uppercase start, a short last line, empty text", () => {
  for (const end of [".", "!", "?", ":", ";", ")", "]", "\"", "'", "”", "’"]) assert.equal(join(PREV + end, "consistently locating"), null, "ends with " + end);
  assert.equal(join(PREV, "Consistently locating"), null);
  assert.equal(join(PREV, "2024 plan"), null);
  assert.equal(join(PREV, "- consistently"), null);
  assert.equal(join("Led the team of two.\nShort line", "consistently"), null, "last line under 20 characters");
  assert.equal(join("", "consistently locating"), null); assert.equal(join(PREV, "   "), null);
  assert.equal(join(null as any, "x"), null);
});

const two = (prev: string, cont: string, ocr2: string | null = "Next page text", company = "Acme Corp", title = "Analyst") => [
  { pageNumber: 1, ocrText: "page one", sections: [sec("EXPERIENCE", "work_history")], extraction: emptyEx({ work_history: [job(company, title, prev, { position: 1 })] }) },
  { pageNumber: 2, ocrText: ocr2, sections: [sec("", "work_history", true)], extraction: emptyEx({ work_history: [job(company, title, cont, { start_date: "", end_date: "", position: 0 })] }) },
];
const text = (m: any) => find(m, "Acme Corp").job_responsibilities as string;
t("the work seam: lowercase continuation after a cut line joins with one space; uppercase or terminated stays a blank line (same as the deployed merge)", () => {
  const cut = run(mNew, two(PREV, "consistently locating candidates."));
  assert.equal(text(cut), PREV + " consistently locating candidates.");
  for (const [p, c] of [[PREV, "Consistently locating candidates."], [PREV + ".", "consistently locating candidates."], ["Short line", "consistently"]] as Array<[string, string]>) {
    const rep: Rep = [];
    assert.equal(JSON.stringify(run(mNew, two(p, c), rep)), JSON.stringify(run(mOld, two(p, c), [])));
    assert.ok(!rep.some(([, m]) => m.startsWith("seam stitch (work row)")));
  }
  assert.equal(text(run(mNew, two(PREV + ".", "consistently locating candidates."))), PREV + ".\n\nconsistently locating candidates.");
});
t("a blank continuation row (no company, no title) with a lowercase start is joined with a space too", () => {
  const p = two(PREV, "consistently locating candidates."); p[1].extraction.work_history[0].company = ""; p[1].extraction.work_history[0].title = "";
  assert.equal(text(run(mNew, p)), PREV + " consistently locating candidates.");
});
t("a page-adjacent row of ANOTHER job is never joined (no merge, nothing changes)", () => {
  const p = two(PREV, "consistently locating candidates.", "x", "Acme Corp", "Analyst"); p[1].extraction.work_history[0].company = "Beta Inc"; p[1].extraction.work_history[0].title = "Lead";
  assert.equal(JSON.stringify(run(mNew, p)), JSON.stringify(run(mOld, p)));
});

// ---------- order of the rules ----------
t("Fix D (a fragment the model left out) still runs first and gives its own result", () => {
  const prev = "Led the first project with care.\nManaged recruiting for many departments and built relationships with";
  const cont = "Built a reporting layer for the leadership group.";
  const rep: Rep = [];
  const nw = run(mNew, two(prev, cont, "hiring managers across teams\nBuilt a reporting layer for the leadership group."), rep);
  assert.equal(text(nw), "Led the first project with care.\nManaged recruiting for many departments and built relationships with hiring managers across teams\n" + cont);
  assert.ok(rep.some(([, m]) => m.startsWith("seam stitch - page 2"))); assert.ok(!rep.some(([, m]) => m.startsWith("seam stitch (work row)")));
});
t("AP9X-2 case A (partial then full) still runs first and gives its own result", () => {
  const prev = "Led the first project with a lot of care and detail for the whole team of people.\nDesigned and delivered the training for the new hires across three regional offices and ran the follow up sessions";
  const cont = "Designed and delivered the training for the new hires across three regional offices and ran the follow up sessions each quarter.\nBuilt a reporting layer.";
  const rep: Rep = [];
  const nw = run(mNew, two(prev, cont), rep);
  assert.equal(text(nw), prev.split("\n")[0] + "\n" + cont);
  assert.ok(rep.some(([, m]) => m.startsWith("seam repeat - page 2: case A"))); assert.ok(!rep.some(([, m]) => m.startsWith("seam stitch (work row)")));
});

// ---------- fail open ----------
t("fail open: the report function throws on the log call (inside the guarded join): joins as before and reports 'seam stitch (work row) FAILED'", () => {
  const rep: Rep = [];
  const out = mNew.mergeExtractions(two(PREV, "consistently locating candidates."), (lvl: string, msg: string) => { if (lvl === "log") throw new Error("forced"); rep.push([lvl, msg]); });
  assert.equal(text(out), PREV + "\n\nconsistently locating candidates.");
  assert.deepEqual(rep, [["error", "seam stitch (work row) FAILED, joining as before: Error: forced"]]);
});
t("without a report function (older callers) the merge is exactly today's", () => {
  const out = mNew.mergeExtractions(two(PREV, "consistently locating candidates."));
  assert.equal(text(out), PREV + "\n\nconsistently locating candidates.");
});

// ---------- together with AP9AA, AP9AC and AP9AD, and the clean upload docB ----------
t("combination: a lowercase continuation at the 1-2 seam and a leading freeform block moved with a space join at the 2-3 seam", () => {
  const BLOCK = "Kept the beta books in order for four years running.";
  const BPREV = "Beta overview line.\nKept the books and ran the offsite for the whole group and also did both";
  const p = [
    { pageNumber: 1, ocrText: "one", sections: [sec("EXPERIENCE", "work_history")], extraction: emptyEx({ work_history: [job("Acme Corp", "Analyst", PREV, { position: 1 })] }) },
    { pageNumber: 2, ocrText: "consistently locating candidates.\nBeta Inc, Lead (2019-2023)", sections: [sec("", "work_history", true), sec("Beta Inc, Lead, Remote (2019-2023)", "work_history")], extraction: emptyEx({ work_history: [job("Acme Corp", "Analyst", "consistently locating candidates.", { start_date: "", end_date: "", position: 0 }), job("Beta Inc", "Lead", BPREV, { position: 1 })] }) },
    { pageNumber: 3, ocrText: BLOCK, sections: [sec("", "unknown", true)], extraction: emptyEx({ freeform: [{ section_type: "needs_review", heading: "", content: BLOCK, position: 0 }] }) },
  ];
  const rep: Rep = [];
  const nw = run(mNew, p, rep);
  assert.equal(text(nw), PREV + " consistently locating candidates.");
  assert.equal(find(nw, "Beta Inc").job_responsibilities, BPREV + " " + BLOCK);
  assert.ok(rep.some(([, m]) => m.startsWith("seam stitch (work row) - page 2"))); assert.ok(rep.some(([, m]) => m === "leading join: space (previous line unterminated) - page 3"));
});
tp(FB, "docB (clean upload, live rows known): no lowercase continuation row, so the output is byte for byte the deployed merge (WESTCX 1998, ALLEGIS 641)", () => {
  const rep: Rep = [];
  const nw = run(mNew, pages797(), rep), old = run(mOld, pages797(), []);
  assert.equal(JSON.stringify(nw), JSON.stringify(old));
  assert.equal(find(nw, "WESTCX").job_responsibilities.length, 1998); assert.equal(find(nw, "ALLEGIS GLOBAL SOLUTIONS").job_responsibilities.length, 641);
  assert.ok(!rep.some(([, m]) => m.startsWith("seam stitch (work row)")));
});

let failed = 0;
for (const [name, fn] of tests) {
  try { await fn(); console.log("  ok   " + name); } catch (e: any) { failed++; console.log("  FAIL " + name + "\n       " + String(e?.message ?? e).split("\n").slice(0, 8).join("\n       ")); }
}
console.log(`\n${tests.length - failed} passed, ${failed} failed`);
if (failed) process.exit(1);
