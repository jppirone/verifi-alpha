// Registry-backed license adapters for verify-license (2026-10-01): Colorado DORA, Connecticut DCP, Illinois IDFPR, Washington DOH + L&I,
// Delaware DPR, California DCA, Michigan LARA. Pure module (no network, no Deno APIs): verify-license passes in a `fetchRegistry` that calls the
// deployed registry-lookup, and the offline tests pass a fake, so every rule below is tested without a database or a registry.
//
// Contract with verify-license's decide(): a lookup returns the registry rows that CARRY THE CANDIDATE'S LICENSE NUMBER (like the Florida adapter's
// number search), each flagged nameMatches, plus a standing. decide() then says verified only for exactly ONE exact-name row that is clean-active.
//
// WHAT "ACTIVE" MEANS HERE (the part that is deliberately stricter than the shared normalizer): the registries publish qualified actives -- Colorado
// "Active - With Conditions / Restricted / Provisional / Telehealth ONLY", Washington "Active On Probation / With Restrictions / Not Renewable",
// Illinois "ACTIVE CHAPERONE REQUIRED", Michigan "Active - In Late Renewal" -- and the shared normalizeLicenseStatus maps every "Active..." to
// plain "active". That is fine for a lookup tool a human reads; it is NOT fine for an automatic Confirmed. Here only a source's own CLEAN active
// text is "active". Everything the table below does not know is "indeterminate" (a human decides), never guessed either way -- the same rule
// the Florida classifier uses. "inactive" means definitively not a currently valid license.

export type Standing = "active" | "inactive" | "indeterminate";

export interface LicenseRow {
  license_holder_name: string; license_number: string; license_type: string | null; status: string; status_raw: string | null;
  issue_date: string | null; expiration_date: string | null; board_agency?: string; source?: string; details?: Record<string, unknown>;
}
export interface RegistryHit { source_id: string; record: LicenseRow }
export interface RegistryReport { source_id: string; ok: boolean; count: number; truncated?: boolean; error?: string; detail?: string; skipped?: string }
export type RegistryResponse = { ok: true; hits: RegistryHit[]; reports: RegistryReport[] } | { ok: false; error: string; detail?: string };
export type FetchRegistry = (body: Record<string, unknown>) => Promise<RegistryResponse>;

// What verify-license's decide() consumes (identical to its RegistryRecord).
export interface AdapterRecord { name: string; nameMatches: boolean; standing: Standing; statusText: string; licenseType: string | null; expiration: string | null }
export type AdapterLookup = { ok: true; records: AdapterRecord[]; capped: boolean } | { ok: false; error: string; detail?: string };

// How complete a license source is, i.e. what its silence means. (The license counterpart of the KB's source_completeness.)
//   full_history          expired / revoked / cancelled / surrendered rows are all listed: "not found" = no such license under that number
//   current_and_lapsed    current and lapsed holders are listed but revoked / cancelled / surrendered outcomes are not (California DCA's public lists)
//   active_only           only currently licensed holders are listed (Michigan LARA: 799k rows, 99.9% Active): a license that lapsed or was revoked is ABSENT
export type LicenseCompleteness = "full_history" | "current_and_lapsed" | "active_only";

export interface LicenseSourceProfile {
  source_id: string; state: string; completeness: LicenseCompleteness;
  coverage: string;            // which licenses this dataset holds, for honest "not found" wording
  refresh: "nightly" | "daily" | "monthly";
  numberScope: "unique" | "shared";   // shared = the number is only unique within a board/type (Colorado, California), so a number alone never identifies a holder
  collapseAcrossTypes: boolean;       // same number + same holder under different type rows (CA "Nurse Practitioner" + "... Furnishing") is ONE license
  lapsedIsDefinitive: boolean;        // is an expired/inactive row proof the license is not valid today? false for monthly snapshots (can be a month stale)
  padNumbersTo?: number[];            // zero-padded forms the source stores
  activeText: string[];               // the source's own CLEAN active status text (lowercase)
  deadText: string[];                 // definitely ended: revoked, suspended, surrendered, cancelled, deceased, ...
  lapsedText: string[];               // lapsed: expired, not renewed, inactive, ...
  classify?: (row: LicenseRow) => Standing | null; // optional source-specific override (Connecticut needs the status reason)
}

const lc = (s: unknown) => String(s ?? "").toLowerCase().replace(/[‐-―–—]/g, "-").replace(/\s+/g, " ").trim();

// ---- source profiles. Every status string below was seen live on 2026-10-01 (counts in the session notes); anything not listed is indeterminate.
const CT_ACTIVE_REASONS = ["", "current", "active", "accepted", "registered", "certification", "certified", "licensed", "permitted", "in renewal"];
export const LICENSE_PROFILES: Record<string, LicenseSourceProfile> = {
  "co-dora": {
    source_id: "co-dora", state: "CO", completeness: "full_history", refresh: "nightly", numberScope: "shared", collapseAcrossTypes: false, lapsedIsDefinitive: true, padNumbersTo: [9],
    coverage: "licenses issued by Colorado's Department of Regulatory Agencies (nurses, physicians, cosmetologists, engineers, accountants, real estate and the other DORA boards); licenses issued elsewhere (attorneys, teachers) are not in it",
    activeText: ["active"],
    deadText: ["revoked", "surrendered", "voluntary surrender", "cancelled", "suspended", "suspended due to child support", "summary suspension", "retired", "expired - dissolved"],
    lapsedText: ["expired", "beyond 6 years expired", "inactive", "expired - telehealth only"],
    // indeterminate on purpose: Active - With Conditions / Restricted / Provisional / Telehealth ONLY / Refresher Course Only / Reentry License,
    // Transferred to Compact Physician (the holder has a compact license), Grad to Higher Level (replaced by a higher license), Need Master Hire.
  },
  "ct-dcp": {
    source_id: "ct-dcp", state: "CT", completeness: "full_history", refresh: "daily", numberScope: "unique", collapseAcrossTypes: false, lapsedIsDefinitive: true,
    coverage: "credentials issued through Connecticut's Department of Consumer Protection eLicense system (trades, nursing, real estate, notaries and many others); licenses issued by other Connecticut agencies are not in it",
    activeText: [], deadText: [], lapsedText: [],
    classify: (r) => {
      const st = lc(r.status_raw), reason = lc((r.details as Record<string, unknown> | undefined)?.status_reason);
      if (st === "active" || st === "active in renewal") return CT_ACTIVE_REASONS.includes(reason) ? "active" : "indeterminate";
      // every INACTIVE variant (lapsed, terminated, withdrawn, surrendered, out of business, ...) is a license that is not valid today; Connecticut's own text is the evidence
      if (st.startsWith("inactive") || st === "lapsed" || st === "closed" || st === "retired" || st === "denied") return "inactive";
      return "indeterminate"; // pending / approved / qualified / expired application / anything new: not a licence, or unknown
    },
  },
  "il-idfpr": {
    source_id: "il-idfpr", state: "IL", completeness: "full_history", refresh: "daily", numberScope: "unique", collapseAcrossTypes: false, lapsedIsDefinitive: true, padNumbersTo: [9],
    coverage: "licenses issued by the Illinois Department of Financial and Professional Regulation (nurses, physicians, cosmetologists, real estate and the other IDFPR professions); licenses issued elsewhere are not in it",
    activeText: ["active"],
    deadText: ["revoked", "suspended", "cancelled", "terminated", "terminated card returned", "terminated without card", "terminated valid reason", "deceased", "relinquish",
      "voluntary surrender", "permanent inactive", "inoperative", "closed", "change of ownership", "refuse to renew", "revoked chaperone required", "suspended chaperone required",
      "non sufficient fund check terminated", "relinquish chaperone required", "deceased chaperone required", "permanent inactive chaperone required"],
    lapsedText: ["not renewed", "expired", "inactive", "expired-renewable", "insurance expired", "not renewed chaperone required"],
    // indeterminate: PROBATION, ACTIVE CHAPERONE REQUIRED, Non Sufficient Fund Check
  },
  "wa-doh": {
    source_id: "wa-doh", state: "WA", completeness: "full_history", refresh: "daily", numberScope: "unique", collapseAcrossTypes: false, lapsedIsDefinitive: true,
    coverage: "health care provider credentials issued by Washington's Department of Health; contractor and other licenses are separate",
    activeText: ["active"],
    deadText: ["suspended", "revoked", "terminated", "surrender", "voluntary surrender", "summary suspension", "retired"],
    lapsedText: ["expired", "inactive"],
    // indeterminate: Active With Conditions / With Restrictions / On Probation / Provisional / Not Renewable, Retired Active*, Military, Expired - Active MSL,
    // Closed, Superseded (replaced by a newer credential), Inoperable, Pending, Approved, Denied.
  },
  "wa-lni": {
    source_id: "wa-lni", state: "WA", completeness: "full_history", refresh: "daily", numberScope: "unique", collapseAcrossTypes: false, lapsedIsDefinitive: true,
    coverage: "contractor licenses issued by Washington's Department of Labor & Industries (held by the business; a sole proprietor's name is the principal)",
    activeText: ["active"],
    deadText: ["suspended", "revoked due dept err", "passed away", "out of business"],
    lapsedText: ["expired", "inactive"],
    // indeterminate: RE-LICENSED and SUPERCEDED (the contractor holds a newer license)
  },
  "de-dpr": {
    source_id: "de-dpr", state: "DE", completeness: "full_history", refresh: "daily", numberScope: "unique", collapseAcrossTypes: false, lapsedIsDefinitive: true,
    coverage: "licenses issued by Delaware's Division of Professional Regulation (nurses, physicians, cosmetologists and the other division boards); licenses issued elsewhere are not in it",
    activeText: ["active"],
    deadText: ["suspended", "revoked", "annulled", "deceased", "withdrawn", "denied", "terminated"],
    lapsedText: ["expired", "inactive", "deactivated", "expired inactive", "closed"],
    // indeterminate: Probation, Delinquent, Non-Disciplinary Suspension, Under Review
  },
  "ca-dca": {
    source_id: "ca-dca", state: "CA", completeness: "current_and_lapsed", refresh: "monthly", numberScope: "shared", collapseAcrossTypes: true, lapsedIsDefinitive: false,
    coverage: "licenses on the 33 California Department of Consumer Affairs boards' public lists (nurses, physicians, cosmetologists, contractors and others) as of the latest monthly list; licenses issued outside DCA are not in them",
    activeText: ["current", "active"],
    deadText: ["suspension", "suspended"],
    lapsedText: ["currentinactive", "inactive", "expired"],
    // indeterminate: Delinquent (renewal overdue, still in its late window)
  },
  "mi-lara": {
    source_id: "mi-lara", state: "MI", completeness: "active_only", refresh: "monthly", numberScope: "unique", collapseAcrossTypes: false, lapsedIsDefinitive: false,
    coverage: "currently licensed holders on seven of Michigan's LARA Bureau of Professional Licensing groups, as of the latest monthly list; licenses issued by other agencies are not in it",
    activeText: ["active"],
    deadText: ["suspended"],
    lapsedText: [],
    // indeterminate: Active - In Late Renewal, Limited, Disciplinary Limited, Voluntary Limited
  },
};

export const STATE_SOURCES: Record<string, string[]> = { CO: ["co-dora"], CT: ["ct-dcp"], IL: ["il-idfpr"], WA: ["wa-doh", "wa-lni"], DE: ["de-dpr"], CA: ["ca-dca"], MI: ["mi-lara"] };
export const STATE_LABELS_SHORT: Record<string, string> = {
  CO: "Colorado DORA", CT: "Connecticut DCP eLicense", IL: "Illinois IDFPR", WA: "Washington DOH / L&I", DE: "Delaware DPR", CA: "California DCA", MI: "Michigan LARA",
};

// ---- standing
export function standingFor(row: LicenseRow, profile: LicenseSourceProfile, today: string): { standing: Standing; note: string | null } {
  let s: Standing | null = profile.classify ? profile.classify(row) : null;
  if (s === null) {
    const t = lc(row.status_raw);
    if (!t) s = "indeterminate";
    else if (profile.activeText.includes(t)) s = "active";
    else if (profile.deadText.includes(t)) s = "inactive";
    else if (profile.lapsedText.includes(t)) s = profile.lapsedIsDefinitive ? "inactive" : "indeterminate";
    else s = "indeterminate";
  } else if (s === "inactive" && !profile.lapsedIsDefinitive) {
    // a source-specific rule said "inactive": definitive only if the source is fresh enough to say so
    const t = lc(row.status_raw);
    if (!profile.deadText.includes(t)) s = "indeterminate";
  }
  // A "clean active" row whose own expiration date has passed is stale or mid-renewal: never an automatic pass.
  if (s === "active" && row.expiration_date && /^\d{4}-\d{2}-\d{2}$/.test(row.expiration_date) && row.expiration_date < today) {
    return { standing: "indeterminate", note: "the registry lists it as active but its expiration date has already passed" };
  }
  return { standing: s, note: null };
}

// ---- names. Registry holder names are "First [Middle...] Last [Suffix]" in every source seen; compare first and last, allow anything between.
const SUFFIX = new Set(["JR", "SR", "II", "III", "IV", "V", "MD", "DO", "RN", "LPN", "PHD", "ESQ"]);
export function nameTokens(s: string): string[] {
  return String(s ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").toUpperCase().replace(/[.,]/g, " ").replace(/['’`"]/g, "").replace(/[^A-Z0-9 ]/g, " ")
    .split(/\s+/).filter(Boolean);
}
const stripSuffix = (t: string[]) => { const o = [...t]; while (o.length > 1 && SUFFIX.has(o[o.length - 1])) o.pop(); return o; };
export function nameMatches(first: string, last: string, holder: string): boolean {
  const f = nameTokens(first), l = stripSuffix(nameTokens(last)), h = stripSuffix(nameTokens(holder));
  if (!f.length || !l.length || h.length < f.length + l.length) return false;
  for (let i = 0; i < f.length; i++) if (h[i] !== f[i]) return false;
  for (let i = 0; i < l.length; i++) if (h[h.length - l.length + i] !== l[i]) return false;
  return true;
}
// Washington L&I names the BUSINESS; the person is the principal, stored "LAST, FIRST M.".
function holderNames(row: LicenseRow): string[] {
  const out = [row.license_holder_name];
  const p = String((row.details as Record<string, unknown> | undefined)?.principal ?? "").trim();
  if (p) { const m = p.match(/^([^,]+),\s*(.+)$/); out.push(m ? `${m[2]} ${m[1]}` : p); }
  return out;
}

// ---- numbers
export const alnum = (s: unknown) => String(s ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
const noLeadingZeros = (s: string) => (/^\d+$/.test(s) ? s.replace(/^0+(?=\d)/, "") : s);
export function numbersEqual(a: unknown, b: unknown): boolean {
  const x = alnum(a), y = alnum(b);
  return !!x && !!y && (x === y || noLeadingZeros(x) === noLeadingZeros(y));
}
export function numberVariants(raw: string, profiles: LicenseSourceProfile[]): string[] {
  const t = String(raw ?? "").trim().toUpperCase().replace(/\s+/g, "");
  const a = alnum(raw), z = noLeadingZeros(a);
  const v: string[] = [t, a, z];
  for (const p of profiles) for (const n of p.padNumbersTo ?? []) if (/^\d+$/.test(z) && z.length <= n) v.push(z.padStart(n, "0"));
  const de = a.match(/^([A-Z][A-Z0-9])(\d{7})$/); if (de && profiles.some((p) => p.source_id === "de-dpr")) v.push(`${de[1]}-${de[2]}`);
  return [...new Set(v.filter(Boolean))].slice(0, 5);
}

// ---- the lookup
const LIMIT = 50;
export interface LookupInput { state: string; licenseNumber: string; firstName: string; lastName: string; today?: string }

function toRecord(row: LicenseRow, source: string, nameOk: boolean, p: LicenseSourceProfile, today: string): AdapterRecord {
  const { standing, note } = standingFor(row, p, today);
  const status = row.status_raw ?? row.status ?? "";
  return {
    name: row.license_holder_name, nameMatches: nameOk, standing,
    statusText: note ? `${status} (${note})` : String(status), licenseType: row.license_type, expiration: row.expiration_date,
  };
}

// Same number + same holder: one license. California lists "Nurse Practitioner" and "Nurse Practitioner Furnishing" under one number and one name.
// All active -> active; all dead -> inactive; anything mixed -> indeterminate (a human decides).
function collapse(recs: Array<{ rec: AdapterRecord; key: string }>): AdapterRecord[] {
  const groups = new Map<string, AdapterRecord[]>();
  for (const { rec, key } of recs) { const g = groups.get(key); if (g) g.push(rec); else groups.set(key, [rec]); }
  const out: AdapterRecord[] = [];
  for (const g of groups.values()) {
    if (g.length === 1) { out.push(g[0]); continue; }
    const all = (s: Standing) => g.every((r) => r.standing === s);
    out.push({
      name: g[0].name, nameMatches: g.some((r) => r.nameMatches),
      standing: all("active") ? "active" : all("inactive") ? "inactive" : "indeterminate",
      statusText: [...new Set(g.map((r) => r.statusText))].join(" / "), licenseType: [...new Set(g.map((r) => r.licenseType).filter(Boolean))].join(" / ") || null,
      expiration: g.map((r) => r.expiration).filter(Boolean).sort()[0] ?? null,
    });
  }
  return out;
}

export async function registryLookup(input: LookupInput, fetchRegistry: FetchRegistry): Promise<AdapterLookup> {
  const state = input.state.toUpperCase();
  const ids = STATE_SOURCES[state];
  if (!ids) return { ok: false, error: "no_registry_profile_for_state" };
  const profiles = ids.map((i) => LICENSE_PROFILES[i]);
  const byId = new Map(profiles.map((p) => [p.source_id, p]));
  const today = input.today ?? new Date().toISOString().slice(0, 10);

  const rowsWithNumber: Array<{ hit: RegistryHit; p: LicenseSourceProfile }> = [];
  const seenRows = new Set<string>();
  const addRow = (h: RegistryHit) => {
    const k = `${h.source_id}|${h.record.license_number}|${h.record.license_holder_name}|${h.record.license_type}|${h.record.status_raw}|${h.record.board_agency ?? ""}`;
    if (seenRows.has(k)) return; seenRows.add(k); rowsWithNumber.push({ hit: h, p: byId.get(h.source_id)! });
  };
  const isMine = (h: RegistryHit) => holderNames(h.record).some((hn) => nameMatches(input.firstName, input.lastName, hn));
  let capped = false;
  let usedNumberSearch = false;
  // Try the number in each stored form. STOP only when a row for THIS holder turns up: in a shared-number source (Colorado, California) the bare number
  // also matches strangers on other boards, which must not end the search before the zero-padded form that is really theirs is tried.
  for (const variant of numberVariants(input.licenseNumber, profiles)) {
    const r = await fetchRegistry({ kind: "license", states: [state], license_number: variant, limit: LIMIT });
    if (!r.ok) return { ok: false, error: r.error, detail: r.detail };
    const failed = r.reports.find((x) => !x.ok);
    if (failed) return { ok: false, error: failed.error || "source_failed", detail: failed.detail };
    usedNumberSearch = true;
    const rows = r.hits.filter((h) => byId.has(h.source_id) && numbersEqual(h.record.license_number, input.licenseNumber));
    const truncated = r.reports.some((x) => x.truncated);
    for (const h of rows) addRow(h);
    if (rows.some(isMine)) break;
    // a shared-number source can return > LIMIT unrelated holders for a short number; the person may be hidden behind the cap, so look the person up by name instead
    if (truncated && profiles.some((p) => p.numberScope === "shared" && r.reports.some((x) => x.source_id === p.source_id && x.truncated))) {
      const n = await fetchRegistry({ kind: "license", states: [state], first_name: input.firstName, last_name: input.lastName, limit: LIMIT });
      if (!n.ok) return { ok: false, error: n.error, detail: n.detail };
      const nf = n.reports.find((x) => !x.ok); if (nf) return { ok: false, error: nf.error || "source_failed", detail: nf.detail };
      const mine = n.hits.filter((h) => byId.has(h.source_id) && numbersEqual(h.record.license_number, input.licenseNumber) && isMine(h));
      if (mine.length) { for (const h of mine) addRow(h); break; }
      if (n.reports.some((x) => x.truncated)) capped = true;
      continue;
    }
    if (truncated) capped = true;
  }
  if (!usedNumberSearch) return { ok: false, error: "no_search_run" };

  const prepared: Array<{ rec: AdapterRecord; key: string; shared: boolean }> = [];
  for (const { hit, p } of rowsWithNumber) {
    const nameOk = holderNames(hit.record).some((hn) => nameMatches(input.firstName, input.lastName, hn));
    // shared-number sources: a row with the same number but a different holder is a stranger on another board, not a "name mismatch" -- drop it
    if (!nameOk && p.numberScope === "shared") continue;
    const rec = toRecord(hit.record, hit.source_id, nameOk, p, today);
    const key = `${hit.source_id}|${hit.record.board_agency ?? ""}|${alnum(hit.record.license_number)}|${nameTokens(hit.record.license_holder_name).join(" ")}|${p.collapseAcrossTypes ? "" : lc(hit.record.license_type)}|${nameOk}`;
    prepared.push({ rec, key, shared: p.numberScope === "shared" });
  }
  const records = collapse(prepared);
  // capped only matters when the cap could be hiding the holder: no exact-name row was found AND a search came back full
  return { ok: true, records, capped: capped && !records.some((r) => r.nameMatches) };
}

// Honest "not found" wording for the candidate/staff note: says what the registry covers (and, for a list with no lapsed holders, that absence is not proof).
export function notFoundNote(state: string): string {
  const key = state.toUpperCase();
  const ps = (STATE_SOURCES[key] ?? []).map((i) => LICENSE_PROFILES[i]).filter(Boolean);
  if (!ps.length) return "";
  const lapse = (p: LicenseSourceProfile) => p.completeness === "active_only"
    ? " It lists currently licensed holders only, so a license that has lapsed or been revoked would not appear."
    : p.completeness === "current_and_lapsed" ? " Revoked and cancelled licenses do not appear on it." : "";
  return `The ${STATE_LABELS_SHORT[key] ?? key} data covers ${ps.map((p) => p.coverage).join("; and ")}.${ps.map(lapse).filter((x, i, a) => a.indexOf(x) === i).join("")}`;
}
