// Setup type definitions for built-in Supabase Runtime APIs
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { withSupabase } from "jsr:@supabase/server@1";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "content-type",
};

// The license_only Activity tab's data (2026-09-19). candidate.html's existing Activity tab (full-resume)
// is a client-only log seeded with fixed entries and lost on reload; this is the real one, built ONLY from
// durable server records, read at request time:
//   - the candidate row's own timestamps (account created, identity verified, phone verified,
//     license-tracking subscription started)
//   - each license (license_items + its certification_items row): added, correction requested, the
//     correction email sent (correction_notified_at)
//   - the license check outcomes in verification_item_timeline. ONLY actor="System" rows written by
//     verify-license, and ONLY mapped to fixed candidate-safe wording below: the raw `note` (registry
//     text) and every staff-written entry stay internal.
//   - a license a reviewer confirmed (queue status Confirmed with no automatic pass)
//   - candidate_name_changes (name edits)
//   - completed employer existence lookups that matched this candidate (employer_lookup_requests,
//     matched_candidate_id): the requester's stated company and email domain, never their typed details
//     about you (those are nulled when the lookup completes). Lookups that did NOT match are not here and
//     cannot be: nothing links them to this candidate.
//
// Derived from current state, so history that was overwritten is not reconstructable: e.g. a license that
// failed, was corrected, then verified shows the latest correction request and the later check results,
// not every intermediate attempt.
//
// Same identity model as list-candidate-licenses: by candidate_id, no session check (pre-launch item, moves
// with the rest of the candidate-side functions). Returns employer names/domains, so it is a step more
// sensitive than most of them.
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const REST = { "apikey": SUPABASE_SERVICE_ROLE_KEY, "Authorization": `Bearer ${SUPABASE_SERVICE_ROLE_KEY}` };
const MAX_EVENTS = 500;

type Ev = { at: string; category: string; text: string };

async function rest(path: string): Promise<any[]> {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, { headers: REST });
  if (!res.ok) throw new Error(`${path.split("?")[0]} ${res.status}`);
  const rows = await res.json();
  return Array.isArray(rows) ? rows : [];
}

function fullName(first: string | null, last: string | null): string {
  const n = [first, last].filter(Boolean).join(" ").trim();
  return n || "(no name)";
}

// Fixed candidate-safe wording for the System rows verify-license writes to a license's queue item.
function systemTimelineText(action: string): string | null {
  if (/^License check passed/.test(action)) return "License verified against the state registry";
  if (/found a discrepancy/.test(action)) return "License check found a discrepancy: the registry lists it as not in good standing";
  if (/held for review/.test(action)) return "License check matched but needs a manual review";
  if (/could not confirm/.test(action)) return "License check could not be completed automatically and was sent for manual review";
  return null;
}

export default {
  fetch: withSupabase({ auth: "none" }, async (req, _ctx) => {
    if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
    const json = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    try {
      let body: any = {};
      try { body = await req.json(); } catch (_e) { body = {}; }
      const cid = body.candidate_id;
      if (!cid || typeof cid !== "string" || !/^[0-9a-f-]{36}$/i.test(cid)) return json({ ok: false, error: "candidate_id_required" }, 400);

      const cands = await rest(`candidates?id=eq.${cid}&select=created_at,kyc_verified_at,phone_verified_at,license_subscription_started_at`);
      if (cands.length === 0) return json({ ok: false, error: "candidate_not_found" }, 404);
      const c = cands[0];

      const [licenses, nameChanges, lookups] = await Promise.all([
        rest(`license_items?candidate_id=eq.${cid}&select=id,linked_certification_id,state,verified_at,queue_item_id,correction_status,correction_requested_at,correction_notified_at,created_at`),
        rest(`candidate_name_changes?candidate_id=eq.${cid}&select=old_first_name,old_last_name,new_first_name,new_last_name,changed_at&order=changed_at.desc&limit=100`),
        rest(`employer_lookup_requests?matched_candidate_id=eq.${cid}&result_exists=eq.true&used_at=not.is.null&select=used_at,requester_email,requester_company&order=used_at.desc&limit=200`),
      ]);

      const certIds = licenses.map((l) => l.linked_certification_id).filter(Boolean);
      const queueIds = licenses.map((l) => l.queue_item_id).filter(Boolean);
      const [certs, queueRows, timeline] = await Promise.all([
        certIds.length ? rest(`certification_items?id=in.(${certIds.map(encodeURIComponent).join(",")})&select=id,name,license_number`) : Promise.resolve([]),
        queueIds.length ? rest(`verification_items?id=in.(${queueIds.map(encodeURIComponent).join(",")})&select=id,status`) : Promise.resolve([]),
        queueIds.length ? rest(`verification_item_timeline?item_id=in.(${queueIds.map(encodeURIComponent).join(",")})&select=item_id,event_date,actor,action&order=event_date.asc&limit=500`) : Promise.resolve([]),
      ]);
      const certById = new Map(certs.map((x) => [x.id, x]));
      const statusByQueue = new Map(queueRows.map((x) => [x.id, x.status]));

      const events: Ev[] = [];
      const add = (at: string | null | undefined, category: string, text: string) => { if (at) events.push({ at: new Date(at).toISOString(), category, text }); };

      add(c.created_at, "account", "Account created");
      add(c.kyc_verified_at, "account", "Identity verification completed");
      add(c.phone_verified_at, "account", "Phone number verified");
      add(c.license_subscription_started_at, "account", "License-tracking subscription started");

      for (const l of licenses) {
        const cert = certById.get(l.linked_certification_id);
        const parts = [l.state, cert?.license_number ? `#${cert.license_number}` : null].filter(Boolean);
        const label = `${cert?.name || "License"}${parts.length ? ` (${parts.join(", ")})` : ""}`;
        add(l.created_at, "license", `License added: ${label}`);
        if (l.correction_requested_at && (l.correction_status === "requested" || l.correction_status === "dismissed")) {
          add(l.correction_requested_at, "license", `We couldn't verify ${label} and asked you to check the state and license number`);
        }
        add(l.correction_notified_at, "notice", `We emailed you that ${label} needs a correction`);

        const rows = l.queue_item_id ? timeline.filter((t) => t.item_id === l.queue_item_id) : [];
        let sawAutoPass = false;
        for (const t of rows) {
          if (t.actor !== "System") continue;
          const text = systemTimelineText(String(t.action || ""));
          if (!text) continue;
          if (text.startsWith("License verified")) sawAutoPass = true;
          add(t.event_date, "license", `${text}: ${label}`);
        }
        if (!sawAutoPass && l.queue_item_id && statusByQueue.get(l.queue_item_id) === "Confirmed") {
          const last = rows.length ? rows[rows.length - 1].event_date : l.verified_at;
          add(last, "license", `License confirmed by a reviewer: ${label}`);
        }
      }

      for (const n of nameChanges) {
        add(n.changed_at, "name", `You changed your name from ${fullName(n.old_first_name, n.old_last_name)} to ${fullName(n.new_first_name, n.new_last_name)}`);
      }

      for (const e of lookups) {
        const domain = String(e.requester_email || "").split("@")[1] || "an unknown domain";
        const company = e.requester_company ? ` (${e.requester_company}, as they stated it)` : "";
        add(e.used_at, "employer", `Employer lookup: someone at ${domain}${company} confirmed that you have an account here. Nothing else about you was shown`);
      }

      events.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
      return json({ ok: true, events: events.slice(0, MAX_EVENTS), truncated: events.length > MAX_EVENTS });
    } catch (_e) {
      return json({ ok: false, error: "activity_failed" }, 500);
    }
  }),
};
