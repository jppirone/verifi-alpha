// Setup type definitions for built-in Supabase Runtime APIs
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { withSupabase } from "jsr:@supabase/server@1";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "content-type, authorization, apikey",
};

// save-customization (2026-09-21): the ONE write path for candidate customization. POST { candidate_id, session_token, base_version, ops: [...] }.
//
// What can be changed (an operation list; anything else is rejected, never ignored):
//   { op:"include", kind, item_id, included }                     kind: work | education | certification | skill | skill_added | freeform
//   { op:"text", kind, item_id, field, value }                    work + field "job_responsibilities"; skill | skill_added + field "skill_text"; value null = back to the extracted text
//   { op:"add_skill", text }   { op:"remove_added_skill", item_id }
//   { op:"summary", mode:"default"|"none"|"version", summary_id? }
//   { op:"contact", printed_phone?, printed_email? }               a present key is set (empty string or null = cleared); an absent key is untouched
//   { op:"reset_items" }
// LOCKED to the verified data (company, title, dates, location, institution, degree, field of study, certification name / issuer / license fields, headings,
// positions, anything about verification): naming one of them in an operation, or asking for a text edit on a kind that has no editable text, is refused with
// 422 field_locked and NOTHING in the request is applied (the whole request is validated first, then written in a single database transaction).
// Concurrency: base_version must equal the current version (409 version_conflict returns the current one). Tier: paid only (403 tier_required).
// Auth: the candidate's OWN live session, or the service-role key. Anything else is the same 401.
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const REST = { "apikey": SERVICE_KEY, "Authorization": `Bearer ${SERVICE_KEY}`, "Content-Type": "application/json" };
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_BODY = 400_000;
const MAX_OPS = 200;
const MAX_DESCRIPTION = 8000;
const MAX_SKILL = 100;

// Names that always mean "a field the candidate may not change". (Unknown names are refused too, as unknown_field.)
const LOCKED = new Set([
  "company", "employer", "employer_name", "employer_name_override", "employer_location_override", "title", "location", "start", "end", "start_date", "end_date",
  "start_date_precision", "end_date_precision", "current", "institution", "degree", "field_of_study", "name", "issuer", "issuing_body", "issued", "issue_date", "expiration_date",
  "license_number", "license_state", "state", "heading", "position", "section_type", "content", "job_title", "verification", "status", "verified", "verified_on", "method",
  "extraction_confidence", "candidate_confirmed", "resume_document_id", "candidate_id", "contact_phone", "contact_name", "source_match", "trade_soc_code", "issuer_category",
]);
const OP_KEYS: Record<string, string[]> = {
  include: ["op", "kind", "item_id", "included"],
  text: ["op", "kind", "item_id", "field", "value"],
  add_skill: ["op", "text"],
  remove_added_skill: ["op", "item_id"],
  summary: ["op", "mode", "summary_id"],
  contact: ["op", "printed_phone", "printed_email"],
  reset_items: ["op"],
};
const INCLUDE_KINDS = new Set(["work", "education", "certification", "skill", "skill_added", "freeform"]);
const TEXT_FIELD: Record<string, string> = { work: "job_responsibilities", skill: "skill_text", skill_added: "skill_text" };
const LOCKED_TEXT_KINDS = new Set(["education", "certification", "freeform"]);

async function sha256Hex(s: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return Array.from(new Uint8Array(d)).map((b) => b.toString(16).padStart(2, "0")).join("");
}
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
function isServiceCaller(req: Request): boolean {
  const h = req.headers.get("authorization") || "";
  const t = h.toLowerCase().startsWith("bearer ") ? h.slice(7).trim() : "";
  return !!t && !!SERVICE_KEY && safeEqual(t, SERVICE_KEY);
}
async function isCandidateSession(body: any, candidateId: string): Promise<boolean> {
  const tok = typeof body?.session_token === "string" ? body.session_token : "";
  if (tok.length < 20 || tok.length > 200 || !candidateId) return false;
  const r = await fetch(`${SUPABASE_URL}/rest/v1/candidate_sessions?token_hash=eq.${await sha256Hex(tok)}&select=candidate_id,expires_at,revoked_at`, { headers: REST });
  const sess = r.ok ? (await r.json())[0] : null;
  return !!sess && !sess.revoked_at && new Date(sess.expires_at).getTime() > Date.now() && sess.candidate_id === candidateId;
}
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });

class Reject extends Error {
  constructor(public status: number, public code: string, public extra: Record<string, unknown> = {}) { super(code); }
}

// Control characters other than tab and (where allowed) newline are refused, not stripped: the candidate is told rather than silently altered.
// Built from char codes so no control character is ever written into this file.
const CTRL_KEEP_NL = new RegExp("[" + String.fromCharCode(0) + "-" + String.fromCharCode(8) + String.fromCharCode(11) + String.fromCharCode(12) + String.fromCharCode(14) + "-" + String.fromCharCode(31) + String.fromCharCode(127) + "]");
const CTRL_NO_NL = new RegExp("[" + String.fromCharCode(0) + "-" + String.fromCharCode(8) + String.fromCharCode(10) + "-" + String.fromCharCode(31) + String.fromCharCode(127) + "]");
const hasBadControl = (s: string, allowNewline: boolean) => (allowNewline ? CTRL_KEEP_NL : CTRL_NO_NL).test(s);

function checkOp(raw: any, idx: number): Record<string, unknown> {
  const at = { op_index: idx };
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Reject(400, "bad_op", at);
  const name = raw.op;
  if (typeof name !== "string" || !OP_KEYS[name]) throw new Reject(400, "bad_op", at);
  for (const k of Object.keys(raw)) {
    if (OP_KEYS[name].includes(k)) continue;
    throw new Reject(422, LOCKED.has(k) ? "field_locked" : "unknown_field", { ...at, field: k });
  }
  const out: Record<string, unknown> = { op: name };
  const uuid = (k: string) => { if (typeof raw[k] !== "string" || !UUID_RE.test(raw[k])) throw new Reject(400, "bad_item_id", at); return raw[k].toLowerCase(); };

  if (name === "include") {
    if (typeof raw.kind !== "string" || !INCLUDE_KINDS.has(raw.kind)) throw new Reject(400, "bad_kind", at);
    if (typeof raw.included !== "boolean") throw new Reject(400, "bad_value", { ...at, field: "included" });
    out.kind = raw.kind; out.item_id = uuid("item_id"); out.included = raw.included;
  } else if (name === "text") {
    if (typeof raw.kind !== "string" || !INCLUDE_KINDS.has(raw.kind)) throw new Reject(400, "bad_kind", at);
    if (LOCKED_TEXT_KINDS.has(raw.kind)) throw new Reject(422, "field_locked", { ...at, field: "text", kind: raw.kind });
    if (typeof raw.field !== "string") throw new Reject(400, "bad_value", { ...at, field: "field" });
    if (raw.field !== TEXT_FIELD[raw.kind]) throw new Reject(422, LOCKED.has(raw.field) ? "field_locked" : "unknown_field", { ...at, field: raw.field });
    out.kind = raw.kind; out.item_id = uuid("item_id");
    if (raw.value === null) {
      if (raw.kind === "skill_added") throw new Reject(400, "bad_value", { ...at, field: "value" });
      out.value = null;
    } else if (typeof raw.value !== "string") {
      throw new Reject(400, "bad_value", { ...at, field: "value" });
    } else if (raw.kind === "work") {
      const v = raw.value.replace(/\r\n?/g, "\n").trim();
      if (hasBadControl(v, true)) throw new Reject(422, "text_invalid", { ...at, field: "value" });
      if (v.length > MAX_DESCRIPTION) throw new Reject(422, "text_too_long", { ...at, field: "value", max: MAX_DESCRIPTION });
      out.value = v;
    } else {
      const v = raw.value.trim().replace(/\s+/g, " ");
      if (hasBadControl(v, false)) throw new Reject(422, "text_invalid", { ...at, field: "value" });
      if (v.length < 1) throw new Reject(422, "text_empty", { ...at, field: "value" });
      if (v.length > MAX_SKILL) throw new Reject(422, "text_too_long", { ...at, field: "value", max: MAX_SKILL });
      out.value = v;
    }
  } else if (name === "add_skill") {
    if (typeof raw.text !== "string") throw new Reject(400, "bad_value", { ...at, field: "text" });
    const v = raw.text.trim().replace(/\s+/g, " ");
    if (hasBadControl(v, false)) throw new Reject(422, "text_invalid", { ...at, field: "text" });
    if (v.length < 1) throw new Reject(422, "text_empty", { ...at, field: "text" });
    if (v.length > MAX_SKILL) throw new Reject(422, "text_too_long", { ...at, field: "text", max: MAX_SKILL });
    out.text = v;
  } else if (name === "remove_added_skill") {
    out.item_id = uuid("item_id");
  } else if (name === "summary") {
    if (raw.mode !== "default" && raw.mode !== "none" && raw.mode !== "version") throw new Reject(400, "bad_value", { ...at, field: "mode" });
    out.mode = raw.mode;
    if (raw.mode === "version") out.summary_id = uuid("summary_id");
    else if (raw.summary_id !== undefined && raw.summary_id !== null) throw new Reject(400, "bad_value", { ...at, field: "summary_id" });
  } else if (name === "contact") {
    if (!("printed_phone" in raw) && !("printed_email" in raw)) throw new Reject(400, "bad_op", at);
    if ("printed_phone" in raw) {
      if (raw.printed_phone !== null && typeof raw.printed_phone !== "string") throw new Reject(400, "bad_value", { ...at, field: "printed_phone" });
      const v = raw.printed_phone === null ? "" : raw.printed_phone.trim();
      if (v !== "") {
        const digits = v.replace(/\D/g, "");
        if (v.length > 40 || !/^[0-9+()\-.\sxX#]+$/.test(v) || digits.length < 7 || digits.length > 20) throw new Reject(422, "phone_invalid", { ...at, field: "printed_phone" });
      }
      out.printed_phone = v === "" ? null : v;
    }
    if ("printed_email" in raw) {
      if (raw.printed_email !== null && typeof raw.printed_email !== "string") throw new Reject(400, "bad_value", { ...at, field: "printed_email" });
      const v = raw.printed_email === null ? "" : raw.printed_email.trim();
      if (v !== "" && (v.length > 254 || !/^[^\s@<>()[\]\\,;:"]{1,64}@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/.test(v))) throw new Reject(422, "email_invalid", { ...at, field: "printed_email" });
      out.printed_email = v === "" ? null : v;
    }
  }
  return out;
}

const RPC_STATUS: Record<string, number> = {
  tier_required: 403, account_deactivated: 403, not_full_resume: 403, candidate_not_found: 404, item_not_found: 404,
  version_conflict: 409, skill_cap: 422, field_locked: 422, bad_ops: 400, bad_op: 400, bad_kind: 400, bad_item_id: 400, bad_value: 400,
};

export default {
  fetch: withSupabase({ auth: "none" }, async (req, _ctx) => {
    if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
    try {
      const text = await req.text();
      if (text.length > MAX_BODY) return json({ ok: false, error: "too_large" }, 413);
      let body: any = {};
      try { body = JSON.parse(text); } catch (_e) { body = {}; }
      const candidateId = typeof body?.candidate_id === "string" ? body.candidate_id : "";
      if (!(isServiceCaller(req) || (UUID_RE.test(candidateId) && await isCandidateSession(body, candidateId)))) return json({ ok: false, error: "unauthorized" }, 401);
      if (!UUID_RE.test(candidateId)) return json({ ok: false, error: "candidate_id_required" }, 400);

      if (!Number.isInteger(body.base_version) || body.base_version < 0) return json({ ok: false, error: "base_version_required" }, 400);
      if (!Array.isArray(body.ops) || body.ops.length < 1 || body.ops.length > MAX_OPS) return json({ ok: false, error: "bad_ops" }, 400);
      let ops: Record<string, unknown>[];
      try { ops = body.ops.map((o: unknown, i: number) => checkOp(o, i + 1)); }
      catch (e) { if (e instanceof Reject) return json({ ok: false, error: e.code, ...e.extra }, e.status); throw e; }

      const r = await fetch(`${SUPABASE_URL}/rest/v1/rpc/apply_customization_ops`, {
        method: "POST", headers: REST,
        body: JSON.stringify({ p_candidate: candidateId, p_base_version: body.base_version, p_ops: ops }),
      });
      if (!r.ok) {
        const err = await r.json().catch(() => ({}));
        const code = typeof err?.message === "string" ? err.message : "";
        if (RPC_STATUS[code]) {
          const extra: Record<string, unknown> = {};
          if (code === "version_conflict") extra.current_version = Number(err.details);
          else if (err.hint && /^\d+$/.test(String(err.hint))) extra.op_index = Number(err.hint);
          return json({ ok: false, error: code, ...extra }, RPC_STATUS[code]);
        }
        return json({ ok: false, error: "save_failed" }, 500);
      }
      const result = await r.json();
      const a = await fetch(`${SUPABASE_URL}/rest/v1/rpc/assemble_customized_resume`, {
        method: "POST", headers: REST, body: JSON.stringify({ p_candidate: candidateId, p_ignore_overrides: false, p_delivered_only: false }),
      });
      return json({ ok: true, version: result?.version, resume: a.ok ? await a.json() : null });
    } catch (_e) {
      return json({ ok: false, error: "unhandled" }, 500);
    }
  }),
};
