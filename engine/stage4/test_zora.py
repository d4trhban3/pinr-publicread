"""Zora reader. One real CoinCreatedV4 event read from Base on 2026-10-25
(zora_created_fixture.json) and made-up answers in the chain's real shapes; no network (any real request fails the run)."""
import json, os, sys, tempfile, urllib.request
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
os.environ["PINR_IPFS_REST_FILE"] = os.path.join(tempfile.mkdtemp(), "ipfs_rest.sqlite")


def _no_network(*a, **k):
    raise AssertionError("a test reached for the network")


urllib.request.urlopen = _no_network
import zora_reader as Z
from evm import enc_address, enc_uint
from readers import Log

results = []
def case(n, title, should, fn):
    try:
        ok, text = fn()
    except Exception as e:
        import traceback; traceback.print_exc()
        ok, text = False, f"CRASH {type(e).__name__}: {e}"
    results.append(ok)
    print(f"\n{n:>2}. {title}\n    should: {should}\n    did:    {text}\n    {'PASS' if ok else 'FAIL'}")


FX = json.load(open(os.path.join(HERE, "zora_created_fixture.json")))


def c1():
    got = Z.decode_created(FX["log"])
    exp = FX["expect"]
    ok = all(got[k] == exp[k] for k in exp) and Z.pool_id_of(got["pool_key"]) == got["pool_id"]
    return ok, f"creator payout {got['payout_recipient'][:10]}…, coin {got['coin'][:10]}…, hook {got['pool_key']['hooks'][:10]}…, version {got['version']}; pool id = keccak(poolKey): {Z.pool_id_of(got['pool_key']) == got['pool_id']}"


def c2():
    other = dict(FX["log"], address="0x" + "11" * 20)
    wrong = dict(FX["log"], topics=["0x" + "00" * 32] + FX["log"]["topics"][1:])
    key = dict(FX["expect"]["pool_key"], fee=FX["expect"]["pool_key"]["fee"] + 1)
    return (Z.decode_created(other) is None and Z.decode_created(wrong) is None and Z.pool_id_of(key) != FX["expect"]["pool_id"]), \
        "another contract's log and another event refused; a changed pool key gives another pool id"


def c3():
    a1, a2 = "0x" + "a1" * 20, "0x" + "b2" * 20
    owners_ret = "0x" + enc_uint(32) + enc_uint(2) + enc_address(a1) + enc_address(a2)
    pos = [(-887200, -500, 10 ** 20), (-500, 887200, 5 * 10 ** 19)]
    tw = lambda t: enc_uint(t % (1 << 256))
    poolcoin = "0x" + enc_uint(32) + enc_address(FX["coin"]) + enc_uint(64) + enc_uint(len(pos)) + "".join(tw(a) + tw(b) + enc_uint(l) for a, b, l in pos)
    keep = Z.call
    Z.call = lambda chain, to, data, block="latest": owners_ret if data.startswith("0x" + Z.selector("owners()")) else poolcoin
    try:
        got_o = Z.owners(FX["coin"])
        got_p = Z.hook_positions(FX["expect"]["pool_key"]["hooks"], FX["expect"]["pool_key"])
    finally:
        Z.call = keep
    return got_o == [a1, a2] and got_p == pos, f"owners {len(got_o or [])}; hook positions {got_p}"


def c4():
    log = Log()
    none_read = Z.coin_links("ipfs://bafkreidoc", log, doc_read=lambda u: None)
    listed = Z.coin_links("ipfs://bafkreidoc", log, doc_read=lambda u: {"name": "x", "twitter": "https://x.com/z", "website": "https://z.example"})
    empty = Z.coin_links("ipfs://bafkreidoc", log, doc_read=lambda u: {"name": "x", "description": "a post"})
    no_uri = Z.coin_links(None, log, doc_read=lambda u: {"twitter": "https://x.com/z"})
    ok = (none_read is None and no_uri is None and listed["twitter"] == "https://x.com/z" and listed["website"] == "https://z.example"
          and empty == {"twitter": None, "website": None, "telegram": None, "farcaster": None})
    return ok, f"document not read -> {none_read} (unknown, never 'none'); read with links -> {listed['twitter']}; read with none -> all empty"


def c5():
    got = Z.zora_price("0x" + "c3" * 20, get=lambda u: {"zora20Token": {"tokenPrice": {"priceInUsdc": "0.0000023"}}})
    unknown = Z.zora_price("0x" + "c3" * 20, get=lambda u: {"zora20Token": None})
    zero = Z.zora_price("0x" + "c3" * 20, get=lambda u: {"zora20Token": {"tokenPrice": {"priceInUsdc": "0"}}})
    return got == 0.0000023 and unknown is None and zero is None, f"Zora's record {got}; unknown coin -> {unknown}; a zero price -> {zero} (never a fake zero)"




case(1, "Zora's CoinCreatedV4, decoded from a real event", "creator, payout recipient, referrer, paired currency, coin, pool key and version as the chain has them; the pool id is keccak(poolKey)", c1)
case(2, "Only Zora's own event", "another contract's log, another event and a changed pool key are refused or give another id", c2)
case(3, "Owners and the hook's positions", "owners() and getPoolCoin(poolKey).positions decoded from the contracts' own return shapes", c3)
case(4, "The coin's own links", "read from its metadata document; a document not read leaves the links unknown, never 'none'", c4)
case(5, "A paired Zora coin's price", "Zora's own record; an unknown coin or a zero price is no price", c5)
print(f"\n{sum(results)}/{len(results)} passed")
raise SystemExit(0 if all(results) else 1)
