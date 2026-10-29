// node --experimental-strip-types tools/resume/test-resume-role-buckets-pages.ts   (no dependencies, no network, no model call)
// AP9 phase D: what the role bucket check does when a company / role group crosses a PAGE BREAK. Made-up page pairs are cut from the real
// Asampletest and PironeSimple text and from invented text. Each case runs the pipeline the way upload-resume does (check page by page,
// then the existing cross-page merge, then the position numbering, then the final latest-first order) and again with the check switched
// off ("doing nothing"). The result must never be WORSE than doing nothing:
//   worse = a duplicated entry, a phantom or empty entry that should not exist, an invented date, a lost line, a role under the wrong
//   company, or a title containing " to ". Safe failure = the check does nothing, or only adds a needs_review entry with the literal lines.
// The page merge (mergeExtractions, dedupePositions) is read from upload-resume's own source, so the real merge logic runs.
import assert from "node:assert/strict";
import fs from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { repairRoleBuckets, orderRoleGroupsLatestFirst, type RoleEntry } from "../../supabase/functions/_shared/resume-role-buckets.ts";

const src = fs.readFileSync(new URL("../../supabase/functions/upload-resume/index.ts", import.meta.url), "utf8").replace(/\r\n/g, "\n");
const body = src.slice(src.indexOf("const PAGE_POSITION_SPAN"), src.indexOf("const RELAY_CALLS_PER_INVOCATION"));
const merge: any = await import("data:text/javascript;base64," + Buffer.from(stripTypeScriptTypes(body) + "\nexport { mergeExtractions, dedupePositions };", "utf8").toString("base64"));

type Page = { ocr: string; entries: RoleEntry[] };
const norm = (s: unknown) => String(s ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "");
const e = (company: string, title: string, sd: string, ed: string, text: string, heading = "PROFESSIONAL EXPERIENCE"): RoleEntry => ({ company, title, start_date: sd, end_date: ed, job_responsibilities: text, heading, location: "", extraction_confidence: "high" });

function run(pages: Page[], withCheck: boolean) {
  const rows = pages.map((p, i) => {
    let wh = p.entries.map((x, k) => ({ ...x, position: k }));
    let freeform: any[] = [];
    if (withCheck) {
      const fix = repairRoleBuckets(p.ocr, wh, i + 1);
      wh = fix.work_history; freeform = fix.needsReview;
    }
    return { pageNumber: i + 1, extraction: { work_history: wh, education: [], certifications: [], skills: [], freeform } };
  });
  const merged = merge.dedupePositions(merge.mergeExtractions(rows), { sections: [] });
  merged.work_history = orderRoleGroupsLatestFirst(merged.work_history);
  return { entries: merged.work_history as RoleEntry[], review: merged.freeform as any[] };
}

// owner: a phrase from the source and the title of the role it belongs to (text attached to the wrong role is a failure)
type Case = { id: string; what: string; pages: Page[]; ideal: Array<[string, string, string, boolean]>; companyOf: Record<string, string>; keep: string[]; owner: Record<string, string> };
const key = (w: RoleEntry) => `${w.company}|${w.title}|${w.start_date}|${w.end_date}|${String(w.job_responsibilities || "").trim() ? "text" : "empty"}`;
function flags(entries: RoleEntry[], c: Case) {
  const all = c.pages.map((p) => norm(p.ocr)).join("");
  const seen = new Map<string, number>(); for (const w of entries) { const k = norm(w.company) + "#" + norm(w.title); seen.set(k, (seen.get(k) || 0) + 1); }
  const text = norm(entries.map((w) => String(w.job_responsibilities || "")).join("\n"));
  const years = (s: unknown) => String(s || "").match(/\d{4}/g) || [];
  return {
    duplicated: [...seen.values()].filter((v) => v > 1).length,
    phantom: entries.filter((w) => !String(w.job_responsibilities || "").trim() && !(w.title && all.includes(norm(w.title)))).length,
    inventedDate: entries.filter((w) => [...years(w.start_date), ...years(w.end_date)].some((y) => !all.includes(y))).length,
    lostLine: c.keep.filter((k) => !text.includes(norm(k))).length,
    wrongCompany: entries.filter((w) => w.title && c.companyOf[w.title as string] && norm(w.company) !== norm(c.companyOf[w.title as string])).length,
    toInTitle: entries.filter((w) => / to /i.test(String(w.title || ""))).length,
    wrongRole: Object.entries(c.owner).filter(([phrase, title]) => { const holder = entries.find((w) => norm(w.job_responsibilities).includes(norm(phrase))); return !holder || norm(holder.title) !== norm(title); }).length,
  };
}

// ---------- the real Asampletest WESTCX lines ----------
const WCO = "WESTCX, Remote September 2023 August 2026";
const WDESC = "WestCx is a cloud-based technology partner that delivers AI-powered solutions for regulated industries like\nhealthcare, pharmacy, and financial services. The company was acquired in July 2026.";
const SR_H = "Senior Recruiter, July 2024 August 2026";
const SR_B1 = "PE-backed, cloud-based AI customer & patient experience platform\ne Managed recruiting for multiple departments across dual company segments, including GTM sales teams,\nproduct, engineering, and IT, owning full-cycle recruiting solo for both TeleVox and Mosaicx.";
const SR_B2 = "Standardized the global recruiting SOP by streamlining the end-to-end process across two countries,\nreplacing ad hoc handoffs with defined approval gates and clear ownership.";
const REC_H = "Recruiter, September 2023 June 2024";
const REC_B1 = "Recruited solely for the TeleVox business segment, a patient engagement platform\n¢ Promoted into an expanded Senior Recruiter scope after the manager role was eliminated, reporting directly\nto the CHRO with added ownership across HR Operations and Vendor Management.";
const REC_B2 = "e Established the initial APAC agency relationships and operating frameworks for a new India-based office,\nhiring 25 technical and product professionals against a 3-month deliverable SLA.";
const NEXT = "CONTRACT ENGAGEMENTS, Remote November 2020 May 2023\nVarious short term contracts allowing flexibility while caring for my mother in her final months\nSourcing Recruiter";
const flat = (s: string) => s.replace(/\n(?:e |¢ )?/g, " ").replace(/\s+/g, " ").trim();
const SRB1 = "PE-backed, cloud-based AI customer & patient experience platform\nManaged recruiting for multiple departments across dual company segments, including GTM sales teams, product, engineering, and IT, owning full-cycle recruiting solo for both TeleVox and Mosaicx.";
const SRB2 = "Standardized the global recruiting SOP by streamlining the end-to-end process across two countries, replacing ad hoc handoffs with defined approval gates and clear ownership.";
const RECB1 = "Recruited solely for the TeleVox business segment, a patient engagement platform\nPromoted into an expanded Senior Recruiter scope after the manager role was eliminated, reporting directly to the CHRO with added ownership across HR Operations and Vendor Management.";
const RECB2 = "Established the initial APAC agency relationships and operating frameworks for a new India-based office, hiring 25 technical and product professionals against a 3-month deliverable SLA.";
const WDESC1 = "WestCx is a cloud-based technology partner that delivers AI-powered solutions for regulated industries like healthcare, pharmacy, and financial services. The company was acquired in July 2026.";
const WKEEP = ["Managed recruiting for multiple departments", "Standardized the global recruiting SOP", "Recruited solely for the TeleVox", "Established the initial APAC agency", "cloud-based technology partner"];
const WCOMP = { "Senior Recruiter": "WESTCX", "Recruiter": "WESTCX", "Sourcing Recruiter": "CONTRACT ENGAGEMENTS" };
const WIDEAL: Case["ideal"] = [["Senior Recruiter", "2024-07", "2026-08", true], ["Recruiter", "2023-09", "2024-06", true], ["Sourcing Recruiter", "2020-11", "2023-05", true]];
const CONTRACT = e("CONTRACT ENGAGEMENTS", "Sourcing Recruiter", "2020-11", "2023-05", "Various short term contracts allowing flexibility while caring for my mother in her final months");
const mergedLabel = `${WDESC1}\n\nRecruiter, September 2023 - June 2024:\n${RECB1}\n${RECB2}\n\nSenior Recruiter, July 2024 - August 2026:\n${SRB1}\n${SRB2}`;

const cases: Case[] = [];
// (a) company line and the first role at the bottom of page 1, the second role at the top of page 2
cases.push({ id: "a1", what: "(a) company line + role 1 end page 1; role 2 starts page 2; model gives one entry per role", ideal: WIDEAL, companyOf: WCOMP, keep: WKEEP,
  pages: [{ ocr: `PROFESSIONAL EXPERIENCE\n${WCO}\n${WDESC}\n${SR_H}\n${SR_B1}\n${SR_B2}`, entries: [e("WESTCX", "Senior Recruiter", "2024-07", "2026-08", `${WDESC1}\n${SRB1}\n${SRB2}`)] },
    { ocr: `${REC_H}\n${REC_B1}\n${REC_B2}\n${NEXT}`, entries: [e("WESTCX", "Recruiter", "2023-09", "2024-06", `${RECB1}\n${RECB2}`), CONTRACT] }] });
cases.push({ id: "a2", what: "(a) same, but the model treats the top of page 2 as a continuation (blank company and title)", ideal: WIDEAL, companyOf: WCOMP, keep: WKEEP,
  pages: [{ ocr: `PROFESSIONAL EXPERIENCE\n${WCO}\n${WDESC}\n${SR_H}\n${SR_B1}\n${SR_B2}`, entries: [e("WESTCX", "Senior Recruiter", "2024-07", "2026-08", `${WDESC1}\n${SRB1}\n${SRB2}`)] },
    { ocr: `${REC_H}\n${REC_B1}\n${REC_B2}\n${NEXT}`, entries: [e("", "", "", "", `Recruiter, September 2023 - June 2024:\n${RECB1}\n${RECB2}`), CONTRACT] }] });
// (b) company line alone at the bottom of page 1, all role lines on page 2
cases.push({ id: "b1", what: "(b) company line alone ends page 1; all role lines on page 2; model keeps a header-only entry on page 1", ideal: WIDEAL, companyOf: WCOMP, keep: WKEEP,
  pages: [{ ocr: `PROFESSIONAL EXPERIENCE\n${WCO}\n${WDESC}`, entries: [e("WESTCX", "", "2023-09", "2026-08", WDESC1)] },
    { ocr: `${SR_H}\n${SR_B1}\n${SR_B2}\n${REC_H}\n${REC_B1}\n${REC_B2}\n${NEXT}`, entries: [e("WESTCX", "Senior Recruiter", "2024-07", "2026-08", `${SRB1}\n${SRB2}`), e("WESTCX", "Recruiter", "2023-09", "2024-06", `${RECB1}\n${RECB2}`), CONTRACT] }] });
cases.push({ id: "b2", what: "(b) same, the model gives page 2 one merged entry (no company line on page 2 to anchor on)", ideal: WIDEAL, companyOf: WCOMP, keep: WKEEP,
  pages: [{ ocr: `PROFESSIONAL EXPERIENCE\n${WCO}\n${WDESC}`, entries: [e("WESTCX", "", "2023-09", "2026-08", WDESC1)] },
    { ocr: `${SR_H}\n${SR_B1}\n${SR_B2}\n${REC_H}\n${REC_B1}\n${REC_B2}\n${NEXT}`, entries: [e("WESTCX", "Recruiter to Senior Recruiter", "2023-09", "2026-08", `Recruiter, September 2023 - June 2024:\n${RECB1}\n${RECB2}\n\nSenior Recruiter, July 2024 - August 2026:\n${SRB1}\n${SRB2}`), CONTRACT] }] });
// (c) all role lines on page 1, their bullets continuing on page 2
cases.push({ id: "c1", what: "(c) both role lines on page 1, the last role's bullets continue on page 2; model merged the roles on page 1", ideal: WIDEAL, companyOf: WCOMP, keep: WKEEP,
  pages: [{ ocr: `PROFESSIONAL EXPERIENCE\n${WCO}\n${WDESC}\n${SR_H}\n${SR_B1}\n${SR_B2}\n${REC_H}\n${REC_B1}`, entries: [e("WESTCX", "Recruiter to Senior Recruiter", "2023-09", "2026-08", `${WDESC1}\n\nRecruiter, September 2023 - June 2024:\n${RECB1}\n\nSenior Recruiter, July 2024 - August 2026:\n${SRB1}\n${SRB2}`)] },
    { ocr: `${REC_B2}\n${NEXT}`, entries: [e("", "", "", "", RECB2), CONTRACT] }] });
cases.push({ id: "c2", what: "(c) same, the model split the roles itself on page 1", ideal: WIDEAL, companyOf: WCOMP, keep: WKEEP,
  pages: [{ ocr: `PROFESSIONAL EXPERIENCE\n${WCO}\n${WDESC}\n${SR_H}\n${SR_B1}\n${SR_B2}\n${REC_H}\n${REC_B1}`, entries: [e("WESTCX", "Senior Recruiter", "2024-07", "2026-08", `${WDESC1}\n${SRB1}\n${SRB2}`), e("WESTCX", "Recruiter", "2023-09", "2024-06", RECB1)] },
    { ocr: `${REC_B2}\n${NEXT}`, entries: [e("", "", "", "", RECB2), CONTRACT] }] });
// (c) pooled list: role lines together, the pooled bullets continue on page 2
const NW = "NORTHWIND SUPPLY CO., Austin, TX 2017 2023";
cases.push({ id: "c3", what: "(c) pooled list: two dated role lines together, bullets 1-2 on page 1, bullet 3 on page 2", companyOf: { "Senior Manager": "NORTHWIND SUPPLY CO.", "Manager": "NORTHWIND SUPPLY CO." },
  ideal: [["Senior Manager", "2020", "2023", true], ["Manager", "2017", "2020", false]], keep: ["Managed daily operations for a team of twelve", "Introduced a weekly review process", "Trained the whole team on the new process"],
  pages: [{ ocr: `EXPERIENCE\n${NW}\nSenior Manager, 2020 2023\nManager, 2017 2020\n• Managed daily operations for a team of twelve and reduced order errors by 18%.\n• Introduced a weekly review process that shortened onboarding time for new staff.`, entries: [e("NORTHWIND SUPPLY CO.", "Senior Manager", "2017", "2023", "Managed daily operations for a team of twelve and reduced order errors by 18%.\nIntroduced a weekly review process that shortened onboarding time for new staff.")] },
    { ocr: `• Trained the whole team on the new process and wrote the handbook.\nEDUCATION\nBS Example University`, entries: [e("", "", "", "", "Trained the whole team on the new process and wrote the handbook.")] }] });
// (c) printed OLDEST role first: the last printed role (the latest one) receives the continuing bullet
cases.push({ id: "c4", what: "(c) roles printed oldest first, the last printed (latest) role's bullet continues on page 2; model merged the roles", companyOf: { "Senior Manager": "NORTHWIND SUPPLY CO.", "Manager": "NORTHWIND SUPPLY CO." },
  ideal: [["Senior Manager", "2020", "2023", true], ["Manager", "2017", "2020", true]], keep: ["Introduced the new vendor onboarding checklist", "Led the regional operations team", "Built the weekly reporting process"],
  pages: [{ ocr: `EXPERIENCE\n${NW}\nManager, 2017 2020\n• Introduced the new vendor onboarding checklist.\nSenior Manager, 2020 2023\n• Led the regional operations team across three sites.`, entries: [e("NORTHWIND SUPPLY CO.", "Manager to Senior Manager", "2017", "2023", "Manager, 2017 - 2020:\nIntroduced the new vendor onboarding checklist.\n\nSenior Manager, 2020 - 2023:\nLed the regional operations team across three sites.")] },
    { ocr: `• Built the weekly reporting process used by finance.\nEDUCATION`, entries: [e("", "", "", "", "Built the weekly reporting process used by finance.")] }] });
// (d) role header at the bottom of page 1, dated subnote at the top of page 2 (the Thomson Reuters shape, cut)
const TRH = "Manager of Business Analysis and Publishing Systems | Thomson Reuters | Montvale, NJ | 1996 1998";
const TRN = "Promoted mid-year from Desktop Publishing Manager (1996-1997)";
const TRB1 = "+ Led cross-functional discovery across 15 professional medical journals, aligning a core decision-making team of 45-50\nstakeholders on requirements, constraints, and success criteria for a unified editorial workflow platform.";
const TRB2 = "Ran a 4-month RFP process; when no external vendor met business requirements, authored and delivered an internal proposal\nin place of a vendor response.";
const TRKEEP = ["Led cross-functional discovery", "Ran a 4-month RFP process", "Promoted mid-year from Desktop Publishing Manager"];
const TRCOMP = { "Manager of Business Analysis and Publishing Systems": "Thomson Reuters", "Desktop Publishing Manager": "Thomson Reuters", "Project Manager": "Letraset" };
const TRIDEAL: Case["ideal"] = [["Manager of Business Analysis and Publishing Systems", "1996", "1998", true], ["Desktop Publishing Manager", "1996", "1997", false], ["Project Manager", "1995", "1996", true]];
const LET = e("Letraset", "Project Manager", "1995", "1996", "Managed delivery of an HTML-based CD-ROM product platform.");
const LETOCR = "Project Manager | Letraset | Paramus, NJ | 1995 — 1996\n+ Managed delivery of an HTML-based CD-ROM product platform to a customer base in the thousands";
cases.push({ id: "d1", what: "(d) role header ends page 1; the dated note starts page 2 (model: blank continuation on page 2)", ideal: TRIDEAL, companyOf: TRCOMP, keep: TRKEEP,
  pages: [{ ocr: `Thomson Healthcare line\n${TRH}`, entries: [e("Thomson Reuters", "Manager of Business Analysis and Publishing Systems", "1996", "1998", "")] },
    { ocr: `${TRN}\n${TRB1}\n${TRB2}\n${LETOCR}`, entries: [e("", "", "", "", `${TRN}\n${flat(TRB1)}\n${flat(TRB2)}`), LET] }] });
cases.push({ id: "d2", what: "(d) same, the model gives the earlier role its own entry on page 2 (company and title, no text)", ideal: TRIDEAL, companyOf: TRCOMP, keep: TRKEEP,
  pages: [{ ocr: `Thomson Healthcare line\n${TRH}`, entries: [e("Thomson Reuters", "Manager of Business Analysis and Publishing Systems", "1996", "1998", "")] },
    { ocr: `${TRN}\n${TRB1}\n${TRB2}\n${LETOCR}`, entries: [e("Thomson Reuters", "Desktop Publishing Manager", "1996", "1997", ""), e("", "", "", "", `${flat(TRB1)}\n${flat(TRB2)}`), LET] }] });
// (e) header + note at the bottom of page 1, the bullets on page 2
cases.push({ id: "e1", what: "(e) header and dated note end page 1; the bullets continue on page 2 (model: one entry, blank continuation)", ideal: TRIDEAL, companyOf: TRCOMP, keep: TRKEEP,
  pages: [{ ocr: `Thomson Healthcare line\n${TRH}\n—\n${TRN}`, entries: [e("Thomson Reuters", "Manager of Business Analysis and Publishing Systems", "1996", "1998", TRN)] },
    { ocr: `${TRB1}\n${TRB2}\n${LETOCR}`, entries: [e("", "", "", "", `${flat(TRB1)}\n${flat(TRB2)}`), LET] }] });
cases.push({ id: "e2", what: "(e) same, the model gave the old split (1997 start, no note) on page 1; continuation on page 2", ideal: TRIDEAL, companyOf: TRCOMP, keep: TRKEEP,
  pages: [{ ocr: `Thomson Healthcare line\n${TRH}\n—\n${TRN}`, entries: [e("Thomson Reuters", "Desktop Publishing Manager", "1996", "1997", ""), e("Thomson Reuters", "Manager of Business Analysis and Publishing Systems", "1997", "1998", "")] },
    { ocr: `${TRB1}\n${TRB2}\n${LETOCR}`, entries: [e("", "", "", "", `${flat(TRB1)}\n${flat(TRB2)}`), LET] }] });
cases.push({ id: "e3", what: "(e) same, the continuation on page 2 repeats company and title (a matching header)", ideal: TRIDEAL, companyOf: TRCOMP, keep: TRKEEP,
  pages: [{ ocr: `Thomson Healthcare line\n${TRH}\n—\n${TRN}`, entries: [e("Thomson Reuters", "Manager of Business Analysis and Publishing Systems", "1996", "1998", TRN)] },
    { ocr: `${TRB1}\n${TRB2}\n${LETOCR}`, entries: [e("Thomson Reuters", "Manager of Business Analysis and Publishing Systems", "", "", `${flat(TRB1)}\n${flat(TRB2)}`), LET] }] });
// (f) the same company printed again as a running header at the top of page 2
const NWC = "NORTHWIND SUPPLY CO., Austin, TX 2015 2023";
cases.push({ id: "f1", what: "(f) company repeated as a running header on page 2; role 1 continues, role 2 starts", companyOf: { "Senior Manager": "NORTHWIND SUPPLY CO.", "Manager": "NORTHWIND SUPPLY CO." },
  ideal: [["Senior Manager", "2020", "2023", true], ["Manager", "2017", "2020", true]], keep: ["Led the regional operations team", "Built the weekly reporting process", "Reduced order errors by 18%"],
  pages: [{ ocr: `EXPERIENCE\n${NWC}\nSenior Manager, 2020 2023\n• Led the regional operations team across three sites.\n• Built the weekly reporting process used by finance.`, entries: [e("NORTHWIND SUPPLY CO.", "Senior Manager", "2020", "2023", "Led the regional operations team across three sites.\nBuilt the weekly reporting process used by finance.")] },
    { ocr: `${NWC} (continued)\n• Reduced order errors by 18% in the first year.\nManager, 2017 2020\n• Introduced the new vendor onboarding checklist.`, entries: [e("NORTHWIND SUPPLY CO.", "Senior Manager", "", "", "Reduced order errors by 18% in the first year."), e("NORTHWIND SUPPLY CO.", "Manager", "2017", "2020", "Introduced the new vendor onboarding checklist.")] }] });
cases.push({ id: "f2", what: "(f) running header on page 2 followed by two role lines; model merged them", companyOf: { "Senior Manager": "NORTHWIND SUPPLY CO.", "Manager": "NORTHWIND SUPPLY CO.", "Analyst": "NORTHWIND SUPPLY CO." },
  ideal: [["Senior Manager", "2020", "2023", true], ["Manager", "2017", "2020", true], ["Analyst", "2015", "2017", true]], keep: ["Led the regional operations team", "Introduced the new vendor onboarding checklist", "Prepared the monthly sales report"],
  pages: [{ ocr: `EXPERIENCE\n${NWC}\nSenior Manager, 2020 2023\n• Led the regional operations team across three sites.`, entries: [e("NORTHWIND SUPPLY CO.", "Senior Manager", "2020", "2023", "Led the regional operations team across three sites.")] },
    { ocr: `${NWC} (continued)\nManager, 2017 2020\n• Introduced the new vendor onboarding checklist.\nAnalyst, 2015 2017\n• Prepared the monthly sales report.`, entries: [e("NORTHWIND SUPPLY CO.", "Analyst to Manager", "2015", "2020", "Analyst, 2015 - 2017:\nPrepared the monthly sales report.\n\nManager, 2017 - 2020:\nIntroduced the new vendor onboarding checklist.")] }] });
// extra: three roles, the third role alone on page 2 (no company line there)
cases.push({ id: "h1", what: "(extra) company + two roles on page 1, an older third role alone on page 2", companyOf: { "Senior Manager": "NORTHWIND SUPPLY CO.", "Manager": "NORTHWIND SUPPLY CO.", "Analyst": "NORTHWIND SUPPLY CO." },
  ideal: [["Senior Manager", "2020", "2023", true], ["Manager", "2017", "2020", true], ["Analyst", "2015", "2017", true]], keep: ["Led the regional operations team", "Introduced the new vendor onboarding checklist", "Prepared the monthly sales report"],
  pages: [{ ocr: `EXPERIENCE\n${NWC}\nSenior Manager, 2020 2023\n• Led the regional operations team across three sites.\nManager, 2017 2020\n• Introduced the new vendor onboarding checklist.`, entries: [e("NORTHWIND SUPPLY CO.", "Manager to Senior Manager", "2017", "2023", "Manager, 2017 - 2020:\nIntroduced the new vendor onboarding checklist.\n\nSenior Manager, 2020 - 2023:\nLed the regional operations team across three sites.")] },
    { ocr: `Analyst, 2015 2017\n• Prepared the monthly sales report.\nEDUCATION`, entries: [e("NORTHWIND SUPPLY CO.", "Analyst", "2015", "2017", "Prepared the monthly sales report.")] }] });

const WOWN = { "Recruited solely for the TeleVox": "Recruiter", "Established the initial APAC agency": "Recruiter", "Managed recruiting for multiple departments": "Senior Recruiter" };
const TROWN = { "Led cross-functional discovery": "Manager of Business Analysis and Publishing Systems", "Ran a 4-month RFP process": "Manager of Business Analysis and Publishing Systems" };
const OWNERS: Record<string, Record<string, string>> = {
  a1: WOWN, a2: WOWN, b1: WOWN, b2: WOWN, c1: WOWN, c2: WOWN,
  c3: { "Trained the whole team": "Senior Manager", "Managed daily operations": "Senior Manager" },
  c4: { "Built the weekly reporting process": "Senior Manager", "Introduced the new vendor onboarding": "Manager", "Led the regional operations": "Senior Manager" },
  d1: TROWN, d2: TROWN, e1: TROWN, e2: TROWN, e3: TROWN,
  f1: { "Reduced order errors": "Senior Manager", "Introduced the new vendor onboarding": "Manager" },
  f2: { "Introduced the new vendor onboarding": "Manager", "Prepared the monthly sales report": "Analyst" },
  h1: { "Introduced the new vendor onboarding": "Manager", "Led the regional operations": "Senior Manager", "Prepared the monthly sales report": "Analyst" },
};
for (const c of cases) c.owner = OWNERS[c.id] || {};

// ---------- negative control: the same check WITHOUT the merge-safe order must be caught as worse (proves the test can see the failure) ----------
{
  const c = cases.find((x) => x.id === "e1")!;
  const rows = c.pages.map((p, i) => {
    let wh = p.entries.map((x, k) => ({ ...x, position: k }));
    const fix = repairRoleBuckets(p.ocr, wh, i + 1);
    wh = fix.work_history;
    // naive order: header role first, earlier role last (so the page merge sends the continuing text to the empty earlier role)
    const grp = wh.filter((w) => w._role_group); if (grp.length === 2) wh = [...wh.filter((w) => !w._role_group), ...[...grp].reverse()].sort((a, b) => (a.position ?? 0) - (b.position ?? 0) || 0);
    return { pageNumber: i + 1, extraction: { work_history: wh, education: [], certifications: [], skills: [], freeform: [] } };
  });
  const naive = merge.dedupePositions(merge.mergeExtractions(rows), { sections: [] });
  const f = flags(orderRoleGroupsLatestFirst(naive.work_history), c);
  assert.ok(f.wrongRole > 0, "negative control: a header-first written order must attach the continuing text to the wrong role");
  console.log("negative control ok: header-first written order puts the continuing bullets on the wrong role (wrongRole=" + f.wrongRole + ")");
}

// ---------- run ----------
const rows: string[] = []; let worse = 0, fixed = 0, safe = 0, same = 0, other = 0;
for (const c of cases) {
  const base = run(c.pages, false), rep = run(c.pages, true);
  const fb = flags(base.entries, c), fr = flags(rep.entries, c);
  const isWorse = (Object.keys(fr) as Array<keyof typeof fr>).some((k) => fr[k] > fb[k]);
  const sameAsNothing = JSON.stringify(base.entries.map(key)) === JSON.stringify(rep.entries.map(key));
  const onlyReview = sameAsNothing && rep.review.length > base.review.length;
  const idealKeys = c.ideal.map(([t, s, en, tx]) => `${t}|${s}|${en}|${tx ? "text" : "empty"}`);
  const strip = (w: RoleEntry) => key(w).split("|").slice(1).join("|");
  const repMatches = JSON.stringify(rep.entries.filter((w) => c.companyOf[w.title as string]).map(strip)) === JSON.stringify(idealKeys);
  const baseMatches = JSON.stringify(base.entries.filter((w) => c.companyOf[w.title as string]).map(strip)) === JSON.stringify(idealKeys);
  const verdict = isWorse ? "WORSE THAN NOTHING" : onlyReview ? "SAFE (needs review added)" : sameAsNothing ? (repMatches ? "SAME AS NOTHING (already right)" : "SAFE (check did nothing)") : repMatches && !baseMatches ? "FIXED" : repMatches ? "RIGHT (both)" : "DIFFERENT, NOT WORSE";
  if (isWorse) worse++; else if (verdict === "FIXED") fixed++; else if (verdict.startsWith("SAFE")) safe++; else if (verdict.startsWith("SAME") || verdict.startsWith("RIGHT")) same++; else other++;
  rows.push(`${c.id}  ${verdict.padEnd(32)} ${c.what}\n      nothing: ${base.entries.map((w) => `${w.title || "(blank)"}[${w.start_date || ""}-${w.end_date || ""}${String(w.job_responsibilities || "").trim() ? "" : ",empty"}]`).join(" ; ")}\n      check:   ${rep.entries.map((w) => `${w.title || "(blank)"}[${w.start_date || ""}-${w.end_date || ""}${String(w.job_responsibilities || "").trim() ? "" : ",empty"}]`).join(" ; ")}${isWorse ? `\n      flags nothing=${JSON.stringify(fb)} check=${JSON.stringify(fr)}` : ""}`);
}
console.log(rows.join("\n"));
console.log(`\nfixed ${fixed}, right either way ${same}, safe failure ${safe}, different but not worse ${other}, WORSE ${worse}`);
assert.equal(worse, 0, "a page break case is worse with the check than without it");

// ---------- ordering through the whole pipeline (step 6): latest role first ----------
const wc = run(cases.find((c) => c.id === "c1")!.pages, true).entries.filter((w) => w.company === "WESTCX");
assert.deepEqual(wc.map((w) => w.title), ["Senior Recruiter", "Recruiter"]);
const tr = run(cases.find((c) => c.id === "e1")!.pages, true).entries.filter((w) => w.company === "Thomson Reuters");
assert.deepEqual(tr.map((w) => w.title), ["Manager of Business Analysis and Publishing Systems", "Desktop Publishing Manager"]);
assert.ok(tr.every((w) => !(("_role_group") in w)), "the marker field must not survive");
console.log("ordering through the pipeline: WESTCX latest first, Thomson Reuters latest first, no marker left");
