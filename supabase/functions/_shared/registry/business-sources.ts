// Business-registry sources built on the shared Socrata client (Stage 1, 2026-09-30): Colorado, New York, Connecticut, Oregon,
// Pennsylvania. One factory, one config per dataset. Every field name below was taken from the dataset's own metadata
// (GET https://<domain>/api/views/<id>.json) and confirmed against real rows on 2026-09-30 -- none is assumed.
//
// Two of the datasets (Oregon tckn-sxa6, Pennsylvania xvd7-5r2c) are ONE ROW PER ASSOCIATED PARTY, not one row per entity
// (Oregon: principal place of business / registered agent / mailing address / authorized representative; Pennsylvania:
// president / treasurer / governor / ...). Counting or returning rows there overcounts the same business 2-4x. Those configs
// set `groupBy`, which makes Socrata itself collapse the rows to one per entity (SoQL $group over the entity-level fields),
// and the adapter additionally de-duplicates on the entity id as a second guard.

import { SocrataClient, soqlString, soqlUpperEquals, soqlUpperPrefix } from "./socrata.ts";
import type { AdapterMeta, BusinessSource, BusinessQuery, MatchMode, Outcome } from "./adapter.ts";
import type { BusinessEntity } from "./schema.ts";
import { cleanStr, isoDate, joinName, normalizeBusinessStatus, stripWildcards } from "./normalize.ts";

type Row = Record<string, unknown>;

export interface SocrataBusinessSpec {
  id: string;
  label: string;
  state: string;
  domain: string;
  datasetId: string;
  nameField: string;
  idField: string;
  idIsNumber?: boolean;
  fields: string[]; // entity-level fields to select (for groupBy datasets: ONLY entity-level fields)
  groupBy?: boolean;
  orderBy: string;
  extraWhere?: string;
  map: (row: Row, sourceDataset: string) => BusinessEntity | null;
  enrich?: (records: BusinessEntity[], token?: string) => Promise<void>;
}

function mkEntity(src: string, state: string, o: {
  name: unknown; id: unknown; statusRaw: unknown; statusOverride?: BusinessEntity["status"]; regDate: unknown; type: unknown; details?: Record<string, unknown>;
}): BusinessEntity | null {
  const entity_name = cleanStr(o.name);
  const entity_id = cleanStr(o.id);
  if (!entity_name || !entity_id) return null;
  const status_raw = cleanStr(o.statusRaw);
  return {
    entity_name, entity_id,
    status: o.statusOverride ?? normalizeBusinessStatus(status_raw),
    status_raw,
    registration_date: isoDate(o.regDate),
    entity_type: cleanStr(o.type),
    state, source_dataset: src,
    details: o.details ?? {},
  };
}

export function makeSocrataBusinessSource(spec: SocrataBusinessSpec, appToken?: string): BusinessSource {
  const client = new SocrataClient({ domain: spec.domain, datasetId: spec.datasetId, appToken });
  const source_dataset = client.sourceId;

  const whereFor = (q: BusinessQuery, mode: MatchMode): string | null => {
    const parts: string[] = [];
    const name = cleanStr(q.name);
    if (name) parts.push(mode === "exact" ? soqlUpperEquals(spec.nameField, name) : soqlUpperPrefix(spec.nameField, stripWildcards(name)));
    const id = cleanStr(q.entity_id);
    if (id) {
      if (spec.idIsNumber) { if (!/^\d{1,18}$/.test(id)) return null; parts.push(`${spec.idField} = ${id}`); }
      else parts.push(`${spec.idField} = ${soqlString(id)}`);
    }
    if (parts.length === 0) return null;
    if (spec.extraWhere) parts.push(spec.extraWhere);
    return parts.join(" AND ");
  };

  return {
    id: spec.id, label: spec.label, state: spec.state, source_dataset, kind: "socrata",

    async search(q, mode): Promise<Outcome<BusinessEntity>> {
      const t0 = Date.now();
      const where = whereFor(q, mode);
      if (!where) return { ok: false, source: source_dataset, error: "empty_or_invalid_query" };
      const limit = Math.min(Math.max(q.limit ?? 25, 1), 100);
      const select = spec.fields.join(",");
      const [rows, raw, distinct] = await Promise.all([
        client.query<Row>({ select, where, group: spec.groupBy ? select : undefined, order: spec.orderBy, limit }),
        spec.groupBy ? client.count(where) : Promise.resolve(null),
        spec.groupBy ? client.count(where, spec.idField) : Promise.resolve(null),
      ]);
      if (!rows.ok) return { ok: false, source: source_dataset, error: rows.error, status: rows.status, detail: rows.detail };
      // second dedup guard: one record per entity id, first row wins
      const seen = new Set<string>();
      const records: BusinessEntity[] = [];
      for (const r of rows.rows) {
        const e = spec.map(r, source_dataset);
        if (!e || seen.has(e.entity_id)) continue;
        seen.add(e.entity_id);
        records.push(e);
      }
      const meta: AdapterMeta = { source: source_dataset, attempts: rows.attempts, ms: Date.now() - t0 };
      // raw_rows = every source row the query matches; entities = the distinct entities those rows belong to (NOT the page size)
      if (raw && raw.ok && distinct && distinct.ok) { meta.raw_rows = raw.count; meta.entities = distinct.count; }
      return { ok: true, records, meta };
    },

    enrich: spec.enrich ? (records) => spec.enrich!(records, appToken) : undefined,

    async dedupEvidence(namePrefix) {
      if (!spec.groupBy) return { ok: false, error: "not_a_party_dataset" };
      const where = `${soqlUpperPrefix(spec.nameField, stripWildcards(namePrefix))}${spec.extraWhere ? " AND " + spec.extraWhere : ""}`;
      const [raw, ents] = await Promise.all([client.count(where), client.count(where, spec.idField)]);
      if (!raw.ok) return { ok: false, error: raw.error };
      if (!ents.ok) return { ok: false, error: ents.error };
      return { ok: true, raw_rows: raw.count, entities: ents.count };
    },
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// Per-state specs.

const CO: SocrataBusinessSpec = {
  id: "co-sos", label: "Colorado Secretary of State — Business Entities", state: "CO",
  domain: "data.colorado.gov", datasetId: "4ykn-tg5h",
  nameField: "entityname", idField: "entityid", idIsNumber: true, orderBy: "entityname",
  fields: ["entityid", "entityname", "entitystatus", "entitytype", "jurisdictonofformation" /* sic: the state's own spelling */, "entityformdate",
    "agentfirstname", "agentmiddlename", "agentlastname", "agentorganizationname"],
  map: (r, src) => mkEntity(src, "CO", {
    name: r.entityname, id: r.entityid, statusRaw: r.entitystatus, regDate: r.entityformdate, type: r.entitytype,
    details: {
      jurisdiction_of_formation: cleanStr(r.jurisdictonofformation),
      registered_agent: joinName([r.agentfirstname, r.agentmiddlename, r.agentlastname]) || cleanStr(r.agentorganizationname),
    },
  }),
};

// New York: "Active Corporations: Beginning 1800". The dataset contains ACTIVE entities only and has no status column, so a
// dissolved New York entity is simply absent here; status "active" is implied by membership, and says so in details.
const NY: SocrataBusinessSpec = {
  id: "ny-dos", label: "New York Department of State — Active Corporations", state: "NY",
  domain: "data.ny.gov", datasetId: "n9v6-gdp6",
  nameField: "current_entity_name", idField: "dos_id", orderBy: "current_entity_name",
  fields: ["dos_id", "current_entity_name", "initial_dos_filing_date", "county", "jurisdiction", "entity_type"],
  map: (r, src) => mkEntity(src, "NY", {
    name: r.current_entity_name, id: r.dos_id, statusRaw: null, statusOverride: "active", regDate: r.initial_dos_filing_date, type: r.entity_type,
    details: {
      status_basis: "dataset lists active entities only; it has no status column",
      county: cleanStr(r.county), jurisdiction: cleanStr(r.jurisdiction),
    },
  }),
};

// Connecticut: master table n7gp-d28j. entity_id is the state's business number (accountnumber); the master's own Salesforce
// id is kept in details because the companion tables join on IT, not on accountnumber (verified live 2026-09-30:
// principals.business_id = master.id and agents.business_key = master.id; matching on accountnumber returns nothing).
async function ctEnrich(records: BusinessEntity[], token?: string): Promise<void> {
  const principals = new SocrataClient({ domain: "data.ct.gov", datasetId: "ka36-64k6", appToken: token });
  const agents = new SocrataClient({ domain: "data.ct.gov", datasetId: "qh2m-n44y", appToken: token });
  await Promise.all(records.slice(0, 10).map(async (rec) => {
    const sf = cleanStr(rec.details.salesforce_id);
    if (!sf) return;
    const [p, a] = await Promise.all([
      principals.query<Row>({ select: "name__c,designation,type", where: `business_id = ${soqlString(sf)}`, limit: 25 }),
      agents.query<Row>({ select: "name__c,type", where: `business_key = ${soqlString(sf)}`, limit: 10 }),
    ]);
    rec.details.principals = p.ok ? p.rows.map((x) => ({ name: cleanStr(x.name__c), designation: cleanStr(x.designation), type: cleanStr(x.type) })) : null;
    rec.details.agents = a.ok ? a.rows.map((x) => ({ name: cleanStr(x.name__c), type: cleanStr(x.type) })) : null;
  }));
}
const CT: SocrataBusinessSpec = {
  id: "ct-sots", label: "Connecticut Secretary of the State — Business Registry", state: "CT",
  domain: "data.ct.gov", datasetId: "n7gp-d28j",
  nameField: "name", idField: "accountnumber", orderBy: "name",
  fields: ["id", "accountnumber", "name", "business_type", "status", "sub_status", "date_registration", "dissolution_date", "formation_place", "state_or_territory_formation", "annual_report_due_date"],
  map: (r, src) => mkEntity(src, "CT", {
    // accountnumber is the registry's own id, EXCEPT that Connecticut stamps the placeholder "0000000" on 26 unrelated records (stub entries such as
    // "WEBSTER BANK NATIONAL ASSOCIATION", "Unauthorized" type) and leaves it empty on 3 more (found 2026-10-01: 1,300,463 rows, 1,300,435 distinct
    // numbers). Keyed on that, 26 different businesses would be one entity. For those rows the entity id is the row's unique Salesforce id: "SF-<id>".
    name: r.name, id: (() => { const a = cleanStr(r.accountnumber); return a && a !== "0000000" ? a : cleanStr(r.id) ? `SF-${cleanStr(r.id)}` : null; })(), statusRaw: r.status, regDate: r.date_registration, type: r.business_type,
    details: {
      salesforce_id: cleanStr(r.id), sub_status: cleanStr(r.sub_status), dissolution_date: isoDate(r.dissolution_date),
      formation_place: cleanStr(r.formation_place), jurisdiction: cleanStr(r.state_or_territory_formation),
      annual_report_due_date: isoDate(r.annual_report_due_date),
    },
  }),
  enrich: ctEnrich,
};

// Oregon: ONE ROW PER ASSOCIATED NAME. Grouped on the entity-level columns so the server returns one row per business.
// "Active Businesses - ALL": active entities only, no status column (status implied, recorded in details).
const OR: SocrataBusinessSpec = {
  id: "or-sos", label: "Oregon Secretary of State — Active Businesses", state: "OR",
  domain: "data.oregon.gov", datasetId: "tckn-sxa6",
  nameField: "business_name", idField: "registry_number", orderBy: "business_name", groupBy: true,
  fields: ["registry_number", "business_name", "entity_type", "registry_date", "jurisdiction"],
  map: (r, src) => mkEntity(src, "OR", {
    name: r.business_name, id: r.registry_number, statusRaw: null, statusOverride: "active", regDate: r.registry_date, type: r.entity_type,
    details: { status_basis: "dataset lists active businesses only; it has no status column", jurisdiction: cleanStr(r.jurisdiction) },
  }),
};

// Pennsylvania: ONE ROW PER OFFICER/PARTY. Grouped on the entity-level columns. "Registered Businesses in PA Current": registrations with NO status
// column, updated monthly. The state's own description says: "Due to statutory limitations in removing businesses no longer in operation from our
// database, this data shows a larger number of active businesses than currently exist" (e.g. The Bon-ton Stores, liquidated 2018, and Bethlehem Steel
// Corporation are still listed). So nothing in a row supports "active": the status is "unknown" (fixed 2026-10-01; the adapter used to force "active").
const PA: SocrataBusinessSpec = {
  id: "pa-dos", label: "Pennsylvania Department of State — Registered Businesses", state: "PA",
  domain: "data.pa.gov", datasetId: "xvd7-5r2c",
  nameField: "business_name", idField: "filing_number", orderBy: "business_name", groupBy: true,
  fields: ["filing_number", "business_name", "typeofbusinessregistration", "creationdate"],
  map: (r, src) => mkEntity(src, "PA", {
    name: r.business_name, id: r.filing_number, statusRaw: null, statusOverride: "unknown", regDate: r.creationdate, type: r.typeofbusinessregistration,
    details: {
      status_basis: "dataset has no status column and, per the Department of State, keeps businesses that are no longer in operation; a listing shows the business was registered, not that it operates",
      source_completeness: "registrations_unflagged",
    },
  }),
};

export const SOCRATA_BUSINESS_SPECS = [CO, NY, CT, OR, PA];
export function socrataBusinessSources(appToken?: string): BusinessSource[] {
  return SOCRATA_BUSINESS_SPECS.map((s) => makeSocrataBusinessSource(s, appToken));
}
