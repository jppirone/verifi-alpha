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
// AP9X-1: the code of 286d5f4 (Fix C live, before the gutter rule) is the "before" side of the gutter cases
const rzPrev = await load(gitShow("286d5f4", RZ)), urPrev = await load(gitShow("286d5f4", UR));

// ---- drift: the two product copies are the same code (comments and spacing ignored) ----
const norm = (s: string) => s.replace(/\/\/[^\n]*/g, "").replace(/\s+/g, " ").trim();
function fnText(src: string, name: string): string {
  const a = src.indexOf(`function ${name}(`);
  assert.ok(a > 0, name + " not found");
  // skip the parameter list first (a parameter type can contain braces, e.g. columnGutter's Array<{ left: number; right: number }>)
  let p = src.indexOf("(", a), pd = 0;
  for (; p < src.length; p++) { if (src[p] === "(") pd++; else if (src[p] === ")") { pd--; if (pd === 0) break; } }
  let depth = 0, i = src.indexOf("{", p);
  const start = i;
  for (; i < src.length; i++) { if (src[i] === "{") depth++; else if (src[i] === "}") { depth--; if (depth === 0) break; } }
  return src.slice(a, i + 1);
}
t("drift guard: the two copies of the column code are identical apart from comments and spacing (constants, line counter, reconstructByWordClustering, the AI correction)", () => {
  const rz = read(RZ), ur = read(UR);
  for (const name of ["countTextLines", "columnGutter", "reconstructByWordClustering", "correctAiOcrMisreads"]) assert.equal(norm(fnText(rz, name)), norm(fnText(ur, name)), `${name} differs between rasterize-pdf-page and upload-resume`);
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
  const drifted3 = ur.replace("columnGutter(withLeft, gapBoundary) >= 0", "columnGutter(withLeft, gapBoundary) >= -5");
  assert.notEqual(drifted3, ur, "gutter control edit must change the text");
  assert.notEqual(norm(fnText(rz, "reconstructByWordClustering")), norm(fnText(drifted3, "reconstructByWordClustering")));
  const drifted4 = ur.replace("if (w.right > maxLeftBlockRight)", "if (w.right >= maxLeftBlockRight)");
  assert.notEqual(norm(fnText(rz, "columnGutter")), norm(fnText(drifted4, "columnGutter")));
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

// ---------------- AP9X-1: a negative gutter rejects the boundary ----------------
// word with explicit left and right edges (pixels at 150 dpi)
const wr = (text: string, left: number, right: number, top: number): W => ({ text, rect: { left, top, right, bottom: top + 18 } });

// (a) the generated PironeSimple page 4, as measured in AP9W: every line starts with a long word (left 113 to 115, right 186 to 304), the second words start at 195 or
// more, so the biggest jump in left edges is 80 px and 13 lines of words sit "right" of it, but the first words run past the start of the second words
const firstRights = [233, 188, 200, 207, 223, 215, 304, 186];
const simple4: W[] = [];
firstRights.forEach((r, i) => {
  const top = 95 + 31 * i;
  simple4.push(wr(["Redeployed", "needed", "Letraset,", "Managed", "thousands,", "execution,", "CERTIFICATIONS", "Google"][i], 114, r, top));
  if (i !== 6) ["existing", "staff", "capacity", "across"].forEach((x, k) => simple4.push(wr(x, r + 9 + k * 80, r + 9 + k * 80 + 70, top)));
});
t("AP9X-1 (a) the PironeSimple page 4 shape (first words overrun the second words, 13 right lines): one column now; before, it was split in two", () => {
  for (const f of [rzNew, urNew]) { const out = f(simple4); assert.ok(!out.includes("\n\n"), out); assert.ok(out.startsWith("Redeployed existing staff capacity across\nneeded "), out); assert.ok(out.includes("\nCERTIFICATIONS\n")); }
  for (const f of [rzPrev, urPrev]) assert.ok(f(simple4).includes("\n\n"), "the code of 286d5f4 splits this page");
});

// (b) a one word per line label column with a positive gutter: still two columns
const labelPage: W[] = [];
["Email", "Phone", "City", "Web"].forEach((label, i) => {
  const top = 100 + 31 * i;
  labelPage.push(wr(label, 100, 160, top));
  ["jane@example.com", "and", "more", "text"].forEach((x, k) => labelPage.push(wr(x, 300 + k * 90, 300 + k * 90 + 80, top)));
});
t("AP9X-1 (b) a one word per line label column with a positive gutter (140 px): two columns kept, identical to before", () => {
  for (const [n, o] of [[rzNew, rzPrev], [urNew, urPrev]] as const) { assert.ok(n(labelPage).includes("\n\n")); assert.equal(n(labelPage), o(labelPage)); }
});

// (c) a real two column page with multi-word lines (the one defined above): still two columns, identical to before
t("AP9X-1 (c) a real two column page with multi-word lines (positive gutter): two columns kept, identical to before", () => {
  for (const [n, o] of [[rzNew, rzPrev], [urNew, urPrev]] as const) { assert.ok(n(twoCol).includes("\n\n")); assert.equal(n(twoCol), o(twoCol)); }
});

// (d) the Fix C cases again, against the code of 286d5f4: a sparse far-right word (one line) is still rejected; exactly 2 lines is a column; exactly 1 is not
t("AP9X-1 (d) the Fix C cases again: far-right word rejected, exactly 2 right lines kept, exactly 1 rejected, all identical to the code of 286d5f4", () => {
  const base = [...line(100, ["Left", "one"]), ...line(130, ["Left", "two"]), ...line(160, ["Left", "three"])];
  const two = [...base, ...line(100, ["Side", "a"], 600), ...line(130, ["Side", "b"], 600)];
  const one = [...base, ...line(100, ["Side", "a"], 600)];
  for (const [n, o] of [[rzNew, rzPrev], [urNew, urPrev]] as const) {
    for (const page of [beast4, two, one, twoCol]) assert.equal(n(page), o(page));
    assert.ok(n(two).includes("\n\n")); assert.ok(!n(one).includes("\n\n")); assert.ok(!n(beast4).includes("\n\n"));
  }
});

// (e) a page where the gap rule accepted a boundary AND Fix C's two line test passes, but a left block word runs past the first right block word: rejected
const overlapPage: W[] = [
  wr("Header", 100, 400, 100), wr("alpha", 120, 170, 131),
  ...[0, 1, 2].flatMap((i) => [wr("Right" + i, 300, 360, 100 + 31 * i + 62), wr("text", 370, 420, 100 + 31 * i + 62)]),
  wr("beta", 110, 160, 162), wr("gamma", 110, 160, 193),
];
t("AP9X-1 (e) a negative gutter on a page the gap rule accepted (and with 3 right lines): the boundary is rejected; before, the page was split", () => {
  for (const [n, o] of [[rzNew, rzPrev], [urNew, urPrev]] as const) {
    assert.ok(o(overlapPage).includes("\n\n"), "286d5f4 splits it");
    assert.ok(!n(overlapPage).includes("\n\n"), n(overlapPage));
  }
});
t("AP9X-1 a gutter of exactly 0 keeps the columns (only a negative gutter rejects), a gutter of -1 rejects", () => {
  const mk = (leftRight: number) => [
    wr("Aaa", 100, leftRight, 100), wr("Bbb", 100, leftRight, 131), wr("Ccc", 100, leftRight, 162),
    wr("Xxx", 300, 360, 100), wr("Yyy", 300, 360, 131), wr("Zzz", 300, 360, 162),
  ];
  for (const f of [rzNew, urNew]) { assert.ok(f(mk(300)).includes("\n\n"), "gutter 0 keeps the columns"); assert.ok(!f(mk(301)).includes("\n\n"), "gutter -1 rejects"); assert.ok(f(mk(250)).includes("\n\n")); }
});
t("AP9X-1 words without right edges are not used: the function reads rect.right of every word (both copies the same on the same boxes)", () => {
  for (const page of [simple4, labelPage, twoCol, overlapPage, beast4]) assert.equal(rzNew(page), urNew(page));
});

for (const [name, fn] of tests) { await fn(); console.log("ok  ", name); }
console.log(`\n${tests.length} tests passed`);
