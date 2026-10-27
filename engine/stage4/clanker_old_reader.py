"""Older Clanker versions (v0, v1, v2, v3, v3.1) on Base, Uniswap v3 pools. Stage 4. Missing stays missing.
Facts (verified source on Basescan + live reads, 2026-10-05; addresses from Clanker's "Deployed Contracts" docs, each
confirmed on chain):
  - tokens: v0/v1 plain ERC-20 minted once (no owner powers). v2/v3: the deployer can change the image only. v3.1: the
    admin can change image and metadata. v3/v3.1 cross-chain mint only by Base's Superchain bridge. No pause/blacklist/tax.
  - liquidity: a Uniswap v3 position NFT.
      v0/v1: a per-token LpLocker (made by the version's LockerFactory in the launch tx). release() hands the NFT to the
             locker's owner once block time passes its unlock time, so each token's lock is TIME-LIMITED and read
             individually (example: BNKR, v1, unlocks 2100-12-14).
      v2/v3/v3.1: shared LpLockerv2 with no function that releases the NFT or removes liquidity (collectRewards only
             collects fees; withdrawERC20 can't move an ERC-721). Locked forever.
  - fees: collected and split (creator / Clanker / interface); no selling step.
"""
from __future__ import annotations
import os, sys, time
from decimal import Decimal
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from evm import rpc, call, selector, enc_address, enc_uint, words, dec_string, topic, logs
from flap_reader import alchemy_prices_usd, native_price, first_transfer
from readers import Log
import clanker_reader as C
import v4_depth as V4
import solana_rpc as _S

CHAIN = "base"
_a, _int = C._a, C._int
FACTORIES = {
    "0x250c9fb2b411b48273f69879007803790a6aea47": ("v0", topic("TokenCreated(address,uint256,address,string,string,uint256,uint256,address)")),
    "0x9b84fce5dcd9a38d2d01d5d72373f6b6b067c3e1": ("v1", topic("TokenCreated(address,uint256,address,uint256,string,string,uint256,address,string)")),
    "0x732560fa1d1a76350b1a500155ba978031b53833": ("v2", topic("TokenCreated(address,uint256,address,uint256,string,string,uint256,address,string)")),
    "0x375c15db32d28cecdcab5c03ab889bf15cbd2c5e": ("v3", topic("TokenCreated(address,uint256,address,uint256,string,string,uint256,string)")),
    "0x2a787b2362021cc3eea3c24c4748a6cd5b687382": ("v3.1", topic("TokenCreated(address,address,address,address,address,uint256,string,string,int24,string,uint256,uint256,uint8,address)")),
}
LOCKER_FACTORIES = {"v0": "0x515d45f06edd179565aa2796388417ed65e88939", "v1": "0x18db5fce22be8814b7e31fbda2f6488d607a1172"}
LOCKER_DEPLOYED = topic("deployed(address,address,uint256,uint256)")
SHARED_LOCKERS = {"v2": "0x618a9840691334ee8d24445a4ada4284bf42417d", "v3": "0x5ec4f99f342038c67a312a166ff56e6d70383d86",
                  "v3.1": "0x33e2eda238edcf470309b8c6d228986a1204c8f9"}
V31_VAULT = "0x42a95190b4088c88dd904d930c79dec1158bf09d"
POWERS = {"v0": "none (plain ERC-20, minted once)", "v1": "none (plain ERC-20, minted once)",
          "v2": "deployer can change the image", "v3": "deployer can change the image",
          "v3.1": "admin can change image and metadata"}
# Farcaster accounts that belong to a launch PLATFORM, not to the token's dev. Evidence (2026-10-05):
# fid 886870 = @bankr (BNKR's own launch record; on 10,572 of 10,990 Clanker v3 launches within 20k blocks of block 27,457,013).
# It stands in for a USER only when the launch record's cast is the literal "bankr deployment" (14,935 of 14,935 such
# launches in a v3 sample); a real cast hash from @bankr (e.g. BNKR's own launch) is @bankr's own post.
PLATFORM_FIDS = {886870: ("bankr deployment", "@bankr (Bankr launched a user's token through Clanker under its own Farcaster account)")}
V3_SWAP = topic("Swap(address,address,int256,int256,uint160,uint128,int24)")


def creation(token: str):
    t = first_transfer(CHAIN, token)                      # PINR's own creation read first, else Alchemy
    if t is None:
        return None
    rc = rpc(CHAIN, "eth_getTransactionReceipt", [t["hash"]])
    if not isinstance(rc, dict):
        return None
    out = None
    for l in rc["logs"]:
        f = l["address"].lower()
        if f not in FACTORIES or l["topics"][0] != FACTORIES[f][1]:
            continue
        ver, d = FACTORIES[f][0], l["data"]
        w = words(d)
        s = lambda i: dec_string(d, w[i])
        if ver == "v3.1":
            if _a(l["topics"][1]) != token:
                continue
            out = {"version": ver, "creator": _a(l["topics"][2]), "interface_admin": _a(l["topics"][3]),
                   "creator_reward_recipient": _a(w[0]), "interface_reward_recipient": _a(w[1]), "position_id": int(w[2], 16),
                   "name": s(3), "symbol": s(4), "metadata": s(6), "tokens_bought": int(w[7], 16) / 1e18,
                   "vault_duration": int(w[8], 16), "vault_percentage": int(w[9], 16), "msg_sender": _a(w[10])}
        else:
            if _a(w[0]) != token:
                continue
            out = {"version": ver, "position_id": int(w[1], 16), "creator": _a(w[2])}
            if ver == "v0":
                out.update(name=s(3), symbol=s(4), locker=_a(w[7]))
            else:
                out.update(fid=int(w[3], 16), name=s(4), symbol=s(5))
                if ver in ("v1", "v2"):
                    out.update(locker=_a(w[7]), cast=s(8))
                else:
                    out.update(cast=s(7))
        out.update(factory=f, tx=t["hash"], tx_from=rc["from"].lower(), block=int(rc["blockNumber"], 16),
                   launch_ts=C._ts(t["metadata"]["blockTimestamp"]))
        # v0/v1: the per-token locker must have been made by that version's LockerFactory in this same transaction
        if ver in LOCKER_FACTORIES:
            out["locker_made_by_factory"] = any(l2["address"].lower() == LOCKER_FACTORIES[ver] and l2["topics"][0] == LOCKER_DEPLOYED
                                                and len(l2["topics"]) > 1 and _a(l2["topics"][1]) == out["locker"] for l2 in rc["logs"])   # lockerAddress is indexed
        break
    return out


def read(token: str, log: Log) -> dict:
    token = token.lower()
    c = creation(token)
    if c is None:
        return {"error": "not an older Clanker token (no TokenCreated from a v0-v3.1 factory in its creation tx), or unreadable"}
    ver = c["version"]
    log.add(f"Clanker {ver} creation (factory TokenCreated)", {k: v for k, v in c.items() if k not in ("metadata",)},
            "raw", f"tx {c['tx']}")
    pos = V4.v3_position(CHAIN, c["position_id"])
    nft_owner = (lambda r: _a(r) if r else None)(call(CHAIN, V4.V3_POSITION_MANAGER[CHAIN], "0x" + selector("ownerOf(uint256)") + enc_uint(c["position_id"])))
    unknown_parts, lock = [], None
    if ver in SHARED_LOCKERS:
        ok = nft_owner == SHARED_LOCKERS[ver]
        lock = {"kind": "locked_forever", "holder": nft_owner, "verified": ok}
        if not ok:
            unknown_parts.append(f"position held by {nft_owner}, not the verified {ver} locker")
    else:
        lk = c.get("locker")
        ok = bool(c.get("locker_made_by_factory")) and nft_owner == lk
        unlock = (lambda r: int(r, 16) if r else None)(call(CHAIN, lk, "0x" + selector("duration()")))
        lowner = (lambda r: _a(r) if r else None)(call(CHAIN, lk, "0x" + selector("owner()")))
        months = max(0.0, (unlock - time.time()) / (30.4375 * 86400)) if unlock else None
        lock = {"kind": "time_locked", "holder": nft_owner, "verified": ok and unlock is not None, "unlock_ts": unlock,
                "unlock_date": time.strftime("%Y-%m-%d", time.gmtime(unlock)) if unlock else None, "months_remaining": months,
                "release_to": lowner}
        if not ok:
            unknown_parts.append(f"{ver} locker {lk} not confirmed (made by the LockerFactory in the launch tx and holding the position)")
    log.add("liquidity lock", lock, "facts", f"ownerOf({c['position_id']}) on the v3 position manager; locker reads")

    supply_raw = C.erc20_int(token, "totalSupply()")
    supply = supply_raw / 1e18 if supply_raw is not None else None
    paired = pos["token1"] if pos and pos["token0"] == token else (pos["token0"] if pos else None)
    dec_paired = C.erc20_int(paired, "decimals()") if paired else None
    if paired == C.WETH:
        q_usd, q_src = native_price("base", "ETH")
    elif paired:
        q_usd = alchemy_prices_usd(addresses=(paired,), network=C.NETWORK).get(paired, (None,))[0]
        q_src = f"Alchemy Prices API ({paired})"
    else:
        q_usd, q_src = None, "no paired asset read"
    log.add("paired asset price", q_usd, "USD", q_src)
    out = {"status": f"pool (Uniswap v3, Clanker {ver})", "version": ver, "supply": supply, "quote_usd": q_usd, "real_usd": None,
           "valuation_usd": None, "lp_buckets": None, "creation": c, "unknown_parts": unknown_parts, "paired": paired,
           "lock": lock, "powers": POWERS[ver]}
    if pos:
        pool = call(CHAIN, V4.UNIV3_FACTORY[CHAIN], "0x" + selector("getPool(address,address,uint24)") + enc_address(pos["token0"])
                    + enc_address(pos["token1"]) + enc_uint(pos["fee"]))
        pool = _a(pool) if pool else None
        out["pool"] = pool
        token_is0 = pos["token0"] == token
        P = V4.read_pool_v3(CHAIN, pool) if pool else None
        if P and P["liquidity_check"] and dec_paired is not None:
            a0, a1 = V4.amounts(P["ranges"], P["sqrtPriceX96"], P["tick"])
            paired_raw, token_raw = (a1, a0) if token_is0 else (a0, a1)
            px = C.price_in_paired(P["sqrtPriceX96"], token_is0, 18, dec_paired)
            out["price_paired"], out["pool_paired"], out["pool_tokens"] = float(px), float(paired_raw) / 10 ** dec_paired, float(token_raw) / 1e18
            if q_usd and supply:
                out["real_usd"] = out["pool_paired"] * q_usd
                out["valuation_usd"] = float(px) * supply * q_usd
            log.add("Uniswap v3 pool", {"pool": pool, "tick": P["tick"], "pool_liquidity": P["pool_liquidity"], "rebuilt_liquidity_matches": True,
                                        "initialized_ticks": P["initialized_ticks"], "paired_in_pool": out["pool_paired"], "tokens_in_pool": out["pool_tokens"]},
                    "raw", f"slot0/liquidity/tickBitmap/ticks on {pool}")
            # permanence: share of pool value inside the launch position (anyone else's positions are removable)
            if lock["verified"] and pos["liquidity"] > 0:
                l0, l1 = V4.amounts([(pos["tick_lower"], pos["tick_upper"], pos["liquidity"])], P["sqrtPriceX96"], P["tick"])
                lp_, lt_ = (l1, l0) if token_is0 else (l0, l1)
                pxr = V4.price1_per_0(P["sqrtPriceX96"]); pxr = pxr if token_is0 else 1 / pxr
                total_val, locked_val = paired_raw + token_raw * pxr, lp_ + lt_ * pxr
                share = float(min(Decimal(1), locked_val / total_val)) if total_val else None
                if share is not None:
                    out["lp_buckets"] = [(lock["kind"], share, lock.get("months_remaining") or 0.0)] + ([("wallet", 1 - share, 0.0)] if share < 1 - 1e-9 else [])
                log.add("liquidity in the locked launch position", {"locked_share_of_pool_value": share}, "share", "positions() + pool ranges")
        else:
            log.add("Uniswap v3 pool", "unreadable, or rebuilt liquidity did not match the pool (refused)", "-", str(pool))
    log.add("real money / valuation", [out["real_usd"], out["valuation_usd"]], "USD", "Uniswap v3 ranges x paired price")

    # dev team: roles named by the launch record / locker / vault
    roles = {"deployer": [c["creator"]]}
    # v0/v1: the launch record's "deployer" is often Clanker's own operator (e.g. 0xe0c959ee… is the lock beneficiary on
    # 2,749 of 2,918 v0 launches around block 22.8M); the dev is the lock's beneficiary, who collects fees and gets the
    # liquidity back after unlock. The recorded deployer counts only when it IS that beneficiary.
    if ver in ("v0", "v1") and lock.get("release_to") and lock["release_to"] != c["creator"]:
        roles = {"lock beneficiary (fees, liquidity after unlock)": [lock["release_to"]]}
        out["launch_service"] = c["creator"]
        log.add("launch operator (not the dev)", {"recorded_deployer": c["creator"], "lock_beneficiary": lock["release_to"]},
                "addresses", f"TokenCreated tx {c['tx']} vs owner() of locker {c.get('locker')}")
    if ver in ("v2", "v3"):
        r = call(CHAIN, SHARED_LOCKERS[ver], "0x" + selector("_userRewardRecipientForToken(uint256)") + enc_uint(c["position_id"]))
        if r:
            roles["reward recipient"] = [_a(words(r)[0])]
    if ver == "v3.1":
        roles["creator reward recipient"] = [c["creator_reward_recipient"]]
        roles["dev buy (launch sender)"] = [c["msg_sender"]] if c["tokens_bought"] > 0 else []
        out["interface"] = {"admin": c["interface_admin"], "recipient": c["interface_reward_recipient"]}
    if ver in ("v0", "v1") and lock.get("release_to") and "lock beneficiary (fees, liquidity after unlock)" not in roles:
        roles["liquidity returns to (after unlock)"] = [lock["release_to"]]
    out["vault"] = None
    if ver == "v3.1" and c["vault_percentage"]:
        r = call(CHAIN, V31_VAULT, "0x" + selector("allocation(address)") + enc_address(token))
        if r:
            w = words(r)
            out["vault"] = {"amount": int(w[1], 16) / 1e18, "end_time": int(w[2], 16), "admin": _a(w[3])}
            roles["vault admin"] = [out["vault"]["admin"]]
            log.add("dev vault (locked allocation, v3.1)", out["vault"], "tokens / unix time", f"allocation on {V31_VAULT}")
    out["roles"] = roles
    # the token's own links: v3.1 publishes Clanker metadata; v1-v3 were launched from a Farcaster cast whose
    # account id (fid) is in the launch record
    if ver == "v3.1":
        out["links"] = C.links({"metadata": c.get("metadata") or "", "context": ""})
    else:
        fid = c.get("fid")
        platform_fid = fid in PLATFORM_FIDS and (c.get("cast") or "").strip() == PLATFORM_FIDS[fid][0]
        if platform_fid:
            log.add("Farcaster account is the launch platform's (not the token's own)", {"fid": fid, "who": PLATFORM_FIDS[fid][1], "cast": c.get("cast")},
                    "fact", f"TokenCreated tx {c['tx']}")
        own = bool(fid) and not platform_fid
        out["links"] = {"twitter": None, "website": None, "telegram": None, "description": None,
                        "interface": "bankr" if platform_fid else None,
                        "platform": "farcaster" if own else None, "context_message": (c.get("cast") or None) if own else None,
                        "farcaster": f"https://farcaster.xyz/~/profiles/{fid}" if own else None,
                        "farcaster_cast": (c.get("cast") or None) if own else None}
    return out


def early_buys_v3(token: str, pool: str, create_block: int, launch_ts: int, creation_tx: str):
    """First-minute buys from the v3 pool's Swap events; the buyer is the transaction signer (the swap 'sender' is a router)."""
    lg, ok = logs(CHAIN, pool, V3_SWAP, create_block, create_block + C.BLOCKS_PER_MIN)
    if not ok:
        return None
    t0 = call(CHAIN, pool, "0x" + selector("token0()"))
    tok_is0 = t0 is not None and _a(t0) == token
    txs = []
    for l in lg:
        if l["transactionHash"].lower() == creation_tx.lower():
            continue
        w = words(l["data"])
        a0, a1 = _int(w[0]), _int(w[1])                     # pool's view: negative = left the pool (bought)
        if (a0 if tok_is0 else a1) < 0:
            txs.append(l)
    froms = _S.pmap(lambda l: rpc(CHAIN, "eth_getTransactionByHash", [l["transactionHash"]]), txs)
    if any(not isinstance(f, dict) for f in froms):
        return None
    return [{"wallet": f["from"].lower(), "slot": int(l["blockNumber"], 16),
             "t": launch_ts + (int(l["blockNumber"], 16) - create_block) * 2, "signature": l["transactionHash"]}
            for l, f in zip(txs, froms)]


def sampled_prices(pool: str, token_is0: bool, dec_paired: int, first_block: int, head: int, n: int = 40):
    blocks = sorted({first_block + 1 + (head - first_block - 1) * i // (n - 1) for i in range(n)})
    def price_at(b):
        r = call(CHAIN, pool, "0x" + selector("slot0()"), hex(b))
        sp = int(words(r)[0], 16) if r else 0
        return float(C.price_in_paired(sp, token_is0, 18, dec_paired)) if sp else None
    return [(b, p) for b, p in zip(blocks, _S.pmap(price_at, blocks)) if p]
