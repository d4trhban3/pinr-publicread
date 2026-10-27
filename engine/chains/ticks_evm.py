"""Line 11:
a listed BNB coin's own trades as the feed's tick files (`frontend-feed/ticks/<0x address>.json`, contract "ticks-1", source
"BNB chain"), the shape SITE's reader takes (its message of 26 Oct): each trade's time, side, transaction and log index,
its price and size in dollars, and where the dollar figure came from. SITE builds the candles and the ribbon from them.

The trades are the launchpads' own events, read through SQD Portal (chains/bnb.py's trade pass, and its history for a coin
listed before its file existed). A trade's price is the launchpad's own price in its event (Four.meme's `price`, Flap's
`postPrice`, in its quote coin a token); its size the quote it moved (Flap's includes its fee); both in dollars at the
quote's price, named on each trade: BNB at Chainlink's BNB/USD feed on the chain; another quote coin (22 of 64 listed BNB
coins on 26 Oct: stock and gold tokens, USDT, USD1, BNCB…) at its own PancakeSwap pool anchored to Chainlink, the reader the
scorer uses (stage4/quote_price.py), which names no price for a pool too thin to read: that coin's trades are left out,
never guessed. Only 18-decimal quote coins are priced (the launchpads state their prices in 18 decimals). This service is
the files' only writer."""
from __future__ import annotations
import fcntl, json, math, os, time

LOCK_NAME = ".evm-ticks.lock"          # one lock for every 0x tick file, held only while a flush writes
KEEP = 500                             # a coin's newest trades kept in its file (SITE's reader shows these; 2,000 made 361 KB files)
SOURCE = "BNB chain"


def tick(side: str, t: float, tx: str, i: int, amount_raw: int, quote_raw: int, price_raw: int, q_usd: float, q_src: str,
         q_sym: str = "BNB") -> dict | None:
    """One trade in SITE's ticks-1 shape; None when it cannot carry its dollars (no tokens, no quote moved, no launchpad
    price, no price for the quote)."""
    if not (amount_raw and amount_raw > 0 and quote_raw and quote_raw > 0 and price_raw and price_raw > 0
            and isinstance(q_usd, (int, float)) and q_usd > 0 and t):
        return None
    q, price_q = quote_raw / 1e18, price_raw / 1e18
    if not (math.isfinite(price_q * q_usd) and math.isfinite(q * q_usd)):
        return None                                            # never a price that is not a number (the Base lesson of 26 Oct)
    x = {"t": int(t * 1000), "side": side, "sig": tx, "i": int(i), "price_usd": price_q * q_usd, "usd": q * q_usd}
    if q_sym == "BNB":
        x.update(bnb=q, price_bnb=price_q, price_usd_src=f"the launchpad's own price in its trade event, at {q_src}")
    else:
        x.update(quote_amount=q, price_quote=price_q, price_usd_src=f"the launchpad's own price in its trade event, in {q_sym}, at {q_src}")
    return x


class TickFiles:
    """Each listed coin's file: read once, added to by transaction and log index, its newest KEEP written whole (a new
    file renamed into place) when it changed. Two writers share a chain's files (the chain's live reader, chains/live_evm.py,
    and the chains service's pass, its fallback): a file another writer changed since this one last wrote it is read again
    and its trades kept before this one writes (a trade is the same trade in both: transaction and log index)."""
    def __init__(self, d: str, source: str = SOURCE):
        self.dir, self.coins, self.dirty, self.quote, self.source, self.mt = d, {}, set(), {}, source, {}

    def _disk(self, mint: str) -> dict:
        ticks = {}
        p = os.path.join(self.dir, mint + ".json")
        try:
            self.mt[mint] = os.path.getmtime(p)
            for x in json.load(open(p)).get("ticks") or []:
                if isinstance(x, dict) and x.get("sig"):
                    ticks[(x["sig"], x.get("i", 0))] = x
        except Exception:
            pass
        return ticks

    def _coin(self, mint: str) -> dict:
        if mint not in self.coins:
            self.coins[mint] = self._disk(mint)
        return self.coins[mint]

    def add(self, mint: str, x: dict) -> bool:
        c = self._coin(mint)
        k = (x["sig"], x["i"])
        if k in c:
            return False
        c[k] = x; self.dirty.add(mint)
        return True

    def has(self, mint: str) -> bool:
        return os.path.exists(os.path.join(self.dir, mint + ".json"))

    def flush(self, now: float | None = None) -> list:
        if not self.dirty:
            return []
        os.makedirs(self.dir, exist_ok=True)
        with open(os.path.join(self.dir, LOCK_NAME), "a") as lf:   # the team's W1 on evmlive: the two writers take turns, so
            fcntl.flock(lf, fcntl.LOCK_EX)                         # neither reads a file the other is about to replace
            try:
                return self._flush(now)
            finally:
                fcntl.flock(lf, fcntl.LOCK_UN)

    def _flush(self, now: float | None = None) -> list:
        now, done = now or time.time(), []
        for mint in sorted(self.dirty):
            p = os.path.join(self.dir, mint + ".json")
            try:
                changed = os.path.getmtime(p) != self.mt.get(mint)
            except OSError:
                changed = False
            if changed:                                        # the other writer wrote it since: its trades kept too
                for k, x in self._disk(mint).items():
                    self.coins[mint].setdefault(k, x)
            ticks = sorted(self.coins[mint].values(), key=lambda x: (x["t"], x["sig"], x["i"]))[-KEEP:]
            self.coins[mint] = {(x["sig"], x["i"]): x for x in ticks}
            body = {"contract": "ticks-1", "mint": mint, "source": self.source, "quote": self.quote.get(mint, "BNB"),
                    "read_at": time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime(now)) + ".%03dZ" % (int(now * 1000) % 1000), "ticks": ticks}
            tmp = p + ".%d.tmp" % os.getpid()
            with open(tmp, "w") as f:
                json.dump(body, f)
            os.replace(tmp, p)
            try:
                self.mt[mint] = os.path.getmtime(p)
            except OSError:
                pass
            done.append(mint)
        self.dirty.clear()
        return done


def add_trades(files: TickFiles, trades: list, listed: set, price_of) -> int:
    """trades: (kind, mint, side, t, tx, log index, tokens raw, quote raw, price raw) from bnb.trades_pass; only listed
    coins, each only when `price_of(mint)` gives its quote's (dollars, source, symbol). Ticks added."""
    n = 0
    for kind, mint, side, t, tx, i, amount_raw, quote_raw, price_raw in trades:
        p = price_of(mint) if mint in listed else None
        if not p:
            continue
        x = tick(side, t, tx, i, amount_raw, quote_raw, price_raw, p[0], p[1], p[2])
        if x and files.add(mint, x):
            files.quote[mint] = p[2]
            n += 1
    return n
