"""a coin with no trade for 24 hours goes quiet; no work is spent on it until it trades.
Made-up coins; DexScreener and the tape stubbed; a temporary database and feed folder; no network.
Run:  python3 test_quiet.py"""
import json, os, sys, tempfile, time
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path[:0] = [HERE, os.path.join(HERE, "..", "stage2"), os.path.join(HERE, "..", "stage3")]
import scanner as S
S.DB = os.path.join(tempfile.mkdtemp(), "scanner.sqlite")
import quiet as Q

results = []
def case(n, title, should, fn):
    try:
        ok, text = fn()
    except Exception as e:
        import traceback; traceback.print_exc()
        ok, text = False, f"CRASH {type(e).__name__}: {e}"
    results.append(ok)
    print(f"\n{n:>2}. {title}\n    should: {should}\n    did:    {text}\n    {'PASS' if ok else 'FAIL'}")

NOW = 1_790_000_000.0
DAY = 86400
def coin(tag):
    return (("MadeUp" + tag) + "1" * 44)[:44].replace("0", "1").replace("O", "P").replace("I", "J").replace("l", "k")
A, B, C, D, E, H = (coin(t) for t in ("Asleep", "Busy", "Young", "Dark", "Taped", "Hand"))
pair = lambda n, created=NOW - 3 * DAY: {"dex": "raydium", "created": created, "txns_h24": n}


def c1():
    j = {"active": Q.judge([pair(0), pair(3)], NOW - 3 * DAY, NOW), "quiet": Q.judge([pair(0)], NOW - 3 * DAY, NOW),
         "young": Q.judge([pair(0, NOW - 3600)], None, NOW), "young by launch": Q.judge([pair(0)], NOW - 3600, NOW),
         "no pair": Q.judge([], NOW - 3 * DAY, NOW), "count missing": Q.judge([pair(0), pair(None)], NOW - 3 * DAY, NOW),
         "age unknown": Q.judge([pair(0, None)], None, NOW)}
    return (j == {"active": "active", "quiet": "quiet", "young": None, "young by launch": None, "no pair": None, "count missing": None, "age unknown": None}), str(j)
case(1, "Quiet only on evidence", "quiet only when DexScreener lists the coin, no pair traded in 24 hours, and the coin is a day old; any trade is active; no pair, a missing count, an unknown or young age: unknown, never quiet on a guess", c1)


def c2():
    c = S.db(); fdir = tempfile.mkdtemp(); ff = os.path.join(fdir, "_quiet.json")
    asked = []
    answers = {A: [pair(0)], B: [pair(12)], D: None}
    def pairs_fn(ms):
        asked.append(list(ms)); return {m: answers[m] for m in ms if answers.get(m) is not None}
    tape = lambda m: NOW - 600 if m == E else None
    coins = [(A, NOW - 3 * DAY), (B, NOW - 3 * DAY), (C, NOW - 3600), (D, NOW - 3 * DAY), (E, NOW - 3 * DAY)]
    first = Q.one_pass(c, coins, NOW, pairs_fn, tape, ff)
    f1 = json.load(open(ff))
    again = Q.one_pass(c, coins, NOW + 60, pairs_fn, tape, ff); asked_again = asked[1:] if len(asked) > 1 else []
    answers[A] = [pair(4)]
    later = Q.one_pass(c, coins, NOW + Q.WAKE_S + 5, pairs_fn, tape, ff)
    f2 = json.load(open(ff))
    row = c.execute("SELECT state, quiet_since FROM quiet WHERE mint=?", (A,)).fetchone()
    return (asked[0] == [A, B, D] and first["went_quiet"] == 1 and list(f1["quiet"]) == [A] and f1["contract"] == "quiet-1" and f1["window_s"] == DAY
            and asked_again == [[D]] and later["woke"] == 1 and f2["quiet"] == {} and row == ("active", None)), \
        (f"first pass asked DexScreener for {len(asked[0])} coins (the day-old ones without a tape trade): {first}; the feed's file lists the quiet one; "
         f"a minute later only the coin DexScreener did not answer for is asked again {asked_again == [[D]]}; after the wake wait A traded and woke: {later}; the file empties; A's record {row}")
case(2, "A pass: quiet coins found and woken, cheaply", "day-old coins are asked in batches; a young coin and one the tape saw trade today are never asked; no answer changes nothing (asked again next pass); a quiet coin is asked again only after the wake wait, and its first trade wakes it; the feed's file lists exactly the quiet coins", c2)


def c3():
    c = S.db(); Q.ensure(c)
    c.execute("INSERT INTO quiet VALUES (?,?,?,?,?,?) ON CONFLICT(mint) DO UPDATE SET state='quiet'", (A, "quiet", NOW, None, NOW, "DexScreener")); c.commit()
    Q._set["at"] = 0.0
    import pinrai as AI, basic as BA
    pages = [(A, time.time() - 9999), (B, time.time() - 9999)]
    S._site_page = lambda: pages
    S._wanted_coins = lambda: {}
    S._has_relay = lambda m: False
    page_next = S._page_next(c, set())
    leased = S.lease(c, 4)
    c.execute("INSERT OR IGNORE INTO tokens (chain, token, launchpad, first_seen, next_due) VALUES ('solana',?,'pumpfun',1.0,0)", (H,))
    c.execute("INSERT INTO quiet VALUES (?,?,?,?,?,?) ON CONFLICT(mint) DO UPDATE SET state='quiet'", (H, "quiet", NOW, None, NOW, "DexScreener")); c.commit()
    Q._set["at"] = 0.0
    hand = S._page_next(c, set())
    rd = tempfile.mkdtemp()
    for m in (A, B):
        json.dump({"mint": m, "receipts": []}, open(os.path.join(rd, m + ".json"), "w"))
    cand = AI.candidates([A, B], passed=lambda m: True, has_reading=lambda m: False, results_dir=rd)
    import x_api as X
    fd = tempfile.mkdtemp()
    for m in (A, B):
        json.dump({"mint": m, "chain": "solana", "name": m[:6]}, open(os.path.join(fd, m + ".json"), "w"))
    picked = X.pick_demand(24, wanted={}, shown=[A, B], feed_dir=fd, out_dir=tempfile.mkdtemp(), gate_ok=lambda m: True)
    asked = []
    BA.read_pass(c, [A, B], {}, tempfile.mkdtemp(), meta_read=lambda ms: asked.extend(ms) or {}, doc_read=lambda u: None,
                 holders_read=lambda m: None, update_seen=lambda m, **f: True, icons_read=lambda ms: {}, rows_read=lambda ms: [])
    return (page_next[0] == B and A not in leased and hand[0] == H and cand == [B] and [p[0] for p in picked] == [B] and A not in asked), \
        (f"A quiet: the server's lane picks {'B' if page_next[0] == B else page_next[0]}, the Mac is lent {['A' if m == A else 'B' for m in leased]}, "
         f"PINRai's list {['A' if m == A else 'B' for m in cand]}, the X check picks {['A' if p[0] == A else 'B' for p in picked]}, the evidence pass reads {['A' if m == A else 'B' for m in asked]}; "
         f"a quiet coin asked for by hand is still scored first: {hand[0] == H}")
case(3, "No work is spent on a quiet coin", "the server's page lane, the Mac's lease, PINRai, the X check and the evidence pass all skip a quiet coin; a coin asked for by hand is still scored", c3)


def c4():
    """the team's F1 on 89960bb0: the scanner's database is never held while DexScreener is asked (the dblock fault)."""
    import sqlite3
    c = S.db(); Q.ensure(c)
    seen = {}
    def pairs_fn(ms):
        seen["open"] = c.in_transaction
        other = sqlite3.connect(S.DB, timeout=0.5)
        try:
            other.execute("CREATE TABLE IF NOT EXISTS probe (x)"); other.execute("INSERT INTO probe VALUES (1)"); other.commit()
            seen["other_wrote"] = True
        except sqlite3.OperationalError as e:
            seen["other_wrote"] = str(e)
        other.close()
        return {}
    x, y = coin("Probe1"), coin("Probe2")
    Q.one_pass(c, [(x, NOW - 3 * DAY), (y, NOW - 3 * DAY)], NOW + 5 * DAY, pairs_fn, lambda m: NOW + 5 * DAY - 60 if m == x else None,
               os.path.join(tempfile.mkdtemp(), "_quiet.json"))
    return (seen.get("open") is False and seen.get("other_wrote") is True), \
        f"while DexScreener was asked (after the tape kept one coin awake): a write left open {seen.get('open')}; another connection could write: {seen.get('other_wrote')}"
case(4, "Nothing holds the database while DexScreener is asked", "the tape's rows are kept before any network read; the scoring loop and the Mac's hand-ins are never kept waiting", c4)

def c5():
    c = S.db(); fdir = tempfile.mkdtemp(); ff = os.path.join(fdir, "_quiet.json")
    evm = "0x" + "ab" * 20
    c.execute("INSERT OR REPLACE INTO quiet (mint, state, quiet_since, checked_at, by) VALUES (?,?,?,?,?)", (evm, "quiet", NOW - 9 * DAY, NOW - 9 * DAY, "chains"))
    c.commit()
    asked, theirs = [], []
    sol = coin("SolOnly")
    Q.one_pass(c, [(sol, NOW - 3 * DAY), (evm, NOW - 3 * DAY)], NOW, lambda ms: asked.append(list(ms)) or {}, lambda m: None, ff)
    untouched = c.execute("SELECT checked_at FROM quiet WHERE mint=?", (evm,)).fetchone()[0] == NOW - 9 * DAY
    Q.one_pass(c, [(sol, NOW - 3 * DAY), (evm, NOW - 3 * DAY)], NOW, lambda ms: theirs.append(list(ms)) or {}, lambda m: None, ff, own=lambda m: m.startswith("0x"))
    return (asked == [[sol]] and untouched and theirs == [[evm]]), f"the scanner's pass asked about {asked} and left the 0x row's check time alone: {untouched}; CHAINS' pass (its own test) asked about {theirs}"
case(5, "CHAINS (249): each quiet pass looks after its own coins", "the scanner's pass never asks DexScreener's Solana pairs about a 0x coin nor marks its row checked; a pass given its own test (CHAINS' service) handles only its coins", c5)


print(f"\n{sum(results)}/{len(results)} passed")
raise SystemExit(0 if all(results) else 1)
