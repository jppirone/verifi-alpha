// Self-referential section-heading guard (2026-10-05, Lisa Tom resume).
//
// Real failure: when a page printed NO heading for a section (here the CERTIFICATIONS heading was lost by the OCR), the
// boundary step sometimes took the first LIST ENTRY as the heading -- "SHRM-SCP Certification | 2020" became the section
// heading of the certifications section and then every cert on the page carried it, so the confirm screen and the
// generated PDF printed the first certification twice (once as the "heading", once as the item). The model gave a clean
// empty heading on other runs of the identical input, i.e. it is non-deterministic, so this is checked in code.
//
// Rule: a section heading that is identical to an item's own name (with or without its date / issuer / place) is NOT a
// heading. It is cleared to "" -- the standing render rule already prints the literal source heading or nothing -- and
// the items are left exactly as extracted. Applies to these section types:
//   work_history     NOT HANDLED HERE (gap 16h follow-up fix, 2026-09-25, kept by AP6 re-run, 2026-10-14): a work history heading
//                    that equals the job's own title is left unchanged for upload-resume's existing merge rule to correct (it
//                    replaces such a heading with the document's dominant work heading). Clearing it here first hid it from that
//                    rule and left the job with a blank heading (PironeBeast regression). KNOWN LEFTOVER: a document where no work
//                    heading is shared by two or more jobs has no dominant heading, so a title-as-heading stays, exactly as
//                    production does today.
//   education       heading == the degree, or any two or more of institution / degree / field (institution alone stays)
//   certifications   heading == the name, optionally with issuer / licence number (issuer alone stays)
//   skills           heading == one of the skill strings
//   freeform         heading == the section's whole content or its first line
// Comparison is on a normalised form: lower case, dates stripped (years, month names, "present"), everything that is not a
// letter or digit dropped. Full-label equality only: a heading that merely CONTAINS an item's name is never touched.

const MONTHS = "jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?";
const DATE_RE = new RegExp(`\\b(?:${MONTHS})\\b\\.?|\\b(?:19|20)\\d{2}\\b|\\b\\d{1,2}[/.]\\d{2,4}\\b|\\b(?:present|current|ongoing|to date|now)\\b`, "gi");

export function normalizeLabel(s: unknown): string {
  if (typeof s !== "string") return "";
  return s.replace(DATE_RE, " ").toLowerCase().replace(/[^a-z0-9]+/g, "");
}

// Every ordered concatenation of a non-empty subset of the (non-empty) parts, that satisfies `keep`.
function combos(parts: string[], keep: (used: number[]) => boolean): Set<string> {
  const out = new Set<string>();
  const n = parts.length;
  const walk = (used: number[], acc: string) => {
    if (used.length && keep(used)) out.add(acc);
    for (let i = 0; i < n; i++) if (!used.includes(i)) walk([...used, i], acc + parts[i]);
  };
  walk([], "");
  return out;
}

type Rec = Record<string, unknown>;
const str = (v: unknown) => normalizeLabel(v);

function educationLabels(it: Rec): Set<string> {
  const f = [str(it.institution), str(it.degree), str(it.field_of_study), str(it.location)]; const idx = [0, 1, 2, 3].filter((i) => f[i]);
  const parts = idx.map((i) => f[i]);
  return combos(parts, (used) => used.length >= 2 || (used.length === 1 && idx[used[0]] === 1)); // degree alone, or two or more fields
}
function certLabels(it: Rec): Set<string> {
  const f = [str(it.name), str(it.issuing_body), str(it.license_number)]; const idx = [0, 1, 2].filter((i) => f[i]);
  const parts = idx.map((i) => f[i]);
  return combos(parts, (used) => used.some((u) => idx[u] === 0)); // must contain the name
}
function firstLine(s: unknown): string { return typeof s === "string" ? (s.split(/\r?\n/).find((l) => l.trim()) ?? "") : ""; }

const MIN_LABEL_LEN = 3;
const hit = (heading: string, labels: Iterable<string>): boolean => { const h = normalizeLabel(heading); if (h.length < MIN_LABEL_LEN) return false; for (const l of labels) if (l === h) return true; return false; };

// Returns the guarded extraction (the same object, headings cleared in place) and what it cleared, for the page log.
export interface GuardRejection { section: string; heading: string }
export function guardSelfReferentialHeadings(extraction: {
  work_history?: Rec[]; education?: Rec[]; certifications?: Rec[]; skills?: unknown[]; skills_heading?: string; freeform?: Rec[];
}): GuardRejection[] {
  const rejected: GuardRejection[] = [];
  const clear = (section: string, items: Rec[] | undefined, labelsOf: (it: Rec) => Set<string>) => {
    if (!Array.isArray(items) || items.length === 0) return;
    const all = new Set<string>(); for (const it of items) for (const l of labelsOf(it)) all.add(l);
    const bad = new Set<string>();
    for (const it of items) { const h = typeof it.heading === "string" ? it.heading : ""; if (h && !bad.has(h) && hit(h, all)) bad.add(h); }
    if (!bad.size) return;
    for (const it of items) if (typeof it.heading === "string" && bad.has(it.heading)) it.heading = "";
    for (const h of bad) rejected.push({ section, heading: h });
  };
  // work_history is deliberately NOT cleared here: upload-resume's merge rule owns a work heading that equals the job's own title.
  clear("education", extraction.education, educationLabels);
  clear("certifications", extraction.certifications, certLabels);
  // skills: the heading against each skill string
  if (extraction.skills_heading && Array.isArray(extraction.skills) && hit(extraction.skills_heading, extraction.skills.map((s) => normalizeLabel(s)).filter(Boolean))) {
    rejected.push({ section: "skills", heading: extraction.skills_heading }); extraction.skills_heading = "";
  }
  if (Array.isArray(extraction.freeform)) {
    const bad = new Set<string>();
    for (const it of extraction.freeform) { const h = typeof it.heading === "string" ? it.heading : ""; if (h && (hit(h, [normalizeLabel(it.content), normalizeLabel(firstLine(it.content))]))) bad.add(h); }
    if (bad.size) { for (const it of extraction.freeform) if (typeof it.heading === "string" && bad.has(it.heading)) it.heading = ""; for (const h of bad) rejected.push({ section: "freeform", heading: h }); }
  }
  return rejected;
}

// The same rule applied to the boundary step's own section list, so the stored section_boundaries (read by the skills-heading
// resolver and the position anchoring) never keeps a heading the items were just cleared of. `cleared` = the headings
// guardSelfReferentialHeadings() rejected, per section type.
export function clearBoundaryHeadings<T extends { heading: string; category: string }>(sections: T[], rejected: GuardRejection[]): T[] {
  if (!rejected.length) return sections;
  const catOf: Record<string, string[]> = { work_history: ["work_history"], education: ["education"], certifications: ["certifications"], skills: ["skills"], freeform: ["summary", "hobbies_other", "additional_info", "unknown"] };
  return sections.map((s) => rejected.some((r) => (catOf[r.section] ?? []).includes(s.category) && normalizeLabel(r.heading) === normalizeLabel(s.heading) && normalizeLabel(s.heading)) ? { ...s, heading: "" } : s);
}
