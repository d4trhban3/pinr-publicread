"""S1's proof by chain history: scanner/sqd_live.py's
PoolHistory run on every listed graduated (PumpSwap) Solana coin from pinr.io's own lists, into a temporary folder (nothing
written into the engine). Prints each coin's events found and the totals. Run from the engine folder:
  python3 tools/replay_pool_history.py [site, default https://pinr.io] [a copy of the server's index/quote_prices.json]"""
import collections, json, os, sys, tempfile, urllib.request
ENGINE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path[:0] = [os.path.join(ENGINE, p) for p in ("scanner", "stage2")]
import sqd, sqd_live as L

site = sys.argv[1] if sys.argv[1:] else "https://pinr.io"
if sys.argv[2:]:
    L.PRICES = sys.argv[2]                                     # the server's quote coins (index/quote_prices.json), copied

rows = []
for path in ("/api/tokens", "/api/tokens/rest"):
    d = json.load(urllib.request.urlopen(urllib.request.Request(site + path, headers={"User-Agent": "PINR-replay"}), timeout=20))
    rows += (d.get("tokens") or d.get("rest") or []) if isinstance(d, dict) else d
tmp = tempfile.mkdtemp()
log = L.PoolLog(os.path.join(tmp, "pools"))
idls = {sqd.PUMP: sqd.Idl(), sqd.PUMP_AMM: sqd.Idl(sqd.AMM_IDL_PATH), L.LAUNCHLAB: sqd.Idl(L.LL_IDL)}
h = L.PoolHistory(log, idls, rows=lambda: rows, state=os.path.join(tmp, "ph.json"))
cands = h.candidates()
per, failed = {}, []
for m in cands:
    got = h.one(m)
    if got is None:
        failed.append(m); continue
    log.flush()
    try:
        ev = json.load(open(os.path.join(tmp, "pools", m + ".json")))["events"]
    except Exception:
        ev = []
    per[m] = collections.Counter(e["kind"] for e in ev)
    print(m, dict(per[m]))
print(json.dumps({"listed_graduated": len(cands), "read": len(per), "failed": len(failed),
                  "with_pool_created": sum(1 for c in per.values() if c.get("pool created")),
                  "events": dict(sum(per.values(), collections.Counter()))}))
