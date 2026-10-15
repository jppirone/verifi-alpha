#!/usr/bin/env bash
# Stages (does NOT commit or push) the temporary test slugs for the OCR-gap regression run. For Git Bash.
# Run from the repo root, on master:
#     git show ocr-gap-repair:tools/resume/stage-temp-slugs.sh | bash
# It stops at the first problem and prints "STOP: ...". Nothing is committed; if it stops after creating files,
# the ABORT block in the runbook removes them.
set -u
fail() { echo "STOP: $*"; exit 1; }
BR=ocr-gap-repair
RZ=supabase/functions/rasterize-pdf-page
UP=supabase/functions/upload-resume

[ "$(git branch --show-current)" = "master" ] || fail "not on master"
[ -z "$(git status --short | grep -v -e '^?? backups/' -e '^?? docs/')" ] || fail "working tree not clean (only '?? backups/' and '?? docs/' are allowed)"
git fetch -q origin || fail "git fetch failed"
[ "$(git rev-parse master)" = "$(git rev-parse origin/master)" ] || fail "master differs from origin/master"
git rev-parse -q --verify "refs/heads/$BR" >/dev/null || fail "local branch $BR not found"
[ ! -e "$RZ-next" ] && [ ! -e "$UP-next" ] || fail "a -next folder already exists"

mkdir "$RZ-next" "$UP-next" || fail "mkdir failed"
git show "$BR:$RZ/index.ts" > "$RZ-next/index.ts" || fail "could not read $RZ/index.ts from $BR"
git show "$BR:$UP/index.ts" | sed 's#functions/v1/rasterize-pdf-page`#functions/v1/rasterize-pdf-page-next`#' > "$UP-next/index.ts" || fail "could not build $UP-next"

# (a) upload-resume-next must now call the -next rasterizer, and ONLY that line may differ from upload-resume on the branch
grep -q 'functions/v1/rasterize-pdf-page-next`' "$UP-next/index.ts" || fail "upload-resume-next does not contain rasterize-pdf-page-next"
[ "$(grep -c 'functions/v1/rasterize-pdf-page`' "$UP-next/index.ts")" = "0" ] || fail "upload-resume-next still calls the production rasterizer"
changed=$(diff <(git show "$BR:$UP/index.ts") "$UP-next/index.ts" | grep -c '^>')
[ "$changed" = "1" ] || fail "upload-resume-next differs from $BR:$UP in $changed lines (expected exactly 1)"
cmp -s "$RZ-next/index.ts" <(git show "$BR:$RZ/index.ts") || fail "rasterize-pdf-page-next is not identical to $BR:$RZ"

git checkout "$BR" -- supabase/functions/_shared/resume-ocr-gaps.ts supabase/functions/_shared/resume-heading-guard.ts \
  tools/resume/run-upload.mjs tools/resume/test-resume-ocr-gaps.ts tools/resume/test-resume-heading-guard.ts || fail "could not copy shared files from $BR"
printf '\n# TEMPORARY test slugs for the OCR-gap regression run; remove after the run (see the runbook).\n[functions.rasterize-pdf-page-next]\nverify_jwt = true\n\n[functions.upload-resume-next]\nverify_jwt = false\n' >> supabase/config.toml
git add supabase/config.toml "$RZ-next" "$UP-next" supabase/functions/_shared/resume-ocr-gaps.ts supabase/functions/_shared/resume-heading-guard.ts \
  tools/resume/run-upload.mjs tools/resume/test-resume-ocr-gaps.ts tools/resume/test-resume-heading-guard.ts

# (b) exactly these 8 paths may be staged, and nothing may be modified-but-unstaged
expected="A	supabase/functions/_shared/resume-heading-guard.ts
A	supabase/functions/_shared/resume-ocr-gaps.ts
A	supabase/functions/rasterize-pdf-page-next/index.ts
A	supabase/functions/upload-resume-next/index.ts
A	tools/resume/run-upload.mjs
A	tools/resume/test-resume-heading-guard.ts
A	tools/resume/test-resume-ocr-gaps.ts
M	supabase/config.toml"
actual=$(git diff --cached --name-status | sort)
[ "$actual" = "$(echo "$expected" | sort)" ] || { echo "$actual"; fail "staged files are not exactly the expected 8"; }
[ -z "$(git diff --name-only)" ] || fail "unstaged modifications exist"
[ "$(git diff --cached -- supabase/config.toml | grep -c '^+\[functions\.')" = "2" ] || fail "config.toml change is not exactly the two new function entries"
git diff --cached --name-only | grep -q -e '^supabase/functions/rasterize-pdf-page/' -e '^supabase/functions/upload-resume/' && fail "a production function folder is staged"

echo "OK: 8 files staged, nothing committed:"
git diff --cached --stat | cat
echo "Next: git commit -m 'TEMPORARY test slugs for the OCR-gap regression run' && git push origin master"
