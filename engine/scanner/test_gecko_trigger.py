"""Stonk.fun coins read from GeckoTerminal for the trigger: plain-English tests with made-up
pools, the real pool shape GeckoTerminal gave on 2026-10-17, a made-up chain, a temporary database and settings file. Every
network call is blocked and counted; no live file is touched. Run:  python3 test_gecko_trigger.py"""
import json, os, socket, tempfile, time, urllib.request

CALLS = []
def _blocked(*a, **k):
    CALLS.append(a[:1])
    raise OSError("network blocked in this test")
urllib.request.urlopen = _blocked
socket.create_connection = _blocked

import scanner as S
import geckoterminal as G
import stonkfun
import sys
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "stage2"))
from b58 import b58e

TMP = tempfile.mkdtemp()
S.DB = os.path.join(TMP, "scanner.sqlite")
S.SETTINGS = os.path.join(TMP, "settings.json")
S._SITE.update(at=time.time() + 10 ** 6, mints=[]); S._SHOWN.update(at=time.time() + 10 ** 6, mints=[])
NOW = float(int(time.time()) - 7200)
A, B, C, PUMP = (b58e(bytes([i]) * 32) for i in (31, 32, 33, 34))
PA, PB, PC = (b58e(bytes([i]) * 32) for i in (41, 42, 43))
HERE = os.path.dirname(os.path.abspath(__file__))
REAL = json.load(open(os.path.join(HERE, "..", "tools", "profiles", "2026-10-17-geckoterminal-new-pools.json")))["answer"]

results = []
def case(n, title, should, fn):
    try:
        ok, text = fn()
    except Exception as e:
        ok, text = False, f"CRASH {type(e).__name__}: {e}"
    results.append(ok)
    print(f"\n{n:>2}. {title}\n    should: {should}\n    did:    {text}\n    {'PASS' if ok else 'FAIL'}")

def settings(**kw):
    d = {"score_chains": ["solana"], "solana_workers": 4, "solana_rescores": "paused", "solana_trigger": "on",
         "solana_trigger_volume_usd": 10000, "solana_trigger_min_buys": 10, "stonkfun_launches": "on"}
    d.update(kw)
    json.dump(d, open(S.SETTINGS, "w"))

def fresh():
    for ext in ("", "-wal", "-shm"):
        if os.path.exists(S.DB + ext):
            os.remove(S.DB + ext)
    S._RUNNING.clear(); S._SITE_RUNNING.clear()
    S._SCORING.update(chains=None, note=None, saved=None); S._SLOTS.update(n=None, note=None)
    S._RESCORES.update(mode=None, note=None); S._TRIG.update(on=None, line=None, buys=None, note=None); S._TRIG.pop("stonk", None)
    S._STONK.update(at=0.0, seen={}, note=None); S._VERIFIED.clear()
    G._next[0] = 0.0; G._rest_until[0] = 0.0
    return S.db()

def pool_item(address, mint, volume_h1, buys_h1, created="2026-10-17T18:45:55Z", dex="stonkfun"):
    """A pool in GeckoTerminal's own shape (its dollar figures are text, its counts integers)."""
    return {"id": f"solana_{address}", "type": "pool",
            "attributes": {"address": address, "name": "x / SOL", "pool_created_at": created,
                           "transactions": {"h1": {"buys": buys_h1, "sells": 0, "buyers": 1, "sellers": 0}},
                           "volume_usd": {"h1": str(volume_h1) if volume_h1 is not None else None, "h24": "1"}},
            "relationships": {"base_token": {"data": {"id": f"solana_{mint}", "type": "token"}},
                              "quote_token": {"data": {"id": "solana_So11111111111111111111111111111111111111112", "type": "token"}},
                              "dex": {"data": {"id": dex, "type": "dex"}}}}

class Get:
    def __init__(self, answers):
        self.answers, self.urls = answers, []
    def __call__(self, url):
        self.urls.append(url)
        a = self.answers.pop(0) if self.answers else (0, None)
        return a

def clock():
    return 1000.0

def row(c, token):
    return c.execute("SELECT triggered_at, next_due, queued_at, dropped_at, launchpad, queue_volume_h1 FROM tokens WHERE chain='solana' AND token=?", (token,)).fetchone()


def t1():
    get = Get([(200, {"data": [pool_item(PA, A, "12345.5", 40), pool_item(PB, B, None, None), pool_item(PC, C, "1", 1)]})])
    got = G.figures([PA, PB], get=get, clock=clock, sleep=lambda s: None)
    return (got[PA] == {"dex": "stonkfun", "mint": A, "created": 1792262755.0, "volume_h1": 12345.5, "buys_h1": 40}
            and got[PB]["volume_h1"] is None and got[PB]["buys_h1"] is None and PC not in got and get.urls == [G.URL + PA + "," + PB]), \
        f"{PA[:6]}: {got.get(PA)}; {PB[:6]} without figures: volume {got[PB]['volume_h1']}, buys {got[PB]['buys_h1']}; an unasked pool in the answer kept out: {PC not in got}; one request naming both pools"
case(1, "The reader takes a pool's 1-hour volume (text) and buys (count), its coin and its exchange from GeckoTerminal's shape", "one request for two pools; dollars as a number, buys as an integer, the base coin and the dex id; a pool without the figures has None; a pool nobody asked about is left out", t1)

def t2():
    for it in REAL["data"][:3]:
        pass
    real = {"data": REAL["data"][:5]}
    addrs = [it["attributes"]["address"] for it in real["data"]]
    got = G.figures(addrs, get=Get([(200, real)]), clock=clock, sleep=lambda s: None)
    ok = len(got) == 5 and all(got[a]["volume_h1"] is not None and got[a]["buys_h1"] is not None and got[a]["mint"] and got[a]["created"] and got[a]["dex"] for a in addrs)
    return ok, f"{len(got)} of 5 real pools parsed, each with volume h1, buys h1, coin, created and dex; example {addrs[0][:6]}: {got[addrs[0]]}"
case(2, "The real pool shape GeckoTerminal gave on 2026-10-17 parses whole", "five real pools, every one with its figures, coin, creation time and exchange", t2)

def t3():
    G._next[0] = 0.0; G._rest_until[0] = 0.0
    get = Get([(429, None), (200, {"data": [pool_item(PB, B, "1", 1)]})])
    got = G.figures([PA], get=get, clock=clock, sleep=lambda s: None)
    again = G.figures([PB], get=get, clock=clock, sleep=lambda s: None)
    later = G.figures([PB], get=get, clock=lambda: 1000.0 + G.REST + 1, sleep=lambda s: None)
    return got == {} and again == {} and len(get.urls) == 2 and PB in later, f"after 429: {got}, the next read within the minute asked nothing ({len(get.urls)} requests so far); after the rest the read goes on: {PB in later}"
case(3, "Too many requests: the reader rests a minute, nothing is guessed", "a 429 gives an empty answer, no request for a minute, then reads again", t3)

def t4():
    G._next[0] = 0.0; G._rest_until[0] = 0.0
    pools = [b58e(bytes([i]) * 32) for i in range(60, 91)]              # 31 pools: two requests
    get = Get([(200, {"data": [pool_item(p, A, "1", 1) for p in pools[:30]]}), (0, None)])
    waits = []
    got = G.figures(pools, get=get, clock=clock, sleep=lambda s: waits.append(s))
    return len(get.urls) == 2 and get.urls[0].count(",") == 29 and len(got) == 30 and pools[30] not in got and waits == [G.GAP], \
        f"{len(get.urls)} requests (30 then 1), {G.GAP} s between them; the second got no answer: its pool absent ({pools[30] not in got}); a bad answer: {G.figures([PA], get=Get([(200, {'data': 'nope'})]), clock=clock, sleep=lambda s: None)}"
case(4, "Thirty pools a request, a gap between requests, a batch with no answer stays unknown", "31 pools make two requests GAP seconds apart; the unanswered pool is absent, never zero; a wrong shape gives nothing", t4)

def gecko(answers):
    class Gk:
        def __init__(self): self.asked = []
        def __call__(self, pools):
            self.asked.append(list(pools)); return {p: answers[p] for p in pools if p in answers}
    return Gk()

def fig(mint, volume, buys, age_min=5):
    return {"dex": "stonkfun", "mint": mint, "created": NOW - age_min * 60, "volume_h1": volume, "buys_h1": buys}

def t5():
    c = fresh(); settings()
    g = gecko({PA: fig(A, 20000, 50), PB: fig(B, 20000, 50)})
    seen = []
    def verify(m, p):
        seen.append(m); return {A: True, B: None}[m]
    said = S.watch_pumpfun(c, now=NOW, lists=lambda: [(PUMP, NOW - 600)], read=lambda ms: {}, stonk_list=lambda: [(A, NOW - 300, PA), (B, NOW - 300, PB), (C, NOW - 300, None)], gecko=g, verify=verify)
    a, b, cc = row(c, A), row(c, B), row(c, C)
    return (a and a[4] == "launchlab" and a[5] == 20000 and b is None and cc is None and sorted(seen) == sorted([A, B]) and g.asked == [[PA, PB]]
            and "1 queued of 4 looked at" in said and "2 read from GeckoTerminal" in said and "1 with no pool address" in said and "1 at the line but not verified" in said), \
        f"A verified: queued as {a and a[4]} with volume {a and a[5]}; B unreadable on chain: queued {b is not None}; C with no pool: asked of GeckoTerminal {PC in (g.asked[0] if g.asked else [])}, queued {cc is not None}; words: {said!r}"
case(5, "At the line, a Stonk.fun coin is queued only once its pool is verified on chain as Stonk.fun's; no pool address means unknown", "A (verified) queued with its queue-time volume; B (not readable) not queued, counted in the words; C (no pool from Stonk.fun) never asked about; the words say each", t5)

def t6():
    c = fresh(); settings()
    g = gecko({PA: fig(A, 20000, 50)})
    calls = []
    said1 = S.watch_pumpfun(c, now=NOW, lists=lambda: [(PUMP, NOW - 600)], read=lambda ms: {}, stonk_list=lambda: [(A, NOW - 300, PA)], gecko=g, verify=lambda m, p: calls.append(m) or False)
    said2 = S.watch_pumpfun(c, now=NOW + 60, lists=lambda: [(PUMP, NOW - 600)], read=lambda ms: {}, stonk_list=lambda: [(A, NOW - 300, PA)], gecko=g, verify=lambda m, p: calls.append(m) or False)
    return row(c, A) is None and calls == [A, A] and all("0 queued" in s and "1 at the line but not verified" in s for s in (said1, said2)), \
        f"two passes, the pool another platform's both times: queued {row(c, A) is not None}, asked on chain each pass {calls == [A, A]}; words {said1!r}"
case(6, "A pool verified as some other platform's is never queued as a Stonk.fun coin", "the hit is counted as not verified on each pass and the coin is not queued", t6)

def t7():
    c = fresh(); settings()
    g = gecko({PA: dict(fig(B, 20000, 50))})                               # GeckoTerminal says pool PA belongs to coin B, not A
    said = S.watch_pumpfun(c, now=NOW, lists=lambda: [(PUMP, NOW - 600)], read=lambda ms: {}, stonk_list=lambda: [(A, NOW - 300, PA)], gecko=g, verify=lambda m, p: True)
    return row(c, A) is None and "0 queued of 2 looked at" in said, f"queued: {row(c, A) is not None}; words: {said!r}"
case(7, "A pool whose coin, as GeckoTerminal names it, is not the coin Stonk.fun listed stays unknown", "nothing queued: the figures are not known to be this coin's", t7)

def t8():
    c = fresh(); settings()
    g = gecko({PA: fig(A, 9999, 50), PB: fig(B, 20000, 9)})
    said = S.watch_pumpfun(c, now=NOW, lists=lambda: [(PUMP, NOW - 600)], read=lambda ms: {}, stonk_list=lambda: [(A, NOW - 300, PA), (B, NOW - 300, PB)], gecko=g, verify=lambda m, p: True)
    return row(c, A) is None and row(c, B) is None and "0 queued of 3" in said, f"volume under the line: queued {row(c, A) is not None}; buys under the floor: queued {row(c, B) is not None}; words: {said!r}"
case(8, "Section 15's two figures, unchanged, in the same read", "a coin under the volume line, or under the buy floor, is not queued whatever Stonk.fun's own figures say", t8)

def t9():
    c = fresh(); settings()
    g = gecko({})                                                           # GeckoTerminal does not answer
    stonk = lambda: [(A, NOW - 300, PA)]
    s1 = S.watch_pumpfun(c, now=NOW, lists=lambda: [(PUMP, NOW - 600)], read=lambda ms: {}, stonk_list=stonk, gecko=g, verify=lambda m, p: True)
    s2 = S.watch_pumpfun(c, now=NOW + 60, lists=lambda: [(PUMP, NOW - 600)], read=lambda ms: {}, stonk_list=stonk, gecko=g, verify=lambda m, p: True)
    return row(c, A) is None and g.asked == [[PA], [PA]] and "0 queued of 2" in s1 and "0 queued of 2" in s2, f"asked each pass: {g.asked}; queued {row(c, A) is not None}"
case(9, "A coin GeckoTerminal does not answer for stays unknown and is looked at again next pass", "no row, and the pool is asked about on both passes", t9)

def t10():
    fresh()
    answers = [[(A, NOW - 300, PA), (B, 0.0, None)], None, [(B, 0.0, PB)], []]
    stonkfun.recent = lambda: answers.pop(0)
    real_time = time.time
    try:
        S.time.time = lambda: NOW
        first = S._stonkfun_mints()
        S.time.time = lambda: NOW + S.SITE_LIST_SECONDS + 1
        second = S._stonkfun_mints(); note = S._STONK["note"]
        S.time.time = lambda: NOW + 2 * S.SITE_LIST_SECONDS + 2
        third = S._stonkfun_mints()
        S.time.time = lambda: NOW + S.TRIGGER_FIRST_SECONDS + 3 * S.SITE_LIST_SECONDS + 10
        fourth = S._stonkfun_mints()
    finally:
        S.time.time = real_time
    ok = (sorted(first) == sorted([(A, NOW - 300, PA), (B, NOW, None)]) and sorted(second) == sorted(first) and note and "could not be read this pass" in note
          and sorted(third) == sorted([(A, NOW - 300, PA), (B, NOW, PB)]) and S._STONK["note"] is None and fourth == [] and S._STONK["note"] is None)
    return ok, f"pass 1: {len(first)} launches (B dated when first seen, no pool yet); pass 2 (list unreadable): the same {len(second)} still looked at, note {note!r}; pass 3: B's pool filled in later {third and any(m == B and p == PB for m, _t, p in third)}; after the hour: {fourth}"
case(10, "The launches are remembered through their first hour: a read that fails keeps them, a later read fills in a pool, the hour ends them", "pass 1 two launches; pass 2 unreadable: the two still there with a note; pass 3 B's pool added; after an hour both gone with no note", t10)

def t11():
    fresh()
    stonkfun.recent = lambda: None
    real_time = time.time
    try:
        S.time.time = lambda: NOW
        got = S._stonkfun_mints()
    finally:
        S.time.time = real_time
    return got is None, f"nothing remembered and the list unreadable: {got}"
case(11, "Nothing remembered and the list unreadable: None, as before (whole or nothing)", "the trigger's words then say the list could not be read whole", t11)

def t12():
    """The verification through the real readers, only the chain made up: a read refused once then fine; the platform account
    refused once then fine; another platform; not a LaunchLab pool; a pool of another coin. Only a definite answer is remembered."""
    fresh()
    import readers as R
    from b58 import b58d
    R._PLATFORM_CHECKED.clear()
    stonk_pc = next(k for k, v in R.LAUNCHLAB_PLATFORMS.items() if v[0] == "stonk")
    bonk_pc = next(k for k, v in R.LAUNCHLAB_PLATFORMS.items() if v[0] == "bonk")
    def raw_pool(mint, pc):
        r = bytearray(400); r[205:237] = b58d(mint); r[173:205] = b58d(pc); return bytes(r)
    def raw_platform(name):
        r = bytearray(944); r[112:112 + len(name)] = name.encode(); return bytes(r)
    chain = {PA: (raw_pool(A, stonk_pc), R.LAUNCHLAB, 5), PB: (raw_pool(B, bonk_pc), R.LAUNCHLAB, 5), PC: (raw_pool(C, stonk_pc), "SomeOtherProgram111111111111111111111111111", 5),
             stonk_pc: (raw_platform("StonkFun"), R.LAUNCHLAB, 5), bonk_pc: (raw_platform("letsbonk.fun"), R.LAUNCHLAB, 5)}
    refuse, reads = set(), []
    def account_raw(addr):
        reads.append(addr)
        if addr in refuse:
            refuse.discard(addr); return (None, None, None)       # refused this once
        return chain.get(addr, (None, None, None))
    old_raw = R.account_raw; R.account_raw = account_raw
    try:
        refuse.add(PA);        a1 = S._stonk_pool_verified(A, PA)                      # the pool read refused once
        refuse.add(stonk_pc);  a2 = S._stonk_pool_verified(A, PA)                      # then the platform account refused once
        a3 = S._stonk_pool_verified(A, PA); n = len(reads); a4 = S._stonk_pool_verified(A, PA); same = len(reads) == n
        b = S._stonk_pool_verified(B, PB)                                               # bonk.fun's platform
        cc = S._stonk_pool_verified(C, PC)                                              # not the LaunchLab program's account
        d = S._stonk_pool_verified(B, PA)                                               # Stonk.fun's pool, but of coin A, asked for B
        S._VERIFIED.pop(B, None); d = S._stonk_pool_verified(B, PA)
    finally:
        R.account_raw = old_raw; R._PLATFORM_CHECKED.clear()
    ok = a1 is None and a2 is None and a3 is True and a4 is True and same and b is False and cc is False and d is False and A in S._VERIFIED and B in S._VERIFIED
    return ok, f"pool refused once: {a1}; platform account refused once: {a2}; then: {a3}, remembered {same}; bonk.fun's platform: {b}; not a LaunchLab account: {cc}; another coin's pool: {d}; coins remembered (definite answers only): {len(S._VERIFIED)} of 3 asked"
case(12, "The on-chain check through the real readers (V1): a refused read is None and asked again, never a remembered False", "pool refused once: None; platform account refused once: None; then True and remembered; another platform, a non-LaunchLab account, another coin's pool: False", t12)


print(f"\nnetwork calls attempted: {len(CALLS)}")
print(f"{sum(results)}/{len(results)} passed")
sys.exit(0 if all(results) and not CALLS else 1)
