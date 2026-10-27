"""every listed coin's trades from SQD Portal, about a second behind the chain, into the
feed's tick files (`frontend-feed/ticks/<mint>.json`, contract "ticks-1", the same files the site already streams), with
each coin's 1-second, 1-minute and 5-minute candles built as the trades arrive.

It keeps one request open to the Portal from the next block on and handles each block as it comes: Pump.fun's bonding
curve, PumpSwap (graduated coins) and Raydium LaunchLab, each decoded with its own published IDL (`stage2/idl/`: Pump.fun's
`pump.json` and `pump_amm.json` from github.com/pump-fun/pump-public-docs, Raydium's `raydium_launchpad.json` from
github.com/raydium-io/raydium-idl, copied unchanged 2026-10-25). Only the coins the site lists (its first page, the rest
of its lists, the coins viewers opened) are written; changed files are written whole every FLUSH_S.

Every figure is the chain's own: a coin's decimals from the transaction's token balances (never assumed, except Pump.fun's
own curve coins, which its program always makes with six); a trade quoted in a coin whose decimals are not in its
transaction keeps its time and quote coin but no size or price. Each tick's dollar price and size come from its quote coin's
Jupiter price (QuotePrices), only while that price is fresh. A block the Portal does not answer is never filled in: the reader asks again from it.
  python3 scanner/sqd_live.py run        the service (pinr-sqdlive), when `sqd_live` is "on" in scanner/settings.json"""
from __future__ import annotations
import base64, json, os, sys, threading, time, urllib.error, urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
ENGINE = os.path.dirname(HERE)
sys.path[:0] = [p for p in (HERE, os.path.join(ENGINE, "stage2")) if p not in sys.path]
import sqd

TICK_DIR = os.path.join(ENGINE, "frontend-feed", "ticks")
STATE = os.path.join(ENGINE, "index", "sqd_live.json")
SETTINGS = os.path.join(HERE, "settings.json")
FEED = "http://127.0.0.1:8787"
WANTED = os.path.join(ENGINE, "index", "pinrbot-wanted-site.json")
LAUNCHLAB = "LanMV9sAd7wArD4vJFi2qDdfnVhFxYSUg6eADduJ3uj"
LL_IDL = os.path.join(ENGINE, "stage2", "idl", "raydium_launchpad.json")
WSOL = "So11111111111111111111111111111111111111112"
USD1 = "USD1ttGY1N17NEEHLmELoaybftRBUSErhqYiQzvEmuB"
ZERO = "11111111111111111111111111111111"                 # an unset pubkey in an event: "no quote coin named" (SOL)
LL_POOL, LL_BASE, LL_QUOTE = 4, 9, 10                     # LaunchLab's buy and sell list pool, coin and quote coin there (its IDL)
AMM_QUOTE = 4                                            # PumpSwap's quote coin (its IDL), beside sqd.AMM_POOL and sqd.AMM_MINT
PUMP_DECIMALS = 6                                        # Pump.fun's program makes every curve coin with six
KEEP_TICKS = 500
HOUR_MS = 3_600_000                                       # the site's ask (260): each coin's trades over the last hour, counted by the minute
CANDLES = {"candles_1s": (1000, 300), "candles_1m": (60_000, 1440), "candles_5m": (300_000, 288)}   # (width ms, kept)
FLUSH_S = 0.25
FRESH_PUSH_S = 5.0                     # only trades this fresh go to the live stream; older ones (a restart's catch-up) go to the
                                       # coins' files only
LISTED_S = 30
PUSH_URL = "http://127.0.0.1:8792/internal/ticks"       # 257: the feed server's own listener, never reached by the tunnel
PUSH_REST_S = 5               # a refusal rests the push this long; a slow answer rests nothing (measured it thin, 2026-10-25)
LOGS_STATUS = os.path.join(TICK_DIR, "_logs_status.json")   # the logs feed's status (livews/logs.mjs): its `watched` coins are its own
HELD_S = 300                                             # the logs feed's coins' trades kept this long, for a hand-back
WS_CHECK_S = 5                                           # the logs feed's status read this often (a hand-back at once)
LOGS_FRESH_S = 60                                        # the logs feed writes its status every 5 s; older than this, it stopped
BUSY_WINDOW_MS = 10 * 60_000                             # the trades counted for `busy` (livews/logs.mjs ranks by the same window)
UNCONFIRMED = os.path.join(ENGINE, "index", "unconfirmed.json")   # the logs feed's unconfirmed trades of coins it handed back
PRICES = os.path.join(ENGINE, "index", "quote_prices.json")   # the quote coins' dollar prices, shared with livews/trades.mjs
JUP_PRICE = "https://lite-api.jup.ag/price/v3?ids="     # Jupiter's price API, keyless (manager/SOURCES.md: price row)
PRICE_EVERY_S = 20            # the quote coins' prices read again this often
PRICE_STALE_S = 120           # an older price is not used: the tick goes without a dollar figure (missing stays missing)


class QuotePrices:
    """the site's ask (257): each tick's dollar price and size, from its quote coin's price at the time. One reader for both
    writers: this service reads Jupiter's price for every quote coin it or the logs feed (its status' `quotes`) has
    seen, every PRICE_EVERY_S, into PRICES; a tick gets price_usd, usd and price_usd_src only from a price under
    PRICE_STALE_S old, and never one of them without the other."""
    def __init__(self, path: str = PRICES, fetch=None, ws_status: str = LOGS_STATUS):
        self.path, self.ws_status, self.want, self.prices = path, ws_status, {WSOL}, {}
        self.fetch = fetch or (lambda url: json.load(urllib.request.urlopen(urllib.request.Request(url, headers=sqd.UA), timeout=10)))
        try:
            self.prices = json.load(open(path)).get("prices") or {}
        except Exception:
            pass

    def refresh(self, now: float | None = None) -> int:
        """One read of every wanted quote coin (50 a call); the file written whole. The number priced."""
        now = now or time.time()
        try:
            self.want |= {q for q in json.load(open(self.ws_status)).get("quotes") or [] if isinstance(q, str)}
        except Exception:
            pass
        ids, got = sorted(self.want), {}
        for k in range(0, len(ids), 50):
            try:
                r = self.fetch(JUP_PRICE + ",".join(ids[k:k + 50])) or {}
            except Exception:
                continue                                       # not answered: the old prices age out on their own
            for m, v in r.items():
                p = v.get("usdPrice") if isinstance(v, dict) else None
                if m in self.want and isinstance(p, (int, float)) and p > 0:
                    got[m] = {"usd": float(p), "read_ms": int(now * 1000), "block": v.get("blockId")}
        if got:
            self.prices = {**self.prices, **got}
            body = {"contract": "quote-prices-1", "source": "Jupiter price API v3", "as_of": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(now)),
                    "prices": self.prices}
            try:
                with open(self.path + ".tmp", "w") as f:
                    json.dump(body, f)
                os.replace(self.path + ".tmp", self.path)
            except OSError:
                pass
        return len(got)

    def start(self) -> None:
        def loop():
            while True:
                self.refresh(); time.sleep(PRICE_EVERY_S)
        threading.Thread(target=loop, name="sqd-prices", daemon=True).start()

    def stamp(self, tick: dict, now_ms: int | None = None) -> dict:
        q = tick.get("quote")
        if isinstance(q, str) and q != "other":
            self.want.add(q)
        p = self.prices.get(q) if isinstance(q, str) else None
        now_ms = now_ms or int(time.time() * 1000)
        price = tick.get("price_sol", tick.get("price_quote"))
        amount = tick.get("sol", tick.get("quote_amount"))
        if p and now_ms - p["read_ms"] <= PRICE_STALE_S * 1000 and isinstance(price, (int, float)) and isinstance(amount, (int, float)):
            tick["price_usd"], tick["usd"] = price * p["usd"], amount * p["usd"]
            tick["price_usd_src"] = "Jupiter price v3, read " + time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(p["read_ms"] / 1000))
        return tick


class Pusher:
    """Hands each block's new ticks to the feed server from its own thread (never in the stream's way): one request a
    coin, one at a time; a refusal rests it 5 s, a slow answer rests nothing (the tick file still follows)."""
    def __init__(self, url: str = PUSH_URL, post=None):
        import queue
        self.q, self.url, self.rest_until, self.sent, self.failed = queue.Queue(maxsize=5000), url, 0.0, 0, 0
        self.post = post or (lambda body: urllib.request.urlopen(urllib.request.Request(self.url, data=json.dumps(body).encode(),
                                                                 headers={"content-type": "application/json"}), timeout=3))
        threading.Thread(target=self._run, name="sqd-push", daemon=True).start()

    def add(self, batch: dict) -> None:
        if batch and time.time() >= self.rest_until:
            try:
                self.q.put_nowait(batch)
            except Exception:
                pass                                          # the feed slow to take them: the file carries these

    def _run(self):
        while True:
            batch = self.q.get()
            for mint, ticks in ((m, t[k:k + 500]) for m, t in batch.items() for k in range(0, len(t), 500)):   # the site's limit: 500 a call
                if time.time() < self.rest_until:
                    self.failed += len(ticks); continue
                try:
                    self.post({"contract": "ticks-1", "mint": mint, "ticks": ticks}); self.sent += len(ticks)
                except Exception as e:
                    self.failed += len(ticks)
                    if not isinstance(e, TimeoutError) and "timed out" not in str(e):
                        self.rest_until = time.time() + PUSH_REST_S


def ws_watched(logs_path: str | None = None) -> set:
    """The coins the logs feed (livews/logs.mjs, 257 step 2) writes itself: the busiest listed coins, heard about 0.7 s
    before this service. One writer a coin: this service writes every other listed coin. A status
    over LOGS_FRESH_S old means the logs feed stopped, and its coins are this service's again."""
    p = logs_path or LOGS_STATUS
    try:
        if time.time() - os.path.getmtime(p) > LOGS_FRESH_S:
            return set()
        return {m for m in json.load(open(p)).get("watched") or [] if isinstance(m, str)}
    except Exception:
        return set()


class Held:
    """The logs feed's coins' trades as this service decodes them (it reads every block anyway), kept HELD_S and never
    written while the logs feed watches the coin: when a coin comes back (the feed stopped, or a socket went silent,
    the team's F1 on wslogs), its trades from the gap are written then, so none is lost; one writer a coin all along."""
    def __init__(self):
        self.ticks = {}

    def keep(self, mint: str, tick: dict) -> None:
        self.ticks.setdefault(mint, []).append(tick)

    def prune(self, now_ms: int | None = None) -> None:
        cut = (now_ms or int(time.time() * 1000)) - HELD_S * 1000
        for m in list(self.ticks):
            self.ticks[m] = [t for t in self.ticks[m] if (t.get("seen_ms") or 0) >= cut]
            if not self.ticks[m]:
                del self.ticks[m]

    def give_back(self, mints: set, store: "Store") -> dict:
        """{mint: ticks newly written} for the coins this service writes again."""
        out = {}
        for m in [m for m in self.ticks if m in mints]:
            new = [t for t in self.ticks.pop(m) if store.add(m, t)]
            if new:
                out[m] = new
        return out


def apply_unconfirmed(store: "Store", mine: set, done: set, path: str | None = None) -> int:
    """Remove the trades the logs feed found unconfirmed from the coins this service now writes; each once."""
    try:
        rows = json.load(open(path or UNCONFIRMED)).get("trades") or []
    except Exception:
        return 0
    done.intersection_update({r.get("sig") for r in rows})          # remember only what the list still names
    n = 0
    for r in rows:
        m, sig = r.get("mint"), r.get("sig")
        if isinstance(m, str) and isinstance(sig, str) and m in mine and sig not in done:
            n += store.forget(m, sig); done.add(sig)
    return n


def busy_counts(store: "Store", now_ms: int | None = None, window_ms: int = BUSY_WINDOW_MS) -> dict:
    """Each coin's trades written over the window, for the logs feed to pick the busiest coins (by seen_ms)."""
    now_ms = now_ms or int(time.time() * 1000)
    out = {}
    for m, c in store.coins.items():
        n = sum(1 for t in c["ticks"] if (t.get("seen_ms") or 0) > now_ms - window_ms)
        if n:
            out[m] = n
    return out


def _count(c: dict, tick: dict, n: int) -> None:
    m = int(tick.get("t") or 0) // 60_000
    b = c["mins"].setdefault(m, [0, 0])
    b[0 if tick.get("side") == "buy" else 1] += n


def hour_counts(c: dict, now_ms: int) -> dict:
    """trades_1h, buys_1h, sells_1h: the last hour's trades by the minute of their block
    time, written only when this writer's count covers the whole hour (it has counted the coin an hour, or the kept trades
    span the hour); else none, never a part-hour count (missing stays missing)."""
    first = (now_ms - HOUR_MS) // 60_000
    for m in [m for m in c["mins"] if m < first]:
        del c["mins"][m]
    if c.get("since", now_ms) > now_ms - HOUR_MS:
        return {}
    buys = sum(b[0] for m, b in c["mins"].items() if m >= first)
    sells = sum(b[1] for m, b in c["mins"].items() if m >= first)
    return {"trades_1h": buys + sells, "buys_1h": buys, "sells_1h": sells}


class Store:
    """The ticks-1 files, kept in memory and written whole when they change (the trade feed's own file, plus 1 s and 1 min)."""
    def __init__(self, d: str | None = None, clock=time.time):
        self.dir, self.coins, self.dirty, self.mtime, self.clock = d or TICK_DIR, {}, set(), {}, clock

    def _disk_mtime(self, mint: str):
        try:
            return os.stat(os.path.join(self.dir, mint + ".json")).st_mtime_ns
        except OSError:
            return None

    def drop(self, keep: set) -> None:
        """the team's F1 on 9c9fa986: a coin that left this writer's list (the websocket took it, or the site dropped it)
        is forgotten, so a stale copy is never written over the other writer's file."""
        for m in [m for m in self.coins if m not in keep and m not in self.dirty]:
            self.coins.pop(m, None); self.mtime.pop(m, None)

    def coin(self, mint: str) -> dict:
        if mint in self.coins and mint not in self.dirty and self._disk_mtime(mint) != self.mtime.get(mint):
            self.coins.pop(mint)                                     # someone else wrote the file since: start from theirs (F1)
        if mint not in self.coins:
            try:
                old = json.load(open(os.path.join(self.dir, mint + ".json")))
            except Exception:
                old = {}
            c = {"ticks": [_named(t) for t in old.get("ticks") or []], "graduated_at": old.get("graduated_at"), "gaps": old.get("gaps") or [],
                 "last_sig": old.get("last_sig"), "quote": OLD_NAMES.get(old.get("quote"), old.get("quote")), "supply": old.get("supply")}
            for k in CANDLES:
                c[k] = old.get(k) or []
            c["seen"] = {f'{t.get("sig")}:{t.get("i", 0)}' for t in c["ticks"]}
            now_ms = int(self.clock() * 1000)
            c["mins"] = {}                                       # minute -> [buys, sells]: the last hour's count, from this writer's trades
            for t in c["ticks"]:
                if t.get("t", 0) > now_ms - HOUR_MS:
                    _count(c, t, 1)
            covered = len(c["ticks"]) and c["ticks"][0].get("t", now_ms) <= now_ms - HOUR_MS
            c["since"] = now_ms - HOUR_MS if covered else now_ms   # the kept trades span the hour: the count is whole already
            self.coins[mint] = c
            self.mtime[mint] = self._disk_mtime(mint)
        return self.coins[mint]

    def add(self, mint: str, tick: dict) -> bool:
        c = self.coin(mint)
        key = f'{tick["sig"]}:{tick.get("i", 0)}'
        if key in c["seen"]:
            return False
        c["seen"].add(key)
        c["ticks"].append(tick)
        c["ticks"].sort(key=lambda t: (t["t"], t.get("slot") or 0, t.get("i") or 0))
        if len(c["ticks"]) > KEEP_TICKS:
            for t in c["ticks"][:-KEEP_TICKS]:
                c["seen"].discard(f'{t.get("sig")}:{t.get("i", 0)}')
            c["ticks"] = c["ticks"][-KEEP_TICKS:]
        c["quote"], c["last_sig"] = tick["quote"], tick["sig"]
        _count(c, tick, 1)
        p = tick.get("price_sol", tick.get("price_quote"))
        size = tick.get("sol", tick.get("quote_amount")) or 0
        if isinstance(p, (int, float)) and p > 0:
            for k, (w, keep) in CANDLES.items():
                start = tick["t"] // w * w
                ks = c[k]
                k1 = next((x for x in ks if x["t"] == start), None)
                if k1 is None:
                    k1 = {"t": start, "o": p, "h": p, "l": p, "c": p, "v": 0, "buys": 0, "sells": 0}
                    ks.append(k1); ks.sort(key=lambda x: x["t"])
                else:
                    k1["h"], k1["l"] = max(k1["h"], p), min(k1["l"], p)
                    if tick["t"] >= k1.get("_last", 0):
                        k1["c"] = p
                k1["_last"] = max(k1.get("_last", 0), tick["t"])
                k1["v"] += size
                k1["buys" if tick["side"] == "buy" else "sells"] += 1
                if len(ks) > keep:
                    del ks[:len(ks) - keep]
        self.dirty.add(mint)
        return True

    def _merge_disk(self, mint: str, c: dict) -> None:
        """Add the file's own ticks (by signature and index) to ours before writing, so neither writer's trades are lost."""
        try:
            old = json.load(open(os.path.join(self.dir, mint + ".json")))
        except Exception:
            return
        for t in old.get("ticks") or []:
            key = f'{t.get("sig")}:{t.get("i", 0)}'
            if key not in c["seen"]:
                c["seen"].add(key); c["ticks"].append(_named(t)); _count(c, t, 1)
        c["ticks"].sort(key=lambda t: (t["t"], t.get("slot") or 0, t.get("i") or 0))
        c["ticks"] = c["ticks"][-KEEP_TICKS:]

    def forget(self, mint: str, sig: str) -> int:
        """Remove a transaction's ticks (one the chain never confirmed, named by the logs feed after handing the coin back):
        out of the coin's hour count and its candles' volume and counts (their open, high, low and close stay). The number removed."""
        c = self.coin(mint)
        gone = [t for t in c["ticks"] if t.get("sig") == sig]
        if not gone:
            return 0
        c["ticks"] = [t for t in c["ticks"] if t.get("sig") != sig]
        for t in gone:
            c["seen"].discard(f'{t.get("sig")}:{t.get("i", 0)}'); _count(c, t, -1)
            for k, (w, _keep) in CANDLES.items():
                k1 = next((x for x in c[k] if x["t"] == t["t"] // w * w), None)
                if k1:
                    k1["v"] = max(0, k1["v"] - (t.get("sol", t.get("quote_amount")) or 0))
                    side = "buys" if t.get("side") == "buy" else "sells"
                    k1[side] = max(0, k1[side] - 1)
        self.dirty.add(mint)
        return len(gone)

    def supply(self, mint: str, tokens: float) -> None:
        """the site's ask (257): the coin's whole supply, as the chain states it (Pump.fun's create event, PumpSwap's sell)."""
        c = self.coin(mint)
        if isinstance(tokens, (int, float)) and tokens > 0 and c.get("supply") != tokens:
            c["supply"] = tokens; self.dirty.add(mint)

    def graduated(self, mint: str, at_ms: int) -> None:
        c = self.coin(mint)
        if not c["graduated_at"]:
            c["graduated_at"] = time.strftime("%Y-%m-%dT%H:%M:%S.000Z", time.gmtime(at_ms / 1000))
            self.dirty.add(mint)

    def flush(self, now: float | None = None) -> list:
        """Write every changed coin's file whole; the coins written."""
        if not self.dirty:
            return []
        os.makedirs(self.dir, exist_ok=True)
        done, now = [], now or time.time()
        for mint in sorted(self.dirty):
            c = self.coins[mint]
            body = {"contract": "ticks-1", "mint": mint, "source": "Solana chain", "read_at": time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime(now)) + ".%03dZ" % (int(now * 1000) % 1000),
                    "quote": c["quote"], "ticks": c["ticks"], "last_sig": c["last_sig"]}
            for k in CANDLES:
                body[k] = [{kk: vv for kk, vv in x.items() if kk != "_last"} for x in c[k]]
            if c["graduated_at"]:
                body["graduated_at"] = c["graduated_at"]
            if c.get("supply"):
                body["supply"] = c["supply"]
            if c["gaps"]:
                body["gaps"] = c["gaps"]
            body.update(hour_counts(c, int(now * 1000)))
            p = os.path.join(self.dir, mint + ".json")
            if self._disk_mtime(mint) != self.mtime.get(mint):
                self._merge_disk(mint, c)                            # written by the other writer meanwhile: keep its ticks too (F1)
                body["ticks"], body["last_sig"] = c["ticks"], c["last_sig"]
            tmp = p + ".sqd.tmp"                                     # its own name: the logs feed writes <mint>.json.tmp, and two
            with open(tmp, "w") as f:                                # writers sharing one temporary file renamed it from under
                json.dump(body, f)                                   # each other (FileNotFoundError, 2026-10-25)
            os.replace(tmp, p)
            self.mtime[mint] = self._disk_mtime(mint)
            done.append(mint)
        self.dirty.clear()
        return done

    def lag(self, mint: str, now: float | None = None):
        """Seconds from the coin's newest trade to now; None when it holds none (its only trade forgotten as unconfirmed,
        or a supply or graduation written before any trade): such a coin was crashing the stream on `ticks[-1]`."""
        ticks = (self.coins.get(mint) or {}).get("ticks") or []
        return (now or time.time()) - ticks[-1]["t"] / 1000 if ticks else None


def live_query(frm: int, to: int | None = None) -> dict:
    """The three programs' instructions from a block on (to the newest when `to` is None), with transactions, logs,
    instruction accounts and the transactions' token balances (for every coin's decimals)."""
    item = lambda prog: {"programId": [prog], "isCommitted": True, "transaction": True, "logs": True, "transactionTokenBalances": True}
    q = {"type": "solana", "fromBlock": int(frm),
         "fields": {"block": {"number": True, "timestamp": True},
                    "transaction": {"transactionIndex": True, "signatures": True},
                    "instruction": {"transactionIndex": True, "instructionAddress": True, "programId": True, "accounts": True},
                    "tokenBalance": {"transactionIndex": True, "preMint": True, "postMint": True, "preDecimals": True, "postDecimals": True},
                    "log": {"transactionIndex": True, "instructionAddress": True, "programId": True, "kind": True, "message": True}},
         "instructions": [item(sqd.PUMP), item(sqd.PUMP_AMM), item(LAUNCHLAB)]}
    if to is not None:
        q["toBlock"] = int(to)
    return q


OLD_NAMES = {"SOL": WSOL, "USD1": USD1}     # this service's first ticks (25 Oct) named the quote; ticks-1 names its mint


def _named(t: dict) -> dict:
    return {**t, "quote": OLD_NAMES[t["quote"]]} if isinstance(t, dict) and t.get("quote") in OLD_NAMES else t


def _quote(mint: str | None) -> str:
    """The quote coin's own mint, as ticks-1 names it (the site keeps SOL trades by the wrapped-SOL mint)."""
    return mint if mint and mint != ZERO else WSOL


def _sized(tick: dict, quote: str | None, q_amount: float | None, price: float | None) -> dict:
    """Put the quote side on a tick the way ticks-1 has it: the quote coin's mint; SOL as sol/price_sol, another coin as
    quote_amount/price_quote (none when its decimals are not known)."""
    tick["quote"] = quote or "other"
    good = lambda v: isinstance(v, (int, float)) and v == v and v >= 0
    if quote == WSOL:
        if good(q_amount): tick["sol"] = q_amount
        if good(price) and price > 0: tick["price_sol"] = price
    elif quote:
        if good(q_amount): tick["quote_amount"] = q_amount
        if good(price) and price > 0: tick["price_quote"] = price
    return tick


POOL_KINDS = {"DepositEvent": "liquidity added", "WithdrawEvent": "liquidity removed", "CreatePoolEvent": "pool created",
              "MigratePoolCoinCreatorEvent": "coin creator changed", "BoostBuyAndBurnEvent": "bought back and burned"}
POOL_KEEP = 500                                          # a coin's newest buybacks kept in its file (its pool's creation and
                                                         # every liquidity change are always kept: S1, 26 Oct, a busy coin's
                                                         # buybacks pushed its "pool created" out of the newest 500)
POOL_HISTORY = os.path.join(ENGINE, "index", "pool_history.json")
POOL_HISTORY_EVERY_S = 30                                # a round of history reads this often, at most POOL_HISTORY_COINS coins
POOL_HISTORY_COINS = 5
POOL_HISTORY_RETRY_S = 600                               # a coin whose read failed is tried again after this
PUBLIC_RPC = "https://api.mainnet-beta.solana.com"      # the LP mint's transaction list (Solana's public node, keyless)
TICK_HISTORY_S = 24 * 3600                               # S3/S4: a listed coin with no tick file: its trades of this window, from
                                                         # SQD (a coin with no trade in 24 h is quiet and leaves the lists, 247)
TICK_SCAN_REQUESTS = 40                                  # Portal requests a round at most (the public Portal answers ~800 slots
TICK_SCAN_PACE_S = 2.0                                   # a request: 24 h ~ 270); paced so the live stream comes first; the scan
                                                         # goes on from where it stopped next round
SLOT_S = 0.4                                             # Solana's slot time, for a window's first slot (a little wider is harmless)
TICK_HISTORY_EVERY_S = 30
TICK_HISTORY_COINS = 200                                 # coins in one scan (one filter); more wait for the next


def pool_event(name: str, f: dict, sig: str, slot, t_ms: int, quote_mint, decimals: dict, mint: str) -> dict:
    """One PumpSwap pool event as the chain states it: who, when, how much, the pool's reserves the event
    gives, and its transaction as the receipt. Token amounts are in tokens when the coin's decimals were read in that block
    (or the event names them), else raw units marked `raw` (never assumed)."""
    q = _quote(quote_mint or f.get("quote_mint"))
    bd = f.get("base_mint_decimals") if isinstance(f.get("base_mint_decimals"), int) else decimals.get(mint)
    qd = f.get("quote_mint_decimals") if isinstance(f.get("quote_mint_decimals"), int) else (9 if q == WSOL else decimals.get(q))
    def amt(v, d):
        return None if not isinstance(v, int) else (v / 10 ** d if isinstance(d, int) else v)
    ev = {"t": t_ms, "slot": slot, "sig": sig, "kind": POOL_KINDS[name], "pool": f.get("pool")}
    if name != "MigratePoolCoinCreatorEvent":                        # an event with amounts names its quote coin; a creator change has none
        ev.update(quote_mint=q, raw=not (isinstance(bd, int) and isinstance(qd, int)))   # 
    if name == "DepositEvent":
        ev.update(user=f.get("user"), base=amt(f.get("base_amount_in"), bd), quote=amt(f.get("quote_amount_in"), qd),
                  lp_raw=f.get("lp_token_amount_out"), lp_supply_raw=f.get("lp_mint_supply"))
    elif name == "WithdrawEvent":
        ev.update(user=f.get("user"), base=amt(f.get("base_amount_out"), bd), quote=amt(f.get("quote_amount_out"), qd),
                  lp_raw=f.get("lp_token_amount_in"), lp_supply_raw=f.get("lp_mint_supply"))
    elif name == "CreatePoolEvent":
        ev.update(user=f.get("creator"), base=amt(f.get("base_amount_in"), bd), quote=amt(f.get("quote_amount_in"), qd),
                  lp_raw=f.get("lp_token_amount_out"), coin_creator=f.get("coin_creator"))
    elif name == "MigratePoolCoinCreatorEvent":
        ev.update(old_coin_creator=f.get("old_coin_creator"), new_coin_creator=f.get("new_coin_creator"))
    elif name == "BoostBuyAndBurnEvent":
        ev.update(user=f.get("authority"), base=amt(f.get("base_amount_burned"), bd), quote=amt(f.get("quote_amount_in_used"), qd))
    if name in ("DepositEvent", "WithdrawEvent"):
        ev.update(pool_base=amt(f.get("pool_base_token_reserves"), bd), pool_quote=amt(f.get("pool_quote_token_reserves"), qd))
    return {k: v for k, v in ev.items() if v is not None}


class PoolLog:
    """Each listed coin's pool events in `frontend-feed/pools/<mint>.json` (contract "pool-events-1"): read
    once, added to by sig, kind and index, its newest POOL_KEEP written whole when it changes. This service is the only writer."""
    def __init__(self, d: str | None = None):
        self.dir, self.coins, self.dirty = d or os.path.join(ENGINE, "frontend-feed", "pools"), {}, set()
        self.lock = threading.RLock()                    # the stream and the history reader (PoolHistory) both add

    def has(self, mint: str, kind: str) -> bool:
        with self.lock:
            self._load(mint)
            return any(e.get("kind") == kind for e in self.coins[mint].values())

    def _load(self, mint: str) -> None:
        if mint not in self.coins:
            try:
                old = json.load(open(os.path.join(self.dir, mint + ".json"))).get("events") or []
            except Exception:
                old = []
            self.coins[mint] = {f'{e.get("sig")}:{e.get("kind")}:{e.get("i", 0)}': e for e in old if isinstance(e, dict)}

    def add(self, mint: str, ev: dict) -> bool:
        with self.lock:
            self._load(mint)
            key = f'{ev["sig"]}:{ev["kind"]}:{ev.get("i", 0)}'
            if key in self.coins[mint]:
                return False
            self.coins[mint][key] = ev; self.dirty.add(mint)
            return True

    def flush(self, now: float | None = None) -> int:
        with self.lock:
            return self._flush(now)

    def _flush(self, now: float | None = None) -> int:
        if not self.dirty:
            return 0
        os.makedirs(self.dir, exist_ok=True)
        for mint in sorted(self.dirty):
            order = lambda e: (e.get("t") or 0, e.get("sig") or "")
            alle = self.coins[mint].values()
            evs = sorted([e for e in alle if e.get("kind") != "bought back and burned"]
                         + sorted([e for e in alle if e.get("kind") == "bought back and burned"], key=order)[-POOL_KEEP:], key=order)
            self.coins[mint] = {f'{e.get("sig")}:{e.get("kind")}:{e.get("i", 0)}': e for e in evs}
            p = os.path.join(self.dir, mint + ".json")
            with open(p + ".tmp", "w") as f:
                json.dump({"contract": "pool-events-1", "mint": mint, "source": "Solana chain (PumpSwap's own events)",
                           "as_of": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(now or time.time())), "events": evs}, f)
            os.replace(p + ".tmp", p)
        n = len(self.dirty); self.dirty.clear()
        return n


class PoolHistory:
    """S1 (the team, 26 Oct: a graduated listed coin showed no pool events: its pool was made before this service watched
    it). For each listed graduated coin whose file has no "pool created", its PumpSwap pool's history, SQD first: the pool
    is the canonical PumpSwap pool (an address worked out from the coin, as stage2 reads it), its LP-token mint another
    (from the pool); that mint is touched only when the pool is made and when liquidity is added or removed, so its
    transaction list (Solana's public node, one call) names every such slot, and each slot is read from SQD Portal and
    decoded by this service's own decoder (ticks_of), the same events as the live stream's. Buybacks before the coin was
    listed are not read (they touch neither). A coin whose read failed is tried again after POOL_HISTORY_RETRY_S; a coin read is
    not read again (the live stream carries it on). Network on its own thread, never in the stream's way."""
    def __init__(self, poollog: "PoolLog", idls: dict, rows=None, rpc=None, post=None, state: str | None = None, clock=time.time,
                 quotes=None):
        self.log, self.idls, self.clock = poollog, idls, clock
        self.quotes = quotes or _quote_mints
        self.rows = rows or (lambda: _site_rows())
        self.rpc = rpc or _public_rpc
        self.post = post or (lambda q: sqd._post(sqd.PORTAL + "/stream", q))
        self.path = state or POOL_HISTORY
        try:
            self.done = json.load(open(self.path))
        except Exception:
            self.done = {}

    def candidates(self) -> list:
        rows = self.rows() or []
        now = self.clock()
        out = []
        for r in rows:
            m = r.get("address") if isinstance(r, dict) else None
            if not (isinstance(m, str) and "PumpSwap" in str(r.get("launchpad") or "")) or m.startswith("0x"):
                continue
            d = self.done.get(m) or {}
            if d.get("read") or (d.get("tried") is not None and now - d["tried"] < POOL_HISTORY_RETRY_S) or self.log.has(m, "pool created"):
                continue
            out.append(m)
        return out

    def one(self, mint: str) -> int | None:
        """Events added for one coin; None when a read failed (tried again later)."""
        from b58 import b58d, pda
        try:                                                   # the canonical pool for each quote coin seen (SOL first: a coin
            pa = pda([b"pool-authority", b58d(mint)], sqd.PUMP)   # may be paired with another coin, e.g. PUMP)
            quotes = [WSOL] + [q for q in self.quotes() if q != WSOL]
            pools = [pda([b"pool", (0).to_bytes(2, "little"), b58d(pa), b58d(mint), b58d(q)], sqd.PUMP_AMM) for q in quotes]
        except Exception:
            return None
        pool = None
        for k in range(0, len(pools), 100):                    # the node answers 100 accounts a call at most
            part = pools[k:k + 100]
            got = self.rpc("getMultipleAccounts", [part, {"encoding": "base64", "dataSlice": {"offset": 0, "length": 0}}])
            vals = got.get("value") if isinstance(got, dict) else None
            if not isinstance(vals, list) or len(vals) != len(part):
                return None
            pool = next((p for p, v in zip(part, vals) if isinstance(v, dict) and v.get("owner") == sqd.PUMP_AMM), None)
            if pool:
                break
        if pool is None:
            return 0                                           # no PumpSwap pool of this coin: nothing to read
        lp = pda([b"pool_lp_mint", b58d(pool)], sqd.PUMP_AMM)
        sigs = self.rpc("getSignaturesForAddress", [lp, {"limit": 1000}])
        if not isinstance(sigs, list):
            return None
        slots = sorted({x["slot"] for x in sigs if isinstance(x, dict) and x.get("err") is None and isinstance(x.get("slot"), int)})
        n = 0
        for slot in slots:
            q = live_query(slot, slot)
            q["instructions"] = [{"programId": [sqd.PUMP_AMM], "a3": [mint], "isCommitted": True, "transaction": True, "logs": True,
                                  "transactionTokenBalances": True}]
            t = self.post(q)
            if t is None:
                return None
            for line in t.splitlines():
                if not line.strip():
                    continue
                out = []
                ticks_of(json.loads(line), self.idls, {mint}, {}, {}, pool_out=out)
                for m, ev in out:
                    if m == mint and self.log.add(m, ev):
                        n += 1
        return n

    def round(self, limit: int = POOL_HISTORY_COINS) -> int:
        added = 0
        for m in self.candidates()[:limit]:
            got = self.one(m)
            self.done[m] = {"tried": self.clock(), **({"read": True, "events": got} if got is not None else {})}
            added += got or 0
        if added:
            self.log.flush()
        try:
            os.makedirs(os.path.dirname(self.path), exist_ok=True)
            with open(self.path + ".tmp", "w") as f:
                json.dump(self.done, f)
            os.replace(self.path + ".tmp", self.path)
        except Exception:
            pass
        return added

    def start(self) -> threading.Thread:
        def loop():
            while True:
                try:
                    self.round()
                except Exception:
                    pass
                time.sleep(POOL_HISTORY_EVERY_S)
        t = threading.Thread(target=loop, name="pool-history", daemon=True)
        t.start()
        return t


class TickHistory:
    """S3/S4 (the team, 26 Oct: 192 of 542 listed Solana coins had no tick file, so no chart from PINR's ticks and no trade
    ribbon: this service writes a coin's trades only from when it first lists it). For the listed coins with no tick file,
    one SQD Portal scan over the last TICK_HISTORY_S (every such coin in one filter: Pump.fun's trades by their coin, account
    3; PumpSwap's by theirs, account 4; LaunchLab's by theirs, account 10), decoded by ticks_of, the live stream's own
    decoder. The trades go to the coins' files only (history, never the live stream), each timed by its block (so it never
    counts as busy) and without a dollar figure at today's price (the site prices SOL trades itself). A coin with no trade in
    the window is marked read (it is quiet; its next trade is live). A scan the Portal stops answering (busy, 529) goes on
    from where it stopped next round; nothing is marked read before the scan ends. Network on its own thread; the ticks reach the store through `out`
    (a queue the stream drains), so the store keeps one writer."""
    def __init__(self, idls: dict, out, listed=None, has_file=None, post=None, head=None, state: str | None = None, clock=time.time,
                 sleep=time.sleep):
        self.idls, self.out, self.clock = idls, out, clock
        self.listed = listed or (lambda: set())
        self.has_file = has_file or (lambda m: os.path.exists(os.path.join(TICK_DIR, m + ".json")))
        self.post = post or (lambda q: sqd._post(sqd.PORTAL + "/stream", q))
        self.head = head or (lambda: sqd.head())
        self.path = state or os.path.join(ENGINE, "index", "tick_history.json")
        self.sleep = sleep
        self.scan = None
        try:
            self.done = json.load(open(self.path))
        except Exception:
            self.done = {}

    def candidates(self) -> list:
        now = self.clock()
        return sorted(m for m in (self.listed() or set()) if isinstance(m, str) and not m.startswith("0x") and not self.has_file(m)
                      and not (self.done.get(m) or {}).get("read") and not self._resting(m, now))

    def _resting(self, m: str, now: float) -> bool:
        tried = (self.done.get(m) or {}).get("tried")
        return tried is not None and now - tried < POOL_HISTORY_RETRY_S

    def query(self, frm: int, to: int, mints: list) -> dict:
        q = live_query(frm, to)
        item = lambda prog, pos: {"programId": [prog], f"a{pos}": list(mints), "isCommitted": True, "transaction": True, "logs": True,
                                  "transactionTokenBalances": True}
        q["instructions"] = [item(sqd.PUMP, 2), item(sqd.PUMP_AMM, sqd.AMM_MINT), item(LAUNCHLAB, LL_BASE)]
        return q

    def round(self, limit: int = TICK_HISTORY_COINS) -> int | None:
        """Ticks found this round; None while the scan is not finished (it goes on from where it stopped next round)."""
        if not self.scan:
            coins = self.candidates()[:limit]
            if not coins:
                return 0
            h = self.head()
            if h is None:
                return None
            self.scan = {"coins": coins, "next": h - int(TICK_HISTORY_S / SLOT_S), "to": h, "found": {}, "pools": {}, "decimals": {}}
            for m in coins:
                self.done[m] = {"tried": self.clock()}
        sc, n = self.scan, 0
        want = set(sc["coins"])
        for k in range(TICK_SCAN_REQUESTS):
            if k:
                self.sleep(TICK_SCAN_PACE_S)
            t = self.post(self.query(sc["next"], sc["to"], sc["coins"]))
            if t is None:
                self._save()
                return None                                    # the Portal busy: on from sc["next"] next round
            last = None
            for line in t.splitlines():
                if not line.strip():
                    continue
                b = json.loads(line)
                last = (b.get("header") or {}).get("number")
                t_ms = int(((b.get("header") or {}).get("timestamp") or 0) * 1000)
                for mint, tick, _g, _s in ticks_of(b, self.idls, want, sc["pools"], sc["decimals"], seen_ms=t_ms):
                    if tick is not None:
                        sc["found"].setdefault(mint, []).append(tick); n += 1
            if last is None or last >= sc["to"]:
                break
            sc["next"] = int(last) + 1
        else:
            self._save()
            return None
        for m, ts in sc["found"].items():                      # each coin's trades handed over in one piece, once the scan
            self.out.put((m, ts))                              # ends (take_history writes them only as a new file)
        now = self.clock()
        for m in sc["coins"]:                                  # read, with or without a trade in the window
            self.done[m] = {"tried": now, "read": True}
        self.scan = None
        self._save()
        return n

    def _save(self) -> None:
        try:
            os.makedirs(os.path.dirname(self.path), exist_ok=True)
            with open(self.path + ".tmp", "w") as f:
                json.dump(self.done, f)
            os.replace(self.path + ".tmp", self.path)
        except Exception:
            pass

    def start(self) -> threading.Thread:
        def loop():
            while True:
                try:
                    self.round()
                except Exception:
                    pass
                time.sleep(TICK_HISTORY_EVERY_S)
        t = threading.Thread(target=loop, name="tick-history", daemon=True)
        t.start()
        return t


def take_history(q, store: "Store", mine: set) -> int:
    """The history reader's coins ({coin: its trades from before it was listed}) into the store, files only, and only as a
    coin's FIRST file: the site's stream sends a trade it has not seen in a file it already watches, whatever the trade's
    age, and
    sends nothing from a file it sees for the first time. A coin that has a file by now (a live trade got there first)
    keeps its live trades only. Ticks written."""
    n = 0
    while not q.empty():
        m, ts = q.get_nowait()
        if m not in mine or os.path.exists(os.path.join(store.dir, m + ".json")) or m in store.coins:
            continue
        for t in ts:
            n += bool(store.add(m, t))
    return n


def _quote_mints() -> list:
    """The quote coins the trade writers have seen (QuotePrices' file), in its order."""
    try:
        return [q for q in (json.load(open(PRICES)).get("prices") or {}) if isinstance(q, str)]
    except Exception:
        return []


def _site_rows() -> list | None:
    """The site's listed rows (first page and the rest), with each coin's launchpad; None when the feed does not answer."""
    out = []
    try:
        for path in ("/api/tokens", "/api/tokens/rest"):
            d = json.load(urllib.request.urlopen(FEED + path, timeout=5))
            out += (d.get("tokens") or d.get("rest") or []) if isinstance(d, dict) else d
    except Exception:
        return None
    return out


def _public_rpc(method: str, params: list):
    try:
        body = json.dumps({"jsonrpc": "2.0", "id": 1, "method": method, "params": params}).encode()
        r = json.load(urllib.request.urlopen(urllib.request.Request(PUBLIC_RPC, body, {"content-type": "application/json"}), timeout=30))
        return r.get("result")
    except Exception:
        return None


def ticks_of(block: dict, idls: dict, listed: set, pools: dict, decimals: dict, seen_ms: int | None = None, pool_out: list | None = None) -> list:
    """[(mint, tick or None, graduated_ms or None, supply or None)] for the listed coins in one block, in the chain's own
    order; `seen_ms` (when the reader got the block) goes on each tick, so the site can time the two halves of the trip.
    `pool_out`, when given, gets each listed coin's PumpSwap pool events from the same pass: [(mint, event)]."""
    seen_ms = seen_ms or int(time.time() * 1000)
    hdr = block.get("header") or {}
    slot, t_ms = hdr.get("number"), int((hdr.get("timestamp") or 0) * 1000)
    sig = {t.get("transactionIndex"): (t.get("signatures") or [None])[0] for t in block.get("transactions") or []}
    for tb in block.get("tokenBalances") or []:
        for m, d in ((tb.get("postMint"), tb.get("postDecimals")), (tb.get("preMint"), tb.get("preDecimals"))):
            if m and isinstance(d, int):
                decimals[m] = d
    by_ix = {}
    for ins in block.get("instructions") or []:
        acc, prog = ins.get("accounts") or [], ins.get("programId")
        key = (ins.get("transactionIndex"), tuple(ins.get("instructionAddress") or []))
        if prog == sqd.PUMP_AMM and len(acc) > AMM_QUOTE:
            pools[acc[sqd.AMM_POOL]] = (acc[sqd.AMM_MINT], acc[AMM_QUOTE]); by_ix[key] = (acc[sqd.AMM_MINT], acc[AMM_QUOTE])
        elif prog == LAUNCHLAB and len(acc) > LL_QUOTE:
            pools[acc[LL_POOL]] = (acc[LL_BASE], acc[LL_QUOTE]); by_ix[key] = (acc[LL_BASE], acc[LL_QUOTE])
    out, idx, pidx = [], {}, {}
    for lg in block.get("logs") or []:
        prog = lg.get("programId")
        if lg.get("kind") != "data" or prog not in idls:
            continue
        try:
            got = idls[prog].event(base64.b64decode(lg.get("message") or ""))
        except Exception:
            got = None
        if not got:
            continue
        name, f = got
        ti = lg.get("transactionIndex")
        s = sig.get(ti)
        if not s:
            continue
        here = by_ix.get((ti, tuple(lg.get("instructionAddress") or [])))
        mint = quote_mint = None
        if prog == sqd.PUMP_AMM and name in POOL_KINDS:
            m, q = here or pools.get(f.get("pool"), (None, None))
            m = m or f.get("base_mint") or f.get("mint")
            if pool_out is not None and m in listed:
                k = (s, name); pidx[k] = pidx.get(k, -1) + 1                 # two of one kind in a transaction both kept
                pool_out.append((m, {**pool_event(name, f, s, slot, t_ms, q, decimals, m), "i": pidx[k]}))
            continue
        if prog == sqd.PUMP and name == "CompleteEvent":
            if f.get("mint") in listed:
                out.append((f["mint"], None, t_ms, None))
            continue
        if prog == sqd.PUMP and name == "CreateEvent":
            if f.get("mint") in listed and isinstance(f.get("token_total_supply"), int):
                out.append((f["mint"], None, None, f["token_total_supply"] / 10 ** decimals.get(f["mint"], PUMP_DECIMALS)))
            continue
        if prog == sqd.PUMP and name == "TradeEvent":
            mint, quote_mint = f.get("mint"), f.get("quote_mint")
        elif prog == sqd.PUMP_AMM and name in ("BuyEvent", "SellEvent"):
            mint, quote_mint = here or pools.get(f.get("pool"), (None, None))
        elif prog == LAUNCHLAB and name == "TradeEvent":
            mint, quote_mint = here or pools.get(f.get("pool_state"), (None, None))
        else:
            continue
        if mint not in listed:
            continue
        i = idx.get(s, 0); idx[s] = i + 1
        q = _quote(quote_mint)
        qd = 9 if q == WSOL else decimals.get(q)
        tick = {"t": t_ms, "t_is_receipt": False, "seen_ms": seen_ms, "slot": slot, "sig": s, "i": i, "from_state": False}
        if prog == sqd.PUMP:
            bd = decimals.get(mint, PUMP_DECIMALS)
            buy = bool(f.get("is_buy"))
            qa = f.get("sol_amount") if q == WSOL else f.get("quote_amount")
            vq = f.get("virtual_sol_reserves") if q == WSOL else f.get("virtual_quote_reserves")
            vt = f.get("virtual_token_reserves")
            price = (vq / 10 ** qd) / (vt / 10 ** bd) if qd is not None and vq and vt else None
            tick.update(side="buy" if buy else "sell", tokens=(f.get("token_amount") or 0) / 10 ** bd)
            out.append((mint, _sized(tick, q, qa / 10 ** qd if qd is not None and isinstance(qa, int) else None, price), None, None))
        elif prog == sqd.PUMP_AMM:
            bd = decimals.get(mint)
            buy = name == "BuyEvent"
            base = f.get("base_amount_out") if buy else f.get("base_amount_in")
            qa = f.get("quote_amount_in") if buy else f.get("quote_amount_out")
            if bd is None or not isinstance(base, int) or base <= 0:
                continue                                         # the coin's decimals not in this transaction: not priced, not sized
            tokens = base / 10 ** bd
            qv = qa / 10 ** qd if qd is not None and isinstance(qa, int) else None
            tick.update(side="buy" if buy else "sell", tokens=tokens)
            sup = f.get("base_supply") / 10 ** bd if isinstance(f.get("base_supply"), int) and f["base_supply"] > 0 else None
            out.append((mint, _sized(tick, q, qv, qv / tokens if qv is not None and tokens else None), None, sup))
        else:
            bd = decimals.get(mint)
            d = f.get("trade_direction")
            buy = d == "Buy"
            if bd is None or d not in ("Buy", "Sell"):
                continue
            base = f.get("amount_out") if buy else f.get("amount_in")
            qa = f.get("amount_in") if buy else f.get("amount_out")
            vb = (f.get("virtual_base") or 0) - (f.get("real_base_after") or 0)
            vq = (f.get("virtual_quote") or 0) + (f.get("real_quote_after") or 0)
            price = (vq / 10 ** qd) / (vb / 10 ** bd) if qd is not None and vb > 0 else None
            tick.update(side="buy" if buy else "sell", tokens=(base or 0) / 10 ** bd)
            out.append((mint, _sized(tick, q, qa / 10 ** qd if qd is not None and isinstance(qa, int) else None, price), None, None))
    return out


def listed_coins(fetch=None, wanted_path: str = WANTED) -> set | None:
    """The Solana coins the site lists: its first page, the rest of its lists, and the coins viewers opened; None when the
    feed does not answer (the last set is kept)."""
    fetch = fetch or (lambda path: json.load(urllib.request.urlopen(FEED + path, timeout=5)))
    out = set()
    try:
        for path in ("/api/tokens", "/api/tokens/rest"):
            d = fetch(path)
            rows = d.get("tokens") or d.get("rest") or [] if isinstance(d, dict) else d
            out |= {t["address"] for t in rows if isinstance(t, dict) and isinstance(t.get("address"), str) and not t["address"].startswith("0x")}
    except Exception:
        return None
    try:
        out |= {m for m in json.load(open(wanted_path)) if isinstance(m, str) and not m.startswith("0x")}
    except Exception:
        pass
    return out


def on(path: str | None = None) -> bool:
    try:
        return json.load(open(path or SETTINGS)).get("sqd_live") == "on"
    except Exception:
        return False


class Lag:
    """Seconds from a trade's block time to its file being written: the last few minutes' figures."""
    def __init__(self):
        self.v = []

    def add(self, s: float):
        self.v.append((time.time(), s)); self.v = [x for x in self.v if time.time() - x[0] < 600]

    def figures(self) -> dict:
        xs = sorted(s for _t, s in self.v)
        q = lambda f: round(xs[min(len(xs) - 1, int(len(xs) * f))], 2) if xs else None
        return {"trades_10_min": len(xs), "p50_s": q(0.5), "p90_s": q(0.9), "max_s": q(1.0)}


def _meter_trade(mint: str, tick: dict) -> None:
    """a trade off the chain into the trade feed, and from it to the site's tape (where the data crosses)."""
    try:
        import wires as _W
        smp = {"coin": mint, **{k: tick.get(k) for k in ("t", "side", "sol", "sig") if k in tick}}
        _W.meter("s_ws|live trades|a_trades|live trades", 1, smp)
        _W.meter("a_trades|trades|p_trades|trades", 1, smp)
        _W.meter("a_trades|trades|p_chart|own ticks", 1, smp)
    except Exception:
        pass


def fresh_only(by_coin: dict, now: float | None = None) -> dict:
    """{coin: [tick]} keeping only the ticks under FRESH_PUSH_S old (their trade time against now): the live stream carries
    fresh trades; the rest are already in the coin's file (its history)."""
    cut = ((now or time.time()) - FRESH_PUSH_S) * 1000
    out = {m: [t for t in ts if isinstance(t.get("t"), (int, float)) and t["t"] >= cut] for m, ts in by_coin.items()}
    return {m: ts for m, ts in out.items() if ts}


def run(say=print, store: Store | None = None, urlopen=None, stop=None, pusher=None, prices: QuotePrices | None = None, pool_log=None) -> None:
    """The service: follow the chain from the Portal's newest block, write the listed coins' ticks, report the lag."""
    urlopen = urlopen or urllib.request.urlopen
    store = store or Store()
    idls = {sqd.PUMP: sqd.Idl(), sqd.PUMP_AMM: sqd.Idl(sqd.AMM_IDL_PATH), LAUNCHLAB: sqd.Idl(LL_IDL)}
    pools, decimals, lag, listed, listed_at = {}, {}, Lag(), set(), 0.0
    pusher = pusher or Pusher()
    if prices is None:
        prices = QuotePrices(); prices.start()
    try:
        nxt = int(json.load(open(STATE)).get("next") or 0)
    except Exception:
        nxt = 0
    h = sqd.head(urlopen)
    if h is None:
        raise SystemExit("the Portal did not answer")
    if not nxt or h - nxt > 1500:                             # more than about ten minutes behind: start at the head (no backlog)
        nxt = h
    last_flush, last_status, written, back = time.time(), 0.0, 0, 1.0
    busy, busy_at = {}, 0.0
    everyone, logs, held, ws_at, unconfirmed_done = set(), set(), Held(), 0.0, set()
    poollog = pool_log or PoolLog()
    import queue
    history = queue.Queue()                                    # S3/S4's history ticks, added to the store by this loop only
    if pool_log is None:                                       # the service (a test gives its own): S1's and S3's history reads
        PoolHistory(poollog, idls).start()
        TickHistory(idls, history, listed=lambda: everyone - logs).start()
    while not (stop and stop()):
        if not on():
            say("sqd_live is not on: stopping"); return
        if time.time() - listed_at > LISTED_S:
            got = listed_coins()
            if got is not None:
                everyone = got
            listed_at = time.time()
            ws_at = 0.0
        try:
            req = urllib.request.Request(sqd.PORTAL + "/stream", data=json.dumps(live_query(nxt)).encode(), headers=sqd.UA)
            resp = urlopen(req, timeout=30)
            back, got_any = 1.0, False
            for line in resp:
                if not line.strip():
                    continue
                b = json.loads(line)
                n = b.get("header", {}).get("number")
                if n is None:
                    continue
                got_any = True
                fresh = {}
                written += take_history(history, store, everyone - logs)
                if time.time() - ws_at >= WS_CHECK_S:              # one writer a coin: the logs feed's coins are its own;
                    logs = ws_watched()                           # one it gives back is this service's at once, with its
                    listed = everyone - logs                      # trades from the gap (Held)
                    store.drop(listed)                            # a coin that left is forgotten (F1 on sqd)
                    gave = held.give_back(listed, store)
                    if gave:
                        pusher.add(fresh_only(gave)); written += sum(map(len, gave.values()))
                    held.prune(); ws_at = time.time()
                    apply_unconfirmed(store, listed, unconfirmed_done)
                pool_evs = []
                for mint, tick, grad, sup in ticks_of(b, idls, everyone, pools, decimals, pool_out=pool_evs):
                    if mint in logs:
                        if tick is not None:
                            held.keep(mint, prices.stamp(tick))
                        continue
                    if sup:
                        store.supply(mint, sup)
                    if grad:
                        store.graduated(mint, grad)
                    if tick is not None and store.add(mint, prices.stamp(tick)):
                        written += 1
                        fresh.setdefault(mint, []).append(tick)
                        _meter_trade(mint, tick)
                pusher.add(fresh_only(fresh))
                for mint, ev in pool_evs:
                    poollog.add(mint, ev)
                nxt = int(n) + 1
                if time.time() - last_flush >= FLUSH_S:
                    for m in store.flush():
                        if (s := store.lag(m)) is not None:
                            lag.add(s)
                    poollog.flush()
                    last_flush = time.time()
                if stop and stop():
                    break
            if not got_any:
                time.sleep(0.2)                                   # at the head: ask again in a moment
        except urllib.error.HTTPError as e:
            if e.code in (429, 503):
                time.sleep(0.25)
            else:
                say(f"the Portal refused ({e.code}): asking again in {back:.0f} s"); time.sleep(back); back = min(30.0, back * 2)
        except Exception as e:
            say(f"the Portal stream stopped ({type(e).__name__}): asking again from block {nxt}"); time.sleep(back); back = min(30.0, back * 2)
        for m in store.flush():
            if (s := store.lag(m)) is not None:
                lag.add(s)
        if time.time() - last_status >= 5:
            st = {"contract": "sqd-live-1", "as_of": time.strftime("%Y-%m-%dT%H:%M:%SZ"), "next_block": nxt, "listed_coins": len(listed),
                  "trades_written": written, "lag_trade_to_file": lag.figures(), "pushed": pusher.sent, "push_failed": pusher.failed}
            if time.time() - busy_at >= 30:
                busy, busy_at = busy_counts(store), time.time()
            st["busy"] = busy
            try:
                os.makedirs(os.path.dirname(STATE), exist_ok=True)
                with open(STATE + ".tmp", "w") as f:
                    json.dump({"next": nxt, **st}, f)
                os.replace(STATE + ".tmp", STATE)
            except Exception:
                pass
            last_status = time.time()


if __name__ == "__main__":
    if sys.argv[1:2] == ["run"]:
        import wires as _W
        _W.name("sqdlive")                                     # this service's wire meters
        run(say=lambda s: print(time.strftime("%H:%M:%S"), s, flush=True))
    else:
        print(__doc__.split("\n\n")[0])
