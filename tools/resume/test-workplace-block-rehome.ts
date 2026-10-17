// node --experimental-strip-types tools/resume/test-workplace-block-rehome.ts   (needs git and the repo history, no network, no model call)
// AP9R (Fix B): a skills-labeled block that contains a string the skill text restore (Fix A) really restored is not a skills list; the merge puts it
// in freeform as additional_info (heading as printed), with its continuation pages, instead of needs_review. This test runs the REAL merge code of
// upload-resume (cut from its own source) against the merge code of eced6e5 (Fix A, what is deployed today) and proves:
//  - the Beast three then two split: one additional_info section equal to the Oct 15 stored content, nothing left in the skills list, no needs_review
//  - every stored page of the six hand-test resumes (and their multi-page combinations) gives a deep-equal merge result to today's, except the Beast block
//  - a real skills list over two pages, a long-phrases block with nothing restored, Fix A not run or failed: the old path
//  - the Fix B logic forced to throw falls back to today's result and logs "workplace block rehome FAILED"
//  - upload-resume's real block: the log line, no log line for the other resumes, no duplicate line when the role bucket repair fails
import assert from "node:assert/strict";
import fs from "node:fs";
import { execFileSync } from "node:child_process";
import { stripTypeScriptTypes } from "node:module";
import { restoreSkillText } from "../../supabase/functions/_shared/resume-skill-text.ts";
import { repairRoleBuckets, orderRoleGroupsLatestFirst } from "../../supabase/functions/_shared/resume-role-buckets.ts";
import { pages as fixture } from "./fixtures/skill-text-pages.ts";

const tests: Array<[string, () => void | Promise<void>]> = [];
const t = (name: string, fn: () => void | Promise<void>) => tests.push([name, fn]);
const EM = String.fromCharCode(8212);

const SRC = "supabase/functions/upload-resume/index.ts";
const srcNew = fs.readFileSync(new URL("../../" + SRC, import.meta.url), "utf8").replace(/\r\n/g, "\n");
let srcOld = "";
try { srcOld = execFileSync("git", ["show", "eced6e5:" + SRC], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }).replace(/\r\n/g, "\n"); } catch { srcOld = ""; }
assert.ok(srcOld.includes("function splitCrossPageSkills("), "could not read eced6e5's upload-resume with git show (run git fetch origin first)");
async function loadMerge(src: string) {
  const cleanHeadingLine = src.split("\n").find((l) => l.startsWith("function cleanHeading("));
  assert.ok(cleanHeadingLine);
  const code = src.slice(src.indexOf("const PAGE_POSITION_SPAN"), src.indexOf("const RELAY_CALLS_PER_INVOCATION"));
  return await import("data:text/javascript;base64," + Buffer.from(stripTypeScriptTypes(cleanHeadingLine + "\n" + code) + "\nexport { mergeExtractions, dedupePositions };", "utf8").toString("base64")) as any;
}
const mOld = await loadMerge(srcOld), mNew = await loadMerge(srcNew);

// ---------- the Beast pages, as stored for the Fix A run (document 49d175fe) ----------
const fx = (name: string) => fixture.find((p) => p.name.startsWith(name))!;
const B1 = fx("PironeBeast page 1"), B3 = fx("PironeBeast page 3"), B4 = fx("PironeBeast page 4");
const HIGHLIGHTS = "Led multi-stakeholder product development initiatives from concept through launch, aligning engineering, marketing, and operations teams around unified delivery goals.\nManaged enterprise client portfolios with high contract value, achieving 95%+ retention rates through proactive success planning and relationship stewardship.\nBuilt and mentored high-performing teams across sales, operations, and technical support functions, fostering cultures of accountability and continuous improvement.\nSpearheaded process improvement projects reducing operational overhead by 20-30% through automation and strategic workflow redesign.\nDelivered executive-level presentations and business cases to C-suite and board-level stakeholders, securing strategic organizational buy-in.\nRecognized for consistently exceeding KPIs in customer satisfaction, revenue retention, and on-time project delivery across multiple business units and environments.";
const CONTINUING = "Continuing Education: 55+ hours of AI & emerging technology certification coursework Coursiv, 2024-2025";
const emptyEx = (o: any) => ({ candidate_location: "", candidate_phone: "", candidate_email: "", printed_header: "", work_history: [], education: [], certifications: [], skills: [], skills_heading: "", skills_position: null, freeform: [], ...o });
const beastEx = () => [
  { n: 1, ex: emptyEx({ skills: B1.skills.slice(), skills_heading: "CORE COMPETENCIES", skills_position: 2 }), ocr: B1.ocr, hd: ["CORE COMPETENCIES"] },
  { n: 3, ex: emptyEx({ skills: B3.skills.slice(), skills_heading: "WORKPLACE STRENGTHS", skills_position: 3, freeform: [{ section_type: "additional_info", heading: "SELECTED CAREER HIGHLIGHTS", content: HIGHLIGHTS, position: 2 }] }), ocr: B3.ocr, hd: ["", "Business Operations & Portfolio Manager", "SELECTED CAREER HIGHLIGHTS", "WORKPLACE STRENGTHS"] },
  { n: 4, ex: emptyEx({ skills: B4.skills.slice(), skills_heading: "", skills_position: 0, freeform: [{ section_type: "additional_info", heading: "EDUCATION", content: CONTINUING, position: 2 }] }), ocr: B4.ocr, hd: ["", "EDUCATION"] },
];
// what upload-resume's restore step hands to the merge: the page with Fix A applied, plus the indexes it restored
function fixA(list: Array<{ n: number; ex: any; ocr: string | null; hd: string[] }>) {
  return list.map((p) => {
    const fix = restoreSkillText(p.ex.skills, p.ocr, p.hd);
    return fix.changes.length
      ? { withMarker: { pageNumber: p.n, extraction: { ...p.ex, skills: fix.skills }, skillsRestored: fix.changes.map((c) => c.index) }, noMarker: { pageNumber: p.n, extraction: { ...p.ex, skills: fix.skills } } }
      : { withMarker: { pageNumber: p.n, extraction: p.ex }, noMarker: { pageNumber: p.n, extraction: p.ex } };
  });
}
const todayOf = (list: any[]) => mOld.mergeExtractions(fixA(list).map((x) => x.noMarker));
const newOf = (list: any[], report?: any) => mNew.mergeExtractions(fixA(list).map((x) => x.withMarker), report);
const ws = (merged: any) => (merged.freeform || []).filter((f: any) => /WORKPLACE STRENGTHS/.test(f.heading || ""));

// the Oct 15 stored content of the Workplace Strengths section (document dd9efed6, additional_info, 729 characters)
const OCT15 = [
  `Strategic Thinking & Analytical Problem Solving ${EM} approaches challenges with a big-picture mindset while maintaining rigorous attention to operational detail`,
  `Relationship Building & Executive Presence ${EM} trusted by clients and leadership alike to represent solutions credibly at every organizational level`,
  `Adaptive Communication Across Technical & Non-Technical Audiences ${EM} consistently translates complexity into clarity for diverse stakeholder groups`,
].join("\n") + "\n\n" + [
  "Initiative & Self-Direction in Fast-Changing Environments proactively identifies and acts on opportunities without requiring top-down direction",
  "Collaborative Leadership & Cross-Functional Influence drives alignment and momentum across teams, departments, and external partners",
].join("\n");

t("Beast 3 then 2: one additional_info section equal to the Oct 15 content; today's (Fix A) result is the same text as needs_review", () => {
  assert.equal(OCT15.length, 729);
  const today = todayOf(beastEx()), after = newOf(beastEx());
  const a = ws(today), b = ws(after);
  assert.equal(a.length, 1); assert.equal(b.length, 1);
  assert.equal(a[0].section_type, "needs_review"); assert.equal(a[0].content, OCT15, "today: full text, wrong label");
  assert.equal(b[0].section_type, "additional_info");
  assert.equal(b[0].heading, "WORKPLACE STRENGTHS");
  assert.equal(b[0].content, OCT15, "after: content equal to the Oct 15 content");
  assert.equal(b[0].content.length, 729);
  assert.equal(b[0].position, a[0].position, "same place in the section order");
  console.log("      BEFORE (today, Fix A): section_type=" + a[0].section_type + " heading=" + a[0].heading + " position=" + a[0].position + " chars=" + a[0].content.length);
  console.log("      AFTER  (Fix B):        section_type=" + b[0].section_type + " heading=" + b[0].heading + " position=" + b[0].position + " chars=" + b[0].content.length);
});

t("Beast: nothing from the block is left in the skills list; no needs_review and no flag anywhere in the merged freeform", () => {
  const after = newOf(beastEx()), today = todayOf(beastEx());
  assert.deepEqual(after.skills, today.skills); assert.equal(after.skills.length, 16);
  assert.equal(after.skills_heading, "CORE COMPETENCIES"); assert.equal(after.skills_position, today.skills_position);
  for (const s of after.skills) assert.ok(!/approaches challenges|trusted by clients|drives alignment|proactively identifies/.test(s));
  assert.equal(after.freeform.filter((f: any) => f.section_type === "needs_review").length, 0);
  assert.equal(today.freeform.filter((f: any) => f.section_type === "needs_review").length, 1);
});

t("Beast: every other field of the merge result is deep-equal to today's; only the type of the Workplace Strengths section differs", () => {
  const today = todayOf(beastEx()), after = newOf(beastEx());
  const strip = (m: any) => ({ ...m, freeform: m.freeform.map((f: any) => (/WORKPLACE STRENGTHS/.test(f.heading) ? { ...f, section_type: "X" } : f)) });
  assert.deepEqual(strip(after), strip(today));
  assert.deepEqual(after.freeform.map((f: any) => f.heading), today.freeform.map((f: any) => f.heading));
});

t("Beast: the log hook gets exactly one line (heading, 5 items moved, first item cut at 60 characters); nothing on the old path", () => {
  const lines: Array<[string, string]> = [];
  newOf(beastEx(), (lvl: string, msg: string) => lines.push([lvl, msg]));
  assert.equal(lines.length, 1); assert.equal(lines[0][0], "log");
  assert.ok(lines[0][1].includes('heading "WORKPLACE STRENGTHS"') && lines[0][1].includes("5 item(s) moved") && lines[0][1].includes('first: "Strategic Thinking & Analytical Problem Solving ') && lines[0][1].length < 260);
  console.log("      LOG LINE: " + lines[0][1]);
  const quiet: Array<[string, string]> = [];
  newOf([beastEx()[0]], (lvl: string, msg: string) => quiet.push([lvl, msg]));
  assert.equal(quiet.length, 0);
});

t("first block case: a resume whose only skills-labeled block is the restored Workplace Strengths (3 then 2): skills list empty, one additional_info section", () => {
  const after = newOf([beastEx()[1], beastEx()[2]]);
  assert.deepEqual(after.skills, []); assert.equal(after.skills_heading, "");
  const b = ws(after); assert.equal(b.length, 1); assert.equal(b[0].section_type, "additional_info"); assert.equal(b[0].content, OCT15);
});

t("stored pages of the six hand-test resumes (alone, and the Beast in document order without page 3): merge result deep-equal to today's", () => {
  let n = 0;
  for (const p of fixture) {
    if (p === B3) continue; // the one that changes, covered above
    const page = [{ n: 1, ex: emptyEx({ skills: p.skills.slice(), skills_heading: "SKILLS", skills_position: 1 }), ocr: p.ocr, hd: [] as string[] }];
    assert.deepEqual(newOf(page), todayOf(page), p.name);
    n++;
  }
  assert.equal(n, 8);
  const b14 = [beastEx()[0], beastEx()[2]];
  assert.deepEqual(newOf(b14), todayOf(b14));
});

t("a real skills list over two pages (second page no heading, then same heading repeated): old path, even when something was restored on the second page", () => {
  const l1 = fixture.find((p) => p.name.startsWith("PironeSimple"))!;
  const mk = (heading2: string) => [
    { n: 1, ex: emptyEx({ skills: l1.skills.slice(0, 8), skills_heading: "CORE COMPETENCIES", skills_position: 1 }), ocr: null, hd: [] },
    { n: 2, ex: emptyEx({ skills: l1.skills.slice(8), skills_heading: heading2, skills_position: 0 }), ocr: null, hd: [] },
  ];
  for (const h of ["", "CORE COMPETENCIES"]) {
    const list = mk(h);
    assert.deepEqual(newOf(list), todayOf(list));
    assert.equal(newOf(list).skills.length, 15);
    // force a restored marker on the continuation page: it is a continuation of the primary list, so it must still go the old way
    const forced = list.map((p) => ({ pageNumber: p.n, extraction: p.ex, skillsRestored: p.n === 2 ? [0] : undefined }));
    assert.deepEqual(mNew.mergeExtractions(forced), mOld.mergeExtractions(list.map((p) => ({ pageNumber: p.n, extraction: p.ex }))));
  }
});

t("a differently headed block of long phrases with NOTHING restored: old path (needs_review), identical to today", () => {
  const long = ["Leads cross-functional teams to deliver complex programs on time and under budget", "Builds long term relationships with executive stakeholders across the business", "Translates complicated technical topics into plain language for any audience"];
  const list = [
    { n: 1, ex: emptyEx({ skills: ["A", "B"], skills_heading: "CORE COMPETENCIES", skills_position: 1 }), ocr: null, hd: [] },
    { n: 2, ex: emptyEx({ skills: long, skills_heading: "KEY STRENGTHS", skills_position: 1 }), ocr: "no match here", hd: [] },
  ];
  const a = newOf(list), b = todayOf(list);
  assert.deepEqual(a, b);
  assert.equal(a.freeform.find((f: any) => f.heading === "KEY STRENGTHS").section_type, "needs_review");
});

t("Fix A did not run (no marker) or failed: the Beast gets exactly today's result", () => {
  const today = todayOf(beastEx());
  const noMarker = mNew.mergeExtractions(fixA(beastEx()).map((x) => x.noMarker));
  assert.deepEqual(noMarker, today);
  const empty = mNew.mergeExtractions(fixA(beastEx()).map((x) => ({ ...x.noMarker, skillsRestored: [] })));
  assert.deepEqual(empty, today);
});

t("a differently headed, non-restored block right after a re-homed one is not swallowed: it takes the old needs_review path", () => {
  const list = [...beastEx().slice(0, 2), { n: 4, ex: emptyEx({ skills: ["Some Other Heading Item One", "Item Two"], skills_heading: "AWARDS LIST", skills_position: 1 }), ocr: null, hd: [] }];
  const after = newOf(list);
  const other = after.freeform.find((f: any) => f.heading === "AWARDS LIST");
  assert.equal(other.section_type, "needs_review");
  assert.equal(ws(after)[0].section_type, "additional_info");
  assert.equal(ws(after)[0].content, OCT15.split("\n\n")[0]);
  assert.equal(after.skills.length, 16, "the core skills list is untouched");
});

t("the Fix B logic forced to throw: the old result, and one 'workplace block rehome FAILED' line", () => {
  const today = todayOf(beastEx());
  const lines: Array<[string, string]> = [];
  // 1. the report hook throws on its first (log) call, which happens inside the guarded step
  const afterHook = newOf(beastEx(), (lvl: string, msg: string) => { lines.push([lvl, msg]); if (lvl === "log") throw new Error("boom in report"); });
  assert.deepEqual(afterHook, today);
  assert.equal(lines.filter(([l, m]) => l === "error" && m.includes("workplace block rehome FAILED") && m.includes("boom in report")).length, 1);
  // 2. a page whose skills_position throws the first time it is read (the re-homing split reads it first)
  let reads = 0;
  const pagesList = fixA(beastEx()).map((x) => x.withMarker);
  const trapped = { ...pagesList[1].extraction };
  Object.defineProperty(trapped, "skills_position", { get() { reads++; if (reads === 1) throw new Error("trap"); return 3; }, enumerable: true });
  pagesList[1] = { ...pagesList[1], extraction: trapped } as any;
  const err: Array<[string, string]> = [];
  const result = mNew.mergeExtractions(pagesList, (lvl: string, msg: string) => err.push([lvl, msg]));
  assert.deepEqual(result.skills, today.skills);
  assert.equal(ws(result)[0].section_type, "needs_review", "fell back to the old split");
  assert.ok(err.some(([l, m]) => l === "error" && m.includes("workplace block rehome FAILED") && m.includes("trap")));
});

// ---------- upload-resume's real block ----------
const start = srcNew.indexOf("  let pagesForMerge");
const end = srcNew.indexOf("  // OCR text per page, in page order");
assert.ok(start > 0 && end > start);
const block = srcNew.slice(start, end);
assert.ok(block.includes("workplace") || block.includes("skillBlockLog"));
const run = new Function("ordered", "restoreSkillText", "repairRoleBuckets", "orderRoleGroupsLatestFirst", "dedupePositions", "mergeExtractions", "docId", "mergedBoundaries", "console",
  stripTypeScriptTypes(block) + "\nreturn merged;") as any;
const row = (p: { n: number; ex: any; ocr: string | null; hd: string[] }) => ({ page_number: p.n, ocr_text: p.ocr, extraction: p.ex, sectionBoundaries: { sections: p.hd.map((h) => ({ heading: h, category: "skills" })) } });
const logs: string[] = [], errors: string[] = [];
const fakeConsole = { log: (s: string) => logs.push(s), error: (s: string) => errors.push(s) };
const call = (list: any[], repair: any = repairRoleBuckets, merge: any = mNew.mergeExtractions) => { logs.length = 0; errors.length = 0; return run(list.map(row), restoreSkillText, repair, orderRoleGroupsLatestFirst, mNew.dedupePositions, merge, "doc-test", { sections: [] }, fakeConsole); };

t("upload-resume block: Beast gives the additional_info section and ONE 'workplace block rehomed' line (with the document id) after the restore line", () => {
  const merged = call(beastEx());
  assert.equal(ws(merged)[0].section_type, "additional_info"); assert.equal(ws(merged)[0].content, OCT15);
  const rh = logs.filter((l) => l.includes("workplace block rehomed"));
  assert.equal(rh.length, 1);
  assert.ok(rh[0].startsWith("upload-resume: doc-test workplace block rehomed:") && rh[0].includes("5 item(s) moved"));
  assert.equal(logs.filter((l) => l.includes("skill text restored")).length, 1);
  assert.equal(errors.length, 0);
});

t("upload-resume block: the other stored resumes log neither 'rehomed' nor 'skill text' lines and merge exactly as today", () => {
  for (const p of fixture) {
    if (p === B3 || p === B4) continue;
    const page = [{ n: 1, ex: emptyEx({ skills: p.skills.slice(), skills_heading: "SKILLS", skills_position: 1 }), ocr: p.ocr, hd: [] as string[] }];
    const merged = call(page);
    assert.equal(logs.filter((l) => /rehomed|skill text/.test(l)).length, 0, p.name);
    assert.equal(errors.length, 0, p.name);
    assert.deepEqual(merged, call(page, repairRoleBuckets, mOld.mergeExtractions), p.name);
  }
});

t("upload-resume block: when the role bucket repair fails, the merge runs again and the 'rehomed' line is printed once, not twice", () => {
  const merged = call(beastEx(), () => { throw new Error("repair down"); });
  assert.equal(ws(merged)[0].section_type, "additional_info");
  assert.equal(logs.filter((l) => l.includes("workplace block rehomed")).length, 1);
  assert.equal(errors.filter((e) => e.includes("role bucket repair FAILED")).length, 1);
});

t("upload-resume block: Fix B forced to throw inside the merge: today's result, the FAILED line with the document id, no rehomed line", () => {
  const today = call(beastEx(), repairRoleBuckets, (pg: any[]) => mOld.mergeExtractions(pg));
  const failing = (pg: any[], report: any) => mNew.mergeExtractions(pg, (lvl: string, msg: string) => { if (lvl === "log") throw new Error("hook down"); report(lvl, msg); });
  const merged = call(beastEx(), repairRoleBuckets, failing);
  assert.deepEqual(merged, today);
  assert.equal(errors.filter((e) => e.startsWith("upload-resume: doc-test workplace block rehome FAILED")).length, 1);
  assert.equal(logs.filter((l) => l.includes("workplace block rehomed")).length, 0);
});

t("wiring: the guarded split is the only caller of the re-homing path, and mergeExtractions is called only from the PDF page merge", () => {
  assert.equal(srcNew.split("splitCrossPageSkills(pages, true, notes)").length - 1, 1);
  assert.equal(srcNew.split("mergeExtractions(bucketed.map").length - 1, 1);
  assert.equal(srcNew.split("mergeExtractions(pagesForMerge.map").length - 1, 1);
  assert.equal(srcNew.split("splitCrossPageSkillsGuarded(pages, report)").length - 1, 1);
});

for (const [name, fn] of tests) { await fn(); console.log("ok  ", name); }
console.log(`\n${tests.length} tests passed`);
