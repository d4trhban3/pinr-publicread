"""The proof for chains/live_evm.py by chain history (the operator, 26 Oct: builds are proved by replaying history, never by
waiting on live data). For a past range of blocks it reads the trades twice and compares them trade by trade:
  - the live reader's way: its own Portal query (every block, from a block on, asked again from the next block after each
    answer) and its own decoding (chains/live_evm.py bnb_ticks / base_ticks, every coin);
  - the chains pass's way: chains/bnb.py's range read and decoder (BNB), chains/ticks_base.py's pool read (Base);
and, for a part of the range, a public node's eth_getLogs (an outside source, not SQD).
Read-only; writes nothing into the engine. Run from the engine folder:
  python3 tools/replay_live_evm.py bsc|base [blocks] [pool ids file, Base]"""
from __future__ import annotations
import json, os, sys, time, urllib.request

ENGINE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path[:0] = [os.path.join(ENGINE, p) for p in ("chains", "scanner", "stage2", "stage3", "stage4")]
import live_evm as L
import bnb as B
import sqd_evm as S
import ticks_base as TB

PUBLIC = {"bsc": "https://bsc-rpc.publicnode.com", "base": "https://base-rpc.publicnode.com"}


def live_way(chain, lo, hi, pools):
    """The live reader's own query, asked from a block and again from the next after each answer, to hi."""
    out, nxt, asked = [], lo, 0
    while nxt <= hi:
        q = L.query(chain, nxt, pools); q["toBlock"] = hi
        t = S._post(S.PORTAL + S.DATASET[chain] + "/stream", q)
        asked += 1
        if t is None:
            raise SystemExit(f"the Portal did not answer from block {nxt}")
        blocks = [json.loads(x) for x in t.splitlines() if x.strip()]
        if not blocks:
            raise SystemExit(f"an empty answer from block {nxt}")
        for b in blocks:
            out += S.block_logs(b)
        nxt = blocks[-1]["header"]["number"] + 1
    return out, asked


def public_logs(chain, address, topics0, lo, hi, topic1s=None):
    out = []
    for a in range(lo, hi + 1, 500):
        flt = {"address": address, "fromBlock": hex(a), "toBlock": hex(min(hi, a + 499)), "topics": [topics0] + ([topic1s] if topic1s else [])}
        body = {"jsonrpc": "2.0", "id": 1, "method": "eth_getLogs", "params": [flt]}
        r = json.load(urllib.request.urlopen(urllib.request.Request(PUBLIC[chain], json.dumps(body).encode(),
                                                                    {"content-type": "application/json", "User-Agent": S.UA["User-Agent"]}), timeout=60))
        if "result" not in r:
            raise SystemExit(f"the public node refused {a}..: {r.get('error')}")
        out += r["result"]
        time.sleep(0.3)
    return out


def bnb_trades(logs):
    raw = []
    for kind in B.TRADES:
        B.decode_trades(kind, logs, B._post, {}, {}, None, raw)
    return {(r[4], r[5]): r for r in raw}


def base_trades(logs, pools):
    out = {}
    for l in logs:
        if l["topics"][0] != TB.SWAP or str(l["topics"][1]).lower() not in pools:
            continue
        out[(l["transactionHash"], int(l["logIndex"], 16) if isinstance(l["logIndex"], str) else l["logIndex"])] = (str(l["topics"][1]).lower(), l["data"])
    return out


def main(chain, n, pools_file=None):
    h = S.head(chain)
    hi, lo = h - 20, h - 20 - n
    pools = None
    if chain == "base":
        pools = sorted({p.strip().lower() for p in open(pools_file) if p.strip().startswith("0x")})
    t0 = time.time()
    live, asked = live_way(chain, lo, hi, pools)
    t_live = time.time() - t0
    if chain == "bsc":
        pass_logs = []
        for kind, (address, t) in B.TRADES.items():
            got = S.logs("bsc", address, t, lo, hi)
            if got is None:
                raise SystemExit("the chains pass's read did not answer")
            pass_logs += got
        a, b = bnb_trades(live), bnb_trades(pass_logs)
        sub_lo = hi - 1500
        pub = []
        for address, t in B.TRADES.values():
            pub += [dict(l, blockTimestamp=None) for l in public_logs("bsc", address, t, sub_lo, hi)]
        c = {k: v for k, v in bnb_trades([l for l in live if int(l["blockNumber"], 16) >= sub_lo]).items()}
        p = {k: v for k, v in _bnb_public(pub).items()}
        same_pub = set(c) == set(p) and all(c[k][1:3] + c[k][4:] == p[k][1:3] + p[k][4:] for k in c)
    else:
        pass_logs = S.logs("base", TB.POOL_MANAGER, [TB.SWAP], lo, hi, topic1s=pools)
        if pass_logs is None:
            raise SystemExit("the chains pass's read did not answer")
        a, b = base_trades(live, set(pools)), base_trades(pass_logs, set(pools))
        sub_lo = hi - 1500
        pub = public_logs("base", TB.POOL_MANAGER, [TB.SWAP], sub_lo, hi, pools)
        c = {k: v for k, v in a.items() if k in {(l["transactionHash"], int(l["logIndex"], 16)) for l in live if int(l["blockNumber"], 16) >= sub_lo}}
        p = base_trades(pub, set(pools))
        same_pub = c == p
    same = a == b
    print(json.dumps({"chain": chain, "blocks": [lo, hi], "live_requests": asked, "live_read_s": round(t_live, 1),
                      "trades_live_way": len(a), "trades_chains_pass": len(b), "same_trade_for_trade": same,
                      "only_live": len(set(a) - set(b)), "only_pass": len(set(b) - set(a)),
                      "public_node_part": [sub_lo, hi], "trades_there": len(c), "public_node_trades": len(p), "same_as_public_node": same_pub}))
    return same and same_pub


def _bnb_public(logs):
    """The public node gives no block time in its logs (Four.meme's decoder then asks the node for it): compare without the
    time, which the Portal's answer carries."""
    raw = []
    times = {}
    for kind in B.TRADES:
        for l in logs:
            l.setdefault("blockTimestamp", None)
        B.decode_trades(kind, [dict(l, blockTimestamp="0x1") for l in logs], B._post, times, {}, None, raw)
    return {(r[4], r[5]): r for r in raw}


if __name__ == "__main__":
    ch = sys.argv[1] if sys.argv[1:] else "bsc"
    n = int(sys.argv[2]) if sys.argv[2:] else (8000 if ch == "bsc" else 1800)
    ok = main(ch, n, sys.argv[3] if sys.argv[3:] else None)
    raise SystemExit(0 if ok else 1)
