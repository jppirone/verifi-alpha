// Setup type definitions for built-in Supabase Runtime APIs
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { withSupabase } from "jsr:@supabase/server@1";
import { createOCREngine } from "npm:tesseract-wasm@0.11.0";
import { ckmeans } from "npm:simple-statistics@7.11.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "content-type",
};

// FEASIBILITY TEST — follow-up to test-tesseract-wasm-psm's dead end (tessedit_pageseg_mode is
// settable/readable via tesseract-wasm's setVariable but has zero effect on getText() output;
// independently corroborated by tesseract-wasm's own issue tracker — issue #58, opened July 2022,
// still open, unresolved, no maintainer response: a real user hit this exact problem — "sometimes
// [it] interprets text as 2-3 columns, making recognition nonsensical" — and asked for --psm
// support with no fix to date).
//
// Search done first, per instructions, before building anything:
//   1. Alternative Tesseract WASM builds with real PSM control: none found. tesseract.js proper
//      does expose a documented setParameters({tessedit_pageseg_mode}) API, but that's moot here —
//      it's the same library already proven unable to even initialize in this runtime (Worker
//      dependency, test-tesseract-ocr). No actively maintained fork of tesseract-wasm itself
//      wires PSM through to the actual recognition call.
//   2. Standalone lightweight column/layout-detection libraries: the one real, relevant hit was
//      nypl-spacetime/hocr-detect-columns — but it operates on hOCR XML output (i.e. AFTER OCR),
//      not on raw images before OCR, and its actual algorithm is small enough to not need the
//      library itself: cluster the LEFT-EDGE x-coordinate of each recognized line's bounding box
//      with simple-statistics' ckmeans (a real, zero-dependency, pure-math 1D clustering
//      function — no ML framework, no native binary, no Worker anywhere in simple-statistics'
//      own source, confirmed by reading its package.json before adding it here), then reorder
//      lines by (cluster, top-position) instead of raw top-to-bottom raster order.
//   Also noted, explicitly out of scope for this pass: robertknight (tesseract-wasm's own author)
//   has a newer, from-scratch OCR engine, ocrs, with a real dedicated layout-analysis stage — but
//   it's three separate neural-network models (detection, layout, recognition) run through ONNX,
//   no clear published WASM npm package, and a fundamentally different engine, not a lightweight
//   pre-processing step. Doesn't fit either search category as specified; flagged, not tested.
//
// The approach actually built and tested here needs no third-party column-splitting at all: it
// uses a capability tesseract-wasm ALREADY has and the earlier tests simply never called —
// getTextBoxes("line"), which returns real per-line pixel bounding boxes alongside each line's
// text. Column membership is inferred from those boxes' left edges (ckmeans, k=2, since this is a
// controlled test against the known two-column case, not a general N-column solution), each
// column's lines are sorted top-to-bottom, and the columns are concatenated left-to-right. No
// image splitting, no second OCR pass — one recognize call, then a ~15-line reordering step.
//
// RESULT — DOCUMENTED, NEGATIVE. A real, reasoned approach that does not work, for a specific,
// now-understood reason — not a partial win rounded up. Confirmed live against the exact same
// two-column resume image as every prior pass:
//   - getTextBoxes("line") returned only 19 boxes for a page with ~27 real distinct lines.
//   - Inspecting those boxes directly: several are themselves ALREADY merged across both columns
//     into one box before this function ever sees them — e.g. one single TextItem's text is
//     literally "taylor.chen@example.com Senior Product Marketing Manager, Nimbus Cloud Co", one
//     bounding box spanning both columns, not two adjacent boxes this could cluster apart.
//   - Consequence: ckmeans column-clustering on left-edge x put 15 of 19 boxes in "column 0"
//     (because a merged box's left edge sits at column 0's position even though its text runs
//     into column 1), so reorderedText is barely different from baselineText — the same
//     "CONTACT EXPERIENCE" / "taylor.chen@example.com Senior Product Marketing Manager..." merges
//     are still there, just with two stray column-1 fragments moved to the end.
// Root cause: getTextBoxes() and getText() are not independent data sources — both are read out
// AFTER the same internal layout-analysis step that PSM 6 (single-block) already got wrong (see
// test-tesseract-wasm-psm). The line boxes are corrupted at the source; no amount of
// post-hoc clustering on already-merged boxes can un-merge text that was glued together before
// this code ever runs. This is the real, concrete reason a promising-on-paper idea failed, not a
// vague "didn't work."
// Conclusion for this whole line of investigation (three passes: PSM via setVariable, PSM's own
// issue tracker corroborating the same defect independently, and now getTextBoxes-based
// reordering): tesseract-wasm cannot be made to handle this two-column case from the pixel data
// alone, however it's asked. The one remaining lever — cropping the IMAGE into separate column
// regions before handing pixels to OCR at all, i.e. real custom column-detection on the raw
// image — is exactly the scope explicitly deferred by this task's own instructions: a deliberate
// decision for a future pass, not something to build blind here.

// Same raw-RGBA input contract as every other test-tesseract-wasm-* function, so the exact same
// two-column resume image can be POSTed here unchanged for a controlled comparison.

const WASM_URL = "https://cdn.jsdelivr.net/npm/tesseract-wasm@0.11.0/dist/tesseract-core.wasm";
const MODEL_URL = "https://raw.githubusercontent.com/tesseract-ocr/tessdata_fast/main/eng.traineddata";

function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

type TextItem = { rect: { left: number; top: number; right: number; bottom: number }; confidence: number; text: string };

// Cluster lines into columns by left-edge x-position (ckmeans, k=2 — this test targets the known
// two-column case), then reorder each column top-to-bottom and concatenate columns left-to-right.
function reorderByColumns(lines: TextItem[]): { reorderedText: string; columnAssignment: { text: string; column: number }[] } {
  if (lines.length < 2) {
    return { reorderedText: lines.map((l) => l.text).join("\n"), columnAssignment: lines.map((l) => ({ text: l.text, column: 0 })) };
  }
  const xs = lines.map((l) => l.rect.left);
  const clusters = ckmeans(xs, Math.min(2, new Set(xs).size));
  // ckmeans returns clusters ordered ascending by value; boundary = midpoint between cluster 0's
  // max and cluster 1's min. Lines are then assigned by comparing to this boundary directly
  // (avoids ambiguity from duplicate x-values rather than trying to map ckmeans' value groups
  // back to specific line objects).
  let boundary = -Infinity;
  if (clusters.length > 1) {
    const c0Max = Math.max(...clusters[0]);
    const c1Min = Math.min(...clusters[1]);
    boundary = (c0Max + c1Min) / 2;
  }
  const withColumn = lines.map((l) => ({ ...l, column: l.rect.left <= boundary ? 0 : 1 }));
  const byColumn: TextItem[][] = [[], []];
  for (const l of withColumn) byColumn[(l as unknown as { column: number }).column].push(l);
  for (const col of byColumn) col.sort((a, b) => a.rect.top - b.rect.top);

  const reorderedText = byColumn
    .filter((col) => col.length > 0)
    .map((col) => col.map((l) => l.text).join("\n"))
    .join("\n\n");

  const columnAssignment = withColumn.map((l) => ({ text: l.text, column: (l as unknown as { column: number }).column }));
  return { reorderedText, columnAssignment };
}

export default {
  fetch: withSupabase({ auth: "none" }, async (req, _ctx) => {
    if (req.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }
    const t0 = performance.now();
    try {
      const { rgba_base64, width, height } = await req.json();
      if (!rgba_base64 || typeof rgba_base64 !== "string" || !width || !height) {
        return new Response(JSON.stringify({ ok: false, error: "rgba_base64, width, and height are required" }), {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      const rgbaBytes = base64ToBytes(rgba_base64);

      const [wasmRes, modelRes] = await Promise.all([fetch(WASM_URL), fetch(MODEL_URL)]);
      if (!wasmRes.ok || !modelRes.ok) {
        return new Response(JSON.stringify({ ok: false, error: "asset_fetch_failed" }), {
          status: 502,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      const wasmBinary = new Uint8Array(await wasmRes.arrayBuffer());
      const modelBytes = new Uint8Array(await modelRes.arrayBuffer());

      const engine = await createOCREngine({ wasmBinary });
      engine.loadModel(modelBytes);
      engine.loadImage({ data: rgbaBytes, width, height });
      const tImageLoaded = performance.now();

      // Baseline, unmodified getText() — same call as test-tesseract-wasm-ocr — for a direct
      // side-by-side comparison in one response, rather than requiring two separate invocations.
      const baselineText = engine.getText();
      const tBaseline = performance.now();

      const lines = engine.getTextBoxes("line") as unknown as TextItem[];
      const tBoxes = performance.now();

      const { reorderedText, columnAssignment } = reorderByColumns(lines);

      engine.destroy();
      const tTotal = performance.now();

      return new Response(JSON.stringify({
        ok: true,
        baselineText,
        reorderedText,
        lineCount: lines.length,
        columnAssignment,
        timingMs: {
          loadImageThroughSetup: Math.round(tImageLoaded - t0),
          baselineGetText: Math.round(tBaseline - tImageLoaded),
          getTextBoxes: Math.round(tBoxes - tBaseline),
          reorderAndCleanup: Math.round(tTotal - tBoxes),
          total: Math.round(tTotal - t0),
        },
      }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    } catch (e) {
      const tFailed = performance.now();
      return new Response(JSON.stringify({
        ok: false,
        error: String(e),
        stack: e && (e as Error).stack ? String((e as Error).stack).slice(0, 3000) : null,
        timingMs: { totalUntilFailure: Math.round(tFailed - t0) },
      }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
  }),
};
