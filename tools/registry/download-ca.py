"""Downloads the California DCA licensee-list data files from the public Box shared folder (the folder linked from
https://www.dca.ca.gov/consumers/public_info/index.html) and the per-board Counts files (the board's own published license counts).
   python tools/registry/download-ca.py <listing.json> <cookies.txt> <outDir> [--skip Folder1,Folder2]
listing.json is the folder listing produced when the Box folder was enumerated: [folder, name, type, size, updated, file_id, hash, ext].
Every download is checked against the size Box lists for it. .xlsx files (Dental, Court Reporters) are also converted to TSV with
xlsx-to-tsv.py so the same TypeScript parser reads them. Re-running skips files already present at the right size."""
import json, os, subprocess, sys, time

listing, cookies, out = sys.argv[1], sys.argv[2], sys.argv[3]
skip = set()
if "--skip" in sys.argv:
    skip = set(sys.argv[sys.argv.index("--skip") + 1].split(","))
S = "oss6hf8jys2bmgxqd2gdz7w4oepm2il9"
os.makedirs(out, exist_ok=True)
os.makedirs(os.path.join(out, "counts"), exist_ok=True)
L = json.load(open(listing))
total = 0
for folder, name, typ, size, updated, fid, h, ext in L:
    if folder in skip or typ != "file":
        continue
    dst = os.path.join(out, "counts", name) if "Counts" in name else os.path.join(out, name)
    if os.path.exists(dst) and os.path.getsize(dst) == size:
        continue
    url = f"https://dca.app.box.com/index.php?rm=box_download_shared_file&shared_name={S}&file_id=f_{fid}"
    for attempt in range(1, 5):
        t = time.time()
        r = subprocess.run(["curl", "-sS", "-L", "-A", "Mozilla/5.0", "-b", cookies, "-o", dst, "--max-time", "900", url])
        got = os.path.getsize(dst) if os.path.exists(dst) else -1
        if r.returncode == 0 and got == size:
            total += got
            print(f"ok   {name:62s} {got:>11,d} B  {time.time()-t:5.1f}s", flush=True)
            break
        print(f"RETRY {name} attempt {attempt}: curl rc={r.returncode}, got {got} of {size}", flush=True)
        time.sleep(3 * attempt)
    else:
        print(f"FAILED {name}", flush=True)
        sys.exit(1)
    if name.endswith(".xlsx"):
        subprocess.run([sys.executable, os.path.join(os.path.dirname(__file__), "xlsx-to-tsv.py"), dst, dst[:-5] + ".tsv"], check=True)
print(f"downloaded {total:,d} bytes this run")
