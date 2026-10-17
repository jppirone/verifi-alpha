// node --experimental-strip-types tools/resume/test-column-detection.ts   (no dependencies, no network, no model call)
// AP9U (Fix C): reconstructByWordClustering accepts a column boundary only when the right-hand block holds at least 2 separate text lines.
// The real function is cut out of BOTH of its product copies (rasterize-pdf-page and upload-resume), the master copy (6135d7c) is read with git show
// for the "before" side, and the test proves: the two copies are the same code; a single far-right word no longer splits the page; a real two column
// page still splits; the cases named in the task (exactly one right line, empty page, a real one line right-hand element such as a date or page number).
import assert from "node:assert/strict";
import fs from "node:fs";
import { execFileSync } from "node:child_process";
import { stripTypeScriptTypes } from "node:module";

const tests: Array<[string, () => void | Promise<void>]> = [];
const t = (name: string, fn: () => void | Promise<void>) => tests.push([name, fn]);

const RZ = "supabase/functions/rasterize-pdf-page/index.ts", UR = "supabase/functions/upload-resume/index.ts";
const read = (p: string) => fs.readFileSync(new URL("../../" + p, import.meta.url), "utf8").replace(/\r\n/g, "\n");
const gitShow = (rev: string, p: string) => execFileSync("git", ["show", `${rev}:${p}`], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }).replace(/\r\n/g, "\n");

function region(src: string): string {
  const a = src.indexOf("const MIN_COLUMN_GAP_PX = 60;");
  const fn = src.indexOf("function correctAiOcrMisreads");
  const b = src.indexOf("\n}\n", fn) + 3;
  assert.ok(a > 0 && fn > a && b > fn, "column region not found");
  return src.slice(a, b);
}
async function load(src: string): Promise<(w: any[]) => string> {
  const mod: any = await import("data:text/javascript;base64," + Buffer.from(stripTypeScriptTypes(region(src)) + "\nexport { reconstructByWordClustering };", "utf8").toString("base64"));
  return mod.reconstructByWordClustering;
}
const rzNew = await load(read(RZ)), urNew = await load(read(UR));
const rzOld = await load(gitShow("6135d7c", RZ)), urOld = await load(gitShow("6135d7c", UR));

// ---- drift: the two product copies are the same code (comments and spacing ignored) ----
const norm = (s: string) => s.replace(/\/\/[^\n]*/g, "").replace(/\s+/g, " ").trim();
function fnText(src: string, name: string): string {
  const a = src.indexOf(`function ${name}(`);
  assert.ok(a > 0, name + " not found");
  let depth = 0, i = src.indexOf("{", a);
  const start = i;
  for (; i < src.length; i++) { if (src[i] === "{") depth++; else if (src[i] === "}") { depth--; if (depth === 0) break; } }
  return src.slice(a, i + 1);
}
t("drift guard: the two copies of the column code are identical apart from comments and spacing (constants, line counter, reconstructByWordClustering, the AI correction)", () => {
  const rz = read(RZ), ur = read(UR);
  for (const name of ["countTextLines", "reconstructByWordClustering", "correctAiOcrMisreads"]) assert.equal(norm(fnText(rz, name)), norm(fnText(ur, name)), `${name} differs between rasterize-pdf-page and upload-resume`);
  for (const c of ["MIN_COLUMN_GAP_PX", "MIN_COLUMN_LINES"]) {
    const re = new RegExp(`const ${c} = [^;]+;`);
    assert.equal((rz.match(re) || [""])[0], (ur.match(re) || ["x"])[0], `${c} differs`);
  }
  assert.equal((read(RZ).match(/const MIN_COLUMN_LINES = (\d+);/) || [])[1], "2");
});

t("negative control: the drift guard really fails when one copy is changed", () => {
  const rz = read(RZ), ur = read(UR);
  const drifted = ur.replace("Math.abs(top - last) > 6", "Math.abs(top - last) > 7");
  assert.notEqual(drifted, ur, "control edit must change the text");
  assert.notEqual(norm(fnText(rz, "countTextLines")), norm(fnText(drifted, "countTextLines")));
  const drifted2 = ur.replace("const MIN_COLUMN_LINES = 2;", "const MIN_COLUMN_LINES = 1;");
  assert.notEqual((drifted2.match(/const MIN_COLUMN_LINES = [^;]+;/) || [""])[0], (rz.match(/const MIN_COLUMN_LINES = [^;]+;/) || [""])[0]);
});

// ---- word box helpers (left, top in pixels at 150 dpi, like tesseract-wasm) ----
type W = { text: string; rect: { left: number; top: number; right: number; bottom: number } };
const w = (text: string, left: number, top: number): W => ({ text, rect: { left, top, right: left + 10 * text.length, bottom: top + 18 } });
const line = (top: number, texts: string[], startLeft = 114, step = 90): W[] => texts.map((x, i) => w(x, startLeft + i * step, top));

// the Beast round trip page 4, as measured (RAN in AP9T): the last word of the longest line starts 106 px right of everything else
const beast4: W[] = [
  w("EDUCATION", 114, 127),
  ...[["Bachelor's", 114], ["Degree,", 228], ["Education,", 316], ["University", 430], ["of", 536], ["Delaware,", 563], ["Newark,", 672], ["DE", 763]].map(([x, l]) => w(x as string, l as number, 158)),
  ...[["Continuing", 114], ["Education:", 230], ["55+", 344], ["hours", 390], ["of", 453], ["AI", 478], ["&", 507], ["emerging", 528], ["technology", 629], ["certification", 747], ["coursework", 869]].map(([x, l]) => w(x as string, l as number, 220)),
  w("Coursiv,", 114, 252), w("2024-2025", 204, 252),
];

t("sparse page, one far-right word: single column now (the word stays on its line); before, it was detached after a blank line", () => {
  const want = "EDUCATION\nBachelor's Degree, Education, University of Delaware, Newark, DE\nContinuing Education: 55+ hours of AI & emerging technology certification coursework\nCoursiv, 2024-2025";
  for (const f of [rzNew, urNew]) assert.equal(f(beast4), want);
  for (const f of [rzOld, urOld]) assert.equal(f(beast4), "EDUCATION\nBachelor's Degree, Education, University of Delaware, Newark, DE\nContinuing Education: 55+ hours of AI & emerging technology certification\nCoursiv, 2024-2025\n\ncoursework");
});

// a real two column page: a narrow left column and a wide right column, several lines in each
const twoCol: W[] = [];
for (let i = 0; i < 6; i++) twoCol.push(...line(100 + i * 30, ["Skill" + i, "alpha"], 100, 60));
for (let i = 0; i < 6; i++) twoCol.push(...line(100 + i * 30, ["Right" + i, "text", "of", "column"], 520, 70));
t("a real two column page (6 lines in the right block): still two columns, identical to before", () => {
  for (const f of [rzNew, urNew]) { const out = f(twoCol); assert.ok(out.includes("\n\n"), "blank line between columns expected"); assert.equal(out, rzOld(twoCol)); }
  assert.equal(urOld(twoCol), rzOld(twoCol));
});

t("a right block with exactly 2 lines is a column (the minimum); exactly 1 line is not", () => {
  const base = [...line(100, ["Left", "one"]), ...line(130, ["Left", "two"]), ...line(160, ["Left", "three"])];
  const two = [...base, ...line(100, ["Side", "a"], 600), ...line(130, ["Side", "b"], 600)];
  const one = [...base, ...line(100, ["Side", "a"], 600)];
  for (const f of [rzNew, urNew]) {
    assert.ok(f(two).includes("\n\n"), "2 right lines: a column");
    assert.ok(!f(one).includes("\n\n"), "1 right line: not a column");
    assert.equal(f(one), "Left one Side a\nLeft two\nLeft three");
  }
  assert.equal(rzNew(two), rzOld(two));
  assert.ok(rzOld(one).includes("\n\n"), "before the fix the single line was split off");
});

t("a real one line right-hand element (a date or a page number far to the right) stays on its own line in the single column", () => {
  const page = [...line(100, ["Senior", "Analyst"]), ...line(130, ["Built", "the", "model"]), w("2019-2023", 900, 100), ...line(160, ["Managed", "the", "team"])];
  for (const f of [rzNew, urNew]) {
    const out = f(page);
    assert.ok(!out.includes("\n\n"));
    assert.ok(out.split("\n")[0].includes("Senior Analyst") && out.split("\n")[0].includes("2019-2023"), out);
  }
});

t("empty page and whitespace-only words: empty text, no error", () => {
  for (const f of [rzNew, urNew, rzOld, urOld]) { assert.equal(f([]), ""); assert.equal(f([w("  ", 10, 10)]), ""); }
});

t("pages with no gap above 60 px are untouched (identical to before)", () => {
  const page = [...line(100, ["a", "b", "c"], 100, 50), ...line(130, ["d", "e"], 100, 50)];
  for (const [n, o] of [[rzNew, rzOld], [urNew, urOld]] as const) assert.equal(n(page), o(page));
});

for (const [name, fn] of tests) { await fn(); console.log("ok  ", name); }
console.log(`\n${tests.length} tests passed`);
