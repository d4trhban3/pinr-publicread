"""The Solana trigger from DexScreener: plain-English tests with made-up coins, and one
real DexScreener answer saved on 2026-10-13. A temporary database and settings file; every network call is blocked and
counted; no live file is touched.
Run:  python3 test_trigger.py"""
import json, os, socket, tempfile, time, urllib.request

CALLS = []
def _blocked(*a, **k):
    CALLS.append(a[:1])
    raise OSError("network blocked in this test")
urllib.request.urlopen = _blocked
socket.create_connection = _blocked

import scanner as S
import dexscreener as D

HERE = os.path.dirname(os.path.abspath(__file__))
TMP = tempfile.mkdtemp()
S.DB = os.path.join(TMP, "scanner.sqlite")
S.SETTINGS = os.path.join(TMP, "settings.json")
S.FEED_DIR = os.path.join(TMP, "frontend-feed")              # the team's finding (2026-10-24): never the engine's live feed folder
import sys as _sys; _sys.path.insert(0, os.path.join(HERE, "..", "feed"))
import feed_export as _FE                                    # the seen files the pool pass writes go to the feed module's folder
_FE.FEED_DIR = S.FEED_DIR
S._SITE.update(at=time.time() + 10 ** 6, mints=[]); S._SHOWN.update(at=time.time() + 10 ** 6, mints=[])   # neither site list is read from the app
NOW = float(int(time.time()) - 7200)                         # two hours ago by the real clock, so what is queued is due

results = []
def case(n, title, should, fn):
    try:
        ok, text = fn()
    except Exception as e:
        ok, text = False, f"CRASH {type(e).__name__}: {e}"
    results.append(ok)
    print(f"\n{n:>2}. {title}\n    should: {should}\n    did:    {text}\n    {'PASS' if ok else 'FAIL'}")

def settings(**kw):
    d = {"score_chains": ["solana"], "solana_workers": 4, "solana_rescores": "paused", "solana_trigger": "on", "solana_trigger_volume_usd": 5000, "solana_trigger_min_buys": 10}
    d.update(kw)
    json.dump({k: v for k, v in d.items() if v is not None}, open(S.SETTINGS, "w"))

def fresh():
    for ext in ("", "-wal", "-shm"):                       # the store is in write-ahead mode (order item 4): its side files go too
        if os.path.exists(S.DB + ext):
            os.remove(S.DB + ext)
    S._RUNNING.clear(); S._SITE_RUNNING.clear()
    S._SCORING.update(chains=None, note=None, saved=None); S._SLOTS.update(n=None, note=None)
    S._RESCORES.update(mode=None, note=None); S._TRIG.update(on=None, line=None, buys=None, note=None)
    return S.db()

def pair(volume, buys, age_min=20, dex="pumpfun"):
    return {"dex": dex, "created": NOW - age_min * 60, "volume_h1": volume, "buys_h1": buys}

class Read:                                                  # stands in for DexScreener: what it would answer, and what was asked
    def __init__(self, answers):
        self.answers, self.asked = answers, []
    def __call__(self, mints):
        self.asked.append(list(mints))
        return {m: self.answers[m] for m in mints if m in self.answers}

def watch(c, coins, answers):
    r = Read(answers)
    return S.watch_pumpfun(c, now=NOW, lists=lambda: coins, read=r), r

def row(c, token):
    return c.execute("SELECT triggered_at, next_due, queued_at, dropped_at FROM tokens WHERE chain='solana' AND token=?", (token,)).fetchone()

class _Job:
    def ready(self): return False
class _Pool:
    def __init__(self): self.sent = []
    def apply_async(self, fn, args):
        self.sent.append(args[0][1]); return _Job()


def c2():
    c = fresh(); settings()
    said, r = watch(c, [("Both", NOW - 1200), ("VolumeOnly", NOW - 1200), ("BuysOnly", NOW - 1200)],
                    {"Both": [pair(5000, 10)], "VolumeOnly": [pair(250000, 9)], "BuysOnly": [pair(4999.99, 400)]})
    q = {t: row(c, t) for t in ("Both", "VolumeOnly", "BuysOnly")}
    ok = q["Both"] == (NOW, NOW, NOW, None) and q["VolumeOnly"] is None and q["BuysOnly"] is None and said.startswith("1 queued of 3")
    return ok, f"queued: {[t for t, v in q.items() if v]}; the log: '{said}'"
case(2, "Three coins twenty minutes old: one at both lines exactly, one with the volume but one buy short, one with the buys but a cent short on volume", "only the first is queued: both must hold in the same read", c2)

def c3():
    c = fresh(); settings()
    said, r = watch(c, [("Old", NOW - 3601), ("NoAge", 0), ("AgeFromPair", 0), ("NoAnswer", NOW - 600), ("NoPair", NOW - 600)],
                    {"Old": [pair(90000, 90)], "NoAge": [dict(pair(90000, 90), created=None)], "AgeFromPair": [pair(90000, 90, age_min=30)], "NoPair": []})
    q = [t for t in ("Old", "NoAge", "AgeFromPair", "NoAnswer", "NoPair") if row(c, t)]
    return q == ["AgeFromPair"] and r.asked == [["NoAge", "AgeFromPair", "NoAnswer", "NoPair"]], f"queued: {q}; asked about: {r.asked[0]} (the coin past its first hour was not even asked about)"
case(3, "A coin past its first hour; one whose age nobody gives; one whose age only DexScreener gives; one DexScreener did not answer for; one with no pair yet", "only the coin with a known age inside its first hour and both figures is queued; no answer and no age are unknown, never guessed", c3)

def c4():
    c = fresh(); settings()
    watch(c, [("Split", NOW - 600)], {"Split": [pair(4000, 30), pair(40000, 4, dex="pumpswap")]})
    split = row(c, "Split")
    watch(c, [("Once", NOW - 600)], {"Once": [pair(20000, 20)]})
    first = row(c, "Once")
    said, r = S.watch_pumpfun(c, now=NOW + 60, lists=lambda: [("Once", NOW - 600)], read=Read({"Once": [pair(90000, 90)]})), None
    return split is None and row(c, "Once") == first and said.startswith("0 queued of 0"), f"a coin whose two pairs only reach the lines when added together: {'queued' if split else 'not queued'}; a coin already queued, a minute later: asked about again: {'no' if said.startswith('0 queued of 0') else 'YES'}, its times unchanged: {row(c, 'Once') == first}"
case(4, "One pair has the buys, another has the volume; and a coin that was queued a minute ago", "figures are not added up across pairs; a coin is queued once and not asked about again", c4)

def c5():
    c = fresh(); settings()
    for t, at in (("Older", NOW - 300), ("Newer", NOW - 100), ("Rescore", NOW - 50)):
        c.execute("INSERT INTO tokens (chain, token, launchpad, first_seen, triggered_at, next_due, queued_at) VALUES ('solana',?,?,?,?,?,?)", (t, "pumpfun", 1.0, at, at, None if t == "Rescore" else at))
    c.execute("UPDATE tokens SET scores=1, last_scored=? WHERE token='Rescore'", (NOW - 60,))
    c.execute("INSERT INTO tokens (chain, token, launchpad, first_seen, next_due) VALUES ('solana','AskedFor','pumpfun',1.0,0)")
    c.commit()
    pool = _Pool()
    S.dispatch(c, pool)
    return pool.sent == ["AskedFor", "Newer", "Older"], f"started, in order: {pool.sent} (the re-score stays paused)"
case(5, "Re-scores paused; the trigger has queued two coins, one coin was asked for by hand, one old re-score is due", "the coin asked for goes first, then the trigger's queue newest first; the re-score is not started", c5)

def c6():
    c = fresh(); settings()
    watch(c, [("Stays", NOW - 600), ("Leaves", NOW - 600)], {"Stays": [pair(20000, 20)], "Leaves": [pair(20000, 20)]})
    said = S.watch_pumpfun(c, now=NOW + 120, lists=lambda: [("Stays", NOW - 600)], read=Read({}))
    left, stays = row(c, "Leaves"), row(c, "Stays")
    none = S.watch_pumpfun(c, now=NOW + 180, lists=lambda: [], read=Read({}))
    pool = _Pool(); S.dispatch(c, pool)
    ok = left[1] is None and left[3] == NOW + 120 and stays[1] == NOW and "1 dropped unscored" in said and "nothing dropped" in none and row(c, "Stays")[1] == NOW and pool.sent == ["Stays"]
    return ok, f"the coin gone from the lists: dropped and counted ('{said}'); the other still queued: {stays[1] == NOW}; with no list to look at: '{none[:60]}...'; started afterwards: {pool.sent}"
case(6, "A queued coin is no longer on Pump.fun's lists; then the lists cannot be read at all", "the coin is dropped from the queue, counted, and never scored late; with no list nothing is dropped", c6)

def c7():
    c = fresh(); settings(solana_trigger_volume_usd=500, solana_trigger_min_buys=3)
    watch(c, [("Low", NOW - 600)], {"Low": [pair(600, 3)]})
    low = bool(row(c, "Low"))
    settings(solana_trigger_volume_usd="lots", solana_trigger_min_buys=0, solana_trigger="maybe")
    got = S.trigger_settings()
    return low and (got["on"], got["line"], got["buys"]) == (True, 500.0, 3) and "solana_trigger_volume_usd" in got["note"] and "solana_trigger_min_buys" in got["note"], \
        f"with other figures in the settings the coin is queued: {low}; three values that cannot be used: the last good ones stay in force: {(got['on'], got['line'], got['buys']) == (True, 500.0, 3)}, and each is named in a warning: {got['note'].count('solana_trigger')} of 3"
case(7, "The two figures changed in the settings; then three values that cannot be used", "the next pass uses the new figures; bad values keep the last good ones and are named", c7)

def c8():
    saved = json.load(open(os.path.join(HERE, "..", "tools", "profiles", "2026-10-13-dexscreener-pumpfun-pairs-one-read.json")))
    mints = [p["baseToken"]["address"] for p in saved]
    asked, clock = [], [NOW]
    def get(url):
        asked.append((clock[0], url)); clock[0] += 0.2
        part = url.rsplit("/", 1)[1].split(",")
        return 200, [p for p in saved if p["baseToken"]["address"] in part]
    D._next[0] = D._rest_until[0] = 0.0
    got = D.pairs(mints + [f"Made{i}" for i in range(50)], get=get, clock=lambda: clock[0], sleep=lambda s: clock.__setitem__(0, clock[0] + s))
    one = saved[4]
    p = got[one["baseToken"]["address"]][0]
    sizes = [len(u.rsplit("/", 1)[1].split(",")) for _t, u in asked]
    gaps = [b[0] - a[0] for a, b in zip(asked, asked[1:])]
    ok = sizes == [30, 30, 2] and min(gaps) >= D.GAP and len(got) == 62 and got["Made7"] == [] and {k: p.get(k) for k in ("dex", "created", "volume_h1", "buys_h1")} == {"dex": "pumpfun", "created": one["pairCreatedAt"] / 1000, "volume_h1": float(one["volume"]["h1"]), "buys_h1": one["txns"]["h1"]["buys"]} and p.get("market_cap") == one["marketCap"] and p.get("pair") == one["pairAddress"] \
        and all(len(got[m]) == 1 for m in mints)
    return ok, f"62 coins asked in requests of {sizes}, never two within a second ({min(gaps):.1f} s); the 12 real coins each came back with one pair; one of them reads: {p['dex']}, 1-hour volume ${p['volume_h1']:,.2f}, {p['buys_h1']} buys; a coin DexScreener has no pair for: {got['Made7']}"
case(8, "The reader, on the real DexScreener answer saved 2026-10-13 (12 Pump.fun coins on their curve) and 50 made-up coins", "30 coins a request, a second apart; each real coin's 1-hour volume and buy count are read as DexScreener gave them; a coin with no pair is an empty list, not a zero", c8)

def c9():
    clock = [NOW]
    asked = []
    def get(url):
        asked.append(clock[0]); clock[0] += 0.2
        return (429, None) if len(asked) == 1 else (200, [])
    D._next[0] = D._rest_until[0] = 0.0
    first = D.pairs([f"M{i}" for i in range(60)], get=get, clock=lambda: clock[0], sleep=lambda s: clock.__setitem__(0, clock[0] + s))
    soon = D.pairs(["M1"], get=get, clock=lambda: clock[0], sleep=lambda s: None)
    clock[0] += D.REST + 1
    later = D.pairs(["M1"], get=get, clock=lambda: clock[0], sleep=lambda s: None)
    D._next[0] = D._rest_until[0] = 0.0
    return first == {} and soon == {} and len(asked) == 2 and later == {"M1": []}, f"after 'too many requests': coins answered {len(first)}, further requests in the next minute {len(asked) - 2 + 1 - 1}; asked again after the minute: {later == {'M1': []}}"
case(9, "DexScreener answers 'too many requests'", "nothing is taken as answered, it is left alone for a minute, then asked again", c9)

def c10():
    c = fresh(); settings()
    watch(c, [("Q1", NOW - 600), ("Q2", NOW - 600)], {"Q1": [pair(20000, 20)], "Q2": [pair(20000, 20)]})
    import io, contextlib
    real = S.time.time
    S.time.time = lambda: NOW + 30
    try:
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            S.status()
    finally:
        S.time.time = real
    line = [l for l in buf.getvalue().splitlines() if l.startswith("Solana trigger")]
    return len(line) == 1 and "queue: 2 waiting" in line[0] and "2 queued, 0 dropped" in line[0] and ": on" in line[0], line[0][:230] if line else "no line"
case(10, "The status line with two coins in the trigger's queue", "it says the trigger is on and shows the queue's length and the last hour's queued and dropped", c10)

def c11():
    c = fresh(); settings()
    pool = [(f"Coin{i}", NOW - i * 20) for i in range(450)]              # one coin every 20 s: the first 180 are under an hour old
    pages = []
    def page(url, timeout=0):
        import io, re
        off = int(re.search(r"offset=(\d+)", url).group(1)); pages.append(off)
        part = pool[off:off + 200]
        return io.StringIO(json.dumps({"coins": [{"mint": m, "createdMs": int(b * 1000)} for m, b in part], "total": len(pool)}))
    def one_page_down(url, timeout=0):
        if "offset=200" in url:
            raise OSError("made-up: the feed server did not answer this page")
        return page(url, timeout)
    blocked = urllib.request.urlopen
    try:
        urllib.request.urlopen = page
        S._POOL.update(at=0.0, mints=[])
        whole = S._pool_mints()
        r = Read({m: [pair(20000, 20, age_min=i / 3)] for i, (m, _b) in enumerate(pool)})
        said = S.watch_pumpfun(c, now=NOW, read=r)                        # lists not given: the pool reader is used
        looked = sorted(set(m for part in r.asked for m in part), key=lambda m: int(m[4:]))
        urllib.request.urlopen = one_page_down
        S._POOL.update(at=0.0, mints=[])
        none = S._pool_mints()
        said2 = S.watch_pumpfun(c, now=NOW + 60, read=Read({}))
    finally:
        urllib.request.urlopen = blocked
    ok = len(whole) == 450 and pages[:3] == [0, 200, 400] and len(looked) == 181 and looked[-1] == "Coin180" and "181 queued of 181 looked at (pool 450)" in said \
        and none == [] and "could not be read whole" in said2 and all(row(c, f"Coin{i}")[1] == NOW for i in (0, 180)) and row(c, "Coin181") is None
    return ok, f"pages asked: {pages[:3]}; coins in the pool: {len(whole)} of 450; looked at on DexScreener: {len(looked)} (the first-hour ones; the oldest asked about: {looked[-1] if looked else None}); the pass said '{said}'; with one page unreadable the pool is {none} and the pass said '{said2[:48]}...'"
case(11, "The app's whole pool, 450 coins over three pages (one born every 20 s); then one page cannot be read", "every page is read (offsets 0, 200, 400); only the 181 coins inside their first hour (exactly an hour old counts) are asked about on DexScreener; with a page unreadable the pool is unknown, nothing is looked at or dropped", c11)

def c12():
    c = fresh(); settings()
    watch(c, [("Asked", NOW - 600), ("Other", NOW - 500)], {"Asked": [pair(20000, 20)], "Other": [pair(20000, 20)]})
    S.watch_pumpfun(c, now=NOW + 60, lists=lambda: [("Other", NOW - 500)], read=Read({}))     # Asked has left the pool: dropped
    dropped = row(c, "Asked")
    import io, contextlib
    with contextlib.redirect_stdout(io.StringIO()):
        S.request("solana", "Asked")                                                            # then asked for by hand
    asked = row(c, "Asked")
    said = S.watch_pumpfun(c, now=NOW + 120, lists=lambda: [("Other", NOW - 500)], read=Read({}))   # still not in the pool
    after = row(c, "Asked")
    pool = _Pool(); S.dispatch(c, pool)
    ok = dropped[1] is None and asked[1] == 0 and after[1] == 0 and "dropped" not in said and pool.sent[:1] == ["Asked"]
    return ok, f"after leaving the pool: due {dropped[1]} (None = dropped); after `request`: due {asked[1]}; after the next pass: due {after[1]}, the pass said '{said}'; started: {pool.sent}"
case(12, "A coin the trigger dropped is asked for by hand, and is still not in the pool", "the next pass leaves it alone (a hand request is never dropped) and it is scored first", c12)

def c13():
    c = fresh(); settings()
    watch(c, [("Fails", NOW - 600), ("Works", NOW - 500)], {"Fails": [pair(20000, 20)], "Works": [pair(20000, 20)]})
    real = S.time.time
    import io, contextlib
    def status_line(at):
        S.time.time = lambda: at
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            S.status()
        return next((l for l in buf.getvalue().splitlines() if l.startswith("Solana trigger")), "")
    def started(at):
        S.time.time = lambda: at
        S._RUNNING.clear(); pool = _Pool(); S.dispatch(c, pool)
        return pool.sent
    try:
        S.time.time = lambda: NOW + 100
        S._record(c, "solana", "Works", {"score": 50})                     # a finished score
        S._record(c, "solana", "Fails", {"error": "made-up failure"})      # a failed first score
        due1 = c.execute("SELECT next_due, fails FROM tokens WHERE token='Fails'").fetchone()
        works = c.execute(f"SELECT COUNT(*) FROM tokens WHERE token='Works' AND {S._WAITING}").fetchone()[0]
        queue_after_fail = status_line(NOW + 200)
        soon = started(NOW + 200)                                            # not yet: an hour has not passed
        later = started(NOW + 100 + 3601)                                    # an hour on: retried, re-scores paused or not
        gave_up = None
        for k in range(2, 5):                                                # the second, third and fourth failures
            S.time.time = lambda k=k: NOW + 100 + k * 3601
            S._record(c, "solana", "Fails", {"error": "made-up failure"})
        final = c.execute("SELECT next_due, fails FROM tokens WHERE token='Fails'").fetchone()
        gave_up = status_line(NOW + 100 + 4 * 3601 + 10)
    finally:
        S.time.time = real
    ok = due1 == (NOW + 100 + 3600, 1) and works == 0 and "queue: 1 waiting" in queue_after_fail and soon == [] and later == ["Fails"] \
        and final == (None, 4) and "1 given up" in gave_up and "queue: 0 waiting" in gave_up
    return ok, f"after the failed first score: due in {due1[0] - (NOW + 100) if due1[0] else None} s, fails {due1[1]}; the finished coin still waiting: {works}; status: '{queue_after_fail[queue_after_fail.find('queue'):queue_after_fail.find('queue') + 16]}'; started 100 s later: {soon}; an hour later: {later}; after three more failures: due {final[0]}, fails {final[1]}; status then: '...{gave_up[gave_up.find('last hour'):]}'"
case(13, "Re-scores paused; a queued coin's first score fails; another's finishes", "the failed one stays in the queue and is retried an hour later, three times at most, then given up and said so in status; the finished one leaves the queue", c13)

def c14():
    c = fresh(); settings()
    watch(c, [("Big", NOW - 600), ("Two", NOW - 600)], {"Big": [pair(25000, 40)], "Two": [pair(900, 3), pair(12000, 12)]})
    got = {t: c.execute("SELECT queue_volume_h1, queue_buys_h1 FROM tokens WHERE token=?", (t,)).fetchone() for t in ("Big", "Two")}
    return got == {"Big": (25000.0, 40), "Two": (12000.0, 12)}, f"saved at queue time: {got}"
case(14, "Two coins queued; one of them trips on its second pair", "each coin keeps the 1-hour volume and buy count of the pair that tripped it, as DexScreener gave them at that moment", c14)

def c17():
    import io, sqlite3, gate as G
    c = fresh(); settings()
    g = sqlite3.connect(S.DB)
    G.record(g, [{"id": "OldCoin", "dev": "D1", "name": "Pump", "symbol": "PUMP", "createdAt": "2025-07-10T13:10:28Z"},
                 {"id": "Relisted", "dev": "D2", "name": "History of Doge", "symbol": "OGDOGE", "createdAt": "2024-08-14T00:00:00Z"}], NOW); g.commit(); g.close()
    coins = [{"mint": "OldCoin", "name": "Mega Jack", "symbol": "MEGAJACK", "createdMs": int(NOW * 1000)},
             {"mint": "Relisted", "name": "History of Doge", "symbol": "OGDOGE", "createdMs": int(NOW * 1000)},
             {"mint": "Fresh", "name": "Fresh", "symbol": "FR", "createdMs": int(NOW * 1000)}]
    blocked = urllib.request.urlopen
    try:
        urllib.request.urlopen = lambda url, timeout=0: io.StringIO(json.dumps({"coins": coins, "total": 3}))
        S._POOL.update(at=0.0, mints=[]); S._POOL["records"].clear(); S._SITE.update(at=0.0, mints=[])
        pool = [m for m, _b in S._pool_mints()]; site = [m for m, _b in S._site_mints()]
        kept = sorted(S._POOL["records"])
    finally:
        urllib.request.urlopen = blocked
    ok = sorted(pool) == sorted(site) == kept == ["Fresh", "Relisted"]
    return ok, f"the pool kept {sorted(pool)}, the site lists {sorted(site)}, seen records {kept}"
case(17, "the team 2026-10-26: a launch record that names an older coin's address under another name is left out", "the app's record calling a year-old coin 'Mega Jack' is dropped from the pool, the site lists and the seen records; an old coin listed again under its own name and a coin the gate has not seen yet stay", c17)


def c15():
    return CALLS == [], f"network calls attempted in the whole run: {len(CALLS)}"

def c16():
    """The trigger-seen file for the app."""
    import tempfile
    c = fresh()
    now = 1_800_000_000.0
    rows = (("Waiting", now - 600, None, None), ("Dropped", now - 3000, now - 1200, None), ("Scored", now - 5000, None, now - 4000),
            ("ScoredBefore", now - 100, None, now - 7000), ("Old", now - 90000, now - 80000, None))
    for t, q, d, ok in rows:
        c.execute("INSERT INTO tokens (chain, token, launchpad, first_seen, triggered_at, queued_at, dropped_at, last_ok) VALUES ('solana',?,?,?,?,?,?,?)", (t, "pumpfun", 1.0, q, q, d, ok))
    c.execute("INSERT INTO tokens (chain, token, launchpad, first_seen) VALUES ('solana','NeverQueued','pumpfun',1.0)")
    c.commit()
    path = os.path.join(tempfile.mkdtemp(), "feed", "trigger-seen.json")
    S.write_trigger_seen(c, now=now, path=path)
    got = json.load(open(path))
    coins = got["coins"]
    ok = (got["contract"] == "1.1" and got["as_of"] == "2027-01-15T08:00:00Z" and sorted(coins) == ["Dropped", "Scored", "ScoredBefore", "Waiting"]
          and coins["Waiting"] == {"seen_at": "2027-01-15T07:50:00Z", "dropped_at": None, "scored_at": None}
          and coins["Dropped"]["dropped_at"] == "2027-01-15T07:40:00Z" and coins["Dropped"]["scored_at"] is None
          and coins["Scored"]["scored_at"] == "2027-01-15T06:53:20Z" and coins["ScoredBefore"]["scored_at"] is None
          and not os.path.exists(path + ".tmp") and not any(k in json.dumps(got) for k in ("volume", "buys", "line")))
    return ok, f"as_of {got['as_of']}; coins {json.dumps(coins)[:260]}"
case(16, "The trigger-seen file: a coin waiting, one dropped, one scored since it was queued, one scored only before, one older than a day, one never queued",
     "the four queued in the last day are listed with seen_at, dropped_at and scored_at as the record says (a score from before the queue time is not a score since); the old one and the never-queued one are not; nothing of the line, volumes or buys", c16)

case(15, "No look-up, whole run", "not one real network call was attempted", c15)

print(f"\n{sum(results)}/{len(results)} passed")
raise SystemExit(0 if all(results) else 1)
