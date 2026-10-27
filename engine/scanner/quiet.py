"""a coin with no trade for 24 hours goes quiet. It leaves every list and tile (the feed reads
frontend-feed/_quiet.json), and no scoring, PINRai, X check, picture pass or other read is spent on it; only a cheap
batched check for a new trade runs (DexScreener, 30 coins a call, paced by its own reader). Its first new trade brings it
back and the 24-hour timer starts again. Nothing is deleted (232): a quiet coin keeps every file and row.

Quiet only on evidence: DexScreener answered for the coin, none of its pairs had a trade in the last 24 hours, and the
coin is at least 24 hours old (its launch time, else its oldest pair's). A coin DexScreener did not answer for, or lists
no pair for, keeps its state (missing stays missing). A trade the tape saw in the last 24 hours keeps a coin awake
without asking anyone. A hand request is still scored."""
from __future__ import annotations
import json, os, sqlite3, sys, threading, time, traceback

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path[:0] = [HERE, os.path.join(ROOT, "stage2")]

QUIET_S = 86400                 # 24 hours with no trade
WAKE_S = 600                    # a quiet coin is asked again after this long (the cheap wake check)
RECHECK_S = 3600                # an old, active coin is asked again after this long (has it gone quiet?)
PASS_S = 120
CALLS_MAX = 40                  # DexScreener requests a pass at most (30 coins each)
CACHE_S = 30
FEED_FILE = os.path.join(ROOT, "frontend-feed", "_quiet.json")   # "_": never read as a coin file
TICK_DIR = os.path.join(ROOT, "frontend-feed", "ticks")
_set = {"at": 0.0, "mints": set()}


def ensure(c) -> None:
    c.execute("CREATE TABLE IF NOT EXISTS quiet (mint TEXT PRIMARY KEY, state TEXT, quiet_since REAL, last_trade REAL, checked_at REAL, by TEXT)")


def quiet_set(db=None, now=None) -> set:
    """The coins quiet now (cached CACHE_S); every reader that spends work on a coin skips these. Unreadable = none."""
    now = now or time.time()
    if db is None and now - _set["at"] < CACHE_S:
        return _set["mints"]
    try:
        import scanner as S
        c = sqlite3.connect(f"file:{db or S.DB}?mode=ro", uri=True, timeout=5)
        try:
            got = {m for (m,) in c.execute("SELECT mint FROM quiet WHERE state='quiet'")}
        finally:
            c.close()
    except Exception:
        got = set() if db else _set["mints"]
    if db is None:
        _set.update(at=now, mints=got)
    return got


def is_quiet(mint: str) -> bool:
    return mint in quiet_set()


def tape_last(mint: str, tick_dir: str = TICK_DIR):
    """The latest trade the tape holds for this coin (seconds), or None."""
    try:
        d = json.load(open(os.path.join(tick_dir, mint + ".json")))
        ts = [t.get("t") for t in d.get("ticks") or [] if isinstance(t, dict) and isinstance(t.get("t"), (int, float))]
        return max(ts) / 1000 if ts else None
    except Exception:
        return None


def judge(pairs: list, launched, now: float):
    """'active', 'quiet' or None (unknown) from one coin's DexScreener pairs."""
    if not pairs:
        return None                                            # no pair listed: unknown, never quiet on a guess
    counts = [p.get("txns_h24") for p in pairs]
    if any(isinstance(n, int) and n > 0 for n in counts):
        return "active"
    if any(n is None for n in counts):
        return None                                            # a pair without its 24-hour count: unknown
    born = launched or min((p.get("created") for p in pairs if p.get("created")), default=None)
    if not born or now - born < QUIET_S:
        return None                                            # under a day old (or age unknown): not quiet
    return "quiet"


def solana_only(m: str) -> bool:
    return not str(m).startswith("0x")


def one_pass(c, coins, now=None, pairs_fn=None, tape_fn=tape_last, feed_file=FEED_FILE, calls_max=CALLS_MAX, own=solana_only) -> dict:
    """coins: [(mint, launched seconds or 0)] the site lists or the app's pool holds. Returns counts. `own`: the coins this
    pass looks after (the scanner's: Solana; CHAINS' service passes its own test for its 0x coins and its own pairs function),
    so neither pass asks about, or marks as checked, the other's rows."""
    now = now or time.time()
    ensure(c)
    coins = [(m, b) for m, b in coins if own(m)]
    rows = {m: (st, since, chk) for m, st, since, chk in c.execute("SELECT mint, state, quiet_since, checked_at FROM quiet") if own(m)}
    born = {m: b for m, b in coins}
    out = {"looked_at": 0, "asked": 0, "went_quiet": 0, "woke": 0, "quiet": 0}
    due = []
    for m in list(dict.fromkeys([m for m, _b in coins] + [m for m, r in rows.items() if r[0] == "quiet"])):
        st, _since, chk = rows.get(m, (None, None, None))
        b = born.get(m) or 0
        if st != "quiet" and b and now - b < QUIET_S:
            continue                                           # under a day old: cannot be quiet yet
        wait = WAKE_S if st == "quiet" else RECHECK_S
        if chk and now - chk < wait:
            continue
        t = tape_fn(m)
        if t and now - t < QUIET_S:                            # the tape saw a trade today: awake, nobody asked
            if st == "quiet":
                out["woke"] += 1
            c.execute("INSERT INTO quiet VALUES (?,?,?,?,?,?) ON CONFLICT(mint) DO UPDATE SET state='active', quiet_since=NULL, "
                      "last_trade=excluded.last_trade, checked_at=excluded.checked_at, by=excluded.by", (m, "active", None, t, now, "tape"))
            continue
        due.append(m)
    out["looked_at"] = len(due)
    due = due[:calls_max * 30]
    c.commit()                                                 # the team's F1 on 89960bb0: never a write open across the network read
    if due:
        if pairs_fn is None:
            import dexscreener
            pairs_fn = dexscreener.pairs
        got = pairs_fn(due) or {}
        out["asked"] = len(got)
        for m in due:
            if m not in got:
                continue                                       # no answer for its batch: unchanged
            verdict = judge(got[m], born.get(m), now)
            st = rows.get(m, (None,))[0]
            if verdict is None:
                c.execute("INSERT INTO quiet (mint, state, checked_at, by) VALUES (?,?,?,?) ON CONFLICT(mint) DO UPDATE SET checked_at=excluded.checked_at",
                          (m, st or "unknown", now, "DexScreener"))
                continue
            if verdict == "quiet":
                out["went_quiet"] += st != "quiet"
                c.execute("INSERT INTO quiet VALUES (?,?,?,?,?,?) ON CONFLICT(mint) DO UPDATE SET state='quiet', "
                          "quiet_since=COALESCE(quiet.quiet_since, excluded.quiet_since), checked_at=excluded.checked_at, by=excluded.by",
                          (m, "quiet", now, None, now, "DexScreener"))
            else:
                out["woke"] += st == "quiet"
                c.execute("INSERT INTO quiet VALUES (?,?,?,?,?,?) ON CONFLICT(mint) DO UPDATE SET state='active', quiet_since=NULL, "
                          "last_trade=excluded.last_trade, checked_at=excluded.checked_at, by=excluded.by", (m, "active", None, now, now, "DexScreener"))
    c.commit()
    write_feed_file(c, now, feed_file)
    out["quiet"] = c.execute("SELECT COUNT(*) FROM quiet WHERE state='quiet'").fetchone()[0]
    _set["at"] = 0.0                                           # the next ask reads the new state
    return out


def write_feed_file(c, now=None, path=FEED_FILE) -> None:
    """frontend-feed/_quiet.json for the feed: {"as_of", "window_s", "quiet": {mint: {"since", "checked", "by"}}}, whole."""
    iso = lambda t: time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(t)) if t else None
    body = {"contract": "quiet-1", "as_of": iso(now or time.time()), "window_s": QUIET_S,
            "quiet": {m: {"since": iso(since), "checked": iso(chk), "by": by}
                      for m, since, chk, by in c.execute("SELECT mint, quiet_since, checked_at, by FROM quiet WHERE state='quiet'")}}
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path + ".tmp", "w") as f:
        json.dump(body, f)
    os.replace(path + ".tmp", path)


def start(db, coins_fn, say=print) -> threading.Thread:
    def run():
        c = db()
        while True:
            try:
                got = one_pass(c, coins_fn() or [])
                if got.get("went_quiet") or got.get("woke"):
                    say(time.strftime("%H:%M:%S") + " quiet: " + ", ".join(f"{k} {v}" for k, v in got.items()))
            except Exception:
                traceback.print_exc()
            time.sleep(PASS_S)
    t = threading.Thread(target=run, name="quiet", daemon=True)
    t.start()
    return t
