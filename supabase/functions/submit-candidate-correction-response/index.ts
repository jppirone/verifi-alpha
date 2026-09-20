// Setup type definitions for built-in Supabase Runtime APIs
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { withSupabase } from "jsr:@supabase/server@1";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "content-type",
};

// Candidate-facing write to verification_items — the first one that exists. Everything else that
// touches this table (update-verification-item, add-verification-timeline-entry) is staff-only,
// with no ownership check and no restriction on which columns get written, because nothing calling
// them today is anything but staff.html. This function is deliberately narrow in a way those are
// not: it writes exactly three columns (correction_requested, correction_note, correction_value),
// never touches status/assigned_to/note/internal_note/automated_check/anything else, and only ever
// after confirming the row's own candidate_id matches the caller's.
//
// Direction note (see this task's investigation): correction_requested/correction_note/
// correction_value were originally built for a candidate-originates -> staff-resolves flow
// (staff.html's Apply/Decline UI literally labels the note "Candidate's request"). That mechanism
// is direction-agnostic in practice — a candidate's response to a staff-raised discrepancy is the
// same shape (an optional proposed value, a note, a flag saying "staff needs to look at this") — so
// this reuses it rather than adding new columns. Staff resolves what lands here through the
// existing, already-real Apply/Decline flow; nothing about that UI needed to change.
//
// Deliberately a one-shot submission per open discrepancy: rejects if correction_requested is
// already true (candidate already responded, awaiting staff) so a second submit can't silently
// overwrite what staff is mid-review on. Once staff applies or declines, correction_requested goes
// back to false and the candidate can respond again if the item goes back to Discrepancy.
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

// ---------------------------------------------------------------------------------------------------
// CALLER AUTHENTICATION (candidate-session pass, 2026-09-19).
// This function used to act on whatever candidate_id the request body named, with no check that the caller was that
// candidate (or anyone at all beyond holding the PUBLIC anon key), so anyone who knew or guessed an id could read or
// change that account. It now requires one of:
//   * the service-role key as the bearer token (our own functions calling each other; exact match, constant-time); or
//   * the candidate's OWN live session: the session_token candidate.html holds, checked on every call against
//     candidate_sessions (hashed, unrevoked, unexpired) and required to belong to the candidate_id being acted on.
// Anything else is the same 401 whether the token was missing, wrong, expired, revoked or someone else's.
// ---------------------------------------------------------------------------------------------------
const AUTH_SB_URL = Deno.env.get("SUPABASE_URL")!;
const AUTH_SB_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
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
function authIsServiceCaller(req: Request): boolean {
  const h = req.headers.get("authorization") || "";
  const t = h.toLowerCase().startsWith("bearer ") ? h.slice(7).trim() : "";
  return !!t && !!AUTH_SB_KEY && authSafeEqual(t, AUTH_SB_KEY);
}
async function authIsCandidateSession(body: any, candidateId: string): Promise<boolean> {
  const tok = typeof body?.session_token === "string" ? body.session_token : "";
  if (tok.length < 20 || tok.length > 200 || !candidateId) return false;
  const rest = { "apikey": AUTH_SB_KEY, "Authorization": `Bearer ${AUTH_SB_KEY}` };
  const r = await fetch(`${AUTH_SB_URL}/rest/v1/candidate_sessions?token_hash=eq.${await authSha256Hex(tok)}&select=candidate_id,expires_at,revoked_at`, { headers: rest });
  const sess = r.ok ? (await r.json())[0] : null;
  return !!sess && !sess.revoked_at && new Date(sess.expires_at).getTime() > Date.now() && sess.candidate_id === candidateId;
}
const UNAUTHORIZED = () => new Response(JSON.stringify({ ok: false, error: "unauthorized" }), { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } });
async function authGateCandidate(req: Request, body: any): Promise<Response | null> {
  const cid = typeof body?.candidate_id === "string" ? body.candidate_id : "";
  if (authIsServiceCaller(req)) return null;
  if (cid && await authIsCandidateSession(body, cid)) return null;
  return UNAUTHORIZED();
}

// ---------------------------------------------------------------------------------------------------
// EDUCATION EDIT + NOTE (2026-09-20). A candidate whose Education row is waiting in review (typically a blank resume template:
// "[Field of Study], [Institution Name]") could neither fix it nor explain it. action "education_resubmit" lets them do either or both:
//   * edit the four printed fields (degree, field of study, institution, location) on their own education_items row, which rewrites the
//     queue claim exactly as confirm-resume-data builds it (dates untouched) and returns a non-New item to "New" so staff look again;
//   * leave a note (max 1000 chars) for staff, kept on verification_items.candidate_note (latest) and in the timeline (every one).
// Only an OPEN Education item of the caller's own can be touched: not one that is Confirmed / Unable to Verify (a result was reached) and
// not one at Discrepancy (that has its own respond flow above). Nothing is ever deleted; a blank-everything edit is refused.
// ---------------------------------------------------------------------------------------------------
const EDU_MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
function eduPrintDate(date: string | null | undefined, precision: string | null | undefined): string {
  if (precision === "present") return "Present";
  if (!date) return "";
  const m = String(date).match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return "";
  const p = precision === "year" || precision === "month" || precision === "day" ? precision
    : (m[2] === "01" && m[3] === "01" ? "year" : m[3] === "01" ? "month" : "day");
  if (p === "year") return m[1];
  const mon = EDU_MONTHS[Number(m[2]) - 1] ?? "";
  return p === "month" ? `${mon} ${m[1]}` : `${mon} ${Number(m[3])}, ${m[1]}`;
}
// Same shape as claimForEducation in confirm-resume-data.
function eduClaim(e: any): string {
  const dates = [eduPrintDate(e.start_date, e.start_date_precision), eduPrintDate(e.end_date, e.end_date_precision)].filter(Boolean).join(" – ");
  return [e.degree, e.field_of_study, e.institution, e.location, dates].filter(Boolean).join(", ");
}
const EDU_OPEN_STATUSES = new Set(["New", "In Progress", "Awaiting Response", "Needs Reconciliation"]);
const EDU_FIELD_MAX = 200;
const EDU_NOTE_MAX = 1000;
const EDU_CANDIDATE_EVENT_CAP = 20; // candidate-authored timeline entries per item: a flood guard, far above any honest use
const restH = { "Content-Type": "application/json", "apikey": SUPABASE_SERVICE_ROLE_KEY, "Authorization": "Bearer " + SUPABASE_SERVICE_ROLE_KEY };
const jsonOut = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });

async function educationResubmit(candidate_id: string, item_id: string, body: any): Promise<Response> {
  const cleanField = (v: unknown): string | null | "bad" => {
    if (v === undefined || v === null) return null; // not sent: leave as is
    if (typeof v !== "string") return "bad";
    const t = v.replace(/\s+/g, " ").trim();
    return t.length > EDU_FIELD_MAX ? "bad" : t;
  };
  const f = body?.fields && typeof body.fields === "object" ? body.fields : {};
  const incoming = { degree: cleanField(f.degree), field_of_study: cleanField(f.field_of_study), institution: cleanField(f.institution), location: cleanField(f.location) };
  if (Object.values(incoming).includes("bad")) return jsonOut({ ok: false, error: "invalid_field" }, 400);
  const rawNote = typeof body?.note === "string" ? body.note.trim() : "";
  if (rawNote.length > EDU_NOTE_MAX) return jsonOut({ ok: false, error: "note_too_long" }, 400);

  const itemRes = await fetch(SUPABASE_URL + "/rest/v1/verification_items?select=id,candidate_id,type,claim,status,source_item_id&id=eq." + encodeURIComponent(item_id), { headers: restH });
  if (!itemRes.ok) return jsonOut({ ok: false, error: "lookup_failed" }, 500);
  const item = (await itemRes.json())[0];
  // Same "not_found" for a missing item, someone else's item, or one that is not an Education item.
  if (!item || item.candidate_id !== candidate_id || item.type !== "Education" || !item.source_item_id) return jsonOut({ ok: false, error: "not_found" }, 404);
  if (!EDU_OPEN_STATUSES.has(item.status)) return jsonOut({ ok: false, error: "not_open_for_edit" }, 409);

  const eduRes = await fetch(SUPABASE_URL + "/rest/v1/education_items?select=id,institution,degree,field_of_study,location,start_date,end_date,start_date_precision,end_date_precision&candidate_id=eq."
    + encodeURIComponent(candidate_id) + "&id=eq." + encodeURIComponent(item.source_item_id), { headers: restH });
  const edu = eduRes.ok ? (await eduRes.json())[0] : null;
  if (!edu) return jsonOut({ ok: false, error: "not_found" }, 404);

  const next = {
    degree: incoming.degree === null ? (edu.degree ?? "") : incoming.degree,
    field_of_study: incoming.field_of_study === null ? (edu.field_of_study ?? "") : incoming.field_of_study,
    institution: incoming.institution === null ? (edu.institution ?? "") : incoming.institution,
    location: incoming.location === null ? (edu.location ?? "") : incoming.location,
  };
  const changed = (["degree", "field_of_study", "institution", "location"] as const).some((k) => (next[k] || "") !== (edu[k] || ""));
  if (!changed && !rawNote) return jsonOut({ ok: false, error: "nothing_to_submit" }, 400);
  if (changed && !next.degree && !next.field_of_study && !next.institution) return jsonOut({ ok: false, error: "empty_entry" }, 400);

  // Flood guard on candidate-authored timeline entries for this item.
  const cntRes = await fetch(SUPABASE_URL + "/rest/v1/verification_item_timeline?select=item_id&actor=eq.Candidate&item_id=eq." + encodeURIComponent(item_id), { headers: restH });
  if (cntRes.ok && (await cntRes.json()).length >= EDU_CANDIDATE_EVENT_CAP) return jsonOut({ ok: false, error: "too_many_updates" }, 429);

  const now = new Date().toISOString();
  const beforeClaim = item.claim || eduClaim(edu);
  let afterClaim = beforeClaim;
  let statusAfter = item.status;
  if (changed) {
    const upd = await fetch(SUPABASE_URL + "/rest/v1/education_items?id=eq." + encodeURIComponent(edu.id) + "&candidate_id=eq." + encodeURIComponent(candidate_id), {
      method: "PATCH", headers: { ...restH, "Prefer": "return=representation" },
      body: JSON.stringify({ degree: next.degree || null, field_of_study: next.field_of_study || null, institution: next.institution || null, location: next.location || null, updated_at: now }),
    });
    const updRows = upd.ok ? await upd.json() : [];
    if (!Array.isArray(updRows) || updRows.length !== 1) return jsonOut({ ok: false, error: "update_failed" }, 502);
    afterClaim = eduClaim({ ...edu, ...next });
    if (item.status !== "New") statusAfter = "New"; // back to intake so staff look at the new text
  }
  const patch: Record<string, unknown> = {};
  if (changed) { patch.claim = afterClaim; patch.status = statusAfter; }
  if (rawNote) { patch.candidate_note = rawNote; patch.candidate_note_at = now; }
  const q = await fetch(SUPABASE_URL + "/rest/v1/verification_items?id=eq." + encodeURIComponent(item_id) + "&candidate_id=eq." + encodeURIComponent(candidate_id), {
    method: "PATCH", headers: { ...restH, "Prefer": "return=representation" }, body: JSON.stringify(patch),
  });
  const qRows = q.ok ? await q.json() : [];
  if (!Array.isArray(qRows) || qRows.length !== 1) return jsonOut({ ok: false, error: "update_failed" }, 502);

  // Timeline, written server-side with a fixed actor (a candidate cannot choose who an entry is from).
  const bits: string[] = [];
  if (changed) bits.push("Before: " + beforeClaim + ". After: " + afterClaim + "." + (statusAfter !== item.status ? " Status was " + item.status + "; returned to New." : ""));
  if (rawNote) bits.push("Candidate's note: " + rawNote);
  await fetch(SUPABASE_URL + "/rest/v1/verification_item_timeline", {
    method: "POST", headers: { ...restH, "Prefer": "return=minimal" },
    body: JSON.stringify({ item_id, event_date: now, actor: "Candidate", action: changed ? "Candidate edited and resubmitted this education entry." : "Candidate added a note.", note: bits.join(" ") }),
  }).catch(() => {}); // best-effort: the change itself already persisted above

  return jsonOut({ ok: true, item: { id: item_id, claim: afterClaim, status: statusAfter, candidateNote: rawNote || null } });
}

export default {
  fetch: withSupabase({ auth: "none" }, async (req, _ctx) => {
    if (req.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }
    try {
      const authBody = await req.clone().json().catch(() => ({}));
      const authDenied = await authGateCandidate(req, authBody);
      if (authDenied) return authDenied;
      const reqBody = await req.json();
      const { candidate_id, item_id, corrected_value, note } = reqBody;
      if (!candidate_id || typeof candidate_id !== "string") {
        return new Response(JSON.stringify({ ok: false, error: "candidate_id_required" }), {
          status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      if (!item_id || typeof item_id !== "string") {
        return new Response(JSON.stringify({ ok: false, error: "item_id_required" }), {
          status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      if (reqBody.action === "education_resubmit") return await educationResubmit(candidate_id, item_id, reqBody);
      const trimmedValue = typeof corrected_value === "string" ? corrected_value.trim() : "";
      const trimmedNote = typeof note === "string" ? note.trim() : "";
      if (!trimmedValue && !trimmedNote) {
        return new Response(JSON.stringify({ ok: false, error: "response_required" }), {
          status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      const lookupUrl = SUPABASE_URL + "/rest/v1/verification_items?select=id,candidate_id,status,correction_requested&id=eq."
        + encodeURIComponent(item_id);
      const lookupRes = await fetch(lookupUrl, {
        headers: { "apikey": SUPABASE_SERVICE_ROLE_KEY, "Authorization": "Bearer " + SUPABASE_SERVICE_ROLE_KEY },
      });
      if (!lookupRes.ok) {
        return new Response(JSON.stringify({ ok: false, error: "lookup_failed" }), {
          status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      const rows = await lookupRes.json();
      const item = rows[0];
      // Same "not_found" for a missing item and an item that belongs to someone else — never
      // reveal to a caller which of the two it is.
      if (!item || item.candidate_id !== candidate_id) {
        return new Response(JSON.stringify({ ok: false, error: "not_found" }), {
          status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      if (item.status !== "Discrepancy") {
        return new Response(JSON.stringify({ ok: false, error: "not_open_for_response" }), {
          status: 409, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      if (item.correction_requested) {
        return new Response(JSON.stringify({ ok: false, error: "already_pending" }), {
          status: 409, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      const patchUrl = SUPABASE_URL + "/rest/v1/verification_items?id=eq." + encodeURIComponent(item_id);
      const patchRes = await fetch(patchUrl, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          "apikey": SUPABASE_SERVICE_ROLE_KEY,
          "Authorization": "Bearer " + SUPABASE_SERVICE_ROLE_KEY,
          "Prefer": "return=representation",
        },
        body: JSON.stringify({
          correction_requested: true,
          correction_note: trimmedNote || null,
          correction_value: trimmedValue || null,
        }),
      });
      if (!patchRes.ok) {
        const errText = await patchRes.text();
        return new Response(JSON.stringify({ ok: false, error: "update_failed", detail: errText }), {
          status: 502, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      const patched = await patchRes.json();
      if (!Array.isArray(patched) || patched.length !== 1) {
        return new Response(JSON.stringify({ ok: false, error: "not_found" }), {
          status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      // Real timeline visibility for staff, written server-side with a fixed actor so a candidate
      // can never spoof who this came from (add-verification-timeline-entry, by contrast, trusts
      // whatever actor string its caller sends — fine for staff.html, not safe to expose directly
      // to a candidate-facing caller).
      const summary = trimmedValue
        ? "Candidate proposed a corrected value" + (trimmedNote ? " and explained: " + trimmedNote : ".")
        : "Candidate responded, standing by the original: " + trimmedNote;
      await fetch(SUPABASE_URL + "/rest/v1/verification_item_timeline", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "apikey": SUPABASE_SERVICE_ROLE_KEY,
          "Authorization": "Bearer " + SUPABASE_SERVICE_ROLE_KEY,
          "Prefer": "return=minimal",
        },
        body: JSON.stringify({
          item_id,
          event_date: new Date().toISOString(),
          actor: "Candidate",
          action: "Candidate responded to discrepancy.",
          note: summary,
        }),
      }).catch(() => {}); // Best-effort: the response itself already persisted above; a failed
                            // timeline write shouldn't fail the candidate's submission.

      return new Response(JSON.stringify({ ok: true }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    } catch (e) {
      return new Response(JSON.stringify({ ok: false, error: "unhandled", detail: String(e) }), {
        status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
  }),
};
