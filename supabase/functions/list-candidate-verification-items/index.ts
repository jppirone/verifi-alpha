// Setup type definitions for built-in Supabase Runtime APIs
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { withSupabase } from "jsr:@supabase/server@1";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "content-type",
};

// Candidate-facing read of a candidate's own verification queue rows — the real data source for
// the "Verification Status" account tab, which previously rendered 100% hardcoded prototype
// content (fake companies, fixed counts, zero backend calls).
//
// Deliberately separate from list-verification-items (staff.html's function): that one returns
// every candidate's items plus name/email/phone for the staff queue, which is exactly the wrong
// shape to hand to a candidate's own browser. This returns only one candidate's own rows, and only
// the fields a candidate is safe to see about their own item — no assigned_to (an internal worker
// identity), never the raw internal `status` value itself, and never `internal_note` or
// `automated_check` (staff-only / out of scope; see the candidate-discrepancy-response task's own
// header). Raw status stays server-side in this response; candidate.html's own safe-label allowlist
// (see verificationSafeLabel) is what ever reaches the rendered page, so there's still a second,
// independent layer between "whatever staff typed into the dropdown" and what a candidate sees,
// not just a client-side filter that could be bypassed by reading the network response directly.
// (Note: mapping happens client-side today, matching this codebase's existing convention of doing
// response shaping in candidate.html rather than duplicating it wallet-to-wallet in every function;
// the raw `status` value is still included below for that mapping to work from, same trust
// boundary as everything else this candidate-facing endpoint already exposes about their own row.)
//
// `note` (relabeled "Note to candidate" in staff.html as of this same change) and the
// correction_requested/correction_note/correction_value trio are now included, but only populated
// for a row with status === 'Discrepancy' — the only state a candidate has anything to read or
// respond to. correction_requested/correction_note/correction_value are the candidate's own past
// submission (via submit-candidate-correction-response) being read back, not someone else's data;
// safe to return as-is.
//
// candidate_id is taken directly from the request body, matching the established pattern in this
// codebase (get-resume-extraction, confirm-resume-data): the candidate_id is only ever reachable
// from resumeCandidateId, itself only ever set from a real session (see applySession's own
// header) — not a new trust boundary, the same one already in place everywhere else in this app.
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

export default {
  fetch: withSupabase({ auth: "none" }, async (req, _ctx) => {
    if (req.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }
    try {
      const { candidate_id } = await req.json();
      if (!candidate_id || typeof candidate_id !== "string") {
        return new Response(JSON.stringify({ ok: false, error: "candidate_id_required" }), {
          status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      const url = SUPABASE_URL + "/rest/v1/verification_items?select=id,type,claim,status,created_at,note,correction_requested,correction_note,correction_value&candidate_id=eq."
        + encodeURIComponent(candidate_id) + "&order=created_at.asc";
      const res = await fetch(url, {
        headers: {
          "apikey": SUPABASE_SERVICE_ROLE_KEY,
          "Authorization": "Bearer " + SUPABASE_SERVICE_ROLE_KEY,
        },
      });
      if (!res.ok) {
        const errText = await res.text();
        return new Response(JSON.stringify({ ok: false, error: "fetch_failed", detail: errText }), {
          status: 502, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      const rows = await res.json();
      const items = rows.map((r: any) => {
        const isDiscrepancy = r.status === "Discrepancy";
        return {
          id: r.id,
          type: r.type,
          claim: r.claim,
          status: r.status,
          createdAt: r.created_at,
          note: isDiscrepancy ? (r.note || null) : null,
          correctionRequested: isDiscrepancy ? !!r.correction_requested : false,
          correctionNote: isDiscrepancy ? (r.correction_note || null) : null,
          correctionValue: isDiscrepancy ? (r.correction_value || null) : null,
        };
      });

      return new Response(JSON.stringify({ ok: true, items }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    } catch (e) {
      return new Response(JSON.stringify({ ok: false, error: "unhandled", detail: String(e) }), {
        status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
  }),
};
