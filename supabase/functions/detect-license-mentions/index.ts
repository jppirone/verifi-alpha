// Setup type definitions for built-in Supabase Runtime APIs
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { withSupabase } from "jsr:@supabase/server@1";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { encodeBase64 } from "jsr:@std/encoding@1/base64";

// detect-license-mentions: a SEPARATE, additive model pass that finds license-shaped content
// wherever it sits on a resume (its own section, mixed into Certifications, mixed into Education,
// the printed header block) and records it as license_items. It runs beside, never inside, the
// two-step extraction (Decision 38): it does not reclassify anything, does not read or alter the
// boundary-detection/classification output, and is deliberately its own call so the already-large
// extraction prompt doesn't grow (extraction non-determinism history).
//
// Input is the SOURCE FILE (PDF document block, or the sanitized JPEG), not OCR text: OCR text does
// not exist for vision-routed pages and stitched images, and a license living on such a page would
// otherwise be invisible to this pass.
//
// Output contract per mention: source_text, license_number (guess), holder_name (guess), state
// (only with a real textual signal — see validateState — NEVER inferred from the candidate's
// location), confidence. Called once per resume_document from resumeConfirm; idempotent.
//
// Single-record model: a license is ONE certification_items row plus a 1:1 license_items extension
// (state + verification). The model is shown the certifications extraction already produced and says
// which one (if any) each mention is; a matched cert gets the extension (and any blank number/date
// filled in), and a mention that matches nothing gets a NEW certification_items row created here
// (extraction_confidence 'license_detection') so every credential has exactly one row, one card, and
// flows through Customization / the PDF / the contact screen like any other certification.

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY");
const MODEL = "claude-sonnet-5";
const BUCKET = "resume-documents";
const MAX_FILE_BYTES = 12 * 1024 * 1024;
const STALE_RUNNING_SECONDS = 180;
const MIN_CONFIDENCE = 0.35;

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "content-type",
};

const STATE_BY_NAME: Record<string, string> = {
  ALABAMA: "AL", ALASKA: "AK", ARIZONA: "AZ", ARKANSAS: "AR", CALIFORNIA: "CA", COLORADO: "CO", CONNECTICUT: "CT",
  DELAWARE: "DE", "DISTRICT OF COLUMBIA": "DC", FLORIDA: "FL", GEORGIA: "GA", HAWAII: "HI", IDAHO: "ID", ILLINOIS: "IL",
  INDIANA: "IN", IOWA: "IA", KANSAS: "KS", KENTUCKY: "KY", LOUISIANA: "LA", MAINE: "ME", MARYLAND: "MD",
  MASSACHUSETTS: "MA", MICHIGAN: "MI", MINNESOTA: "MN", MISSISSIPPI: "MS", MISSOURI: "MO", MONTANA: "MT",
  NEBRASKA: "NE", NEVADA: "NV", "NEW HAMPSHIRE": "NH", "NEW JERSEY": "NJ", "NEW MEXICO": "NM", "NEW YORK": "NY",
  "NORTH CAROLINA": "NC", "NORTH DAKOTA": "ND", OHIO: "OH", OKLAHOMA: "OK", OREGON: "OR", PENNSYLVANIA: "PA",
  "RHODE ISLAND": "RI", "SOUTH CAROLINA": "SC", "SOUTH DAKOTA": "SD", TENNESSEE: "TN", TEXAS: "TX", UTAH: "UT",
  VERMONT: "VT", VIRGINIA: "VA", WASHINGTON: "WA", "WEST VIRGINIA": "WV", WISCONSIN: "WI", WYOMING: "WY",
};
const VALID_STATES = new Set(Object.values(STATE_BY_NAME));
// Abbreviations that are also ordinary English words: only accepted via the full state name.
const AMBIGUOUS_ABBR = new Set(["IN", "OR", "ME", "OK", "HI", "OH", "AL", "ID", "LA", "MA", "DE", "PA", "AS", "US"]);
// State agencies whose name alone is a real textual signal for the state.
const AGENCY_ALIASES: Record<string, string> = { DBPR: "FL", DORA: "CO" };

function stripPunct(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

// Accepts a model-proposed state only if (1) it is a real 2-letter code, (2) the quoted evidence
// actually names that state (full name, unambiguous abbreviation, or a known state agency), and
// (3) the evidence is not just the candidate's own location text.
function validateState(
  state: unknown, evidence: unknown, locationTexts: string[],
): { state: string | null; evidence: string | null } {
  if (typeof state !== "string" || typeof evidence !== "string") return { state: null, evidence: null };
  const code = state.trim().toUpperCase();
  const ev = evidence.trim();
  if (!VALID_STATES.has(code) || ev.length < 2) return { state: null, evidence: null };

  const evUpper = ev.toUpperCase();
  let signalled = false;
  for (const [name, abbr] of Object.entries(STATE_BY_NAME)) {
    if (abbr === code && new RegExp(`\\b${name.replace(/ /g, "\\s+")}\\b`).test(evUpper)) signalled = true;
  }
  if (!signalled && !AMBIGUOUS_ABBR.has(code) && new RegExp(`(^|[^A-Za-z])${code}([^A-Za-z]|$)`).test(ev)) signalled = true;
  if (!signalled) {
    for (const [agency, abbr] of Object.entries(AGENCY_ALIASES)) {
      if (abbr === code && new RegExp(`\\b${agency}\\b`).test(evUpper)) signalled = true;
    }
  }
  if (!signalled) return { state: null, evidence: null };

  const evNorm = stripPunct(ev);
  for (const loc of locationTexts) {
    const locNorm = stripPunct(loc);
    if (locNorm.length >= 4 && (locNorm.includes(evNorm) || evNorm.includes(locNorm))) return { state: null, evidence: null };
  }
  return { state: code, evidence: ev };
}

function normNumber(s: unknown): string {
  return typeof s === "string" ? s.replace(/[^A-Za-z0-9]/g, "").toUpperCase() : "";
}
function normName(s: unknown): string {
  return typeof s === "string" ? stripPunct(s) : "";
}
function isoDateOrNull(s: unknown): string | null {
  if (typeof s !== "string") return null;
  const m = s.trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  const d = new Date(`${m[1]}-${m[2]}-${m[3]}T00:00:00Z`);
  return isNaN(d.getTime()) ? null : `${m[1]}-${m[2]}-${m[3]}`;
}
function strOrNull(s: unknown): string | null {
  return typeof s === "string" && s.trim() ? s.trim() : null;
}

type ExistingCert = { id: string; name: string | null; issuing_body: string | null; license_number: string | null };

function buildDetectionPrompt(existing: ExistingCert[]): string {
  const list = existing.length
    ? existing.map((c) => JSON.stringify({ id: c.id, name: c.name, issuing_body: c.issuing_body, license_number: c.license_number })).join("\n")
    : "(none)";
  return DETECTION_PROMPT + `

ALREADY-EXTRACTED CERTIFICATION ENTRIES (a separate step already read these off the same resume):
${list}

For each license mention, set "existing_certification_id" to the "id" of the entry above that is the SAME credential (same license, even if worded differently or missing its number there). If it is not any of those entries, set it to null. Never use an id that is not listed above, and never give two mentions the same id.`;
}

const DETECTION_PROMPT = `You are reading a resume. Find every STATE OR GOVERNMENT-ISSUED PROFESSIONAL/TRADE LICENSE mentioned anywhere in the document, no matter where it appears: its own section, inside a Certifications or Education section, in the header block at the top, or in a sentence.

A license here is a credential issued by a government licensing board or regulatory agency that authorizes someone to practice a regulated trade or profession (for example contractor, plumber, electrician, HVAC, real estate agent/broker, cosmetologist, CPA, nurse, engineer, architect, insurance agent, private investigator). It is usually identified by a license number.

Do NOT report: vendor or industry certifications (Credly badges, OSHA cards, CPR/First Aid, software or IT certifications, manufacturer training), degrees, diplomas, memberships, or general skills. When unsure whether something is a government license, include it with a LOW confidence rather than omitting it.

Return ONLY a JSON object, no prose, in exactly this shape:
{"license_mentions":[{
  "source_text": "the verbatim text from the resume that this mention comes from (a line or short passage)",
  "license_number": "the license number exactly as printed, or null if none is shown",
  "holder_name": "the name printed with the license if one is shown next to it, otherwise null",
  "license_name": "the license/credential title, e.g. Certified Plumbing Contractor, or null",
  "issuing_body": "the issuing board/agency exactly as printed, or null",
  "state": "2-letter US state code, or null",
  "state_evidence": "the verbatim words from the resume that name the state, or null",
  "issue_date": "YYYY-MM-DD or null",
  "expiration_date": "YYYY-MM-DD or null",
  "existing_certification_id": "id of the already-extracted entry this is the same credential as, or null",
  "confidence": a number from 0 to 1
}]}

STATE RULES — these are strict:
- Set "state" ONLY if words on the resume tied to THIS license actually name the state: for example the issuing body ("Florida Department of Business and Professional Regulation", "State of Texas Board of ..."), or the license line itself ("License #123456, Florida").
- NEVER infer the state from where the candidate lives, works, or went to school, and never from the address or location shown in the resume header, even if it is the only state mentioned anywhere on the resume. If the license itself does not name a state, "state" and "state_evidence" MUST both be null.
- "state_evidence" must be the exact words you relied on. If you cannot quote such words, use null for both.

Use dates only when printed; otherwise null. If the resume contains no licenses, return {"license_mentions":[]}.`;

type Mention = {
  source_text: string | null; license_number: string | null; holder_name: string | null; license_name: string | null;
  issuing_body: string | null; state: string | null; state_evidence: string | null;
  issue_date: string | null; expiration_date: string | null; existing_certification_id: string | null; confidence: number;
};

async function callModel(fileBase64: string, mime: string, existing: ExistingCert[]): Promise<{ ok: true; mentions: Mention[] } | { ok: false; error: string }> {
  if (!ANTHROPIC_API_KEY) return { ok: false, error: "ANTHROPIC_API_KEY not configured" };
  const fileBlock = mime === "application/pdf"
    ? { type: "document", source: { type: "base64", media_type: "application/pdf", data: fileBase64 } }
    : { type: "image", source: { type: "base64", media_type: mime, data: fileBase64 } };
  let res: Response;
  try {
    res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01", "Content-Type": "application/json" },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 8000,
        messages: [{ role: "user", content: [fileBlock, { type: "text", text: buildDetectionPrompt(existing) }] }],
      }),
    });
  } catch (e) {
    return { ok: false, error: `claude_network_error: ${String(e)}` };
  }
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    return { ok: false, error: `claude_call_failed (${res.status}): ${detail.slice(0, 300)}` };
  }
  const data = await res.json();
  const textBlock = (data?.content ?? []).find((b: { type?: string }) => b.type === "text");
  const cleaned = String(textBlock?.text ?? "").trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "");
  let parsed: any;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    return { ok: false, error: "malformed_detection_response" };
  }
  if (!parsed || !Array.isArray(parsed.license_mentions)) return { ok: false, error: "detection_response_wrong_shape" };
  const mentions: Mention[] = parsed.license_mentions
    .filter((m: any) => m && typeof m === "object")
    .map((m: any) => ({
      source_text: strOrNull(m.source_text), license_number: strOrNull(m.license_number), holder_name: strOrNull(m.holder_name),
      license_name: strOrNull(m.license_name), issuing_body: strOrNull(m.issuing_body),
      state: strOrNull(m.state), state_evidence: strOrNull(m.state_evidence),
      issue_date: isoDateOrNull(m.issue_date), expiration_date: isoDateOrNull(m.expiration_date),
      existing_certification_id: strOrNull(m.existing_certification_id),
      confidence: typeof m.confidence === "number" ? Math.max(0, Math.min(1, m.confidence)) : 0.5,
    }));
  return { ok: true, mentions };
}

export default {
  fetch: withSupabase({ auth: "none" }, async (req, _ctx) => {
    if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
    const json = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

    // What the client needs after detection: the license extensions AND the (possibly newly created)
    // certification rows they hang off, so it can merge both into one card per credential.
    const readResult = async (resumeDocumentId: string) => {
      const [li, certs] = await Promise.all([
        supabase.from("license_items")
          .select("id, resume_document_id, linked_certification_id, source_text, state, state_evidence, state_source, confidence, candidate_confirmed, verification_outcome")
          .eq("resume_document_id", resumeDocumentId).order("created_at", { ascending: true }),
        supabase.from("certification_items").select("*").eq("resume_document_id", resumeDocumentId).order("issue_date", { ascending: false }),
      ]);
      return { license_items: li.data || [], certifications: certs.data || [] };
    };

    let resumeDocumentId: string | null = null;
    let claimedHere = false;
    try {
      const body = await req.json();
      const candidateId = body.candidate_id;
      resumeDocumentId = body.resume_document_id;
      if (!candidateId || !resumeDocumentId) return json({ ok: false, error: "candidate_id and resume_document_id are required" }, 400);

      const { data: doc, error: docErr } = await supabase.from("resume_documents")
        .select("id, candidate_id, original_storage_path, sanitized_render_path, mime_type, extraction_status, candidate_location, printed_header, license_detection_status, license_detected_at")
        .eq("id", resumeDocumentId).eq("candidate_id", candidateId).maybeSingle();
      if (docErr) return json({ ok: false, error: "lookup_failed", detail: docErr.message }, 500);
      if (!doc) return json({ ok: false, error: "resume_document_not_found" }, 404);

      if (doc.license_detection_status === "done") {
        return json({ ok: true, status: "done", ...(await readResult(doc.id)) });
      }
      if (doc.extraction_status !== "extracted") {
        return json({ ok: true, status: "not_ready", extraction_status: doc.extraction_status, license_items: [], certifications: [] });
      }

      // Atomic claim: null/failed -> running, or a stale 'running' (crashed run) is retaken.
      const staleCutoff = new Date(Date.now() - STALE_RUNNING_SECONDS * 1000).toISOString();
      const { data: claimed } = await supabase.from("resume_documents")
        .update({ license_detection_status: "running", license_detected_at: new Date().toISOString() })
        .eq("id", doc.id)
        .or(`license_detection_status.is.null,license_detection_status.eq.failed,and(license_detection_status.eq.running,license_detected_at.lt.${staleCutoff})`)
        .select("id");
      if (!claimed || claimed.length === 0) {
        return json({ ok: true, status: "running", license_items: [], certifications: [] });
      }
      claimedHere = true;

      // A re-run after a failed/crashed run must not stack duplicates: clear this document's
      // not-yet-confirmed detections (extensions first, then any certification rows a previous run
      // created — never a certification the extraction pass made).
      await supabase.from("license_items").delete()
        .eq("resume_document_id", doc.id).eq("source", "resume").eq("candidate_confirmed", false);
      await supabase.from("certification_items").delete()
        .eq("resume_document_id", doc.id).eq("extraction_confidence", "license_detection").eq("candidate_confirmed", false);

      const isPdf = doc.mime_type === "application/pdf";
      const path = isPdf ? doc.original_storage_path : (doc.sanitized_render_path || doc.original_storage_path);
      const mime = isPdf ? "application/pdf" : (doc.sanitized_render_path ? "image/jpeg" : (doc.mime_type || "image/jpeg"));
      if (!path || !(mime === "application/pdf" || /^image\/(jpeg|png|gif|webp)$/.test(mime))) {
        await supabase.from("resume_documents").update({ license_detection_status: "failed" }).eq("id", doc.id);
        return json({ ok: false, error: "unsupported_source_file", mime }, 200);
      }
      const dl = await supabase.storage.from(BUCKET).download(path);
      if (dl.error || !dl.data) {
        await supabase.from("resume_documents").update({ license_detection_status: "failed" }).eq("id", doc.id);
        return json({ ok: false, error: "download_failed", detail: dl.error?.message }, 200);
      }
      const bytes = new Uint8Array(await dl.data.arrayBuffer());
      if (bytes.byteLength > MAX_FILE_BYTES) {
        await supabase.from("resume_documents").update({ license_detection_status: "failed" }).eq("id", doc.id);
        return json({ ok: false, error: "file_too_large" }, 200);
      }

      const { data: existingCerts } = await supabase.from("certification_items")
        .select("id, name, issuing_body, license_number, issue_date, expiration_date").eq("resume_document_id", doc.id);
      const existing: ExistingCert[] = (existingCerts || []).map((c: any) => ({ id: c.id, name: c.name, issuing_body: c.issuing_body, license_number: c.license_number }));

      const result = await callModel(encodeBase64(bytes), mime, existing);
      if (!result.ok) {
        await supabase.from("resume_documents").update({ license_detection_status: "failed" }).eq("id", doc.id);
        return json({ ok: false, error: result.error }, 200);
      }

      const { data: cand } = await supabase.from("candidates").select("personal_location").eq("id", candidateId).maybeSingle();
      const locationTexts = [doc.candidate_location, doc.printed_header, cand?.personal_location].filter((x): x is string => typeof x === "string" && !!x.trim());

      const certById = new Map<string, any>((existingCerts || []).map((c: any) => [c.id, c]));
      const certIdByNumber = new Map<string, string>();
      for (const c of existingCerts || []) {
        const n = normNumber(c.license_number);
        if (n && !certIdByNumber.has(n)) certIdByNumber.set(n, c.id);
      }

      const seen = new Set<string>();
      const usedCertIds = new Set<string>();
      const licenseRows: Record<string, unknown>[] = [];
      for (const m of result.mentions) {
        if (m.confidence < MIN_CONFIDENCE) continue;
        const num = normNumber(m.license_number);
        const key = num || normName(m.license_name) + "|" + normName(m.source_text);
        if (!key || seen.has(key)) continue;
        seen.add(key);
        const vs = validateState(m.state, m.state_evidence, locationTexts);

        // Which certification row is this credential? The model's answer (validated against this
        // document's real rows), else an exact license-number match, else it's new.
        let certId: string | null = null;
        if (m.existing_certification_id && certById.has(m.existing_certification_id) && !usedCertIds.has(m.existing_certification_id)) {
          certId = m.existing_certification_id;
        } else if (num && certIdByNumber.has(num) && !usedCertIds.has(certIdByNumber.get(num)!)) {
          certId = certIdByNumber.get(num)!;
        }

        if (certId) {
          // Matched: the certification row stays the record; only blanks are filled in from the mention.
          const c = certById.get(certId);
          const fill: Record<string, unknown> = {};
          if (!normNumber(c.license_number) && m.license_number) fill.license_number = m.license_number;
          if (!c.issue_date && m.issue_date) fill.issue_date = m.issue_date;
          if (!c.expiration_date && m.expiration_date) fill.expiration_date = m.expiration_date;
          if (Object.keys(fill).length) {
            const { error: fillErr } = await supabase.from("certification_items").update({ ...fill, updated_at: new Date().toISOString() })
              .eq("id", certId).eq("candidate_id", candidateId);
            if (fillErr) {
              await supabase.from("resume_documents").update({ license_detection_status: "failed" }).eq("id", doc.id);
              return json({ ok: false, error: "cert_update_failed", detail: fillErr.message }, 200);
            }
          }
        } else {
          // Not in what extraction produced: create the certification row here so this credential
          // still has exactly one record and one card.
          const { data: created, error: createErr } = await supabase.from("certification_items").insert({
            candidate_id: candidateId, resume_document_id: doc.id,
            name: m.license_name || m.issuing_body || "Professional license",
            issuing_body: m.issuing_body, license_number: m.license_number,
            issue_date: m.issue_date, expiration_date: m.expiration_date,
            extraction_confidence: "license_detection", candidate_confirmed: false,
          }).select("id").single();
          if (createErr || !created) {
            await supabase.from("resume_documents").update({ license_detection_status: "failed" }).eq("id", doc.id);
            return json({ ok: false, error: "cert_create_failed", detail: createErr?.message }, 200);
          }
          certId = created.id;
        }
        usedCertIds.add(certId!);

        licenseRows.push({
          candidate_id: candidateId, resume_document_id: doc.id, source: "resume",
          linked_certification_id: certId,
          source_text: m.source_text, holder_name_guess: m.holder_name,
          state: vs.state, state_evidence: vs.evidence, state_source: vs.state ? "detected" : null,
          confidence: m.confidence,
        });
      }

      if (licenseRows.length) {
        const { error: insErr } = await supabase.from("license_items").insert(licenseRows);
        if (insErr) {
          await supabase.from("resume_documents").update({ license_detection_status: "failed" }).eq("id", doc.id);
          return json({ ok: false, error: "insert_failed", detail: insErr.message }, 200);
        }
      }
      await supabase.from("resume_documents")
        .update({ license_detection_status: "done", license_detected_at: new Date().toISOString() }).eq("id", doc.id);
      return json({ ok: true, status: "done", ...(await readResult(doc.id)) });
    } catch (e) {
      if (claimedHere && resumeDocumentId) {
        try {
          await supabase.from("resume_documents").update({ license_detection_status: "failed" }).eq("id", resumeDocumentId);
        } catch { /* best effort: a stale 'running' is retaken after STALE_RUNNING_SECONDS anyway */ }
      }
      return json({ ok: false, error: "unhandled", detail: String(e) }, 500);
    }
  }),
};
