// Common schema for the state business-registry and professional-license integrations (2026-09-30).
//
// EVERY source -- a Socrata dataset queried live, a fixed-width flat file ingested into our own table, a spreadsheet --
// is normalized into exactly one of these two record shapes, so a caller that looks up a company name or a license holder
// never needs per-source code. Anything a source has that the common shape does not is kept in `details` (always present,
// always an object, possibly empty) and the source's own status wording is kept verbatim in `status_raw`; nothing is
// dropped or reworded (standing rule 11: present what the source says, do not editorialize it).
//
// Dates are ISO `YYYY-MM-DD` strings or null -- never a source-specific format, never a placeholder like 0001-01-01.

export const BUSINESS_STATUSES = ["active", "delinquent", "inactive", "dissolved", "merged", "pending", "other"] as const;
export type BusinessStatus = (typeof BUSINESS_STATUSES)[number];

export const LICENSE_STATUSES = ["active", "expired", "revoked", "suspended", "inactive", "pending", "other"] as const;
export type LicenseStatus = (typeof LICENSE_STATUSES)[number];

export const HOLDER_KINDS = ["individual", "business", "unknown"] as const;
export type HolderKind = (typeof HOLDER_KINDS)[number];

export interface BusinessEntity {
  entity_name: string;
  entity_id: string; // the registry's own entity / filing / document number, as a string
  status: BusinessStatus; // normalized; the source's own wording is in status_raw
  status_raw: string | null;
  registration_date: string | null; // formation / registration / filing date, ISO
  entity_type: string | null; // the source's own type wording, verbatim
  state: string; // two-letter code of the REGISTRY this record came from
  source_dataset: string; // e.g. "data.colorado.gov/4ykn-tg5h"
  details: Record<string, unknown>;
}

export interface LicenseRecord {
  license_holder_name: string;
  holder_kind: HolderKind;
  license_number: string;
  license_type: string | null; // license type / profession / credential, verbatim
  status: LicenseStatus;
  status_raw: string | null;
  issue_date: string | null; // original / first issue date, ISO
  expiration_date: string | null;
  state: string; // two-letter code of the licensing state
  board_agency: string; // the licensing board / agency
  source: string; // e.g. "data.colorado.gov/7s5z-vewr"
  details: Record<string, unknown>;
}

// The exact keys and primitive types every record of a kind must have, in a stable order. The cross-source test and the
// runtime validators both use these, so "same shape everywhere" is checked, not assumed.
export const BUSINESS_SHAPE: Record<keyof BusinessEntity, "string" | "string|null" | "object"> = {
  entity_name: "string", entity_id: "string", status: "string", status_raw: "string|null", registration_date: "string|null",
  entity_type: "string|null", state: "string", source_dataset: "string", details: "object",
};
export const LICENSE_SHAPE: Record<keyof LicenseRecord, "string" | "string|null" | "object"> = {
  license_holder_name: "string", holder_kind: "string", license_number: "string", license_type: "string|null", status: "string",
  status_raw: "string|null", issue_date: "string|null", expiration_date: "string|null", state: "string", board_agency: "string",
  source: "string", details: "object",
};

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function checkShape(kind: string, rec: Record<string, unknown>, shape: Record<string, string>): string[] {
  const problems: string[] = [];
  const keys = Object.keys(rec).sort().join(",");
  const want = Object.keys(shape).sort().join(",");
  if (keys !== want) problems.push(`${kind}: keys [${keys}] != expected [${want}]`);
  for (const [k, t] of Object.entries(shape)) {
    const v = rec[k];
    if (t === "string" && (typeof v !== "string" || v === "")) problems.push(`${kind}.${k}: expected non-empty string, got ${JSON.stringify(v)}`);
    if (t === "string|null" && v !== null && (typeof v !== "string" || v === "")) problems.push(`${kind}.${k}: expected non-empty string or null, got ${JSON.stringify(v)}`);
    if (t === "object" && (v === null || typeof v !== "object" || Array.isArray(v))) problems.push(`${kind}.${k}: expected plain object`);
  }
  for (const k of ["registration_date", "issue_date", "expiration_date"]) {
    const v = rec[k];
    if (typeof v === "string" && !ISO_DATE.test(v)) problems.push(`${kind}.${k}: not an ISO date: ${v}`);
  }
  if (typeof rec.state === "string" && !/^[A-Z]{2}$/.test(rec.state)) problems.push(`${kind}.state: not a 2-letter code: ${rec.state}`);
  return problems;
}

export function businessProblems(rec: unknown): string[] {
  if (!rec || typeof rec !== "object") return ["business: not an object"];
  const r = rec as Record<string, unknown>;
  const p = checkShape("business", r, BUSINESS_SHAPE);
  if (!(BUSINESS_STATUSES as readonly string[]).includes(String(r.status))) p.push(`business.status: ${r.status} not in enum`);
  return p;
}

export function licenseProblems(rec: unknown): string[] {
  if (!rec || typeof rec !== "object") return ["license: not an object"];
  const r = rec as Record<string, unknown>;
  const p = checkShape("license", r, LICENSE_SHAPE);
  if (!(LICENSE_STATUSES as readonly string[]).includes(String(r.status))) p.push(`license.status: ${r.status} not in enum`);
  if (!(HOLDER_KINDS as readonly string[]).includes(String(r.holder_kind))) p.push(`license.holder_kind: ${r.holder_kind} not in enum`);
  return p;
}

// A compact "key:type" signature of a record, used to compare shapes across sources.
export function shapeSignature(rec: Record<string, unknown>): string {
  return Object.keys(rec).sort().map((k) => `${k}:${rec[k] === null ? "null" : Array.isArray(rec[k]) ? "array" : typeof rec[k]}`).join(" ");
}
