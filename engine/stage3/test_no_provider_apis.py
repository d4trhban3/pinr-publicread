"""no read depends on Helius or Alchemy. Every former provider-only path answers from the chain's standard
JSON-RPC methods, on any node, with or without a Helius key; Helius stays usable as an ordinary node, counted and capped.
Offline: Python's request function is replaced by a made-up chain that answers only standard Solana methods and records
every request; waiting is skipped; temporary count files.  Run:  python3 test_no_provider_apis.py"""
import io, json, os, re, sys, tempfile, urllib.request
HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.join(HERE, "..")
sys.path.insert(0, os.path.join(ROOT, "stage2")); sys.path.insert(0, HERE); sys.path.insert(0, os.path.join(ROOT, "feed"))
import solana_rpc as S

S.COUNT_DB = os.path.join(tempfile.mkdtemp(), "requests.sqlite")
S.PACE_DB = os.path.join(tempfile.mkdtemp(), "solana_pace.sqlite")
S.time.sleep = lambda s: None
SETTINGS = os.path.join(tempfile.mkdtemp(), "settings.json")
S.SETTINGS = SETTINGS
json.dump({"helius_monthly_credit_cap": 9_500_000}, open(SETTINGS, "w"))
for k in ("HELIUS_API_KEY", "SHYFT_API_KEY"):
    S._ENV.pop(k, None)
    os.environ.pop(k, None)
PUBLIC = "https://made-up-node.example/rpc"
HEL = "https://mainnet.helius-rpc.com/?api-key=made-up-key"
STANDARD = {"getSignaturesForAddress", "getTransaction", "getMultipleAccounts", "getAccountInfo", "getBalance", "getSlot",
            "getTokenAccountsByOwner", "getTokenLargestAccounts", "getProgramAccounts", "getBlockTime"}
PROVIDER_ONLY = {"getTransactionsForAddress", "getAsset", "getAssetBatch", "getAssetsByOwner", "searchAssets"}
ASKED = []
SIGS = [{"signature": f"made-up-sig-{i}", "slot": 100 + i, "blockTime": 1_700_000_000 + i, "err": None} for i in range(3)]


def raw_tx(sig):
    return {"slot": 100, "blockTime": 1_700_000_000, "version": 0,
            "transaction": {"signatures": [sig], "message": {"accountKeys": [{"pubkey": "MadeUpWallet1111111111111111111111111111111", "signer": True, "writable": True}],
                                                             "instructions": []}},
            "meta": {"err": None, "fee": 5000, "preBalances": [10 ** 9], "postBalances": [10 ** 9 - 5000], "preTokenBalances": [],
                     "postTokenBalances": [], "innerInstructions": [], "logMessages": [], "loadedAddresses": {"writable": [], "readonly": []}}}


def _urlopen(req, timeout=None):
    url = req.full_url if hasattr(req, "full_url") else str(req)
    body = json.loads(req.data) if getattr(req, "data", None) else {}
    method = body.get("method") if isinstance(body, dict) else None
    ASKED.append((url.split("/")[2].split("?")[0], method or url.split("?")[0]))
    if method not in STANDARD:
        raise OSError(f"not a standard Solana method: {method or url}")
    p = body.get("params") or []
    if method == "getSignaturesForAddress":
        res = [] if (len(p) > 1 and isinstance(p[1], dict) and p[1].get("before")) else SIGS
    elif method == "getTransaction":
        res = raw_tx(p[0])
    elif method == "getMultipleAccounts":
        res = {"context": {"slot": 1}, "value": [None for _ in p[0]]}
    elif method == "getAccountInfo":
        res = {"context": {"slot": 1}, "value": None}
    else:
        res = 1
    return io.BytesIO(json.dumps({"jsonrpc": "2.0", "id": body.get("id", 1), "result": res}).encode())


urllib.request.urlopen = _urlopen
import feed_export as F
import readers as R
import dev_history as D
import scan_c as C
import sol_cache as SC
SC.DB = os.path.join(tempfile.mkdtemp(), "solana_cache.sqlite")

results = []


def case(n, title, fn):
    try:
        ok, said = fn()
    except Exception as e:
        ok, said = False, f"CRASH {type(e).__name__}: {e}"
    results.append(ok)
    print(f"{n}. {title}\n   {'PASS' if ok else 'FAIL'}: {said}")


def fresh(endpoints):
    S._dead.clear(); S._ASIDE_UNTIL.clear(); S._credits.clear(); S._credit_seen.update(at=0.0, month=None, saved={})
    S.COUNT_DB = os.path.join(tempfile.mkdtemp(), "requests.sqlite"); ASKED.clear()
    S.ENDPOINTS[:] = endpoints


PATHS = [   # every former provider-only path, as its callers call it
    ("dev history: a wallet's history", lambda: D.Helius().history("MadeUpWallet", max_pages=2)),
    ("dev history: the wallet's creations", lambda: D.Helius().creates("MadeUpWallet")),
    ("dev history: names for many coins", lambda: D.Helius().assets(["MadeUpMintA", "MadeUpMintB"])),
    ("the cache's history (new pages after a stored read)", lambda: (SC._put("history:MadeUpCached", {"txs": [{"signature": "made-up-sig-9", "timestamp": 1}], "complete": True}),
                                                                       SC.history(D.Helius(), "MadeUpCached", max_pages=1))[1]),
    ("scan_c: parsed transactions", lambda: C.parse(D.Helius(), ["made-up-sig-0", "made-up-sig-1"])),
    ("reader: a wallet's transactions scanned", lambda: R._scan("MadeUpWallet", lambda t: 1, 1000)),
    ("request module: full history, oldest first", lambda: S.history_full("MadeUpWallet")),
    ("request module: signature history, oldest first", lambda: S.history_asc("MadeUpWallet")),
    ("feed: the coin's name and picture", lambda: F._solana_meta("MadeUpMint")),
]


def c1():
    fresh([("public", PUBLIC, 0.0)])
    try:
        D.Helius(); D.ChainHistory()
    except Exception as e:
        return False, f"the dev reader would not start without a key: {e}"
    return D.Helius is D.ChainHistory and "HELIUS_API_KEY" not in S._ENV, "the dev reader starts with no HELIUS_API_KEY at all (the old one refused: every Solana score failed)"


def run_all(endpoints):
    out = []
    for name, run in PATHS:
        fresh(endpoints)
        got = run()
        out.append((name, got, list(ASKED)))
    return out


def c2():
    got = run_all([("public", PUBLIC, 0.0)])
    bad = [(n, a) for n, _g, a in got if not a or any(m not in STANDARD for _h, m in a)]
    answered = [n for n, g, _a in got if g is None or (isinstance(g, tuple) and g[0] is None)]
    return not bad and not answered, (f"every path answered from standard methods only, e.g. {got[0][2][:2]}"
                                      if not bad and not answered else f"provider-only or nothing asked: {bad}; no answer: {answered}")


def c3():
    S._ENV["HELIUS_API_KEY"] = "made-up-key"
    try:
        got = run_all([("helius", HEL, 0.0)])                  # Helius as the only node, NOT set aside: still standard methods only
    finally:
        S._ENV.pop("HELIUS_API_KEY", None)
    calls = [m for _n, _g, a in got for _h, m in a]
    bad = [m for m in calls if m in PROVIDER_ONLY or m not in STANDARD]
    hosts = {h for _n, _g, a in got for h, _m in a}
    return not bad and hosts == {"mainnet.helius-rpc.com"}, f"{len(calls)} requests to Helius as an ordinary node, all standard methods; provider-only: {bad or 'none'}"


def c4():
    json.dump({"helius_monthly_credit_cap": 5}, open(SETTINGS, "w"))
    S._ENV["HELIUS_API_KEY"] = "made-up-key"
    try:
        fresh([("helius", HEL, 0.0)]); S.rpc("getBalance", ["MadeUpWallet"]); one = S.month_credits("helius")
        fresh([("helius", HEL, 0.0)]); S._credits[(S._month(), "helius")] = 5
        S.rpc("getBalance", ["MadeUpWallet"]); at_cap = len(ASKED)
    finally:
        json.dump({"helius_monthly_credit_cap": 9_500_000}, open(SETTINGS, "w"))
        S._ENV.pop("HELIUS_API_KEY", None)
    return one == 1 and at_cap == 0, f"an ordinary read on Helius counts {one} credit; at the cap it sends {at_cap} requests"


def c5():
    """No live file calls a provider-only API (a new path cannot bring one back). The two Alchemy paths of the EVM side
    are named here so the list cannot grow."""
    pat = re.compile(r"api\.helius\.xyz|\"getTransactionsForAddress\"|\"getAsset\"|\"getAssetBatch\"|HELIUS_API_KEY missing")
    alchemy = re.compile(r"alchemy_getAssetTransfers|alchemy_prices_usd|api\.g\.alchemy\.com/prices")
    words_only = {"stage2/solana_rpc.py"}                     # its credit table and host labels name methods and hosts; it calls none of them
    found, alc = [], set()
    for d in ("stage2", "stage3", "stage4", "feed", "scanner", "pinr-index"):
        for f in sorted(os.listdir(os.path.join(ROOT, d))):
            rel = f"{d}/{f}"
            if not f.endswith(".py") or f.startswith("test_"):
                continue
            src = open(os.path.join(ROOT, d, f)).read()
            if pat.search(src) and rel not in words_only:
                found.append(rel)
            if alchemy.search(src):
                alc.add(rel)
    rpc_src = open(os.path.join(ROOT, "stage2", "solana_rpc.py")).read()
    calls_in_rpc = re.findall(r"_call\([^)]*\"(getTransactionsForAddress|getAsset|getAssetBatch)\"", rpc_src)
    later = {"feed/feed_export.py", "scanner/scanner.py", "stage4/flap_reader.py", "stage4/fourmeme_reader.py", "stage4/clanker_reader.py",
             "stage4/clanker_old_reader.py", "stage4/bankr_reader.py", "stage4/evm_linked.py"}   # the EVM side: ops/PLAN-198, E1 to E3
    return not found and not calls_in_rpc and alc <= later, (f"no live file calls a Helius-only API; the Alchemy names stay only in the EVM files planned for its return: {sorted(alc)}"
                                                           if not found and not calls_in_rpc and alc <= later else f"provider-only call in {found} {calls_in_rpc}; Alchemy outside the planned files: {sorted(alc - later)}")


def c6():
    order = S.provider_order(os.path.join(ROOT, "scanner", "settings.json"))
    return order == ["shyft", "chainstack", "helius", "helius_official", "alchemy_official"] and S.ORDER_NOTE[0] is None, f"the repo's Solana order: {order} "


def c7():
    gap = S._KNOWN["public"][1]
    return gap >= 0.25, f"the public node is paced {gap} s apart for all workers together: {1 / gap:g} a second, within 10 a second overall and 4 a second per method"


case(1, "The dev reader starts without any Helius key", c1)
case(2, "Every former Helius-only path answers from standard Solana methods on an ordinary node", c2)
case(3, "With a Helius key and Helius open, the same paths still call no provider-only method", c3)
case(4, "Helius as an ordinary node is still counted and capped", c4)
case(5, "No live file calls a provider-only API; Alchemy's names only in the EVM files planned for later", c5)
case(6, "The repo's provider order puts Helius last of the ordinary nodes, the official keys after it", c6)
case(7, "Solana's public node within its published limits (100 per 10 s per IP, 40 per method)", c7)
print(f"\n{sum(results)}/{len(results)} passed")
raise SystemExit(0 if all(results) else 1)
