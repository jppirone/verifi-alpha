// AP9L: diagnostic log lines for detect-license-mentions. Logging only: nothing here is read back by the function, every
// entry point swallows its own errors, and nothing here ever sees an API key, a token or a request header (callers pass
// only the fields named below). Pure functions with an injectable sink so a test can run them without Deno or a network.

export const RAW_ANSWER_MAX = 4000;
export const INPUT_SNIPPET_MAX = 1000;
export const LOCATION_MAX = 300;

export type Sink = (line: string) => void;

export function clip(v: unknown, max: number): { text: string; truncated: boolean } {
  let s: string;
  try { s = typeof v === "string" ? v : v == null ? "" : String(v); } catch { s = ""; }
  return s.length > max ? { text: s.slice(0, max), truncated: true } : { text: s, truncated: false };
}

function json(v: unknown): string {
  try { return JSON.stringify(v); } catch { return '"unserializable"'; }
}

export type RawAnswerLog = {
  docId: string;
  ok: boolean;              // did the call produce a usable answer
  error?: string | null;    // the function's own error code when it did not
  model?: unknown;          // response.model exactly as the API returned it
  rawText?: unknown;        // the model's text block, before any cleanup
  inputSnippet?: unknown;   // the text half of what was sent (the resume itself goes as a file, not text)
  inputKind?: string;       // mime type of the file block
  inputBytes?: number;
  locations?: Array<{ source: string; value: string | null | undefined }>; // what validateState compares against
};

export function logRawAnswer(d: RawAnswerLog, sink: Sink = console.log): void {
  try {
    const raw = clip(d.rawText, RAW_ANSWER_MAX);
    const inp = clip(d.inputSnippet, INPUT_SNIPPET_MAX);
    const locs = (Array.isArray(d.locations) ? d.locations : []).map((l) => ({ source: l?.source, value: clip(l?.value, LOCATION_MAX).text }));
    sink(`detect-license-mentions: ${d.docId} license-detect raw ${json({
      ok: d.ok, error: d.error ?? null,
      model: d.model == null ? null : String(d.model),
      raw_answer: raw.text, raw_answer_chars: String(d.rawText ?? "").length, raw_answer_truncated: raw.truncated,
      input_kind: d.inputKind ?? null, input_bytes: d.inputBytes ?? null,
      input_text_tail: inp.text, input_text_truncated: inp.truncated,
      candidate_locations: locs,
    })}`);
  } catch { /* logging must never change the result */ }
}

export type ItemDecisionLog = {
  docId: string;
  name: unknown;            // license name, else the source text
  stateReturned: unknown;   // exactly what the model returned for state
  evidenceReturned?: unknown;
  accepted: boolean;
  rule: string;             // which rule decided
  detail?: Record<string, unknown>; // the values that rule compared
};

export function logItemDecision(d: ItemDecisionLog, sink: Sink = console.log): void {
  try {
    const st = typeof d.stateReturned === "string" && d.stateReturned !== "" ? d.stateReturned : "none";
    sink(`detect-license-mentions: ${d.docId} license-detect item ${json({
      name: clip(d.name, 200).text,
      state_returned: st,
      evidence_returned: d.evidenceReturned == null ? null : clip(d.evidenceReturned, 300).text,
      result: d.accepted ? "accepted" : "rejected",
      rule: d.rule,
      detail: d.detail ?? null,
    })}`);
  } catch { /* logging must never change the result */ }
}
