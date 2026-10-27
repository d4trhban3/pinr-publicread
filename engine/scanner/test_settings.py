"""Data-set switch: plain-English tests with made-up coins.
Uses a temporary database and a temporary settings file; reads no chain, starts no scorer, touches no live file.
Run:  python3 test_settings.py"""
import json, os, tempfile, time
import scanner as S

TMP = tempfile.mkdtemp()
S.DB = os.path.join(TMP, "scanner.sqlite")
S.SETTINGS = os.path.join(TMP, "settings.json")
S._SITE.update(at=time.time() + 10 ** 6, mints=[]); S._SHOWN.update(at=time.time() + 10 ** 6, mints=[], page=[])   # the site lane's lists stay empty: no call to the app server
S._WANTED.update(at=time.time() + 10 ** 6, coins={})                                                                  # and the wanted list: no live file read

results = []
def case(n, title, should, fn):
    try:
        ok, text = fn()
    except Exception as e:
        ok, text = False, f"CRASH {type(e).__name__}: {e}"
    results.append(ok)
    print(f"\n{n:>2}. {title}\n    should: {should}\n    did:    {text}\n    {'PASS' if ok else 'FAIL'}")


class _Job:                                                  # a score that never finishes
    def ready(self):
        return False


class _Pool:                                                 # records what would have been sent to a scoring worker
    def __init__(self):
        self.sent = []
    def apply_async(self, fn, args):
        self.sent.append(args[0])
        return _Job()


def settings(value=None, raw=None):
    if value is None and raw is None:
        if os.path.exists(S.SETTINGS):
            os.remove(S.SETTINGS)
        return
    with open(S.SETTINGS, "w") as f:
        f.write(raw if raw is not None else json.dumps({"score_chains": value}))


def fresh(coins):
    """An empty scanner database holding these made-up coins, all due for a score now; nothing in progress."""
    for ext in ("", "-wal", "-shm"):                       # the store is in write-ahead mode (order item 4): its side files go too
        if os.path.exists(S.DB + ext):
            os.remove(S.DB + ext)
    S._RUNNING.clear(); S._SITE_RUNNING.clear()
    S._SCORING.update(chains=None, note=None, saved=None)    # as at the start of the program: no answer read yet
    S._SLOTS.update(n=None, note=None)
    S._RESCORES.update(mode=None, note=None)
    c = S.db()
    for chain, token in coins:
        c.execute("INSERT INTO tokens (chain, token, launchpad, first_seen, triggered_at, next_due) VALUES (?,?,?,?,?,?)",
                  (chain, token, "made-up", 1.0, 1.0, 1.0))
    c.commit()
    return c


COINS = [("solana", "SolCoinA"), ("bsc", "0xbnbcoina"), ("base", "0xbasecoina")]
started = lambda pool: sorted(ch for ch, _, _ in pool.sent)


def c1():
    settings(["solana", "bsc", "base"])
    c, pool = fresh(COINS), _Pool()
    text = S.dispatch(c, pool)
    return started(pool) == ["base", "bsc", "solana"] and "paused" not in text, f"started: {started(pool)}; log says: {text}"
case(1, "Settings list all three chains", "every chain is scored and the log names nothing as paused", c1)


def c2():
    settings(["solana"])
    c, pool = fresh(COINS), _Pool()
    text = S.dispatch(c, pool)
    return started(pool) == ["solana"] and "paused: bsc, base" in text, f"started: {started(pool)}; log says: {text}"
case(2, "Settings list Solana only", "only the Solana coin starts; the log names BNB and Base as paused", c2)


def c3():
    settings(["solana"])
    c, pool = fresh(COINS), _Pool()
    S.dispatch(c, pool)
    left = c.execute("SELECT chain, next_due, scores, last_scored FROM tokens WHERE chain != 'solana' ORDER BY chain").fetchall()
    ok = left == [("base", 1.0, 0, None), ("bsc", 1.0, 0, None)]
    return ok, f"paused coins in the queue: {left}"
case(3, "Paused coins while paused", "still in the queue and still due; nothing about them is changed or dropped", c3)


def c4():
    settings(["solana"])
    c, pool = fresh(COINS), _Pool()
    S.dispatch(c, pool)
    first = started(pool)
    settings(["solana", "bsc", "base"])
    S.dispatch(c, pool)                                      # same running scanner, next pass: no restart
    return first == ["solana"] and started(pool) == ["base", "bsc", "solana"], f"first pass: {first}; after resuming: {started(pool)}"
case(4, "Chains resumed in the file while the scanner runs", "the waiting BNB and Base coins start on the next pass, with no restart", c4)


def c5():
    settings(["solana"])
    c, pool = fresh(COINS), _Pool()
    S._RUNNING[("bsc", "0xalreadyrunning", "made-up")] = _Job()
    S.dispatch(c, pool)
    return ("bsc", "0xalreadyrunning", "made-up") in S._RUNNING and started(pool) == ["solana"], \
        f"score already in progress kept: {('bsc', '0xalreadyrunning', 'made-up') in S._RUNNING}; newly started: {started(pool)}"
case(5, "A BNB score already in progress when the pause arrives", "it is left to finish; no new BNB score starts", c5)


def c6():
    settings(["solana"])
    c, pool = fresh(COINS), _Pool()
    S.dispatch(c, pool)
    settings(raw="{ this is not a settings file")
    text = S.dispatch(c, pool)
    return started(pool) == ["solana"] and "not usable" in text and "still scoring solana" in text, f"started: {started(pool)}; log says: {text}"
case(6, "Settings file damaged while the scanner RUNS", "the last good answer stays in force (Solana only) and the log says the file is not usable", c6)


def c7():
    settings(["solana"])
    c, pool = fresh(COINS), _Pool()
    S.dispatch(c, pool)
    settings(["solana", "ethereum"])
    text = S.dispatch(c, pool)
    return started(pool) == ["solana"] and "not usable" in text, f"started: {started(pool)}; log says: {text}"
case(7, "Settings name a chain the scanner does not know", "refused as a whole: the last good answer stays, nothing new starts", c7)


def c8():
    settings([])
    c, pool = fresh(COINS), _Pool()
    text = S.dispatch(c, pool)
    return started(pool) == [] and "paused: solana, bsc, base" in text, f"started: {started(pool)}; log says: {text}"
case(8, "Settings list no chain at all", "nothing is scored, and the log says all three are paused", c8)


def c9():
    settings(["solana"])
    many = [("solana", f"SolCoin{i}") for i in range(10)] + COINS[1:]
    c, pool = fresh(many), _Pool()
    S.dispatch(c, pool)
    return started(pool) == ["solana"] * S.SOLANA_SLOTS, f"started: {started(pool)} (Solana may hold {S.SOLANA_SLOTS} workers)"
case(9, "Ten Solana coins waiting while BNB and Base are paused", "Solana still starts only as many as its own limit; the pause does not change that limit", c9)


def start_with(n, title, make):
    def run():
        make()
        c, pool = fresh(COINS), _Pool()                      # fresh() = a scanner that has just started
        text = S.dispatch(c, pool)
        second = S.dispatch(c, pool)
        ok = started(pool) == [] and "at start: scoring nothing" in text and "paused: solana, bsc, base" in text \
            and "at start: scoring nothing" in second
        return ok, f"started: {started(pool)}; log says: {text}"
    case(n, title, "nothing is scored, on the first pass and the next, and the log says the file must be put right", run)


start_with(10, "Scanner STARTED with a damaged settings file", lambda: settings(raw="{ this is not a settings file"))
start_with(11, "Scanner STARTED with an empty settings file (0 bytes)", lambda: settings(raw=""))
start_with(12, "Scanner STARTED with a chain name it does not know", lambda: settings(["solana", "ethereum"]))
start_with(13, "Scanner STARTED with a capital letter in a chain name", lambda: settings(["Solana"]))
start_with(14, "Scanner STARTED with the list written as one word", lambda: settings(raw='{"score_chains": "solana"}'))
start_with(15, "Scanner STARTED with the wrong name for the list", lambda: settings(raw='{"chains": ["solana"]}'))
start_with(16, "Scanner STARTED with no settings file at all", lambda: settings())


def c17():
    settings(["solana"])
    c, pool = fresh(COINS), _Pool()
    S.dispatch(c, pool)                                      # paused correctly
    settings(raw="{ slip made while running")
    S.dispatch(c, pool)
    c2, pool2 = fresh(COINS), _Pool()                        # ... then the scanner is restarted with the slip still there
    text = S.dispatch(c2, pool2)
    return started(pool2) == [] and "at start: scoring nothing" in text, f"after the restart, started: {started(pool2)}; log says: {text}"
case(17, "Paused correctly, a slip made in the file while running, then a restart", "the restarted scanner scores nothing; BNB and Base are not switched back on", c17)


def c18():
    settings(raw="{ this is not a settings file")
    c, pool = fresh(COINS), _Pool()
    S.dispatch(c, pool)
    settings(["solana"])
    text = S.dispatch(c, pool)
    return started(pool) == ["solana"] and "not usable" not in text and "paused: bsc, base" in text, f"started: {started(pool)}; log says: {text}"
case(18, "Started with a damaged file, then the file is put right", "scoring begins on the next pass with what the file lists, no restart", c18)


def c19():
    settings(["solana"])
    c, pool = fresh(COINS), _Pool()
    S.dispatch(c, pool)                                      # the running scanner writes down: Solana only
    settings(raw="{ slip made while running")
    S.dispatch(c, pool)                                      # still Solana only (last good answer)
    S._SCORING.update(chains=None, note=None, saved=None)    # `status` is a separate, freshly started program
    lines = S._scoring_report(c)
    text = " / ".join(lines)
    ok = "solana | paused: bsc, base" in lines[0] and "as last recorded by the scanner" in lines[0] \
        and "solana, bsc, base" not in text and "not usable" in lines[1]
    return ok, text
case(19, "`status` asked while the running scanner holds a last good answer and the file is damaged",
     "it reports what the scanner itself recorded (Solana only, with the time) and that the file is not usable; it does not say every chain", c19)


def c20():
    settings(["solana"])
    c, pool = fresh(COINS), _Pool()
    S.dispatch(c, pool)
    S._SCORING.update(chains=None, note=None, saved=None)    # `request` is a separate, freshly started program
    bnb, sol = S._when_scored(c, "bsc"), S._when_scored(c, "solana")
    ok = "paused" in bnb and "waits" in bnb and "scored on a coming pass" not in bnb and "scored on a coming pass" in sol
    return ok, f"BNB: {bnb} / Solana: {sol}"
case(20, "`request` for a BNB coin and for a Solana coin while BNB is paused",
     "BNB: told it waits because the scanner recorded BNB as paused; Solana: told it is scored on a coming pass if the scanner is running", c20)


def c21():
    settings(["solana"])
    c = fresh(COINS)
    lines, ans = S._scoring_report(c), S._when_scored(c, "solana")
    return "no scanner has recorded" in lines[0] and "no scanner has recorded" in ans, f"status: {lines[0]} / request: {ans}"
case(21, "`status` and `request` when no scanner has ever recorded what it is scoring",
     "both say so, and neither claims a coin will be scored", c21)


def c22():
    settings(raw=json.dumps({"score_chains": ["solana"], "solana_providers": ["public", "shfyt"]}))
    c, pool = fresh(COINS), _Pool()
    text = S.dispatch(c, pool)
    settings(raw=json.dumps({"score_chains": ["solana"], "solana_providers": ["public", "shyft"]}))
    good = S.dispatch(c, pool)
    return "WARNING solana_providers not usable" in text and "WARNING" not in good and started(pool) == ["solana"], f"log says: {text} | once put right: {good}"
case(22, "The Solana provider list in the settings has a misspelt name", "the scanner's log says so on every pass until it is put right; scoring carries on with the free sources", c22)


MANY = [("solana", f"SolCoin{i}") for i in range(10)]


def workers(n, raw=None):
    settings(raw=raw if raw is not None else json.dumps({"score_chains": ["solana"], "solana_workers": n}))


def c23():
    workers(4)
    c, pool = fresh(MANY), _Pool()
    S.dispatch(c, pool)
    return started(pool) == ["solana"] * 4, f"started {len(pool.sent)} Solana scores"
case(23, "Settings give Solana 4 workers, ten coins waiting", "four Solana scores start, no more", c23)


def c24():
    workers(4)
    c, pool = fresh(MANY), _Pool()
    S.dispatch(c, pool); workers(2); S._RUNNING.clear(); pool.sent.clear()
    S.dispatch(c, pool)
    return len(pool.sent) == 2, f"after the file changed to 2, the next pass started {len(pool.sent)}"
case(24, "The number is changed in the file while the scanner runs", "the next pass uses the new number, no restart", c24)


def c25():
    out = []
    for bad in (0, S.WORKERS + 1, "4", 2.5, True):           # one past the pool's size (a setting since order item 4), not a fixed six
        workers(bad)
        c, pool = fresh(MANY), _Pool()
        text = S.dispatch(c, pool)
        out.append((bad, len(pool.sent), "WARNING solana_workers not usable" in text))
    return all(n == S.SOLANA_SLOTS and warned for _, n, warned in out), f"(value, scores started, warned): {out}"
case(25, "The number cannot be used (0, one past the pool, a word, a fraction, true)", "the built-in number is used and the log warns on every pass", c25)


def c26():
    settings(["solana"])
    c, pool = fresh(MANY), _Pool()
    S.dispatch(c, pool)
    return len(pool.sent) == S.SOLANA_SLOTS, f"started {len(pool.sent)} (built-in number {S.SOLANA_SLOTS})"
case(26, "Settings give no number of Solana workers", "the built-in number is used, as before", c26)

def rescore_settings(value):
    with open(S.SETTINGS, "w") as f:
        json.dump(dict({"score_chains": ["solana"]}, **({} if value is None else {"solana_rescores": value})), f)

def c27():
    c = fresh([("solana", "DueRescore"), ("solana", "AskedFor")])
    c.execute("UPDATE tokens SET next_due=0 WHERE token='AskedFor'")          # what `scanner.py request` does
    c.commit()
    rescore_settings("paused")
    pool = _Pool()
    S.dispatch(c, pool)
    still = c.execute("SELECT next_due FROM tokens WHERE token='DueRescore'").fetchone()[0]
    return [t for _c, t, _l in pool.sent] == ["AskedFor"] and still == 1.0, f"started: {[t for _c, t, _l in pool.sent]}; the due re-score is still queued: {still == 1.0}"
case(27, "Solana re-scores paused; one coin is due for a re-score and one was asked for by hand", "only the coin asked for is started; the due re-score stays queued", c27)

def c28():
    c = fresh([("solana", "DueRescore")])
    rescore_settings("on")
    pool = _Pool()
    S.dispatch(c, pool)
    on = [t for _c, t, _l in pool.sent]
    c = fresh([("solana", "DueRescore")])
    rescore_settings(None)
    pool = _Pool()
    S.dispatch(c, pool)
    return on == ["DueRescore"] and [t for _c, t, _l in pool.sent] == ["DueRescore"], f"with \"on\": started {on}; with no word in the settings: started {[t for _c, t, _l in pool.sent]}"
case(28, "Solana re-scores switched on, then a settings file that does not mention them", "the due coin is started both times, as before this setting existed", c28)

def c29():
    c = fresh([("solana", "DueRescore")])
    rescore_settings("maybe")
    pool = _Pool()
    out = S.dispatch(c, pool)
    first = (list(pool.sent), "solana_rescores not usable" in out)
    rescore_settings("on"); S.dispatch(c, pool)
    rescore_settings("maybe")
    c2 = fresh([("solana", "Other")]); S._RESCORES.update(mode="on")       # a running scanner whose last good word was "on"
    pool2 = _Pool()
    S.dispatch(c2, pool2)
    return first == ([], True) and [t for _c, t, _l in pool2.sent] == ["Other"], f"a bad word when the scanner starts: started {first[0]}, the log warned: {first[1]}; a bad word after a good \"on\": started {[t for _c, t, _l in pool2.sent]}"
case(29, "The word for Solana re-scores cannot be used", "when the scanner has no good word yet nothing due is started (never read as on) and the log warns; a running scanner keeps its last good word", c29)

def c30():
    S._SITE.update(at=time.time() + 10 ** 6, mints=[("SiteCoin", time.time() - 600)])
    try:
        c = fresh([("solana", "DueRescore")])
        rescore_settings("paused")
        pool = _Pool()
        S.dispatch(c, pool)
    finally:
        S._SITE.update(at=time.time() + 10 ** 6, mints=[])
    return [t for _c, t, _l in pool.sent] == ["SiteCoin"], f"started: {[t for _c, t, _l in pool.sent]}"
case(30, "Re-scores paused, and the site is showing a coin with no score", "the site's coin is still scored; the due re-score is not", c30)

def c31():
    settings(["solana"]); rescore_settings("paused")
    c = fresh([])
    c.execute("INSERT INTO tokens (chain, token, launchpad, first_seen, next_due) VALUES ('solana','Asked','pumpfun',1.0,0)")      # asked for by hand
    c.execute("INSERT INTO tokens (chain, token, launchpad, first_seen, triggered_at, next_due, scores, last_scored, last_ok) VALUES ('solana','ScoredBefore','pumpfun',1.0,1.0,0,1,2.0,2.0)")
    c.commit()
    real = S.time.time
    def run(at):
        S.time.time = lambda: at
        S._RUNNING.clear(); pool = _Pool(); S.dispatch(c, pool)
        return [t for _c, t, _l in pool.sent]
    try:
        first = run(1000.0)                                                   # both asked for by hand: both started
        S.time.time = lambda: 1100.0
        S._record(c, "solana", "Asked", {"error": "made-up failure"})         # its first score fails
        S._record(c, "solana", "ScoredBefore", {"error": "made-up failure"})  # a coin scored before fails too
        soon, later = run(1200.0), run(1100.0 + 901)
    finally:
        S.time.time = real
    return sorted(first) == ["Asked", "ScoredBefore"] and soon == [] and later == ["Asked"], f"started at first: {sorted(first)}; 100 s after both failed: {soon}; 15 minutes after: {later} (the coin scored before is a paused re-score now)"
case(31, "Re-scores paused; a coin asked for by hand fails its first score; a coin scored before fails too", "the first score's retry is started 15 minutes later, pause or no pause; the coin that already has a finished score waits with the paused re-scores", c31)

def c32():
    settings(["solana"]); rescore_settings("follow-ups")
    c = fresh([])
    now = time.time()
    rows = [("HourFollowUp", 1, now - 100, now - 10), ("DayFollowUp", 2, now - 100, now - 20), ("DailyOfTriggered", 3, now - 100, now - 30)]   # queued by the DexScreener trigger
    for t, since, q, due in rows:
        c.execute("INSERT INTO tokens (chain, token, launchpad, first_seen, triggered_at, queued_at, next_due, scores, last_scored, last_ok, ok_since_queue) VALUES ('solana',?,?,?,?,?,?,?,?,?,?)",
                  (t, "pumpfun", 1.0, q, q, due, since, now - 50, now - 50, since))
    c.execute("INSERT INTO tokens (chain, token, launchpad, first_seen, triggered_at, next_due, scores, last_scored, last_ok) VALUES ('solana','OldBacklog','pumpfun',1.0,1.0,1.0,1,2.0,2.0)")   # the old trigger's coin, no queued_at
    c.commit()
    S._RUNNING.clear(); pool = _Pool(); S.dispatch(c, pool)
    first = [t for _c, t, _l in pool.sent]
    S._RUNNING.clear(); pool2 = _Pool(); S.dispatch(c, pool2)                 # the follow-up worker is free again
    second = [t for _c, t, _l in pool2.sent]
    rescore_settings("paused"); S._RUNNING.clear(); pool3 = _Pool(); S.dispatch(c, pool3)
    return first == ["DayFollowUp"] and second == ["DayFollowUp"] and pool3.sent == [], f"follow-ups: started {first} (the oldest due; the other waits for the one follow-up worker); next time: {second}; back to paused: started {[t for _c, t, _l in pool3.sent]}"
case(32, "Re-scores set to follow-ups: four due coins, three queued by the DexScreener trigger (after their first, second and third scores) and one of the old backlog", "only the 1-hour and 24-hour follow-ups of the trigger's coins are started, the oldest due first and one at a time (one follow-up worker); the daily one and the old backlog wait; set back to paused, nothing is started", c32)

def c33():
    settings(["solana"]); rescore_settings("follow-ups")
    c = fresh([])
    now = time.time()
    c.execute("INSERT INTO tokens (chain, token, launchpad, first_seen, scores, last_scored, last_ok) VALUES ('solana','SiteFirst','pumpfun',1.0,1,?,?)", (now - 3000, now - 3000))   # the site lane scored it
    c.execute("UPDATE tokens SET triggered_at=?, next_due=?, queued_at=?, ok_since_queue=0 WHERE token='SiteFirst'", (now - 60, now - 60, now - 60))                                   # then the trigger queued it
    c.commit()
    S._RUNNING.clear(); pool = _Pool(); S.dispatch(c, pool)
    started = [t for _c, t, _l in pool.sent]
    S._record(c, "solana", "SiteFirst", {"score": 50})
    due, since = c.execute("SELECT next_due, ok_since_queue FROM tokens WHERE token='SiteFirst'").fetchone()
    hours = (due - (now - 60)) / 3600 if due else None
    return started == ["SiteFirst"] and since == 1 and abs(hours - 1.0) < 0.01, f"started: {started}; after the trigger's score its next is due {hours:.2f} h after it was queued (finished since queue: {since})"
case(33, "A coin the site lane scored before the trigger queued it", "the trigger's score is started, and the 1-hour follow-up is due an hour after the queue time, not a day later", c33)

def c34():
    json.dump({"score_chains": ["solana"], "solana_rescores": "follow-ups", "solana_workers": 4}, open(S.SETTINGS, "w"))   # four Solana workers, as live
    c = fresh([])
    now = time.time()
    for t, due in (("FirstA", now - 10), ("FirstB", now - 20)):                                                        # queued, not yet scored: first scores
        c.execute("INSERT INTO tokens (chain, token, launchpad, first_seen, triggered_at, queued_at, next_due, ok_since_queue) VALUES ('solana',?,?,?,?,?,?,0)", (t, "pumpfun", 1.0, now - 100, now - 100, due))
    for t, due in (("FollowOld", now - 500), ("FollowNew", now - 5)):                                                   # follow-ups due
        c.execute("INSERT INTO tokens (chain, token, launchpad, first_seen, triggered_at, queued_at, next_due, scores, last_scored, last_ok, ok_since_queue) VALUES ('solana',?,?,?,?,?,?,1,?,?,1)", (t, "pumpfun", 1.0, now - 4000, now - 4000, due, now - 3900, now - 3900))
    c.commit()
    S._RUNNING.clear(); pool = _Pool(); S.dispatch(c, pool)
    started = [t for _c, t, _l in pool.sent]
    import io, contextlib
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        S.status()
    line = next((l for l in buf.getvalue().splitlines() if l.startswith("Solana scores finished")), "")
    ok = started[:2] == ["FirstA", "FirstB"] and started[2:] == ["FollowOld"] and "of them 1 follow-up" in line and "first scores" in line and "follow-ups" in line
    return ok, f"started: {started} (both first scores, then the oldest-due follow-up; the newer follow-up waits for the one follow-up worker); status: '{line[:150]}'"
case(34, "Follow-ups on; two first scores and two follow-ups due; four workers free", "the first scores start newest first, one follow-up starts (the oldest due), the other waits; status counts first scores and follow-ups apart and shows the follow-up worker busy", c34)


def c35():
    json.dump({"score_chains": ["solana"], "solana_rescores": "follow-ups", "solana_workers": 4}, open(S.SETTINGS, "w"))
    c = fresh([])
    now = time.time()
    for i in range(6):                                                                                                  # six coins waiting for a first score
        c.execute("INSERT INTO tokens (chain, token, launchpad, first_seen, triggered_at, queued_at, next_due, ok_since_queue) VALUES ('solana',?,?,?,?,?,?,0)", (f"First{i}", "pumpfun", 1.0, now - 100, now - 100, now - 10 - i))
    c.execute("INSERT INTO tokens (chain, token, launchpad, first_seen, triggered_at, queued_at, next_due, scores, last_scored, last_ok, ok_since_queue) VALUES ('solana','Follow','pumpfun',1.0,?,?,?,1,?,?,1)", (now - 4000, now - 4000, now - 300, now - 3900, now - 3900))
    c.commit()
    S._RUNNING.clear(); pool = _Pool(); S.dispatch(c, pool)
    first = [t for _c, t, _l in pool.sent]
    c.execute("UPDATE tokens SET next_due=NULL WHERE token='Follow'"); c.commit()                                      # no follow-up due any more
    S._RUNNING.clear(); pool2 = _Pool(); S.dispatch(c, pool2)
    second = [t for _c, t, _l in pool2.sent]
    json.dump({"score_chains": ["solana"], "solana_rescores": "paused", "solana_workers": 4}, open(S.SETTINGS, "w")); S._RUNNING.clear(); pool3 = _Pool(); S.dispatch(c, pool3)
    third = [t for _c, t, _l in pool3.sent]
    ok = sorted(first) == ["First0", "First1", "First2", "Follow"] and len(second) == 3 and "Follow" not in second and len(third) == 4 and "Follow" not in third
    return ok, f"six waiting and one follow-up due: started {sorted(first)} (three first scores, the follow-up on its kept place); no follow-up due: started {len(second)} (the kept place idles); paused: started {len(third)} (no place kept)"
case(35, "Follow-ups on; six coins waiting for a first score and one follow-up due; four workers", "the follow-up gets its kept worker whatever waits in front of it, three first scores take the rest; with no follow-up due the kept worker idles; set to paused, all four take first scores", c35)

def c36():
    settings(["solana"]); rescore_settings("follow-ups")
    for ext in ("", "-wal", "-shm"):                       # the store is in write-ahead mode (order item 4): its side files go too
        if os.path.exists(S.DB + ext):
            os.remove(S.DB + ext)
    S._RUNNING.clear(); S._SITE_RUNNING.clear(); S._SCORING.update(chains=None, note=None, saved=None); S._SLOTS.update(n=None, note=None); S._RESCORES.update(mode=None, note=None)
    import sqlite3
    raw = sqlite3.connect(S.DB)                                                                                         # a record written by the code before this count existed
    raw.execute("CREATE TABLE tokens (chain TEXT, token TEXT, launchpad TEXT, creator TEXT, quote TEXT, outside_raw TEXT, outside_usd REAL, buyers INTEGER, first_seen REAL, last_trade REAL, triggered_at REAL, last_scored REAL, scores INTEGER DEFAULT 0, next_due REAL, last_result TEXT, PRIMARY KEY (chain, token))")
    for col in ("pool_id TEXT", "paired TEXT", "team TEXT", "early_at REAL", "queued_at REAL", "dropped_at REAL", "last_ok REAL", "fails INTEGER"):
        raw.execute(f"ALTER TABLE tokens ADD COLUMN {col}")
    now = time.time()
    raw.execute("INSERT INTO tokens (chain, token, launchpad, first_seen, triggered_at, queued_at, next_due, scores, last_scored, last_ok) VALUES ('solana','ScoredOnce','pumpfun',1.0,?,?,?,1,?,?)", (now - 5000, now - 5000, now - 5000 + 86400, now - 4900, now - 4900))   # scored since queueing; its next was set a day on by the old rule
    raw.execute("INSERT INTO tokens (chain, token, launchpad, first_seen, triggered_at, queued_at, next_due) VALUES ('solana','NeverScored','pumpfun',1.0,?,?,?)", (now - 500, now - 500, now - 500))
    raw.execute("INSERT INTO tokens (chain, token, launchpad, first_seen, triggered_at, next_due, scores, last_scored, last_ok) VALUES ('solana','OldTrigger','pumpfun',1.0,1.0,1.0,1,2.0,2.0)")
    raw.commit(); raw.close()
    c = S.db()
    rows = {t: c.execute("SELECT ok_since_queue, next_due FROM tokens WHERE token=?", (t,)).fetchone() for t in ("ScoredOnce", "NeverScored", "OldTrigger")}
    S._RUNNING.clear(); pool = _Pool(); S.dispatch(c, pool)
    started = [t for _c, t, _l in pool.sent]
    ok = rows["ScoredOnce"][0] == 1 and abs(rows["ScoredOnce"][1] - (now - 5000 + 3600)) < 1 and rows["NeverScored"][0] == 0 and rows["OldTrigger"][0] is None and sorted(started) == ["NeverScored", "ScoredOnce"]
    return ok, f"filled at the start: {rows}; then started: {sorted(started)} (the overdue follow-up and the first score; the old trigger's coin untouched)"
case(36, "A record from before the count existed: a coin scored once since the trigger queued it, one never scored, one of the old trigger", "at the start the count is filled from the record (1 and 0; the old trigger's coin is left alone), the overdue 1-hour follow-up is pulled forward to an hour after queueing and runs", c36)

def c37():
    json.dump({"score_chains": ["solana"], "solana_rescores": "follow-ups", "solana_workers": 4}, open(S.SETTINGS, "w"))
    c = fresh([])
    now = time.time()
    for t, due in (("Healthy", now - 200), ("Failing", now - 100)):                                                    # two follow-ups due, the healthy one older
        c.execute("INSERT INTO tokens (chain, token, launchpad, first_seen, triggered_at, queued_at, next_due, scores, last_scored, last_ok, ok_since_queue) VALUES ('solana',?,?,?,?,?,?,1,?,?,1)", (t, "pumpfun", 1.0, now - 4000, now - 4000, due, now - 3900, now - 3900))
    c.commit()
    real = S.time.time
    def run(at):
        S.time.time = lambda: at
        S._RUNNING.clear(); S._FOLLOWUP_RUNNING.clear(); pool = _Pool(); S.dispatch(c, pool)
        return [t for _c, t, _l in pool.sent]
    try:
        first = run(now)                                                                                               # the healthy one, older due, goes first
        S.time.time = lambda: now + 10
        S._record(c, "solana", "Healthy", {"score": 50})
        S._record(c, "solana", "Failing", {"error": "made-up failure"})                                               # its first try fails
        due1 = c.execute("SELECT next_due FROM tokens WHERE token='Failing'").fetchone()[0]
        c2 = S.db()                                                                                                    # the record opened again, as every pass does
        due2 = c2.execute("SELECT next_due FROM tokens WHERE token='Failing'").fetchone()[0]
        soon = run(now + 300)                                                                                          # five minutes on: not yet
        later = run(now + 10 + 901)                                                                                    # fifteen minutes on: retried
        for k in range(2, 5):
            S.time.time = lambda k=k: now + 10 + k * 901
            S._record(c, "solana", "Failing", {"error": "made-up failure"})
        final = c.execute("SELECT next_due, fails, last_result FROM tokens WHERE token='Failing'").fetchone()
    finally:
        S.time.time = real
    ok = first == ["Healthy"] and abs(due1 - (now + 10 + 900)) < 1 and due2 == due1 and soon == [] and later == ["Failing"] and final[0] is None and final[1] == 4 and "made-up failure" in (final[2] or "")
    return ok, f"started first: {first}; after the failure its retry is {due1 - (now + 10):.0f} s on, and after the record is opened again still {due2 - (now + 10):.0f} s on; 5 min later started {soon}; 15 min later {later}; after three more failures: due {final[0]}, failed tries {final[1]}, the failure written down: {'made-up failure' in (final[2] or '')}"
case(37, "Follow-ups on; a follow-up fails while another is healthy", "the failed one is retried 15 minutes later (opening the record again does not pull it into the past), three times at most, then given up with its failure written down; the healthy, older-due one went first", c37)

def c38():
    settings(["solana"]); rescore_settings("paused")
    c = fresh([]); S._LANE_TRIED.clear()
    now = time.time()
    feed = tempfile.mkdtemp(); real_feed = S.FEED_DIR; S.FEED_DIR = feed
    def iso(t): return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(t))
    rows = (("Fresh", now - 3600, now - 7200), ("StaleOld", now - 90000, now - 400000), ("StaleNew", now - 90000, now - 200000), ("NoFacts", now - 90000, now - 300000), ("NoFile", now - 90000, now - 100000))
    for t, scored_at, seen in rows:
        c.execute("INSERT INTO tokens (chain, token, launchpad, first_seen, scores, last_scored, last_ok) VALUES ('solana',?,?,?,1,?,?)", (t, "pumpfun", seen, scored_at, scored_at))
    c.execute("INSERT INTO tokens (chain, token, launchpad, first_seen, triggered_at, next_due, scores, last_scored, last_ok) VALUES ('solana','Backlog','pumpfun',1.0,1.0,1.0,1,2.0,2.0)")
    c.commit()
    for t, scored_at, _seen in rows[:3]:
        json.dump({"mint": t, "facts": [{"id": "valuation", "read_at": iso(scored_at)}]}, open(os.path.join(feed, t + ".json"), "w"))
    json.dump({"mint": "NoFacts"}, open(os.path.join(feed, "NoFacts.json"), "w"))
    S._SITE.update(at=time.time() + 10 ** 6, mints=[])
    S._SHOWN.update(at=time.time() + 10 ** 6, mints=["Fresh", "StaleOld", "StaleNew", "NoFacts", "NoFile", "NotInRecord"])
    order = []
    try:
        for _ in range(5):                                                                                                  # each pass: the lane's one slot frees; the score finishes but, in this made-up world, the feed file is not rewritten
            S._RUNNING.clear(); S._SITE_RUNNING.clear(); pool = _Pool(); S.dispatch(c, pool)
            order.append([t for _c, t, _l in pool.sent])
            for _ch, t, _l in pool.sent:
                S._record(c, "solana", t, {"score": 50})
        S._SITE.update(at=time.time() + 10 ** 6, mints=[("NewCoin", time.time() - 600)])                                   # an unscored coin appears: it goes first
        S._RUNNING.clear(); S._SITE_RUNNING.clear(); pool2 = _Pool(); S.dispatch(c, pool2)
        second = [t for _c, t, _l in pool2.sent]
    finally:
        S.FEED_DIR = real_feed; S._SHOWN.update(at=time.time() + 10 ** 6, mints=[]); S._SITE.update(at=time.time() + 10 ** 6, mints=[]); S._LANE_TRIED.clear()
    ok = order == [["NoFacts"], ["NoFile"], ["StaleNew"], ["StaleOld"], []] and second[:1] == ["NewCoin"] and "Backlog" not in sum(order, []) + second and "Fresh" not in sum(order, [])
    return ok, f"pass by pass the lane started: {order} (no receipts first in the site's order, then stale receipts newest coin first, then nothing: the fresh coin, the backlog and a coin not on record are left alone); when an unscored coin appears: {second[:1]} first"
case(38, "Re-scores paused; the site shows a coin with fresh receipts, two with receipts older than a day, one with none, one with no feed file", "the lane takes the coins without receipts first (site order), then the stale ones newest coin first, one a pass, never one twice in a row; fresh receipts, the backlog and unknown coins are left alone; an unscored coin always goes first", c38)

def c40():
    settings(["solana"]); rescore_settings("paused")
    c = fresh([]); S._LANE_TRIED.clear()
    now = time.time()
    feed = tempfile.mkdtemp(); real_feed = S.FEED_DIR; S.FEED_DIR = feed
    for t in ("Broken", "Behind"):
        c.execute("INSERT INTO tokens (chain, token, launchpad, first_seen, scores, last_scored, last_ok) VALUES ('solana',?,?,?,1,?,?)", (t, "pumpfun", now - 90000, now - 90000, now - 90000))
    c.commit()
    S._SITE.update(at=time.time() + 10 ** 6, mints=[])
    S._SHOWN.update(at=time.time() + 10 ** 6, mints=["Broken", "Behind"])
    real = S.time.time
    def run(at):
        S.time.time = lambda: at
        S._RUNNING.clear(); S._SITE_RUNNING.clear(); pool = _Pool(); S.dispatch(c, pool)
        return [t for _c, t, _l in pool.sent]
    started = []
    try:
        for k in range(6):                                                                                                  # six passes a minute apart: Broken fails each time it is started
            got = run(now + k * 60); started.append(got)
            if got == ["Broken"]:
                S.time.time = lambda k=k: now + k * 60 + 5
                S._record(c, "solana", "Broken", {"error": "made-up failure"})
            elif got == ["Behind"]:
                S.time.time = lambda k=k: now + k * 60 + 5
                S._record(c, "solana", "Behind", {"score": 50})
                json.dump({"mint": "Behind", "facts": [{"id": "valuation", "read_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(now + k * 60 + 5))}]}, open(os.path.join(feed, "Behind.json"), "w"))
        later = []
        for k in range(4):                                                                                                  # then a pass every 16 minutes: Broken's retries, 15 minutes apart, three in all
            got = run(now + 400 + k * 960); later.append(got)
            if got == ["Broken"]:
                S.time.time = lambda k=k: now + 400 + k * 960 + 5
                S._record(c, "solana", "Broken", {"error": "made-up failure"})
        fails = c.execute("SELECT fails FROM tokens WHERE token='Broken'").fetchone()[0]
    finally:
        S.time.time = real; S.FEED_DIR = real_feed; S._SHOWN.update(at=time.time() + 10 ** 6, mints=[]); S._SITE.update(at=time.time() + 10 ** 6, mints=[]); S._LANE_TRIED.clear()
    ok = started == [["Broken"], ["Behind"], [], [], [], []] and later == [[], ["Broken"], ["Broken"], []] and fails == 3
    return ok, f"a minute apart: {started} (Broken once, then the coin behind it, then nothing within 15 minutes); 16 minutes apart: {later} (two more tries, then left); failed tries on record: {fails}"
case(40, "The site lane's second job meets a coin that cannot be scored", "it is started once, the coin behind it is not blocked, it is not started again for 15 minutes, three starts in all, then left", c40)

def c39():
    settings(["solana"]); rescore_settings("follow-ups")
    c = fresh([])
    now = time.time()
    c.execute("INSERT INTO tokens (chain, token, launchpad, first_seen, triggered_at, queued_at, next_due, ok_since_queue) VALUES ('solana','First','pumpfun',1.0,?,?,?,0)", (now - 100, now - 100, now - 10))
    c.execute("INSERT INTO tokens (chain, token, launchpad, first_seen, triggered_at, queued_at, next_due, scores, last_scored, last_ok, ok_since_queue) VALUES ('solana','Follow','pumpfun',1.0,?,?,?,1,?,?,1)", (now - 4000, now - 4000, now - 300, now - 3900, now - 3900))
    c.commit()
    S._RUNNING.clear(); S._FOLLOWUP_RUNNING.clear(); S._SCORING.update(saved=None); pool = _Pool(); S.dispatch(c, pool)
    import io, contextlib
    S._RUNNING.clear(); S._FOLLOWUP_RUNNING.clear()                                                                   # as `status`, a separate program, has nothing in memory
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        S.status()
    line = next((l for l in buf.getvalue().splitlines() if l.startswith("Solana scores finished")), "")
    rep = S._last_reported(c)
    ok = sorted(t for _c, t, _l in pool.sent) == ["First", "Follow"] and rep[3] == 2 and rep[4] == 1 and "2 Solana scores, of them 1 follow-up" in line and "as the scanner last recorded at" in line and "scoring" in S._when_scored(c, "solana")
    return ok, f"started {sorted(t for _c, t, _l in pool.sent)}; the scanner recorded running {rep[3]}, follow-ups {rep[4]}; status says: '{line[line.find('in progress'):][:90]}'; `request` still answers: {S._when_scored(c, 'solana')[:40]}..."
case(39, "The scanner records what it is scoring; `status` and `request` are separate programs", "status shows the running count and the follow-up count the scanner last recorded, with the time, not its own empty memory; `request` still reads the record", c39)

def c41():
    settings(["solana"]); rescore_settings("paused")
    c = fresh([]); S._LANE_TRIED.clear(); S._LANE_TURN[0] = 0
    now = time.time()
    feed = tempfile.mkdtemp(); real_feed = S.FEED_DIR; S.FEED_DIR = feed
    for t in ("OldA", "OldB"):                                                                                            # two shown coins with no receipts
        c.execute("INSERT INTO tokens (chain, token, launchpad, first_seen, scores, last_scored, last_ok) VALUES ('solana',?,?,?,1,?,?)", (t, "pumpfun", now - 90000, now - 90000, now - 90000))
    c.commit()
    S._SHOWN.update(at=time.time() + 10 ** 6, mints=["OldA", "OldB"])
    new = [("New%d" % i, time.time() - 600 - i) for i in range(6)]                                                        # six unscored coins on the site's lists
    S._SITE.update(at=time.time() + 10 ** 6, mints=list(new))
    order = []
    try:
        for _ in range(6):
            S._RUNNING.clear(); S._SITE_RUNNING.clear(); pool = _Pool(); S.dispatch(c, pool)
            got = [t for _c, t, _l in pool.sent]; order.append(got)
            for _ch, t, _l in pool.sent:
                S._record(c, "solana", t, {"score": 50})
            S._SITE.update(at=time.time() + 10 ** 6, mints=[m for m in S._SITE["mints"] if m[0] not in got])
        S._SITE.update(at=time.time() + 10 ** 6, mints=[])                                                               # nothing unscored any more: the second job takes every turn
        S._SHOWN.update(at=time.time() + 10 ** 6, mints=["OldA", "OldB", "OldC"])
        c.execute("INSERT INTO tokens (chain, token, launchpad, first_seen, scores, last_scored, last_ok) VALUES ('solana','OldC','pumpfun',?,1,?,?)", (now - 90000, now - 90000, now - 90000)); c.commit()
        S._RUNNING.clear(); S._SITE_RUNNING.clear(); pool = _Pool(); S.dispatch(c, pool)
        alone = [t for _c, t, _l in pool.sent]
    finally:
        S.FEED_DIR = real_feed; S._SHOWN.update(at=time.time() + 10 ** 6, mints=[]); S._SITE.update(at=time.time() + 10 ** 6, mints=[]); S._LANE_TRIED.clear(); S._LANE_TURN[0] = 0
    kinds = ["old" if g and g[0].startswith("Old") else "new" for g in order]
    return kinds == ["new", "new", "old", "new", "new", "old"] and alone == ["OldC"], f"turn by turn the lane took: {kinds} ({order}); with nothing unscored left: {alone} (the second job takes the turn)"
case(41, "Six unscored coins on the site's lists and shown coins without receipts, one lane slot", "the slot alternates: two unscored coins, then one from the second job, and so on; when nothing unscored waits the second job takes the turn", c41)


def c42():
    """the order setting, read like the others."""
    seen = {}
    for label, raw in (("not given", {"score_chains": ["solana"]}), ("biggest", {"score_chains": ["solana"], "solana_queue_order": "biggest"}),
                       ("newest", {"score_chains": ["solana"], "solana_queue_order": "newest"}), ("a word", {"score_chains": ["solana"], "solana_queue_order": "largest"}),
                       ("a number", {"score_chains": ["solana"], "solana_queue_order": 1})):
        json.dump(raw, open(S.SETTINGS, "w")); seen[label] = (S.solana_queue_order(), S._ORDER["note"] is not None)
    open(S.SETTINGS, "w").write("{ not json"); seen["unreadable"] = (S.solana_queue_order(), S._ORDER["note"] is not None)
    want = {"not given": ("biggest", False), "biggest": ("biggest", False), "newest": ("newest", False), "a word": ("newest", True), "a number": ("newest", True), "unreadable": ("newest", True)}
    return seen == want, f"{seen} (order, warning)"
case(42, "The queue order setting", "not given or 'biggest' = biggest first; 'newest' = newest first; a word, a number or an unreadable file keeps the last good value and warns", c42)


def c43():
    """three coins waiting, different volumes at queue time; a hand request; both orders."""
    import io, contextlib
    def run(order):
        json.dump({"score_chains": ["solana"], "solana_rescores": "paused", "solana_workers": 4, "solana_queue_order": order}, open(S.SETTINGS, "w"))
        c = fresh([])
        now = time.time()
        for t, due, vol in (("SmallNewest", now - 10, 12000.0), ("BigOldest", now - 30, 90000.0), ("MidMiddle", now - 20, 40000.0)):
            c.execute("INSERT INTO tokens (chain, token, launchpad, first_seen, triggered_at, queued_at, queue_volume_h1, next_due, ok_since_queue) VALUES ('solana',?,?,?,?,?,?,?,0)", (t, "pumpfun", 1.0, due, due, vol, due))
        c.execute("INSERT INTO tokens (chain, token, launchpad, first_seen, next_due) VALUES ('solana','ByHand','pumpfun',?,0)", (now,))
        c.commit()
        S._RUNNING.clear(); S._SITE_RUNNING.clear(); pool = _Pool(); S.dispatch(c, pool)
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            S.status()
        line = next((l for l in buf.getvalue().splitlines() if l.startswith("Solana trigger")), "")
        return [t for _c, t, _l in pool.sent], line
    big, line_b = run("biggest"); new, line_n = run("newest")
    ok = (big[:4] == ["ByHand", "BigOldest", "MidMiddle", "SmallNewest"] and new[:4] == ["ByHand", "SmallNewest", "MidMiddle", "BigOldest"]
          and "biggest first" in line_b and "newest first" in line_n)
    return ok, f"biggest: started {big}; newest: started {new}; status says '{line_b[line_b.find('queue:'):line_b.find('queue:')+70]}' / '{line_n[line_n.find('queue:'):line_n.find('queue:')+40]}'"
case(43, "Three queued coins of different sizes and one hand request; the order setting at 'biggest', then 'newest'", "the hand request goes first either way; then the biggest volume at queue time first, or the newest first with the old setting; the status line says which", c43)


def c44():
    """A "Technical error, retrying" result (the engine read nothing it could score) is retried like a failed first score."""
    json.dump({"score_chains": ["solana"], "solana_rescores": "paused", "solana_workers": 4, "solana_error_retries": 2}, open(S.SETTINGS, "w"))
    c = fresh([])
    now = time.time()
    c.execute("INSERT INTO tokens (chain, token, launchpad, first_seen, next_due) VALUES ('solana','ByHand','pumpfun',?,0)", (now,))
    c.commit()
    tech = {"display": "Technical error, retrying", "label": None, "error": None, "coverage": 0.3}
    seen = []
    for i in range(3):
        S._record(c, "solana", "ByHand", tech)
        due, fails, last_ok, res = c.execute("SELECT next_due, fails, last_ok, last_result FROM tokens WHERE token='ByHand'").fetchone()
        seen.append(((due - now) / 3600 if due else None, fails, last_ok, "Technical error" in (res or "")))
    json.dump({"score_chains": ["solana"], "solana_rescores": "paused", "solana_workers": 4}, open(S.SETTINGS, "w")); n_default = S.error_retries()
    json.dump({"score_chains": ["solana"], "solana_rescores": "paused", "solana_workers": 4, "solana_error_retries": "many"}, open(S.SETTINGS, "w")); n_junk = S.error_retries()
    ok = (abs(seen[0][0] - 1.0) < 0.01 and seen[0][1] == 1 and seen[0][2] is None and seen[0][3] and abs(seen[1][0] - 1.0) < 0.01 and seen[1][1] == 2
          and seen[2][0] is None and seen[2][1] == 3 and seen[2][3] and n_default == S.TRIGGER_RETRIES and n_junk == S.TRIGGER_RETRIES and bool(S._ERR_RETRIES["note"]))
    return ok, f"after each technical error (hours until the retry, fails, last_ok, the error kept): {seen}; the setting not given -> {n_default}, junk -> {n_junk} with a warning"
case(44, "A hand-requested coin ends in 'Technical error, retrying' three times; the retry count is a setting at 2",
     "retried an hour later, twice; the third error stands with no next try (never a guess), the error kept as its result, no finished score recorded; the setting not given or junk falls back to the trigger's count", c44)


def c45():
    """Order item 4: the two faults' fixes are in place."""
    import signal as _sig
    c = fresh([])
    mode = c.execute("PRAGMA journal_mode").fetchone()[0]
    S._worker_init()
    quiet = _sig.getsignal(_sig.SIGTERM) is not _sig.SIG_DFL and _sig.getsignal(_sig.SIGINT) is _sig.SIG_IGN
    src = open(S.__file__).read()
    wired = "initializer=_worker_init" in src and "signal.signal(signal.SIGTERM, _stop_main)" in src
    _sig.signal(_sig.SIGTERM, _sig.SIG_DFL); _sig.signal(_sig.SIGINT, _sig.default_int_handler)
    return mode == "wal" and quiet and wired, f"the scanner's store opens in '{mode}' mode; a worker exits quietly on a stop {quiet}; the pool starts its workers with that and the main process ends its loop on a stop {wired}"
case(45, "The scanner's store and its workers after order item 4", "the store is in write-ahead mode (readers never wait on a writer: no 'database is locked'); every worker exits at once and quietly on a stop (no broken pipe); the main process ends its loop on a stop so the pool stops the workers first", c45)


def c46():
    """The pool's size as a setting."""
    import tempfile as _t
    folder = _t.mkdtemp(); path = os.path.join(folder, "settings.json")
    seen = {}
    for label, raw in (("not given", {}), ("6", {"scanner_workers": 6}), ("8", {"scanner_workers": 8}), ("16", {"scanner_workers": 16}), ("0", {"scanner_workers": 0}), ("17", {"scanner_workers": 17}), ("a word", {"scanner_workers": "six"}), ("true", {"scanner_workers": True})):
        json.dump(raw, open(path, "w")); seen[label] = S.pool_workers(path)
    open(path, "w").write("{ junk"); seen["unreadable"] = S.pool_workers(path)
    want = {"not given": 5, "6": 6, "8": 8, "16": 16, "0": 5, "17": 5, "a word": 5, "true": 5, "unreadable": 5}
    live = json.load(open(os.path.join(os.path.dirname(S.__file__), "settings.json")))
    return seen == want and live.get("scanner_workers") == 6 and live.get("solana_workers") == 6, f"read as {seen}; the live settings file says scanner_workers {live.get('scanner_workers')}, solana_workers {live.get('solana_workers')}"
case(46, "The pool's size as a setting: not given, 6, 8, out of range, junk", "a usable number from 1 to 16 (the ceiling since 2026-10-24) is the pool's size at start; anything else the built-in 5; the live file asks for six, with Solana allowed all six", c46)


def page_lists(page=(), wanted=None):
    S._SHOWN.update(at=time.time() + 10 ** 6, mints=[], page=list(page)); S._WANTED.update(at=time.time() + 10 ** 6, coins=dict(wanted or {}))


def c47():
    settings(raw=json.dumps({"score_chains": ["solana"], "solana_workers": 6, "solana_rescores": "follow-ups"}))
    c = fresh([]); S._FOLLOWUP_RUNNING.clear()
    now = time.time()
    c.execute("INSERT INTO tokens (chain, token, launchpad, first_seen, next_due) VALUES ('solana','Hand','pumpfun',1.0,0)")                         # asked for by hand
    c.execute("INSERT INTO tokens (chain, token, launchpad, first_seen, triggered_at, queued_at, next_due, ok_since_queue) VALUES ('solana','Queued','pumpfun',1.0,?,?,?,0)", (now - 100, now - 100, now - 10))
    c.execute("INSERT INTO tokens (chain, token, launchpad, first_seen, scores, last_scored, last_ok) VALUES ('solana','Scored','pumpfun',1.0,1,?,?)", (now - 300, now - 300))
    c.execute("INSERT INTO tokens (chain, token, launchpad, first_seen, last_scored, fails, next_due) VALUES ('solana','Failed','pumpfun',1.0,?,1,?)", (now - 300, now + 3000))
    c.commit()
    page = [("Scored", now - 500), ("Old", now - 3000), ("New", now - 200), ("Baby", now - 20), ("Failed", now - 400), ("NoTime", 0.0), ("Mid", now - 1000)]
    page_lists(page, {"WantA": now - 50, "WantB": now - 10, "Scored": now - 5})
    try:
        S._RUNNING.clear(); pool = _Pool(); S.dispatch(c, pool)
        first = [t for _c, t, _l in pool.sent]
        pool2 = _Pool(); S.dispatch(c, pool2)                                                                             # all five still running
        again = [t for _c, t, _l in pool2.sent]
        for t in first:
            S._record(c, "solana", t, {"score": 50})
        S._RUNNING.clear(); pool3 = _Pool(); S.dispatch(c, pool3)
        second = [t for _c, t, _l in pool3.sent]
        added = c.execute("SELECT launchpad FROM tokens WHERE token='WantA'").fetchone()
    finally:
        page_lists()
    cap = S.solana_slots() - S.FOLLOWUP_SLOTS
    ok = cap == 5 and first == ["Hand", "WantB", "WantA", "New", "Mid"] and again == [] and second == ["Old", "NoTime", "Queued"] and added == ("pumpfun",)
    return ok, f"{cap} first-score workers; first round {first} (the trigger's queued coin waits); while they run {again}; next round {second} (the page done: the young coin waits, the scored and failed ones are left to their own paths, then the queue); a coin new to the scanner recorded as {added}"
case(47, "the coins on the page and the wanted list before all others", "a hand request first, then the wanted list (latest ask first), then the first page's never-scored coins newest first, a coin under a minute old waiting and one with no launch time last, on every first-score worker; the trigger's queue only once none is left; a scored coin and one whose score failed are not this lane's", c47)


def c48():
    settings(raw=json.dumps({"score_chains": ["solana"], "solana_workers": 6, "solana_rescores": "follow-ups"}))
    c = fresh([]); S._FOLLOWUP_RUNNING.clear()
    now = time.time()
    for i in range(3):
        c.execute("INSERT INTO tokens (chain, token, launchpad, first_seen, triggered_at, queued_at, next_due, ok_since_queue) VALUES ('solana',?,'pumpfun',1.0,?,?,?,0)", (f"Q{i}", now - 100, now - 100, now - 10 - i))
    c.commit()
    page_lists()
    S._RUNNING.clear(); pool = _Pool(); S.dispatch(c, pool)
    got = sorted(t for _c, t, _l in pool.sent)
    page_lists([("Scored", now - 500)])
    c.execute("INSERT INTO tokens (chain, token, launchpad, first_seen, scores, last_scored, last_ok) VALUES ('solana','Scored','pumpfun',1.0,1,?,?)", (now - 300, now - 300)); c.commit()
    S._RUNNING.clear(); pool = _Pool(); S.dispatch(c, pool)
    got2 = sorted(t for _c, t, _l in pool.sent)
    page_lists()
    return got == ["Q0", "Q1", "Q2"] and got2 == ["Q0", "Q1", "Q2"], f"no page answer: {got}; a page whose coins are all scored: {got2}"
case(48, "Nothing unscored on the page or the wanted list", "the workers go to the trigger's queue as before; an unreadable page means nothing for the lane, never a block", c48)


def c49():
    import urllib.request as U
    answer = {"tokens": [
        {"chain": "solana", "address": "ScoredA", "score": 40, "launchedAtMs": 1_700_000_000_000},
        {"chain": "solana", "address": "Unscored", "score": None, "note": "Not scored yet", "launchedAtMs": 1_700_000_500_000},
        {"chain": "solana", "address": "Mayhem", "score": None, "label": "MAYHEM", "note": "No score, ever"},
        {"chain": "solana", "address": "BadTime", "score": None, "launchedAtMs": "soon"},
        {"chain": "solana", "address": "BoolTime", "score": None, "launchedAtMs": True},
        {"chain": "bsc", "address": "0xother", "score": 10},
        {"chain": "solana", "score": 12}, "junk"]}
    real = U.urlopen
    try:
        U.urlopen = lambda url, timeout=5: __import__("io").BytesIO(json.dumps(answer).encode())
        S._SHOWN.update(at=0.0); shown = S._site_shown(); page = list(S._SHOWN["page"])
        def broken(url, timeout=5):
            raise OSError("feed server down")
        U.urlopen = broken
        S._SHOWN.update(at=0.0); shown2 = S._site_shown(); page2 = S._site_page()
    finally:
        U.urlopen = real; page_lists()
    want = [("ScoredA", 1_700_000_000.0), ("Unscored", 1_700_000_500.0), ("Mayhem", 0.0), ("BadTime", 0.0), ("BoolTime", 0.0)]
    return shown == ["ScoredA", "Mayhem"] and page == want and shown2 == [] and page2 == [], f"scored list {shown} (unchanged rule); page {page}; feed server down: {shown2} and {page2}"
case(49, "The first page as the feed server answers it (made-up answer, no network)", "the page lane reads every Solana coin on the page with its launch time in seconds, a time that is not a number counted as unknown; the second job's scored list exactly as before; nothing when the server does not answer", c49)


def c50():
    import pinrbot
    folder = tempfile.mkdtemp(); hand, site = os.path.join(folder, "hand.json"), os.path.join(folder, "site.json")
    now = time.time()
    json.dump({"Both": now - 100, "HandOnly": now - 50, "TooOld": now - 90000}, open(hand, "w"))
    json.dump({"Both": now - 10, "0xevm": now - 5}, open(site, "w"))
    real = (pinrbot.WANTED, pinrbot.WANTED_SITE, pinrbot._wanted)
    try:
        pinrbot.WANTED, pinrbot.WANTED_SITE = hand, site
        S._WANTED.update(at=0.0); got = S._wanted_coins()
        pinrbot._wanted = lambda *a, **k: (_ for _ in ()).throw(ValueError("unreadable"))
        S._WANTED.update(at=0.0); broken = S._wanted_coins()
    finally:
        pinrbot.WANTED, pinrbot.WANTED_SITE, pinrbot._wanted = real; page_lists()
    ok = sorted(got) == ["Both", "HandOnly"] and abs(got["Both"] - (now - 10)) < 1 and broken == {}
    return ok, f"read {sorted(got)} (the latest ask wins for a coin on both lists, a day's asks only, no EVM address); unreadable: {broken}"
case(50, "The wanted list for the page lane", "PINRbot's own reader: the hand list and the site's file together, the latest ask winning, older than a day left out; an EVM address not taken; anything unreadable is an empty list, never a stop", c50)

print(f"\n{sum(results)}/{len(results)} passed")
raise SystemExit(0 if all(results) else 1)
