// node tools/resume/test-employer-document.mjs   (no network, no model call, no live database)
// BA (October 21, 2026): the employer's comparison document and screen.
//   1. the notice on the comparison screen carries the professional-summary paragraph, word for word, and the document never prints a summary;
//   2. the employer document's job headings are generated like the candidate's PDF (printed heading as written, bold-title pipe heading as the fallback), and the PDF writer's page content
//      is the candidate writer's page content for the same lines;
//   3. the "No record exists" result's "Start another lookup" returns to the home screen (the other two buttons keep returning to the lookup form);
//   4. the server side (candidate-comparison-requests) attaches printed_heading to the work rows and adds nothing else.
// Each guard is shown to catch a planted defect (a changed copy of the page or function text held in memory; nothing on disk changes).
import assert from "node:assert/strict";
import fs from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { attachPrintedHeadings as attachFor } from "../../supabase/functions/_shared/resume-heading-line.ts";

const repo = new URL("../../", import.meta.url);
const rd = (f) => fs.readFileSync(new URL(f, repo), "utf8").replace(/\r\n/g, "\n");
const EMP = rd("employer.html"), CAND = rd("candidate.html"), CCR = rd("supabase/functions/candidate-comparison-requests/index.ts");
const FX = JSON.parse(fs.readFileSync(new URL("fixtures/job-heading-six.json", import.meta.url), "utf8"));
function method(src, name) { let s = src.indexOf("\n  " + name + "("); if (s < 0) s = src.indexOf("\n  async " + name + "("); if (s < 0) return ""; return src.slice(s + 1, src.indexOf("\n  }\n", s) + 4); }
const makeClass = (src, names) => new Function("return class P { " + names.map((n) => method(src, n)).filter(Boolean).join("\n") + " }")();
const SHARED = ["sanitizeAts", "wrapText", "czPartialLabel", "czRange", "czWorkLabel", "czEduLabel", "czCertLabel", "groupByLiteralHeading", "czDatesText", "workHeadingLines", "wrapHeadingRuns", "helvWidth"];
const EmpC = (src = EMP) => makeClass(src, [...SHARED, "buildComparisonLines", "buildComparisonPdfBytes"]);
const CandC = () => makeClass(CAND, [...SHARED, "buildResumeLines", "buildAtsPdfBytes"]);

const PARAGRAPH = "The professional summary (also called an executive summary or profile) is not included in this document. Candidates can write and change their own summaries at any time and may keep more than one version, so we cannot tell which one went with the resume you hold. Anything a candidate states about themselves in a summary is their own content and is not part of what is registered here.";
const EXISTING_NOTICE = "Every job, education entry and certification the candidate has submitted is shown below, with its current status. Job descriptions are not part of what is verified, so they are not shown. This report covers only these three categories — skills, summaries, and other resume content shown in the document below are the candidate's own stated content, not independently verified.";
const STYLE = 'style="font-size:12px;color:var(--color-neutral-400);line-height:1.6"';

// ---- data: Lisa shaped (one summary section, no customization) and the AW fixtures (real printed headings and the known fallback) ----
const SUMMARY = { source: "resume", heading: "PROFESSIONAL SUMMARY", content: "Strategic talent executive with 13 years of experience scaling venture-backed technology companies through modern people systems." };
const LISA = () => ({ available: true, candidate: { name: "Lisa Test" }, header: { mode: "account", location: "Austin, TX" }, contact: { email: { value: "lisa@example.test" } }, summary: SUMMARY,
  work: [{ id: "w1", position: 10, heading: "EXPERIENCE", employer: "Acme", title: "Director of Talent", location: "Austin, TX", start: "2015", end: "2020", description: "Led a team of five.\nShipped a thing.", printed_heading: ["Acme | Director of Talent | Austin, TX | 2015 - 2020"] },
         { id: "w2", position: 11, heading: "EXPERIENCE", employer: "Beta Co", title: "Recruiter", location: "Dallas, TX", start: "2012", end: "2015", description: "Hired people." }],
  education: [{ id: "e1", position: 20, heading: "EDUCATION", institution: "State U", degree: "BA", start: "2008", end: "2012" }], certifications: [], skills: { items: [{ text: "Sourcing" }] }, other_sections: [] });
function fixtureResume(name) {
  const d = FX.docs[name], rows = d.rows.map((r) => ({ ...r })), found = attachFor(rows, () => d.ocr.join("\n"));
  for (const r of rows) { const h = found.get(r.id); if (h && h.length) r.printed_heading = h; }
  return { available: true, candidate: { name: "Jane Doe" }, header: { mode: "account" }, contact: {}, summary: SUMMARY, work: rows.map((r) => ({ heading: "PROFESSIONAL EXPERIENCE", description: "Led a team (of five).\nShipped a thing.", ...r })), education: [], certifications: [], skills: { items: [] }, other_sections: [] };
}
const without = (lines, pred) => lines.filter((l) => !pred(l));
const summaryLine = (l) => /Strategic talent executive|PROFESSIONAL SUMMARY/.test(l.text || "");

const tests = [];
const t = (name, fn) => tests.push([name, fn]);

// ------------------------------------------------------------------ 1. the notice
const noticeOk = (html) => {
  const a = html.indexOf(`<div ${STYLE}>` + EXISTING_NOTICE + "</div>");
  if (a < 0) return "existing notice sentence changed or missing";
  const after = html.slice(a + `<div ${STYLE}>` + EXISTING_NOTICE + "</div>".length - 0);
  const want = "\n      <div " + STYLE + ">" + PARAGRAPH + "</div>\n";
  if (!html.slice(a).includes(`${EXISTING_NOTICE}</div>${want}`)) return "the paragraph is not directly after the existing notice, word for word, in the same style";
  return null;
};
t("the comparison screen notice: the existing notice is unchanged and the summary paragraph follows it directly, word for word, in the same style", () => {
  assert.equal(noticeOk(EMP), null);
  assert.equal([...EMP.matchAll(/professional summary \(also called an executive summary or profile\)/g)].length, 1, "the notice text is built in one place only");
  assert.equal(/—/.test(PARAGRAPH), false); assert.equal(/verified/i.test(PARAGRAPH), false);
});
t("control: the notice guard catches a missing paragraph, a changed word, the paragraph moved before the notice, and a changed existing sentence", () => {
  assert.match(noticeOk(EMP.replace(PARAGRAPH, "")), /not directly after/);
  assert.match(noticeOk(EMP.replace("we cannot tell which one", "we can tell which one")), /not directly after/);
  assert.match(noticeOk(EMP.replace(EXISTING_NOTICE + "</div>\n      <div " + STYLE + ">" + PARAGRAPH + "</div>", "<div " + STYLE + ">" + PARAGRAPH + "</div>\n      <div " + STYLE + ">" + EXISTING_NOTICE + "</div>")), /changed or missing|not directly after/);
  assert.match(noticeOk(EMP.replace("so they are not shown.", "so they are not displayed.")), /existing notice sentence changed/);
});
t("the downloaded comparison PDF does not carry the notice (the document is the resume only); the notice is on the screen only, in one place", () => {
  const P = new (EmpC())(); const lines = P.buildComparisonLines(LISA());
  assert.equal(lines.some((l) => /not included in this document|Verification coverage|independently verified/i.test(l.text || "")), false);
  assert.equal(/Verification coverage/.test(method(EMP, "buildComparisonLines")), false);
});

// ------------------------------------------------------------------ 1b. the summary is never printed
const printsSummary = (src, R) => new (EmpC(src))().buildComparisonLines(R).some(summaryLine);
t("the employer document NEVER prints the summary, whatever the data holds (Lisa shaped; sources resume, default, candidate_selected; with a heading)", () => {
  for (const s of [SUMMARY, { ...SUMMARY, source: "default" }, { ...SUMMARY, source: "candidate_selected", id: "x" }, { source: "none" }, null, undefined]) assert.equal(printsSummary(EMP, { ...LISA(), summary: s }), false, JSON.stringify(s));
  assert.equal(/R\.summary|S\.content/.test(method(EMP, "buildComparisonLines")), false);
  assert.match(method(EMP, "buildComparisonLines"), /John confirmed on October 21, 2026 that the omission STAYS/);
});
t("control: restoring the four removed lines (planted in a copy of the page) is caught: the summary prints", () => {
  const planted = EMP.replace("    push('');\n\n    const other = (kind) => {", "    const S = R.summary || {};\n    if (S.content) {\n      if (S.heading) push(S.heading, true);\n      this.wrapText(S.content, 90).forEach(w => push(w));\n    }\n    push('');\n\n    const other = (kind) => {");
  assert.notEqual(planted, EMP);
  assert.equal(printsSummary(planted, LISA()), true);
});

// ------------------------------------------------------------------ 2. job headings and format match the candidate's PDF
const jobHeadingLines = (lines) => lines; // the whole list is compared; the candidate side only differs by the summary block
function sideBySide(R) {
  const e = new (EmpC())().buildComparisonLines(R), c = new (CandC())().buildResumeLines(R, R);
  return { e, c, cNoSummary: without(c, (l, i) => false) };
}
const candidateWithoutSummary = (c) => { const i = c.findIndex((l) => l.text === SUMMARY.heading); if (i < 0) return c; let j = i + 1; while (j < c.length && c[j].text !== "") j++; return [...c.slice(0, i), ...c.slice(j)]; };
t("job headings: for the printed-heading case, the fallback case and a job with no printed heading, the employer document's lines equal the candidate PDF's lines (the summary block aside)", () => {
  const e = new (EmpC())(), c = new (CandC())();
  for (const [label, R] of [["Lisa shaped (one printed, one no printed heading)", LISA()], ["PironeSimple (printed headings, includes the Desktop Publishing Manager fallback)", fixtureResume("PironeSimple")], ["Aclark", fixtureResume("Aclark")], ["Donofrio", fixtureResume("Donofrio")], ["LisaTom", fixtureResume("LisaTom")], ["PironeBeast", fixtureResume("PironeBeast")]]) {
    const el = e.buildComparisonLines(R), cl = candidateWithoutSummary(c.buildResumeLines(R, R));
    assert.deepEqual(el, cl, label);
  }
});
t("job headings: the printed heading is used as written; the fallback is the pipe heading with the title in bold; the Desktop Publishing Manager case really is a fallback in the fixture", () => {
  const lisa = new (EmpC())().buildComparisonLines(LISA());
  assert.ok(lisa.some((l) => l.text === "Acme | Director of Talent | Austin, TX | 2015 - 2020" && !l.bold && !l.runs), "printed heading, as written");
  const fb = lisa.find((l) => Array.isArray(l.runs)); assert.ok(fb, "fallback line has runs"); assert.deepEqual(fb.runs, [{ text: "Recruiter", bold: true }, { text: " | Beta Co | Dallas, TX | 2012-2015", bold: false }]);
  const R = fixtureResume("PironeSimple"); const dpm = R.work.find((w) => w.title === "Desktop Publishing Manager");
  assert.ok(dpm && !dpm.printed_heading, "Desktop Publishing Manager has no printed heading in the fixture (the known fallback)");
  const lines = new (EmpC())().buildComparisonLines(R); assert.ok(lines.some((l) => l.runs && l.runs[0].text === "Desktop Publishing Manager"));
  assert.equal(lines.some((l) => / at /.test(l.text || "") && /Desktop Publishing Manager at/.test(l.text)), false, "the old 'Title at Company' label is gone");
});
t("employer only items are kept: the gated ATID line is drawn only for a well-formed ATID; education, skills and the header are as before; the status labels are not in the document", () => {
  const e = new (EmpC())(); const base = e.buildComparisonLines(LISA());
  const withAtid = e.buildComparisonLines({ ...LISA(), atid: "ATID-7K3M-Q9XP-2WD2" });
  assert.equal(withAtid.length, base.length + 1); assert.ok(withAtid.some((l) => l.text === "Applitrust ID: ATID-7K3M-Q9XP-2WD2"));
  assert.equal(base.some((l) => /Applitrust ID/.test(l.text)), false);
  assert.ok(base.some((l) => l.text === "BA, State U (2008-2012)") || base.some((l) => /State U/.test(l.text)));
  assert.equal(/\.verification\b/.test(method(EMP, "buildComparisonLines")), false, "never reads the verification object");
});
t("control: a planted employer builder that still builds the old 'Title at Company' label is caught by the side by side check", () => {
  const planted = EMP.replace("if (g.kind === 'experience') this.workHeadingLines(b.src).forEach(l => lines.push(l));\n          else this.wrapText(b.label, 90).forEach(w => push(w));", "this.wrapText(b.label, 90).forEach(w => push(w));");
  assert.notEqual(planted, EMP);
  const el = new (EmpC(planted))().buildComparisonLines(LISA()), cl = candidateWithoutSummary(new (CandC())().buildResumeLines(LISA(), LISA()));
  assert.notDeepEqual(el, cl);
});
// the PDF writer: the page content stream of the employer PDF equals the candidate writer's for the same lines
const streams = (pdf) => [...pdf.matchAll(/stream\n([\s\S]*?)\nendstream|stream\n([\s\S]*?)endstream/g)].map((m) => (m[1] ?? m[2]).replace(/\n$/, ""));
t("PDF writer: for the same lines (headings with bold runs, long documents over several pages) the employer PDF's page content is the candidate writer's page content, byte for byte", () => {
  const E = new (EmpC())(), C = new (CandC())();
  for (const R of [LISA(), fixtureResume("PironeSimple"), fixtureResume("Donofrio")]) {
    const lines = E.buildComparisonLines(R); for (let i = 0; i < 3; i++) lines.push(...E.buildComparisonLines(R));   // several pages
    const a = streams(E.buildComparisonPdfBytes(lines)), b = streams(C.buildAtsPdfBytes(lines));
    assert.ok(a.length >= 2 && a.length === b.length, "pages " + a.length + " vs " + b.length);
    assert.deepEqual(a, b);
  }
});
t("control: a planted 10 pt writer (the old size) or a writer with no runs support is caught by the content comparison", () => {
  const lines = new (EmpC())().buildComparisonLines(LISA()); const C = new (CandC())();
  const planted10 = EMP.replace("fontSize = 11, leading = 15;", "fontSize = 10, leading = 14;");
  assert.notEqual(planted10, EMP); assert.notDeepEqual(streams(new (EmpC(planted10))().buildComparisonPdfBytes(lines)), streams(C.buildAtsPdfBytes(lines)));
  const noRuns = EMP.replace("if (Array.isArray(ln.runs) && ln.runs.length) {", "if (false) {");
  assert.notEqual(noRuns, EMP); assert.notDeepEqual(streams(new (EmpC(noRuns))().buildComparisonPdfBytes(lines)), streams(C.buildAtsPdfBytes(lines)));
});

// ------------------------------------------------------------------ 3. the buttons
function buttonHandler(src, name) {
  const m = new RegExp("\\n      " + name + ": \\(e\\) => \\{([\\s\\S]*?)\\n      \\},").exec(src);
  assert.ok(m, name + " handler found");
  const calls = []; const ctx = { clearTokenFromUrl: () => calls.push("clearToken"), setState: (s) => calls.push(["setState", s]), blank: () => ({ screen: "lookup", candNameInput: "" }) };
  new Function("e", m[1]).call(ctx, { preventDefault: () => calls.push("preventDefault") });
  return calls;
}
const buttonsOf = (src) => [...src.matchAll(/sc-camel-on-click="\{\{ (\w+) \}\}"[^>]*>Start another lookup</g)].map((m) => m[1]);
t("Start another lookup: the 'No record exists' result goes to the home screen; the other two (the found result's link and the guest 'request sent' result) still return to the lookup form", () => {
  assert.deepEqual(buttonsOf(EMP), ["startOverHome", "startOver", "startOver"]);
  const noMatch = EMP.slice(EMP.indexOf('<sc-if value="{{ isNoMatch }}"'), EMP.indexOf('<sc-if value="{{ isNoMatch }}"') + 900);
  assert.match(noMatch, /No record exists for the credentials supplied\.[\s\S]*startOverHome[\s\S]*Start another lookup/);
  const home = buttonHandler(EMP, "startOverHome"); assert.equal(home.find((c) => Array.isArray(c))[1].screen, "landing"); assert.ok(home.includes("clearToken") && home.includes("preventDefault"));
  const old = buttonHandler(EMP, "startOver"); assert.equal(old.find((c) => Array.isArray(c))[1].screen, "lookup");
  assert.match(EMP, /isLanding: s\.screen === 'landing'/);
});
t("control: a planted page whose No record button still uses startOver, or whose home handler returns to the lookup form, is caught", () => {
  const p1 = EMP.replace('sc-camel-on-click="{{ startOverHome }}">Start another lookup', 'sc-camel-on-click="{{ startOver }}">Start another lookup');
  assert.notDeepEqual(buttonsOf(p1), ["startOverHome", "startOver", "startOver"]);
  const p2 = EMP.replace("this.setState(Object.assign(this.blank(), { screen: 'landing' }));\n      },\n      abandonConfirmation", "this.setState(this.blank());\n      },\n      abandonConfirmation");
  assert.notEqual(p2, EMP); assert.equal(buttonHandler(p2, "startOverHome").find((c) => Array.isArray(c))[1].screen, "lookup");
});

// ------------------------------------------------------------------ 4. the server side
const ATTACH_SRC = (() => { const a = CCR.indexOf("async function attachPrintedHeadings"), b = CCR.indexOf("\nconst esc = ", a); return stripTypeScriptTypes(CCR.slice(a, b)); })();
function runAttach(src, resume, tables, throwOn) {
  const rows = async (path) => { if (throwOn && path.startsWith(throwOn)) throw new Error("db"); const t = path.split("?")[0]; return tables[t] || []; };
  return new Function("rows", "UUID", "attachPrintedHeadingsFor", "return (" + src.replace(/^async function attachPrintedHeadings/, "async function") + ")")(rows, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, attachFor)(resume);
}
const U = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
t("server: candidate-comparison-requests attaches printed_heading to each work row from the stored page text, reads only, adds only that field, and a failure leaves the rows untouched", async () => {
  const d = FX.docs.PironeSimple; const work = d.rows.map((r, i) => ({ ...r, id: U(i + 1) }));
  const tables = { work_history_items: work.map((w) => ({ id: w.id, resume_document_id: U(900) })), resume_documents: [{ id: U(900), ocr_raw_text: d.ocr.join("\n") }] };
  const before = JSON.parse(JSON.stringify(work)); const resume = { work };
  await runAttach(ATTACH_SRC, resume, tables);
  const attached = work.filter((w) => w.printed_heading); assert.ok(attached.length >= 6, "most rows get a printed heading, got " + attached.length);
  assert.ok(work.some((w) => !w.printed_heading), "a row with no recoverable heading gets none (the Desktop Publishing Manager case)");
  work.forEach((w, i) => { const { printed_heading, ...rest } = w; assert.deepEqual(rest, before[i]); assert.ok(printed_heading === undefined || (Array.isArray(printed_heading) && printed_heading.every((x) => typeof x === "string"))); });
  assert.equal(JSON.stringify(resume).includes(d.ocr[0]) && !work.some((w) => (w.printed_heading || []).some((x) => x.includes(d.ocr[0]))), false, "the page text itself is not returned"); // only heading lines can appear
  // failure: the caller's try/catch leaves the rows as they were
  const w2 = d.rows.map((r, i) => ({ ...r, id: U(i + 1) })); await assert.rejects(() => runAttach(ATTACH_SRC, { work: w2 }, tables, "resume_documents"));
  assert.equal(w2.some((w) => w.printed_heading), false);
  // no work rows / no document ids: nothing happens
  await runAttach(ATTACH_SRC, { work: [] }, tables); await runAttach(ATTACH_SRC, { work: [{ id: "not-a-uuid" }] }, tables); await runAttach(ATTACH_SRC, {}, tables);
  assert.match(CCR, /try \{ await attachPrintedHeadings\(resume\); \} catch \(_e\) \{ \/\* fallback heading \*\/ \}/);
  assert.ok(CCR.indexOf("await attachPrintedHeadings(resume)") > CCR.indexOf('rpc/assemble_customized_resume'), "after the assembler");
  assert.ok(CCR.indexOf("await attachPrintedHeadings(resume)") < CCR.indexOf("cand && cand.atid_employer_visible === true"), "before the ATID step, which is untouched");
});
t("server: it only SELECTs (work_history_items id and resume_document_id; resume_documents id and ocr_raw_text); no write, no other table, and no new field reaches the employer path", () => {
  const body = ATTACH_SRC;
  assert.deepEqual([...body.matchAll(/rows\(`([a-z_]+)\?/g)].map((m) => m[1]), ["work_history_items", "resume_documents"]);
  assert.deepEqual([...body.matchAll(/&select=([a-z_,]+)`/g)].map((m) => m[1]), ["id,resume_document_id", "id,ocr_raw_text"]);
  assert.equal(/method:|PATCH|POST|DELETE|rest\(/.test(body), false);
  assert.deepEqual([...body.matchAll(/w\.(\w+) = /g)].map((m) => m[1]), ["printed_heading"]);
});
t("control: a planted attach that returns the page text, or writes, or skips the failure guard, is caught", () => {
  const noGuard = CCR.replace("try { await attachPrintedHeadings(resume); } catch (_e) { /* fallback heading */ }", "await attachPrintedHeadings(resume);");
  assert.notEqual(noGuard, CCR); assert.equal(/try \{ await attachPrintedHeadings\(resume\); \} catch/.test(noGuard), false);
  const leaks = ATTACH_SRC.replace("w.printed_heading = h;", "w.printed_heading = h; w.ocr = docs[0].ocr_raw_text;");
  assert.notDeepEqual([...leaks.matchAll(/w\.(\w+) = /g)].map((m) => m[1]), ["printed_heading"]);
  // run the leaking copy: the extra field really does appear on the row, which the field-set check in the previous test would reject
  const d = FX.docs.PironeSimple; const work = d.rows.map((r, i) => ({ ...r, id: U(i + 1) }));
  return runAttach(leaks, { work }, { work_history_items: work.map((w) => ({ id: w.id, resume_document_id: U(900) })), resume_documents: [{ id: U(900), ocr_raw_text: d.ocr.join("\n") }] }).then(() => {
    assert.ok(work.some((w) => typeof w.ocr === "string" && w.ocr.length > 100), "the planted leak puts the page text on a row");
    assert.ok(Object.keys(work.find((w) => w.printed_heading)).includes("ocr"));
  });
});

let pass = 0, fail = 0;
for (const [name, fn] of tests) { try { await fn(); pass++; console.log("  ok   " + name); } catch (e) { fail++; console.log("  FAIL " + name + "\n       " + String(e?.message ?? e).split("\n").slice(0, 8).join("\n       ")); } }
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
