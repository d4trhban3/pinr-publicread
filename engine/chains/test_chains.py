"""CHAINS: Base and BNB coins into PINR. Made-up coins in each source's real shape (read live
2026-10-25: Clanker, Zora, Virtuals, GeckoTerminal, DexScreener, the Four.meme and Flap factory events); every file and
database in a temporary folder; no network (any real request fails the run)."""
import json, os, sqlite3, sys, tempfile, time, urllib.request
HERE = os.path.dirname(os.path.abspath(__file__))
TMP = tempfile.mkdtemp(prefix="pinr-chains-test-")
os.environ.update(PINR_CHAINS_DB=os.path.join(TMP, "chains.sqlite"), PINR_SCANNER_DB=os.path.join(TMP, "scanner.sqlite"),
                  PINR_ROUTING_FILE=os.path.join(TMP, "routing.json"), PINR_GATE_FILE=os.path.join(TMP, "gate.json"),
                  PINR_IPFS_REST_FILE=os.path.join(TMP, "ipfs_rest.sqlite"))
os.environ.pop("PINR_CHAINS_OFF", None)


def _no_network(*a, **k):
    raise AssertionError("a test reached for the network")


urllib.request.urlopen = _no_network
sys.path.insert(0, HERE)
import service as SV, sources as S, bnb as B, feed as FD, market as MK
import solana_rpc as _S
_S.COUNT_DB = os.path.join(TMP, "requests.sqlite")          # the request counter in the temp folder too
import holders as HD, virtuals_facts as VF, score as SC
HD_READ, VF_READ = HD.read, VF.read                           # the real readers, for the cases that test them
HD.read = lambda *a, **k: None                                # elsewhere no holders or Virtuals read reaches for the chain (F2)
VF.read = lambda *a, **k: None
import zora_social as ZS
ZS_READ = ZS.read
ZS.read = lambda *a, **k: None
SC._supply = lambda chain, mint: None
import flap_reader as FL, funding as FN
FL_FIRST = FL.first_funding
FL.first_funding = lambda *a, **k: None                       # no funding read reaches for the chain outside its own cases
FN.CODE_FN = lambda ch, w: None                               # nor any code read
FN.SHOWN_FN = lambda: set()                                   # nor the site's list
FN.SENDER_FN = lambda block, tx: None                         # nor a launch sender
import feed_export as F, seen_feed as SF
F.FEED_DIR = os.path.join(TMP, "frontend-feed")
from evm import enc_address, enc_uint

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
ISO = lambda t: time.strftime("%Y-%m-%dT%H:%M:%S.000Z", time.gmtime(t))
A = lambda n: "0x" + f"{n:040x}"                        # a made-up address
CREATOR = "0x00000000000000000000000000000000000000c1"

CLANKER = {"data": [
    {"chain_id": 8453, "contract_address": "0x00000000000000000000000000000000000000AA", "name": "Alpha", "symbol": "ALP",
     "img_url": "https://clankerworld.mypinata.cloud/ipfs/bafkreiaaaa", "deployed_at": ISO(NOW - 120), "admin": CREATOR.upper().replace("X", "x"),
     "tx_hash": "0xtx1", "socialLinks": [{"name": "twitter", "url": "https://x.com/alpha"}],
     "metadata": {"socialMediaUrls": [{"platform": "telegram", "url": "https://t.me/alpha"}]},
     "related": {"market": {"priceUsd": 2e-08, "marketCap": 2000, "marketDataUpdatedAt": ISO(NOW - 60)}}},
    {"chain_id": 1, "contract_address": A(0xAB), "name": "Eth", "symbol": "ETH1", "deployed_at": ISO(NOW - 100), "admin": CREATOR}]}
ZORA = {"exploreList": {"edges": [
    {"node": {"chainId": 8453, "address": A(0xB1), "name": "boat", "symbol": "boat", "createdAt": "2026-09-21T08:51:00+00:00",
              "creatorAddress": A(0xC2), "mediaContent": {"mimeType": "image/jpeg", "originalUri": "ipfs://bafybeizzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz"},
              "tokenPrice": {"priceInUsdc": "0.0000001"}, "marketCap": "12.5", "tokenUri": "ipfs://bafymeta"}},
    {"node": {"chainId": 8453, "address": A(0xB2), "name": "clip", "symbol": "clip", "createdAt": "2026-09-21T08:52:00+00:00",
              "creatorAddress": A(0xC2), "mediaContent": {"mimeType": "video/mp4", "originalUri": "ipfs://bafyvideovideovideovideovideovideovideovideo"}}},
    {"node": {"chainId": 8453, "address": A(0xB3), "name": "blocked", "symbol": "x", "createdAt": "2026-09-21T08:52:00+00:00", "platformBlocked": True}}]}}
VIRTUALS = {"data": [
    {"chain": "BASE", "tokenAddress": None, "preToken": "0x00000000000000000000000000000000000000D1", "name": "Hey", "symbol": "HEY",
     "walletAddress": A(0xC3), "launchedAt": ISO(NOW - 200), "image": {"url": "https://s3.example/hey.png"}, "socials": '{"VERIFIED_LINKS": {"TWITTER": "https://x.com/hey"}}'},
    {"chain": "ROBINHOOD", "preToken": A(0xD2), "name": "Rh", "symbol": "RH", "walletAddress": A(0xC3), "launchedAt": ISO(NOW - 200)}]}
GECKO = {"data": [
    {"attributes": {"pool_created_at": "2026-09-21T08:50:00Z"}, "relationships": {"dex": {"data": {"id": "virtuals-base"}}, "base_token": {"data": {"id": "base_" + A(0xD1)}}}},
    {"attributes": {"pool_created_at": "2026-09-21T08:50:00Z"}, "relationships": {"dex": {"data": {"id": "virtuals-base"}}, "base_token": {"data": {"id": "base_" + A(0xD3)}}}},
    {"attributes": {"pool_created_at": "2026-09-21T08:50:00Z"}, "relationships": {"dex": {"data": {"id": "uniswap-v4-base"}}, "base_token": {"data": {"id": "base_" + A(0xD4)}}}}],
    "included": [{"id": "base_" + A(0xD3), "attributes": {"name": "Gk", "symbol": "GK", "image_url": "missing.png"}}]}


def _str(s):
    b = s.encode()
    return enc_uint(len(b)) + (b.hex() + "00" * ((32 - len(b) % 32) % 32))


def four_log(token, creator, name, sym, launch_time, block=100, bts=None):
    head = [enc_address(creator), enc_address(token), enc_uint(1), None, None, enc_uint(10 ** 27), enc_uint(launch_time), enc_uint(0)]
    tail, off = "", 8 * 32
    for i, s in ((3, name), (4, sym)):
        head[i] = enc_uint(off + len(tail) // 2)
        tail += _str(s)
    log = {"topics": [B.FOUR_CREATE], "data": "0x" + "".join(head) + tail, "blockNumber": hex(block), "transactionHash": "0xft"}
    if bts:
        log["blockTimestamp"] = hex(bts)
    return log


def flap_log(token, creator, name, sym, meta, ts, block=101):
    head = [enc_uint(ts), enc_address(creator), enc_uint(7), enc_address(token), None, None, None]
    tail, off = "", 7 * 32
    for i, s in ((4, name), (5, sym), (6, meta)):
        head[i] = enc_uint(off + len(tail) // 2)
        tail += _str(s)
    return {"topics": [B.FLAP_CREATE], "data": "0x" + "".join(head) + tail, "blockNumber": hex(block), "transactionHash": "0xfl"}


class Node:
    """A made-up public node: eth_blockNumber, eth_getLogs over ranges, eth_getBlockByNumber; `refuse` makes a URL fail."""
    def __init__(self, tip, logs, refuse=()):
        self.tip, self.logs, self.refuse, self.calls = tip, logs, set(refuse), []

    def __call__(self, url, method, params, timeout=20):
        self.calls.append((url, method, params))
        if url in self.refuse:
            return None
        if method == "eth_blockNumber":
            return hex(self.tip)
        if method == "eth_getBlockByNumber":
            return {"timestamp": hex(int(NOW) - 50)}
        if method == "eth_getLogs":
            f = params[0]
            lo, hi = int(f["fromBlock"], 16), int(f["toBlock"], 16)
            if lo < getattr(self, "lost_below", -1):
                return None                                   # an old range no node keeps any more
            want = f["topics"][0] if isinstance(f["topics"][0], list) else [f["topics"][0]]
            return [l for l in self.logs if l["topics"][0] in want and lo <= int(l["blockNumber"], 16) <= hi]
        return None


def t1():
    r = S.clanker(CLANKER)
    ok = (len(r) == 1 and r[0]["mint"] == A(0xAA) and r[0]["creator"] == CREATOR and r[0]["links"] == {"x": "https://x.com/alpha", "telegram": "https://t.me/alpha"}
          and r[0]["price_usd"] == 2e-08 and r[0]["valuation_usd"] == 2000 and r[0]["launched_at"] == NOW - 120 and r[0]["image"].startswith("https://clankerworld"))
    return ok, f"{len(r)} Base coin, mint {r[0]['mint'] if r else None}, links {r[0].get('links') if r else None}"


def t2():
    z, v, g = S.zora(ZORA), S.virtuals(VIRTUALS), S.gecko_virtuals(GECKO)
    ok = ([x["mint"] for x in z] == [A(0xB1), A(0xB2)] and z[0]["image"] == "https://ipfs.io/ipfs/bafybeizzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz"
          and z[1]["image"] is None and z[0]["creator"] == A(0xC2)
          and [x["mint"] for x in v] == [A(0xD1)] and v[0]["links"] == {"x": "https://x.com/hey"} and v[0]["image"] == "https://s3.example/hey.png"
          and [x["mint"] for x in g] == [A(0xD1), A(0xD3)] and all(x["creator"] is None for x in g) and g[1]["image"] is None)
    return ok, f"zora {[x['mint'][-2:] for x in z]} pics {[bool(x['image']) for x in z]}; virtuals {[x['mint'][-2:] for x in v]}; gecko {[x['mint'][-2:] for x in g]}"


def t3():
    tok, tok2 = A(0xE1), A(0xE2)
    a = B.decode("fourmeme", four_log(tok, CREATOR, "Lucia", "LUCIA", 0, bts=int(NOW) - 30))
    b = B.decode("flap", flap_log(tok2, CREATOR, "牛熊", "牛熊", "bafkreimeta", int(NOW) - 40))
    c = B.decode("flap", four_log(tok, CREATOR, "x", "y", 1))
    ok = (a["mint"] == tok and a["creator"] == CREATOR and a["name"] == "Lucia" and a["launched_at"] == NOW - 30 and a["launchpad"] == "Four.meme"
          and b["mint"] == tok2 and b["name"] == "牛熊" and b["meta_uri"] == "ipfs://bafkreimeta" and b["launched_at"] == NOW - 40 and c is None)
    return ok, f"four {a['name']} at {a['launched_at'] - NOW:+.0f}s; flap {b['name']} meta {b['meta_uri']}; wrong event -> {c}"


def t4():
    logs = [four_log(A(0xE1), CREATOR, "A", "A", 0, block=9_995), flap_log(A(0xE2), CREATOR, "B", "B", "m", int(NOW), block=9_996),
            four_log(A(0xE3), CREATOR, "C", "C", int(NOW) - 5, block=9_000)]
    node = Node(10_000, logs)
    recs, cur = B.one_pass({}, post=node, sleep=lambda s: None)
    first = sorted(r["mint"][-2:] for r in recs)
    node.logs.append(four_log(A(0xE4), CREATOR, "D", "D", 0, block=10_002)); node.tip = 10_010
    recs2, cur2 = B.one_pass(cur, post=node, sleep=lambda s: None)
    node.refuse = {u for u, _c in B.NODES}; node.tip = 10_020
    recs3, cur3 = B.one_pass(cur2, post=node, sleep=lambda s: None)
    ok = (first == ["e1", "e2", "e3"] and cur == {"fourmeme": 9_997, "flap": 9_997} and [r["mint"][-2:] for r in recs2] == ["e4"]
          and recs2[0]["launched_at"] == NOW - 50 and cur2 == {"fourmeme": 10_007, "flap": 10_007} and recs3 == [] and cur3 == cur2)
    return ok, f"first pass {first} cursors {cur}; next {[r['mint'][-2:] for r in recs2]} (block time {recs2[0]['launched_at'] - NOW:+.0f}s) {cur2}; nodes refusing: {len(recs3)} new, cursors kept {cur3 == cur2}"


def t5():
    node = Node(30_000, [], refuse={B.NODES[0][0]})
    node.logs = [four_log(A(0xE5), CREATOR, "N", "N", int(NOW), block=9_500)]
    recs, cur = B.one_pass({"fourmeme": 2_000, "flap": 9_990}, post=node, sleep=lambda s: None)
    ok = cur["fourmeme"] == 2_000 + B.NODES[0][1] * B.MAX_CALLS and cur["flap"] == 9_990 + B.NODES[0][1] * B.MAX_CALLS and any(u == B.NODES[1][0] for u, m, _p in node.calls if m == "eth_getLogs")
    return ok, f"a long gap is caught up {B.NODES[0][1] * B.MAX_CALLS} blocks a pass (cursor {cur['fourmeme']}); the second node served when the first refused"


def t6():
    r = S.clanker(CLANKER)[0]
    rec = FD.seen_record(r, NOW)
    path = SF.write_seen(rec)
    again = FD.write_new([r], NOW)
    old = dict(r, mint=A(0xF1), launched_at=NOW - 90_000)
    unknown = dict(r, mint=A(0xF2), launched_at=None)
    skipped = FD.write_new([old, unknown], NOW)
    d = json.load(open(path))
    want = {"mint", "score", "display", "coverage", "label", "seen", "seen_at", "seen_by", "chain", "launchpad", "name", "ticker", "image_url",
            "launched_at", "links", "price_usd", "valuation_usd", "as_of"}
    ok = (set(d) == want and d["chain"] == "base" and d["seen_by"] == "clanker_api" and d["score"] is None and d["display"] == "not scored yet"
          and d["links"]["source"] == "Clanker" and again == {} and skipped == {} and not os.path.exists(os.path.join(F.FEED_DIR, A(0xF1) + ".json")))
    try:
        FD.seen_record(dict(r, chain="solana"), NOW); bad = False
    except ValueError:
        bad = True
    return ok and bad, f"fields {sorted(d)}; second write {again}; old/unknown-age {skipped}; solana refused {bad}"


def t7():
    c, g = SV.store(), SV.scanner_db()
    lists = {S.CLANKER_NEW: CLANKER, S.ZORA_NEW: ZORA, S.VIRTUALS_NEW: VIRTUALS, S.GECKO_BASE_NEW: GECKO}
    fetch = lambda url: (200, lists[url]) if url in lists else (404, None)
    zora_now = S.ts("2026-09-21T09:00:00Z")
    node = Node(10_000, [four_log(A(0xE1), CREATOR, "Lucia", "LUCIA", 0, block=9_995, bts=int(zora_now) - 30),
                         flap_log(A(0xE2), CREATOR, "B", "B", "bafkreimetametametametametametametametametameta", int(zora_now) - 20, block=9_996)])
    got = SV.discover(c, zora_now, {}, fetch=fetch, post=node)
    rows = dict(c.execute("SELECT mint, by FROM coins"))
    virt = json.load(open(os.path.join(F.FEED_DIR, A(0xD1) + ".json")))
    ok = (got == {"zora_explore": 2, "virtuals_api": 1, "fourmeme_chain": 1, "flap_chain": 1, "gecko_virtuals": 1}
          and rows[A(0xD1)] == "virtuals_api" and virt["seen_by"] == "virtuals_api" and rows[A(0xD3)] == "gecko_virtuals"
          and A(0xAA) in rows and A(0xB3) not in rows)
    again = SV.discover(c, zora_now + 1000, {}, fetch=fetch, post=Node(10_000, node.logs))
    return ok and again == {}, f"written {got} (Clanker's coins over a day old at this clock: kept in the store, no file); a coin in both Virtuals lists keeps Virtuals' own record; second pass {again}"




def t9():
    c, g = SV.store(), SV.scanner_db()
    doc = {"image": "bafkreipicpicpicpicpicpicpicpicpicpicpicpicpic", "twitter": "https://x.com/flap", "website": "", "telegram": ""}
    n = SV.read_docs(c, NOW, docs=lambda uri: doc)
    d = json.load(open(os.path.join(F.FEED_DIR, A(0xE2) + ".json")))
    c.execute("INSERT INTO coins (mint, chain, launchpad, by, creator, launched_at, meta_uri, doc_done) VALUES (?,?,?,?,?,?,?,0)",
              (A(0xE6), "bsc", "Flap", "flap_chain", CREATOR, NOW - 10, "ipfs://bafkreiunread"))
    n2 = SV.read_docs(c, NOW, docs=lambda uri: None)
    n3 = SV.read_docs(c, NOW + 60, docs=lambda uri: doc)
    n4 = SV.read_docs(c, NOW + 3700, docs=lambda uri: doc)
    ok = (n == 1 and d.get("image_url") == "https://ipfs.io/ipfs/bafkreipicpicpicpicpicpicpicpicpicpicpicpicpic" and d["links"]["x"] == "https://x.com/flap"
          and d["links"]["source"] == "Flap metadata (IPFS)" and "website" not in d["links"] and n2 == 0 and n3 == 0 and n4 == 1)
    return ok, f"picture {d.get('image_url')}; links {d.get('links')}; an unanswered document waits an hour ({n2}, {n3}, then {n4})"


def t10():
    c, g = SV.store(), SV.scanner_db()
    c.execute("UPDATE coins SET gated_at=1, doc_done=1 WHERE mint=?", (A(0xE6),))
    c.execute("UPDATE coins SET doc_done=0, doc_at=NULL, gated_at=5 WHERE mint=?", (A(0xE6),))
    SV.read_docs(c, NOW + 9000, docs=lambda uri: {"image": "bafkreinewnewnewnewnewnewnewnewnewnewnewnewnew"})
    regate = c.execute("SELECT gated_at FROM coins WHERE mint=?", (A(0xE6),)).fetchone()[0]
    n = SV.gate(c, g, NOW + 9000, F.FEED_DIR, fetch=lambda u: (0, None))
    icon = g.execute("SELECT image_key, dev_mints FROM gate WHERE mint=?", (A(0xE6),)).fetchone()
    ok = regate is None and icon is not None and icon[0] == "ipfs:bafkreinewnewnewnewnewnewnewnewnewnewnewnewnew" and icon[1] == 3
    return ok, f"a picture read after the gate: taken again ({regate}); gate picture {icon[0] if icon else None}; the creator's BNB coins PINR read: {icon[1] if icon else None}"


def t11():
    dex = [{"baseToken": {"address": "0x00000000000000000000000000000000000000E1".replace("E1", "e1").upper().replace("X", "x")}, "dexId": "pancakeswap", "pairAddress": "0xp1",
            "pairCreatedAt": int(NOW - 500) * 1000, "txns": {"h24": {"buys": 3, "sells": 2}}, "priceUsd": "0.00001", "marketCap": 10000,
            "liquidity": {"usd": 5000}, "volume": {"h24": 800}},
           {"baseToken": {"address": A(0xE1)}, "dexId": "other", "pairAddress": "0xp2", "txns": {"h24": {"buys": 0, "sells": 0}}, "priceUsd": "0.2", "liquidity": {"usd": 10}}]
    a = MK.from_dexscreener([A(0xE1), A(0xE3)], dex)
    gk = {"data": [{"attributes": {"address": A(0xAA), "price_usd": "0.0000002", "fdv_usd": "200", "market_cap_usd": None, "total_reserve_in_usd": "50",
                                   "volume_usd": {"h24": "9"}}, "relationships": {"top_pools": {"data": [{"id": "base_0xpool"}]}}}],
          "included": [{"id": "base_0xpool", "type": "pool", "attributes": {"address": "0xpool", "pool_created_at": "2026-09-21T08:50:00Z",
                                                                             "transactions": {"h24": {"buys": None, "sells": None}}},
                        "relationships": {"dex": {"data": {"id": "uniswap-v4-base"}}}}]}
    b = MK.from_gecko([A(0xAA)], gk)
    ok = (a[A(0xE1)]["price_usd"] == 0.00001 and a[A(0xE1)]["liquidity_usd"] == 5000 and [p["txns_h24"] for p in a[A(0xE1)]["pairs"]] == [5, 0]
          and a[A(0xE3)] == {"pairs": []} and b[A(0xAA)]["valuation_usd"] == 200 and b[A(0xAA)]["pairs"][0]["txns_h24"] is None
          and MK.fields(b[A(0xAA)]) == {"price_usd": 2e-07, "valuation_usd": 200, "liquidity_usd": 50, "volume_24h_usd": 9})
    return ok, f"bsc best pair by liquidity {a[A(0xE1)].get('price_usd')}, trades {[p['txns_h24'] for p in a[A(0xE1)]['pairs']]}; no pair -> {a[A(0xE3)]}; base fields {MK.fields(b[A(0xAA)])}"


def t12():
    clock = [1000.0]; slept = []; urls = []
    def get(url):
        urls.append(url)
        return (429, None) if len(urls) == 1 else (200, [])
    MK._next.update(dexscreener=0.0, geckoterminal=0.0); MK._rest.update(dexscreener=0.0, geckoterminal=0.0)
    mints = [A(i) for i in range(1, 70)]
    r1 = MK.read("bsc", mints, get=get, clock=lambda: clock[0], sleep=lambda s: (slept.append(s), clock.__setitem__(0, clock[0] + s)))
    clock[0] += 61
    r2 = MK.read("bsc", mints, get=get, clock=lambda: clock[0], sleep=lambda s: (slept.append(s), clock.__setitem__(0, clock[0] + s)))
    r3 = MK.read("base", mints[:5], get=lambda u: (urls.append(u), (200, {"data": []}))[1], clock=lambda: clock[0], sleep=lambda s: None)
    ok = (r1 == {} and len(urls) == 6 and len(r2) == 69 and "/tokens/v1/bsc/" in urls[1] and urls[1].count(",") == 29
          and "/tokens/v1/base/" in urls[-2] and "networks/base/tokens/multi" in urls[-1] and len(r3) == 5)
    return ok, f"after a 429 the rest of that pass is skipped ({len(r1)}), {len(r2)} answered a minute later in 3 calls; Base asks DexScreener first, then GeckoTerminal for the coins it lists no pair for"


def t13():
    c = SV.store()
    scored = A(0xF9)
    os.makedirs(F.FEED_DIR, exist_ok=True)
    json.dump({"mint": scored, "score": 40, "display": "40", "coverage": 0.5, "label": "x", "chain": "bsc", "price_usd": 1.0}, open(os.path.join(F.FEED_DIR, scored + ".json"), "w"))
    c.execute("INSERT INTO coins (mint, chain, launchpad, by, launched_at) VALUES (?,?,?,?,?)", (scored, "bsc", "Flap", "flap_chain", NOW - 100))
    c.execute("UPDATE coins SET launched_at=?, market_at=NULL", (NOW - 100,))
    c.commit()
    def get(url):
        if "dexscreener" in url:
            return 200, [{"baseToken": {"address": A(0xE1)}, "priceUsd": "0.5", "liquidity": {"usd": 7}, "txns": {"h24": {"buys": 1, "sells": 0}}},
                         {"baseToken": {"address": scored}, "priceUsd": "9", "liquidity": {"usd": 7}}]
        return 200, {"data": []}
    MK._next.update(dexscreener=0.0, geckoterminal=0.0); MK._rest.update(dexscreener=0.0, geckoterminal=0.0)
    MK.GAP.update(geckoterminal=0.0)
    got = SV.market_pass(c, NOW, get=get)
    e1 = json.load(open(os.path.join(F.FEED_DIR, A(0xE1) + ".json")))
    sc = json.load(open(os.path.join(F.FEED_DIR, scored + ".json")))
    again = SV.market_pass(c, NOW + 10, get=get)
    ok = e1.get("price_usd") == 0.5 and e1.get("liquidity_usd") == 7 and sc["price_usd"] == 1.0 and sc["score"] == 40 and again == {}
    return ok, f"answered {got}; seen file price {e1.get('price_usd')}; a scored file keeps its own ({sc['price_usd']}); ten seconds later nothing due {again}"


def t14():
    c, g = SV.store(), SV.scanner_db()
    old = NOW - 3 * 86400
    c.execute("UPDATE coins SET launched_at=? WHERE mint IN (?,?)", (NOW - 30 * 3600, A(0xE1), A(0xAA)))
    c.commit()
    g.execute("CREATE TABLE IF NOT EXISTS quiet (mint TEXT PRIMARY KEY, state TEXT, quiet_since REAL, last_trade REAL, checked_at REAL, by TEXT)")
    g.execute("INSERT OR REPLACE INTO quiet VALUES ('SolanaQuietCoin1111111111111111111111111111', 'quiet', ?, NULL, ?, 'DexScreener')", (old, old))
    g.commit()
    def get(url):
        if "dexscreener" in url:
            return 200, [{"baseToken": {"address": A(0xE1)}, "pairCreatedAt": int(NOW - 30 * 3600) * 1000, "txns": {"h24": {"buys": 0, "sells": 0}}}]
        return 200, {"data": [{"attributes": {"address": A(0xAA)}, "relationships": {"top_pools": {"data": [{"id": "p"}]}}}],
                     "included": [{"id": "p", "type": "pool", "attributes": {"pool_created_at": "2026-01-01T00:00:00Z", "transactions": {"h24": {"buys": 4, "sells": 1}}}}]}
    MK._next.update(dexscreener=0.0, geckoterminal=0.0); MK._rest.update(dexscreener=0.0, geckoterminal=0.0)
    qf = os.path.join(TMP, "frontend-feed", "_quiet.json")
    got = SV.quiet_pass(c, g, NOW, get=get, feed_file=qf, tape=lambda m: None)
    st = dict(g.execute("SELECT mint, state FROM quiet"))
    q = json.load(open(qf))
    sol = g.execute("SELECT checked_at FROM quiet WHERE mint='SolanaQuietCoin1111111111111111111111111111'").fetchone()[0]
    ok = st.get(A(0xE1)) == "quiet" and st.get(A(0xAA)) == "active" and A(0xE1) in q["quiet"] and sol == old and q["contract"] == "quiet-1"
    return ok, f"no trade for a day on BNB -> {st.get(A(0xE1))}; traded on Base -> {st.get(A(0xAA))}; a Solana quiet row is left as it was ({sol == old}); _quiet.json lists {len(q['quiet'])}"


def t15():
    os.environ["PINR_CHAINS_OFF"] = "zora,flap"
    a = (SV.on("clanker"), SV.on("zora"), SV.on("gecko_virtuals"), SV.on("flap"), SV.on("fourmeme"))
    os.environ.pop("PINR_CHAINS_OFF")
    lists = {S.ZORA_NEW: ZORA}
    os.environ["PINR_CHAINS_OFF"] = "zora"
    c = SV.store()
    got = SV.discover(c, NOW, {"clanker": NOW, "virtuals": NOW, "gecko_virtuals": NOW, "bnb": NOW}, fetch=lambda u: (200, lists.get(u)))
    os.environ.pop("PINR_CHAINS_OFF")
    return a == (True, False, True, False, True) and got == {}, f"switches {a}; Zora off -> its list not asked ({got})"


def t16():
    st = SV.status(SV.store())
    ok = st.get("base Clanker") == 1 and st.get("base Zora") == 2 and st.get("bsc Four.meme") == 1 and st.get("bsc Flap", 0) >= 2
    return ok, f"store {st}"


def t17():
    c, g = SV.store(), SV.scanner_db()
    open_at = []
    def watch(answer):
        def f(*a, **k):
            open_at.append(c.in_transaction or g.in_transaction)
            return answer(*a, **k)
        return f
    for i in range(3):
        c.execute("INSERT OR IGNORE INTO coins (mint, chain, launchpad, by, creator, launched_at, meta_uri, doc_done) VALUES (?,?,?,?,?,?,?,0)",
                  (A(0x700 + i), "bsc", "Flap", "flap_chain", A(0xC9), NOW - 10, "ipfs://bafkreiwatch%d" % i))
        c.execute("INSERT OR IGNORE INTO coins (mint, chain, launchpad, by, creator, launched_at, doc_done) VALUES (?,?,?,?,?,?,1)",
                  (A(0x800 + i), "base", "Zora", "zora_explore", A(0xCA + i), NOW - 10))
    c.commit()
    SV.read_docs(c, NOW + 20_000, docs=watch(lambda uri: None if uri.endswith("0") else {"image": "bafkreiwatchwatchwatchwatchwatchwatchwatchwat"}))
    SV.gate(c, g, NOW + 20_000, F.FEED_DIR, fetch=watch(lambda u: (200, {"profile": {"createdCoins": {"count": 3}}})))
    MK._next.update(dexscreener=0.0, geckoterminal=0.0); MK._rest.update(dexscreener=0.0, geckoterminal=0.0)
    c.execute("UPDATE coins SET market_at=NULL, launched_at=?", (NOW - 10,)); c.commit()
    SV.market_pass(c, NOW, get=watch(lambda u: (200, [] if "dexscreener" in u else {"data": []})), exists=lambda m: True)
    FN.one_pass(c, g, F.FEED_DIR, NOW, first_fn=watch(lambda ch, w: {"wallet": w, "funder": A(0x7F), "value": 1.0, "unit": "BNB",
                                                                       "funded_at": NOW - 999 * 86400, "tx": "0x" + "f" * 64, "block": 1}),
                code_fn=watch(lambda ch, w: "0x"))
    return len(open_at) >= 7 and not any(open_at), f"{len(open_at)} network reads, a write open during {sum(open_at)} of them"




def t19():
    c = SV.store()
    SV._BNB_FAILS.clear()
    c.execute("DELETE FROM cursors"); c.execute("INSERT INTO cursors VALUES ('fourmeme', 1000), ('flap', 1000)"); c.commit()
    node = Node(50_000, [four_log(A(0x901), CREATOR, "Late", "LATE", int(NOW) - 5, block=40_100)])
    node.lost_below = 30_000
    stuck = []
    for i in range(B.GAP_TRIES):
        SV.discover(c, NOW + i * 60, {k: NOW + i * 60 for k in S.LISTS}, post=node)
        stuck.append(dict(c.execute("SELECT kind, block FROM cursors"))["fourmeme"])
    gaps = c.execute("SELECT kind, from_block, to_block FROM gaps ORDER BY kind").fetchall()
    for i in range(B.GAP_TRIES + 3):                          # the next stretch is also lost: noted after its own GAP_TRIES
        SV.discover(c, NOW + 1000 + i * 60, {k: NOW for k in S.LISTS}, post=node)
    found = c.execute("SELECT 1 FROM coins WHERE mint=?", (A(0x901),)).fetchone() is not None
    st = SV.status(c)
    ok = (stuck[:-1] == [1000] * (B.GAP_TRIES - 1) and stuck[-1] == 1000 + B.NODES[0][1] * B.MAX_CALLS
          and gaps == [("flap", 1001, 17000), ("fourmeme", 1001, 17000)] and found
          and c.execute("SELECT COUNT(*) FROM gaps").fetchone()[0] == 4 and "BNB gaps (ranges no node served)" in st)
    return ok, f"cursor held for {B.GAP_TRIES - 1} passes, then moved; gaps noted {gaps}; a later coin found: {found}; status says {st.get('BNB gaps (ranges no node served)')}"


def t20():
    c = SV.store()
    SV._BNB_FAILS.clear()
    c.execute("DELETE FROM gaps"); c.execute("DELETE FROM cursors")
    c.execute("INSERT INTO cursors VALUES ('fourmeme', 49000), ('flap', 49000)"); c.commit()
    node = Node(50_000, [four_log(A(0x902), CREATOR, "Back", "BACK", int(NOW) - 5, block=49_500)])
    node.lost_below = 10**9                                   # both nodes refuse every range (an outage)
    for i in range(B.GAP_TRIES * 2):
        SV.discover(c, NOW + i * 60, {k: NOW + i * 60 for k in S.LISTS}, post=node)
    held = dict(c.execute("SELECT kind, block FROM cursors"))
    gaps = c.execute("SELECT COUNT(*) FROM gaps").fetchone()[0]
    node.lost_below = -1                                      # the nodes are back
    SV.discover(c, NOW + 5000, {k: NOW for k in S.LISTS}, post=node)
    found = c.execute("SELECT 1 FROM coins WHERE mint=?", (A(0x902),)).fetchone() is not None
    ok = held == {"fourmeme": 49_000, "flap": 49_000} and gaps == 0 and found
    return ok, f"{B.GAP_TRIES * 2} refused passes on the last hour's blocks: cursors held {held}, gaps {gaps}; when the nodes came back the coin was found: {found}"




def t22():
    c, g = SV.store(), SV.scanner_db()
    old_bsc, old_base, nochain, wrongname = A(0x12A), A(0x12B), A(0x12C), A(0x12D)
    def put(m, body):
        json.dump(body, open(os.path.join(F.FEED_DIR, m + ".json"), "w"))
    put(old_bsc, {"mint": old_bsc, "score": None, "display": "Technical error, retrying", "coverage": 0.2, "label": "x", "chain": "bsc", "launchpad": "Flap.sh"})
    put(old_base, {"mint": old_base, "score": None, "display": "x", "coverage": 0.2, "label": "x", "chain": "base", "launchpad": "Bankr", "launched_at": "2026-09-08T10:00:00+00:00"})
    put(nochain, {"mint": nochain, "score": None, "display": "x", "coverage": 0, "label": "x"})
    put(wrongname, {"mint": A(0x99), "chain": "bsc"})
    SV._OLD.update(at=0.0, dir=None, coins=[])
    asked = []
    def get(url):
        asked.append(url)
        if "dexscreener" in url:
            return 200, [{"baseToken": {"address": old_bsc}, "pairCreatedAt": int(NOW - 12 * 86400) * 1000, "txns": {"h24": {"buys": 0, "sells": 0}}}]
        return 200, {"data": [{"attributes": {"address": old_base}, "relationships": {"top_pools": {"data": [{"id": "p2"}]}}}],
                     "included": [{"id": "p2", "type": "pool", "attributes": {"pool_created_at": "2026-09-08T10:00:00Z", "transactions": {"h24": {"buys": 2, "sells": 0}}}}]}
    MK._next.update(dexscreener=0.0, geckoterminal=0.0); MK._rest.update(dexscreener=0.0, geckoterminal=0.0)
    qf = os.path.join(TMP, "q22.json")
    SV.quiet_pass(c, g, NOW, get=get, feed_file=qf, tape=lambda m: None, feed_dir=F.FEED_DIR)
    st = dict(g.execute("SELECT mint, state FROM quiet"))
    listed_old = {x[0] for x in SV._OLD["coins"]}
    q = json.load(open(qf))
    files_kept = all(os.path.exists(os.path.join(F.FEED_DIR, m + ".json")) for m in (old_bsc, old_base))
    sol = g.execute("SELECT state FROM quiet WHERE mint='SolanaQuietCoin1111111111111111111111111111'").fetchone()
    ok = (st.get(old_bsc) == "quiet" and st.get(old_base) == "active" and old_bsc in q["quiet"] and nochain not in listed_old
          and wrongname not in listed_old and A(0x99) not in listed_old and files_kept and sol == ("quiet",)
          and any(old_bsc in u for u in asked) and any(old_base in u for u in asked))
    return ok, f"old BNB file with no trade for a day -> {st.get(old_bsc)}; old Base file with trades -> {st.get(old_base)}; no-chain and misnamed files left out; files kept: {files_kept}; Solana row as it was: {sol}"


def trade_log(kind, token, ts, block):
    if kind == "flap":
        data = enc_uint(ts) + enc_address(token) + enc_address(A(0xB0B)) + enc_uint(1) + enc_uint(2) + enc_uint(0) + enc_uint(3)
        return {"topics": [B.FLAP_BUY], "data": "0x" + data, "blockNumber": hex(block)}
    data = enc_address(token) + enc_address(A(0xB0B)) + "".join(enc_uint(1) for _ in range(6))
    out = {"topics": [B.FOUR_SELL], "data": "0x" + data, "blockNumber": hex(block)}
    if ts:
        out["blockTimestamp"] = hex(ts)                      # as the public nodes give it
    return out


def t23():
    c, g = SV.store(), SV.scanner_db()
    for t in ("trades", "watch", "gaps"):
        c.execute(f"DELETE FROM {t}")
    c.execute("DELETE FROM cursors"); c.commit()
    SV._TRADE_FAILS.clear(); SV._BNB_FAILS.clear()
    traded, idle, young = A(0x23A), A(0x23B), A(0x23C)
    node = Node(70_000, [trade_log("flap", traded, int(NOW) - 600, 69_990), trade_log("four", A(0x23D), 0, 69_991),
                         trade_log("four", A(0x23E), int(NOW) - 70, 69_992)])
    SV.discover(c, NOW, {k: NOW for k in S.LISTS}, post=node)
    last = dict(c.execute("SELECT mint, last FROM trades"))
    watch = dict(c.execute("SELECT kind, since FROM watch"))
    def put(m, lp, launched):
        json.dump({"mint": m, "score": None, "display": "x", "coverage": 0.1, "label": "x", "chain": "bsc", "launchpad": lp,
                   "launched_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(launched))}, open(os.path.join(F.FEED_DIR, m + ".json"), "w"))
    for m in (traded, idle):
        put(m, "Flap.sh", NOW - 10 * 86400)
    put(young, "four.meme", NOW - 10 * 86400)
    MK._next.update(dexscreener=0.0, geckoterminal=0.0); MK._rest.update(dexscreener=0.0, geckoterminal=0.0)
    get = lambda url: (200, []) if "dexscreener" in url else (200, {"data": []})       # no pair for any: all on their curve
    def run(at):
        SV._OLD.update(at=0.0, dir=None, coins=[])
        g.execute("UPDATE quiet SET checked_at=NULL"); g.commit()
        SV.quiet_pass(c, g, at, get=get, feed_file=os.path.join(TMP, "q23.json"), tape=lambda m: None, feed_dir=F.FEED_DIR)
        return {m: s_ for m, s_ in g.execute("SELECT mint, state FROM quiet WHERE mint IN (?,?,?)", (traded, idle, young))}
    first = run(NOW)                                         # watched for minutes only: a trade seen counts, no trade is unknown
    c.execute("UPDATE watch SET since=? WHERE kind='flap_trades'", (NOW - 25 * 3600,)); c.commit()
    later = run(NOW)                                         # the Flap watch now unbroken for a day; Four.meme's not
    c.execute("UPDATE cursors SET block=1000 WHERE kind='flap_trades'"); c.commit()   # an old stretch no node serves any more
    node.lost_below = 30_000
    for i in range(B.GAP_TRIES):
        SV.discover(c, NOW + 100 + i, {k: NOW for k in S.LISTS}, post=node)
    restarted = c.execute("SELECT since FROM watch WHERE kind='flap_trades'").fetchone()[0]
    after_gap = run(NOW + 200)                               # the unbroken day starts again: the idle coin is unknown, not quiet
    ok = (abs(last.get(traded, 0) - (NOW - 600)) < 1 and last.get(A(0x23D)) == NOW - 50 and last.get(A(0x23E)) == NOW - 70 and set(watch) == {"flap_trades", "fourmeme_trades"}
          and first.get(traded) == "active" and first.get(idle) in (None, "unknown") and first.get(young) in (None, "unknown")
          and later.get(idle) == "quiet" and later.get(young) in (None, "unknown") and later.get(traded) == "active"
          and restarted >= NOW + 100 and after_gap.get(idle) == "quiet")
    return ok, f"trades read {len(last)} (Flap time from its event, Four.meme from the log's block time, else the block); watches {sorted(watch)}; minutes in: {first}; a day of Flap watched: {later}; a gap in the watch restarts it at {restarted - NOW:+.0f}s (a coin already quiet stays quiet: {after_gap.get(idle)})"


def t24():
    c, g = SV.store(), SV.scanner_db()
    m = A(0x24A)
    json.dump({"mint": m, "score": None, "display": "x", "coverage": 0.1, "label": "x", "chain": "bsc", "launchpad": "Flap.sh",
               "launched_at": "2026-09-01T00:00:00Z"}, open(os.path.join(F.FEED_DIR, m + ".json"), "w"))
    c.execute("DELETE FROM watch"); c.execute("DELETE FROM trades")
    c.execute("INSERT INTO trades VALUES (?,?)", (m, NOW - 25 * 3600))          # its last trade read: 25 h ago
    c.execute("INSERT INTO watch (kind, since, read_to) VALUES ('flap_trades', ?, ?)", (NOW - 3 * 86400, NOW - 2 * 3600))   # read only to 2 h ago
    c.commit()
    MK._next.update(dexscreener=0.0, geckoterminal=0.0); MK._rest.update(dexscreener=0.0, geckoterminal=0.0)
    get = lambda url: (200, []) if "dexscreener" in url else (200, {"data": []})
    def run(at):
        SV._OLD.update(at=0.0, dir=None, coins=[])
        g.execute("DELETE FROM quiet WHERE mint=?", (m,)); g.commit()
        r = SV.quiet_pass(c, g, at, get=get, feed_file=os.path.join(TMP, "q24.json"), tape=lambda x: None, feed_dir=F.FEED_DIR)
        return (g.execute("SELECT state FROM quiet WHERE mint=?", (m,)).fetchone() or (None,))[0], r["went_quiet"]
    lagging = run(NOW)                                       # the watch is 2 h behind: nothing judged, even after 25 h without a trade
    c.execute("UPDATE watch SET read_to=? WHERE kind='flap_trades'", (NOW - 60,)); c.commit()
    caught_up = run(NOW)                                     # read to a minute ago: a day read with no trade -> quiet
    c.execute("UPDATE watch SET read_to=? WHERE kind='flap_trades'", (NOW - 25 * 3600 + 600,)); c.execute("UPDATE watch SET since=?", (NOW - 3 * 86400,)); c.commit()
    stale_clock = run(NOW - 25 * 3600 + 700)                 # judged by the read-up-to time, not the clock: its trade is 10 min old there
    ok = lagging[0] in (None, "unknown") and lagging[1] == 0 and caught_up[0] == "quiet" and stale_clock[0] == "active"
    return ok, f"watch 2 h behind -> {lagging[0]} (went quiet {lagging[1]}); read to a minute ago -> {caught_up[0]}; measured at the read-up-to time -> {stale_clock[0]}"


import score as SC










import evidence_evm as EE




def t30():
    urls = []
    def get(url):
        urls.append(url)
        if "dexscreener" in url:
            return 200, [{"baseToken": {"address": A(0x301)}, "priceUsd": "0.1", "liquidity": {"usd": 50}, "txns": {"h24": {"buys": 1, "sells": 1}}}]
        return 200, {"data": [{"attributes": {"address": A(0x302), "price_usd": "0.2"}, "relationships": {"top_pools": {"data": []}}}]}
    MK._next.update(dexscreener=0.0, geckoterminal=0.0); MK._rest.update(dexscreener=0.0, geckoterminal=0.0)
    got = MK.read("base", [A(0x301), A(0x302)], get=get, sleep=lambda s: None)
    gt = [u for u in urls if "geckoterminal" in u]
    ok = got[A(0x301)].get("source") == "DexScreener" and got[A(0x302)].get("source") == "GeckoTerminal" and len(gt) == 1 and A(0x301) not in gt[0]
    return ok, f"a Base coin DexScreener prices -> {got[A(0x301)].get('source')}; one it lists no pair for -> {got[A(0x302)].get('source')}; GeckoTerminal asked about {gt[0].count('0x') if gt else 0} coin"


import mark_old as MO


def t31():
    fd, rd, od = (os.path.join(TMP, x) for x in ("feed31", "results31", "old31"))
    for d in (fd, rd):
        os.makedirs(d, exist_ok=True)
    put = lambda m, body: json.dump(body, open(os.path.join(fd, m + ".json"), "w"))
    old_s, old_l, old_e, mine, seen, sol = A(0x311), A(0x312), A(0x313), A(0x314), A(0x315), "SoLanaCoin1111111111111111111111111111111111"
    put(old_s, {"mint": old_s, "score": 46, "display": "46", "coverage": 0.6, "label": None, "chain": "bsc", "launchpad": "Flap.sh", "name": "Old",
                "ticker": "OLD", "image_url": "https://ipfs.io/ipfs/bafkreiold", "valuation_usd": 5000, "facts": [{"id": "x"}], "as_of": "2026-10-12T14:13:05+00:00"})
    put(old_l, {"mint": old_l, "score": None, "display": "BOT/RUG", "coverage": 0.4, "label": "BOT/RUG", "chain": "base", "launchpad": "Bankr", "as_of": "2026-10-12T10:00:00+00:00"})
    put(old_e, {"mint": old_e, "score": None, "display": "Technical error, retrying", "coverage": 0.2, "label": "Technical error, retrying", "chain": "bsc", "launchpad": "four.meme", "as_of": "2026-10-12T09:00:00+00:00"})
    put(mine, {"mint": mine, "score": 30, "display": "30", "coverage": 0.3, "label": None, "chain": "bsc", "launchpad": "Flap.sh", "as_of": "2026-10-25T05:00:00Z"})
    put(seen, {"mint": seen, "score": None, "display": "not scored yet", "coverage": 0, "label": None, "seen": True, "chain": "bsc", "as_of": "2026-10-12T09:00:00Z"})
    put(sol, {"mint": sol, "score": 50, "display": "50", "coverage": 0.5, "label": None, "chain": "solana", "as_of": "2026-10-12T09:00:00Z"})
    json.dump({"mint": old_s, "score": 46}, open(os.path.join(rd, old_s + ".json"), "w"))
    orphan, orphan_new = A(0x316), A(0x317)                   # result files whose feed file is gone: an old one and a CHAINS one
    json.dump({"mint": orphan, "chain": "bsc", "launchpad": "flap", "score": 25, "receipts": [{"what": "x", "as_of": "2026-10-06T00:19:01+00:00"}]},
              open(os.path.join(rd, orphan + ".json"), "w"))
    json.dump({"mint": orphan_new, "chain": "bsc", "launchpad": "flap", "score": 30, "receipts": [{"what": "x", "as_of": "2026-10-25T05:00:00+00:00"}]},
              open(os.path.join(rd, orphan_new + ".json"), "w"))
    dry = MO.run(fd, [rd], od, apply=False)
    untouched = json.load(open(os.path.join(fd, old_s + ".json")))["score"] == 46 and not os.path.exists(od)
    done = MO.run(fd, [rd], od, apply=True)
    again = MO.run(fd, [rd], od, apply=True)
    a = json.load(open(os.path.join(fd, old_s + ".json")))
    keep_mine = json.load(open(os.path.join(fd, mine + ".json")))["score"] == 30
    keep_sol = json.load(open(os.path.join(fd, sol + ".json")))["score"] == 50
    backed = json.load(open(os.path.join(od, "feed", old_s + ".json")))["score"] == 46 and os.path.exists(os.path.join(od, "results", old_s + ".json"))
    orphans = (dry.get("orphan_results") == 1 and done["results_moved"] == 2 and not os.path.exists(os.path.join(rd, orphan + ".json"))
               and os.path.exists(os.path.join(od, "results", orphan + ".json")) and os.path.exists(os.path.join(rd, orphan_new + ".json")))
    ok = (dry["old"] == 3 and untouched and done["marked"] == 3 and orphans and again["marked"] == 0 and again["old"] == 0 and not again.get("orphan_results")
          and a == {"mint": old_s, "score": None, "display": "not scored yet", "coverage": 0, "label": "Not scored yet", "chain": "bsc", "launchpad": "Flap.sh",
                    "name": "Old", "ticker": "OLD", "image_url": "https://ipfs.io/ipfs/bafkreiold", "as_of": "2026-10-12T14:13:05+00:00"}
          and json.load(open(os.path.join(fd, old_l + ".json")))["label"] == "Not scored yet" and keep_mine and keep_sol and backed
          and not os.path.exists(os.path.join(rd, old_s + ".json")))
    return ok, f"dry run: {dry['old']} old found, nothing written: {untouched}; applied: {done['marked']} marked, {done['results_moved']} results moved (one an old result with no feed file; CHAINS' own kept: {orphans}); twice: {again['marked']}; CHAINS' own score, the seen file and Solana kept; originals backed up: {backed}"








import holders as HD


def tlog(frm, to, v, block, idx=0):
    pad = lambda a: "0x" + "0" * 24 + a[2:]
    return {"topics": [HD.TRANSFER, pad(frm), pad(to)], "data": hex(v), "blockNumber": hex(block), "logIndex": hex(idx)}


def t35():
    Z0, a, b, cc, dead = "0x" + "00" * 20, A(0x351), A(0x352), A(0x353), "0x000000000000000000000000000000000000dead"
    logs = [tlog(Z0, a, 1000, 10), tlog(a, b, 300, 11), tlog(b, cc, 100, 12), tlog(cc, dead, 100, 13), tlog(a, b, 50, 11, 1), tlog(b, Z0, 20, 14)]
    bal = HD.balances(logs)
    got = HD_READ("bsc", A(0x350), 10, 1_800_000_000 - 60, now=1_800_000_000, logs_fn=lambda lo, hi: (logs, True), head_fn=lambda: 20)
    ok = (bal[a] == 650 and bal[b] == 230 and bal.get(cc) == 0 and bal[dead] == 100 and Z0 not in bal
          and got["count"] == 2 and dict(got["holders"]).get(dead) == 100)
    return ok, f"balances {[(k[-3:], v) for k, v in sorted(bal.items())]}; holders counted {got['count']} (the dead address shown as the burn address, never counted; a burn to the zero address leaves the supply)"


def t36():
    now = 1_800_000_000
    full = lambda lo, hi: ([tlog("0x" + "00" * 20, A(0x361), 10, lo)], True)
    young = HD_READ("bsc", A(0x360), 100, now - 600, now=now, logs_fn=full, head_fn=lambda: 200)
    old = HD_READ("bsc", A(0x360), 100, now - 90_000, now=now, logs_fn=full, head_fn=lambda: 200)
    partial = HD_READ("bsc", A(0x360), 100, now - 600, now=now, logs_fn=lambda lo, hi: ([], False), head_fn=lambda: 200)
    long_ = HD_READ("bsc", A(0x360), 100, now - 600, now=now, logs_fn=lambda lo, hi: ([tlog("0x" + "00" * 20, A(0x362), 1, lo)] * (HD.MAX_LOGS + 1), True), head_fn=lambda: 200)
    ok = young and young["count"] == 1 and young["to_block"] == 200 and old is None and partial is None and long_ is None
    return ok, f"a young coin read ({young['count']} holder to block {young['to_block']}); over a day old, a stretch unread, or more than {HD.MAX_LOGS} transfers: no list (never a partial one)"




import virtuals_facts as VF


def t38():
    c, g = SV.store(), SV.scanner_db()
    v_ok, v_other, v_unread = A(0x381), A(0x382), A(0x383)
    for m in (v_ok, v_other, v_unread):
        c.execute("INSERT OR REPLACE INTO coins (mint, chain, launchpad, by, launched_at) VALUES (?,?,?,?,?)", (m, "base", "Virtuals", "virtuals_api", time.time()))
    c.commit()
    owner, taxto = A(0xE220), A(0x617F)
    answers = {"owner()": "0x" + "0" * 24 + owner[2:], "projectTaxRecipient()": "0x" + "0" * 24 + taxto[2:],
               "totalBuyTaxBasisPoints()": "0x" + "%064x" % 100, "totalSellTaxBasisPoints()": "0x" + "%064x" % 100}
    clone = "0x363d3d373d3d3d363d73" + VF.AGENT_TOKEN_V4[2:] + "5af43d82803e903d91602b57fd5bf3"
    def read_fn(m):
        if m == v_unread:
            return VF_READ(m, call=lambda fn: None, code=clone)                 # a read that did not answer
        return VF_READ(m, call=lambda fn: answers[fn], code=clone if m == v_ok else "0x6080")
    n = VF.one_pass(c, g, F.FEED_DIR, read_fn=read_fn)
    rows = {(w, t_): (oc, v) for w, t_, oc, v in g.execute("SELECT what, to_id, onchain, value FROM evidence WHERE coin=?", (v_ok,))}
    done = dict(c.execute("SELECT mint, facts_at FROM coins WHERE mint IN (?,?,?)", (v_ok, v_other, v_unread)))
    own = rows.get(("owned by (contract owner)", owner))
    ok = (n == 3 and own and own[0] == 1 and "add and remove addresses on a blacklist" in json.loads(own[1])["can"]
          and json.loads(rows[("trading tax", "tax")][1]) == {"buy_pct": 1.0, "sell_pct": 1.0} and ("tax paid to", taxto) in rows
          and done[v_ok] and done[v_other] and done[v_unread] is None
          and not g.execute("SELECT 1 FROM evidence WHERE coin=?", (v_other,)).fetchone())
    return ok, f"a verified AgentTokenV4 coin: {n} rows (●): its owner and the powers it holds, the 1%/1% tax, where the tax goes; another implementation: none, for good; an unread one: tried again"


def t39():
    hook = "0x0469a4bd3724dc86c9542f4694c976da13c450c0"
    out = {"mint": A(0x391), "chain": "base", "receipts": [{"what": "liquidity held by the Zora hook", "value": {"positions": 33, "locked_share_of_pool_value": 1.0},
                                                            "source": f"getPoolCoin on {hook} (moves only to a hook on Zora's upgrade gate)"}]}
    rows = EE.rows(out, {"launchpad": "Zora"})
    r = next((x for x in rows if x["what"] == "liquidity held by Zora's hook"), None)
    v = json.loads(r["value"]) if r else {}
    ok = (r is not None and r["onchain"] == 1 and r["to_id"] == hook and r["link"] == "https://basescan.org/address/" + hook
          and v.get("locked_share") == 1.0 and "approved list" in v.get("owners_can", "") and "no one can withdraw" in v.get("owners_can", ""))
    return ok, f"the Zora coin's trail: '{r['what'] if r else None}' (●) with what the owners can do: {v.get('owners_can')}"


import sqd_evm as SQ


class FakeResp:
    def __init__(self, text): self.text = text
    def read(self): return self.text.encode()
    def __enter__(self): return self
    def __exit__(self, *a): return False


def t40():
    pages = {100: [{"header": {"number": 120, "timestamp": 1_790_000_000}, "logs": [{"address": "0xABC", "topics": ["0xt"], "data": "0x01", "transactionHash": "0xh1", "logIndex": 3}]},
                   {"header": {"number": 150, "timestamp": 1_790_000_010}, "logs": []}],
             151: [{"header": {"number": 200, "timestamp": 1_790_000_050}, "logs": [{"address": "0xabc", "topics": ["0xt"], "data": "0x02", "transactionHash": "0xh2", "logIndex": 0}]}]}
    asked = []
    def urlopen(req, timeout=60):
        body = json.loads(req.data.decode()); asked.append(body["fromBlock"])
        return FakeResp("\n".join(json.dumps(b) for b in pages[body["fromBlock"]]))
    got = SQ.logs("bsc", "0xABC", "0xt", 100, 200, urlopen=urlopen, sleep=lambda s: None)
    def refused(req, timeout=60):
        raise urllib.error.HTTPError(req.full_url, 403, "no", {}, None)
    none_403 = SQ.logs("bsc", "0xabc", "0xt", 100, 200, urlopen=refused, sleep=lambda s: None)
    short = SQ.logs("bsc", "0xabc", "0xt", 100, 300, urlopen=lambda req, timeout=60: FakeResp("") if json.loads(req.data.decode())["fromBlock"] == 201
                    else FakeResp("\n".join(json.dumps(b) for b in pages.get(json.loads(req.data.decode())["fromBlock"], []))), sleep=lambda s: None)
    ok = (asked == [100, 151] and [l["transactionHash"] for l in got] == ["0xh1", "0xh2"] and got[0]["blockNumber"] == hex(120)
          and got[0]["blockTimestamp"] == hex(1_790_000_000) and got[0]["logIndex"] == hex(3) and got[0]["address"] == "0xabc"
          and none_403 is None and short is None)
    return ok, f"two answers paged ({asked}), logs in eth_getLogs' shape with block and time; refused -> {none_403}; an empty answer before the range's end -> {short} (never partial)"


def t41():
    import urllib.error as _ue
    calls = []
    keep_first, keep_logs = B.SQD_FIRST, SQ.logs
    SQ.logs = lambda chain, a, t, lo, hi, **k: (calls.append("sqd"), [{"topics": [B.FLAP_CREATE], "blockNumber": hex(lo)}])[1]
    keep_post = B._post
    try:
        got_sqd = B.logs(B.FLAP_PORTAL, B.FLAP_CREATE, 10, 20)
        SQ.logs = lambda *a, **k: (calls.append("sqd"), None)[1]
        B._post = lambda url, m, p, timeout=20: (calls.append("node"), [])[1]
        # the default post is read at call time: a test post is a stand-in node and skips SQD
        got_fall = B.logs(B.FLAP_PORTAL, B.FLAP_CREATE, 10, 20, post=B._post)
    finally:
        SQ.logs, B._post, B.SQD_FIRST = keep_logs, keep_post, keep_first
    ok = got_sqd and got_sqd[0]["blockNumber"] == hex(10) and calls[0] == "sqd" and "node" in calls
    return ok, f"SQD first ({calls[0]}); a stand-in node asked directly when given ({calls[-1]})"


def t42():
    c, g = SV.store(), SV.scanner_db()
    z1, z2, z3 = A(0x421), A(0x422), A(0x423)
    for m in (z1, z2, z3):
        c.execute("INSERT OR REPLACE INTO coins (mint, chain, launchpad, by, launched_at) VALUES (?,?,?,?,?)", (m, "base", "Zora", "zora_explore", time.time()))
    c.commit()
    rec = {"zora20Token": {"creatorAddress": A(0xC42), "creatorProfile": {"handle": "basedchadbal", "socialAccounts": {
        "instagram": {"username": "basedchadbal", "followerCount": 4235}, "twitter": {"username": "Redpandamobster", "followerCount": 414},
        "farcaster": None, "tiktok": None}}}}
    def read_fn(m):
        if m == z3:
            return ZS_READ(m, get=lambda u: (_ for _ in ()).throw(OSError("down")))            # unread
        return ZS_READ(m, get=lambda u: rec if m == z1 else {"zora20Token": None})
    n = ZS.one_pass(c, g, F.FEED_DIR, read_fn=read_fn)
    rows = {(w, t_): (oc, v) for w, t_, oc, v in g.execute("SELECT what, to_id, onchain, value FROM evidence WHERE coin=?", (z1,))}
    done = dict(c.execute("SELECT mint, social_at FROM coins WHERE mint IN (?,?,?)", (z1, z2, z3)))
    x = rows.get(("creator's linked account", "https://x.com/Redpandamobster"))
    ok = (n == 3 and rows.get(("creator's Zora profile", "basedchadbal"), (None,))[0] == 0 and x and json.loads(x[1]) == {"username": "Redpandamobster", "followers": 414}
          and not any("farcaster" in k[1] for k in rows) and done[z1] and done[z2] and done[z3] is None)
    return ok, f"{n} ○ rows from Zora's record: the creator's profile and the linked X and Instagram (with followers as Zora reports them); empty accounts get no row; an unread record is tried again"


def t43():
    rec = {"zora20Token": {"creatorProfile": {"handle": "bad handle/x", "socialAccounts": {
        "twitter": {"username": "good_name"}, "instagram": {"username": "a/b"}, "farcaster": {"username": "ok-name.eth"}, "tiktok": {"username": "has space"}}}}}
    f = ZS_READ(A(0x431), get=lambda u: rec)
    ok = f["handle"] is None and set(f["accounts"]) == {"twitter", "farcaster"} and f["accounts"]["farcaster"]["username"] == "ok-name.eth"
    return ok, f"kept {sorted(f['accounts'])}; a handle or username with a slash or space gets no row (never altered)"










def t48():
    import evidence_evm as EE
    out = {"mint": A(0x480), "chain": "base", "receipts": [
        {"what": "dev team (named by Zora records)", "value": {"payout recipient at creation": [A(0x481)], "owner": [A(0x482)]}, "source": "Zora's coin record"}]}
    r = EE.rows(out)
    ok = sorted(x["what"] for x in r) == ["dev team: owner", "dev team: payout recipient at creation"] and all(x["link"].startswith("https://basescan.org/address/") for x in r)
    return ok, f"Zora's named team in the Creator group: {sorted(x['what'] for x in r)}"


def t49():
    asked = []
    def rpc_fn(chain, method, params):
        asked.append(params[0]["category"])
        if chain == "base" and "internal" in params[0]["category"]:
            return None                                       # refused
        return {"transfers": [{"from": A(0x491).upper().replace("X", "x"), "to": A(0x490), "value": 0.0123, "asset": "ETH", "hash": "0x" + "e" * 64,
                               "blockNum": "0x1f", "metadata": {"blockTimestamp": "2026-10-25T19:00:00.000Z"}}]}
    f = FL_FIRST("base", A(0x490), rpc_fn=rpc_fn)
    none = FL_FIRST("bsc", A(0x490), rpc_fn=lambda *a: {"transfers": []})
    unread = FL_FIRST("bsc", A(0x490), rpc_fn=lambda *a: None)
    ok = (f == {"wallet": A(0x490), "funder": A(0x491), "value": 0.0123, "unit": "ETH", "funded_at": 1792954800, "tx": "0x" + "e" * 64, "block": 31}
          and asked == [["external", "internal"], ["external"]] and none == {"wallet": A(0x490), "funder": None} and unread is None)
    return ok, f"Alchemy's transfer record read as {f and (f['unit'], f['value'], f['block'])}; Base asked again with direct transfers only when refused; none -> no funder; unread -> None"


def t50():
    import run_evm as R
    keep = (R.RESULTS, R._feed)
    fed = []
    R.RESULTS, R._feed = os.path.join(TMP, "r50"), (lambda out: fed.append(out["mint"]))
    os.makedirs(R.RESULTS, exist_ok=True)
    try:
        bad = {"mint": A(0x500), "chain": "base", "launchpad": "zora", "score": None, "display": "Technical error, retrying", "label": None, "coverage": 0.55}
        err = {"mint": A(0x501), "chain": "bsc", "launchpad": "flap", "error": "no dev wallet identified"}
        good = dict(bad, mint=A(0x502), score=56, display="56")
        label = dict(bad, mint=A(0x503), label="VAMP", display="VAMP")
        for o in (bad, err, good, label):
            R._write_result(o["mint"], o)
        files = sorted(os.listdir(R.RESULTS))
    finally:
        R.RESULTS, R._feed = keep
    ok = fed == [A(0x502), A(0x503)] and files == [A(0x502) + ".json", A(0x503) + ".json"]
    return ok, f"a technical error and a reader error write no result and no feed file; a score and a proven label do ({len(fed)} fed)"


def t51():
    T0 = NOW - 86400
    asked = []
    def fake(chain, w):
        asked.append(w)
        return {"wallet": w, "funder": A(0x512), "value": 0.5, "unit": "BNB", "funded_at": T0 - 60, "tx": "0x" + "1" * 64, "block": 5}
    proxy = "0x363d3d373d3d3d363d73" + "ab" * 20 + "5af43d82803e903d91602b57fd5bf3"     # a launch service's contract code
    code = {A(0x510): proxy, A(0x511): "0xef0100" + "cd" * 20, A(0x512): proxy, A(0x513): "0x"}
    code_fn = lambda ch, w: code.get(w)
    svc_hops, svc_done = FN.trace("bsc", A(0x510), T0, fake, code_fn)            # creator is a launch service: not traced
    del_hops, del_done = FN.trace("base", A(0x511), T0, fake, code_fn)            # a 7702-delegated wallet is a person's
    unread_hops, unread_done = FN.trace("bsc", A(0x514), T0, fake, code_fn)       # code not read: tried again later
    ok = (svc_hops == [] and svc_done and A(0x510) not in asked
          and [h["wallet"] for h in del_hops] == [A(0x511)] and del_done            # its funder A(0x512) is a contract: shown, not followed
          and A(0x512) not in asked and unread_hops == [] and not unread_done
          and FN.is_person("bsc", A(0x513), code_fn) is True and FN.is_person("bsc", A(0x510), code_fn) is False)
    return ok, (f"a contract creator (a launch service) gets no funding row and is never asked; a 7702-delegated wallet is traced; "
                f"a contract funder is shown ({len(del_hops)} row) but not followed; unread code: tried again later")


def t52():
    rec = {lp: FD.seen_record({"mint": A(0x520 + i), "chain": "bsc", "launchpad": lp, "by": by, "launched_at": NOW - 60}, NOW)["launchpad"]
           for i, (lp, by) in enumerate((("Flap", "flap_chain"), ("Four.meme", "fourmeme_chain")))}
    base = FD.seen_record({"mint": A(0x522), "chain": "base", "launchpad": "Zora", "by": "zora_explore", "launched_at": NOW - 60}, NOW)["launchpad"]
    c = SV.store()
    c.execute("UPDATE coins SET market_at=?", (NOW,))
    c.execute("INSERT OR REPLACE INTO coins (mint, chain, launchpad, by, launched_at) VALUES (?,?,?,?,?)", (A(0x523), "bsc", "Flap", "flap_chain", NOW - 60))
    c.execute("INSERT OR REPLACE INTO coins (mint, chain, launchpad, by, launched_at) VALUES (?,?,?,?,?)", (A(0x524), "base", "Zora", "zora_explore", NOW - 60))
    c.commit()
    got = []
    MK._next.update(dexscreener=0.0, geckoterminal=0.0); MK._rest.update(dexscreener=0.0, geckoterminal=0.0)
    pair = lambda ch, m: {"chainId": ch, "baseToken": {"address": m}, "priceUsd": "0.0001", "liquidity": {"usd": 900}, "volume": {"h24": 10},
                          "txns": {"h24": {"buys": 1, "sells": 1}}, "pairCreatedAt": int(NOW * 1000)}
    ans = lambda u: (200, [pair("bsc", A(0x523))] if "dexscreener" in u and "/bsc/" in u else [pair("base", A(0x524))] if "dexscreener" in u else {"data": []})
    SV.market_pass(c, NOW, get=ans, update=lambda m, **f: got.append((m, f.get("launchpad"), f.get("price_usd"))),
                   exists=lambda m: m in (A(0x523), A(0x524)))
    by = {m: (lp, px) for m, lp, px in got}
    ok = (rec == {"Flap": "Flap.sh", "Four.meme": "four.meme"} and base == "Zora" and by.get(A(0x523)) == ("Flap.sh", 0.0001)
          and by.get(A(0x524)) == (None, 0.0001))                    # a Base coin's prices are written too, its words untouched
    return ok, f"seen files say {rec} and {base}, as scored files do; with its prices an earlier BNB seen file gets the feed's words {by.get(A(0x523))}, a Base coin its prices alone {by.get(A(0x524))}"


def t53():
    c = SV.store()
    found = c.execute("SELECT COUNT(*) FROM coins WHERE named_at IS NULL AND first_seen IS NOT NULL").fetchone()[0]   # discovered coins are named on arrival
    c.execute("UPDATE coins SET named_at=1")
    for i, lp in enumerate(("Flap", "Four.meme", "Zora")):
        c.execute("INSERT OR REPLACE INTO coins (mint, chain, launchpad, by, launched_at) VALUES (?,?,?,?,?)",
                  (A(0x530 + i), "base" if lp == "Zora" else "bsc", lp, "x", NOW - 3 * 86400))     # older than the market pass follows
    c.commit()
    got = []
    def upd(m, **f):
        got.append((m, f.get("launchpad")))
        return m != A(0x531)                                  # the Four.meme coin has been scored meanwhile: not a seen file
    first = SV.rename_pass(c, NOW, update=upd)
    second = SV.rename_pass(c, NOW + 1, update=upd)
    fresh = SV.store().execute("SELECT COUNT(*) FROM coins WHERE named_at IS NULL AND launchpad IN ('Flap', 'Four.meme') AND first_seen IS NOT NULL").fetchone()[0]
    ok = first == 1 and second == 0 and sorted(got) == [(A(0x530), "Flap.sh"), (A(0x531), "four.meme")] and fresh == 0 and found == 0
    return ok, f"curve coins with no prices get the feed's words once ({sorted(x[1] for x in got)}), a scored file is left as it is, Zora untouched, nothing twice"


def t54():
    page = [{"header": {"number": 120, "timestamp": 1_790_000_000},
             "transactions": [{"transactionIndex": 4, "from": A(0x541).upper().replace("X", "x")}, {"transactionIndex": 9, "from": A(0x542)}],
             "logs": [{"address": "0xabc", "topics": ["0xt"], "data": "0x01", "transactionHash": "0xh1", "logIndex": 3, "transactionIndex": 4},
                      {"address": "0xabc", "topics": ["0xt"], "data": "0x02", "transactionHash": "0xh2", "logIndex": 7, "transactionIndex": 9}]}]
    asked = []
    def urlopen(req, timeout=60):
        asked.append(json.loads(req.data.decode()))
        return FakeResp(json.dumps(page[0]))
    got = SQ.logs("bsc", "0xabc", "0xt", 100, 120, urlopen=urlopen, sleep=lambda s: None, senders=True)
    q = asked[0]
    plain = SQ.logs("bsc", "0xabc", "0xt", 100, 120, urlopen=urlopen, sleep=lambda s: None)
    # the trades pass hands each trade on with its sender (a router's own address is the event's wallet)
    lg = trade_log("flap", A(0x543), int(NOW) - 60, 500)
    lg.update(txFrom=A(0x544), transactionHash="0xtx54")
    keep = B.logs
    B.logs = lambda address, t0, lo, hi, post=None, sleep=None, senders=False: [lg] if senders and "flap" not in str(address).lower() and address == B.FLAP_PORTAL else []
    sink = []
    try:
        B.trades_pass({"fourmeme_trades": 400, "flap_trades": 400}, post=lambda url, m, p, timeout=20: "0x" + format(600, "x") if m == "eth_blockNumber" else
                      {"timestamp": hex(int(NOW))}, sleep=lambda s: None, sink=sink)
    finally:
        B.logs = keep
    ok = ([l.get("txFrom") for l in got] == [A(0x541), A(0x542)] and q["logs"][0].get("transaction") is True and q["fields"]["transaction"]["from"] is True
          and "txFrom" not in plain[0] and sink and sink[0][:4] == (A(0x543), A(0x544), A(0xB0B), "buy") and sink[0][5] == "0xtx54")
    return ok, f"SQD gives each trade's sender ({len(got)} logs); the trades pass hands on the sender, not the event's router wallet: {sink[:1] and sink[0][:4]}"










def t59():
    import evidence_evm as EE
    coin, locker, pid, h = A(0x590), A(0x591), "0x" + "ab" * 32, "0x" + "cd" * 32
    made = {"what": "Clanker creation (factory TokenCreated)", "value": {"creator": A(0x592), "locker": locker, "msg_sender": A(0x592)},
            "unit": "facts", "source": f"factory TokenCreated, tx {h}", "as_of": "x"}
    pool = {"what": "Uniswap v4 pool", "value": {"pool_id": pid}, "unit": "facts", "source": "StateView", "as_of": "x"}
    lock = {"what": "liquidity held by the Clanker locker", "value": {"locked_share_of_pool_value": 1.0}, "unit": "share", "source": "PositionManager " + A(0x7C5F), "as_of": "x"}
    full = EE.rows({"mint": coin, "chain": "base", "receipts": [made, pool, lock]})
    bare = EE.rows({"mint": coin, "chain": "base", "receipts": [pool, lock]})
    get = lambda rs, w: [r["link"] for r in rs if r["what"] == w]
    none = [r["what"] for r in full + bare if r["onchain"] == 1 and not r["link"]]
    ok = (get(full, "trades in pool (Uniswap v4)") == [f"https://basescan.org/tx/{h}"] and get(full, "liquidity locked") == [f"https://basescan.org/address/{locker}"]
          and get(bare, "trades in pool (Uniswap v4)") == [f"https://app.uniswap.org/explore/pools/base/{pid}"]
          and get(bare, "liquidity locked") == [f"https://basescan.org/address/{A(0x7C5F)}"] and none == [])
    return ok, (f"with the creation record: pool {get(full, 'trades in pool (Uniswap v4)')}, lock {get(full, 'liquidity locked')}; "
                f"without it: pool {get(bare, 'trades in pool (Uniswap v4)')}, lock {get(bare, 'liquidity locked')} (the position's contract); ● rows with no link {none}")


def t60():
    import evidence as EV
    c, g = SV.store(), SV.scanner_db()
    svc, person, funder = A(0x60A), A(0x60B), A(0x60C)               # a Flap launch service (a contract), the person who sent the launch
    listed, newer, old = A(0x600), A(0x601), A(0x602)
    code = lambda ch, w: "0x6080" if w == svc else "0x"
    first = lambda ch, w: {"wallet": w, "funder": funder, "value": 0.5, "unit": "BNB", "funded_at": NOW - 600, "tx": "0x" + "f1" * 32, "block": 7} if w == person else {"wallet": w, "funder": None}
    asked = []
    sender = lambda block, tx: (asked.append((block, tx)), (person, "SQD Portal"))[1]
    for m, at, done in ((listed, NOW - 7200, NOW - 3600), (newer, NOW - 60, None), (old, NOW - 9000, NOW - 3600)):
        c.execute("INSERT OR REPLACE INTO coins (mint, chain, launchpad, by, creator, launched_at, launch_tx, block, written, funding_at, funding_ver, bot_at) "
                  "VALUES (?,?,?,?,?,?,?,?,1,?,NULL,NULL)", (m, "bsc", "Flap", "flap_chain", svc, at, "0x" + m[-4:] * 16, 77, done))
    c.commit()
    n = FN.one_pass(c, g, F.FEED_DIR, NOW, limit=1, first_fn=first, code_fn=code, shown_fn=lambda: {listed}, sender_fn=sender)
    ev = g.execute("SELECT what, from_id, to_id, link FROM evidence WHERE coin=? AND what IN ('launched by', 'funded') ORDER BY what", (listed,)).fetchall()
    kept = c.execute("SELECT launch_sender, funding_ver FROM coins WHERE mint=?", (listed,)).fetchone()
    other = c.execute("SELECT funding_ver FROM coins WHERE mint=?", (old,)).fetchone()[0]
    hops, done = FN.trace("bsc", svc, NOW, first, code)                  # without a sender: as before, not traced
    # the team's F1 on 65842868: SQD and the node both unreadable (529): not read, a try counted, read again later, never done
    down = A(0x603)
    c.execute("INSERT OR REPLACE INTO coins (mint, chain, launchpad, by, creator, launched_at, launch_tx, block, written, funding_at, funding_ver, bot_at) "
              "VALUES (?,?,?,?,?,?,?,?,1,NULL,NULL,NULL)", (down, "bsc", "Flap", "flap_chain", svc, NOW - 100, "0x" + "d0" * 32, 88)); c.commit()
    FN.one_pass(c, g, F.FEED_DIR, NOW, limit=1, first_fn=first, code_fn=code, shown_fn=lambda: {down}, sender_fn=lambda b_, t_: None)
    after_down = c.execute("SELECT funding_at, funding_tries, launch_sender FROM coins WHERE mint=?", (down,)).fetchone()
    FN.one_pass(c, g, F.FEED_DIR, NOW + 2 * FN.RETRY_S, limit=1, first_fn=first, code_fn=code, shown_fn=lambda: {down},
                sender_fn=lambda b_, t_: (person, "a public BNB node"))
    back = g.execute("SELECT source FROM evidence WHERE coin=? AND what='launched by'", (down,)).fetchone()
    done_back = c.execute("SELECT funding_at FROM coins WHERE mint=?", (down,)).fetchone()[0]
    ok = (n == 2 and asked == [(77, "0x" + listed[-4:] * 16)] and kept == (person, FN.FUNDING_VER) and other is None
          and ev == [("funded", funder, person, "https://bscscan.com/tx/0x" + "f1" * 32),
                     ("launched by", listed, person, "https://bscscan.com/tx/0x" + listed[-4:] * 16)]
          and hops == [] and done is True
          and after_down[0] is None and after_down[1] == 1 and after_down[2] is None
          and back and "a public BNB node" in back[0] and done_back is not None)
    return ok, (f"the listed coin first (one a pass): sender read from its launch block {asked}; rows {[(w, f[:8], t[:8]) for w, f, t, _l in ev]}; "
                f"kept {kept and (kept[0][:8], kept[1])}; an unlisted coin read before is left for later ({other}); a service creator with no sender: {len(hops)} hops; SQD and the node down: {after_down} (not done), back an hour later: {back and back[0][:60]}")


def t61():
    import evidence_evm as EE
    coin = A(0x610)
    gp = lambda v: {"mint": coin, "chain": "bsc", "receipts": [{"what": "GoPlus token security (lead)", "value": v, "unit": "flags", "source": "GoPlus API", "as_of": "x"}]}
    none = [r for r in EE.rows(gp({"is_honeypot": "0", "buy_tax": ""})) if r["to_id"] == "GoPlus"]
    some = [r for r in EE.rows(gp({"is_honeypot": "0", "buy_tax": "0.09"})) if r["to_id"] == "GoPlus"]
    words = json.dumps(none + some).lower()
    ok = (len(none) == 1 and none[0]["value"] == "0" and none[0]["unit"] == "notes GoPlus returned" and none[0]["onchain"] == 0
          and some[0]["value"] == json.dumps({"buy_tax": "0.09"}) and some[0]["unit"] == "notes GoPlus returned" and "flag" not in words)
    return ok, f"GoPlus returned nothing: {none[0]['value']} {none[0]['unit']}; one note: {some[0]['value']} {some[0]['unit']}; the word flag anywhere: {'flag' in words}"


def t62():
    import ticks_evm as TE
    c = SV.store()
    flap, four, usdt, other, early = A(0x620), A(0x621), A(0x622), A(0x623), A(0x624)
    for m, lp, blk in ((flap, "Flap", 900), (four, "Four.meme", 900), (usdt, "Four.meme", 900), (other, "Flap", 900), (early, "Flap", 500)):
        c.execute("INSERT OR REPLACE INTO coins (mint, chain, launchpad, by, creator, launched_at, block, written, quote) VALUES (?,?,?,?,?,?,?,1,NULL)",
                  (m, "bsc", lp, "flap_chain", A(0x62F), NOW - 600, blk))
    c.execute("DROP TABLE IF EXISTS ticks_back"); c.commit()
    SV._TICKS.pop("quotes", None)
    on = {flap, four, usdt, early}
    tdir = os.path.join(F.FEED_DIR, "ticks")
    for m in on | {other}:
        if os.path.exists(os.path.join(tdir, m + ".json")):
            os.remove(os.path.join(tdir, m + ".json"))
    SV._TICKS.clear(); SV._TICKS["bnb"] = (600.0, "Chainlink BNB/USD on the chain", NOW)
    E18 = 10 ** 18
    live = [("flap_trades", flap, "buy", NOW - 30, "0x" + "a1" * 32, 3, 1000 * E18, E18 // 10, E18 // 10000),   # 0.1 BNB moved; Flap says 0.0001 BNB a token
            ("fourmeme_trades", four, "sell", NOW - 20, "0x" + "a2" * 32, 1, 500 * E18, E18 // 20, E18 // 10000),
            ("fourmeme_trades", usdt, "buy", NOW - 10, "0x" + "a3" * 32, 0, 500 * E18, 5 * E18, E18 // 100),   # quoted in USDT: no dollars guessed
            ("flap_trades", other, "buy", NOW - 5, "0x" + "a4" * 32, 0, 10 * E18, E18, E18 // 10)]   # not listed
    history = {"from": None}
    def fake_logs(address, t0, lo, hi, post=None, sleep=None, senders=False):
        history["from"] = history["from"] or lo
        if address != B.FLAP_PORTAL:
            return []
        data = "0x" + "".join(w[2:] if w.startswith("0x") else w for w in (enc_uint(int(NOW - 3000)), enc_address(early), enc_address(A(0x625)),
                                                                           enc_uint(2000 * E18), enc_uint(E18 // 5), enc_uint(0), enc_uint(E18 // 10000)))
        return [{"topics": [B.FLAP_BUY], "data": data, "blockNumber": hex(510), "transactionHash": "0x" + "b1" * 32, "logIndex": "0x2"}]
    keep = B.logs; B.logs = fake_logs
    try:
        n = SV.ticks_pass(c, live, NOW, {"fourmeme_trades": 1000, "flap_trades": 1000}, exists=lambda m: True, shown_fn=lambda: on,
                          quote_fn=lambda m, kind: "0x55d398326f99059ff775485246999027b3197955" if m == usdt else "BNB",
                          quote_price_fn=lambda q: (0.998, "USDT's PancakeSwap pool vs WBNB, anchored to Chainlink BNB/USD", "USDT"))
        n2 = SV.ticks_pass(c, [], NOW + 30, {"fourmeme_trades": 1000, "flap_trades": 1000}, exists=lambda m: True, shown_fn=lambda: on, quote_fn=lambda m, kind: None,
                           quote_price_fn=lambda q: None)
    finally:
        B.logs = keep
    rd = lambda m: json.load(open(os.path.join(tdir, m + ".json"))) if os.path.exists(os.path.join(tdir, m + ".json")) else None
    f, fo, e = rd(flap), rd(four), rd(early)
    # the team's F1 on 59102803: the site's list unreadable for a pass: the last good list, never an empty one
    import pinrbot as PB
    keep_ss = PB._site_shown
    try:
        FN._LAST_LIST["coins"] = None
        PB._site_shown = lambda: {"0xAbC"}; first = FN._site_list()
        PB._site_shown = lambda: set(); after_fail = FN._site_list()
        FN._LAST_LIST["coins"] = None; never = FN._site_list()
    finally:
        PB._site_shown = keep_ss; FN._LAST_LIST["coins"] = None
    late = A(0x626)
    c.execute("INSERT OR REPLACE INTO coins (mint, chain, launchpad, by, creator, launched_at, block, written, quote) VALUES (?,?,?,?,?,?,?,1,'BNB')",
              (late, "bsc", "Flap", "flap_chain", A(0x62F), NOW - 60, 990)); c.commit()
    n3 = SV.ticks_pass(c, [("flap_trades", late, "buy", NOW - 5, "0x" + "a9" * 32, 0, 10 * E18, E18, E18 // 10)], NOW + 60,
                       {"fourmeme_trades": 1000, "flap_trades": 1000}, exists=lambda m: True, shown_fn=lambda: None)
    unread_ok = first == {"0xabc"} and after_fail == {"0xabc"} and never is None and n3 == 1 and rd(late) is not None
    x = (f or {}).get("ticks", [{}])[0]
    done = dict(c.execute("SELECT kind, block FROM ticks_back").fetchall())
    clean = c.execute("SELECT COUNT(*) FROM cursors WHERE kind LIKE 'ticks%'").fetchone()[0] == 0
    ok = (f and f["contract"] == "ticks-1" and f["source"] == "BNB chain" and f["mint"] == flap
          and x["side"] == "buy" and x["sig"] == "0x" + "a1" * 32 and x["i"] == 3 and abs(x["usd"] - 60.0) < 1e-9 and abs(x["price_usd"] - 0.06) < 1e-12 and "own price" in x["price_usd_src"]
          and "Chainlink BNB/USD" in x["price_usd_src"] and x["t"] == int((NOW - 30) * 1000)
          and fo and fo["ticks"][0]["side"] == "sell" and abs(fo["ticks"][0]["usd"] - 30.0) < 1e-9
          and rd(usdt) and rd(usdt)["quote"] == "USDT" and abs(rd(usdt)["ticks"][0]["usd"] - 5 * 0.998) < 1e-9
          and "in USDT" in rd(usdt)["ticks"][0]["price_usd_src"] and "bnb" not in rd(usdt)["ticks"][0] and rd(other) is None
          and e and e["ticks"][0]["sig"] == "0x" + "b1" * 32 and abs(e["ticks"][0]["usd"] - 120.0) < 1e-9 and history["from"] == 500
          and c.execute("SELECT quote FROM coins WHERE mint=?", (four,)).fetchone()[0] == "BNB" and c.execute("SELECT quote FROM coins WHERE mint=?", (usdt,)).fetchone()[0].startswith("0x55d3") and n == 4 and unread_ok and done.get("ticks_back_done") == 1000 and done.get("ticks_ver") == SV.TICKS_VER and clean)
    return ok, (f"Flap trade: {x.get('usd')} USD at {x.get('price_usd')} ({x.get('price_usd_src')}); Four.meme BNB-quoted: {bool(fo)}; USDT-quoted: {rd(usdt) and rd(usdt)['ticks'][0]['usd']} USD; "
                f"unlisted: {rd(other)}; a coin listed before its file: history from block {history['from']}, {e and len(e['ticks'])} trade; ticks {n}, then {n2}; sweep {done}; list unreadable: last good list kept {unread_ok}")


def t63():
    import ticks_base as TB
    c, g = SV.store(), SV.scanner_db()
    weth_coin, zora_coin, quiet_coin = "0x1" + "1" * 39, "0x2" + "2" * 39, "0x3" + "3" * 39
    pid = {weth_coin: "0x" + "a1" * 32, zora_coin: "0x" + "b2" * 32, quiet_coin: "0x" + "c3" * 32}
    import evidence as EV
    EV.ensure(g)
    for m, p in pid.items():
        g.execute("INSERT OR REPLACE INTO evidence (coin, from_kind, from_id, to_kind, to_id, what, onchain, receipt) VALUES (?,?,?,?,?,?,1,?)",
                  (m, "token", m, "pool", p, "trades in pool (Uniswap v4)", "Uniswap v4 pool"))
    g.commit()
    c.execute("DROP TABLE IF EXISTS base_pools"); c.commit()
    TB._STATE.clear()
    word = lambda v, bits=256: format(v % (1 << 256), "064x")
    creator = "0x" + "77" * 20
    def init_log(m, other):
        c0, c1 = sorted([m, other], key=lambda a: int(a, 16))
        return {"topics": [TB.INIT, pid[m], "0x" + "0" * 24 + c0[2:], "0x" + "0" * 24 + c1[2:]], "data": "0x", "blockNumber": hex(100)}
    sqrt = int((2 ** 96) * (0.0004 ** 0.5))                    # currency1 per currency0 = 0.0004 (the coin sorts before WETH)
    def swap(m, tok, weth, n, b):
        data = "0x" + word(tok) + word(weth) + word(sqrt) + word(1) + word(0) + word(3000)
        return {"topics": [TB.SWAP, pid[m]], "data": data, "blockNumber": hex(b), "blockTimestamp": hex(int(NOW) - 60 + b),
                "transactionHash": "0x" + format(n, "064x"), "logIndex": hex(n)}
    asked = []
    def logs(lo, hi, t0, t1):
        asked.append((lo, hi, t0[0][:10], sorted(t1)))
        if t0 == [TB.INIT]:
            return [init_log(next(m for m, p in pid.items() if p == t1[0]), TB.WETH if t1[0] != pid[zora_coin] else creator)]
        return [l for l in (swap(weth_coin, 1000 * 10 ** 18, -(4 * 10 ** 17), 1, 120), swap(weth_coin, -(500 * 10 ** 18), 2 * 10 ** 17, 2, 130),
                            swap(zora_coin, 10 ** 18, -(10 ** 15), 3, 125)) if lo <= int(l["blockNumber"], 16) <= hi]
    listed = [(weth_coin, 100), (zora_coin, 100), (quiet_coin, 100)]
    keep_cap = TB.NEW_POOLS; TB.NEW_POOLS = 1                  # at most this many new pools' Initialize reads a pass
    n0 = TB.one_pass(c, g, NOW - 120, F.FEED_DIR, listed, logs_fn=logs, head_fn=lambda: 150, eth_fn=lambda: (None, "Chainlink unread"))
    capped = c.execute("SELECT COUNT(*) FROM base_pools").fetchone()[0]
    TB.NEW_POOLS = keep_cap
    TB.one_pass(c, g, NOW - 90, F.FEED_DIR, listed, logs_fn=logs, head_fn=lambda: 150, eth_fn=lambda: (None, "Chainlink unread"))
    held = dict(c.execute("SELECT mint, read_to FROM base_pools").fetchall()).get(weth_coin)   # no ETH price: read again, nothing lost
    TB._STATE.pop("eth", None)
    n = TB.one_pass(c, g, NOW, F.FEED_DIR, listed, logs_fn=logs, head_fn=lambda: 150, eth_fn=lambda: (2500.0, "Chainlink ETH/USD on Base"))
    n2 = TB.one_pass(c, g, NOW + 30, F.FEED_DIR, listed, logs_fn=logs, head_fn=lambda: 160, eth_fn=lambda: (2500.0, "Chainlink ETH/USD on Base"))
    rd = lambda m: json.load(open(os.path.join(F.FEED_DIR, "ticks", m + ".json"))) if os.path.exists(os.path.join(F.FEED_DIR, "ticks", m + ".json")) else None
    f = rd(weth_coin) or {}
    t = f.get("ticks") or [{}, {}]
    # the team's case of 26 Oct (0x5989cfa0…): a $0.0018 swap in a near-empty pool, the pool's price after it at the edge of
    # its range: the tick takes the trade's own amounts, never that price
    edge = "0x" + word(5 * 10 ** 20) + word(-(int(7.8e14))) + word(2 ** 160 - 1) + word(1) + word(0) + word(3000)
    thin = TB.tick(True, edge, NOW, "0x" + "e" * 64, 0, 2500.0, "Chainlink ETH/USD on Base")
    rows = dict((m, (q, r)) for m, q, r in c.execute("SELECT mint, paired, read_to FROM base_pools"))
    swap_reads = [a for a in asked if a[2] == TB.SWAP[:10]]
    ok = (thin and abs(thin["price_quote"] - 7.8e14 / 5e20) < 1e-24 and abs(thin["price_usd"] - 7.8e14 / 5e20 * 2500) < 1e-12 and capped == 1 and n0 == 0 and held is None and n == 2 and n2 == 0 and f.get("source") == "Base chain" and f.get("quote") == "WETH" and len(t) == 2
          and t[0]["side"] == "buy" and abs(t[0]["usd"] - 1000.0) < 1e-6 and abs(t[0]["price_usd"] - 0.0004 * 2500) < 1e-6
          and t[1]["side"] == "sell" and "trade's own WETH" in t[0]["price_usd_src"] and "Chainlink ETH/USD" in t[0]["price_usd_src"]
          and rd(zora_coin) is None and rd(quiet_coin) is None and rows[zora_coin][0] == creator and rows[weth_coin] == (TB.WETH, 160)
          and sorted(swap_reads[-1][3]) == sorted([pid[weth_coin], pid[quiet_coin]]) and swap_reads[-1][0] == 151)
    return ok, (f"WETH-paired coin: {[(x.get('side'), x.get('usd'), x.get('price_usd')) for x in t]}; paired with a creator coin: {rd(zora_coin)} "
                f"(paired {rows.get(zora_coin, ('?',))[0][:8]}); no trades: {rd(quiet_coin)}; swaps asked for pools {len(swap_reads[-1][3])} (new pools read at most {TB.NEW_POOLS} a pass: {capped} with the cap at 1), "
                f"the second pass from block {swap_reads[-1][0]}; a thin-pool swap at the range's edge priced {thin and thin['price_usd']} USD a token; with no ETH price first: {n0} ticks, read position kept at {held}; ticks {n}, then {n2}")



case(1, "Clanker's own list", "Base coins only, with creator, links, price and launch time as Clanker gives them", t1)
case(2, "Zora's and Virtuals' own lists, GeckoTerminal's Virtuals venues", "Base only; a picture only when the media is a picture; a blocked coin left out; Virtuals' bonding token before graduation; GeckoTerminal gives no creator", t2)
case(3, "Four.meme and Flap factory events decoded", "creator, coin, name, ticker, launch time (block time when Four.meme says 'at once'), Flap's metadata id; another event refused", t3)
case(4, "BNB pass: cursors", "a first start reads back from the tip, each later pass from its cursor; nodes refusing keep the cursor (read again)", t4)
case(5, "BNB pass: long gaps and a refusing node", "at most MAX_CALLS calls a pass; the next free node serves a range the first refuses", t5)
case(6, "The seen file", "the design's fields with the coin's chain and seen_by; never replaces a file; over a day old or unknown age not written; chain solana refused", t6)
case(7, "Discovery into the store and the feed", "every list once, a coin once; a launchpad's own record wins over GeckoTerminal's; a second pass writes nothing", t7)
case(9, "Flap documents", "picture and links into the seen file; an unanswered document is tried again after an hour, not before", t9)
case(10, "A picture after the gate", "the coin is taken into the gate again with its picture", t10)
case(11, "Market answers", "DexScreener matched whatever the address case, best pair by liquidity, each pair's 24-hour trades; GeckoTerminal's tokens with top pools", t11)
case(12, "Market pacing", "30 coins a call; after a refusal the rest of the pass is skipped; DexScreener first on both chains, GeckoTerminal only for Base coins DexScreener lists no pair for", t12)
case(13, "Prices into the seen files", "seen files get price and liquidity; a scored file is never changed; a coin read in the last five minutes is not asked again", t13)
case(14, "The quiet rule (247) for Base and BNB", "the scanner's own quiet pass: no trade for a day -> quiet; a trade -> active; Solana rows untouched", t14)
case(15, "Switches", "PINR_CHAINS_OFF turns a launchpad off (its list is not asked)", t15)
case(16, "Store counts", "coins per chain and launchpad", t16)
case(17, "No write open across a network read", "every document, count, market and funding read happens with no open write on the store or the scanner's database", t17)
case(19, "A BNB range no node serves", "read again each pass; after GAP_TRIES passes noted as a gap (store and status) and passed over, so later coins are still found", t19)
case(20, "Recent blocks are never passed over", "an outage of both nodes on the last hour's blocks is waited out: no gap, and the coins are found when the nodes return", t20)
case(22, "Every Base/BNB file in the feed goes through the quiet rule", "an old file with no trade for a day goes quiet and is kept; one with trades stays; files with no chain or a mismatched name are left out; Solana rows untouched", t22)
case(23, "BNB curve coins go quiet from the launchpads' own trade events (no DexScreener pair)", "a trade event in the last day keeps a coin active; no trade is unknown until the launchpad's events were watched a whole day unbroken, then quiet", t23)
case(24, "A lagging trade watch judges nothing", "while the watch has not read to within minutes of now, no curve coin is judged; a coin's last trade is compared with the time the watch has read up to, never the clock", t24)
case(30, "Base prices from DexScreener first", "GeckoTerminal is asked only about the Base coins DexScreener lists no pair for", t30)
case(31, "Old Base/BNB scores marked unscored", "a dry run writes nothing; applied, each old score, label or error becomes 'not scored yet' with the coin's own identity, the original copied and its result moved, nothing deleted; CHAINS' own scores, seen files and Solana untouched; twice changes nothing", t31)
case(35, "Holders from Transfer logs: the balances (254)", "a mint from the zero address, transfers in block and log order; a burn to the zero address leaves the supply; tokens at 0x…dead shown as the burn address; neither is counted as a holder", t35)
case(36, "Holders are bounded", "only a coin under a day old, read in full; a stretch unread or too many transfers gives no list, never a partial one", t36)
case(38, "Virtuals coins listed with what is verifiable", "the owner's powers from AgentTokenV4's verified source, the tax and its recipient, all ● read on chain; no pool row (the curve stays not checked yet)", t38)
case(39, "Zora's liquidity, scored as locked, shown with what the owners can do", "a ● row: the share the hook holds, and that the owners can move it only into another pool on Zora's approved list, never withdraw it", t39)
case(40, "SQD Portal for Base/BNB logs", "a range read in several answers, in eth_getLogs' own shape with block number and time; a refusal or an answer ending early gives None, never a partial range", t40)
case(41, "The BNB reader asks SQD first", "the launchpads' events from SQD when it answers; the public nodes otherwise", t41)
case(42, "A Zora coin's creator and linked accounts", "○ rows from Zora's own record: the creator's Zora profile and each linked account with its followers; an empty one gets no row; an unread record is tried again", t42)
case(43, "Usernames only in each site's own characters", "a name with characters the site does not allow gets no row, never a broken or altered link", t43)
case(48, "Zora's named team in the evidence (checklist 6: creator)", "every launchpad's 'dev team (named by …)' record gives its 'dev team: <role>' rows, not only Clanker's", t48)
case(49, "The funding read from Alchemy's transfer history (checklist 6)", "the oldest incoming ETH/BNB, its sender, amount, time, block and transaction; Base asks for contract-sent transfers too, and direct ones only when refused; an empty history gives no funder; an unread one None", t49)
case(50, "Error text is never a coin's public note", "run_evm's own writer (used outside the CHAINS service) writes a result and feed file only for a score or a proven label; a technical or reader error leaves what the coin showed", t50)
case(51, "Only a person's wallet is traced for funding", "a creator that is a contract (a launch service) gets no funding row, so a stranger who paid the service never shows as its funder; a 7702-delegated wallet is a person's; a contract funder is shown, not followed; a wallet whose code was not read is tried again", t51)
case(52, "One launchpad, one name on the site (2026-10-26: \"Flap\" beside \"Flap.sh\")", "a seen BNB coin's file names its launchpad in the feed's own words, as its scored file will; an earlier seen file is put right when its prices are next written", t52)
case(53, "Every seen BNB coin gets the feed's launchpad words once (chains17 finished: 895 \"Flap\" coins on their curve had no prices)", "with or without prices, at any age, once a coin; a scored file is left; Base coins untouched", t53)
case(54, "Each BNB trade's sender", "SQD Portal gives the wallet that sent each trade's transaction in the same answer; the trades pass hands it on, never the router the launchpad's event names", t54)
case(59, "A Base pool and its lock link to their receipts", "the Uniswap v4 pool links the creation transaction that made it, else Uniswap's own page for the pool; the lock links the Clanker locker named in the creation record, else the contract its receipt names; no ● row without a link", t59)
case(60, "A launch service's coin: the person who sent the launch, and their funding", "the site's listed coins are read first; a coin whose creator is a contract gets the launch transaction's sender (SQD, from its own block) as a ● launched-by row and that wallet's funding; a coin read before this is read again once; without a sender a service is still not traced; when the sender cannot be read (SQD 529 and the node) the coin stays unread, a try counted, and is read later through the node, its source named", t60)
case(61, "GoPlus's answer in observed words", "no notes: a count of 0 notes GoPlus returned; notes: what GoPlus returned; never the word flagged; reported (o), never on chain", t61)
case(62, "A listed BNB coin's own trades as its tick file", "SITE's ticks-1 shape with source BNB chain: time, side, transaction, log index, the trade's dollars and price at Chainlink's BNB/USD, named on each; a coin quoted in another coin is priced at that coin's own pool price, named (none when the pool names none: never guessed); an unlisted coin none; a coin listed before its file gets its history from its launch block, once", t62)
case(63, "A listed Base coin's own trades as its tick file (line 11, Base)", "the pool's two coins from its own Initialize event (read once, kept); Swap events read only for the listed WETH-paired pools, from their creation block, then onward; price the pool's own after each trade, size the WETH moved, in dollars at Chainlink ETH/USD, named; a coin paired with another coin, and a coin with no trade, get no file; with no ETH price the read position holds, nothing lost", t63)


def c64():
    """Base, a pool paired with USDC (4 of 87 Base pools on 26 Oct): priced at Chainlink's USDC/USD feed on Base, its 6
    decimals counted; a pool paired with anything else still left out."""
    import ticks_base as TB
    word = lambda v, bits=256: format(v % (1 << 256), "064x")
    usdc = TB.USDC
    coin = "0x" + "11" * 20                                   # below USDC's address: the coin is currency0
    buy = "0x" + word(2 * 10 ** 21) + word(-(5 * 10 ** 6)) + word(2 ** 96) + word(1) + word(0) + word(3000)   # 2,000 tokens for 5 USDC
    x = TB.tick(int(coin, 16) < int(usdc, 16), buy, NOW, "0x" + "f" * 64, 0, 0.9997, "Chainlink USDC / USD", *TB.QUOTES[usdc])
    w = TB.tick(True, buy, NOW, "0x" + "f" * 64, 0, 2500.0, "Chainlink ETH/USD on Base")    # the same amounts read as WETH (18 decimals)
    ok = (x and x["side"] == "buy" and abs(x["quote_amount"] - 5.0) < 1e-12 and abs(x["price_quote"] - 0.0025) < 1e-15
          and abs(x["price_usd"] - 0.0025 * 0.9997) < 1e-15 and "USDC over its tokens" in x["price_usd_src"]
          and w and abs(w["quote_amount"] - 5e-12) < 1e-24 and set(TB.QUOTES) == {TB.WETH, usdc})
    return ok, f"USDC pool: {x and (x['side'], x['quote_amount'], x['price_quote'], round(x['price_usd'], 8))}, source {x and x['price_usd_src']!r}; priced pairs: WETH and USDC only"
case(64, "A Base pool paired with USDC is priced at Chainlink's USDC/USD (its 6 decimals)", "2,000 tokens for 5 USDC: a buy at 0.0025 USDC a token, in dollars at the feed's price, named; the WETH reading of the same amounts differs by 10^12 (decimals counted); only WETH and USDC pairs are priced", c64)


print(f"\n{sum(results)}/{len(results)} passing")
