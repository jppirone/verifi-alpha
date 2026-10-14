// Regression driver for the resume pipeline (2026-10-05 OCR-gap run). Meant for a THROWAWAY test candidate only.
//   node tools/resume/run-upload.mjs upload  <file.pdf> <candidate_id> <session_token>   upload + drive extraction to the end, print the doc id
//   node tools/resume/run-upload.mjs show    <candidate_id> <session_token>               print what the confirm screen would load
//   node tools/resume/run-upload.mjs discard <candidate_id> <session_token> <doc_id>      remove a test upload (DB rows + stored file)
// UPLOAD_FN selects the upload function. It defaults to the TEMPORARY test slug, so a run never touches production's pipeline
// by accident; set UPLOAD_FN=upload-resume to run the same document through production for a baseline comparison.
// The key below is the public publishable key already embedded in candidate.html (not a secret).
import fs from "node:fs";

const FN = "https://ihmypoduvrzymasgactc.supabase.co/functions/v1";
const KEY = "sb_publishable_o3S1LP0utVvxTXPRb2aZxg_Fz2FWwBj";
const UPLOAD_FN = process.env.UPLOAD_FN || "upload-resume-next";
const H = { "Content-Type": "application/json", apikey: KEY, Authorization: "Bearer " + KEY };
const post = async (fn, body) => { const r = await fetch(`${FN}/${fn}`, { method: "POST", headers: H, body: JSON.stringify(body) }); return { status: r.status, json: await r.json().catch(() => ({})) }; };
const [cmd, a1, a2, a3] = process.argv.slice(2);

if (cmd === "upload") {
  const [file, cid, tok] = [a1, a2, a3];
  if (!file || !cid || !tok) throw new Error("usage: upload <file.pdf> <candidate_id> <session_token>");
  console.log("function:", UPLOAD_FN);
  const up = (await post(UPLOAD_FN, { candidate_id: cid, session_token: tok, original_filename: file.split(/[\\/]/).pop(), mime_type: "application/pdf", original_base64: fs.readFileSync(file).toString("base64") })).json;
  console.log("upload:", JSON.stringify(up).slice(0, 260));
  const id = up.resume_document_id; let st = up.extraction_status;
  for (let i = 0; i < 40 && id && !["extracted", "complete", "failed"].includes(st); i++) {
    await new Promise((r) => setTimeout(r, 4000));
    const c = (await post(UPLOAD_FN, { resume_document_id: id })).json; st = c.extraction_status; console.log("  continue", i + 1, st, c.continue);
  }
  console.log("DOC", id, "status", st);
} else if (cmd === "show") {
  const { status, json: j } = await post("get-resume-extraction", { candidate_id: a1, session_token: a2 });
  const pick = (a, f) => (a || []).map((x) => f.map((k) => `${k}=${JSON.stringify(x[k])}`).join(" | "));
  console.log(status, "keys:", Object.keys(j).join(","));
  console.log("WORK:\n" + pick(j.work_history, ["title", "company", "heading"]).join("\n"));
  console.log("EDU:", (j.education || []).length + "\n" + pick(j.education, ["institution", "degree", "heading"]).join("\n"));
  console.log("CERT:\n" + pick(j.certifications, ["name", "heading", "issuing_body"]).join("\n"));
  console.log("FREEFORM:\n" + pick(j.freeform, ["heading", "section_type"]).join("\n"));
  console.log("SKILLS heading:", JSON.stringify(j.skills_heading), "n=", (j.skills || []).length);
} else if (cmd === "discard") {
  const r = await post("discard-resume-document", { candidate_id: a1, session_token: a2, resume_document_id: a3 });
  console.log(r.status, JSON.stringify(r.json).slice(0, 200));
} else {
  console.log("usage: upload <file.pdf> <cid> <token> | show <cid> <token> | discard <cid> <token> <doc_id>");
  process.exit(1);
}
