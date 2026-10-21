// node --experimental-strip-types tools/resume/build-aw-heading-proofs.mjs [outDir]
// AW (October 20, 2026): writes one "heading proof" PDF and one page-1 text file for each of the six test resumes, using the SAME code the page uses (cut out of candidate.html) and the stored
// heading lines and work rows in tools/resume/fixtures (read from the live project, read only). No database write, no browser. Each PDF starts with a line saying it is a proof: only the job
// headings are the real thing; the body under each heading is the first 150 characters of the stored job text, and the other sections are left out.
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { findPrintedHeading } from "../../supabase/functions/_shared/resume-heading-line.ts";

const out = process.argv[2] || "C:/Users/jpiro/OneDrive/Desktop/Testing resumes/AWTest10-20";
const MUPDF = process.env.ATID_MUPDF || "C:/Users/jpiro/AppData/Local/Temp/ocr-repro/node_modules/mupdf/dist/mupdf.js";
const mupdf = await import(pathToFileURL(MUPDF).href);
const repo = new URL("../../", import.meta.url);
const NOW = fs.readFileSync(new URL("candidate.html", repo), "utf8").replace(/\r\n/g, "\n");
function method(src, name) { let s = src.indexOf("\n  " + name + "("); if (s < 0) s = src.indexOf("\n  async " + name + "("); return src.slice(s + 1, src.indexOf("\n  }\n", s) + 4); }
const P = new Function("return class P { " + ["buildResumeLines", "buildAtsPdfBytes", "sanitizeAts", "wrapText", "groupByLiteralHeading", "czPartialLabel", "czRange", "czWorkLabel", "czEduLabel", "czCertLabel", "workHeadingLines", "wrapHeadingRuns", "czDatesText"].map((n) => method(NOW, n)).join("\n") + " }")();
const page = new P();
const FX = JSON.parse(fs.readFileSync(new URL("fixtures/job-heading-six.json", import.meta.url), "utf8"));
const DESC = JSON.parse(fs.readFileSync(new URL("fixtures/job-heading-desc.json", import.meta.url), "utf8"));
const FILES = { PironeSimple: "PironeSimpleGenAW", PironeBeast: "PironeBeastGenAW", PironeBeastHybrid: "PironeBeastHybridGenAW", Aclark: "AclarkGenAW", Donofrio: "DonofrioGenAW", LisaTom: "LisaTomGenAW" };
fs.mkdirSync(out, { recursive: true });
const written = [];
for (const [name, d] of Object.entries(FX.docs)) {
  const used = new Set(), printed = {};
  for (const r of [...d.rows].sort((a, b) => a.position - b.position)) { const f = findPrintedHeading(d.ocr.join("\n"), r, used); if (f) printed[r.id] = f; }
  const work = d.rows.map((r) => ({ heading: "PROFESSIONAL EXPERIENCE", ...r, description: (DESC[name][r.id] || "").replace(/ \/ /g, "\n").replace(/\n\n+/g, "\n"), ...(printed[r.id] ? { printed_heading: printed[r.id] } : {}) }));
  const R = { candidate: { name: `HEADING PROOF: ${name}` }, header: { mode: "account", location: "Built from stored work rows; text under each heading shortened; other sections left out" }, work };
  const pdf = page.buildAtsPdfBytes(page.buildResumeLines(R, R));
  const base = path.join(out, FILES[name]);
  fs.writeFileSync(base + ".pdf", Buffer.from(pdf, "latin1"));
  const doc = mupdf.Document.openDocument(Uint8Array.from(Buffer.from(pdf, "latin1")), "application/pdf");
  const lines = []; doc.loadPage(0).toStructuredText("preserve-whitespace").walk({ beginLine() { lines.push(""); }, onChar(c) { lines[lines.length - 1] += c; } });
  fs.writeFileSync(base + ".txt", lines.join("\n") + "\n", "utf8");
  written.push(`${FILES[name]}.pdf (${doc.countPages()} page${doc.countPages() === 1 ? "" : "s"}), ${FILES[name]}.txt (${lines.length} lines)`);
}
console.log(written.join("\n"));
