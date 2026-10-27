"""Minimal EVM toolkit for PINR (no third-party packages): keccak-256, call encoding/decoding, the free nodes first, the
official Alchemy key last.
Every piece is checked against reference values in test_evm.py."""
from __future__ import annotations
import json, os, sys, time, threading, urllib.error, urllib.request

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "stage2"))
import solana_rpc as _S          # reuses the .env loader and the parallel helper

# ------------------------------------------------------------------ keccak-256 (Ethereum's hash, not SHA3-256)
_RC = [0x0000000000000001, 0x0000000000008082, 0x800000000000808A, 0x8000000080008000, 0x000000000000808B,
       0x0000000080000001, 0x8000000080008081, 0x8000000000008009, 0x000000000000008A, 0x0000000000000088,
       0x0000000080008009, 0x000000008000000A, 0x000000008000808B, 0x800000000000008B, 0x8000000000008089,
       0x8000000000008003, 0x8000000000008002, 0x8000000000000080, 0x000000000000800A, 0x800000008000000A,
       0x8000000080008081, 0x8000000000008080, 0x0000000080000001, 0x8000000080008008]
_ROT = [[0, 36, 3, 41, 18], [1, 44, 10, 45, 2], [62, 6, 43, 15, 61], [28, 55, 25, 21, 56], [27, 20, 39, 8, 14]]
_M = (1 << 64) - 1


def _rol(x, n):
    return ((x << n) | (x >> (64 - n))) & _M if n else x


def _f(A):
    for rc in _RC:
        C = [A[x][0] ^ A[x][1] ^ A[x][2] ^ A[x][3] ^ A[x][4] for x in range(5)]
        D = [C[(x - 1) % 5] ^ _rol(C[(x + 1) % 5], 1) for x in range(5)]
        A = [[A[x][y] ^ D[x] for y in range(5)] for x in range(5)]
        B = [[0] * 5 for _ in range(5)]
        for x in range(5):
            for y in range(5):
                B[y][(2 * x + 3 * y) % 5] = _rol(A[x][y], _ROT[x][y])
        A = [[B[x][y] ^ ((~B[(x + 1) % 5][y]) & B[(x + 2) % 5][y]) for y in range(5)] for x in range(5)]
        A[0][0] ^= rc
    return A


def keccak256(data: bytes) -> bytes:
    rate = 136
    p = bytearray(data) + b"\x01"
    p += b"\x00" * ((-len(p)) % rate)
    p[-1] |= 0x80
    A = [[0] * 5 for _ in range(5)]
    for off in range(0, len(p), rate):
        blk = p[off:off + rate]
        for i in range(rate // 8):
            x, y = i % 5, i // 5
            A[x][y] ^= int.from_bytes(blk[8 * i:8 * i + 8], "little")
        A = _f(A)
    out = b""
    for i in range(4):
        x, y = i % 5, i // 5
        out += A[x][y].to_bytes(8, "little")
    return out


def selector(sig: str) -> str:
    return keccak256(sig.encode()).hex()[:8]


def topic(sig: str) -> str:
    return "0x" + keccak256(sig.encode()).hex()


# ------------------------------------------------------------------ encoding / decoding (static types + strings)
def enc_address(a: str) -> str:
    return a.lower().replace("0x", "").rjust(64, "0")


def enc_uint(n: int) -> str:
    return hex(n)[2:].rjust(64, "0")


def words(hexdata: str) -> list[str]:
    h = hexdata[2:] if hexdata.startswith("0x") else hexdata
    return [h[i:i + 64] for i in range(0, len(h), 64)]


def dec(word: str, typ: str):
    if typ == "address":
        return "0x" + word[-40:]
    if typ == "bool":
        return int(word, 16) != 0
    if typ.startswith("uint"):
        return int(word, 16)
    if typ.startswith("int"):
        v = int(word, 16)
        return v - (1 << 256) if v >> 255 else v
    if typ.startswith("bytes"):
        return "0x" + word
    raise ValueError(f"unsupported static type {typ}")


def dec_string(hexdata: str, offset_word: str) -> str:
    h = hexdata[2:] if hexdata.startswith("0x") else hexdata
    off = int(offset_word, 16) * 2
    n = int(h[off:off + 64], 16)
    return bytes.fromhex(h[off + 64:off + 64 + n * 2]).decode("utf-8", "ignore")


# ------------------------------------------------------------------ Alchemy RPC
NETS = {"bsc": "bnb-mainnet", "base": "base-mainnet", "eth": "eth-mainnet"}
_last = [0.0]
_lock = threading.Lock()


# ------------------------------------------------------------------ free read pool (operator: "every free and fast avenue")
# Endpoints tested 2026-10-05 (facts EVM file, "Free / fast data sources survey"). Standard reads rotate across them;
# Alchemy is the last resort. "ankr" = the operator's Ankr endpoint from .env. HISTORY = endpoints that answered reads
# 1M blocks back (archive).
# Measured 2026-10-10 (25 calls each): all listed endpoints answered 25/25 in ~0.15-0.27 s. Dropped: 1rpc (usage limit,
# 18 s timeouts), dRPC's BNB endpoint (429 on most calls). Ankr stays in the list but is skipped while its key is disabled.
FREE_POOL = {
    "base": ["https://base-rpc.publicnode.com", "https://mainnet.base.org", "https://base.drpc.org",
             "https://base-mainnet.public.blastapi.io", "ankr"],
    "bsc": ["https://bsc-rpc.publicnode.com", "https://bsc-dataseed.bnbchain.org", "https://bsc-dataseed1.binance.org",
            "https://bsc-dataseed2.defibit.io", "https://bsc-mainnet.nodereal.io/v1/64a9df0874fb4a93b9d0a3849de012d3", "ankr"],
}
HISTORY_POOL = {"base": ["https://mainnet.base.org", "https://base.drpc.org", "https://base.gateway.tenderly.co", "ankr"],
                "bsc": ["https://bsc-mainnet.nodereal.io/v1/64a9df0874fb4a93b9d0a3849de012d3", "ankr"]}
POOL_REST_AFTER = 4                   # failures in a row before an endpoint is rested
POOL_REST_SECONDS = 300               # ... for this long (a provider going bad must never stall the engine again)
_pool_health: dict = {}               # url -> [failures in a row, rest until]
POOL_METHODS = {"eth_call", "eth_getCode", "eth_getBalance", "eth_blockNumber", "eth_getTransactionReceipt",
                "eth_getTransactionByHash", "eth_getBlockByNumber", "eth_chainId"}
POOL_GAP = 0.05                       # seconds between requests to the same free endpoint (~20 per second each)
_pool_state: dict = {}                # url -> [lock, last_time]
_pool_rr = {"n": 0}
_pool_rr_lock = threading.Lock()
PIN: dict = {}                        # chain -> block number every current-state read of the token being scored uses
STATS: dict = {}                      # endpoint -> answered count (for the speed / cost report)


def _pool_url(chain: str, ep: str):
    return _ankr_url(chain) if ep == "ankr" else ep


def _definitive(err) -> bool:
    """A real answer from the chain (the call reverted / doesn't exist), not an outage: never retried elsewhere."""
    m = str(err).lower()
    return "revert" in m or "invalid opcode" in m or "out of gas" in m


def _pool_try(chain: str, ep: str, method: str, params: list):
    url = _pool_url(chain, ep)
    if not url:
        return "skip", None
    hl = _pool_health.setdefault(url, [0, 0.0])
    if time.time() < hl[1]:
        return "skip", None                                  # resting after repeated failures
    kind, val = _pool_try_one(chain, ep, url, method, params)
    if kind == "fail":
        hl[0] += 1
        if hl[0] >= POOL_REST_AFTER:
            hl[0], hl[1] = 0, time.time() + POOL_REST_SECONDS
    else:
        hl[0] = 0
    return kind, val


def _counted(name: str, answered: bool) -> None:
    try:                                  # the saved request count per source (`scanner.py status`); never in the way
        _S.count(name, answered)
    except Exception:
        pass


def _pool_try_one(chain: str, ep: str, url: str, method: str, params: list):
    st = _pool_state.setdefault(url, [threading.Lock(), 0.0])
    with st[0]:
        wait = POOL_GAP - (time.time() - st[1])
        st[1] = time.time() + max(0.0, wait)
    if wait > 0:
        time.sleep(wait)
    try:
        req = urllib.request.Request(url, json.dumps({"jsonrpc": "2.0", "id": 1, "method": method, "params": params}).encode(),
                                     {"content-type": "application/json", "User-Agent": "PINR"})
        r = json.load(urllib.request.urlopen(req, timeout=8))
    except urllib.error.HTTPError as e:
        _counted(_S.label(url), False)
        if ep == "ankr" and e.code in (401, 403):
            _ankr_dead[0] = True
        return "fail", None
    except Exception:
        _counted(_S.label(url), False)
        return "fail", None
    if "error" in r:
        _counted(_S.label(url), _definitive(r["error"]))
        return ("answer", {"ERROR": r["error"]}) if _definitive(r["error"]) else ("fail", None)
    _counted(_S.label(url), True)
    if r.get("result") is None:
        return "miss", None            # this node doesn't have it (yet): the next provider answers (not a failure)
    STATS[ep] = STATS.get(ep, 0) + 1
    return "answer", r["result"]


def pin(chain: str, behind: int = 3):
    """Fix one block for the token about to be scored: a few blocks behind the tip so every node has it."""
    head = rpc(chain, "eth_blockNumber", [])
    if isinstance(head, str):
        PIN[chain] = int(head, 16) - behind
    return PIN.get(chain)


def unpin(chain: str) -> None:
    PIN.pop(chain, None)


def _pinned(chain: str, method: str, params: list) -> list:
    if chain in PIN and method in ("eth_call", "eth_getCode", "eth_getBalance") and params and params[-1] == "latest":
        return params[:-1] + [hex(PIN[chain])]
    return params


def rpc(chain: str, method: str, params: list, tries: int = 6):
    params = _pinned(chain, method, params)
    if method in POOL_METHODS and chain in FREE_POOL:
        blk = params[-1] if method in ("eth_call", "eth_getCode", "eth_getBalance") and params else "latest"
        historical = isinstance(blk, str) and blk.startswith("0x") and not (chain in PIN and int(blk, 16) == PIN[chain])
        pool = HISTORY_POOL[chain] if historical else FREE_POOL[chain]
        with _pool_rr_lock:
            k = _pool_rr["n"]; _pool_rr["n"] += 1
        order = pool[k % len(pool):] + pool[:k % len(pool)]
        for ep in order:
            how, res = _pool_try(chain, ep, method, params)
            if how == "answer":
                return res
    return _rpc_alchemy(chain, method, params, tries)


# the operator's official Alchemy key only (248), counted against its monthly cap with the Solana reads
# (stage2/solana_rpc.py: one allowance per key). EVM methods are billed in compute units by method, as Alchemy's own table
# gives them (alchemy.com/docs/reference/compute-unit-costs, read 2026-10-25, no date shown on the page).
for _m, _cu in (("eth_getLogs", 60), ("eth_call", 26), ("eth_getCode", 20), ("eth_getTransactionReceipt", 20),
                ("eth_getBlockByNumber", 20), ("eth_blockNumber", 10), ("eth_getBalance", 20), ("eth_getTransactionByHash", 20),
                ("eth_chainId", 0)):
    _S.CREDIT_COST.setdefault("alchemy_official", {})[_m] = _cu
ALCHEMY_REST_S = 3600                # a network the key is not enabled for (403) is not asked again for this long
_alchemy_off: dict = {}              # chain -> until


CREATION: dict = {}                  # coin -> {"tx", "block", "ts"}: its creation as the launchpad's list or factory event gave it


def alchemy_ready(chain: str) -> bool:
    """The official key exists, is enabled for this chain (no recent refusal) and the month's cap is not reached."""
    if not (_S._ENV.get("ALCHEMY_OFFICIAL_KEY") or "").strip() or time.time() < _alchemy_off.get(chain, 0):
        return False
    try:
        return not _S._capped("alchemy_official")
    except Exception:
        return True


def _rpc_alchemy(chain: str, method: str, params: list, tries: int = 3):
    """One call on the official key, or None (no key, network not enabled, cap reached, refused). Never a long retry loop:
    the free nodes are the first route and a missing answer stays missing."""
    if not alchemy_ready(chain):
        return None
    url = f"https://{NETS[chain]}.g.alchemy.com/v2/{_S._ENV['ALCHEMY_OFFICIAL_KEY'].strip()}"
    err = None
    for i in range(tries):
        with _lock:
            wait = 0.03 - (time.time() - _last[0])
            _last[0] = time.time() + max(0.0, wait)
        if wait > 0:
            time.sleep(wait)
        try:
            req = urllib.request.Request(url, json.dumps({"jsonrpc": "2.0", "id": 1, "method": method, "params": params}).encode(),
                                         {"content-type": "application/json"})
            r = json.load(urllib.request.urlopen(req, timeout=30))
        except urllib.error.HTTPError as e:
            _counted("alchemy_official", False)
            if e.code in (401, 403):                         # e.g. "BNB_MAINNET is not enabled for this app"
                _alchemy_off[chain] = time.time() + ALCHEMY_REST_S
                return None
            err = f"HTTP {e.code}"; time.sleep(min(8, 2 ** i)); continue
        except Exception as e:
            if type(e).__name__ == "SwitchedOff":                # switched off on pinr.io/control: not asked again for a while
                _alchemy_off[chain] = time.time() + 300
                return None
            _counted("alchemy_official", False)
            err = type(e).__name__; time.sleep(min(8, 2 ** i)); continue
        if "error" in r:
            msg = str(r["error"])
            if "429" in msg or "rate" in msg.lower() or "exceeded" in msg.lower():
                _counted("alchemy_official", False)
                err = msg; time.sleep(min(8, 2 ** i)); continue
            _counted("alchemy_official", True)
            return {"ERROR": r["error"]}
        _counted("alchemy_official", True)
        try:
            _S._spend("alchemy_official", method)
        except Exception:
            pass
        STATS["alchemy"] = STATS.get("alchemy", 0) + 1
        return r["result"]
    if not method.startswith("alchemy_"):
        alt = ankr(chain, method, params)
        if alt is not None:
            return alt                      # Alchemy failed after retries; Ankr answered the same standard call
    return {"ERROR": err}


MULTICALL3 = "0xca11bde05977b3631167028862be2a173976ca11"   # same address on Base and BNB (verified deployed)
_AGG3 = None


def _enc_bytes(h: str) -> str:
    b = h[2:] if h.startswith("0x") else h
    n = len(b) // 2
    return enc_uint(n) + b.ljust(((n + 31) // 32) * 64, "0")


def multicall(chain: str, calls: list, block: str = "latest", chunk: int = 100) -> list:
    """Many eth_calls in one request via Multicall3.aggregate3 (each call allowed to fail on its own).
    Returns one entry per call: its return data, or None if that call failed. If a bundle can't be read as a whole,
    its calls are read one by one, so bundling never turns into missing data."""
    global _AGG3
    _AGG3 = _AGG3 or selector("aggregate3((address,bool,bytes)[])")
    out = []
    for i in range(0, len(calls), chunk):
        part = calls[i:i + chunk]
        heads, tails, pos = [], [], 32 * len(part)
        for to, data in part:
            t = enc_address(to) + enc_uint(1) + enc_uint(96) + _enc_bytes(data)
            heads.append(enc_uint(pos)); tails.append(t); pos += len(t) // 2
        payload = "0x" + _AGG3 + enc_uint(32) + enc_uint(len(part)) + "".join(heads) + "".join(tails)
        r = rpc(chain, "eth_call", [{"to": MULTICALL3, "data": payload}, block])
        res = None
        if isinstance(r, str) and len(r) > 2:
            try:
                h = r[2:]
                word = lambda o: int(h[o * 2:o * 2 + 64], 16)
                base = word(0) + 32                     # start of the array elements (after the length word)
                n = word(word(0))
                if n == len(part):
                    res = []
                    for j in range(n):
                        t0 = base + word(base + 32 * j)
                        ok, boff = word(t0), word(t0 + 32)
                        ln = word(t0 + boff)
                        data = "0x" + h[(t0 + boff + 32) * 2:(t0 + boff + 32 + ln) * 2]
                        res.append(data if ok else None)
            except Exception:
                res = None
        if res is None:
            res = [call(chain, to, data, block) for to, data in part]
        out += res
    return out


# ------------------------------------------------------------------ native coin price from Chainlink (free, on chain)
# Feeds verified 2026-10-05 by description(). max_age = twice the longest normal gap between updates, measured from the
# feeds' own last 12 rounds (Base ETH/USD ~1,230 s heartbeat; BNB BNB/USD ~33 s). Older than that -> not used.
CHAINLINK = {"base": ("0x71041dddad3595f9ced3dccfbe3d1f4b0a16bb70", "ETH / USD", 2500),
             "bsc": ("0x0567f2323251f0aab15c8dfb1967e4e8a7d42aee", "BNB / USD", 120)}


# Other assets priced through Chainlink feeds on Base (description checked on every read). These feeds update on a 0.5%
# (SOL) / 0.3% (USDC) move or at least daily, so a reading up to 25 h old is still within that band.
CHAINLINK_OTHER = {"SOL": ("base", "0xda5fd22f9382e57534feda4ff544878aa1cf401f", "SOL / USD", 90000),
                   "USDC": ("base", "0x7e860098f58bbfc8648a4311b374b1d669a2bc6b", "USDC / USD", 90000)}


def asset_usd(symbol: str):
    """(price in USD, receipt) for a non-native asset from its Chainlink feed, or (None, why)."""
    if symbol not in CHAINLINK_OTHER:
        return None, "no Chainlink feed configured"
    chain, feed, want, max_age = CHAINLINK_OTHER[symbol]
    return _chainlink(chain, feed, want, max_age)


def native_usd(chain: str):
    """(price in USD, receipt text) from the chain's Chainlink feed at the pinned block, or (None, why)."""
    if chain not in CHAINLINK:
        return None, "no Chainlink feed configured"
    return _chainlink(chain, *CHAINLINK[chain])


def _chainlink(chain, feed, want, max_age):
    d = call(chain, feed, "0x" + selector("description()"))
    dc = call(chain, feed, "0x" + selector("decimals()"))
    lr = call(chain, feed, "0x" + selector("latestRoundData()"))
    if not (d and dc and lr):
        return None, "Chainlink feed unreadable"
    if dec_string(d, words(d)[0]) != want:
        return None, "Chainlink feed description mismatch"
    w = words(lr)
    answer, updated = int(w[1], 16), int(w[3], 16)
    if answer >> 255:
        return None, "Chainlink answer negative"
    head_ts = None
    blk = rpc(chain, "eth_getBlockByNumber", [hex(PIN[chain]) if chain in PIN else "latest", False])
    if isinstance(blk, dict):
        head_ts = int(blk["timestamp"], 16)
    if head_ts is None or head_ts - updated > max_age:
        return None, f"Chainlink price older than {max_age}s"
    price = answer / 10 ** int(dc, 16)
    return price, f"Chainlink {want} feed {feed} (updated {head_ts - updated}s before the read block)"


def call(chain: str, to: str, data: str, block: str = "latest"):
    r = rpc(chain, "eth_call", [{"to": to, "data": data}, block])
    return None if isinstance(r, dict) else r


# Ankr: one key for every chain, read from ANKR_ENDPOINT in .env and never
# printed. Tested: 10,000-block log ranges and archive reads on Base and BNB; log records identical to PublicNode's.
ANKR_PATHS = {"base": "base", "bsc": "bsc", "eth": "eth"}


_ankr_dead = [False]                  # set when Ankr says the key is disabled (seen 2026-10-10): skipped until restart


def _ankr_url(chain: str) -> str | None:
    if _ankr_dead[0]:
        return None
    ep = (_S._ENV.get("ANKR_ENDPOINT") or "").strip().rstrip("/")
    key = ep.split("/")[-1] if ep.startswith("https://rpc.ankr.com/") else ""
    return f"https://rpc.ankr.com/{ANKR_PATHS[chain]}/{key}" if key and chain in ANKR_PATHS else None


_ankr_lock = threading.Lock()
_ankr_last = [0.0]


def ankr(chain: str, method: str, params: list, tries: int = 3):
    """One JSON-RPC call to Ankr. Returns the result, or None when unavailable (no key, refused, error)."""
    url = _ankr_url(chain)
    if not url:
        return None
    for i in range(tries):
        with _ankr_lock:
            wait = 0.05 - (time.time() - _ankr_last[0])
            _ankr_last[0] = time.time() + max(0.0, wait)
        if wait > 0:
            time.sleep(wait)
        try:
            req = urllib.request.Request(url, json.dumps({"jsonrpc": "2.0", "id": 1, "method": method, "params": params}).encode(),
                                         {"content-type": "application/json"})
            r = json.load(urllib.request.urlopen(req, timeout=40))
        except urllib.error.HTTPError as e:
            _counted("ankr", False)
            if e.code in (401, 403):
                _ankr_dead[0] = True                         # key disabled / refused: stop asking
                return None
            time.sleep(1.0 * (i + 1)); continue
        except Exception:
            _counted("ankr", False)
            time.sleep(1.0 * (i + 1)); continue
        _counted("ankr", True)
        return r.get("result") if "result" in r else None
    return None


# Free log sources per chain, in order (measured 2026-10-10, after Ankr disabled our key):
#   PublicNode: fast, 2,000 blocks a call, but only recent blocks (about 1 h on BNB, 4 h on Base; older = refused).
#   BNB backlog: NodeReal's public endpoint (weeks deep, 5,000 blocks a call).
#   Base backlog: Tenderly's public gateway (deep, 500 blocks a call), then dRPC's public endpoint (100 a call).
#   Ankr only if its key works. Anything all of them refuse is read from Alchemy in 10-block slices (last resort).
# A range a source refuses is tried on the next one; a reply near the cap is split and re-read, so nothing is ever
# silently missing or cut short.
LOG_SOURCES = {
    "bsc": [("https://bsc-rpc.publicnode.com", 2000), ("https://bsc-mainnet.nodereal.io/v1/64a9df0874fb4a93b9d0a3849de012d3", 5000),
            ("ankr", 10000)],
    "base": [("https://base-rpc.publicnode.com", 2000), ("https://base.gateway.tenderly.co", 500), ("https://base.drpc.org", 100),
             ("ankr", 10000)],
}
PUBLIC_LOGS = {k: v[0] for k, v in LOG_SOURCES.items()}      # kept for callers that only want the first source
PUBLIC_RESULT_CAP = 10_000          # a reply this large may be truncated by the provider -> split and re-read
_src_state: dict = {}               # url -> [lock, last request time]


def _source_logs(chain: str, url: str, flt: dict):
    """One eth_getLogs on one source. list = answer; None = refused / failed / possibly truncated."""
    if url == "ankr":
        r = ankr(chain, "eth_getLogs", [flt])
        return r if isinstance(r, list) and len(r) < PUBLIC_RESULT_CAP else None
    st = _src_state.setdefault(url, [threading.Lock(), 0.0])
    for i in range(3):
        with st[0]:
            wait = 0.12 - (time.time() - st[1])
            st[1] = time.time() + max(0.0, wait)
        if wait > 0:
            time.sleep(wait)
        try:
            req = urllib.request.Request(url, json.dumps({"jsonrpc": "2.0", "id": 1, "method": "eth_getLogs", "params": [flt]}).encode(),
                                         {"content-type": "application/json", "User-Agent": "PINR"})
            r = json.load(urllib.request.urlopen(req, timeout=40))
        except urllib.error.HTTPError as e:
            _counted(_S.label(url), False)
            if e.code in (400, 401, 403, 413):
                return None         # refused (e.g. history it doesn't keep): fail fast, the next source reads it
            time.sleep(1.5 * (i + 1)); continue
        except Exception:
            _counted(_S.label(url), False)
            time.sleep(1.5 * (i + 1)); continue
        _counted(_S.label(url), True)
        if isinstance(r.get("result"), list) and len(r["result"]) < PUBLIC_RESULT_CAP:
            return r["result"]
        return None
    return None


def _public_logs(chain: str, flt: dict):
    return _source_logs(chain, LOG_SOURCES[chain][0][0], flt)


def _read_span(chain: str, base_flt: dict, lo: int, hi: int):
    """Logs for blocks lo..hi from the first free source that serves all of it, or None."""
    for url, cap in LOG_SOURCES.get(chain, []):
        if url == "ankr" and not _ankr_url(chain):
            continue
        out, ok, a = [], True, lo
        while a <= hi:
            b = min(a + cap - 1, hi)
            r = _source_logs(chain, url, dict(base_flt, fromBlock=hex(a), toBlock=hex(b)))
            if r is None and b - a >= 50:               # refused or too many results: try this stretch in halves once
                mid = (a + b) // 2
                r1 = _source_logs(chain, url, dict(base_flt, fromBlock=hex(a), toBlock=hex(mid)))
                r2 = _source_logs(chain, url, dict(base_flt, fromBlock=hex(mid + 1), toBlock=hex(b))) if r1 is not None else None
                r = (r1 + r2) if (r1 is not None and r2 is not None) else None
            if r is None:
                ok = False
                break
            out += r
            a = b + 1
        if ok:
            return out
    return None


def logs(chain: str, address, topic0, from_block: int, to_block: int, slice_size: int = 10, topic1: str | None = None,
         workers: int = 4, span: int | None = None, topics: list | None = None):
    """eth_getLogs over a block range from the free sources in LOG_SOURCES order; any stretch none of them serves is
    read from Alchemy in small slices (the free plan allows 10 blocks per call).
    Returns (logs, complete). Any failed slice -> complete False (never silently missing)."""
    tops = topics if topics is not None else ([topic0] if topic1 is None else [topic0, topic1])
    if chain in LOG_SOURCES:
        big = span or 2000
        bigspans = [(b, min(b + big - 1, to_block)) for b in range(from_block, to_block + 1, big)]
        base_flt = {"address": address, "topics": tops}
        got = _S.pmap(lambda s_: _read_span(chain, base_flt, s_[0], s_[1]), bigspans, workers=workers)
        out, ok, rest = [], True, []
        for s_, r in zip(bigspans, got):
            if r is None:
                rest.append(s_)
            else:
                out += r
        for lo, hi in rest:
            more, k = logs_alchemy(chain, address, tops, lo, hi, slice_size)
            out += more; ok = ok and k
        return out, ok
    return logs_alchemy(chain, address, tops, from_block, to_block, slice_size)


def logs_alchemy(chain: str, address: str, tops: list, from_block: int, to_block: int, slice_size: int = 10):
    spans = [(b, min(b + slice_size - 1, to_block)) for b in range(from_block, to_block + 1, slice_size)]
    res = _S.pmap(lambda s: rpc(chain, "eth_getLogs", [{"address": address, "topics": tops,
                                                        "fromBlock": hex(s[0]), "toBlock": hex(s[1])}]), spans)
    out, ok = [], True
    for r in res:
        if isinstance(r, list):
            out += r
        else:
            ok = False
    return out, ok
