"""the gate in front of the X check and PINRai (scanner/gate.py). Made-up coins, no network."""
import json, os, sqlite3, sys, tempfile
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path[:0] = [HERE, os.path.join(HERE, "..", "stage3"), os.path.join(HERE, "..", "stage2")]
import gate as G
import basic as _BA
_BA.read_images = lambda pairs: {}                 # no network: case 19 hands in its own picture hashes

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


LINE = 50   # an example figure for the tests only; PINR's own line is withheld from the public copy
DEV1, DEV2 = addr("DevOne"), addr("DevTwo")


def store():
    path = os.path.join(tempfile.mkdtemp(), "scanner.sqlite")
    c = sqlite3.connect(path)
    G.ensure(c)
    return c, path


def iso(t):
    import time
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(t))


def row(mint, dev=DEV1, name="Alpha", sym="ALP", icon=None, mints=3, at=1_790_000_000):
    """A record in Jupiter's shape; `at` is the coin's launch (Jupiter's createdAt), None for no launch time."""
    r = {"id": mint, "dev": dev, "name": name, "symbol": sym, "icon": icon, "audit": {"devMints": mints}}
    if at is not None:
        r["createdAt"] = iso(at)
    return r






def c3():
    c, _ = store()
    A, B, C = addr("CoinD1"), addr("CoinD2"), addr("CoinD3")
    G.record(c, [row(A, name="Moon Dog", sym="MDOG"), row(B, name="moon  dog", sym="MDOG2"), row(C, name="Other", sym="OTH")], 1000.0)
    va, vc = G.verdict(c, A, serial_over=LINE), G.verdict(c, C, serial_over=LINE)
    return (va["status"] == "held" and va["observed"] == ["the same creator launched another coin with the same name"] and vc["status"] == "passed"), f"A: {va}; C (same creator, nothing shared): {vc['status']}"
case(3, "A duplicate is held: the same creator relaunching a name, ticker or picture", "the same creator with another coin of the same name (case and spaces evened out) is held and says which field; the same creator's unrelated coin passes", c3)


def c4():
    c, _ = store()
    A, B = addr("CoinOrig"), addr("CoinCopy")
    G.record(c, [row(A, dev=DEV1, name="Pepe King", sym="PKING", at=1_790_000_000)], 1000.0)
    G.record(c, [row(B, dev=DEV2, name="PEPE KING", sym="pking", at=1_790_000_060)], 1060.0)
    va, vb = G.verdict(c, A, serial_over=LINE), G.verdict(c, B, serial_over=LINE)
    return (va["status"] == "passed" and vb["status"] == "held" and vb["observed"] == ["an earlier-launched coin by another creator has the same name and ticker"]), f"original: {va['status']}; later copy: {vb}"
case(4, "A vamp is held: a later coin by another creator with the same name and ticker", "the earlier coin passes; the later one by another creator with the same name and ticker is held, said in plain words", c4)


def c5():
    c, _ = store()
    cid = "Qm" + "a" * 44
    A, B, D, E2 = addr("CoinPic1"), addr("CoinPic2"), addr("CoinPic3"), addr("CoinPic4")
    G.record(c, [row(A, dev=DEV1, name="Cat", sym="CAT", icon=f"https://ipfs.io/ipfs/{cid}", at=1_790_000_000)], 1000.0)
    G.record(c, [row(B, dev=DEV2, name="Kitty", sym="CAT", icon=f"https://gateway.pinata.cloud/ipfs/{cid}", at=1_790_000_060)], 1060.0)
    G.record(c, [row(D, dev=addr("DevThree"), name="Dog", sym="DOG", icon=f"https://cf-ipfs.com/ipfs/{cid}", at=1_790_000_070)], 1070.0)
    G.record(c, [row(E2, dev=addr("DevFour"), name="Hat", sym="HAT", icon="https://launchpad.example/default.png", at=1_790_000_080)], 1080.0)
    G.record(c, [row(addr("CoinPic5"), dev=addr("DevFive"), name="Cap", sym="CAP", icon="https://launchpad.example/default.png", at=1_790_000_090)], 1090.0)
    va, vb, vd = (G.verdict(c, m, serial_over=LINE) for m in (A, B, D))
    ve, v4 = G.verdict(c, addr("CoinPic5"), serial_over=LINE), G.verdict(c, E2, serial_over=LINE)
    return (va["status"] == "passed" and vb["status"] == "held" and vb["observed"] == ["an earlier-launched coin by another creator has the same picture"]
            and vd["status"] == "held" and ve["status"] == "held" and v4["status"] == "passed"), f"the first with the picture: {va['status']}; same picture on another gateway: {vb['status']}; same picture, nothing else shared: {vd['status']}; a shared picture, the later one: {ve['status']}, the earlier: {v4['status']}"
case(5, "The operator: the picture alone is enough", "the same picture (by its IPFS content id, whichever gateway, or the same address) is a copy with no shared name or ticker; the earliest launch keeps it, every later coin by another creator is held", c5)


def c6():
    c, path = store()
    A, B, C = addr("CoinN1"), addr("CoinN2"), addr("CoinN3")
    G.record(c, [row(A, dev=None), {"id": B, "dev": DEV1, "name": "x", "symbol": "x", "audit": {}}], 1000.0); c.commit()
    va, vb, vc = G.verdict(c, A, serial_over=LINE), G.verdict(c, B, serial_over=LINE), G.verdict(c, C, serial_over=LINE)
    missing = os.path.join(tempfile.mkdtemp(), "none.sqlite")
    ok_m, why_m = G.passed(A, missing)
    return (va["status"] == vb["status"] == vc["status"] == "not read yet" and not G.passed(A, path)[0] and not ok_m
            and not os.path.exists(missing)), f"no creator: {va}; no launch count: {vb}; never read: {vc}; a store that does not exist: {ok_m}, {why_m!r}, file created: {os.path.exists(missing)}"
case(6, "Missing stays missing: no token data, creator or launch count means 'not read yet'", "nothing is sent for a coin whose creator or launch count is unknown or never read; an unreadable store sends nothing and is never created", c6)




def c8():
    import basic as BA, scanner as S
    S.DB = os.path.join(tempfile.mkdtemp(), "scanner.sqlite")
    c = S.db()
    A, B = addr("CoinBa"), addr("CoinBb")
    c.execute("INSERT OR REPLACE INTO tokens (chain, token, last_ok) VALUES ('solana', ?, 1)", (B,)); c.commit()   # B fully scored
    asked = []
    def rows(ms):
        asked.append(list(ms))
        return [row(m, dev=DEV1, name=m[:8], sym=m[:4], icon="https://cdn.example/" + m[:6] + ".png") for m in ms]
    seen = {}
    got = BA.read_pass(c, [A, B], {}, tempfile.mkdtemp(), now=1000.0, meta_read=lambda ms: {}, doc_read=lambda u: None,
                       holders_read=lambda m: None, update_seen=lambda m, **f: seen.setdefault(m, {}).update(f) or True, rows_read=rows)
    return (asked == [[A, B]] and G.has(c, A) and G.has(c, B) and got["gate_read"] == 2 and got["from_jupiter"] == 1
            and seen.get(A, {}).get("image_url") == "https://cdn.example/" + A[:6] + ".png" and B not in seen), f"Jupiter asked once for {len(asked[0]) if asked else 0} coins; gate rows for both (B is fully scored); {got}; A's picture from the same answer"
case(8, "The picture pass reads the gate's token data in the same Jupiter call", "one call gives the gate every listed coin's record (fully scored coins included) and the not-yet-read coins their pictures, with no second call", c8)


def c9():
    c, _ = store()
    O, K = addr("CoinOrig9"), addr("CoinCopy9")
    G.record(c, [row(K, dev=DEV2, name="Frog Lord", sym="FROG", at=1_790_000_600)], 1000.0)     # the copy is READ first (newest first)
    G.record(c, [row(O, dev=DEV1, name="Frog Lord", sym="FROG", at=1_790_000_000)], 1100.0)     # the original, read a pass later
    vo, vk = G.verdict(c, O, serial_over=LINE), G.verdict(c, K, serial_over=LINE)
    return (vo == {"status": "passed", "observed": []} and vk["status"] == "held"
            and vk["observed"] == ["an earlier-launched coin by another creator has the same name and ticker"]), f"original (read second, launched first): {vo}; copy (read first, launched later): {vk}"
case(9, "the team's F1: the copy read before its original", "'earlier' is the coin's own launch (Jupiter's createdAt), never when PINR first read it: the original passes and the copy is held, whichever was read first", c9)


def c10():
    c, _ = store()
    P, Q, R = addr("CoinNt1"), addr("CoinNt2"), addr("CoinNt3")
    G.record(c, [row(P, dev=DEV1, name="Same", sym="SAME", at=None), row(Q, dev=DEV2, name="Same", sym="SAME", at=1_790_000_000),
                 {"id": R, "dev": addr("DevR"), "name": "Lone", "symbol": "LONE", "audit": {"devMints": 1}, "firstPool": {"createdAt": iso(1_790_000_100)}}], 1000.0)
    vp, vq, vr = (G.verdict(c, m, serial_over=LINE) for m in (P, Q, R))
    at_r = c.execute("SELECT launched_at FROM gate WHERE mint=?", (R,)).fetchone()[0]
    return (vp["status"] == "not read yet" and vq["status"] == "not read yet" and vr["status"] == "passed" and at_r == 1_790_000_100), f"look-alike with no launch time: {vp}; its twin: {vq['status']}; a coin dated only by its first pool: {vr['status']}, launch read {at_r}"
case(10, "No launch time: the vamp check is 'not read yet'", "a look-alike whose launch time is missing (on either side) leaves both 'not read yet', never passed or held on a guess; the first pool's createdAt is used when createdAt is absent", c10)


def c11():
    c, _ = store()
    O, K, R1, R2, S = addr("CoinSecO"), addr("CoinSecK"), addr("CoinSecR1"), addr("CoinSecR2"), addr("CoinSecS")
    G.record(c, [row(O, dev=DEV1, name="Wolf", sym="WOLF", at=1_790_000_000),
                 row(K, dev=DEV2, name="Wolf", sym="WOLF", at=1_790_000_300, mints=LINE + 7),
                 row(R1, dev=DEV2, name="Wolf", sym="WLF2", at=1_789_999_000), row(R2, dev=DEV2, name="Other", sym="OTH", at=1_789_998_000)], 1000.0)
    g = G.section(c, K, serial_over=LINE)
    kinds = [i["kind"] for i in g["items"]]
    look = next(i for i in g["items"] if i["kind"] == "earlier_lookalike")
    rel = next(i for i in g["items"] if i["kind"] == "same_creator_relaunch")
    ser = next(i for i in g["items"] if i["kind"] == "serial_launcher")
    text = json.dumps(g)
    ok = (g["status"] == "held" and kinds == ["serial_launcher", "same_creator_relaunch", "earlier_lookalike"]
          and look["coin"] == O and look["launched_at"] == iso(1_790_000_000) and look["link"] == "https://solscan.io/token/" + O
          and look["creator"] == DEV1 and look["same"] == "name and ticker"
          and rel["same"] == ["name"] and [x["coin"] for x in rel["coins"]] == [R1] and ser["launch_count"] == LINE + 7
          and g["creator"]["id"] == DEV2 and g["creator"]["launch_count"] == LINE + 7 and g["creator"]["link"] == "https://solscan.io/account/" + DEV2
          and {x["coin"] for x in g["creator"]["other_coins"]} == {R1, R2} and g["launched_at"] == iso(1_790_000_300)
          and g["source"] == "Jupiter" and f": {LINE}" not in text and f" {LINE} " not in text and G.section(c, addr("Never")) is None)
    return ok, f"status {g['status']}; items {kinds}; look-alike {look['coin'][:10]} launched {look['launched_at']}; relaunch coins {[x['coin'][:10] for x in rel['coins']]}; creator's other coins {len(g['creator']['other_coins'])}; the line never in the section"
case(11, "the coin's gate section, observed words with links", "status and words as the gate said them; one item per observation: the earlier look-alike's coin, launch time, link and creator; the creator's coins sharing a name/ticker/picture; the creator's launch count (never the line); the creator's wallet and its other coins PINR has read; none for a coin never read", c11)






def c14():
    c, _ = store()
    dev = addr("DevFast")
    rows = [row(addr("Fast" + "".join("abcdefghjk"[int(d)] for d in "%04d" % i)), dev=dev, name=f"Coin {i}", sym=f"C{i}", mints=38, at=1_790_000_000 + i) for i in range(LINE + 1)]
    G.record(c, rows, 1000.0)
    m = rows[-1]["id"]
    v, g = G.verdict(c, m, serial_over=LINE), G.section(c, m, serial_over=LINE)
    ser = next(i for i in g["items"] if i["kind"] == "serial_launcher")
    slow = addr("DevSlow"); c2_ = row(addr("Slow1"), dev=slow, name="Solo", sym="SOLO", mints=12)
    G.record(c, [c2_], 1000.0)
    n_slow = G.launch_count(c, slow, 12)
    return (v["status"] == "held" and v["observed"] == [f"this coin's creator has launched at least {LINE + 1} coins (PINR's count)"]
            and ser["launch_count_source"] == "PINR" and g["creator"]["launch_count"] == LINE + 1 and n_slow == (12, "Jupiter")), \
        f"Jupiter says 38, PINR has read {LINE + 1}: {v['status']}, source {ser['launch_count_source']}; a creator PINR has seen once with Jupiter's 12: {n_slow}"
case(14, "the team 2026-10-23: Jupiter's count lags behind a fast launcher", "the launch count is the larger of Jupiter's and the creator's coins PINR has itself read, said as 'at least N (PINR's count)' when PINR's is larger; Jupiter's when it is larger", c14)


def c15():
    c, _ = store()
    rate = (5, 10.0)                                                          # made-up figures for the test; the operator's live only on the server
    dev, slow = addr("DevBurst"), addr("DevSteady")
    t0 = 1_790_000_000
    burst = [row(addr("Bu" + "abcdefghjk"[i]), dev=dev, name=f"B {i}", sym=f"B{i}", mints=5, at=t0 + i * 60) for i in range(5)]
    steady = [row(addr("St" + "abcdefghjk"[i]), dev=slow, name=f"S {i}", sym=f"S{i}", mints=5, at=t0 + i * 200) for i in range(5)]
    G.record(c, burst + steady, 1000.0)
    vb = G.verdict(c, burst[2]["id"], serial_over=LINE, rate=rate)
    vs = G.verdict(c, steady[2]["id"], serial_over=LINE, rate=rate)
    vf = G.verdict(c, burst[2]["id"], serial_over=LINE, rate=(6, 10.0))
    g = G.section(c, burst[2]["id"], serial_over=LINE, rate=rate)
    it = next(i for i in g["items"] if i["kind"] == "fast_launcher")
    text = json.dumps(g)
    return (vb["status"] == "held" and vb["observed"] == ["this coin's creator launched 5 coins in quick succession around this one"]
            and vs["status"] == "passed" and vf["status"] == "passed" and it["count"] == 5 and len(it["coins"]) == 4
            and "10 min" not in text and "minutes" not in text), f"5 coins a minute apart: {vb['status']}; 5 coins over ~13 min: {vs['status']}; one short of the count: {vf['status']}; item {it['count']} coins, {len(it['coins'])} linked; the rate's figures not in the section"
case(15, "a creator launching fast is held", "at least the operator's count of the creator's coins inside one window of the operator's length that holds this launch: held, said as what was observed, the other coins linked; the rate's own figures never in the words or the section; fewer, or spread wider: passed", c15)




def c17():
    c, _ = store()
    A, B, C = addr("CoinShaA"), addr("CoinShaB"), addr("CoinShaC")
    G.record(c, [row(A, dev=DEV1, name="Skin", sym="SKN", icon="https://cdn-one.example/a.png", at=1_790_000_000),
                 row(B, dev=DEV2, name="Walker", sym="WLK", icon="https://other-host.example/x/b.webp", at=1_790_000_100),
                 row(C, dev=addr("DevC3"), name="Third", sym="THR", icon="https://third.example/c.png", at=1_790_000_200)], 1000.0)
    G.record_image(c, A, "f" * 64, "00000000000000ff", 1000.0)
    G.record_image(c, B, "f" * 64, "ffffffffffffffff", 1000.0)                    # the same file bytes on another host
    G.record_image(c, C, "e" * 64, "00000000000000f8", 1000.0)                    # a different file, 2 bits from A's look
    vb, vc = G.verdict(c, B, serial_over=LINE), G.verdict(c, C, serial_over=LINE)
    g = G.section(c, B, serial_over=LINE)
    it = next(i for i in g["items"] if i["kind"] == "earlier_lookalike")
    gc = next(i for i in G.section(c, C, serial_over=LINE)["items"] if i["kind"] == "earlier_lookalike")
    return (vb["status"] == "held" and vc["status"] == "held" and it["match"] == "same picture file" and it["coin"] == A
            and gc["match"] == "near-identical picture" and gc["coin"] == A and G.verdict(c, A, serial_over=LINE)["status"] == "passed"), \
        f"same file on another host: {vb['status']} ({it['match']}, earlier coin {it['coin'][:10]}); a near-identical picture: {vc['status']} ({gc['match']}); the earliest: passed"
case(17, "The same picture file or a near-identical picture, on any host", "the same SHA-256 of the picture's bytes, or a perceptual hash a few bits away, is the same picture across hosts and addresses; the item says which match it was; the earliest launch keeps it", c17)


def c18():
    c, _ = store()
    A, B = addr("CoinFarA"), addr("CoinFarB")
    G.record(c, [row(A, dev=DEV1, name="One", sym="ONE", icon="https://a.example/1.png", at=1_790_000_000),
                 row(B, dev=DEV2, name="Two", sym="TWO", icon="https://b.example/2.png", at=1_790_000_100)], 1000.0)
    G.record_image(c, A, "1" * 64, "0000000000000000", 1000.0)
    G.record_image(c, B, "2" * 64, "00000000000000ff", 1000.0)                    # 8 bits apart: a different picture
    vb = G.verdict(c, B, serial_over=LINE)
    G.record(c, [row(B, dev=DEV2, name="Two", sym="TWO", icon="https://b.example/new.png", at=1_790_000_100)], 1100.0)
    reset = c.execute("SELECT img_sha, img_phash, img_read FROM gate WHERE mint=?", (B,)).fetchone()
    return (vb["status"] == "passed" and reset == (None, None, None) and B in [m for m, _u in G.image_need(c, 10, 1200.0)]), \
        f"a picture several bits away: {vb['status']}; the coin's picture address changed: its hashes cleared {reset} and it is fetched again"
case(18, "A different picture is not a copy; a changed picture is read again", "a perceptual hash past the near-identical margin is another picture; when a coin's picture address changes, its file and look are cleared and fetched again", c18)




def c20():
    c, path = store()
    fdir = tempfile.mkdtemp()
    A, B = addr("CoinTileA"), addr("CoinTileB")
    G.record(c, [row(A, dev=DEV1, name="Wolf", sym="WOLFA", icon=None, at=1_790_000_000), row(B, dev=DEV2, name="Navajo", sym="NAV", icon=None, at=1_790_000_100)], 1000.0)
    for m in (A, B):
        json.dump({"mint": m, "image_url": "https://tile-host.example/wolf.png"}, open(os.path.join(fdir, m + ".json"), "w"))
    n = G.fill_images(c, fdir)
    vb = G.verdict(c, B, serial_over=LINE)
    c.commit()
    ro = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
    ok_ro = G.verdict(ro, A, serial_over=LINE)["status"] == "passed"
    return (n == 2 and vb["status"] == "held" and "same picture" in vb["observed"][0] and ok_ro), f"no Jupiter picture: {n} filled from the tiles' own pictures; the later coin {vb['status']}; a read-only reader still answers: {ok_ro}"
case(20, "No Jupiter picture: the tile's own picture is compared", "a coin Jupiter has no picture for takes the image_url its feed file shows (its own metadata document), so the gate compares what buyers see; a read-only reader (the X check, PINRai) never writes to the store", c20)




def c22():
    import random, time as _t
    c, path = store()
    rnd = random.Random(7)
    base = [rnd.getrandbits(64) for _ in range(40)]
    mints, devs = [addr("Pic%04d" % i) for i in range(1500)], [addr("Dev%02d" % i) for i in range(30)]
    rows = []
    for i, m in enumerate(mints):
        v = base[i % 40]
        for _ in range(rnd.randrange(0, 9)):
            v ^= 1 << rnd.randrange(64)                                  # 0 to 8 bits flipped: some within the line, some past it
        rows.append(row(m, dev=None if i % 7 == 3 else devs[i % 30], name="P%d" % i, sym="P%d" % i, at=1_790_000_000 + i, icon=f"https://h.example/{i % 300}.png"))
    G.record(c, rows, 1000.0)
    for i, m in enumerate(mints):
        G.record_image(c, m, "sha%d" % (i % 500), "%016x" % (base[i % 40] ^ sum(1 << b for b in rnd.sample(range(64), rnd.randrange(0, 9)))), 2000.0 + i)
    c.commit()
    def brute(m, same):
        d, img, sha, ph = c.execute("SELECT dev, image_key, img_sha, img_phash FROM gate WHERE mint=?", (m,)).fetchone()
        out = []
        for r in c.execute("SELECT mint, launched_at, dev, image_key, img_sha, img_phash FROM gate WHERE " + ("dev=?" if same else "dev<>?") + " AND mint<>?", (d, m)):
            how = ("same picture address" if img and r[3] == img else "same picture file" if sha and r[4] == sha else "near-identical picture" if G._near(ph, r[5]) else None)
            if how:
                out.append((r[0], r[1], r[2], how))
        return sorted(out, key=lambda x: (x[1] is None, x[1] or 0, x[0]))
    sample = mints[::25]
    t0 = _t.time(); fast = [G.same_picture(c, m, s) for m in sample for s in (True, False)]; tf = _t.time() - t0
    slow = [brute(m, s) for m in sample for s in (True, False)]
    later = addr("PicLater")
    G.record(c, [row(later, dev=devs[0], name="L", sym="L", at=1_790_009_999)], 3000.0)
    first_ph = c.execute("SELECT img_phash FROM gate WHERE mint=?", (mints[0],)).fetchone()[0]
    G.record_image(c, later, "shaX", first_ph, 3001.0); c.commit()                 # the first coin's very picture, read later
    new = any(x[0] == later for x in G.same_picture(c, mints[0], False) + G.same_picture(c, mints[0], True))
    nobody = {r[0] for r in c.execute("SELECT mint FROM gate WHERE dev IS NULL")}
    none_found = not any(x[0] in nobody for got in fast for x in got)
    return (fast == slow and sum(map(len, fast)) > 0 and new and none_found and len(nobody) > 100), \
        f"{len(sample) * 2} look-ups: the same {sum(map(len, fast))} matches as comparing every picture ({tf:.2f} s); a picture read later is found too: {new}; none of the {len(nobody)} creatorless coins counted as anyone's: {none_found}"
case(22, "The server's stalls: the picture check finds the same matches without comparing every picture", "near-identical pictures found through the hash's slices give exactly what comparing every picture gives (address, file and near matches alike); a picture read after the index was built is found too", c22)


def c23():
    c, _p = store()
    same = G._key("Blind Ape\u2060") == G._key("Blind Ape") == G._key("blind\u200b ape") == "blind ape" and G._key("\u2060") is None
    a, b = addr("Hidden"), addr("Plain")
    G.record(c, [row(b, dev=DEV1, name="Blind Ape", sym="APE")], 1000.0)
    c.execute("INSERT INTO gate (mint, dev, name_key, symbol_key) VALUES (?,?,?,?)", (a, DEV2, "blind ape\u2060", "ape\u2060"))   # kept before the fix
    G._REKEYED.clear()
    n = G.rekey(c); again = G.rekey(c)
    keys = c.execute("SELECT name_key, symbol_key FROM gate WHERE mint=?", (a,)).fetchone()
    return (same and n == 1 and again == 0 and keys == ("blind ape", "ape")), f"keys with a word joiner or zero-width space equal the plain one: {same}; rows re-keyed: {n} (then {again}); the old row now {keys}"
case(23, "the team 2026-10-26: a name that hides an invisible character is the same name", "a word joiner, zero-width space and the like are dropped before names and tickers are compared; rows kept before are re-keyed once", c23)








print(f"\n{sum(results)}/{len(results)} passed")
raise SystemExit(0 if all(results) else 1)
