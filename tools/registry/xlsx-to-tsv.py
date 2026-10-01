"""Converts the first sheet of an .xlsx file to tab-delimited text (dates as ISO yyyy-mm-dd), streaming.
   python tools/registry/xlsx-to-tsv.py in.xlsx out.tsv
Used so the Michigan / Delaware roster spreadsheets can be parsed by the same TypeScript normalizers as every other source."""
import sys, datetime, openpyxl
src, dst = sys.argv[1], sys.argv[2]
wb = openpyxl.load_workbook(src, read_only=True)
ws = wb.worksheets[0]
n = 0
def cell(v):
    if v is None: return ""
    if isinstance(v, datetime.datetime): return v.date().isoformat()
    if isinstance(v, datetime.date): return v.isoformat()
    return str(v).replace("\t", " ").replace("\r", " ").replace("\n", " ")
with open(dst, "w", encoding="utf-8", newline="\n") as out:
    for row in ws.iter_rows(values_only=True):
        out.write("\t".join(cell(v) for v in row) + "\n"); n += 1
print(f"{src}: sheet '{ws.title}' -> {n} lines (incl. header)")
