"""Which launchpad made a LaunchLab pool: plain-English tests on made-up pool bytes and a made-up chain.
The platform account baked into the pool names the launchpad only after the chain shows the account exists and the
LaunchLab program owns it; anything else is "unknown platform". Reads no chain, touches no live file.
Run:  python3 test_launchlab_platform.py"""
import os, struct, sys
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import readers as R
from b58 import b58d, b58e

results = []
def case(n, title, should, fn):
    try:
        ok, text = fn()
    except Exception as e:
        ok, text = False, f"CRASH {type(e).__name__}: {e}"
    results.append(ok)
    print(f"\n{n:>2}. {title}\n    should: {should}\n    did:    {text}\n    {'PASS' if ok else 'FAIL'}")

STONK_REWARD = "6BwHHDg3u1854jC8PDLXvR4spTcLNaoBxLJNGC4nTESt"
STONK_STD = "4E876qZTE9FJMrBzgVtBrSrzz2TLivB5Y5QXPjB4gZL7"
BONK = "FfYek5vEz23cMkWsdJwG2oa6EphsvXSHrGpdALN4g6W1"
NOBODY = b58e(bytes([7]) * 32)                      # an account nobody listed
MINT = b58e(bytes([9]) * 32)
CREATOR = b58e(bytes([3]) * 32)


def pool_bytes(platform):
    """A LaunchLab pool account in the engine's own layout: status, decimals, the curve figures, the platform account,
    the mint, the quote, the vaults, the creator."""
    raw = bytearray(400)
    raw[17], raw[18], raw[19] = 0, 6, 9
    for i, v in enumerate((10 ** 15, 8 * 10 ** 14, 10 ** 15, 3 * 10 ** 10, 0, 0, 8 * 10 ** 10)):
        struct.pack_into("<Q", raw, 21 + 8 * i, v)
    raw[173:205] = b58d(platform); raw[205:237] = b58d(MINT); raw[237:269] = b58d(R.WSOL)
    raw[269:301] = bytes([1]) * 32; raw[301:333] = bytes([2]) * 32; raw[333:365] = b58d(CREATOR)
    return bytes(raw)


NAMES = {STONK_REWARD: "StonkFun", STONK_STD: "StonkFun", BONK: "letsbonk.fun"}      # as the accounts name themselves on chain (read 2026-10-17)

def config_bytes(size, name):
    raw = bytearray(size)
    raw[R.PLATFORM_NAME_AT:R.PLATFORM_NAME_AT + len(name)] = name.encode()
    return bytes(raw)

class Chain:
    """A made-up chain: which accounts exist, who owns them and what name they keep; counts the reads."""
    def __init__(self, accounts, names=None):
        self.accounts, self.reads, self.names = accounts, [], names if names is not None else NAMES
    def __call__(self, addr):
        self.reads.append(addr)
        if addr not in self.accounts:
            return None, None, None
        owner, size = self.accounts[addr]
        return config_bytes(size, self.names.get(addr, "")), owner, 123456


def fresh():
    R._PLATFORM_CHECKED.clear()
    return R.Log()


def t1():
    log = fresh(); chain = Chain({STONK_REWARD: (R.LAUNCHLAB, 200)})
    got = R.launchlab_platform(STONK_REWARD, log, get=chain)
    return got["verified"] and got["words"] == "StonkFun (reward mode)" and chain.reads == [STONK_REWARD], f"{got['words']!r}; chain reads {chain.reads}"
case(1, "A listed Stonk.fun account that the chain confirms names the launchpad, by its own name on chain", "the account exists, the LaunchLab program owns it and it names itself StonkFun: 'StonkFun (reward mode)', verified, one read", t1)

def t2():
    log = fresh(); chain = Chain({STONK_STD: ("SomeOtherProgram111111111111111111111111111", 200)})
    got = R.launchlab_platform(STONK_STD, log, get=chain)
    return not got["verified"] and got["words"] == "unknown platform" and got["name"] is None, f"{got['words']!r} (listed, but owned by another program)"
case(2, "A listed account the chain does not confirm is not trusted", "owned by another program: 'unknown platform', never the listed name", t2)

def t3():
    log = fresh(); chain = Chain({})
    got = R.launchlab_platform(STONK_STD, log, get=chain)
    return got["words"] == "unknown platform" and not got["verified"], f"{got['words']!r} (listed, but no such account on chain)"
case(3, "A listed account that does not exist on chain is not trusted", "no account: 'unknown platform'", t3)

def t4():
    log = fresh(); chain = Chain({NOBODY: (R.LAUNCHLAB, 200)})
    got = R.launchlab_platform(NOBODY, log, get=chain)
    return got["words"] == "unknown platform" and chain.reads == [], f"{got['words']!r}; chain reads {chain.reads} (an unlisted account is not even read)"
case(4, "An account nobody listed is unknown, never guessed", "'unknown platform' with no chain read: the chain cannot tell us a name", t4)

def t5():
    log = fresh(); chain = Chain({BONK: (R.LAUNCHLAB, 200)})
    got = R.launchlab_platform(BONK, log, get=chain)
    return got["words"] == "letsbonk.fun" and got["mode"] is None, f"{got['words']!r}"
case(5, "bonk.fun's account names itself letsbonk.fun, with no mode", "the one bonk.fun account, verified the same way, named as the chain names it", t5)

def t6():
    log = fresh(); chain = Chain({STONK_REWARD: (R.LAUNCHLAB, 200)})
    for _ in range(3):
        R.launchlab_platform(STONK_REWARD, log, get=chain)
    return chain.reads == [STONK_REWARD], f"three pools, chain reads {len(chain.reads)}"
case(6, "The chain check is made once a process", "three pools of the same platform: one read of the account", t6)

def t7():
    log = fresh()
    def broken(addr):
        raise OSError("no answer")
    got = R.launchlab_platform(STONK_REWARD, log, get=broken)
    again = Chain({STONK_REWARD: (R.LAUNCHLAB, 200)})
    got2 = R.launchlab_platform(STONK_REWARD, log, get=again)
    return got["words"] == "unknown platform" and got2["verified"], f"unread: {got['words']!r}; next time, read: {got2['words']!r}"
case(7, "A read that fails is not trusted and is tried again", "the first answer 'unknown platform'; the check is not cached as a failure", t7)

def t8():
    log = fresh(); chain = Chain({STONK_REWARD: (R.LAUNCHLAB, 200)})
    raw = pool_bytes(STONK_REWARD)
    R.account_raw, keep = (lambda a: (raw, R.LAUNCHLAB, 1) if a == "POOL" else chain(a)), R.account_raw
    try:
        d = R.read_launchlab_pool("POOL", MINT, log)
        got = R.launchlab_platform(d["platform_config"], log, get=chain)
    finally:
        R.account_raw = keep
    said = " ".join(str(v) for v in vars(log).values())        # whatever the log holds its receipts in
    return d["platform_config"] == STONK_REWARD and got["words"] == "StonkFun (reward mode)" and "LaunchLab platform" in said, \
        f"pool's platform_config read back as the reward account; named {got['words']!r}; receipt written: {'LaunchLab platform' in said}"
case(8, "From the pool bytes to the name, with a receipt", "the pool's own platform account, decoded, verified, named, and a 'LaunchLab platform' receipt in the log", t8)

def t9():
    log = fresh(); chain = Chain({STONK_REWARD: (R.LAUNCHLAB, 944)}, names={STONK_REWARD: "SomeOtherPad"})
    got = R.launchlab_platform(STONK_REWARD, log, get=chain)
    return got["words"] == "unknown platform" and "names itself" not in str(vars(log)) and "SomeOtherPad" in str(vars(log)), f"{got['words']!r}; the receipt names what the chain said: {'SomeOtherPad' in str(vars(log))}"
case(9, "An account whose own name is not the listed launchpad's is not trusted (W3)", "owned by LaunchLab but named SomeOtherPad: 'unknown platform', the receipt saying what the chain said", t9)

def t10():
    import json
    saved = json.load(open(os.path.join(HERE, "..", "tools", "profiles", "2026-10-17-launchlab-platform-accounts.json")))["accounts"]
    names = {a: v["name_at_112"] for a, v in saved.items()}
    ok = all(R.LAUNCHLAB_PLATFORMS[a][0] in n.lower() for a, n in names.items()) and len(names) == 4 and all(v["size"] == 944 for v in saved.values())
    return ok, f"the four accounts as read 2026-10-17: {names}; all 944 bytes, each name containing its listed stem"
case(10, "The four real accounts name themselves as listed (read 2026-10-17)", "StonkFun on Stonk.fun's three, letsbonk.fun on bonk.fun's, at the documented offset", t10)


print(f"\n{sum(results)}/{len(results)} passed")
sys.exit(0 if all(results) else 1)
