"""the design's three no-loss levers, offline: the EVM block watchers run only for a chain that is scored; the coin's metadata
document is read from every gateway at once with one try and a short timeout; the seen files' fee fill reads LaunchLab coins only;
the Solana provider order no longer names the node that answered nothing. Network blocked. Run:  python3 test_no_loss.py"""
import json, os, socket, sys, tempfile, time, types, urllib.request
os.environ["PINR_IPFS_REST_FILE"] = os.path.join(tempfile.mkdtemp(), "ipfs_rest.sqlite")   # never the engine's own record of rests

CALLS = []
def _blocked(*a, **k):
    CALLS.append(a[:1]); raise OSError("network blocked in this test")
urllib.request.urlopen = _blocked
socket.create_connection = _blocked

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE); sys.path.insert(0, os.path.join(HERE, "..", "stage2")); sys.path.insert(0, os.path.join(HERE, "..", "feed"))
# a made-up EVM request module, in place before the scanner imports it inside cycle()
EVM_CALLS = []
evm = types.ModuleType("evm")
def _rpc(chain, method, params):
    EVM_CALLS.append((chain, method)); return "0x10"
evm.rpc = _rpc
sys.modules["evm"] = evm
import scanner as S
import readers as R
import seen as SN
import seen_feed as SF
import feed_export as F
import solana_rpc as SR

TMP = tempfile.mkdtemp(); S.DB = os.path.join(TMP, "scanner.sqlite"); S.SETTINGS = os.path.join(TMP, "settings.json")
F.FEED_DIR = os.path.join(TMP, "frontend-feed"); os.makedirs(F.FEED_DIR)
S._SITE.update(at=time.time() + 10 ** 6, mints=[]); S._SHOWN.update(at=time.time() + 10 ** 6, mints=[]); S._POOL.update(at=time.time() + 10 ** 6, mints=[])

results = []
def case(n, title, should, fn):
    try:
        ok, text = fn()
    except Exception as e:
        import traceback; traceback.print_exc()
        ok, text = False, f"CRASH {type(e).__name__}: {e}"
    results.append(ok)
    print(f"\n{n:>2}. {title}\n    should: {should}\n    did:    {text}\n    {'PASS' if ok else 'FAIL'}")

def settings(chains):
    json.dump({"score_chains": chains, "solana_workers": 1, "solana_rescores": "paused", "solana_trigger": "off"}, open(S.SETTINGS, "w"))
    S._SCORING.update(chains=None, note=None, saved=None); S._TRIG.update(on=None, line=None, buys=None, note=None)

def t1():
    for ext in ("", "-wal", "-shm"):
        if os.path.exists(S.DB + ext): os.remove(S.DB + ext)
    S.db()
    S.watch_bnb = lambda c, head: 0; S.watch_base = lambda c, head: 0; S.dispatch = lambda c, pool, wait=False: "0 finished"
    settings(["solana"]); EVM_CALLS.clear()
    out1 = S.cycle(None)
    off = (out1.get("bsc_triggered"), out1.get("base_triggered")); none = len(EVM_CALLS)
    settings(["solana", "bsc"]); EVM_CALLS.clear()
    out2 = S.cycle(None)
    return off == ("off (chain not scored)", "off (chain not scored)") and none == 0 and out2.get("bsc_triggered") == 0 and out2.get("base_triggered") == "off (chain not scored)" and EVM_CALLS == [("bsc", "eth_blockNumber")] \
        and "bsc" not in out1["seconds"] and "bsc" in out2["seconds"], \
        f"only Solana scored: watchers {off}, EVM requests {none}; Solana and BNB scored: bsc ran ({out2.get('bsc_triggered')}), base {out2.get('base_triggered')!r}, EVM requests {EVM_CALLS}"
case(1, "The EVM block watchers run only for a chain that is scored", "both off with no request when only Solana is scored; BNB's runs and Base's stays off when BNB is scored too", t1)

def t2():
    seen = []
    def get(u):
        seen.append(u); time.sleep(0.01)
        return {"name": "Coin", "symbol": "C"} if "dweb.link" in u else None
    uri = "https://ipfs.io/ipfs/bafyTESTcid"
    R.IPFS_ALTS_FOR_TEST = R.ipfs_alternatives(uri)                       # the address itself plus every other gateway (5 here: ipfs.io is one of them)
    doc = R.metadata_document(uri, get=get); n_first = len(seen)
    one = R.metadata_document("https://example.com/meta.json", get=lambda u: seen.append(u) or {"name": "X"})
    dead = R.metadata_document(uri, get=lambda u: None)
    calls = []
    real_get = R._gateway_get
    R._gateway_get = lambda u: calls.append(u) or None                  # the default read: one try each
    try:
        R.metadata_document(uri)
    finally:
        R._gateway_get = real_get
    return (doc == {"name": "Coin", "symbol": "C"} and n_first == len(R.IPFS_ALTS_FOR_TEST) and one == {"name": "X"} and dead is None
            and len(calls) == len(R.IPFS_ALTS_FOR_TEST) and R.IPFS_TIMEOUT <= 10), \
        f"all {n_first} addresses asked at once, the one gateway that answered won: {doc}; a plain https document: {one}; nobody answers: {dead}; the default read: {len(calls)} reads, one each, {R.IPFS_TIMEOUT} s"
case(2, "The metadata document: every gateway at once, one try each, a short timeout; the first valid answer wins", "the address and every other gateway asked together, one try, 8 s; a dead set of gateways gives None in seconds, not a minute", t2)

def t3():
    SN._STATE.clear()
    for n in os.listdir(F.FEED_DIR): os.remove(os.path.join(F.FEED_DIR, n)) if os.path.isfile(os.path.join(F.FEED_DIR, n)) else None
    from b58 import b58e
    A, B, POOL = (b58e(bytes([i]) * 32) for i in (61, 62, 63))
    SN.note_seen([{"mint": A, "seen_by": "pumpfun_pool", "created": time.time() - 100, "name": "P", "symbol": "P", "image": None, "pool": None},
                  {"mint": B, "seen_by": "stonkfun_list", "created": time.time() - 100, "name": "S", "symbol": "S", "image": None, "pool": POOL}], time.time())
    reads = []
    def rm(m, log):
        reads.append(m); log.add("token program", R.TOKEN_2022, "program id", "x", 1)
        return {"mint": m, "program": R.TOKEN_2022, "decimals": 6, "supply_raw": 1, "powers": {}, "transfer_fee_bps": 300, "withdraw_withheld_authority": R.STONKFUN_COLLECTOR}
    def rw(m, plat, log, pool_state=None, **k):
        log.add("transfer fee", 300, "bps", "getAccountInfo (Token-2022 transfer-fee extension; none means no fee)")
        return {"fee_bps": 300, "pct": 3.0, "fee_kind": "rewards_standard", "program": "StonkFun reward mode", "standard_pct": 3.0, "standard_basis": "settings", "standard_links": None}
    r = SN.fill_fees(10, read_mint=rm, read_pool=lambda pool, m, log: {"address": pool, "platform_config": "PC"}, platform=lambda pc, log, get=None: {"name": "StonkFun", "mode": "reward mode", "words": "StonkFun (reward mode)", "verified": True}, rewards=rw, now=time.time())
    a = json.load(open(os.path.join(F.FEED_DIR, A + ".json"))); b = json.load(open(os.path.join(F.FEED_DIR, B + ".json")))
    return reads == [B] and r["read"] == 1 and "facts" not in a and a["seen"] is True and any(f["id"] == "transfer_fee" for f in b["facts"]) and SN.fill_fees(10, read_mint=rm, rewards=rw)["read"] == 0, \
        f"reads {len(reads)} (the Stonk.fun coin only); the Pump.fun seen file keeps no fee fact ({'facts' in a}); the Stonk.fun file has its fee: {any(f['id'] == 'transfer_fee' for f in b['facts'])}; a second pass reads nothing"
case(3, "The seen files' fee fill reads LaunchLab coins only; a Pump.fun seen file waits for its score", "one read for the Stonk.fun coin, none for the Pump.fun coin", t3)

def t4():
    order = SR.provider_order(os.path.join(HERE, "settings.json"))
    return "publicnode" not in order and order == ["shyft", "chainstack", "helius", "helius_official", "alchemy_official"] and SR.ORDER_NOTE[0] is None and "publicnode" in SR._KNOWN, \
        f"the repo's order: {order} (publicnode still a known name, off the list; no note)"
case(4, "The Solana provider order in the repo's settings no longer names PublicNode (0 of 177 answered on 2026-10-18); the name stays known", "shyft, chainstack, helius, then the operator's official keys; usable, no warning", t4)

def t5():
    """The operator's 2026-10-24 (the rules: never disguised as a browser): every engine reader names itself as PINR."""
    import re
    root = os.path.join(HERE, "..")
    found = []
    for folder in ("scanner", "stage2", "stage3", "feed", "livews", "control"):
        d = os.path.join(root, folder)
        for n in sorted(os.listdir(d)) if os.path.isdir(d) else []:
            if n.startswith("test_") or not n.endswith((".py", ".mjs", ".js")):
                continue
            text = open(os.path.join(d, n), encoding="utf-8", errors="ignore").read()
            found += [f"{folder}/{n}" for _ in re.findall(r"Mozilla/|AppleWebKit|Chrome/\d|Safari/\d", text)]
    return not found, f"engine files naming a browser: {found or 'none'}"
case(5, "No engine reader poses as a browser", "every request the engine sends names itself as PINR; no file outside the tests carries a browser's user agent", t5)

print(f"\nnetwork calls attempted: {len(CALLS)}")
print(f"{sum(results)}/{len(results)} passed")
sys.exit(0 if all(results) and not CALLS else 1)
