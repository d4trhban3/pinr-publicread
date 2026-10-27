"""Dev-history logic: plain-English tests with made-up wallets and transactions (no network).
Run:  python3 test_dev_history.py"""
from dev_history import launches, duplicates, conduct, conduct_from_balances, first_funding

DEV, POOL, FRIEND, CEX = "DevWallet111", "PoolAccount222", "FriendWallet333", "ExchangeHot444"
T0 = 1_000_000

def create(mint, ts, payer=DEV):
    return {"type": "CREATE", "source": "PUMP_FUN", "feePayer": payer, "timestamp": ts, "signature": f"create-{mint}",
            "tokenTransfers": [{"mint": mint, "fromUserAccount": "", "toUserAccount": POOL, "tokenAmount": 1e9}]}

def move(mint, ts, frm, to, amt, kind="SWAP"):
    return {"type": kind, "feePayer": DEV, "timestamp": ts, "signature": f"{kind}-{mint}-{ts}",
            "tokenTransfers": [{"mint": mint, "fromUserAccount": frm, "toUserAccount": to, "tokenAmount": amt}]}

results = []
def case(n, title, should, fn):
    try:
        ok, text = fn()
    except Exception as e:
        ok, text = False, f"CRASH {type(e).__name__}: {e}"
    results.append(ok)
    print(f"\n{n:>2}. {title}\n    should: {should}\n    did:    {text}\n    {'PASS' if ok else 'FAIL'}")

def c1():
    txs = [create("MintA", T0), create("MintB", T0 + 3000), create("MintC", T0 + 9000, payer=FRIEND)]
    ls = launches(txs, DEV)
    return ([l["mint"] for l in ls] == ["MintA", "MintB"], f"launches found: {[l['mint'] for l in ls]}")
case(1, "Dev created two tokens; a third was created by someone else", "counts only the dev's own two", c1)

def c2():
    ls = [{"mint": "MintA"}, {"mint": "MintB"}, {"mint": "MintC"}]
    meta = {"MintA": {"name": "Scarecrow", "symbol": "SCROW"}, "MintB": {"name": "scarecrow ", "symbol": "SCROW"},
            "MintC": {"name": "Other", "symbol": "OTH"}}
    d = duplicates(ls, meta)
    return (d == [["MintA", "MintB"]], f"duplicate groups: {d}")
case(2, "Dev relaunched the same name and symbol", "flags the pair as a duplicate launch", c2)

def c3():
    txs = [move("MintA", T0 + 2, POOL, DEV, 100), move("MintA", T0 + 60, DEV, POOL, 100)]
    c = conduct(txs, DEV, "MintA", T0)
    return (c["pct_out_5m"] == 1.0 and c["pct_out_1h"] == 1.0, f"sold by 5 min {c['pct_out_5m']:.0%}, by 1 h {c['pct_out_1h']:.0%}")
case(3, "Dev buys at launch and dumps everything a minute later", "100% out within 5 minutes", c3)

def c4():
    txs = [move("MintA", T0 + 2, POOL, DEV, 100), move("MintA", T0 + 6325, DEV, POOL, 100)]
    c = conduct(txs, DEV, "MintA", T0)
    return (c["pct_out_5m"] == 0 and c["pct_out_1h"] == 0 and c["pct_out_24h"] == 1.0,
            f"5 min {c['pct_out_5m']:.0%}, 1 h {c['pct_out_1h']:.0%}, 24 h {c['pct_out_24h']:.0%}")
case(4, "Dev sells everything after 1 h 45 min (the SCROW pattern)", "0% by 5 min and 1 h, 100% by 24 h", c4)

def c5():
    txs = [move("MintA", T0 + 2, POOL, DEV, 100), move("MintA", T0 + 600, DEV, POOL, 25), move("MintA", T0 + 900, POOL, DEV, 50)]
    c = conduct(txs, DEV, "MintA", T0)
    return (c["acquired"] == 150 and abs(c["pct_out_1h"] - 25 / 150) < 1e-9, f"acquired {c['acquired']:g}, out by 1 h {c['pct_out_1h']:.0%}")
case(5, "Dev sells a quarter, then buys more", "share sold is measured against everything acquired (17%)", c5)

def c6():
    c = conduct([], DEV, "MintA", T0)
    return (c["never_bought"] and c["pct_out_5m"] is None, f"never bought: {c['never_bought']}, % sold: {c['pct_out_5m']}")
case(6, "Dev never bought their own token", "never-bought is recorded; % sold stays missing, not 0", c6)

def c7():
    txs = [move("MintA", T0 + 2, POOL, DEV, 100), move("MintA", T0 + 30, DEV, FRIEND, 100, kind="TRANSFER")]
    c = conduct(txs, DEV, "MintA", T0)
    return (c["pct_out_5m"] == 1.0 and c["moves"][1]["counterparty"] == FRIEND,
            f"moved out {c['pct_out_5m']:.0%} to {c['moves'][1]['counterparty']} (kept as a lead for linked-wallet tracing)")
case(7, "Dev quietly moves the whole bag to another wallet", "counts as leaving the dev wallet, recipient recorded", c7)

def c8():
    txs = [{"timestamp": T0 + 50, "signature": "s2", "nativeTransfers": [{"fromUserAccount": FRIEND, "toUserAccount": DEV, "amount": 2e9}]},
           {"timestamp": T0, "signature": "s1", "nativeTransfers": [{"fromUserAccount": CEX, "toUserAccount": DEV, "amount": 5.5e9}]}]
    a = first_funding(txs, DEV, True); b = first_funding(txs, DEV, False)
    return (a["from"] == CEX and a["sol"] == 5.5 and b is None, f"full history -> {a['from']} {a['sol']} SOL; partial history -> {b}")
case(8, "Finding where the dev's money first came from", "oldest incoming SOL; refuses to answer from a partial history", c8)

def bal(ts, delta, label="TRANSFER", sig=None):
    return {"type": label, "timestamp": ts, "signature": sig or f"b{ts}",
            "accountData": [{"tokenBalanceChanges": [{"userAccount": DEV, "mint": "MintA",
                             "rawTokenAmount": {"tokenAmount": str(int(delta * 10**6)), "decimals": 6}}]}],
            "tokenTransfers": [{"mint": "MintA", "fromUserAccount": "Someone", "toUserAccount": "SomeoneElse", "tokenAmount": abs(delta)}]}

def c9():
    txs = [bal(T0, 793_100_000, "CREATE")] + [bal(T0 + 23 + i, -2_884_000, "SWAP") for i in range(5)] + [bal(T0 + 600, -778_680_000, "SWAP")]
    c = conduct_from_balances(txs, DEV, "MintA", T0)
    return (abs(c["acquired"] - 793_100_000) < 1 and c["pct_out_1h"] > 0.999 and c["pct_out_5m"] < 0.02,
            f"acquired {c['acquired']:,.0f}; out by 5 min {c['pct_out_5m']:.1%}, by 1 h {c['pct_out_1h']:.0%}")
case(9, "Transfer labels name the wrong wallets, but the dev's balance tells the truth",
     "conduct is measured from the dev's real balance changes, not from the labels", c9)

print(f"\n{sum(results)}/{len(results)} passed")
raise SystemExit(0 if all(results) else 1)
