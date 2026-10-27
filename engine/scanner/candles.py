"""Pump.fun's own candles for the Pump.fun coins on the site, one file per coin for the feed and the apps.
Pump.fun answers the engine's honest, read-only client (scanner on the server) but not the feed server's, so the engine reads
`swap-api.pump.fun/v2/coins/<mint>/candles` through stage2/pumpfun_api.py (its shared budget, rests and counts) and writes
`frontend-feed/candles/<mint>.json` (contract "candles-1") whole.

Paced: the candle reads take at most `pumpfun_candles_per_min` requests a minute (scanner/settings.json; CANDLES_PER_MIN when
not set) out of Pump.fun's shared trade-service budget, which the scanner's own trade reads also use. The coins a viewer
opened or searched on the site come first (the site's index/pinrbot-wanted-site.json, newest ask first), then the Pump.fun coins
on its first page, newest launch first; each interval is read again when its last read is older than its own wait (1m every
2 minutes, 5m every 5, 15m every 15, 1h hourly). Pump.fun's own rows only: an empty minute is never filled in.
Missing stays missing: an interval Pump.fun did not answer, or answered with no candle, is absent; a failed read leaves the
last good file as it was; a coin with no known launch time is not read (Pump.fun needs it)."""
from __future__ import annotations
import calendar, json, os, sys, threading, time, traceback

HERE = os.path.dirname(os.path.abspath(__file__))
ENGINE = os.path.dirname(HERE)
sys.path[:0] = [p for p in (HERE, os.path.join(ENGINE, "stage2")) if p not in sys.path]

CONTRACT = "candles-1"
FEED_DIR = os.path.join(ENGINE, "frontend-feed")
SETTINGS = os.path.join(HERE, "settings.json")
INTERVALS = {"1m": 120, "5m": 300, "15m": 900, "1h": 3600}   # a coin a viewer opened: each interval and how long its read stays good
# every other page coin gets the two sizes the site builds the rest from (5m and 15m from
# 1m while the coin is under about 16 hours old, 4h and 1D from 1h), each read just inside the site's own stale time
# (30 minutes for 1m, 3 hours for 1h), so the whole page stays fresh within the share.
PAGE_INTERVALS = {"1m": 1500, "1h": 10200}
STEP_S = 600                  # 255: the share steps up by one a minute after this long without a refusal, and halves at one
SCORING_FLOOR = 3             # the team's call under 255: the scanner's trade reads keep at least this many a minute
ROWS_MAX = 1000                                      # Pump.fun's own largest answer per read
CANDLES_PER_MIN = 4                                  # the share of the trade service's budget when the settings name none
PASS_S = 15
URL = "https://swap-api.pump.fun/v2/coins/%s/candles?interval=%s&limit=%d&currency=USD&createdTs=%d"
_read = {}                                           # (mint, interval) -> when it was last read (answered or not)
_allow = [0.0, 0.0]                                  # requests in hand, and when last refilled
_share = [None, 0.0, False]                          # the share now (255: stepped), when it last changed, whether a refusal is on


def per_min(path: str | None = None) -> int:
    try:
        v = json.load(open(path or SETTINGS)).get("pumpfun_candles_per_min")
        if isinstance(v, int) and not isinstance(v, bool) and 0 <= v <= 60:
            return v
    except Exception:
        pass
    return CANDLES_PER_MIN


def rows_of(answer) -> list | None:
    """Pump.fun's candles as [[t_ms, open, high, low, close, volume], ...] oldest first; None when the answer is not a list
    of candles in that shape (nothing is kept from it), [] when it is an empty list."""
    if not isinstance(answer, list):
        return None
    out = []
    for c in answer:
        try:
            t = int(c["timestamp"])
            row = [t] + [float(c[k]) for k in ("open", "high", "low", "close", "volume")]
        except (KeyError, TypeError, ValueError):
            return None
        if t <= 0 or any(v != v or v < 0 for v in row[1:]):      # a NaN or a negative figure: not Pump.fun's candle shape
            return None
        out.append(row)
    out.sort(key=lambda r: r[0])
    return out[-ROWS_MAX:]


def _iso(t: float) -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(t))


def path_of(mint: str, feed_dir: str | None = None) -> str:
    return os.path.join(feed_dir or FEED_DIR, "candles", mint + ".json")


def write(mint: str, interval: str, rows: list, now: float, feed_dir: str | None = None) -> str:
    """Put one interval's candles into the coin's file (the other intervals as they were), written whole."""
    p = path_of(mint, feed_dir)
    try:
        body = json.load(open(p))
        if body.get("contract") != CONTRACT or body.get("mint") != mint:
            body = None
    except Exception:
        body = None
    body = body or {"contract": CONTRACT, "mint": mint, "source": "Pump.fun", "link": "https://pump.fun/coin/" + mint,
                    "currency": "USD", "intervals": {}, "read": {}}
    body["intervals"][interval] = rows
    body.setdefault("read", {})[interval] = _iso(now)
    body["read_at"] = max(body["read"].values())
    os.makedirs(os.path.dirname(p), exist_ok=True)
    with open(p + ".tmp", "w") as f:
        json.dump(body, f)
    os.replace(p + ".tmp", p)
    return p


import re
_MINT = re.compile(r"^[1-9A-HJ-NP-Za-km-z]{32,44}$")             # the team's W1 on b5e73ff6: only a Solana address reaches a path or URL


def coins_for(page: list, wanted: dict, feed_dir: str | None = None) -> list:
    """[(mint, launched seconds or 0)] in reading order: the Pump.fun coins a viewer asked for (newest ask first; its launch
    time and launchpad from its own feed file), then the site's first-page Pump.fun coins, newest launch first; each once."""
    out, seen = [], set()
    for m, _at in sorted((wanted or {}).items(), key=lambda kv: -(kv[1] if isinstance(kv[1], (int, float)) else 0)):
        if not isinstance(m, str) or not _MINT.match(m):
            continue
        try:
            f = json.load(open(os.path.join(feed_dir or FEED_DIR, m + ".json")))
        except Exception:
            continue
        if not str(f.get("launchpad") or "").startswith(("Pump.fun", "PumpSwap")):
            continue
        try:
            born = float(calendar.timegm(time.strptime(str(f.get("launched_at"))[:19], "%Y-%m-%dT%H:%M:%S")))   # UTC
        except Exception:
            born = 0
        if m not in seen:
            out.append((m, born, True)); seen.add(m)
    for m, born in sorted(page or [], key=lambda mb: -(mb[1] or 0)):
        if isinstance(m, str) and _MINT.match(m) and m not in seen:
            out.append((m, born, False)); seen.add(m)
    return out


def due(coins: list, now: float) -> list:
    """(mint, launched seconds, interval) to read, in the coins' own order and the shortest interval first; a coin with no
    launch time is left out (Pump.fun's read needs it)."""
    out = []
    for c in coins:
        m, born, opened = (c + (True,))[:3] if len(c) == 2 else c   # (mint, launched) alone: read as an opened coin
        if not born:
            continue
        for iv, wait in (INTERVALS if opened else PAGE_INTERVALS).items():
            if now - _read.get((m, iv), 0) >= wait:
                out.append((m, born, iv))
    return out


def share(now: float, refused: bool, base: int, cap: int) -> int:
    """255: the candle share. It starts at the settings' figure, steps up by one every STEP_S while Pump.fun refuses
    nothing, up to `cap` (the trade service's budget less the scanner's floor of SCORING_FLOOR), and halves once per refusal."""
    if _share[0] is None:
        _share[0], _share[1], _share[2] = min(base, cap), now, False
    if refused:
        if not _share[2]:                                    # once per refusal, however long its rest
            _share[0], _share[1], _share[2] = max(1, _share[0] // 2), now, True
        return _share[0]
    _share[2] = False
    if now - _share[1] >= STEP_S and _share[0] < cap:
        _share[0], _share[1] = _share[0] + 1, now
    return _share[0]


def one_pass(coins: list, now: float | None = None, get=None, feed_dir: str | None = None, rate: int | None = None) -> dict:
    """coins: [(mint, launched seconds or 0)], the Pump.fun coins on the site. Reads as many due intervals as the share
    allows (refilled per minute, at most one minute's worth in hand) and writes each answered one. Returns counts."""
    now = now or time.time()
    live = get is None
    if live:
        import pumpfun_api as PF
        get = lambda url: PF._get(url, lane=PF.CANDLE_LANE)    # 255: the candles' own lane of the budget
    if rate is None:
        import pumpfun_api as PF
        rate = share(now, PF.resting(), per_min(), max(1, int(PF.BUDGET.get("swap-api.pump.fun", (25, 12.0))[1]) - SCORING_FLOOR))
        PF.lane_share(value=rate)                                # the trade reads take the rest
    if not _allow[1]:                                        # the first pass: one minute's share in hand
        _allow[0] = float(rate)
    else:
        _allow[0] = min(float(rate), _allow[0] + max(0.0, now - _allow[1]) * rate / 60.0)
    _allow[1] = now
    out = {"due": 0, "asked": 0, "written": 0, "unanswered": 0, "share": rate}
    todo = due(coins, now)
    out["due"] = len(todo)
    for m, born, iv in todo:
        if _allow[0] < 1:
            break
        _allow[0] -= 1
        _read[(m, iv)] = now                                 # asked: not again before its wait, answered or not
        out["asked"] += 1
        rows = rows_of(get(URL % (m, iv, ROWS_MAX, int(born * 1000))))
        if not rows:                                         # no answer, a shape we do not know, or no candle yet: nothing written
            out["unanswered"] += 1
            continue
        write(m, iv, rows, now, feed_dir)
        out["written"] += 1
    return out


def start(coins_fn, say=print) -> threading.Thread:
    """The candle reader's own thread in the scanner: a pass every PASS_S seconds."""
    def run():
        while True:
            try:
                got = one_pass(coins_fn() or [])
                if got.get("written"):
                    say(time.strftime("%H:%M:%S") + " candles: " + ", ".join(f"{k} {v}" for k, v in got.items()))
            except Exception:
                traceback.print_exc()
            time.sleep(PASS_S)
    t = threading.Thread(target=run, name="candles", daemon=True)
    t.start()
    return t
