"""Re-export the feed files of the coins the site shows, from their SAVED result files (the team, 2026-10-13: so the
operator's review meets receipts, contract v1.1). No score is re-run: the facts come from each result's own receipts and
read_at is the time each figure was read at that score. The only outside reads are one Pump.fun coin-record request per
Solana coin for its links (inside the shared budget). BNB and Base coins are exported only from what is cached (no chain
read); their saved results carry no matching receipts, so they get no facts.

  python3 tools/reexport_shown.py <engine root> [--dry] [--all]

--all: every saved Solana result, not only the shown coins, from what is
cached only: no record read, no chain read (a coin whose name and picture were never cached keeps its old file and is
counted as skipped); the shown coins are done first by the plain run.
"""
import glob, json, os, sys, time, urllib.request

root = os.path.abspath(sys.argv[1]); dry = "--dry" in sys.argv; everything = "--all" in sys.argv
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "feed"))
for p in ("stage2", "stage3", "stage4", "pinr-score", "feed"):
    sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", p))
import feed_export as F
F.FEED_DIR = os.path.join(root, "frontend-feed"); F.CACHE = os.path.join(root, "feed", "meta_cache.json")
F.RESULT_DIRS = [os.path.join(root, d) for d in ("stage2/results", "gate3/results", "stage4/results")]
import pumpfun_api as PF, solana_rpc as S                        # the SAME shared budget, pacing and count files as the live scanner
PF._BUCKET_DB = os.path.join(root, "index", "pumpfun_budget.sqlite")
S.PACE_DB, S.COUNT_DB = os.path.join(root, "index", "solana_pace.sqlite"), os.path.join(root, "index", "requests.sqlite")

cache = F._cache()
if everything:
    F.READ_LINKS = False
    shown = [{"address": os.path.basename(f)[:-5], "chain": "solana", "score": 1} for f in glob.glob(os.path.join(root, "stage2/results", "*.json"))]
    scored = shown
else:
    shown = json.load(urllib.request.urlopen("http://127.0.0.1:8787/api/tokens", timeout=10)).get("tokens") or []
    scored = [t for t in shown if t.get("score") is not None or (t.get("label") and t.get("note") != "Not scored yet")]
def newest_result(addr):
    best = None
    for d in F.RESULT_DIRS:
        for f in glob.glob(os.path.join(d, addr + ".json")) + glob.glob(os.path.join(d, addr.lower() + ".json")):
            t = os.path.getmtime(f)
            if best is None or t > best[0]:
                best = (t, f)
    return best[1] if best else None
counts = {"solana": [0, 0, 0, 0], "evm": [0, 0, 0, 0]}        # exported, with facts, with links, skipped
t0 = time.time()
for t in scored:
    addr = t.get("address") or t.get("mint") or ""
    kind = "solana" if t.get("chain") == "solana" else "evm"
    f = newest_result(addr)
    if not f:
        counts[kind][3] += 1; continue
    o = json.load(open(f))
    if (kind == "evm" or everything) and o["mint"] not in cache:
        counts[kind][3] += 1; continue                         # no chain read for a paused chain, nor in a bulk run: only what is cached
    if dry:
        counts[kind][0] += 1; continue
    path = F.export_one(o, cache)
    if not path:
        counts[kind][3] += 1; continue
    rec = json.load(open(path))
    counts[kind][0] += 1; counts[kind][1] += bool(rec.get("facts")); counts[kind][2] += bool(rec.get("links"))
print(f"{'DRY: would export' if dry else 'exported'} in {time.time() - t0:.0f} s | shown: {len(shown)} tokens, {len(scored)} scored")
for k, (n, fa, li, sk) in counts.items():
    print(f"  {k}: {n} feed files {'(no write)' if dry else 'rewritten'}, {fa} with facts, {li} with links, {sk} skipped (no saved result, or an uncached coin on a paused chain)")
