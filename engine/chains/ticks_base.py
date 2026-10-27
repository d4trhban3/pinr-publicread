"""Line 11, Base: a listed Base coin's own trades as its tick file
(`frontend-feed/ticks/<0x address>.json`, contract "ticks-1", source "Base chain"), the shape SITE's reader takes.

Every listed Base coin trades in a Uniswap v4 pool (Clanker's and Zora's both): its PoolManager Swap events, read through
SQD Portal filtered to the listed coins' own pool ids (never all of Base's swaps). A trade's price is its own amounts (the
WETH it moved over the tokens it moved; never the pool's price after it, which a tiny swap in a near-empty pool can push to
the edge of its range), its size the WETH it moved; both in dollars at the paired coin's price: WETH at
Chainlink's ETH/USD feed on Base, named on each trade. A coin paired with anything else (3 of 6 listed on 26 Oct: Zora coins
paired with their creator's coin) gets no dollar figure, never guessed: its trades are left out for now. The pool's two
coins come from its own Initialize event (read once, kept). Each pool is read from its creation block on, then onward from
where it was read to; a busy or refused read is tried again next pass, nothing skipped."""
from __future__ import annotations
import json, math, os, time

from evm import topic

SOURCE = "Base chain"
WETH = "0x4200000000000000000000000000000000000006"
USDC = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913"      # Circle's USDC on Base
QUOTES = {WETH: ("WETH", 18), USDC: ("USDC", 6)}       # the paired coins a trade is priced in (symbol, decimals), each at its
                                                       # Chainlink feed on Base; any other pair is left out, never guessed
SWAP = topic("Swap(bytes32,address,int128,int128,uint160,uint128,int24,uint24)")
INIT = topic("Initialize(bytes32,address,address,uint24,int24,address,uint160,int24)")
POOL_MANAGER = "0x498581ff718922c3f8e6a244956af099b2652b2b"
CALLS = 4                                # SQD answers a pass at most
NEW_POOLS = 10                           # new pools' Initialize reads a pass at most (26 Oct: a first pass over 618 held the market thread ~15 min)
PRICE_EVERY = 60
_STATE: dict = {}


def _int(word: str, bits: int) -> int:
    v = int(word, 16) & ((1 << bits) - 1)                       # the low `bits` of the 32-byte word, signed
    return v - (1 << bits) if v >> (bits - 1) else v


def tick(token_is0: bool, data: str, t: float, tx: str, i: int, eth_usd: float, eth_src: str, q_sym: str = "WETH", q_dec: int = 18) -> dict | None:
    """One Swap as a ticks-1 trade, priced in its paired coin (WETH, or USDC with its 6 decimals; `eth_usd` is that coin's
    dollar price); None when it moved no tokens or none of the paired coin, or the paired coin has no price."""
    w = [data[2 + k * 64: 2 + (k + 1) * 64] for k in range((len(data) - 2) // 64)]
    if len(w) < 3 or not (isinstance(eth_usd, (int, float)) and eth_usd > 0 and t):
        return None
    d0, d1, sqrt = _int(w[0], 128), _int(w[1], 128), int(w[2], 16)
    tok, weth = (d0, d1) if token_is0 else (d1, d0)            # the caller's deltas: positive = received
    if tok == 0 or weth == 0 or sqrt == 0:
        return None
    eth = abs(weth) / 10 ** q_dec                              # the paired coin's own decimals; the launchpads' coins have 18
    price_eth = abs(weth) / abs(tok) * 10 ** (18 - q_dec)      # the trade's own price: the paired coin it moved over the tokens
    # (the team, 26 Oct: a $0.0018 swap in a near-empty pool left the pool's price after it at the edge of its range,
    # $7.83e41 a token; a trade's own amounts cannot do that.)
    if not (math.isfinite(price_eth) and price_eth > 0 and math.isfinite(price_eth * eth_usd)):
        return None                                            # never a price that is not a number: the trade is left out
    return {"t": int(t * 1000), "side": "buy" if tok > 0 else "sell", "sig": tx, "i": int(i), "price_usd": price_eth * eth_usd,
            "usd": eth * eth_usd, "quote_amount": eth, "price_quote": price_eth,
            "price_usd_src": f"the trade's own {q_sym} over its tokens, at {eth_src}"}


def _eth_usd(now: float, fn=None, sym: str = "WETH"):
    """(dollars, source) of a paired coin from its Chainlink feed on Base, read at most every PRICE_EVERY; (None, why) unread."""
    got = _STATE.get(sym)
    if not got or now - got[2] >= PRICE_EVERY:
        if fn is None:
            from evm import native_usd, asset_usd
            fn = (lambda: native_usd("base")) if sym == "WETH" else (lambda: asset_usd(sym))
        p, why = fn()
        got = (p, why, now) if p else (got or (None, why, now))
        _STATE[sym] = got
    return got[0], got[1]


def ensure(c) -> None:
    c.execute("CREATE TABLE IF NOT EXISTS base_pools (mint TEXT PRIMARY KEY, pool TEXT, paired TEXT, block INTEGER, read_to INTEGER)")


def one_pass(c, g, now: float, feed_dir: str, listed: list, logs_fn=None, head_fn=None, eth_fn=None) -> int:
    """listed: [(mint, launch block)] of the listed Base coins. Network first (each new pool's coins, the swaps, ETH's price),
    then the files and short writes. Ticks written."""
    import sqd_evm as S, ticks_evm as TE
    logs_fn = logs_fn or (lambda lo, hi, topics0, topics1: S.logs("base", POOL_MANAGER, topics0, lo, hi, topic1s=topics1))
    head_fn = head_fn or (lambda: S.head("base"))
    ensure(c)
    files = _STATE.get("files")
    if files is None or files.dir != os.path.join(feed_dir, "ticks"):
        files = _STATE["files"] = TE.TickFiles(os.path.join(feed_dir, "ticks"), source=SOURCE)
    known = {m: (p, q, b, r) for m, p, q, b, r in c.execute("SELECT mint, pool, paired, block, read_to FROM base_pools")}
    new = []
    for m, blk in listed:                                      # a new pool's id (the evidence) and its two coins (Initialize)
        if m in known or not blk:
            continue
        if len(new) >= NEW_POOLS:
            break
        r = g.execute("SELECT to_id FROM evidence WHERE coin=? AND what='trades in pool (Uniswap v4)'", (m,)).fetchone()
        if not r:
            continue
        got = logs_fn(blk - 5, blk + 5, [INIT], [r[0]])
        if got is None:
            continue
        hit = next((l for l in got if str(l["topics"][1]).lower() == r[0].lower()), None)
        if hit:
            c0, c1 = "0x" + hit["topics"][2][-40:], "0x" + hit["topics"][3][-40:]
            new.append((m, r[0].lower(), (c1 if c0.lower() == m else c0).lower(), blk))
    for m, p, q, b in new:
        known[m] = (p, q, b, None)
    on = {m for m, _b in listed}
    weth = {m: v for m, v in known.items() if m in on and v[1] in QUOTES}      # pools paired with a coin priced on Base
    added = 0
    pools = {v[0]: m for m, v in weth.items()}
    if weth:
        lo = min((v[3] if v[3] is not None else v[2] - 1) for v in weth.values()) + 1
        hi = head_fn()
        got, reached = [], None
        if hi and lo <= hi:
            got = logs_fn(lo, min(hi, lo + 50_000 * CALLS), [SWAP], sorted(pools))
            if got is not None:
                reached = min(hi, lo + 50_000 * CALLS)
        fn_for = lambda sym: eth_fn.get(sym) if isinstance(eth_fn, dict) else (eth_fn if sym == "WETH" else None)   # tests: stand-ins
        price = {q: _eth_usd(now, fn_for(QUOTES[q][0]), QUOTES[q][0]) for q in {v[1] for v in weth.values()}}
        for l in got or []:
            m = pools.get(str(l["topics"][1]).lower())
            if not m:
                continue
            read_to = weth[m][3]
            b = int(l["blockNumber"], 16)
            if read_to is not None and b <= read_to:
                continue
            ts = l.get("blockTimestamp")
            q = weth[m][1]
            usd, src = price[q]
            x = tick(int(m, 16) < int(q, 16), l["data"], float(int(ts, 16)) if isinstance(ts, str) else None,
                     l.get("transactionHash"), int(l.get("logIndex") or "0x0", 16), usd, src or "", *QUOTES[q])
            if x and files.add(m, x):
                files.quote[m] = QUOTES[q][0]; added += 1
        files.flush(now)
        if reached is not None and all(p[0] for p in price.values()):   # the team's note on a32a466a: a paired coin unpriced: read again
            for m in weth:
                known[m] = known[m][:3] + (reached,)
    for m, p, q, b in new:
        c.execute("INSERT OR REPLACE INTO base_pools VALUES (?,?,?,?,NULL)", (m, p, q, b))
    for m in weth:
        if known[m][3] is not None:
            c.execute("UPDATE base_pools SET read_to=? WHERE mint=?", (known[m][3], m))
    c.commit()
    return added
