"""Clanker v4 (Base) reader, Stage 4. Every number is read from chain with a receipt; nothing is guessed.
Facts behind it (facts EVM file, Clanker section; verified source on Basescan, read 2026-10-04):
  - tokens are the verified ClankerToken: no owner, no mint (only Base's official Superchain bridge can mint, for
    cross-chain moves), no pause, no blacklist, no tax. The admin can change only the image and the description.
  - liquidity = Uniswap v4 positions held by the verified ClankerLpLockerFeeConversion. It accepts position NFTs only
    from the Clanker factory and has no function that removes liquidity or moves the NFTs (its only "decrease" uses
    liquidity 0, which collects fees). The owner's withdraw functions move plain tokens / ETH, never the positions.
  - the factory refuses any locker / hook / extension it has not enabled, so a token the factory created (its own
    TokenCreated event + tokenDeploymentInfo) uses only enabled parts; each part's code is also checked by name here.
  - hooks: launch fees fixed at launch, capped at 10%; anti-sniper fee up to 80% only in the first 2 minutes; the
    optional pool add-on runs inside try/catch, so it cannot block a sell.
Missing stays missing.
"""
from __future__ import annotations
import calendar, json, os, sys, time
from decimal import Decimal
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from evm import rpc, call, selector, enc_address, enc_uint, words, dec, dec_string, topic, logs
from flap_reader import alchemy_prices_usd, native_price, dev_moves, first_transfer
from readers import Log
import v4_depth as V4
import solana_rpc as _S

CHAIN = "base"
NETWORK = "base-mainnet"
BLOCKS_PER_MIN = 30                      # Base: one block every 2 s
FACTORY = "0xe85a59c628f7d27878aceb4bf3b35733630083a9"
WETH = "0x4200000000000000000000000000000000000006"
POSITION_MANAGER = "0x7c5f5a4bbd8fd63184577525326123b519429bdc"
POOL_MANAGER = V4.POOLMANAGER[CHAIN].lower()
# Clanker parts whose verified source was read (2026-10-04). Anything else -> that reading is unknown, not trusted.
VERIFIED_PARTS = {
    "0xffa37784d619f228d8b379d287a4d7282e500762": "ClankerLpLockerFeeConversion",
    "0x63d2dfea64b3433f4071a98665bcd7ca14d93496": "ClankerLpLockerFeeConversion (v4.0)",
    # v4.0 parts (verified source read 2026-10-05): same no-removal locker pattern; hooks have no admin setters,
    # LP fee cap 30% (v4.1: 10%), MEV module only in the first 2 minutes; v4.0 airdrop has NO admin reclaim / re-root
    "0x29d17c1a8d851d7d4ca97fae97acadb398d9cce0": "ClankerLpLockerMultiple (v4.0, no fee conversion)",
    "0x34a45c6b61876d739400bd71228cbcbd4f53e8cc": "ClankerHookDynamicFee (v4.0)",
    "0xdd5eeaff7bd481ad55db083062b13a3cdf0a68cc": "ClankerHookStaticFee (v4.0)",
    "0x56fa0da89ed94822e46734e736d34cab72df344f": "ClankerAirdrop (v4.0, no admin reclaim)",
    "0xfdc013ce003980889cffd66b0c8329545ae1d1e8": "ClankerSniperAuctionV0 (v4.0, first 2 minutes only)",
    "0xb429d62f8f3bffb98cdb9569533ea23bf0ba28cc": "ClankerHookStaticFeeV2",
    "0xd60d6b218116cfd801e28f78d011a203d2b068cc": "ClankerHookDynamicFeeV2",
    "0x8e845ead15737bf71904a30bddd3aee76d6adf6c": "ClankerVault",
    "0xf652b3610d75d81871bf96db50825d9af28391e0": "ClankerAirdropV2",
    "0x1331f0788f9c08c8f38d52c7a1152250a9de00be": "ClankerUniv4EthDevBuy",
    "0xe143f9872a33c955f23cf442bb4b1efb3a7402a2": "ClankerMevBlockDelay",
    "0xebb25bb797d82cb78e1bc70406b13233c0854413": "ClankerSniperAuctionV2 (runs only in the hook's first 2 minutes)",
    "0xf3622742b1e446d92e45e22923ef11c2fcd55d68": "ClankerFeeLocker",
}
TOKEN_CREATED = topic("TokenCreated(address,address,address,string,string,string,string,string,int24,address,bytes32,"
                      "address,address,address,uint256,address[])")
ETH_DEV_BUY = topic("EthDevBuy(address,address,uint256,uint256)")
SWAP = topic("Swap(bytes32,address,int128,int128,uint160,uint128,int24,uint24)")
FEE_IN = {0: "both (no conversion)", 1: "paired (token fees SOLD for the paired token)", 2: "clanker (paired fees used to BUY the token)"}
ZERO = "0x0000000000000000000000000000000000000000"


def _a(w: str) -> str:
    return ("0x" + w[-40:]).lower()


def _ts(iso: str) -> int:
    return calendar.timegm(time.strptime(iso[:19], "%Y-%m-%dT%H:%M:%S"))


def _int(w: str, bits: int = 256) -> int:
    v = int(w, 16) & ((1 << bits) - 1)
    return v - (1 << bits) if v >> (bits - 1) else v


def _json(s: str):
    try:
        j = json.loads(s)
        return j if isinstance(j, dict) else None
    except Exception:
        return None


def creation(token: str):
    """Token's first transfer (its mint, to the factory) -> creation tx -> Clanker TokenCreated + dev-buy events."""
    t = first_transfer(CHAIN, token)                      # PINR's own creation read first, else Alchemy
    if t is None:
        return None
    rc = rpc(CHAIN, "eth_getTransactionReceipt", [t["hash"]])
    if not isinstance(rc, dict):
        return None
    out = None
    for l in rc["logs"]:
        if l["address"].lower() == FACTORY and l["topics"][0] == TOKEN_CREATED and _a(l["topics"][1]) == token.lower():
            d, w = l["data"], words(l["data"])
            n_ext_off = int(w[13], 16) // 32
            exts = [_a(x) for x in w[n_ext_off + 1:n_ext_off + 1 + int(w[n_ext_off], 16)]]
            out = {"creator": _a(l["topics"][2]), "msg_sender": _a(w[0]), "tx": t["hash"], "tx_from": rc["from"].lower(),
                   "block": int(rc["blockNumber"], 16), "launch_ts": _ts(t["metadata"]["blockTimestamp"]),
                   "image": dec_string(d, w[1]), "name": dec_string(d, w[2]), "symbol": dec_string(d, w[3]),
                   "metadata": dec_string(d, w[4]), "context": dec_string(d, w[5]), "starting_tick": _int(w[6], 24),
                   "hook": _a(w[7]), "pool_id": "0x" + w[8], "paired": _a(w[9]), "locker": _a(w[10]),
                   "mev_module": _a(w[11]), "extensions_supply": int(w[12], 16) / 1e18, "extensions": exts}
    if out is None:
        return None
    out["dev_buys"] = [{"recipient": _a(l["topics"][2]), "eth": dec(words(l["data"])[0], "uint256") / 1e18,
                        "tokens": dec(words(l["data"])[1], "uint256") / 1e18}
                       for l in rc["logs"] if l["topics"] and l["topics"][0] == ETH_DEV_BUY and _a(l["topics"][1]) == token.lower()]
    return out


def links(c: dict) -> dict:
    """The token's own links, published on chain in its Clanker metadata/context (no third party)."""
    md, cx = _json(c.get("metadata") or "") or {}, _json(c.get("context") or "") or {}
    out = {"twitter": None, "website": None, "telegram": None, "farcaster": None, "description": md.get("description")}
    for s in md.get("socialMediaUrls") or []:
        url = (s.get("url") if isinstance(s, dict) else s) or ""
        plat = ((s.get("platform") if isinstance(s, dict) else "") or "").lower()
        u = url.lower()
        if not url.strip():
            continue
        if plat in ("x", "twitter") or "x.com/" in u or "twitter.com/" in u:
            out["twitter"] = out["twitter"] or url.strip()
        elif plat == "telegram" or "t.me/" in u or "telegram.me/" in u:
            out["telegram"] = out["telegram"] or url.strip()
        elif plat in ("farcaster", "warpcast") or "warpcast.com/" in u or "farcaster.xyz/" in u:
            out["farcaster"] = out["farcaster"] or url.strip()
        elif plat in ("website", "web", "site", "") and u.startswith("http"):
            out["website"] = out["website"] or url.strip()
    out["interface"], out["platform"] = cx.get("interface"), cx.get("platform")
    out["context_message"] = cx.get("messageId")
    # launched from Farcaster: the on-chain launch record names the requesting account (fid) -> its profile
    if not out["farcaster"] and str(cx.get("platform") or "").lower() == "farcaster" and str(cx.get("id") or "").isdigit():
        out["farcaster"] = f"https://farcaster.xyz/~/profiles/{cx['id']}"
        out["farcaster_cast"] = cx.get("messageId")
    return out


def reward_info(locker: str, token: str):
    """The locker's own record for this token: pool key, position ids, reward split, recipients, fee preferences."""
    r = call(CHAIN, locker, "0x" + selector("tokenRewards(address)") + enc_address(token))
    if not r:
        return None
    w = words(r)
    tup = 1                                                    # word 0 is the offset of the returned tuple
    arr = lambda k: (lambda o: w[o + 1:o + 1 + int(w[o], 16)])(tup + int(w[tup + k], 16) // 32)
    key = {"currency0": _a(w[2]), "currency1": _a(w[3]), "fee": int(w[4], 16), "tickSpacing": _int(w[5], 24), "hooks": _a(w[6])}
    bps = [int(x, 16) for x in arr(8)]
    prefs = []
    for i in range(len(bps)):
        p = call(CHAIN, locker, "0x" + selector("feePreferences(address,uint256)") + enc_address(token) + enc_uint(i))
        prefs.append(int(p, 16) if p else None)
    return {"pool_key": key, "position_id": int(w[7], 16), "num_positions": int(w[tup + 7], 16),
            "reward_bps": bps, "reward_admins": [_a(x) for x in arr(9)], "reward_recipients": [_a(x) for x in arr(10)],
            "fee_preferences": prefs}


def position(pid: int):
    """Owner, tick range and liquidity of one Uniswap v4 position NFT."""
    o = call(CHAIN, POSITION_MANAGER, "0x" + selector("ownerOf(uint256)") + enc_uint(pid))
    info = call(CHAIN, POSITION_MANAGER, "0x" + selector("positionInfo(uint256)") + enc_uint(pid))
    liq = call(CHAIN, POSITION_MANAGER, "0x" + selector("getPositionLiquidity(uint256)") + enc_uint(pid))
    if not (o and info and liq):
        return None
    v = int(info, 16)
    sx = lambda x: x - (1 << 24) if x >> 23 else x
    return {"id": pid, "owner": _a(o), "tick_lower": sx((v >> 8) & 0xFFFFFF), "tick_upper": sx((v >> 32) & 0xFFFFFF),
            "liquidity": int(liq, 16)}


def erc20_int(token: str, fn: str, *args, block: str = "latest"):
    data = "0x" + selector(fn) + "".join(enc_address(a) if isinstance(a, str) else enc_uint(a) for a in args)
    r = call(CHAIN, token, data, block)
    return None if r is None else int(words(r)[0], 16)


def vault(token: str):
    r = call(CHAIN, "0x8e845ead15737bf71904a30bddd3aee76d6adf6c", "0x" + selector("allocation(address)") + enc_address(token))
    if not r:
        return None
    w = words(r)
    return {"amount_total": int(w[1], 16) / 1e18, "amount_claimed": int(w[2], 16) / 1e18, "lockup_end": int(w[3], 16),
            "vesting_end": int(w[4], 16), "admin": _a(w[5])}


def airdrop(token: str):
    r = call(CHAIN, "0xf652b3610d75d81871bf96db50825d9af28391e0", "0x" + selector("airdrops(address)") + enc_address(token))
    if not r:
        return None
    w = words(r)
    return {"admin": _a(w[0]), "total": int(w[2], 16) / 1e18, "claimed": int(w[3], 16) / 1e18, "lockup_end": int(w[4], 16),
            "vesting_end": int(w[5], 16), "admin_claim_time": int(w[6], 16), "admin_claimed": bool(int(w[7], 16))}


def price_in_paired(sqrt_price_x96: int, token_is0: bool, dec_token: int, dec_paired: int) -> Decimal:
    """Whole paired-token units per whole token."""
    p = V4.price1_per_0(sqrt_price_x96)                     # raw currency1 per raw currency0
    p = p if token_is0 else 1 / p
    return p * Decimal(10) ** (dec_token - dec_paired)


def read(token: str, log: Log) -> dict:
    token = token.lower()
    c = creation(token)
    if c is None:
        return {"error": "not a Clanker v4 token (no TokenCreated event from the factory in its creation tx), or unreadable"}
    di = call(CHAIN, FACTORY, "0x" + selector("tokenDeploymentInfo(address)") + enc_address(token))
    dw = words(di) if di else []
    if not dw or _a(dw[1]) != token or _a(dw[2]) != c["hook"] or _a(dw[3]) != c["locker"]:
        return {"error": "factory deployment record does not match the creation event"}
    log.add("Clanker creation (factory TokenCreated)", {k: c[k] for k in ("creator", "msg_sender", "block", "hook", "locker", "mev_module", "paired", "extensions", "extensions_supply")},
            "raw", f"tx {c['tx']}; tokenDeploymentInfo on {FACTORY}")
    parts = [c["hook"], c["locker"]] + c["extensions"] + ([c["mev_module"]] if c["mev_module"] != ZERO else [])
    unknown_parts = [p for p in parts if p not in VERIFIED_PARTS]
    log.add("Clanker parts used", {p: VERIFIED_PARTS.get(p, "NOT YET VERIFIED") for p in parts}, "contract names", "verified source (Basescan)")

    supply_raw = erc20_int(token, "totalSupply()")
    dec_paired = erc20_int(c["paired"], "decimals()")
    supply = supply_raw / 1e18 if supply_raw is not None else None
    if c["paired"] == WETH:
        q_usd, q_src = native_price("base", "ETH")
    else:
        q_usd = alchemy_prices_usd(addresses=(c["paired"],), network=NETWORK).get(c["paired"], (None,))[0]
        q_src = "Alchemy Prices API (" + c["paired"] + ")"
    log.add("paired asset price", q_usd, "USD", q_src)

    out = {"status": "pool (Uniswap v4)", "supply": supply, "quote_usd": q_usd, "real_usd": None, "valuation_usd": None,
           "lp_buckets": None, "pool": c["pool_id"], "creation": c, "unknown_parts": unknown_parts, "links": links(c),
           "owner": None, "paired": c["paired"]}

    # pool: real money (paired token across every range) and valuation, checked against the pool's own liquidity
    ri = reward_info(c["locker"], token) if c["locker"] in VERIFIED_PARTS else None
    out["rewards"] = ri
    if ri:
        key = ri["pool_key"]
        token_is0 = key["currency0"] == token
        pool = V4.read_pool(CHAIN, c["pool_id"], key["tickSpacing"])
        if pool and pool["liquidity_check"] and dec_paired is not None:
            a0, a1 = V4.amounts(pool["ranges"], pool["sqrtPriceX96"], pool["tick"])
            paired_raw, token_raw = (a1, a0) if token_is0 else (a0, a1)
            px = price_in_paired(pool["sqrtPriceX96"], token_is0, 18, dec_paired)
            out["price_paired"] = float(px)
            out["pool_paired"] = float(paired_raw) / 10 ** dec_paired
            out["pool_tokens"] = float(token_raw) / 1e18
            if q_usd and supply:
                out["real_usd"] = out["pool_paired"] * q_usd
                out["valuation_usd"] = float(px) * supply * q_usd
            log.add("Uniswap v4 pool", {"pool_id": c["pool_id"], "tick": pool["tick"], "pool_liquidity": pool["pool_liquidity"],
                                        "rebuilt_liquidity_matches": True, "initialized_ticks": pool["initialized_ticks"],
                                        "paired_in_pool": out["pool_paired"], "tokens_in_pool": out["pool_tokens"]},
                    "raw", f"StateView {V4.STATEVIEW[CHAIN]} (slot0, liquidity, tick bitmap, tick liquidity)")
            # permanence: share of the pool's value held in the locker's positions (anyone else's positions are removable)
            pos = _S.pmap(position, list(range(ri["position_id"], ri["position_id"] + ri["num_positions"])))
            if all(pos):
                locked_ranges = [(p["tick_lower"], p["tick_upper"], p["liquidity"]) for p in pos
                                 if p["owner"] == c["locker"] and p["liquidity"] > 0]
                l0, l1 = V4.amounts(locked_ranges, pool["sqrtPriceX96"], pool["tick"])
                lp_, lt_ = (l1, l0) if token_is0 else (l0, l1)
                pxr = V4.price1_per_0(pool["sqrtPriceX96"]); pxr = pxr if token_is0 else 1 / pxr   # raw paired per raw token
                total_val, locked_val = paired_raw + token_raw * pxr, lp_ + lt_ * pxr
                share = float(min(Decimal(1), locked_val / total_val)) if total_val else None
                if share is not None:
                    out["lp_buckets"] = [("locked_forever", share)] + ([("wallet", 1 - share)] if share < 1 - 1e-9 else [])
                log.add("liquidity held by the Clanker locker", {"positions": [(p["id"], p["owner"] == c["locker"], p["liquidity"]) for p in pos],
                                                                 "locked_share_of_pool_value": share},
                        "share", f"PositionManager {POSITION_MANAGER} ownerOf/positionInfo/getPositionLiquidity")
        else:
            log.add("Uniswap v4 pool", "unreadable, or rebuilt liquidity did not match the pool (refused)", "-", "StateView")
        log.add("creator rewards (locker record)", {"recipients": ri["reward_recipients"], "bps": ri["reward_bps"],
                                                    "fee_preferences": [FEE_IN.get(p, p) for p in ri["fee_preferences"]]},
                "raw", f"tokenRewards/feePreferences on {c['locker']}")
    log.add("real money / valuation", [out["real_usd"], out["valuation_usd"]], "USD", "Uniswap v4 ranges x paired price")

    # extras that change who holds supply
    ext_names = [VERIFIED_PARTS.get(e) for e in c["extensions"]]
    out["vault"] = vault(token) if "ClankerVault" in ext_names else None
    out["airdrop"] = airdrop(token) if "ClankerAirdropV2" in ext_names else None
    if any(n and n.startswith("ClankerAirdrop (v4.0") for n in ext_names):
        # v4.0 airdrop: the admin can't take back unclaimed supply, so it never counts as dev-controlled
        out["airdrop_v40"] = True
        log.add("airdrop reserve (v4.0)", "present; admin has no reclaim or re-root power", "fact", "ClankerAirdrop verified source")
    if out["vault"]:
        log.add("dev vault (locked allocation)", out["vault"], "tokens / unix time", "ClankerVault.allocation")
    if out["airdrop"]:
        log.add("airdrop reserve", out["airdrop"], "tokens / unix time", "ClankerAirdropV2.airdrops")
    if c["dev_buys"]:
        log.add("dev buy at launch (EthDevBuy)", c["dev_buys"], "ETH / tokens", f"tx {c['tx']}")
    out["admin_now"] = (lambda r: _a(r) if r else None)(call(CHAIN, token, "0x" + selector("admin()")))
    return out


def early_buys(token: str, paired: str, pool_id: str, create_block: int, launch_ts: int, creation_tx: str):
    """Buys of the token in its first minute: PoolManager Swap events for this pool; the buyer is the transaction's
    signer (the swap 'sender' is a router). Buys inside the creation tx itself are the declared dev buy, not a bundle."""
    lg, ok = logs(CHAIN, V4.POOLMANAGER[CHAIN], SWAP, create_block, create_block + BLOCKS_PER_MIN, topic1=pool_id)
    if not ok:
        return None
    out, txs = [], []
    for l in lg:
        if l["transactionHash"].lower() == creation_tx.lower():
            continue
        w = words(l["data"])
        txs.append((l, _int(w[0], 128), _int(w[1], 128)))
    if not txs:
        return []
    froms = _S.pmap(lambda x: rpc(CHAIN, "eth_getTransactionByHash", [x[0]["transactionHash"]]), txs)
    if any(not isinstance(f, dict) for f in froms):
        return None
    tok_is0 = int(token, 16) < int(paired, 16)                   # v4 sorts the two currencies by address
    for (l, d0, d1), f in zip(txs, froms):
        got = d0 if tok_is0 else d1                               # caller's delta: positive = received tokens
        if got > 0:
            b = int(l["blockNumber"], 16)
            out.append({"wallet": f["from"].lower(), "slot": b, "t": launch_ts + round((b - create_block) * 2),
                        "signature": l["transactionHash"]})
    return out


def collector_sells_vs_buys(token: str, locker: str, placement_tx: str, head: int, plumbing: set = frozenset()):
    """Reward-flow pressure inputs (24 h, token units): the locker's fee-conversion sells (token sent from the locker
    into the PoolManager, excluding the initial liquidity placement) vs everyone else's buys (token sent out of the
    PoolManager to anyone but the locker). Same token on both sides, so the ratio needs no price."""
    frm = hex(max(0, head - 24 * 60 * BLOCKS_PER_MIN))
    def pull(q):
        res, page = [], None
        while True:
            qq = dict(q, contractAddresses=[token], category=["erc20"], fromBlock=frm, maxCount="0x3e8")
            if page:
                qq["pageKey"] = page
            r = rpc(CHAIN, "alchemy_getAssetTransfers", [qq])
            if not isinstance(r, dict):
                return None
            res += r.get("transfers", [])
            page = r.get("pageKey")
            if not page:
                return res
    sells = pull({"fromAddress": locker, "toAddress": POOL_MANAGER})
    buys = pull({"fromAddress": POOL_MANAGER})
    if sells is None or buys is None:
        return None
    s = sum(float(t["value"] or 0) for t in sells if t["hash"].lower() != placement_tx.lower())
    # platform plumbing (initializer, hook, airlock, token contract) receiving tokens is not anyone buying
    skip = {locker} | {x.lower() for x in plumbing}
    b = sum(float(t["value"] or 0) for t in buys if (t["to"] or "").lower() not in skip)
    return {"collector_sells_tokens": s, "other_buys_tokens": b, "sell_txs": len(sells), "buy_txs": len(buys)}


def sampled_prices(pool_id: str, token_is0: bool, dec_paired: int, first_block: int, head: int, n: int = 40):
    """Pool price (paired per token) at n evenly spaced past blocks (archive reads of StateView.getSlot0). The peak
    found is a LOWER bound on the true peak, so 'pump retained' can only look better than reality, never worse."""
    blocks = sorted({first_block + 1 + (head - first_block - 1) * i // (n - 1) for i in range(n)})
    pid = pool_id[2:]
    def price_at(b):
        r = call(CHAIN, V4.STATEVIEW[CHAIN], "0x" + selector("getSlot0(bytes32)") + pid, hex(b))
        sp = int(words(r)[0], 16) if r else 0
        return float(price_in_paired(sp, token_is0, 18, dec_paired)) if sp else None
    return [(b, p) for b, p in zip(blocks, _S.pmap(price_at, blocks)) if p]
