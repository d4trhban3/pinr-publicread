"""the PvP Arena's battles (scanner/pvp.py), from the gate's look-alike matches. Made-up coins, no network."""
import json, os, sqlite3, sys, tempfile, time
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path[:0] = [HERE, os.path.join(HERE, "..", "stage3"), os.path.join(HERE, "..", "stage2")]
import gate as G
import pvp as P

results = []
def case(n, title, should, fn):
    try:
        ok, text = fn()
    except Exception as e:
        import traceback; traceback.print_exc()
        ok, text = False, f"CRASH {type(e).__name__}: {e}"
    results.append(ok)
    print(f"\n{n:>2}. {title}\n    should: {should}\n    did:    {text}\n    {'PASS' if ok else 'FAIL'}")


def addr(tag):
    return (("MadeUp" + tag) + "1" * 44)[:44].replace("0", "1").replace("O", "P").replace("I", "J").replace("l", "k")


def row(mint, dev, name, sym, at, icon=None):
    return {"id": mint, "dev": dev, "name": name, "symbol": sym, "icon": icon, "audit": {"devMints": 1},
            "createdAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(at))}


def store():
    c = sqlite3.connect(os.path.join(tempfile.mkdtemp(), "scanner.sqlite")); G.ensure(c)
    return c


def c1():
    c = store(); T = 1_790_000_000
    A, B, C, D, E, F = (addr(x) for x in ("CopyA", "CopyB", "CopyC", "PicD", "AloneE", "SameDevF"))
    G.record(c, [row(A, addr("Dev1"), "Moon Cat", "MCAT", T), row(B, addr("Dev2"), "Moon Cat", "MCAT", T + 60),
                 row(C, addr("Dev3"), "Moon Cat", "MCAT", T + 120), row(D, addr("Dev4"), "Other", "MCAT", T + 30),
                 row(E, addr("Dev5"), "Lonely", "LONE", T), row(F, addr("Dev1"), "Moon Cat", "MCAT", T + 90)], T + 200)
    for m in (B, D):                                              # the listed coin and another creator's coin share a picture
        G.record_image(c, m, "same-file", "0f0f0f0f0f0f0f0f", T + 300)
    c.commit()
    groups = P.build(c, [B, E])                                    # the site lists B and E only
    g = groups[0] if groups else {}
    members = [x["mint"] for x in g.get("members", [])]
    hows = {x["mint"]: x["how"] for x in g.get("members", [])}
    return (len(groups) == 1 and g["id"] == A and set(members) == {A, B, C, D, F} and E not in members
            and hows.get(D) == "same picture file and ticker" and hows.get(C) == "same name and ticker" and g["versions"] == 5), \
        f"{len(groups)} battle, named after the earliest version ({g.get('id', '')[:10]}...); {g.get('versions')} versions: the name-and-ticker copies (one a relaunch by the first coin's creator) and a same-picture coin; a coin with no look-alike left out"
case(1, "A battle is one coin's versions by different creators", "the listed coin's look-alikes by other creators (same name and ticker, or same picture) join one group named after its earliest launch (one step out from each listed coin); a coin with none is not a battle", c1)


def c2():
    d = tempfile.mkdtemp()
    P.write(d, [{"id": "X", "launched_at": None, "versions": 2, "members": []}], now=1_790_000_000)
    f = json.load(open(os.path.join(d, P.FILE)))
    return (f["contract"] == "pvp-1" and f["as_of"] == "2026-09-21T14:13:20Z" and f["groups"][0]["id"] == "X" and not os.path.exists(os.path.join(d, P.FILE + ".tmp"))), \
        f"written whole as {P.FILE}: contract {f['contract']}, as of {f['as_of']}, {len(f['groups'])} group"
def c3():
    c = store(); T = 1_790_000_000
    coins = [addr("Holder%02d" % i) for i in range(30)]
    G.record(c, [row(m, addr("Dv%02d" % i), "Name %d" % i, "T%d" % i, T + i) for i, m in enumerate(coins)], T + 100)
    for m in coins:
        G.record_image(c, m, "the-default-picture", "00ff00ff00ff00ff", T + 200)
    c.commit()
    groups = P.build(c, coins[:5])
    return groups == [], f"30 coins with different names and tickers sharing one placeholder picture: {len(groups)} battles"
case(3, "A shared placeholder picture is not a battle", "coins with the same picture but different names and tickers are never joined", c3)


case(2, "The battles file", "written whole by a rename into the feed folder, contract pvp-1 with its time", c2)


def c4():
    d = tempfile.mkdtemp(); T = 1_790_000_000
    c = sqlite3.connect(os.path.join(d, "scanner.sqlite"))           # a store kept before no name or ticker columns
    c.execute("""CREATE TABLE gate (mint TEXT PRIMARY KEY, dev TEXT, name_key TEXT, symbol_key TEXT, image_key TEXT, dev_mints INTEGER,
                 first_seen REAL, read_at REAL, launched_at REAL, img_sha TEXT, img_phash TEXT, img_read REAL, chain TEXT, source TEXT,
                 dev_mints_source TEXT)""")
    A, B, C = addr("NameA"), addr("NameB"), addr("NameC")
    c.execute("INSERT INTO gate (mint, dev, name_key, symbol_key, launched_at) VALUES (?,?,?,?,?)", (C, addr("Dev9"), "moon cat", "mcat", T + 120))
    G.record(c, [row(A, addr("Dev1"), "  Moon Cat ", "MCAT", T), row(B, addr("Dev2"), "moon cat\u2060", "McAt", T + 60)], T + 200)
    c.commit()
    g = (P.build(c, [B]) or [{}])[0]
    m = {x["mint"]: x for x in g.get("members", [])}
    ok = (set(m) == {A, B, C} and (m[A].get("name"), m[A].get("ticker")) == ("Moon Cat", "MCAT")
          and (m[B].get("name"), m[B].get("ticker")) == ("moon cat\u2060", "McAt") and "name" not in m[C] and "ticker" not in m[C])
    G.record(c, [{"id": A, "dev": addr("Dev1"), "name": "", "symbol": None}], T + 300); c.commit()
    r = c.execute("SELECT name, ticker FROM gate WHERE mint=?", (A,)).fetchone()
    return ok and r == (None, None), \
        f"names {[m[x].get('name') for x in (A, B)]}, tickers {[m[x].get('ticker') for x in (A, B)]} as given (spaces trimmed); a row read before the columns: {sorted(k for k in m[C])}; a later read with none: {r}"
case(4, "Arena members carry name and ticker", "each member's name and ticker as Jupiter's list gives them (outer spaces trimmed, case and characters kept); a member the gate has none for has neither key, never an empty or made-up one; an old store gains the columns", c4)


def c5():
    c = store(); T = 1_790_000_000
    A, B, C = addr("ArenaA"), addr("ArenaB"), addr("ArenaBot")
    G.record(c, [row(A, addr("Dev1"), "Moon", "MOON", T), row(B, addr("Dev2"), "Moon", "MOON", T + 60), row(C, addr("Dev3"), "Moon", "MOON", T + 120)], T + 200)
    G.mark_bot(c, C, "bot-speed trading was observed across this coin's first-day volume (5 wallets)", [addr("W1")], "PINR's read (first-day trades)", [], T + 300)
    c.commit()
    g = P.build(c, [B, C])
    members = sorted(x["mint"] for x in (g[0]["members"] if g else []))
    return members == sorted([A, B]), f"battle members {[m[:10] for m in members]}: the bot launch left out whether listed or a look-alike"
case(5, "A bot launch never appears in the Arena", "a coin marked as a bot launch is never a battle member, listed or found as a look-alike", c5)


print(f"\n{sum(results)}/{len(results)} passed")
raise SystemExit(0 if all(results) else 1)
