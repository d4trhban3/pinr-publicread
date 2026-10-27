"""GeckoTerminal, read only: a pool's own figures for the trigger.

DexScreener lists no Raydium LaunchLab coin before it graduates, so a Stonk.fun coin on its curve is read here, by its
POOL address: one request names up to 30 pools (`GET /networks/solana/pools/multi/{a,b,...}`) and answers each pool's
transaction counts and dollar volume for the last 5 minutes, 1 hour, 6 hours and 24 hours, the same pool shape the app's
feed server already reads from GeckoTerminal's newest-pools list (`tools/profiles/2026-10-17-geckoterminal-new-pools.json`).
Only the 1-hour volume (both ways) and the 1-hour buy count are taken, as GeckoTerminal reports them; PINR counts no trade.

No key. GeckoTerminal allows about 30 requests a minute an address and the app's feed server on the same machine shares
that allowance (one newest-pools read every 30 seconds, plus the chart reads), so this stays small: at most one request
every GAP seconds, and after "too many requests" it is left alone for a minute. Missing stays missing: a pool whose
batch got no answer, or that is not in the answer, is absent from the result (unknown, never zero)."""
from __future__ import annotations
import json, math, time, urllib.error, urllib.request

URL = "https://api.geckoterminal.com/api/v2/networks/solana/pools/multi/"
BATCH = 30                # pools named in one request (the service's own limit)
GAP = 2.0                 # seconds between two requests from here
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
    """GeckoTerminal writes its dollar figures as text ("4.4435089745"); a count is a plain integer."""
    try:
        v = float(x) if isinstance(x, (int, float, str)) and not isinstance(x, bool) else None
    except ValueError:
        return None
    return v if v is not None and math.isfinite(v) else None


def _when(v) -> float | None:
    try:
        from datetime import datetime
        return datetime.fromisoformat(v.replace("Z", "+00:00")).timestamp() if isinstance(v, str) else None
    except Exception:
        return None


def _count(ok: bool) -> None:
    try:                                  # the saved request count (`scanner.py status`); never in the way of a read
        import solana_rpc
        solana_rpc._count("geckoterminal", ok)
    except Exception:
        pass


def figures(pools, get=None, clock=time.time, sleep=time.sleep) -> dict:
    """{pool address: figures} for every pool GeckoTerminal answered for, in one or more reads of up to 30 pools. A pool
    whose batch got no answer, or that the answer does not name, is NOT in the result. Each: {"dex" (GeckoTerminal's
    exchange id, e.g. "stonkfun"), "mint" (the pool's base coin, or None), "created" (seconds, or None), "volume_h1"
    (dollars both ways in the last hour, or None), "buys_h1" (buy transactions in the last hour, or None)}."""
    get, out, pools = get or _get, {}, [p for p in dict.fromkeys(pools) if isinstance(p, str) and p]
    for i in range(0, len(pools), BATCH):
        if clock() < _rest_until[0]:
            break                                             # resting after a refusal: the rest stay unknown this time
        wait = _next[0] - clock()
        if wait > 0:
            sleep(wait)
        _next[0] = clock() + GAP
        part = pools[i:i + BATCH]
        status, got = get(URL + ",".join(part))
        data = got.get("data") if isinstance(got, dict) else None
        ok = status == 200 and isinstance(data, list)
        _count(ok)
        if status == 429:
            _rest_until[0] = clock() + REST
        if not ok:
            continue
        for item in data:
            if not isinstance(item, dict) or not isinstance(item.get("attributes"), dict):
                continue
            a, rel = item["attributes"], item.get("relationships") if isinstance(item.get("relationships"), dict) else {}
            addr = a.get("address")
            if addr not in part:
                continue                                      # an answer about a pool nobody asked for
            tx = a.get("transactions") if isinstance(a.get("transactions"), dict) else {}
            h1 = tx.get("h1") if isinstance(tx.get("h1"), dict) else {}
            buys = h1.get("buys")
            vol = a.get("volume_usd") if isinstance(a.get("volume_usd"), dict) else {}
            base = ((rel.get("base_token") or {}).get("data") or {}).get("id") if isinstance(rel.get("base_token"), dict) else None
            dex = ((rel.get("dex") or {}).get("data") or {}).get("id") if isinstance(rel.get("dex"), dict) else None
            out[addr] = {"dex": dex if isinstance(dex, str) else None,
                         "mint": base.split("_", 1)[1] if isinstance(base, str) and base.startswith("solana_") else None,
                         "created": _when(a.get("pool_created_at")),
                         "volume_h1": _number(vol.get("h1")),
                         "buys_h1": int(buys) if isinstance(buys, int) and not isinstance(buys, bool) and buys >= 0 else None}
    return out


if __name__ == "__main__":
    import sys
    got = figures(sys.argv[1:])
    for p, f in got.items():
        print(f"{p}  dex {f['dex']}  mint {f['mint']}  volume h1 {f['volume_h1']}  buys h1 {f['buys_h1']}")
    print(f"{len(got)} of {len(sys.argv[1:])} pools answered")
