#!/usr/bin/env node
// Answers one question at a glance: "is what's live on alpha.applitrust.com actually the same
// content as my local git HEAD, and if not, how far behind is it?"
//
// WHY THIS EXISTS: a real investigation this session (the "Missing Skills section" bug) turned
// out not to be a code bug at all — the fix had already been written and committed locally, but
// the live GitHub Pages site was 3 commits behind, and nothing surfaced that. This script is the
// fix for the actual gap: not a smarter bug hunt, a way to SEE deploy lag directly, on demand.
//
// DELIBERATELY NOT a baked-in version marker (a `<meta build-commit="...">` tag written into
// candidate.html/staff.html/index.html at commit time): embedding "this commit's own hash" inside
// a file that same commit changes is self-referential — the hash isn't known until after the
// commit exists, so making it accurate requires amending the commit after computing it, which
// changes the hash again. Real static-site tooling works around that with a two-commit stamp
// (content commit, then a separate "record the previous commit's hash" commit) — extra process,
// extra discipline, another thing to forget. This script needs none of that: it hashes the LIVE
// bytes, hashes each historical LOCAL version of the same file via `git show <sha>:<path>`, and
// finds which local commit (if any) produced exactly what's live right now. No process change to
// the deploy step at all — it's a pure, read-only diagnostic, safe to run anytime, and it can't go
// stale the way a baked-in marker could if someone edits a file without re-stamping it.
//
// USAGE: node scripts/check-deploy-sync.js [file ...]
//   No args: checks the default site files below.
//   One or more args: checks just those paths (repo-relative, e.g. "staff.html").

const { execSync } = require("child_process");
const crypto = require("crypto");

const SITE_ORIGIN = "https://alpha.applitrust.com";
// How many of the most recent commits touching a file to search before giving up and reporting
// "no match found" — deep enough to catch real deploy lag (this session's real gap was 3 commits),
// shallow enough that an actually-diverged file (live edited outside git, or a truly ancient
// deploy) fails fast instead of walking the entire repo history.
const MAX_COMMITS_TO_CHECK = 50;

const DEFAULT_FILES = ["candidate.html", "staff.html", "index.html", "employer.html"];

function sha256(text) {
  return crypto.createHash("sha256").update(text, "utf8").digest("hex");
}

function git(args) {
  return execSync(`git ${args}`, { encoding: "utf8", cwd: __dirname + "/.." }).trim();
}

async function fetchLive(path) {
  // Cache-bust query param: GitHub Pages sits behind a CDN, and a plain fetch (or a browser
  // navigation) can return a stale cached copy even right after a real deploy — confirmed real
  // during this session's own testing, not a hypothetical. cache:"no-store" plus a unique query
  // string is the combination that actually got a fresh response every time it was tried live.
  const url = `${SITE_ORIGIN}/${path}?cb=${Date.now()}`;
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) return { ok: false, status: res.status };
  const text = await res.text();
  return { ok: true, text };
}

function findMatchingCommit(path, liveHash) {
  let shas;
  try {
    shas = git(`log --format=%H -n ${MAX_COMMITS_TO_CHECK} -- ${path}`).split("\n").filter(Boolean);
  } catch (e) {
    return { error: `git log failed for ${path}: ${e.message}` };
  }
  if (shas.length === 0) return { error: `no commit history found for ${path} (untracked?)` };

  for (let i = 0; i < shas.length; i++) {
    const sha = shas[i];
    let content;
    try {
      content = git(`show ${sha}:${path}`);
    } catch (e) {
      continue; // file didn't exist at this commit, or was renamed — skip, keep walking back
    }
    if (sha256(content) === liveHash) {
      const info = git(`log -1 --format=%h|%ci|%s ${sha}`);
      const [shortSha, date, subject] = info.split("|");
      return { matchIndex: i, sha, shortSha, date, subject };
    }
  }
  return { noMatch: true, checked: shas.length };
}

async function checkFile(path) {
  console.log(`\n=== ${path} ===`);

  let localContent;
  try {
    localContent = require("fs").readFileSync(__dirname + "/../" + path, "utf8");
  } catch (e) {
    console.log(`  local file not found (${e.message}) — skipping`);
    return;
  }
  const localHash = sha256(localContent);
  const localHeadSha = git(`log -1 --format=%h -- ${path}`) || "(no commits)";

  const live = await fetchLive(path);
  if (!live.ok) {
    console.log(`  LIVE FETCH FAILED (status ${live.status}) — is this file actually deployed at ${SITE_ORIGIN}?`);
    return;
  }
  const liveHash = sha256(live.text);

  if (liveHash === localHash) {
    console.log(`  ✅ IN SYNC — live matches local working copy exactly (local HEAD for this file: ${localHeadSha})`);
    return;
  }

  const match = findMatchingCommit(path, liveHash);
  if (match.error) {
    console.log(`  ⚠️  could not determine sync status: ${match.error}`);
  } else if (match.noMatch) {
    console.log(`  ❌ LIVE CONTENT DOES NOT MATCH ANY OF THE LAST ${match.checked} LOCAL COMMITS for this file.`);
    console.log(`     Either it was deployed from further back than that, edited outside git, or this is a different file. Investigate directly.`);
  } else if (match.matchIndex === 0) {
    // Matched the most recent commit that touched this file, but local's working copy differs —
    // means there are uncommitted local changes, not deploy lag.
    console.log(`  ⚠️  live matches your last COMMIT (${match.shortSha}, ${match.date}) but NOT your current working copy — you have uncommitted local changes.`);
  } else {
    console.log(`  ❌ LIVE IS ${match.matchIndex} COMMIT(S) BEHIND for this file.`);
    console.log(`     Live matches: ${match.shortSha}  (${match.date})  "${match.subject}"`);
    console.log(`     Local HEAD for this file: ${localHeadSha}`);
    console.log(`     Fix: git push origin master (GitHub Pages usually catches up within ~1 min).`);
  }
}

async function main() {
  const args = process.argv.slice(2);
  const files = args.length ? args : DEFAULT_FILES;
  console.log(`Checking ${SITE_ORIGIN} against local git history for: ${files.join(", ")}`);
  for (const f of files) {
    await checkFile(f);
  }
}

main().catch((e) => {
  console.error("FATAL:", e);
  process.exit(1);
});
