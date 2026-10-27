"""Zora (Base) reader for the Base scorer. Every fact used here was read from verified source on
2026-10-25 (Sourcify, exact match), not assumed:
  - ZoraFactory 0x7777…baf3 (EIP-1967 proxy; implementation ZoraFactoryImpl) emits `CoinCreatedV4(address indexed caller,
    address indexed payoutRecipient, address indexed platformReferrer, address currency, string uri, string name,
    string symbol, address coin, PoolKey poolKey, bytes32 poolKeyHash, string version)` (topic matched on chain);
  - a content coin is an EIP-1167 clone of ContentCoin 0x5dbd…ff13: 1,000,000,000 minted once at creation, 1% to the payout
    recipient and the rest to the pool's hook (`_handleInitialDistribution`); no other mint; transfers have no pause or
    blacklist (`_update` only emits an extra event); its owners (`owners()`, add/remove among themselves) can set the payout
    recipient, the metadata URI and the name and ticker, and can `migrateLiquidity`;
  - the hook ZoraV4CoinHook 0x0469…50c0 holds the coin's liquidity positions (`getPoolCoin(poolKey).positions`); its
    `migrateLiquidity` accepts only the coin as caller and only a new hook on Zora's upgrade gate, and moves the liquidity
    into that hook; it has no other way to take liquidity out. Its swap step converts collected fees to the backing currency.
A coin of another implementation (a creator coin) or behind another hook version is "not yet verified" (missing stays
missing). Prices: the paired currency's dollar price from Alchemy's Prices API on the official key (ETH from Chainlink),
else, for a paired Zora coin, Zora's own coin record (reported); none answered, the dollar figures stay unknown."""
from __future__ import annotations
import os, sys
from decimal import Decimal

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from evm import rpc, call, selector, enc_address, enc_uint, words, dec, dec_string, topic, keccak256
from flap_reader import token_price_usd, native_price, first_transfer
from readers import Log
import v4_depth as V4
import solana_rpc as _S

CHAIN = "base"
NETWORK = "base-mainnet"
FACTORY = "0x777777751622c0d3258f214f9df38e35bf45baf3"
COIN_CREATED_V4 = topic("CoinCreatedV4(address,address,address,address,string,string,string,address,(address,address,uint24,int24,address),bytes32,string)")
VERIFIED_IMPLS = {"0x5dbd43785954d43c1643a0caf2ecef9e0056ff13": "ContentCoin (Sourcify exact match)"}
VERIFIED_HOOKS = {"0x0469a4bd3724dc86c9542f4694c976da13c450c0": "ZoraV4CoinHook (Sourcify exact match)"}
WETH = "0x4200000000000000000000000000000000000006"
ZERO = "0x0000000000000000000000000000000000000000"
MARKET_SHARE = 0.99                    # CONTENT_COIN_MARKET_SUPPLY / TOTAL_SUPPLY (CoinConstants, verified source)


def _a(w: str) -> str:
    return ("0x" + w[-40:]).lower()


def _int24(w: str) -> int:
    v = int(w, 16) & ((1 << 24) - 1)
    return v - (1 << 24) if v >= 1 << 23 else v


def decode_created(log: dict) -> dict | None:
    """One CoinCreatedV4 log as a record, or None."""
    try:
        if (log.get("topics") or [None])[0] != COIN_CREATED_V4 or log.get("address", "").lower() != FACTORY:
            return None
        d, w = log["data"], words(log["data"])
        return {"caller": _a(log["topics"][1]), "payout_recipient": _a(log["topics"][2]), "platform_referrer": _a(log["topics"][3]),
                "currency": _a(w[0]), "uri": dec_string(d, w[1]), "name": dec_string(d, w[2]), "symbol": dec_string(d, w[3]),
                "coin": _a(w[4]), "pool_key": {"currency0": _a(w[5]), "currency1": _a(w[6]), "fee": int(w[7], 16),
                                               "tickSpacing": _int24(w[8]), "hooks": _a(w[9])},
                "pool_id": "0x" + w[10], "version": dec_string(d, w[11])}
    except Exception:
        return None


def pool_id_of(key: dict) -> str:
    """keccak256(abi.encode(PoolKey)): Uniswap v4's pool id, checked against the event's poolKeyHash."""
    enc = enc_address(key["currency0"]) + enc_address(key["currency1"]) + enc_uint(key["fee"]) + \
        enc_uint(key["tickSpacing"] % (1 << 256)) + enc_address(key["hooks"])
    return "0x" + keccak256(bytes.fromhex(enc)).hex()


def creation(token: str):
    t = first_transfer(CHAIN, token)                      # PINR's own creation read first, else Alchemy
    if t is None:
        return None
    rc = rpc(CHAIN, "eth_getTransactionReceipt", [t["hash"]])
    if not isinstance(rc, dict):
        return None
    for l in rc["logs"]:
        c = decode_created(l)
        if c and c["coin"] == token.lower():
            c.update(tx=t["hash"], block=int(rc["blockNumber"], 16), launch_ts=_ts(t))
            return c
    return None


def _ts(t) -> int | None:
    import calendar, time
    v = ((t or {}).get("metadata") or {}).get("blockTimestamp")
    try:
        return calendar.timegm(time.strptime(v[:19], "%Y-%m-%dT%H:%M:%S"))
    except Exception:
        return None


def impl_of(token: str) -> str | None:
    code = rpc(CHAIN, "eth_getCode", [token, "latest"])
    return ("0x" + code[22:62]).lower() if isinstance(code, str) and code.startswith("0x363d3d373d3d3d363d73") else None


def owners(token: str) -> list | None:
    out = call(CHAIN, token, "0x" + selector("owners()"))
    if not out:
        return None
    w = words(out)
    try:
        n = int(w[int(w[0], 16) // 32], 16)
        start = int(w[0], 16) // 32 + 1
        return [_a(x) for x in w[start:start + n]]
    except Exception:
        return None


def hook_positions(hook: str, key: dict) -> list | None:
    """[(tickLower, tickUpper, liquidity)] the hook holds for this coin's pool (getPoolCoin(poolKey).positions)."""
    data = "0x" + selector("getPoolCoin((address,address,uint24,int24,address))") + enc_address(key["currency0"]) + \
        enc_address(key["currency1"]) + enc_uint(key["fee"]) + enc_uint(key["tickSpacing"] % (1 << 256)) + enc_address(key["hooks"])
    out = call(CHAIN, hook, data)
    if not out:
        return None
    w = words(out)
    try:
        base = int(w[0], 16) // 32                            # the struct (coin, positions[])
        arr = base + int(w[base + 1], 16) // 32               # positions offset is relative to the struct
        n = int(w[arr], 16)
        return [(_int24(w[arr + 1 + 3 * i]), _int24(w[arr + 2 + 3 * i]), int(w[arr + 3 + 3 * i], 16)) for i in range(n)]
    except Exception:
        return None


def coin_links(uri: str | None, log: Log, doc_read=None):
    """The X, website and Telegram the coin's own metadata document lists (the creator's own words), read through the shared
    IPFS reader (stage2/readers.metadata_document: the gateways' shared rests). None when the document was not read, so the
    links stay unknown and are never called "none"."""
    if not isinstance(uri, str) or not uri.strip():
        return None
    if doc_read is None:
        from readers import metadata_document as doc_read
    doc = doc_read(uri.strip())
    if not isinstance(doc, dict):
        return None
    sys.path.insert(0, os.path.join(HERE, "..", "scanner"))
    from basic import links_from
    lk = links_from(doc)
    log.add("token's own links (metadata document)", {k: v for k, v in lk.items() if v} or "none listed", "links", uri)
    return {"twitter": lk.get("x"), "website": lk.get("website"), "telegram": lk.get("telegram"), "farcaster": None}


ZORA_COIN = "https://api-sdk.zora.engineering/coin?chain=8453&address="


def zora_price(address: str, get=None) -> float | None:
    """A Zora coin's dollar price as Zora's own record reports it (keyless; the list source CHAINS already reads); None
    when Zora does not know the coin or did not answer."""
    import json, urllib.request
    try:
        body = get(ZORA_COIN + address) if get else json.load(urllib.request.urlopen(
            urllib.request.Request(ZORA_COIN + address, headers={"User-Agent": "PINR-live/1.0 (read-only)"}), timeout=15))
        v = float((((body or {}).get("zora20Token") or {}).get("tokenPrice") or {}).get("priceInUsdc"))
    except Exception:
        return None
    return v if v > 0 else None


def erc20_int(token: str, fn: str, *args, block: str = "latest"):
    data = "0x" + selector(fn) + "".join(enc_address(a) for a in args)
    r = call(CHAIN, token, data, block)
    return int(words(r)[0], 16) if r else None


def read(token: str, log: Log) -> dict:
    token = token.lower()
    c = creation(token)
    if c is None:
        return {"error": "not a Zora coin (no CoinCreatedV4 from the factory in its creation transaction), or unreadable"}
    if pool_id_of(c["pool_key"]) != c["pool_id"]:
        return {"error": "the creation event's pool id does not match its pool key"}
    impl, hook = impl_of(token), c["pool_key"]["hooks"]
    unknown_parts = [p for p, ok in ((impl or "no clone", impl in VERIFIED_IMPLS), (hook, hook in VERIFIED_HOOKS)) if not ok]
    log.add("Zora creation (factory CoinCreatedV4)", {k: c[k] for k in ("caller", "payout_recipient", "platform_referrer", "currency", "pool_id", "version")},
            "raw", f"tx {c['tx']}")
    log.add("Zora parts used", {impl or "no EIP-1167 clone": VERIFIED_IMPLS.get(impl, "NOT YET VERIFIED"), hook: VERIFIED_HOOKS.get(hook, "NOT YET VERIFIED")},
            "contract names", "verified source (Sourcify)")
    own = owners(token)
    payout = (lambda r: _a(r) if r else None)(call(CHAIN, token, "0x" + selector("payoutRecipient()")))
    supply_raw = erc20_int(token, "totalSupply()")
    supply = supply_raw / 1e18 if supply_raw is not None else None
    paired = c["currency"] if c["currency"] != ZERO else WETH
    dec_paired = 18 if c["currency"] == ZERO else erc20_int(paired, "decimals()")
    if paired == WETH:
        q_usd, q_src = native_price("base", "ETH")
    else:
        q_usd, q_src = token_price_usd(paired, NETWORK)
        if q_usd is None:                                      # a Zora coin paired with another Zora coin (its creator coin)
            q_usd = zora_price(paired)
            q_src = f"Zora's own coin record for {paired} (reported price)"
    log.add("paired asset price", q_usd, "USD", q_src)
    out = {"status": "pool (Uniswap v4)", "supply": supply, "quote_usd": q_usd, "real_usd": None, "valuation_usd": None, "lp_buckets": None,
           "pool": c["pool_id"], "pool_id": c["pool_id"], "paired": paired, "creation": dict(c, paired=paired), "unknown_parts": unknown_parts,
           "owners": own, "payout_recipient": payout, "links": coin_links(c.get("uri"), log)}
    key = c["pool_key"]
    token_is0 = key["currency0"] == token
    pool = V4.read_pool(CHAIN, c["pool_id"], key["tickSpacing"])
    if pool and pool["liquidity_check"] and dec_paired is not None:
        a0, a1 = V4.amounts(pool["ranges"], pool["sqrtPriceX96"], pool["tick"])
        paired_raw, token_raw = (a1, a0) if token_is0 else (a0, a1)
        pxr = V4.price1_per_0(pool["sqrtPriceX96"]); pxr = pxr if token_is0 else 1 / pxr        # raw paired per raw token
        px = pxr * Decimal(10) ** (18 - dec_paired)
        out["price_paired"] = float(px)
        out["pool_paired"] = float(paired_raw) / 10 ** dec_paired
        out["pool_tokens"] = float(token_raw) / 1e18
        if q_usd and supply:
            out["real_usd"] = out["pool_paired"] * q_usd
            out["valuation_usd"] = float(px) * supply * q_usd
        log.add("Uniswap v4 pool", {"pool_id": c["pool_id"], "tick": pool["tick"], "pool_liquidity": pool["pool_liquidity"],
                                    "paired_in_pool": out["pool_paired"], "tokens_in_pool": out["pool_tokens"]},
                "raw", f"StateView {V4.STATEVIEW[CHAIN]} (slot0, liquidity, tick bitmap, tick liquidity)")
        pos = hook_positions(hook, key) if hook in VERIFIED_HOOKS else None
        if pos is not None:
            l0, l1 = V4.amounts([p for p in pos if p[2] > 0], pool["sqrtPriceX96"], pool["tick"])
            lp_, lt_ = (l1, l0) if token_is0 else (l0, l1)
            total_val, locked_val = paired_raw + token_raw * pxr, lp_ + lt_ * pxr
            share = float(min(Decimal(1), locked_val / total_val)) if total_val else None
            if share is not None:
                out["lp_buckets"] = [("locked_forever", share)] + ([("wallet", 1 - share)] if share < 1 - 1e-9 else [])
            log.add("liquidity held by the Zora hook", {"positions": len(pos), "locked_share_of_pool_value": share}, "share",
                    f"getPoolCoin on {hook} (moves only to a hook on Zora's upgrade gate)")
    else:
        log.add("Uniswap v4 pool", "unreadable, or rebuilt liquidity did not match the pool (refused)", "-", "StateView")
    log.add("real money / valuation", [out["real_usd"], out["valuation_usd"]], "USD", "Uniswap v4 ranges x paired price")
    return out
