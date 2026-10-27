"""The reason behind a fee outside the norm: plain-English tests on made-up
collectors, transactions, powers and dev groups. the team's H1 and H2 rulings: the six cases; the collector's coins traced from
its withdrawals of withheld fees; coin payouts out of those only; SOL/quote only from selling them into a pool; each recipient's
balance BEFORE the payout; the dev group kept out; the read stopped at ten; the five powers; "not checked yet"; the ceiling tiers. Reads no chain, touches no
live file. Run:  python3 test_fee_reason.py"""
import json, os, sys
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE); sys.path.insert(0, os.path.join(HERE, "..", "pinr-index"))
import readers as R
import score_engine_v1 as E
from b58 import b58e, b58d, oc, pda

results = []
def case(n, title, should, fn):
    try:
        ok, text = fn()
    except Exception as e:
        ok, text = False, f"CRASH {type(e).__name__}: {e}"
    results.append(ok)
    print(f"\n{n:>2}. {title}\n    should: {should}\n    did:    {text}\n    {'PASS' if ok else 'FAIL'}")

def wallets(n, start=1):
    """n distinct addresses on the ed25519 curve (people's wallets)."""
    out, i = [], start
    while len(out) < n:
        b = bytes([i % 256, (i // 256) % 256]) * 16
        if oc(b):
            out.append(b58e(b))
        i += 1
    return out

COLLECTOR, DEV, LINKED, *HOLDERS = wallets(40)
POOL = pda([b"pool", b"x"], R.LAUNCHLAB)                      # a program account: off the curve
assert not oc(__import__("b58").b58d(POOL))

MINT, QUOTE, OTHER_COIN = (b58e(bytes([i]) * 32) for i in (90, 91, 92))        # real base58 addresses (the default readers derive from them)
_T = [1760000000]
def _tx(sig, tt=(), nt=(), sol_change=0, coin_change=0.0):
    """One of the collector's transactions in the parsed shape: token moves, SOL moves, and the collector's own balance changes."""
    _T[0] += 1
    return {"signature": sig, "timestamp": _T[0], "tokenTransfers": list(tt), "nativeTransfers": list(nt),
            "accountData": [{"account": COLLECTOR, "nativeBalanceChange": int(sol_change), "tokenBalanceChanges":
                             ([{"mint": MINT, "userAccount": COLLECTOR, "tokenAccount": "ata", "rawTokenAmount": {"tokenAmount": str(int(coin_change * 10 ** 6)), "decimals": 6}}] if coin_change else [])}]}
def move(a, b, amount=5.0, mint=None):
    return {"fromUserAccount": a, "toUserAccount": b, "mint": mint or MINT, "tokenAmount": amount}
WD_INSTR = {"programId": R.TOKEN_2022, "program": "spl-token-2022", "type": "withdrawWithheldTokensFromAccounts", "mint": None}
def withdraw(amount, sig="wd", instr=None):
    """The collector withdraws this mint's withheld fees: Token-2022's withdraw-withheld instruction for this mint, its balance rising."""
    t = _tx(sig, coin_change=amount); t["instructions"] = [dict(WD_INSTR, mint=MINT) if instr is None else instr]; return t
def helius_withdraw_instr(mint=None):
    """Helius's shape of the same instruction: the program, the accounts (the mint first) and the raw bytes (26, 3)."""
    return {"programId": R.TOKEN_2022, "accounts": [mint or MINT, COLLECTOR], "data": b58e(bytes([26, 3])), "innerInstructions": []}
def minted(amount, listed=True, sig="mint"):
    """Coins MINTED to the collector: in Helius's shape a transfer from nobody; in the rebuild's a mintTo instruction and no transfer."""
    t = _tx(sig, tt=[{"fromUserAccount": "", "toUserAccount": COLLECTOR, "mint": MINT, "tokenAmount": amount}] if listed else [], coin_change=amount)
    t["instructions"] = [{"programId": R.TOKEN_2022, "program": "spl-token-2022", "type": "mintTo", "mint": MINT, "amount": str(int(amount * 10 ** 6))}]
    return t
def gift(frm, amount, sig="gift"):
    return _tx(sig, tt=[move(frm, COLLECTOR, amount)], coin_change=amount)
def buy(amount, lamports, sig="buy"):
    return _tx(sig, tt=[move(POOL, COLLECTOR, amount)], sol_change=-lamports, coin_change=amount)
def sale(coins, lamports=0, quote=0.0, sig="sale", to=None, pool_out=None, extra_sol=0):
    """The collector sells the coin into the pool: the coin out to the pool (or `to`), SOL and/or the quote coin back; the pool's
    own output is in its accounts' balance changes (`pool_out` lamports, default = what the collector got); `extra_sol` = SOL
    arriving from elsewhere in the same transaction."""
    dest = to or POOL
    tt = [move(COLLECTOR, dest, coins)] + ([move(POOL, COLLECTOR, quote, QUOTE)] if quote else [])
    t = _tx(sig, tt=tt, sol_change=lamports + extra_sol, coin_change=-coins)
    t["accountData"].append({"account": POOL, "nativeBalanceChange": -(lamports if pool_out is None else pool_out),
                             "tokenBalanceChanges": [{"mint": QUOTE, "userAccount": POOL, "tokenAccount": "poolvault", "rawTokenAmount": {"tokenAmount": str(-int(quote * 10 ** 6)), "decimals": 6}}] if quote else []})
    return t
def pay_coin(w, amount=5.0, sig=None):
    return _tx(sig or f"pc{w[:4]}", tt=[move(COLLECTOR, w, amount)], coin_change=-amount)
def pay_sol(w, lamports=10_000_000, sig=None):
    return _tx(sig or f"ps{w[:4]}", nt=[{"fromUserAccount": COLLECTOR, "toUserAccount": w, "amount": lamports}], sol_change=-lamports)
def pay_quote(w, amount=1.0, sig=None):
    return _tx(sig or f"pq{w[:4]}", tt=[move(COLLECTOR, w, amount, QUOTE)])
def payouts_to(recipients, amount=5.0):
    return [pay_coin(w, amount) for w in recipients]

PRE = {}                                                         # wallet -> balance of the coin before a payout (default 1.0: a holder)
READS = []                                                       # which balance reads were made
def pre_balance(sig, w):
    READS.append(("pre", w)); return PRE.get(w, 1.0)
def before(w, ts):
    READS.append(("before", w)); return PRE.get(w, 1.0)

def mint(collector=COLLECTOR):
    return {"mint": MINT, "decimals": 6, "transfer_fee_bps": 500, "withdraw_withheld_authority": collector}

def fee(kind="outside_norm", pct=5.0, standard=None):
    return {"fee_bps": int(pct * 100), "pct": pct, "fee_kind": kind, "standard_pct": standard, "program": "P" if standard else None}

RENOUNCED = {"mint": "renounced", "freeze": "renounced", "transfer_fee_config": "verified_launchpad_wallet", "metadata_update": "renounced"}

def reason(fee_, history, holders=RENOUNCED, devs=(DEV, LINKED), m=None):
    log = R.Log(); PRE.clear(); READS.clear()
    r = R.fee_reason(fee_, m or mint(), holders, set(devs), log, history=history, mint=MINT, quote_mints=(QUOTE,), pre_balance=pre_balance, before=before, pool_accounts=(POOL,))
    return r, log

def pay(txs, devs=(DEV, LINKED), need=10, pools=(POOL,)):
    READS.clear()
    return R.collector_payouts(txs, COLLECTOR, MINT, (QUOTE,), set(devs), need, pre_balance=pre_balance, before=before, pool_accounts=pools, decimals=6)

def t1():
    r1, l1 = reason(None, lambda a: ([], True))
    r2, l2 = reason(fee("rewards_standard", 1.0, 3.0), lambda a: (_ for _ in ()).throw(AssertionError("must not read")))
    r3, l3 = reason(fee("standard_unknown", 3.0), lambda a: (_ for _ in ()).throw(AssertionError("must not read")))
    r0, l0 = reason({"fee_bps": 0, "pct": 0, "fee_kind": "none"}, lambda a: (_ for _ in ()).throw(AssertionError("must not read")))
    ok = r1["case"] == "none" and r0["case"] == "none" and r2["case"] == "rewards_standard" and r3["case"] == "standard_unknown" and all(any(x["what"] == "fee reason" for x in l.items) for l in (l1, l2, l3, l0))
    return ok, f"no fee / mint unread: {r1['case']}, {r0['case']}; rewards at its standard: {r2['case']} (no history read); standard unknown: {r3['case']}; a 'fee reason' receipt on each"
case(1, "Case 1 and no fee: shown, never scored, no collector read", "none, rewards_standard and standard_unknown pass straight through with a receipt; the collector's history is not read", t1)

def t2():
    r, log = reason(fee(), lambda a: ([withdraw(100)] + payouts_to(HOLDERS[:12]), False))
    rc = next(x for x in log.items if x["what"] == "fee reason")
    return r["case"] == "reason_found" and r["recipients"] == 10 and r["dev_payouts"] == {} and r["every_power_renounced"] and len(r["signatures"]) == 10 and "stopped at 10" in rc["source"] and "100 of the coin withdrawn" in rc["source"], \
        f"{r['case']}: {r['recipients']} holders (stopped at 10 of the 12 paid), dev payouts {r['dev_payouts']}; receipt: …{rc['source'][rc['source'].find('stopped'):][:60]}"
case(2, "Case 3, reason found: withheld fees withdrawn, the coin paid to twelve holders, reading stopped at ten", "reason_found with 10 holders, the receipt saying the read stopped and how much was withdrawn", t2)

def t3():
    r, log = reason(fee(), lambda a: ([withdraw(100)] + payouts_to(HOLDERS[:9]) + [pay_coin(LINKED), pay_coin(LINKED, sig="l2"), pay_coin(DEV)], False))
    rc = next((x for x in log.items if x["what"] == "fees paid to the dev group"), None)
    return r["case"] == "no_reason" and r["dev_payouts"] == {LINKED: 2, DEV: 1} and r["recipients"] == 9 and rc and rc["value"] == {LINKED: 2, DEV: 1} and COLLECTOR in rc["source"] and "dev group" in r["why"][0], \
        f"{r['case']}: dev payouts {dict((k[:6], v) for k, v in r['dev_payouts'].items())}, holders outside the group {r['recipients']}; why: {r['why'][0][:60]}…; the receipt names the collector: {COLLECTOR in (rc or {}).get('source', '')}"
case(3, "Payouts to the dev group: no reason, a fact of its own with its receipt, and they never count as holders", "no_reason naming the dev-group payouts (a linked wallet twice, the dev once); 9 holders outside", t3)

def t4():
    r, _ = reason(fee(), lambda a: ([withdraw(100)] + payouts_to(HOLDERS[:9]), True))
    return r["case"] == "no_reason" and "9 holder(s)" in r["why"][0] and "fewer than 10" in r["why"][0], f"{r['case']}: {r['why'][0][:110]}"
case(4, "Too few holders paid: no reason", "9 holders is under the starting line of 10", t4)

def t5():
    held = dict(RENOUNCED, mint="dev_or_linked", freeze="unexplained_wallet")
    r, _ = reason(fee(), lambda a: ([withdraw(100)] + payouts_to(HOLDERS[:12]), False), holders=held)
    meta_only = dict(RENOUNCED, metadata_update="dev_or_linked")
    r2, _ = reason(fee(), lambda a: ([withdraw(100)] + payouts_to(HOLDERS[:12]), False), holders=meta_only)
    return (r["case"] == "no_reason" and r["powers_held"] == ["freeze", "mint"] and not r["every_power_renounced"]
            and r2["case"] == "reason_found" and r2["every_power_renounced"] and r2["powers_held"] == []), \
        f"mint and freeze held: {r['case']}, powers held {r['powers_held']}; only metadata held: {r2['case']} (not one of the five), every power renounced {r2['every_power_renounced']}"
case(5, "The five powers: mint, freeze, pause, permanent delegate, fee-rate control; metadata is not one of them, for the reason or the ceiling tier", "a held mint or freeze means no reason and the lower ceiling tier; a held metadata power alone allows a reason and counts as every power renounced for the fee ceiling", t5)

def t6():
    r1, l1 = reason(fee(), lambda a: ([], False))
    r2, _ = reason(fee(), lambda a: (None, False))
    r3, _ = reason(fee(), lambda a: (_ for _ in ()).throw(OSError("node down")))
    r4, _ = reason(fee(), lambda a: ([], True))
    rc = next(x for x in l1.items if x["what"] == "fee reason")
    return r1["case"] == r2["case"] == r3["case"] == "not_checked" and r4["case"] == "no_reason" and "follow-up" in rc["source"], \
        f"unreadable three ways: {r1['case']}, {r2['case']}, {r3['case']} (receipt says checked again at the follow-up); read whole and empty: {r4['case']}"
case(6, "Case 5, not checked yet: the collector's history could not be read", "not_checked (counts as no reason; rechecked at the follow-up), never from an empty history that was read whole", t6)

def t7():
    """H2: only coins withdrawn as withheld fees are fee coins."""
    gifted = pay([gift(HOLDERS[20], 100)] + payouts_to(HOLDERS[:12]))
    bought = pay([buy(100, 10 ** 9)] + payouts_to(HOLDERS[:12]))
    over = pay([withdraw(10)] + payouts_to(HOLDERS[:12], 5.0))                        # 10 coins withdrawn pay two holders, not twelve
    none = pay(payouts_to(HOLDERS[:12]))
    return (gifted["holders"] == {} and gifted["other"] == 12 and bought["holders"] == {} and bought["withdrawn"] == 0
            and len(over["holders"]) == 2 and over["other"] == 10 and over["traced_left"] == 0 and none["holders"] == {}), \
        f"a gift passed on: {len(gifted['holders'])} holders ({gifted['other']} moves not fee coins); bought and passed on: {len(bought['holders'])}, withdrawn {bought['withdrawn']}; 10 withdrawn then 60 paid: {len(over['holders'])} holders, {over['other']} beyond the fees; nothing withdrawn: {len(none['holders'])}"
case(7, "H2: coins given to the collector or bought by it are never fee coins; coin payouts count only up to what was withdrawn", "gifts and buys passed on count for nothing; 10 coins withdrawn cover two 5-coin payouts, the other ten are not fee coins", t7)

def t8():
    r, log = reason(fee(), lambda a: (payouts_to(HOLDERS[:12]), False), m=mint(collector=None))
    return r["case"] == "no_reason" and "nobody" in r["why"][0], f"{r['case']}: {r['why']}"
case(8, "No wallet can withdraw the withheld fees: no reason", "no_reason, said plainly", t8)



def t11():
    """Held when paid: the balance BEFORE the payout, from the chain; 0 is not a holder, unread is left out."""
    PRE_ = {HOLDERS[0]: 0.0, HOLDERS[1]: None}
    def pb(sig, w): return PRE_.get(w, 1.0)
    p = R.collector_payouts([withdraw(100)] + payouts_to(HOLDERS[:12]), COLLECTOR, MINT, (QUOTE,), {DEV, LINKED}, 10, pre_balance=pb, before=before)
    return len(p["holders"]) == 10 and p["not_holding"] == 1 and p["unread"] == 1 and HOLDERS[0] not in p["holders"] and HOLDERS[1] not in p["holders"], \
        f"12 paid: one had no balance before (not a holder), one unread (left out): {len(p['holders'])} holders, not holding {p['not_holding']}, unread {p['unread']}"
case(11, "Held when paid: a coin payout's own pre-balance decides; none before is no holder, unread is left out", "10 holders of 12 paid; the two others named in the counts", t11)

def t12():
    """SOL and quote payouts: only out of selling the traced coins into the pool; outside SOL never."""
    txs = [withdraw(100), sale(100, lamports=10 ** 9, quote=50.0)] + [pay_sol(w, 100_000_000) for w in HOLDERS[:12]] + [pay_quote(w, 5.0) for w in HOLDERS[12:24]]
    p = pay(txs, need=100)
    half = pay([withdraw(50), gift(HOLDERS[25], 50), sale(100, lamports=10 ** 9)] + [pay_sol(w, 100_000_000) for w in HOLDERS[:12]], need=100)
    outside = pay([withdraw(100), _tx("in", nt=[{"fromUserAccount": HOLDERS[26], "toUserAccount": COLLECTOR, "amount": 10 ** 9}], sol_change=10 ** 9)] + [pay_sol(w, 100_000_000) for w in HOLDERS[:12]], need=100)
    to_person = pay([withdraw(100), _tx("p2p", tt=[move(COLLECTOR, HOLDERS[27], 100)], sol_change=10 ** 9, coin_change=-100)] + [pay_sol(w, 100_000_000) for w in HOLDERS[:12]], need=100)
    return (len(p["holders"]) == 20 and p["other"] == 4 and abs(p["budget_left"].get("SOL", 0)) < 1e-9
            and len(half["holders"]) == 5 and half["other"] == 7
            and outside["holders"] == {} and outside["other"] == 12
            and len(to_person["holders"]) == 1 and to_person["other"] == 12), \
        f"1 SOL and 50 quote from selling the fees: {len(p['holders'])} holders paid (10 SOL + 10 quote), {p['other']} beyond the budget; half the coins sold were a gift: {len(half['holders'])} SOL payouts count; outside SOL passed on: {len(outside['holders'])}; the coin sent to a person while SOL came in is a payout, not a sale: {len(to_person['holders'])} holder, {to_person['other']} SOL payouts untraced"
case(12, "H2: SOL or the quote coin count only out of selling the withdrawn fees into a pool, by the traced share; outside SOL and sales to people never", "ten SOL and ten quote payouts from one sale; a half-gifted sale funds half; outside SOL funds nothing; a coin-to-person move is no sale", t12)

def t13():
    r, _ = reason(fee(), lambda a: ([withdraw(100)] + payouts_to(HOLDERS[:12]) + [pay_coin(LINKED)], False))
    twice = pay([withdraw(200)] + payouts_to(HOLDERS[:12]) + payouts_to(HOLDERS[:12]), need=100)
    return r["case"] == "reason_found" and r["recipients"] == 10 and r["dev_payouts"] == {} and len(twice["holders"]) == 12 and sum(twice["holders"].values()) == 24, \
        f"ten holders qualified before the linked wallet's payout was reached: {r['case']}, dev payouts {r['dev_payouts']} (the read stopped); each holder paid twice: {len(twice['holders'])} holders, {sum(twice['holders'].values())} payouts"
case(13, "Stop at ten: a dev-group payout after the tenth holder is not reached; a holder counts once however often paid", "reason found with the read stopped; 24 payouts to 12 holders are 12", t13)

def t14():
    p = pay([withdraw(100)] + payouts_to(HOLDERS[:12]))
    return p["stopped"] and len([r for r in READS if r[0] == "pre"]) == 10 and len(p["holders"]) == 10, f"balance reads made: {len(READS)} for {len(p['holders'])} holders, stopped {p['stopped']}"
case(14, "Stop at ten: no balance is read past the tenth holder", "exactly ten reads for ten holders", t14)

def t15():
    """The two default balance readers on the chain's own record, with the chain made up."""
    import solana_rpc as SR
    H = HOLDERS[0]
    raw = {"meta": {"preTokenBalances": [{"owner": H, "mint": MINT, "uiTokenAmount": {"amount": "2500000", "decimals": 6}}],
                    "postTokenBalances": [{"owner": H, "mint": MINT, "uiTokenAmount": {"amount": "7500000", "decimals": 6}}, {"owner": HOLDERS[1], "mint": MINT, "uiTokenAmount": {"amount": "5000000", "decimals": 6}}]}}
    old_raw, old_sigs = SR.fetch_raw, SR.sigs_desc
    SR.fetch_raw = lambda sigs: [raw]
    SR.sigs_desc = lambda addr, limit=None, until=None, max_pages=2: ([{"signature": "newer", "blockTime": 2000}, {"signature": "older", "blockTime": 1000}], True)
    try:
        a = R.pre_balance_in_tx("s", H, MINT); b = R.pre_balance_in_tx("s", HOLDERS[1], MINT); c = R.pre_balance_in_tx("s", HOLDERS[2], MINT)
        d = R.balance_before(H, 1500, MINT)                         # the newest transaction before 1500 is "older": its post-balance 7.5
        SR.sigs_desc = lambda addr, limit=None, until=None, max_pages=2: ([{"signature": "newer", "blockTime": 2000}], True)
        e = R.balance_before(H, 1500, MINT)                         # nothing before 1500 and the whole history read: 0
        SR.sigs_desc = lambda addr, limit=None, until=None, max_pages=2: (None, False)
        f = R.balance_before(H, 1500, MINT)
    finally:
        SR.fetch_raw, SR.sigs_desc = old_raw, old_sigs
    return a == 2.5 and b == 0.0 and c is None and d == 7.5 and e == 0.0 and f is None, f"pre-balance from the transaction: {a}; an account opened by the payout: {b}; a wallet not in it: {c}; before a SOL payout from the account's newest earlier transaction: {d}; no earlier transaction: {e}; unreadable: {f}"
case(15, "The default balance readers: a coin payout's pre-balance from the chain's record; a SOL payout's from the account's newest earlier transaction", "2.5 / 0 (opened by the payout) / None (not in it); 7.5 / 0 (none before, history whole) / None (unreadable)", t15)

def helius_mint_instr(mint=None, checked=False):
    return {"programId": R.TOKEN_2022, "accounts": [mint or MINT, "dest", COLLECTOR], "data": b58e(bytes([14 if checked else 7, 0, 0, 0, 0, 0, 0, 0, 0])), "innerInstructions": []}

def t16():
    """M1 and M1c: withdrawn fees are only coins arriving through Token-2022's withdraw-withheld (or harvest) instruction for this mint;
    a transaction that mints this coin in any form never counts; an undecodable Token-2022 instruction makes it not count."""
    listed = pay([minted(100, listed=True)] + payouts_to(HOLDERS[:12]))
    unlisted = pay([minted(100, listed=False)] + payouts_to(HOLDERS[:12]))
    no_instr = pay([_tx("rise", coin_change=100)] + payouts_to(HOLDERS[:12]))                       # a rise with no instruction at all
    other_mint = pay([withdraw(100, instr=dict(WD_INSTR, mint=OTHER_COIN))] + payouts_to(HOLDERS[:12]))
    helius = pay([withdraw(100, instr=helius_withdraw_instr())] + payouts_to(HOLDERS[:12]))
    helius_other = pay([withdraw(100, instr=helius_withdraw_instr(OTHER_COIN))] + payouts_to(HOLDERS[:12]))
    # M1c: a withdraw beside a mint of this coin, in every form, is no withdrawal at all
    wd_parsed_mint = withdraw(100); wd_parsed_mint["instructions"].append({"programId": R.TOKEN_2022, "program": "spl-token-2022", "type": "mintTo", "mint": MINT, "amount": "5000000"})
    wd_bytes_mint = withdraw(100, instr=helius_withdraw_instr()); wd_bytes_mint["instructions"].append(helius_mint_instr())
    wd_inner_mint = withdraw(100, instr=dict(helius_withdraw_instr(), innerInstructions=[helius_mint_instr(checked=True)]))
    wd_listed_mint = withdraw(100); wd_listed_mint["tokenTransfers"].append({"fromUserAccount": "", "toUserAccount": COLLECTOR, "mint": MINT, "tokenAmount": 40})
    wd_other_coin_mint = withdraw(100, instr=helius_withdraw_instr()); wd_other_coin_mint["instructions"].append(helius_mint_instr(OTHER_COIN))
    cases = [pay([t] + payouts_to(HOLDERS[:12]))["withdrawn"] for t in (wd_parsed_mint, wd_bytes_mint, wd_inner_mint, wd_listed_mint)]
    other_coin_minted = pay([wd_other_coin_mint] + payouts_to(HOLDERS[:12]))["withdrawn"]
    # fail safe: a Token-2022 instruction that cannot be decoded in the candidate transaction
    undecodable = withdraw(100, instr=helius_withdraw_instr()); undecodable["instructions"].append({"programId": R.TOKEN_2022, "accounts": [MINT], "data": "0OIl", "innerInstructions": []})
    no_data = withdraw(100, instr=helius_withdraw_instr()); no_data["instructions"].append({"programId": R.TOKEN_2022, "accounts": [MINT], "data": "", "innerInstructions": []})
    other_prog = withdraw(100, instr=helius_withdraw_instr()); other_prog["instructions"].append({"programId": "SomeOtherProgram11111111111111111111111111", "accounts": [], "data": "0OIl", "innerInstructions": []})
    fails = [pay([t] + payouts_to(HOLDERS[:12]))["withdrawn"] for t in (undecodable, no_data)]
    other_ok = pay([other_prog] + payouts_to(HOLDERS[:12]))["withdrawn"]
    # the cap: the collector's rise less every fall of this coin elsewhere in the same transaction
    capped = withdraw(100); capped["accountData"].append({"account": HOLDERS[20], "nativeBalanceChange": 0, "tokenBalanceChanges": [{"mint": MINT, "userAccount": HOLDERS[20], "tokenAccount": "x", "rawTokenAmount": {"tokenAmount": str(-30 * 10 ** 6), "decimals": 6}}]})
    cap = pay([capped] + payouts_to(HOLDERS[:12]))["withdrawn"]
    return (listed["withdrawn"] == 0 and unlisted["withdrawn"] == 0 and no_instr["withdrawn"] == 0 and other_mint["withdrawn"] == 0 and helius_other["withdrawn"] == 0
            and helius["withdrawn"] == 100 and len(helius["holders"]) == 10 and cases == [0, 0, 0, 0] and other_coin_minted == 100
            and fails == [0, 0] and other_ok == 100 and cap == 70), \
        f"minted, listed / unlisted: {listed['withdrawn']} / {unlisted['withdrawn']}; a bare rise: {no_instr['withdrawn']}; another mint's withdraw (parsed / bytes): {other_mint['withdrawn']} / {helius_other['withdrawn']}; a withdraw in Helius's bytes: {helius['withdrawn']} ({len(helius['holders'])} holders); a withdraw beside a mint of this coin (parsed, bytes, inner bytes, listed from nobody): {cases}; beside a mint of another coin: {other_coin_minted}; an undecodable / empty Token-2022 instruction: {fails}; an undecodable other program's: {other_ok}; 100 up with 30 falling elsewhere: {cap}"
case(16, "M1 and M1c: only the withdraw-withheld instruction for this mint, in either shape; a mint of this coin in any form bars the transaction; undecodable Token-2022 bytes bar it; the amount is capped by the falls the transaction shows", "minted, a bare rise, another mint's withdraw: 0; a real withdraw: 100; a withdraw beside any mint of this coin: 0 (another coin's mint: 100); undecodable or empty Token-2022 data: 0 (another program's: fine); a 100 rise with 30 falling elsewhere: 70", t16)

def t17():
    """M3: a sale is only a swap through this coin's own verified pool; the SOL counted is that pool's own output, at most what the collector got."""
    elsewhere = pay([withdraw(100), sale(100, lamports=10 ** 9, to=pda([b"other", b"x"], R.LAUNCHLAB))] + [pay_sol(w, 100_000_000) for w in HOLDERS[:12]], need=100)
    outside_in = pay([withdraw(100), sale(100, lamports=10 ** 9, extra_sol=10 ** 9)] + [pay_sol(w, 100_000_000) for w in HOLDERS[:12]] + [pay_sol(w, 100_000_000) for w in HOLDERS[12:20]], need=100)
    pool_less = pay([withdraw(100), sale(100, lamports=10 ** 9, pool_out=5 * 10 ** 8)] + [pay_sol(w, 100_000_000) for w in HOLDERS[:12]], need=100)
    no_pools = pay([withdraw(100), sale(100, lamports=10 ** 9)] + [pay_sol(w, 100_000_000) for w in HOLDERS[:12]], need=100, pools=())
    good = pay([withdraw(100), sale(100, lamports=10 ** 9)] + [pay_sol(w, 100_000_000) for w in HOLDERS[:12]], need=100)
    return (elsewhere["holders"] == {} and elsewhere["other"] == 12 and len(outside_in["holders"]) == 10 and outside_in["other"] == 10
            and len(pool_less["holders"]) == 5 and no_pools["holders"] == {} and len(good["holders"]) == 10), \
        f"the coin to another program account with SOL arriving: {len(elsewhere['holders'])} holders ({elsewhere['other']} SOL payouts untraced); 1 SOL from the pool and 1 SOL from outside in the same transaction: {len(outside_in['holders'])} of 20 paid; the pool put out 0.5 of the 1 SOL the collector got: {len(pool_less['holders'])}; no verified pool known: {len(no_pools['holders'])}; a clean sale through the pool: {len(good['holders'])}"
case(17, "M3: a sale counts only through the coin's own verified pool, and only the pool's own output funds payouts", "another program account: nothing; outside SOL in the sale's transaction: only the pool's SOL; the pool's output caps it; no pool known: nothing", t17)

def t18():
    """T1: reason_why is a list of short items, held powers first in the rule's order, each naming the holder,
    then the payout finding; nothing cut; the no-authority case keeps the powers first too."""
    held = dict(RENOUNCED, transfer_fee_config="dev_or_linked", mint="dev_or_linked", freeze="unexplained_wallet", metadata_update="dev_or_linked")
    r, _ = reason(fee(), lambda a: ([withdraw(100)] + payouts_to(HOLDERS[:3]) + [pay_coin(LINKED)], False), holders=held)
    r2, _ = reason(fee(), lambda a: ([], True), holders=held, m=mint(collector=None))
    r3, _ = reason(fee(), lambda a: (payouts_to(HOLDERS[:3]), False))
    ok = (r["why"][:3] == ["mint held by the dev", "freeze held by an unexplained wallet", "fee-rate control held by the dev"]
          and r["why"][3].startswith("fees paid to the dev group: 1 wallet(s), 1 transfer(s)") and r["why"][4].startswith("fees reached 3 holder(s) outside the dev group, fewer than")
          and r["why"][-1] == "100 of the coin withdrawn as withheld fees" and all(len(w) <= 120 for w in r["why"]) and "metadata" not in " ".join(r["why"])
          and r2["why"] == ["mint held by the dev", "freeze held by an unexplained wallet", "fee-rate control held by the dev", "no wallet can withdraw the withheld fees, so they are paid to nobody"]
          and r3["why"][-1] == "no withdrawal of withheld fees seen" and r3["why"][0].startswith("fees reached 0 holder(s)")
          and r["items"] == [{"kind": "power_held", "power": "mint", "holder": "dev"}, {"kind": "power_held", "power": "freeze", "holder": "unexplained"}, {"kind": "power_held", "power": "fee_rate_control", "holder": "dev"},
                             {"kind": "dev_payouts", "wallets": 1, "transfers": 1}, {"kind": "holders_reached", "holders": 3}, {"kind": "withdrawn", "amount": 100.0}]
          and r2["items"][-1] == {"kind": "no_withdraw_authority"} and len(r2["items"]) == 4
          and r3["items"] == [{"kind": "holders_reached", "holders": 0}, {"kind": "not_traced", "transfers": 3}, {"kind": "no_withdrawal_seen"}]
          and not any("fewer" in json.dumps(it) for it in r["items"]) and len(r["items"]) == len(r["why"]))
    return ok, f"words: {r['why']}; coded: {r['items']}; no authority: {r2['items']}; nothing withdrawn: {r3['items']}"
case(18, "T1, the site's contract shape: the findings as words and as coded items alike, the held powers first (power and holder codes, the rule's order, metadata left out), then the payout findings, no starting value in any coded item", "power_held x3, dev_payouts, holders_reached 3, withdrawn 100; no authority: the powers then no_withdraw_authority; nothing withdrawn: holders_reached 0, not_traced 3, no_withdrawal_seen", t18)

print(f"\n{sum(results)}/{len(results)} passed")
sys.exit(0 if all(results) else 1)
