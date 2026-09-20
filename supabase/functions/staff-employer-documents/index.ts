// Setup type definitions for built-in Supabase Runtime APIs
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { withSupabase } from "jsr:@supabase/server@1";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
};

// STAFF VIEW OF EMPLOYER DOCUMENTS (2026-09-20). Closes the abuse-handling gap left by the employer-document build: an employer's uploaded
// document is stored for 21 days and only the candidate could see it. This is the staff side, for investigating abuse.
//
//   search {query}      a candidate id (uuid) or a name / email fragment -> the matching candidates (up to 20), each with the requests that
//                       qualify: APPROVED by the candidate (approved_at is set; that includes an approval whose employer access has since
//                       ended) AND whose document is still stored. Nothing pending, declined, expired-unanswered or without a document.
//   link   {request_id} a 60-second signed link to that document, for a request that qualifies under the same rule; the view is recorded
//                       in staff_employer_document_views (who, which request, when; never file contents).
//
// THE LIST IS THE REAL STATE, NOT A COPY OF IT. It reads comparison_request_documents directly and keeps only rows whose purge_after is
// still in the future, so a document disappears from this page the moment retention ends (before the purge job has even removed the file)
// and there is no separate retention window here. A request without a document row (older than the document requirement, or purged) is
// simply not listed.
//
// ROLE: ADMIN ONLY, enforced here on every call from the staff_users row (never from the request). Why admin-only and not any staff session:
// (1) the existing staff role policy scopes a worker to the queue items ASSIGNED to them, and everything not tied to an assignment (the
// Reporting tab, the staff roster) is already admin-only; this page is cross-candidate by design (search any candidate), with no assignment to
// scope it by. (2) The files are third-party uploads about a candidate, possibly abusive or containing other people's data: least privilege.
// (3) It exists for abuse investigation, a narrow duty. A worker gets 403; no session gets 401.
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const REST = { "apikey": SERVICE_KEY, "Authorization": `Bearer ${SERVICE_KEY}` };
const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PATH_OK = /^[0-9a-f-]{36}\.(pdf|png|jpg)$/;

async function sha256Hex(s: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return Array.from(new Uint8Array(d)).map((b) => b.toString(16).padStart(2, "0")).join("");
}
async function rows(path: string): Promise<any[]> {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, { headers: REST });
  return r.ok ? await r.json() : [];
}
// A live STAFF session only (no service-role bypass: nothing internal calls this). Identity and role come from the database.
async function staffFromSession(body: any): Promise<{ id: string; email: string; name: string; role: string } | null> {
  const tok = typeof body?.staff_session_token === "string" ? body.staff_session_token : "";
  if (tok.length < 20 || tok.length > 200) return null;
  const sess = (await rows(`staff_sessions?token_hash=eq.${await sha256Hex(tok)}&select=staff_user_id,expires_at,revoked_at`))[0];
  if (!sess || sess.revoked_at || new Date(sess.expires_at).getTime() <= Date.now()) return null;
  const u = (await rows(`staff_users?id=eq.${sess.staff_user_id}&select=id,email,name,role`))[0];
  return u ? { id: u.id, email: u.email, name: u.name, role: u.role } : null;
}

// The ONE definition of "qualifies": approved by the candidate, and the file's row is still within its retention.
async function qualifyingRequests(candidateIds: string[], onlyRequestId?: string): Promise<any[]> {
  if (!candidateIds.length) return [];
  const idFilter = onlyRequestId ? `id=eq.${onlyRequestId}&` : "";
  const reqs = await rows(`comparison_requests?${idFilter}candidate_id=in.(${candidateIds.join(",")})&approved_at=not.is.null&select=id,candidate_id,requester_name,requester_company,requester_email,created_at,approved_at,status,kind,access_method&order=approved_at.desc&limit=300`);
  if (!reqs.length) return [];
  const nowIso = encodeURIComponent(new Date().toISOString());
  const docs = await rows(`comparison_request_documents?request_id=in.(${reqs.map((r) => r.id).join(",")})&purge_after=gt.${nowIso}&select=request_id,storage_path,file_name,content_type,byte_size,purge_after`);
  const byReq = new Map(docs.map((d) => [d.request_id, d]));
  return reqs.filter((r) => byReq.has(r.id)).map((r) => ({ req: r, doc: byReq.get(r.id) }));
}

export default {
  fetch: withSupabase({ auth: "none" }, async (req, _ctx) => {
    if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
    if (req.method !== "POST") return json({ ok: false, error: "method_not_allowed" }, 405);
    let body: any = {};
    try { body = await req.json(); } catch (_e) { body = {}; }
    const staff = await staffFromSession(body);
    if (!staff) return json({ ok: false, error: "unauthorized" }, 401);
    if (staff.role !== "admin") return json({ ok: false, error: "forbidden" }, 403); // only the exact string 'admin' is privileged
    try {
      const action = typeof body.action === "string" ? body.action : "";

      if (action === "search") {
        const raw = typeof body.query === "string" ? body.query.trim() : "";
        if (raw.length < 2 || raw.length > 100) return json({ ok: false, error: "query_invalid" }, 400);
        let cands: any[] = [];
        if (UUID.test(raw)) {
          cands = await rows(`candidates?id=eq.${raw.toLowerCase()}&select=id,full_name,first_name,last_name,email`);
        } else {
          // name / email fragment. Only harmless characters reach the filter (no commas, parentheses, wildcards or quotes).
          const q = raw.replace(/[^A-Za-z0-9 .'@+_-]/g, " ").replace(/\s+/g, " ").trim();
          if (q.length < 2) return json({ ok: false, error: "query_invalid" }, 400);
          const enc = (v: string) => encodeURIComponent(`*${v}*`);
          const toks = q.split(" ").filter(Boolean);
          const conds = [`full_name.ilike.${enc(q)}`, `first_name.ilike.${enc(q)}`, `last_name.ilike.${enc(q)}`, `email.ilike.${enc(q)}`];
          if (toks.length >= 2) conds.push(`and(first_name.ilike.${enc(toks[0])},last_name.ilike.${enc(toks[toks.length - 1])})`);
          cands = await rows(`candidates?or=(${conds.join(",")})&select=id,full_name,first_name,last_name,email&order=created_at.desc&limit=20`);
        }
        const found = await qualifyingRequests(cands.map((c) => c.id));
        const out = cands.map((c) => ({
          candidate_id: c.id,
          name: [c.first_name, c.last_name].filter(Boolean).join(" ") || c.full_name || null,
          email: c.email,
          rows: found.filter((f) => f.req.candidate_id === c.id).map((f) => ({
            request_id: f.req.id,
            requester_name: f.req.requester_name,
            requester_company: f.req.requester_company,
            requester_email: f.req.requester_email,
            kind: f.req.kind,
            access_method: f.req.access_method,
            requested_at: f.req.created_at,
            approved_at: f.req.approved_at,
            status: f.req.status,            // 'approved', or 'expired' once the employer's access to the approved snapshot ended
            file_name: f.doc.file_name,
            content_type: f.doc.content_type,
            byte_size: f.doc.byte_size,
            available_until: f.doc.purge_after,
          })),
        }));
        return json({ ok: true, candidates: out });
      }

      if (action === "link") {
        if (typeof body.request_id !== "string" || !UUID.test(body.request_id)) return json({ ok: false, error: "request_id_invalid" }, 400);
        const one = (await rows(`comparison_requests?id=eq.${body.request_id.toLowerCase()}&select=candidate_id`))[0];
        // A request that does not qualify (pending, declined, unanswered, no document, past retention, or not there at all) is the same 404.
        const hit = one ? (await qualifyingRequests([one.candidate_id], body.request_id.toLowerCase()))[0] : null;
        if (!hit || !PATH_OK.test(hit.doc.storage_path)) return json({ ok: false, error: "not_found" }, 404);
        const sres = await fetch(`${SUPABASE_URL}/storage/v1/object/sign/employer-documents/${hit.doc.storage_path}`, {
          method: "POST", headers: { ...REST, "Content-Type": "application/json" }, body: JSON.stringify({ expiresIn: 60 }),
        });
        const sj = sres.ok ? await sres.json().catch(() => null) : null;
        if (!sj || typeof sj.signedURL !== "string") return json({ ok: false, error: "link_failed" }, 502);
        // the audit record: written before the link is handed out, and the link is withheld if it cannot be written
        const aud = await fetch(`${SUPABASE_URL}/rest/v1/staff_employer_document_views`, {
          method: "POST", headers: { ...REST, "Content-Type": "application/json", "Prefer": "return=minimal" },
          body: JSON.stringify({ staff_user_id: staff.id, staff_email: staff.email, request_id: hit.req.id, candidate_id: hit.req.candidate_id }),
        });
        if (!aud.ok) return json({ ok: false, error: "audit_failed" }, 500);
        return json({ ok: true, url: `${SUPABASE_URL}/storage/v1${sj.signedURL}`, expires_in: 60, file_name: hit.doc.file_name, content_type: hit.doc.content_type });
      }

      return json({ ok: false, error: "unknown_action" }, 400);
    } catch (e) {
      return json({ ok: false, error: "unhandled", detail: String(e).slice(0, 200) }, 500);
    }
  }),
};
