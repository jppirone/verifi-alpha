// node --experimental-strip-types tools/resume/test-upload-resume-fail-open.ts   (no dependencies, no network, no model call)
// AP9 phase E: a bug in the role bucket repair must never block an upload. This test cuts the real repair block out of upload-resume's own
// source, runs it with the REAL page merge and position numbering from the same file, and makes the repair step (or the final ordering
// step) throw. The upload must carry on with the model's original, unrepaired pages, and the error must be logged.
import assert from "node:assert/strict";
import fs from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { repairRoleBuckets, orderRoleGroupsLatestFirst } from "../../supabase/functions/_shared/resume-role-buckets.ts";

let n = 0; const t = (name: string, fn: () => void) => { fn(); n++; console.log("ok  ", name); };
const src = fs.readFileSync(new URL("../../supabase/functions/upload-resume/index.ts", import.meta.url), "utf8").replace(/\r\n/g, "\n");
const mergeCode = src.slice(src.indexOf("const PAGE_POSITION_SPAN"), src.indexOf("const RELAY_CALLS_PER_INVOCATION"));
const m: any = await import("data:text/javascript;base64," + Buffer.from(stripTypeScriptTypes(mergeCode) + "\nexport { mergeExtractions, dedupePositions };", "utf8").toString("base64"));
const start = src.indexOf("  const roleBucketLog: string[] = [];");
const end = src.indexOf("  // OCR text per page, in page order");
assert.ok(start > 0 && end > start, "repair block not found in upload-resume");
const block = src.slice(start, end);
assert.ok(block.includes("try {") && block.includes("catch (roleBucketErr)"), "the repair block must sit in a try with a catch");
const run = new Function("ordered", "repairRoleBuckets", "orderRoleGroupsLatestFirst", "dedupePositions", "mergeExtractions", "docId", "mergedBoundaries", "console",
  stripTypeScriptTypes(block) + "\nreturn merged;") as any;

const row = (page: number, ocr: string, wh: any[]) => ({ page_number: page, ocr_text: ocr, extraction: { work_history: wh, education: [], certifications: [], skills: [], freeform: [] } });
const ordered = [row(1, "PROFESSIONAL EXPERIENCE\nAcme Corp, Austin, TX 2015 2023\nSenior Analyst, 2019 2023\nAnalyst, 2015 2019", [
  { company: "Acme Corp", title: "Analyst to Senior Analyst", start_date: "2015", end_date: "2023", job_responsibilities: "Analyst, 2015 - 2019:\nBuilt the model.\n\nSenior Analyst, 2019 - 2023:\nLed the team.", heading: "PROFESSIONAL EXPERIENCE", position: 0 }])];
const unrepaired = m.dedupePositions(m.mergeExtractions(ordered.map((r) => ({ pageNumber: r.page_number, extraction: r.extraction }))), { sections: [] });
const logs: string[] = []; const errors: string[] = [];
const fakeConsole = { log: (s: string) => logs.push(s), error: (s: string) => errors.push(s) };
const call = (repair: any, order: any) => { logs.length = 0; errors.length = 0; return run(ordered, repair, order, m.dedupePositions, m.mergeExtractions, "doc-test", { sections: [] }, fakeConsole); };

t("normal case: the repair splits the merged entry (so the test block really does the repair)", () => {
  const merged = call(repairRoleBuckets, orderRoleGroupsLatestFirst);
  assert.deepEqual(merged.work_history.map((w: any) => w.title), ["Senior Analyst", "Analyst"]);
  assert.equal(errors.length, 0);
});

t("the repair step throws: the upload carries on with the unrepaired pages and the error is logged", () => {
  const merged = call(() => { throw new Error("boom in repair"); }, orderRoleGroupsLatestFirst);
  assert.deepEqual(merged.work_history, unrepaired.work_history);
  assert.equal(errors.length, 1);
  assert.ok(errors[0].includes("FAILED") && errors[0].includes("boom in repair") && errors[0].includes("doc-test"));
});

t("the final ordering step throws: the upload carries on with the unrepaired pages and the error is logged", () => {
  const merged = call(repairRoleBuckets, () => { throw new Error("boom in ordering"); });
  assert.deepEqual(merged.work_history, unrepaired.work_history);
  assert.equal(errors.length, 1); assert.ok(errors[0].includes("boom in ordering"));
});

t("the repair returns something unusable (not a list): the merge throws inside the guarded block and the upload still carries on", () => {
  const merged = call(() => ({ work_history: null, needsReview: [], actions: ["x"] }), orderRoleGroupsLatestFirst);
  assert.deepEqual(merged.work_history, unrepaired.work_history);
  assert.equal(errors.length, 1);
});

t("no marker field and no repaired entry ever reaches the result when the fallback is used", () => {
  const merged = call(() => { throw new Error("x"); }, orderRoleGroupsLatestFirst);
  assert.ok(merged.work_history.every((w: any) => !("_role_group" in w)));
});

console.log(`\n${n} tests passed`);
