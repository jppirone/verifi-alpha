// Setup type definitions for built-in Supabase Runtime APIs
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { withSupabase } from "jsr:@supabase/server@1";
import { createWorker } from "npm:tesseract.js@5.1.1";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "content-type",
};

// FEASIBILITY TEST — PROVEN, DOCUMENTED DEAD END. Not a work in progress, not wired into
// anything, not meant to be fixed or iterated on in place. This function exists to answer one
// question with real evidence — can Tesseract.js do useful OCR inside Supabase's actual Edge
// Function runtime (Deno, ~150MB memory, 60s execution, 10MB source bundle)? — and the answer,
// confirmed by actually invoking this deployed function, is no, unconditionally, for an
// architectural reason no amount of tuning here fixes:
//
// Real error from a live invocation, 3ms after the request started (before any image decoding,
// WASM loading, or language-data fetch even begins):
//   Error [ERR_NOT_IMPLEMENTED]: Not implemented: Worker.prototype.constructor
//       at new NodeWorker (node:worker_threads:34:5)
//       at .../tesseract.js/5.1.1/src/worker/node/spawnWorker.js:10:38
//
// Root cause, traced to source: tesseract.js's own environment detection
// (naptha/tesseract.js src/utils/getEnvironment.js) checks, in order, WorkerGlobalScope (browser
// worker) -> document (browser) -> process && require (Node). Deno Edge Functions have no
// `document` (correctly — not a browser), but Deno's npm-compat layer does expose `process` and
// `require`, so tesseract.js deterministically picks the Node code path, which calls
// `node:worker_threads` — and Deno's compat shim for that module is a stub that does not
// implement `Worker` at all. There is no environment override in tesseract.js's public API to
// force a different path. This is the same underlying failure mode as naptha/tesseract.js#950
// ("doesn't work in Cloudflare Workers" — "Worker is not defined"), arrived at independently here
// and confirmed against Supabase's actual runtime rather than assumed from that unrelated issue.
//
// What this does NOT tell us: nothing about accuracy, timing, or memory under real OCR load —
// the failure happens before any of that is exercised, on trivial or realistic input alike, so
// there was no reason to test harder documents (a two-column resume would fail identically and
// just as instantly). What it DOES settle: the 10MB source-bundle limit was never actually the
// risk (tesseract.js's language data is fetched over HTTP at runtime by design, never bundled —
// confirmed by this function deploying cleanly with no build-time size error), but that's moot
// now — the real blocker is one step earlier, in worker initialization itself.
//
// Next candidate, not yet tested: tesseract-wasm (github.com/robertknight/tesseract-wasm) is a
// *different* project from Tesseract.js proper, exposing a synchronous, non-worker WASM API —
// built for exactly this kind of constrained-runtime case. Worth testing on its own merits before
// concluding OCR needs separate infrastructure entirely; this file's finding is specific to
// Tesseract.js's Worker-dependent architecture, not a verdict on WASM-based OCR in general.

function timingsToObj(marks: Record<string, number>) {
  return marks;
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
      const { image_base64 } = await req.json();
      if (!image_base64 || typeof image_base64 !== "string") {
        return new Response(JSON.stringify({ ok: false, error: "image_base64 is required" }), {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      const binary = atob(image_base64);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      const tDecoded = performance.now();

      const worker = await createWorker("eng", 1, { logger: () => {} });
      const tWorkerReady = performance.now();

      const { data } = await worker.recognize(bytes);
      const tRecognized = performance.now();

      await worker.terminate();
      const tTerminated = performance.now();

      let memAfter: unknown = null;
      try {
        // deno-lint-ignore no-explicit-any
        memAfter = typeof (Deno as any).memoryUsage === "function" ? (Deno as any).memoryUsage() : "unavailable";
      } catch {
        memAfter = "unavailable";
      }

      return new Response(JSON.stringify({
        ok: true,
        text: data.text,
        confidence: data.confidence,
        timingMs: timingsToObj({
          decodeInputImage: Math.round(tDecoded - t0),
          workerInit_includesCoreAndLangDataFetch: Math.round(tWorkerReady - tDecoded),
          recognize: Math.round(tRecognized - tWorkerReady),
          terminate: Math.round(tTerminated - tRecognized),
          total: Math.round(tTerminated - t0),
        }),
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
