// node --experimental-strip-types tools/resume/make-pdf-bullet-pdfs.mjs <outDir> [--hyphen]     (prompt EA, October 28, 2026; no network, no model call, no browser)
// Makes the PDFs of the invented resume (tools/resume/fixtures/ea-bullet-resume.json): control (the writer of commit 3fd8fca, before this change) and new (the writer of the working tree, with the bullet mark U+2022).
// With --hyphen it also makes new-hyphen: the same writer with the mark changed to a plain hyphen (code 0x2D), by changing the one constant pdfBullet() in memory (the file is not edited). It is the one fallback of the EA
// prompt, only to be used if the round trip fails for the bullet. Prints how many description paragraphs wrap at a different place than the control.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { loadWriter, loadFixture, makePdf, CONTROL_REV } from "./pdf-bullets-lib.mjs";

const out = path.resolve(process.argv[2] || ".");
const hyphen = process.argv.includes("--hyphen");
fs.mkdirSync(out, { recursive: true });
const fx = loadFixture();
const W = loadWriter(null), C = loadWriter(CONTROL_REV);
const sha = (b) => crypto.createHash("sha256").update(b).digest("hex");
const res = {};
const write = (name, bytes) => { fs.writeFileSync(path.join(out, name), bytes); return { file: name, bytes: bytes.length, sha256: sha(bytes) }; };
res.control = write("Rowan-Testwell-Resume-Applitrust-control.pdf", makePdf(C, fx).bytes);
const N = makePdf(W, fx);
res.new = write("Rowan-Testwell-Resume-Applitrust-new-bullet.pdf", N.bytes);
if (hyphen) {
  const H = loadWriter(null);
  const orig = H.pdfBullet.bind(H);
  H.pdfBullet = () => Object.assign(orig(), { glyph: "-", code: "-" });
  res.hyphen = write("Rowan-Testwell-Resume-Applitrust-new-hyphen.pdf", makePdf(H, fx).bytes);
}
// how many description paragraphs wrap at a different place than the control
let paragraphs = 0, changed = 0, controlLines = 0, newLines = 0, movedBreaks = 0;
const breaksOf = (ls) => { const b = []; let n = 0; ls.forEach((s, i) => { n += s.split(" ").filter(Boolean).length; if (i < ls.length - 1) b.push(n); }); return b; };
const MARKRE = /^\s*(?:[\u{2022}\u{25CF}\u{25AA}\u{25E6}\u{B7}]\s*|[*\-\u{2013}\u{2014}]\s+)/u;   // \u{...} escapes: this file holds no dash character
for (const j of fx.delivered.work) for (const raw of j.description.split("\n")) {
  if (!raw) continue;
  paragraphs++;
  const c = C.wrapText(raw, 90), n = W.wrapBulletBlock(raw).map((l) => l.text);   // control: wrapText as the old writer wrapped it (the old writer drew the data line as it was)
  controlLines += c.length; newLines += n.length;
  const cb = breaksOf(c.map((s, i) => (i === 0 ? s.replace(MARKRE, "") : s))), nb = breaksOf(n);
  if (JSON.stringify(cb) !== JSON.stringify(nb)) changed++;
  movedBreaks += cb.filter((x) => !nb.includes(x)).length;
}
res.wrap = { descriptionParagraphs: paragraphs, wrappedDifferently: changed, controlDescriptionLines: controlLines, newDescriptionLines: newLines, controlBreaksNotInNew: movedBreaks, controlOutputLines: makePdf(C, fx).lines.length, newOutputLines: N.lines.length };
console.log(JSON.stringify(res, null, 2));
