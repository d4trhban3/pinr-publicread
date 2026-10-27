"""USD price of a BNB-chain quote coin read from its own PancakeSwap pool.

Used for launchpad tokens that trade against something other than BNB (tokenized stocks, BTCB, USDT, ...).
- One anchor: Chainlink BNB/USD on chain. USDT is priced from its deepest USDT/WBNB pool; every other coin from its
  deepest PancakeSwap v2 or v3 pool against WBNB or USDT. No peg is assumed (BTCB and USDT are measured too).
- Depth = the BNB/USDT side's balance held by the pool, in USD. A pool under MIN_DEPTH_USD is not used: a thin pool can be
  moved by one small trade. No pool deep enough -> the price stays missing.
- Prices are read at the same block as the rest of the token's reads (evm.pin), and remembered 10 minutes per process.
"""
from __future__ import annotations
import time
from evm import call, selector, enc_address, enc_uint, words, multicall, native_usd

PCS_V2_FACTORY = "0xca143ce32fe78f1f7019d7d551a6402fc5350c73"
PCS_V3_FACTORY = "0x0bfbcf9fa4f9c56b0f40a671ad40e0805a091865"
WBNB = "0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c"
USDT = "0x55d398326f99059ff775485246999027b3197955"
V3_FEES = (100, 500, 2500, 10000)
MIN_DEPTH_USD = 50_000.0
_TTL = 600
_CACHE: dict = {}


def _addr(r):
    return None if not r or int(r, 16) == 0 else "0x" + r[-40:].lower()


def _decimals(tok):
    r = call("bsc", tok, "0x" + selector("decimals()"))
    return int(r, 16) if r else None


def _pools(tok, other):
    """Every PancakeSwap v2 pair and v3 pool of (tok, other), checked to belong to the factory and hold both coins."""
    calls = [(PCS_V2_FACTORY, "0x" + selector("getPair(address,address)") + enc_address(tok) + enc_address(other))]
    calls += [(PCS_V3_FACTORY, "0x" + selector("getPool(address,address,uint24)") + enc_address(tok) + enc_address(other) + enc_uint(f))
              for f in V3_FEES]
    out = []
    for i, r in enumerate(multicall("bsc", calls)):
        a = _addr(r)
        if a:
            out.append(("v2" if i == 0 else f"v3/{V3_FEES[i - 1]}", a))
    return out


def _price_from(kind, rows, tok, other, dec_tok, dec_other):
    """(other per whole tok, other held by the pool in whole units) from one pool's batched reads, or None."""
    t0, t1, held, st = _addr(rows[0]), _addr(rows[1]), rows[2], rows[3]
    if {t0, t1} != {tok, other} or not held or not st:
        return None
    held = int(held, 16) / 10 ** dec_other
    w = words(st)
    if kind == "v2":
        r0, r1 = int(w[0], 16), int(w[1], 16)
        if not r0 or not r1:
            return None
        raw = r1 / r0 if t0 == tok else r0 / r1                      # raw other per raw tok
    else:
        sp = int(w[0], 16)
        if not sp:
            return None
        p10 = (sp / 2 ** 96) ** 2                                    # raw token1 per raw token0
        raw = p10 if t0 == tok else 1 / p10
    return raw * 10 ** dec_tok / 10 ** dec_other, held


def _best(tok, others):
    """Deepest qualifying pool of tok against the given {coin: (usd price, decimals)}. All pool reads in one batch."""
    dec_tok = _decimals(tok)
    if dec_tok is None:
        return None, "quote coin decimals unreadable"
    found = [(other, kind, pool) for other in others for kind, pool in _pools(tok, other)]
    calls = []
    for other, kind, pool in found:
        calls += [(pool, "0x" + selector("token0()")), (pool, "0x" + selector("token1()")),
                  (other, "0x" + selector("balanceOf(address)") + enc_address(pool)),
                  (pool, "0x" + selector("getReserves()" if kind == "v2" else "slot0()"))]
    res = multicall("bsc", calls) if calls else []
    best, seen = None, []
    for i, (other, kind, pool) in enumerate(found):
        usd_other, dec_other = others[other]
        got = _price_from(kind, res[4 * i:4 * i + 4], tok, other, dec_tok, dec_other)
        if not got:
            continue
        px, held = got
        depth = held * usd_other
        seen.append(round(depth))
        if depth >= MIN_DEPTH_USD and (best is None or depth > best[0]):
            name = "WBNB" if other == WBNB else "USDT"
            best = (depth, px * usd_other, f"PancakeSwap {kind} pool {pool} vs {name} (${depth:,.0f} of {name} held)")
    if best is None:
        return None, f"no PancakeSwap pool with at least ${MIN_DEPTH_USD:,.0f} on the BNB/USDT side (deepest seen: ${max(seen, default=0):,})"
    return best[1], best[2]


def quote_usd(token: str):
    """(USD per whole token, receipt) or (None, why)."""
    token = token.lower()
    hit = _CACHE.get(token)
    if hit and time.time() - hit[2] < _TTL:
        return hit[0], hit[1]
    bnb, why = native_usd("bsc")
    if bnb is None:
        return None, f"BNB/USD unavailable ({why})"
    if token == WBNB:
        val = (bnb, why)
    elif token == USDT:
        p, src = _best(USDT, {WBNB: (bnb, 18)})
        val = (p, src if p is None else f"{src}; BNB at ${bnb:,.2f} ({why})")
    else:
        usdt, usrc = quote_usd(USDT)
        others = {WBNB: (bnb, 18)}
        if usdt is not None:
            others[USDT] = (usdt, 18)
        p, src = _best(token, others)
        val = (p, src if p is None else f"{src}; BNB at ${bnb:,.2f}" + (f"; USDT at ${usdt:.4f}" if usdt else ""))
    if val[0] is not None:
        _CACHE[token] = (val[0], val[1], time.time())
    return val
