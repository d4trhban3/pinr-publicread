"""Pump.fun's own public records.

Free, no key, ~0.2 s per call. Used for Pump.fun coins (bonding curve and PumpSwap):
  coin(mint)                      the coin record (name, ticker, image, creator, created time, links, ath, ...)
  trades(mint, t_from, t_to)      every trade between two times, oldest first, from the coin's trade list
  launch(mint)                    launch time, launch block and launch transaction (chain-checked, see below)
  top_holders(mint)               the coin's top holders, largest first

Checked against the chain (facts section 14): the trade list held all 100 of 100 on-chain trades for a coin; a trade's
`slotIndexId` starts with the 12-digit block number and its time equals the block time. The page marker is
"<slotIndexId>-<ms>", so a list can be opened at any moment ("9999999999999999999999-<ms>" = the newest trade at or
before that time). Anything unreadable comes back as None (the reading is unknown), never a shorter list.
"""
from __future__ import annotations
import calendar, json, os, sqlite3, threading, time, urllib.error, urllib.request

FRONT = "https://frontend-api-v3.pump.fun"
SWAP = "https://swap-api.pump.fun"
PAGE = 100                                      # the trade list's largest page
_COIN: dict = {}
PEAK_INFO: dict = {}                            # mint -> the last all-time high matched to a trade: {cap_usd, at, tx} (SITE's ATH row)


PACE = 0.35                                     # seconds between requests per process (Pump.fun's edge rate-limits bursts)
_lock = threading.Lock()
_last = [0.0]
_rest_until = [0.0]                             # after repeated rate limits: rest, and let callers use the chain
REFUSED_REST_S = 3600                           # an outright refusal (403) rests EVERY caller this long (the team 2026-10-23: one
                                                # hourly probe), shared by all engine processes on this machine through REST_FILE
REST_FILE = None                                         # a test sets its own; else PINR_PUMPFUN_REST_FILE, named only by the running
                                                         # scanner and the Mac worker


def _file():
    return REST_FILE or os.environ.get("PINR_PUMPFUN_REST_FILE")
_shared = [0.0, 0.0]                            # (until, read at): the shared rest, re-read at most every few seconds


def _shared_until() -> float:
    if not _file():
        return 0.0
    now = time.time()
    if now - _shared[1] > 5:
        try:
            _shared[0] = float(json.load(open(_file())).get("until") or 0)
        except Exception:
            _shared[0] = 0.0
        _shared[1] = now
    return _shared[0]


def _set_rest(until: float) -> None:
    """The shared rest for every process (written whole); 0 ends it."""
    _rest_until[0] = max(_rest_until[0], until) if until else 0.0
    f = _file()
    if not f:
        return
    try:
        os.makedirs(os.path.dirname(f), exist_ok=True)
        tmp = f + f".{os.getpid()}.tmp"
        json.dump({"until": until, "set_at": time.time()}, open(tmp, "w"))
        os.replace(tmp, f)
    except Exception:
        pass
    _shared[0], _shared[1] = until, time.time()


def _claim_probe() -> bool:
    """When the shared rest has run out, exactly one caller sends the probe: it takes the next hour first (under a lock),
    and gives it back if Pump.fun answers. False for every other caller."""
    import fcntl
    try:
        os.makedirs(os.path.dirname(_file()), exist_ok=True)
        with open(_file() + ".lock", "w") as lk:
            fcntl.flock(lk, fcntl.LOCK_EX)
            _shared[1] = 0.0
            u = _shared_until()
            if u and time.time() < u:
                return False
            _set_rest(time.time() + REFUSED_REST_S)
            return True
    except Exception:
        return False


def resting() -> bool:
    return time.time() < max(_rest_until[0], _shared_until())


# Measured 2026-10-06: the trade service (swap-api) refuses after ~30 quick requests, then lets ~13 a minute through;
# the coin-record service (frontend-api-v3) has its own separate limit. One budget per service, shared by every
# process on this machine (a small SQLite file): up to BURST at once, refilled at RATE per minute.
BUDGET = {"swap-api.pump.fun": (25, 12.0), "frontend-api-v3.pump.fun": (25, 30.0)}
_BUCKET_DB = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "index", "pumpfun_budget.sqlite")


CANDLE_LANE = "#candles"      # the candle reads' own lane of the trade service's budget


def lane_share(c=None, value=None):
    """The candle lane's requests a minute, shared by every process (the candle reader writes it, the trade reads read it);
    0 when the reader has not said (then the trade reads keep the whole budget)."""
    own = c is None
    c = c or sqlite3.connect(_BUCKET_DB, timeout=30)
    try:
        c.execute("CREATE TABLE IF NOT EXISTS lane (name TEXT PRIMARY KEY, per_min REAL, at REAL)")
        if value is not None:
            c.execute("INSERT OR REPLACE INTO lane VALUES (?,?,?)", (CANDLE_LANE, float(value), time.time())); c.commit()
            return float(value)
        r = c.execute("SELECT per_min, at FROM lane WHERE name=?", (CANDLE_LANE,)).fetchone()
        return r[0] if r and time.time() - r[1] < 300 else 0.0       # a reader silent for 5 minutes gives its share back
    finally:
        if own:
            c.close()


def _take(host: str, max_wait: float = 20.0, lane: str = "") -> bool:
    """Spend one request from the host's shared budget, waiting up to max_wait seconds; False = budget empty. On the trade
    service the candle reads (`lane` CANDLE_LANE) and the trade reads each have their own lane: the candles' share, and the
    rest of the budget; together never more than Pump.fun's own total."""
    burst, per_min = BUDGET.get(host, (25, 12.0))
    if host == "swap-api.pump.fun":
        share = min(per_min, lane_share())
        if lane == CANDLE_LANE:
            burst, per_min = max(1.0, share), share
        else:
            burst, per_min = max(1.0, burst * (per_min - share) / per_min), per_min - share
        if per_min <= 0:
            return False
    host = host + lane
    deadline = time.time() + max_wait
    while True:
        c = sqlite3.connect(_BUCKET_DB, timeout=30)
        try:
            c.execute("CREATE TABLE IF NOT EXISTS bucket (host TEXT PRIMARY KEY, tokens REAL, at REAL)")
            c.execute("BEGIN IMMEDIATE")
            row = c.execute("SELECT tokens, at FROM bucket WHERE host=?", (host,)).fetchone()
            now = time.time()
            tokens = burst if row is None else min(burst, row[0] + (now - row[1]) * per_min / 60)
            ok = tokens >= 1
            c.execute("INSERT OR REPLACE INTO bucket VALUES (?,?,?)", (host, tokens - 1 if ok else tokens, now))
            c.commit()
        finally:
            c.close()
        if ok:
            return True
        if time.time() + 60 / per_min > deadline:
            return False
        time.sleep(60 / per_min)


def _counted(url, answered) -> None:
    """The saved request count per source (`scanner.py status`); never in the way of a read. answered=None: the
    request was held back by our own budget or rest and never sent."""
    try:
        import solana_rpc
        if answered is None:
            solana_rpc.held(solana_rpc.label(url))
        else:
            solana_rpc.count(solana_rpc.label(url), answered)
    except Exception:
        pass


TALLY: dict = {}        # wire -> {"n": reads that got through, "error": the last refusal} since take_tally(): what a Mac worker hands in with each score


def take_tally() -> dict:
    """The record and holders reads counted since the last call, and cleared. A Mac worker's own wire files are on the Mac, which the server's
    /control never reads, so the Mac hands this in with each result and the server's hand-in command counts it."""
    out = {k: dict(v) for k, v in TALLY.items() if v.get("n") or v.get("error")}
    TALLY.clear()
    return out


def _wire(url, why=None) -> None:
    """DEBUG 26 Oct (/control): the record and holders reads are counted on their map wires, and a refusal is kept with its reason,
    so the page reads what Pump.fun really did instead of a hand-drawn "blocked". Never in the way of a read."""
    try:
        key = ("s_pump|coin record|a_token|Pump.fun" if "/coins-v2/" in url else "s_pump|holders|a_token|Pump.fun" if "/coins/top-holders/" in url else None)
        if key is None:
            return
        t = TALLY.setdefault(key, {"n": 0, "error": None})
        if why:
            t["error"] = why
        else:
            t["n"] += 1
            t["error"] = None
        import wires as W
        if why:
            W.error(key, why)
        else:
            W.meter(key, 1, {"coin": url.rstrip("/").split("/")[-1]})
    except Exception:
        pass


def _get(url, tries=4, lane: str = ""):
    if resting():
        _counted(url, None)
        return None
    probing = bool(_shared_until())                     # a rest just ran out: one caller probes, the others wait
    if probing and not _claim_probe():
        _counted(url, None)
        return None
    host = url.split("/")[2]
    for i in range(tries):
        if not _take(host, lane=lane):
            _counted(url, None)
            return None                                 # budget used up for now: the caller reads the chain instead
        with _lock:
            wait = PACE - (time.time() - _last[0])
            _last[0] = time.time() + max(0.0, wait)
        if wait > 0:
            time.sleep(wait)
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "PINR-live/1.0 (read-only; pinr.io)"})
            r = json.load(urllib.request.urlopen(req, timeout=20))
        except urllib.error.HTTPError as e:
            _counted(url, e.code == 404)                # "no such coin" is the service's own answer; the rest refused
            if e.code == 404:
                if probing:
                    _set_rest(0)                            # Pump.fun answered ("no such coin"): the rest ends
                return None
            if e.code == 403:
                _set_rest(time.time() + REFUSED_REST_S)    # refused outright (Cloudflare's bot check since 2026-10-23): every caller rests
                _wire(url, "refused (403): every reader rests an hour, then one probe")
                return None
            if e.code == 429:
                if i == tries - 1:
                    _rest_until[0] = time.time() + 300  # still limited: rest 5 minutes
                    _wire(url, "rate limited (429): resting 5 minutes")
                    return None
                time.sleep(5 * 3 ** i)                  # 5 s, 15 s, 45 s
                continue
            time.sleep(1 + i)
            continue
        except Exception:
            _counted(url, False)
            time.sleep(1 + i)
            continue
        _counted(url, True)
        _wire(url)
        if probing:
            _set_rest(0)                                    # the probe got through: every caller may ask again
        return r
    return None


_CACHE_DB = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "index", "solana_cache.sqlite")


def _kv(key, value=None):
    """Permanent store for things that never change once known (a launch; a trade window that has fully passed)."""
    c = sqlite3.connect(_CACHE_DB, timeout=60)
    try:
        c.execute("CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT, updated REAL)")
        if value is None:
            row = c.execute("SELECT v FROM kv WHERE k=?", (key,)).fetchone()
            return json.loads(row[0]) if row else None
        c.execute("INSERT OR REPLACE INTO kv VALUES (?,?,?)", (key, json.dumps(value), time.time()))
        c.commit()
    finally:
        c.close()


def _ts(iso: str) -> int:
    return calendar.timegm(time.strptime(iso[:19], "%Y-%m-%dT%H:%M:%S"))


def coin(mint: str):
    """Pump.fun's record for this coin, or None if Pump.fun does not know it."""
    if mint not in _COIN:
        r = _get(f"{FRONT}/coins-v2/{mint}")
        _COIN[mint] = r if isinstance(r, dict) and r.get("mint") == mint else None
    return _COIN[mint]



def top_holders(mint: str):
    """Pump.fun's own top-holders list for this coin, largest first: [{"address", "amount", "isDev", "isSniper",
    "isBundler", ...}] . The curve account is not in it; the addresses
    are owner wallets. None if the service is unreadable or does not answer with a list (the caller reads the chain)."""
    r = _get(f"{FRONT}/coins/top-holders/{mint}")
    rows = r.get("topHolders") if isinstance(r, dict) else None
    if not isinstance(rows, list):
        return None
    rows = [x for x in rows if isinstance(x, dict) and isinstance(x.get("address"), str)]
    return sorted(rows, key=lambda x: -(x.get("amount") or 0))

def _row(t):
    return {"tx": t["tx"], "t": _ts(t["timestamp"]), "slot": int(t["slotIndexId"][:12]), "pos": t["slotIndexId"],
            "user": t["userAddress"], "side": t["type"], "sol": float(t["amountSol"]) if t.get("amountSol") else None,
            "usd": float(t["amountUsd"]) if t.get("amountUsd") else None, "program": t.get("program"),
            "price_sol": float(t["priceSol"]) if t.get("priceSol") else None,
            "price_usd": float(t["priceUsd"]) if t.get("priceUsd") else None}


def trades(mint: str, t_from: int, t_to: int, max_trades: int = 20000):
    """Every trade with t_from <= time <= t_to, oldest first. (rows, complete) or (None, False) if unreadable.
    complete = the list was read back to t_from within max_trades."""
    final = t_to < time.time() - 120                  # the window is over: its trades can never change
    key = f"pf_trades:{mint}:{t_from}:{t_to}"
    if final:
        hit = _kv(key)
        if hit is not None:
            return hit["rows"], hit["complete"]
    got = _trades_read(mint, t_from, t_to, max_trades)
    if final and got[0] is not None and got[1]:
        _kv(key, {"rows": got[0], "complete": True})
    return got


def _trades_read(mint, t_from, t_to, max_trades):
    cur, rows, seen = f"9999999999999999999999-{(t_to + 1) * 1000}", [], set()
    while True:
        d = _get(f"{SWAP}/v2/coins/{mint}/trades?limit={PAGE}&cursor={cur}")
        if not isinstance(d, dict) or not isinstance(d.get("trades"), list):
            return None, False
        for t in d["trades"]:
            r = _row(t)
            if r["t"] > t_to or (r["tx"], r["pos"]) in seen:
                continue
            if r["t"] < t_from:
                return sorted(rows, key=lambda x: x["pos"]), True
            seen.add((r["tx"], r["pos"])); rows.append(r)
        if len(rows) > max_trades:
            return sorted(rows, key=lambda x: x["pos"])[-max_trades:], False
        nxt = (d.get("pagination") or {}).get("nextCursor")
        if not d["trades"] or not (d.get("pagination") or {}).get("hasMore") or not nxt:
            return sorted(rows, key=lambda x: x["pos"]), True       # reached the coin's first trade
        cur = nxt


def launch(mint: str):
    """(launch_ts, launch_slot, launch_signature) or (None, None, None).
    Pump.fun gives the first trade; the chain gives the transactions on the mint before it (just the launch itself,
    so one small read even for a busy coin). The launch = the oldest successful one of those, or the first trade."""
    hit = _kv(f"pf_launch:{mint}")
    if hit:
        return tuple(hit)
    got = _launch_read(mint)
    if got[0] is not None:
        _kv(f"pf_launch:{mint}", list(got))
    return got


def _launch_read(mint: str):
    from solana_rpc import rpc
    c = coin(mint)
    if not c or not c.get("created_timestamp"):
        return None, None, None
    ft = _get(f"{SWAP}/v1/coins/{mint}/first-trade")
    if not isinstance(ft, dict) or not ft.get("tx"):
        return None, None, None
    f = _row(ft)
    before = rpc("getSignaturesForAddress", [mint, {"before": f["tx"], "limit": 1000}])
    if not isinstance(before, list) or len(before) == 1000:
        return None, None, None                                    # more history before it than expected: unknown
    older = [s for s in before if not s.get("err") and s.get("blockTime")]
    if older:
        o = older[-1]
        return o["blockTime"], o["slot"], o["signature"]
    return f["t"], f["slot"], f["tx"]      # nothing successful before it: the first trade is the launch transaction


def peak(mint: str):
    """(peak price in raw quote per raw token, time, receipt) from Pump.fun's all-time high, or (None, None, why).
    Pump.fun keeps the all-time high in US dollars; the trade at that moment carries its price in both SOL and dollars,
    so its SOL price IS the peak in SOL (no conversion through a later SOL price)."""
    c = coin(mint)
    if not c or not c.get("ath_market_cap") or not c.get("ath_market_cap_timestamp"):
        return None, None, "Pump.fun has no all-time high for this coin"
    t = int(c["ath_market_cap_timestamp"]) // 1000
    supply_whole = int(c.get("total_supply") or 0) / 10 ** int(c.get("base_decimals") or 6)
    if not supply_whole:
        return None, None, "supply unknown"
    ath_usd_per_token = float(c["ath_market_cap"]) / supply_whole
    rows, _ = trades(mint, t - 120, t + 1, max_trades=PAGE * 2)
    if not rows:
        return None, None, "trade at the all-time high not found"
    best = min(rows, key=lambda r: abs((r.get("price_usd") or 0) - ath_usd_per_token))
    if not best.get("price_usd") or abs(best["price_usd"] / ath_usd_per_token - 1) > 0.005:
        return None, None, "no trade priced at the all-time high"
    raw = best["price_sol"] * 10 ** 9 / 10 ** int(c.get("base_decimals") or 6)
    PEAK_INFO[mint] = {"cap_usd": float(c["ath_market_cap"]), "at": best["t"], "tx": best["tx"]}
    return raw, best["t"], f"Pump.fun all-time high ${float(c['ath_market_cap']):,.0f} market cap; trade {best['tx']} priced {best['price_sol']:.3e} SOL"


def first_trades(mint: str, t0: int, horizon: int, max_trades: int):
    """The EARLIEST trades from t0 (up to max_trades) within t0..t0+horizon, oldest first. The list only pages backwards,
    so it is read in back-to-back slices moving forward from the launch; each page is read once. (rows, complete) where
    complete = every trade in the horizon was read; (None, False) if unreadable."""
    rows, start, width = [], t0, 300
    while start <= t0 + horizon and len(rows) < max_trades:
        end = min(start + width - 1, t0 + horizon)
        part, ok = trades(mint, start, end, max_trades=max_trades * 2)
        if part is None or not ok:
            return None, False
        rows += part
        width = width * 4 if len(part) < PAGE * 2 else max(60, width // 2)   # quiet: wider slices; busy: narrower
        start = end + 1
    rows.sort(key=lambda x: x["pos"])
    if len(rows) > max_trades:
        return rows[:max_trades], False
    return rows, start > t0 + horizon


CREATE_EVENT = __import__("hashlib").sha256(b"event:CreateEvent").digest()[:8]


def creation(mint: str):
    """Who launched a Pump.fun coin, from its creation transaction on chain: {"launcher": the wallet that
    created it (Pump.fun's CreateEvent `user`), "fee_receiver": the wallet named as creator (receives creator fees; the
    curve stores this and it can differ from the launcher), "payer", "signature", "t", "slot"}. None if unreadable.
    Stored permanently (a creation never changes)."""
    import base64, struct
    from solana_rpc import rpc, sigs_desc
    from b58 import b58e
    hit = _kv(f"pf_creation:{mint}")
    if hit:
        return hit
    sig = None
    items, end = sigs_desc(mint, max_pages=1)            # a quiet coin: its whole history is one page
    if items is not None and end:
        ok = [s for s in items if not s.get("err")]
        sig = ok[-1]["signature"] if ok else None
    if sig is None:
        _t, _s, sig = launch(mint)                       # busy coin: Pump.fun's first trade + the chain before it
    if not sig:
        return None
    t = rpc("getTransaction", [sig, {"encoding": "json", "maxSupportedTransactionVersion": 1}])
    if not isinstance(t, dict) or not t.get("meta"):
        return None
    out = None
    for line in t["meta"].get("logMessages") or []:
        if not line.startswith("Program data: "):
            continue
        try:
            b = base64.b64decode(line[14:])
        except Exception:
            continue
        if b[:8] != CREATE_EVENT:
            continue
        o = 8
        for _ in range(3):                               # name, symbol, uri
            o += 4 + struct.unpack_from("<I", b, o)[0]
        if b58e(b[o:o + 32]) != mint or len(b) < o + 128:
            continue
        out = {"launcher": b58e(b[o + 64:o + 96]), "fee_receiver": b58e(b[o + 96:o + 128]),
               "payer": t["transaction"]["message"]["accountKeys"][0], "signature": sig,
               "t": t.get("blockTime"), "slot": t.get("slot")}
    if out:
        _kv(f"pf_creation:{mint}", out)
    return out
