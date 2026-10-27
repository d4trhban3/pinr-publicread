"""A LaunchLab coin's pool when the scanner hands over no pointer (StonkFun, LetsBonk; 2026-10-13).
The live scan calls the scorer with no pool pointer since the launch index went, so the five StonkFun
coins asked for by hand came out "Technical error" (no pool, no creator). Now Raydium's own LaunchLab record names the
pool (an approved source, one keyless read) and the pool account is verified on chain exactly as a pointer from the
scanner is. The network is blocked here: Raydium's answer is the real one saved in
tools/profiles/2026-10-13-raydium-launchlab-by-mints-one-read.json, the chain is a made-up account.
Run: cd stage2 && python3 test_launchlab_pool.py"""
import json, os, struct, sys
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import readers as R
from b58 import b58d

results = []


def case(n, title, should, fn):
    try:
        ok, seen = fn()
    except Exception as e:
        ok, seen = False, f"raised {type(e).__name__}: {e}"
    results.append(bool(ok))
    print(f"{'ok  ' if ok else 'FAIL'} {n:>2}. {title}\n      should: {should}\n      seen:   {seen}")


FIXTURE = json.load(open(os.path.join(HERE, "..", "tools", "profiles", "2026-10-13-raydium-launchlab-by-mints-one-read.json")))
ROW = FIXTURE["data"]["rows"][0]
MINT, POOL, CREATOR = ROW["mint"], ROW["poolId"], ROW["creator"]
OTHER_MINT = "8RVBk8vxLiUHueLUW1f4izFVqN3nWippLhkohKg6EGkS"
WSOL = "So11111111111111111111111111111111111111112"
ASKED = {"api": [], "chain": []}


def pool_account(mint, creator, status=0):
    """A LaunchLab pool account as the chain lays it out (the offsets read_launchlab_pool reads)."""
    raw = bytearray(400)
    raw[17], raw[18], raw[19] = status, 6, 9
    for i, v in enumerate((1_000_000_000, 793_100_000, 1_073_025_605, 30_000_000_000, 0, 0, 85_000_000_000)):
        struct.pack_into("<Q", raw, 21 + 8 * i, v)
    raw[173:205] = b58d(ROW["configId"]); raw[205:237] = b58d(mint); raw[237:269] = b58d(WSOL)
    raw[269:301] = b58d(ROW["platformInfo"]["platformClaimFeeWallet"]); raw[301:333] = b58d(ROW["platformInfo"]["transferFeeExtensionAuth"])
    raw[333:365] = b58d(creator)
    return bytes(raw)


def wire(api_answer, chain):
    """api_answer: what Raydium answers (None = down). chain: {address: (raw, owner)}."""
    ASKED["api"].clear(); ASKED["chain"].clear()
    def http_json(url, tries=3):
        ASKED["api"].append(url); return api_answer
    def account_raw(addr):
        ASKED["chain"].append(addr)
        raw, owner = chain.get(addr, (None, None))
        return raw, owner, 123456789
    R.http_json, R.account_raw = http_json, account_raw


def c1():
    wire(FIXTURE, {POOL: (pool_account(MINT, CREATOR), R.LAUNCHLAB)})
    log = R.Log(); d = R.find_launchlab_pool(MINT, log)
    whats = [i["what"] for i in log.items]
    ok = (d is not None and d["address"] == POOL and d["creator"] == CREATOR and d["quote_mint"] == WSOL and d["status"] == 0
          and ASKED["api"] == [R.LAUNCHLAB_API + MINT] and ASKED["chain"] == [POOL]
          and "LaunchLab pool (Raydium's record, verified on chain)" in whats and "creator (from LaunchLab pool)" in whats)
    return ok, f"pool {d and d['address']}, creator {d and d['creator']}; reads: Raydium {len(ASKED['api'])}, chain {ASKED['chain']}; receipts {whats}"
case(1, "Raydium's record names the pool and the chain confirms it (the real answer for NOLIMIT, saved)",
     "the pool is read from the chain with its creator; one read of Raydium, one of the chain; receipts for the pointer and the creator", c1)


def c2():
    wire(FIXTURE, {POOL: (pool_account(OTHER_MINT, CREATOR), R.LAUNCHLAB)})
    log = R.Log(); d = R.find_launchlab_pool(MINT, log)
    return d is None and not log.items, f"result {d}; receipts {[i['what'] for i in log.items]}"
case(2, "Raydium names a pool whose chain account is for ANOTHER mint", "nothing is trusted from the record alone: None, no receipt", c2)


def c3():
    wire(FIXTURE, {POOL: (pool_account(MINT, CREATOR), "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA")})
    log = R.Log(); d1 = R.find_launchlab_pool(MINT, log)
    wire(FIXTURE, {})
    d2 = R.find_launchlab_pool(MINT, log)
    return d1 is None and d2 is None and not log.items, f"other owner: {d1}; account missing: {d2}; receipts {len(log.items)}"
case(3, "The named pool account is owned by another program, or does not exist", "None both times", c3)


def c4():
    seen = {}
    for label, ans in (("down", None), ("not success", {"success": False, "data": None}), ("no rows", {"success": True, "data": {"rows": []}}),
                       ("junk", "not a dict"), ("row without pool", {"success": True, "data": {"rows": [{"mint": MINT}]}})):
        wire(ans, {POOL: (pool_account(MINT, CREATOR), R.LAUNCHLAB)})
        d = R.find_launchlab_pool(MINT, R.Log()); seen[label] = (d, len(ASKED["chain"]))
    return all(v == (None, 0) for v in seen.values()), f"{seen} (result, chain reads)"
case(4, "Raydium is down, says no, lists nothing, answers junk, or names no pool", "None every time, and the chain is not asked", c4)


def c5():
    row = dict(ROW); row["mint"] = OTHER_MINT
    wire({"success": True, "data": {"rows": [row]}}, {POOL: (pool_account(MINT, CREATOR), R.LAUNCHLAB)})
    d = R.find_launchlab_pool(MINT, R.Log())
    return d is None and ASKED["chain"] == [], f"result {d}; chain reads {ASKED['chain']}"
case(5, "Raydium's row is for a different mint than the one asked", "the row is skipped: None, no chain read", c5)



print(f"\n{sum(results)}/{len(results)} passed")
raise SystemExit(0 if all(results) else 1)
