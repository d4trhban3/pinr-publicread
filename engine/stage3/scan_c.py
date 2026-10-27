"""Scan C: clean dev-sell timing study on OLDER Pump.fun launches (Stage 3, step 3).

Written rule, fixed before drawing (nothing about price, outcome or names is looked at when choosing):
- Seed "PINR-SCANC-2026-10-04". For each draw: pick a random slot between 30 and 7 days before the run;
  take the first transaction in that block; read the Pump.fun program's transactions just before it;
  keep the token-creation (CREATE) ones; pick one at random. Repeat until N launches are collected.
- For each launch: the dev = the wallet that paid for the CREATE. Dev conduct is read from the dev's own
  token account for that mint (every buy, sell or transfer of that token by the dev), and outcome from
  the token's bonding-curve state today.
Output: scan_c_results.json with receipts, and a plain summary.
"""
from __future__ import annotations
import base64, json, os, random, sys, time, urllib.error, urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "stage2"))
from solana_rpc import rpc
from b58 import b58d, b58e, pda
from readers import read_pump_curve, Log, PUMP
from dev_history import Helius, conduct_from_balances as conduct

SEED = "PINR-SCANC-2026-10-04"
ATA_PROGRAM = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL"
SLOTS_PER_DAY = 216_000            # ~0.4 s per slot


import threading as _th
_PARSE_SLOTS = _th.BoundedSemaphore(6)        # at most 6 parse requests in flight across the whole run


def parse(h: Helius, sigs: list[str]):
    """Parsed transactions in input order from the chain's standard methods (`fetch_txs`, the same
    fields). QUALITY GUARD: every requested signature must come back, or None (the caller marks the
    reading unreadable), never a silently shorter list."""
    from solana_rpc import fetch_txs
    return fetch_txs(list(sigs))


def draw_launch(h: Helius, rng: random.Random, now_slot: int, pump_sigs_per_draw: int = 200):
    for _ in range(40):
        slot = rng.randint(now_slot - 30 * SLOTS_PER_DAY, now_slot - 7 * SLOTS_PER_DAY)
        b = rpc("getBlock", [slot, {"transactionDetails": "signatures", "rewards": False,
                                    "maxSupportedTransactionVersion": 1}])
        if not isinstance(b, dict) or "ERROR" in b or not b.get("signatures"):
            continue
        anchor = b["signatures"][0]
        sigs = rpc("getSignaturesForAddress", [PUMP, {"before": anchor, "limit": pump_sigs_per_draw}])
        if not isinstance(sigs, list):
            continue
        txs = parse(h, [s["signature"] for s in sigs if not s.get("err")])
        if txs is None:
            continue
        creates = [t for t in txs if t.get("type") == "CREATE" and t.get("source") == "PUMP_FUN"]
        if not creates:
            continue
        t = rng.choice(sorted(creates, key=lambda x: x["signature"]))
        mints = sorted({x["mint"] for x in t.get("tokenTransfers") or [] if x.get("mint", "").endswith("pump")}
                       or {x["mint"] for x in t.get("tokenTransfers") or [] if x.get("mint")})
        if not mints:
            continue
        return {"slot_drawn": slot, "anchor": anchor, "create_signature": t["signature"],
                "mint": mints[0], "dev": t["feePayer"], "launch_timestamp": t["timestamp"]}
    return None


def dev_token_account(dev: str, mint: str) -> str | None:
    v = rpc("getAccountInfo", [mint, {"encoding": "base64"}])
    if not isinstance(v, dict) or not v.get("value"):
        return None
    prog = v["value"]["owner"]
    return pda([b58d(dev), b58d(prog), b58d(mint)], ATA_PROGRAM)


def study(n: int, out_path: str):
    h = Helius()
    rng = random.Random(SEED)
    now_slot = rpc("getSlot", [])
    rows = []
    while len(rows) < n:
        d = draw_launch(h, rng, now_slot)
        if d is None:
            break
        ata = dev_token_account(d["dev"], d["mint"])
        sigs = rpc("getSignaturesForAddress", [ata, {"limit": 1000}]) if ata else []
        txs = parse(h, [s["signature"] for s in sigs if not s.get("err")]) if isinstance(sigs, list) else None
        if txs is None:
            print(f"skipped {d['mint'][:8]}: dev history unreadable", flush=True)
            continue
        c = conduct(txs, d["dev"], d["mint"], d["launch_timestamp"])
        week = sum(m["amount"] for m in c["moves"] if m["dir"] == "out" and m["t"] <= d["launch_timestamp"] + 7 * 86400)
        curve = read_pump_curve(d["mint"], Log())
        rows.append({**d, "dev_token_account": ata, "dev_txs_on_token": len(txs),
                     "never_bought": c["never_bought"], "acquired": c["acquired"],
                     "pct_out_5m": c["pct_out_5m"], "pct_out_1h": c["pct_out_1h"], "pct_out_24h": c["pct_out_24h"],
                     "pct_out_7d": None if not c["acquired"] else min(1.0, week / c["acquired"]),
                     "graduated": None if curve is None else curve["complete"],
                     "mayhem": None if curve is None else curve["mayhem"],
                     "real_sol_on_curve_now": None if curve is None or curve["complete"] else curve["real_quote"] / 1e9,
                     "moves": [{k: m[k] for k in ("t", "dir", "amount", "kind", "signature")} for m in c["moves"]]})
        print(f"{len(rows)}/{n} {d['mint'][:8]} dev {d['dev'][:8]} out 5m/1h/24h: "
              f"{rows[-1]['pct_out_5m']} {rows[-1]['pct_out_1h']} {rows[-1]['pct_out_24h']} graduated {rows[-1]['graduated']} | Helius calls so far {h.calls}",
              flush=True)
    json.dump({"seed": SEED, "rule": __doc__, "run_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
               "now_slot": now_slot, "helius_calls": h.calls, "launches": rows}, open(out_path, "w"), indent=1)
    return rows, h.calls


if __name__ == "__main__":
    n = int(sys.argv[1]) if len(sys.argv) > 1 else 5
    rows, calls = study(n, os.path.join(HERE, f"scan_c_{n}.json"))
    print(f"done: {len(rows)} launches, {calls} Helius calls")
