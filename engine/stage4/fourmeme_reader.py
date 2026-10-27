"""four.meme (BNB Chain) reader, Stage 4. four.meme's manager and helper code is unpublished, so every field used
here was verified against the chain first (facts EVM file, four.meme section):
  - events TokenCreate / TokenPurchase / TokenSale: topics match the cited signatures exactly; on every trade funds
    changes by exactly `cost` and offers by exactly `amount`
  - TokenManagerHelper3.getTokenInfo(token): at the block of a real trade, lastPrice / offers / funds equal that
    trade's values, 10 of 10 across 6 tokens (BNB- and USDT-quoted)
Graduation CONFIRMED (wuji, tx 0xa7b34b44...): manager creates a PancakeSwap v2 pair (official factory) and the LP is
minted to 0x...dEaD (100% burned, except the 1,000 units v2 locks by design). Missing stays missing.
"""
from __future__ import annotations
import os, sys
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from evm import rpc, call, selector, enc_address, words, dec, dec_string, topic
from flap_reader import alchemy_prices_usd, native_price, dev_moves, erc20, CHAIN, PCS_V2_FACTORY, WBNB, DEAD, first_transfer
from evm import enc_uint
from readers import Log

MANAGER = "0x5c952063c7fc8610ffdb798152d69f0b9550762b"
HELPER = "0xF251F83e40a78868FcfA3FA4599Dad6494E46034"
TOKEN_CREATE = topic("TokenCreate(address,address,uint256,string,string,uint256,uint256,uint256)")
_NAMES = ["version", "tokenManager", "quote", "lastPrice", "tradingFeeRate", "minTradingFee", "launchTime", "offers",
          "maxOffers", "funds", "maxFunds", "liquidityAdded"]
_TYPES = ["uint256", "address", "address", "uint256", "uint256", "uint256", "uint256", "uint256", "uint256", "uint256",
          "uint256", "bool"]
KNOWN_QUOTES = {"0x55d398326f99059ff775485246999027b3197955": "USDT"}


def info(token: str, block: str = "latest"):
    out = call(CHAIN, HELPER, "0x" + selector("getTokenInfo(address)") + enc_address(token), block)
    if out is None or len(words(out)) < 12:
        return None
    return {n: dec(w, t) for n, t, w in zip(_NAMES, _TYPES, words(out))}


def creation(token: str):
    t = first_transfer(CHAIN, token)                      # PINR's own creation read first, else Alchemy
    if t is None:
        return None
    rc = rpc(CHAIN, "eth_getTransactionReceipt", [t["hash"]])
    if not isinstance(rc, dict):
        return None
    for l in rc["logs"]:
        if l["address"].lower() == MANAGER.lower() and l["topics"][0] == TOKEN_CREATE:
            w = words(l["data"])
            if dec(w[1], "address").lower() == token.lower():
                # launchTime is 0 on 'launch immediately' tokens: use the creation block's own timestamp (unambiguous)
                blk = rpc(CHAIN, "eth_getBlockByNumber", [rc["blockNumber"], False])
                block_ts = int(blk["timestamp"], 16) if isinstance(blk, dict) else None
                lt = dec(w[6], "uint256")
                return {"creator": dec(w[0], "address"), "launch_ts": max(lt, block_ts or 0) or None, "tx": t["hash"],
                        "block": int(rc["blockNumber"], 16), "name": dec_string(l["data"], w[3]),
                        "symbol": dec_string(l["data"], w[4])}
    return None


def read(token: str, log: Log) -> dict:
    st = info(token)
    if st is None or st["tokenManager"].lower() != MANAGER.lower():
        return {"error": "not a four.meme v2 token, or helper unreadable"}
    log.add("four.meme state (Helper3.getTokenInfo, verified 10/10 vs trades)",
            {k: st[k] for k in ("quote", "lastPrice", "offers", "maxOffers", "funds", "maxFunds", "liquidityAdded", "tradingFeeRate")},
            "raw", f"getTokenInfo({token}) on {HELPER}")
    ts = erc20(token, "totalSupply()")
    supply = dec(ts[0], "uint256") / 1e18 if ts else None
    quote = st["quote"]
    is_bnb = int(quote, 16) == 0
    if is_bnb:
        q_usd, q_src = native_price("bsc", "BNB")
    else:
        from quote_price import quote_usd                     # its own PancakeSwap pool, anchored to Chainlink BNB/USD
        q_usd, q_src = quote_usd(quote)
    log.add("quote asset price", q_usd, "USD", q_src)
    out = {"status": "graduated" if st["liquidityAdded"] else "on curve", "supply": supply, "quote_usd": q_usd,
           "trading_fee": st["tradingFeeRate"] / 10000, "real_usd": None, "valuation_usd": None, "lp_buckets": None,
           "graduation_verified": True}
    if not st["liquidityAdded"] and q_usd and supply:
        out["real_usd"] = st["funds"] / 1e18 * q_usd
        out["valuation_usd"] = st["lastPrice"] / 1e18 * supply * q_usd
        out["progress"] = st["funds"] / st["maxFunds"] if st["maxFunds"] else None
    if st["liquidityAdded"]:
        q = WBNB if is_bnb else quote
        p = call(CHAIN, PCS_V2_FACTORY, "0x" + selector("getPair(address,address)") + enc_address(token) + enc_address(q))
        pool = ("0x" + p[-40:]) if p and int(p, 16) else None
        if pool:
            res = call(CHAIN, pool, "0x" + selector("getReserves()")); t0 = call(CHAIN, pool, "0x" + selector("token0()"))
            if res and t0 and q_usd and supply:
                r0, r1 = dec(words(res)[0], "uint256"), dec(words(res)[1], "uint256")
                tok_res, q_res = (r0, r1) if ("0x" + t0[-40:]).lower() == token.lower() else (r1, r0)
                if tok_res:
                    out["real_usd"] = q_res / 1e18 * q_usd
                    out["valuation_usd"] = (q_res / tok_res) * supply * q_usd
            lp_total = dec(words(call(CHAIN, pool, "0x" + selector("totalSupply()")))[0], "uint256")
            burned = sum(dec(words(call(CHAIN, pool, "0x" + selector("balanceOf(address)") + enc_address(a)))[0], "uint256") for a in DEAD)
            out["lp_buckets"] = [("burned", burned / lp_total)] + ([("wallet", 1 - burned / lp_total)] if burned < lp_total else [])
            out["pool"] = pool
            log.add("PancakeSwap v2 pool", {"pool": pool, "lp_burned_share": burned / lp_total}, "raw", f"getPair/getReserves on {pool}")
    log.add("real money / valuation", [out["real_usd"], out["valuation_usd"]], "USD",
            "four.meme funds and lastPrice" if not st["liquidityAdded"] else "PancakeSwap v2 reserves")
    code = rpc(CHAIN, "eth_getCode", [token, "latest"])
    owner = erc20(token, "owner()")
    out["owner"] = ("0x" + owner[0][-40:]).lower() if owner else None
    mode = call(CHAIN, token, "0x" + selector("_mode()"))
    out["mode"] = int(mode, 16) if mode else None
    out["contract"] = {"bytes": (len(code) // 2) if isinstance(code, str) else None,
                       "template": "four.meme Token (verified; no mint/pause/blacklist; launchpad-held setMode)"}
    log.add("token contract", {"owner": out["owner"], "mode": out["mode"]}, "address", f"owner()/_mode() on {token}")
    out["creation"] = creation(token)
    if out["creation"]:
        log.add("creator (four.meme TokenCreate)", out["creation"]["creator"], "address", f"tx {out['creation']['tx']}")
    return out
