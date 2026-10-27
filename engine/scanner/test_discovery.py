"""a design decision discovery (scanner/discovery.py): every Solana launchpad's new coins from three keyless lists, written as
seen files. Made-up coins in each list's real shape (read 2026-10-23); no network."""
import json, os, sys, tempfile, time
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path[:0] = [HERE, os.path.join(HERE, "..", "feed")]
os.environ["PINR_ROUTING_FILE"] = os.path.join(tempfile.mkdtemp(), "routing.json")   # never the engine's own routing
import discovery as D
import seen_feed as SF

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
ISO = lambda t: time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(t))
JUP = [{"id": "MadeUpBagsCoin111111111111111111111111111111", "launchpad": "met-dbc", "name": "Bag", "symbol": "BAG", "createdAt": ISO(NOW - 300)},
       {"id": "MadeUpDbcCoin1111111111111111111111111111111", "launchpad": "met-dbc", "name": "Dbc", "symbol": "DBC", "icon": "https://cdn.example/d.png", "createdAt": ISO(NOW - 60)},
       {"id": "MadeUpPumpCoin11111111111111111111111111pump", "launchpad": "pump.fun", "name": "Pump", "symbol": "PMP", "createdAt": ISO(NOW - 30)},
       {"id": "MadeUpStonkCoin111111111111111111111111111111", "launchpad": "stonkfun", "name": "Stonk", "symbol": "STK", "createdAt": ISO(NOW - 40)},
       {"id": "MadeUpOtherPad11111111111111111111111111111", "launchpad": "newpad", "name": "Np", "symbol": "NP", "createdAt": ISO(NOW - 50)},
       {"id": "MadeUpOldCoin1111111111111111111111111111111", "launchpad": "met-dbc", "name": "Old", "symbol": "OLD", "createdAt": ISO(NOW - 90_000)}]
RAY = {"data": {"rows": [{"mint": "MadeUpStonkCoin111111111111111111111111111111", "name": "Stonk", "symbol": "STK", "imgUrl": "https://img.example/s.png",
                          "createAt": int((NOW - 40) * 1000), "platformInfo": {"name": "StonkFun"}},
                         {"mint": "MadeUpBonkCoin1111111111111111111111111111111", "name": "Bonk", "symbol": "BNK", "createAt": int((NOW - 20) * 1000),
                          "platformInfo": {"name": "letsbonk.fun"}}]}}
BAGS = {"response": [{"tokenMint": "MadeUpBagsCoin111111111111111111111111111111", "name": "Bag", "symbol": "BAG", "image": "https://bags.example/b.png"},
                     {"tokenMint": "MadeUpBagsNoTime1111111111111111111111111111", "name": "NoTime", "symbol": "NT"}]}


def fetch(url):
    if url.startswith(D.JUP_SEARCH):                              # Jupiter's record for the coins a list gave no time for
        return [{"id": "MadeUpBagsCoin111111111111111111111111111111", "createdAt": ISO(NOW - 300)}]
    return JUP if url == D.JUP_RECENT else RAY if url == D.RAYDIUM_NEW else BAGS if url == D.BAGS_FEED else None


def c1():
    j, r, b = D.from_jupiter(JUP), D.from_raydium(RAY), D.from_bags(BAGS)
    jm = {x["mint"][:12]: x["launchpad"] for x in j}
    return (jm == {"MadeUpBagsCo": "Meteora DBC", "MadeUpDbcCoi": "Meteora DBC", "MadeUpOtherP": "newpad (as Jupiter names it)", "MadeUpOldCoi": "Meteora DBC"}
            and [x["launchpad"] for x in r] == ["LaunchLab curve (StonkFun)", "LaunchLab curve (letsbonk.fun)"] and r[0]["launched_at"] == NOW - 40
            and b[0]["launchpad"] == "Bags (Meteora DBC)" and b[0]["launched_at"] is None), f"Jupiter: {jm}; Raydium: {[x['launchpad'] for x in r]}; Bags: {b[0]['launchpad']}"
case(1, "Each list read in its own shape; Pump.fun and LaunchLab left to their own routes", "Jupiter's coins outside Pump.fun and LaunchLab, the launchpad in the feed's words (or as Jupiter names it); Raydium's every LaunchLab platform named; Bags' feed; a launch time only where the list states one", c1)


def c2():
    written = {}
    files = set()
    def write(rec):
        files.add(rec["mint"]); written[rec["mint"]] = rec; return True
    got = D.one_pass(fetch=fetch, now=NOW, write=write, exists=lambda m: m in files)
    again = D.one_pass(fetch=fetch, now=NOW + 30, write=write, exists=lambda m: m in files)
    stonk = written.get("MadeUpStonkCoin111111111111111111111111111111")
    bag = written.get("MadeUpBagsCoin111111111111111111111111111111")              # on Jupiter's list AND Bags' feed (W1)
    return (got == {"raydium_list": 2, "bags_feed": 1, "jupiter_recent": 2} and again == {} and bag["launched_at"] == ISO(NOW - 300) and bag["seen_by"] == "bags_feed" and bag["launchpad"] == "Bags (Meteora DBC)"
            and "MadeUpBagsNoTime1111111111111111111111111111" not in written
            and stonk["seen_by"] == "raydium_list" and stonk["launchpad"] == "LaunchLab curve (StonkFun)"
            and "MadeUpOldCoin1111111111111111111111111111111" not in written and "MadeUpPumpCoin11111111111111111111111111pump" not in written
            and written["MadeUpDbcCoin1111111111111111111111111111111"]["image_url"] == "https://cdn.example/d.png"), \
        f"first pass {got}; second pass {again}; Stonk.fun from Raydium's own list; a coin over a day old and the Pump.fun coin not written"
case(2, "Each new coin written once, from its launchpad's own list first", "one seen file a coin (Raydium's or Bags' own list before Jupiter's); a coin with a file is never written again; a coin launched over a day ago is left out; a list with no launch time takes Jupiter's, and a coin whose launch time stays unknown is not written", c2)


def c3():
    d = tempfile.mkdtemp()
    import feed_export as F
    F.FEED_DIR = d
    m = "MadeUpDbcCoin1111111111111111111111111111111"
    json.dump({"mint": m, "score": 55, "display": "55"}, open(os.path.join(d, m + ".json"), "w"))
    got = D.write_new(D.from_jupiter(JUP[1:2]), now=NOW)
    kept = json.load(open(os.path.join(d, m + ".json")))
    rec = SF.seen_record("MadeUpBagsCoin111111111111111111111111111111", "bags_feed", NOW, launchpad="Bags (Meteora DBC)")
    return (got == {} and kept.get("score") == 55 and rec["seen_by"] == "bags_feed" and rec["chain"] == "solana"), f"a scored file left as it was: {kept.get('score')}; the new sources accepted by the seen record: {rec['seen_by']}"
case(3, "A scored or existing file is never replaced; the new sources are allowed", "the real writer's exclusive create keeps a scored file; jupiter_recent, raydium_list and bags_feed are seen_by values the record accepts", c3)


def c4():
    """a launchpad switched off on /control is not asked at all."""
    import routing as RT
    r = RT.defaults(); r["discovery"]["bags"] = False; r["discovery"]["jupiter_recent"] = False
    json.dump({"version": 2, "routing": r}, open(RT.routing_file(), "w")); RT._cur[0] = None
    asked = []
    def counting(url):
        asked.append(url.split("/")[2]); return fetch(url)
    try:
        written, files = {}, set()
        got = D.one_pass(fetch=counting, now=NOW, write=lambda rec: files.add(rec["mint"]) or written.setdefault(rec["mint"], rec) or True,
                         exists=lambda m: m in files)
    finally:
        os.remove(RT.routing_file()); RT._cur[0] = None
    hosts = sorted(set(asked))
    return (got == {"raydium_list": 2} and not any("bags" in h or "jup" in h for h in hosts)), \
        f"Bags and Jupiter's recent list off: asked {hosts}; written {got}"
case(4, "A launchpad switched off on pinr.io/control is not asked", "with Bags and Jupiter's recent list off, neither list is read and only LaunchLab's coins come in; the others as before", c4)

print(f"\n{sum(results)}/{len(results)} passed")
raise SystemExit(0 if all(results) else 1)
