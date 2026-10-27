"""The per-source daily request counter (schedule step 5, for PINR_Budget's usage ledger): plain-English tests with
made-up sources and a temporary count file. Reads no chain, sends no request, touches no live file.
Run:  python3 test_request_count.py"""
import calendar, os, sqlite3, sys, tempfile, time, urllib.error
import solana_rpc as S

REAL_COUNT = os.path.abspath(S.COUNT_DB)                      # the real count file of this folder: must be left alone

results = []
def case(n, title, should, fn):
    try:
        ok, text = fn()
    except Exception as e:
        ok, text = False, f"CRASH {type(e).__name__}: {e}"
    results.append(ok)
    print(f"\n{n:>2}. {title}\n    should: {should}\n    did:    {text}\n    {'PASS' if ok else 'FAIL'}")


def fresh(path=None):
    """A new temporary count file and empty counts in memory."""
    S.COUNT_DB = path or os.path.join(tempfile.mkdtemp(), "requests.sqlite")
    S._counts.clear(); S._minutes.clear()
    S._count_off_until[0] = 0.0; S._count_saved[0] = time.time(); S._pruned[0] = None
    return S.COUNT_DB


def at(day: str, hhmm: str) -> float:
    """A moment in UTC, as seconds."""
    return calendar.timegm(time.strptime(f"{day} {hhmm}", "%Y-%m-%d %H:%M"))


DAY, YESTERDAY = "2026-10-13", "2026-10-12"
by = lambda rows: {r["source"]: r for r in rows}


def c1():
    fresh()
    for _ in range(3): S.count("made-up-a", True, now=at(DAY, "09:00"))
    S.count("made-up-a", False, now=at(DAY, "09:00"))
    S.held("made-up-a", now=at(DAY, "09:00")); S.held("made-up-a", now=at(DAY, "09:00"))
    S.save_counts()
    r = by(S.read_day(DAY))["made-up-a"]
    return (r["sent"], r["answered"], r["refused"], r["held"]) == (4, 3, 1, 2), f"sent {r['sent']}, answered {r['answered']}, refused {r['refused']}, held {r['held']}"
case(1, "Three answered, one refused, two held back by our own pacing", "sent 4 = answered 3 + refused 1; held 2, not part of sent", c1)

def c2():
    fresh()
    for _ in range(5): S.count("made-up-a", True, now=at(DAY, "09:01"))     # one worker, one minute
    S.save_counts()
    for _ in range(4): S.count("made-up-a", False, now=at(DAY, "09:01"))    # another worker, the same minute
    for _ in range(6): S.count("made-up-a", True, now=at(DAY, "09:07"))     # a quieter minute later
    S.save_counts()
    r = by(S.read_day(DAY))["made-up-a"]
    return (r["peak"], r["peak_at"]) == (9, "09:01"), f"busiest minute {r['peak']} at {r['peak_at']}"
case(2, "The busiest minute is added up across workers and saves", "9 at 09:01 (5 from one worker + 4 from another), not the 6 of the later minute", c2)

def c3():
    fresh()
    for _ in range(3): S.count("made-up-a", True, now=at(DAY, "10:00"))
    for _ in range(20): S.held("made-up-a", now=at(DAY, "10:30"))
    S.save_counts()
    r = by(S.read_day(DAY))["made-up-a"]
    return (r["peak"], r["peak_at"], r["held"]) == (3, "10:00", 20), f"busiest minute {r['peak']} at {r['peak_at']}; held {r['held']}"
case(3, "Held requests were never sent", "the busiest minute counts sent requests only (3 at 10:00), the 20 held are listed as held", c3)

def c4():
    fresh()
    S.count("made-up-a", True, now=at(YESTERDAY, "23:59"))
    S.count("made-up-a", True, now=at(DAY, "00:00")); S.count("made-up-b", False, now=at(DAY, "00:00"))
    S.save_counts()
    y, t = by(S.read_day(YESTERDAY)), by(S.read_day(DAY))
    return (y["made-up-a"]["sent"], t["made-up-a"]["sent"], t["made-up-b"]["refused"], "made-up-b" in y) == (1, 1, 1, False), f"yesterday: {sorted(y)} a={y['made-up-a']['sent']}; today: a={t['made-up-a']['sent']} b refused={t['made-up-b']['refused']}"
case(4, "Midnight UTC splits the days", "one request lands on yesterday, the two others on today; each day is read on its own", c4)

def c5():
    fresh(os.path.join(tempfile.mkdtemp(), "no-such-folder", "requests.sqlite"))
    S.count("made-up-a", True, now=at(DAY, "11:00")); S.held("made-up-a", now=at(DAY, "11:00"))
    S.save_counts()                                           # cannot be written: kept in memory, file left alone
    kept = dict(S._counts), dict(S._minutes), S._count_off_until[0] > time.time()
    S.COUNT_DB = os.path.join(tempfile.mkdtemp(), "requests.sqlite"); S._count_off_until[0] = 0.0
    S.save_counts()
    r = by(S.read_day(DAY)).get("made-up-a") or {}
    return kept[0] == {(DAY, "made-up-a"): (1, 0, 1)} and kept[1] == {(DAY, "made-up-a", "11:00"): 1} and kept[2] and (r.get("sent"), r.get("held"), r.get("peak")) == (1, 1, 1), f"kept in memory: {kept[0]} {kept[1]}, file rested: {kept[2]}; saved later: {r}"
case(5, "The count file cannot be written", "nothing breaks; the counts and the minute stay in memory, the file is rested, and the next save writes them", c5)

def c6():
    got = [S.label(u) for u in ("https://frontend-api-v3.pump.fun/coins-v2/x", "https://swap-api.pump.fun/v2/coins/x/trades?limit=100",
                                "https://api.dexscreener.com/tokens/v1/solana/x", "https://solana-mainnet.g.alchemy.com/v2/KEY",
                                "https://base-mainnet.g.alchemy.com/v2/KEY", "https://api.helius.xyz/v0/addresses/x?api-key=KEY",
                                "https://gateway.pinata.cloud/ipfs/x", "https://some.new.service.example/v1/x", "not a url")]
    want = ["pumpfun-coins", "pumpfun-trades", "dexscreener", "alchemy", "alchemy", "helius-history", "ipfs", "other", "other"]
    return got == want, f"{got}"
case(6, "A source's short name comes from its host", "Pump.fun's two services, DexScreener, Alchemy on any chain, Helius history and an IPFS gateway by name; a host nobody listed (a creator's own address) and a non-URL both as 'other', never as a row of their own", c6)

def c7():
    import pumpfun_api as PF
    fresh()
    PF._BUCKET_DB = os.path.join(tempfile.mkdtemp(), "bucket.sqlite"); PF._rest_until[0] = 0.0
    answers = []
    def fake_open(req, timeout=0):
        kind = answers.pop(0)
        if kind == "ok":
            import io; return io.StringIO('{"made": "up"}')
        raise urllib.error.HTTPError(req.full_url, int(kind), "made up", {}, None)
    real_open, real_sleep = PF.urllib.request.urlopen, PF.time.sleep
    PF.urllib.request.urlopen, PF.time.sleep = fake_open, lambda s: None
    try:
        answers[:] = ["ok"];        a = PF._get("https://frontend-api-v3.pump.fun/coins-v2/MadeUp")
        answers[:] = ["404"];       b = PF._get("https://frontend-api-v3.pump.fun/coins-v2/NoSuch")
        answers[:] = ["429", "ok"]; c = PF._get("https://swap-api.pump.fun/v2/coins/MadeUp/trades?limit=100&cursor=")
        PF._rest_until[0] = time.time() + 60;  d = PF._get("https://swap-api.pump.fun/v2/coins/MadeUp/trades?limit=100&cursor=")
        PF._rest_until[0] = 0.0
        real_take = PF._take; PF._take = lambda host, max_wait=20.0, lane="": False
        e = PF._get("https://swap-api.pump.fun/v2/coins/MadeUp/trades?limit=100&cursor=")
        PF._take = real_take
    finally:
        PF.urllib.request.urlopen, PF.time.sleep = real_open, real_sleep
    S.save_counts()
    r = by(S.read_day())
    coins, trades = r.get("pumpfun-coins", {}), r.get("pumpfun-trades", {})
    ok = (a, b, c, d, e) == ({"made": "up"}, None, {"made": "up"}, None, None) \
        and (coins.get("answered"), coins.get("refused"), coins.get("held")) == (2, 0, 0) \
        and (trades.get("answered"), trades.get("refused"), trades.get("held")) == (1, 1, 2)
    return ok, f"coin record: answered {coins.get('answered')}, refused {coins.get('refused')}, held {coins.get('held')}; trade list: answered {trades.get('answered')}, refused {trades.get('refused')}, held {trades.get('held')}"
case(7, "Pump.fun's reader counts by service", "coin record: an answer and a 'no such coin' are 2 answered; trade list: one 'too many requests' refused then answered, a rest and an empty budget are 2 held", c7)

def c8():
    import readers as R
    fresh()
    answers = ["boom", "ok"]
    def fake_open(req, timeout=0):
        if answers.pop(0) == "ok":
            import io; return io.StringIO('{"made": "up"}')
        raise OSError("made-up network trouble")
    real_open, real_sleep = R.urllib.request.urlopen, R.time.sleep
    R.urllib.request.urlopen, R.time.sleep = fake_open, lambda s: None
    try:
        got = R.http_json("https://lite-api.jup.ag/price/v3?ids=MadeUp")
    finally:
        R.urllib.request.urlopen, R.time.sleep = real_open, real_sleep
    S.save_counts()
    r = by(S.read_day()).get("jupiter", {})
    return got == {"made": "up"} and (r.get("answered"), r.get("refused")) == (1, 1), f"answer {got}; jupiter answered {r.get('answered')}, refused {r.get('refused')}"
case(8, "The general JSON reader counts every try under the host's name", "a failed first try and a good second: Jupiter 1 refused, 1 answered; the answer is returned as before", c8)

def c9():
    fresh()
    for _ in range(2): S.count("made-up-a", True, now=at(DAY, "12:00"))
    S.count("made-up-b", False, now=at(DAY, "12:00")); S.held("made-up-b", now=at(DAY, "12:00"))
    S.save_counts()
    lines = S.report(DAY)
    a = next((l for l in lines if "made-up-a" in l), ""); b = next((l for l in lines if "made-up-b" in l), "")
    ok = DAY in lines[0] and all(w in a for w in ("sent", "2", "answered", "refused", "held", "busiest minute 2 at 12:00")) \
        and "refused       1" in b and "held       1" in b and len(lines) == 3
    return ok, "\n".join(lines)
case(9, "The report is one plain line per source", "the day in the heading, then sent, answered, refused, held and the busiest minute for each source", c9)

def c10():
    path = fresh()
    c = sqlite3.connect(path)                                   # a file the older code wrote: no held column, no minutes
    c.execute("CREATE TABLE requests (day TEXT, provider TEXT, answered INTEGER, refused INTEGER, PRIMARY KEY (day, provider))")
    c.execute("INSERT INTO requests VALUES (?,?,?,?)", (DAY, "shyft", 100, 5)); c.commit(); c.close()
    before = by(S.read_day(DAY))["shyft"]
    S.count("shyft", True, now=at(DAY, "13:00")); S.held("shyft", now=at(DAY, "13:00"))
    S.save_counts()
    after = by(S.read_day(DAY))["shyft"]
    old = S.read_counts(DAY)
    return (before["sent"], before["held"], before["peak"]) == (105, 0, None) and (after["answered"], after["refused"], after["held"], after["peak"]) == (101, 5, 1, 1) and old == [("shyft", 101, 5)], f"before: {before}; after: {after}; the old reader: {old}"
case(10, "A count file written by the older code", "read as it is (held 0, busiest minute not kept); the first save adds the column and keeps the old totals; the old reader still works", c10)

def c11():
    fresh()
    old_day = time.strftime("%Y-%m-%d", time.gmtime(time.time() - (S.KEEP_MINUTE_DAYS + 3) * 86400))
    S.count("made-up-a", True, now=at(old_day, "08:00")); S.save_counts()
    S._pruned[0] = None
    S.count("made-up-a", True); S.save_counts()
    old = by(S.read_day(old_day))["made-up-a"]
    return (old["sent"], old["peak"]) == (1, None), f"the old day: sent {old['sent']}, busiest minute {old['peak']}"
case(11, "Minute rows older than two weeks are dropped", "the old day's total stays (1 sent); its busiest minute is no longer kept", c11)

def c12():
    return os.path.abspath(S.COUNT_DB) != REAL_COUNT and not any(os.path.abspath(S.COUNT_DB) == REAL_COUNT for _ in [0]), f"counted into {S.COUNT_DB}"
case(12, "The real count file was left alone", "every case counted into a temporary file", c12)

print(f"\n{sum(results)}/{len(results)} passed")
raise SystemExit(0 if all(results) else 1)
