"""Downloads the two California bulk license files that are loaded by hand (monthly SOP, see RELOAD-SOP.md).
  python tools/registry/download-cslb-dre.py <outDir> [cslb|dre|both]

CSLB  License Master + Personnel (CSV)  https://www.cslb.ca.gov/OnlineServices/DataPortal/ContractorList   (an ASP.NET page: pick the file, press the CSV link)
DRE   Licensee List (CurrList.zip)      https://secure.dre.ca.gov/datafile/CurrList.zip                      (a plain file URL)
Both are the agencies' own free public downloads (no login, no CAPTCHA). Be polite: ONE request per file; the CSLB stream occasionally drops mid-file (no Content-Length,
no resume), so a CSLB file is accepted only if its last CSV row is complete, retried at most 3 times with a pause. Never loop on this faster than a human would click.
"""
import csv, io, os, re, sys, time, zipfile, urllib.parse, urllib.request, http.cookiejar

UA = "Mozilla/5.0 (Verifi data-load; contact john.pirone@gmail.com)"
out = sys.argv[1] if len(sys.argv) > 1 else "."
which = sys.argv[2] if len(sys.argv) > 2 else "both"
os.makedirs(out, exist_ok=True)
csv.field_size_limit(10 ** 8)

def complete(path):
    """A CSV is complete if every row has the header's width (a dropped stream leaves a short last row)."""
    with open(path, encoding="latin1", newline="") as fh:
        rows = csv.reader(fh); n = len(next(rows)); last = 0
        for r in rows:
            if len(r) != n: return False
            last += 1
    return last > 1000

def cslb():
    base = "https://www.cslb.ca.gov/OnlineServices/DataPortal/ContractorList"
    for code, target, name in [("M", "ctl00$MainContent$lbMasterCSV", "license_master.csv"), ("P", "ctl00$MainContent$lbtnPersonnelcsv", "personnel.csv")]:
        for attempt in range(1, 4):
            cj = http.cookiejar.CookieJar(); op = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(cj)); op.addheaders = [("User-Agent", UA)]
            html = op.open(base, timeout=60).read().decode("utf8", "ignore")
            hidden = lambda h: {m.group(1): m.group(2) for m in re.finditer(r'<input type="hidden" name="([^"]+)" id="[^"]*" value="([^"]*)"', h)}
            f = hidden(html); f.update({"ctl00$MainContent$smPanel": "ctl00$MainContent$uplinks|ctl00$MainContent$ddlStatus", "__EVENTTARGET": "ctl00$MainContent$ddlStatus", "__ASYNCPOST": "true", "ctl00$MainContent$ddlStatus": code})
            r = op.open(urllib.request.Request(base, data=urllib.parse.urlencode(f).encode(), headers={"X-MicrosoftAjax": "Delta=true", "X-Requested-With": "XMLHttpRequest"}), timeout=60).read().decode("utf8", "ignore")
            g = hidden(html); g.update({m.group(1): m.group(2) for m in re.finditer(r"\|hiddenField\|([^|]+)\|([^|]*)\|", r)}); g.update({"__EVENTTARGET": target, "__EVENTARGUMENT": "", "ctl00$MainContent$ddlStatus": code})
            resp = op.open(urllib.request.Request(base, data=urllib.parse.urlencode(g).encode()), timeout=900)
            path = os.path.join(out, name); n = 0
            with open(path, "wb") as fh:
                while True:
                    try: b = resp.read(1 << 20)
                    except Exception as e: print(f"  {name}: stream dropped after {n} bytes ({type(e).__name__})"); break
                    if not b: break
                    fh.write(b); n += len(b)
            if complete(path): print(f"{name}: {n} bytes, complete"); break
            print(f"  {name}: incomplete (attempt {attempt}/3)"); time.sleep(30)
        else:
            sys.exit(f"{name}: could not get a complete file after 3 attempts; stop and try again later")

def dre():
    path = os.path.join(out, "CurrList.zip")
    req = urllib.request.Request("https://secure.dre.ca.gov/datafile/CurrList.zip", headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=600) as resp, open(path, "wb") as fh: fh.write(resp.read())
    zipfile.ZipFile(path).extractall(out)
    ok = complete(os.path.join(out, "CurrList.csv")); print("CurrList.csv:", os.path.getsize(os.path.join(out, "CurrList.csv")), "bytes,", "complete" if ok else "INCOMPLETE")
    if not ok: sys.exit("CurrList.csv incomplete")

if which in ("cslb", "both"): cslb()
if which in ("dre", "both"): dre()
