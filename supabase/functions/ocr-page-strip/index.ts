// Setup type definitions for built-in Supabase Runtime APIs
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { withSupabase } from "jsr:@supabase/server@1";
import { createOCREngine } from "npm:tesseract-wasm@0.11.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "content-type",
};

// OCR of ONE horizontal strip of one PDF page — the worker behind rasterize-pdf-page's tesseract route.
//
// Why this exists (2026-09-19, resume-parsing slowness investigation): Supabase Edge Functions are killed after
// ~2 s of CPU time per request (WORKER_RESOURCE_LIMIT — not memory, not the render). Measured on the platform
// against a real 2-page resume, tesseract-wasm costs ~5.5 ms per recognised word: a 217-244 word strip finishes in
// ~1.3-1.5 s, while the full page (~600 words) and even a 350-word half are killed. Dense pages therefore could
// never finish OCR in a single invocation at any DPI that keeps small text legible (110 DPI still died), and every
// such page fell through to the Sonnet-vision route: ~45-75 s per page instead of ~7 s.
//
// The fix is to split the page into strips that each fit the budget and OCR them in parallel invocations of this
// function. rasterize-pdf-page plans the strips (cuts sit in blank rows between text lines, so no line is ever
// split), calls this once per strip, then merges the word boxes and runs the SAME word-clustering and the SAME
// Haiku boundary/extraction steps as before. Measured locally against the PDF's exact text layer: strip OCR and
// whole-page OCR both match 563 of 594 words on page 1 (~95%; the misses are bullet and dash glyphs), i.e. strips
// cost no accuracy.
//
// Request: { storage_path, page_number, scale, width, y0, y1 } — scale is the parent's effective render scale,
// width its pixmap width, y0/y1 the strip's row range within the parent's pixmap (rows from the top of the page).
// Response: { ok, words: [{ text, confidence, rect }] with rect.top/bottom already offset by y0, timing_ms }.
// It renders only its own strip (a clipped pixmap), so its memory and CPU do not depend on the page size.

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const BUCKET = "resume-documents";
const WASM_URL = "https://cdn.jsdelivr.net/npm/tesseract-wasm@0.11.0/dist/tesseract-core.wasm";
const MODEL_URL = "https://raw.githubusercontent.com/tesseract-ocr/tessdata_fast/main/eng.traineddata";
const MAX_STRIP_ROWS = 3000; // sanity bound on a request (a whole US-Letter page at 250 DPI is 2750 rows)

// ---------------------------------------------------------------------------------------------------
// CALLER AUTHENTICATION (staff/internal endpoint auth pass, 2026-09-19).
// This function used to have no caller check beyond the platform's own key check, which the PUBLIC anon key (embedded in
// candidate.html and staff.html) passes: anyone could call it. It now requires one of:
//   * the service-role key as the bearer token (what our own functions send when they call each other; exact match,
//     constant-time compare), where the function allows internal callers; or
//   * a live STAFF session: the staff_session_token staff.html already holds from staff-confirm-login, checked on every call
//     against staff_sessions (hashed, unrevoked, unexpired) and resolved to a staff_users row. Identity is never taken from
//     the request body.
// Anything else is the same 401 whether the token was missing, wrong, expired or revoked.
// ---------------------------------------------------------------------------------------------------
const AUTH_SB_URL = Deno.env.get("SUPABASE_URL")!;
const AUTH_SB_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
type AuthCaller = { kind: "service" } | { kind: "staff"; id: string; email: string; name: string; role: string };
async function authSha256Hex(s: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return Array.from(new Uint8Array(d)).map((b) => b.toString(16).padStart(2, "0")).join("");
}
function authSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
async function authenticateStaffOrService(req: Request, body: any, allow: { staff: boolean; service: boolean }): Promise<AuthCaller | null> {
  if (allow.service) {
    const h = req.headers.get("authorization") || "";
    const t = h.toLowerCase().startsWith("bearer ") ? h.slice(7).trim() : "";
    if (t && AUTH_SB_KEY && authSafeEqual(t, AUTH_SB_KEY)) return { kind: "service" };
  }
  if (allow.staff) {
    const tok = typeof body?.staff_session_token === "string" ? body.staff_session_token : "";
    if (tok.length >= 20 && tok.length <= 200) {
      const rest = { "apikey": AUTH_SB_KEY, "Authorization": `Bearer ${AUTH_SB_KEY}` };
      const sRes = await fetch(`${AUTH_SB_URL}/rest/v1/staff_sessions?token_hash=eq.${await authSha256Hex(tok)}&select=staff_user_id,expires_at,revoked_at`, { headers: rest });
      const sess = sRes.ok ? (await sRes.json())[0] : null;
      if (sess && !sess.revoked_at && new Date(sess.expires_at).getTime() > Date.now()) {
        const uRes = await fetch(`${AUTH_SB_URL}/rest/v1/staff_users?id=eq.${sess.staff_user_id}&select=id,email,name,role`, { headers: rest });
        const u = uRes.ok ? (await uRes.json())[0] : null;
        if (u) return { kind: "staff", id: u.id, email: u.email, name: u.name, role: u.role };
      }
    }
  }
  return null;
}
const UNAUTHORIZED = () => new Response(JSON.stringify({ ok: false, error: "unauthorized" }), { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } });

export default {
  fetch: withSupabase({ auth: "none" }, async (req, _ctx) => {
    if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
    const caller = await authenticateStaffOrService(req, {}, { staff: false, service: true }); // only rasterize-pdf-page calls this
    if (!caller) return UNAUTHORIZED();
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    try {
      const { storage_path, page_number, scale, width, y0, y1 } = await req.json();
      const pageNum = Number(page_number);
      const s = Number(scale), w = Math.round(Number(width)), top = Math.round(Number(y0)), bottom = Math.round(Number(y1));
      if (typeof storage_path !== "string" || !storage_path || !Number.isInteger(pageNum) || pageNum < 1 ||
          !(s > 0.2 && s < 6) || !(w > 0 && w <= 6000) || !(top >= 0) || !(bottom > top) || bottom - top > MAX_STRIP_ROWS) {
        return json({ ok: false, error: "bad_request" }, 400);
      }
      const t0 = performance.now();
      const stages: Record<string, number> = {};

      let t = performance.now();
      const fileRes = await fetch(`${SUPABASE_URL}/storage/v1/object/${BUCKET}/${storage_path}`, {
        headers: { apikey: SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}` },
      });
      if (!fileRes.ok) return json({ ok: false, error: "storage_fetch_failed", status: fileRes.status }, 500);
      const pdfBytes = new Uint8Array(await fileRes.arrayBuffer());
      stages.fetch_pdf = Math.round(performance.now() - t); t = performance.now();

      const mupdf: any = await import("npm:mupdf@1");
      const doc = mupdf.Document.openDocument(pdfBytes, "application/pdf");
      if (pageNum > doc.countPages()) return json({ ok: false, error: "page_number_out_of_range" }, 400);
      const page = doc.loadPage(pageNum - 1);
      const b = page.getBounds();
      // Same device-space rounding the parent's full-page pixmap used (page bounds x scale, rounded outward), so
      // row y in the parent's pixmap is row y here.
      const originX = Math.floor(b[0] * s), originY = Math.floor(b[1] * s);
      const matrix = mupdf.Matrix.scale(s, s);
      const pixmap = new mupdf.Pixmap(mupdf.ColorSpace.DeviceRGB, [originX, originY + top, originX + w, originY + bottom], false);
      pixmap.clear(255);
      const device = new mupdf.DrawDevice(matrix, pixmap);
      page.run(device, mupdf.Matrix.identity);
      device.close();
      const rgb = pixmap.getPixels();
      const rgba = new Uint8Array((rgb.length / 3) * 4);
      for (let i = 0, n = rgb.length / 3; i < n; i++) {
        rgba[i * 4] = rgb[i * 3]; rgba[i * 4 + 1] = rgb[i * 3 + 1]; rgba[i * 4 + 2] = rgb[i * 3 + 2]; rgba[i * 4 + 3] = 255;
      }
      stages.render = Math.round(performance.now() - t); t = performance.now();

      const [wasmRes, modelRes] = await Promise.all([fetch(WASM_URL), fetch(MODEL_URL)]);
      if (!wasmRes.ok || !modelRes.ok) return json({ ok: false, error: "ocr_asset_fetch_failed" }, 502);
      const wasmBinary = new Uint8Array(await wasmRes.arrayBuffer());
      const modelBytes = new Uint8Array(await modelRes.arrayBuffer());
      stages.fetch_assets = Math.round(performance.now() - t); t = performance.now();

      const engine = await createOCREngine({ wasmBinary });
      engine.loadModel(modelBytes);
      engine.loadImage({ data: rgba, width: pixmap.getWidth(), height: pixmap.getHeight() });
      stages.engine_init = Math.round(performance.now() - t); t = performance.now();
      const boxes = engine.getTextBoxes("word") as unknown as Array<{ rect: { left: number; top: number; right: number; bottom: number }; confidence: number; text: string }>;
      stages.recognize = Math.round(performance.now() - t);
      const words = boxes.map((wd) => ({ text: wd.text, confidence: wd.confidence, rect: { left: wd.rect.left, top: wd.rect.top + top, right: wd.rect.right, bottom: wd.rect.bottom + top } }));
      engine.destroy();

      return json({ ok: true, words, strip: { y0: top, y1: bottom, width: w, scale: s }, timing_ms: { ...stages, total: Math.round(performance.now() - t0) } });
    } catch (e) {
      return json({ ok: false, error: "unhandled", detail: String(e) }, 500);
    }
  }),
};
