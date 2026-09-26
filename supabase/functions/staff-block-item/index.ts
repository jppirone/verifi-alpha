// Setup type definitions for built-in Supabase Runtime APIs
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { withSupabase } from "jsr:@supabase/server@1";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "content-type",
};

// STAFF CONTENT-BLOCK (2026-09-26): staff authority to block content anywhere in the system, with a
// short instructional reason back to the candidate. Universal (any field, any category), full block
// (excluded from the delivered PDF / Customization / Content Manager / any employer comparison output /
// normal verification-item counting -- see assemble_customized_resume, assembleResumeSnapshot in
// candidate-comparison-requests, and list-candidate-verification-items' own comments for where each of
// those is enforced; this function only ever writes the four staff_block_* columns and a
// staff_block_events row -- it does not itself gate any read path).
//
//   search_candidates  {query}                            admin only. Same candidate-search convention
//                      already used by staff-employer-documents (id, or a name/email fragment).
//   list_candidate_items {candidate_id}                    admin only. Every confirmed item across all
//                      five tables for one candidate, whether or not it was ever queued for
//                      verification -- this is the "find candidate -> find item" entry point for an
//                      item that has no verification_items row at all (the one gap a badge on the
//                      normal queue could never reach).
//   block   {candidate_id, item_kind, item_id, reason_code, note}
//   unblock {candidate_id, item_kind, item_id}              a manual override -- the normal path is the
//                      automatic clear on a resubmission that actually changes or removes the item (see
//                      apply_resume_resubmission's own header); this exists for a staff correction or a
//                      mistaken block, not for routine use.
//   history {candidate_id, item_kind, item_id}              the staff_block_events trail for one item.
//
// SCOPING for block/unblock/history: admin (or service) can act on anything. A worker can act only on
// an item that already has a verification_items row assigned to them -- same "only what's assigned to
// you" rule the rest of the staff role policy already enforces (see list-verification-items' own
// header). An item with NO queue row at all (never opted into verification) has no "assigned to me"
// concept, so only admin/service can block/unblock/view history for one -- same reasoning as
// list_candidate_items being admin-only.
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const REST = { "apikey": SUPABASE_SERVICE_ROLE_KEY, "Authorization": `Bearer ${SUPABASE_SERVICE_ROLE_KEY}` };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });

async function rows(path: string): Promise<any[]> {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, { headers: REST });
  return r.ok ? await r.json() : [];
}
async function patch(path: string, body: unknown): Promise<any[]> {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, { method: "PATCH", headers: { ...REST, "Content-Type": "application/json", "Prefer": "return=representation" }, body: JSON.stringify(body) });
  return r.ok ? await r.json() : [];
}

// ---------------------------------------------------------------------------------------------------
// CALLER AUTHENTICATION (same pattern as list-verification-items' own header).
// ---------------------------------------------------------------------------------------------------
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
async function authenticate(req: Request, body: any): Promise<AuthCaller | null> {
  const h = req.headers.get("authorization") || "";
  const t = h.toLowerCase().startsWith("bearer ") ? h.slice(7).trim() : "";
  if (t && SUPABASE_SERVICE_ROLE_KEY && authSafeEqual(t, SUPABASE_SERVICE_ROLE_KEY)) return { kind: "service" };
  const tok = typeof body?.staff_session_token === "string" ? body.staff_session_token : "";
  if (tok.length >= 20 && tok.length <= 200) {
    const sess = (await rows(`staff_sessions?token_hash=eq.${await authSha256Hex(tok)}&select=staff_user_id,expires_at,revoked_at`))[0];
    if (sess && !sess.revoked_at && new Date(sess.expires_at).getTime() > Date.now()) {
      const u = (await rows(`staff_users?id=eq.${sess.staff_user_id}&select=id,email,name,role`))[0];
      if (u) return { kind: "staff", id: u.id, email: u.email, name: u.name, role: u.role };
    }
  }
  return null;
}
const isAdminCaller = (c: AuthCaller) => c.kind === "service" || (c.kind === "staff" && c.role === "admin");
const callerName = (c: AuthCaller) => c.kind === "service" ? "system" : c.name;

const KIND_TABLE: Record<string, string> = {
  work_history: "work_history_items", education: "education_items", certification: "certification_items",
  skill: "skill_items", freeform: "candidate_freeform_sections",
};
// Closed set, never free text: see this function's own header on why the candidate-facing reason is a
// fixed choice, not something a staff member types.
const REASON_CODES = new Set(["needs_correction", "resubmit_required"]);

// A worker may act on an item only if it already has a verification_items row assigned to them; an
// item with no queue row at all has no "assigned to me" concept for a worker to be scoped by.
async function workerOwnsItem(itemId: string, workerName: string): Promise<boolean> {
  const vq = await rows(`verification_items?source_item_id=eq.${itemId}&select=assigned_to&limit=1`);
  return !!vq.length && vq[0].assigned_to === workerName;
}

export default {
  fetch: withSupabase({ auth: "none" }, async (req, _ctx) => {
    if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
    if (req.method !== "POST") return json({ ok: false, error: "method_not_allowed" }, 405);
    let body: any = {};
    try { body = await req.json(); } catch (_e) { body = {}; }
    const caller = await authenticate(req, body);
    if (!caller) return json({ ok: false, error: "unauthorized" }, 401);
    try {
      const action = typeof body.action === "string" ? body.action : "";

      if (action === "search_candidates") {
        if (!isAdminCaller(caller)) return json({ ok: false, error: "forbidden" }, 403);
        const raw = typeof body.query === "string" ? body.query.trim() : "";
        if (raw.length < 2 || raw.length > 100) return json({ ok: false, error: "query_invalid" }, 400);
        let cands: any[] = [];
        if (UUID.test(raw)) {
          cands = await rows(`candidates?id=eq.${raw.toLowerCase()}&select=id,full_name,first_name,last_name,email`);
        } else {
          const q = raw.replace(/[^A-Za-z0-9 .'@+_-]/g, " ").replace(/\s+/g, " ").trim();
          if (q.length < 2) return json({ ok: false, error: "query_invalid" }, 400);
          const enc = (v: string) => encodeURIComponent(`*${v}*`);
          const toks = q.split(" ").filter(Boolean);
          const conds = [`full_name.ilike.${enc(q)}`, `first_name.ilike.${enc(q)}`, `last_name.ilike.${enc(q)}`, `email.ilike.${enc(q)}`];
          if (toks.length >= 2) conds.push(`and(first_name.ilike.${enc(toks[0])},last_name.ilike.${enc(toks[toks.length - 1])})`);
          cands = await rows(`candidates?or=(${conds.join(",")})&select=id,full_name,first_name,last_name,email&order=created_at.desc&limit=20`);
        }
        return json({ ok: true, candidates: cands.map((c) => ({ id: c.id, name: [c.first_name, c.last_name].filter(Boolean).join(" ") || c.full_name || null, email: c.email })) });
      }

      if (action === "list_candidate_items") {
        if (!isAdminCaller(caller)) return json({ ok: false, error: "forbidden" }, 403);
        const candidateId = typeof body.candidate_id === "string" ? body.candidate_id : "";
        if (!UUID.test(candidateId)) return json({ ok: false, error: "candidate_id_invalid" }, 400);
        const base = `candidate_id=eq.${candidateId}&candidate_confirmed=eq.true`;
        const [work, edu, certs, skills, free, vq] = await Promise.all([
          rows(`work_history_items?${base}&select=id,company,title,staff_blocked_at,staff_block_reason_code`),
          rows(`education_items?${base}&select=id,institution,degree,staff_blocked_at,staff_block_reason_code`),
          rows(`certification_items?${base}&select=id,name,issuing_body,staff_blocked_at,staff_block_reason_code`),
          rows(`skill_items?${base}&select=id,skill_text,staff_blocked_at,staff_block_reason_code`),
          rows(`candidate_freeform_sections?${base}&select=id,section_type,heading,content,staff_blocked_at,staff_block_reason_code`),
          rows(`verification_items?candidate_id=eq.${candidateId}&select=id,source_item_id,status,assigned_to`),
        ]);
        const vqBySource = new Map(vq.filter((v: any) => v.source_item_id).map((v: any) => [v.source_item_id as string, v]));
        const mk = (kind: string, id: string, label: string, blockedAt: string | null, reasonCode: string | null) => {
          const q = vqBySource.get(id);
          return {
            item_kind: kind, item_id: id, label,
            blocked: !!blockedAt, blocked_at: blockedAt || null, reason_code: reasonCode || null,
            queue_item_id: q ? q.id : null, queue_status: q ? q.status : null, assigned_to: q ? q.assigned_to : null,
          };
        };
        const items = [
          ...work.map((w: any) => mk("work_history", w.id, [w.title, w.company].filter(Boolean).join(", ") || "(no title)", w.staff_blocked_at, w.staff_block_reason_code)),
          ...edu.map((e: any) => mk("education", e.id, [e.degree, e.institution].filter(Boolean).join(", ") || "(no degree)", e.staff_blocked_at, e.staff_block_reason_code)),
          ...certs.map((c: any) => mk("certification", c.id, [c.name, c.issuing_body].filter(Boolean).join(", ") || "(no name)", c.staff_blocked_at, c.staff_block_reason_code)),
          ...skills.map((s: any) => mk("skill", s.id, s.skill_text || "(no text)", s.staff_blocked_at, s.staff_block_reason_code)),
          ...free.map((f: any) => mk("freeform", f.id, [f.heading, (f.content || "").replace(/\s+/g, " ").trim().slice(0, 80)].filter(Boolean).join(": ") || "(no content)", f.staff_blocked_at, f.staff_block_reason_code)),
        ];
        return json({ ok: true, items });
      }

      // ---- block / unblock / history: candidate_id + item_kind + item_id required, worker-scoped ----
      const candidateId = typeof body.candidate_id === "string" ? body.candidate_id : "";
      const itemKind = typeof body.item_kind === "string" ? body.item_kind : "";
      const itemId = typeof body.item_id === "string" ? body.item_id : "";
      if (action === "block" || action === "unblock" || action === "history") {
        if (!UUID.test(candidateId) || !UUID.test(itemId) || !KIND_TABLE[itemKind]) return json({ ok: false, error: "invalid_item" }, 400);
        if (!isAdminCaller(caller) && !(await workerOwnsItem(itemId, caller.name))) return json({ ok: false, error: "forbidden" }, 403);
        const tbl = KIND_TABLE[itemKind];
        const owned = (await rows(`${tbl}?id=eq.${itemId}&candidate_id=eq.${candidateId}&select=id`)).length > 0;
        if (!owned) return json({ ok: false, error: "item_not_found" }, 404);

        if (action === "history") {
          const events = await rows(`staff_block_events?candidate_id=eq.${candidateId}&item_kind=eq.${itemKind}&item_id=eq.${itemId}&select=event_date,actor,action,reason_code,note&order=event_date.asc`);
          return json({ ok: true, events });
        }

        if (action === "block") {
          const reasonCode = typeof body.reason_code === "string" ? body.reason_code : "";
          const note = typeof body.note === "string" ? body.note.trim().slice(0, 1000) : "";
          if (!REASON_CODES.has(reasonCode)) return json({ ok: false, error: "reason_code_invalid" }, 400);
          if (!note) return json({ ok: false, error: "note_required" }, 400);
          const nowIso = new Date().toISOString();
          const updated = await patch(`${tbl}?id=eq.${itemId}&candidate_id=eq.${candidateId}`, {
            staff_blocked_at: nowIso, staff_blocked_by: caller.kind === "staff" ? caller.id : null,
            staff_block_note: note, staff_block_reason_code: reasonCode,
          });
          if (!updated.length) return json({ ok: false, error: "update_failed" }, 500);
          await fetch(`${SUPABASE_URL}/rest/v1/staff_block_events`, {
            method: "POST", headers: { ...REST, "Content-Type": "application/json" },
            body: JSON.stringify({ candidate_id: candidateId, item_kind: itemKind, item_id: itemId, actor: callerName(caller), action: "blocked", reason_code: reasonCode, note }),
          });
          return json({ ok: true });
        }

        if (action === "unblock") {
          const updated = await patch(`${tbl}?id=eq.${itemId}&candidate_id=eq.${candidateId}`, {
            staff_blocked_at: null, staff_blocked_by: null, staff_block_note: null, staff_block_reason_code: null,
          });
          if (!updated.length) return json({ ok: false, error: "update_failed" }, 500);
          await fetch(`${SUPABASE_URL}/rest/v1/staff_block_events`, {
            method: "POST", headers: { ...REST, "Content-Type": "application/json" },
            body: JSON.stringify({ candidate_id: candidateId, item_kind: itemKind, item_id: itemId, actor: callerName(caller), action: "cleared_manually", reason_code: null, note: null }),
          });
          return json({ ok: true });
        }
      }

      return json({ ok: false, error: "unknown_action" }, 400);
    } catch (e) {
      return json({ ok: false, error: String(e) }, 500);
    }
  }),
};
