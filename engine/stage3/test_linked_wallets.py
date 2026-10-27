"""Linked wallets: plain-English tests with made-up wallets (no network).
Run:  python3 test_linked_wallets.py"""
from linked_wallets import *

DAY = 86400
T = 10_000_000
SUPPLY = 1_000_000_000
results = []
def case(n, title, should, fn):
    try:
        ok, text = fn()
    except Exception as e:
        ok, text = False, f"CRASH {type(e).__name__}: {e}"
    results.append(ok)
    print(f"\n{n:>2}. {title}\n    should: {should}\n    did:    {text}\n    {'PASS' if ok else 'FAIL'}")

def old(w, amt, t=T, **kw):   # an established wallet (2 months of history)
    return Recipient(w, amt, t, f"tx-{w}", first_activity=t - 60 * DAY, **kw)

def c1():
    rs = [old(f"Fan{i}", 200_000, T + i) for i in range(40)]          # 0.02% each
    r = GroupResult(); classify_handoffs(rs, SUPPLY, 50_000_000, r)
    return (not r.linked and len(r.airdrops) == 1 and r.airdrops[0]["recipients"] == 40,
            f"linked {len(r.linked)}; airdrops {r.airdrops[0]['recipients'] if r.airdrops else 0} wallets")
case(1, "Dev airdrops small amounts to 40 established community wallets",
     "an airdrop: incentive context, nobody linked (unlike bubblemap-style bundling)", c1)

def c2():
    rs = [Recipient("SideWallet", 80_000_000, T, "tx-side", first_activity=T - 2 * DAY)]   # 8% to a 2-day-old wallet
    r = GroupResult(); classify_handoffs(rs, SUPPLY, 100_000_000, r)
    return ("SideWallet" in r.linked and "fresh" in r.linked["SideWallet"][0], f"linked: {r.linked}")
case(2, "Dev moves 8% of supply to a 2-day-old wallet", "bag handoff: linked, with the transfer as receipt", c2)

def c3():
    rs = [old("OldWhale", 30_000_000, sold_within_24h_share=0.9)]
    r = GroupResult(); classify_handoffs(rs, SUPPLY, 100_000_000, r)
    return ("OldWhale" in r.linked and "sold half+" in r.linked["OldWhale"][0], f"linked: {r.linked}")
case(3, "Dev hands 3% to an old wallet that dumps it within a day", "bag handoff (fast seller): linked", c3)

def c4():
    rs = [old("Partner", 15_000_000, sold_within_24h_share=0.0)]
    r = GroupResult(); classify_handoffs(rs, SUPPLY, 100_000_000, r)
    return (not r.linked and len(r.context) == 1, f"linked {len(r.linked)}; context {r.context}")
case(4, "Dev sends 1.5% to an established wallet that keeps holding", "in between: shown as context, not linked", c4)

def c5():
    rs = [Recipient(f"Fresh{i}", 300_000, T + i, f"tx{i}", first_activity=T - DAY, sold_within_1h_share=1.0) for i in range(12)]
    r = GroupResult(); classify_handoffs(rs, SUPPLY, 50_000_000, r)
    return (len(r.linked) == 12 and any("disguised" in f for f in r.flags), f"linked {len(r.linked)}; flags {r.flags}")
case(5, "'Airdrop' to 12 fresh wallets that all dump within the hour", "disguised handoff: flagged, all 12 linked", c5)

def c6():
    r = GroupResult()
    classify_bundles(500, [{"wallet": "Bundler", "slot": 500, "t": T, "signature": "b1"},
                           {"wallet": "NormalBuyer", "slot": 503, "t": T + 1, "signature": "b2"}], "Dev", set(), r)
    return (list(r.linked) == ["Bundler"], f"linked: {list(r.linked)}")
case(6, "One wallet buys in the same block as creation, another two blocks later", "only the same-block buyer is linked", c6)

def c7():
    r = GroupResult()
    buys = [{"wallet": "Sniper", "slot": 510, "t": T + 20, "signature": "s1"},
            {"wallet": "LateFriend", "slot": 900, "t": T + 600, "signature": "s2"}]
    sol = [{"to": "Sniper", "t": T - 3600, "signature": "f1"}, {"to": "LateFriend", "t": T - 3600, "signature": "f2"}]
    classify_snipers(T, buys, sol, "Dev", set(), r)
    return (list(r.linked) == ["Sniper"], f"linked: {list(r.linked)}")
case(7, "Dev funds two wallets an hour before launch; one buys at 20 s, one at 10 min",
     "only the first-minute buyer is a funded sniper", c7)

def c8():
    r = GroupResult()
    classify_bundles(500, [{"wallet": "StonkFunCollector", "slot": 500, "t": T, "signature": "x"}], "Dev", {"StonkFunCollector"}, r)
    rs = [Recipient("ExchangeHot", 90_000_000, T, "tx", first_activity=T - DAY, excluded=True)]
    classify_handoffs(rs, SUPPLY, 100_000_000, r)
    return (not r.linked, f"linked: {r.linked}")
case(8, "Exchange and verified launchpad wallets", "never linked, whatever they do", c8)

def c9():
    import scan_c, urllib.request
    class H: key = "x"; calls = 0
    real = urllib.request.urlopen
    urllib.request.urlopen = lambda *a, **k: (_ for _ in ()).throw(OSError("network down"))
    scan_c.time.sleep = lambda s: None
    try:
        out = scan_c.parse(H(), ["sigA", "sigB"])
    finally:
        urllib.request.urlopen = real
    return (out is None, f"parse result when Helius can't be reached: {out!r}")
case(9, "Helius can't be reached while reading a dev's history",
     "the read is reported as FAILED (None), never as an empty history that looks like 'never bought'", c9)

print(f"\n{sum(results)}/{len(results)} passed")
raise SystemExit(0 if all(results) else 1)
