"""Seen coins into the feed before any score: plain-English tests on a temporary feed folder with made-up list
records and made-up chain reads; the network blocked. The file's shape (as posted to the site), what wins over what, the fee fill with
its budget and order, a failed read tried again, the day's lifetime, the gate that keeps tests from writing live files, and the
real Stonk.fun answer's record fields. Run:  python3 test_seen.py"""
import json, os, socket, sys, tempfile, time, urllib.request

CALLS = []
def _blocked(*a, **k):
    CALLS.append(a[:1]); raise OSError("network blocked in this test")
urllib.request.urlopen = _blocked
socket.create_connection = _blocked

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE); sys.path.insert(0, os.path.join(HERE, "..", "feed")); sys.path.insert(0, os.path.join(HERE, "..", "stage2"))
import seen_feed as SF
import feed_export as F
import seen as S
import stonkfun as SK
import scanner as SC
import readers as R
from b58 import b58e

TMP = tempfile.mkdtemp(); F.FEED_DIR = os.path.join(TMP, "frontend-feed"); os.makedirs(F.FEED_DIR)
NOW = float(int(time.time()))
A, B, C, D, POOL = (b58e(bytes([i]) * 32) for i in (41, 42, 43, 44, 45))

results = []
def case(n, title, should, fn):
    try:
        ok, text = fn()
    except Exception as e:
        import traceback; traceback.print_exc()
        ok, text = False, f"CRASH {type(e).__name__}: {e}"
    results.append(ok)
    print(f"\n{n:>2}. {title}\n    should: {should}\n    did:    {text}\n    {'PASS' if ok else 'FAIL'}")

def fresh():
    for n in os.listdir(F.FEED_DIR):
        if os.path.isfile(os.path.join(F.FEED_DIR, n)):
            os.remove(os.path.join(F.FEED_DIR, n))
    S._STATE.clear()

def rec(mint, seen_by="pumpfun_pool", created=NOW - 300, name="Coin", symbol="CN", image="https://img/x.png", pool=None):
    return {"mint": mint, "seen_by": seen_by, "created": created, "name": name, "symbol": symbol, "image": image, "pool": pool}

def scored_file(mint):
    json.dump({"mint": mint, "score": 40, "display": "40", "coverage": 0.5, "label": None}, open(os.path.join(F.FEED_DIR, mint + ".json"), "w"))

def load(mint):
    return json.load(open(os.path.join(F.FEED_DIR, mint + ".json")))

# made-up chain
def mint_read(fee_bps, auth=R.STONKFUN_COLLECTOR):
    def f(m, log):
        log.add("token program", R.TOKEN_2022, "program id", f"getAccountInfo {m}", 7)
        return {"mint": m, "program": R.TOKEN_2022, "decimals": 6, "supply_raw": 10 ** 15, "powers": {}, "transfer_fee_bps": fee_bps or None, "withdraw_withheld_authority": auth if fee_bps else None}
    return f
def rewards_stub(m, plat, log, pool_state=None, **k):
    bps = m.get("transfer_fee_bps") or 0
    log.add("transfer fee", bps, "bps", "getAccountInfo (Token-2022 transfer-fee extension; none means no fee)")
    if not bps:
        return {"fee_bps": 0, "pct": 0.0, "fee_kind": "none", "program": None, "standard_pct": None, "standard_basis": None, "standard_links": None}
    if plat and plat.get("verified") and plat.get("mode") == "reward mode":
        return {"fee_bps": bps, "pct": bps / 100, "fee_kind": "rewards_standard", "program": "StonkFun reward mode", "standard_pct": 3.0, "standard_basis": "settings", "standard_links": None}
    return {"fee_bps": bps, "pct": bps / 100, "fee_kind": "outside_norm", "program": None, "standard_pct": None, "standard_basis": None, "standard_links": None}
def pool_stub(pool, m, log):
    return {"address": pool, "platform_config": "PC", "quote_mint": R.WSOL} if pool == POOL else None
def platform_stub(pc, log, get=None):
    return {"name": "StonkFun", "mode": "reward mode", "words": "StonkFun (reward mode)", "verified": True}


def t1():
    r = SF.seen_record(A, "pumpfun_pool", NOW - 10, launchpad="Pump.fun curve", name=" Coin ", ticker="$CN", image_url="https://img/x.png", launched_at=NOW - 300)
    bare = SF.seen_record(B, "stonkfun_list", NOW)
    try:
        SF.seen_record(C, "somewhere", NOW); bad = False
    except ValueError:
        bad = True
    return (r["score"] is None and r["display"] == "not scored yet" and r["coverage"] == 0 and r["label"] is None and r["seen"] is True and r["seen_by"] == "pumpfun_pool"
            and r["seen_at"].endswith("Z") and r["launchpad"] == "Pump.fun curve" and r["name"] == "Coin" and r["ticker"] == "CN" and r["image_url"] == "https://img/x.png" and r["launched_at"]
            and "name" not in bare and "image_url" not in bare and "launched_at" not in bare and "facts" not in bare and bad), \
        f"required: score {r['score']}, display {r['display']!r}, coverage {r['coverage']}, label {r['label']}; seen {r['seen']} by {r['seen_by']} at {r['seen_at']}; bare record keys {sorted(bare)}; an unknown seen_by refused {bad}"
case(1, "The seen file's shape as posted to the site: the four required fields, seen/seen_at/seen_by, and only what the list gave", "score null, 'not scored yet', coverage 0, label null, seen true; absent fields absent; an unknown seen_by refused", t1)

def t2():
    fresh()
    p1 = SF.write_seen(SF.seen_record(A, "pumpfun_pool", NOW))
    p2 = SF.write_seen(SF.seen_record(A, "pumpfun_pool", NOW + 5, name="Later"))
    upd = SF.update_seen(A, name="Later")
    scored_file(B)
    p3 = SF.write_seen(SF.seen_record(B, "pumpfun_pool", NOW))
    u3 = SF.update_seen(B, name="Nope")
    open(os.path.join(F.FEED_DIR, C + ".json"), "w").write("{broken")
    p4 = SF.write_seen(SF.seen_record(C, "pumpfun_pool", NOW))
    return bool(p1) and p2 is None and upd and load(A).get("name") == "Later" and p3 is None and u3 is False and load(B)["score"] == 40 and "name" not in load(B) and p4 is None and SF.is_seen_file(A) and not SF.is_seen_file(B), \
        f"created {bool(p1)}, a second create refused {p2 is None}, an update while seen {upd}; over a scored file: create {p3}, update {u3} (score kept {load(B)['score']}); over an unreadable file: {p4}"
case(2, "A seen file is created once and only created; a scored or unreadable file is never replaced or updated; fields come in through update_seen", "the second create and every write over a scored file refused; the update of a seen file lands", t2)

def t3():
    fresh(); scored_file(C)
    n1 = S.note_seen([rec(A), rec(B, "stonkfun_list", pool=None), rec(C)], NOW)
    n2 = S.note_seen([rec(A), rec(B, "stonkfun_list", pool=POOL)], NOW + 60)
    a, b = load(A), load(B)
    return n1 == 2 and n2 == 0 and a["seen_by"] == "pumpfun_pool" and a["launchpad"] == "Pump.fun curve" and b["launchpad"] == "LaunchLab curve" and "facts" not in a and S._STATE[B]["pool"] == POOL and load(C)["score"] == 40 and not CALLS, \
        f"first pass wrote {n1} (the scored coin skipped), second pass {n2}; A: {a['launchpad']}, B: {b['launchpad']}; B's pool learned later: {S._STATE[B]['pool'] == POOL}; network calls {len(CALLS)}"
case(3, "note_seen: a file at once for every coin looked at, none for a scored one, none twice; no chain read", "two files, the scored coin untouched, the second pass writes nothing, the pool filled in later", t3)

def t4():
    fresh()
    S.note_seen([rec(A, created=NOW - 100), rec(B, "stonkfun_list", created=NOW - 500, pool=POOL), rec(C, "stonkfun_list", created=NOW - 50, pool=POOL), rec(D, created=NOW - 900)], NOW)
    reads = []
    def rm(m, log):
        reads.append(m); return mint_read(300 if m == B else 0)(m, log)
    r1 = S.fill_fees(1, read_mint=rm, read_pool=pool_stub, platform=platform_stub, rewards=rewards_stub, now=NOW)
    c = load(C)
    fc = next(f for f in c["facts"] if f["id"] == "transfer_fee")
    r2 = S.fill_fees(10, read_mint=rm, read_pool=pool_stub, platform=platform_stub, rewards=rewards_stub, now=NOW)
    b = load(B); fb = next(f for f in b["facts"] if f["id"] == "transfer_fee")
    r3 = S.fill_fees(10, read_mint=rm, rewards=rewards_stub)
    return (reads == [C, B] and r1["written"] == 1 and r2["written"] == 1 and r3["read"] == 0
            and b["launchpad"] == "LaunchLab curve (StonkFun (reward mode))" and fb["value"] == 3.0 and fb["fee_kind"] == "rewards_standard" and fb["fee_case"] == "rewards_standard" and fb["program"] == "StonkFun reward mode" and fb["standard_pct"] == 3.0 and fb["source"] == "Solana chain" and fb["read_at"] and fb["link"]
            and fc["value"] == 0 and fc["fee_kind"] == "none" and fc["fee_case"] == "none" and "facts" not in load(A) and "facts" not in load(D)), \
        f"budget 1 read {reads[:1]} (the newest Stonk.fun coin), then {reads[1:]}; B {b['launchpad']}, fee {fb['value']}% {fb['fee_case']} standard {fb['standard_pct']}; C fee {fc['value']} {fc['fee_case']}; the Pump.fun coins A and D never read, their seen files without a fee fact; a third pass reads nothing"
case(4, "fill_fees: a budget a pass, LaunchLab coins only, newest first; the pool and platform verified and the launchpad words set; the fee fact as the contract has it", "C (the newer Stonk.fun coin) then B; the Pump.fun coins never read; nothing left on the third pass", t4)

def t5():
    fresh(); S.note_seen([rec(A, "stonkfun_list", pool=POOL), rec(B, "stonkfun_list", pool=POOL)], NOW)
    calls = {"n": 0}
    def flaky(m, log):
        calls["n"] += 1
        if calls["n"] == 1:
            return None
        return mint_read(0)(m, log)
    r1 = S.fill_fees(1, read_mint=flaky, read_pool=pool_stub, platform=platform_stub, rewards=rewards_stub, now=NOW)
    nothing_after_fail = "facts" not in load(A)
    r2 = S.fill_fees(1, read_mint=flaky, read_pool=pool_stub, platform=platform_stub, rewards=rewards_stub, now=NOW)
    scored_file(B)
    r3 = S.fill_fees(5, read_mint=flaky, read_pool=pool_stub, platform=platform_stub, rewards=rewards_stub, now=NOW)
    terms = (r1["failed"] == 1, nothing_after_fail, r2["written"] == 1, SF.has_fee(A), r3["skipped"] == 1, load(B)["score"] == 40)
    return all(terms), f"terms {terms}; " \
        + f"first read failed ({r1['failed']}), nothing written; next pass written {r2['written']}; a coin scored meanwhile: skipped {r3['skipped']}, its scored file kept"
case(5, "A failed read is tried again next pass, never guessed; a coin scored meanwhile is skipped", "failed 1 then written 1; the scored coin's file untouched", t5)

def t6():
    fresh()
    S.note_seen([rec(A, "stonkfun_list", created=NOW - 200, pool=POOL)], NOW)
    standard_mode = lambda pc, log, get=None: {"name": "StonkFun", "mode": "standard mode", "words": "StonkFun (standard mode)", "verified": True}
    S.fill_fees(1, read_mint=mint_read(800), read_pool=pool_stub, platform=standard_mode, rewards=rewards_stub, now=NOW)
    f = next(x for x in load(A)["facts"] if x["id"] == "transfer_fee")
    return f["value"] == 8.0 and f["fee_kind"] == "outside_norm" and "fee_case" not in f and "program" not in f, f"8% fee outside the norm on a seen file: fee_kind {f['fee_kind']}, fee_case present {'fee_case' in f}"
case(6, "A fee outside the norm on a seen file shows the fee and no case (the reason needs the score)", "fee_kind outside_norm, no fee_case", t6)

def t7():
    fresh()
    SF.write_seen(SF.seen_record(A, "pumpfun_pool", NOW - 90000)); SF.write_seen(SF.seen_record(B, "pumpfun_pool", NOW - 3600)); scored_file(C)
    json.dump({"contract": "1.1", "coins": {}}, open(os.path.join(F.FEED_DIR, "trigger-seen.json"), "w"))
    S._STATE[A] = {"fee": False}
    gone = S.expire(NOW)
    left = sorted(os.listdir(F.FEED_DIR))
    return gone == [A] and A not in S._STATE and left == sorted([B + ".json", C + ".json", "trigger-seen.json"]), f"removed {len(gone)} (a day old, unscored); kept {left}"
case(7, "After a day unscored a seen file is removed; fresh seen files, scored files and trigger-seen.json stay", "one removed, three kept", t7)

def t8():
    fresh()
    SC.DB = os.path.join(TMP, "scanner.sqlite"); SC.SETTINGS = os.path.join(TMP, "settings.json")
    json.dump({"score_chains": ["solana"], "solana_workers": 1, "solana_rescores": "paused", "solana_trigger": "on", "solana_trigger_volume_usd": 10000, "solana_trigger_min_buys": 10}, open(SC.SETTINGS, "w"))
    SC._TRIG.update(on=None, line=None, buys=None, note=None); SC._SITE.update(at=time.time() + 10 ** 6, mints=[]); SC._SHOWN.update(at=time.time() + 10 ** 6, mints=[])
    c = SC.db()
    said = SC.watch_pumpfun(c, now=NOW, lists=lambda: [(A, NOW - 600)], read=lambda ms: {})
    return os.listdir(F.FEED_DIR) == [] and "seen" not in said, f"a test's list: files written {os.listdir(F.FEED_DIR)}; words: {said!r}"
case(8, "The gate: a trigger pass handed a test list writes no seen file (only the real pool and list do)", "no file, no seen words", t8)

def t9():
    fresh()
    saved = json.load(open(os.path.join(HERE, "..", "tools", "profiles", "2026-10-17-stonkfun-launches-recent.json")))["answer"]
    SK.LAST_RECORDS.clear(); got = SK.recent(get=lambda u: saved)
    r = SK.LAST_RECORDS[got[0][0]]
    n = S.note_seen([SK.LAST_RECORDS[m] for m, _t, _p in got], NOW)
    f = load(got[0][0])
    return len(SK.LAST_RECORDS) == 6 and r["name"] and r["symbol"] and r["pool"] and r["created"] > 1_700_000_000 and r["seen_by"] == "stonkfun_list" and n == 6 and f["name"] == r["name"] and f["ticker"] == r["symbol"] and f["launchpad"] == "LaunchLab curve" and bool(f["launched_at"]), \
        f"6 real launches: record {dict((k, (v[:12] if isinstance(v, str) else v)) for k, v in r.items())}; 6 seen files; the first file's name {f['name']!r}, ticker {f['ticker']!r}, launched {f['launched_at']}"
case(9, "The real Stonk.fun answer (saved 2026-10-17) gives each seen file its name, ticker, pool and launch time", "six files with the list's own fields", t9)

def t10():
    """the team's R1, the interleaving forced: a score lands while the seen writer is between its check and its write."""
    import threading
    fresh()
    # (a) the create: the writer's own check saw nothing, yet a scored file appears before its write -> exclusive create refuses
    real_read = SF.read_file
    SF.read_file = lambda m: None
    try:
        scored_file(A)
        created = SF.write_seen(SF.seen_record(A, "pumpfun_pool", NOW))
    finally:
        SF.read_file = real_read
    # (b) the update: the exporter holds the lock and writes the score while an update is waiting; the update must then give way
    SF.write_seen(SF.seen_record(B, "pumpfun_pool", NOW))
    order = []
    def exporter():
        with F.file_lock(B):
            order.append("exporter in"); time.sleep(0.4)
            scored_file(B); order.append("score written")
    t = threading.Thread(target=exporter); t.start(); time.sleep(0.1)
    order.append("update starts"); u = SF.update_seen(B, facts=[{"id": "transfer_fee"}]); order.append(f"update {u}")
    t.join()
    # (c) expire: an old seen file that gets its score while expire waits for the lock is kept
    SF.write_seen(SF.seen_record(C, "pumpfun_pool", NOW - 90000))
    def exporter_c():
        with F.file_lock(C):
            time.sleep(0.4); scored_file(C)
    t2 = threading.Thread(target=exporter_c); t2.start(); time.sleep(0.1)
    gone = SF.expire(NOW); t2.join()
    return (created is None and load(A)["score"] == 40 and u is False and load(B)["score"] == 40 and "facts" not in load(B)
            and order == ["exporter in", "update starts", "score written", "update False"] and gone == [] and load(C)["score"] == 40), \
        f"create over a score that appeared after the check: {created}; update waiting on the exporter's lock: {order}; expire while a score lands: removed {gone}, C's score {load(C)['score']}"
case(10, "R1: a score landing between a seen writer's check and its write always wins; the create is exclusive, the update and expire wait for the coin's lock and re-check", "the create refused, the update gives way after the exporter's write, expire keeps the saved result", t10)

def t11():
    fresh()
    old = NOW - SF.SEEN_WINDOW - 1; young = NOW - SF.SEEN_WINDOW + 60
    SF.write_seen(SF.seen_record(A, "pumpfun_pool", old)); SF.write_seen(SF.seen_record(B, "pumpfun_pool", young))
    gone = SF.expire(NOW)
    return gone == [A] and B + ".json" in os.listdir(F.FEED_DIR), f"a second past the day: removed {gone == [A]}; a minute inside it: kept {B + '.json' in os.listdir(F.FEED_DIR)} (UTC parsing, whatever the machine's zone)"
case(11, "expire reads seen_at as UTC, exactly: one second past the day goes, a minute inside it stays", "A removed, B kept", t11)

def t12():
    fresh(); S._STATE.clear()
    recs = [{"mint": A, "seen_by": "pumpfun_pool", "created": NOW - 60, "name": "a", "symbol": "A", "graduated": True},
            {"mint": B, "seen_by": "pumpfun_pool", "created": NOW - 60, "name": "b", "symbol": "B", "graduated": False},
            {"mint": C, "seen_by": "stonkfun_list", "created": NOW - 60, "name": "c", "symbol": "C", "pool": POOL, "graduated": True}]
    S.note_seen(recs, NOW)
    got = {m: SF.read_file(m).get("launchpad") for m in (A, B, C)}
    ok = got[A] == "PumpSwap (graduated)" and got[B] == "Pump.fun curve" and got[C] == "LaunchLab curve"
    return ok, f"a graduated Pump.fun record: '{got[A]}'; one on its curve: '{got[B]}'; a Stonk.fun record marked graduated: '{got[C]}' (the flag is Pump.fun's only)"
case(12, "Item 54: a new seen coin's launchpad words follow the launchpad's own record", "a Pump.fun coin its record shows graduated is written 'PumpSwap (graduated)' at once; on its curve 'Pump.fun curve'; a LaunchLab coin unchanged", t12)


def t13():
    fresh(); S._STATE.clear()
    rec = lambda m, g: {"mint": m, "seen_by": "pumpfun_pool", "created": NOW - 60, "name": "x", "symbol": "X", "graduated": g}
    S.note_seen([rec(A, False)], NOW)
    scored = {"mint": B, "chain": "solana", "launchpad": "Pump.fun curve", "score": 46, "display": 46, "coverage": 0.6, "label": None,
              "as_of": "2026-10-22T10:00:00+00:00", "facts": [{"id": "valuation", "value": 1}]}
    json.dump(scored, open(os.path.join(F.FEED_DIR, B + ".json"), "w"))
    ll = dict(scored, mint=C, launchpad="LaunchLab curve (StonkFun (standard mode))")
    json.dump(ll, open(os.path.join(F.FEED_DIR, C + ".json"), "w"))
    open(os.path.join(F.FEED_DIR, D + ".json"), "w").write("{ broken")
    S.note_seen([rec(A, False), rec(B, False), rec(C, False), rec(D, False)], NOW + 30)
    before = {m: open(os.path.join(F.FEED_DIR, m + ".json")).read() for m in (A, B, C, D)}
    real = SF.follow_graduation; calls = []
    SF.follow_graduation = lambda m: calls.append(m) or real(m)
    try:
        S.note_seen([rec(A, True), rec(B, True), rec(C, True), rec(D, True)], NOW + 60)
        S.note_seen([rec(A, True), rec(B, True), rec(C, True), rec(D, True)], NOW + 90)
    finally:
        SF.follow_graduation = real
    a, b = SF.read_file(A), json.load(open(os.path.join(F.FEED_DIR, B + ".json")))
    same_b = {k: v for k, v in b.items() if k != "launchpad"} == {k: v for k, v in scored.items() if k != "launchpad"}
    c_same = open(os.path.join(F.FEED_DIR, C + ".json")).read() == before[C]
    d_same = open(os.path.join(F.FEED_DIR, D + ".json")).read() == before[D]
    none = SF.follow_graduation(b58e(bytes([46]) * 32))
    ok = (a["launchpad"] == "PumpSwap (graduated)" and a.get("seen") is True and b["launchpad"] == "PumpSwap (graduated)" and same_b
          and c_same and d_same and sorted(calls) == sorted([A, B, C, D]) and none is False)
    return ok, f"the seen file: '{a['launchpad']}'; the scored file: '{b['launchpad']}', every other field as scored {same_b}; the LaunchLab file untouched {c_same}; the unreadable file untouched {d_same}; asked once per coin over two passes ({len(calls)} calls); no file: {none}"
case(13, "Item 54: a coin that graduates after its file was written", "the file's launchpad words follow on the pass its record turns graduated, a seen file or a scored one, under the coin's lock, and only those words (the score, its figures and time stay as scored); a LaunchLab or unreadable file untouched; once per coin", t13)


def t14():
    page = {"coins": [{"mint": A, "createdMs": NOW * 1000, "name": "a", "symbol": "A", "graduated": True},
                      {"mint": B, "createdMs": NOW * 1000, "name": "b", "symbol": "B", "graduated": False},
                      {"mint": C, "createdMs": NOW * 1000, "name": "c", "symbol": "C", "graduated": "yes"}], "total": 3}
    import io
    real = urllib.request.urlopen
    urllib.request.urlopen = lambda url, timeout=5: io.BytesIO(json.dumps(page).encode())
    try:
        SC._POOL.update(at=0.0, mints=[], records={})
        SC._pool_mints()
        got = {m: SC._POOL["records"][m].get("graduated") for m in (A, B, C)}
    finally:
        urllib.request.urlopen = real; SC._POOL.update(at=0.0, mints=[], records={})
    return got == {A: True, B: False, C: False}, f"kept from the app's pool records: {got} (only a true value counts)"
case(14, "Item 54: the scanner keeps the app's own graduated flag from its Pump.fun pool records", "true only when the record says true; anything else is not graduated", t14)

def t15():
    import sqlite3
    fresh()
    E, G, H, K = (b58e(bytes([i]) * 32) for i in (51, 52, 53, 54))
    db = os.path.join(tempfile.mkdtemp(), "scanner.sqlite"); real = SF.SCANNER_DB; SF.SCANNER_DB = db
    c = sqlite3.connect(db); c.execute("CREATE TABLE IF NOT EXISTS tokens (chain TEXT, token TEXT, last_ok REAL)"); c.execute("DELETE FROM tokens")
    c.executemany("INSERT INTO tokens VALUES ('solana', ?, ?)", [(E, None), (G, None), (H, NOW - 5 * 86400)]); c.commit(); c.close()
    iso = lambda t: time.strftime("%Y-%m-%dT%H:%M:%S+00:00", time.gmtime(t))
    failed = lambda m, t: json.dump({"mint": m, "score": None, "display": "Technical error, retrying", "label": "Technical error, retrying", "coverage": 0.158, "as_of": iso(t)},
                                    open(os.path.join(F.FEED_DIR, m + ".json"), "w"))
    failed(E, NOW - 3 * 86400)                       # never scored, last tried 3 days ago: goes
    failed(G, NOW - 3600)                            # never scored, tried an hour ago: still being retried, stays
    failed(H, NOW - 3 * 86400)                       # scored once, its last re-score failed: stays
    failed(K, NOW - 3 * 86400)                       # no scanner record: unknown, stays
    try:
        gone = S.expire(NOW)
        SF.SCANNER_DB = os.path.join(TMP, "missing", "x.sqlite"); failed(E, NOW - 3 * 86400); unread = S.expire(NOW)
    finally:
        SF.SCANNER_DB = real
    left = sorted(os.listdir(F.FEED_DIR))
    return gone == [E] and unread == [] and left == sorted(m + ".json" for m in (E, G, H, K)), \
        f"removed {len(gone)} (never scored, last try 3 days ago); kept the one tried an hour ago, the once-scored one and the one with no record; with the scanner's record unreadable: {len(unread)} removed"
case(15, "the team 2026-10-25: a never-scored coin's failed file leaves after a day", "a file that holds only a technical error goes a day after its last try when the scanner's record shows the coin never scored; one still being retried, one scored before, one with no record, or an unreadable record: kept", t15)



def t16():
    fresh()
    asked = []; real = SF.never_scored; SF.never_scored = lambda m, db=None: asked.append(m) or True
    iso = lambda t: time.strftime("%Y-%m-%dT%H:%M:%S+00:00", time.gmtime(t))
    young, old = b58e(bytes([61]) * 32), b58e(bytes([62]) * 32)
    for m, t in ((young, NOW - 3600), (old, NOW - 3 * 86400)):
        json.dump({"mint": m, "score": None, "display": "Technical error, retrying", "as_of": iso(t)}, open(os.path.join(F.FEED_DIR, m + ".json"), "w"))
    calls = []; real_exp = SF.expire; SF.expire = lambda now=None: calls.append(now) or real_exp(now)
    try:
        S._expired_at[0] = 0.0
        S.pass_seen([], NOW); S.pass_seen([], NOW); S.pass_seen([], NOW)
        first = len(calls)
        S._expired_at[0] = time.time() - S.EXPIRE_EVERY_S - 1; S.pass_seen([], NOW)
    finally:
        SF.never_scored = real; SF.expire = real_exp
    return first == 1 and len(calls) == 2 and asked == [old], \
        f"three passes in a row: the folder swept {first} time(s); after {S.EXPIRE_EVERY_S // 60} min: swept again; the scanner's record asked about {len(asked)} coin(s) (only the one old enough to go)"
case(16, "The server's main loop: the feed folder is swept at most every ten minutes, and the scanner's record is asked only about a file old enough to go", "back-to-back passes sweep once; the next sweep comes after ten minutes; a failed file younger than a day is never looked up", t16)


print(f"\nnetwork calls attempted: {len(CALLS)}")
print(f"{sum(results)}/{len(results)} passed")
sys.exit(0 if all(results) and not CALLS else 1)
