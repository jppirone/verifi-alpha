# Reloading the file-based license sources (manual, monthly)

The file-based sources are snapshots in the private `registry-data` bucket. They are only as fresh as the last load, which is why the adapters treat a lapse on
them as "held for staff", never as a definitive expiry. Reload at least monthly; each reload replaces that source's objects only (pruning is per source id).

| source id | what | where it comes from | refresh at source |
|---|---|---|---|
| `ca-cslb` | California contractors (business + associated people) | CSLB Data Portal: License Master + Personnel CSV | daily |
| `ca-dre` | California real estate salespeople, brokers, corporations | DRE `CurrList.zip` (Licensee List) | daily |
| `ca-dca` | 33 DCA boards | dca.ca.gov public_info monthly lists (`download-ca.py`) | monthly |
| `mi-lara` | 7 LARA groups | MiPLUS FOIA reports | monthly |

## CSLB + DRE (about 10 minutes, mostly waiting)

```bash
python tools/registry/download-cslb-dre.py <dir>            # both; one request per file, retries a dropped CSLB stream up to 3x
node tools/registry/test-cslb.ts <dir>                       # real-file check (expects the measured shape, no schema problems)
node tools/registry/test-dre.ts  <dir>
node tools/registry/build-shards.ts ca-cslb <shardsDir> <dir> license_master.csv personnel.csv     # ~3 min
node tools/registry/build-shards.ts ca-dre  <shardsDir> <dir> CurrList.csv                          # ~3 min
# staff admin session token in STAFF_TOKEN; REGISTRY_URL and SUPABASE_ANON_KEY set
node tools/registry/upload-shards.ts <shardsDir> ca-cslb
node tools/registry/upload-shards.ts <shardsDir> ca-dre
```

Checks after a load: the upload prints `rows_total`; look a known licensee up through `registry-lookup` (`sources: ["ca-cslb"]` / `["ca-dre"]`).
Expected size (2026-10-01): CSLB 566,617 records / 44.5 MB; DRE 428,262 records / 31.5 MB. Bucket total after both: about 320 MiB of the 1 GiB free-plan limit.

## Rules the loads depend on
* One request per file, no loops, no scraping of the search pages. These are the agencies' own free bulk downloads (no login, no CAPTCHA). The CSLB page says
  its data is "current as of the date reflected" and to confirm status through its Instant License Check; the adapters therefore never turn a CSLB or DRE row
  into a definitive negative.
* Nothing personal beyond the public licence record is stored: no street address, phone, zip or related person (parsers drop them; the build refuses e-mail
  addresses and street addresses in city/county).
* The DRE **Examinee** list carries a use restriction (Civil Code s.1798.61(b)) and is deliberately NOT used.
