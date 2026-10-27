"""Transfer fees and rewards programs: plain-English tests with made-up
mints, pools and a made-up sample of the program's launches. The fee is shown always; "rewards" needs the verified
authority AND the pool's verified reward mode; the standard is the rate the program's VERIFIED launches agree on, else
unknown; at or below the standard is rewards (B1), above is outside the norm, unknown is its own state (U1). Nothing is
scored here. Reads no chain, touches no live file. Run:  python3 test_fee_fields.py"""
import os, sys
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import readers as R
from b58 import b58e

results = []
def case(n, title, should, fn):
    try:
        ok, text = fn()
    except Exception as e:
        ok, text = False, f"CRASH {type(e).__name__}: {e}"
    results.append(ok)
    print(f"\n{n:>2}. {title}\n    should: {should}\n    did:    {text}\n    {'PASS' if ok else 'FAIL'}")

AUTH = R.STONKFUN_COLLECTOR
DEV = b58e(bytes([5]) * 32)
REWARD = {"name": "StonkFun", "mode": "reward mode", "words": "StonkFun (reward mode)", "verified": True}
STD = {"name": "StonkFun", "mode": "standard mode", "words": "StonkFun (standard mode)", "verified": True}
BONK = {"name": "letsbonk.fun", "mode": None, "words": "letsbonk.fun", "verified": True}
UNKNOWN = {"name": None, "mode": None, "words": "unknown platform", "verified": False}
SAMPLE = [b58e(bytes([30 + i]) * 32) for i in range(10)]
PROGRAM = "StonkFun reward mode"

def mint(fee, auth=AUTH):
    return {"program": R.TOKEN_2022, "decimals": 6, "supply_raw": 10 ** 15, "powers": {}, "transfer_fee_bps": fee, "withdraw_withheld_authority": auth if fee else None}

class Chain:
    """Made-up launches for the sample: each mint's rate, and which are verified reward-mode launches; counts the reads."""
    def __init__(self, rates, verified=None):
        self.rates, self.reads, self.verified = rates, [], verified if verified is not None else set(rates)
    def read(self, m, log):
        self.reads.append(("mint", m)); return mint(self.rates[m]) if m in self.rates else None
    def pool(self, m, log):
        self.reads.append(("pool", m)); return {"platform_config": "PLAT-" + m, "creator": "C" + m[:4]} if m in self.rates else None
    def platform(self, cfg, log):
        return REWARD if cfg[5:] in self.verified else STD

def run(fee, platform, chain=None, auth=AUTH):
    chain = chain or Chain({m: 100 for m in SAMPLE})
    return R.rewards_program(mint(fee, auth), platform, R.Log(), sample=lambda: SAMPLE, read=chain.read, pool=chain.pool, plat=chain.platform), chain

def fresh():
    R._STANDARD.clear()


def t1():
    fresh(); log = R.Log()
    got = R.rewards_program(mint(None), REWARD, log)
    return got["fee_bps"] == 0 and got["fee_kind"] == "none" and got["program"] is None and "transfer fee" in str(vars(log)), f"kind {got['fee_kind']!r}, {got['words']!r}, receipt written"
case(1, "A mint with no fee extension has no fee: kind 'none', with a receipt", "fee 0, 'none', no program; the figure still carries its receipt (shown always)", t1)

def t2():
    fresh()
    got, _ = run(500, REWARD, auth=DEV)
    return got["fee_kind"] == "outside_norm" and got["program"] is None and got["pct"] == 5.0 and "not a launchpad rewards fee" in got["words"], f"{got['fee_kind']}: {got['words'][:80]!r}"
case(2, "A fee whose withheld-fee authority is not a verified launchpad wallet is outside the norm, with no program", "5%, outside_norm, no program named", t2)

def t3():
    fresh()
    outs = [run(100, p)[0] for p in (BONK, STD, UNKNOWN, None)]
    return all(o["fee_kind"] == "outside_norm" and o["program"] is None for o in outs) and "not that program's reward mode" in outs[0]["words"], \
        f"bonk.fun pool, Stonk standard mode, unknown, not LaunchLab: {[o['fee_kind'] for o in outs]}"
case(3, "The verified authority alone is not enough: the pool must be that launchpad's verified reward mode", "the same authority on any other pool: outside_norm, no program", t3)

def t4():
    fresh()
    got, chain = run(100, REWARD)
    return (got["fee_kind"] == "rewards_standard" and got["program"] == PROGRAM and got["standard_pct"] == 1.0 and got["pct"] == 1.0
            and got["standard_basis"] == "observed" and len(got["standard_links"]) == 10 and all(l.startswith("https://solscan.io/token/") for l in got["standard_links"])
            and sum(1 for k, _m in chain.reads if k == "mint") == 10 and sum(1 for k, _m in chain.reads if k == "pool") == 10), \
        f"{got['fee_kind']}, program {got['program']!r}, standard {got['standard_pct']}% ({got['standard_basis']}, {len(got['standard_links'] or [])} launch links): from 10 launches, each pool verified and each mint read"
case(4, "A reward-mode coin at the rate every verified launch carries is 'rewards_standard'", "program named from the chain's own name, observed standard 1% from 10 verified launches, kind rewards_standard", t4)

def t5():
    fresh()
    below, _ = run(50, REWARD)
    fresh()
    above, _ = run(300, REWARD)
    return (below["fee_kind"] == "rewards_standard" and above["fee_kind"] == "outside_norm" and above["program"] == PROGRAM and above["standard_pct"] == 1.0
            and "above" in above["words"]), f"0.5% against a 1% standard: {below['fee_kind']}; 3%: {above['fee_kind']} with the program and its standard"
case(5, "At or below the standard is rewards; above it is outside the norm with the program and its standard (B1)", "0.5%: rewards_standard; 3% against 1%: outside_norm, program and standard_pct kept", t5)

def t6():
    fresh()
    mixed = Chain({m: (100 if i % 2 else 300) for i, m in enumerate(SAMPLE)})
    got, _ = run(100, REWARD, mixed)
    return (got["fee_kind"] == "standard_unknown" and got["program"] == PROGRAM and got["standard_pct"] is None and got["rates_pct"] == [1.0, 3.0]
            and "standard was not read" in got["words"]), f"{got['fee_kind']}; rates seen {got['rates_pct']}; {got['words'][:70]!r}"
case(6, "Launches that disagree leave the standard unknown: its own state, never guessed (R1, U1)", "rates 1% and 3% among the verified launches: standard_unknown, the program named, no standard_pct, the rates in the result", t6)

def t7():
    fresh()
    half = Chain({m: 100 for m in SAMPLE}, verified=set(SAMPLE[:5]))        # five launches on another platform's pools
    got, chain = run(100, REWARD, half)
    unverified_read = [m for k, m in chain.reads if k == "mint" and m not in SAMPLE[:5]]
    fresh()
    none = Chain({m: 100 for m in SAMPLE}, verified=set())
    got2, _ = run(100, REWARD, none)
    return got["fee_kind"] == "rewards_standard" and not unverified_read and got2["fee_kind"] == "standard_unknown" and "could be verified" in got2["words"], \
        f"5 of 10 verified: standard from those 5 only, the unverified mints not even read ({len(unverified_read)}); none verified: {got2['fee_kind']}"
case(7, "Only the program's VERIFIED launches count towards its standard (R1)", "a launch on another platform's pool is not read for the rate; with none verified the standard is unknown", t7)

def t8():
    fresh()
    chain = Chain({m: 100 for m in SAMPLE})
    for fee in (100, 100, 250):
        R.rewards_program(mint(fee), REWARD, R.Log(), sample=lambda: SAMPLE, read=chain.read, pool=chain.pool, plat=chain.platform)
    reads = sum(1 for k, _m in chain.reads if k == "mint")
    none = R.rewards_program(None, REWARD, R.Log())
    return reads == 10 and none is None, f"three coins: the ten sample mints read once ({reads}); an unread mint gives {none} (missing stays missing)"
case(8, "The standard is read once an hour a process; an unread mint gives nothing", "ten reads for three coins; None for a mint that could not be read", t8)

import json, struct
from b58 import b58d, pda
RULE_FILE = os.path.join(HERE, "..", "tools", "profiles", "2026-10-17-stonkfun-reward-curve-rule-account.json")
REWARD_ACCT, GLOBAL_CFG = "6BwHHDg3u1854jC8PDLXvR4spTcLNaoBxLJNGC4nTESt", "6s1xP3hpbAfFoNtUNF8mfHsjr2Bd97JxFJRWLbL6aHuX"

def t9():
    d = json.load(open(RULE_FILE)); raw = bytes.fromhex(d["hex"])
    dec = R.decode_curve_rule(raw)
    fee_cons = [(g["group"], f, op, v) for g in dec["groups"] for f, op, v in g["constraints"] if f == R.FIELD_FEE_BPS]
    derived = pda([R.CURVE_RULE_SEED, b58d(REWARD_ACCT), b58d(GLOBAL_CFG)], R.LAUNCHLAB)
    return (dec["platform_id"] == REWARD_ACCT and dec["config_id"] == GLOBAL_CFG and len(dec["groups"]) == 2 and fee_cons == [(0, 11, 0, 100), (1, 11, 0, 300)]
            and R.allowed_fee_bps(dec) == [100, 300] and derived == d["account"]), f"2 groups, fee constraints {fee_cons} (field 11 Eq), allowed {R.allowed_fee_bps(dec)}; names the reward platform and config; derived address equals the one read: {derived == d['account']}"
case(9, "The real curve-rule account (read 2026-10-17) decodes whole by Raydium's layout and names its platform", "two rule groups pinning the fee to 100 and to 300 bps; allowed [100, 300]; the published seed derives exactly that account", t9)

def t10():
    d = json.load(open(RULE_FILE)); raw = bytes.fromhex(d["hex"])
    class Chain2:
        def __init__(self, owner, data): self.owner, self.data, self.reads = owner, data, []
        def __call__(self, addr): self.reads.append(addr); return self.data, self.owner, 5
    R._CURVE_RULE.clear()
    good = R.read_curve_rule(REWARD_ACCT, GLOBAL_CFG, R.Log(), get=Chain2(R.LAUNCHLAB, raw))
    R._CURVE_RULE.clear()
    wrong_owner = R.read_curve_rule(REWARD_ACCT, GLOBAL_CFG, R.Log(), get=Chain2("SomeOtherProgram", raw))
    R._CURVE_RULE.clear()
    other = R.read_curve_rule(b58e(bytes([8]) * 32), GLOBAL_CFG, R.Log(), get=Chain2(R.LAUNCHLAB, raw))     # the bytes name the reward platform, not this one
    R._CURVE_RULE.clear()
    none = R.read_curve_rule(REWARD_ACCT, GLOBAL_CFG, R.Log(), get=Chain2(None, None))
    return good and good["max_bps"] == 300 and good["allowed_bps"] == [100, 300] and wrong_owner is None and other is None and none is None, \
        f"good: max {good and good['max_bps']} of {good and good['allowed_bps']}; wrong owner: {wrong_owner}; names another platform: {other}; no account: {none}"
case(10, "The settings account is trusted only when LaunchLab owns it and it names the platform and config back", "the real bytes: standard 300 of [100, 300]; another owner, another platform or no account: None", t10)

def t11():
    fresh(); R._CURVE_RULE.clear()
    rule = lambda p, c, log, now=None: {"address": "RULE", "allowed_bps": [100, 300], "max_bps": 300, "groups": 2, "slot": 1, "words": "the program's settings allow 100 bps, 300 bps (2 rule groups; the highest is the standard)"}
    state = {"platform_config": REWARD_ACCT, "config_id": GLOBAL_CFG}
    chain = Chain({m: 100 for m in SAMPLE})
    outs = {}
    for fee in (100, 300, 500):
        fresh(); R._CURVE_RULE.clear()
        outs[fee] = R.rewards_program(mint(fee), REWARD, R.Log(), sample=lambda: SAMPLE, read=chain.read, pool=chain.pool, plat=chain.platform, pool_state=state, rule=rule)
    return (outs[100]["fee_kind"] == "rewards_standard" and outs[300]["fee_kind"] == "rewards_standard" and outs[300]["standard_pct"] == 3.0
            and outs[500]["fee_kind"] == "outside_norm" and outs[500]["standard_pct"] == 3.0 and "on-chain settings" in outs[100]["words"] and not chain.reads
            and all(outs[f]["standard_basis"] == "settings" and outs[f]["standard_links"] is None for f in (100, 300, 500))), \
        f"1%: {outs[100]['fee_kind']}; 3%: {outs[300]['fee_kind']} (standard {outs[300]['standard_pct']}%, basis {outs[300]['standard_basis']}); 5%: {outs[500]['fee_kind']} above {outs[500]['standard_pct']}%; launches read for the standard: {len(chain.reads)}"
case(11, "With the settings read, the standard is the highest they allow: 3% (R1, B1)", "1% and 3% are rewards_standard, 5% is outside_norm with the 3% standard; no launch is sampled when the settings decide", t11)

def t12():
    fresh(); R._CURVE_RULE.clear()
    no_rate = lambda p, c, log, now=None: {"address": "RULE", "allowed_bps": [], "max_bps": None, "groups": 1, "slot": 1, "words": "the program's settings keep no transfer-fee rate (1 rule groups)"}
    state = {"platform_config": REWARD_ACCT, "config_id": GLOBAL_CFG}
    chain = Chain({m: 100 for m in SAMPLE})
    got = R.rewards_program(mint(100), REWARD, R.Log(), sample=lambda: SAMPLE, read=chain.read, pool=chain.pool, plat=chain.platform, pool_state=state, rule=no_rate)
    return got["fee_kind"] == "rewards_standard" and "observed standard" in got["words"] and len([1 for k, _m in chain.reads if k == "mint"]) == 10, \
        f"settings keep no rate: {got['fee_kind']} by the observed standard from {len([1 for k, _m in chain.reads if k == 'mint'])} verified launches"
case(12, "Only when the settings keep no rate does the observed standard stand in (R1)", "settings with no fee rate: the verified launches' agreed rate, labelled observed", t12)


print(f"\n{sum(results)}/{len(results)} passed")
sys.exit(0 if all(results) else 1)
