"""Stage 2 sample: 10 real Solana tokens chosen by a written random rule, before looking at them.

Rule (fixed before drawing):
- Seed: "PINR-STAGE2-2026-10-04". Python random.Random(seed).sample, frames processed in the order below.
- Exclusions: the operator's disclosed token and every teaching-example mint (they stay out of tuning).
- Frame A, 3 Pump.fun tokens still on the curve: Pump.fun rows of the operator's pre-registered Grok sample
  (Grok Scans/solana_devsell_sample.csv, drawn 2026-10-03 16:55 UTC with its own seed) whose on-chain
  curve is not complete at selection time.
- Frame B, 3 graduated Pump.fun tokens: Pump.fun's public list of completed coins (offsets 0-999, newest first),
  limited to coins created before 2026-10-03 16:00 UTC, so each has at least ~10 hours of history.
- Frame C, 2 StonkFun reward tokens: StonkFun rows of the same pre-registered Grok sample.
- Frame D, 2 other LaunchLab tokens: the non-StonkFun LaunchLab rows of that sample (letsbonk.fun and Raydium).
Nothing about price, market cap, holders or outcome is looked at when choosing.
"""
import csv, json, os, random, struct, sys, time, base64, urllib.request, datetime
sys.path.insert(0, ".")
from solana_rpc import rpc
from b58 import b58d, pda

SEED = "PINR-STAGE2-2026-10-04"
EXCLUDE = {
    "9PX6BGM8bWUMfZG2gVWTdoiUa22HW54DWnoULLhEP81z",  # operator's disclosed token
    "7MCgYMzq3fov6oERdtTMAYbN2U9LZrrSYS1MBhjixZFr", "8RNUw4N655VSrZKuhGdywhbSMDTrheguFPfxbpE2NZHQ",
    "Ai66LHZG9MCzg1WKdawwqduVAXpNDUuV8M3uyq5ppump", "CbcyNo7m1amFWqEQm2m4PLv1UNvpcL3C1Ujm6AkzpKoU",
    "6WbiJtjXoNpLH6GhSvDX4HqRUN3ShQgxsk56Synpump",  # teaching examples
}
PUMP = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P"
CSV = os.environ.get("PINR_SAMPLE_CSV", "solana_devsell_sample.csv")
CUTOFF_MS = int(datetime.datetime(2026, 10, 3, 16, 0, tzinfo=datetime.timezone.utc).timestamp() * 1000)

def get(url):
    for i in range(6):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "PINR-live/1.0 (read-only; pinr.io)"})
            return json.load(urllib.request.urlopen(req, timeout=20))
        except Exception:
            time.sleep(3 * (i + 1))
    raise RuntimeError(f"could not fetch {url}")

rng = random.Random(SEED)
rows = [r for r in csv.DictReader(open(CSV)) if r["mint"] not in EXCLUDE]
picked = []

# Frame A
frame_a = []
for r in rows:
    if r["launchpad"] != "pump.fun":
        continue
    v = rpc("getAccountInfo", [pda([b"bonding-curve", b58d(r["mint"])], PUMP), {"encoding": "base64"}])["value"]
    if v and base64.b64decode(v["data"][0])[48] == 0:
        frame_a.append(r["mint"])
picked += [("A pump curve", m, f"{len(frame_a)} eligible") for m in rng.sample(frame_a, 3)]

# Frame B
frame_b = []
for off in range(0, 1000, 50):
    page = get(f"https://frontend-api-v3.pump.fun/coins?sort=created_timestamp&order=DESC&limit=50&offset={off}&includeNsfw=false&complete=true")
    if not isinstance(page, list) or not page:
        break
    frame_b += [c["mint"] for c in page if c["created_timestamp"] < CUTOFF_MS and c["mint"] not in EXCLUDE]
    time.sleep(1.5)
frame_b = sorted(set(frame_b))
picked += [("B pump graduated", m, f"{len(frame_b)} eligible") for m in rng.sample(frame_b, 3)]

# Frame C
frame_c = sorted(r["mint"] for r in rows if r["platform"] == "StonkFun")
picked += [("C stonkfun", m, f"{len(frame_c)} eligible") for m in rng.sample(frame_c, 2)]

# Frame D
frame_d = sorted(r["mint"] for r in rows if r["launchpad"] == "Raydium LaunchLab" and r["platform"] in ("letsbonk.fun", "Raydium"))
picked += [("D other launchlab", m, f"{len(frame_d)} eligible") for m in rng.sample(frame_d, 2)]

now = datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds")
with open("stage2_sample.csv", "w", newline="") as f:
    w = csv.writer(f)
    w.writerow(["frame", "mint", "frame_size", "selected_at_utc", "seed"])
    for frame, m, size in picked:
        w.writerow([frame, m, size, now, SEED])
for p in picked:
    print(*p)
