"""one hour of Pump.fun trades from SQD Portal, compared with the engine's own websocket ticks
(frontend-feed/ticks/<mint>.json) and Pump.fun's own trade list (swap-api, through stage2/pumpfun_api.py's budget).
Read-only; prints one JSON report.
  python3 tools/sqd_compare.py [coins, 12 when not given] [pumpfun_coins, 4 when not given]
Coins: those the websocket watched with the most ticks in the hour. SQD is read for the whole program (no account
filter: Pump.fun's newer instructions put the coin elsewhere) and the coins picked after decoding. Matching: with Pump.fun's
list by transaction signature; with the websocket by slot, since its ticks come from the curve account's changes and carry
the slot, not the transaction (one tick per slot)."""
from __future__ import annotations
import json, os, sys, time
HERE = os.path.dirname(os.path.abspath(__file__))
ENGINE = os.path.dirname(HERE)
sys.path[:0] = [os.path.join(ENGINE, "scanner"), os.path.join(ENGINE, "stage2")]
import sqd

TICKS = os.path.join(ENGINE, "frontend-feed", "ticks")


def ws_coins(now: float, n: int) -> dict:
    out = {}
    for f in os.listdir(TICKS):
        if not f.endswith(".json") or f.startswith("_"):
            continue
        try:
            d = json.load(open(os.path.join(TICKS, f)))
        except Exception:
            continue
        sigs = {int(t["slot"]) for t in d.get("ticks") or [] if isinstance(t.get("t"), (int, float)) and now - 3600 <= t["t"] / (1000 if t["t"] > 1e11 else 1) <= now - 120 and isinstance(t.get("slot"), int)}
        if sigs:
            out[d.get("mint") or f[:-5]] = sigs
    return dict(sorted(out.items(), key=lambda kv: -len(kv[1]))[:n])


def main(n=12, pf_n=4):
    now = time.time()
    ws = ws_coins(now, n)
    h = sqd.head()
    if h is None or not ws:
        print(json.dumps({"error": "no head" if h is None else "no websocket ticks in the hour"})); return 1
    frm, to = h - 9_400, h                     # more than an hour at about 0.4 s a block; cut by the blocks' own times below
    idl, amm, pools = sqd.Idl(), sqd.Idl(sqd.AMM_IDL_PATH), {}
    counts, got, slots, t0 = {}, {m: set() for m in ws}, {m: set() for m in ws}, time.time()
    blocks_read, unanswered = 0, None
    for b in sqd.blocks(frm, to):
        if "unanswered_from" in b:
            unanswered = b["unanswered_from"]; break
        blocks_read += 1
        for e in sqd.events(b, idl, counts, amm, pools):
            ts = e.get("time") or 0
            if e["kind"] == "trade" and now - 3600 <= ts <= now - 120 and e["fields"].get("mint") in got:
                got[e["fields"]["mint"]].add(e["sig"]); slots[e["fields"]["mint"]].add(int(e["block"]))
    took = round(time.time() - t0, 1)
    import pumpfun_api as PF
    pf = {}
    for m in list(ws)[:pf_n]:
        got_pf = PF.trades(m, int(now - 3600), int(now - 120))
        rows, complete = got_pf if isinstance(got_pf, tuple) else (got_pf, None)
        pf[m] = None if rows is None or complete is False else {r.get("tx") for r in rows if isinstance(r, dict)}   # a partial list is not compared
    per = []
    for m in ws:
        s, sl, w, p = got[m], slots[m], ws[m], pf.get(m)
        row = {"coin": m[:6] + "..", "sqd": len(s), "sqd_slots": len(sl), "websocket_slots": len(w), "both_slots": len(sl & w),
               "sqd_only_slots": len(sl - w), "websocket_only_slots": len(w - sl)}
        if m in pf:
            row.update({"pumpfun": None if p is None else len(p), "sqd_and_pumpfun": None if p is None else len(s & p),
                        "pumpfun_only": None if p is None else len(p - s)})
        per.append(row)
    tot = lambda k: sum(r[k] for r in per if isinstance(r.get(k), int))
    print(json.dumps({"window": "the last hour, less 2 minutes", "coins": len(per), "sqd_blocks_read": blocks_read, "sqd_seconds": took,
                      "sqd_unanswered_from": unanswered, "decoded": counts,
                      "totals": {k: tot(k) for k in ("sqd", "sqd_slots", "websocket_slots", "both_slots", "sqd_only_slots", "websocket_only_slots", "pumpfun", "sqd_and_pumpfun", "pumpfun_only")},
                      "per_coin": per}, indent=1))
    return 0


if __name__ == "__main__":
    a = [int(x) for x in sys.argv[1:3]]
    raise SystemExit(main(*a))
