// Connects the Knowledge Base to the verification queue (2026-10-01).
//
// What the queue did before: a "Job Experience" item went in as status "New" with NO automated employer check at all; nothing called the KB.
// What it does now: right after an item is queued, the employer on that work-history entry is checked against the KB (existence, automatically),
// the result is written ONTO the queue item (employer_check + the operating-status columns + one line of automated_check text), and a result whose
// operating_status_confirmation_required is true (the registry publishes no status: Pennsylvania) routes the item to staff confirmation of OPERATING
// STATUS specifically. That is a separate question from existence and does not change it: the item still shows the employer as found / verified.
//
// Routing, concretely: the item carries operating_confirmation_required = true until staff record a resolution (operating / not_operating /
// undetermined); update-verification-item refuses to set status "Confirmed" on such an item until they have. Nothing else about the item changes.
//
// Pure module: no Deno / Node / npm imports.

import type { VerifyResponse } from "./kb.ts";

const STATE_NAMES: Record<string, string> = {
  ALABAMA: "AL", ALASKA: "AK", ARIZONA: "AZ", ARKANSAS: "AR", CALIFORNIA: "CA", COLORADO: "CO", CONNECTICUT: "CT", DELAWARE: "DE", "DISTRICT OF COLUMBIA": "DC",
  FLORIDA: "FL", GEORGIA: "GA", HAWAII: "HI", IDAHO: "ID", ILLINOIS: "IL", INDIANA: "IN", IOWA: "IA", KANSAS: "KS", KENTUCKY: "KY", LOUISIANA: "LA", MAINE: "ME",
  MARYLAND: "MD", MASSACHUSETTS: "MA", MICHIGAN: "MI", MINNESOTA: "MN", MISSISSIPPI: "MS", MISSOURI: "MO", MONTANA: "MT", NEBRASKA: "NE", NEVADA: "NV",
  "NEW HAMPSHIRE": "NH", "NEW JERSEY": "NJ", "NEW MEXICO": "NM", "NEW YORK": "NY", "NORTH CAROLINA": "NC", "NORTH DAKOTA": "ND", OHIO: "OH", OKLAHOMA: "OK",
  OREGON: "OR", PENNSYLVANIA: "PA", "RHODE ISLAND": "RI", "SOUTH CAROLINA": "SC", "SOUTH DAKOTA": "SD", TENNESSEE: "TN", TEXAS: "TX", UTAH: "UT", VERMONT: "VT",
  VIRGINIA: "VA", WASHINGTON: "WA", "WEST VIRGINIA": "WV", WISCONSIN: "WI", WYOMING: "WY",
};
const STATE_CODES = new Set(Object.values(STATE_NAMES));

// The two-letter state of an employer from the free-text location on a work-history entry ("York, PA", "York, Pennsylvania 17401", "Philadelphia PA",
// "Pittsburgh, PA, USA"). Returns null when there is no state to read ("Remote", "Hybrid", a bare city, an ambiguous bare "Washington"): the KB is never
// asked to guess, and a lookup is never made without a stated state.
export function employerStateFromLocation(location: string | null | undefined): string | null {
  let s = String(location ?? "").replace(/\s+/g, " ").trim();
  if (!s) return null;
  s = s.replace(/[,\s]*(united states of america|united states|u\.s\.a\.?|usa|u\.s\.|us)\s*$/i, "").replace(/[,\s]*\d{5}(-\d{4})?\s*$/, "").trim().replace(/[,\s]+$/, "");
  const parts = s.split(",").map((p) => p.trim()).filter(Boolean);
  if (parts.length === 0) return null;
  const last = parts[parts.length - 1];
  if (/^[A-Z]{2}$/.test(last) && STATE_CODES.has(last)) return last;                     // "York, PA"
  const named = STATE_NAMES[last.toUpperCase().replace(/\./g, "")];
  if (named && (parts.length > 1 || last.toUpperCase() !== "WASHINGTON")) return named;  // "York, Pennsylvania"; a lone "Washington" is city-or-state: no guess
  const m = /^(.+)\s([A-Z]{2})$/.exec(last);                                              // "Philadelphia PA" (no comma; code must be upper-case)
  if (m && STATE_CODES.has(m[2])) return m[2];
  return null;
}

export interface WorkHistoryEmployer { company: string | null; employer_name_override: string | null; location: string | null; employer_location_override: string | null }
export function employerFromWorkHistory(w: WorkHistoryEmployer): { name: string | null; state: string | null } {
  const name = (w.employer_name_override || w.company || "").trim() || null;
  const state = employerStateFromLocation(w.employer_location_override) ?? employerStateFromLocation(w.location);
  return { name, state };
}

export type OperatingStatus = "active_per_registry" | "not_active" | "unknown";
export interface EmployerCheckPatch {
  employer_check: Record<string, unknown>;
  operating_status: OperatingStatus | null;
  operating_confirmation_required: boolean;
  automated_check_line: string;
}

export function notCheckedPatch(reason: "no_employer_name" | "no_state" | "kb_unavailable", detail?: string, checkedAt = new Date().toISOString()): EmployerCheckPatch {
  const why = reason === "no_state" ? "the work-history entry gives no employer state, so no registry was asked (a lookup is never made without a stated state)"
    : reason === "no_employer_name" ? "the work-history entry has no employer name"
    : `the Knowledge Base could not be reached${detail ? " (" + detail.slice(0, 120) + ")" : ""}`;
  return {
    employer_check: { status: "not_checked", reason, checked_at: checkedAt },
    operating_status: null, operating_confirmation_required: false,
    automated_check_line: `Employer check: not run - ${why}.`,
  };
}

// The patch for a verification_items row from a kb-verify-business response.
export function employerCheckFromKb(r: VerifyResponse, checkedAt = new Date().toISOString()): EmployerCheckPatch {
  const e = r.entity ?? r.stale_entity ?? null;
  const needs = r.operating_status_confirmation_required === true;
  return {
    employer_check: {
      status: r.status, checked_at: checkedAt, state: r.query.state, name_checked: r.query.name, cache_result: r.cache_result, from_cache: r.from_cache,
      manual_verification_required: r.manual_verification_required, message: r.message, kb_log_id: r.log_id,
      entity: e ? {
        name: e.name, registry_entity_id: e.registry_entity_id, status: e.status, status_raw: e.status_raw, entity_type: e.entity_type, registration_date: e.registration_date,
        source_completeness: e.source_completeness, last_verified_at: e.last_verified_at, stale: !r.entity,
      } : null,
      operating_status: r.operating_status ?? null, operating_status_confirmation_required: needs,
      ...(r.resolution ? { resolution: r.resolution } : {}),
    },
    operating_status: r.entity ? (r.operating_status ?? null) : null,
    operating_confirmation_required: needs,
    automated_check_line: `Employer check (${r.query.state} registry): ${r.message}${needs ? " [OPERATING STATUS NEEDS STAFF CONFIRMATION]" : ""}`,
  };
}

// Replace any earlier "Employer check" line in the item's automated_check text with the new one (idempotent on re-run); other text is untouched.
export function mergeAutomatedCheck(existing: string | null | undefined, line: string): string {
  const keep = String(existing ?? "").split("\n").filter((l) => !/^Employer check/.test(l));
  return [...keep, line].join("\n").trim();
}

export const OPERATING_RESOLUTIONS = ["operating", "not_operating", "undetermined"] as const;
export type OperatingResolution = (typeof OPERATING_RESOLUTIONS)[number];

// The gate update-verification-item applies: an item flagged for operating-status confirmation cannot be set to "Confirmed" until staff have recorded
// a resolution. Returns true when the change must be refused. Every other status change, and every item without the flag, passes untouched.
export function blocksConfirmed(item: { operating_confirmation_required?: boolean | null; operating_resolution?: string | null }, nextStatus: string | null | undefined): boolean {
  return nextStatus === "Confirmed" && item.operating_confirmation_required === true && !item.operating_resolution;
}
