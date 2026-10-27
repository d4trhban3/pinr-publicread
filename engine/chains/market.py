"""CHAINS: price, pairs and 24-hour trade counts for Base and BNB coins once pooled, free and keyless.
  - both chains: DexScreener `tokens/v1/<chain>/` first (30 coins a call; PancakeSwap, where Four.meme and Flap graduate);
  - Base, for a coin DexScreener lists no pair for: GeckoTerminal `networks/base/tokens/multi/` with its top pools (it lists
    Uniswap v4, where Clanker and Zora coins trade and which DexScreener misses: pinr-live/server/quotes.ts).
The same answer gives the quiet rule its pairs in the shape `scanner/quiet.judge` reads
({"txns_h24", "created"}). A coin whose batch got no answer is absent (unknown); one with no pair maps to []."""
from __future__ import annotations
import json, time, urllib.error, urllib.request

DEX_URL = "https://api.dexscreener.com/tokens/v1/%s/"
GT_URL = "https://api.geckoterminal.com/api/v2/networks/base/tokens/multi/%s?include=top_pools"
BATCH = 30
GAP = {"dexscreener": 1.0, "geckoterminal": 6.0}        # GeckoTerminal's ~30 a minute an address is shared with the app's feed
REST = 60.0                                               # left alone this long after "too many requests"
_next = {"dexscreener": 0.0, "geckoterminal": 0.0}
_rest = {"dexscreener": 0.0, "geckoterminal": 0.0}


def _get(url: str):
    req = urllib.request.Request(url, headers={"user-agent": "PINR/1.0 (read-only market data)", "accept": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=15) as r:
            return r.status, json.loads(r.read())
    except urllib.error.HTTPError as e:
        return e.code, None
    except Exception:
        return 0, None


def _num(x):
    try:
        v = float(x)
    except (TypeError, ValueError):
        return None
    return v if v == v and v >= 0 else None


def _when(v):
    if isinstance(v, (int, float)) and not isinstance(v, bool) and v > 0:
        return v / 1000 if v > 1e12 else float(v)
    if isinstance(v, str) and len(v) >= 19:
        import calendar
        try:
            return float(calendar.timegm(time.strptime(v[:19], "%Y-%m-%dT%H:%M:%S")))
        except ValueError:
            return None
    return None


def _count(a, b):
    return a + b if isinstance(a, int) and isinstance(b, int) and not isinstance(a, bool) and not isinstance(b, bool) else None


def from_dexscreener(mints: list, body) -> dict:
    """{coin: {"pairs": [...], price fields}} for a DexScreener answer; every asked coin maps (no pair = [])."""
    out = {m: {"pairs": []} for m in mints}
    best = {}
    for p in body if isinstance(body, list) else []:
        if not isinstance(p, dict):
            continue
        m = str((p.get("baseToken") or {}).get("address") or "").lower()
        if m not in out:
            continue
        tx = ((p.get("txns") or {}).get("h24") or {}) if isinstance(p.get("txns"), dict) else {}
        liq = _num((p.get("liquidity") or {}).get("usd")) if isinstance(p.get("liquidity"), dict) else None
        out[m]["pairs"].append({"dex": p.get("dexId"), "pair": p.get("pairAddress"), "created": _when(p.get("pairCreatedAt")),
                                "txns_h24": _count(tx.get("buys"), tx.get("sells")) if isinstance(tx, dict) else None})
        if liq is not None and liq >= best.get(m, (-1,))[0]:
            best[m] = (liq, p)
    for m, (liq, p) in best.items():
        vol = (p.get("volume") or {}).get("h24") if isinstance(p.get("volume"), dict) else None
        out[m].update(price_usd=_num(p.get("priceUsd")), valuation_usd=_num(p.get("marketCap")) or _num(p.get("fdv")),
                      liquidity_usd=liq, volume_24h_usd=_num(vol), source="DexScreener")
    return out


def from_gecko(mints: list, body) -> dict:
    """The same shape from GeckoTerminal's tokens/multi answer with top pools included."""
    out = {m: {"pairs": []} for m in mints}
    if not isinstance(body, dict):
        return out
    pools = {p.get("id"): p for p in body.get("included") or [] if isinstance(p, dict) and p.get("type") == "pool"}
    for t in body.get("data") or []:
        a = (t or {}).get("attributes") or {}
        m = str(a.get("address") or "").lower()
        if m not in out:
            continue
        liq = 0.0
        for ref in ((t.get("relationships") or {}).get("top_pools") or {}).get("data") or []:
            p = pools.get((ref or {}).get("id"))
            if not p:
                continue
            pa = p.get("attributes") or {}
            tx = (pa.get("transactions") or {}).get("h24") or {}
            out[m]["pairs"].append({"dex": ((p.get("relationships") or {}).get("dex") or {}).get("data", {}).get("id"),
                                    "pair": pa.get("address"), "created": _when(pa.get("pool_created_at")),
                                    "txns_h24": _count(tx.get("buys"), tx.get("sells")) if isinstance(tx, dict) else None})
        out[m].update(price_usd=_num(a.get("price_usd")), valuation_usd=_num(a.get("market_cap_usd")) or _num(a.get("fdv_usd")),
                      liquidity_usd=_num(a.get("total_reserve_in_usd")),
                      volume_24h_usd=_num((a.get("volume_usd") or {}).get("h24")) if isinstance(a.get("volume_usd"), dict) else None,
                      source="GeckoTerminal")
    return out


def _ask(src: str, chain: str, mints: list, get, clock, sleep, calls_max: int) -> dict:
    """One source, BATCH coins a call, at most calls_max calls, paced on its own and rested after a refusal."""
    out = {}
    for i in range(0, min(len(mints), BATCH * calls_max), BATCH):
        if clock() < _rest[src]:
            break
        wait = _next[src] - clock()
        if wait > 0:
            sleep(wait)
        _next[src] = clock() + GAP[src]
        part = mints[i:i + BATCH]
        status, body = get((DEX_URL % chain) + ",".join(part) if src == "dexscreener" else GT_URL % ",".join(part))
        if status == 429:
            _rest[src] = clock() + REST
        if status != 200:
            continue
        out.update((from_dexscreener if src == "dexscreener" else from_gecko)(part, body))
    return out


def read(chain: str, mints: list, get=None, clock=time.time, sleep=time.sleep, calls_max: int = 10) -> dict:
    """{coin: {...}} for every coin whose batch was answered. DexScreener first on both chains (the team 2026-10-25: the
    Air's GeckoTerminal allowance is shared with the site's charts); on Base, a coin DexScreener lists no pair for (Uniswap
    v4 launches, which it misses) is asked of GeckoTerminal."""
    get = get or _get
    mints = list(dict.fromkeys(m.lower() for m in mints))
    out = _ask("dexscreener", chain, mints, get, clock, sleep, calls_max)
    if chain == "base":
        rest = [m for m in mints[:BATCH * calls_max] if out.get(m, {}).get("pairs") == [] or m not in out]
        if rest:
            got = _ask("geckoterminal", chain, rest, get, clock, sleep, calls_max)
            out.update(got)                                    # DexScreener had nothing for these: GeckoTerminal's answer stands
    return out


def fields(q: dict) -> dict:
    """The feed-file fields a market answer gives (the names a scored file uses); missing stays absent."""
    f = {k: q.get(k) for k in ("price_usd", "valuation_usd", "liquidity_usd", "volume_24h_usd") if q.get(k) is not None}
    if f.get("price_usd") == 0:
        f.pop("price_usd")
    return f
