"""SQD Portal blocks into the feed's tick files. Made-up blocks built from each
program's own IDL; a temporary folder; no network. Run:  python3 test_sqd_live.py"""
import base64, json, os, struct, sys, tempfile, time
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path[:0] = [HERE, os.path.join(HERE, "..", "stage2")]
import sqd as Q
import sqd_live as L
from b58 import b58e

results = []
def case(n, title, should, fn):
    try:
        ok, text = fn()
    except Exception as e:
        import traceback; traceback.print_exc()
        ok, text = False, f"CRASH {type(e).__name__}: {e}"
    results.append(ok)
    print(f"\n{n:>2}. {title}\n    should: {should}\n    did:    {text}\n    {'PASS' if ok else 'FAIL'}")

PUMP, AMM, LL = Q.Idl(), Q.Idl(Q.AMM_IDL_PATH), Q.Idl(L.LL_IDL)
IDLS = {Q.PUMP: PUMP, Q.PUMP_AMM: AMM, L.LAUNCHLAB: LL}
KEY = lambda i: bytes([i]) * 32
COIN, AMMCOIN, LLCOIN, OTHER = b58e(KEY(11)), b58e(KEY(12)), b58e(KEY(13)), b58e(KEY(14))
POOL, LLPOOL = b58e(KEY(21)), b58e(KEY(22))


def encode(idl, t, v):
    fixed = {"u8": "<B", "u16": "<H", "u32": "<I", "u64": "<Q", "i64": "<q"}
    if isinstance(t, str) and t in fixed:
        return struct.pack(fixed[t], v)
    if t in ("u128", "i128"):
        return int(v).to_bytes(16, "little", signed=(t == "i128"))
    if t in ("i8", "i16", "i32"):
        return struct.pack({"i8": "<b", "i16": "<h", "i32": "<i"}[t], v)
    if t == "bool":
        return bytes([1 if v else 0])
    if t == "pubkey":
        return v
    if t == "string":
        b = v.encode(); return struct.pack("<I", len(b)) + b
    if isinstance(t, dict) and "vec" in t:
        return struct.pack("<I", len(v)) + b"".join(encode(idl, t["vec"], x) for x in v)
    if isinstance(t, dict) and "defined" in t:
        spec = idl.types[t["defined"]["name"]]
        if spec["kind"] == "enum":
            return bytes([[x["name"] for x in spec["variants"]].index(v)])
        return b"".join(encode(idl, f["type"], v[f["name"]]) for f in spec["fields"])
    raise ValueError(t)


def event(idl, name, **given):
    tag = {v: k for k, v in idl.events.items()}[name]
    out = tag
    for f in idl.types[name]["fields"]:
        t = f["type"]
        if f["name"] in given:
            v = given[f["name"]]
        elif t == "pubkey":
            v = KEY(1)
        elif t == "bool":
            v = False
        elif t == "string":
            v = "x"
        elif isinstance(t, dict) and "vec" in t:
            v = []
        elif isinstance(t, dict) and "defined" in t:
            spec = idl.types[t["defined"]["name"]]
            v = spec["variants"][0]["name"] if spec["kind"] == "enum" else {ff["name"]: 0 for ff in spec["fields"]}
        else:
            v = 0
        out += encode(idl, t, v)
    return base64.b64encode(out).decode()


def block():
    pump = event(PUMP, "TradeEvent", mint=KEY(11), sol_amount=2_000_000_000, token_amount=50_000_000_000, is_buy=True,
                 virtual_sol_reserves=40_000_000_000, virtual_token_reserves=800_000_000_000_000, quote_mint=bytes(32))
    other = event(PUMP, "TradeEvent", mint=KEY(14), sol_amount=1, token_amount=1, is_buy=True, virtual_sol_reserves=1, virtual_token_reserves=1)
    done = event(PUMP, "CompleteEvent", mint=KEY(11))
    sell = event(AMM, "SellEvent", pool=KEY(21), base_amount_in=3_000_000_000, quote_amount_out=150_000_000, base_supply=1_000_000_000_000_000)
    llbuy = event(LL, "TradeEvent", pool_state=KEY(22), amount_in=1_000_000_000, amount_out=200_000_000_000, trade_direction="Buy",
                  virtual_base=1_073_000_000_000_000, virtual_quote=30_000_000_000, real_base_after=200_000_000_000, real_quote_after=1_000_000_000)
    return {"header": {"number": 500, "timestamp": 1_792_906_000},
            "transactions": [{"transactionIndex": i, "signatures": [f"Sig{i}"]} for i in range(5)],
            "instructions": [{"transactionIndex": 2, "instructionAddress": [0], "programId": Q.PUMP_AMM, "accounts": [POOL, "u", "g", AMMCOIN, L.WSOL]},
                             {"transactionIndex": 3, "instructionAddress": [1], "programId": L.LAUNCHLAB,
                              "accounts": ["p", "a", "g", "pc", LLPOOL, "ub", "uq", "bv", "qv", LLCOIN, L.WSOL]}],
            "tokenBalances": [{"transactionIndex": 2, "postMint": AMMCOIN, "postDecimals": 6}, {"transactionIndex": 3, "postMint": LLCOIN, "postDecimals": 6}],
            "logs": [{"transactionIndex": 0, "instructionAddress": [0], "programId": Q.PUMP, "kind": "data", "message": pump},
                     {"transactionIndex": 1, "instructionAddress": [0], "programId": Q.PUMP, "kind": "data", "message": other},
                     {"transactionIndex": 0, "instructionAddress": [0], "programId": Q.PUMP, "kind": "data", "message": done},
                     {"transactionIndex": 2, "instructionAddress": [0], "programId": Q.PUMP_AMM, "kind": "data", "message": sell},
                     {"transactionIndex": 3, "instructionAddress": [1], "programId": L.LAUNCHLAB, "kind": "data", "message": llbuy}]}


def c1():
    out = L.ticks_of(block(), IDLS, {COIN, AMMCOIN, LLCOIN}, {}, {}, seen_ms=1_792_906_000_700)
    by = {(m, t["sig"] if t else "grad"): (t, g, s) for m, t, g, s in out}
    pt, at, lt = by[(COIN, "Sig0")][0], by[(AMMCOIN, "Sig2")][0], by[(LLCOIN, "Sig3")][0]
    sup = by[(AMMCOIN, "Sig2")][2]
    near = lambda a, b: abs(a - b) <= 1e-12 * max(1, abs(b))
    return (pt["side"] == "buy" and near(pt["sol"], 2.0) and near(pt["tokens"], 50_000.0) and near(pt["price_sol"], 40 / 800_000_000)
            and pt["t"] == 1_792_906_000_000 and pt["seen_ms"] == 1_792_906_000_700 and pt["slot"] == 500 and pt["quote"] == L.WSOL
            and at["side"] == "sell" and near(at["tokens"], 3000.0) and near(at["sol"], 0.15) and near(at["price_sol"], 0.15 / 3000) and near(sup, 1_000_000_000.0)
            and lt["side"] == "buy" and near(lt["tokens"], 200_000.0) and near(lt["price_sol"], (31.0) / ((1_073_000_000_000_000 - 200_000_000_000) / 1e6))
            and (COIN, "grad") in by and not any(m == OTHER for m, *_ in out)), \
        (f"curve: {pt['side']} {pt['tokens']} tokens for {pt['sol']} SOL at {pt['price_sol']:.3g}; PumpSwap: {at['side']} {at['tokens']} at {at['price_sol']:.3g} "
         f"(the coin from its instruction, supply {sup:,.0f}); LaunchLab: {lt['side']} {lt['tokens']} at {lt['price_sol']:.3g}; graduation seen; an unlisted coin left out")
case(1, "Every venue's trades from the chain's own figures", "Pump.fun's curve (price from its reserves), PumpSwap (the coin from the instruction, decimals from the token balances, supply from the sell) and LaunchLab (its own price formula) become ticks with block time, the reader's own time and slot; a graduation is kept; a coin the site does not list is left out", c1)


def c2():
    b = block(); b["tokenBalances"] = []
    out = L.ticks_of(b, IDLS, {AMMCOIN, LLCOIN}, {}, {})
    usd = L._sized({"t": 1}, L.USD1, 5.0, 0.002)
    other = L._sized({"t": 1}, "QuoteCoinWithNoDecimals1111111111111111111", None, None)
    return (out == [] and usd["quote"] == L.USD1 and usd["quote_amount"] == 5.0 and usd["price_quote"] == 0.002 and "sol" not in usd
            and other["quote"] == "QuoteCoinWithNoDecimals1111111111111111111" and "price_quote" not in other and "quote_amount" not in other), \
        f"no token balances in the block: {len(out)} PumpSwap or LaunchLab ticks (decimals never assumed); a USD1 trade: {usd}; an unknown quote coin: {other}"
case(2, "Missing stays missing", "a PumpSwap or LaunchLab trade whose coin's decimals are not in its transaction gives no tick; a USD1 trade carries quote_amount and price_quote; a quote coin we cannot price carries neither", c2)


def c3():
    d = tempfile.mkdtemp(); st = L.Store(d)
    ticks = [{"t": 1_000_000_000 + ms, "sig": f"s{k}", "i": 0, "slot": 1, "side": side, "tokens": 1.0, "quote": L.WSOL, "sol": v, "price_sol": p}
             for k, (ms, side, v, p) in enumerate([(100, "buy", 1.0, 2.0), (700, "sell", 0.5, 1.5), (1500, "buy", 2.0, 3.0)])]
    added = [st.add("CoinM", t) for t in ticks] + [st.add("CoinM", ticks[0])]
    st.supply("CoinM", 1e9); st.graduated("CoinM", 1_000_002_000)
    wrote = st.flush(1_000_003.0)
    f = json.load(open(os.path.join(d, "CoinM.json")))
    s1, m1 = f["candles_1s"], f["candles_1m"]
    again = L.Store(d).coin("CoinM")
    return (added == [True, True, True, False] and wrote == ["CoinM"] and f["contract"] == "ticks-1" and f["last_sig"] == "s2"
            and [(k["o"], k["h"], k["l"], k["c"], k["buys"], k["sells"]) for k in s1] == [(2.0, 2.0, 1.5, 1.5, 1, 1), (3.0, 3.0, 3.0, 3.0, 1, 0)]
            and len(m1) == 1 and m1[0]["v"] == 3.5 and f["supply"] == 1e9 and f["graduated_at"].startswith("1970-01-12")
            and not any("_last" in k for k in s1) and len(again["ticks"]) == 3 and "s0:0" in again["seen"]), \
        f"3 ticks kept once each; 1 s candles {[(k['o'], k['c']) for k in s1]}; 1 min volume {m1[0]['v']}; supply and graduation in the file; read back on start: {len(again['ticks'])} ticks"
case(3, "One ticks-1 file a coin, with 1 s, 1 min and 5 min candles", "each trade once (signature and index), the candles built as it comes, the supply and graduation kept; the file written whole and read back on a restart", c3)


def c4():
    d = tempfile.mkdtemp(); wp, sp = os.path.join(d, "w.json"), os.path.join(d, "s.json")
    json.dump({"Wanted11111111111111111111111111111111111111": 1, "0xabc": 2}, open(wp, "w"))
    pages = {"/api/tokens": {"tokens": [{"address": "A111"}, {"address": "0xdef"}]}, "/api/tokens/rest": {"tokens": [{"address": "B111"}]}}
    got = L.listed_coins(lambda p: pages[p], wp)
    down = L.listed_coins(lambda p: (_ for _ in ()).throw(OSError("down")), wp)
    json.dump({"watched": ["A111"]}, open(sp, "w"))
    watched = L.ws_watched(sp)
    sent = []
    p = L.Pusher(post=lambda body: sent.append(body) or None)
    p.add({"CoinX": [{"sig": "a"}], "CoinY": [{"sig": "b"}]}); time.sleep(0.2)
    def refuse(body): raise OSError("no")
    q = L.Pusher(post=refuse); q.add({"CoinX": [{"sig": "c"}]}); time.sleep(0.2); q.add({"CoinX": [{"sig": "d"}]}); time.sleep(0.1)
    return (got == {"A111", "B111", "Wanted11111111111111111111111111111111111111"} and down is None and watched == {"A111"}
            and [b["mint"] for b in sent] == ["CoinX", "CoinY"] and sent[0]["contract"] == "ticks-1" and q.failed == 1 and q.q.qsize() == 0), \
        f"listed: {sorted(got)} (no 0x coin); the feed down: {down} (the last list kept); the websocket's own: {watched}; pushed {[b['mint'] for b in sent]}; after a refusal the next batch not queued (failed {q.failed})"
case(4, "Which coins, and the push", "the site's first page, the rest of its lists and the opened coins, Solana only; the feed not answering keeps the last list; the websocket's own coins are named so they keep one writer; each block's new ticks go to the feed server a coin at a time, resting a minute after a refusal", c4)


def c5():
    d = tempfile.mkdtemp(); st = L.Store(d); path = os.path.join(d, "CoinW.json")
    tick = lambda sig, ms: {"t": ms, "sig": sig, "i": 0, "slot": 1, "side": "buy", "tokens": 1.0, "quote": L.WSOL, "sol": 0.1, "price_sol": 1.0}
    st.add("CoinW", tick("sqd-1", 1000)); st.flush(1.0)
    ws = json.load(open(path)); ws["ticks"] += [tick("ws-1", 2000), tick("ws-2", 3000)]; ws["last_sig"] = "ws-2"
    time.sleep(0.01); json.dump(ws, open(path, "w"))                       # the websocket writes the file meanwhile
    st.add("CoinW", tick("sqd-2", 4000)); st.flush(2.0)
    after = [t["sig"] for t in json.load(open(path))["ticks"]]
    ws = json.load(open(path)); ws["ticks"] += [tick("ws-3", 5000)]; time.sleep(0.01); json.dump(ws, open(path, "w"))
    st.drop(set())                                                          # the coin went to the websocket's list
    kept = "CoinW" not in st.coins
    st.flush(3.0)
    final = [t["sig"] for t in json.load(open(path))["ticks"]]
    return (after == ["sqd-1", "ws-1", "ws-2", "sqd-2"] and kept and final == ["sqd-1", "ws-1", "ws-2", "sqd-2", "ws-3"]), \
        f"after both wrote: {after}; the coin forgotten when it left: {kept}; the other writer's later tick kept: {final}"
case(5, "the team's F1 on 9c9fa986: two writers never lose each other's trades", "a file the other writer changed is read again before this writer adds to it, and its ticks merged by signature and index before writing; a coin that leaves this writer's list is forgotten, so a stale copy is never written back", c5)


def site_keeps(f: dict) -> list:
    """the site's rule for a ticks-1 file (pinr-live/server/ticks.ts parseTicks): SOL trades only, the quote named by its mint."""
    if f.get("contract") != "ticks-1" or f.get("source") != "Solana chain":
        return []
    ok = lambda q: q is None or q == L.WSOL
    return [t["sig"] for t in f.get("ticks") or [] if isinstance(t.get("price_sol"), (int, float)) and t["price_sol"] > 0
            and isinstance(t.get("sol"), (int, float)) and t.get("side") in ("buy", "sell") and ok(t.get("quote", f.get("quote")))]


def c6():
    d = tempfile.mkdtemp(); path = os.path.join(d, "CoinQ.json")
    old = lambda sig, ms: {"t": ms, "sig": sig, "i": 0, "slot": 1, "side": "buy", "tokens": 1.0, "quote": "SOL", "sol": 0.1, "price_sol": 1.0}
    json.dump({"contract": "ticks-1", "mint": "CoinQ", "source": "Solana chain", "quote": "SOL", "ticks": [old("first-1", 1000)]}, open(path, "w"))
    before = site_keeps(json.load(open(path)))
    b = block(); got = [x for x in L.ticks_of(b, IDLS, {COIN, AMMCOIN, LLCOIN}, {}, {}, seen_ms=1) if x[1]]
    st = L.Store(d)
    st.add("CoinQ", {**got[0][1], "sig": "new-1"}); st.flush(1.0)
    f = json.load(open(path)); kept = site_keeps(f)
    quotes = sorted({t["quote"] for _m, t, _g, _s in got})
    return (before == [] and kept == ["first-1", "new-1"] and f["quote"] == L.WSOL and quotes == [L.WSOL]), \
        f"a file from the first day ('SOL'): the site kept {before}; after this service wrote it: kept {kept}, file quote {f['quote'][:6]}...; every venue's tick quotes {[q[:6] for q in quotes]}"
case(6, "The site keeps this service's trades (live 25 Oct: it kept none)", "every tick names its quote by the coin's mint, as ticks-1 and the websocket feed do; a file this service wrote with 'SOL' is renamed when it next writes it; the site's own rule keeps them all", c6)


def c7():
    d = tempfile.mkdtemp(); path, ws = os.path.join(d, "quote_prices.json"), os.path.join(d, "_status.json")
    OTHERQ = "QuoteCoinFromTheWebsocket111111111111111111"
    json.dump({"quotes": [OTHERQ]}, open(ws, "w"))
    asked = []
    def fetch(url):
        ids = url.split("ids=")[1].split(","); asked.append(ids)
        return {m: {"usdPrice": {L.WSOL: 200.0, L.USD1: 0.999, OTHERQ: 2.0}[m], "blockId": 9} for m in ids if m != OTHERQ or len(asked) > 1}
    qp = L.QuotePrices(path, fetch, ws)
    qp.want.add(L.USD1)
    n1 = qp.refresh(1_000.0)                                               # OTHERQ not answered the first time
    sol = qp.stamp({"quote": L.WSOL, "sol": 0.5, "price_sol": 2e-8}, now_ms=1_010_000)
    usd1 = qp.stamp({"quote": L.USD1, "quote_amount": 10.0, "price_quote": 1e-6}, now_ms=1_010_000)
    none = qp.stamp({"quote": OTHERQ, "quote_amount": 3.0, "price_quote": 1e-3}, now_ms=1_010_000)
    nosize = qp.stamp({"quote": L.WSOL, "price_sol": 2e-8}, now_ms=1_010_000)
    stale = qp.stamp({"quote": L.WSOL, "sol": 0.5, "price_sol": 2e-8}, now_ms=1_000_000 + L.PRICE_STALE_S * 1000 + 1)
    n2 = qp.refresh(1_200.0); other = qp.stamp({"quote": OTHERQ, "quote_amount": 3.0, "price_quote": 1e-3}, now_ms=1_200_000)
    saved = json.load(open(path))
    def down(url): raise OSError("no answer")
    qp2 = L.QuotePrices(path, down, ws); n3 = qp2.refresh(1_300.0)
    kept = qp2.stamp({"quote": L.WSOL, "sol": 1.0, "price_sol": 1e-8}, now_ms=1_300_000)
    ok = (n1 == 2 and abs(sol["price_usd"] - 4e-6) < 1e-12 and sol["usd"] == 100.0 and sol["price_usd_src"] == "Jupiter price v3, read 1970-01-01T00:16:40Z"
          and abs(usd1["usd"] - 9.99) < 1e-9 and "price_usd" not in none and "usd" not in none and "price_usd" not in nosize and "usd" not in nosize
          and "price_usd" not in stale and n2 == 3 and other["usd"] == 6.0 and sorted(saved["prices"]) == sorted([L.WSOL, L.USD1, OTHERQ])
          and saved["contract"] == "quote-prices-1" and n3 == 0 and abs(kept["price_usd"] - 2e-6) < 1e-15 and abs(kept["usd"] - 200.0) < 1e-9 and OTHERQ in asked[0])
    return ok, (f"read {n1} quote prices (the websocket's quote coin asked too, not answered); SOL tick ${sol['usd']} at ${sol['price_usd']:.2g}, src '{sol['price_usd_src']}'; "
                f"USD1 tick ${usd1['usd']:.2f}; unpriced quote: no dollar fields; a tick without its size: none; a price past {L.PRICE_STALE_S} s: none; "
                f"next read {n2}, the websocket's coin ${other['usd']}; Jupiter not answering: {n3} read, the saved price still used while fresh (${kept['usd']:.0f})")
case(7, "Dollar price and size on every tick (the site's ask, 257)", "each tick gets price_usd and usd from its quote coin's Jupiter price (SOL, USD1, and the websocket feed's quote coins), with the price's read time named; no figure from a price over the stale line, none when the price or the size is missing, never one without the other", c7)


def c8():
    d = tempfile.mkdtemp(); lg = os.path.join(d, "_logs_status.json")
    json.dump({"watched": ["BusyCoin"]}, open(lg, "w"))
    both = L.ws_watched(lg)
    old = time.time() - L.LOGS_FRESH_S - 30; os.utime(lg, (old, old))
    stale = L.ws_watched(lg)
    st = L.Store(d); now = 10_000_000
    for k, ms in enumerate((now - 1000, now - 2000, now - L.BUSY_WINDOW_MS - 1)):
        st.add("CoinB", {"t": ms, "seen_ms": ms, "sig": f"b{k}", "i": 0, "side": "buy", "tokens": 1.0, "quote": L.WSOL, "sol": 0.1, "price_sol": 1.0})
    st.add("CoinQ", {"t": 1, "seen_ms": 1, "sig": "q", "i": 0, "side": "buy", "tokens": 1.0, "quote": L.WSOL, "sol": 0.1, "price_sol": 1.0})
    busy = L.busy_counts(st, now)
    return (both == {"BusyCoin"} and stale == set() and busy == {"CoinB": 2}), \
        f"the logs feed's coins skipped: {sorted(both)}; its status {L.LOGS_FRESH_S + 30} s old: {sorted(stale)} (SQD writes them again); trades in the last 10 min: {busy}"
case(8, "The logs feed's busiest coins (257 step 2)", "one writer a coin: SQD skips the logs feed's coins while its status is fresh (it stopped: SQD carries them again); SQD counts each coin's trades over the last 10 minutes for the logs feed to pick the busiest", c8)


def c9():
    d = tempfile.mkdtemp(); st = L.Store(d); h = L.Held(); now = 10_000_000
    tk = lambda sig, ms: {"t": ms, "seen_ms": ms, "sig": sig, "i": 0, "slot": 1, "side": "buy", "tokens": 1.0, "quote": L.WSOL, "sol": 0.1, "price_sol": 1.0}
    json.dump({"contract": "ticks-1", "mint": "CoinL", "source": "Solana chain", "ticks": [tk("heard-by-logs", now - 5000)]}, open(os.path.join(d, "CoinL.json"), "w"))
    for sig, ms in (("heard-by-logs", now - 5000), ("in-the-gap-1", now - 3000), ("in-the-gap-2", now - 1000), ("too-old", now - L.HELD_S * 1000 - 1)):
        h.keep("CoinL", tk(sig, ms))
    h.keep("StillLogs", tk("x", now))
    h.prune(now)
    gave = h.give_back({"CoinL"}, st); st.flush(1.0)
    sigs = [t["sig"] for t in json.load(open(os.path.join(d, "CoinL.json")))["ticks"]]
    return (list(gave) == ["CoinL"] and [t["sig"] for t in gave["CoinL"]] == ["in-the-gap-1", "in-the-gap-2"]
            and sigs == ["heard-by-logs", "in-the-gap-1", "in-the-gap-2"] and "StillLogs" in h.ticks), \
        f"given back: {[t['sig'] for t in gave.get('CoinL', [])]} (the logs feed's own trade not doubled, one older than {L.HELD_S} s dropped); the file now: {sigs}; a coin the logs feed still watches stays held"
case(9, "A coin handed back by the logs feed loses no trade", "SQD keeps the logs feed's coins' trades without writing them; a coin it gets back has the gap's trades written at once, never one the logs feed already wrote", c9)


def c10():
    d = tempfile.mkdtemp(); clock = [10_000_000.0]
    tk = lambda sig, ms, side: {"t": ms, "seen_ms": ms, "sig": sig, "i": 0, "slot": 1, "side": side, "tokens": 1.0, "quote": L.WSOL, "sol": 0.1, "price_sol": 1.0}
    now = lambda: int(clock[0] * 1000)
    st = L.Store(d, clock=lambda: clock[0])
    st.add("New", tk("n1", now() - 1000, "buy")); st.flush(clock[0])
    young = json.load(open(os.path.join(d, "New.json")))
    clock[0] += 3700                                                        # past the hour by more than the minute the count goes by
    for k, (side, ago) in enumerate((("buy", 1000), ("sell", 2000), ("buy", 3_700_000))):
        st.add("New", tk(f"n{k + 2}", now() - ago, side))
    st.flush(clock[0]); hour = json.load(open(os.path.join(d, "New.json")))
    json.dump({"contract": "ticks-1", "mint": "Old", "source": "Solana chain", "ticks": [tk("o1", now() - 4_000_000, "sell"), tk("o2", now() - 5000, "buy"), tk("o3", now() - 4000, "sell")]},
              open(os.path.join(d, "Old.json"), "w"))
    st2 = L.Store(d, clock=lambda: clock[0]); st2.add("Old", tk("o4", now() - 1000, "buy")); st2.flush(clock[0])
    old = json.load(open(os.path.join(d, "Old.json")))
    return ("trades_1h" not in young and hour.get("trades_1h") == 2 and hour.get("buys_1h") == 1 and hour.get("sells_1h") == 1
            and old.get("trades_1h") == 3 and old.get("buys_1h") == 2), \
        f"counted for under an hour: no count written; after an hour: {hour.get('trades_1h')} trades ({hour.get('buys_1h')} buys, {hour.get('sells_1h')} sells; the hour-old one and the first, now past the hour, left out); a coin whose kept trades span the hour: {old.get('trades_1h')} at once"
case(10, "Each coin's trades over the last hour", "trades_1h, buys_1h and sells_1h by block time, written only when the count covers the whole hour (counted for an hour, or the kept trades span it); a part-hour count is never written", c10)


def c11():
    d = tempfile.mkdtemp(); now = 20_000_000
    tk = lambda sig, ms, side: {"t": ms, "seen_ms": ms, "sig": sig, "i": 0, "slot": 1, "side": side, "tokens": 1.0, "quote": L.WSOL, "sol": 0.5, "price_sol": 1.0}
    for m in ("Mine", "Theirs"):
        json.dump({"contract": "ticks-1", "mint": m, "source": "Solana chain", "ticks": [tk("good", now - 2000, "buy"), tk("bad", now - 1000, "buy")]}, open(os.path.join(d, m + ".json"), "w"))
    lst = os.path.join(d, "unconfirmed.json")
    json.dump({"contract": "unconfirmed-1", "trades": [{"mint": "Mine", "sig": "bad"}, {"mint": "Theirs", "sig": "bad"}]}, open(lst, "w"))
    st, done = L.Store(d, clock=lambda: now / 1000), set()
    st.coin("Mine")
    st.add("Mine", tk("later", now - 500, "sell"))
    n1 = L.apply_unconfirmed(st, {"Mine"}, done, lst); n2 = L.apply_unconfirmed(st, {"Mine"}, done, lst); st.flush(now / 1000)
    sigs = [t["sig"] for t in json.load(open(os.path.join(d, "Mine.json")))["ticks"]]
    theirs = [t["sig"] for t in json.load(open(os.path.join(d, "Theirs.json")))["ticks"]]
    json.dump({"contract": "unconfirmed-1", "trades": []}, open(lst, "w")); L.apply_unconfirmed(st, {"Mine"}, done, lst)
    return (n1 == 1 and n2 == 0 and sigs == ["good", "later"] and theirs == ["good", "bad"] and done == set()), \
        f"removed {n1} from a coin SQD writes (then {n2} on the next look); its file: {sigs}; a coin SQD does not write is left to its own writer: {theirs}; the list emptied, nothing remembered"
case(11, "A trade the logs feed found unconfirmed after handing the coin back is removed by SQD", "the logs feed lists it; SQD removes it once from the coins it now writes, never from another writer's coin", c11)


def c12():
    b = block()
    dep = event(AMM, "DepositEvent", pool=KEY(21), user=KEY(31), base_amount_in=5_000_000_000, quote_amount_in=2_000_000_000, lp_token_amount_out=777,
                lp_mint_supply=9_999, pool_base_token_reserves=100_000_000_000, pool_quote_token_reserves=40_000_000_000)
    wd = event(AMM, "WithdrawEvent", pool=KEY(21), user=KEY(31), base_amount_out=4_000_000_000, quote_amount_out=1_500_000_000, lp_token_amount_in=700)
    far = event(AMM, "DepositEvent", pool=KEY(23), user=KEY(31), base_amount_in=1, quote_amount_in=1)
    b["logs"] += [{"transactionIndex": 2, "instructionAddress": [0], "programId": Q.PUMP_AMM, "kind": "data", "message": m} for m in (dep, wd)]
    b["logs"].append({"transactionIndex": 4, "instructionAddress": [0], "programId": Q.PUMP_AMM, "kind": "data", "message": far})
    got = []; ticks = L.ticks_of(b, IDLS, {AMMCOIN}, {}, {}, seen_ms=1, pool_out=got)
    d = tempfile.mkdtemp(); pl = L.PoolLog(d)
    for m, ev in got + got:                                             # the same events twice: kept once
        pl.add(m, ev)
    pl.flush(1_792_906_100)
    f = json.load(open(os.path.join(d, AMMCOIN + ".json"))); e = f["events"]
    add, rem = e[0], e[1]
    return (f["contract"] == "pool-events-1" and [x["kind"] for x in e] == ["liquidity added", "liquidity removed"] and add["user"] == b58e(KEY(31))
            and add["base"] == 5000.0 and add["quote"] == 2.0 and add["lp_raw"] == 777 and add["pool_quote"] == 40.0 and add["sig"] == "Sig2"
            and rem["base"] == 4000.0 and add["raw"] is False and len(got) == 2 and any(t for _m, t, _g, _s in ticks)), \
        f"{len(got)} pool events for the listed coin (one for an unknown pool left out): {[x['kind'] for x in e]}; added {add['base']} tokens and {add['quote']} SOL by {add['user'][:6]}..., LP {add['lp_raw']} (raw), receipt {add['sig']}; written once"
case(12, "Each listed coin's pool events from the chain", "PumpSwap's own deposit and withdraw events become 'liquidity added' and 'liquidity removed' with who, how much (in tokens, its decimals read in the block), LP units and the pool's reserves, receipt the transaction; an unknown pool's event is left out; the same event is kept once", c12)


def c13():
    b = block()
    create = event(AMM, "CreatePoolEvent", pool=KEY(21), creator=KEY(32), base_mint=KEY(12), quote_mint=bytes(32), base_mint_decimals=6, quote_mint_decimals=9,
                   base_amount_in=200_000_000_000_000, quote_amount_in=85_000_000_000, lp_token_amount_out=5, coin_creator=KEY(33))
    migrate = event(AMM, "MigratePoolCoinCreatorEvent", pool=KEY(21), base_mint=KEY(12), old_coin_creator=KEY(33), new_coin_creator=KEY(34))
    burn = event(AMM, "BoostBuyAndBurnEvent", pool=KEY(21), mint=KEY(12), authority=KEY(35), base_amount_burned=7_000_000, quote_amount_in_used=500_000_000)
    b["logs"] += [{"transactionIndex": 2, "instructionAddress": [0], "programId": Q.PUMP_AMM, "kind": "data", "message": m} for m in (create, migrate, burn)]
    got = []; L.ticks_of(b, IDLS, {AMMCOIN}, {}, {}, seen_ms=1, pool_out=got)
    by = {e["kind"]: e for _m, e in got}
    c, m, k = by.get("pool created", {}), by.get("coin creator changed", {}), by.get("bought back and burned", {})
    return (c.get("user") == b58e(KEY(32)) and c.get("base") == 200_000_000.0 and c.get("quote") == 85.0 and c.get("coin_creator") == b58e(KEY(33)) and c.get("raw") is False
            and m.get("old_coin_creator") == b58e(KEY(33)) and m.get("new_coin_creator") == b58e(KEY(34)) and "quote_mint" not in m and "raw" not in m
            and k.get("user") == b58e(KEY(35)) and k.get("base") == 7.0 and k.get("quote") == 0.5), \
        f"pool created by {c.get('user', '')[:6]}... with {c.get('base')} tokens and {c.get('quote')} SOL (decimals from the event); creator changed {m.get('old_coin_creator', '')[:6]}... to {m.get('new_coin_creator', '')[:6]}... (no quote coin named: {'quote_mint' not in m}); bought back and burned {k.get('base')} tokens for {k.get('quote')} SOL"
case(13, "The pool's other events: created, creator changed, bought back and burned", "each as the chain states it; a creator change names no quote coin and none is assumed (W1)", c13)


def c14():
    import inspect
    d = tempfile.mkdtemp(); now = 20_000_000
    tk = lambda sig, ms: {"t": ms, "seen_ms": ms, "sig": sig, "i": 0, "slot": 1, "side": "buy", "tokens": 1.0, "quote": L.WSOL, "sol": 0.5, "price_sol": 1.0}
    st = L.Store(d, clock=lambda: now / 1000)
    st.add("Lone", tk("bad", now - 1000)); st.flush(now / 1000)
    st.forget("Lone", "bad")                                       # its only trade, never confirmed
    st.supply("Fresh", 1_000_000_000.0)                            # a supply read before any trade
    st.add("Busy", tk("ok", now - 3000))
    wrote = st.flush(now / 1000)
    lags = {m: st.lag(m, now / 1000) for m in wrote}
    files = {m: json.load(open(os.path.join(d, m + ".json")))["ticks"] for m in wrote}
    src = inspect.getsource(L.run)
    return (sorted(wrote) == ["Busy", "Fresh", "Lone"] and lags["Lone"] is None and lags["Fresh"] is None and abs(lags["Busy"] - 3.0) < 1e-6
            and files["Lone"] == [] and files["Fresh"] == [] and '["ticks"][-1]' not in src and src.count("store.lag(") == 2), \
        f"written {sorted(wrote)}; lag {lags}; their trades {[len(files[m]) for m in sorted(files)]}; the stream reads the lag only through Store.lag"
case(14, "A coin left with no trades is written and does not stop the stream (2026-10-25: IndexError at sqd_live.py:732)", "a coin whose only trade was forgotten as unconfirmed, and one with a supply but no trade yet, are written with no trades and give no lag figure (never a crash, never a made-up lag); a coin with trades gives its lag", c14)


def c15():
    d = tempfile.mkdtemp(); now = 20_000_000
    theirs = os.path.join(d, "Shared.json.tmp")                    # the logs feed half way through its own write of the same coin
    open(theirs, "w").write('{"theirs": true}')
    st = L.Store(d, clock=lambda: now / 1000)
    st.add("Shared", {"t": now - 1000, "seen_ms": now - 1000, "sig": "s", "i": 0, "slot": 1, "side": "buy", "tokens": 1.0, "quote": L.WSOL, "sol": 0.5, "price_sol": 1.0})
    wrote = st.flush(now / 1000)
    left = sorted(x for x in os.listdir(d) if x.endswith(".tmp"))
    kept = json.load(open(theirs)) if os.path.exists(theirs) else None
    return (wrote == ["Shared"] and left == ["Shared.json.tmp"] and kept == {"theirs": True}
            and json.load(open(os.path.join(d, "Shared.json")))["ticks"][0]["sig"] == "s"), \
        f"written {wrote}; temporary files left: {left} (the logs feed's own, untouched: {kept})"
case(15, "SQD's temporary file has its own name (2026-10-25: FileNotFoundError on <mint>.json.tmp)", "SQD writes <mint>.json.sqd.tmp and renames it, so the logs feed's <mint>.json.tmp for the same coin is never taken or renamed away; none of SQD's own is left", c15)


def c16():
    """the team, 26 Oct: after a restart, sqd_live replayed its backlog onto the live stream (1 in 10 trades 85 s late)."""
    now = 1_800_000_000.0
    caught_up = {"CoinA": [{"t": int((now - 60) * 1000), "sig": "old1"}, {"t": int((now - 2) * 1000), "sig": "new1"}],
                 "CoinB": [{"t": int((now - 300) * 1000), "sig": "old2"}]}
    pushed = L.fresh_only(caught_up, now)
    edge = L.fresh_only({"C": [{"t": int((now - L.FRESH_PUSH_S) * 1000), "sig": "edge"}, {"sig": "no time"}]}, now)
    ok = pushed == {"CoinA": [{"t": int((now - 2) * 1000), "sig": "new1"}]} and edge == {"C": [{"t": int((now - L.FRESH_PUSH_S) * 1000), "sig": "edge"}]}
    return ok, f"a restart's backlog: pushed {[(m, [x['sig'] for x in v]) for m, v in pushed.items()]} (the rest stay in the coins' files); at the edge: {list(edge)}; a tick with no time: not pushed"
case(16, "Only fresh trades go to the live stream", "trades older than FRESH_PUSH_S (a restart's backlog) are not pushed; fresh ones are; a coin left with none is not pushed at all; a tick with no time is not pushed", c16)


FIXP = json.load(open(os.path.join(HERE, "fixtures", "pool_history_block.json")))   # the real block of CV5G7…'s pool (slot 459437268)


def c17():
    """S1: a graduated listed coin whose pool was made before it was watched: its history, from SQD."""
    d = tempfile.mkdtemp()
    log = L.PoolLog(os.path.join(d, "pools"))
    M = FIXP["mint"]
    asked, posts = [], []
    def rpc(method, params):
        asked.append((method, params[0]))
        if method == "getMultipleAccounts":                     # the SOL pool is not there; the other quote coin's pool is
            return {"value": [None] + [{"owner": Q.PUMP_AMM} if k == 0 else None for k in range(len(params[0]) - 1)]}
        return [{"slot": FIXP["slot"], "err": None}, {"slot": FIXP["slot"], "err": None}, {"slot": 7, "err": {"x": 1}}]
    def post(q):
        posts.append((q["fromBlock"], q["toBlock"], q["instructions"][0]["a3"])); return FIXP["answer"]
    rows = [{"address": M, "launchpad": "PumpSwap (graduated)"}, {"address": "CurveCoin", "launchpad": "Pump.fun"}, {"address": "0xabc", "launchpad": "PumpSwap"}]
    h = L.PoolHistory(log, IDLS, rows=lambda: rows, rpc=rpc, post=post, state=os.path.join(d, "ph.json"), clock=lambda: 1000.0,
                      quotes=lambda: [L.WSOL, "QuoteCoin1111111111111111111111111111111111", "QuoteCoin2222222222222222222222222222222222"])
    cands = h.candidates()
    added = h.round()
    ev = json.load(open(os.path.join(d, "pools", M + ".json")))["events"]
    created = [e for e in ev if e["kind"] == "pool created"]
    again = h.candidates()
    ok = (cands == [M] and added == 1 and len(created) == 1 and created[0]["pool"] == "JCUQck7K5hmCvMUCYdPG6YnNqeSLMbjYhDvyUDT866oB"
          and abs(created[0]["quote"] - 85.022037034) < 1e-9 and created[0]["sig"].startswith("3vrsWaMLbB6B")
          and [a[0] for a in asked] == ["getMultipleAccounts", "getSignaturesForAddress"] and len(asked[0][1]) == 3 and asked[1][1] != "7vFbaZtwwcQvZ8w5vGqhrcoveLi1h7fmQe4KEPZdamQq"
          and posts == [(FIXP["slot"], FIXP["slot"], [M])] and again == [])
    return ok, (f"candidates {cands}; pools tried for {len(asked[0][1])} quote coins, the second's LP mint asked; SQD read slot(s) {[p[0] for p in posts]}; "
                f"pool created: {created[0]['quote'] if created else None} SOL in pool {created[0]['pool'][:8] if created else None}…; read again: {again}")
case(17, "A graduated coin's pool history from SQD (S1: pool made before it was watched)", "only listed PumpSwap Solana coins without a 'pool created' are read; the LP mint's slots (failed transactions left out) are each read once from SQD; the real block gives 'pool created' (85.02 SOL, its receipt); a coin read is not read again", c17)


def c18():
    """A read that fails is not marked read: tried again after POOL_HISTORY_RETRY_S, never filled in."""
    d = tempfile.mkdtemp()
    log = L.PoolLog(os.path.join(d, "pools"))
    M = FIXP["mint"]; now = [1000.0]
    rows = [{"address": M, "launchpad": "PumpSwap (graduated)"}]
    h = L.PoolHistory(log, IDLS, rows=lambda: rows, rpc=lambda m, p: {"value": [{"owner": Q.PUMP_AMM}]} if m == "getMultipleAccounts" else [{"slot": FIXP["slot"], "err": None}], post=lambda q: None,
                      quotes=lambda: [],
                      state=os.path.join(d, "ph.json"), clock=lambda: now[0])
    a1 = h.round(); soon = h.candidates()
    now[0] += L.POOL_HISTORY_RETRY_S + 1; later = h.candidates()
    h2 = L.PoolHistory(log, IDLS, rows=lambda: rows, rpc=lambda m, p: None, post=lambda q: FIXP["answer"], state=os.path.join(d, "ph2.json"), clock=lambda: 1.0,
                       quotes=lambda: [])
    a2 = h2.round()
    ok = a1 == 0 and soon == [] and later == [M] and a2 == 0 and not os.path.exists(os.path.join(d, "pools", M + ".json"))
    return ok, f"SQD not answering: {a1} events, asked again at once: {bool(soon)}, after {L.POOL_HISTORY_RETRY_S} s: {later == [M]}; the node not answering: {a2} events, no file"
case(18, "A failed history read is tried again later, never filled in", "SQD or the public node not answering adds nothing, writes no file, and the coin is asked again after the retry time", c18)


def c19():
    """A busy coin's buybacks never push its pool's creation or a liquidity change out of its file."""
    d = tempfile.mkdtemp()
    log = L.PoolLog(d)
    log.add("C", {"t": 1, "sig": "create", "kind": "pool created", "i": 0})
    log.add("C", {"t": 2, "sig": "dep", "kind": "liquidity added", "i": 0})
    for k in range(L.POOL_KEEP + 100):
        log.add("C", {"t": 10 + k, "sig": f"b{k}", "kind": "bought back and burned", "i": 0})
    log.flush()
    ev = json.load(open(os.path.join(d, "C.json")))["events"]
    kinds = [e["kind"] for e in ev]
    ok = kinds[:2] == ["pool created", "liquidity added"] and kinds.count("bought back and burned") == L.POOL_KEEP and ev[-1]["sig"] == f"b{L.POOL_KEEP + 99}"
    return ok, f"{len(ev)} events kept: {kinds[:2]} first, then the newest {kinds.count('bought back and burned')} buybacks"
case(19, "Buybacks never push out the pool's creation or liquidity changes (S1)", "the newest POOL_KEEP buybacks are kept, and every other pool event too", c19)



def c20():
    """S3/S4: a listed coin with no tick file gets its trades from the window before it was listed, files only."""
    import queue
    d = tempfile.mkdtemp()
    M = FIXP["mint"]
    q = queue.Queue()
    asked = []
    def post(qq):
        asked.append(qq); return FIXP["answer"]
    th = L.TickHistory(IDLS, q, listed=lambda: {M, "HasFile", "0xbnb"}, has_file=lambda m: m == "HasFile", post=post,
                       head=lambda: FIXP["slot"], state=os.path.join(d, "th.json"), clock=lambda: 5000.0, sleep=lambda s: None)
    cands = th.candidates()
    n = th.round()
    got = []
    while not q.empty():
        m, ts = q.get(); got += [(m, t) for t in ts]
    bt = json.loads(FIXP["answer"].splitlines()[0])["header"]["timestamp"] * 1000
    ins = asked[0]["instructions"]
    filt = sorted((i["programId"][:4], [k for k in i if k.startswith("a") and k[1:].isdigit()][0]) for i in ins)
    again = th.candidates()
    ok = (cands == [M] and n == len(got) > 0 and all(m == M for m, _t in got) and all(t["seen_ms"] == bt for _m, t in got)
          and not any("price_usd" in t for _m, t in got) and asked[0]["fromBlock"] == FIXP["slot"] - int(L.TICK_HISTORY_S / L.SLOT_S)
          and all(i[f"a{ {L.sqd.PUMP: 2, L.sqd.PUMP_AMM: L.sqd.AMM_MINT, L.LAUNCHLAB: L.LL_BASE}[i['programId'][0]] }"] == [M] for i in ins)
          and again == [])
    return ok, (f"candidates {cands}; {n} trades of the real block (its buys), timed by the block ({all(t['seen_ms'] == bt for _m, t in got)}), "
                f"no dollar figure at today's price; window from {FIXP['slot'] - asked[0]['fromBlock']} slots back; filters {filt}; read again: {again}")
case(20, "A listed coin with no tick file gets its trades from before it was listed (S3/S4)", "one SQD scan over the window, filtered to the coins (Pump.fun account 3, PumpSwap 4, LaunchLab 10); each trade timed by its block and not priced at today's price; the coin is not read again; coins with a file, and 0x coins, are not read", c20)


def c21():
    """The Portal busy mid-scan (529, as on 26 Oct): nothing marked read; the scan goes on from where it stopped."""
    import queue
    d = tempfile.mkdtemp()
    q = queue.Queue()
    M = FIXP["mint"]
    froms, answers = [], [None]
    def post(qq):
        froms.append(qq["fromBlock"]); return answers.pop(0) if answers else FIXP["answer"]
    th = L.TickHistory(IDLS, q, listed=lambda: {M}, has_file=lambda m: False, post=post, head=lambda: FIXP["slot"],
                       state=os.path.join(d, "th.json"), clock=lambda: 100.0, sleep=lambda s: None)
    r1 = th.round(); read1 = (th.done.get(M) or {}).get("read")
    r2 = th.round(); read2 = (th.done.get(M) or {}).get("read")
    return (r1 is None and not read1 and froms[0] == froms[1] and r2 == sum(len(q.get()[1]) for _ in range(q.qsize())) > 0 and read2), \
        f"busy: round {r1}, read {bool(read1)}; next round asked from the same block ({froms[0] == froms[1]}): {r2} trades, read {read2}"
case(21, "A history scan the Portal interrupts goes on from where it stopped (S3/S4)", "a busy answer marks nothing read and fills nothing in; the next round asks from the same block and finishes", c21)



def c22():
    """the team and DEBUG, 26 Oct: trades 8-11 h old reached pinr.io's live stream after the 17:34 deploy. The site streams a
    trade it has not seen in a file it already watches (whatever its age) and nothing from a file it sees for the first time;
    so a coin's history is written only as its first file, and never pushed."""
    import queue
    d = tempfile.mkdtemp()
    st = L.Store(d)
    old = lambda sig, h: {"t": int((time.time() - h * 3600) * 1000), "seen_ms": int((time.time() - h * 3600) * 1000), "sig": sig, "i": 0,
                          "slot": 1, "side": "buy", "tokens": 1.0, "quote": L.WSOL, "sol": 0.1, "price_sol": 0.1}
    json.dump({"contract": "ticks-1", "mint": "Watched", "ticks": [old("live1", 0)]}, open(os.path.join(d, "Watched.json"), "w"))
    st.add("InMemory", old("live2", 0))                        # a live trade added, its file not written yet
    q = queue.Queue()
    for m in ("New", "Watched", "InMemory", "NotMine"):
        q.put((m, [old(m + "-h1", 10.9), old(m + "-h2", 8.7)]))
    pushed = []
    n = L.take_history(q, st, {"New", "Watched", "InMemory"})
    st.flush()
    files = {m: [t["sig"] for t in json.load(open(os.path.join(d, m + ".json")))["ticks"]] for m in ("New", "Watched", "InMemory")
             if os.path.exists(os.path.join(d, m + ".json"))}
    ok = (n == 2 and files.get("New") == ["New-h1", "New-h2"] and files.get("Watched") == ["live1"]
          and files.get("InMemory") == ["live2"] and not os.path.exists(os.path.join(d, "NotMine.json")) and q.empty())
    return ok, f"written {n}: a coin with no file gets its history as its first file {files.get('New')}; a watched file keeps {files.get('Watched')} (no old trade added); a coin with a live trade in memory keeps {files.get('InMemory')}; a coin not this service's: no file"
case(22, "A stored old trade never reaches the stream (history only as a coin's first file)", "history 8.7 and 10.9 h old is written only for a coin with no file and no live trade yet (the site sends nothing from a file it sees first); a file the site already watches gets no old trade; nothing is pushed", c22)

print(f"\n{sum(results)}/{len(results)} passed")
raise SystemExit(0 if all(results) else 1)
