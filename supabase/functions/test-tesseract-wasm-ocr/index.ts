// Setup type definitions for built-in Supabase Runtime APIs
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { withSupabase } from "jsr:@supabase/server@1";
import { createOCREngine } from "npm:tesseract-wasm@0.11.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "content-type",
};

// FEASIBILITY TEST — follow-up to test-tesseract-ocr (Tesseract.js proper, a proven dead end here:
// its Worker-based architecture hits Deno's unimplemented node:worker_threads.Worker). This tests
// tesseract-wasm (github.com/robertknight/tesseract-wasm) — a different project, NOT a wrapper
// around Tesseract.js — specifically because its low-level API is documented as synchronous with
// no worker requirement. Confirmed against the real source before writing a line of test code
// here, same discipline as pulling real field names before building a parser:
//   - src/ocr-engine.ts: createOCREngine() and OCREngine take wasmBinary/model as plain
//     Uint8Array/ArrayBuffer and call WebAssembly APIs directly — no Worker, no worker_threads,
//     anywhere in this file.
//   - src/ocr-client.ts (the *other*, high-level API this deliberately does NOT use): `new
//     Worker(url)` exists there, but only inside a function body, never at module scope — so
//     merely importing createOCREngine from the package's shared entry point does not execute or
//     even reference Worker at import time. Confirmed by reading the actual file, not assumed.
//   - loadImage()'s real implementation duck-types its input (`imageData.data` /
//     `.width` / `.height`) rather than doing a hard `instanceof ImageData` check — the ImageBitmap
//     branch is itself guarded with `typeof ImageBitmap !== "undefined"`. So this never needs a
//     real browser ImageData/ImageBitmap global to exist in Deno; a plain object with the same
//     three fields works.
//
// One deliberate scope simplification, disclosed plainly: this endpoint accepts pre-decoded raw
// RGBA pixels (width, height, and a base64 Uint8ClampedArray buffer) rather than a PNG/JPEG file.
// Decoding a compressed image format into raw pixels with no DOM/Canvas available in Deno is a
// real, separate, solvable problem (pure-JS decoders exist) — but it is not what this test is
// about. This isolates the one real open question — does the WASM OCR engine itself run and
// produce correct text in this runtime — from an unrelated image-decoding concern. The test
// harness (a real browser canvas) does the "decoding" by construction, same as any other camera/
// scanner pipeline that already has pixels before OCR starts.
//
// WASM core (~1.84MB) and the eng trained-data model (~4.1MB fast variant, not the ~23.5MB "best"
// variant Tesseract.js defaults to) are both fetched over HTTPS at invocation time, not bundled —
// same non-issue for the 10MB source-bundle limit as before, for the same reason.
//
// RESULT — DOCUMENTED SUCCESS, WITH A REAL KNOWN LIMITATION (not a work in progress; see
// test-tesseract-wasm-psm for the page-segmentation follow-up to the limitation below).
// Confirmed live, against three real invocations of this deployed function:
//   - Tiny sanity image ("HELLO WORLD 12345"): ok:true, perfect text, 197ms total.
//   - Clean single-column resume (850x1100): ok:true, near-perfect text — every section header,
//     job title, company, and date range exact; two isolated OCR-typical slips (a case error,
//     and the classic "internal"->"intemal" rn/m ligature confusion). 616ms total server-side
//     (recognize itself: 466ms), ~26.7MB heap used / ~48.7MB external — comfortable headroom
//     against the ~150MB ceiling and 60s budget.
//   - Two-column resume (same 850x1100 canvas, genuine left/right column layout): ok:true, no
//     crash, no resource pressure (957ms total, same ~26.7MB/~48.7MB memory profile) — but the
//     OUTPUT interleaves the two columns line-by-line ("CONTACT EXPERIENCE",
//     "taylor.chen@example.com Senior Product Marketing Manager, Nimbus Cloud Co") instead of
//     reading each column as a separate block, plus a couple of words in the narrower left
//     column got locally garbled ("SQL, Tableau, Figma" -> "Sel Tableau Fisma"), likely a side
//     effect of the same misread. This is real Tesseract's default page-segmentation behavior on
//     multi-column input, not a tesseract-wasm-specific bug.
// Bottom line: the runtime-constraints question (can this run in an Edge Function at all) is
// settled yes, comfortably. The accuracy question is settled yes for single-column, not yet for
// multi-column — page-segmentation-mode tuning is the next real avenue, tested separately.

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
    let memBefore: unknown = null;
    try {
      // deno-lint-ignore no-explicit-any
      memBefore = typeof (Deno as any).memoryUsage === "function" ? (Deno as any).memoryUsage() : "unavailable";
    } catch {
      memBefore = "unavailable";
    }

    try {
      const { rgba_base64, width, height } = await req.json();
      if (!rgba_base64 || typeof rgba_base64 !== "string" || !width || !height) {
        return new Response(JSON.stringify({ ok: false, error: "rgba_base64, width, and height are required" }), {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      const rgbaBytes = base64ToBytes(rgba_base64);
      const tDecoded = performance.now();

      const [wasmRes, modelRes] = await Promise.all([fetch(WASM_URL), fetch(MODEL_URL)]);
      if (!wasmRes.ok || !modelRes.ok) {
        return new Response(JSON.stringify({
          ok: false,
          error: "asset_fetch_failed",
          detail: `wasm status=${wasmRes.status}, model status=${modelRes.status}`,
        }), { status: 502, headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }
      const wasmBinary = new Uint8Array(await wasmRes.arrayBuffer());
      const modelBytes = new Uint8Array(await modelRes.arrayBuffer());
      const tAssetsFetched = performance.now();

      const engine = await createOCREngine({ wasmBinary });
      const tEngineReady = performance.now();

      engine.loadModel(modelBytes);
      const tModelLoaded = performance.now();

      engine.loadImage({ data: rgbaBytes, width, height });
      const tImageLoaded = performance.now();

      const text = engine.getText();
      const tRecognized = performance.now();

      engine.destroy();
      const tDestroyed = performance.now();

      let memAfter: unknown = null;
      try {
        // deno-lint-ignore no-explicit-any
        memAfter = typeof (Deno as any).memoryUsage === "function" ? (Deno as any).memoryUsage() : "unavailable";
      } catch {
        memAfter = "unavailable";
      }

      return new Response(JSON.stringify({
        ok: true,
        text,
        assetSizes: { wasmBytes: wasmBinary.byteLength, modelBytes: modelBytes.byteLength },
        timingMs: {
          decodeInputRgba: Math.round(tDecoded - t0),
          fetchWasmAndModel: Math.round(tAssetsFetched - tDecoded),
          engineInit: Math.round(tEngineReady - tAssetsFetched),
          loadModel: Math.round(tModelLoaded - tEngineReady),
          loadImage: Math.round(tImageLoaded - tModelLoaded),
          recognize_getText: Math.round(tRecognized - tImageLoaded),
          destroy: Math.round(tDestroyed - tRecognized),
          total: Math.round(tDestroyed - t0),
        },
        memory: { before: memBefore, after: memAfter },
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
        memory: { before: memBefore },
      }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
  }),
};
