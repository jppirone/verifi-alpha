// node --experimental-strip-types tools/resume/test-seam-case-b-fragment.ts   (needs git and the repo history, no network, no model call)
// AP9AM: after AP9X-2 case B drops a repeated first line, the OCR-fragment stitch of Fix D is run on the result with larger caps (80 characters, 10 words), only on that
// path. Document 4833c981 (Donofrio, Applitrust PDF): the page break cuts a bullet, the page 4 extraction repeats the page 3 line instead of writing the OCR's first line
// "content delivered to healthcare professionals" (45 characters), case B removes the repeat and the words were lost. The REAL merge code is cut out of upload-resume (this
// commit) and out of 0e7a38c (deployed) and compared on the stored rows of the six stored case B seams (RAN SQL: five Truven seams of PironeSimple uploads whose previous
// text, continuation text and OCR first line are byte for byte identical by md5, and 4833c981 page 4).
import assert from "node:assert/strict";
import fs from "node:fs";
import { execFileSync } from "node:child_process";
import { stripTypeScriptTypes } from "node:module";

const tests: Array<[string, () => void | Promise<void>]> = [];
const t = (name: string, fn: () => void | Promise<void>) => tests.push([name, fn]);
const SRC = "supabase/functions/upload-resume/index.ts";
const srcNew = fs.readFileSync(new URL("../../" + SRC, import.meta.url), "utf8").replace(/\r\n/g, "\n");
const srcOld = execFileSync("git", ["show", "0e7a38c:" + SRC], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }).replace(/\r\n/g, "\n");
async function loadMerge(src: string) {
  const cleanHeadingLine = src.split("\n").find((l) => l.startsWith("function cleanHeading("))!;
  const code = src.slice(src.indexOf("const PAGE_POSITION_SPAN"), src.indexOf("const RELAY_CALLS_PER_INVOCATION"));
  return await import("data:text/javascript;base64," + Buffer.from(stripTypeScriptTypes(cleanHeadingLine + "\n" + code) + "\nexport { mergeExtractions, stitchSeamFragment };", "utf8").toString("base64")) as any;
}
const mNew = await loadMerge(srcNew), mOld = await loadMerge(srcOld);
type Rep = Array<[string, string]>;
const run = (m: any, pages: any[], rep: Rep = []) => m.mergeExtractions(pages, (lvl: string, msg: string) => rep.push([lvl, msg]));
const emptyEx = (o: any) => ({ candidate_location: "", candidate_phone: "", candidate_email: "", printed_header: "", work_history: [], education: [], certifications: [], skills: [], skills_heading: "", skills_position: null, freeform: [], ...o });
const row = (company: string, title: string, jr: string, o: any = {}) => ({ company, title, location: "", start_date: "", end_date: "", heading: "", job_responsibilities: jr, extraction_confidence: "high", position: 0, ...o });
const sec = (heading: string, category: string, cont = false) => ({ heading, category, is_continuation_of_previous_page: cont });
const twoPages = (prev: string, cont: string, ocr2: string | null | undefined, company = "Thomson Healthcare", title = "Vice President Technology") => [
  { pageNumber: 3, ocrText: "page three", sections: [sec("", "work_history", true)], extraction: emptyEx({ work_history: [row(company, title, prev, { position: 3, start_date: "1998-11", end_date: "2003-06" })] }) },
  { pageNumber: 4, ocrText: ocr2, sections: [sec("", "work_history", true)], extraction: emptyEx({ work_history: [row(company, title, cont, { position: 0 })] }) },
];
const textOf = (m: any, company = "Thomson Healthcare") => m.work_history.find((w: any) => w.company === company).job_responsibilities as string;

// ---------- the stored rows of 4833c981 (pages 3 and 4) ----------
const P3 = "Design and delivery of an editorial and web-publication system for reference and media";
const REST = "Transition to an integrated (Oracle Financials) general ledger, accounts payable, T&E, and procurement system which cut administrative overhead while significantly augmenting operating controls required to ensure Sarbanes Oxley compliance\nDivestiture and disentanglement of a $100M business unit (Medical Economics)\nLead an organization of over 80 technology professionals delivering software product and internal systems development\nGuidance and support for development of enterprise resource planning and order-to-cash systems";
const P4 = P3 + "\n" + REST;
const FRAG = "content delivered to healthcare professionals";
const OCR4 = FRAG + "\nTransition to an integrated (Oracle Financials) general ledger, accounts payable, T&E, and\nprocurement system which cut administrative overhead while significantly augmenting";

t("fixtures match the stored lengths (4833c981: page 3 row 86, page 4 row 615, fragment 45)", () => { assert.equal(P3.length, 86); assert.equal(P4.length, 615); assert.equal(FRAG.length, 45); });

t("4833c981: today's live merge gives 616 characters (cut bullet, blank line); now the first bullet is whole and the row is 661 characters", () => {
  const old = run(mOld, twoPages(P3, P4, OCR4));
  assert.equal(textOf(old), P3 + "\n\n" + REST); assert.equal(textOf(old).length, 616);
  const rep: Rep = [];
  const nw = run(mNew, twoPages(P3, P4, OCR4), rep);
  assert.equal(textOf(nw), P3 + " " + FRAG + "\n" + REST); assert.equal(textOf(nw).length, 661);
  assert.equal(textOf(nw).split("\n")[0], "Design and delivery of an editorial and web-publication system for reference and media content delivered to healthcare professionals");
  assert.ok(!textOf(nw).includes("\n\n"));
  assert.deepEqual(rep, [["log", "seam repeat - page 4: case B, first 40 chars: Design and delivery of an editorial and "], ["log", "seam stitch (case B fragment) - page 4: joined with one space, fragment \"" + FRAG.slice(0, 40) + "\""]]);
  assert.equal(FRAG.slice(0, 40), "content delivered to healthcare professi");
  console.log("      BEFORE " + textOf(old).length + " chars: " + JSON.stringify(textOf(old).slice(0, 120)) + " ...");
  console.log("      AFTER  " + textOf(nw).length + " chars: " + JSON.stringify(textOf(nw).slice(0, 170)) + " ...");
});

// ---------- the six stored case B seams ----------
const EM = String.fromCharCode(8212);
const TRUVEN_PREV = "Led integration efforts for 5 enterprise acquisitions over 8 years, coordinating cross-functional teams ranging from 50 to 200+ stakeholders depending on the structure of each acquired organization.\nDesigned integration and rollout sequencing across Sales, Finance, Operations, and Technology, aligning stakeholders on scope, timeline, and success criteria before go-live.\nRedesigned sales-to-contract and invoicing workflows, reducing sale: support effort by an estimated 20 hours per contract across approximately 200 contracts annually, and cutting 5" + EM + "10 hours of client-facing invoice/AP clarification work per contract through end-to-end billing cleanup.\nBuilt process documentation and SOPs that served as the onboarding foundation for enterprise system implementations at scale.\nManaged cross-functional delivery and governance to bring complex implementations in on schedule and budget.\nDeveloped and executed API-based data mapping strategies across Salesforce, Pramata (contract management), and Oracle, plus one-off integrations for custom CRM and AP systems inherited through acquisitions, bringing sales, contract, and AP data onto standardized enterprise systems.\nLed a company-wide identity and access management rollout (Fischer Identity, layered over Microsoft Active Directory/Exchange) for 5,000+ employees across multiple geographies, including self-service provisioning for managers overseeing contractor access; audited and pruned approximately 500 dormant accounts with lingering post-termination access, closing a significant security gap. Built training curricula for both a Tier 1 offshore support team and company-wide self-service adoption.";
const TRUVEN_CONT = "Pruned approximately 500 dormant accounts with lingering post-termination access, closing a significant security gap. Built training curricula for both a Tier 1 offshore support team and company-wide self-service adoption.";
const TRUVEN_OCR1 = "Technical Project Manager | QPharma | Summit, NJ | 2007 " + EM + " 2008";
const SEAMS: Array<{ doc: string; prev: string; cont: string; ocr: string; company: string; title: string; changes: boolean }> = [
  ...["13537c49", "2d01dd30", "33cbcc63", "595a0cf2", "e8865c97"].map((doc) => ({ doc, prev: TRUVEN_PREV, cont: TRUVEN_CONT, ocr: TRUVEN_OCR1 + "\nmore page text", company: "Truven Health Analytics (IBM Watson Health)", title: "Business Integration Manager", changes: false })),
  { doc: "4833c981", prev: P3, cont: P4, ocr: OCR4, company: "Thomson Healthcare", title: "Vice President Technology", changes: true },
];
t("replay of the six stored case B seams: exactly one changes (4833c981), the five Truven seams are byte for byte identical to the deployed merge (output and log lines)", () => {
  assert.equal(TRUVEN_PREV.length, 1667); assert.equal(TRUVEN_CONT.length, 222);
  let changed = 0;
  const lines: string[] = [];
  for (const s of SEAMS) {
    const rOld: Rep = [], rNew: Rep = [];
    const a = run(mOld, twoPages(s.prev, s.cont, s.ocr, s.company, s.title), rOld), b = run(mNew, twoPages(s.prev, s.cont, s.ocr, s.company, s.title), rNew);
    const same = JSON.stringify(a) === JSON.stringify(b) && JSON.stringify(rOld) === JSON.stringify(rNew);
    if (!same) changed++;
    assert.equal(!same, s.changes, s.doc);
    lines.push(`${s.doc} | case B | OCR first line starts ${/^[a-z]/.test(s.ocr) ? "lowercase" : "capital"} | before ${textOf(a, s.company).length} | after ${textOf(b, s.company).length} | ${same ? "identical" : "CHANGED"}`);
  }
  assert.equal(changed, 1);
  console.log(lines.map((l) => "      " + l).join("\n"));
});

// ---------- negative tests: everything that does not meet all conditions behaves exactly as today ----------
const same = (name: string, prev: string, cont: string, ocr: string | null) => t("unchanged: " + name, () => {
  const rOld: Rep = [], rNew: Rep = [];
  const a = run(mOld, twoPages(prev, cont, ocr), rOld), b = run(mNew, twoPages(prev, cont, ocr), rNew);
  assert.equal(JSON.stringify(b), JSON.stringify(a)); assert.deepEqual(rNew, rOld);
  assert.ok(!rNew.some(([, m]) => m.startsWith("seam stitch (case B fragment)")));
});
same("the OCR first line starts with a capital letter", P3, P4, "Content delivered to healthcare professionals\n" + REST.slice(0, 60));
same("the OCR first line is over 80 characters", P3, P4, "content delivered to healthcare professionals and a great many other words that go on and on\n" + REST.slice(0, 60));
same("the OCR first line has 11 words (under 80 characters)", P3, P4, "one two three four five six seven eight nine ten eleven\n" + REST.slice(0, 60));
same("the OCR first line has a digit or a symbol", P3, P4, "content delivered to 2 healthcare professionals\n" + REST.slice(0, 60));
same("the previous last line ends with a period", P3 + ".", P4.replace(P3, P3 + "."), OCR4);
same("the previous last line ends with a colon", P3 + ":", P4.replace(P3, P3 + ":"), OCR4);
same("the previous last line ends with a semicolon", P3 + ";", P4.replace(P3, P3 + ";"), OCR4);
same("the previous last line is under 20 characters (the repeated line is an earlier line)", P3 + "\nshort tail", P4, OCR4);
same("the fragment is already inside the first 200 characters of the continuation text", P3, P3 + "\n" + FRAG + " " + REST, OCR4);
same("no OCR text for the page (vision routed)", P3, P4, null);
t("unchanged: case A (partial then full) is not touched even with a lowercase OCR first line", () => {
  const prev = "Designed and delivered curriculum across three instructional tracks Microsoft Office, WordPress, and foundational computer skills and administered annual certification testing for all three.\nAchieved certification pass rates above 90% every year, improving year over year to a high";
  const cont = "Achieved certification pass rates above 90% every year, improving year over year to a high of 97% in 2024-2025.\nBuilt a rules-based restroom pass system.";
  const ocr = "of 97% in 2024-2025.\nBuilt a rules-based restroom pass system";
  const rOld: Rep = [], rNew: Rep = [];
  assert.equal(JSON.stringify(run(mNew, twoPages(prev, cont, ocr), rNew)), JSON.stringify(run(mOld, twoPages(prev, cont, ocr), rOld))); assert.deepEqual(rNew, rOld);
});
t("the default caps of Fix D are unchanged for every other caller: a 45 character fragment is still refused without the options, accepted with them", () => {
  const s = mNew.stitchSeamFragment as (p: string, c: string, o: string, opts?: any) => any;
  assert.equal(s(P3, REST, OCR4), null);
  assert.equal(s(P3, REST, OCR4, { maxChars: 80, maxWords: 10 }).text, P3 + " " + FRAG + "\n" + REST);
  assert.equal(s(P3, REST, "the sixth fragment has six words\nx").fragment, "the sixth fragment has six words");
  assert.equal(s(P3, REST, "this one has seven words in it ok\nx"), null, "7 words refused by default");
  assert.equal(JSON.stringify(mOld.stitchSeamFragment(P3, REST, OCR4)), JSON.stringify(s(P3, REST, OCR4)));
});

// ---------- fail open, older callers, combination ----------
t("fail open: the report function throws on the new log call: case B's text stays and the error line is reported", () => {
  const rep: Rep = [];
  const out = mNew.mergeExtractions(twoPages(P3, P4, OCR4), (lvl: string, msg: string) => { if (lvl === "log" && msg.startsWith("seam stitch (case B fragment)")) throw new Error("forced"); rep.push([lvl, msg]); });
  assert.equal(textOf(out), P3 + "\n\n" + REST);
  assert.deepEqual(rep.map((r) => r[1]), ["seam repeat - page 4: case B, first 40 chars: Design and delivery of an editorial and ", "seam stitch (case B fragment) FAILED, joining as before: Error: forced"]);
});
t("without a report function (older callers, no seam rules at all) the merge is exactly the deployed merge's", () => {
  const a = mOld.mergeExtractions(twoPages(P3, P4, OCR4)), b = mNew.mergeExtractions(twoPages(P3, P4, OCR4));
  assert.equal(JSON.stringify(b), JSON.stringify(a)); assert.equal(textOf(b), P3 + "\n\n" + P4);
});
t("case B with nothing after the repeated line: the fragment is appended to the previous last line", () => {
  const out = run(mNew, twoPages(P3, P3, FRAG + "\nx"));
  assert.equal(textOf(out), P3 + " " + FRAG);
});
t("combination: the case B stitch at the 3-4 seam and a leading freeform block moved at the 4-5 seam (AP9AA/AP9AD) in one document", () => {
  const BLOCK = "Kept the beta books in order for four years running.";
  const pages = [
    ...twoPages(P3, P4, OCR4),
    { pageNumber: 5, ocrText: BLOCK, sections: [sec("", "unknown", true)], extraction: emptyEx({ freeform: [{ section_type: "needs_review", heading: "", content: BLOCK, position: 0 }] }) },
  ];
  pages[1].sections = [sec("", "work_history", true), sec("FAME Information Systems, Director (Oct 1996-Nov 1998)", "work_history")];
  pages[1].extraction.work_history.push(row("FAME Information Systems", "Director, Data Product Development", "Delivery of a relational query interface", { position: 1, start_date: "1996-10", end_date: "1998-11" }));
  const rep: Rep = [];
  const nw = run(mNew, pages, rep);
  assert.equal(textOf(nw), P3 + " " + FRAG + "\n" + REST);
  assert.ok(rep.some(([, m]) => m.startsWith("seam stitch (case B fragment) - page 4")));
  assert.ok(textOf(nw, "FAME Information Systems").includes(BLOCK), "the page 5 leading block is moved onto the last job of page 4 as before");
});

let failed = 0;
for (const [name, fn] of tests) {
  try { await fn(); console.log("  ok   " + name); } catch (e: any) { failed++; console.log("  FAIL " + name + "\n       " + String(e?.message ?? e).split("\n").slice(0, 8).join("\n       ")); }
}
console.log(`\n${tests.length - failed} passed, ${failed} failed`);
if (failed) process.exit(1);
