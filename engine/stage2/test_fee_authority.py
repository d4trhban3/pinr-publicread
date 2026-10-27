"""The fee-authority check's judgement and its page: plain-English
tests with made-up accounts and samples, and the engine's own on-curve test on known keys. Reads no chain, writes
only a temporary file. Run:  python3 test_fee_authority.py"""
import importlib.util, os, sys, tempfile
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from b58 import b58d, b58e, oc, pda
import readers as R

spec = importlib.util.spec_from_file_location("check_fee_authority", os.path.join(HERE, "..", "tools", "check_fee_authority.py"))
T = importlib.util.module_from_spec(spec); spec.loader.exec_module(T)

results = []
def case(n, title, should, fn):
    try:
        ok, text = fn()
    except Exception as e:
        ok, text = False, f"CRASH {type(e).__name__}: {e}"
    results.append(ok)
    print(f"\n{n:>2}. {title}\n    should: {should}\n    did:    {text}\n    {'PASS' if ok else 'FAIL'}")

AUTH = R.STONKFUN_COLLECTOR
WALLET = {"owner": T.SYSTEM_PROGRAM, "size": 0, "slot": 1, "lamports": 1}
def sample(n, naming=None, creators=None):
    naming = n if naming is None else naming
    creators = creators or n
    return [{"mint": b58e(bytes([40 + i]) * 32), "authority": AUTH if i < naming else b58e(bytes([99]) * 32), "fee_bps": 100,
             "creator": b58e(bytes([70 + (i % creators)]) * 32), "from": "made up"} for i in range(n)]


def t1():
    derived = pda([b"pool-authority", b58d(R.WSOL)], R.PUMP)       # the engine's own derivation: off the curve by construction
    return (not oc(b58d(derived))) and oc(b58d(R.TOKEN_2022)) and oc(b58d(T.SYSTEM_PROGRAM)), \
        f"a program-derived address off the curve: {not oc(b58d(derived))}; the Token-2022 program's key on it: {oc(b58d(R.TOKEN_2022))}; the System Program's: {oc(b58d(T.SYSTEM_PROGRAM))}"
case(1, "The on-curve test tells a program-derived address from a key", "a PDA the engine derives is off the curve; two well-known program keys are on it", t1)

def t2():
    alone = T.judge(AUTH, {"owner": "SomeProgram", "size": 100}, False, [])
    named = T.judge(AUTH, {"owner": "SomeProgram", "size": 100}, False, sample(10, creators=6))
    broken = T.judge(AUTH, {"owner": "SomeProgram", "size": 100}, False, sample(10, naming=8, creators=6))
    return (alone["verdict"] == "not settled" and "not settled" in alone["words"] and named["verdict"] == "launchpad-run"
            and "every one of 10" in named["words"] and broken["verdict"] == "not consistent"), f"alone: {alone['verdict']}; named by 10 of 10: {named['verdict']}; 8 of 10: {broken['verdict']}"
case(2, "Off the curve alone settles nothing; the launches must name it (J1)", "a program-derived address with no sample is not settled; named by every launch of many creators it is launchpad-run; 8 of 10 is not consistent", t2)

def t3():
    r = T.judge(AUTH, WALLET, True, sample(10, creators=6))
    return r["verdict"] == "launchpad-assigned" and r["counts"] == {"sample": 10, "naming_it": 10, "creators": 6}, f"{r['verdict']}; counts {r['counts']}"
case(3, "A keypair wallet named by every reward launch of many creators is launchpad-assigned", "10 of 10 launches by 6 creators name it: platform context", t3)

def t4():
    r = T.judge(AUTH, WALLET, True, sample(10, naming=8, creators=6))
    return r["verdict"] == "not consistent" and "8 of 10" in r["words"], f"{r['verdict']}: {r['words'][:110]}"
case(4, "Two launches naming another authority break the case", "8 of 10: not consistent, not platform context", t4)

def t5():
    small = T.judge(AUTH, WALLET, True, sample(3))
    one_dev = T.judge(AUTH, WALLET, True, sample(10, creators=1))
    return small["verdict"] == "not settled" and one_dev["verdict"] == "not settled" and "1 creator" in one_dev["words"], \
        f"3 launches: {small['verdict']}; 10 launches by one creator: {one_dev['verdict']}"
case(5, "Too few launches, or all by one creator, settle nothing", "a small sample or one dev's own launches cannot show a platform wallet", t5)

def t6():
    s = sample(6, creators=4)
    r = T.judge(AUTH, WALLET, True, s)
    text = T.page(AUTH, WALLET, True, s, r, "2026-10-17 00:00 UTC")
    p = os.path.join(tempfile.mkdtemp(), "f.md"); open(p, "w").write(text)
    ok = ("LAUNCHPAD-ASSIGNED" in text and sum(1 for l in text.splitlines() if l.startswith("| `")) == 6 and "getAccountInfo" in text and "keeps the entry" in text and AUTH in text)
    return ok, f"page: verdict line, 6 sample rows with receipts, the account's receipt, the engine consequence: {ok}"
case(6, "The facts page carries the verdict, every sample row and the receipts", "one page a reader can check line by line", t6)


print(f"\n{sum(results)}/{len(results)} passed")
sys.exit(0 if all(results) else 1)
