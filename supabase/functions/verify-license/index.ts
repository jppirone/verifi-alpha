// Setup type definitions for built-in Supabase Runtime APIs
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { withSupabase } from "jsr:@supabase/server@1";
import { createClient } from "jsr:@supabase/supabase-js@2";

// verify-license: the shared, state-agnostic license-verification module. Automatic (not a
// staff-triggered button): called after a candidate confirms resume data (confirm-resume-data) or
// completes license-only signup (confirm-verification), once required data is complete.
//
// Layering (a new state only ever adds an entry to ADAPTERS with new fetch/parse logic; nothing
// below the "ADAPTERS" section changes):
//   1. JurisdictionAdapter — the interface every state implements: which fields must exist before a
//      check may fire, how that state wants the license number normalized, and lookup(), which
//      returns registry records already normalized to RegistryRecord (name-match + active flags
//      decided by the adapter, since "exact" and "active" are registry-specific facts).
//   2. decide() — the ONE place the outcome vocabulary and ambiguity rules live:
//        verified                  exactly one exact-name match AND active status, cap not hit
//        not_found                 the registry returned zero rows
//        ambiguous                 anything else that needs a human: multiple exact matches, cap
//                                  reached, exact match but not active, rows but none name-matching,
//                                  lookup/scrape/API failure
//        unsupported_jurisdiction  no adapter for the state (never conflated with not_found)
//      No outcome here is ever a negative determination about the candidate: everything that is not
//      a clean pass routes to Needs Reconciliation for a human, never to Discrepancy/Unable to Verify.
//   3. persist() — writes the outcome onto license_items and (for verified / ambiguous / not_found)
//      the verification_items queue row (type "License") plus a System timeline entry. An
//      unsupported jurisdiction gets NO queue row: nothing exists for staff to run.

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
  active: boolean;
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
  registryLabel: string; // human-readable, used in timeline/claim text
  requiredFields: RequiredField[];
  normalizeLicenseNumber(raw: string): string;
  lookup(input: { licenseNumber: string; firstName: string; lastName: string }): Promise<Lookup>;
}

// ---------------------------------------------------------------------------------------------
// decide(): shared outcome + ambiguity routing
// ---------------------------------------------------------------------------------------------
function decide(lookup: Lookup): { outcome: Outcome; reason: string; matched: RegistryRecord | null } {
  if (!lookup.ok) return { outcome: "ambiguous", reason: "lookup_failed", matched: null };
  if (lookup.records.length === 0) return { outcome: "not_found", reason: "no_records", matched: null };
  if (lookup.capped) return { outcome: "ambiguous", reason: "result_cap_reached", matched: null };
  const exact = lookup.records.filter((r) => r.nameMatches);
  if (exact.length === 0) return { outcome: "ambiguous", reason: "no_exact_name_match", matched: null };
  if (exact.length > 1) return { outcome: "ambiguous", reason: "multiple_exact_matches", matched: null };
  if (!exact[0].active) return { outcome: "ambiguous", reason: "exact_match_not_active", matched: exact[0] };
  return { outcome: "verified", reason: "exact_match_active", matched: exact[0] };
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
//  - one license number can return several rows (business + qualifying individual), so a pass
//    requires a row that is BOTH exactMatch:true and active, and exactly one such row.
//  - the search is capped at 10 rows with no truncation flag; a full page (>= 10 rows) is treated
//    as possibly truncated.
const DBPR_ROW_CAP = 10;

function dbprIsActive(status: string): boolean {
  const s = (status || "").toLowerCase();
  if (!/\bactive\b/.test(s)) return false;
  if (/\binactive\b/.test(s)) return false;
  if (/(delinquent|suspend|revok|null|void|expired|probation|denied|closed|cancel|withdrawn)/.test(s)) return false;
  return true;
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
        active: dbprIsActive(String(m.status || "")),
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

const STATE_NAMES: Record<string, string> = { FLORIDA: "FL", COLORADO: "CO" };
function normalizeState(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const t = raw.trim().toUpperCase();
  if (!t) return null;
  if (/^[A-Z]{2}$/.test(t)) return t;
  return STATE_NAMES[t] || null;
}

function claimFor(item: any, state: string): string {
  const num = item.license_number ? `Lic #${item.license_number}` : null;
  return [item.license_name || "License", item.issuing_body, num, state].filter(Boolean).join(", ");
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
      const { candidate_id, license_item_id } = await req.json();
      if (!candidate_id || !license_item_id) return json({ ok: false, error: "candidate_id and license_item_id are required" }, 400);

      const { data: item, error: itemErr } = await supabase
        .from("license_items").select("*").eq("id", license_item_id).eq("candidate_id", candidate_id).maybeSingle();
      if (itemErr) return json({ ok: false, error: "lookup_failed", detail: itemErr.message }, 500);
      if (!item) return json({ ok: false, error: "license_item_not_found" }, 404);

      // Already resolved (a clean pass is final): return what's stored rather than re-hitting the registry.
      if (item.verification_outcome === "verified") {
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
      const rawNumber = (item.license_number || "").trim();
      const licenseNumber = adapter ? adapter.normalizeLicenseNumber(rawNumber) : rawNumber;
      const have: Record<RequiredField, string> = { license_number: licenseNumber, first_name: firstName, last_name: lastName };
      const requiredFields: RequiredField[] = adapter ? adapter.requiredFields : ["license_number"];
      for (const f of requiredFields) if (!have[f]) missing.push(f);

      // Required-field validation: nothing fires, nothing is stamped, no queue row. The item simply
      // stays unverified — by design nothing chases the candidate for the missing detail.
      if (missing.length) return json({ ok: true, status: "incomplete", missing });

      // Atomic claim so a double-fire (e.g. a retried confirm) can't hit the registry twice at once.
      const cutoff = new Date(Date.now() - COOLDOWN_SECONDS * 1000).toISOString();
      const { data: claimed } = await supabase
        .from("license_items")
        .update({ verification_attempted_at: new Date().toISOString() })
        .eq("id", license_item_id)
        .or(`verification_attempted_at.is.null,verification_attempted_at.lt.${cutoff}`)
        .select("id");
      if (!claimed || claimed.length === 0) {
        return json({ ok: true, status: "recently_attempted", outcome: item.verification_outcome, queue_item_id: item.queue_item_id });
      }

      let outcome: Outcome;
      let reason: string;
      let lookup: Lookup | null = null;
      let matched: RegistryRecord | null = null;
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
        outcome = d.outcome; reason = d.reason; matched = d.matched;
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

      // Queue row: verified -> Confirmed; ambiguous / not_found -> Needs Reconciliation.
      // unsupported_jurisdiction -> none. Re-runs reuse the same row instead of stacking new ones.
      let queueId: string | null = item.queue_item_id || null;
      if (adapter) {
        const status = outcome === "verified" ? "Confirmed" : "Needs Reconciliation";
        const text = outcomeText(adapter, { outcome, reason }, lookup);
        const historyLine = `Automated check result (not a determination) — ${label} (automatic), ${now}:\n${text}`;
        if (queueId) {
          const { data: existing } = await supabase.from("verification_items").select("automated_check").eq("id", queueId).maybeSingle();
          const prior = existing?.automated_check || "";
          await supabase.from("verification_items").update({
            status, automated_check: prior ? historyLine + "\n\n---\n\n" + prior : historyLine,
          }).eq("id", queueId);
        } else {
          const { data: idRow } = await supabase.rpc("nextval_verification_item_id");
          const { error: qErr } = await supabase.from("verification_items").insert({
            id: idRow, candidate_id, type: "License", claim: claimFor(item, state!), received: now.slice(0, 10),
            status, automated_check: historyLine,
            internal_note: outcome === "verified" ? null : `Auto-flagged by automatic license verification: ${reason}. Not a negative determination — needs a human look.`,
            source_item_id: item.id, bundle_id: item.resume_document_id || null,
          });
          if (qErr) return json({ ok: false, error: "queue_insert_failed", detail: qErr.message }, 500);
          queueId = idRow as string;
        }
        await supabase.from("verification_item_timeline").insert({
          item_id: queueId, event_date: now, actor: "System",
          action: outcome === "verified"
            ? `Automatic license check passed (${label}): confirmed.`
            : `Automatic license check could not confirm (${label}): flagged for reconciliation.`,
          note: text,
        });
      }

      const { error: updErr } = await supabase.from("license_items").update({
        verification_outcome: outcome, verification_reason: reason, verification_detail: detail,
        verification_source: sourceTag, verified_at: outcome === "verified" ? now : null,
        queue_item_id: queueId, updated_at: now,
      }).eq("id", license_item_id);
      if (updErr) return json({ ok: false, error: "persist_failed", detail: updErr.message }, 500);

      return json({ ok: true, status: "checked", outcome, reason, queue_item_id: queueId });
    } catch (e) {
      return json({ ok: false, error: "unhandled", detail: String(e) }, 500);
    }
  }),
};
