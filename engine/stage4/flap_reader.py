"""Flap.sh (BNB Chain) reader, Stage 4. Every number is read from chain with a receipt; nothing is guessed.
Facts behind it: facts file section 15 (price & reserve confirmed against real trades; graduation to PancakeSwap v2
with LP burned; tokens are EIP-1167 clones of the verified FlapTaxTokenV3, owned by the Flap Portal).
"""
from __future__ import annotations
import calendar, json, os, sys, time, urllib.request
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "stage2"))
sys.path.insert(0, os.path.join(HERE, "..", "pinr-score"))
from evm import rpc, call, selector, enc_address, enc_uint, words, dec, dec_string, topic
from readers import Log
import solana_rpc as _S
import score_engine_v1 as E

CHAIN = "bsc"
PORTAL = "0xe2cE6ab80874Fa9Fa2aAE65D277Dd6B8e65C9De0"
PCS_V2_FACTORY = "0xca143ce32fe78f1f7019d7d551a6402fc5350c73"
WBNB = "0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c"
DEAD = ("0x000000000000000000000000000000000000dead", "0x0000000000000000000000000000000000000000")
FIXED_TOKEN_IMPLS = {"0x024f18294970b5c76c0691b87f138a0317156422": "FlapTaxTokenV3 (verified, no mint/pause/blacklist)"}
STATUS = {1: "on curve", 4: "graduated"}          # observed values; others are reported raw
_ABI = json.load(open(os.path.join(HERE, "flap_portal_abi.json")))
_STATE = [x for x in _ABI if x.get("name") == "getTokenV9Safe"][0]["outputs"][0]["components"]
TOKEN_CREATED = topic("TokenCreated(uint256,address,uint256,address,string,string,string)")


_S.CREDIT_COST.setdefault("alchemy_official", {})["alchemy_getAssetTransfers"] = 120   # Alchemy's own table (read 2026-10-25), as in evm.py


def first_transfer(chain: str, token: str):
    """The coin's first transfer (its mint), in the shape of Alchemy's transfer record ({"hash", "blockNum",
    "metadata": {"blockTimestamp"}}): from the creation PINR already read (`CREATION`, set by chains/score.py), else Alchemy's
    transfer history on the official key; None when neither has it (missing stays missing)."""
    from evm import CREATION
    h = CREATION.get(token.lower())
    if h and h.get("tx") and h.get("ts"):
        ts = h.get("ts")
        return {"hash": h["tx"], "blockNum": hex(h["block"]) if h.get("block") else None,
                "metadata": {"blockTimestamp": time.strftime("%Y-%m-%dT%H:%M:%S.000Z", time.gmtime(ts)) if ts else None}}
    r = rpc(chain, "alchemy_getAssetTransfers", [{"contractAddresses": [token], "category": ["erc20"], "order": "asc",
                                                  "maxCount": "0x1", "withMetadata": True, "fromBlock": "0x0"}])
    return r["transfers"][0] if isinstance(r, dict) and r.get("transfers") else None


NATIVE = {"base": "ETH", "bsc": "BNB"}


def first_funding(chain: str, wallet: str, rpc_fn=None):
    """Checklist 6, CHAINS: where a Base/BNB wallet's money first came from, the way funding_source.py reads
    it for Solana: the wallet's oldest incoming ETH/BNB transfer and who sent it, from Alchemy's transfer history on the
    official key (counted under its cap). Base asks for contract-sent transfers too (smart wallets are often first paid
    that way); BNB asks for direct ones only. {"wallet", "funder", "value", "unit", "funded_at", "tx", "block"};
    {"wallet", "funder": None} when the history holds none; None when it could not be read (missing stays missing)."""
    rpc_fn = rpc_fn or rpc
    q = lambda cats: rpc_fn(chain, "alchemy_getAssetTransfers", [{"toAddress": wallet, "category": cats, "order": "asc", "maxCount": "0x1",
                                                                  "withMetadata": True, "excludeZeroValue": True, "fromBlock": "0x0"}])
    r = q(["external", "internal"] if chain == "base" else ["external"])
    if chain == "base" and not isinstance(r, dict):
        r = q(["external"])                                    # refused with contract-sent transfers: direct ones only
    if not isinstance(r, dict) or not isinstance(r.get("transfers"), list):
        return None
    if not r["transfers"]:
        return {"wallet": wallet.lower(), "funder": None}
    t = r["transfers"][0]
    try:
        ts = calendar.timegm(time.strptime(t["metadata"]["blockTimestamp"][:19], "%Y-%m-%dT%H:%M:%S"))
        return {"wallet": wallet.lower(), "funder": str(t["from"]).lower(), "value": float(t["value"]) if t.get("value") is not None else None,
                "unit": NATIVE.get(chain, t.get("asset")), "funded_at": ts, "tx": t.get("hash"), "block": int(t["blockNum"], 16)}
    except (KeyError, TypeError, ValueError):
        return None

def native_price(chain: str, symbol: str):
    """(USD price, source text): Chainlink on chain first (free, verified, fresh), Alchemy's price API as fallback."""
    from evm import native_usd
    p, why = native_usd(chain)
    if p is not None:
        return p, why
    q = alchemy_prices_usd(symbols=(symbol,)).get(symbol, (None,))[0]
    return q, f"Alchemy Prices API ({symbol}; Chainlink not used: {why})"


def _counted(name: str, answered: bool) -> None:
    try:                                  # the saved request count per source (`scanner.py status`); never in the way
        _S.count(name, answered)
    except Exception:
        pass


def alchemy_prices_usd(symbols=(), addresses=(), network: str = "bnb-mainnet"):
    """Alchemy's Prices API on the official key (248); {} when there is no key or it is not answering (missing stays
    missing: the caller's Chainlink read comes first). Never raises."""
    key = (_S._ENV.get("ALCHEMY_OFFICIAL_KEY") or "").strip()
    if not key:
        return {}
    try:
        return _alchemy_prices(key, symbols, addresses, network)
    except Exception:
        return {}


def token_price_usd(address: str, network: str):
    """(USD price or None, source words) for one token by address, from Alchemy's Prices API on the official key (the
    readers outside the planned EVM files ask through here: stage3/test_no_provider_apis.py)."""
    return alchemy_prices_usd(addresses=(address,), network=network).get(address, (None,))[0], f"Alchemy Prices API ({address})"


def _alchemy_prices(key, symbols, addresses, network):
    out = {}
    if symbols:
        q = "&".join(f"symbols={s}" for s in symbols)
        try:
            r = json.load(urllib.request.urlopen(urllib.request.Request(
                f"https://api.g.alchemy.com/prices/v1/{key}/tokens/by-symbol?{q}", headers={"User-Agent": "PINR"}), timeout=30))
        except Exception:
            _counted("alchemy-prices", False); raise
        _counted("alchemy-prices", True)
        for d in r.get("data", []):
            p = (d.get("prices") or [{}])[0]
            if p.get("value"):
                out[d["symbol"]] = (float(p["value"]), p.get("lastUpdatedAt"))
    for a in addresses:
        body = json.dumps({"addresses": [{"network": network, "address": a}]}).encode()
        try:
            r = json.load(urllib.request.urlopen(urllib.request.Request(
                f"https://api.g.alchemy.com/prices/v1/{key}/tokens/by-address", body,
                {"content-type": "application/json", "User-Agent": "PINR"}), timeout=30))
        except Exception:
            _counted("alchemy-prices", False); raise
        _counted("alchemy-prices", True)
        for d in r.get("data", []):
            p = (d.get("prices") or [{}])[0]
            if p.get("value"):
                out[a.lower()] = (float(p["value"]), p.get("lastUpdatedAt"))
    return out


def state(token: str, block: str = "latest"):
    out = call(CHAIN, PORTAL, "0x" + selector("getTokenV9Safe(address)") + enc_address(token), block)
    return None if out is None else {c["name"]: dec(w, c["type"]) for c, w in zip(_STATE, words(out))}


def erc20(token: str, fn: str, *args):
    data = "0x" + selector(fn) + "".join(enc_address(a) if isinstance(a, str) else enc_uint(a) for a in args)
    r = call(CHAIN, token, data)
    return None if r is None else words(r)


def creation(token: str):
    """First transfer of the token (its mint) -> creation tx -> Flap TokenCreated event -> creator and time."""
    t = first_transfer(CHAIN, token)                      # PINR's own creation read first, else Alchemy
    if t is None:
        return None
    rc = rpc(CHAIN, "eth_getTransactionReceipt", [t["hash"]])
    if not isinstance(rc, dict):
        return None
    for l in rc["logs"]:
        if l["address"].lower() == PORTAL.lower() and l["topics"][0] == TOKEN_CREATED:
            w = words(l["data"])
            if dec(w[3], "address").lower() == token.lower():
                return {"creator": dec(w[1], "address"), "launch_ts": dec(w[0], "uint256"), "tx": t["hash"],
                        "block": int(rc["blockNumber"], 16), "name": dec_string(l["data"], w[4]),
                        "symbol": dec_string(l["data"], w[5]), "meta": dec_string(l["data"], w[6])}
    return None


MOVES_SOURCE: dict = {}     # coin -> the sources its dev moves were read from (the receipt names them truthfully)
ALCHEMY_MOVES, FREE_MOVES = "Alchemy transfer records", "Transfer logs on free nodes (eth_getLogs)"


def moves_source(token: str) -> str:
    return " + ".join(sorted(MOVES_SOURCE.get(token.lower()) or {ALCHEMY_MOVES}))


def dev_moves(token: str, dev: str, chain: str = CHAIN, to_block: int | None = None):
    """Every movement of the token in or out of the dev wallet (Alchemy transfer records, with timestamps).
    to_block: stop at that block (used for the 24 h after a handoff, so big wallets' later history isn't read)."""
    moves = []
    for direction in ("toAddress", "fromAddress"):
        page = None
        while True:
            q = {"contractAddresses": [token], "category": ["erc20"], "order": "asc", "withMetadata": True,
                 "fromBlock": "0x0", direction: dev, "maxCount": "0x3e8"}
            if to_block is not None:
                q["toBlock"] = hex(to_block)
            if page:
                q["pageKey"] = page
            r = rpc(chain, "alchemy_getAssetTransfers", [q])
            if not isinstance(r, dict):
                MOVES_SOURCE.setdefault(token.lower(), set()).add(FREE_MOVES)
                return dev_moves_free(token, dev, chain, to_block)     # the free nodes' Transfer logs
            MOVES_SOURCE.setdefault(token.lower(), set()).add(ALCHEMY_MOVES)
            for t in r.get("transfers", []):
                ts = calendar.timegm(time.strptime(t["metadata"]["blockTimestamp"][:19], "%Y-%m-%dT%H:%M:%S"))   # UTC, no DST
                amt = int(t["rawContract"]["value"], 16) / 10 ** int(t["rawContract"].get("decimal") or "0x12", 16)
                moves.append({"t": ts, "block": int(t["blockNum"], 16), "dir": "in" if direction == "toAddress" else "out", "amount": amt,
                              "kind": "transfer", "signature": t["hash"], "counterparty": t["from"] if direction == "toAddress" else t["to"]})
            page = r.get("pageKey")
            if not page:
                break
    moves.sort(key=lambda m: m["t"])
    return moves


TRANSFER = topic("Transfer(address,address,uint256)")


def dev_moves_free(token: str, dev: str, chain: str = CHAIN, to_block: int | None = None):
    """The same moves as dev_moves, from the token's own Transfer logs on the free nodes (eth_getLogs, from the coin's
    creation block, which PINR read itself: evm.CREATION). None when the creation block is not known or any stretch went
    unread (missing stays missing, never a partial history)."""
    from evm import CREATION, logs, rpc as _rpc
    h = CREATION.get(token.lower()) or {}
    if not h.get("block"):
        return None
    if to_block is None:
        tip = _rpc(chain, "eth_blockNumber", [])
        if not isinstance(tip, str):
            return None
        to_block = int(tip, 16) - 3
    d = erc20(token, "decimals()") if chain == CHAIN else None
    if chain != CHAIN:
        out = call(chain, token, "0x" + selector("decimals()"))
        d = words(out) if out else None
    decimals = dec(d[0], "uint256") if d else 18
    pad = "0x" + "0" * 24 + dev.lower()[2:]
    moves, times = [], {}
    for direction, tops in (("in", [TRANSFER, None, pad]), ("out", [TRANSFER, pad])):
        got, complete = logs(chain, token, None, h["block"], to_block, topics=tops)
        if not complete:
            return None
        for l in got:
            b = int(l["blockNumber"], 16)
            bts = l.get("blockTimestamp")
            if isinstance(bts, str) and bts.startswith("0x"):
                ts = int(bts, 16)
            else:
                if b not in times:
                    blk = _rpc(chain, "eth_getBlockByNumber", [hex(b), False])
                    times[b] = int(blk["timestamp"], 16) if isinstance(blk, dict) and blk.get("timestamp") else None
                ts = times[b]
                if ts is None:
                    return None
            other = "0x" + (l["topics"][1] if direction == "in" else l["topics"][2])[-40:]
            moves.append({"t": ts, "block": b, "dir": direction, "amount": int(l["data"], 16) / 10 ** decimals, "kind": "transfer",
                          "signature": l["transactionHash"], "counterparty": other.lower()})
    moves.sort(key=lambda m: m["t"])
    return moves


def read(token: str, log: Log) -> dict:
    """All Flap readings for one token. Missing data stays missing."""
    st = state(token)
    if st is None:
        return {"error": "Flap state unreadable"}
    log.add("Flap state", {k: st[k] for k in ("status", "reserve", "price", "circulatingSupply", "buyTaxRate", "sellTaxRate", "pool", "dexId", "quoteTokenAddress")},
            "raw", f"getTokenV9Safe({token}) on {PORTAL}")
    ts = erc20(token, "totalSupply()")
    supply = dec(ts[0], "uint256") / 1e18 if ts else None
    quote = st["quoteTokenAddress"]
    is_bnb = int(quote, 16) == 0
    if is_bnb:
        q_usd, q_src = native_price("bsc", "BNB")
    else:
        from quote_price import quote_usd                     # its own PancakeSwap pool, anchored to Chainlink BNB/USD
        q_usd, q_src = quote_usd(quote)
    log.add("quote asset price", q_usd, "USD", q_src)
    out = {"status": STATUS.get(st["status"], f"status {st['status']}"), "supply": supply, "quote_usd": q_usd,
           "buy_tax": st["buyTaxRate"] / 10000, "sell_tax": st["sellTaxRate"] / 10000, "real_usd": None, "valuation_usd": None,
           "lp_buckets": None, "pool": None}
    if st["status"] == 4 and int(st["pool"], 16):
        pool = st["pool"]
        fac = call(CHAIN, pool, "0x" + selector("factory()"))
        res = call(CHAIN, pool, "0x" + selector("getReserves()"))
        t0 = call(CHAIN, pool, "0x" + selector("token0()"))
        if fac and ("0x" + fac[-40:]).lower() == PCS_V2_FACTORY and res and t0:
            r0, r1 = dec(words(res)[0], "uint256"), dec(words(res)[1], "uint256")
            tok_is0 = ("0x" + t0[-40:]).lower() == token.lower()
            tok_res, q_res = (r0, r1) if tok_is0 else (r1, r0)
            out["pool"] = pool
            if q_usd and tok_res:
                out["real_usd"] = q_res / 1e18 * q_usd
                out["valuation_usd"] = (q_res / tok_res) * supply * q_usd if supply else None
            lp_total = dec(words(call(CHAIN, pool, "0x" + selector("totalSupply()")))[0], "uint256")
            burned = sum(dec(words(call(CHAIN, pool, "0x" + selector("balanceOf(address)") + enc_address(a)))[0], "uint256") for a in DEAD)
            out["lp_buckets"] = [("burned", burned / lp_total)] + ([("wallet", 1 - burned / lp_total)] if burned < lp_total else [])
            log.add("PancakeSwap v2 pool", {"pool": pool, "reserves": [r0, r1], "lp_burned_share": burned / lp_total}, "raw", f"getReserves/totalSupply on {pool}")
    elif st["status"] == 1 and q_usd and supply:
        out["real_usd"] = st["reserve"] / 1e18 * q_usd
        out["valuation_usd"] = st["price"] / 1e18 * supply * q_usd
    log.add("real money / valuation", [out["real_usd"], out["valuation_usd"]], "USD", "Flap state or PancakeSwap reserves")
    # contract control: the token is a fixed clone; its owner is the Flap Portal (a verified launchpad contract)
    code = rpc(CHAIN, "eth_getCode", [token, "latest"])
    impl = "0x" + code[22:62] if isinstance(code, str) and code.startswith("0x363d3d373d3d3d363d73") else None
    owner = erc20(token, "owner()")
    owner = ("0x" + owner[0][-40:]).lower() if owner else None
    out["fixed_template"] = FIXED_TOKEN_IMPLS.get(impl or "")
    out["owner"] = owner
    log.add("token contract", {"clone_of": impl, "template": out["fixed_template"], "owner": owner}, "address", f"eth_getCode/owner() on {token}")
    out["creation"] = creation(token)
    if out["creation"]:
        log.add("creator (Flap TokenCreated)", out["creation"]["creator"], "address", f"tx {out['creation']['tx']}")
    return out
