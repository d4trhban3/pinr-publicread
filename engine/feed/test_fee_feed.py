"""The transfer fee in the feed: one fact `transfer_fee` in
percent with `fee_kind`, `program` and `standard_pct`, each with source, read_at and link (K2), or not written; nothing
at the top level. Plain-English tests on made-up results. Reads nothing live, writes nothing. Run:  python3 test_fee_feed.py"""
import json, os, sys
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import feed_export as F

results = []
def case(n, title, should, fn):
    try:
        ok, text = fn()
    except Exception as e:
        ok, text = False, f"CRASH {type(e).__name__}: {e}"
    results.append(ok)
    print(f"\n{n:>2}. {title}\n    should: {should}\n    did:    {text}\n    {'PASS' if ok else 'FAIL'}")

MINT = "So1aNaMadeUpMintAddress1111111111111pump"
T = "2026-10-17T18:00:00+00:00"
PROGRAM = "StonkFun reward mode"

def receipt(what, value, unit, source, slot=77):
    return {"what": what, "value": value, "unit": unit, "source": source, "as_of": f"slot {slot}"}

def result(fee=None, receipts=()):
    o = {"mint": MINT, "venue": "LaunchLab curve", "platform": "StonkFun (reward mode)", "creator": "Dev111", "score": 61,
         "display": "61", "coverage": 0.8, "label": None, "readings": {}, "flags": [], "notes": [], "receipts": list(receipts)}
    if fee is not None:
        o["transfer_fee"] = fee
    return o

def fee_of(kind, bps, program=None, standard=None, basis="settings", links=None):
    return {"fee_bps": bps, "pct": bps / 100, "fee_kind": kind, "program": program, "standard_pct": standard, "standard_basis": basis if standard is not None else None,
            "standard_links": links, "rates_pct": None, "authority": "A" * 32, "words": ""}

def fact(o):
    return next((f for f in F.facts_for(o, {}, T) if f["id"] == "transfer_fee"), None)

FEE_RECEIPT = receipt("transfer fee", 100, "bps", "getAccountInfo (Token-2022 transfer-fee extension)")


def t1():
    o = result(fee_of("rewards_standard", 100, PROGRAM, 1.0), [FEE_RECEIPT])
    f = fact(o); rec = F.to_feed(o, {}) or {}
    ok = (f and f["value"] == 1.0 and f["unit"] == "percent" and f["fee_kind"] == "rewards_standard" and f["program"] == PROGRAM and f["standard_pct"] == 1.0
          and f["standard_basis"] == "settings" and "standard_links" not in f
          and f["source"] == "Solana chain" and MINT in f["link"] and f["read_at"] and "transfer_fee_bps" not in rec and "fee_rewards_program" not in rec)
    return bool(ok), f"one fact: {dict((k, f[k]) for k in ('value', 'unit', 'fee_kind', 'program', 'standard_pct', 'standard_basis')) if f else None}; source/read_at/link present; nothing at the top level"
case(1, "A rewards fee at the standard is one fact in the site's shape (X1, X2)", "value 1 percent, fee_kind rewards_standard, program, standard_pct with standard_basis 'settings' and no links, with source, read_at and link; no top-level fields", t1)

def t2():
    o = result(fee_of("none", 0), [receipt("transfer fee", 0, "bps", "getAccountInfo (none means no fee)")])
    f = fact(o)
    return f and f["value"] == 0 and f["fee_kind"] == "none" and "program" not in f and "standard_pct" not in f, f"{dict((k, f[k]) for k in ('value', 'fee_kind')) if f else None}; no program, no standard"
case(2, "No fee: value 0, kind 'none', no program", "the fact is written (read, and no fee), with nothing a 'none' must not carry", t2)

def t3():
    o = result(fee_of("outside_norm", 300, PROGRAM, 1.0), [FEE_RECEIPT])
    f = fact(o)
    o2 = result(fee_of("outside_norm", 250), [FEE_RECEIPT])
    g = fact(o2)
    return (f and f["fee_kind"] == "outside_norm" and f["program"] == PROGRAM and f["standard_pct"] == 1.0 and f["standard_basis"] == "settings" and f["value"] == 3.0
            and g and g["fee_kind"] == "outside_norm" and "program" not in g and "standard_pct" not in g and "standard_basis" not in g), f"a program's fee above its standard: {f and (f['value'], f['program'], f['standard_pct'], f['standard_basis'])}; a fee that is nobody's program: {g and (g['value'], 'program' in g)}"
case(3, "Outside the norm: above a program's standard carries the program and its rate; a non-program fee carries neither", "3% above StonkFun's 1%: program and standard_pct; 2.5% not a program's: neither", t3)

def t4():
    o = result(fee_of("standard_unknown", 300, PROGRAM), [FEE_RECEIPT])
    f = fact(o)
    return f and f["fee_kind"] == "standard_unknown" and f["program"] == PROGRAM and "standard_pct" not in f and f["value"] == 3.0, f"{dict((k, f.get(k)) for k in ('value', 'fee_kind', 'program', 'standard_pct')) if f else None}"
case(4, "A rewards fee whose standard was not read is its own state (U1)", "fee_kind standard_unknown with the program and no standard_pct: never a guessed rate", t4)

def t5():
    no_receipt = fact(result(fee_of("rewards_standard", 100, PROGRAM, 1.0), []))
    no_reading = fact(result(None, [FEE_RECEIPT]))
    bad_kind = fact(result(fee_of("rewards_standard", 0, PROGRAM, 1.0), [FEE_RECEIPT]))          # a kind that disagrees with its value
    odd_kind = fact(result(fee_of("something_else", 100, PROGRAM, 1.0), [FEE_RECEIPT]))
    rec = F.to_feed(result(None, [FEE_RECEIPT]), {}) or {}
    return no_receipt is None and no_reading is None and bad_kind is None and odd_kind is None and "transfer_fee_bps" not in rec, \
        f"no receipt: {no_receipt}; no reading: {no_reading}; kind disagreeing with value: {bad_kind}; unknown kind: {odd_kind}"
case(5, "No receipt, no reading, or fields that disagree: no fact (K2 and the contract's dash rule)", "nothing is written that the site would have to show as a dash", t5)

def t6():
    links = [f"https://solscan.io/token/Mint{i}" for i in range(3)]
    o = result(fee_of("rewards_standard", 100, PROGRAM, 1.0, basis="observed", links=links), [FEE_RECEIPT])
    f = fact(o)
    no_links = fact(result(fee_of("rewards_standard", 100, PROGRAM, 1.0, basis="observed", links=[]), [FEE_RECEIPT]))
    no_basis = fact(result(dict(fee_of("rewards_standard", 100, PROGRAM, 1.0), standard_basis=None), [FEE_RECEIPT]))
    too_many = fact(result(fee_of("rewards_standard", 100, PROGRAM, 1.0, basis="observed", links=[f"https://x/{i}" for i in range(11)]), [FEE_RECEIPT]))
    return (f and f["standard_basis"] == "observed" and f["standard_links"] == links and no_links is None and no_basis is None and too_many is None), \
        f"observed with 3 links: basis {f and f['standard_basis']}, links {f and len(f['standard_links'])}; observed with no links: {no_links}; a rate with no basis: {no_basis}; 11 links: {too_many}"
case(6, "An observed standard carries its launches as links; a rate without its basis or links is not written (X2)", "observed: standard_basis 'observed' and 1 to 10 https links; without them the fact would disagree with the contract, so it is not written", t6)


COLLECTOR = "5KXDF6QnqhBj72hDtJNkkpFaQVUfbFXNybMsp3DiK6tD"
REASON_RECEIPT = {"what": "fee reason", "value": "no_reason", "unit": "case", "source": f"no reason found: x; the collector's transactions ({COLLECTOR}; 120 read)", "as_of": T}

def t7():
    o = result(fee_of("outside_norm", 500), [FEE_RECEIPT, REASON_RECEIPT])
    ITEMS = [{"kind": "power_held", "power": "mint", "holder": "dev"}, {"kind": "holders_reached", "holders": 3}, {"kind": "no_withdrawal_seen"}]
    o["fee_reason"] = {"case": "no_reason", "recipients": 3, "dev_payouts": {}, "powers_held": ["mint"], "every_power_renounced": False, "why": ["mint held by the dev", "fees reached 3 holder(s) outside the dev group, fewer than 10", "no withdrawal of withheld fees seen"], "items": ITEMS, "words": ""}
    f = fact(o)
    o2 = result(fee_of("outside_norm", 500), [FEE_RECEIPT, dict(REASON_RECEIPT, value="reason_found")])
    o2["fee_reason"] = {"case": "reason_found", "recipients": 41, "dev_payouts": {}, "powers_held": [], "every_power_renounced": True, "why": [], "words": ""}
    g = fact(o2)
    o3 = result(fee_of("outside_norm", 500), [FEE_RECEIPT])                              # no 'fee reason' receipt: no case written
    o3["fee_reason"] = {"case": "reason_found", "recipients": 41, "dev_payouts": {}, "why": []}
    h = fact(o3)
    o4 = result(fee_of("outside_norm", 500), [FEE_RECEIPT, dict(REASON_RECEIPT, value="not_checked")])
    o4["fee_reason"] = {"case": "something_else", "why": []}
    i = fact(o4)
    long = result(fee_of("outside_norm", 500), [FEE_RECEIPT, REASON_RECEIPT])
    long["fee_reason"] = {"case": "no_reason", "why": ["x"] * 40, "items": [{"kind": "power_held", "power": "mint", "holder": "dev"}] * 40 + ["a string, not an item", {"no": "kind"}], "words": ""}
    lf = fact(long)
    words_only = result(fee_of("outside_norm", 500), [FEE_RECEIPT, REASON_RECEIPT]); words_only["fee_reason"] = {"case": "no_reason", "why": ["mint held by the dev"], "words": ""}
    wf = fact(words_only)
    return (f and f["fee_case"] == "no_reason" and f["reason_why"] == ITEMS and "holders_paid" not in f and "fewer" not in json.dumps(f["reason_why"])
            and lf and len(lf["reason_why"]) == 40 and all(it["kind"] == "power_held" for it in lf["reason_why"])
            and wf and "reason_why" not in wf
            and g and g["fee_case"] == "reason_found" and g["holders_paid"] == 41 and "reason_why" not in g
            and h and "fee_case" not in h and i and "fee_case" not in i), \
        f"no reason: fee_case {f and f.get('fee_case')}, reason_why {f and f.get('reason_why')!r} (the site's coded items, T1; 40 items -> {lf and len(lf['reason_why'])} kept, nothing cut, a string and a kindless entry dropped; words alone write no reason_why: {wf and 'reason_why' not in wf}); reason found: {g and g.get('fee_case')}, holders_paid {g and g.get('holders_paid')}; no receipt: fee_case written {bool(h and 'fee_case' in h)}; an unknown case: written {bool(i and 'fee_case' in i)}"
case(7, "a design decision, T1: the fact carries which case applied (fee_case), the reasons as the site's coded items when none was found, the holders paid when one was", "fee_case no_reason with reason_why as the coded items (every one, no cut, no starting value; only dicts with a kind); reason_found with holders_paid; nothing without the 'fee reason' receipt or with an unknown case", t7)

def t8():
    DEV1, DEV2 = "Dev1" + "1" * 36, "Dev2" + "2" * 36
    pay = {"what": "fees paid to the dev group", "value": {DEV1: 2, DEV2: 1}, "unit": "wallet -> transfers from the fee collector", "source": f"the collector's transactions ({COLLECTOR}; 120 read)", "as_of": T}
    o = result(fee_of("outside_norm", 500), [FEE_RECEIPT, REASON_RECEIPT, pay])
    o["fee_reason"] = {"case": "no_reason", "recipients": 12, "dev_payouts": {DEV1: 2, DEV2: 1}, "why": ["fees paid to the dev group (2 wallet(s), 3 transfer(s))"], "words": ""}
    facts = F.facts_for(o, {}, T)
    d = next((x for x in facts if x["id"] == "fee_dev_payouts"), None)
    o2 = result(fee_of("outside_norm", 500), [FEE_RECEIPT, REASON_RECEIPT]); o2["fee_reason"] = {"case": "no_reason", "dev_payouts": {DEV1: 2}, "why": []}
    none = next((x for x in F.facts_for(o2, {}, T) if x["id"] == "fee_dev_payouts"), None)
    o3 = result(fee_of("outside_norm", 500), [FEE_RECEIPT, REASON_RECEIPT, pay]); o3["fee_reason"] = {"case": "reason_found", "dev_payouts": {}, "why": []}
    empty = next((x for x in F.facts_for(o3, {}, T) if x["id"] == "fee_dev_payouts"), None)
    return (d and d["value"] == 3 and d["unit"] == "transfers" and d["wallets"] == [DEV1, DEV2] and d["source"] == "Solana chain" and d["link"].endswith(COLLECTOR) and d["read_at"]
            and none is None and empty is None), \
        f"fact: value {d and d['value']} {d and d['unit']}, wallets {d and len(d['wallets'])}, link to the collector {bool(d and d['link'].endswith(COLLECTOR))}; without its receipt: {none}; no payouts: {empty}"
case(8, "fees paid to the dev group are a fact of their own, with the collector as the receipt's link", "fee_dev_payouts: the transfers, the wallets, source, read_at and the collector's link; not written without its receipt or without payouts", t8)

print(f"\n{sum(results)}/{len(results)} passed")
sys.exit(0 if all(results) else 1)
