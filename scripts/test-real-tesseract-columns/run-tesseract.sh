#!/usr/bin/env bash
# FEASIBILITY TEST — settles whether the two-column interleaving bug found in every prior OCR test
# tonight (test-tesseract-wasm-ocr, test-tesseract-wasm-psm, test-tesseract-wasm-columns) is a
# limitation specific to tesseract-wasm's incomplete bindings (no real PSM control — confirmed
# dead, see test-tesseract-wasm-psm), or a fundamental limitation of Tesseract's actual layout-
# analysis engine that any wrapper would hit.
#
# Local-only, not deployed anywhere, not an Edge Function — a real, mature Tesseract binary run
# directly, with real --psm control, against the exact same test image as every prior test.
#
# SETUP: real, official Tesseract 5.5.3 (tesseract-ocr.tesseract via winget — the same upstream
# project apt-get install tesseract-ocr would give on Linux, not a fork), installed locally.
#   winget install --id tesseract-ocr.tesseract
#
# IMAGE: two-column-resume.png in this folder is the exact same test image used in every prior
# column test. The original in-browser RGBA buffer was never saved to disk (it was generated and
# POSTed directly to a Supabase Edge Function, never persisted), so it could not be reused as a
# literal file — but the deterministic canvas-drawing CODE that produced it was recovered verbatim
# from this session's own transcript (see generate-image.js) and re-run unmodified in the same
# browser engine to reproduce the identical rendering. This is a genuine reuse of the same image
# via its exact generation code, not a new/different example.
#
# RESULT — DOCUMENTED, NEGATIVE. Real Tesseract's actual layout-analysis engine does NOT fix the
# column problem. Ran three page-segmentation modes against the identical image:
#   --psm 3 (automatic page segmentation, real Tesseract's own CLI default — the exact mode
#            tesseract-wasm's setVariable call set but never actually reached, per
#            test-tesseract-wasm-psm)
#   --psm 1 (automatic with orientation/script detection)
#   --psm 6 (single uniform block — tesseract-wasm's actual, unfixable default)
#
# psm3-output.txt and psm1-output.txt are BYTE-FOR-BYTE IDENTICAL (confirmed via diff). Both show
# the exact same column interleaving as every prior test: "CONTACT EXPERIENCE" merged onto one
# line, "taylor.chen@example.com Senior Product Marketing Manager, Nimbus Cloud Co" merged onto
# one line, "SKILLS ~ Managed $1.2M annual marketing budget..." merged, same everything. psm6-
# output.txt differs only in incidental OCR noise (slightly different misreads here and there,
# e.g. "SL Tableau Figma" under psm3/1 vs "SOL. Tableau, Figma" under psm6) — the fundamental
# column-merge failure is identical across all three modes.
#
# THE DECISIVE EVIDENCE (not just eyeballing the text): psm3.tsv's own block/paragraph/line
# structure — Tesseract's internal ground truth for what it thinks the layout is — shows
# block_num=4 spanning left=60,top=127,width=616,height=209 containing BOTH "CONTACT" (x=61) and
# "EXPERIENCE" (x=321) as two words on the SAME line_num=1 of the SAME block. Real Tesseract's own
# layout-analysis engine looked at this page and decided the two columns were one block, one
# paragraph, one line — not a rendering-order artifact downstream of correct block detection, a
# genuine layout-analysis miss at the source. Regenerate with `tesseract two-column-resume.png out
# --psm 3 tsv` to re-check this directly.
#
# One real, honest partial difference worth flagging, not rounded up to "fixed": character-level
# accuracy on isolated words did improve in a couple of spots — "Figma" read correctly here (vs
# tesseract-wasm's "Fisma"), "Cross unetona" vs tesseract-wasm's "Cross unctona" (both still wrong,
# different specific corruption). That's real Tesseract's more mature character-recognition model
# doing slightly better at the character level, NOT its layout analysis doing better — the column
# merge that actually breaks reading order is identical.
#
# CONCLUSION: this is not a WASM-wrapper limitation. Real, mature, actual Tesseract — the thing
# tesseract-wasm's incomplete bindings supposedly couldn't reach — was reached directly here, given
# real, working --psm control, and produced the same column-interleaving failure. The column
# problem is genuinely hard for Tesseract's layout analysis on this specific image shape (a narrow
# left column against a wide right column separated only by a thin ruled line, no wide whitespace
# gutter), not an artifact of any particular binding. Column-splitting the IMAGE itself before OCR
# (real custom column-detection on pixel data) remains the only lever not yet tried — explicitly
# out of scope here, per every prior test's own deferral of that same next step.

set -e
cd "$(dirname "$0")"

TESSERACT="/c/Program Files/Tesseract-OCR/tesseract.exe"

"$TESSERACT" two-column-resume.png psm3-output --psm 3
"$TESSERACT" two-column-resume.png psm1-output --psm 1
"$TESSERACT" two-column-resume.png psm6-output --psm 6
"$TESSERACT" two-column-resume.png psm3 --psm 3 tsv   # produces psm3.tsv — block/line structure

diff psm3-output.txt psm1-output.txt && echo "psm3 vs psm1: IDENTICAL"
