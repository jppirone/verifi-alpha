// Setup type definitions for built-in Supabase Runtime APIs
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { withSupabase } from "jsr:@supabase/server@1";
import { createOCREngine } from "npm:tesseract-wasm@0.11.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "content-type",
};

// FEASIBILITY TEST — follow-up to test-tesseract-wasm-ocr's one real known limitation
// (two-column resumes come back with the columns interleaved line-by-line instead of read as
// separate blocks). This tests whether Tesseract's page-segmentation-mode setting fixes that,
// before concluding it needs a heavier custom column-detection step.
//
// API confirmed first, not assumed: tesseract-wasm's OCREngine (src/ocr-engine.ts) exports NO
// dedicated PSM method or enum — no setPageSegMode(), no PageSegMode type. The only mechanism
// exposed at all is the generic passthrough setVariable(name: string, value: string): void, whose
// own JSDoc points at real Tesseract's tesseractclass.cpp variable list and `tesseract
// --print-parameters` — i.e. this is a real, direct passthrough to Tesseract's internal variable
// system, not a tesseract-wasm-specific abstraction, and there is no guarantee any given variable
// name is actually read by the code path getText() runs. This test sets the real Tesseract
// variable `tessedit_pageseg_mode` to `3` ("fully automatic page segmentation, no OSD" — real
// Tesseract's own CLI default) via that one available mechanism, and reports the raw result.
//
// Why PSM 3 specifically, and why the merge likely happened at all: real Tesseract's C++
// TessBaseAPI class — which is what any library (this one included) sits on top of — defaults to
// PSM_SINGLE_BLOCK (mode 6, "assume one uniform block of text") unless a caller explicitly asks
// for something else; only the tesseract CLI binary itself overrides that default to PSM 3 before
// calling the library. tesseract-wasm's own createOCREngine/getText never sets a PSM, so the
// previous test almost certainly ran under the single-block default the whole time — which reads
// a page as one flowing block with no column-awareness at all, exactly matching the interleaved
// output observed. PSM 3 is Tesseract's real layout-analysis mode, the one actually meant to
// detect separate text blocks/columns; that's the specific, reasoned hypothesis being tested here,
// not a guess among the full PSM 0-13 list.
//
// Same test image as test-tesseract-wasm-ocr's two-column case — this endpoint reuses the exact
// same raw-RGBA input contract (rgba_base64/width/height) so the same generated canvas image can
// be POSTed again unchanged, keeping this a controlled before/after comparison.
//
// RESULT — DOCUMENTED, NEGATIVE. Confirmed live against the exact same two-column resume image as
// before: pageSegModeVariable read back {before: "6", after: "3"} — proving the hypothesis above
// was right (default really was PSM 6) and proving setVariable() genuinely accepted and stored
// "3", no error. But the getText() OUTPUT came back byte-for-byte IDENTICAL to the untouched PSM
// 6 run — same interleaved columns ("CONTACT EXPERIENCE", "taylor.chen@example.com Senior Product
// Marketing Manager, Nimbus Cloud Co"), same locally garbled words ("Sel Tableau Fisma", "Cross
// unctona Leadership"), same everything, timing included (903ms vs 957ms — noise). Not a partial
// improvement rounded up: zero measurable effect. tessedit_pageseg_mode is settable and readable
// through tesseract-wasm's setVariable/getVariable passthrough, but this build's getText() does
// not appear to actually consult it at recognition time — most likely because the dedicated C++
// SetPageSegMode() call that real Tesseract's PSM machinery is actually keyed off of is never
// invoked anywhere in tesseract-wasm's own bindings, and the tessedit_pageseg_mode variable is
// stored without being wired back into that internal state. tesseract-wasm's public API exposes
// no other lever for this (see the full method list in test-tesseract-wasm-ocr's companion
// investigation) — page segmentation is not fixable through this library's API, full stop, not
// "needs a different mode," an honest dead end for this specific approach. Per instructions, no
// custom column-detection logic was attempted here — that's the next real idea, evaluated later,
// not started blind off the back of this result.

const WASM_URL = "https://cdn.jsdelivr.net/npm/tesseract-wasm@0.11.0/dist/tesseract-core.wasm";
const MODEL_URL = "https://raw.githubusercontent.com/tesseract-ocr/tessdata_fast/main/eng.traineddata";

function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export default {
  fetch: withSupabase({ auth: "none" }, async (req, _ctx) => {
    if (req.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }
    const t0 = performance.now();
    try {
      const { rgba_base64, width, height, psm } = await req.json();
      if (!rgba_base64 || typeof rgba_base64 !== "string" || !width || !height) {
        return new Response(JSON.stringify({ ok: false, error: "rgba_base64, width, and height are required" }), {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      const psmValue = typeof psm === "string" || typeof psm === "number" ? String(psm) : "3";

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

      // The one real, confirmed lever available — see header comment. Report what value we tried
      // and read it back via getVariable so a silently-ignored/unrecognized variable name shows up
      // in the response instead of being invisible.
      let readBackBefore: string | null = null;
      let setVariableError: string | null = null;
      try {
        readBackBefore = engine.getVariable("tessedit_pageseg_mode");
      } catch (e) {
        readBackBefore = null;
      }
      try {
        engine.setVariable("tessedit_pageseg_mode", psmValue);
      } catch (e) {
        setVariableError = String(e);
      }
      let readBackAfter: string | null = null;
      try {
        readBackAfter = engine.getVariable("tessedit_pageseg_mode");
      } catch (e) {
        readBackAfter = null;
      }

      engine.loadImage({ data: rgbaBytes, width, height });
      const tImageLoaded = performance.now();

      const text = engine.getText();
      const tRecognized = performance.now();

      engine.destroy();
      const tTotal = performance.now();

      return new Response(JSON.stringify({
        ok: true,
        psmRequested: psmValue,
        pageSegModeVariable: { before: readBackBefore, after: readBackAfter, setVariableError },
        text,
        timingMs: {
          loadImageThroughSetup: Math.round(tImageLoaded - t0),
          recognize_getText: Math.round(tRecognized - tImageLoaded),
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
