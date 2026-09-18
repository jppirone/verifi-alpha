// Setup type definitions for built-in Supabase Runtime APIs
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { withSupabase } from "jsr:@supabase/server@1";
import { createClient } from "jsr:@supabase/supabase-js@2";

// verify-license: the shared, state-agnostic license-verification module. Automatic (not a
// staff-triggered button): called after a candidate confirms resume data (confirm-resume-data),
// completes license-only signup (confirm-verification), or corrects a license's details
// (update-license-details), once required data is complete.
//
// Record model: a license is ONE certification_items row (the credential's name / number / dates)
// plus a 1:1 license_items extension (state + verification + correction state). This function reads
// the descriptive fields from the certification row and writes only license_items / the queue.
//
// Layering (a new state only ever adds an entry to ADAPTERS with new fetch/parse logic; nothing
// below the "ADAPTERS" section changes):
//   1. JurisdictionAdapter — the interface every state implements: which fields must exist before a
//      check may fire, how that state wants the license number normalized, and lookup(), which
//      returns registry records already normalized to RegistryRecord (name-match + standing flags
//      decided by the adapter, since "exact" and "active" are registry-specific facts).
//   2. decide() — the ONE place the outcome vocabulary and ambiguity rules live:
//        verified                  exactly ONE row with an exact name match, AND that row is active,
//                                  and the result wasn't possibly truncated by the registry's row cap.
//                                  Extra rows that are NOT exact name matches (e.g. DBPR listing a
//                                  business and its qualifying individual under one license number)
//                                  are expected and never make a result ambiguous — ambiguity counts
//                                  exact matches, not total rows.
//        not_found                 the registry returned zero rows
//        ambiguous                 rows exist but need a human: more than one EXACT match, cap
//                                  reached, exact match not active, rows but no exact name match,
//                                  lookup/scrape/API failure
//        unsupported_jurisdiction  no adapter for the state (never conflated with not_found)
//   3. routing (below, in the handler) — where an outcome goes:
//        verified                  -> queue row Confirmed
//        ambiguous                 -> queue row Needs Reconciliation (staff)
//        not_found / unsupported   -> FIRST time: no queue row; the candidate is asked to correct the
//                                     details (wrong state / wrong number is the likely cause) and
//                                     re-submits, which re-runs this same check. not_found AFTER a
//                                     genuine correction -> Needs Reconciliation (staff). unsupported
//                                     never goes to staff (there is nothing for staff to run).
//      The automatic path never produces a negative determination. The one exception is a
//      staff-triggered re-run (staff_rerun), where an exact name+number match whose registry status
//      is DEFINITIVELY not in good standing becomes a Discrepancy on the queue row; "delinquent" and
//      other indeterminate statuses stay Needs Reconciliation either way.

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "content-type",
};

const COOLDOWN_SECONDS = 30;

type Outcome = "verified" | "ambiguous" | "unsupported_jurisdiction" | "not_found";
type RequiredField = "license_number" | "first_name" | "last_name";

type RegistryRecord = {
  name: string;
  nameMatches: boolean;
  standing: "active" | "inactive" | "indeterminate";
  statusText: string;
  licenseType: string | null;
  expiration: string | null; // ISO yyyy-mm-dd when the registry gave one
};

type Lookup =
  | { ok: true; records: RegistryRecord[]; capped: boolean }
  | { ok: false; error: string; detail?: string };

interface JurisdictionAdapter {
  state: string;
  source: string;        // stored on license_items.verification_source
  registryLabel: string; // human-readable, used in timeline/claim/candidate text
  requiredFields: RequiredField[];
  normalizeLicenseNumber(raw: string): string;
  lookup(input: { licenseNumber: string; firstName: string; lastName: string }): Promise<Lookup>;
}

// ---------------------------------------------------------------------------------------------
// decide(): shared outcome + ambiguity routing
// ---------------------------------------------------------------------------------------------
type Decision = { outcome: Outcome; reason: string; matched: RegistryRecord | null; definitiveNegative: boolean };
function decide(lookup: Lookup): Decision {
  const d = (outcome: Outcome, reason: string, matched: RegistryRecord | null = null, definitiveNegative = false): Decision =>
    ({ outcome, reason, matched, definitiveNegative });
  if (!lookup.ok) return d("ambiguous", "lookup_failed");
  if (lookup.records.length === 0) return d("not_found", "no_records");
  if (lookup.capped) return d("ambiguous", "result_cap_reached");
  const exact = lookup.records.filter((r) => r.nameMatches);
  if (exact.length === 0) return d("ambiguous", "no_exact_name_match");
  if (exact.length > 1) return d("ambiguous", "multiple_exact_matches");
  const m = exact[0];
  if (m.standing === "active") return d("verified", "exact_match_active", m);
  if (m.standing === "inactive") return d("ambiguous", "exact_match_not_active", m, true);
  return d("ambiguous", "exact_match_status_indeterminate", m);
}

// ---------------------------------------------------------------------------------------------
// ADAPTERS
// ---------------------------------------------------------------------------------------------

function mdyToIso(s: string | null | undefined): string | null {
  const m = (s || "").trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!m) return null;
  return `${m[3]}-${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}`;
}

// Florida DBPR (verify-dbpr-license). Contract, all observed live:
//  - the license-number search matches EXACTLY (case-insensitive); it has zero tolerance for spaces
//    or hyphens, so both are stripped before sending.
//  - first_name/last_name are sent explicitly, never full_name (its first-token/remainder split
//    would fold a middle name into the last name). With a license number present DBPR searches by
//    number only; the names are used purely to compute exactMatch on each returned row.
//  - one license number can return several rows (business + qualifying individual); that is normal.
//    A pass requires exactly one exactMatch:true row that is active.
//  - the search is capped at 10 rows with no truncation flag; a full page (>= 10 rows) is treated
//    as possibly truncated.
const DBPR_ROW_CAP = 10;

// "Current, Active" is the only clean pass. Statuses that are definitively not in good standing are
// "inactive"; everything else (Delinquent, probation, anything unrecognized) is "indeterminate" —
// a human decides, and it is never treated as a definitive negative.
function dbprStanding(status: string): "active" | "inactive" | "indeterminate" {
  const s = (status || "").toLowerCase();
  if (/\binactive\b|suspend|revok|\bnull\b|\bvoid\b|expired|denied|closed|cancel|withdrawn/.test(s)) return "inactive";
  if (/\bactive\b/.test(s) && !/(delinquent|probation)/.test(s)) return "active";
  return "indeterminate";
}

const floridaDbpr: JurisdictionAdapter = {
  state: "FL",
  source: "fl_dbpr",
  registryLabel: "Florida DBPR",
  requiredFields: ["license_number", "first_name", "last_name"],
  normalizeLicenseNumber: (raw) => raw.replace(/[\s\-‐-―]/g, "").toUpperCase(),
  async lookup({ licenseNumber, firstName, lastName }) {
    let res: Response;
    try {
      res = await fetch(`${SUPABASE_URL}/functions/v1/verify-dbpr-license`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "apikey": SUPABASE_SERVICE_ROLE_KEY,
          "Authorization": `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
        },
        body: JSON.stringify({ license_number: licenseNumber, first_name: firstName, last_name: lastName }),
      });
    } catch (e) {
      return { ok: false, error: "network_error", detail: String(e) };
    }
    const data = await res.json().catch(() => null);
    if (!data || !data.ok) {
      return { ok: false, error: (data && data.error) || `http_${res.status}`, detail: data && data.detail ? String(data.detail) : undefined };
    }
    const matches: any[] = Array.isArray(data.matches) ? data.matches : [];
    return {
      ok: true,
      capped: matches.length >= DBPR_ROW_CAP,
      records: matches.map((m) => ({
        name: String(m.name || ""),
        nameMatches: m.exactMatch === true,
        standing: dbprStanding(String(m.status || "")),
        statusText: String(m.status || ""),
        licenseType: m.licenseType ? String(m.licenseType) : null,
        expiration: mdyToIso(m.expirationDate),
      })),
    };
  },
};

const ADAPTERS: Record<string, JurisdictionAdapter> = {
  FL: floridaDbpr,
};

// ---------------------------------------------------------------------------------------------
// persistence + handler
// ---------------------------------------------------------------------------------------------

const STATE_LABELS: Record<string, string> = {
  AL: "Alabama", AK: "Alaska", AZ: "Arizona", AR: "Arkansas", CA: "California", CO: "Colorado", CT: "Connecticut",
  DE: "Delaware", DC: "District of Columbia", FL: "Florida", GA: "Georgia", HI: "Hawaii", ID: "Idaho", IL: "Illinois",
  IN: "Indiana", IA: "Iowa", KS: "Kansas", KY: "Kentucky", LA: "Louisiana", ME: "Maine", MD: "Maryland",
  MA: "Massachusetts", MI: "Michigan", MN: "Minnesota", MS: "Mississippi", MO: "Missouri", MT: "Montana",
  NE: "Nebraska", NV: "Nevada", NH: "New Hampshire", NJ: "New Jersey", NM: "New Mexico", NY: "New York",
  NC: "North Carolina", ND: "North Dakota", OH: "Ohio", OK: "Oklahoma", OR: "Oregon", PA: "Pennsylvania",
  RI: "Rhode Island", SC: "South Carolina", SD: "South Dakota", TN: "Tennessee", TX: "Texas", UT: "Utah",
  VT: "Vermont", VA: "Virginia", WA: "Washington", WV: "West Virginia", WI: "Wisconsin", WY: "Wyoming",
};
function normalizeState(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const t = raw.trim().toUpperCase();
  return /^[A-Z]{2}$/.test(t) && STATE_LABELS[t] ? t : null;
}

function claimFor(cert: any, state: string): string {
  const num = cert.license_number ? `Lic #${cert.license_number}` : null;
  return [cert.name || "License", cert.issuing_body, num, state].filter(Boolean).join(", ");
}

function outcomeText(adapter: JurisdictionAdapter, d: { outcome: Outcome; reason: string }, lookup: Lookup | null): string {
  const lines: string[] = [];
  if (lookup && lookup.ok) {
    for (const r of lookup.records) {
      lines.push(`• ${r.name}${r.licenseType ? " — " + r.licenseType : ""}, ${r.statusText || "status unknown"}${r.expiration ? " (expires " + r.expiration + ")" : ""} — ${r.nameMatches ? "exact name match" : "name does NOT match"}`);
    }
  } else if (lookup && !lookup.ok) {
    lines.push(`Lookup failed: ${lookup.error}${lookup.detail ? " — " + lookup.detail : ""}`);
  }
  const head: Record<string, string> = {
    verified: `${adapter.registryLabel}: one exact name match with active status.`,
    not_found: `${adapter.registryLabel}: no record found for this license number.`,
    ambiguous: `${adapter.registryLabel}: could not be resolved automatically (${d.reason}).`,
  };
  return [head[d.outcome] || d.outcome, ...lines].join("\n");
}

export default {
  fetch: withSupabase({ auth: "none" }, async (req, _ctx) => {
    if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
    const json = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
    try {
      // staff_rerun: a staff member pressed "Re-run" on a License queue item. Bypasses the
      // already-verified short-circuit and the cooldown, never asks the candidate to correct
      // anything, and is the only mode in which a definitive "not in good standing" registry status
      // may become a Discrepancy (see decide()).
      // after_correction: set by update-license-details when the candidate changed the state or
      // number after an earlier failed check — a not_found on such a check goes to staff instead of
      // asking the candidate to correct again.
      const { candidate_id, license_item_id, staff_rerun, after_correction } = await req.json();
      const staffRerun = staff_rerun === true;
      const afterCorrection = after_correction === true;
      if (!candidate_id || !license_item_id) return json({ ok: false, error: "candidate_id and license_item_id are required" }, 400);

      const { data: item, error: itemErr } = await supabase
        .from("license_items").select("*").eq("id", license_item_id).eq("candidate_id", candidate_id).maybeSingle();
      if (itemErr) return json({ ok: false, error: "lookup_failed", detail: itemErr.message }, 500);
      if (!item) return json({ ok: false, error: "license_item_not_found" }, 404);

      const { data: cert } = await supabase
        .from("certification_items").select("id, name, issuing_body, license_number")
        .eq("id", item.linked_certification_id).eq("candidate_id", candidate_id).maybeSingle();
      if (!cert) return json({ ok: false, error: "certification_not_found" }, 404);

      // Already resolved (a clean pass is final): return what's stored rather than re-hitting the registry.
      if (item.verification_outcome === "verified" && !staffRerun) {
        return json({ ok: true, status: "already_verified", outcome: "verified", queue_item_id: item.queue_item_id });
      }

      const { data: cand } = await supabase
        .from("candidates").select("first_name, last_name, full_name").eq("id", candidate_id).maybeSingle();
      let firstName = (cand?.first_name || "").trim();
      let lastName = (cand?.last_name || "").trim();
      if (!lastName && cand?.full_name) {
        const parts = String(cand.full_name).trim().split(/\s+/);
        firstName = parts[0] || "";
        lastName = parts.slice(1).join(" ");
      }

      const state = normalizeState(item.state);
      const missing: string[] = [];
      if (!state) missing.push("state");

      const adapter = state ? ADAPTERS[state] : undefined;
      const rawNumber = (cert.license_number || "").trim();
      const licenseNumber = adapter ? adapter.normalizeLicenseNumber(rawNumber) : rawNumber;
      const have: Record<RequiredField, string> = { license_number: licenseNumber, first_name: firstName, last_name: lastName };
      const requiredFields: RequiredField[] = adapter ? adapter.requiredFields : ["license_number"];
      for (const f of requiredFields) if (!have[f]) missing.push(f);

      // Required-field validation: nothing fires, nothing is stamped, no queue row. The item simply
      // stays unverified — by design nothing chases the candidate for the missing detail.
      if (missing.length) return json({ ok: true, status: "incomplete", missing });

      // Atomic claim so a double-fire (e.g. a retried confirm) can't hit the registry twice at once.
      const cutoff = new Date(Date.now() - COOLDOWN_SECONDS * 1000).toISOString();
      let claimQuery = supabase
        .from("license_items")
        .update({ verification_attempted_at: new Date().toISOString() })
        .eq("id", license_item_id);
      if (!staffRerun && !afterCorrection) claimQuery = claimQuery.or(`verification_attempted_at.is.null,verification_attempted_at.lt.${cutoff}`);
      const { data: claimed } = await claimQuery.select("id");
      if (!claimed || claimed.length === 0) {
        return json({ ok: true, status: "recently_attempted", outcome: item.verification_outcome, queue_item_id: item.queue_item_id });
      }

      let outcome: Outcome;
      let reason: string;
      let lookup: Lookup | null = null;
      let matched: RegistryRecord | null = null;
      let definitiveNegative = false;
      let sourceTag: string;
      let label: string;

      if (!adapter) {
        outcome = "unsupported_jurisdiction";
        reason = `no_adapter_for_${state}`;
        sourceTag = `unsupported_${state}`;
        label = `${state} (unsupported)`;
      } else {
        lookup = await adapter.lookup({ licenseNumber, firstName, lastName });
        const d = decide(lookup);
        outcome = d.outcome; reason = d.reason; matched = d.matched; definitiveNegative = d.definitiveNegative;
        sourceTag = adapter.source;
        label = adapter.registryLabel;
      }

      const now = new Date().toISOString();
      const detail = {
        searched: { license_number: licenseNumber, first_name: firstName, last_name: lastName, state },
        records: lookup && lookup.ok ? lookup.records : [],
        capped: lookup && lookup.ok ? lookup.capped : false,
        lookup_error: lookup && !lookup.ok ? { error: lookup.error, detail: lookup.detail || null } : null,
        matched_record: matched,
        registry_expiration: matched ? matched.expiration : null,
      };

      // ---- routing -------------------------------------------------------------------------------
      // A clean no-match or unsupported state is most likely a wrong state/number, so on the first
      // check it goes back to the candidate (no queue row). Everything else that isn't a pass goes
      // to staff, as does a not_found that survives a genuine correction.
      const stateLabel = state ? STATE_LABELS[state] : "";
      const genericNumber = rawNumber.replace(/[\s\-‐-―]/g, "").toUpperCase();
      const unchangedSinceDismissed = item.correction_status === "dismissed" && item.checked_state === state && item.checked_number === genericNumber;
      const askCandidate = !staffRerun && (
        outcome === "unsupported_jurisdiction" ||
        (outcome === "not_found" && !afterCorrection)
      );
      let correction: { status: string; reason: string; message: string } | null = null;
      if (askCandidate && !unchangedSinceDismissed) {
        correction = {
          status: "requested",
          reason: outcome,
          message: outcome === "not_found"
            ? `We couldn't verify this license under ${stateLabel} (${label}). Please confirm the license number and details, or update the state if it was entered incorrectly.`
            : `We can't check licenses issued in ${stateLabel} automatically yet, so this license is shown as candidate-stated. If ${stateLabel} isn't the state that issued it, update the state and we'll check it again.`,
        };
      }

      // Queue row: verified -> Confirmed; ambiguous / not_found-after-correction -> Needs
      // Reconciliation, except a staff re-run that finds an exact name+number match in a
      // definitively-not-in-good-standing state -> Discrepancy. Nothing for a candidate-correction
      // or an unsupported state. Re-runs reuse the same row instead of stacking new ones.
      let queueId: string | null = item.queue_item_id || null;
      let queueStatus: string | null = null;
      if (adapter && !askCandidate) {
        const isDiscrepancy = staffRerun && definitiveNegative && !!matched;
        const status = outcome === "verified" ? "Confirmed" : isDiscrepancy ? "Discrepancy" : "Needs Reconciliation";
        queueStatus = status;
        const text = outcomeText(adapter, { outcome, reason }, lookup);
        const runLabel = staffRerun ? "re-run by staff" : afterCorrection ? "automatic, after candidate correction" : "automatic";
        const historyLine = `Automated check result (not a determination) — ${label} (${runLabel}), ${now}:\n${text}`;
        // Candidate-visible on a Discrepancy row; factual registry data only.
        const discrepancyNote = isDiscrepancy ? `The state registry lists this license with status "${matched!.statusText}".` : null;
        if (queueId) {
          const { data: existing } = await supabase.from("verification_items").select("automated_check").eq("id", queueId).maybeSingle();
          const prior = existing?.automated_check || "";
          await supabase.from("verification_items").update({
            claim: claimFor(cert, state!),
            status, automated_check: prior ? historyLine + "\n\n---\n\n" + prior : historyLine,
            ...(discrepancyNote ? { note: discrepancyNote } : {}),
          }).eq("id", queueId);
        } else {
          const { data: idRow } = await supabase.rpc("nextval_verification_item_id");
          const { error: qErr } = await supabase.from("verification_items").insert({
            id: idRow, candidate_id, type: "License", claim: claimFor(cert, state!), received: now.slice(0, 10),
            status, automated_check: historyLine, ...(discrepancyNote ? { note: discrepancyNote } : {}),
            internal_note: outcome === "verified" ? null : `Auto-flagged by automatic license verification: ${reason}${afterCorrection ? " (after the candidate corrected the details)" : ""}. Not a negative determination — needs a human look.`,
            source_item_id: item.id, bundle_id: item.resume_document_id || null,
          });
          if (qErr) return json({ ok: false, error: "queue_insert_failed", detail: qErr.message }, 500);
          queueId = idRow as string;
        }
        await supabase.from("verification_item_timeline").insert({
          item_id: queueId, event_date: now, actor: "System",
          action: outcome === "verified"
            ? `License check passed (${label}, ${runLabel}): confirmed.`
            : isDiscrepancy
              ? `License check found a discrepancy (${label}, ${runLabel}): registry status is not in good standing.`
              : `License check could not confirm (${label}, ${runLabel}): flagged for reconciliation.`,
          note: text,
        });
      }

      const { error: updErr } = await supabase.from("license_items").update({
        verification_outcome: outcome, verification_reason: reason, verification_detail: detail,
        verification_source: sourceTag, verified_at: outcome === "verified" ? now : null,
        queue_item_id: queueId, updated_at: now,
        verification_attempts: (item.verification_attempts || 0) + 1,
        // Always the generic normalization (not the adapter's, which doesn't exist for an unsupported
        // state): update-license-details compares against this to decide whether a resubmit is a change.
        checked_state: state, checked_number: rawNumber.replace(/[\s\-‐-―]/g, "").toUpperCase(),
        correction_status: correction ? correction.status : (unchangedSinceDismissed ? "dismissed" : null),
        correction_reason: correction ? correction.reason : (unchangedSinceDismissed ? item.correction_reason : null),
        correction_message: correction ? correction.message : (unchangedSinceDismissed ? item.correction_message : null),
        correction_requested_at: correction ? now : (unchangedSinceDismissed ? item.correction_requested_at : null),
      }).eq("id", license_item_id);
      if (updErr) return json({ ok: false, error: "persist_failed", detail: updErr.message }, 500);

      return json({ ok: true, status: "checked", outcome, reason, queue_item_id: queueId, queue_status: queueStatus, correction });
    } catch (e) {
      return json({ ok: false, error: "unhandled", detail: String(e) }, 500);
    }
  }),
};
