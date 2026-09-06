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

export default {
  fetch: withSupabase({ auth: "none" }, async (req, _ctx) => {
    if (req.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }
    try {
      const { candidate_id, item_id, corrected_value, note } = await req.json();
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
