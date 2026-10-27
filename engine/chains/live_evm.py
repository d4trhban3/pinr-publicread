"""The operator's order, 26 Oct: BNB and Base trades at Solana's speed. One small live reader a chain on SQD
Portal's head, like scanner/sqd_live.py for Solana: it asks the Portal for the blocks after the last one it read (a request
for a block not made yet is held by the Portal until the block exists), decodes the listed coins' trades as each block
comes, writes them into the feed's tick files (`frontend-feed/ticks/<0x address>.json`, contract "ticks-1") and hands the
fresh ones to the feed server's live stream.

  BNB:  Four.meme's and Flap's own trade events (chains/bnb.py's decoder), priced as chains/ticks_evm.py prices them (the
        launchpad's own price; BNB at Chainlink's BNB/USD feed; another quote coin at its own PancakeSwap pool).
  Base: the listed coins' Uniswap v4 pools' Swap events, filtered to their pool ids (chains/ticks_base.py's pools and
        decoder; WETH-paired pools, ETH at Chainlink's ETH/USD feed on Base).

The rules sqd_live keeps: only trades under FRESH_PUSH_S old go to the live stream, older ones (a restart's catch-up) to the
files only; the next block is saved and read again from there after a restart (up to MAX_BEHIND_S; further behind, it starts
at the head and the chains service's pass covers the gap). A busy, refused or failed answer is waited out, longer each time,
and never filled in. The chains service's pass keeps writing the same files every 30 s (its trades, its history of a coin
listed before its file, its new pools): the fallback whenever the Portal is down, and never a second copy of a trade (the
files keep one trade per transaction and log index, chains/ticks_evm.py). Every network read (the coin list, prices) runs on
its own thread, never in the stream's way.
  python3 chains/live_evm.py run bsc|base     the service (pinr-bnblive, pinr-baselive), while its switch in
                                             scanner/settings.json ("bnb_live", "base_live") is "on\""""
from __future__ import annotations
import json, os, sqlite3, sys, threading, time, urllib.error, urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
ENGINE = os.path.dirname(HERE)
sys.path[:0] = [p for p in (HERE, os.path.join(ENGINE, "scanner"), os.path.join(ENGINE, "stage2"), os.path.join(ENGINE, "stage3"),
                            os.path.join(ENGINE, "stage4")) if p not in sys.path]
import bnb as B
import sqd_evm as S
import ticks_base as TB
import ticks_evm as TE

DB = os.environ.get("PINR_CHAINS_DB") or os.path.join(HERE, "chains.sqlite")
TICK_DIR = os.path.join(ENGINE, "frontend-feed", "ticks")
SETTINGS = os.path.join(ENGINE, "scanner", "settings.json")
SWITCH = {"bsc": "bnb_live", "base": "base_live"}
NAME = {"bsc": "bnblive", "base": "baselive"}            # each service's wire meters (control/wires/<name>.json)
NODE = {"bsc": "s_bnb", "base": "s_base"}
PACE_S = {"bsc": 1.0, "base": 2.0}       # one request a second at most (BNB: about two blocks an answer), one a block on Base:
                                         # the Portal's public limit (about 20 a 10 s) is shared with sqd_live and the chains pass
BLOCK_S = {"bsc": 0.45, "base": 2.0}
MAX_BEHIND_S = 600                       # a saved block further back than this: start at the head (the chains pass covers it)
FLUSH_S = 0.25
STATUS_S = 2
LIST_S = 30                              # the coin list (and Base's pools) read again this often
PRICE_S = 60                             # the quote coins' prices read again this often (Chainlink and PancakeSwap reads)
PRICE_STALE_S = 300                      # an older price is not used: the trade waits for the chains pass (missing stays missing)
BACK_MAX_S = 60
PUSH_URL = "http://127.0.0.1:8792/internal/ticks"


def state_path(chain: str) -> str:
    return os.path.join(ENGINE, "index", f"live_{chain}.json")


def on(chain: str, path: str | None = None) -> bool:
    try:
        return json.load(open(path or SETTINGS)).get(SWITCH[chain]) == "on"
    except Exception:
        return False


def query(chain: str, frm: int, pools=None) -> dict:
    """The Portal request from block `frm` to the newest: every block's number and time (so the reader always knows where it
    is) and the trade logs."""
    q = {"type": "evm", "fromBlock": int(frm), "includeAllBlocks": True,
         "fields": {"block": {"number": True, "timestamp": True},
                    "log": {"address": True, "topics": True, "data": True, "transactionHash": True, "logIndex": True}}}
    if chain == "bsc":
        q["logs"] = [{"address": [a.lower()], "topic0": list(t)} for a, t in B.TRADES.values()]
    else:
        q["logs"] = [{"address": [TB.POOL_MANAGER], "topic0": [TB.SWAP], "topic1": sorted(pools)}] if pools else []
    return q


class Coins:
    """What the reader needs from the chains service's store and the site, read on its own thread every LIST_S: the listed
    coins (the site's list, chains/funding.py's last good one), each BNB coin's quote coin, Base's WETH pools {pool id: coin},
    and the quote coins' dollar prices."""
    def __init__(self, chain: str, db: str = DB, site_fn=None, native_fn=None, quote_fn=None, clock=time.time):
        self.chain, self.db, self.clock = chain, db, clock
        self.site_fn, self.native_fn, self.quote_fn = site_fn, native_fn, quote_fn
        self.listed, self.quote, self.pools, self.prices, self.read_at = set(), {}, {}, {}, 0.0

    def _site(self):
        if self.site_fn:
            return self.site_fn()
        import funding as FN
        return FN._site_list()

    def _native(self):
        if self.native_fn:
            return self.native_fn()
        from evm import native_usd
        return native_usd(self.chain)

    def _quote_price(self, q):
        if self.quote_fn:
            return self.quote_fn(q)
        import service as SV
        return SV._quote_price(q)

    def refresh(self) -> None:
        site = self._site()
        try:
            c = sqlite3.connect(f"file:{self.db}?mode=ro", uri=True, timeout=10)
            try:
                if self.chain == "bsc":
                    quote = {m: q for m, q in c.execute("SELECT mint, quote FROM coins WHERE chain='bsc'")}
                    pools = {}
                else:
                    quote = {}
                    pools = {p.lower(): (m, q) for m, p, q in c.execute("SELECT mint, pool, paired FROM base_pools") if q in TB.QUOTES and p}
            finally:
                c.close()
        except sqlite3.Error:
            return                                             # the store busy or not there yet: the last lists stand
        if site is not None:
            if self.chain == "bsc":
                self.listed = {m for m in quote if m in site}
            else:
                self.listed = {m for m, _q in pools.values() if m in site}
        self.quote = {m: q for m, q in quote.items() if m in self.listed}
        self.pools = {p: mq for p, mq in pools.items() if mq[0] in self.listed}
        now = self.clock()
        p, why = self._native()
        if p:
            self.prices["BNB" if self.chain == "bsc" else "WETH"] = (p, why or "", now)
        if self.chain == "base":                               # the other paired coins priced on Base (USDC), at their own feed
            for q in {q for _m, q in self.pools.values() if q != TB.WETH}:
                sym = TB.QUOTES[q][0]
                try:
                    got = self.quote_fn(sym) if self.quote_fn else __import__("evm").asset_usd(sym)
                except Exception:
                    got = (None, None)
                if got and got[0]:
                    self.prices[sym] = (got[0], got[1] or "", now)
        for q in {q for q in self.quote.values() if q and q != "BNB"}:
            got = self.prices.get(q)
            if got and now - got[2] < PRICE_S:
                continue
            try:
                hit = self._quote_price(q)
            except Exception:
                hit = None
            if hit:
                self.prices[q] = (hit[0], hit[1], now, hit[2])
        self.read_at = now

    def price(self, sym: str):
        """(dollars, source) of a quote coin's price under PRICE_STALE_S old, else None."""
        got = self.prices.get(sym)
        return got if got and self.clock() - got[2] < PRICE_STALE_S else None

    def start(self) -> threading.Thread:
        def loop():
            while True:
                try:
                    self.refresh()
                except Exception:
                    pass
                time.sleep(LIST_S)
        t = threading.Thread(target=loop, name="live-coins", daemon=True)
        t.start()
        return t


def bnb_ticks(logs: list, coins: Coins) -> list:
    """[(coin, tick)] of one block's Four.meme and Flap trades of listed coins whose quote coin has a fresh price."""
    out, raw = [], []
    for kind in B.TRADES:
        B.decode_trades(kind, logs, B._post, {}, {}, None, raw)
    for _kind, mint, side, t, tx, i, amount, paid, price in raw:
        if mint not in coins.listed:
            continue
        q = coins.quote.get(mint)
        p = coins.price(q) if q else None
        if not p:
            continue
        sym = "BNB" if q == "BNB" else (p[3] if len(p) > 3 and p[3] else q[:10])
        x = TE.tick(side, t, tx, i, amount, paid, price, p[0], p[1], sym)
        if x:
            out.append((mint, x, sym))
    return out


def base_ticks(logs: list, coins: Coins) -> list:
    """[(coin, tick)] of one block's Swaps in the listed coins' pools paired with WETH or USDC, while that coin has a fresh price."""
    out = []
    for l in logs:
        try:
            mq = coins.pools.get(str(l["topics"][1]).lower())
            if not mq or l["topics"][0] != TB.SWAP:
                continue
            m, q = mq
            sym, dec = TB.QUOTES[q]
            p = coins.price(sym)
            if not p:
                continue
            ts = l.get("blockTimestamp")
            x = TB.tick(int(m, 16) < int(q, 16), l["data"], float(int(ts, 16)) if isinstance(ts, str) else None,
                        l.get("transactionHash"), int(l.get("logIndex") or "0x0", 16), p[0], p[1], sym, dec)
        except Exception:
            continue
        if x:
            out.append((m, x, sym))
    return out


def fresh_only(by_coin: dict, now: float | None = None) -> dict:
    """livefresh's rule (scanner/sqd_live.py): only trades under FRESH_PUSH_S old go to the live stream."""
    import sqd_live as SL
    return SL.fresh_only(by_coin, now)


class Lag:
    """Seconds from a trade's block time to its file being written, the last ten minutes. Block times are whole seconds."""
    def __init__(self, clock=time.time):
        self.v, self.clock = [], clock

    def add(self, s: float) -> None:
        now = self.clock()
        self.v.append((now, s)); self.v = [x for x in self.v if now - x[0] < 600]

    def figures(self) -> dict:
        xs = sorted(s for _t, s in self.v)
        q = lambda f: round(xs[min(len(xs) - 1, int(len(xs) * f))], 2) if xs else None
        return {"trades_10_min": len(xs), "p50_s": q(0.5), "p90_s": q(0.9), "max_s": q(1.0)}


def _meter(chain: str, mint: str, x: dict) -> None:
    """a trade off the chain into the trade feed, and from it to the site's tape."""
    try:
        import wires as W
        smp = {"coin": mint, "chain": chain, **{k: x.get(k) for k in ("t", "side", "usd", "sig")}}
        W.meter(f"{NODE[chain]}|live trades|a_trades|live trades", 1, smp)
        W.meter("a_trades|trades|p_trades|trades", 1, smp)
        W.meter("a_trades|trades|p_chart|own ticks", 1, smp)
    except Exception:
        pass


def _wire_error(chain: str, why: str) -> None:
    try:
        import wires as W
        W.error(f"{NODE[chain]}|live trades|a_trades|live trades", why)
    except Exception:
        pass


def _beat(chain: str) -> None:
    try:
        import wires as W
        W.beat(NODE[chain])
    except Exception:
        pass


def _pusher():
    import sqd_live as SL
    return SL.Pusher(PUSH_URL)


def run(chain: str, say=print, urlopen=None, stop=None, pusher=None, coins: Coins | None = None, files=None, clock=time.time,
        sleep=time.sleep, head_fn=None, switch=None, state: str | None = None) -> None:
    """The service: follow the chain from the saved block, write the listed coins' trades, push the fresh ones."""
    urlopen = urlopen or urllib.request.urlopen
    switch = switch or (lambda: on(chain))
    head_fn = head_fn or (lambda: S.head(chain))
    if coins is None:
        coins = Coins(chain); coins.refresh(); coins.start()
    files = files or TE.TickFiles(TICK_DIR, source=TB.SOURCE if chain == "base" else TE.SOURCE)
    pusher = pusher or _pusher()
    sp = state or state_path(chain)
    try:
        nxt = int(json.load(open(sp)).get("next") or 0)
    except Exception:
        nxt = 0
    lag, written, back, busy_since, note = Lag(clock), 0, 1.0, None, None
    last_flush, last_status, last_ok, asked, started = 0.0, 0.0, None, [], clock()
    while not (stop and stop()):
        if not switch():
            say(f"{SWITCH[chain]} is not on: stopping"); return
        t0 = clock()
        if not nxt:
            h = head_fn()
            if h is None:
                note = "the Portal's head did not answer"; _wire_error(chain, note)
                sleep(back); back = min(BACK_MAX_S, back * 2)
                continue
            nxt = h
        elif last_ok is None:
            h = head_fn()
            if h is not None and (h - nxt) * BLOCK_S[chain] > MAX_BEHIND_S:
                say(f"block {nxt} is over {MAX_BEHIND_S} s behind the head {h}: starting at the head (the chains pass covers the gap)")
                nxt = h
        if chain == "base" and not coins.pools:
            sleep(PACE_S[chain]); continue                     # no listed WETH pool yet: nothing to ask for
        try:
            asked.append(t0); asked = [a for a in asked if t0 - a < 60]
            req = urllib.request.Request(S.PORTAL + S.DATASET[chain] + "/stream",
                                         data=json.dumps(query(chain, nxt, coins.pools)).encode(), headers=S.UA)
            resp = urlopen(req, timeout=30)
            fresh = {}
            for line in resp:
                if not line.strip():
                    continue
                b = json.loads(line)
                n = (b.get("header") or {}).get("number")
                logs = S.block_logs(b)
                if not isinstance(n, int) or logs is None:
                    continue
                for mint, x, sym in (bnb_ticks if chain == "bsc" else base_ticks)(logs, coins):
                    if files.add(mint, x):
                        files.quote[mint] = sym
                        written += 1
                        fresh.setdefault(mint, []).append(x)
                        _meter(chain, mint, x)
                nxt = n + 1
                last_ok = clock()
            pusher.add(fresh_only(fresh, clock()))
            if busy_since is not None:
                say(f"the Portal answers again (busy since {time.strftime('%H:%M:%S', time.gmtime(busy_since))} UTC)")
                last_status = 0.0                              # said at once in the status
            back, busy_since, note = 1.0, None, None
            _beat(chain)
        except urllib.error.HTTPError as e:
            note = f"the Portal answered {e.code}" + (" (busy)" if e.code in (429, 503, 529) else "")
            busy_since = busy_since or clock(); _wire_error(chain, note)
            sleep(back); back = min(BACK_MAX_S, back * 2)
        except Exception as e:
            note = f"the Portal stream stopped ({type(e).__name__})"
            busy_since = busy_since or clock(); _wire_error(chain, note)
            sleep(back); back = min(BACK_MAX_S, back * 2)
        now = clock()
        if now - last_flush >= FLUSH_S:
            for m in files.flush(now):
                ts = [x["t"] for x in files.coins.get(m, {}).values()]
                if ts:
                    lag.add(max(0.0, now - max(ts) / 1000))
            last_flush = now
        if now - last_status >= STATUS_S:
            st = {"contract": "evm-live-1", "chain": chain, "as_of": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(now)),
                  "next": nxt, "reading": last_ok is not None and now - last_ok < 30, "busy_since": busy_since, "note": note,
                  "listed_coins": len(coins.listed), "pools": len(coins.pools) if chain == "base" else None,
                  "trades_written": written, "lag_trade_to_file": lag.figures(), "requests_last_min": len(asked),
                  "pushed": getattr(pusher, "sent", None), "push_failed": getattr(pusher, "failed", None),
                  "prices": {k: v[2] for k, v in coins.prices.items()}, "since": started}
            try:
                os.makedirs(os.path.dirname(sp), exist_ok=True)
                with open(sp + ".tmp", "w") as f:
                    json.dump(st, f)
                os.replace(sp + ".tmp", sp)
            except Exception:
                pass
            last_status = now
        wait = PACE_S[chain] - (clock() - t0)
        if wait > 0:
            sleep(wait)


if __name__ == "__main__":
    if sys.argv[1:2] == ["run"] and sys.argv[2:3] and sys.argv[2] in SWITCH:
        ch = sys.argv[2]
        try:
            os.nice(int(os.environ.get("PINR_ENGINE_NICE", "10")))     # below the site's feed server (line 1)
        except OSError:
            pass
        try:
            import control
            control.install()                                  # counted and switched on /control
        except Exception:
            pass
        import wires as _W
        _W.name(NAME[ch])
        run(ch, say=lambda s: print(time.strftime("%H:%M:%S"), s, flush=True))
    else:
        print(__doc__.split("\n\n")[0])
