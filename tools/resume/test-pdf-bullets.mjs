// node --experimental-strip-types tools/resume/test-pdf-bullets.mjs   (no network, no model call, no live database, no browser)
// EA (October 28, 2026): the generated resume PDF puts a real bullet mark in front of every line of a job's description block, as its own piece of text at the left margin, with the words indented 14 points and wrapped lines
// under the words. This test builds the PDF of an INVENTED resume (tools/resume/fixtures/ea-bullet-resume.json) with the writer of the working tree and with the writer of commit 3fd8fca (the control, the code before this change), both
// cut out of candidate.html as written, and checks the structure. The extraction checks with PyMuPDF and pdftotext are in check-pdf-bullets.py; the round trip is described in the EA report.
import assert from "node:assert/strict";
import { loadWriter, loadFixture, makePdf, CONTROL_REV } from "./pdf-bullets-lib.mjs";

const fx = loadFixture();
const W = loadWriter(process.env.EA_WRITER_REV || null), C = loadWriter(CONTROL_REV);   // EA_WRITER_REV=3fd8fca runs this test against the OLD writer: it must fail (proof that the test can fail)
const N = makePdf(W, fx), O = makePdf(C, fx);
const bullets = N.lines.filter((l) => l.bullet);
const firsts = N.lines.filter((l) => l.bullet === "first");
let pass = 0, fail = 0;
const t = (name, fn) => { try { fn(); pass++; console.log("PASS " + name); } catch (e) { fail++; console.log("FAIL " + name + "\n     " + String(e && e.message).split("\n")[0].slice(0, 300)); } };
const descLines = fx.delivered.work.flatMap((j) => j.description.split("\n")).filter((x) => x !== "");
const stripMark = (s) => s.replace(/^\s*(?:[\u{2022}\u{25CF}\u{25AA}\u{25E6}\u{B7}]\s*|[*\-\u{2013}\u{2014}]\s+)/u, "").trim();   // \u{...} escapes: this file holds no dash character
const words = (s) => s.split(/\s+/).filter(Boolean);

t("one mark per description line: the number of bullet first lines equals the number of description lines in the data (" + descLines.length + ")", () => assert.equal(firsts.length, descLines.length));
t("each description line gives one first line followed only by its own continuation lines, and its words are the data's words, in order (marks the data had are not words)", () => {
  let i = 0;
  for (const d of descLines) {
    const need = words(sanitize(stripMark(d)));
    const got = [];
    while (i < N.lines.length && !(N.lines[i].bullet === "first")) i++;
    assert.ok(i < N.lines.length, "ran out of bullet lines");
    got.push(...words(N.lines[i].text)); i++;
    while (i < N.lines.length && N.lines[i].bullet === "cont") { got.push(...words(N.lines[i].text)); i++; }
    assert.deepEqual(got, need, d.slice(0, 40));
  }
});
function sanitize(s) { return W.sanitizeAts(s); }

t("no line other than a description line has a bullet flag: name, contact, headings, job headings, summary, skills, education, certifications and interests are plain", () => {
  const keep = N.lines.filter((l) => !l.bullet);
  assert.ok(keep.every((l) => !("bullet" in l)));
  const bad = ["Rowan Testwell", "Professional Summary", "Professional Experience", "Skills", "Education", "Certifications", "Interests", "Program Coordinator | ", "Operations Analyst | ", "Office Assistant | ", "Program coordinator with eleven"];
  for (const b of bad) { const line = N.lines.find((l) => l.text.startsWith(b)); assert.ok(line && !line.bullet, "marked: " + b); }
});
t("every line that is not a description line is the same as in the control (text, bold, runs): only description lines changed", () => {
  const strip = (ls) => ls.filter((l) => !l.bullet).map((l) => JSON.stringify({ t: l.text, b: l.bold, r: l.runs || null }));
  // blank lines between blocks are kept; the control's description lines are removed by position (they sit between a job heading and the blank line after it)
  const ctl = []; let inDesc = false;
  O.lines.forEach((l) => { if (l.runs) { ctl.push(l); inDesc = true; return; } if (inDesc && l.text === "") { inDesc = false; ctl.push(l); return; } if (!inDesc) ctl.push(l); });
  assert.deepEqual(strip(N.lines), strip(ctl));
});
t("a description line in the data that starts with a bullet, a hyphen, an en dash, an em dash or a star is drawn with ONE mark: no line text starts with a mark character, and no mark character is left inside job 3's lines", () => {
  const job3 = N.lines.slice(N.lines.findIndex((l) => l.text.startsWith("Office Assistant")) + 1).filter((l) => l.bullet).slice(0, 10);
  assert.ok(job3.length >= 8);
  for (const l of N.lines) assert.ok(!/^[\u{2022}\u{25CF}\u{25AA}\u{25E6}\u{B7}*\u{2013}\u{2014}-]\s/u.test(l.text), "a line starts with a mark: " + l.text.slice(0, 30));
  assert.ok(job3.every((l) => !/^[-*]/.test(l.text)));
  assert.equal(firsts.filter((l) => /^(Greeted|Scheduled|Filed|Ordered|Answered)/.test(l.text)).length, 5);
});
t("the PDF has exactly one mark piece per description line and no mark inside any text piece: the count of (\\267) Tj equals the number of bullet first lines; no (\\267...) text", () => {
  const marks = (N.text.match(/\(\\267\) Tj/g) || []).length;
  assert.ok(firsts.length > 0, "no bullet lines at all");
  assert.equal(marks, firsts.length);
  assert.equal((N.text.match(/\\267/g) || []).length, firsts.length, "the code 267 is used somewhere else");
  assert.equal((O.text.match(/\\267/g) || []).length, 0, "the control has no mark");
});
t("layout: the mark is at x = 54 (the left margin); the first line's text piece is drawn at 64.942 (54 + 14 less one space) so its first letter is at 68; wrapped lines at 68; all on the baseline of their line", () => {
  const re = /1 0 0 1 54 ([\d.]+) Tm\n\(\\267\) Tj\n1 0 0 1 64\.942 \1 Tm\n\( [^\n]*\) Tj\n/g;
  assert.ok(firsts.length > 0, "no bullet lines at all");
  assert.equal((N.text.match(re) || []).length, firsts.length);
  const conts = bullets.length - firsts.length;
  assert.equal((N.text.match(/1 0 0 1 68 [\d.]+ Tm\n\([^\n]*\) Tj\n/g) || []).length, conts);
});
t("the fonts, size and spacing are the control's: both PDFs use Helvetica and Helvetica-Bold with no /Encoding, size 11, and the same page size; the font objects are byte for byte the same", () => {
  for (const p of [N.text, O.text]) { assert.ok(p.includes("/BaseFont /Helvetica >>") && p.includes("/BaseFont /Helvetica-Bold >>")); assert.ok(!p.includes("/Encoding")); assert.ok(p.includes("/MediaBox [0 0 612 792]")); assert.ok(!/ \d+ Tf/.test(p) || p.includes("11 Tf")); }
  const fonts = (p) => p.match(/\d+ 0 obj\n<< \/Type \/Font[^\n]*\n/g).join("");
  assert.equal(fonts(N.text), fonts(O.text));
  assert.ok(!/\/F[12] (?!11 )\d+ Tf/.test(N.text));
  const ys = [...N.text.matchAll(/ Tm\n/g)].length; assert.ok(ys > 0);
});
t("a mark is never alone: in every page the mark piece is followed at once by a text piece on the same baseline, and a page never ends with a lone mark", () => {
  const pages = N.text.split(/\/Type \/Page /).slice(1);
  assert.ok(pages.length >= 1 && firsts.length > 0);
  for (const re of N.text.matchAll(/\(\\267\) Tj\n1 0 0 1 [\d.]+ ([\d.]+) Tm\n\( /g)) assert.ok(re[1]);
  assert.equal((N.text.match(/\(\\267\) Tj\n/g) || []).length, (N.text.match(/\(\\267\) Tj\n1 0 0 1 [\d.]+ [\d.]+ Tm\n\( /g) || []).length);
});
t("a page break in the middle of a long description: the lines of the block keep their marks and a page ends on a whole line (a synthetic resume with many description lines)", () => {
  const d = JSON.parse(JSON.stringify(fx));
  const many = []; for (let i = 0; i < 70; i++) many.push("Line number " + (i + 1) + " of a long description that is made up for this test and wraps once it is long enough to pass the limit of the line.");
  d.delivered.work[0].description = many.join("\n");
  const P = makePdf(W, d);
  const pages = P.text.split(/\/Type \/Page /).slice(1).length;
  assert.ok(pages >= 3, "pages: " + pages);
  assert.equal(P.lines.filter((l) => l.bullet === "first").length, 70 + descLines.length - fx.delivered.work[0].description.split("\n").length);
  const marks = (P.text.match(/\(\\267\) Tj\n1 0 0 1 [\d.]+ [\d.]+ Tm\n\( /g) || []).length;
  assert.equal(marks, (P.text.match(/\(\\267\) Tj/g) || []).length);
  // the last bullet line of every page is a whole line: the page's last text piece follows a mark or is a continuation, never a mark alone
  P.text.split("endstream").slice(0, -1).forEach((s) => { const body = s.slice(s.lastIndexOf("BT")); assert.ok(!/\(\\267\) Tj\nET/.test(body), "a lone mark ends a page"); });
});
t("nothing runs past the right margin: every bullet line is at most 490 points wide (504 less the 14 point indent); every other line at most 504", () => {
  const wide = Math.max(...bullets.map((l) => W.helvWidth(l.text, false)));
  assert.ok(wide <= 490, "widest bullet line " + wide);
  for (const l of N.lines.filter((x) => !x.bullet && !x.runs)) assert.ok(W.helvWidth(l.text, !!l.bold) <= 504, l.text.slice(0, 30));
  console.log("     widest bullet line: " + wide.toFixed(2) + " points (limit 490); widest other line " + Math.max(...N.lines.filter((x) => !x.bullet && !x.runs).map((l) => W.helvWidth(l.text, !!l.bold))).toFixed(2) + " (limit 504)");
});
t("wide letters: a line made of capital W is wrapped narrower so it stays inside the margin", () => {
  const lines = W.wrapBulletBlock("WWWW ".repeat(30).trim());
  assert.ok(lines.length > 1);
  for (const l of lines) assert.ok(W.helvWidth(W.sanitizeAts(l.text), false) <= 490, l.text);
});
t("a blank line inside a description stays blank and gets no mark; a line that is only a mark is dropped; spaces only are dropped", () => {
  const r = W.wrapBulletBlock("First line.\n\n\u{2022}\n   \nSecond line.");
  assert.deepEqual(r.map((l) => [l.text, l.bullet || null]), [["First line.", "first"], ["", null], ["Second line.", "first"]]);
});
t("the mark is one constant: pdfBullet() gives the glyph U+2022, the code 267 octal, the indent 14 and the wrap width 87; the glyph is the bullet", () => {
  const B = W.pdfBullet();
  assert.deepEqual([B.glyph, B.code, B.indent, B.wrapChars], ["\u{2022}", "\\267", 14, 87]);
  assert.equal(B.glyph.codePointAt(0), 0x2022); assert.equal(parseInt("267", 8), 0xb7);
});
t("PDF structure: starts %PDF-1.4, ends %%EOF, the cross reference table points at the objects; the control's structure is the same", () => {
  for (const P of [N, O]) {
    assert.ok(P.text.startsWith("%PDF-1.4\n") && P.text.endsWith("%%EOF"));
    const sx = Number(P.text.match(/startxref\n(\d+)\n%%EOF$/)[1]);
    const offs = [...P.text.slice(sx).matchAll(/^(\d{10}) 00000 n $/gm)].map((x) => Number(x[1]));
    offs.forEach((off, i) => assert.ok(P.text.slice(off).startsWith((i + 1) + " 0 obj\n")));
  }
});
t("opts and other functions are unchanged: buildAtsPdfBytes with an ATID line still draws it; downloadFileName is as before", () => {
  const withId = W.buildAtsPdfBytes(N.lines, { atidLine: "ATID-TEST-0000-0000", atidMeta: "ATID-TEST-0000-0000" });
  assert.ok(withId.includes("(ATID-TEST-0000-0000) Tj") && withId.includes("/Keywords (ATID-TEST-0000-0000)"));
  const when = new Date(2026, 9, 28, 12);
  assert.equal(W.downloadFileName("pdf", "Rowan", "Testwell", when), C.downloadFileName("pdf", "Rowan", "Testwell", when));
});

console.log(pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
