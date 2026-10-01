// The staff-facing answer to a lookup. An empty result from an automated source is NOT "this record does not exist": it only means the
// sources we can query automatically did not contain it. Every lookup response therefore carries a `verification` block that says, in
// words and in a machine-readable status, whether staff must go and check by hand.
//
// Statuses
//   found                                              at least one automated source returned a match
//   not_found_manual_verification_required             sources were searched successfully and none matched
//   inconclusive_manual_verification_required          nothing matched AND at least one source failed / timed out, so the miss proves nothing
//   no_automated_source_manual_verification_required   no source could be searched at all (e.g. a state we have no automated source for)
// `manual_verification_required` is also true when something WAS found but part of what was asked was not covered (a requested state
// with no automated source, or a source that failed).

import type { SourceReport } from "./lookup.ts";

export type VerificationStatus =
  | "found"
  | "not_found_manual_verification_required"
  | "inconclusive_manual_verification_required"
  | "no_automated_source_manual_verification_required";

export interface VerificationSummary {
  status: VerificationStatus;
  manual_verification_required: boolean;
  message: string;
  searched_sources: string[];
  failed_sources: Array<{ source_id: string; error: string }>;
  skipped_sources: Array<{ source_id: string; reason: string }>;
  not_loaded_sources: string[];
  truncated_sources: string[];
  states_requested: string[] | null;
  states_without_automated_coverage: string[];
  states_with_automated_coverage: string[];
}

const list = (a: string[]) => (a.length <= 1 ? a.join("") : a.slice(0, -1).join(", ") + " and " + a[a.length - 1]);

export function summarizeVerification(input: {
  hitCount: number;
  reports: SourceReport[];
  notLoaded: Array<{ source_id: string; state: string }>;
  requestedStates?: string[];
  coveredStates: string[];
}): VerificationSummary {
  const requested = input.requestedStates && input.requestedStates.length ? [...new Set(input.requestedStates.map((s) => s.toUpperCase()))].sort() : null;
  const covered = [...new Set(input.coveredStates.map((s) => s.toUpperCase()))].sort();
  const searched = input.reports.filter((r) => r.ok && !r.skipped).map((r) => r.source_id);
  const failed = input.reports.filter((r) => !r.ok).map((r) => ({ source_id: r.source_id, error: r.error ?? "unknown_error" }));
  const skipped = input.reports.filter((r) => r.ok && r.skipped).map((r) => ({ source_id: r.source_id, reason: r.skipped! }));
  const uncovered = requested ? requested.filter((s) => !covered.includes(s)) : [];
  const notLoaded = input.notLoaded.filter((n) => !requested || requested.includes(n.state.toUpperCase())).map((n) => n.source_id);
  const truncated = input.reports.filter((r) => r.ok && r.truncated).map((r) => r.source_id);
  const truncNote = truncated.length ? ` ${list(truncated)} returned the maximum number of results, so more matches may exist: add a middle name, license number or state to narrow the search.` : "";
  const base = { searched_sources: searched, failed_sources: failed, skipped_sources: skipped, not_loaded_sources: notLoaded, truncated_sources: truncated, states_requested: requested, states_without_automated_coverage: uncovered, states_with_automated_coverage: covered };
  const coverageNote = requested ? "" : ` Automated coverage is limited to ${list(covered)}; any other state has no automated source.`;
  const uncoveredNote = uncovered.length ? ` No automated source exists for ${list(uncovered)}: look ${uncovered.length === 1 ? "it" : "those"} up by hand.` : "";
  const notLoadedNote = notLoaded.length ? ` Not yet loaded (so not searched): ${list(notLoaded)}.` : "";

  if (input.hitCount > 0) {
    const gaps = failed.length > 0 || uncovered.length > 0;
    return {
      ...base, status: "found", manual_verification_required: gaps,
      message: gaps
        ? `Match found, but the search was incomplete:${failed.length ? ` ${list(failed.map((f) => f.source_id))} failed or timed out.` : ""}${uncoveredNote} Verify the rest by hand.`
        : `Match found in an automated source.${truncNote}`,
    };
  }
  if (searched.length === 0 && failed.length === 0) {
    return {
      ...base, status: "no_automated_source_manual_verification_required", manual_verification_required: true,
      message: `Not searched: no automated source could answer this lookup.${uncoveredNote}${notLoadedNote}${coverageNote} Needs manual verification.`,
    };
  }
  if (failed.length > 0) {
    return {
      ...base, status: "inconclusive_manual_verification_required", manual_verification_required: true,
      message: `No match found, but ${list(failed.map((f) => f.source_id))} could not be searched (failed or timed out), so this is not a "not found". Needs manual verification.${uncoveredNote}${notLoadedNote}${coverageNote}`,
    };
  }
  return {
    ...base, status: "not_found_manual_verification_required", manual_verification_required: true,
    message: `Not found in automated sources (searched ${list(searched)}). This does not mean the record does not exist: it only means these sources do not contain it. Needs manual verification.${uncoveredNote}${notLoadedNote}${coverageNote}`,
  };
}
