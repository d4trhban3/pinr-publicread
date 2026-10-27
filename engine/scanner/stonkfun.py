"""New Stonk.fun launches, read keyless from Stonk.fun's public API.

One read a pass of the last ten minutes of launches (`GET /api/v2/launches/recent`, at most 100, newest first; Stonk.fun's
page allows 240 such reads a minute an address, so one a minute is far inside it; no key, "nothing to sign up for").
Only three things are taken from each record: the coin (its mint), when it was launched, and its pool; everything else
about the coin is read on chain or from the approved sources, as for any coin. Whole or nothing: an answer that cannot
be read, or whose shape is not the documented one (`{"pools": [...]}`), gives None (unknown), never a part. The item
fields are not stated on Stonk.fun's page (2026-10-17), so the reader accepts the names the page and the launchpad
brief use, and a record without a recognisable mint is not a record. Counted under "stonkfun" in the request counter.
"""
from __future__ import annotations
import json, os, sys, time, urllib.request

BASE = "https://www.stonkfun.xyz"
RECENT = BASE + "/api/v2/launches/recent?limit=100&order=desc"
MINT_KEYS = ("mint", "baseMint", "tokenMint", "mintAddress", "token")
POOL_KEYS = ("poolId", "pool", "poolAddress", "poolState")
TIME_KEYS = ("launchedAt", "createdAt", "createdMs", "launchTime", "timestamp", "created_at")
B58 = set("123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz")
LAST_RECORDS: dict = {}            # mint -> the list's own record fields (name, symbol, image, created, pool), from the last read
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "stage2"))


def _address(v) -> bool:
    return isinstance(v, str) and 32 <= len(v) <= 44 and all(ch in B58 for ch in v)


def _when(v) -> float:
    """Seconds since 1970 from a time in any of the usual shapes (milliseconds, seconds, ISO text); 0 if not readable."""
    try:
        if isinstance(v, bool) or v is None:
            return 0.0
        if isinstance(v, (int, float)):
            return float(v) / 1000 if v > 10 ** 11 else float(v)
        if isinstance(v, str):
            from datetime import datetime
            return datetime.fromisoformat(v.replace("Z", "+00:00")).timestamp()
    except Exception:
        pass
    return 0.0


def _count(answered: bool) -> None:
    try:
        import solana_rpc
        solana_rpc.count("stonkfun", answered)
    except Exception:
        pass


def _get(url: str):
    req = urllib.request.Request(url, headers={"accept": "application/json", "user-agent": "PINR scanner"})
    with urllib.request.urlopen(req, timeout=10) as r:
        return json.load(r)


def recent(get=None) -> list | None:
    """The last ten minutes of Stonk.fun launches as [(mint, launched seconds or 0, pool or None)], newest first as
    Stonk.fun orders them; None when the list could not be read whole (no answer, or not the documented shape)."""
    try:
        answer = (get or _get)(RECENT)
    except Exception:
        _count(False)
        return None
    pools = answer.get("pools") if isinstance(answer, dict) else None
    if not isinstance(pools, list):
        _count(False)
        return None
    _count(True)
    out, seen = [], set()
    for p in pools:
        if not isinstance(p, dict):
            continue
        mint = next((p[k] for k in MINT_KEYS if _address(p.get(k))), None)
        if mint is None or mint in seen:
            continue                                    # not a record of a coin, or the same coin twice
        seen.add(mint)
        pool = next((p[k] for k in POOL_KEYS if _address(p.get(k))), None)
        when = next((_when(p[k]) for k in TIME_KEYS if k in p and _when(p[k])), 0.0)
        out.append((mint, when, pool))
        LAST_RECORDS[mint] = {"mint": mint, "created": when, "pool": pool, "name": p.get("name") if isinstance(p.get("name"), str) else None,
                              "symbol": p.get("symbol") if isinstance(p.get("symbol"), str) else None,
                              "image": p.get("imageUrl") if isinstance(p.get("imageUrl"), str) else None, "seen_by": "stonkfun_list"}   # for the seen file
    return out


REWARD_LIST = BASE + "/api/public/v1/tokens?mode=reward&sort=newest&pageSize=10"


def reward_mints(get=None) -> list:
    """The newest reward-mode mints from Stonk.fun's keyless list, as a sample to read on chain (only WHICH
    mints; every figure comes from the mints themselves). [] when the shape is not recognised or the list cannot be read."""
    try:
        d = (get or _get)(REWARD_LIST)
    except Exception:
        _count(False)
        return []
    _count(True)
    body = d.get("data") if isinstance(d, dict) and isinstance(d.get("data"), dict) else d       # the real shape (2026-10-17): data.tokens
    items = next((body[k] for k in ("tokens", "items", "data", "results") if isinstance(body, dict) and isinstance(body.get(k), list)), body if isinstance(body, list) else [])
    out = []
    for it in items:
        if isinstance(it, dict):
            m = next((it[k] for k in MINT_KEYS if _address(it.get(k))), None)
            if m and m not in out:
                out.append(m)
    return out


if __name__ == "__main__":
    got = recent()
    print("could not be read whole" if got is None else f"{len(got)} launches in the last ten minutes" +
          "".join(f"\n  {m}  {time.strftime('%H:%M:%S', time.gmtime(t)) if t else 'time unknown'}  pool {p or 'unknown'}" for m, t, p in got[:10]))
