"""Downloads Virginia DPOR's free public Regulant Lists (180-odd tab-delimited files, one per occupation) and records the page's code -> occupation labels.
  python tools/registry/download-dpor.py <outDir>
Source: https://www.dpor.virginia.gov/RegulantLists ("Regulant lists are provided free of charge in electronic format", updated about every 5 business days).
ONE request per file with a pause between them (about 5 minutes in all); never run it in a loop. The files contain e-mail addresses and street addresses: the parser
(supabase/functions/_shared/registry/dpor.ts) drops them and the build refuses to store an e-mail.
Writes <outDir>/<file>.txt for every list and <outDir>/labels.json {"0401": "APELSCIDLA Architect", ...}."""
import html, json, os, re, sys, time, urllib.parse, urllib.request

UA = "Mozilla/5.0 (Verifi data-load; contact john.pirone@gmail.com)"
out = sys.argv[1] if len(sys.argv) > 1 else "."
os.makedirs(out, exist_ok=True)
page = "https://www.dpor.virginia.gov/RegulantLists"
body = urllib.request.urlopen(urllib.request.Request(page, headers={"User-Agent": UA}), timeout=60).read().decode("utf8", "ignore")
body = re.sub(r"<script.*?</script>|<style.*?</style>", "", body, flags=re.S)
links = []
for m in re.finditer(r'href="([^"]*Regulant%20List/([^"/]+\.txt))"', body):
    if m.group(2) not in [f for _, f in links]: links.append((m.group(1), m.group(2)))
# labels: the page lists "<code> <occupation name>" entries, e.g. "0401 APELSCIDLA Architect"
txt = re.sub(r"\s+", " ", html.unescape(re.sub(r"<[^>]+>", " ", body)))
labels = {}
for m in re.finditer(r"\b(\d{4}(?:[a-z]+)?)\s+((?:\([A-Z]+\)\s+)?[A-Z][A-Za-z&'/\-,\. ()]+?)(?=\s+\d{4}\b|\s+Board\b|\s+Businesses:|\s+Individuals:|$)", txt):
    labels.setdefault(m.group(1), m.group(2).strip())
print(len(links), "files listed;", len(labels), "labels read")
json.dump(labels, open(os.path.join(out, "labels.json"), "w"), indent=1)
done = 0
for href, f in links:
    path = os.path.join(out, f)
    if os.path.exists(path) and os.path.getsize(path) > 0: done += 1; continue
    url = urllib.parse.urljoin(page, href)
    for attempt in range(1, 4):
        try:
            data = urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": UA}), timeout=120).read()
            open(path, "wb").write(data); done += 1; break
        except Exception as e:
            print(f"  {f}: attempt {attempt} failed ({type(e).__name__})"); time.sleep(10)
    time.sleep(1.5)
print(done, "of", len(links), "files present in", out)
