#!/usr/bin/env bash
# FEASIBILITY TEST — follow-up to test-real-tesseract-columns' negative result (real Tesseract 5.5.3,
# --psm 3, genuinely merges the two columns into one block — confirmed via TSV block structure, not
# just eyeballing text). Question: is the thin RULED-LINE divider specifically what confuses
# Tesseract's layout analysis, or does the same failure happen with a plain whitespace gutter (no
# line at all)? Isolates exactly one variable — see generate-image.js: identical content, fonts,
# and column x-positions (60 / 320) as the original test, only the vertical line's draw call is
# removed.
#
# RESULT — DOCUMENTED, NEGATIVE. The whitespace gutter changes NOTHING. psm3-output.txt in this
# folder is byte-for-byte identical to test-real-tesseract-columns/psm3-output.txt in body content
# (confirmed via diff — the only difference across the two files is one trailing blank line at
# end-of-file, an artifact of tesseract's own text-output formatting, not a content difference).
# The TSV block structure confirms it directly: "CONTACT" (left=61) and "EXPERIENCE" (left=321)
# still land on block_num=4, line_num=1 — the identical single-block merge as the ruled-line
# version, at the identical pixel coordinates.
#
# CONCLUSION: this rules out "ruled line confuses gutter detection" as the mechanism. The finding
# does NOT narrow to "thin-line dividers specifically break Tesseract's column detection" — it
# widens to a general finding: this column shape (narrow left column, wide right column, ~55-75px
# gap either way) defeats Tesseract's layout analysis regardless of what marks the gutter, or
# whether anything marks it at all. Stronger evidence for a genuine Tesseract layout-analysis
# limitation on this shape, not a narrow one about ruled lines.

set -e
cd "$(dirname "$0")"

TESSERACT="/c/Program Files/Tesseract-OCR/tesseract.exe"

"$TESSERACT" two-column-resume-gutter.png psm3-output --psm 3
"$TESSERACT" two-column-resume-gutter.png psm3 --psm 3 tsv   # produces psm3.tsv

echo "--- diff against the ruled-line version's output (expect: only trailing-newline noise) ---"
diff ../test-real-tesseract-columns/psm3-output.txt psm3-output.txt || true

echo "--- CONTACT / EXPERIENCE block assignment in this version's TSV ---"
grep "CONTACT\|EXPERIENCE" psm3.tsv
