"""PINR live scanner. Keeps the launch index current, watches the launchpads' own buy events, and scores a
token automatically once someone other than the dev has put at least $500 of real money in. Results go to the live
app's feed through the scorers' existing hook. Re-scored 1 h and 24 h after the trigger, then daily while it trades.
Anyone can submit a token to be scored right away.

  python3 scanner/scanner.py run            -> run forever (one cycle a minute)
  python3 scanner/scanner.py once           -> one cycle, then stop (for testing)
  python3 scanner/scanner.py request <chain> <token>   -> score this token as soon as possible
  python3 scanner/scanner.py status         -> what it's watching and scoring, and today's requests per source
  python3 scanner/scanner.py requests [day] -> one day's requests per outside source (UTC), for the usage ledger

Watching: BNB (Flap, four.meme) and Base (Clanker v4, Bankr on Doppler) buy events. Solana has no watcher of the chain or a
stream since 2026-10-13. A
Solana coin is scored when it is requested, when the site shows it unscored, when a re-score falls due,
or when it trips the trigger of a Pump.fun coin in the app's whole pool (every coin
its feed server holds), in its first hour, whose 1-hour volume and 1-hour buy count on DexScreener are both at their
lines in the same read. A queued coin is dropped only when it has left that whole pool; a coin asked for by hand is
never dropped; a first score that fails is retried up to three times an hour apart, re-scores paused or not.
"""
from __future__ import annotations
import json, os, signal, sqlite3, sys, time, traceback
from multiprocessing import get_context
HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
for p in ("stage2", "stage3", "stage4", "pinr-index", "index", "pinr-step2", "scanner"):
    sys.path.insert(0, os.path.join(ROOT, p))

DB = os.path.join(HERE, "scanner.sqlite")
TRIGGER_USD = 250.0                 # BNB and Base (example figure; PINR's own is withheld from the public copy)
SOLANA_TRIGGER_USD = 5000.0         # the Solana line (example figure; PINR's own is withheld): read on
                                    # DexScreener's 1-hour volume, both ways. The built-in figure; the settings carry it
TRIGGER_MIN_BUYS = 50                 # example figure (PINR's own is withheld): buy transactions in the last hour, in the same read
TRIGGER_FIRST_SECONDS = 3600        # the trigger looks at a coin in its first hour only
TRIGGER_RETRIES = 3                 # rules section 15: a queued coin's failed first score is retried this many times ...
TRIGGER_RETRY_AFTER = 3600          # ... an hour apart, whether or not re-scores are paused; then it is given up, shown by status
FOLLOWUP_SLOTS = 1                  # the team (step 7b): with re-scores on "follow-ups", ONE Solana worker is kept for follow-up re-scores
                                    # (it idles when none is due) and the others take first scores: a place kept, not a ceiling
_FOLLOWUP_RUNNING: set = set()      # the follow-up jobs in progress (keys of _RUNNING)
RESCORE_AFTER = [3600, 86400]       # then daily while trading
DAILY = 86400
WORKERS_DEFAULT = 5                 # the pool's size when the settings do not say (measured 2026-10-10: 6 added nothing while Helius paced us)


WORKERS_CEILING = 16                # the most scoring workers a run may start


def pool_workers(path=None) -> int:
    """How many scoring workers the pool starts with, from "scanner_workers" in scanner/settings.json (1 to 16), read once at
    start (the pool's size is fixed for the run; a change takes the one restart). the team's word of 2026-10-14 (order item 4):
    a sixth Solana worker, refusals watched for an hour after the restart. the team 2026-10-24: the ceiling 8 -> 16 (8 workers used
    6% CPU and 362 MB on the server; they wait on network reads). Not given or not usable: the built-in number."""
    try:
        with open(path or SETTINGS) as f:
            n = json.load(f).get("scanner_workers")
        return n if isinstance(n, int) and not isinstance(n, bool) and 1 <= n <= WORKERS_CEILING else WORKERS_DEFAULT
    except Exception:
        return WORKERS_DEFAULT

SOLANA_SLOTS = 2                    # Solana scores at once (back on 2026-10-10: launchpad sources replace Helius)
SITE_SLOTS = 1                      # of those, kept for coins the site is showing unscored
SITE_LIST_URL = "http://127.0.0.1:8787/api/launchpad/pumpfun?sort=%s&limit=200"   # the app server's live Pump.fun lists
SITE_LIST_SECONDS = 30
POOL_URL = "http://127.0.0.1:8787/api/launchpad/pumpfun?sort=new&limit=200&offset=%d"   # the app's whole pool, 200 a page
POOL_PAGES_MAX = 60                 # 12,000 coins: far above the pool (about 3,800 on 2026-10-13); a stop, not a window
SITE_MIN_AGE = 60                   # seconds: a younger coin is not yet settled on the chain (reads come back empty)
CYCLE_SECONDS = 60
FLAP_PORTAL = "0xe2ce6ab80874fa9fa2aae65d277dd6b8e65c9de0"
FOURMEME = "0x5c952063c7fc8610ffdb798152d69f0b9550762b"

# ------------------------------------------------------------------ data-set switch
SETTINGS = os.path.join(HERE, "settings.json")
WORKERS = pool_workers()            # the pool's size for this run (order item 4: six today)
CHAINS = ("solana", "bsc", "base")
_SCORING = {"chains": None, "note": None, "saved": None}     # chains None = no usable answer has been read yet


def _names(chains) -> str:
    return ", ".join(ch for ch in CHAINS if ch in (chains or ())) or "nothing"


def scoring_chains(path=None) -> set:
    """The chains whose coins are scored right now. The scanner scores ONLY the chains scanner/settings.json lists,
    and reads the file on every call, so pausing or resuming a chain is a change to that one file and needs no restart.
    Watching (launch index, buy events, the trade record) is not switched here: a paused chain's coins keep queueing.
    The file missing, damaged, or naming a chain the scanner does not know is never read as "score everything":
      - while the scanner runs, the last good answer stays in force;
      - when the scanner starts (no good answer yet), nothing is scored until the file is put right.
    Either way the reason is kept for the log."""
    try:
        with open(path or SETTINGS) as f:
            want = json.load(f)["score_chains"]
        if not isinstance(want, list) or any(ch not in CHAINS for ch in want):
            raise ValueError("score_chains must be a list drawn from " + ", ".join(CHAINS))
        _SCORING["chains"], _SCORING["note"] = set(want), None
    except Exception as e:
        why = "missing" if isinstance(e, FileNotFoundError) else f"not usable ({type(e).__name__})"
        if _SCORING["chains"] is None:
            _SCORING["note"] = f"settings.json {why} at start: scoring nothing until it is put right"
        else:
            _SCORING["note"] = f"settings.json {why}: still scoring {_names(_SCORING['chains'])}"
    return _SCORING["chains"] or set()


_SLOTS = {"n": None, "note": None}


def solana_slots(path=None) -> int:
    """How many of the scoring workers Solana may hold, from "solana_workers" in scanner/settings.json, read on every
    pass. A whole number from 1 to the number of workers. Not given = the built-in number. A value that cannot be used
    changes nothing: the last good number (or the built-in one) stays, and the log says so."""
    try:
        with open(path or SETTINGS) as f:
            want = json.load(f).get("solana_workers")
        if want is None:
            _SLOTS["n"], _SLOTS["note"] = SOLANA_SLOTS, None
        elif isinstance(want, bool) or not isinstance(want, int) or not 1 <= want <= WORKERS:
            raise ValueError
        else:
            _SLOTS["n"], _SLOTS["note"] = want, None
    except Exception:
        _SLOTS["note"] = f"WARNING solana_workers not usable: Solana keeps {_SLOTS['n'] or SOLANA_SLOTS} workers"
    return _SLOTS["n"] or SOLANA_SLOTS


_ERR_RETRIES = {"n": None, "note": None}


def error_retries(path=None) -> int:
    """How many times a score that ended in a technical error is tried again, an hour apart, from "solana_error_retries"
    in scanner/settings.json (0 to 10), read on every pass (the team's go, 2026-10-13: the engine promises an automatic
    retry; the scanner now makes it). Not given = the trigger's own retry count. A value that cannot be used keeps the
    last good one, and the log says so."""
    try:
        with open(path or SETTINGS) as f:
            want = json.load(f).get("solana_error_retries")
        if want is None:
            _ERR_RETRIES["n"], _ERR_RETRIES["note"] = TRIGGER_RETRIES, None
        elif isinstance(want, bool) or not isinstance(want, int) or not 0 <= want <= 10:
            raise ValueError
        else:
            _ERR_RETRIES["n"], _ERR_RETRIES["note"] = want, None
    except Exception:
        _ERR_RETRIES["note"] = f"WARNING solana_error_retries not usable: staying {_ERR_RETRIES['n'] if _ERR_RETRIES['n'] is not None else TRIGGER_RETRIES}"
    return _ERR_RETRIES["n"] if _ERR_RETRIES["n"] is not None else TRIGGER_RETRIES


_RESCORES = {"mode": None, "note": None}


def solana_rescores(path=None) -> str:
    """Whether Solana re-scores that have fallen due are started, from "solana_rescores" in scanner/settings.json, read
    on every pass (a design decision-10-13: the re-scores already queued wait until the cheaper full score is
    in). "on", or not given: they are started, newest first, as always. "paused": none is started; a coin asked for
    with `scanner.py request` and the coins the site shows unscored are still scored, and what is queued stays queued.
    "follow-ups" : as "paused", except that the 1-hour and 24-hour follow-up
    re-scores of the coins the DexScreener trigger queued are started; the daily backlog stays paused. A value that
    cannot be used changes nothing: the last good value stays, and with none yet they are paused (never read as "on");
    the log says so."""
    try:
        with open(path or SETTINGS) as f:
            want = json.load(f).get("solana_rescores", "on")
        if want not in ("on", "paused", "follow-ups"):
            raise ValueError
        _RESCORES["mode"], _RESCORES["note"] = want, None
    except Exception:
        _RESCORES["note"] = f"WARNING solana_rescores not usable: staying {_RESCORES['mode'] or 'paused'}"
    return _RESCORES["mode"] or "paused"


_ORDER = {"mode": None, "note": None}


def solana_queue_order(path=None) -> str:
    """How the trigger's queue is served, from "solana_queue_order" in scanner/settings.json, read on every pass (operator
    a design decision-10-13; rules section 15): "biggest", or not given: biggest first, by the 1-hour volume read at
    queue time, after any hand request; "newest": newest first, as before. A value that cannot be used changes nothing:
    the last good value stays (with none yet, biggest), and the log says so."""
    try:
        with open(path or SETTINGS) as f:
            want = json.load(f).get("solana_queue_order", "biggest")
        if want not in ("biggest", "newest"):
            raise ValueError
        _ORDER["mode"], _ORDER["note"] = want, None
    except Exception:
        _ORDER["note"] = f"WARNING solana_queue_order not usable: staying {_ORDER['mode'] or 'biggest'}"
    return _ORDER["mode"] or "biggest"


_TRIG = {"on": None, "line": None, "buys": None, "note": None}
_WAITING = "queued_at IS NOT NULL AND (last_ok IS NULL OR last_ok < queued_at)"     # queued by the trigger, no finished score since


def trigger_settings(path=None) -> dict:
    """The Solana trigger's settings, read on every pass, no restart:
    "solana_trigger" "on" or "off" (not given: off); "solana_trigger_volume_usd", the line the 1-hour volume must
    reach; "solana_trigger_min_buys", the fewest buy transactions in that hour. Not given: the built-in figures.
    A value that cannot be used changes nothing: the last good one stays (at the start: off, and the built-in
    figures), and the log says so."""
    notes = []
    try:
        with open(path or SETTINGS) as f:
            d = json.load(f)
        on, line, buys = d.get("solana_trigger", "off"), d.get("solana_trigger_volume_usd", SOLANA_TRIGGER_USD), d.get("solana_trigger_min_buys", TRIGGER_MIN_BUYS)
        if on in ("on", "off"):
            _TRIG["on"] = on == "on"
        else:
            notes.append("solana_trigger")
        stonk = d.get("stonkfun_launches", "off")                 # Stonk.fun's own list of new launches, keyless
        if stonk in ("on", "off"):
            _TRIG["stonk"] = stonk == "on"
        else:
            notes.append("stonkfun_launches")
        if isinstance(line, (int, float)) and not isinstance(line, bool) and line > 0:
            _TRIG["line"] = float(line)
        else:
            notes.append("solana_trigger_volume_usd")
        if isinstance(buys, int) and not isinstance(buys, bool) and buys >= 1:
            _TRIG["buys"] = buys
        else:
            notes.append("solana_trigger_min_buys")
    except Exception:
        notes.append("the settings file")
    _TRIG["note"] = ("WARNING not usable: " + ", ".join(notes) + ": the trigger keeps its last good settings") if notes else None
    return {"on": bool(_TRIG["on"]), "line": _TRIG["line"] or SOLANA_TRIGGER_USD, "buys": _TRIG["buys"] or TRIGGER_MIN_BUYS, "note": _TRIG["note"],
            "stonk": bool(_TRIG.get("stonk"))}


def watch_pumpfun(c, now=None, lists=None, read=None, stonk_list=None, gecko=None, verify=None) -> str:
    """The Solana trigger. The coins are the app's WHOLE pool of Pump.fun coins (every
    coin its feed server holds, read 200 a page, not a window of the newest or most traded); what is read is DexScreener,
    for the coins in their first hour. A coin in its first hour, not yet triggered, is queued for a score when ONE pair
    of it shows, in the same read, 1-hour volume at the line AND at least the minimum number of buys in that hour.
    Nothing is added up across pairs and nothing is guessed: a coin DexScreener did not answer for, or whose age is not
    known, is left for the next pass. A queued coin is dropped from the queue (and counted), not scored late, only when
    it has left the whole pool; a coin asked for by hand is never dropped; with no pool to look at (the feed server down,
    or any page unreadable), nothing is looked at and nothing is dropped. Returns words for the log.
    a Stonk.fun coin still on its LaunchLab curve is judged by the same two figures, but
    read from GeckoTerminal's own figures for its POOL (DexScreener lists no LaunchLab coin before graduation), through
    `gecko` (default `geckoterminal.figures`); it is queued only once `verify` (default: its pool's platform account read
    on chain, a design decision) says the pool is Stonk.fun's. Stonk.fun's own figures never queue a coin."""
    cfg = trigger_settings()
    if not cfg["on"]:
        return "off"
    now = now or time.time()
    coins = lists() if lists else _pool_mints()               # [(coin, when it was created or 0)], the whole pool
    if not coins:
        return "the app's pool could not be read whole: nothing looked at, nothing dropped"
    on_list = {m for m, _b in coins}
    # new Stonk.fun launches, from Stonk.fun's own ten-minute list, join the coins looked at (never the drop
    # rule: that list is a window, not a pool, so a coin leaving it has not gone anywhere). None = off, or unreadable.
    import routing as _RT                                     # Stonk.fun's list on or off on /control too
    stonk = (stonk_list() if stonk_list else _stonkfun_mints()) if cfg["stonk"] and _RT.discovery_on("stonkfun") else None
    stonk_rows = [(r[0], r[1], r[2] if len(r) > 2 else None) for r in (stonk or [])]       # (mint, launched, pool or None)
    stonk_on = {m for m, _b, _p in stonk_rows}
    stonk_pool = {m: p for m, _b, p in stonk_rows if p}
    busy = {k[1] for k in _RUNNING if k[0] == "solana"}
    gone = [t for (t,) in c.execute(f"SELECT token FROM tokens WHERE chain='solana' AND next_due IS NOT NULL AND next_due != 0 AND {_WAITING} "
                                    "AND (launchpad IS NULL OR launchpad != 'launchlab')")
            if t not in on_list and t not in busy]            # next_due 0 = asked for by hand: never dropped
    coins = coins + [(m, b) for m, b, _p in stonk_rows if m not in on_list]
    for t in gone:
        c.execute("UPDATE tokens SET next_due=NULL, dropped_at=? WHERE chain='solana' AND token=?", (now, t))
    done = set()
    names = list(on_list | stonk_on)                          # Q1: a Stonk.fun coin already queued is "done" too, not asked again
    for i in range(0, len(names), 500):
        part = names[i:i + 500]
        done.update(t for (t,) in c.execute(f"SELECT token FROM tokens WHERE chain='solana' AND triggered_at IS NOT NULL AND token IN ({','.join('?' * len(part))})", part))
    young = [(m, b) for m, b in coins if m not in done and (not b or now - b <= TRIGGER_FIRST_SECONDS)]
    if read is None:
        import dexscreener
        read = dexscreener.pairs
    young_pump = [m for m, _b in young if m not in stonk_on]
    got = read(young_pump) if young_pump else {}
    # the Stonk.fun coins are read from GeckoTerminal by their pool; a coin whose pool Stonk.fun did not name
    # cannot be read and stays unknown (counted in the words)
    pools = [stonk_pool[m] for m, _b in young if m in stonk_on and m in stonk_pool]
    if pools and gecko is None:
        import geckoterminal
        gecko = geckoterminal.figures
    figures = gecko(pools) if pools else {}
    if verify is None:
        verify = _stonk_pool_verified
    n, no_pool, unverified = 0, 0, 0
    for m, born in young:
        if m in stonk_on:
            if m not in stonk_pool:
                no_pool += 1
                continue                                          # no pool address from Stonk.fun's list: cannot be read
            f = figures.get(stonk_pool[m])
            if f is None or (f.get("mint") and f["mint"] != m):
                continue                                          # no answer, or the pool GeckoTerminal describes is not this coin's
            ps = [f]
        else:
            ps = got.get(m)
            if ps is None:
                continue                                          # no answer for it: unknown, looked at again next pass
        start = born or min([p["created"] for p in ps if p.get("created")], default=None)
        if not start or now - start > TRIGGER_FIRST_SECONDS:
            continue                                              # past its first hour, or its age is not known
        hit = next((p for p in ps if p.get("volume_h1") is not None and p.get("buys_h1") is not None
                    and p["volume_h1"] >= cfg["line"] and p["buys_h1"] >= cfg["buys"]), None)
        if hit is not None:
            if m in stonk_on and verify(m, stonk_pool[m]) is not True:
                unverified += 1
                continue                                          # the pool is not (yet) verified as Stonk.fun's: not queued on a guess
            c.execute("INSERT OR IGNORE INTO tokens (chain, token, launchpad, first_seen) VALUES ('solana',?,?,?)",
                      (m, "launchlab" if m in stonk_on else "pumpfun", now))
            cur = c.execute("UPDATE tokens SET triggered_at=?, next_due=?, queued_at=?, queue_volume_h1=?, queue_buys_h1=?, ok_since_queue=0 "
                            "WHERE chain='solana' AND token=? AND triggered_at IS NULL", (now, now, now, hit["volume_h1"], hit["buys_h1"], m))
            n += 1 if cur.rowcount == 1 else 0                 # Q1: counted only when this pass queued it
    c.commit()
    # every coin this pass looked at gets a feed file at once, "not scored yet", then its fee a budget a pass; only on
    # the real pool and list (a test that hands in lists writes no file)
    seen_words = ""
    if lists is None and stonk_list is None:
        try:
            import seen as _seen, stonkfun as _sf
            recs = [_POOL["records"][m] for m, _b in coins if m in _POOL["records"]] + [_sf.LAST_RECORDS[m] for m, _b, _p in stonk_rows if m in _sf.LAST_RECORDS]
            seen_words = "; seen: " + _seen.pass_seen(recs, now)
        except Exception as e:
            seen_words = f"; seen step failed ({type(e).__name__})"
    return (f"{n} queued of {len(young)} looked at (pool {len(coins)})" + (f"; {len(gone)} dropped unscored (left the app's pool)" if gone else "")
            + (f"; {len(stonk_rows)} Stonk.fun launches in their first hour, {len(pools)} read from GeckoTerminal"
               + (f", {no_pool} with no pool address" if no_pool else "") + (f", {unverified} at the line but not verified as Stonk.fun's" if unverified else "")
               + (f"; {_STONK['note']}" if not stonk_list and _STONK.get("note") else "")
               if stonk is not None else "; Stonk.fun's list could not be read whole" if cfg["stonk"] else "") + seen_words)


def _provider_note():
    """Said on every pass while the Solana provider list in the settings cannot be used (the workers then use the
    built-in free order), so a misspelt list is never silent."""
    try:
        import solana_rpc
        solana_rpc.provider_order(SETTINGS)
        return ("WARNING " + solana_rpc.ORDER_NOTE[0]) if solana_rpc.ORDER_NOTE[0] else None
    except Exception as e:
        return f"WARNING provider list could not be checked ({type(e).__name__})"


def _paused() -> str:
    """Plain words for the log: which chains are not being scored, or '' if none."""
    off = [ch for ch in CHAINS if ch not in (_SCORING["chains"] or ())]
    return ("paused: " + ", ".join(off)) if off else ""


def _save_scoring(c) -> None:
    """The running scanner writes down what it is scoring (when it changes, and once a minute), so that `status` and
    `request`, which are separate programs, can report what the scanner itself last said instead of guessing."""
    running = sum(1 for k in _RUNNING if k[0] == "solana")
    now = (sorted(_SCORING["chains"] or ()), _SCORING["note"], running, len(_FOLLOWUP_RUNNING))
    if _SCORING["saved"] and _SCORING["saved"][0] == now and time.time() - _SCORING["saved"][1] < 60:
        return
    c.execute("INSERT OR REPLACE INTO state (k, v, t) VALUES ('scoring', ?, ?)",
              (json.dumps({"chains": now[0], "note": now[1], "solana_running": now[2], "followups_running": now[3]}), time.time()))
    c.commit()
    _SCORING["saved"] = (now, time.time())


def _last_reported(c):
    """(chains, note, when) as last written down by a running scanner, or None if none ever has."""
    r = c.execute("SELECT v, t FROM state WHERE k='scoring'").fetchone()
    if not r:
        return None
    d = json.loads(r[0])
    return set(d["chains"]), d.get("note"), r[1], d.get("solana_running"), d.get("followups_running")


def _scoring_report(c) -> list:
    """Lines for `status`: what the scanner last said it was scoring (with the time), and what the file says now.
    This program is not the scanner, so it never states what the scanner is doing beyond what the scanner recorded."""
    rep = _last_reported(c)
    if rep is None:
        lines = ["scoring: no scanner has recorded what it is scoring yet"]
    else:
        chains, note, t = rep[0], rep[1], rep[2]
        off = [ch for ch in CHAINS if ch not in chains]
        lines = [f"scoring, as last recorded by the scanner at {time.strftime('%H:%M:%S', time.localtime(t))} "
                 f"({int(time.time() - t)} s ago): {_names(chains)}" + (f" | paused: {', '.join(off)}" if off else "")
                 + (f" | {note}" if note else "")]
    try:
        with open(SETTINGS) as f:
            want = json.load(f)["score_chains"]
        if not isinstance(want, list) or any(ch not in CHAINS for ch in want):
            raise ValueError
        lines.append(f"settings.json now lists: {_names(want)}")
    except Exception as e:
        why = "is missing" if isinstance(e, FileNotFoundError) else "is not usable"
        lines.append(f"settings.json now {why}: a running scanner keeps its last good answer; one started now scores nothing")
    return lines


def _when_scored(c, chain: str) -> str:
    """The second half of `request`'s answer, from what the scanner itself last recorded."""
    rep = _last_reported(c)
    if rep is None:
        return f"no scanner has recorded what it is scoring yet, so it waits for a running scanner that scores {chain}"
    chains, _note, t = rep[0], rep[1], rep[2]
    at = time.strftime("%H:%M:%S", time.localtime(t))
    if chain in chains:
        return f"the scanner last recorded ({at}) that it is scoring {chain}; if it is running, this is scored on a coming pass"
    return f"the scanner last recorded ({at}) that {chain} scoring is paused, so it waits until that chain is resumed"


def _meter_pump(res) -> None:
    """The Pump.fun record and holders reads a worker-machine worker made for one coin (it hands its tally in with the result), counted on the server's
    /control wires; only those two wires, only counts and a short refusal text. Never in the way of the hand-in."""
    try:
        import wires as _W
        for k, v in ((res.get("pump") if isinstance(res, dict) else None) or {}).items():
            if k in ("s_pump|coin record|a_token|Pump.fun", "s_pump|holders|a_token|Pump.fun") and isinstance(v, dict):
                if isinstance(v.get("n"), int) and v["n"] > 0:
                    _W.meter(k, v["n"], {"coin": res.get("mint")})
                if isinstance(v.get("error"), str) and v["error"]:
                    _W.error(k, v["error"][:200])
    except Exception:
        pass


def _worker_init():
    """Runs once in every scoring worker: a stop (SIGTERM, which the
    pool sends its workers when the main process ends or is stopped) exits the worker at once and quietly, instead of
    letting it finish its score and die writing the result to a parent that is gone (two tracebacks per worker)."""
    signal.signal(signal.SIGTERM, lambda *_: os._exit(0))
    signal.signal(signal.SIGINT, signal.SIG_IGN)                 # the main process handles a Ctrl-C; the workers follow it
    try:
        import control as _control                               # pinr.io/control's switches and the per-source record
        _control.install()
    except Exception:
        pass
    if os.environ.get("PINR_WORKER_WIRES") != "1":              # only the running service's workers write meter files (set by `run`/`once` below);
        return                                                   # a test's pool must not write into control/wires
    try:                                                         # each scoring worker names its meter file (worker-1 ...), so the
        import multiprocessing as _mp, wires as _W               # reads it makes (Pump.fun holders) reach /control; state() merges the files
        ident = (getattr(_mp.current_process(), "_identity", None) or (os.getpid(),))[0]          # a replacement worker (maxtasksperchild) gets the
        _W.name("worker-%d" % ((ident - 1) % 16 + 1))                                              # next number: 16 file names, never one a restart
    except Exception:
        pass


def _stop_main(*_):
    """The main process on SIGTERM (order item 4): leave the run loop so the pool's own exit stops the workers first."""
    raise SystemExit(0)


_LOCKS_GONE = [0]           # how many of the pool's locks were already gone when the main process cleaned up at its stop


def _quiet_lock_cleanup():
    """The stop stays quiet when the pool's locks are already gone (the server, 2026-10-17: logind's RemoveIPC had wiped
    /dev/shm, so the main process's exit cleanup printed one traceback per lock, six in all, on top of the real fault).
    Python's cleanup unlinks each lock by name and prints a traceback if the name is not there; this wraps that one
    call so a lock already gone is counted and noted once, in one plain line, and the stop goes on. A real fault in a
    worker is never hidden by this: it touches only the main process's cleanup of lock names, nothing else."""
    from multiprocessing import synchronize, util
    real = synchronize.sem_unlink

    def unlink(name):
        try:
            real(name)
        except FileNotFoundError:
            _LOCKS_GONE[0] += 1
    synchronize.sem_unlink = unlink

    def note():
        if _LOCKS_GONE[0]:
            print(f"NOTE at the stop {_LOCKS_GONE[0]} worker lock(s) were already gone (shared memory cleared while the scanner "
                  f"ran); the stop went on. If this repeats, the box clears /dev/shm: see ops/SERVER-INSTALL.md", file=sys.stderr, flush=True)
    util.Finalize(None, note, exitpriority=-1)      # runs after Python's own lock cleanups (priority 0), so the count is final


def _wal(c, path):
    """Write-ahead logging on a store several processes share (order item 4, the "database is locked" fault): readers no
    longer wait on a writer, and a writer waits only on another writer; set once per process and kept by the file."""
    try:                                                      # one cheap question per open; the file keeps the mode once set
        if c.execute("PRAGMA journal_mode").fetchone()[0] != "wal":
            c.execute("PRAGMA journal_mode=WAL")
    except sqlite3.OperationalError:
        pass


def db():
    c = sqlite3.connect(DB, timeout=60)
    _wal(c, DB)
    c.execute("""CREATE TABLE IF NOT EXISTS tokens (chain TEXT, token TEXT, launchpad TEXT, creator TEXT, quote TEXT,
                 outside_raw TEXT DEFAULT '0', outside_usd REAL DEFAULT 0, buyers INTEGER DEFAULT 0,
                 first_seen REAL, last_trade REAL, triggered_at REAL, last_scored REAL, scores INTEGER DEFAULT 0,
                 next_due REAL, last_result TEXT, PRIMARY KEY (chain, token))""")
    c.execute("CREATE TABLE IF NOT EXISTS cursor (chain TEXT PRIMARY KEY, block INTEGER)")
    c.execute("CREATE TABLE IF NOT EXISTS state (k TEXT PRIMARY KEY, v TEXT, t REAL)")
    c.execute("CREATE INDEX IF NOT EXISTS due ON tokens (next_due)")
    # early_at: left from the early scores; nothing reads or writes it now
    # queued_at: when the DexScreener trigger queued the coin; dropped_at: when it left that queue unscored
    # last_ok: when its last score FINISHED (a failed try stamps last_scored only); fails: failed tries in a row, 0 after a finished score
    # queue_volume_h1, queue_buys_h1: DexScreener's 1-hour figures of the pair that tripped the trigger, at the moment the coin was
    # queued. Read-only afterwards.
    for col, typ in (("pool_id", "TEXT"), ("paired", "TEXT"), ("team", "TEXT"), ("early_at", "REAL"), ("queued_at", "REAL"), ("dropped_at", "REAL"),
                     ("last_ok", "REAL"), ("fails", "INTEGER"), ("queue_volume_h1", "REAL"), ("queue_buys_h1", "INTEGER"),
                     ("ok_since_queue", "INTEGER"),   # finished scores since the trigger queued the coin (0 = none yet)
                     ("held_until", "REAL"), ("held_by", "TEXT")):   # a page coin handed to a machine, not started elsewhere until then
        try:
            c.execute(f"ALTER TABLE tokens ADD COLUMN {col} {typ}")
        except sqlite3.OperationalError:
            pass
    # Coins the trigger queued before this count existed: filled once, from what the record shows: a finished
    # score since the queue time counts as 1 (its 1-hour follow-up is next, due an hour after queueing: overdue ones run first),
    # none as 0. Only rows with no count yet are touched, so this is idle on every later start.
    fill = [t for (t,) in c.execute("SELECT token FROM tokens WHERE chain='solana' AND queued_at IS NOT NULL AND ok_since_queue IS NULL")]
    for i in range(0, len(fill), 500):                            # only the rows with no count yet: nothing else is ever touched
        part = fill[i:i + 500]                                    # again
        marks = ",".join("?" * len(part))
        c.execute("UPDATE tokens SET ok_since_queue = CASE WHEN last_ok IS NOT NULL AND last_ok > queued_at THEN 1 ELSE 0 END "
                  f"WHERE chain='solana' AND token IN ({marks})", part)
        c.execute(f"UPDATE tokens SET next_due = MIN(next_due, queued_at + {RESCORE_AFTER[0]}) WHERE chain='solana' AND token IN ({marks}) "
                  "AND ok_since_queue = 1 AND next_due IS NOT NULL", part)
    c.commit()
    c.execute("CREATE INDEX IF NOT EXISTS by_pool ON tokens (pool_id)")
    import evidence as _EV
    _EV.ensure(c)                                                 # the evidence table, kept for good (232)
    c.execute("CREATE INDEX IF NOT EXISTS by_early ON tokens (early_at) WHERE early_at > 0")   # coins holding an early score
    return c


# ------------------------------------------------------------------ BNB buy events (Flap TokenBought, four.meme TokenPurchase)
def _bnb_events():
    from evm import topic
    return {FLAP_PORTAL: (topic("TokenBought(uint256,address,address,uint256,uint256,uint256,uint256)"), 1, 2, 4),
            FOURMEME: (topic("TokenPurchase(address,address,uint256,uint256,uint256,uint256,uint256,uint256)"), 0, 1, 4)}


LAUNCHES_DB = os.path.join(ROOT, "index", "launches.sqlite")
# What is left of the EVM launch index: the file as it stood that day.
# Nothing adds to it any more, so a coin launched after that day is not in it. It is only read, and only if it is
# still there: with no file, or no row, the launchpad and creator are unknown (never guessed).


def _launch_row(sql: str, args) -> tuple | None:
    if not os.path.exists(LAUNCHES_DB):
        return None
    c = sqlite3.connect(f"file:{LAUNCHES_DB}?mode=ro", uri=True, timeout=60)
    try:
        return c.execute(sql, args).fetchone()
    except sqlite3.Error:
        return None
    finally:
        c.close()


def _creator(chain, token):
    r = _launch_row("SELECT launchpad, creator FROM launches WHERE chain=? AND token=?", (chain, token))
    return r if r else (None, None)


_PRICE_TTL = 600
_QUOTE_PRICES: dict = {}                    # quote token -> ((usd, decimals) or None, time), remembered 10 minutes


def _safe_prices(**kw):
    """Price lookups never stop the scanner: a refusal (e.g. rate limit) means 'unknown for now'."""
    from flap_reader import alchemy_prices_usd
    try:
        return alchemy_prices_usd(**kw)
    except Exception:
        return {}


def _quote_usd(c, chain, launchpad, token, cache):
    """USD per whole quote unit for this token's buys (BNB via Chainlink; other quotes from their own PancakeSwap pool)."""
    row = c.execute("SELECT quote FROM tokens WHERE chain=? AND token=?", (chain, token)).fetchone()
    quote = row[0] if row and row[0] else None
    if quote is None:
        import flap_reader as FL, fourmeme_reader as FM
        if launchpad == "flap":
            st = FL.state(token); quote = (st or {}).get("quoteTokenAddress")
        else:
            st = FM.info(token); quote = (st or {}).get("quote")
        if quote is None:
            return None, None
        quote = quote.lower()
    hit = _QUOTE_PRICES.get(quote)
    if hit and time.time() - hit[1] < _PRICE_TTL:
        return quote, hit[0]
    from evm import native_usd
    if int(quote, 16) == 0:
        p, _ = native_usd("bsc")
        p = p if p is not None else _safe_prices(symbols=("BNB",)).get("BNB", (None,))[0]
        dec = 18
    else:
        from quote_price import quote_usd
        try:
            p = quote_usd(quote)[0]
        except Exception:
            p = None
        from evm import call, selector
        d = call("bsc", quote, "0x" + selector("decimals()"))
        dec = int(d, 16) if d else None
    val = (p, dec) if (p is not None and dec is not None) else None
    if val is not None:
        _QUOTE_PRICES[quote] = (val, time.time())             # only remember real prices; unknown is retried next cycle
    return quote, val


MAX_BNB_BLOCKS = 2400                 # most BNB blocks read per pass (~30 minutes of chain at ~0.75 s a block)


def _prefetch_quotes(c, agg):
    """Which coin each new token trades against, for every new token in one batched read (instead of one request each)."""
    import flap_reader as FL, fourmeme_reader as FM
    from evm import multicall, selector, enc_address, words, dec
    known = {r[0] for r in c.execute("SELECT token FROM tokens WHERE chain='bsc' AND quote IS NOT NULL")}
    todo = [(tok, lp) for (tok, lp) in agg if tok not in known]
    if not todo:
        return
    calls = [(FL.PORTAL, "0x" + selector("getTokenV9Safe(address)") + enc_address(tok)) if lp == "flap" else
             (FM.HELPER, "0x" + selector("getTokenInfo(address)") + enc_address(tok)) for tok, lp in todo]
    for (tok, lp), out in zip(todo, multicall("bsc", calls)):
        if not out:
            continue
        try:
            if lp == "flap":
                q = {cc["name"]: dec(w, cc["type"]) for cc, w in zip(FL._STATE, words(out))}.get("quoteTokenAddress")
            else:
                w = words(out)
                q = dec(w[2], "address") if len(w) >= 12 else None
        except Exception:
            q = None
        if q:
            lp_i, creator = _creator("bsc", tok)                 # same row the watcher would create (dev from the launch index)
            c.execute("INSERT OR IGNORE INTO tokens (chain, token, launchpad, creator, first_seen) VALUES ('bsc',?,?,?,?)",
                      (tok, lp_i or lp, creator, time.time()))
            c.execute("UPDATE tokens SET quote=? WHERE chain='bsc' AND token=? AND quote IS NULL", (q.lower(), tok))


def watch_bnb(c, head):
    from evm import logs, words
    ev = _bnb_events()
    row = c.execute("SELECT block FROM cursor WHERE chain='bsc'").fetchone()
    frm = (row[0] + 1) if row else head - 200                   # first run: start from the last ~90 seconds
    to = min(head - 3, frm + MAX_BNB_BLOCKS - 1)                # after a long pause: catch up in steps, saving progress
    if to < frm:
        return 0
    lg, ok = logs("bsc", list(ev), [[t for t, *_ in ev.values()]][0], frm, to, workers=8, span=2000)
    if not ok:
        return 0                                                # retry this range next cycle (never skip blocks)
    now = time.time()
    agg = {}
    for l in lg:
        a = l["address"].lower()
        if a not in ev or l["topics"][0] != ev[a][0]:
            continue
        _, ti, bi, qi = ev[a]
        w = words(l["data"])
        tok, buyer, paid = "0x" + w[ti][-40:], "0x" + w[bi][-40:], int(w[qi], 16)
        agg.setdefault((tok.lower(), "flap" if a == FLAP_PORTAL else "fourmeme"), []).append((buyer.lower(), paid))
    _prefetch_quotes(c, agg)
    qcache, n = {}, 0
    for (tok, lp), buys in agg.items():
        r = c.execute("SELECT creator, outside_raw, buyers, triggered_at FROM tokens WHERE chain='bsc' AND token=?", (tok,)).fetchone()
        if r:
            creator, raw, nb, trig = r[0], int(r[1]), r[2], r[3]
        else:
            lp_i, creator = _creator("bsc", tok)
            raw, nb, trig = 0, 0, None
            c.execute("INSERT OR IGNORE INTO tokens (chain, token, launchpad, creator, first_seen) VALUES ('bsc',?,?,?,?)",
                      (tok, lp_i or lp, creator, now))
        outside = [(b, p) for b, p in buys if b != (creator or "")]
        raw += sum(p for _, p in outside)
        nb += len({b for b, _ in outside})
        usd = None
        if trig is None and raw > 0:
            quote, qv = _quote_usd(c, "bsc", lp, tok, qcache)
            if qv:
                usd = raw / 10 ** qv[1] * qv[0]
            c.execute("UPDATE tokens SET quote=? WHERE chain='bsc' AND token=?", (quote, tok))
        c.execute("UPDATE tokens SET outside_raw=?, buyers=?, last_trade=?" + (", outside_usd=?" if usd is not None else "") +
                  " WHERE chain='bsc' AND token=?", (str(raw), nb, now) + ((usd,) if usd is not None else ()) + (tok,))
        if trig is None and usd is not None and usd >= TRIGGER_USD:
            c.execute("UPDATE tokens SET triggered_at=?, next_due=? WHERE chain='bsc' AND token=?", (now, now, tok))
            n += 1
    c.execute("INSERT OR REPLACE INTO cursor VALUES ('bsc', ?)", (to,))
    c.commit()
    return n


# ------------------------------------------------------------------ Base: Clanker v4 launches + Uniswap v4 swaps
MAX_BASE_BLOCKS = 1200                # most Base blocks read per step (~40 minutes of chain at 2 s a block)
CATCHUP_SECONDS = 40                  # per pass and chain: keep taking steps this long while behind


def watch_base(c, head):
    """New Clanker v4 launches give token -> pool; each minute's PoolManager Swap events give the buys into those pools.
    The buyer is the transaction's signer (the swap 'sender' is a router). Paid amounts are in the pool's paired token."""
    import clanker_reader as C
    from evm import logs, words, rpc, native_usd
    from flap_reader import alchemy_prices_usd
    import solana_rpc as _S
    row = c.execute("SELECT block FROM cursor WHERE chain='base'").fetchone()
    frm = (row[0] + 1) if row else head - 45
    to = min(head - 3, frm + MAX_BASE_BLOCKS - 1)               # after a long pause: catch up in steps, saving progress
    if to < frm:
        return 0
    now = time.time()
    lg, ok = logs("base", C.FACTORY, C.TOKEN_CREATED, frm, to, workers=8)
    if not ok:
        return 0
    for l in lg:                                          # new launches: remember their pools and named dev wallets
        w = words(l["data"])
        tok, admin, sender = C._a(l["topics"][1]), C._a(l["topics"][2]), C._a(w[0])
        c.execute("INSERT OR IGNORE INTO tokens (chain, token, launchpad, creator, first_seen, pool_id, paired, team) "
                  "VALUES ('base',?,?,?,?,?,?,?)", (tok, "clanker", admin, now, "0x" + w[8], C._a(w[9]), json.dumps([admin, sender])))
    # Bankr (on Doppler): Airlock Create events; Bankr's when its fee wallet is the integrator (facts EVM file)
    import bankr_reader as B
    from evm import call, selector, enc_address, keccak256
    bl, ok = logs("base", B.AIRLOCK, B.CREATE, frm, to, workers=8)
    if not ok:
        return 0
    for l in bl:
        tok = C._a(words(l["data"])[0])
        ad = call("base", B.AIRLOCK, "0x" + selector("getAssetData(address)") + enc_address(tok))
        if not ad or C._a(words(ad)[9]) != B.BANKR_FEE_WALLET:
            continue
        hi = C._a(words(ad)[4])
        st = call("base", hi, "0x" + selector("getState(address)") + enc_address(tok)) if hi in B.VERIFIED_PARTS else None
        if not st:
            continue
        sw_ = words(st)
        pid = "0x" + keccak256(bytes.fromhex("".join(sw_[5:10]))).hex()
        bn = call("base", hi, "0x" + selector("getBeneficiaries(address)") + enc_address(tok))
        bw = words(bn) if bn else []
        team = [C._a(bw[2 + 2 * i]) for i in range(int(bw[1], 16))] if bw else []
        team = [x for x in team if x not in B.PLATFORM_WALLETS]
        c.execute("INSERT OR IGNORE INTO tokens (chain, token, launchpad, creator, first_seen, pool_id, paired, team) "
                  "VALUES ('base',?,?,?,?,?,?,?)", (tok, "bankr", team[0] if team else None, now, pid, C._a(words(ad)[0]), json.dumps(team)))
    sw, ok = logs("base", C.V4.POOLMANAGER["base"], C.SWAP, frm, to, workers=8, span=10)
    if not ok:
        return 0
    watched = {}
    for l in sw:
        pid = l["topics"][1].lower()
        if pid not in watched:
            r = c.execute("SELECT token, paired, team, triggered_at FROM tokens WHERE pool_id=?", (pid,)).fetchone()
            watched[pid] = r
        if not watched[pid]:
            continue
    buys = []
    for l in sw:
        r = watched.get(l["topics"][1].lower())
        if not r:
            continue
        tok, paired, team, trig = r
        w = words(l["data"])
        a0, a1 = C._int(w[0], 128), C._int(w[1], 128)
        tok_is0 = int(tok, 16) < int(paired, 16)
        got, paid = (a0, -a1) if tok_is0 else (a1, -a0)    # caller's view: received tokens, paid the paired token
        if got > 0 and paid > 0:
            buys.append((tok, paired, json.loads(team or "[]"), trig, l["transactionHash"], paid))
    if buys:
        froms = dict(zip([b[4] for b in buys], _S.pmap(lambda h: rpc("base", "eth_getTransactionByHash", [h]), [b[4] for b in buys], workers=8)))
    n, price = 0, {}
    eth_usd = native_usd("base")[0] or _safe_prices(symbols=("ETH",)).get("ETH", (None,))[0]
    per = {}
    for tok, paired, team, trig, h, paid in buys:
        t = froms.get(h)
        if not isinstance(t, dict):
            continue                                      # signer unreadable: this buy isn't counted (never assumed outside)
        if t["from"].lower() in {x.lower() for x in team}:
            continue
        per.setdefault((tok, paired, trig), []).append((t["from"].lower(), paid))
    for (tok, paired, trig), bs in per.items():
        if paired not in price:
            if paired == C.WETH:
                price[paired] = (eth_usd, 18)
            else:
                hit = _QUOTE_PRICES.get(paired)
                if hit and time.time() - hit[1] < _PRICE_TTL:
                    price[paired] = hit[0]
                else:
                    p = _safe_prices(addresses=(paired,), network=C.NETWORK).get(paired, (None,))[0]
                    d = C.erc20_int(paired, "decimals()")
                    price[paired] = (p, d) if (p is not None and d is not None) else None
                    if price[paired]:
                        _QUOTE_PRICES[paired] = (price[paired], time.time())
        r = c.execute("SELECT outside_raw, buyers FROM tokens WHERE chain='base' AND token=?", (tok,)).fetchone()
        raw = int(r[0]) + sum(p for _, p in bs)
        nb = r[1] + len({b for b, _ in bs})
        usd = raw / 10 ** price[paired][1] * price[paired][0] if price[paired] else None
        c.execute("UPDATE tokens SET outside_raw=?, buyers=?, last_trade=?" + (", outside_usd=?" if usd is not None else "") +
                  " WHERE chain='base' AND token=?", (str(raw), nb, now) + ((usd,) if usd is not None else ()) + (tok,))
        if trig is None and usd is not None and usd >= TRIGGER_USD:
            c.execute("UPDATE tokens SET triggered_at=?, next_due=? WHERE chain='base' AND token=?", (now, now, tok))
            n += 1
    c.execute("INSERT OR REPLACE INTO cursor VALUES ('base', ?)", (to,))
    c.commit()
    return n


# ------------------------------------------------------------------ scoring
def _score(job):
    t0 = time.time()
    job, res = _score_inner(job)
    res["seconds"] = round(time.time() - t0)
    return job, res


def _is_bot(token: str) -> bool:
    """a coin the gate marked as a bot launch gets no further score (read-only; unreadable: not a bot)."""
    try:
        import gate as _G
        g = sqlite3.connect(f"file:{DB}?mode=ro", uri=True, timeout=10)
        try:
            return _G.bot_of(g, token) is not None
        finally:
            g.close()
    except Exception:
        return False


def _score_inner(job):
    chain, token, launchpad = job
    if _is_bot(token):
        return job, {"error": "not scored: a bot launch"}
    try:
        if chain == "solana":
            os.chdir(os.path.join(ROOT, "stage2"))                # Stage 2 reads/writes relative to its own folder
            from run_stage2 import score_token as sol_score
            o = sol_score("live scan", token, None)
            return job, {k: o.get(k) for k in ("display", "label", "error", "coverage")}
        import run_evm as R
        if chain == "bsc":
            o = R.score_token(launchpad, token)
        elif launchpad == "clanker":
            o = R.score_clanker(token)
        elif launchpad == "clanker_old":
            o = R.score_clanker_old(token)
        elif launchpad == "bankr":
            o = R.score_bankr(token)
        else:
            return job, {"error": f"no scorer for {chain}/{launchpad}"}
        return job, {k: o.get(k) for k in ("display", "label", "error", "coverage")}
    except Exception as e:
        return job, {"error": f"{type(e).__name__}: {e}"[:300]}


_RUNNING: dict = {}                  # (chain, token, launchpad) -> scoring job still in progress
_SITE = {"at": 0.0, "mints": []}     # the site's live Pump.fun coins, newest first (refreshed every SITE_LIST_SECONDS)
_SITE_RUNNING: set = set()           # site-lane jobs in progress


_POOL = {"at": 0.0, "mints": [], "records": {}}     # the app's whole Pump.fun pool, newest first (refreshed every SITE_LIST_SECONDS), with the records' own fields


_STONK = {"at": 0.0, "seen": {}, "note": None}   # Stonk.fun launches in their first hour: mint -> (launched seconds, pool or None)
_VERIFIED: dict = {}                              # mint -> True/False once its pool's platform account was read


def _stonkfun_mints():
    """Stonk.fun's launches still in their first hour as [(mint, launched seconds, pool or None)]: the ten-minute list is read
    once per SITE_LIST_SECONDS and every launch it names is remembered for TRIGGER_FIRST_SECONDS, so a coin is looked at
    through its whole first hour, as the app's pool holds a Pump.fun coin. A launch whose time Stonk.fun did
    not give is dated when it was first seen (it was in the ten-minute list). None when the list could not be read whole
    and nothing is remembered; when a read fails with coins remembered, those are still looked at and the note says so."""
    now = time.time()
    if now - _STONK["at"] >= SITE_LIST_SECONDS:
        _STONK["at"] = now
        try:
            import stonkfun
            got = stonkfun.recent()
        except Exception:
            got = None
        if got is None:
            _STONK["note"] = "Stonk.fun's list could not be read this pass; the launches already seen are still looked at"
        else:
            _STONK["note"] = None
            for m, t, p in got:
                if m not in _STONK["seen"]:
                    _STONK["seen"][m] = (t or now, p)
                elif p and not _STONK["seen"][m][1]:
                    _STONK["seen"][m] = (_STONK["seen"][m][0], p)
        _STONK["seen"] = {m: v for m, v in _STONK["seen"].items() if now - v[0] <= TRIGGER_FIRST_SECONDS}
        if got is None and not _STONK["seen"]:
            return None
    return [(m, t, p) for m, (t, p) in _STONK["seen"].items()]


def _stonk_pool_verified(mint: str, pool: str):
    """True once the coin's LaunchLab pool, read on chain, names a platform account verified as Stonk.fun's (a design decision,
    `stage2/readers.py`); False when the pool is some other platform's, not a LaunchLab pool, or not this coin's; None when
    the pool or the platform account could not be read this time (unknown: asked again next pass). Only a definite answer
    is remembered per coin for the process, so a hit costs one read of each account."""
    if mint in _VERIFIED:
        return _VERIFIED[mint]
    try:
        sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "stage2"))
        import readers as R
        got = R.account_raw(pool)
        if got[0] is None:
            return None                                           # the pool account could not be read: unknown
        state = R.read_launchlab_pool(pool, mint, R.Log(), raw=got)
        if state is None:                                         # read, and not a LaunchLab pool of this coin: definite
            _VERIFIED[mint] = False
            return False
        pc = state["platform_config"]
        if pc in R.LAUNCHLAB_PLATFORMS:
            praw = R.account_raw(pc)
            if praw[0] is None:
                return None                                       # the platform account could not be read: unknown
            plat = R.launchlab_platform(pc, R.Log(), get=lambda a: praw)
        else:
            plat = R.launchlab_platform(pc, R.Log())              # not a listed account: no read, definite "unknown platform"
        hit = R.LAUNCHLAB_PLATFORMS.get(pc)
        _VERIFIED[mint] = bool(plat.get("verified")) and bool(hit) and hit[0] == "stonk"
        return _VERIFIED[mint]
    except Exception:
        return None


CROSSED_AFTER_S = 86400            # a "new coin" record made this long after the gate saw the same address launch is another coin's


def _crossed(coins: list) -> set:
    """the team 2026-10-26 (PUMP shown as "Blind Ape"): the app's Pump.fun records whose address the gate (Jupiter's record) saw
    launch long before the record's own creation time, under another name or ticker: a launch event that named an older coin's
    address, so its name, picture and launch time belong to another coin and the record is left out. One read of the gate; nothing left out when it cannot
    be read or the coin is not in it yet."""
    import gate as G
    rec = {x["mint"]: x for x in coins if x.get("createdMs")}
    if not rec:
        return set()
    try:
        c = sqlite3.connect(f"file:{DB}?mode=ro", uri=True, timeout=5)
        try:
            out = set()
            ms = list(rec)
            for i in range(0, len(ms), 500):
                part = ms[i:i + 500]
                for m, t, nk, sk in c.execute(f"SELECT mint, launched_at, name_key, symbol_key FROM gate WHERE launched_at IS NOT NULL AND mint IN ({','.join('?' * len(part))})", part):
                    x = rec[m]                              # an old coin the app lists again under its own name is that coin: kept
                    if x["createdMs"] / 1000 - t > CROSSED_AFTER_S and (G._key(x.get("name")), G._key(x.get("symbol"))) != (nk, sk):
                        out.add(m)
            return out
        finally:
            c.close()
    except Exception:
        return set()


def _pool_mints() -> list:
    """Every Pump.fun coin the app's feed server holds (its whole pool), newest first, as [(coin, created seconds or 0)],
    read 200 a page from the app on this machine. Whole or nothing: if any page cannot be read the answer is [] (the pool
    is unknown, so the trigger neither looks at nor drops anything this pass), never a part that looks complete."""
    if time.time() - _POOL["at"] < SITE_LIST_SECONDS:
        return _POOL["mints"]
    _POOL["at"] = time.time()
    import urllib.request
    out, seen, offset = [], set(), 0
    for _ in range(POOL_PAGES_MAX):
        try:
            d = json.load(urllib.request.urlopen(POOL_URL % offset, timeout=5))
        except Exception:
            _POOL["mints"] = []
            return []
        coins = [x for x in (d.get("coins") or []) if isinstance(x, dict) and isinstance(x.get("mint"), str)]
        crossed = _crossed(coins)
        for x in coins:
            if x["mint"] not in seen and x["mint"] not in crossed:
                seen.add(x["mint"]); out.append((x["mint"], (x.get("createdMs") or 0) / 1000))
                _POOL["records"][x["mint"]] = {"mint": x["mint"], "created": (x.get("createdMs") or 0) / 1000, "name": x.get("name"), "symbol": x.get("symbol"),
                                               "image": x.get("image"), "pool": None, "seen_by": "pumpfun_pool",     # for the seen file
                                               "graduated": x.get("graduated") is True}     # item 54: the launchpad's own record says it moved to PumpSwap
        offset += 200
        total = d.get("total")
        if len(coins) < 200 or (isinstance(total, int) and offset >= total):
            break
    out.sort(key=lambda mb: -mb[1])
    _POOL["mints"] = out
    return out


def _site_mints() -> list:
    """Coins the site is showing from Pump.fun's live lists: newest launches first, then most recently traded.
    Read from the app's own feed server on this machine; if it is not running the lane simply stays idle."""
    if time.time() - _SITE["at"] < SITE_LIST_SECONDS:
        return _SITE["mints"]
    _SITE["at"] = time.time()
    import urllib.request
    out, seen = [], set()
    for sort in ("new", "active"):
        try:
            d = json.load(urllib.request.urlopen(SITE_LIST_URL % sort, timeout=5))
        except Exception:
            continue
        coins = [x for x in (d.get("coins") or []) if isinstance(x, dict) and isinstance(x.get("mint"), str)]
        if sort == "new":
            coins.sort(key=lambda x: -(x.get("createdMs") or 0))
        crossed = _crossed(coins)
        for x in coins:
            if x["mint"] not in seen and x["mint"] not in crossed:
                seen.add(x["mint"]); out.append((x["mint"], (x.get("createdMs") or 0) / 1000))
    _SITE["mints"] = out
    return out


SHOWN_URL = "http://127.0.0.1:8787/api/tokens"               # the app's first page: the scored coins the site shows, in its order
_SHOWN = {"at": 0.0, "mints": [], "page": [], "pump": []}
REST_URL = "http://127.0.0.1:8787/api/tokens/rest"         # the site's browse list after its first page, in its order (500 a page)
_REST = {"at": 0.0, "page": []}   # pump: its Pump.fun coins (253); page: every Solana coin on the first page, scored or not, as (coin, launched seconds or 0)
_WANTED = {"at": 0.0, "coins": {}}                # the wanted list, {coin: ask time} 
FEED_DIR = os.path.join(ROOT, "frontend-feed")
TRIGGER_SEEN_FILE = os.path.join(FEED_DIR, "trigger-seen.json")   # coins the trigger saw in the last day: seen, dropped, scored (PINRbot's item)
SEEN_WINDOW = 86400


def _iso_utc(t) -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(t))


def trigger_seen(c, now=None) -> dict:
    """What the app may say about a coin the trigger saw: for every coin the
    trigger queued in the last day, when it was seen (queued), when it left the app's pool before its turn (dropped_at, else
    null) and when its first score since landed (scored_at, else null). Nothing of the line, the volumes or the order."""
    now = now or time.time()
    coins = {}
    for tok, q, d, ok in c.execute("SELECT token, queued_at, dropped_at, last_ok FROM tokens WHERE chain='solana' AND queued_at > ? ORDER BY queued_at DESC", (now - SEEN_WINDOW,)):
        coins[tok] = {"seen_at": _iso_utc(q), "dropped_at": _iso_utc(d) if d else None, "scored_at": _iso_utc(ok) if ok and ok >= q else None}
    return {"contract": "1.1", "as_of": _iso_utc(now), "coins": coins}


def write_trigger_seen(c, now=None, path=None) -> None:
    """Writes the file whole (a temporary file, then one rename), once a pass; never in the way of the scan."""
    try:
        path = path or TRIGGER_SEEN_FILE
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path + ".tmp", "w") as f:
            json.dump(trigger_seen(c, now), f)
        os.replace(path + ".tmp", path)
    except Exception:
        traceback.print_exc()


def _site_shown() -> list:
    """The scored Solana coins on the site's first page, in the site's order, read from the app's feed server on this
    machine every SITE_LIST_SECONDS; [] when it does not answer."""
    if time.time() - _SHOWN["at"] < SITE_LIST_SECONDS:
        return _SHOWN["mints"]
    _SHOWN["at"] = time.time()
    import urllib.request
    try:
        d = json.load(urllib.request.urlopen(SHOWN_URL, timeout=5))
        sol = [t for t in (d.get("tokens") or []) if isinstance(t, dict) and t.get("chain") == "solana" and isinstance(t.get("address"), str)]
        toks = [t for t in sol if t.get("score") is not None or (t.get("label") and t.get("note") != "Not scored yet")]
        _SHOWN["mints"] = [t["address"] for t in toks]
        born = lambda t: t["launchedAtMs"] / 1000 if isinstance(t.get("launchedAtMs"), (int, float)) and not isinstance(t.get("launchedAtMs"), bool) else 0.0
        _SHOWN["page"] = [(t["address"], born(t)) for t in sol]
        _SHOWN["pump"] = [(t["address"], born(t)) for t in sol if str(t.get("launchpad") or "").startswith(("Pump.fun", "PumpSwap"))]   # 253
    except Exception:
        _SHOWN["mints"], _SHOWN["page"], _SHOWN["pump"] = [], [], []
    return _SHOWN["mints"]


def _site_page() -> list:
    """Every Solana coin on the site's first page, scored or not, in the site's order, as (coin, launched seconds or 0): the
    same read as `_site_shown`; [] when the feed server does not answer."""
    _site_shown()
    return _SHOWN["page"]


def _site_rest() -> list:
    """The Solana coins of the site's browse list's first page (after its first page), in the site's order, as (coin,
    launched seconds or 0), read every SITE_LIST_SECONDS; [] when the feed server does not answer (S6, the team 26 Oct: a
    scored coin listed there but older than the pool's newest thousands never reached the gate's read)."""
    if time.time() - _REST["at"] < SITE_LIST_SECONDS:
        return _REST["page"]
    _REST["at"] = time.time()
    import urllib.request
    try:
        d = json.load(urllib.request.urlopen(REST_URL, timeout=5))
        born = lambda t: t["launchedAtMs"] / 1000 if isinstance(t.get("launchedAtMs"), (int, float)) and not isinstance(t.get("launchedAtMs"), bool) else 0.0
        _REST["page"] = [(t["address"], born(t)) for t in (d.get("tokens") or []) if isinstance(t, dict) and t.get("chain") == "solana"
                         and isinstance(t.get("address"), str)]
    except Exception:
        _REST["page"] = []
    return _REST["page"]


def _wanted_coins() -> dict:
    """The wanted list, {coin: ask time}: PINRbot's hand list and the site's own file, a day (`stage3/pinrbot.py` reads both),
    read every SITE_LIST_SECONDS; {} when it cannot be read."""
    if time.time() - _WANTED["at"] < SITE_LIST_SECONDS:
        return _WANTED["coins"]
    _WANTED["at"] = time.time()
    try:
        import pinrbot
        _WANTED["coins"] = {m: t for m, t in pinrbot._wanted().items() if not m.startswith("0x")}
    except Exception:
        _WANTED["coins"] = {}
    return _WANTED["coins"]


def _gate_first(c, page: list) -> list:
    """the team 2026-10-24 (after 244): the site's coins in scoring order: those the gate passed (237) first, then the rest,
    each newest launch first. The gate's result as last kept (gategraph's gate_events, one query); a coin with none kept
    counts as not passed. An unreadable store leaves the design's order (newest first) as it was."""
    page = sorted(page, key=lambda mb: -(mb[1] or 0))
    try:
        mints = [m for m, _b in page]
        passed = set()
        for i in range(0, len(mints), 500):
            part = mints[i:i + 500]
            passed.update(m for m, st in c.execute(
                f"SELECT e.mint, e.status FROM gate_events e JOIN (SELECT mint, MAX(at) a FROM gate_events WHERE mint IN ({','.join('?' * len(part))}) "
                "GROUP BY mint) l ON e.mint = l.mint AND e.at = l.a", part) if st == "passed")
    except sqlite3.Error:
        return page
    return [mb for mb in page if mb[0] in passed] + [mb for mb in page if mb[0] not in passed]


def _quiet(mint: str) -> bool:
    """no work is spent on a quiet coin (no trade for 24 hours); a hand request still is."""
    try:
        import quiet as Q
        return Q.is_quiet(mint)
    except Exception:
        return False


def _page_next(c, busy):
    """the coins a visitor can see are scored ahead of all others. The next coin, or None: a coin asked for by
    hand first, then a coin on the wanted list never scored (the latest ask first), then a coin on
    the site's first page never scored (the newest launch first; one younger than SITE_MIN_AGE waits, one with no launch time
    after the rest). Never scored = no score started yet: a coin whose score failed is left to the retries it already has,
    and a scored coin to its own re-scores."""
    now = time.time()
    for tok, lp in c.execute("SELECT token, launchpad FROM tokens WHERE chain='solana' AND next_due = 0").fetchall():
        if ("solana", tok) not in busy:
            return tok, lp or "pumpfun"
    page = _site_page()
    born = dict(page)
    wanted = sorted(_wanted_coins().items(), key=lambda mt: -mt[1])
    for mint in [m for m, _ in wanted] + [m for m, _ in _gate_first(c, page)]:
        if ("solana", mint) in busy or now - born.get(mint, 0.0) < SITE_MIN_AGE or _quiet(mint):   # 247: a quiet coin is not worked on
            continue
        r = c.execute("SELECT last_scored, launchpad, held_until, held_by FROM tokens WHERE chain='solana' AND token=?", (mint,)).fetchone()
        if r is None:
            c.execute("INSERT OR IGNORE INTO tokens (chain, token, launchpad, first_seen) VALUES ('solana',?,?,?)", (mint, "pumpfun", now))
            c.commit()
            return mint, "pumpfun"
        if r[2] and r[2] > now and r[3] == "mac":
            continue                                              # handed to the worker machine's workers: theirs until the hold ends
        if r[0] is None:
            return mint, r[1] or "pumpfun"
    return None


# ------------------------------------------------------------------ the worker machine's scoring workers (ops/PLAN-228-MAC-WORKERS.md)
HOLD_S = 600                         # a coin handed out is not started by the other machine for 10 minutes; then it goes back
LEASE_MAX = 16                       # coins lent to the worker machine in one ask: as many as it may run (extra_worker.WORKERS_MAX)
_MINT_RE = __import__("re").compile(r"^[1-9A-HJ-NP-Za-km-z]{32,44}$")
RESULT_KEYS = ("mint", "frame", "score", "display", "coverage", "readings", "receipts")
RESULTS_DIR = os.path.join(ROOT, "stage2", "results")
CODE_DIRS = ("stage2", "stage3", "stage4", "pinr-index", "pinr-step2", "feed", "scanner")
_URL_RE = __import__("re").compile(r"[A-Za-z][A-Za-z0-9+.-]*://\S+")


def quiet(text) -> str:
    """Error text with every address taken out."""
    return _URL_RE.sub("<address>", str(text))


def engine_stamp(root=None):
    """The engine's code as committed: a hash over every .py file's path and content id in the code folders at HEAD
   . The same on two machines exactly when they run the same code; a settings file, a document or
    a data file does not change it. None when git cannot answer."""
    import hashlib, subprocess
    root = root or ROOT
    try:                                                          # paths relative to the engine folder, whatever the clone's location
        out = subprocess.run(["git", "-C", root, "ls-tree", "-r", "HEAD", "--"] + list(CODE_DIRS), capture_output=True, text=True, timeout=30)
    except Exception:
        return None
    if out.returncode != 0:
        return None
    rows = sorted(line.split(None, 3)[2] + " " + line.split("\t", 1)[1] for line in out.stdout.splitlines() if line.endswith(".py") and "\t" in line)
    return hashlib.sha256("\n".join(rows).encode()).hexdigest() if rows else None


def _has_relay(mint: str) -> bool:
    """True when PINRbot's relay holds a reading for the coin (either copy): that coin stays on the server."""
    try:
        import pinrbot
        return any(os.path.exists(os.path.join(d, mint + ".json")) for d in (pinrbot.RELAY_COPY_DIR, pinrbot.RELAY_REPO_DIR))
    except Exception:
        return True                                               # unknown: the coin stays on the server


def lease(c, n, now=None) -> list:
    """Up to n coins for the worker machine's workers: the never-scored coins on the site's first page, newest launch first (decision
    224's order), each held for HOLD_S. Never a hand request, a coin on the wanted list, a coin with a relay reading, one
    younger than SITE_MIN_AGE, one already started or scored, or one held already: those stay with the server."""
    now = now or time.time()
    n = max(0, min(LEASE_MAX, int(n)))
    wanted = _wanted_coins()
    out = []
    for mint, born in _gate_first(c, _site_page()):
        if len(out) >= n:
            break
        if not _MINT_RE.match(mint) or mint in wanted or (born and now - born < SITE_MIN_AGE) or _has_relay(mint) or _quiet(mint):
            continue
        r = c.execute("SELECT last_scored, next_due, held_until FROM tokens WHERE chain='solana' AND token=?", (mint,)).fetchone()
        if r is None:
            c.execute("INSERT OR IGNORE INTO tokens (chain, token, launchpad, first_seen) VALUES ('solana',?,?,?)", (mint, "pumpfun", now))
        elif r[0] is not None or r[1] == 0 or (r[2] or 0) > now:
            continue
        c.execute("UPDATE tokens SET held_until=?, held_by='mac' WHERE chain='solana' AND token=?", (now + HOLD_S, mint))
        out.append(mint)
    c.commit()
    return out


def _feed_out(out):
    sys.path.insert(0, os.path.join(ROOT, "stage2"))
    from run_stage2 import _feed
    _feed(out)


def _remember(*args):
    import brakes
    brakes.remember(*args)


def hand_in(c, payload, now=None, results_dir=None, feed=None, remember=None, stamp=None) -> str:
    """One result from the worker machine's workers, handled exactly as the server's own score: the result file, the coin's feed file (with
    its chart event and score history), a new label in PINR's memory, the scanner's record. Only for a coin handed to the
    Mac and not scored on the server since, from an engine copy whose code is the server's own (W1); a result for another coin
    or not in the result's own shape is refused. A failure
    the worker machine reports is recorded as a failed try, so the coin goes to the retries it already has."""
    now = now or time.time()
    mint = payload.get("mint") if isinstance(payload, dict) else None
    if not isinstance(mint, str) or not _MINT_RE.match(mint):
        return "refused: not a Solana coin"
    r = c.execute("SELECT held_by, last_ok FROM tokens WHERE chain='solana' AND token=?", (mint,)).fetchone()
    if r is None or r[0] != "mac":
        return f"refused {mint}: not handed to the worker machine"
    if r[1] is not None:
        c.execute("UPDATE tokens SET held_until=NULL, held_by=NULL WHERE chain='solana' AND token=?", (mint,)); c.commit()
        return f"refused {mint}: scored on the server meanwhile"
    mine = (stamp or engine_stamp)()
    if mine is None or payload.get("engine") != mine:
        return f"refused {mint}: the worker machine's engine copy is not the server's (pull it); the coin goes back to the server when its hold ends"
    if payload.get("error") is not None:
        _record(c, "solana", mint, {"error": "worker-machine workers: " + quiet(payload["error"])[:200], "by": "mac"})
        c.execute("UPDATE tokens SET held_until=NULL, held_by=NULL WHERE chain='solana' AND token=?", (mint,)); c.commit()
        return f"{mint}: the worker machine's score failed; recorded as a failed try"
    out = payload.get("result")
    if not isinstance(out, dict) or out.get("mint") != mint or any(k not in out for k in RESULT_KEYS) or not isinstance(out.get("receipts"), list):
        return f"refused {mint}: not a result in the scorer's shape"
    d = results_dir or RESULTS_DIR
    os.makedirs(d, exist_ok=True)
    tmp = os.path.join(d, mint + ".json.tmp")
    with open(tmp, "w") as f:
        json.dump(out, f, indent=1, default=str)
    os.replace(tmp, os.path.join(d, mint + ".json"))
    (feed or _feed_out)(out)
    rem = payload.get("remember")
    if isinstance(rem, list) and len(rem) == 7 and rem[0] == mint and isinstance(rem[2], list):
        (remember or _remember)(*rem)
    res = {k: out.get(k) for k in ("display", "label", "error", "coverage")}
    res.update(by="mac", seconds=payload.get("seconds"))
    _record(c, "solana", mint, res)
    c.execute("UPDATE tokens SET held_until=NULL, held_by=NULL WHERE chain='solana' AND token=?", (mint,)); c.commit()
    return f"{mint}: handed in, {out.get('display')}"


LANE_RETRY_AFTER = 900              # the lane's second job: a coin it started is not started again for 15 minutes ...
LANE_TRIES = 3                      # ... and at most this many times without a finished score; then it is left
STALE_AFTER = 86400                 # a shown coin whose newest receipt is older than this is re-scored
_LANE_TRIED: dict = {}              # mint -> [starts without a finished score since, last_ok seen at the first of them]
LANE_TURNS = (0, 0, 1)              # the lane's one slot alternates: two unscored shown coins, then one from the
_LANE_TURN = [0]                    # second job; whichever job has nothing takes the other's turn, so neither starves


def _feed_facts(mint: str):
    """(has facts, when its newest fact was read as seconds, or None) from the coin's feed file; (False, None) with no file."""
    try:
        with open(os.path.join(FEED_DIR, "".join(ch for ch in mint if ch.isalnum()) + ".json")) as f:
            facts = json.load(f).get("facts") or []
    except Exception:
        return False, None
    import datetime
    times = []
    for x in facts:
        t = x.get("read_at") if isinstance(x, dict) else None
        try:
            times.append(datetime.datetime.fromisoformat(str(t).replace("Z", "+00:00")).timestamp())
        except Exception:
            pass
    return bool(facts), max(times) if times else None


def _site_next(c, busy):
    """The lane's next coin, or None: the newest coin on the site that has never been scored (and is not being scored now),
    or the second job: a coin the site shows whose feed file has no receipts yet, then one whose
    receipts are older than a day; two of the first for one of the second (L2), and the other job's turn when one has nothing.
    The daily backlog is untouched."""
    second_first = LANE_TURNS[_LANE_TURN[0] % len(LANE_TURNS)] == 1
    jobs = (_lane_second, _lane_unscored) if second_first else (_lane_unscored, _lane_second)
    for job in jobs:
        got = job(c, busy)
        if got:
            _LANE_TURN[0] += 1
            return got
    return None


def _lane_unscored(c, busy):
    for mint, born in _site_mints():
        if ("solana", mint) in busy or time.time() - born < SITE_MIN_AGE:
            continue
        r = c.execute("SELECT last_scored, launchpad FROM tokens WHERE chain='solana' AND token=?", (mint,)).fetchone()
        if r is None:
            c.execute("INSERT OR IGNORE INTO tokens (chain, token, launchpad, first_seen) VALUES ('solana',?,?,?)",
                      (mint, "pumpfun", time.time()))
            c.commit()
            return mint, "pumpfun"
        if r[0] is None:
            return mint, r[1] or "pumpfun"
    return None


def _lane_second(c, busy):
    # The second job: first the shown coins with no receipts at all (in the site's order), then the shown coins whose newest
    # receipt is older than STALE_AFTER (newest coin first); within the lane's one slot. A coin the lane started is not started
    # again for LANE_RETRY_AFTER, and after LANE_TRIES starts without a finished score it is left and the lane moves on (L1).
    now, picks = time.time(), []
    for i, mint in enumerate(_site_shown()):
        if ("solana", mint) in busy:
            continue
        r = c.execute("SELECT launchpad, last_scored, last_ok, first_seen FROM tokens WHERE chain='solana' AND token=?", (mint,)).fetchone()
        if r is None:
            continue
        lp, last_scored, last_ok, first_seen = r
        tried = _LANE_TRIED.get(mint)
        if tried and tried[1] != last_ok:
            tried = None                                          # a score finished since: the count starts afresh
        if tried and tried[0] >= LANE_TRIES:
            continue                                              # tried enough without a finished score: left
        if last_scored and now - last_scored < LANE_RETRY_AFTER:
            continue                                              # tried or finished less than 15 minutes ago: never twice in a row
        has, newest = _feed_facts(mint)
        if not has:
            picks.append((0, 0.0, i, mint, lp, last_ok))              # no receipts: in the site's order
        elif newest is not None and now - newest > STALE_AFTER:
            picks.append((1, -(first_seen or 0.0), i, mint, lp, last_ok))   # stale receipts: newest coin first
    if picks:
        picks.sort()
        _, _, _, mint, lp, last_ok = picks[0]
        tried = _LANE_TRIED.get(mint)
        _LANE_TRIED[mint] = [(tried[0] if tried and tried[1] == last_ok else 0) + 1, last_ok]
        return mint, lp or "pumpfun"
    return None


BOT_RECEIPT = "bot-speed wallets (first day)"               # stage2/run_stage2.py logs it when the bot brake is at its heavy level


def _mark_bot(c, ch, tok, failed, t) -> bool:
    """True when the coin is (now) a bot launch. A finished Solana score whose result carries BOT_RECEIPT marks
    it at the gate, in observed words, with the wallets and the first-day trades as receipts."""
    import gate as _G
    if _G.bot_of(c, tok):
        return True
    if failed or ch != "solana":
        return False
    try:
        o = json.load(open(os.path.join(RESULTS_DIR, tok + ".json")))
    except Exception:
        return False
    r = next((x for x in o.get("receipts") or [] if isinstance(x, dict) and x.get("what") == BOT_RECEIPT), None)
    v = (r or {}).get("value")
    if not isinstance(v, dict) or not v.get("wallets"):
        return False
    n = v.get("count") if isinstance(v.get("count"), int) else len(v["wallets"])
    known = _G.known_bots(c, v["wallets"], before=tok)        # the team 2026-10-26: wallets seen driving an earlier bot launch
    receipt = [{"what": "first-day trades", "value": v.get("share"), "unit": "share of first-day volume", "source": r.get("source"), "as_of": r.get("as_of")}]
    if v.get("level") == "bot_heavy":
        _G.mark_bot(c, tok, f"bot-speed trading was observed across this coin's first-day volume ({n} wallets)", v["wallets"],
                    "PINR's read (first-day trades)", receipt, t)
        return True
    if v.get("level") and known:                              # the brake fired, and wallets known from earlier bot launches drive it
        _G.mark_bot(c, tok, f"bot-speed trading by {len(known)} wallet(s) seen driving earlier bot launches was observed", known,
                    "PINR's read (first-day trades, known bot wallets)", receipt, t)
        return True
    return False


def _record(c, ch, tok, res):
    r = c.execute("SELECT triggered_at, scores, last_trade, last_scored, queued_at, last_ok, fails, ok_since_queue FROM tokens WHERE chain=? AND token=?", (ch, tok)).fetchone()
    trig, sc, last_trade, _, queued, last_ok, fails, since = r
    sc += 1
    t = time.time()
    tech = res.get("display") == "Technical error, retrying"     # the engine read nothing it could score: a failed score, retried
    failed = bool(res.get("error")) or tech
    waiting = queued is not None and (last_ok is None or last_ok < queued)     # in the trigger's queue: no finished score since it was queued
    fails = (fails or 0) + 1 if failed else 0
    since = since or 0                                            # finished scores since the trigger queued it
    if failed and waiting:                                        # rules section 15: retried up to TRIGGER_RETRIES times, an hour
        nxt = t + TRIGGER_RETRY_AFTER if fails <= TRIGGER_RETRIES else None   # apart, re-scores paused or not; then given up (status says so)
    elif failed and queued is not None:                           # a follow-up that failed: 15 minutes later, at most
        nxt = t + 900 if fails <= TRIGGER_RETRIES else None       # TRIGGER_RETRIES times, then given up; its failure stays in last_result
    elif failed and tech:                                         # a technical error on a coin asked for by hand or shown by the site: an hour
        nxt = t + TRIGGER_RETRY_AFTER if fails <= error_retries() else None   # later, error_retries() times at most; then the error stands
    elif failed:
        nxt = t + 900                                             # couldn't score (the worker itself failed): try again in 15 minutes, as before
    elif queued is not None and since < len(RESCORE_AFTER):
        nxt = queued + RESCORE_AFTER[since]                       # the trigger's coin: its 1-hour and 24-hour follow-ups count from the
                                                                  # queue time, whatever scores it had before
    elif trig is None:
        nxt = None                                                # submitted token: one score
    elif sc <= len(RESCORE_AFTER):
        nxt = trig + RESCORE_AFTER[sc - 1]
    else:
        nxt = t + DAILY                                           # daily; dropped below if it stopped trading
    try:                                                          # a finished score reaches the coin list and its prices the evidence
        import wires as _W
        if not failed:
            _W.meter("e_score|score|p_tokens|score", 1, {"coin": tok, "display": res.get("display"), "label": res.get("label")})
        else:
            _W.error("e_score|score|p_tokens|score", str(res.get("error") or res.get("display"))[:120])
    except Exception:
        pass
    if _mark_bot(c, ch, tok, failed, t):                      # a bot launch gets no further score
        nxt = None
    c.execute("UPDATE tokens SET scores=?, last_scored=?, last_ok=?, fails=?, ok_since_queue=?, next_due=?, last_result=? WHERE chain=? AND token=?",
              (sc - 1 if failed else sc, t, last_ok if failed else t, fails, since if failed else since + 1, nxt, json.dumps(res), ch, tok))
    if not failed and ch == "solana":                         # the finished score's facts into the evidence table
        try:
            import evidence as _EV
            if _EV.store_file(c, tok, RESULTS_DIR, t):
                _EV.write_coin_file(c, tok, FEED_DIR, t)          # 231 step 4: the coin's evidence file for the site
        except Exception:
            traceback.print_exc()                                 # the trail never stops a score being recorded
    c.commit()


def _is_followup(c, tok) -> bool:
    """A Solana score that is a follow-up re-score of a coin the trigger queued (it has a finished score since it was queued),
    as against a first score (a coin asked for by hand, shown by the site, or queued and not yet scored) or a retry of one."""
    r = c.execute("SELECT queued_at, ok_since_queue FROM tokens WHERE chain='solana' AND token=?", (tok,)).fetchone()
    return bool(r) and r[0] is not None and (r[1] or 0) >= 1


def dispatch(c, pool, wait=False):
    """Scoring runs beside the watchers: each cycle collects finished scores and starts new ones in free slots,
    so a slow token (Solana can take minutes) never holds up the minute-by-minute watching."""
    done = 0
    while True:
        _FOLLOWUP_RUNNING.intersection_update(_RUNNING)          # never counts a job that is no longer running
        for key, job in list(_RUNNING.items()):
            if job.ready():
                del _RUNNING[key]
                _SITE_RUNNING.discard(key)
                _FOLLOWUP_RUNNING.discard(key)
                try:
                    _, res = job.get()
                except Exception as e:
                    res = {"error": f"{type(e).__name__}: {str(e)[:120]}"}
                _record(c, key[0], key[1], res)
                done += 1
        # Only as many jobs as workers, and Solana (minutes per score) may hold at most SOLANA_SLOTS of them,
        # so BNB and Base scores (seconds each) always have a free worker.
        free = WORKERS - len(_RUNNING)
        sol_running = sum(1 for k in _RUNNING if k[0] == "solana")
        sol_free = solana_slots() - sol_running
        on = scoring_chains()                                     # data-set switch: a paused chain starts no new score
        mode = solana_rescores() if "solana" in on else "paused"
        # With re-scores on "follow-ups", FOLLOWUP_SLOTS of the Solana workers are kept for follow-ups and the rest take first
        # scores (the site lane, hand requests, the trigger's queue, retries): a place kept, not a ceiling (H1).
        first_cap = solana_slots() - (FOLLOWUP_SLOTS if mode == "follow-ups" else 0)
        first_running = sol_running - len(_FOLLOWUP_RUNNING)
        _save_scoring(c)
        if free > 0:
            busy = {(k[0], k[1]) for k in _RUNNING}
            due = []
            if on - {"solana"}:
                due = [d for d in c.execute(
                    "SELECT chain, token, launchpad FROM tokens WHERE next_due IS NOT NULL AND next_due <= ? "
                    "AND chain != 'solana' ORDER BY next_due", (time.time(),)).fetchall() if d[0] in on]
            # Solana: a coin asked for by hand first; then the trigger's queue biggest first, by the 1-hour volume read at
            # queue time (a design decision; "newest" in the settings gives the old order); the rest newest first behind them
            if "solana" in on:
                # re-scores paused: the pause is for re-scores only. Started anyway: a coin asked for by
                # hand (`request` marks it due at 0), the coins the trigger queued and nobody has scored since (rules
                # section 15), and the retry of a FIRST score that failed (no finished score yet; the team's R1 on
                # `ecb94a1`). "follow-ups" (step 7b): also the 1-hour and 24-hour follow-ups of the coins the trigger
                # queued (their second and third scores); the daily backlog stays paused. Asked for first, then the order setting.
                started_anyway = f"next_due = 0 OR ({_WAITING}) OR (last_ok IS NULL AND COALESCE(fails, 0) > 0)"
                held = f" AND ({started_anyway})" if mode in ("paused", "follow-ups") else ""
                by_size = "COALESCE(queue_volume_h1, 0) DESC, " if solana_queue_order() == "biggest" else ""   # a design decision
                due = c.execute("SELECT chain, token, launchpad FROM tokens WHERE next_due IS NOT NULL AND next_due <= ? "
                                "AND chain = 'solana'" + held + " ORDER BY (next_due = 0) DESC, " + by_size + "next_due DESC LIMIT 50", (time.time(),)).fetchall() + due
                if mode == "follow-ups":                          # the trigger's 1-hour and 24-hour follow-ups, oldest due first, behind
                    due += c.execute(f"SELECT chain, token, launchpad FROM tokens WHERE next_due IS NOT NULL AND next_due <= ? AND chain = 'solana' "
                                     f"AND queued_at IS NOT NULL AND ok_since_queue BETWEEN 1 AND {len(RESCORE_AFTER)} AND NOT ({started_anyway}) "
                                     "ORDER BY next_due ASC LIMIT 10", (time.time(),)).fetchall()
            hand = {t for (t,) in c.execute("SELECT token FROM tokens WHERE chain='solana' AND next_due = 0")}
            due = [d for d in due if d[0] != "solana" or d[1] in hand or not _quiet(d[1])]   # no re-score of a quiet coin (a hand request still runs)
            # (Solana is listed first but may hold at most SOLANA_SLOTS workers, so each side always gets its share)
            # Page lane: every first-score worker serves the coins a visitor can see before anything below:
            # hand requests, then the wanted list, then the site's first page, newest first. The follow-up worker stays kept.
            while "solana" in on and sol_free > 0 and free > 0 and first_running < first_cap:
                nxt = _page_next(c, busy)
                if nxt is None:
                    break
                key = ("solana", nxt[0], nxt[1])
                _RUNNING[key] = pool.apply_async(_score, (key,))
                c.execute("UPDATE tokens SET held_until=?, held_by='air' WHERE chain='solana' AND token=?", (time.time() + HOLD_S, nxt[0]))
                c.commit()                                        # never handed to the worker machine while the server scores it
                busy.add(("solana", nxt[0]))
                free -= 1
                sol_free -= 1
                first_running += 1
            # Site lane: one Solana slot serves coins the site shows with no score yet, newest first. A fresh coin
            # scores in well under a minute; these get one score, and the normal trigger line re-scores them later.
            while "solana" in on and sol_free > 0 and free > 0 and first_running < first_cap and len(_SITE_RUNNING) < SITE_SLOTS:
                nxt = _site_next(c, busy)
                if nxt is None:
                    break
                key = ("solana", nxt[0], nxt[1])
                _RUNNING[key] = pool.apply_async(_score, (key,))
                _SITE_RUNNING.add(key)
                busy.add(("solana", nxt[0]))
                free -= 1
                sol_free -= 1
                first_running += 1
            for ch, tok, lp in due:
                if free <= 0:
                    break
                if (ch, tok) in busy or (ch == "solana" and sol_free <= 0):
                    continue
                followup = ch == "solana" and _is_followup(c, tok)
                if followup and len(_FOLLOWUP_RUNNING) >= FOLLOWUP_SLOTS:
                    continue                                      # the follow-up worker is busy: this one waits
                if ch == "solana" and not followup and first_running >= first_cap:
                    continue                                      # the first-score workers are all busy; the kept place is not theirs
                _RUNNING[(ch, tok, lp)] = pool.apply_async(_score, ((ch, tok, lp),))
                if followup:
                    _FOLLOWUP_RUNNING.add((ch, tok, lp))
                elif ch == "solana":
                    first_running += 1
                busy.add((ch, tok))
                free -= 1
                sol_free -= ch == "solana"
        _save_scoring(c)                                          # what is running now, after this round's starts, for `status`
        if not wait or not _RUNNING:
            break
        time.sleep(2)
    # daily re-scores only while still trading: no trade since the last score -> stop
    c.execute("UPDATE tokens SET next_due=NULL WHERE scores > ? AND next_due IS NOT NULL AND last_trade < last_scored",
              (len(RESCORE_AFTER),))
    c.commit()
    return f"{done} finished, {len(_RUNNING)} in progress" + "".join(f"; {x}" for x in (_paused(), _SCORING["note"], _SLOTS["note"], _RESCORES["note"], _provider_note()) if x)


def request(chain: str, token: str) -> None:
    c = db()
    token = token.lower() if token.startswith("0x") else token
    if chain == "solana":                                         # as the site lane queues one: the scorer reads the rest
        lp, creator = "pumpfun", None
    else:
        lp, creator = _creator(chain, token)
        if lp is None:
            print("not in what is left of the launch index for that chain (nothing has been added to it since 2026-10-13)"); return
    lp = "clanker_old" if (lp == "clanker" and c is not None and _version(chain, token) != "v4") else lp
    c.execute("INSERT OR IGNORE INTO tokens (chain, token, launchpad, creator, first_seen) VALUES (?,?,?,?,?)",
              (chain, token, lp, creator, time.time()))
    c.execute("UPDATE tokens SET next_due=? WHERE chain=? AND token=?", (0, chain, token))
    c.commit()
    print(f"queued {chain} {token} ({lp}); " + _when_scored(c, chain))


def _version(chain, token):
    r = _launch_row("SELECT version FROM launches WHERE chain=? AND token=?", (chain, token))
    return r[0] if r else None


def cycle(pool, wait=False) -> dict:
    from evm import rpc
    c = db()
    out = {}
    took = {}
    def step(name, fn):
        t_ = time.time()
        try:
            out[name] = fn()
        except Exception as e:                                    # one watcher failing never stops the others
            out[name] = f"error: {type(e).__name__}: {str(e)[:80]}"
        took[name.split("_")[0]] = round(time.time() - t_)
    for chain in ("bsc", "base"):
        if chain not in scoring_chains():                         # a watcher reads blocks only for a chain that is scored
            out[f"{chain}_triggered"] = "off (chain not scored)"  # 
            continue
        def run_chain(chain=chain):
            head = int(rpc(chain, "eth_blockNumber", []), 16)
            t0, n = time.time(), 0
            while True:                                           # behind after a pause: several capped steps per pass
                before = (c.execute("SELECT block FROM cursor WHERE chain=?", (chain,)).fetchone() or [None])[0]
                n += (watch_bnb if chain == "bsc" else watch_base)(c, head) or 0
                after = (c.execute("SELECT block FROM cursor WHERE chain=?", (chain,)).fetchone() or [None])[0]
                if after is None or after == before or after >= head - 3 or time.time() - t0 > CATCHUP_SECONDS:
                    break
            if after is not None and head - after > 50:
                out[f"{chain}_behind"] = f"{head - after} blocks"
            return n
        step(f"{chain}_triggered", run_chain)
    if trigger_settings()["on"]:
        step("solana_triggered", lambda: watch_pumpfun(c))
    if _TRIG["note"]:
        out["trigger_note"] = _TRIG["note"]
    step("scored", lambda: dispatch(c, pool, wait))
    out["seconds"] = took
    return out


def requests_report(day=None) -> list:
    """The day's requests per outside source (UTC; default today), one plain line each, for PINR_Budget's usage ledger
    (schedule step 5): sent, answered, refused, held back by our own pacing, and the busiest minute."""
    try:
        import solana_rpc
        return solana_rpc.report(day)
    except Exception as e:
        return [f"request count not readable ({type(e).__name__})"]


def status() -> None:
    c = db()
    tot, trig, scored = c.execute("SELECT COUNT(*), SUM(triggered_at IS NOT NULL), SUM(scores > 0) FROM tokens").fetchone()
    due = c.execute("SELECT COUNT(*) FROM tokens WHERE next_due IS NOT NULL AND next_due <= ?", (time.time(),)).fetchone()[0]
    print(f"tokens watched {tot} | triggered ($500+ from others) {trig or 0} | scored {scored or 0} | due now {due}")
    for line in _scoring_report(c):
        print(line)
    print(f"Solana may hold {solana_slots()} of {WORKERS} scoring workers" + (f" | {_SLOTS['note']}" if _SLOTS["note"] else ""))
    waiting = c.execute("SELECT COUNT(*) FROM tokens WHERE chain='solana' AND next_due > 0 AND next_due <= ?", (time.time(),)).fetchone()[0]
    print(f"Solana re-scores: {solana_rescores()}" + (f" | {_RESCORES['note']}" if _RESCORES["note"] else "")
          + f" | due and waiting {waiting} (a coin asked for by hand, and coins the site shows unscored, are scored either way)")
    t = trigger_settings()
    queue = c.execute(f"SELECT COUNT(*) FROM tokens WHERE chain='solana' AND next_due IS NOT NULL AND {_WAITING}").fetchone()[0]
    hour = c.execute("SELECT SUM(queued_at > ?), SUM(dropped_at > ?), SUM(fails > ? AND next_due IS NULL AND last_scored > ?) FROM tokens WHERE chain='solana'",
                     (time.time() - 3600, time.time() - 3600, TRIGGER_RETRIES, time.time() - 3600)).fetchone()
    print(f"Solana trigger (DexScreener): {'on' if t['on'] else 'off'}" + (f" | {t['note']}" if t["note"] else "")
          + f" | 1-hour volume at ${t['line']:,.0f} and {t['buys']} buys or more | queue: {queue} waiting, {'biggest first by the 1-hour volume at queue time' if solana_queue_order() == 'biggest' else 'newest first'}, hand requests before all"
          + (f" ({_ORDER['note']})" if _ORDER["note"] else "") + f" (a failed first score waits an hour and is retried, {TRIGGER_RETRIES} times at most)"
          + f" | last hour: {hour[0] or 0} queued, {hour[1] or 0} dropped unscored (left the app's pool), {hour[2] or 0} given up after {TRIGGER_RETRIES} failed retries")
    hour_ago = time.time() - 3600
    firsts = c.execute("SELECT COUNT(*) FROM tokens WHERE chain='solana' AND last_ok > ? AND ((queued_at IS NOT NULL AND ok_since_queue = 1) OR (queued_at IS NULL AND scores = 1))", (hour_ago,)).fetchone()[0]
    follow = c.execute("SELECT COUNT(*) FROM tokens WHERE chain='solana' AND last_ok > ?", (hour_ago,)).fetchone()[0] - firsts
    rep = _last_reported(c)
    running = (f"{rep[3]} Solana scores, of them {rep[4]} follow-up (at most {FOLLOWUP_SLOTS} worker), as the scanner last recorded at "
               f"{time.strftime('%H:%M:%S', time.localtime(rep[2]))}") if rep and rep[3] is not None else "not recorded by the scanner yet"
    print(f"Solana scores finished in the last hour: {firsts} first scores, {follow} follow-ups or re-scores | in progress: {running}")
    for line in requests_report():
        print(line)
    for row in c.execute("SELECT chain, token, launchpad, round(outside_usd), buyers, scores, last_result FROM tokens "
                         "WHERE triggered_at IS NOT NULL ORDER BY triggered_at DESC LIMIT 10"):
        print("  ", row)


ENGINE_NICE = int(os.environ.get("PINR_ENGINE_NICE", "10"))   # the scanner and its workers run below the feed server (line 1)

if __name__ == "__main__":
    import io, contextlib
    cmd = sys.argv[1] if len(sys.argv) > 1 else "status"
    if cmd == "request":
        request(sys.argv[2], sys.argv[3])
    elif cmd == "status":
        status()
    elif cmd == "lease":                                       # python3 scanner/scanner.py lease N (the worker machine's workers)
        import wires as _W
        _W.name("mac-lease")
        got = lease(db(), int(sys.argv[2]))
        _W.meter("a_pool|coin list|a_mac|coin list", len(got) if isinstance(got, list) else 0, got[0] if isinstance(got, list) and got else None)
        print(json.dumps(got))
    elif cmd == "handin":                                      # one result as JSON on standard input
        import wires as _W
        _W.name("mac-handin")
        res = json.load(sys.stdin)
        said = hand_in(db(), res)
        if isinstance(res, dict) and not res.get("error"):
            _W.meter("a_mac|chain rows|e_score|evidence", 1, {"coin": res.get("mint"), "display": res.get("display")})
            _W.meter("a_mac|chain rows|e_build|chain rows", 1, {"coin": res.get("mint"), "receipts": len(res.get("receipts") or [])})
        _meter_pump(res)
        print(said)
    elif cmd == "evidence-backfill":                           # the team, after 231 step 4: rows and files from the results on disk, the page first
        import evidence as _EV
        page = [m for m, _b in _site_page()]
        print(json.dumps(_EV.backfill(db(), RESULTS_DIR, FEED_DIR, first=page, say=lambda l: print(l, flush=True))))
    elif cmd == "evidence":                                    # python3 scanner/scanner.py evidence <coin>
        import evidence as _EV
        for r in _EV.for_coin(db(), sys.argv[2]):
            print(("●" if r["onchain"] else "○"), r["from_kind"], r["from_id"][:12], "->", r["to_kind"], str(r["to_id"])[:40], "|", r["what"], "|", (r["value"] or "")[:60], "|", r["link"] or "")
    elif cmd == "requests":                                   # python3 scanner/scanner.py requests [YYYY-MM-DD]
        for line in requests_report(sys.argv[2] if len(sys.argv) > 2 else None):
            print(line)
    elif cmd in ("once", "run"):
        if cmd == "run":
            try:                                               # the operator's yes, 26 Oct (line 1): the engine yields the server's CPU to
                os.nice(ENGINE_NICE)                           # the site's feed server; its scoring workers inherit it
            except OSError:
                pass
        import wires as _W
        _W.name("scanner")                                      # this service's wire meters
        os.environ["PINR_WORKER_WIRES"] = "1"                   # its spawned scoring workers name their own meter files (_worker_init)
        signal.signal(signal.SIGTERM, _stop_main)               # a stop ends the loop; the pool's exit then stops the workers quietly
        _quiet_lock_cleanup()                                   # and a lock already gone at the stop is one NOTE line, not a traceback
        os.environ.setdefault("PINR_PUMPFUN_REST_FILE", os.path.join(ROOT, "index", "pumpfun_rest.json"))   # one Pump.fun rest for every worker
        if cmd == "run" and os.environ.get("PINR_BASIC_EVIDENCE", "on") != "off":
            import basic as _basic                                # the team, 231: every listed coin's basic evidence at once, its own thread
            _basic.start(db, _site_page, _pool_mints, FEED_DIR, rest_fn=_site_rest)
        if cmd == "run":
            import control as _control                            # the switches, the record and the status file
            _control.install()
            _control.start_status()
            import gategraph as _gategraph                        # the gate's status per check, every 30 s
            _gategraph.start_status(db, feed_dir=FEED_DIR)
        if cmd == "run":
            import pinrai as _pinrai                              # PINRai for the gate-passed coins on the first page
            _pinrai.start(db, _site_page, FEED_DIR)
            import quiet as _quietmod                             # coins with no trade for 24 hours go quiet
            _quietmod.start(db, lambda: list({m: b for m, b in (_pool_mints() or []) + (_site_page() or [])}.items()))
            import pvp as _pvp                                    # the PvP Arena's battles, from the gate's look-alikes
            _pvp.start(db, lambda: list({m: b for m, b in (_pool_mints() or []) + (_site_page() or [])}.items()), FEED_DIR)
            import candles as _candles                            # Pump.fun's own candles for the site's Pump.fun coins
            _candles.start(lambda: _candles.coins_for((_site_shown(), _SHOWN.get("pump") or [])[1], _wanted_coins()))
        if cmd == "run" and os.environ.get("PINR_DISCOVERY", "on") != "off":
            import discovery as _discovery                        # every Solana launchpad's new coins, its own thread
            _discovery.start()
        with get_context("spawn").Pool(WORKERS, maxtasksperchild=25, initializer=_worker_init) as pool:
            while True:
                t = time.time()
                try:
                    with contextlib.redirect_stdout(io.StringIO()):
                        res = cycle(pool, wait=(cmd == "once"))
                    print(time.strftime("%H:%M:%S"), res, f"{time.time() - t:.0f}s", flush=True)
                    write_trigger_seen(db())                  # the trigger-seen file for the app, once a pass
                except Exception:
                    traceback.print_exc()
                if cmd == "once":
                    break
                c = db()                                          # between watch passes: refill free workers every 2 s
                while time.time() - t < CYCLE_SECONDS:
                    try:
                        dispatch(c, pool)
                    except Exception:
                        traceback.print_exc()
                    time.sleep(2)
