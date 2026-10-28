# check-pdf-bullets.py - extraction checks of the bullet PDFs of prompt EA (October 28, 2026). Invented data only. No network, no browser. Reads the PDFs with PyMuPDF and pdftotext only.
# Usage: python tools/resume/check-pdf-bullets.py <dir with the PDFs> [--hyphen]
# Files: Rowan-Testwell-Resume-Applitrust-control.pdf, ...-new-bullet.pdf (and ...-new-hyphen.pdf with --hyphen). Prints one JSON document.
# Numbers: pages, bytes, words and non space characters (PyMuPDF), the first 40 lines of text (PyMuPDF and pdftotext -raw), lines that start with the mark, words lost, changed, split or joined against the control
# (PyMuPDF, pdftotext and pdftotext -raw; lone marks left out), every description line has exactly one mark and nothing else has one, no mark alone at the bottom of a page, the widest line against the margin.
import json, os, subprocess, sys, re
import pymupdf

d = sys.argv[1]
HY = "--hyphen" in sys.argv
FX = os.path.join(os.path.dirname(os.path.abspath(__file__)), "fixtures", "ea-bullet-resume.json")
fx = json.loads(open(FX, encoding="utf-8").read().replace("{BULLET}", chr(0x2022)).replace("{ENDASH}", chr(0x2013)).replace("{EMDASH}", chr(0x2014)))   # the fixture holds placeholders, not the characters
NAMES = {"control": "Rowan-Testwell-Resume-Applitrust-control.pdf", "new": "Rowan-Testwell-Resume-Applitrust-new-bullet.pdf"}
if HY: NAMES["hyphen"] = "Rowan-Testwell-Resume-Applitrust-new-hyphen.pdf"
P = {k: os.path.join(d, v) for k, v in NAMES.items()}
docs = {k: pymupdf.open(v) for k, v in P.items()}
BULLET, ENDASH, EMDASH = chr(0x2022), chr(0x2013), chr(0x2014)   # written as numbers so this file holds no dash character
MARK = {"new": BULLET, "hyphen": "-"}

def pdftotext(path, raw):
    cmd = ["pdftotext", "-enc", "UTF-8"] + (["-raw"] if raw else []) + [path, "-"]
    return subprocess.run(cmd, capture_output=True).stdout.decode("utf-8", errors="replace").replace("\r\n", "\n")

T = {k: {"PyMuPDF": "".join(p.get_text() for p in docs[k]), "pdftotext": pdftotext(P[k], False), "pdftotext -raw": pdftotext(P[k], True)} for k in P}

def nonspace(doc):
    n = 0
    for page in doc:
        for b in page.get_text("rawdict")["blocks"]:
            for l in b.get("lines", []):
                for s in l["spans"]: n += sum(1 for c in s["chars"] if c["c"] != " ")
    return n

LONE = {BULLET, "-", "*"}
def tokens(t, drop):
    return [x for x in t.replace("\f", " ").split() if not (drop and x in LONE)]

res = {"files": {}, "first_40_lines": {}, "compare_with_control": {}, "checks": {}}
for k in P:
    doc = docs[k]
    res["files"][k] = {"pages": len(doc), "bytes": os.path.getsize(P[k]), "words_pymupdf": sum(len(p.get_text("words")) for p in doc), "non_space_chars_pymupdf": nonspace(doc),
                       "fonts": sorted({f[3] for p in doc for f in p.get_fonts()})}
    res["first_40_lines"][k] = {"PyMuPDF": T[k]["PyMuPDF"].split("\n")[:40], "pdftotext -raw": T[k]["pdftotext -raw"].split("\n")[:40]}
    for tool, t in T[k].items():
        lines = t.replace("\f", "\n").split("\n")
        res["files"][k].setdefault("lines_starting_with_bullet_U+2022", {})[tool] = sum(1 for l in lines if l.startswith(BULLET))
        res["files"][k].setdefault("lines_starting_with_hyphen_space", {})[tool] = sum(1 for l in lines if l.startswith("- "))
for k in P:
    if k == "control": continue
    res["compare_with_control"][k] = {}
    for tool in T["control"]:
        a, b = tokens(T["control"][tool], True), tokens(T[k][tool], True)
        info = {"words_control_without_marks": len(a), "words_variant_without_marks": len(b), "identical_word_lists": a == b}
        if a != b:
            sa, sb = set(a), set(b)
            info["only_in_control"] = sorted(sa - sb)[:30]; info["only_in_variant"] = sorted(sb - sa)[:30]
            i = 0
            while i < min(len(a), len(b)) and a[i] == b[i]: i += 1
            info["first_difference_at_word"] = i; info["control_there"] = a[i:i + 6]; info["variant_there"] = b[i:i + 6]
        info["lone_marks_control"] = len(tokens(T["control"][tool], False)) - len(a); info["lone_marks_variant"] = len(tokens(T[k][tool], False)) - len(b)
        res["compare_with_control"][k][tool] = info

# every description line (a line of the data, wrapped) must have exactly one mark; nothing else may have one
desc = [l for j in fx["delivered"]["work"] for l in j["description"].split("\n") if l]
MARK_RE = re.compile("^\\s*(?:[" + BULLET + chr(0x25CF) + chr(0x25AA) + chr(0x25E6) + chr(0xB7) + "]\\s*|[*\\-" + ENDASH + EMDASH + "]\\s+)")
def strip_mark(s): return MARK_RE.sub("", s).strip()
starts = [" ".join(strip_mark(l).split()[:4]) for l in desc]
for k in ("new", "hyphen"):
    if k not in P: continue
    m = MARK[k]; doc = docs[k]
    marked = []; per_page_last = []; xs = []; max_x1 = 0.0; max_text_x1 = 0.0
    for pi, page in enumerate(doc):
        lines = []
        for b in page.get_text("rawdict")["blocks"]:
            for l in b.get("lines", []):
                txt = "".join(c["c"] for s in l["spans"] for c in s["chars"])
                chars = [c for s in l["spans"] for c in s["chars"]]
                lines.append((l["bbox"][1], l["bbox"][0], txt, chars, l["bbox"]))
                max_x1 = max(max_x1, l["bbox"][2])
        lines.sort(key=lambda r: (round(r[0]), r[1]))
        per_page_last.append(lines[-1][2].strip() if lines else "")
        for y, x, txt, chars, bb in lines:
            if txt.strip().startswith(m) and m == BULLET or (m == "-" and txt.strip().startswith("- ")):
                marked.append(" ".join(txt.strip()[1:].split()[:4]))
                mk = [c for c in chars if c["c"] == m]
                if mk: xs.append(round(mk[0]["origin"][0], 2))
    exp = list(starts); got = list(marked)
    ok_each = sorted(exp) == sorted(got)
    total_marks = T[k]["PyMuPDF"].count(m) if m == BULLET else None
    res["checks"][k] = {"description_lines_in_data": len(desc), "lines_with_a_mark": len(marked), "each_description_line_has_one_mark_and_no_other_line_has_one": ok_each,
                        "unexpected_marked_lines": [g for g in got if g not in exp][:10], "description_lines_without_mark": [e for e in exp if e not in got][:10],
                        "mark_character_count_in_text": total_marks, "mark_x_positions_distinct": sorted(set(xs)),
                        "page_last_lines": per_page_last, "a_lone_mark_ends_a_page": any(l == m for l in per_page_last),
                        "right_most_text_edge_points": round(max_x1, 2), "right_margin_points": 612 - 54}
# the geometry the reader's column rule looks at (rasterize-pdf-page reconstructByWordClustering): the sorted LEFT edges of all words at 150 dpi; a jump between neighbours of more than 60 px (MIN_COLUMN_GAP_PX) makes it
# think of two columns. The word boxes here come from the PDF (PyMuPDF), not from the OCR, so this is the geometry the OCR boxes should have, not the OCR itself.
res["reader_column_rule_geometry"] = {}
for k in P:
    r = []
    for pi, page in enumerate(docs[k]):
        lefts = sorted(w[0] * 150 / 72 for w in page.get_text("words"))
        gaps = [(lefts[i] - lefts[i - 1], lefts[i - 1], lefts[i]) for i in range(1, len(lefts))]
        g = max(gaps) if gaps else (0, 0, 0)
        r.append({"page": pi + 1, "words": len(lefts), "largest_gap_between_neighbouring_left_edges_px": round(g[0], 1), "between_left_edges_px": [round(g[1], 1), round(g[2], 1)], "limit_px": 60})
    res["reader_column_rule_geometry"][k] = r
print(json.dumps(res, indent=1, ensure_ascii=False))
