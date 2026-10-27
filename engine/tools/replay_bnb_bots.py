"""Replay recorded BNB blocks through chains/bots.py (read-only): the launchpads' trade events with each sender, through the
engine's own SQD reader, into a throwaway in-memory store; then the real observe on every coin. Prints who would be
labelled and whether any labelled wallet is a shared event wallet (a router).
Usage, from the engine folder: python3 tools/replay_bnb_bots.py . <lo> <hi>  """
import sys, os, collections, json, sqlite3
E, LO, HI = sys.argv[1], int(sys.argv[2]), int(sys.argv[3])
sys.path.insert(0, os.path.join(E, "chains")); sys.path.insert(0, os.path.join(E, "scanner"))
import bnb, bots
bnb.head = lambda post=None: HI + bnb.SAFE_BEHIND            # read the recorded range only, never past HI
cur = {k: LO for k in bnb.TRADES}
sink = []
for _ in range(200):
    _last, cur, _began = bnb.trades_pass(cur, sink=sink)
    if all(v >= HI for v in cur.values()):
        break
rows = [x for x in sink if x[1] and x[2] and LO <= x[6] <= HI]
under = collections.defaultdict(set)
for m, s, w, side, t, tx, b in rows:
    under[w].add(s)
shared = {w for w, v in under.items() if len(v) >= 5}
c = sqlite3.connect(":memory:"); bots.ensure(c); bots.record(c, rows, max(r[4] for r in rows) + 1 if rows else None)
lab = []
for m in sorted({r[0] for r in rows}):
    o = bots.observe(c, m, None, None)
    if o:
        lab.append({"coin": m, "kinds": o["kind"], "wallets": sorted(o["wallets"]),
                    "via": sorted({v.get("via") for v in o["wallets"].values() if v.get("via")})})
named = sorted({w for x in lab for w in x["wallets"]})
print(json.dumps({"blocks": [LO, HI], "read_to": cur, "trades_with_sender": len(rows), "senders": len({r[1] for r in rows}),
                  "coins": len({r[0] for r in rows}), "coins_labelled": len(lab),
                  "labelled_wallets_that_are_shared_event_wallets": sorted(w for w in named if w in shared),
                  "router_0xd36b6d64_named": any(w.startswith("0xd36b6d64") for w in named),
                  "labels": lab}, indent=1))
