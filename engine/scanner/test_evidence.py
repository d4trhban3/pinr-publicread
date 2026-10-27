"""a design decision (c), step 3; the evidence table, with made-up coins and wallets.
A temporary database and result folder; no network, no chain read, no live file touched.
Run:  python3 test_evidence.py"""
import json, os, sys, tempfile, time
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path[:0] = [HERE, os.path.join(HERE, "..", "stage2"), os.path.join(HERE, "..", "stage3")]
import evidence as EV
import scanner as S

TMP = tempfile.mkdtemp()
S.DB = os.path.join(TMP, "scanner.sqlite")
S.SETTINGS = os.path.join(TMP, "settings.json")
json.dump({"score_chains": ["solana"]}, open(S.SETTINGS, "w"))

results = []
def case(n, title, should, fn):
    try:
        ok, text = fn()
    except Exception as e:
        import traceback; traceback.print_exc()
        ok, text = False, f"CRASH {type(e).__name__}: {e}"
    results.append(ok)
    print(f"\n{n:>2}. {title}\n    should: {should}\n    did:    {text}\n    {'PASS' if ok else 'FAIL'}")


def addr(tag):                                    # a made-up Solana address of the right form
    return (("MadeUp" + tag) + "1" * 44)[:44].replace("0", "1").replace("O", "P").replace("I", "J").replace("l", "k")


COIN, DEV, LAUNCHER, FEE, LINKED, FUNDER, H1, H2, CURVE, POOL, PAIR = (addr(t) for t in ("Coin", "Dev", "Launch", "Fee", "Linked", "Funder", "HoldA", "HoldB", "Curve", "Pool", "Pair"))
SIG = ("5" + "Sig" * 40)[:88]


def result(**extra):
    rc = [
        {"what": "creator (from curve)", "value": DEV, "unit": "address", "source": "getAccountInfo " + CURVE, "as_of": "slot 1"},
        {"what": "creation record (launcher, fee receiver at launch)", "value": [LAUNCHER, FEE], "unit": "wallets", "source": "Pump.fun creation transaction " + SIG, "as_of": "x"},
        {"what": "launcher of this token", "value": {"wallet": LAUNCHER, "launches": "544+"}, "unit": "facts", "source": "Pump.fun lists ...", "as_of": "x"},
        {"what": "dev launches", "value": 3, "unit": "tokens created", "source": "Pump.fun lists 3", "as_of": "x"},
        {"what": "dev group (linked wallets)", "value": {LINKED: "bundled buy (same block as creation)", DEV: "itself"}, "unit": "wallet -> why", "source": "chain", "as_of": "x"},
        {"what": "funding source", "value": {"kind": "from_busy", "trace": [{"wallet": DEV, "funder": FUNDER, "sol": 1.5, "funded_at": 1792688493, "signature": SIG},
                                                                          {"wallet": FUNDER, "funder": None}]}, "unit": "trace", "source": "chain", "as_of": "x"},
        {"what": "holders (evidence)", "value": [{"wallet": H1, "amount": 1000, "program": False, "dev": True, "sniper": False, "bundler": False},
                                                 {"wallet": H2, "amount": 50, "program": False, "dev": False, "sniper": True, "bundler": False},
                                                 {"wallet": CURVE, "amount": 9e8, "program": True}], "unit": "holders", "source": "Pump.fun top holders", "as_of": "x"},
        {"what": "PumpSwap pool (derived canonical PDA, verified owner and base mint)", "value": POOL, "unit": "address", "source": "getAccountInfo " + POOL, "as_of": "slot 2"},
        {"what": "token's own twitter link", "value": "https://x.com/madeup", "unit": "url", "source": "Pump.fun record", "as_of": "x"},
        {"what": "token's own website link", "value": "none", "unit": "url", "source": "Pump.fun record", "as_of": "x"},
        {"what": "token metadata URI", "value": "https://ipfs.example/meta.json", "unit": "url", "source": "getAccountInfo " + COIN, "as_of": "slot 3"},
        {"what": "launch time (launch transaction)", "value": 1792688741, "unit": "unix time", "source": "Pump.fun first trade, chain-checked: launch tx " + SIG, "as_of": "x"},
        {"what": "venue", "value": "Pump.fun curve", "unit": "text", "source": "derived", "as_of": "x"},
        {"what": "market figures (DexScreener)", "value": {"dex": "pumpfun", "pair": PAIR, "url": "https://dexscreener.com/solana/" + PAIR.lower(), "market_cap": 3109.95}, "unit": "USD", "source": "DexScreener pair", "as_of": "x"},
        {"what": "X check", "value": "not checked yet: the X account's social parts wait", "unit": "social", "source": "PINRsocialscan's file", "as_of": "x"},
    ]
    out = {"mint": COIN, "frame": "live scan", "score": 40, "display": 40, "coverage": 0.5, "readings": {}, "receipts": rc}
    out.update(extra)
    return out


def c1():
    rows = EV.rows_from_result(result())
    by = {(r["what"], r["to_id"] if r["from_id"] in (COIN, DEV) else r["from_id"]): r for r in rows}
    want = {("created by", DEV), ("launched by", LAUNCHER), ("fee receiver at launch", FEE), ("linked: bundled buy (same block as creation)", LINKED),
            ("funded", FUNDER), ("holds", H1), ("holds", H2), ("holds", CURVE), ("trades in pool", POOL), ("lists its own link", "https://x.com/madeup"),
            ("metadata document", "https://ipfs.example/meta.json"), ("launched", "launch"), ("trades on", "Pump.fun curve"), ("market pair", PAIR), ("X check", "check")}
    have = set(by)
    fund = next(r for r in rows if r["what"] == "funded")
    hold = next(r for r in rows if r["what"] == "holds" and r["from_id"] == H1)
    links_ok = all((r["link"] or "https://").startswith("https://") for r in rows)
    ok = (want <= have and fund["onchain"] == 1 and fund["link"] == EV.tx(SIG) and json.loads(fund["value"]) == 1.5 and fund["at"] == 1792688493
          and hold["onchain"] == 0 and json.loads(hold["value"])["dev"] is True and by[("created by", DEV)]["onchain"] == 1
          and by[("lists its own link", "https://x.com/madeup")]["onchain"] == 0 and not any(r["to_id"] == "none" for r in rows)
          and not any(r["what"].startswith("linked") and r["to_id"] == DEV for r in rows) and links_ok
          and sum(1 for r in rows if r["what"] == "coins launched (the launchpad's list)") == 2)
    return ok, f"{len(rows)} rows: {sorted(w for w, _ in have)[:6]}...; missing {sorted(want - have)}; the funding hop ● with its transaction link; Pump.fun holders ○ with their labels; the website 'none' and the dev's own entry in its group give no row; every link https: {links_ok}"
case(1, "One score's receipts become evidence rows", "creator, launcher, fee receiver, linked wallets, funders hop by hop, holders with Pump.fun's labels, the pool, the coin's own links, its metadata document, its launch, its venue, its market pair and its X check; ● for what PINR read on chain, ○ for the creator's own words and third parties; a link to see each", c1)


def c2():
    bad = result(receipts=[{"what": "creator (from curve)", "value": "not-an-address"}, {"what": "funding source", "value": "words only"},
                           {"what": "holders (evidence)", "value": {"odd": 1}}, {"what": "creation record (launcher, fee receiver at launch)", "value": [1, 2, 3]},
                           "junk", {"value": "no what"}, {"what": "launch time (launch transaction)", "value": True}])
    none_mint = EV.rows_from_result(dict(result(), mint="0xevm"))
    empty = EV.rows_from_result({"mint": COIN})
    rows = EV.rows_from_result(bad)
    return rows == [] and none_mint == [] and empty == [], f"odd shapes: {len(rows)} rows; not a Solana coin: {len(none_mint)}; no receipts: {len(empty)}"
case(2, "Receipts not in their shape", "give no row and never stop: missing stays missing", c2)


def fresh():
    for ext in ("", "-wal", "-shm"):
        if os.path.exists(S.DB + ext):
            os.remove(S.DB + ext)
    return S.db()


def c3():
    c = fresh()
    n1 = EV.store(c, result(), now=1000.0); c.commit()
    first = {(r["from_id"], r["to_id"], r["what"]): r for r in EV.for_coin(c, COIN)}
    later = result()
    later["receipts"] = [r for r in later["receipts"] if r["what"] != "X check"]
    for r in later["receipts"]:
        if r["what"] == "market figures (DexScreener)":
            r["value"] = dict(r["value"], market_cap=9999.0)
    n2 = EV.store(c, later, now=2000.0); c.commit()
    second = {(r["from_id"], r["to_id"], r["what"]): r for r in EV.for_coin(c, COIN)}
    pair = second[(COIN, PAIR, "market pair")]
    xc = second[(COIN, "check", "X check")]
    count = c.execute("SELECT COUNT(*) FROM evidence").fetchone()[0]
    ok = (len(first) == n1 and len(second) == n1 and count == n1 and json.loads(pair["value"])["market_cap"] == 9999.0 and pair["first_read"] == 1000.0
          and pair["read_at"] == 2000.0 and xc["read_at"] == 1000.0 and n2 == n1 - 1)
    return ok, f"first score: {n1} rows; a re-score: {count} rows kept (no copies), the pair's value renewed, first read {pair['first_read']:.0f} and read again {pair['read_at']:.0f}; the X check not read this time is kept as it was (read {xc['read_at']:.0f})"
case(3, "A re-score reads the same facts again", "one row per fact: its value and read time renewed, its first read kept; a fact not read this time is never removed", c3)


def c4():
    c = fresh()
    rdir = tempfile.mkdtemp(); real = S.RESULTS_DIR; S.RESULTS_DIR = rdir
    real_feed = S.FEED_DIR; S.FEED_DIR = tempfile.mkdtemp()      # the team's finding (2026-10-24): the evidence file never in the live feed
    try:
        json.dump(result(), open(os.path.join(rdir, COIN + ".json"), "w"))
        c.execute("INSERT INTO tokens (chain, token, launchpad, first_seen) VALUES ('solana',?,?,?)", (COIN, "pumpfun", 1.0)); c.commit()
        S._record(c, "solana", COIN, {"display": 40, "coverage": 0.5})
        got = c.execute("SELECT COUNT(*) FROM evidence WHERE coin=?", (COIN,)).fetchone()[0]
        other = addr("Other")
        json.dump(dict(result(), mint=other), open(os.path.join(rdir, other + ".json"), "w"))
        c.execute("INSERT INTO tokens (chain, token, launchpad, first_seen) VALUES ('solana',?,?,?)", (other, "pumpfun", 1.0)); c.commit()
        S._record(c, "solana", other, {"error": "made-up failure"})
        failed = c.execute("SELECT COUNT(*) FROM evidence WHERE coin=?", (other,)).fetchone()[0]
        third = addr("Third")
        c.execute("INSERT INTO tokens (chain, token, launchpad, first_seen) VALUES ('solana',?,?,?)", (third, "pumpfun", 1.0)); c.commit()
        realstore = EV.store_file; EV.store_file = lambda *a, **k: (_ for _ in ()).throw(RuntimeError("made-up store failure"))
        import io, contextlib
        try:
            with contextlib.redirect_stderr(io.StringIO()):
                S._record(c, "solana", third, {"display": 30, "coverage": 0.4})
        finally:
            EV.store_file = realstore
        rec = c.execute("SELECT scores, last_ok IS NOT NULL FROM tokens WHERE token=?", (third,)).fetchone()
    finally:
        S.RESULTS_DIR = real; S.FEED_DIR = real_feed
    return got > 10 and failed == 0 and rec == (1, 1), f"a finished score: {got} rows; a failed one: {failed}; the store failing: the score still recorded {rec}"
case(4, "The scanner writes the trail when it records a finished score", "the server's own and the Mac's hand-ins alike go through the same record: rows for a finished score, none for a failed one, and a broken trail never stops the record", c4)




def c_known():
    """the team 2026-10-26: the wallets that drove a bot coin are known; a later launch by one is a bot at the gate with no scan,
    and a later coin whose bot-speed traders include them is marked from its score."""
    import gate as G
    c = fresh(); G.ensure(c)
    rdir = tempfile.mkdtemp(); real = S.RESULTS_DIR; S.RESULTS_DIR = rdir
    real_feed = S.FEED_DIR; fdir = tempfile.mkdtemp(); S.FEED_DIR = fdir
    W = [addr("KnownW%d" % i) for i in range(3)]
    first, launched, driven, fresh_bots = addr("FirstBot"), addr("LaunchedByBot"), addr("DrivenByBots"), addr("NewBotsOnly")
    rc = lambda level, ws: dict(result(), receipts=list(result()["receipts"]) + [{"what": S.BOT_RECEIPT, "value": {"level": level, "share": 0.5,
                                "count": len(ws), "wallets": ws}, "unit": "wallets", "source": "first-day trades", "as_of": None}])
    later = time.time() + 60                                  # the team's F1 on tags271: these coins came after the first bot coin
    G.record(c, [{"id": m, "dev": addr("Dev" + m[:4]), "name": "Later", "symbol": "LTR", "audit": {"devMints": 1}} for m in (driven, fresh_bots)], later); c.commit()
    try:
        for m, o in ((first, rc("bot_heavy", W)), (driven, rc("bot_moderate", [W[1], addr("Stranger")])), (fresh_bots, rc("bot_moderate", [addr("NewA"), addr("NewB")]))):
            json.dump(dict(o, mint=m), open(os.path.join(rdir, m + ".json"), "w"))
            c.execute("INSERT INTO tokens (chain, token, launchpad, first_seen) VALUES ('solana',?,?,?)", (m, "pumpfun", 1.0)); c.commit()
            S._record(c, "solana", m, {"display": 40, "coverage": 0.5})
        G.record(c, [{"id": launched, "dev": W[0], "name": "Next", "symbol": "NXT", "audit": {"devMints": 1}}], later); c.commit()
        before = c.execute("SELECT COUNT(*) FROM gate_bot").fetchone()[0]
        v = G.verdict(c, launched); sec = G.section(c, launched)
        after = c.execute("SELECT COUNT(*) FROM gate_bot").fetchone()[0]
        skip = S._score_inner(("solana", launched, "pumpfun"))[1]
        bots = G.bot_mints(c)
        d, f = G.bot_of(c, driven), G.bot_of(c, fresh_bots)
    finally:
        S.RESULTS_DIR = real; S.FEED_DIR = real_feed
    it = (sec or {}).get("items", [{}])[0]
    return (v["status"] == "bot" and before == after and it.get("kind") == "bot_launch" and (it.get("receipts") or [{}])[0].get("value") == first
            and "bot launch" in str(skip.get("error")) and launched in bots and first in bots
            and d is not None and d["wallets"] == [W[1]] and f is None), \
        f"a later launch by a known bot wallet: {v['status']} with no scan ({skip.get('error')}), its receipt the earlier coin, nothing written by the read ({before}->{after}); a moderate brake driven by a known wallet: {d['words'] if d else None}; a moderate brake by new wallets only: {f}"
case(10, "Known bot wallets, learned from PINR's own receipts", "every wallet behind a bot launch is kept; a later coin it creates is a bot at the gate with no scan (read, never written by a reader); a later coin whose bot-speed traders include known wallets, with the brake fired, is marked from its score; new bot-speed wallets alone below the heavy level are not", c_known)




def c6():
    c = fresh()
    EV.store(c, result(), now=1.0); c.commit()
    by_wallet = EV.for_coin(c, FUNDER)
    by_coin = EV.for_coin(c, COIN)
    return any(r["what"] == "funded" for r in by_wallet) and len(by_coin) >= 15, f"asked by the funder's wallet: {[r['what'] for r in by_wallet]}; by the coin: {len(by_coin)} rows"
case(6, "Looking up the trail", "by a coin, or by any wallet or account named in it", c6)


def c7():
    c = fresh()
    EV.store(c, result(), now=1792690000.0)
    other = addr("Other")
    EV.store(c, dict(result(), mint=other), now=1792690000.0); c.commit()
    body = EV.coin_file(c, COIN, now=1792690100.0)
    rows = body["rows"]
    kinds = [r["what"] for r in rows]
    order_ok = kinds.index("created by") < kinds.index("funded") < kinds.index("holds") < kinds.index("X check")
    holds = [r for r in rows if r["what"] == "holds"]
    fund = next(r for r in rows if r["what"] == "funded")
    ok = (body["contract"] == "evidence/1" and body["mint"] == COIN and body["as_of"] == "2026-10-22T17:28:20Z" and order_ok
          and all(isinstance(r["onchain"], bool) for r in rows) and all(r["link"] is None or r["link"].startswith("https://") for r in rows)
          and fund["at"] and fund["at"].endswith("Z") and fund["read"].endswith("Z") and fund["onchain"] is True
          and holds[0]["value"]["amount"] >= holds[-1]["value"]["amount"] and not any(other in json.dumps(r) for r in rows)
          and set(rows[0]) == {"from", "to", "what", "value", "unit", "at", "first_read", "read", "source", "link", "onchain"})
    return ok, f"contract {body['contract']}, {len(rows)} rows of this coin only, in the agreed order ({kinds[0]} ... {kinds[-1]}); times ISO UTC; holders largest first; ● and ○ as true and false"
case(7, "231 step 4: the per-coin evidence file's body", "contract 'evidence/1' as proposed to the site: the coin's own rows only, ordered by kind, times as ISO UTC or null, a link only when https, onchain true or false", c7)


def c8():
    c = fresh()
    rdir, fdir = tempfile.mkdtemp(), tempfile.mkdtemp()
    real = (S.RESULTS_DIR, S.FEED_DIR); S.RESULTS_DIR, S.FEED_DIR = rdir, fdir
    try:
        json.dump(result(), open(os.path.join(rdir, COIN + ".json"), "w"))
        c.execute("INSERT INTO tokens (chain, token, launchpad, first_seen) VALUES ('solana',?,?,?)", (COIN, "pumpfun", 1.0)); c.commit()
        S._record(c, "solana", COIN, {"display": 40, "coverage": 0.5})
        path = os.path.join(fdir, "evidence", COIN + ".json")
        body = json.load(open(path)) if os.path.exists(path) else None
        left = [n for n in os.listdir(os.path.join(fdir, "evidence")) if n.endswith(".tmp")]
        other = addr("Fail")
        c.execute("INSERT INTO tokens (chain, token, launchpad, first_seen) VALUES ('solana',?,?,?)", (other, "pumpfun", 1.0)); c.commit()
        S._record(c, "solana", other, {"error": "made-up failure"})
        none_written = not os.path.exists(os.path.join(fdir, "evidence", other + ".json"))
        no_rows = EV.write_coin_file(c, addr("Nothing"), fdir)
    finally:
        S.RESULTS_DIR, S.FEED_DIR = real
    ok = body and body["contract"] == "evidence/1" and len(body["rows"]) > 10 and not left and none_written and no_rows is None
    return ok, f"after a finished score: {path.split('/')[-2]}/<coin>.json with {len(body['rows']) if body else 0} rows, no temporary file left; a failed score: no file {none_written}; a coin with no rows: {no_rows}"
case(8, "The scanner writes the coin's evidence file with its trail", "on every finished score, written whole into the feed's evidence folder; none for a failed score or a coin with no rows", c8)




def c10():
    c = fresh()
    newer = result()
    for r in newer["receipts"]:
        if r["what"] == "market figures (DexScreener)":
            r["value"] = dict(r["value"], market_cap=5000.0)
    EV.store(c, newer, now=2000.0); c.commit()
    EV.store(c, result(), now=1000.0); c.commit()                                   # an older result arriving later (a backfill)
    pair = next(r for r in EV.for_coin(c, COIN) if r["what"] == "market pair")
    kept_new = json.loads(pair["value"])["market_cap"] == 5000.0 and pair["read_at"] == 2000.0 and pair["first_read"] == 1000.0
    c = fresh()
    rdir, fdir = tempfile.mkdtemp(), tempfile.mkdtemp()
    a, b, d = addr("PageA"), addr("OldB"), addr("NewD")
    for m, t in ((a, 100.0), (b, 50.0), (d, 300.0)):
        json.dump(dict(result(), mint=m), open(os.path.join(rdir, m + ".json"), "w")); os.utime(os.path.join(rdir, m + ".json"), (t, t))
    open(os.path.join(rdir, addr("Broken") + ".json"), "w").write("{ broken")
    seen = []
    real = EV.store_file
    EV.store_file = lambda c_, m, rd, now=None: seen.append(m) or real(c_, m, rd, now)
    try:
        got = EV.backfill(c, rdir, fdir, first=[a, addr("NotScored")])
    finally:
        EV.store_file = real
    files = sorted(n for n in os.listdir(os.path.join(fdir, "evidence")))
    first_read = c.execute("SELECT MIN(first_read) FROM evidence WHERE coin=?", (b,)).fetchone()[0]
    real_order = [m for m in seen if m != addr("Broken")]                           # the broken file is the newest by its own time
    ok = (kept_new and real_order == [a, d, b] and got["files"] == 3 and got["first_files"] == 1 and got["unreadable"] == 1
          and len(files) == 3 and first_read == 50.0)
    return ok, f"an older result after a newer one: the newer value kept {kept_new}; backfill order {['page' if m == a else 'newest' if m == d else 'older' if m == b else 'broken' for m in seen]}; {got}; a backfilled row's read time is its result's own time ({first_read})"
case(10, "the team's backfill: every coin already scored gets its rows and its file, from results on disk", "the site's first page first, then the rest newest first; each result read at its own file time, so an older result never overwrites a newer fact and the first read is the earliest; an unreadable result counted and passed; a page coin never scored simply has no file", c10)


def c11():
    import sqlite3, gate as G
    c = sqlite3.connect(os.path.join(tempfile.mkdtemp(), "s.sqlite")); EV.ensure(c); G.ensure(c)
    c.execute("CREATE TABLE IF NOT EXISTS tokens (chain TEXT, token TEXT, last_ok REAL)")
    bnb, base, sol = "0x" + "ab" * 20, "0x" + "cd" * 20, addr("SolanaCoin")
    G.record(c, [{"id": bnb, "dev": "0x" + "11" * 20, "name": "B", "symbol": "B", "chain": "bsc", "audit": {"devMints": 1}}])
    c.execute("INSERT INTO tokens VALUES ('base', ?, NULL)", (base,))
    rows = [(bnb, "token contract", "eth_getCode/owner() on 0x..", 1), (bnb, "launch (CHAINS)", "Four.meme factory event (BNB Chain), tx 0x..", 1),
            (bnb, "GoPlus token security (lead)", "GoPlus API", 0), (base, "launch (CHAINS)", "Clanker API (launchpad record)", 0),
            (base, "token contract", "eth_getCode on 0x..", 1)]
    for i, (coin, receipt, src, oc) in enumerate(rows):
        c.execute("INSERT INTO evidence (coin, from_kind, from_id, to_kind, to_id, what, value, unit, at, first_read, read_at, source, link, onchain, receipt) "
                  "VALUES (?, 'token', ?, 'token', ?, ?, NULL, NULL, NULL, 1, 1, ?, NULL, ?, ?)", (coin, coin, str(i), "fact " + str(i), src, oc, receipt))
    d = tempfile.mkdtemp(); real = EV.EVM_RESULTS; EV.EVM_RESULTS = d
    json.dump({"mint": bnb, "display": "41"}, open(os.path.join(d, bnb + ".json"), "w"))
    json.dump({"mint": base, "error": "read failed"}, open(os.path.join(d, base + ".json"), "w"))
    try:
        fb, fs = EV.coin_file(c, bnb), EV.coin_file(c, base)
    finally:
        EV.EVM_RESULTS = real
    src = lambda f: [r["source"] for r in f["rows"]]
    sol_src = EV.public_source("holders (evidence)", "getTokenLargestAccounts")
    return (sorted(map(str, src(fb))) == sorted(["BNB chain", "BNB chain", "GoPlus"]) and sorted(map(str, src(fs))) == ["Base chain", "launchpad record"]
            and fb["scan"] == "full" and fs["scan"] == "basic" and sol_src == "Solana chain"), \
        f"a BNB coin: sources {src(fb)}, scan {fb['scan']} (its EVM result holds a score); a Base coin: {src(fs)}, scan {fs['scan']} (its result holds an error); a Solana row unchanged: {sol_src}"
case(11, "the team's notes on a6f9dec4: a Base or BNB coin's evidence file", "a row read on the coin's own chain says Base chain or BNB chain, a launchpad's own record says launchpad record, an outside reporter (GoPlus) is named; \"full\" once its EVM score's result is there without an error, else \"basic\"; Solana rows as before", c11)


def c_links():
    """Checklist 6: every ● row links to its receipt."""
    rc = [x for x in result()["receipts"] if x["what"] != "launch time (launch transaction)"]
    old = dict(result(), receipts=rc + [{"what": "launch time (oldest mint transaction)", "value": 1792688741, "unit": "unix time",
                                         "source": "getSignaturesForAddress on the mint", "as_of": "x"},
                                        {"what": "duplicate relaunches of this token", "value": 2, "unit": "coins", "source": "Helius parsed history", "as_of": "x"}])
    new = dict(result(), receipts=rc + [{"what": "launch time (oldest mint transaction)", "value": 1792688741, "unit": "unix time",
                                         "source": "getSignaturesForAddress on the mint: oldest tx " + SIG, "as_of": "x"}])
    ro, rn = EV.rows_from_result(old), EV.rows_from_result(new)
    bare = [r["what"] for r in ro + rn if r["onchain"] == 1 and not r["link"]]
    la = {r["link"] for r in ro if r["what"] == "launched"}; ln = {r["link"] for r in rn if r["what"] == "launched"}
    cp = {r["link"] for r in ro if r["what"] == "copies of this coin launched"}
    return (bare == [] and la == {"https://solscan.io/token/" + COIN} and ln == {"https://solscan.io/tx/" + SIG}
            and cp == {"https://solscan.io/account/" + DEV}), \
        f"● rows with no link: {bare}; launched with no signature kept: {la}; with the oldest tx kept: {ln}; copies: {cp}"
case(12, "Every ● row links to its receipt", "a launch read from the mint's oldest transaction links that transaction when kept, else the token's own chain record; copies of this coin link the creator's launches; no ● row is left without a link", c_links)


def _relay(mint, rows, dropped=None):
    return {"schema": "pinrbot-relay/1", "mint": mint, "request": "REQUEST-010", "read_at": "2026-10-26T18:00:00Z",
            "read_by": "PINRbot_claude with PINRbot_Grok (X, browser)", "evidence": rows, "items": [],
            "dropped_before_filing": dropped or []}
POST = {"id": "g1", "class": "post", "what": "the coin's own X post", "value": "we launched", "source": "https://x.com/someone/status/2113263652195439102",
        "as_of": "2026-10-26T17:55:00Z", "on_chain": False, "own_account": True, "removed": False, "checked": "quote in post by X's embed 2026-10-26T17:55:00Z",
        "age": "joined March 2024", "regularity": "12 of 20 in 7 days; oldest 2026-10-19"}
PARTNER = {"id": "g2", "class": "partner_source", "what": "the partner the post names", "value": "no mention of this coin", "source": "https://x.com/partner",
           "as_of": "2026-10-26T17:56:00Z", "on_chain": True, "checked": "partner's own account read 2026-10-26T17:56:00Z"}
BARE = {"id": "g3", "class": "post", "what": "a post with no checked phrase", "value": "x", "source": "https://x.com/a/status/1", "as_of": "2026-10-26T17:57:00Z", "on_chain": False}


def c13():
    """GrokBot's checked findings as a ○ section of the coin's evidence file; a row without its
    checked phrase is left out; a coin with no relay file has no section."""
    rd = tempfile.mkdtemp()
    json.dump(_relay(COIN, [POST, PARTNER, BARE], [{"what": "a dead link", "reason": "link did not open"}]), open(os.path.join(rd, COIN + ".json"), "w"))
    sec = EV.grokbot_section(COIN, dirs=(rd,))
    none = EV.grokbot_section(addr("Other"), dirs=(rd,))
    ids = [r["id"] for r in sec["rows"]]
    post = sec["rows"][0]
    ok = (sec["source"] == "GrokBot (X, browser)" and sec["onchain"] is False and ids == ["g1", "g2"] and post["kind"] == "post"
          and post["link"] == POST["source"] and post["as_of"] == POST["as_of"] and post["onchain"] is False and post["own_account"] is True
          and sec["rows"][1]["kind"] == "partner" and sec["rows"][1]["onchain"] is False and sec["read_at"] == "2026-10-26T18:00:00Z"
          and sec["dropped"] == [{"reason": "link did not open"}] and none is None and "person" not in json.dumps(sec))
    return ok, f"rows {ids} (g3 without 'quote in post' left out); the post links {post['link']} as of {post['as_of']}, ○; the partner read ○ even though the file said on_chain; dropped: {sec['dropped']}; no relay file: {none}"
case(13, "GrokBot's checked findings in the coin's evidence file", "each checked row as ○ with its opened link and time; a row without the checked phrase is left out; on_chain is forced false; a coin with no relay file has no section", c13)

print(f"\n{sum(results)}/{len(results)} passed")
raise SystemExit(0 if all(results) else 1)
