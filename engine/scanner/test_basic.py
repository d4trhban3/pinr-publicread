"""the team's order under every listed coin's basic evidence at once, from cheap free reads.
Made-up coins; the chain, the gateways and Pump.fun stubbed; a temporary database and feed folder; no network.
Run:  python3 test_basic.py"""
import json, os, sys, tempfile, time
os.environ["PINR_IPFS_REST_FILE"] = os.path.join(tempfile.mkdtemp(), "ipfs_rest.sqlite")   # never the engine's own record of rests
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path[:0] = [HERE, os.path.join(HERE, "..", "stage2"), os.path.join(HERE, "..", "stage3"), os.path.join(HERE, "..", "feed")]
import basic as BA
import evidence as EV
import scanner as S

BA.jup_icons = lambda ms, rows=None: {}                                        # no network: case 7 hands in its own Jupiter answer
BA.jup_rows = lambda ms: []                                                    # no network: the gate's tests hand in their own records
BA.read_images = lambda pairs: {}                                              # no network: no picture is fetched in these tests
BA.pump_record = lambda m, uri: None                                           # no network: case 6 hands in its own Pump.fun answer
import pumpfun_api as _PF                                                      # the team's F2: never the engine's own rest file
_PF.REST_FILE = os.path.join(tempfile.mkdtemp(), "pumpfun_rest.json")
TMP = tempfile.mkdtemp()
S.DB = os.path.join(TMP, "scanner.sqlite")

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


def fresh():
    for ext in ("", "-wal", "-shm"):
        if os.path.exists(S.DB + ext):
            os.remove(S.DB + ext)
    BA._DONE.clear(); BA._HOLDERS.clear()
    return S.db()


A, B, C, D, DEV, H1 = (addr(t) for t in ("CoinA", "CoinB", "CoinC", "CoinD", "Dev", "HoldA"))


def stubs(docs, calls):
    def meta_read(ms):
        calls.setdefault("meta", []).append(list(ms))
        return {m: {"name": "n", "symbol": "s", "uri": "https://ipfs.example/" + m, "account": m} for m in ms if m in docs}
    def doc_read(uri):
        calls.setdefault("doc", []).append(uri)
        return docs.get(uri.rsplit("/", 1)[1])
    def holders_read(m):
        calls.setdefault("holders", []).append(m)
        return {"source": "Pump.fun top holders", "rows": [{"wallet": H1, "amount": 10, "program": False, "dev": True}]}
    seen = {}
    def update_seen(m, **f):
        seen[m] = f
        return True
    return meta_read, doc_read, holders_read, update_seen, seen


def c1():
    pf = BA.links_from({"twitter": "https://x.com/a", "website": "ftp://no", "telegram": " https://t.me/a "})
    mp = BA.links_from({"properties": {"links": {"x": "https://x.com/b", "web": "https://b.example"}}})
    none = BA.links_from({"name": "only a name"})
    return (pf == {"x": "https://x.com/a", "website": None, "telegram": "https://t.me/a"} and mp == {"x": "https://x.com/b", "website": "https://b.example", "telegram": None}
            and none == {"x": None, "website": None, "telegram": None}), f"Pump.fun shape {pf}; Metaplex shape {mp}; none listed {none}"
case(1, "The links a coin launched with, from its own metadata document", "both document shapes; http(s) only; none listed is none, never a guess", c1)


def c2():
    c = fresh(); fdir = tempfile.mkdtemp(); calls = {}
    docs = {A: {"image": "https://img.example/a.png", "twitter": "https://x.com/a", "website": "https://a.example"},
            B: {"image": "https://img.example/b.png"}, C: {"image": "https://img.example/c.png", "telegram": "https://t.me/c"}}
    mr, dr, hr, us, seen = stubs(docs, calls)
    records = {A: {"creator": DEV, "image": None}, B: {"creator": DEV, "image": "https://already.example/b.png"}, C: {}}
    got = BA.read_pass(c, [A, B, C], records, fdir, now=1000.0, meta_read=mr, doc_read=dr, holders_read=hr, update_seen=us, budget=3, holders_budget=2)
    fa = json.load(open(os.path.join(fdir, "evidence", A + ".json")))
    rows = {r["what"]: r for r in fa["rows"]}
    ok = (got["files"] == 3 and calls["meta"] == [[A, B, C]] and calls["holders"] == [A, B] and fa["scan"] == "basic"
          and rows["created by"]["onchain"] is False and rows["created by"]["source"] == "Pump.fun"
          and rows["metadata document"]["onchain"] is True and rows["metadata document"]["source"] == "Solana chain"
          and rows["lists its own link"]["source"] == "launchpad record" and rows["holds"]["source"] == "Pump.fun"
          and seen[A]["image_url"] == "https://img.example/a.png" and "image_url" not in seen[B]
          and seen[A]["links"]["x"] == "https://x.com/a" and seen[A]["links"]["source"] == "Solana chain" and seen[A]["links"]["read_at"].endswith("Z")
          and "x" not in seen[B]["links"] and seen[C]["links"]["telegram"] == "https://t.me/c")
    return ok, f"{got}; one chain read for all three; holders for the first two only; A's file '{fa['scan']}': created by ○ Pump.fun, document ● Solana chain, own links 'launchpad record'; the seen file gets the picture only where the record had none, and links in the scored files' shape"
case(2, "One pass: every coin's basic evidence from cheap free reads", "page order, one batch read of the chain, then each coin's document; rows into the table and the coin's file marked 'basic'; the picture and the links into its seen file; the holders list for a few coins only", c2)


def c3():
    c = fresh(); fdir = tempfile.mkdtemp(); calls = {}
    docs = {A: {"image": "https://img.example/a.png"}}
    mr, dr, hr, us, seen = stubs(docs, calls)
    meta_unanswered = lambda ms: {m: {"uri": "https://ipfs.example/" + m, "account": m} for m in ms}
    got1 = BA.read_pass(c, [A, B], {}, fdir, now=1000.0, meta_read=meta_unanswered, doc_read=dr, holders_read=hr, update_seen=us)
    got2 = BA.read_pass(c, [A, B], {}, fdir, now=1100.0, meta_read=meta_unanswered, doc_read=dr, holders_read=hr, update_seen=us)
    got3 = BA.read_pass(c, [A, B], {}, fdir, now=1000.0 + 3700, meta_read=meta_unanswered, doc_read=dr, holders_read=hr, update_seen=us)
    nofile = not os.path.exists(os.path.join(fdir, "evidence", B + ".json"))
    return (got1["unanswered"] == 1 and got1["files"] == 1 and got2["asked"] == 0 and got3["asked"] == 1 and nofile and B not in seen), \
        f"first pass {got1}; ten minutes later nothing asked ({got2['asked']}); an hour later B asked again ({got3['asked']}); B never given an empty file or 'no links': {nofile}"
case(3, "A document no gateway answered", "unknown, never 'no links': no file, no seen update, tried again after an hour and not before; a read coin never read again", c3)


def c4():
    c = fresh(); fdir = tempfile.mkdtemp(); calls = {}
    docs = {A: {"twitter": "https://x.com/a"}, D: {"twitter": "https://x.com/d"}}
    mr, dr, hr, us, seen = stubs(docs, calls)
    c.execute("INSERT INTO tokens (chain, token, launchpad, first_seen, scores, last_scored, last_ok) VALUES ('solana',?,?,?,1,?,?)", (D, "pumpfun", 1.0, 500.0, 500.0)); c.commit()
    got = BA.read_pass(c, [D, A], {A: {"creator": DEV}, D: {"creator": DEV}}, fdir, now=1000.0, meta_read=mr, doc_read=dr, holders_read=hr, update_seen=us)
    skipped = D not in sum(calls.get("meta", []), []) and not os.path.exists(os.path.join(fdir, "evidence", D + ".json"))
    full = {"mint": A, "receipts": [{"what": "creator (from curve)", "value": DEV, "unit": "address", "source": "getAccountInfo curve", "as_of": "slot 1"}]}
    EV.store(c, full, now=2000.0)
    c.execute("INSERT INTO tokens (chain, token, launchpad, first_seen, scores, last_scored, last_ok) VALUES ('solana',?,?,?,1,?,?)", (A, "pumpfun", 1.0, 2000.0, 2000.0)); c.commit()
    body = EV.coin_file(c, A, now=2001.0)
    cb = next(r for r in body["rows"] if r["what"] == "created by")
    return skipped and got["files"] == 1 and body["scan"] == "full" and cb["onchain"] is True and cb["source"] == "Solana chain", \
        f"a fully scored coin left alone: {skipped}; after A's full scan its file says '{body['scan']}' and its creator row is ● {cb['source']} (the chain read replaced the launch record)"
case(4, "The full scan takes over", "a coin already scored is never read again by the basic pass (a chain-read fact is never replaced by a reported one); a basic coin's full scan replaces its basic rows and its file says 'full'", c4)


def c5():
    os.environ["PINR_IPFS_REST_FILE"] = os.path.join(tempfile.mkdtemp(), "ipfs_rest.sqlite")   # its own record of rests
    asked = []
    answers = {}
    def fetch(u):
        asked.append(u)
        return answers.get(u.split("/")[2], (200, {"image": "https://img.example/x.png"}))
    gws = ["https://g1.example/ipfs/", "https://g2.example/ipfs/", "https://g3.example/ipfs/"]
    alts = lambda uri: [uri] if "/ipfs/" not in uri else [g + uri.split("/ipfs/", 1)[1] for g in gws]
    clock = [1000.0]
    P = BA.PacedDocs(fetch=fetch, alternatives=alts, now=lambda: clock[0])
    own = P("https://launchpad.example/meta/1.json")
    one = len(asked); asked.clear()
    a, b, c3 = P("https://g1.example/ipfs/A"), P("https://g1.example/ipfs/B"), P("https://g1.example/ipfs/C")
    rotated = [u.split("/")[2] for u in asked]; asked.clear()
    answers["g1.example"] = (429, None)
    P.turn = 0
    refused = P("https://g1.example/ipfs/D")
    rested = "g1.example" in P.rest; asked.clear()
    answers.update({"g2.example": (429, None), "g3.example": (429, None)})
    P("https://g1.example/ipfs/E"); P("https://g1.example/ipfs/F")
    asked.clear()
    all_resting = P("https://g1.example/ipfs/G")
    sent_while_resting = len(asked)
    clock[0] += BA.GATEWAY_REST_S + 1; answers.clear()
    back = P("https://g1.example/ipfs/H")
    ok = bool(own and one == 1 and a and b and c3 and rotated == ["g1.example", "g2.example", "g3.example"] and refused is None and rested
              and all_resting is None and sent_while_resting == 0 and back)
    return ok, f"a launchpad-hosted document: {one} request; three IPFS documents: one gateway each, in turn {rotated}; a 429 rests that gateway {rested}; every gateway resting: {sent_while_resting} requests sent; after the rest: answered {bool(back)}"
case(5, "The basic pass's paced document reader (LIMIT of 2026-10-22: the public gateways answered 429)", "one request per document: the document's own host once, or ONE IPFS gateway, taken in turn; a 429 rests that gateway ten minutes; with all resting nothing is sent and the document waits; the scorer's own reader is unchanged", c5)


def c6():
    c = fresh(); fdir = tempfile.mkdtemp(); calls = {}
    mr, dr, hr, us, seen = stubs({}, calls)                                   # no gateway answers any document
    meta = lambda ms: {m: {"uri": "https://ipfs.example/" + m, "account": m} for m in ms}
    asked = []
    def pump(m, uri):
        asked.append(m)
        if m == A:
            return {"image": "https://pump-images.example/a.png", "twitter": "https://x.com/a", "_source": "Pump.fun record of " + uri}
        return None                                                            # B: Pump.fun's record names another file, or none
    got = BA.read_pass(c, [A, B, C], {A: {"creator": DEV}}, fdir, now=1000.0, meta_read=meta, doc_read=lambda u: None, holders_read=hr,
                       update_seen=us, pump_read=pump, pump_budget=2)
    fa = json.load(open(os.path.join(fdir, "evidence", A + ".json")))
    link = next(r for r in fa["rows"] if r["what"] == "lists its own link")
    ok = (asked == [A, B] and got["from_pumpfun"] == 1 and got["files"] == 1 and got["unanswered"] == 2 and seen[A]["image_url"] == "https://pump-images.example/a.png"
          and seen[A]["links"]["source"] == "Pump.fun" and link["source"] == "Pump.fun" and B not in seen and C not in seen)
    return ok, f"Pump.fun asked for {len(asked)} coins (its budget); {got}; A's picture from Pump.fun's image host and its links sourced 'Pump.fun'; B (record names another file) and C (over the budget) left for later"
case(6, "the team's fallback: Pump.fun's own coin record when no gateway answered", "only when the record names this exact metadata file, for a few coins a pass (Pump.fun's shared budget); its picture and links, sourced Pump.fun; anything else stays unknown for a later pass", c6)


def c7():
    fresh()
    c = S.db()
    fdir = tempfile.mkdtemp()
    calls = {}
    mr, dr, hr, _us, _seen = stubs({A: {"name": "a", "twitter": "https://x.com/a", "image": "https://doc-host.example/a.png"}}, calls)
    seen, order = {}, []
    def us(m, **f):                                                            # merges fields, as the real seen-file writer does
        order.append((m, sorted(f)))
        seen.setdefault(m, {}).update(f)
        return True
    asked = []
    def icons(ms):
        asked.append(list(ms))
        return {A: "https://cdn.example/a.png", B: "https://cdn.example/b.png"}   # Jupiter has pictures for A and B, none for C
    got = BA.read_pass(c, [A, B, C], {C: {"image": "https://record.example/c.png"}}, fdir, now=1000.0, meta_read=mr, doc_read=dr,
                       holders_read=hr, update_seen=us, icons_read=icons)
    ok = (asked == [[A, B]] and got["from_jupiter"] == 2 and seen[A]["image_url"] == "https://cdn.example/a.png"
          and seen[B]["image_url"] == "https://cdn.example/b.png" and order[0] == (A, ["image_url"]) and order[1] == (B, ["image_url"])
          and seen[A]["links"]["x"] == "https://x.com/a" and got["pictures"] == 0 and "image_url" not in seen.get(C, {}) and seen[B] == {"image_url": "https://cdn.example/b.png"})
    return ok, (f"Jupiter asked once for {asked} (C's record already has a picture); {got}; A and B got their pictures first, before any document; "
                f"A's document still gave its links and did not replace Jupiter's picture; B (no document) kept Jupiter's picture alone")
case(7, "pictures straight from token data, at once", "one Jupiter token-list call for up to 100 coins a pass, before any document is read; each picture written at once; coins whose record already has a picture not asked; the documents still read for links and evidence, never replacing that picture; a coin Jupiter has no picture for waits for its document as before", c7)


def c8():
    os.environ["PINR_IPFS_REST_FILE"] = os.path.join(tempfile.mkdtemp(), "ipfs_rest.sqlite")   # its own record of rests
    slept, t = [], [1000.0]
    def fetch(url):
        return 200, {"name": "n", "image": "https://x.example/p.png"}
    P = BA.PacedDocs(fetch=fetch, alternatives=lambda u: ["https://g1.example/ipfs/A", "https://g1.example/ipfs/A2"] if "A" in u else [u],
                     now=lambda: t[0], sleep=lambda s: slept.append(round(s, 2)))
    P("https://g1.example/ipfs/A"); P("https://g1.example/ipfs/A")
    ok = len(slept) == 1 and slept[0] == BA.GATEWAY_GAP_S
    import readers as R
    return ok and R.IPFS_GATEWAYS[0].startswith("https://ipfs.filebase.io/"), f"two documents on one gateway in the same instant: waited {slept}; Filebase listed first: {R.IPFS_GATEWAYS[0]}"
case(8, "the team 2026-10-23: each IPFS gateway paced on its own; Filebase first", "a gateway is asked at most once a half second, whatever the workers do; Filebase's free gateway, which answered when ipfs.io and dweb.link refused, is listed first", c8)


def c9():
    """2026-10-24: the scanner's database stayed locked while the pass fetched pictures (a write left open)."""
    import sqlite3, gate as G
    c = fresh(); fdir = tempfile.mkdtemp()
    G.record(c, [{"id": A, "dev": DEV, "name": "a", "symbol": "a", "icon": None, "audit": {"devMints": 1}}], 1000.0); c.commit()
    json.dump({"image_url": "https://img.example/a.png"}, open(os.path.join(fdir, A + ".json"), "w"))
    seen = {}
    def images_read(pairs):
        seen["pairs"] = [m for m, _u in pairs]
        seen["open"] = c.in_transaction
        other = sqlite3.connect(S.DB, timeout=0.5)
        try:
            other.execute("CREATE TABLE IF NOT EXISTS probe (x)"); other.execute("INSERT INTO probe VALUES (1)"); other.commit()
            seen["other_wrote"] = True
        except sqlite3.OperationalError as e:
            seen["other_wrote"] = str(e)
        other.close()
        return {}
    mr, dr, hr, us, _seen = stubs({}, {})
    BA.read_pass(c, [A], {A: {}}, fdir, now=1000.0, meta_read=mr, doc_read=dr, holders_read=hr, update_seen=us, images_read=images_read)
    return (seen.get("pairs") == [A] and seen["open"] is False and seen["other_wrote"] is True), \
        f"while the picture was fetched: a write left open {seen.get('open')}; another connection could write: {seen.get('other_wrote')}"
case(9, "Nothing holds the database while pictures are fetched (the 'database is locked' of 2026-10-24)", "the picture filled from the coin's tile is kept before any network read; another reader or writer (the scoring loop, the Mac's hand-ins) is never kept waiting", c9)

def c10():
    """the team 2026-10-24: /control showed IPFS ~90% errors: every gateway asked for every coin, those refusing the server included."""
    import io, urllib.error, urllib.request, readers as R
    os.environ["PINR_IPFS_REST_FILE"] = os.path.join(tempfile.mkdtemp(), "ipfs_rest.sqlite")
    asked, agents = [], set()
    def urlopen(req, timeout=None):
        u = req.full_url; asked.append(u.split("/")[2]); agents.add(req.get_header("User-agent"))
        host = u.split("/")[2]
        if host == "ipfs.filebase.io":
            return io.BytesIO(b'{"name": "Coin"}')
        code = 403 if host in ("dweb.link", "w3s.link") else 429
        raise urllib.error.HTTPError(u, code, "refused", {}, None)
    real = urllib.request.urlopen
    urllib.request.urlopen = urlopen
    try:
        uri = "https://ipfs.io/ipfs/bafyTESTcidA"
        first = R.metadata_document(uri); first_asked = sorted(set(asked)); asked.clear()
        second = R.metadata_document("https://ipfs.io/ipfs/bafyTESTcidB"); second_asked = sorted(set(asked)); asked.clear()
        resting = R.resting_gateways()
        paced = BA.PacedDocs(alternatives=R.ipfs_alternatives, sleep=lambda s: None)
        picked = [paced._pick(R.ipfs_alternatives("https://ipfs.io/ipfs/bafyTESTcidC")) for _ in range(3)]
        for h in ("ipfs.filebase.io",):
            R.rest_gateway(h)
        none_left = R.metadata_document("https://ipfs.io/ipfs/bafyTESTcidD"); none_asked = list(asked)
        local = BA.PacedDocs(alternatives=lambda u: ["https://a.example/x", "https://b.example/x"], sleep=lambda s: None)
        local._refused("https://a.example/x", 403)
        shared_403 = "a.example" in R.resting_gateways()
    finally:
        urllib.request.urlopen = real
    return (first == {"name": "Coin"} and len(first_asked) == len(R.IPFS_GATEWAYS) and second == {"name": "Coin"} and second_asked == ["ipfs.filebase.io"]
            and resting == {g.split("/")[2] for g in R.IPFS_GATEWAYS} - {"ipfs.filebase.io"}
            and all(p and p.startswith("https://ipfs.filebase.io/") for p in picked) and none_left is None and none_asked == [] and shared_403
            and agents == {"PINR-live/1.0 (read-only metadata)"}), \
        (f"first coin: {len(first_asked)} gateways asked, Filebase answered; the {len(resting)} that refused (429 or 403) rest for every process; "
         f"next coin asks only {second_asked}; the basic pass picks {set(p.split('/')[2] for p in picked if p)}; all resting: {none_left} with {len(none_asked)} requests; "
         f"a 403 rests a gateway too: {shared_403}; asked as {agents}")
case(10, "Gateways that refuse the server rest for every process", "a gateway answering 429 or 403 rests ten minutes for the scorer's workers and the basic pass alike; the next coin asks only those not resting; with all resting nothing is sent; PINR's own name, never a browser's", c10)

def c11():
    """the team 2026-10-24, after ipfsrest: two more readers still asked every gateway with no rest (the metadata batch's
    picture read and the EVM token's document), so /control kept showing 429s while the gateways rested."""
    import re
    root = os.path.join(HERE, "..")
    users = []
    skip = {"inspection", "learning", "node_modules", "frontend-feed", "rules-history", "index", "__pycache__"}   # the team's F1 on c7255ae3: every engine folder
    for dirpath, dirs, names in os.walk(root):
        dirs[:] = [d for d in dirs if d not in skip and not d.startswith(".")]
        folder = os.path.relpath(dirpath, root)
        for n in sorted(names):
            if n.endswith(".py") and not n.startswith("test_"):
                text = open(os.path.join(dirpath, n), encoding="utf-8", errors="ignore").read()
                for fn in re.findall(r"\ndef (\w+)\([^\n]*\n(?:(?!\ndef ).)*?ipfs_alternatives\(", text, re.S):
                    users.append(f"{folder}/{n}:{fn}")
                if "ipfs_alternatives" in text and n == "basic.py":
                    users.append("scanner/basic.py:PacedDocs")
    allowed = {"stage2/readers.py:metadata_document", "stage2/readers.py:ipfs_alternatives", "scanner/basic.py:PacedDocs"}
    return set(users) <= allowed and "stage2/readers.py:metadata_document" in users, f"readers walking the gateway list: {sorted(set(users))}"
case(11, "Only the readers that honour the rests walk the gateway list", "the scorer's metadata read (metadata_document) and the basic pass's paced reader are the only places that ask IPFS gateways; every other reader goes through them", c11)

def c12():
    """the evidence pass follows the operator's wires for pictures, links and token data."""
    import routing as RT
    os.environ["PINR_ROUTING_FILE"] = os.path.join(tempfile.mkdtemp(), "routing.json")
    docs = {A: {"image": "https://img.example/a.png", "twitter": "https://x.com/a"}}
    def run(pic, links, token=("jupiter",)):
        r = RT.defaults(); r["routes"]["picture"], r["routes"]["links"], r["routes"]["token_data"] = list(pic), list(links), list(token)
        json.dump({"version": 2, "routing": r}, open(RT.routing_file(), "w")); RT._cur[0] = None
        c = fresh(); fdir = tempfile.mkdtemp(); calls = {}
        mr, dr, hr, _us, _seen = stubs(docs, calls)
        seen, pumped = {}, []
        us = lambda m, **f: seen.setdefault(m, {}).update(f) or True
        got = BA.read_pass(c, [A], {A: {}}, fdir, now=1000.0, meta_read=mr, doc_read=dr, holders_read=hr, update_seen=us,
                           icons_read=lambda ms: {m: "https://jup.example/a.png" for m in ms}, pump_read=lambda m, u: pumped.append(m) or None,
                           rows_read=lambda ms: calls.setdefault("jup_rows", []).append(list(ms)) or [])
        return seen.get(A, {}), calls, pumped, got
    today, c_today, p_today, _ = run(["jupiter", "ipfs", "pumpfun"], ["ipfs", "pumpfun"])
    own_first, _c, _p, _ = run(["ipfs", "jupiter"], ["ipfs", "pumpfun"])
    no_doc_links, c3, p3, g3 = run(["jupiter"], ["pumpfun"])
    try:
        os.remove(RT.routing_file())
    except OSError:
        pass
    RT._cur[0] = None
    return (today.get("image_url") == "https://jup.example/a.png" and today["links"]["x"] == "https://x.com/a" and "jup_rows" in c_today
            and own_first.get("image_url") == "https://img.example/a.png"
            and no_doc_links.get("image_url") == "https://jup.example/a.png" and "links" not in no_doc_links and "doc" not in c3 and p3 == [A]), \
        (f"today's wires: picture {today.get('image_url')}, links {today.get('links', {}).get('x')}; the coin's own file above Jupiter: {own_first.get('image_url')}; "
         f"picture from Jupiter only and links from Pump.fun only: picture {no_doc_links.get('image_url')}, links {no_doc_links.get('links')}, "
         f"metadata file read {'doc' in c3}, Pump.fun asked for {len(p3)} coin")
case(12, "The evidence pass follows the wires", "today's wires give today's result; the top wire wins a field; a source not wired to a field is never asked for it nor used for it", c12)
def c13():
    """the design's catch-up: Arena members kept before the gate kept names are read again from Jupiter, once."""
    import gate as G, pvp as P, routing as RT
    os.environ["PINR_ROUTING_FILE"] = os.path.join(tempfile.mkdtemp(), "routing.json"); RT._cur[0] = None
    c = fresh(); G.ensure(c)
    for m, nk, chain in ((B, "wolf", None), (C, None, None), (D, "wolf", "base")):   # B: an old row; C: Jupiter gave no name; D: a Base coin
        c.execute("INSERT INTO gate (mint, dev, name_key, symbol_key, chain) VALUES (?,?,?,?,?)", (m, DEV, nk, nk, chain))
    c.commit()
    P.NAMELESS[:] = [B, C, D]
    asked = []
    def rows(ms):
        asked.append(list(ms))
        return [{"id": m, "dev": DEV, "name": "Wolf", "symbol": "WOLF"} for m in ms if m == B and len(asked) > 1]   # unknown the first time
    kw = dict(meta_read=lambda ms: {}, doc_read=lambda u: None, holders_read=lambda m: None, update_seen=lambda m, **f: True,
              icons_read=lambda ms: {}, pump_read=lambda m, u: None, rows_read=rows)
    BA.read_pass(c, [], {}, tempfile.mkdtemp(), now=1000.0, **kw)
    BA.read_pass(c, [], {}, tempfile.mkdtemp(), now=1100.0, **kw)
    once = list(asked)
    G._NAME_ASKED.clear()                                                 # a new process asks again
    BA.read_pass(c, [], {}, tempfile.mkdtemp(), now=1200.0, **kw)
    BA.read_pass(c, [], {}, tempfile.mkdtemp(), now=1300.0, **kw)
    got = c.execute("SELECT name, ticker FROM gate WHERE mint=?", (B,)).fetchone()
    P.NAMELESS[:] = []
    return once == [[B]] and asked == [[B], [B]] and got == ("Wolf", "WOLF"), \
        f"a coin Jupiter did not know: asked {len(once)} time in two passes; a new process asked again ({len(asked)} in all) and the old row now {got}; nothing asked after"
case(13, "Arena members kept before names were get them", "an old Solana row with a name key is read again from Jupiter once a process and keeps the name and ticker as given; a row Jupiter gave no name for and a Base coin are never asked", c13)

def c14():
    """Checklist 6: a young coin with no launch record's creator gets the creator Jupiter's list gives (the gate's row), as ○ Jupiter."""
    import gate as G
    c = fresh(); G.ensure(c); fdir = tempfile.mkdtemp(); calls = {}
    JD = addr("JupDev")
    G.record(c, [{"id": A, "dev": JD, "name": "a", "symbol": "a"}, {"id": B, "dev": JD, "name": "b", "symbol": "b"}], 900.0); c.commit()
    docs = {A: {"image": "https://img.example/a.png"}, B: {"image": "https://img.example/b.png"}, C: {"image": "https://img.example/c.png"}}
    mr, dr, hr, us, _seen = stubs(docs, calls)
    BA.read_pass(c, [A, B, C], {A: {}, B: {"creator": DEV}, C: {}}, fdir, now=1000.0, meta_read=mr, doc_read=dr, holders_read=hr,
                 update_seen=us, budget=3, holders_budget=0, rows_read=lambda ms: [])
    cb = {m: [r for r in json.load(open(os.path.join(fdir, "evidence", m + ".json")))["rows"] if r["what"] == "created by"] for m in (A, B, C)}
    a, b = cb[A][0] if cb[A] else {}, cb[B][0] if cb[B] else {}
    to = lambda r: (r.get("to") or {}).get("id")
    return (to(a) == JD and a.get("source") == "Jupiter" and a.get("onchain") is False and len(cb[A]) == 1
            and to(b) == DEV and b.get("source") == "Pump.fun" and len(cb[B]) == 1 and cb[C] == []), \
        f"no launch record: created by {str(to(a))[:10]}... ○ {a.get('source')}; with one: {str(to(b))[:10]}... ○ {b.get('source')} (Jupiter's not added); neither: {len(cb[C])} rows"
case(14, "A young coin's creator from Jupiter's list before its full score (checklist 6)", "with no launch record's creator, the gate's Jupiter creator becomes a ○ 'created by' row named Jupiter; a launch record's creator wins; with neither, no row (missing stays missing)", c14)

def c15():
    """the team's F1 on creator6: the chain's creator retires Jupiter's row on the page, also when they differ."""
    import gate as G
    c = fresh(); G.ensure(c); fdir = tempfile.mkdtemp(); calls = {}
    JD, CD = addr("JupDev"), addr("ChainDev")
    G.record(c, [{"id": A, "dev": JD, "name": "a", "symbol": "a"}, {"id": B, "dev": JD, "name": "b", "symbol": "b"}], 900.0); c.commit()
    mr, dr, hr, us, _seen = stubs({A: {"image": "https://img.example/a.png"}, B: {"image": "https://img.example/b.png"}}, calls)
    BA.read_pass(c, [A, B], {A: {}, B: {}}, fdir, now=1000.0, meta_read=mr, doc_read=dr, holders_read=hr, update_seen=us,
                 budget=2, holders_budget=0, rows_read=lambda ms: [])
    for m, who in ((A, CD), (B, JD)):                                    # the full score: A's chain creator differs, B's is the same
        EV.store(c, {"mint": m, "receipts": [{"what": "creator (from curve)", "value": who, "unit": "address", "source": "getAccountInfo " + m, "as_of": None}]}, 2000.0)
    c.commit()
    page = {m: [(r["to"]["id"], r["source"], r["onchain"]) for r in EV.coin_file(c, m)["rows"] if r["what"] == "created by"] for m in (A, B)}
    kept = c.execute("SELECT COUNT(*) FROM evidence WHERE coin=? AND what='created by'", (A,)).fetchone()[0]
    return (page[A] == [(CD, "Solana chain", True)] and page[B] == [(JD, "Solana chain", True)] and kept == 2), \
        f"chain creator differs: the page shows {[(w[:10], s) for w, s, _o in page[A]]} (the table keeps both rows: {kept}); the same wallet: {[(w[:10], s) for w, s, _o in page[B]]}"
case(15, "The chain's creator retires Jupiter's on the page", "once a ● creator is read, the ○ Jupiter creator is left off the coin's file, whether it names the same wallet or another; both stay in the evidence table (nothing deleted, 232)", c15)


def c16():
    """S6: a scored coin on the site's browse list, older than the pool's newest coins, never reached the
    gate's 100 a pass. The pass order: first page (newest first), the browse list's first page (the site's order), the pool."""
    page = [("P_old", 10), ("P_new", 20)]
    rest = [("R_ranked1", 1), ("R_ranked2", 99), ("P_new", 20)]
    pool = [(f"N{k}", 1000 + k) for k in range(150)] + [("R_ranked1", 1)]
    order = BA.pass_order(page, rest, pool)
    need = [m for m in order if m.startswith(("R", "P"))][:4]
    old = [m for m, _b in sorted(page, key=lambda mb: -mb[1])] + [m for m, _b in sorted(pool, key=lambda mb: -mb[1]) if m not in {m for m, _ in page}]
    ok = order[:4] == ["P_new", "P_old", "R_ranked1", "R_ranked2"] and len(order) == len(set(order)) == 154 and old.index("R_ranked1") >= 100
    return ok, f"first: {order[:4]}; each once ({len(order)} coins); before the change the browse list's coin came at place {old.index('R_ranked1') + 1} (past the 100 a pass)"
case(16, "Listed coins on the browse list reach the gate's read before the pool's newest (S6)", "the first page, then the browse list in the site's order, then the pool; each coin once; a browse-list coin is inside the first 100", c16)

print(f"\n{sum(results)}/{len(results)} passed")
raise SystemExit(0 if all(results) else 1)
