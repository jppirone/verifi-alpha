// node --experimental-strip-types tools/resume/test-atid.ts   (no network, no model call, no database)
// ATID (October 19, 2026): the JS side of the shared test vector (tools/resume/atid-vectors.json; the SQL side is test-atid-sql.mjs), the strip rule for a
// line that is essentially just an ATID, and how rasterize-pdf-page wires it in (read from the source).
import assert from "node:assert/strict";
import fs from "node:fs";
import { atidCheckChar, atidValidCode, atidIsStored, atidDisplay, isAtidLine, stripATIDLines } from "../../supabase/functions/_shared/resume-atid.ts";

const V = JSON.parse(fs.readFileSync(new URL("./atid-vectors.json", import.meta.url), "utf8"));
const tests: Array<[string, () => void | Promise<void>]> = [];
const t = (name: string, fn: () => void | Promise<void>) => tests.push([name, fn]);

// ---------- the shared vector ----------
t("vector: the check character of every listed 11 character body", () => {
  for (const c of V.check_cases) assert.equal(atidCheckChar(c.body), c.check, c.body);
  console.log("      " + V.check_cases.length + " bodies");
});
t("vector: bodies that are not 11 characters of the alphabet have no check character (null)", () => {
  for (const b of V.check_null_bodies) assert.equal(atidCheckChar(b as string), null, String(b));
});
t("vector: every stored value is valid or invalid exactly as listed", () => {
  for (const c of V.stored_cases) assert.equal(atidIsStored(c.value), c.valid, `${JSON.stringify(c.value)} ${c.why ?? ""}`);
  console.log("      " + V.stored_cases.length + " values (" + V.stored_cases.filter((c: any) => c.valid).length + " valid)");
});
t("vector: the displayed form of every listed value", () => {
  for (const c of V.display_cases) assert.equal(atidDisplay(c.stored), c.display, c.stored);
});
t("every valid stored value also passes atidValidCode on its 12 characters, and the check character is the last one", () => {
  for (const c of V.stored_cases.filter((x: any) => x.valid)) {
    assert.ok(atidValidCode(c.value.slice(4)));
    assert.equal(atidCheckChar(c.value.slice(4, 15)), c.value[15]);
  }
});
t("property: 20000 random bodies; check character from the function makes a valid code, and every single-character change is caught", () => {
  const A = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
  let seed = 12345; const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  for (let n = 0; n < 20000; n++) {
    let body = ""; for (let i = 0; i < 11; i++) body += A[Math.floor(rnd() * 32)];
    const code = body + atidCheckChar(body);
    assert.ok(atidValidCode(code));
    const pos = Math.floor(rnd() * 12);
    let other = A[Math.floor(rnd() * 32)]; if (other === code[pos]) other = A[(A.indexOf(other) + 1) % 32];
    assert.equal(atidValidCode(code.slice(0, pos) + other + code.slice(pos + 1)), false, code + " at " + pos);
  }
});

// ---------- the strip rule ----------
const PAGE = ["Jane Doe", "Senior Analyst, Example Corp", "2019-2024", "Led a team of five.", "Built the reporting system"].join("\n");
t("clean ATID line at the end of the page is removed and nothing else changes", () => {
  const r = stripATIDLines(PAGE + "\nATID-7K3M-Q9XP-2WD2");
  assert.equal(r.text, PAGE); assert.equal(r.stripped, 1);
});
t("clean ATID line in the middle of a page is removed; the other lines keep their order", () => {
  const r = stripATIDLines("A line\nATID-7K3M-Q9XP-2WD2\nB line");
  assert.equal(r.text, "A line\nB line"); assert.equal(r.stripped, 1);
});
t("OCR-confused lines: I/L/1 and O/0, spaces or dashes for hyphens, trailing full stop", () => {
  for (const l of ["AT1D-7K3M-Q9XP-2WD2", "ATlD-7K3M-Q9XP-2WD2", "ATLD-7K3M-Q9XP-2WD2", "ATID 7K3M Q9XP 2WD2", "ATID–7K3M–Q9XP–2WD2", "ATID—7K3M—Q9XP—2WD2", "ATID - 7K3M - Q9XP - 2WD2", "ATID-7K3M-Q9XP-2WD2.", "  ATID-7K3M-Q9XP-2WD2  ", "ATID-0OO0-1IL1-2WD2", "ATID-7K3M-Q9XP-2WD2 |", "ATID7K3MQ9XP2WD2", "atid-7k3m-q9xp-2wd2".toUpperCase()]) {
    assert.equal(isAtidLine(l), true, JSON.stringify(l));
    assert.equal(stripATIDLines(PAGE + "\n" + l).text, PAGE, JSON.stringify(l));
  }
});
t("an ATID inside a sentence is left alone, byte for byte", () => {
  for (const l of ["My ATID is ATID-7K3M-Q9XP-2WD2 please write to me", "Reference ATID-7K3M-Q9XP-2WD2", "ATID-7K3M-Q9XP-2WD2 is my identifier on Applitrust", "Applicant ID: ATID-7K3M-Q9XP-2WD2", "See ATID-7K3M-Q9XP-2WD2."]) {
    assert.equal(isAtidLine(l), false, l);
    const text = PAGE + "\n" + l;
    const r = stripATIDLines(text);
    assert.equal(r.text, text); assert.equal(r.stripped, 0);
  }
});
t("ordinary lines that begin with ATID are left alone (no digit, no hyphen: three plain words; wrong group lengths; lower case words)", () => {
  for (const l of ["ATID Core Team Lead", "ATID Lead Role Team", "ATID-Core-Team", "ATID 7K3M Q9XP", "ATID 7K3M Q9XP 2WD2 5", "ATID", "ATID-", "Data ATID Analyst", "ATIDentify Core Team Lead"]) {
    assert.equal(isAtidLine(l), false, l);
  }
});
t("empty page, whitespace page and non-strings are returned unchanged", () => {
  assert.deepEqual(stripATIDLines(""), { text: "", stripped: 0 });
  assert.deepEqual(stripATIDLines("   \n  "), { text: "   \n  ", stripped: 0 });
  assert.deepEqual(stripATIDLines(undefined as unknown as string), { text: "", stripped: 0 });
  assert.deepEqual(stripATIDLines(null as unknown as string), { text: "", stripped: 0 });
});
t("a page that is only an ATID line becomes empty text", () => {
  assert.deepEqual(stripATIDLines("ATID-7K3M-Q9XP-2WD2"), { text: "", stripped: 1 });
});
t("a page with no ATID line comes back as the same string (no re-join)", () => {
  const r = stripATIDLines(PAGE); assert.ok(r.text === PAGE); assert.equal(r.stripped, 0);
});
t("the result never carries the removed value (only text and a count)", () => {
  const r = stripATIDLines(PAGE + "\nATID-7K3M-Q9XP-2WD2");
  assert.deepEqual(Object.keys(r).sort(), ["stripped", "text"]);
  assert.equal(JSON.stringify(r).includes("7K3M"), false);
});

// ---------- wiring in rasterize-pdf-page (read from the source) ----------
t("rasterize-pdf-page strips right after the OCR text is rebuilt, before the boundary call, fails open and logs the page only", () => {
  const src = fs.readFileSync(new URL("../../supabase/functions/rasterize-pdf-page/index.ts", import.meta.url), "utf8").replace(/\r\n/g, "\n");
  assert.ok(src.includes('import { stripATIDLines } from "../_shared/resume-atid.ts";'));
  const rec = src.indexOf("ocrText = reconstructByWordClustering(gap.words);");
  const strip = src.indexOf("stripATIDLines(ocrText)");
  const boundary = src.indexOf("runBoundaryDetectionHaiku(ocrText, trailingContext, modelCalls)", rec);
  assert.ok(rec > 0 && strip > rec && boundary > strip, "order: rebuild, strip, boundary");
  assert.ok(strip - rec < 400, "right after the rebuild");
  const block = src.slice(rec, boundary);
  assert.ok(/try \{[\s\S]*stripATIDLines\(ocrText\)[\s\S]*\} catch \(stripErr\)/.test(block), "inside try/catch");
  assert.ok(block.includes("ATID line stripped - page ${pageNum}`"), "log line");
  assert.ok(block.includes("ATID line strip FAILED, text unchanged"), "failure line");
  assert.equal(/ATID line stripped[^`]*\$\{(?!pageNum)/.test(block), false, "the stripped log line interpolates only the page number");
  assert.equal([...src.matchAll(/stripATIDLines\(/g)].length, 1, "one call site");
});
t("the strip rule never touches an account: the shared module imports nothing and reads no table", () => {
  const src = fs.readFileSync(new URL("../../supabase/functions/_shared/resume-atid.ts", import.meta.url), "utf8");
  assert.equal(/^\s*import\b/m.test(src), false);
  assert.equal(/fetch\(|supabase|\.rpc\(|candidate/i.test(src.replace(/\/\/.*$/gm, "")), false);
});

let failed = 0;
for (const [name, fn] of tests) {
  try { await fn(); console.log("  ok   " + name); } catch (e: any) { failed++; console.log("  FAIL " + name + "\n       " + String(e?.message ?? e).split("\n").slice(0, 6).join("\n       ")); }
}
console.log(`\n${tests.length - failed} passed, ${failed} failed`);
if (failed) process.exit(1);
