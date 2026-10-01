// Professional-license sources built on the shared Socrata client (Stage 1, 2026-09-30): Colorado DORA, Connecticut
// DCP/eLicense, Illinois IDFPR, Washington Department of Health, Washington Labor & Industries (contractors). Field names
// come from each dataset's own metadata and were confirmed against real rows on 2026-09-30.
//
// Lookups are by holder name and/or license number. Individuals are matched on last + first name (exact, then first-name
// prefix), businesses on the business name; every user value is quoted through soqlString and wildcard characters are stripped
// from prefix terms. Every source returns the SAME LicenseRecord shape (schema.ts); what a source has beyond it goes in
// `details`, and the source's own status wording stays in `status_raw`.
//
// NOTE (mismatch with the brief, flagged in the report): the brief names Washington "Dept of Licensing (most professions)".
// On data.wa.gov the Department of Licensing publishes only license COUNTS and transactions (e.g. a2n7-rij5), not a roster of
// licensees. The second Washington agency built here is therefore Labor & Industries (contractor licenses, m8qx-ubtq); the
// Board of Accountancy's CPA roster (6du3-3h9e) is also on the portal and not built.

import { SocrataClient, soqlString, soqlUpperContains, soqlUpperEquals, soqlUpperPrefix } from "./socrata.ts";
import type { LicenseQuery, LicenseSource, MatchMode, Outcome } from "./adapter.ts";
import type { HolderKind, LicenseRecord } from "./schema.ts";
import { cleanStr, isoDate, joinName, normalizeLicenseStatus, parsePersonName, stripWildcards } from "./normalize.ts";

type Row = Record<string, unknown>;

export interface SocrataLicenseSpec {
  id: string;
  label: string;
  state: string;
  boardAgency: string;
  domain: string;
  datasetId: string;
  fields: string[];
  typeField?: string; // the dataset column that holds the licence type text (used by the optional license_type narrowing filter)
  fixedType?: string; // a dataset that holds ONE licence type and has no type column (Texas Board of Nursing RN / VN): the filter then matches this text instead
  orderBy: string;
  // Returns the WHERE for a query in the given match mode, or null when the query has nothing this source can search on.
  whereFor: (q: { person: { first: string; last: string } | null; business: string | null; number: string | null }, mode: MatchMode) => string | null;
  map: (row: Row, sourceDataset: string) => LicenseRecord | null;
}

function mkLicense(src: string, state: string, board: string, o: {
  name: unknown; kind: HolderKind; number: unknown; type: unknown; statusRaw: unknown; reason?: unknown; issue: unknown; exp: unknown; details?: Record<string, unknown>;
  status?: LicenseRecord["status"]; // the source's own vocabulary needs a source-specific mapping (Texas "CURRENT (C)")
}): LicenseRecord | null {
  const license_holder_name = cleanStr(o.name);
  const license_number = cleanStr(o.number);
  if (!license_holder_name || !license_number) return null;
  const status_raw = cleanStr(o.statusRaw);
  return {
    license_holder_name, holder_kind: o.kind, license_number,
    license_type: cleanStr(o.type),
    status: o.status ?? normalizeLicenseStatus(status_raw, cleanStr(o.reason)), status_raw,
    issue_date: isoDate(o.issue), expiration_date: isoDate(o.exp),
    state, board_agency: board, source: src,
    details: o.details ?? {},
  };
}

// Interpret a caller's LicenseQuery into the three things a source can search on.
export function interpretLicenseQuery(q: LicenseQuery): { person: { first: string; last: string } | null; business: string | null; number: string | null } {
  let person: { first: string; last: string } | null = null;
  if (cleanStr(q.first_name) && cleanStr(q.last_name)) person = { first: cleanStr(q.first_name)!.toUpperCase(), last: cleanStr(q.last_name)!.toUpperCase() };
  else if (cleanStr(q.name)) person = parsePersonName(q.name!);
  const business = cleanStr(q.business_name) || cleanStr(q.name);
  return { person, business, number: cleanStr(q.license_number) };
}

export function makeSocrataLicenseSource(spec: SocrataLicenseSpec, appToken?: string): LicenseSource {
  const client = new SocrataClient({ domain: spec.domain, datasetId: spec.datasetId, appToken });
  const source_dataset = client.sourceId;
  return {
    id: spec.id, label: spec.label, state: spec.state, board_agency: spec.boardAgency, source_dataset, kind: "socrata",
    async search(q, mode): Promise<Outcome<LicenseRecord>> {
      const t0 = Date.now();
      const base = spec.whereFor(interpretLicenseQuery(q), mode);
      if (!base) return { ok: false, source: source_dataset, error: "empty_or_invalid_query" };
      // The licence-type filter is part of the WHERE (not applied after the fact) so it narrows BEFORE the result cap: a capped common-name search
      // can be narrowed to the one licence type that matters instead of the cap hiding it.
      const typeFilter = cleanStr(q.license_type);
      // a one-type dataset has no type column: a filter that does not match its type text means "none of this source's licences", not "no filter"
      if (typeFilter && spec.fixedType && !spec.fixedType.toUpperCase().includes(typeFilter.toUpperCase())) return { ok: true, records: [], meta: { source: source_dataset, attempts: 0, ms: 0 } };
      const where = typeFilter && spec.typeField ? `(${base}) AND ${soqlUpperContains(spec.typeField, typeFilter)}` : base;
      const r = await client.query<Row>({ select: spec.fields.join(","), where, order: spec.orderBy, limit: Math.min(Math.max(q.limit ?? 25, 1), 100) });
      if (!r.ok) return { ok: false, source: source_dataset, error: r.error, status: r.status, detail: r.detail };
      const records = r.rows.map((row) => spec.map(row, source_dataset)).filter((x): x is LicenseRecord => !!x);
      return { ok: true, records, meta: { source: source_dataset, attempts: r.attempts, ms: Date.now() - t0 } };
    },
  };
}

// Builds "person OR business OR number" from whichever parts the query has. Person/business are matched per `mode`; a license
// number is always exact.
function anyOf(parts: Array<string | null>): string | null {
  const p = parts.filter((x): x is string => !!x);
  return p.length === 0 ? null : p.length === 1 ? p[0] : p.map((x) => `(${x})`).join(" OR ");
}
const eqOrPrefix = (field: string, v: string, mode: MatchMode) => mode === "exact" ? soqlUpperEquals(field, v) : soqlUpperPrefix(field, stripWildcards(v));

// ---------------------------------------------------------------------------------------------------------------------
// Colorado DORA, 7s5z-vewr. licensenumber is NOT globally unique (scoped per license type / board; verified live), so a number
// lookup can return unrelated holders -- callers must also match the name or the type. Has individual and business licensees.
const CO_DORA: SocrataLicenseSpec = {
  id: "co-dora", label: "Colorado DORA — Professional and Occupational Licenses", state: "CO",
  boardAgency: "Colorado Department of Regulatory Agencies (DORA)",
  domain: "data.colorado.gov", datasetId: "7s5z-vewr", typeField: "licensetype", orderBy: "lastname, firstname, licensenumber",
  fields: ["lastname", "firstname", "middlename", "suffix", "entityname", "city", "state", "licensetype", "subcategory", "licensenumber",
    "licensefirstissuedate", "licenseexpirationdate", "licensestatusdescription", "specialty", "linktoverifylicense", "programaction"],
  whereFor: (q, mode) => anyOf([
    q.person ? `${soqlUpperEquals("lastname", q.person.last)} AND ${eqOrPrefix("firstname", q.person.first, mode)}` : null,
    q.business ? eqOrPrefix("entityname", q.business, mode) : null,
    q.number ? `licensenumber = ${soqlString(q.number)}` : null,
  ]),
  map: (r, src) => {
    const isBiz = !!cleanStr(r.entityname) && !cleanStr(r.lastname);
    return mkLicense(src, "CO", "Colorado Department of Regulatory Agencies (DORA)", {
      name: isBiz ? r.entityname : joinName([r.firstname, r.middlename, r.lastname, r.suffix]) || r.entityname,
      kind: isBiz ? "business" : "individual", number: r.licensenumber, type: r.licensetype, statusRaw: r.licensestatusdescription,
      issue: r.licensefirstissuedate, exp: r.licenseexpirationdate,
      details: { program_action: cleanStr(r.programaction), subcategory: cleanStr(r.subcategory), specialty: cleanStr(r.specialty), city: cleanStr(r.city), holder_state: cleanStr(r.state), verify_link: (r.linktoverifylicense as Row | undefined)?.url ?? null },
    });
  },
};

// Connecticut "State Licenses and Credentials", ngch-56tr (eLicense). One row per credential; `name` is a single column in
// "FIRST [M] LAST" order for individuals, businessname for businesses. The dataset spans many credential types (850+).
// INACTIVE rows carry a statusreason ("LAPSED DUE TO NON-RENEWAL") that distinguishes an expiry from a bare inactive status.
const CT_DCP: SocrataLicenseSpec = {
  id: "ct-dcp", label: "Connecticut DCP eLicense — State Licenses and Credentials", state: "CT",
  boardAgency: "Connecticut Department of Consumer Protection (eLicense)",
  domain: "data.ct.gov", datasetId: "ngch-56tr", typeField: "credential", orderBy: "name, fullcredentialcode",
  fields: ["credentialid", "name", "type", "businessname", "dba", "fullcredentialcode", "credentialnumber", "credentialtype", "credential",
    "status", "statusreason", "issuedate", "effectivedate", "expirationdate", "city", "state"],
  whereFor: (q, mode) => anyOf([
    q.person ? (mode === "exact"
      ? `${soqlUpperPrefix("name", q.person.first + " ")} AND upper(name) like ${soqlString("% " + q.person.last)}`
      : `${soqlUpperPrefix("name", q.person.first)} AND upper(name) like ${soqlString("%" + q.person.last + "%")}`) : null,
    q.business ? `${eqOrPrefix("businessname", q.business, mode)}` : null,
    q.number ? `fullcredentialcode = ${soqlString(q.number)} OR credentialnumber = ${soqlString(q.number)}` : null,
  ]),
  map: (r, src) => mkLicense(src, "CT", "Connecticut Department of Consumer Protection (eLicense)", {
    name: cleanStr(r.type)?.toUpperCase() === "BUSINESS" ? (cleanStr(r.businessname) || r.name) : (cleanStr(r.name) || r.businessname),
    kind: cleanStr(r.type)?.toUpperCase() === "BUSINESS" ? "business" : cleanStr(r.type)?.toUpperCase() === "INDIVIDUAL" ? "individual" : "unknown",
    number: r.fullcredentialcode ?? r.credentialnumber, type: r.credential, statusRaw: r.status, reason: r.statusreason,
    issue: r.issuedate, exp: r.expirationdate,
    details: {
      credential_id: cleanStr(r.credentialid), credential_number: cleanStr(r.credentialnumber), credential_type_code: cleanStr(r.credentialtype),
      status_reason: cleanStr(r.statusreason), effective_date: isoDate(r.effectivedate), dba: cleanStr(r.dba), city: cleanStr(r.city), holder_state: cleanStr(r.state),
    },
  }),
};

// Illinois IDFPR "Professional Licensing", pzzh-kp68, on data.illinois.gov. 4.4M rows, all statuses. Dates are text in
// MM/DD/YYYY. `business` = "Y" marks a business licensee (business_name), otherwise an individual (first/middle/last).
const IL_IDFPR: SocrataLicenseSpec = {
  id: "il-idfpr", label: "Illinois IDFPR — Professional Licensing", state: "IL",
  boardAgency: "Illinois Department of Financial and Professional Regulation (IDFPR)",
  domain: "data.illinois.gov", datasetId: "pzzh-kp68", typeField: "description", orderBy: "last_name, first_name, license_number",
  fields: ["license_type", "description", "license_number", "license_status", "business", "first_name", "middle", "last_name", "suffix", "business_name",
    "businessdba", "original_issue_date", "effective_date", "expiration_date", "city", "state", "ever_disciplined", "specialty_qualifier"],
  whereFor: (q, mode) => anyOf([
    q.person ? `${soqlUpperEquals("last_name", q.person.last)} AND ${eqOrPrefix("first_name", q.person.first, mode)}` : null,
    q.business ? eqOrPrefix("business_name", q.business, mode) : null,
    q.number ? `license_number = ${soqlString(q.number)}` : null,
  ]),
  map: (r, src) => {
    const isBiz = String(r.business ?? "").toUpperCase() === "Y";
    return mkLicense(src, "IL", "Illinois Department of Financial and Professional Regulation (IDFPR)", {
      name: isBiz ? r.business_name : joinName([r.first_name, r.middle, r.last_name, r.suffix]) || r.business_name,
      kind: isBiz ? "business" : "individual", number: r.license_number, type: r.description, statusRaw: r.license_status,
      issue: r.original_issue_date, exp: r.expiration_date,
      details: { profession: cleanStr(r.license_type), effective_date: isoDate(r.effective_date), ever_disciplined: cleanStr(r.ever_disciplined), specialty: cleanStr(r.specialty_qualifier), dba: cleanStr(r.businessdba), city: cleanStr(r.city), holder_state: cleanStr(r.state) },
    });
  },
};

// Washington Department of Health "Health Care Provider Credential Data", qxh8-f4bd. Individuals only. The dataset also
// publishes birth year; it is NOT carried into our records (not needed to verify a license, and avoidable personal data).
const WA_DOH: SocrataLicenseSpec = {
  id: "wa-doh", label: "Washington Department of Health — Health Care Provider Credentials", state: "WA",
  boardAgency: "Washington State Department of Health",
  domain: "data.wa.gov", datasetId: "qxh8-f4bd", typeField: "credentialtype", orderBy: "lastname, firstname, credentialnumber",
  fields: ["credentialnumber", "lastname", "firstname", "middlename", "credentialtype", "status", "firstissuedate", "lastissuedate", "expirationdate", "actiontaken"],
  whereFor: (q, mode) => anyOf([
    q.person ? `${soqlUpperEquals("lastname", q.person.last)} AND ${eqOrPrefix("firstname", q.person.first, mode)}` : null,
    q.number ? `credentialnumber = ${soqlString(q.number)}` : null,
  ]),
  map: (r, src) => mkLicense(src, "WA", "Washington State Department of Health", {
    name: joinName([r.firstname, r.middlename, r.lastname]), kind: "individual", number: r.credentialnumber, type: r.credentialtype,
    statusRaw: r.status, issue: r.firstissuedate, exp: r.expirationdate,
    details: { last_issue_date: isoDate(r.lastissuedate), action_taken: cleanStr(r.actiontaken) },
  }),
};

// Washington Labor & Industries contractor licenses, m8qx-ubtq. Licensees are businesses (incl. sole proprietors, whose
// businessname can be a trade name); the named principal is in primaryprincipalname as "LAST, FIRST M.". The dataset's date
// is the license EFFECTIVE date, used as the nearest thing to an issue date.
const WA_LNI: SocrataLicenseSpec = {
  id: "wa-lni", label: "Washington Labor & Industries — Contractor Licenses", state: "WA",
  boardAgency: "Washington State Department of Labor & Industries",
  domain: "data.wa.gov", datasetId: "m8qx-ubtq", typeField: "contractorlicensetypecodedesc", orderBy: "businessname, contractorlicensenumber",
  fields: ["businessname", "contractorlicensenumber", "contractorlicensetypecodedesc", "businesstypecodedesc", "licenseeffectivedate", "licenseexpirationdate",
    "ubi", "primaryprincipalname", "contractorlicensestatus", "city", "state", "specialtycode1desc"],
  whereFor: (q, mode) => anyOf([
    q.person ? `upper(primaryprincipalname) like ${soqlString(q.person.last + ", " + q.person.first + "%")}` : null,
    q.business ? eqOrPrefix("businessname", q.business, mode) : null,
    q.number ? `contractorlicensenumber = ${soqlString(q.number)}` : null,
  ]),
  map: (r, src) => mkLicense(src, "WA", "Washington State Department of Labor & Industries", {
    name: r.businessname, kind: /individual/i.test(String(r.businesstypecodedesc ?? "")) ? "individual" : "business",
    number: r.contractorlicensenumber, type: r.contractorlicensetypecodedesc, statusRaw: r.contractorlicensestatus,
    issue: r.licenseeffectivedate, exp: r.licenseexpirationdate,
    details: { principal: cleanStr(r.primaryprincipalname), ubi: cleanStr(r.ubi), business_type: cleanStr(r.businesstypecodedesc), specialty: cleanStr(r.specialtycode1desc), city: cleanStr(r.city), holder_state: cleanStr(r.state), issue_date_basis: "license effective date" },
  }),
};

// Delaware Division of Professional Regulation roster on the Delaware Open Data Portal, pjnv-eaih (daily). NOT what the brief assumed:
// the brief describes DELPROS CSV rosters emailed on request, but the full roster -- active AND expired/revoked/closed rows,
// ~354k -- is a public Socrata dataset with no request. Individuals have first_name + last_name; facilities and firms put
// their whole name in last_name and leave first_name empty. The dataset's own disciplinary_action column is 'N' on every row
// (even Suspended / Revoked ones), so it is deliberately ignored: use license_status, or the discipline dataset dz6p-akeq.
const DE_DPR: SocrataLicenseSpec = {
  id: "de-dpr", label: "Delaware Division of Professional Regulation — Professional & Occupational Licensing", state: "DE",
  boardAgency: "Delaware Division of Professional Regulation",
  domain: "data.delaware.gov", datasetId: "pjnv-eaih", typeField: "license_type", orderBy: "last_name, first_name, license_no",
  fields: ["last_name", "first_name", "license_no", "profession_id", "license_type", "city", "state", "issue_date", "expiration_date", "license_status"],
  whereFor: (q, mode) => anyOf([
    q.person ? `${soqlUpperEquals("last_name", q.person.last)} AND ${eqOrPrefix("first_name", q.person.first, mode)}` : null,
    q.business ? eqOrPrefix("last_name", q.business, mode) : null,
    q.number ? `license_no = ${soqlString(q.number)}` : null,
  ]),
  map: (r, src) => mkLicense(src, "DE", "Delaware Division of Professional Regulation", {
    name: joinName([r.first_name, r.last_name]), kind: cleanStr(r.first_name) ? "individual" : "business",
    number: r.license_no, type: r.license_type, statusRaw: r.license_status, issue: r.issue_date, exp: r.expiration_date,
    details: { profession: cleanStr(r.profession_id), city: cleanStr(r.city), holder_state: cleanStr(r.state) },
  }),
};

// Texas Board of Nursing: "RN-All" (tgb2-j935, 796k rows: current AND expired/revoked/..., updated by the Board) and "VN-All" (yjie-tuwv, 318k, Vocational/LVN).
// One row per license; the number is the Board's own (RN and VN are separate numberings). The Board's file also carries gender, ethnicity, county of
// residence, employer, practice setting and school: NONE of that is selected here (not needed to verify a license, and avoidable personal data).
// license_status is "<WORD> (<code>)": CURRENT (C), DELINQUENT (D), INACTIVE (I), DECEASED (E), RETIRED - INACTIVE (Z), REVOKED (R), VOL.SURRENDER (V),
// VOLUNTEER RETIRED (W), NLC LICENSE - TX INVALID(Y), SUSPENDED (S), Current RENEWAL DENIED (K), NOT CURRENT - SEE ENF (X). Dates are YYYYMMDD. The
// column names carry the Board's own typo "lincense". current_board_action (boolean) says a board action is on record for the licensee.
export function txBonStatus(raw: unknown): LicenseRecord["status"] {
  const m = /\(([A-Z])\)\s*$/.exec(String(raw ?? "").trim());
  switch (m?.[1]) {
    case "C": return "active";
    case "D": return "expired";                         // delinquent: renewal overdue
    case "I": case "Z": case "W": case "E": case "V": return "inactive"; // inactive, retired, volunteer-retired, deceased, voluntarily surrendered
    case "R": return "revoked";
    case "S": return "suspended";
    default: return "other";                            // NLC invalid, renewal denied, see enforcement: status_raw carries the truth
  }
}
const txBon = (id: "tx-bon-rn" | "tx-bon-vn", datasetId: string, label: string, type: string): SocrataLicenseSpec => ({
  id, label, state: "TX", boardAgency: "Texas Board of Nursing", domain: "data.texas.gov", datasetId, fixedType: type, orderBy: "last_name, first_name, license_number",
  fields: ["license_number", "last_name", "first_name", "middle_name", "license_status", "lincense_status_date", "lincense_expiration_date", "texas_license_issuance_date",
    ...(id === "tx-bon-rn" ? ["current_board_action", "date_of_board_action_imposed"] : [])],
  whereFor: (q, mode) => anyOf([
    q.person ? `${soqlUpperEquals("last_name", q.person.last)} AND ${eqOrPrefix("first_name", q.person.first, mode)}` : null,
    // the Board's license_number column is NUMERIC: a non-numeric search form (the TREC "763827-SA" variants a combined Texas lookup also tries) is a bad query, not a miss
    q.number && /^\d{1,12}$/.test(q.number) ? `license_number = ${soqlString(q.number)}` : null,
  ]),
  map: (r, src) => mkLicense(src, "TX", "Texas Board of Nursing", {
    name: joinName([r.first_name, r.middle_name, r.last_name]), kind: "individual", number: r.license_number, type, statusRaw: r.license_status,
    status: txBonStatus(r.license_status), issue: r.texas_license_issuance_date, exp: r.lincense_expiration_date,
    details: { status_date: isoDate(r.lincense_status_date), ...(id === "tx-bon-rn" ? { board_action: r.current_board_action === true || String(r.current_board_action).toLowerCase() === "true", board_action_date: isoDate(r.date_of_board_action_imposed) } : {}) },
  }),
});
const TX_BON_RN = txBon("tx-bon-rn", "tgb2-j935", "Texas Board of Nursing — Registered Nurses (RN-All)", "Registered Nurse");
const TX_BON_VN = txBon("tx-bon-vn", "yjie-tuwv", "Texas Board of Nursing — Vocational Nurses (VN-All)", "Vocational Nurse");

// Texas Real Estate Commission "Broker and Sales Agent License Holder Information" (s7ft-44qi, 326k rows, updated daily): sales agents, individual brokers and
// broker companies with their status. license_number carries a type suffix ("763827-SA" sales agent, "-B" broker, "-BB" broker company). The file also carries
// county and the supervising broker; neither is selected.
const TX_TREC: SocrataLicenseSpec = {
  id: "tx-trec", label: "Texas Real Estate Commission — Broker and Sales Agent Licenses", state: "TX", boardAgency: "Texas Real Estate Commission",
  domain: "data.texas.gov", datasetId: "s7ft-44qi", typeField: "license_type", orderBy: "last_name, first_name, license_number",
  fields: ["license_type", "license_number", "full_name", "suffix", "status", "original_license_date", "license_expiration_date", "first_name", "middle_name", "last_name"],
  whereFor: (q, mode) => anyOf([
    q.person ? `${soqlUpperEquals("last_name", q.person.last)} AND ${eqOrPrefix("first_name", q.person.first, mode)}` : null,
    q.business ? `license_type = 'Broker Company' AND ${eqOrPrefix("full_name", q.business, mode)}` : null,
    q.number ? `license_number = ${soqlString(q.number)}` : null,
  ]),
  map: (r, src) => {
    const isBiz = String(r.license_type ?? "") === "Broker Company";
    return mkLicense(src, "TX", "Texas Real Estate Commission", {
      name: isBiz ? r.full_name : joinName([r.first_name, r.middle_name, r.last_name, r.suffix]) || r.full_name, kind: isBiz ? "business" : "individual",
      number: r.license_number, type: r.license_type, statusRaw: r.status, issue: r.original_license_date, exp: r.license_expiration_date,
    });
  },
};

export const SOCRATA_LICENSE_SPECS = [CO_DORA, CT_DCP, IL_IDFPR, WA_DOH, WA_LNI, DE_DPR, TX_BON_RN, TX_BON_VN, TX_TREC];
export function socrataLicenseSources(appToken?: string): LicenseSource[] {
  return SOCRATA_LICENSE_SPECS.map((s) => makeSocrataLicenseSource(s, appToken));
}
