// Setup type definitions for built-in Supabase Runtime APIs
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { withSupabase } from "jsr:@supabase/server@1";
import { createClient } from "npm:@supabase/supabase-js@2";

// EMPLOYER DOCUMENT UPLOAD (2026-09-20). An employer's request for a candidate's verified record must carry the employer's own document (their
// copy of the candidate's resume or application), so the candidate can see who is really asking. This function is the only way a document gets
// in. It: authenticates the caller (an org employer's session, or a guest's lookup + claim token), requires the disclosure to be ticked,
// validates the file by its SIGNATURE (never the extension or the browser's claimed type), runs a lightweight scan for active or malicious
// content, and stores the EXACT bytes, untouched, in the private employer-documents bucket. The scan is a check, not a conversion: a file that
// passes is stored and later served byte for byte; a file that fails is refused with a plain reason and nothing is stored.
// The request itself is created elsewhere (employer-api / employer-comparison), which passes the returned document_id to
// create_comparison_request; that function binds the file to the request in the same transaction and starts the 21-day clock. An upload
// that is never used is deleted an hour later (expire_comparison_requests), and a file with no row is removed by the purge sweep.
//
// THE SCAN IS LIGHTWEIGHT AND SAYS SO. It is not an antivirus engine. It rejects: PDFs with JavaScript, launch/submit/import/remote-goto
// actions, embedded files or rich media, XFA forms, or encryption (which hides content from any scan); executables and Office-macro markers
// found anywhere in the file; the standard EICAR antivirus test signature; and images that carry script markup or data appended after the
// image ends. PDF names are decoded first (so /J#61vaScript is seen as /JavaScript), object streams are inflated and scanned (that is
// where a PDF can hide its actions), and anything it cannot inspect is refused rather than waved through.

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const BUCKET = "employer-documents";
const REST = { "apikey": SERVICE_KEY, "Authorization": `Bearer ${SERVICE_KEY}` };
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
};
const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });

const MAX_BYTES = 10 * 1024 * 1024;
const CONSENT_VERSION = "2026-09-20.1";
const UNBOUND_UPLOADS_PER_HOUR = 5;

// @@scanner-start
type ScanOk = { ok: true; kind: "pdf" | "png" | "jpeg"; mime: string; ext: string };
type ScanFail = { ok: false; code: string; message: string };
type ScanResult = ScanOk | ScanFail;

const SCAN_MESSAGES: Record<string, string> = {
  bad_type: "Only PDF, PNG or JPEG files are accepted, and the file's contents must match its type.",
  empty: "That file is empty.",
  too_large: "That file is over 10 MB.",
  damaged: "That file looks damaged and could not be read.",
  pdf_javascript: "This PDF contains JavaScript, which we do not accept. Print or save it to a fresh PDF and upload that copy.",
  pdf_action: "This PDF contains an action that runs or sends something (launch, submit, import or a link to another file), which we do not accept. Print or save it to a fresh PDF and upload that copy.",
  pdf_embedded: "This PDF contains an attached or embedded file or media, which we do not accept. Print or save it to a fresh PDF and upload that copy.",
  pdf_form_script: "This PDF contains an XFA form, which can run scripts, so we do not accept it. Print or save it to a fresh PDF and upload that copy.",
  pdf_encrypted: "This PDF is encrypted, so it cannot be checked. Remove the encryption, or print it to a fresh PDF, and upload that copy.",
  pdf_unscannable: "Part of this PDF could not be inspected, so we cannot accept it. Print or save it to a fresh PDF and upload that copy.",
  malware_signature: "This file matches a known malware or antivirus-test signature, so it was rejected.",
  embedded_executable: "This file contains an embedded program or macro, so it was rejected.",
  image_script: "This image contains script or markup that a picture should not have, so it was rejected.",
  image_trailing_data: "This image has extra data hidden after the end of the picture, so it was rejected. Re-save it from an image editor and upload that copy.",
};
const fail = (code: string): ScanFail => ({ ok: false, code, message: SCAN_MESSAGES[code] || SCAN_MESSAGES.damaged });

const latin1 = (b: Uint8Array): string => new TextDecoder("latin1").decode(b); // one character per byte, so string offsets are byte offsets

function sniffKind(b: Uint8Array): "pdf" | "png" | "jpeg" | null {
  if (b.length >= 5 && b[0] === 0x25 && b[1] === 0x50 && b[2] === 0x44 && b[3] === 0x46 && b[4] === 0x2d) return "pdf";            // %PDF-
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 && b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a) return "png";
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "jpeg";
  return null;
}

// Signatures looked for anywhere in any file. All are long enough that a chance match inside compressed data is negligible.
function scanSignatures(s: string): ScanFail | null {
  if (s.includes("EICAR-STANDARD-ANTIVIRUS-TEST-FILE")) return fail("malware_signature");
  if (s.includes("This program cannot be run in DOS mode") || /\x7fELF[\x01\x02][\x01\x02]\x01/.test(s)) return fail("embedded_executable");
  if (s.includes("vbaProject.bin") || s.includes("_VBA_PROJECT")) return fail("embedded_executable");
  return null;
}

// Inflate a zlib (Flate) stream, bounded. Data after the end of the zlib stream (a trailing end-of-line) is tolerated: what was inflated up
// to that point is used. Returns null when nothing could be inflated or the output passes the cap.
async function inflate(bytes: Uint8Array, cap: number): Promise<Uint8Array | null> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    const reader = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("deflate")).getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > cap) { await reader.cancel(); return null; }
      chunks.push(value);
    }
  } catch (_e) { /* keep whatever was inflated before the error */ }
  if (total === 0) return null;
  const out = new Uint8Array(total);
  let o = 0;
  for (const c of chunks) { out.set(c, o); o += c.length; }
  return out;
}

// Just the first n inflated bytes (enough to recognise what a stream holds); stops reading as soon as it has them.
async function inflateHead(bytes: Uint8Array, n: number): Promise<string | null> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    const reader = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("deflate")).getReader();
    while (total < n) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value); total += value.length;
    }
    await reader.cancel();
  } catch (_e) { /* use what was read */ }
  if (total === 0) return null;
  const out = new Uint8Array(total);
  let o = 0;
  for (const c of chunks) { out.set(c, o); o += c.length; }
  return latin1(out.subarray(0, n));
}
const looksZlib = (b: Uint8Array) => b.length > 8 && b[0] === 0x78 && (b[1] === 0x01 || b[1] === 0x5e || b[1] === 0x9c || b[1] === 0xda);
const MAX_SNIFFED_STREAMS = 3000; // beyond this a PDF is refused rather than partly inspected

const PDF_RULES: [RegExp, string][] = [
  [/\/(JavaScript|JS)(?![A-Za-z0-9])/, "pdf_javascript"],
  [/javascript\s*:/i, "pdf_javascript"],
  [/\/(Launch|SubmitForm|ImportData|GoToR|GoToE)(?![A-Za-z0-9])/, "pdf_action"],
  [/\/(EmbeddedFile|EmbeddedFiles|FileAttachment|RichMedia)(?![A-Za-z0-9])/, "pdf_embedded"],
  [/\/XFA(?![A-Za-z0-9])/, "pdf_form_script"],
];
// PDF names may be written with #xx escapes (/J#61vaScript is /JavaScript): decode them before matching.
const decodeNames = (t: string) => t.replace(/#([0-9a-fA-F]{2})/g, (_m, h) => String.fromCharCode(parseInt(h, 16)));

async function scanPdf(b: Uint8Array, s: string): Promise<ScanFail | null> {
  if (/\/Encrypt(?![A-Za-z0-9])/.test(s)) return fail("pdf_encrypted");
  // Split the file into the text of its objects and the bodies of its streams. Compressed stream bodies are binary and would
  // false-match short names by chance, so the rules run on the object text and on inflated OBJECT STREAMS (where a PDF can hide objects).
  const objectText: string[] = [];
  const hidden: string[] = [];
  let pos = 0;
  let inflatedTotal = 0;
  let sniffedStreams = 0;
  const startRe = />>\s*stream(\r\n|\n|\r)/g;
  for (;;) {
    startRe.lastIndex = pos;
    const m = startRe.exec(s);
    if (!m) { objectText.push(s.slice(pos)); break; }
    const bodyStart = m.index + m[0].length;
    const end = s.indexOf("endstream", bodyStart);
    if (end < 0) return fail("damaged");
    objectText.push(s.slice(pos, bodyStart));
    // The dictionary of this stream: everything since the end of the previous object (an attacker can pad a dictionary, so no fixed window).
    const prevEnd = s.lastIndexOf("endobj", m.index);
    const dict = decodeNames(s.slice(prevEnd >= 0 ? prevEnd : 0, m.index + 2));
    let bodyEnd = end;
    while (bodyEnd > bodyStart && (s.charCodeAt(bodyEnd - 1) === 0x0a || s.charCodeAt(bodyEnd - 1) === 0x0d)) bodyEnd--;
    const body = b.subarray(bodyStart, bodyEnd);
    let isObjStm = /\/ObjStm(?![A-Za-z0-9])/.test(dict);
    let sniffed = false;
    if (!isObjStm && looksZlib(body)) {
      // Whatever the dictionary says, a stream that inflates to an object-stream index ("12 0 13 45 ...") is one.
      if (++sniffedStreams > MAX_SNIFFED_STREAMS) return fail("pdf_unscannable");
      const head = await inflateHead(body, 200);
      if (head && /^\s*(\d+\s+\d+\s+){1,}/.test(head)) { isObjStm = true; sniffed = true; }
    }
    if (isObjStm) {
      const fm = dict.match(/\/Filter\s*(\[[^\]]*\]|\/[A-Za-z0-9]+)/);
      const spec = fm ? fm[1].replace(/[\s\[\]]/g, "") : "";
      if (!sniffed && !fm) hidden.push(latin1(body));                                  // an uncompressed object stream: plain text
      else if (sniffed || spec === "/FlateDecode") {
        const out = await inflate(body, 15 * 1024 * 1024);
        if (!out) return fail("pdf_unscannable");
        inflatedTotal += out.length;
        if (inflatedTotal > 40 * 1024 * 1024) return fail("pdf_unscannable");
        hidden.push(latin1(out));
      } else return fail("pdf_unscannable");                                           // a filter we cannot decode: refuse rather than wave it through
    }
    pos = end;
  }
  const text = decodeNames(objectText.join("\n")) + "\n" + hidden.map(decodeNames).join("\n");
  for (const [re, code] of PDF_RULES) if (re.test(text)) return fail(code);
  return null;
}

function scanPng(b: Uint8Array): ScanFail | null {
  const u32 = (p: number) => ((b[p] << 24) | (b[p + 1] << 16) | (b[p + 2] << 8) | b[p + 3]) >>> 0;
  let p = 8, first = true, end = -1;
  while (p + 12 <= b.length) {
    const len = u32(p);
    const type = String.fromCharCode(b[p + 4], b[p + 5], b[p + 6], b[p + 7]);
    if (!/^[A-Za-z]{4}$/.test(type) || p + 12 + len > b.length) return fail("damaged");
    if (first && type !== "IHDR") return fail("damaged");
    first = false;
    p += 12 + len;
    if (type === "IEND") { end = p; break; }
  }
  if (end < 0) return fail("damaged");
  if (b.length - end > 16) return fail("image_trailing_data");
  return null;
}

function scanJpeg(b: Uint8Array): ScanFail | null {
  let i = b.length - 1;
  while (i > 0 && !(b[i - 1] === 0xff && b[i] === 0xd9)) i--;                          // the last end-of-image marker
  if (i <= 0) return fail("damaged");
  if (b.length - (i + 1) > 16) return fail("image_trailing_data");
  return null;
}

async function scanUpload(b: Uint8Array): Promise<ScanResult> {
  if (b.length === 0) return fail("empty");
  if (b.length > MAX_BYTES) return fail("too_large");
  const kind = sniffKind(b);
  if (!kind) return fail("bad_type");
  const s = latin1(b);
  const sig = scanSignatures(s);
  if (sig) return sig;
  let r: ScanFail | null;
  if (kind === "pdf") r = await scanPdf(b, s);
  else {
    if (/<script|<\?php|<iframe|<html|<svg|javascript\s*:|onerror\s*=/i.test(s)) return fail("image_script");
    r = kind === "png" ? scanPng(b) : scanJpeg(b);
  }
  if (r) return r;
  return kind === "pdf" ? { ok: true, kind, mime: "application/pdf", ext: "pdf" }
    : kind === "png" ? { ok: true, kind, mime: "image/png", ext: "png" }
    : { ok: true, kind, mime: "image/jpeg", ext: "jpg" };
}
// @@scanner-end

async function sha256Hex(data: Uint8Array | string): Promise<string> {
  const buf = typeof data === "string" ? new TextEncoder().encode(data) : data;
  const d = await crypto.subtle.digest("SHA-256", buf);
  return Array.from(new Uint8Array(d)).map((x) => x.toString(16).padStart(2, "0")).join("");
}
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
async function rows(path: string): Promise<any[]> {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, { headers: REST });
  return r.ok ? await r.json() : [];
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const TOKEN = /^[0-9a-fA-F]{64}$/;

// A display name only: no path, no control characters, short. It is never used to build a storage path.
function cleanName(raw: string, ext: string): string {
  const base = String(raw || "").split(/[\\/]/).pop() || "";
  const t = base.replace(/[^\w .()\-]/g, "").replace(/\s+/g, " ").trim().slice(0, 100);
  return t || `document.${ext}`;
}

export default {
  fetch: withSupabase({ auth: "none" }, async (req, _ctx) => {
    if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
    if (req.method !== "POST") return json({ ok: false, error: "method_not_allowed" }, 405);
    try {
      const len = Number(req.headers.get("content-length") || "0");
      if (len > MAX_BYTES + 512 * 1024) return json({ ok: false, error: "scan_failed", code: "too_large", message: SCAN_MESSAGES.too_large }, 413);
      let fd: FormData;
      try { fd = await req.formData(); } catch (_e) { return json({ ok: false, error: "bad_request" }, 400); }

      // ---- who is uploading (the same identities create_comparison_request checks again when the request is made)
      const mode = String(fd.get("mode") || "");
      let uploaderRef = "";
      if (mode === "org") {
        const raw = String(fd.get("session_token") || "");
        if (!raw || raw.length > 200) return json({ ok: false, error: "invalid_session" }, 401);
        const sess = (await rows(`employer_sessions?token_hash=eq.${await sha256Hex(raw)}&select=employer_user_id,expires_at,revoked_at`))[0];
        if (!sess || sess.revoked_at || new Date(sess.expires_at) < new Date()) return json({ ok: false, error: "invalid_session" }, 401);
        const user = (await rows(`employer_users?id=eq.${sess.employer_user_id}&select=id,org_id`))[0];
        if (!user || !user.org_id) return json({ ok: false, error: "forbidden" }, 403);
        uploaderRef = user.id;
      } else if (mode === "employer") {
        // Gap #22 (2026-09-26): the direct-request path (request_comparison_direct, employer-api.ts) has no
        // employer_lookup_requests row to prove ownership by (that is the whole point -- it is not reached
        // via any prior lookup). Same session-based identity as 'org' above, minus the org_id requirement,
        // since a pay-per-use (no-org) employer must be able to use this path too.
        const raw = String(fd.get("session_token") || "");
        if (!raw || raw.length > 200) return json({ ok: false, error: "invalid_session" }, 401);
        const sess = (await rows(`employer_sessions?token_hash=eq.${await sha256Hex(raw)}&select=employer_user_id,expires_at,revoked_at`))[0];
        if (!sess || sess.revoked_at || new Date(sess.expires_at) < new Date()) return json({ ok: false, error: "invalid_session" }, 401);
        const user = (await rows(`employer_users?id=eq.${sess.employer_user_id}&select=id`))[0];
        if (!user) return json({ ok: false, error: "forbidden" }, 403);
        uploaderRef = user.id;
      } else if (mode === "guest") {
        const lookupId = String(fd.get("lookup_id") || "");
        const claim = String(fd.get("claim_token") || "");
        if (!UUID.test(lookupId) || !TOKEN.test(claim)) return json({ ok: false, error: "unavailable" }, 409);
        const l = (await rows(`employer_lookup_requests?id=eq.${lookupId}&select=id,claim_token_hash,result_exists,used_at,matched_candidate_id`))[0];
        const claimHash = await sha256Hex(claim.toLowerCase());
        if (!l || !l.claim_token_hash || !safeEqual(l.claim_token_hash, claimHash) || l.result_exists !== true || !l.used_at || !l.matched_candidate_id
          || new Date(l.used_at).getTime() < Date.now() - 30 * 24 * 3600 * 1000) return json({ ok: false, error: "unavailable" }, 409);
        uploaderRef = l.id;
      } else return json({ ok: false, error: "bad_request" }, 400);

      // ---- disclosure
      if (String(fd.get("consent") || "") !== "true") return json({ ok: false, error: "consent_required" }, 400);

      // ---- a few unused uploads per person per hour
      const since = encodeURIComponent(new Date(Date.now() - 3600 * 1000).toISOString());
      const recent = await rows(`comparison_request_documents?uploader_kind=eq.${mode}&uploader_ref=eq.${uploaderRef}&created_at=gte.${since}&request_id=is.null&select=id`);
      if (recent.length >= UNBOUND_UPLOADS_PER_HOUR) return json({ ok: false, error: "too_many_uploads" }, 429);

      // ---- the file
      const f = fd.get("file");
      if (!f || typeof f === "string") return json({ ok: false, error: "file_required" }, 400);
      if ((f as File).size > MAX_BYTES) return json({ ok: false, error: "scan_failed", code: "too_large", message: SCAN_MESSAGES.too_large }, 422);
      const bytes = new Uint8Array(await (f as File).arrayBuffer());
      const scan = await scanUpload(bytes);
      if (!scan.ok) return json({ ok: false, error: "scan_failed", code: scan.code, message: scan.message }, 422);

      // ---- store the exact bytes, then the row
      const id = crypto.randomUUID();
      const path = `${id}.${scan.ext}`;
      const storage = createClient(SUPABASE_URL, SERVICE_KEY).storage.from(BUCKET);
      const up = await storage.upload(path, bytes, { contentType: scan.mime, upsert: false });
      if (up.error) return json({ ok: false, error: "store_failed" }, 502);
      const now = new Date();
      const name = cleanName((f as File).name, scan.ext);
      const ins = await fetch(`${SUPABASE_URL}/rest/v1/comparison_request_documents`, {
        method: "POST", headers: { ...REST, "Content-Type": "application/json", "Prefer": "return=minimal" },
        body: JSON.stringify({
          id, storage_path: path, content_type: scan.mime, byte_size: bytes.length, sha256: await sha256Hex(bytes), file_name: name,
          uploader_kind: mode, uploader_ref: uploaderRef, consent_at: now.toISOString(), consent_version: CONSENT_VERSION,
          purge_after: new Date(now.getTime() + 3600 * 1000).toISOString(),
        }),
      });
      if (!ins.ok) { await storage.remove([path]); return json({ ok: false, error: "store_failed" }, 502); }
      return json({ ok: true, document_id: id, file_name: name, content_type: scan.mime, byte_size: bytes.length, retention_days: 21 });
    } catch (e) {
      return json({ ok: false, error: "unhandled", detail: String(e).slice(0, 200) }, 500);
    }
  }),
};
