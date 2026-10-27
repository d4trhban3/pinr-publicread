"""Pump.fun's candles into one file per coin. A made-up Pump.fun answer, a temporary
feed folder; no network. Run:  python3 test_candles.py"""
import json, os, sys, tempfile
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import candles as K

results = []
def case(n, title, should, fn):
    try:
        ok, text = fn()
    except Exception as e:
        import traceback; traceback.print_exc()
        ok, text = False, f"CRASH {type(e).__name__}: {e}"
    results.append(ok)
    print(f"\n{n:>2}. {title}\n    should: {should}\n    did:    {text}\n    {'PASS' if ok else 'FAIL'}")

NOW = 1_792_904_400.0
OLD, NEW = "MadeUpPkdCoin1111111111111111111111111pump", "MadeUpNewCoin1111111111111111111111111pump"
def candle(t, o=1e-6, h=2e-6, l=5e-7, c=1.5e-6, v=100.0):
    return {"timestamp": t, "open": str(o), "high": str(h), "low": str(l), "close": str(c), "volume": str(v)}
def fresh():
    K._read.clear(); K._allow[0], K._allow[1] = 0.0, 0.0
    return tempfile.mkdtemp()


def c1():
    rows = K.rows_of([candle(2000), candle(1000, o=3e-6)])
    bad = {"not a list": K.rows_of({"candles": []}), "a field missing": K.rows_of([{"timestamp": 1}]),
           "not a number": K.rows_of([candle(1000) | {"open": "x"}]), "negative": K.rows_of([candle(1000, v=-1)])}
    return (rows == [[1000, 3e-6, 2e-6, 5e-7, 1.5e-6, 100.0], [2000, 1e-6, 2e-6, 5e-7, 1.5e-6, 100.0]] and K.rows_of([]) == []
            and all(v is None for v in bad.values())), f"rows oldest first {rows}; refused: {', '.join(k for k, v in bad.items() if v is None)}"
case(1, "Pump.fun's candles as rows", "each candle as [t_ms, open, high, low, close, volume], oldest first, numbers from Pump.fun's strings; an answer not in that shape gives nothing (never a guessed row)", c1)


def c2():
    d = fresh(); asked = []
    def get(url):
        asked.append(url)
        return [candle(1_792_904_000_000), candle(1_792_904_060_000)]
    order_in = K.coins_for([(OLD, NOW - 86400), (NEW, NOW - 600), ("NoLaunchTime111111111111111111111111pump", 0)], {}, d)
    first = K.one_pass(order_in, NOW, get, d, rate=4)
    body = json.load(open(K.path_of(NEW, d)))
    order = [u.split("/coins/")[1].split("/")[0][:9] + " " + u.split("interval=")[1].split("&")[0] for u in asked]
    created = asked[0].split("createdTs=")[1]
    return (first["asked"] == 4 and order == ["MadeUpNew 1m", "MadeUpNew 1h", "MadeUpPkd 1m", "MadeUpPkd 1h"]
            and created == str(int((NOW - 600) * 1000)) and body["contract"] == "candles-1" and body["source"] == "Pump.fun"
            and body["link"] == "https://pump.fun/coin/" + NEW and body["currency"] == "USD" and set(body["intervals"]) == {"1m", "1h"}
            and body["read"]["1m"] == body["read_at"] and not os.path.exists(K.path_of("NoLaunchTime111111111111111111111111pump", d))), \
        f"asked {order} (a minute's share: 4); createdTs from the launch time; the file: {sorted(body)}, intervals {sorted(body['intervals'])}; the coin with no launch time not read"
case(2, "Newest launch first, within the share", "a page coin's two sizes (1m, 1h; 255), newest coin first, then the next coin, until the minute's share is spent; Pump.fun is told the coin's launch time; a coin with no launch time is not read", c2)


def c3():
    d = fresh(); calls = []
    good = lambda url: calls.append(url) or [candle(1_792_904_000_000)]
    K.one_pass([(NEW, NOW - 600)], NOW, good, d, rate=4)
    before = open(K.path_of(NEW, d)).read()
    again = K.one_pass([(NEW, NOW - 600)], NOW + 60, good, d, rate=4)            # 1m read 60 s ago: not due yet
    K._allow[0] = 4
    failed = K.one_pass([(NEW, NOW - 600)], NOW + 130, lambda url: None, d, rate=4)   # due, but Pump.fun did not answer
    after = open(K.path_of(NEW, d)).read()
    empty = K.one_pass([(OLD, NOW - 86400)], NOW + 130, lambda url: [], d, rate=4)
    return (again["asked"] == 0 and failed["asked"] == 1 and failed["unanswered"] == 1 and after == before
            and empty["written"] == 0 and not os.path.exists(K.path_of(OLD, d))), \
        f"a minute later nothing due ({again}); a failed re-read: {failed}, file unchanged {after == before}; no candle yet: no file ({empty})"
case(3, "Missing stays missing", "an interval is read again only after its own wait; a failed re-read leaves the last good file; an answer with no candle writes nothing (no empty interval as if no trades)", c3)


def c4():
    d = fresh()
    K.one_pass([(NEW, NOW - 600)], NOW, lambda url: [candle(1_792_904_000_000)], d, rate=1)
    one = json.load(open(K.path_of(NEW, d)))
    K.one_pass([(NEW, NOW - 600)], NOW + 60, lambda url: [candle(1_792_904_000_000), candle(1_792_904_900_000)], d, rate=1)
    two = json.load(open(K.path_of(NEW, d)))
    many = K.rows_of([candle(1_000_000 + i) for i in range(1500)])
    st = tempfile.mkdtemp(); sp = os.path.join(st, "s.json")
    json.dump({"pumpfun_candles_per_min": 9}, open(sp, "w")); set9 = K.per_min(sp)
    json.dump({"pumpfun_candles_per_min": "lots"}, open(sp, "w")); bad = K.per_min(sp)
    left = [n for n in os.listdir(os.path.join(d, "candles")) if n.endswith(".tmp")]
    return (list(one["intervals"]) == ["1m"] and sorted(two["intervals"]) == ["1m", "5m"] and two["intervals"]["1m"] == one["intervals"]["1m"]
            and len(many) == 1000 and many[-1][0] == 1_001_499 and set9 == 9 and bad == K.CANDLES_PER_MIN and left == []), \
        f"one request a minute: 1m first, 5m the next minute, the 1m rows kept; at most {len(many)} rows (the newest); the share from the settings {set9}, unusable → {bad}; no half-written file"
case(4, "One file per coin, built up interval by interval", "each read replaces only its own interval (the others stay as read); at most 1,000 rows, the newest; the share comes from the settings (unusable: the built-in one); the file is written whole", c4)


def c5():
    d = fresh()
    W1, W2, WS = "MadeUpPpenedA111111111111111111111111pump", "MadeUpPpenedB111111111111111111111111pump", "MadeUpPpenedStonk11111111111111111111111"
    for m, lp, at in ((W1, "Pump.fun curve", "2026-10-25T03:00:00Z"), (W2, "PumpSwap (graduated)", "2026-10-20T03:00:00Z"), (WS, "LaunchLab curve", "2026-10-25T03:00:00Z")):
        json.dump({"mint": m, "launchpad": lp, "launched_at": at}, open(os.path.join(d, m + ".json"), "w"))
    got = K.coins_for([(NEW, NOW - 600), (W1, NOW - 99999), ("../../etc/passwd", NOW)], {W1: NOW - 300, W2: NOW - 30, WS: NOW - 10, "NoFike11111111111111111111111111111pump": NOW, "../x": NOW + 1}, d)
    born_w1 = {m: b for m, b, _o in got}.get(W1)
    return ([m for m, _b, _o in got] == [W2, W1, NEW] and [o for _m, _b, o in got] == [True, True, False] and born_w1 == 1792897200.0), \
        f"order {[m[6:13] for m, _b, _o in got]}, opened {[o for _m, _b, o in got]}; an opened coin's launch time from its own file ({born_w1}); another launchpad's coin, a coin with no file and anything not a Solana address left out"
case(5, "the site's ask: the coins a viewer opened come first", "the Pump.fun coins on the site's wanted list (searched or opened), newest ask first, with their launch time from their own file, then the first page's Pump.fun coins newest launch first, each once; a coin of another launchpad, or with no file, or anything not a Solana address, is not read", c5)


def c6():
    d = fresh(); asked = []
    get = lambda url: asked.append(url.split("interval=")[1].split("&")[0]) or [candle(1_792_904_000_000)]
    K.one_pass(K.coins_for([], {}, d) + [(NEW, NOW - 600, True)], NOW, get, d, rate=8)
    opened = list(asked); asked.clear()
    K.one_pass([(NEW, NOW - 600, True)], NOW + 130, get, d, rate=8)             # an opened coin's 1m again after 2 minutes
    again = list(asked); asked.clear()
    K.one_pass([(OLD, NOW - 86400, False)], NOW + 130, get, d, rate=8)
    page_first = list(asked); asked.clear()
    K.one_pass([(OLD, NOW - 86400, False)], NOW + 130 + 600, get, d, rate=8)   # a page coin's 1m not before 25 minutes
    page_soon = list(asked)
    K._share[:] = [None, 0.0, False]
    steps = [K.share(0, False, 9, 12), K.share(300, False, 9, 12), K.share(600, False, 9, 12), K.share(1200, False, 9, 12),
             K.share(1210, True, 9, 12), K.share(1220, True, 9, 12), K.share(1290, True, 9, 12), K.share(1300, False, 9, 12),
             K.share(1900, False, 9, 12), K.share(1910, True, 9, 12)]
    K._share[:] = [None, 0.0, False]
    capped = [K.share(t * 600, False, 11, 12) for t in range(4)]
    return (opened == ["1m", "5m", "15m", "1h"] and page_first == ["1m", "1h"] and page_soon == [] and steps == [9, 9, 10, 11, 5, 5, 5, 5, 6, 3] and again == ["1m"]
            and capped == [11, 12, 12, 12]), \
        f"an opened coin: {opened}; a page coin: {page_first}, nothing again within 10 minutes {page_soon}; the share over time {steps} (up one per 10 minutes, halved once per refusal however long its rest, then up again; a new refusal halves again); never past the budget {capped}"
case(6, "the whole page fresh, site first", "a coin a viewer opened gets all four sizes at full speed; every other page coin the two the site builds from, each just inside the site's stale time; the share steps up while Pump.fun refuses nothing, never past its whole budget, and halves at a refusal", c6)


def c7():
    sys.path.insert(0, os.path.join(HERE, "..", "stage2"))
    import pumpfun_api as PF
    real = PF._BUCKET_DB; PF._BUCKET_DB = os.path.join(tempfile.mkdtemp(), "b.sqlite")
    try:
        none_said = PF.lane_share()
        PF.lane_share(value=9)
        take = lambda lane: sum(PF._take("swap-api.pump.fun", max_wait=0, lane=lane) for _ in range(40))
        candles, trades = take(PF.CANDLE_LANE), take("")
        coins = sum(PF._take("frontend-api-v3.pump.fun", max_wait=0) for _ in range(40))
    finally:
        PF._BUCKET_DB = real
    return (none_said == 0.0 and candles == 9 and trades == 6 and coins == 25), \
        f"no share said: {none_said} (the trade reads keep it all); with 9 a minute: the candles' lane holds {candles} at once, the trade reads' {trades} (their part of the burst), the coin-record service untouched ({coins})"
case(7, "the candles' own lane of Pump.fun's budget", "the candle reads get exactly their share and the trade reads the rest of the trade service's budget (so the trade reads can no longer take it all), never more than Pump.fun's own total; the other Pump.fun service keeps its own budget", c7)


print(f"\n{sum(results)}/{len(results)} passed")
raise SystemExit(0 if all(results) else 1)
