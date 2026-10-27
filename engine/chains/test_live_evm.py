"""chains/live_evm.py: the live reader replayed on real SQD
Portal blocks recorded from the chain (fixtures/live_evm_blocks.json: 6 BNB blocks with Four.meme and Flap trades from
129919701, 4 Base blocks with Swaps in three listed WETH pools), against the chains pass's own decoders. A temporary folder;
no network. Run:  python3 test_live_evm.py"""
import io, json, os, sqlite3, sys, tempfile, urllib.error
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path[:0] = [HERE, os.path.join(HERE, "..", "scanner"), os.path.join(HERE, "..", "stage2"), os.path.join(HERE, "..", "stage4")]
import live_evm as L
import bnb as B
import sqd_evm as S
import ticks_base as TB
import ticks_evm as TE

results = []
def case(n, title, should, fn):
    try:
        ok, text = fn()
    except Exception as e:
        import traceback; traceback.print_exc()
        ok, text = False, f"CRASH {type(e).__name__}: {e}"
    results.append(ok)
    print(f"\n{n:>2}. {title}\n    should: {should}\n    did:    {text}\n    {'PASS' if ok else 'FAIL'}")

FIX = json.load(open(os.path.join(HERE, "fixtures", "live_evm_blocks.json")))
BNB_USD, ETH_USD = 600.0, 3000.0


class Pusher:
    def __init__(self):
        self.got, self.sent, self.failed = [], 0, 0

    def add(self, batch):
        if batch:
            self.got.append(batch); self.sent += sum(map(len, batch.values()))


class Clock:
    def __init__(self, t):
        self.t = t

    def __call__(self):
        return self.t

    def sleep(self, s):
        self.slept.append(s); self.t += s


def answer(blocks):
    return io.BytesIO(b"".join(json.dumps(b).encode() + b"\n" for b in blocks))


def bnb_logs():
    return [l for b in FIX["bsc"]["blocks"] for l in S.block_logs(b)]


def store(d, bsc=(), pools=()):
    """A chains.sqlite stand-in: the coins table's BNB coins and their quote coins, Base's pools."""
    p = os.path.join(d, "chains.sqlite")
    c = sqlite3.connect(p)
    c.execute("CREATE TABLE coins (mint TEXT PRIMARY KEY, chain TEXT, quote TEXT)")
    TB.ensure(c)
    c.executemany("INSERT INTO coins VALUES (?, 'bsc', ?)", bsc)
    c.executemany("INSERT INTO base_pools VALUES (?,?,?,0,NULL)", pools)
    c.commit(); c.close()
    return p


def coins_of(d, chain, bsc=(), pools=(), site=None, clock=None):
    db = store(d, bsc, pools)
    listed = site if site is not None else {m for m, _q in bsc} | {m for m, _p, _w in pools}
    co = L.Coins(chain, db, site_fn=lambda: listed, native_fn=lambda: ((BNB_USD if chain == "bsc" else ETH_USD), "Chainlink stand-in"),
                 quote_fn=lambda q: None, clock=clock or (lambda: 2e9))
    co.refresh()
    return co


def bnb_coins_in_fixture():
    raw = []
    for kind in B.TRADES:
        B.decode_trades(kind, bnb_logs(), B._post, {}, {}, None, raw)
    return raw


def replay(chain, d, co, blocks, clock, pusher=None, urlopen=None, nxt=None, rounds=1, head=None):
    files = TE.TickFiles(os.path.join(d, "ticks"), source=TB.SOURCE if chain == "base" else TE.SOURCE)
    sp = os.path.join(d, f"live_{chain}.json")
    json.dump({"next": nxt or blocks[0]["header"]["number"]}, open(sp, "w"))
    asked, n = [], [0]
    def opener(req, timeout=30):
        asked.append(json.loads(req.data)); n[0] += 1
        return answer(blocks if n[0] == 1 else [])
    clock.slept = []
    L.run(chain, say=lambda s: asked.append(s), urlopen=urlopen or opener, stop=lambda: n[0] >= rounds or (urlopen and len(clock.slept) > 8),
          pusher=pusher or Pusher(), coins=co, files=files, clock=clock, sleep=clock.sleep, head_fn=lambda: head,
          switch=lambda: True, state=sp)
    files.flush(clock())
    return files, asked, json.load(open(sp)) if os.path.exists(sp) else None


def c1():
    """BNB: every Four.meme and Flap trade in the replayed blocks, the same ticks the chains pass writes for them."""
    d = tempfile.mkdtemp()
    raw = bnb_coins_in_fixture()
    mints = sorted({r[1] for r in raw})
    co = coins_of(d, "bsc", [(m, "BNB") for m in mints])
    blocks = FIX["bsc"]["blocks"]
    clock = Clock(blocks[-1]["header"]["timestamp"] + 1.0)
    files, asked, st = replay("bsc", d, co, blocks, clock)
    live = {m: sorted(v.values(), key=lambda x: (x["sig"], x["i"])) for m, v in files.coins.items()}
    ref = TE.TickFiles(os.path.join(d, "ref"))                 # the chains pass's own route: decode, then ticks_evm
    TE.add_trades(ref, raw, set(mints), lambda m: (BNB_USD, "Chainlink stand-in", "BNB"))
    want = {m: sorted(v.values(), key=lambda x: (x["sig"], x["i"])) for m, v in ref.coins.items()}
    kinds = sorted({r[0] for r in raw})
    q = asked[0]
    ok = (live == want and len(raw) >= 2 and kinds == ["flap_trades", "fourmeme_trades"] and st["next"] == blocks[-1]["header"]["number"] + 1
          and q["fromBlock"] == blocks[0]["header"]["number"] and q["includeAllBlocks"] is True and len(q["logs"]) == 2)
    return ok, f"{len(raw)} trades ({', '.join(kinds)}) of {len(mints)} coins; live reader's ticks == the chains pass's: {live == want}; next block saved {st['next']}"
case(1, "BNB replay: Four.meme and Flap trades from real blocks, the same ticks as the chains pass", "the live reader writes exactly the ticks chains/ticks_evm.py writes from the same logs (price, size, dollars, source); the next block is saved", c1)


def c2():
    """Base: every Swap in the listed WETH pools, the same ticks as ticks_base.tick."""
    d = tempfile.mkdtemp()
    pools = FIX["base"]["pools"]
    logs = [l for b in FIX["base"]["blocks"] for l in S.block_logs(b)]
    rows = [(f"0x{i:040x}", p, TB.WETH) for i, p in enumerate(pools, 1)]
    co = coins_of(d, "base", pools=rows)
    blocks = FIX["base"]["blocks"]
    clock = Clock(blocks[-1]["header"]["timestamp"] + 1.0)
    files, asked, st = replay("base", d, co, blocks, clock)
    of = {p: m for m, p, _w in rows}
    want = {}
    for l in logs:
        m = of[l["topics"][1]]
        x = TB.tick(int(m, 16) < int(TB.WETH, 16), l["data"], float(int(l["blockTimestamp"], 16)), l["transactionHash"],
                    int(l["logIndex"], 16), ETH_USD, "Chainlink stand-in")
        if x:
            want.setdefault(m, []).append(x)
    live = {m: sorted(v.values(), key=lambda x: (x["sig"], x["i"])) for m, v in files.coins.items()}
    want = {m: sorted(v, key=lambda x: (x["sig"], x["i"])) for m, v in want.items()}
    q = asked[0]
    ok = live == want and sum(map(len, want.values())) >= 1 and q["logs"][0]["topic1"] == sorted(pools)
    return ok, f"{len(logs)} swaps, {sum(map(len, live.values()))} ticks written; == ticks_base's: {live == want}; asked for the 3 pools only: {q['logs'][0]['topic1'] == sorted(pools)}"
case(2, "Base replay: Swaps in the listed WETH pools from real blocks, the same ticks as ticks_base", "only the listed pools are asked for; each Swap becomes ticks_base's own tick (its own WETH over its tokens, at ETH's price)", c2)


def c3():
    """livefresh's rule: a fresh trade is pushed; a backlog (a restart's catch-up) goes to the files only."""
    out = {}
    for label, after in (("fresh", 1.0), ("backlog", 120.0)):
        d = tempfile.mkdtemp()
        raw = bnb_coins_in_fixture()
        co = coins_of(d, "bsc", [(m, "BNB") for m in {r[1] for r in raw}])
        blocks = FIX["bsc"]["blocks"]
        push = Pusher()
        files, _a, _s = replay("bsc", d, co, blocks, Clock(blocks[-1]["header"]["timestamp"] + after), pusher=push)
        out[label] = (push.sent, sum(map(len, files.coins.values())), len(os.listdir(os.path.join(d, "ticks"))))
    ok = out["fresh"][0] == out["fresh"][1] > 0 and out["backlog"][0] == 0 and out["backlog"][1] == out["fresh"][1] and out["backlog"][2] > 0
    return ok, f"1 s after the blocks: pushed {out['fresh'][0]} of {out['fresh'][1]}; 120 s after: pushed {out['backlog'][0]}, written to files {out['backlog'][1]}"
case(3, "Only fresh trades go to the live stream (livefresh); a backlog goes to the files", "trades under 5 s old are pushed and written; trades 120 s old are written to the coins' files and not pushed", c3)


def c4():
    """Unlisted coins, a coin with no quote coin read, and a quote coin with no fresh price: never written."""
    d = tempfile.mkdtemp()
    raw = bnb_coins_in_fixture()
    mints = sorted({r[1] for r in raw})
    listed, noquote, other = mints[0], mints[1] if len(mints) > 1 else None, "0x" + "ab" * 20
    rows = [(listed, "BNB")] + ([(noquote, None)] if noquote else []) + ([(m, other) for m in mints[2:]])
    co = coins_of(d, "bsc", rows, site={listed, noquote, *mints[2:]} - {None})
    blocks = FIX["bsc"]["blocks"]
    files, _a, _s = replay("bsc", d, co, blocks, Clock(blocks[-1]["header"]["timestamp"] + 1))
    co2 = coins_of(tempfile.mkdtemp(), "bsc", [(m, "BNB") for m in mints], site=set())
    files2, _a, _s = replay("bsc", tempfile.mkdtemp(), co2, blocks, Clock(blocks[-1]["header"]["timestamp"] + 1))
    clk = [1e9]
    stale = coins_of(tempfile.mkdtemp(), "bsc", [(m, "BNB") for m in mints], clock=lambda: clk[0])
    clk[0] = 1e9 + L.PRICE_STALE_S + 1
    files3, _a, _s = replay("bsc", tempfile.mkdtemp(), stale, blocks, Clock(blocks[-1]["header"]["timestamp"] + 1))
    ok = set(files.coins) == {listed} and not files2.coins and not files3.coins
    return ok, f"written: {sorted(files.coins)} (only the listed coin quoted in BNB); with an empty site list: {len(files2.coins)}; with BNB's price {L.PRICE_STALE_S}+ s old: {len(files3.coins)}"
case(4, "Only listed, priced coins are written (missing stays missing)", "a coin not on the site's list, a coin whose quote coin is not read, a quote coin with no price, and a stale BNB price: none written", c4)


def c5():
    """The Portal busy (529, as on 26 Oct) or down: waited out longer each time, nothing filled in, said in the status; then read again from the same block."""
    d = tempfile.mkdtemp()
    raw = bnb_coins_in_fixture()
    co = coins_of(d, "bsc", [(m, "BNB") for m in {r[1] for r in raw}])
    blocks = FIX["bsc"]["blocks"]
    clock = Clock(blocks[-1]["header"]["timestamp"] + 1)
    asked, n = [], [0]
    def opener(req, timeout=30):
        n[0] += 1; asked.append(json.loads(req.data)["fromBlock"])
        if n[0] <= 3:
            raise urllib.error.HTTPError("u", 529, "overloaded", {}, None) if n[0] < 3 else OSError("connection reset")
        return answer(blocks if n[0] == 4 else [])
    clock.slept = []
    sp = os.path.join(d, "live.json"); json.dump({"next": blocks[0]["header"]["number"]}, open(sp, "w"))
    files = TE.TickFiles(os.path.join(d, "ticks"))
    L.run("bsc", say=lambda s: None, urlopen=opener, stop=lambda: n[0] >= 4, pusher=Pusher(), coins=co, files=files, clock=clock,
          sleep=clock.sleep, head_fn=lambda: None, switch=lambda: True, state=sp)
    files.flush(clock())
    waits = [s for s in clock.slept if s >= 1]
    st = json.load(open(sp))
    ok = (asked[:4] == [blocks[0]["header"]["number"]] * 4 and waits[:3] == [1.0, 2.0, 4.0] and sum(map(len, files.coins.values())) == len(raw)
          and st["busy_since"] is None and st["reading"] is True)
    return ok, f"asked from block {asked[0]} {len(asked)} times; waits {waits[:3]}; then {sum(map(len, files.coins.values()))} trades written; status reading again: {st['reading']}"
case(5, "SQD busy or down: waited out, nothing skipped, read again from the same block", "two 529 answers and a reset connection wait 1, 2, 4 s; the same block is asked each time; then every trade is written and the status says reading", c5)


def c6():
    """A restart: from the saved block; a saved block over MAX_BEHIND_S behind the head: from the head."""
    d = tempfile.mkdtemp()
    co = coins_of(d, "bsc", [])
    blocks = FIX["bsc"]["blocks"]
    first = blocks[0]["header"]["number"]
    _f, a1, _s = replay("bsc", d, co, [], Clock(2e9), nxt=first, head=first + 100)
    far = first - int(L.MAX_BEHIND_S / L.BLOCK_S["bsc"]) - 10
    _f, a2, _s = replay("bsc", tempfile.mkdtemp(), co, [], Clock(2e9), nxt=far, head=first)
    q1 = next(x for x in a1 if isinstance(x, dict)); q2 = next(x for x in a2 if isinstance(x, dict))
    ok = q1["fromBlock"] == first and q2["fromBlock"] == first
    return ok, f"saved {first}, head 100 blocks on: asked from {q1['fromBlock']}; saved {far} (over {L.MAX_BEHIND_S} s behind): asked from {q2['fromBlock']}"
case(6, "A restart resumes from the saved block (a backlog over 10 minutes is left to the chains pass)", "from the saved block when it is close; from the head when it is over MAX_BEHIND_S behind", c6)


def c7():
    """Two writers of one coin's file (the live reader and the chains pass): neither loses the other's trades."""
    d = tempfile.mkdtemp()
    live, chains = TE.TickFiles(d), TE.TickFiles(d)
    t = lambda s, at: {"t": at, "side": "buy", "sig": s, "i": 0, "price_usd": 1.0, "usd": 1.0}
    live.add("0xc", t("a", 1000)); live.flush(1)
    chains.add("0xc", t("b", 2000)); chains.flush(2)             # the pass read the file after the live reader wrote it
    os.utime(os.path.join(d, "0xc.json"), (5, 5))             # (a later write)
    live.add("0xc", t("c", 3000)); live.flush(3)               # the live reader's cache has no "b": read again first
    chains.add("0xc", t("a", 1000))                            # the pass's copy of a trade the file already has: no second copy
    got = [x["sig"] for x in json.load(open(os.path.join(d, "0xc.json")))["ticks"]]
    left = [f for f in os.listdir(d) if f.endswith(".tmp")]
    return got == ["a", "b", "c"] and not left, f"the file's trades: {got}; temporary files left: {left}"
case(7, "The live reader and the chains pass share the files (the fallback), never losing or doubling a trade", "a file the other writer changed is read again before writing: a, b and c all kept, each once", c7)


def c8():
    """Base with no listed WETH pool: nothing asked (an empty filter would read every block's swaps)."""
    d = tempfile.mkdtemp()
    co = coins_of(d, "base", pools=[("0x" + "11" * 20, "0x" + "22" * 32, "0x" + "33" * 20)])
    asked = []
    clock = Clock(2e9); clock.slept = []
    L.run("base", say=lambda s: None, urlopen=lambda req, timeout=30: asked.append(1), stop=lambda: len(clock.slept) >= 3, pusher=Pusher(),
          coins=co, files=TE.TickFiles(d), clock=clock, sleep=clock.sleep, head_fn=lambda: 100, switch=lambda: True,
          state=os.path.join(d, "s.json"))
    q = L.query("base", 5, {})
    return not asked and not co.pools and q["logs"] == [], f"pools: {len(co.pools)} (the one listed coin is paired with another coin); requests made: {len(asked)}"
case(8, "Base asks the Portal only when a listed coin has a WETH pool", "a coin paired with anything but WETH has no pool here; no request is made", c8)


def c9():
    """The switch off: the service stops."""
    said = []
    L.run("bsc", say=said.append, urlopen=lambda *a, **k: 1 / 0, stop=None, pusher=Pusher(), coins=coins_of(tempfile.mkdtemp(), "bsc"),
          files=TE.TickFiles(tempfile.mkdtemp()), clock=Clock(2e9), sleep=lambda s: None, switch=lambda: False,
          state=os.path.join(tempfile.mkdtemp(), "s.json"))
    sw = os.path.join(tempfile.mkdtemp(), "settings.json"); json.dump({"bnb_live": "on"}, open(sw, "w"))
    return said == ["bnb_live is not on: stopping"] and L.on("bsc", sw) and not L.on("base", sw), f"said {said}; bnb_live on: {L.on('bsc', sw)}; base_live (unset): {L.on('base', sw)}"
case(9, "Each reader has its own switch in scanner/settings.json, off unless on", "bnb_live off: stops at once; set on: runs; base_live unset: off", c9)



def c10():
    """the team's W1 on evmlive: the two writers take turns (a lock), so neither reads a file the other is replacing."""
    import fcntl, threading
    d = tempfile.mkdtemp()
    f = TE.TickFiles(d)
    f.add("0xc", {"t": 1000, "side": "buy", "sig": "a", "i": 0, "price_usd": 1.0, "usd": 1.0})
    lf = open(os.path.join(d, TE.LOCK_NAME), "a"); fcntl.flock(lf, fcntl.LOCK_EX)    # the other writer, mid-flush
    done = []
    t = threading.Thread(target=lambda: done.append(f.flush(1))); t.start()
    t.join(0.5); waited = not done and not os.path.exists(os.path.join(d, "0xc.json"))
    fcntl.flock(lf, fcntl.LOCK_UN); lf.close(); t.join(5)
    ok = waited and done == [["0xc"]] and os.path.exists(os.path.join(d, "0xc.json"))
    return ok, f"while the other writer held the lock: waited ({waited}); after it let go: wrote {done}"
case(10, "The two writers of a tick file take turns", "a flush waits while the other writer holds the lock, then writes", c10)

print(f"\n{sum(results)}/{len(results)} passed")
raise SystemExit(0 if all(results) else 1)
