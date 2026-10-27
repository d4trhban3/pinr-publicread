"""S3/S4's proof by chain history: scanner/sqd_live.py's TickHistory run as the service runs it
(rounds until its 24-hour scan ends) on the listed Solana coins that had no tick file (a JSON list of their addresses, read
on the server), into memory (nothing written into the engine). Then, for some Pump.fun curve coins it found trades for, the
same window from an outside record: Solana's public node's list of the coin's bonding-curve transactions (every curve trade
touches it), transaction by transaction. Run from the engine folder:
  python3 tools/replay_tick_history.py <coins.json> [coins to compare, default 10]"""
import json, os, queue, sys, time, urllib.request
ENGINE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path[:0] = [os.path.join(ENGINE, p) for p in ("scanner", "stage2")]
import sqd, sqd_live as L
from b58 import b58d, pda

coins = json.load(open(sys.argv[1]))
k = int(sys.argv[2]) if sys.argv[2:] else 10
idls = {sqd.PUMP: sqd.Idl(), sqd.PUMP_AMM: sqd.Idl(sqd.AMM_IDL_PATH), L.LAUNCHLAB: sqd.Idl(L.LL_IDL)}
q = queue.Queue()
import tempfile
th = L.TickHistory(idls, q, listed=lambda: set(coins), has_file=lambda m: False, state=os.path.join(tempfile.mkdtemp(), "th.json"))
t0, rounds, n = time.time(), 0, None
th_to = None
while n is None and rounds < 60:
    n = th.round(limit=len(coins)); rounds += 1
    th_to = th_to or (th.scan or {}).get("to")
    if n is None:
        time.sleep(L.TICK_HISTORY_EVERY_S)
got = {}
while not q.empty():
    m, t = q.get()
    got.setdefault(m, []).append(t)
print(json.dumps({"coins": len(coins), "scan_finished": n is not None, "rounds": rounds, "ticks": n, "coins_with_trades": len(got),
                  "minutes": round((time.time() - t0) / 60, 1)}))


def rpc(method, params):
    body = json.dumps({"jsonrpc": "2.0", "id": 1, "method": method, "params": params}).encode()
    return json.load(urllib.request.urlopen(urllib.request.Request(L.PUBLIC_RPC, body, {"content-type": "application/json"}), timeout=30)).get("result")


same = checked = 0
for m in [m for m in sorted(got, key=lambda m: len(got[m])) if all(x.get("sol") is not None for x in got[m])][:k]:
    ts = got[m]
    lo = min(x["t"] for x in ts) // 1000
    curve = pda([b"bonding-curve", b58d(m)], sqd.PUMP)
    sigs = rpc("getSignaturesForAddress", [curve, {"limit": 1000}]) or []
    window = {s["signature"] for s in sigs if s.get("err") is None and (s.get("blockTime") or 0) >= lo and s.get("slot", 0) <= th_to}
    a = {x["sig"] for x in ts}
    checked += 1; same += a == window
    print(m, f"SQD {len(ts)} trades in {len(a)} tx; the node's curve transactions in the window {len(window)}; same: {a == window}",
          "" if a == window else f"only SQD {len(a - window)}, only the node {len(window - a)}")
    time.sleep(0.5)
print(json.dumps({"compared": checked, "same": same}))
