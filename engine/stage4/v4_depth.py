"""Uniswap v4 concentrated-liquidity depth (Stage 4). Pure math first (tested offline), then readers.

In a concentrated pool, liquidity L sits in price ranges between initialized ticks. Walking the ticks from the bottom
and adding each tick's liquidityNet rebuilds L per range. For a range [a, b] (sqrt prices sa < sb) and current sqrt
price s:
    range below the price (b <= current): holds only token1: L * (sb - sa)
    range above the price (a >  current): holds only token0: L * (1/sa - 1/sb)
    range containing the price:           token0 = L * (1/s - 1/sb), token1 = L * (s - sa)
"Real money" = the quote token's total across all ranges. CHECK: the rebuilt L for the current range must equal the
pool's own reported liquidity exactly, or the reading is refused (unknown).
"""
from __future__ import annotations
from decimal import Decimal, getcontext
from typing import Optional

getcontext().prec = 80
Q96 = Decimal(2) ** 96
MIN_TICK, MAX_TICK = -887272, 887272


def sqrt_at_tick(t: int) -> Decimal:
    return Decimal("1.0001") ** (Decimal(t) / 2)


def rebuild(ticks: list[tuple[int, int]]) -> list[tuple[int, int, int]]:
    """ticks: [(tick, liquidityNet)] for initialized ticks. Returns ranges [(lower, upper, L)] with L > 0."""
    out, L = [], 0
    ts = sorted(ticks)
    for (t, net), nxt in zip(ts, ts[1:] + [(None, 0)]):
        L += net
        if nxt[0] is not None and L > 0:
            out.append((t, nxt[0], L))
    return out


def liquidity_at(ranges: list[tuple[int, int, int]], tick: int) -> int:
    return sum(L for lo, hi, L in ranges if lo <= tick < hi)


def amounts(ranges, sqrt_price_x96: int, tick: int):
    """(token0, token1) raw amounts held by all ranges."""
    s = Decimal(sqrt_price_x96) / Q96
    a0 = a1 = Decimal(0)
    for lo, hi, L in ranges:
        sa, sb, L = sqrt_at_tick(lo), sqrt_at_tick(hi), Decimal(L)
        if hi <= tick:
            a1 += L * (sb - sa)
        elif lo > tick:
            a0 += L * (1 / sa - 1 / sb)
        else:
            a0 += L * (1 / s - 1 / sb)
            a1 += L * (s - sa)
    return a0, a1


def price1_per_0(sqrt_price_x96: int) -> Decimal:
    return (Decimal(sqrt_price_x96) / Q96) ** 2


# ------------------------------------------------------------------ chain readers (Base, Uniswap v4 StateView)
import os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from evm import rpc, call, selector, words, dec, topic, logs, multicall
import solana_rpc as _S

STATEVIEW = {"base": "0xa3c0c9b65bad0b08107aa264b0f3db444b867a71"}
POOLMANAGER = {"base": "0x498581fF718922c3f8e6A244956aF099B2652b2b"}
INITIALIZE = topic("Initialize(bytes32,address,address,uint24,int24,address,uint160,int24)")


def _int24(word: str) -> int:
    v = int(word, 16) & ((1 << 24) - 1)
    return v - (1 << 24) if v >> 23 else v


def _enc_int(n: int, bits: int = 256) -> str:
    return hex(n % (1 << 256))[2:].rjust(64, "0")


def pool_key(chain: str, pool_id: str, around_block: int, window: int = 50):
    """currency0, currency1, fee, tickSpacing, hooks from the PoolManager Initialize event near the creation block."""
    lg, ok = logs(chain, POOLMANAGER[chain], INITIALIZE, around_block - window, around_block + window)
    for l in lg:
        if l["topics"][1].lower() == pool_id.lower():
            w = words(l["data"])
            return {"currency0": "0x" + l["topics"][2][-40:], "currency1": "0x" + l["topics"][3][-40:],
                    "fee": int(w[0], 16), "tickSpacing": _int24(w[1]), "hooks": "0x" + w[2][-40:]}
    return None


def read_pool(chain: str, pool_id: str, tick_spacing: int, block: str = "latest"):
    sv = STATEVIEW[chain]
    pid = pool_id[2:] if pool_id.startswith("0x") else pool_id
    s0 = call(chain, sv, "0x" + selector("getSlot0(bytes32)") + pid, block)
    lq = call(chain, sv, "0x" + selector("getLiquidity(bytes32)") + pid, block)
    if not s0 or not lq:
        return None
    w = words(s0)
    sqrtp, tick = int(w[0], 16), _int24(w[1])
    pool_L = int(words(lq)[0], 16)
    lo_w = (MIN_TICK // tick_spacing) >> 8
    hi_w = (MAX_TICK // tick_spacing) >> 8
    wps = list(range(lo_w, hi_w + 1))
    bitmaps = multicall(chain, [(sv, "0x" + selector("getTickBitmap(bytes32,int16)") + pid + _enc_int(wp)) for wp in wps], block)
    if any(b is None for b in bitmaps):
        return None
    inited = []
    for wp, bm in zip(wps, bitmaps):
        v = int(bm, 16)
        bit = 0
        while v:
            if v & 1:
                inited.append((wp * 256 + bit) * tick_spacing)
            v >>= 1; bit += 1
    infos = multicall(chain, [(sv, "0x" + selector("getTickLiquidity(bytes32,int24)") + pid + _enc_int(t)) for t in inited], block)
    if any(i is None for i in infos):
        return None
    ticks = []
    for t, info in zip(inited, infos):
        ww = words(info)
        net = int(ww[1], 16)
        net = net - (1 << 256) if net >> 255 else net
        ticks.append((t, net))
    ranges = rebuild(ticks)
    rebuilt_L = liquidity_at(ranges, tick)
    return {"sqrtPriceX96": sqrtp, "tick": tick, "pool_liquidity": pool_L, "rebuilt_liquidity": rebuilt_L,
            "liquidity_check": rebuilt_L == pool_L, "ranges": ranges, "initialized_ticks": len(ticks)}


# ------------------------------------------------------------------ Uniswap v3 pools (older Clanker versions)
# Same concentrated-liquidity math as v4 (rebuild / amounts above); only the reads differ: a v3 pool is its own
# contract with slot0(), liquidity(), tickSpacing(), tickBitmap(int16) and ticks(int24) -> (liquidityGross, liquidityNet).
UNIV3_FACTORY = {"base": "0x33128a8fc17869897dce68ed026d694621f6fdfd"}
V3_POSITION_MANAGER = {"base": "0x03a520b32c04bf3beef7beb72e919cf822ed34f1"}


def read_pool_v3(chain: str, pool: str, block: str = "latest"):
    s0 = call(chain, pool, "0x" + selector("slot0()"), block)
    lq = call(chain, pool, "0x" + selector("liquidity()"), block)
    ts = call(chain, pool, "0x" + selector("tickSpacing()"), block)
    if not (s0 and lq and ts):
        return None
    w = words(s0)
    sqrtp, tick, spacing = int(w[0], 16), _int24(w[1]), _int24(words(ts)[0])
    pool_L = int(words(lq)[0], 16)
    wps = list(range((MIN_TICK // spacing) >> 8, ((MAX_TICK // spacing) >> 8) + 1))
    bitmaps = multicall(chain, [(pool, "0x" + selector("tickBitmap(int16)") + _enc_int(wp)) for wp in wps], block)
    if any(b is None for b in bitmaps):
        return None
    inited = []
    for wp, bm in zip(wps, bitmaps):
        v, bit = int(bm, 16), 0
        while v:
            if v & 1:
                inited.append((wp * 256 + bit) * spacing)
            v >>= 1; bit += 1
    infos = multicall(chain, [(pool, "0x" + selector("ticks(int24)") + _enc_int(t)) for t in inited], block)
    if any(i is None for i in infos):
        return None
    ticks = []
    for t, info in zip(inited, infos):
        net = int(words(info)[1], 16)
        ticks.append((t, net - (1 << 256) if net >> 255 else net))
    ranges = rebuild(ticks)
    rebuilt_L = liquidity_at(ranges, tick)
    return {"sqrtPriceX96": sqrtp, "tick": tick, "tick_spacing": spacing, "pool_liquidity": pool_L, "rebuilt_liquidity": rebuilt_L,
            "liquidity_check": rebuilt_L == pool_L, "ranges": ranges, "initialized_ticks": len(ticks)}


def v3_position(chain: str, token_id: int):
    """positions(tokenId) on the v3 position manager: token0, token1, fee, tickLower, tickUpper, liquidity."""
    r = call(chain, V3_POSITION_MANAGER[chain], "0x" + selector("positions(uint256)") + hex(token_id)[2:].rjust(64, "0"))
    if not r:
        return None
    w = words(r)
    return {"token0": "0x" + w[2][-40:], "token1": "0x" + w[3][-40:], "fee": int(w[4], 16), "tick_lower": _int24(w[5]),
            "tick_upper": _int24(w[6]), "liquidity": int(w[7], 16)}
