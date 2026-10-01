// Texas Comptroller "Active Franchise Taxpayers" (data.texas.gov 9cir-efmm): code tables and the status rule, taken from the Comptroller's own record layout
// ("Franchise Layout.docx", attached to the dataset; read 2026-10-01). Kept in its own module so the mapping is a pure, testable function.
import type { BusinessStatus } from "./schema.ts";

// Taxpayer Organizational Type (the layout's own list, verbatim).
export const TX_ORG_TYPES: Record<string, string> = {
  AB: "TEXAS BUSINESS ASSOC",
  AC: "FRGN BUSINESS ASSOC",
  AF: "FOREIGN PROFESSIONAL ASSOCIATION",
  AP: "TEXAS PROFESSIONAL ASSOCIATION",
  AR: "OTHER ASSOCIATION",
  C: "CORPORATION",
  CF: "FOREIGN PROFIT CORPORATION",
  CI: "FOREIGN LMTD LIAB CO - OOS",
  CL: "TEXAS LIMITED LIABILITY COMPANY",
  CM: "FOREIGN NON-PROFIT CORP - OOS",
  CN: "TEXAS NON-PROFIT CORPORATION",
  CP: "TEXAS PROFESSIONAL CORPORATION",
  CR: "TEXAS INSURANCE CORPORATION",
  CS: "FOREIGN INSURANCE CORP - OOS",
  CT: "TEXAS PROFIT CORPORATION",
  CU: "FOREIGN PROFESSIONAL CORPORATION",
  CW: "TEXAS RAILROAD CORPORATION",
  CX: "FOREIGN RAILROAD CORPORATION",
  DC: "REGISTERED DATA CENTER",
  ES: "ESTATE",
  FA: "FINANCIAL INSTITUTION - STATE SAVINGS & LOAN - OOS",
  FB: "FINANCIAL INSTITUTION - STATE SAVINGS B ANK - TX",
  FC: "FINANCIAL INSTITUTION - FEDERAL CREDIT UNION",
  FD: "FINANCIAL INSTITUTION - STATE SAVINGS & LOAN - TX",
  FE: "FINANCIAL INSTITUTION - FEDERAL SAVINGS & LOAN-TX",
  FF: "FINANCIAL INSTITUTION - FEDERAL BANK - TX",
  FG: "FINANCIAL INSTITUTION - FEDERAL SAVINGS BANK - TX",
  FH: "FINANCIAL INSTITUTION - STATE SAVINGS BANK - OOS",
  FI: "FINANCIAL INSTITUTION - STATE CREDIT UNION - TX",
  FJ: "FINANCIAL INSTITUTION - FEDERAL BANK - OOS",
  FK: "FINANCIAL INSTITUTION - FEDERAL SAVINGS BANK - OOS",
  FL: "FINANCIAL INSTITUTION - STATE LIMITED BANK ASSOC",
  FM: "FINANCIAL INSTITUTION - TRUST COMPANY",
  FN: "FINANCIAL INSTITUTION - FEDERAL SAVINGS & LOAN-OOS",
  FO: "FINANCIAL INSTITUTION - STATE BANK - OOS",
  FP: "FINANCIAL INSTITUTION",
  FR: "FINANCIAL INSTITUTION - FOREIGN COUNTRY BANK",
  FS: "FINANCIAL INSTITUTION - STATE BANK - TX",
  FT: "FINANCIAL INSTITUTION - STATE CREDIT UNION - OOS",
  GC: "CITY",
  GD: "FEDERAL AGENCY",
  GF: "STATE AGENCY - OOS",
  GJ: "JUNIOR COLLEGE",
  GL: "LOCAL OFFICIAL",
  GM: "MASS TRANSIT",
  GO: "COUNTY",
  GP: "SPECIAL PURPOSE DISTRICT",
  GR: "RAPID TRANSIT",
  GS: "SCHOOL DISTRICT",
  GT: "STATE AGENCY - TX",
  GU: "STATE COLLEGE/UNIVERSITY",
  GY: "COMMUNITY COLLEGE",
  HF: "FRGN HOLDING COMPANY",
  HS: "HISTORIC STRUCTURE",
  IS: "INDIVIDUAL - SOLE OWNER",
  J: "JOINT VENTURE",
  L: "LIMITED (LIABILITY) COMPANY",
  M: "LIMITED (LIABILITY) PARTNERSHIP",
  O: "OTHER",
  P: "GENERAL PARTNERSHIP",
  PB: "BUS GENERAL PRTNSHP",
  PF: "FRGN LIMITED PRTNSHP",
  PI: "IND GENERAL PRTNSHP",
  PL: "TX LIMITED PRTNSHP",
  PO: "OIL & GAS SPECIAL",
  PV: "TEXAS JOINT VENTURE",
  PW: "FRGN JOINT VENTURE",
  PX: "TX LLP REGISTRATION",
  PY: "FRGN LLP REGISTRATION",
  PZ: "IND SUCCESSOR PRTSHP",
  S: "SOLE PROPRIETORSHIP",
  SF: "FRGN JOINT STOCK CO",
  ST: "TEXAS JOINT STOCK CO",
  TF: "FOREIGN BUSINESS TRUST",
  TH: "TX RL EST INV TRST",
  TI: "FOREIGN REAL ESTATE INVESTMENT TRUST",
  TR: "TRUST",
  UF: "UNKNOWN - FRANCHISE",
  UK: "UNKNOWN"
};

// SOS Status Code, for records that carry a Secretary of State charter / certificate-of-authority number (Record Type Code U or V).
const TX_SOS_STATUS: Record<string, { label: string; status: BusinessStatus }> = {
  A: { label: "Active", status: "active" },
  R: { label: "Reinstated", status: "active" },
  B: { label: "Consolidated", status: "merged" },
  C: { label: "Converted", status: "merged" },
  M: { label: "Merger", status: "merged" },
  D: { label: "Dissolved", status: "dissolved" },
  E: { label: "Expired", status: "dissolved" },
  I: { label: "Closed by FDIC", status: "dissolved" },
  J: { label: "State charter pulled", status: "dissolved" },
  T: { label: "Terminated", status: "dissolved" },
  W: { label: "Withdrawn", status: "dissolved" },
  Y: { label: "Dead at conversion 69", status: "dissolved" },
  Z: { label: "Dead at conversion 83", status: "dissolved" },
  // Forfeitures: the entity lost its right to transact business (franchise tax, registered agent / office, hot check, court order) but can be revived;
  // that is "exists but out of good standing", not an ended existence.
  F: { label: "Forfeited franchise tax", status: "delinquent" },
  K: { label: "Forfeited registered agent", status: "delinquent" },
  L: { label: "Forfeited registered office", status: "delinquent" },
  N: { label: "Forfeited hot check", status: "delinquent" },
  P: { label: "Forfeited court order", status: "delinquent" },
  G: { label: "Miscellaneous", status: "other" },
};

// Right to Transact Business Code (franchise-tax account standing).
const TX_RIGHT_TO_TRANSACT: Record<string, string> = {
  A: "Active", D: "Active - eligible for termination/withdrawal", N: "Forfeited", I: "Franchise tax involuntarily ended", U: "Franchise tax not established",
};

const code = (v: unknown): string => String(v ?? "").trim().toUpperCase();

export interface TxStatus { status: BusinessStatus; status_raw: string; basis: string }

// One honest status per row. The Secretary of State's own status leads whenever the row has an SOS file number; the Comptroller's right-to-transact code
// can only make it WORSE (an SOS-active entity whose right to transact is forfeited is delinquent), never better. A row with no SOS file number
// (record type X: a Comptroller-assigned number) has only the right-to-transact code to go on, and where that says nothing about standing the status
// is "unknown" (never "active") -- same rule as Pennsylvania, so such a row is routed to staff for operating status downstream.
export function txStatus(sosStatusCode: unknown, rightToTransactCode: unknown, recordTypeCode: unknown): TxStatus {
  const sos = code(sosStatusCode), rtt = code(rightToTransactCode), rec = code(recordTypeCode);
  const sosInfo = sos ? TX_SOS_STATUS[sos] : undefined;
  const rttLabel = rtt ? (TX_RIGHT_TO_TRANSACT[rtt] ?? `code ${rtt}`) : "franchise tax ended";
  const hasSosNumber = rec === "U" || rec === "V";
  const raw = `${sosInfo ? `SOS: ${sosInfo.label}` : hasSosNumber && sos ? `SOS: code ${sos}` : "no SOS file number"}; right to transact: ${rttLabel}`;
  if (hasSosNumber && sosInfo) {
    let status = sosInfo.status;
    if (status === "active" && (rtt === "N" || rtt === "I")) status = "delinquent";
    return { status, status_raw: raw, basis: "sos_status" };
  }
  if (hasSosNumber && sos) return { status: "other", status_raw: raw, basis: "sos_status_unrecognised" };
  if (rtt === "A" || rtt === "D") return { status: "active", status_raw: raw, basis: "right_to_transact" };
  if (rtt === "N" || rtt === "I") return { status: "delinquent", status_raw: raw, basis: "right_to_transact" };
  return { status: "unknown", status_raw: raw, basis: "right_to_transact" };
}
