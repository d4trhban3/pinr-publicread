"""Counting launches a day against the server's workers: plain-English tests on
made-up pages and a made-up status line. Reads no network, writes nothing. Run:  python3 test_count_launches.py"""
import importlib.util, os, sys, time
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from b58 import b58e
spec = importlib.util.spec_from_file_location("count_launches", os.path.join(HERE, "..", "tools", "count_launches.py"))
C = importlib.util.module_from_spec(spec); spec.loader.exec_module(C)

results = []
def case(n, title, should, fn):
    try:
        ok, text = fn()
    except Exception as e:
        ok, text = False, f"CRASH {type(e).__name__}: {e}"
    results.append(ok)
    print(f"\n{n:>2}. {title}\n    should: {should}\n    did:    {text}\n    {'PASS' if ok else 'FAIL'}")

NOW = 1760700000.0                                           # a fixed "now"
def rec(i, minutes_ago, key="launchedAt"):
    t = NOW - minutes_ago * 60
    v = int(t * 1000) if key == "createdMs" else time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(t))
    return {"mint": b58e(bytes([i % 250 + 1]) * 32), key: v, "name": f"coin {i}"}


def t1():
    pages = [{"launches": [rec(i, 10 * i) for i in range(1, 101)]},          # 10 min apart: 100 records over 1,000 min
             {"launches": [rec(i, 10 * i) for i in range(101, 201)]},        # all older than a day
             {"launches": [rec(i, 10 * i) for i in range(201, 301)]}]
    got = C.count_window(iter(pages), NOW - 24 * 3600, NOW)
    return got["count"] == 144 and got["pages"] == 3, f"{got['count']} launches in the day (10 minutes apart: 144 fit), stopped after {got['pages']} pages"
case(1, "A day's launches are counted over newest-first pages, and the paging stops at the first wholly older page", "144 of 300 records fall in the last 24 hours (page 2 still holds some); the third page, wholly older, is read and ends the paging", t1)

def t2():
    pages = [{"pools": [rec(1, 5), rec(1, 5), rec(2, 7, key="createdMs"), {"mint": "notanaddress", "launchedAt": "x"}, {"name": "no time"}, rec(3, 5000)]}]
    got = C.count_window(iter(pages), NOW - 3600, NOW)
    return got["count"] == 2 and got["undated"] == 2, f"{got['count']} counted (a repeat skipped, a milliseconds time read), {got['undated']} undated records not counted"
case(2, "A repeated coin counts once, both time shapes are read, a record with no time is not counted", "2 in the hour; the undated ones named, never guessed into the count", t2)

def t3():
    first_bad = C.count_window(iter([{"_error": "URLError"}]), NOW - 3600, NOW)
    pages = [{"launches": [rec(i, 10 * i) for i in range(1, 101)]}, {"launches": [rec(i, 10 * i) for i in range(101, 121)]}, {"_error": "HTTPError"}]
    mid_bad = C.count_window(iter(pages), NOW - 24 * 3600, NOW)
    return (first_bad["count"] == 0 and first_bad["partial"] and mid_bad["count"] == 120 and mid_bad["partial"] and "page 3" in mid_bad["partial"]), \
        f"first page refused: count {first_bad['count']}, partial {first_bad['partial']!r}; third page refused: count {mid_bad['count']}, partial {mid_bad['partial']!r}"
case(3, "A refused page leaves a PARTIAL count, said so (N1)", "a first page refused: 0 and partial; a third page refused: the 120 read so far, marked a minimum, never read as the whole day", t3)

def t4():
    rate = C.air_rate("tokens watched 1 | scored 2\nSolana may hold 4 of 4 scoring workers\nSolana scores finished in the last hour: 45 first scores, 34 follow-ups or re-scores | in progress: 3 Solana scores, of them 1 follow-up")
    return rate == {"first": 45, "followups": 34, "busy": 3, "workers": 4}, f"{rate}"
case(4, "The server's own rate and how busy its workers were are read from its status lines", "45 first scores, 34 follow-ups, 3 of 4 workers busy at the read", t4)

def t5():
    counts = {"Stonk.fun": {"primary": {"count": 120, "per_hour": {"a": 9, "b": 4}, "undated": 0, "pages": 2, "partial": None}, "cross_checks": {}},
              "bonk.fun": {"primary": {"count": 1500, "per_hour": {"a": 90}, "undated": 0, "pages": 15, "partial": None}, "cross_checks": {}}}
    full = C.summarise(counts, 24, {"first": 45, "followups": 34, "busy": 4, "workers": 4}, 4)
    half = C.summarise(counts, 24, {"first": 45, "followups": 34, "busy": 2, "workers": 4}, 4)
    wf, wh = C.words(full, 24), C.words(half, 24)
    return (full["need_a_day"] == 1620 and full["room_a_day"] == 0 and full["carries_all"] is False and "No room" in wf and "do NOT carry" in wf
            and half["room_a_day"] == 1896 and half["carries_all"] is True and "CARRY" in wh), \
        f"need {full['need_a_day']}; workers busy 4 of 4: room {full['room_a_day']} a day, carries {full['carries_all']}; busy 2 of 4: room {half['room_a_day']}, carries {half['carries_all']}"
case(5, "The comparison is against the room left, not the work done (N3)", "workers busy all the time: no room, they do not carry; half busy: room 1,896 a day against 1,620 needed, they carry", t5)

def t6():
    counts = {"Stonk.fun": {"primary": {"count": 60, "per_hour": {"a": 5}, "undated": 0, "pages": 1, "partial": None},
                            "cross_checks": {"Stonk.fun standard (Raydium list)": {"count": 60, "per_hour": {"a": 5}, "undated": 0, "pages": 1, "partial": None}}},
              "bonk.fun": {"primary": {"error": "not countable keyless"}, "cross_checks": {}}}
    s = C.summarise(counts, 12, {"first": 45, "followups": 34, "busy": 2, "workers": 4}, 4)
    w = C.words(s, 12)
    return s["launches_a_day"] == {"Stonk.fun": 120, "bonk.fun": None} and s["need_a_day"] == 120 and "not countable keyless" in w and "cross-check" in w and "not added" in w, \
        f"{s['launches_a_day']}; need {s['need_a_day']} (the Raydium cross-check of the same coins not added); words name the uncountable one"
case(6, "A cross-check never adds coins, and an uncountable launchpad is said so (N2)", "Stonk.fun 120 a day from its ledger; Raydium's list of the same coins shown as a cross-check only; bonk.fun 'not countable keyless'", t6)

def t7():
    counts = {"Stonk.fun": {"primary": {"count": 200, "per_hour": {"a": 20}, "undated": 0, "pages": 3, "partial": "page 3 could not be read (HTTPError): the count is a minimum"}, "cross_checks": {}}}
    under = C.summarise(counts, 24, {"first": 45, "followups": 34, "busy": 2, "workers": 4}, 4)      # room 1,896 > at least 200: not settled
    over = C.summarise(counts, 24, {"first": 45, "followups": 34, "busy": 4, "workers": 4}, 4)       # room 0 < at least 200: settled, no
    return under["need_is_minimum"] and under["carries_all"] is None and "at least 200" in C.words(under, 24) and over["carries_all"] is False, \
        f"partial count under the room: carries {under['carries_all']} ({'Not settled' in C.words(under, 24)}); partial count over the room: carries {over['carries_all']}"
case(7, "A partial count settles the comparison only when even the minimum is past the room", "at least 200 under a room of 1,896: not settled; at least 200 against no room: they do not carry", t7)


print(f"\n{sum(results)}/{len(results)} passed")
sys.exit(0 if all(results) else 1)
