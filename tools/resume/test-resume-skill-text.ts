// node --experimental-strip-types tools/resume/test-resume-skill-text.ts   (no dependencies, no network, no model call)
// AP9O (Fix A): restoreSkillText puts the full "title plus description" text back into skills strings from the page's own OCR, and changes
// nothing else. This test proves:
//  - the stored pages fixture matches the database (md5 of OCR and of the skills array)
//  - every stored page is returned byte for byte (the same array object) EXCEPT PironeBeast page 3, whose three Workplace Strengths items are restored
//  - the edge cases: plain list, parentheticals, two columns, title alone with the description on the next line, the 3 then 2 split
//  - empty and hostile input, OCR text without the strings, very long OCR text, no mutation of the input
//  - upload-resume's real block (cut out of its own source): normal, restore throws, restore returns garbage -> fail open, one log line per restored page,
//    nothing logged when nothing changed, and the rest of the merge result is identical with and without the restore
import assert from "node:assert/strict";
import fs from "node:fs";
import crypto from "node:crypto";
import { stripTypeScriptTypes } from "node:module";
import { restoreSkillText, MIN_REST_CHARS, MIN_QUALIFYING, MIN_QUALIFYING_SHARE } from "../../supabase/functions/_shared/resume-skill-text.ts";
import { repairRoleBuckets, orderRoleGroupsLatestFirst } from "../../supabase/functions/_shared/resume-role-buckets.ts";
import { pages } from "./fixtures/skill-text-pages.ts";

const tests: Array<[string, () => void | Promise<void>]> = [];
const t = (name: string, fn: () => void | Promise<void>) => tests.push([name, fn]);
const md5 = (s: string) => crypto.createHash("md5").update(s, "utf8").digest("hex");
const EM = "—";

// ---------------- the fixture and the stored pages ----------------
t("fixture: the OCR text of every page matches the md5 stored in the database", () => {
  assert.equal(pages.length, 9);
  for (const p of pages) assert.equal(md5(p.ocr), p.ocrMd5, p.name);
});

t("fixture: the skills array of every page matches the md5 of the stored jsonb text", () => {
  for (const p of pages) assert.equal(md5("[" + p.skills.map((s) => JSON.stringify(s)).join(", ") + "]"), p.skillsMd5, p.name);
});

const BEAST3 = pages.find((p) => p.name.startsWith("PironeBeast page 3"))!;
const BEAST4 = pages.find((p) => p.name.startsWith("PironeBeast page 4"))!;
const headingsOf = (name: string): string[] => name.startsWith("PironeBeast page 3") ? ["", "Business Operations & Portfolio Manager", "SELECTED CAREER HIGHLIGHTS", "WORKPLACE STRENGTHS"]
  : name.startsWith("PironeBeast page 4") ? ["", "EDUCATION"] : [];

t("byte identity: every stored page except PironeBeast page 3 comes back as the very same array, with no change recorded", () => {
  let checked = 0;
  for (const p of pages) {
    if (p === BEAST3) continue;
    const before = JSON.stringify(p.skills);
    const r = restoreSkillText(p.skills, p.ocr, headingsOf(p.name));
    assert.equal(r.skills, p.skills, p.name + ": must be the same array object");
    assert.equal(r.changes.length, 0, p.name);
    assert.equal(JSON.stringify(r.skills), before, p.name);
    checked++;
  }
  assert.equal(checked, 8);
});

const EXPECTED_BEAST3 = [
  `Strategic Thinking & Analytical Problem Solving ${EM} approaches challenges with a big-picture mindset while maintaining rigorous attention to operational detail`,
  `Relationship Building & Executive Presence ${EM} trusted by clients and leadership alike to represent solutions credibly at every organizational level`,
  `Adaptive Communication Across Technical & Non-Technical Audiences ${EM} consistently translates complexity into clarity for diverse stakeholder groups`,
];

t("PironeBeast page 3: the three Workplace Strengths items are restored, nothing else changes (before and after printed)", () => {
  const input = BEAST3.skills.slice();
  const r = restoreSkillText(BEAST3.skills, BEAST3.ocr, headingsOf(BEAST3.name));
  assert.deepEqual(r.skills, EXPECTED_BEAST3);
  assert.deepEqual(r.changes.map((c) => c.index), [0, 1, 2]);
  assert.deepEqual(r.changes.map((c) => c.before), input);
  assert.deepEqual(BEAST3.skills, input, "the input array must not be changed");
  assert.notEqual(r.skills, BEAST3.skills);
  console.log("      BEFORE/AFTER (Beast page 3, same in the 6 stored documents that hold this page):");
  r.changes.forEach((c, i) => console.log(`       ${i + 1}. before: ${c.before}\n          after:  ${c.after}`));
});

t("PironeBeast page 4 (the 2 of the 3 then 2 split): left exactly as the model gave it, because its strings are not at the start of an OCR line", () => {
  const r = restoreSkillText(BEAST4.skills, BEAST4.ocr, headingsOf(BEAST4.name));
  assert.equal(r.skills, BEAST4.skills); assert.equal(r.changes.length, 0);
  // and the model's page 4 strings already carry their description (stored answer)
  assert.ok(BEAST4.skills[0].includes("proactively identifies") && BEAST4.skills[1].includes("drives alignment"));
});

t("the same restore is idempotent: a second pass over the restored strings changes nothing", () => {
  const first = restoreSkillText(BEAST3.skills, BEAST3.ocr, headingsOf(BEAST3.name));
  const second = restoreSkillText(first.skills, BEAST3.ocr, headingsOf(BEAST3.name));
  assert.equal(second.changes.length, 0); assert.equal(second.skills, first.skills);
});

// ---------------- the five edge cases and the gate ----------------
const ok = (skills: string[], ocr: string, headings: string[] = []) => restoreSkillText(skills, ocr, headings);

t("edge 1: a plain list with delimiters (Python | SQL) is unchanged", () => {
  const s = ["Python", "SQL", "Tableau"];
  const r = ok(s, "SKILLS\nPython | SQL | Tableau");
  assert.equal(r.skills, s); assert.equal(r.changes.length, 0);
});

t("edge 2: parentheticals (Python (5 years)) are unchanged, whether the model kept them in the string or not", () => {
  const a = ["Python", "SQL"]; const ra = ok(a, "Python (5 years)\nSQL (3 years)");
  assert.equal(ra.skills, a); assert.equal(ra.changes.length, 0);
  const b = ["Python (5 years)", "SQL (3 years)"]; const rb = ok(b, "Python (5 years)\nSQL (3 years)");
  assert.equal(rb.skills, b); assert.equal(rb.changes.length, 0);
});

t("edge 3: a two column list is unchanged (the rest of the line is the other column, which starts with a capital)", () => {
  const s = ["Customer Success", "Data Analysis", "Change Management", "Digital Strategy"];
  const r = ok(s, "Customer Success Data Analysis\nChange Management Digital Strategy");
  assert.equal(r.skills, s); assert.equal(r.changes.length, 0);
});

t("edge 3b: a two column list whose second column starts in lowercase is still unchanged when fewer than 2 items qualify, or fewer than half of the found items do", () => {
  const four = ["Alpha tools", "Beta", "Gamma", "Delta"];
  const r1 = ok(four, "Alpha tools and techniques for analysis of the data\nBeta\nGamma\nDelta");
  assert.equal(r1.skills, four, "1 qualifying item is below MIN_QUALIFYING");
  const five = ["A one", "B two", "C three", "D four", "E five"];
  const ocr5 = "A one runs through a long lowercase continuation here\nB two continues with a long lowercase continuation here\nC three\nD four\nE five";
  const r2 = ok(five, ocr5);
  assert.equal(r2.skills, five, "2 of 5 is a share of 0.4, below MIN_QUALIFYING_SHARE");
  const four2 = ["A one", "B two", "C three", "D four"];
  const ocr4 = "A one runs through a long lowercase continuation here\nB two continues with a long lowercase continuation here\nC three\nD four";
  const r3 = ok(four2, ocr4);
  assert.equal(r3.changes.length, 2, "2 of 4 is exactly MIN_QUALIFYING_SHARE and passes");
  assert.equal(MIN_QUALIFYING, 2); assert.equal(MIN_QUALIFYING_SHARE, 0.5); assert.equal(MIN_REST_CHARS, 25);
});

t("edge 4: a title alone on its line with the description on the next line is left unchanged (a conservative miss)", () => {
  const s = ["Strategic Thinking", "Relationship Building"];
  const r = ok(s, "WORKPLACE STRENGTHS\nStrategic Thinking\napproaches challenges with a big-picture mindset overall\nRelationship Building\ntrusted by clients and leadership alike across levels");
  assert.equal(r.skills, s); assert.equal(r.changes.length, 0);
});

t("edge 5: a list split 3 then 2 across two pages: page 3 is restored, page 4 is unchanged", () => {
  const p3 = restoreSkillText(BEAST3.skills, BEAST3.ocr, headingsOf(BEAST3.name));
  const p4 = restoreSkillText(BEAST4.skills, BEAST4.ocr, headingsOf(BEAST4.name));
  assert.equal(p3.changes.length, 3); assert.equal(p4.changes.length, 0); assert.equal(p4.skills, BEAST4.skills);
});

t("the threshold of 25 characters and the lowercase start are both required", () => {
  const s = ["Aaa Bbb", "Ccc Ddd"];
  assert.equal(ok(s, "Aaa Bbb short rest\nCcc Ddd short rest too").changes.length, 0, "rest under 25 characters");
  assert.equal(ok(s, "Aaa Bbb Starts with a capital letter here\nCcc Ddd Starts with a capital letter here").changes.length, 0, "rest starts with a capital");
  assert.equal(ok(s, "Aaa Bbb 12345 starts with a digit so no change\nCcc Ddd 12345 starts with a digit so no change").changes.length, 0, "rest starts with a digit");
  assert.equal(ok(s, "Aaa Bbb starts lowercase and is long enough here\nCcc Ddd starts lowercase and is long enough here").changes.length, 2);
});

t("a name that is only a prefix of a longer word does not match (Python vs Pythonic)", () => {
  const s = ["Python", "Ruby"];
  const r = ok(s, "Pythonic approaches to data engineering for teams everywhere\nRubyists around the world gather every single year");
  assert.equal(r.skills, s); assert.equal(r.changes.length, 0);
});

t("a lone dash line is moved between title and description; no dash line means a plain space; a blank line, a heading and the next item end the text", () => {
  const s = ["First Item", "Second Item", "Third Item"];
  const ocr = "WORKPLACE STRENGTHS\nFirst Item does the first thing very well always\ncontinues here\nSecond Item does the second thing very well always\n-\nand more\n\nstray unrelated line\nThird Item does the third thing very well always\nEDUCATION\nBachelor's Degree";
  const r = ok(s, ocr, ["WORKPLACE STRENGTHS", "EDUCATION"]);
  assert.deepEqual(r.skills, [
    "First Item does the first thing very well always continues here",
    `Second Item ${EM} does the second thing very well always and more`,
    "Third Item does the third thing very well always",
  ]);
});

t("a leading bullet or glyph on the OCR line is ignored when finding the title, and is not copied into the text", () => {
  const s = ["Item One", "Item Two"];
  const r = ok(s, "© Item One has a long lowercase description here\n* Item Two has a long lowercase description here");
  assert.deepEqual(r.skills, ["Item One has a long lowercase description here", "Item Two has a long lowercase description here"]);
});

// ---------------- empty, hostile, long input ----------------
t("empty and unusable input: returned as given, never throws", () => {
  const unusable: any[] = [undefined, null, "text", 5, {}, [], [""], ["  "], [null, 3, undefined]];
  for (const sk of unusable) {
    for (const ocr of [undefined, null, "", "   ", 5, {}, "some text\nmore text"]) {
      let r: any;
      assert.doesNotThrow(() => { r = restoreSkillText(sk, ocr as any, undefined); });
      assert.equal(r.skills, sk);
      assert.deepEqual(r.changes, []);
    }
  }
  for (const h of [undefined, null, "x", 5, {}, [null, 3, {}]]) assert.doesNotThrow(() => restoreSkillText(["a b"], "a b c d e f g h", h as any));
});

t("OCR text that does not contain the strings: unchanged", () => {
  const s = ["Alpha Skill", "Beta Skill"];
  const r = ok(s, "Nothing here matches at all\nNot even close to it");
  assert.equal(r.skills, s); assert.equal(r.changes.length, 0);
});

t("very long OCR text: finishes, correct, and does not change an unrelated list", () => {
  const filler = Array.from({ length: 60000 }, (_, i) => `filler line number ${i} with some words in it`).join("\n");
  const s = ["Alpha Skill", "Beta Skill"];
  const t0 = Date.now();
  const r1 = ok(s, filler);
  assert.equal(r1.skills, s);
  const r2 = ok(s, filler + "\nAlpha Skill does something long and lowercase here\nBeta Skill does another long and lowercase thing");
  assert.equal(r2.changes.length, 2);
  assert.ok(Date.now() - t0 < 5000, "took " + (Date.now() - t0) + " ms");
});

t("the input array and its strings are never mutated", () => {
  const s = Object.freeze(["Item One", "Item Two"]) as unknown as string[];
  assert.doesNotThrow(() => restoreSkillText(s, "Item One has a long lowercase description here\nItem Two has a long lowercase description here"));
});

// ---------------- upload-resume's real block ----------------
const src = fs.readFileSync(new URL("../../supabase/functions/upload-resume/index.ts", import.meta.url), "utf8").replace(/\r\n/g, "\n");
const mergeCode = src.slice(src.indexOf("const PAGE_POSITION_SPAN"), src.indexOf("const RELAY_CALLS_PER_INVOCATION"));
const cleanHeadingLine = src.split("\n").find((l) => l.startsWith("function cleanHeading("));
assert.ok(cleanHeadingLine, "cleanHeading not found in upload-resume (splitCrossPageSkills uses it)");
const m: any = await import("data:text/javascript;base64," + Buffer.from(stripTypeScriptTypes(cleanHeadingLine + "\n" + mergeCode) + "\nexport { mergeExtractions, dedupePositions };", "utf8").toString("base64"));
const start = src.indexOf("  let pagesForMerge");
const end = src.indexOf("  // OCR text per page, in page order");
assert.ok(start > 0 && end > start, "restore block not found in upload-resume");
const block = src.slice(start, end);
assert.ok(block.includes("catch (skillTextErr)") && block.includes("skill text restore FAILED"), "the restore step must be in its own try with the FAILED log");
const run = new Function("ordered", "restoreSkillText", "repairRoleBuckets", "orderRoleGroupsLatestFirst", "dedupePositions", "mergeExtractions", "docId", "mergedBoundaries", "console",
  stripTypeScriptTypes(block) + "\nreturn merged;") as any;

const ex = (skills: string[], heading: string, position: number | null, freeform: any[] = []) => ({ work_history: [], education: [], certifications: [], skills, skills_heading: heading, skills_position: position, freeform });
const p1 = pages.find((p) => p.name === "PironeBeast page 1")!;
const row = (page: number, ocr: string | null, extraction: any, headings: string[]) => ({ page_number: page, ocr_text: ocr, extraction, sectionBoundaries: { sections: headings.map((h) => ({ heading: h, category: "skills" })) } });
const makeOrdered = () => [
  row(1, p1.ocr, ex(p1.skills.slice(), "CORE COMPETENCIES", 1), ["CORE COMPETENCIES"]),
  row(3, BEAST3.ocr, ex(BEAST3.skills.slice(), "WORKPLACE STRENGTHS", 1), headingsOf(BEAST3.name)),
  row(4, BEAST4.ocr, ex(BEAST4.skills.slice(), "WORKPLACE STRENGTHS", 0), headingsOf(BEAST4.name)),
];
const logs: string[] = []; const errors: string[] = [];
const fakeConsole = { log: (s: string) => logs.push(s), error: (s: string) => errors.push(s) };
const call = (restore: any, ordered: any[] = makeOrdered()) => { logs.length = 0; errors.length = 0; return run(ordered, restore, repairRoleBuckets, orderRoleGroupsLatestFirst, m.dedupePositions, m.mergeExtractions, "doc-test", { sections: [] }, fakeConsole); };
const identity = (skills: any) => ({ skills, changes: [] });
const strengthsSection = (merged: any) => (merged.freeform || []).filter((f: any) => /WORKPLACE STRENGTHS/.test(f.heading || ""));

t("upload-resume block: with the restore, the Workplace Strengths section keeps its descriptions; the primary skills list and everything else are identical to without it", () => {
  const without = call(identity);
  const withFix = call(restoreSkillText);
  assert.deepEqual(withFix.skills, without.skills, "the primary skills list must be identical");
  assert.deepEqual({ ...withFix, freeform: null }, { ...without, freeform: null }, "everything except freeform must be identical");
  const a = strengthsSection(without), b = strengthsSection(withFix);
  assert.equal(a.length, 1); assert.equal(b.length, 1);
  assert.ok(!a[0].content.includes("big-picture mindset"), "today (without the restore) the descriptions of the first three items are lost");
  assert.ok(b[0].content.includes("big-picture mindset") && b[0].content.includes("trusted by clients") && b[0].content.includes("clarity for diverse"));
  assert.ok(b[0].content.includes("proactively identifies") && b[0].content.includes("drives alignment"), "page 4 items still present");
  assert.equal(b[0].section_type, "additional_info", "AP9R (Fix B): a block with restored strings is re-homed as additional_info, not needs_review");
  assert.equal(b[0].heading, a[0].heading);
  assert.equal(errors.length, 0);
});

t("upload-resume block: one log line per restored page, with the page number, the count and the first before and after; nothing is logged when nothing changed", () => {
  call(restoreSkillText);
  const restored = logs.filter((l) => l.includes("skill text restored"));
  assert.equal(restored.length, 1);
  assert.ok(restored[0].includes("doc-test") && restored[0].includes("page 3") && restored[0].includes("3 string(s)") && restored[0].includes("Strategic Thinking & Analytical Problem Solving") && restored[0].includes("->"));
  assert.ok(restored[0].length < 400);
  call(identity);
  assert.equal(logs.filter((l) => l.includes("skill text")).length, 0);
  const plain = [row(1, p1.ocr, ex(p1.skills.slice(), "CORE COMPETENCIES", 1), ["CORE COMPETENCIES"])];
  call(restoreSkillText, plain);
  assert.equal(logs.filter((l) => l.includes("skill text")).length, 0, "a page that is not changed logs nothing");
});

t("upload-resume block: the restore throws -> fail open, today's result exactly, the reason is logged, other sections untouched", () => {
  const today = call(identity);
  const failed = call(() => { throw new Error("boom in restore"); });
  assert.deepEqual(failed, today);
  assert.equal(errors.filter((e) => e.includes("skill text restore FAILED")).length, 1);
  assert.ok(errors[0].includes("boom in restore") && errors[0].includes("doc-test"));
  assert.equal(logs.filter((l) => l.includes("skill text restored")).length, 0);
});

t("upload-resume block: the restore returns garbage (no changes list, skills not a list) -> fail open, today's result exactly", () => {
  const today = call(identity);
  for (const bad of [() => undefined, () => null, () => ({}), () => ({ skills: "not a list", changes: [{ before: "x", after: "y" }] }), () => ({ skills: [1, 2], changes: [{}] })]) {
    const r = call(bad as any);
    assert.deepEqual(r, today);
    assert.equal(errors.filter((e) => e.includes("skill text restore FAILED")).length, 1, "each unusable result must be reported, once");
  }
});

t("upload-resume block: a throw on the LAST page does not leave the earlier pages half restored (all or nothing)", () => {
  let n = 0;
  const flaky = (skills: any, ocr: any, headings: any) => { n++; if (n === 3) throw new Error("late failure"); return restoreSkillText(skills, ocr, headings); };
  const today = call(identity);
  const r = call(flaky);
  assert.deepEqual(r, today);
  assert.equal(errors.filter((e) => e.includes("skill text restore FAILED")).length, 1);
});

t("upload-resume block: a vision routed page (no OCR text) passes through unchanged", () => {
  const ordered = makeOrdered(); ordered[1].ocr_text = null;
  const r = call(restoreSkillText, ordered);
  const today = call(identity, (() => { const o = makeOrdered(); o[1].ocr_text = null; return o; })());
  assert.deepEqual(r, today);
});

t("wiring: the restore is called exactly once in upload-resume, inside the PDF page merge (processPdfPages); the photo/image path does not call it", () => {
  const calls = src.split("restoreSkillText(").length - 1;
  assert.equal(calls, 1);
  const pdfStart = src.indexOf("async function processPdfPages");
  const at = src.indexOf("restoreSkillText(", pdfStart);
  assert.ok(pdfStart > 0 && at > pdfStart, "the call must come after the start of processPdfPages");
  // processPdfPages ends before the image path begins (the image path is the code after 'is a PDF, routing through rasterize-pdf-page')
  assert.ok(at < src.indexOf("is a PDF, routing through rasterize-pdf-page"), "the call must sit in processPdfPages, not in the later upload handler");
  // the image/vision branch (the path with p_ocr_text: null) is after processPdfPages and has no restore call
  const imagePath = src.slice(src.indexOf("p_ocr_text: null"));
  assert.ok(!imagePath.includes("restoreSkillText"));
});

for (const [name, fn] of tests) { await fn(); console.log("ok  ", name); }
console.log(`\n${tests.length} tests passed`);
