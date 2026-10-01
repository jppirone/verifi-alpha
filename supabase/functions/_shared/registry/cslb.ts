// California Contractors State License Board (CSLB) public data files -> registry records (2026-10-01).
// Source: the CSLB Data Portal (cslb.ca.gov/OnlineServices/DataPortal/ContractorList), which the Board publishes for free download as CSV: "License Master"
// (one row per license) and "Personnel" (the people associated with each license). Measured on 2026-10-01: 245,529 licenses (all numbers unique), 407,947
// personnel rows. The Board says the Master holds licenses that are "currently renewed, or expired but renewable"; in the real file an expired license is
// essentially absent (2,098 rows expire on/after 2026-09-30) and cancelled / revoked / expired-non-renewable licenses are NOT included.
//
// Records produced (state CA, board "Contractors State License Board"), all carrying the LICENSE's number, status, classifications and dates:
//   * one BUSINESS row per license (the licensee's business name), and
//   * one INDIVIDUAL row per person CURRENTLY associated with that license (a corporation's license is held by the company; the person on a resume is its
//     qualifier or an officer). details.qualifier says whether that person's current title identifies them as the license's holder/qualifier
//     (Sole Owner, Responsible Managing Officer/Employee/Manager/Member, Qualifying Partner) rather than just an officer or member.
// NOT kept: street address, phone, mailing address, bond / insurance / workers-comp detail (not needed to verify a license; a sole owner's business address is
// often a home address). Kept: city, county, state of the business. E-mail addresses are not in the Board's files (Bus. & Prof. Code s.27).

import type { LicenseRecord, HolderKind } from "./schema.ts";
import { cleanStr, isoDate, placeOrNull } from "./normalize.ts";
import type { IngestLicense } from "./ca-dca.ts";

export interface CslbStats {
  licenses: number; businessRows: number; personRows: number; personnelRows: number; personnelOrphans: number; personnelHistorical: number; personnelNonPerson: number;
  personnelDeceased: number; rejected: number; rejectedSamples: Array<{ line: number; reason: string }>; placeBlanked: number;
}

// RFC 4180: quoted fields, doubled quotes, commas and newlines inside quotes. Returns every row, header included.
export function parseCsv(text: string): string[][] {
  const rows: string[][] = []; let row: string[] = []; let f = ""; let q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') { if (text[i + 1] === '"') { f += '"'; i++; } else q = false; } else f += c;
    } else if (c === '"') q = true;
    else if (c === ",") { row.push(f); f = ""; }
    else if (c === "\n" || c === "\r") { if (c === "\r" && text[i + 1] === "\n") i++; row.push(f); f = ""; if (row.length > 1 || row[0] !== "") rows.push(row); row = []; }
    else f += c;
  }
  if (f !== "" || row.length) { row.push(f); rows.push(row); }
  return rows;
}

// CSLB classification codes (the Board's own list). The files write "C10" in the Master and "C-10" in Personnel; both are normalised to the bare form.
export const CSLB_CLASSES: Record<string, string> = {
  A: "General Engineering Contractor", B: "General Building Contractor", B2: "Residential Remodeling Contractor",
  C2: "Insulation and Acoustical", C4: "Boiler, Hot Water Heating and Steam Fitting", C5: "Framing and Rough Carpentry", C6: "Cabinet, Millwork and Finish Carpentry",
  C7: "Low Voltage Systems", C8: "Concrete", C9: "Drywall", C10: "Electrical", C11: "Elevator Installation", C12: "Earthwork and Paving", C13: "Fencing",
  C15: "Flooring and Floor Covering", C16: "Fire Protection", C17: "Glazing", C20: "Warm-Air Heating, Ventilating and Air-Conditioning", C21: "Building Moving/Demolition",
  C22: "Asbestos Abatement", C23: "Ornamental Metal", C27: "Landscaping", C28: "Lock and Security Equipment", C29: "Masonry", C31: "Construction Zone Traffic Control",
  C32: "Parking and Highway Improvement", C33: "Painting and Decorating", C34: "Pipeline", C35: "Lathing and Plastering", C36: "Plumbing", C38: "Refrigeration",
  C39: "Roofing", C42: "Sanitation System", C43: "Sheet Metal", C45: "Sign", C46: "Solar", C47: "General Manufactured Housing", C49: "Tree and Palm",
  C50: "Reinforcing Steel", C51: "Structural Steel", C53: "Swimming Pool", C54: "Tile (Ceramic and Mosaic)", C55: "Water Conditioning", C57: "Well Drilling (Water)",
  C60: "Welding", C61: "Limited Specialty", HAZ: "Hazardous Substance Removal", ASB: "Asbestos Certification",
};
const classCode = (s: string) => s.trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
export function cslbClassNames(raw: string): string | null {
  const codes = [...new Set(raw.split(/[|,]/).map(classCode).filter(Boolean))];
  if (!codes.length) return null;
  return codes.map((c) => (CSLB_CLASSES[c] ? `${CSLB_CLASSES[c]} (${c})` : /^D\d+$/.test(c) ? `Limited Specialty (${c})` : c)).join("; ");
}

// PrimaryStatus: CLEAR (good standing) or one of ~20 suspension reasons ("Contr Bond Susp", "Work Comp Susp", "Liab Ins Susp", "Family Sup Susp", ...). SecondaryStatus
// carries pending items ("WC Susp Pending", "Pending Case/CIT", "Renewal Recived", "7073E Probation", ...). Only a bare CLEAR with NO secondary status is clean:
// status_raw is "CLEAR" for that and "CLEAR; <secondary>" otherwise, so the adapter's exact-text rule holds everything else for a human.
export function cslbStatus(primary: string, secondary: string, inactivation: string, reactivation: string): { status: LicenseRecord["status"]; status_raw: string } {
  const P = primary.trim(), S = secondary.trim();
  const raw = (x: string) => (S ? `${x}; ${S}` : x);
  if (/susp/i.test(P)) return { status: "suspended", status_raw: raw(P) };
  if (cleanStr(inactivation) && !cleanStr(reactivation)) return { status: "inactive", status_raw: raw("INACTIVE") };
  if (P.toUpperCase() === "CLEAR") return { status: "active", status_raw: raw("CLEAR") };
  return { status: "other", status_raw: raw(P || "(none)") };
}

const QUALIFIER = /responsible managing|qualifying partner|sole owner/i;
// Names in Personnel are fixed-width columns "LAST<pad>FIRST<pad>MIDDLE": split on runs of 2+ spaces.
export function cslbPersonName(raw: string): { first: string; last: string; middle: string | null } | null {
  const parts = raw.trim().split(/\s{2,}/).map((s) => s.trim()).filter(Boolean);
  if (parts.length < 2) return null;
  return { last: parts[0], first: parts[1], middle: parts[2] ?? null };
}
// Titles and association / disassociation dates are parallel "a| b| c" lists. A person is CURRENT if any association has no disassociation date.
export function currentTitles(titles: string, dis: string): string[] | null {
  const t = titles.split("|").map((s) => s.trim().replace(/,$/, "").trim()).filter(Boolean);
  const d = dis.split("|").map((s) => s.trim());
  // a list that literally ENDS with "|" is terminated (" 10/28/2003| 06/30/2006|"): that last empty piece is not an open association. (" 12/31/2025| " ends with a
  // space, so its blank second entry IS an association with no end date.)
  if (dis.endsWith("|")) d.pop();
  const open = d.length === 0 || d.every((x) => x === "") || d.some((x) => x === "");
  if (!open) return null;
  if (t.length && t.length === d.length) return t.filter((_, i) => d[i] === "");
  return t;
}

export function parseCslb(masterText: string, personnelText: string): { rows: IngestLicense[]; stats: CslbStats } {
  const stats: CslbStats = { licenses: 0, businessRows: 0, personRows: 0, personnelRows: 0, personnelOrphans: 0, personnelHistorical: 0, personnelNonPerson: 0, personnelDeceased: 0, rejected: 0, rejectedSamples: [], placeBlanked: 0 };
  const out: IngestLicense[] = [];
  const M = parseCsv(masterText); const mh = M[0] ?? [];
  const mi = (n: string) => { const i = mh.indexOf(n); if (i < 0) throw new Error(`CSLB master: column ${n} missing`); return i; };
  const c = { no: mi("LicenseNo"), bn: mi("BusinessName"), fbn: mi("FullBusinessName"), city: mi("City"), county: mi("County"), btype: mi("BusinessType"), issue: mi("IssueDate"), exp: mi("ExpirationDate"),
    inact: mi("InactivationDate"), react: mi("ReactivationDate"), ps: mi("PrimaryStatus"), ss: mi("SecondaryStatus"), cls: mi("Classifications(s)"), dr: mi("DiscpCaseRegion"), dc: mi("DBCaseNo"), upd: mi("LastUpdate") };
  const source = "cslb.ca.gov/OnlineServices/DataPortal (License Master + Personnel files)";
  const board = "California Contractors State License Board";
  const byLic = new Map<string, { base: Omit<LicenseRecord, "license_holder_name" | "holder_kind">; business: string }>();
  for (let n = 1; n < M.length; n++) {
    const r = M[n];
    if (r.length !== mh.length) { stats.rejected++; if (stats.rejectedSamples.length < 5) stats.rejectedSamples.push({ line: n + 1, reason: `${r.length} fields, expected ${mh.length}` }); continue; }
    const no = cleanStr(r[c.no]); const business = cleanStr(r[c.fbn]) ?? cleanStr(r[c.bn]);
    if (!no || !business) { stats.rejected++; if (stats.rejectedSamples.length < 5) stats.rejectedSamples.push({ line: n + 1, reason: "no license number or business name" }); continue; }
    const st = cslbStatus(r[c.ps], r[c.ss], r[c.inact], r[c.react]);
    const city = placeOrNull(r[c.city]), county = placeOrNull(r[c.county]);
    if ((cleanStr(r[c.city]) && !city) || (cleanStr(r[c.county]) && !county)) stats.placeBlanked++;
    const base = {
      license_number: no, license_type: cslbClassNames(r[c.cls]), status: st.status, status_raw: st.status_raw, issue_date: isoDate(r[c.issue]), expiration_date: isoDate(r[c.exp]),
      state: "CA", board_agency: board, source,
      details: { business_name: business, business_type: cleanStr(r[c.btype]), city, county, holder_state: "CA", discipline: !!(cleanStr(r[c.dr]) || cleanStr(r[c.dc])), source_updated: isoDate(r[c.upd]) } as Record<string, unknown>,
    };
    byLic.set(no, { base, business });
    out.push({ record_key: `${no}|biz`, last_name: null, first_name: null, record: { ...base, license_holder_name: business, holder_kind: "business" as HolderKind } });
    stats.licenses++; stats.businessRows++;
  }

  const P = parseCsv(personnelText); const ph = P[0] ?? [];
  const pi = (n: string) => { const i = ph.indexOf(n); if (i < 0) throw new Error(`CSLB personnel: column ${n} missing`); return i; };
  const p = { no: pi("LIC-NO"), seq: pi("SEQ-NO"), tp: pi("Name-TP"), name: pi("Name"), title: pi("EMP-Titl-CDE"), dis: pi("DIS-ASSN-DT") };
  for (let n = 1; n < P.length; n++) {
    const r = P[n]; stats.personnelRows++;
    if (r.length !== ph.length) { stats.rejected++; continue; }
    if (r[p.tp].trim().toLowerCase() !== "principal") { stats.personnelNonPerson++; continue; } // business / joint-venture entities, not people
    const lic = byLic.get(cleanStr(r[p.no]) ?? ""); if (!lic) { stats.personnelOrphans++; continue; }
    const titles = currentTitles(r[p.title], r[p.dis]); if (!titles) { stats.personnelHistorical++; continue; }
    if (titles.some((t) => /^deceased$/i.test(t))) { stats.personnelDeceased++; continue; }
    const nm = cslbPersonName(r[p.name]); if (!nm) { stats.rejected++; continue; }
    const full = [nm.first, nm.middle, nm.last].filter(Boolean).join(" ");
    const qualifier = titles.some((t) => QUALIFIER.test(t));
    out.push({
      record_key: `${lic.base.license_number}|p|${cleanStr(r[p.seq]) ?? full}`, last_name: nm.last, first_name: nm.first,
      record: { ...lic.base, license_holder_name: full, holder_kind: "individual" as HolderKind, details: { ...lic.base.details, title: [...new Set(titles)].join("; ").slice(0, 160), qualifier } },
    });
    stats.personRows++;
  }
  return { rows: out, stats };
}
