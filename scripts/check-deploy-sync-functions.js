#!/usr/bin/env node
// Edge-Function counterpart to check-deploy-sync.js. Same question, different deploy path: "is
// what's actually LIVE on Supabase for this function the same content as local git HEAD, and if
// not, how far behind is it?"
//
// WHY THIS EXISTS: check-deploy-sync.js only ever covered the 4 GitHub Pages static files. Edge
// Function deploys go through the Supabase dashboard's Monaco editor (or, as of this session, the
// CLI) with no git-push discipline behind them at all — arguably higher-risk than the static-file
// case precisely because there's no CDN-propagation-delay explanation available if it's wrong;
// wrong here just means someone deployed the wrong content, no automatic catch-up coming.
//
// AUTH: requires a Supabase Personal Access Token in SUPABASE_ACCESS_TOKEN. Investigated live
// this session (2026-09-06): Supabase does not currently offer a project-scoped or read-only PAT —
// a PAT generated from Account -> Access Tokens is a full account-wide bearer credential regardless
// of what it's used for (confirmed against Supabase's own docs + an open, unshipped GitHub feature
// request asking for scoped keys). This script only ever calls read endpoints, but the credential
// itself is not narrower than that by construction — see the session's report to the user before
// treating this as a routine thing to leave lying around in an env var long-term.
//
// USAGE: SUPABASE_ACCESS_TOKEN=sbp_... node scripts/check-deploy-sync-functions.js [function-name ...]
//   No args: checks every function that exists locally under supabase/functions/.
//   One or more args: checks just those (by directory/slug name).

const { execSync } = require("child_process");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const PROJECT_REF = process.env.SUPABASE_PROJECT_REF || "ihmypoduvrzymasgactc";
const ACCESS_TOKEN = process.env.SUPABASE_ACCESS_TOKEN;
const MGMT_API = "https://api.supabase.com/v1";

// Same reasoning as check-deploy-sync.js's MAX_COMMITS_TO_CHECK: deep enough to catch real deploy
// lag, shallow enough that a truly-diverged function (deployed from way back, or edited straight in
// the dashboard with no matching local commit ever made) fails fast instead of walking full history.
const MAX_COMMITS_TO_CHECK = 50;

const FUNCTIONS_DIR = path.join(__dirname, "..", "supabase", "functions");

function sha256(text) {
  // Normalize line endings before hashing on BOTH sides (local git checkout and whatever comes
  // back from the Management API) — deploys that went through a human copy/paste into the Monaco
  // editor are a real, demonstrated source of LF/CRLF drift this session (caught via a raw length
  // mismatch, not a hash mismatch, while testing the manual deploy path). A pure byte-for-byte
  // hash would flag that as "different" even when the actual code is identical, which is noise
  // this check should not produce.
  return crypto.createHash("sha256").update(text.replace(/\r\n/g, "\n"), "utf8").digest("hex");
}

function git(args) {
  return execSync(`git ${args}`, { encoding: "utf8", cwd: path.join(__dirname, "..") }).trim();
}

function localFunctionSlugs() {
  return fs
    .readdirSync(FUNCTIONS_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .filter((name) => fs.existsSync(path.join(FUNCTIONS_DIR, name, "index.ts")));
}

async function mgmtFetch(urlPath) {
  const res = await fetch(`${MGMT_API}${urlPath}`, {
    headers: { Authorization: `Bearer ${ACCESS_TOKEN}` },
  });
  const bodyText = await res.text();
  return { ok: res.ok, status: res.status, bodyText };
}

async function fetchDeployedSource(slug) {
  const { ok, status, bodyText } = await mgmtFetch(`/projects/${PROJECT_REF}/functions/${slug}/body`);
  if (!ok) return { ok: false, status, bodyText };

  // Defensive: the Management API reference for this endpoint doesn't clearly document whether the
  // response is raw source text or JSON-wrapped — handle both rather than assuming. If this branch
  // ever fires for real, print what actually came back so it's obvious, not silently wrong.
  const trimmed = bodyText.trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      const parsed = JSON.parse(trimmed);
      if (typeof parsed === "string") return { ok: true, text: parsed };
      const candidate = parsed.body ?? parsed.source ?? parsed.content ?? parsed.code;
      if (typeof candidate === "string") return { ok: true, text: candidate };
      console.log(`  ⚠️  unexpected JSON shape from /body endpoint, keys: ${Object.stringify ? Object.keys(parsed).join(", ") : "?"}`);
      return { ok: true, text: bodyText, unexpectedShape: true };
    } catch {
      // looked JSON-ish but wasn't — fall through and treat as raw text
    }
  }
  return { ok: true, text: bodyText };
}

function findMatchingCommit(localPath, liveHash) {
  let shas;
  try {
    shas = git(`log --format=%H -n ${MAX_COMMITS_TO_CHECK} -- ${localPath}`).split("\n").filter(Boolean);
  } catch (e) {
    return { error: `git log failed for ${localPath}: ${e.message}` };
  }
  if (shas.length === 0) return { error: `no commit history found for ${localPath} (untracked?)` };

  for (let i = 0; i < shas.length; i++) {
    const sha = shas[i];
    let content;
    try {
      content = git(`show ${sha}:${localPath}`);
    } catch {
      continue;
    }
    if (sha256(content) === liveHash) {
      const info = git(`log -1 --format=%h::%ci::%s ${sha}`);
      const [shortSha, date, subject] = info.split("::");
      return { matchIndex: i, sha, shortSha, date, subject };
    }
  }
  return { noMatch: true, checked: shas.length };
}

async function checkFunction(slug) {
  console.log(`\n=== ${slug} ===`);

  const localRelPath = `supabase/functions/${slug}/index.ts`;
  let localContent;
  try {
    localContent = fs.readFileSync(path.join(__dirname, "..", localRelPath), "utf8");
  } catch (e) {
    console.log(`  local file not found (${e.message}) — skipping`);
    return;
  }
  const localHash = sha256(localContent);
  const localHeadSha = git(`log -1 --format=%h -- ${localRelPath}`) || "(no commits)";

  const deployed = await fetchDeployedSource(slug);
  if (!deployed.ok) {
    console.log(`  LIVE FETCH FAILED (status ${deployed.status}) — ${deployed.bodyText.slice(0, 200)}`);
    return;
  }
  const liveHash = sha256(deployed.text);

  if (liveHash === localHash) {
    console.log(`  ✅ IN SYNC — deployed matches local working copy exactly (local HEAD for this file: ${localHeadSha})`);
    return;
  }

  const match = findMatchingCommit(localRelPath, liveHash);
  if (match.error) {
    console.log(`  ⚠️  could not determine sync status: ${match.error}`);
  } else if (match.noMatch) {
    console.log(`  ❌ DEPLOYED CONTENT DOES NOT MATCH ANY OF THE LAST ${match.checked} LOCAL COMMITS for this function.`);
    console.log(`     Either it was deployed from further back than that, edited outside git, or a transcription error (see this session's own near-miss). Investigate directly.`);
  } else if (match.matchIndex === 0) {
    console.log(`  ⚠️  deployed matches your last COMMIT (${match.shortSha}, ${match.date}) but NOT your current working copy — you have uncommitted local changes not yet deployed.`);
  } else {
    console.log(`  ❌ DEPLOYED IS ${match.matchIndex} COMMIT(S) BEHIND for this function.`);
    console.log(`     Deployed matches: ${match.shortSha}  (${match.date})  "${match.subject}"`);
    console.log(`     Local HEAD for this file: ${localHeadSha}`);
    console.log(`     Fix: redeploy (supabase functions deploy ${slug} --project-ref ${PROJECT_REF} --use-api).`);
  }
}

async function listDeployedSlugs() {
  const { ok, status, bodyText } = await mgmtFetch(`/projects/${PROJECT_REF}/functions`);
  if (!ok) throw new Error(`could not list deployed functions (status ${status}): ${bodyText.slice(0, 200)}`);
  const parsed = JSON.parse(bodyText);
  return new Set(parsed.map((f) => f.slug));
}

async function main() {
  if (!ACCESS_TOKEN) {
    console.error("FATAL: SUPABASE_ACCESS_TOKEN env var not set. This check needs a Management API PAT to read deployed function source — see the header comment in this file for what that credential actually grants before generating one.");
    process.exitCode = 1;
    return;
  }
  const args = process.argv.slice(2);
  const localSlugs = args.length ? args : localFunctionSlugs();

  let deployedSlugs;
  try {
    deployedSlugs = await listDeployedSlugs();
  } catch (e) {
    console.error(`FATAL: ${e.message}`);
    process.exitCode = 1;
    return;
  }

  console.log(`Checking Supabase project ${PROJECT_REF} (${deployedSlugs.size} functions live) against local git history for: ${localSlugs.join(", ")}`);

  const localOnly = localSlugs.filter((s) => !deployedSlugs.has(s));
  if (localOnly.length) {
    console.log(`\n(local file exists but NOT deployed to this project — skipping content check, nothing live to compare against): ${localOnly.join(", ")}`);
  }

  // Only report live-only functions when this run covers the full local set — a targeted run
  // (explicit slug args) isn't trying to be exhaustive, so silence here isn't a missing finding.
  if (!args.length) {
    const liveOnly = [...deployedSlugs].filter((s) => !localSlugs.includes(s));
    if (liveOnly.length) {
      console.log(`\n⚠️  deployed on Supabase but no local supabase/functions/<slug>/index.ts found (orphan, or deleted locally without un-deploying): ${liveOnly.join(", ")}`);
    }
  }

  for (const slug of localSlugs.filter((s) => deployedSlugs.has(s))) {
    await checkFunction(slug);
  }
}

main().catch((e) => {
  console.error("FATAL:", e);
  process.exitCode = 1;
});
