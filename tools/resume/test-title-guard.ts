// node --experimental-strip-types tools/resume/test-title-guard.ts   (needs git and the repo history, no network, no model call)
// AP9AF-1: restore the job title from the heading line of the page when the stored title is not on the page (restoreTitlesFromHeadingLines in upload-resume, applied at
// the start of mergeExtractions). The REAL merge code is cut out of upload-resume (this commit) and out of f2d4bfb (deployed) and compared on the exact stored pages of
// 6fc77af5 (the defect) and 797fc5d5 (a clean upload of the same resume layout, whose live saved rows are known).
import assert from "node:assert/strict";
import fs from "node:fs";
import { execFileSync } from "node:child_process";
import { stripTypeScriptTypes } from "node:module";
import { pages6fc, emptyEx, sec, OCR2 as OCR2_6FC } from "./fixtures/aclark-6fc77af5.ts";
import { pages797, WESTCX as WESTCX797, LEAD, TV, P3_BLOCK } from "./fixtures/aclark-797fc5d5.ts";

const tests: Array<[string, () => void | Promise<void>]> = [];
const t = (name: string, fn: () => void | Promise<void>) => tests.push([name, fn]);
const SRC = "supabase/functions/upload-resume/index.ts";
const srcNew = fs.readFileSync(new URL("../../" + SRC, import.meta.url), "utf8").replace(/\r\n/g, "\n");
const srcOld = execFileSync("git", ["show", "f2d4bfb:" + SRC], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }).replace(/\r\n/g, "\n");
async function loadMerge(src: string) {
  const cleanHeadingLine = src.split("\n").find((l) => l.startsWith("function cleanHeading("))!;
  const code = src.slice(src.indexOf("const PAGE_POSITION_SPAN"), src.indexOf("const RELAY_CALLS_PER_INVOCATION"));
  const exp = src.includes("function titleFromHeadingLine(") ? "mergeExtractions, titleFromHeadingLine, headingDateKey" : "mergeExtractions";
  return await import("data:text/javascript;base64," + Buffer.from(stripTypeScriptTypes(cleanHeadingLine + "\n" + code) + `\nexport { ${exp} };`, "utf8").toString("base64")) as any;
}
const mNew = await loadMerge(srcNew), mOld = await loadMerge(srcOld);
type Rep = Array<[string, string]>;
const run = (m: any, pages: any[], rep: Rep = []) => m.mergeExtractions(pages, (lvl: string, msg: string) => rep.push([lvl, msg]));
const job = (company: string, title: string, jr: string, o: any = {}) => ({ company, title, location: "Remote", start_date: "2023-09", end_date: "2024-06", heading: "", job_responsibilities: jr, extraction_confidence: "high", position: 0, ...o });
const find = (m: any, company: string, sd?: string) => m.work_history.find((w: any) => w.company === company && (sd === undefined || w.start_date === sd));
const guard = mNew.titleFromHeadingLine as (row: any, ocr: string) => string | null;

// ---------- the real stored document 6fc77af5 ----------
t("6fc77af5: the live merge saves the second WESTCX job as 'Recruiter to Senior Recruiter'; now it is 'Recruiter' (the page line); nothing else changes", () => {
  const old = run(mOld, pages6fc());
  assert.equal(find(old, "WESTCX", "2023-09").title, "Recruiter to Senior Recruiter");
  const rep: Rep = [];
  const nw = run(mNew, pages6fc(), rep);
  assert.equal(find(nw, "WESTCX", "2023-09").title, "Recruiter");
  assert.equal(find(nw, "WESTCX", "2024-07").title, "Senior Recruiter");
  assert.deepEqual(rep, [["log", "title restored from heading line - page 2: Recruiter to Senior Recruiter -> Recruiter"]]);
  const strip = (m: any) => JSON.stringify({ ...m, work_history: m.work_history.map((w: any) => ({ ...w, title: w.title === "Recruiter" ? "Recruiter to Senior Recruiter" : w.title })) });
  assert.equal(strip(nw), strip(old), "only that one title differs");
  console.log("      WESTCX second job title BEFORE '" + find(old, "WESTCX", "2023-09").title + "' AFTER '" + find(nw, "WESTCX", "2023-09").title + "'");
});

// ---------- guard conditions (titleFromHeadingLine on a constructed page) ----------
const OCR = "WESTCX, Recruiter, Remote (Sep 2023-Jun 2024)\nRecruited solely for the TeleVox business segment.\nPromoted into an expanded Senior Recruiter scope.";
const row = (o: any = {}) => ({ company: "WESTCX", title: "Recruiter to Senior Recruiter", start_date: "2023-09", end_date: "2024-06", ...o });
t("fires: title not on the page, one matching heading line, dates agree (ISO, month names, MM/YYYY, YYYY-MM-DD style spellings)", () => {
  assert.equal(guard(row(), OCR), "Recruiter");
  assert.equal(guard(row({ start_date: "Sep 2023", end_date: "June 2024" }), OCR), "Recruiter");
  assert.equal(guard(row({ start_date: "9/2023", end_date: "06/2024" }), OCR), "Recruiter");
  assert.equal(guard(row({ start_date: "2023-09", end_date: "" }), OCR), "Recruiter", "one date present and agreeing is enough");
  assert.equal(guard(row({ start_date: "", end_date: "2024-06" }), OCR), "Recruiter");
  assert.equal(guard(row({ company: "westcx" }), OCR), "Recruiter", "company case ignored");
  assert.equal(guard(row(), "WESTCX, Recruiter (Sep 2023-Jun 2024)\nbody"), "Recruiter", "no location");
  assert.equal(guard(row({ end_date: "Present", title: "Lead" }), "WESTCX, Senior Recruiter, Remote (Sep 2023-Present)\nbody"), "Senior Recruiter");
});
const none = (name: string, r: any, ocr: string) => t("does not fire: " + name, () => assert.equal(guard(r, ocr), null));
none("the stored title is on the page", row({ title: "Recruiter" }), OCR);
none("the stored title is on the page in another case and spacing", row({ title: "recruiter  " }), OCR);
none("the stored title is somewhere else on the page", row({ title: "Senior Recruiter" }), OCR);
none("start date disagrees", row({ start_date: "2023-10" }), OCR);
none("end date disagrees", row({ end_date: "2024-07" }), OCR);
none("a date is present but cannot be read", row({ start_date: "autumn 2023" }), OCR);
none("the row has no dates at all (a continuation row)", row({ start_date: "", end_date: "" }), OCR);
none("the line title is compound (' to ')", row({ title: "Lead" }), "WESTCX, Recruiter to Senior Recruiter, Remote (Sep 2023-Jun 2024)\nbody");
none("the line title has a slash", row({ title: "Lead" }), "WESTCX, Recruiter / Coordinator, Remote (Sep 2023-Jun 2024)\nbody");
none("the line title is 80 characters or more", row({ title: "Lead" }), "WESTCX, " + "A".repeat(80) + ", Remote (Sep 2023-Jun 2024)\nbody");
none("no line starts with the company", row({ company: "ACME" }), OCR);
none("the matching line has no parenthesised date range", row(), "WESTCX, Recruiter, Remote Sep 2023 Jun 2024\nbody");
none("two matching lines (ambiguous)", row(), OCR + "\nWESTCX, Lead, Remote (Sep 2023-Jun 2024)");
none("the company is empty", row({ company: "" }), OCR);
none("the line dates cannot be read", row(), "WESTCX, Recruiter, Remote (autumn 2023-Jun 2024)\nbody");
none("the line starts with a longer company name (WESTCX Holdings)", row(), "WESTCX Holdings, Recruiter, Remote (Sep 2023-Jun 2024)\nbody");

t("a page without OCR text (vision routed) is left alone; the stored title stays", () => {
  const p = pages6fc(); p[1].ocrText = null as any;
  const nw = run(mNew, p, []);
  assert.equal(find(nw, "WESTCX", "2023-09").title, "Recruiter to Senior Recruiter");
});
t("the other 6fc77af5 titles are all on the page or have no matching line: no other row changes (no log line for them)", () => {
  const rep: Rep = [];
  run(mNew, pages6fc(), rep);
  assert.equal(rep.length, 1);
});

// ---------- fail open ----------
t("fail open: a forced throw inside the guard saves the live merge output and reports the error", () => {
  const p = pages6fc(); let n = 0;
  Object.defineProperty(p[1], "ocrText", { get() { n++; if (n === 1) throw new Error("forced"); return OCR2_6FC; }, configurable: true });
  const rep: Rep = [];
  const nw = run(mNew, p, rep), old = run(mOld, pages6fc(), []);
  assert.equal(JSON.stringify(nw), JSON.stringify(old));
  assert.deepEqual(rep, [["error", "title restore FAILED, saving as before: Error: forced"]]);
});

// ---------- the clean upload 797fc5d5 and the combination with AP9AA, AP9AC and AP9AD ----------
t("797fc5d5 (live saved rows known): the real stored pages give WESTCX 1998 (lead-in kept, space join), ALLEGIS 641, and the title guard changes nothing (its titles are on the page)", () => {
  const rep: Rep = [];
  const nw = run(mNew, pages797(), rep), old = run(mOld, pages797(), []);
  assert.equal(JSON.stringify(nw), JSON.stringify(old), "same as the deployed merge, byte for byte");
  assert.equal(find(nw, "WESTCX").job_responsibilities.length, 1998); assert.equal(find(nw, "ALLEGIS GLOBAL SOLUTIONS").job_responsibilities.length, 641);
  assert.equal(find(nw, "WESTCX").title, "Recruiter to Senior Recruiter", "title is printed on page 1 of that layout, so it stays");
  assert.equal(find(nw, "WESTCX").job_responsibilities, WESTCX797 + " " + LEAD + "\n" + TV);
  assert.equal(find(nw, "ALLEGIS GLOBAL SOLUTIONS").job_responsibilities, "AGS is a global provider of workforce solutions\n" + P3_BLOCK);
  assert.ok(!rep.some(([, m]) => m.startsWith("title restored")), JSON.stringify(rep));
});
t("combination: a title restored on page 2 and a leading freeform block moved on page 3 (AP9AA, AP9AD join) in one document", () => {
  const A_PREV = "Led the first program with care.\nManaged recruiting for many departments across segments, owning full-cycle recruiting solo for both";
  const BLOCK = "TeleVox and Mosaicx (incl. India), and built cross-functional expertise with leaders.\nStandardized the global SOP.";
  const ocr2 = "WESTCX, Recruiter, Remote (Sep 2023-Jun 2024)\nRecruited solely for the TeleVox business segment.";
  const p = [
    { pageNumber: 1, ocrText: "one", sections: [sec("EXPERIENCE", "work_history")], extraction: emptyEx({ work_history: [job("Other Co", "Analyst", "Did things.", { start_date: "2020-01", end_date: "2023-08", position: 1 })] }) },
    { pageNumber: 2, ocrText: ocr2, sections: [sec("WESTCX, Recruiter, Remote (Sep 2023-Jun 2024)", "work_history")], extraction: emptyEx({ work_history: [job("WESTCX", "Recruiter to Senior Recruiter", A_PREV, { position: 0 })] }) },
    { pageNumber: 3, ocrText: BLOCK, sections: [sec("", "unknown", true)], extraction: emptyEx({ freeform: [{ section_type: "needs_review", heading: "", content: BLOCK, position: 0 }] }) },
  ];
  const rep: Rep = [];
  const nw = run(mNew, p, rep);
  assert.equal(find(nw, "WESTCX").title, "Recruiter");
  assert.equal(find(nw, "WESTCX").job_responsibilities, A_PREV + " " + BLOCK);
  assert.ok(rep.some(([, m]) => m === "title restored from heading line - page 2: Recruiter to Senior Recruiter -> Recruiter"));
  assert.ok(rep.some(([, m]) => m === "leading join: space (previous line unterminated) - page 3")); assert.ok(rep.some(([, m]) => m.startsWith("leading bullets moved to previous job - page 3")));
});

let failed = 0;
for (const [name, fn] of tests) {
  try { await fn(); console.log("  ok   " + name); } catch (e: any) { failed++; console.log("  FAIL " + name + "\n       " + String(e?.message ?? e).split("\n").slice(0, 8).join("\n       ")); }
}
console.log(`\n${tests.length - failed} passed, ${failed} failed`);
if (failed) process.exit(1);
