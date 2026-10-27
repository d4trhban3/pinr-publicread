"""DexScreener, read only: what it shows for Solana coins, a batch at a time.

One request names up to 30 coins and returns their trading pairs, each with counts of buys and sells and the volume
both ways for the last 5 minutes, 1 hour, 6 hours and 24 hours. A Pump.fun coin still on its curve is there within
minutes of its creation (checked once, 2026-10-13: 12 of 12, the youngest 7 minutes old;
tools/profiles/2026-10-13-dexscreener-pumpfun-pairs-one-read.json). It gives no buy-only volume and no wallets.

No key. At most one request a second from here; on "too many requests" it is left alone for a minute. The app's feed
server asks the same service from the same address for prices, so this stays small: a few requests a pass.
Missing stays missing: a coin whose batch got no answer is absent from the result (unknown, never zero)."""
from __future__ import annotations
import json, math, time, urllib.error, urllib.request

URL = "https://api.dexscreener.com/tokens/v1/solana/"
BATCH = 30                # coins named in one request (the service's own limit)
GAP = 1.0                 # seconds between two requests
REST = 60.0               # seconds it is left alone after "too many requests"
_next, _rest_until = [0.0], [0.0]


def _get(url: str):
    """(HTTP status, parsed answer or None)."""
    req = urllib.request.Request(url, headers={"user-agent": "PINR/1.0 (read-only market data)", "accept": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=15) as r:
            return r.status, json.loads(r.read())
    except urllib.error.HTTPError as e:
        return e.code, None
    except Exception:
        return 0, None


def _number(x):
    return float(x) if isinstance(x, (int, float)) and not isinstance(x, bool) and math.isfinite(x) else None


def _count(ok: bool) -> None:
    try:                                  # the saved request count (`scanner.py status`); never in the way of a read
        import solana_rpc
        solana_rpc._count("dexscreener", ok)
    except Exception:
        pass


def _txns(p, window):
    """Buys plus sells in one of DexScreener's windows ("m5", "h1", "h6", "h24"); None when the pair does not give both."""
    w = (p.get("txns") or {}).get(window) if isinstance(p.get("txns"), dict) else None
    if not isinstance(w, dict):
        return None
    b, s = w.get("buys"), w.get("sells")
    ok = lambda v: isinstance(v, int) and not isinstance(v, bool) and v >= 0
    return b + s if ok(b) and ok(s) else None


def pairs(mints, get=None, clock=time.time, sleep=time.sleep) -> dict:
    """{coin: [pair, ...]} for every coin whose batch was answered; a coin with no pair yet maps to []. A coin whose
    batch got no answer is NOT in the result. Each pair: {"dex", "created" (seconds, or None), "volume_h1" (dollars
    both ways in the last hour, or None), "buys_h1" (buy transactions in the last hour, or None)}."""
    get, out, mints = get or _get, {}, list(dict.fromkeys(mints))
    for i in range(0, len(mints), BATCH):
        if clock() < _rest_until[0]:
            break                                             # resting after a refusal: the rest stay unknown this time
        wait = _next[0] - clock()
        if wait > 0:
            sleep(wait)
        _next[0] = clock() + GAP
        part = mints[i:i + BATCH]
        status, got = get(URL + ",".join(part))
        ok = status == 200 and isinstance(got, list)
        _count(ok)
        if status == 429:
            _rest_until[0] = clock() + REST
        if not ok:
            continue
        for m in part:
            out[m] = []
        for p in got:
            if not isinstance(p, dict):
                continue
            mint = (p.get("baseToken") or {}).get("address") if isinstance(p.get("baseToken"), dict) else None
            if mint not in out:
                continue
            created = _number(p.get("pairCreatedAt"))
            buys = ((p.get("txns") or {}).get("h1") or {}).get("buys") if isinstance(p.get("txns"), dict) and isinstance((p.get("txns") or {}).get("h1"), dict) else None
            vol = p.get("volume") if isinstance(p.get("volume"), dict) else {}
            liq = p.get("liquidity") if isinstance(p.get("liquidity"), dict) else {}
            # the quote side alone, in dollars: DexScreener's `liquidity.quote` is in the quote coin, and
            # priceUsd / priceNative is that coin's dollar price; the two-sided `liquidity.usd` is NOT what the depth grade takes
            try:
                q_usd = float(liq.get("quote")) * (float(p.get("priceUsd")) / float(p.get("priceNative"))) if liq.get("quote") is not None and float(p.get("priceNative") or 0) > 0 else None
            except (TypeError, ValueError):
                q_usd = None
            quote = p.get("quoteToken") if isinstance(p.get("quoteToken"), dict) else {}
            out[mint].append({"dex": p.get("dexId") if isinstance(p.get("dexId"), str) else None,
                              "created": created / 1000 if created else None,
                              "volume_h1": _number(vol.get("h1")),
                              "buys_h1": int(buys) if isinstance(buys, int) and not isinstance(buys, bool) and buys >= 0 else None,
                              # the figures the page shows (T2, T3; 2026-10-13): each None when the pair does not carry it
                              "pair": p.get("pairAddress") if isinstance(p.get("pairAddress"), str) else None,
                              "url": p.get("url") if isinstance(p.get("url"), str) and p["url"].startswith("https://dexscreener.com/") else None,
                              "price_usd": _number(float(p["priceUsd"])) if isinstance(p.get("priceUsd"), str) and p["priceUsd"].replace(".", "", 1).isdigit() else _number(p.get("priceUsd")),
                              "liquidity_usd": _number(liq.get("usd")),              # both sides together: the figure DexScreener's page shows
                              "liquidity_quote_usd": _number(q_usd),                 # the quote side alone: what the rules' depth grade takes (P1)
                              "quote_symbol": quote.get("symbol") if isinstance(quote.get("symbol"), str) else None,
                              "market_cap": _number(p.get("marketCap")),
                              "fdv": _number(p.get("fdv")),
                              "volume_h24": _number(vol.get("h24")),
                              "txns_h24": _txns(p, "h24")})            # buys and sells in 24 hours (0 = no trade; None = not given)
    return out


def best_pair(mint: str, get=None) -> dict | None:
    """One coin's pair with the most liquidity (then the oldest), from one read; None when DexScreener gave no answer or
    lists no pair. For the score: a graduated coin's liquidity when the chain read gives nothing (T2) and the market figures
    the page shows, with their receipt (T3). Missing stays missing: a figure the pair does not carry is None."""
    got = pairs([mint], get=get).get(mint)
    if not got:
        return None
    return sorted(got, key=lambda q: (-(q.get("liquidity_usd") or 0), q.get("created") or 0))[0]
