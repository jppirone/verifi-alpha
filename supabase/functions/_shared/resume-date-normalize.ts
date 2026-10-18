// AP9AA-2: month-and-year dates written as text ("Nov 2020", "September 2023", "9/2023") become "YYYY-MM" before the extraction is saved.
//
// Why this exists: the database function parse_partial_date accepts only YYYY, YYYY-MM and YYYY-MM-DD and returns NULL for everything else, silently. The extraction
// prompt asks the model for those three forms, but on some pages the model returns the printed text instead (document 2f1fdc89, page 2: "Nov 2020", "May 2023", ...), and
// the job is then saved with null dates. This turns the two clean text shapes into the form the database already accepts. No model call, no schema change.
//
// Changed (case-insensitive, outer spaces ignored):
//   "Mon YYYY", "Mon. YYYY", "Sept YYYY", "Month YYYY"  ->  "YYYY-MM"   (English month names and 3-letter forms, "sept" and "sep", one optional period)
//   "MM/YYYY", "M/YYYY"                                  ->  "YYYY-MM"   (month 1 to 12)
// Everything else is returned exactly as given (the same string, byte for byte): YYYY, YYYY-MM, YYYY-MM-DD, empty strings, null and other non-strings,
// Present/Current/Now/Ongoing, "MM/DD/YYYY", ranges ("Nov 2020 - May 2023"), free text, a year outside 1900 to 2100, an unknown month word.
// Pure and synchronous; never throws (any failure returns the original value).

const MONTHS: Record<string, string> = {
  jan: "01", january: "01", feb: "02", february: "02", mar: "03", march: "03", apr: "04", april: "04", may: "05", jun: "06", june: "06",
  jul: "07", july: "07", aug: "08", august: "08", sep: "09", sept: "09", september: "09", oct: "10", october: "10", nov: "11", november: "11", dec: "12", december: "12",
};

export function normalizePartialDate(value: unknown): unknown {
  try {
    if (typeof value !== "string") return value;
    const s = value.trim();
    if (!s) return value;
    let year: string | null = null, month: string | null = null;
    const named = s.match(/^([A-Za-z]{3,9})\.?\s+(\d{4})$/);
    if (named) { month = MONTHS[named[1].toLowerCase()] ?? null; year = named[2]; }
    else {
      const slash = s.match(/^(\d{1,2})\/(\d{4})$/);
      if (slash) { const m = parseInt(slash[1], 10); if (m >= 1 && m <= 12) month = String(m).padStart(2, "0"); year = slash[2]; }
    }
    if (!month || !year) return value;
    const y = parseInt(year, 10);
    if (y < 1900 || y > 2100) return value;
    return `${year}-${month}`;
  } catch {
    return value;
  }
}

type DateRows = { work_history: any[]; education: any[]; certifications: any[] };
export type DateNormalizeResult<T> = { extraction: T; changed: number; first: string | null };

// Applies normalizePartialDate to start_date/end_date of work history and education and to issue_date/expiration_date of certifications. Rows that change are
// copied (the input object and its rows are not modified); rows that do not change are the same objects. `first` is "<before> -> <after>" of the first change.
export function normalizeExtractionDates<T extends DateRows>(extraction: T): DateNormalizeResult<T> {
  try {
    let changed = 0;
    let first: string | null = null;
    const fix = (rows: any[], fields: string[]) => (Array.isArray(rows) ? rows : []).map((row) => {
      if (!row || typeof row !== "object") return row;
      let copy: any = null;
      for (const f of fields) {
        const before = row[f];
        const after = normalizePartialDate(before);
        if (after !== before) {
          copy = copy ?? { ...row };
          copy[f] = after;
          changed++;
          if (first === null) first = `${String(before)} -> ${String(after)}`;
        }
      }
      return copy ?? row;
    });
    const work_history = fix(extraction.work_history, ["start_date", "end_date"]);
    const education = fix(extraction.education, ["start_date", "end_date"]);
    const certifications = fix(extraction.certifications, ["issue_date", "expiration_date"]);
    if (changed === 0) return { extraction, changed: 0, first: null };
    return { extraction: { ...extraction, work_history, education, certifications }, changed, first };
  } catch {
    return { extraction, changed: 0, first: null };
  }
}
