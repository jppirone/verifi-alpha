// pdf-bullets-lib.mjs - shared by test-pdf-bullets.mjs and make-pdf-bullet-pdfs.mjs (prompt EA, October 28, 2026). No network, no model call, no browser.
// loadWriter(source) loads the whole Component class of a candidate.html (the working tree file, or a git revision such as 3fd8fca) in Node with a stub base class and returns an object that has the class's
// methods but none of its page state (the constructor is never run). Only the PDF writer methods are used. makePdf(writer, data) gives { lines, text, bytes }.
import fs from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
export const CONTROL_REV = "3fd8fca";

export function readSource(rev) {
  const raw = rev ? execFileSync("git", ["show", rev + ":candidate.html"], { cwd: root, maxBuffer: 1 << 28 }).toString("utf8") : fs.readFileSync(path.join(root, "candidate.html"), "utf8");
  return raw.replace(/\r\n/g, "\n");
}
export function loadWriter(rev) {
  const html = readSource(rev);
  const m = html.match(/<script type="text\/x-dc" data-dc-script="">\n([\s\S]*?)\n<\/script>/);
  if (!m) throw new Error("the page script was not found");
  const Cls = new Function("class DCLogic {}\n" + m[1] + "\nreturn Component;")();
  return Object.create(Cls.prototype);
}
export function loadFixture(file = "ea-bullet-resume.json") {
  const text = fs.readFileSync(path.join(root, "tools", "resume", "fixtures", file), "utf8");
  return JSON.parse(text.replaceAll("{BULLET}", String.fromCodePoint(0x2022)).replaceAll("{ENDASH}", String.fromCodePoint(0x2013)).replaceAll("{EMDASH}", String.fromCodePoint(0x2014)));
}
export function makePdf(writer, fx) {
  const d = fx.delivered;
  const lines = writer.buildResumeLines(d, d);
  const text = writer.buildAtsPdfBytes(lines);
  return { lines, text, bytes: Buffer.from(text, "latin1") };
}
