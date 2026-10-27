"""T2 and T3: one DexScreener pair read inside each Solana score gives the
market figures the page shows as facts with their receipt, and a graduated PumpSwap coin its liquidity when the chain read
gives nothing. The network is blocked: DexScreener's answer is made up in the shape of the real one saved in
tools/profiles/2026-10-13-dexscreener-pumpfun-pairs-one-read.json.
Run: cd stage2 && python3 test_market_figures.py"""
import json, os, sys
HERE = os.path.dirname(os.path.abspath(__file__)); ROOT = os.path.dirname(HERE)
for p in ("stage2", "stage3", "stage4", "pinr-index", "index", "pinr-step2", "scanner", "feed"):
    sys.path.insert(0, os.path.join(ROOT, p))
import dexscreener as DX
import feed_export as FE

results = []


def case(n, title, should, fn):
    try:
        ok, seen = fn()
    except Exception as e:
        ok, seen = False, f"raised {type(e).__name__}: {e}"
    results.append(bool(ok))
    print(f"{'ok  ' if ok else 'FAIL'} {n:>2}. {title}\n      should: {should}\n      seen:   {seen}")


MINT = "CCbWVGWaAxXVKXGUGfTxhJQgVNqsUK8sFUpPBERgpump"
REAL = json.load(open(os.path.join(ROOT, "tools", "profiles", "2026-10-13-dexscreener-pumpfun-pairs-one-read.json")))[0]


def pair(address, dex, liq, mc, vol24, price="0.0000362", created=1791907711000, quote=40.0, native="0.0000002"):
    p = dict(REAL); p.update({"pairAddress": address, "dexId": dex, "url": f"https://dexscreener.com/solana/{address.lower()}", "priceUsd": price, "priceNative": native,
                              "liquidity": {"usd": liq, "base": 1, "quote": quote}, "marketCap": mc, "fdv": mc, "volume": {"h24": vol24, "h6": 1, "h1": 1, "m5": 0},
                              "pairCreatedAt": created, "quoteToken": {"address": "So11111111111111111111111111111111111111112", "symbol": "SOL"}})
    p["baseToken"] = dict(REAL["baseToken"], address=MINT)
    return p


def c1():
    DX._next[0] = 0.0; DX._rest_until[0] = 0.0
    got = DX.best_pair(MINT, get=lambda url: (200, [pair("SmallPair1111111111111111111111111111111111", "raydium", 900.5, 20000, 100),
                                                       pair("BigPair22222222222222222222222222222222222", "pumpswap", 15538.2, 36238.0, 13200.0)]))
    ok = (got and got["pair"] == "BigPair22222222222222222222222222222222222" and got["dex"] == "pumpswap" and got["liquidity_usd"] == 15538.2
          and got["market_cap"] == 36238.0 and got["volume_h24"] == 13200.0 and abs(got["price_usd"] - 0.0000362) < 1e-12 and got["url"].startswith("https://dexscreener.com/")
          and abs(got["liquidity_quote_usd"] - 40.0 * (0.0000362 / 0.0000002)) < 1e-6 and got["quote_symbol"] == "SOL")
    return ok, f"quote side {got and got['liquidity_quote_usd']} (40 SOL at $181 = $7,240, P1), symbol {got and got['quote_symbol']}; picked {got and got['pair'][:8]} ({got and got['dex']}): liquidity {got and got['liquidity_usd']}, market cap {got and got['market_cap']}, 24 h volume {got and got['volume_h24']}, price {got and got['price_usd']}"
case(1, "Two pairs for one coin; the PumpSwap one holds the liquidity", "the pair with the most liquidity is chosen and its figures read: liquidity, market cap, 24-hour volume, price, address and page", c1)


def c2():
    DX._next[0] = 0.0; DX._rest_until[0] = 0.0
    a = DX.best_pair(MINT, get=lambda url: (0, None))
    b = DX.best_pair(MINT, get=lambda url: (200, []))
    bare = pair("BarePair3333333333333333333333333333333333", "pumpswap", None, None, None); bare.pop("liquidity"); bare.pop("marketCap"); bare.pop("fdv"); bare["priceUsd"] = "n/a"
    c = DX.best_pair(MINT, get=lambda url: (200, [bare]))
    ok = a is None and b is None and c is not None and c["liquidity_usd"] is None and c["market_cap"] is None and c["price_usd"] is None and c["pair"].startswith("BarePair")
    return ok, f"no answer: {a}; no pair: {b}; a pair without the figures: {c and {k: c[k] for k in ('pair', 'liquidity_usd', 'market_cap', 'price_usd')}}"
case(2, "DexScreener gives no answer, no pair, or a pair without the figures", "None, None, and a pair whose missing figures stay None (missing stays missing)", c2)


def result(receipts, venue="PumpSwap (graduated)"):
    return {"mint": MINT, "venue": venue, "creator": None, "receipts": receipts, "readings": {}, "notes": []}


T = "2026-10-13T23:00:00+00:00"
FIGS = {"dex": "pumpswap", "pair": "BigPair22222222222222222222222222222222222", "url": "https://dexscreener.com/solana/bigpair", "price_usd": 0.0000362,
        "liquidity_usd": 15538.2, "liquidity_quote_usd": 7240.0, "quote_symbol": "SOL", "market_cap": 36238.0, "fdv": 36238.0, "volume_h24": 13200.0}


def c3():
    o = result([{"what": "venue", "value": "PumpSwap (graduated)", "unit": "text", "source": "derived", "as_of": T},
                {"what": "real money in pool (SOL side)", "value": 15000.0, "unit": "USD", "source": "vault Vau1tAcc1111111111111111111111111111111111", "as_of": T},
                {"what": "spot-implied valuation", "value": 35000.0, "unit": "USD", "source": "pool price × total supply", "as_of": T},
                {"what": "market figures (DexScreener)", "value": FIGS, "unit": "USD", "source": "DexScreener pair BigPair22222222222222222222222222222222222", "as_of": T}])
    facts = {f["id"]: f for f in FE.facts_for(o, {}, T)}
    ok = (facts["valuation"]["source"] == "Solana chain" and facts["liquidity_usd"]["value"] == 15000.0 and facts["liquidity_usd"]["source"] == "Solana chain"
          and facts["liquidity_usd"]["link"] == "https://solscan.io/account/Vau1tAcc1111111111111111111111111111111111" and facts["liquidity_usd"]["label"] == "Real money in pool (SOL side)"
          and facts["market_cap"] == {"id": "market_cap", "label": "Market cap", "value": 36238.0, "unit": "USD", "source": "DexScreener", "read_at": T, "link": "https://dexscreener.com/solana/bigpair"}
          and facts["volume_24h"]["value"] == 13200.0 and facts["price_usd"]["value"] == 0.0000362 and facts["venue"]["value"] == "PumpSwap (graduated)"
          and facts["venue"]["source"] == "Solana chain" and facts["venue"]["link"] == "https://pump.fun/coin/" + MINT
          and all(k in f for f in facts.values() for k in ("source", "read_at", "link")))
    return ok, f"facts: {sorted(facts)}; liquidity {facts.get('liquidity_usd', {}).get('value')} from {facts.get('liquidity_usd', {}).get('source')}; market cap {facts.get('market_cap', {}).get('value')} from {facts.get('market_cap', {}).get('source')}"
case(3, "A score that read the pool itself and DexScreener's figures (T3)", "liquidity and valuation from the chain with the vault's explorer link; market cap, 24-hour volume and price from DexScreener with the pair's page; the venue from the chain; every fact with source, read_at and link", c3)


def c4():
    o = result([{"what": "venue", "value": "PumpSwap (graduated)", "unit": "text", "source": "derived", "as_of": T},
                {"what": "real money in pool (SOL side; DexScreener's quote-side liquidity, the chain read gave nothing)", "value": 7240.0, "unit": "USD", "source": "DexScreener pair BigPair22222222222222222222222222222222222", "as_of": T},
                {"what": "spot-implied valuation (DexScreener's market cap; the chain read gave nothing)", "value": 36238.0, "unit": "USD", "source": "DexScreener pair BigPair22222222222222222222222222222222222", "as_of": T},
                {"what": "market figures (DexScreener)", "value": FIGS, "unit": "USD", "source": "DexScreener pair BigPair22222222222222222222222222222222222", "as_of": T}])
    facts = {f["id"]: f for f in FE.facts_for(o, {}, T)}
    ok = (facts["liquidity_usd"]["source"] == "DexScreener" and facts["liquidity_usd"]["link"] == "https://dexscreener.com/solana/BigPair22222222222222222222222222222222222"
          and facts["liquidity_usd"]["value"] == 7240.0 and facts["liquidity_usd"]["label"] == "Real money in pool (SOL side)"   # the quote side, never the two-sided figure (P1, P2)
          and facts["valuation"]["source"] == "DexScreener" and facts["valuation"]["value"] == 36238.0 and sum(1 for f in facts if f == "liquidity_usd") == 1)
    return ok, f"liquidity {facts['liquidity_usd']['value']} from {facts['liquidity_usd']['source']} ({facts['liquidity_usd']['link']}); valuation {facts['valuation']['value']} from {facts['valuation']['source']}"
case(4, "The T2 fallback: the chain gave no pool, DexScreener's QUOTE-side liquidity and market cap stood in", "the liquidity fact is the quote side alone, labelled 'Real money in pool (SOL side)', source DexScreener with the pair's page, written once; the two-sided figure never becomes the fact", c4)



print(f"\n{sum(results)}/{len(results)} passed")
raise SystemExit(0 if all(results) else 1)
