"""Bankr on Doppler (Base) reader, Stage 4. Every number is read from chain with a receipt; nothing is guessed.
Facts behind it (facts EVM file, "Bankr on Doppler" section; verified source on Basescan, read 2026-10-04):
  - Bankr token = Airlock record whose integrator is Bankr's fee wallet. Token = clone of the verified DopplerERC20V1:
    mints once at creation, no pause/blacklist/tax; owner = the Airlock forever (NoOpMigrator always reverts), and the
    Airlock has no way to use the owner's functions. Its controller can only switch OFF the early per-wallet cap.
  - liquidity sits in the verified DopplerHookInitializer, status Locked: it can leave only via exitLiquidity, which
    needs status Initialized, so never. Timelock 0x0 -> nobody can switch the pool's Doppler hook.
  - Rehype hook: swap fee decays to an end fee, capped at 80%, set once at launch; it cannot block a sell. Part of the
    token-side fees can be SOLD for the paired token (a selling step -> reward-flow pressure is measured).
  - outsiders CAN add removable liquidity, so the locked share is measured from the launch positions.
Missing stays missing.
"""
from __future__ import annotations
import calendar, os, sys, time
from decimal import Decimal
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from evm import rpc, call, selector, enc_address, enc_uint, words, dec, dec_string, topic, keccak256
from flap_reader import alchemy_prices_usd, native_price, first_transfer
from readers import Log, http_json, metadata_document
import clanker_reader as C                      # shared v4 helpers (price, erc20 reads, early buys, sampled prices)
import v4_depth as V4
import solana_rpc as _S

CHAIN = "base"
AIRLOCK = "0x660eaaedebc968f8f3694354fa8ec0b4c5ba8d12"
BANKR_FEE_WALLET = "0xf60633d02690e2a15a54ab919925f3d038df163e"
DOPPLER_SAFE = "0x21e2ce70511e4fe542a97708e89520471daa7a66"           # Airlock owner; takes the 5% protocol share
TOKEN_IMPL = "0xdb7b520bb5c3a2c5d4871198081911359f93be87"             # DopplerERC20V1 (verified)
VERIFIED_PARTS = {
    "0xbdf938149ac6a781f94faa0ed45e6a0e984c6544": "DopplerHookInitializer",
    "0x6ddfed58d238ca3195e49d8ac3d4cea6386e5c33": "NoOpMigrator (migration always reverts)",
    "0x9982538f41f2ae29ddb9d3d9307010052984fdbb": "RehypeDopplerHookInitializer (Bankr fee hook)",
}
PLATFORM_WALLETS = {BANKR_FEE_WALLET: "Bankr fee wallet", DOPPLER_SAFE: "Doppler protocol Safe"}
CREATE = topic("Create(address,address,address,address)")
VESTING_ALLOCATED = topic("VestingAllocated(address,uint256,uint256)")
VESTING_SCHEDULE = topic("VestingScheduleCreated(uint256,uint64,uint64)")
MODIFY_LIQUIDITY = topic("ModifyLiquidity(bytes32,address,int24,int24,int256,bytes32)")
STATUS = {0: "uninitialized", 1: "initialized", 2: "locked", 3: "graduated", 4: "exited"}
_a, _int = C._a, C._int


def _metadata(token: str):
    u = call(CHAIN, token, "0x" + selector("tokenURI()"))
    uri = dec_string(u, words(u)[0]) if u else None
    if not uri:
        return uri, None
    url = "https://ipfs.io/ipfs/" + uri[7:] if uri.startswith("ipfs://") else uri
    j = metadata_document(url)                     # the team's F1 on c7255ae3: the gateways not resting, one try each
    return uri, j


def links(meta: dict | None) -> dict:
    """The token's own links from its (immutable) metadata. Every URL found is classified by its domain."""
    out = {"twitter": None, "website": None, "telegram": None, "farcaster": None, "description": None,
           "interface": "bankr", "platform": None, "context_message": None}
    if not meta:
        return out
    out["description"] = meta.get("description")
    # Bankr's own (immutable) record of which X accounts launched the token and receive its fees
    out["x_accounts"] = {role: (meta.get(k) or {}).get("x_username") for role, k in
                         (("deployer", "initial_deployer"), ("fee recipient", "initial_fee_recipient"))
                         if (meta.get(k) or {}).get("x_username")}
    found = []
    def walk(v, key=""):
        if isinstance(v, dict):
            for k, x in v.items():
                walk(x, k)
        elif isinstance(v, list):
            for x in v:
                walk(x, key)
        elif isinstance(v, str) and v.strip().lower().startswith("http"):
            found.append((key.lower(), v.strip()))
    walk({k: v for k, v in meta.items() if k not in ("image", "animation_url")})
    for key, url in found:
        u = url.lower()
        if "x.com/" in u or "twitter.com/" in u:
            out["twitter"] = out["twitter"] or url
        elif "t.me/" in u or "telegram.me/" in u:
            out["telegram"] = out["telegram"] or url
        elif "warpcast.com/" in u or "farcaster.xyz/" in u:
            out["farcaster"] = out["farcaster"] or url
        elif "ipfs" not in u and not u.endswith((".png", ".jpg", ".jpeg", ".gif", ".webp")):
            out["website"] = out["website"] or url
    return out


def creation(token: str):
    """First transfer -> creation tx -> Airlock Create, vesting allocations, and the launch liquidity positions."""
    t = first_transfer(CHAIN, token)                      # PINR's own creation read first, else Alchemy
    if t is None:
        return None
    rc = rpc(CHAIN, "eth_getTransactionReceipt", [t["hash"]])
    if not isinstance(rc, dict):
        return None
    ok = any(l["address"].lower() == AIRLOCK and l["topics"][0] == CREATE and _a(words(l["data"])[0]) == token for l in rc["logs"])
    if not ok:
        return None
    schedules, vest, positions = {}, [], []
    for l in rc["logs"]:
        if l["address"].lower() == token and l["topics"][0] == VESTING_SCHEDULE:
            w = words(l["data"]); schedules[int(l["topics"][1], 16)] = (int(w[0], 16), int(w[1], 16))
        elif l["address"].lower() == token and l["topics"][0] == VESTING_ALLOCATED:
            vest.append({"beneficiary": _a(l["topics"][1]), "schedule": int(l["topics"][2], 16), "amount": int(l["data"], 16) / 1e18})
        elif l["address"].lower() == V4.POOLMANAGER[CHAIN].lower() and l["topics"][0] == MODIFY_LIQUIDITY:
            w = words(l["data"])
            positions.append({"pool_id": l["topics"][1], "owner": _a(l["topics"][2]), "tick_lower": _int(w[0], 24),
                              "tick_upper": _int(w[1], 24), "liquidity": _int(w[2]), "salt": "0x" + w[3]})
    return {"tx": t["hash"], "tx_from": rc["from"].lower(), "block": int(rc["blockNumber"], 16),
            "launch_ts": C._ts(t["metadata"]["blockTimestamp"]), "schedules": schedules, "vesting": vest, "launch_positions": positions}


def clone_target(code) -> str | None:
    """Template address of an immutable minimal clone (whole bytecode must match exactly), else None.
    EIP-1167 and the 44-byte Solady variant: no upgrade slot, every call forwards to the fixed template."""
    if not isinstance(code, str):
        return None
    c = code.lower()
    for pre, post in (("0x363d3d373d3d3d363d73", "5af43d82803e903d91602b57fd5bf3"),
                      ("0x3d3d3d3d363d3d37363d73", "5af43d3d93803e602a57fd5bf3")):
        if c.startswith(pre) and c.endswith(post) and len(c) == len(pre) + 40 + len(post):
            return "0x" + c[len(pre):len(pre) + 40]
    return None


def position_liquidity(pool_id: str, owner: str, tl: int, tu: int, salt: str):
    r = call(CHAIN, V4.STATEVIEW[CHAIN], "0x" + selector("getPositionInfo(bytes32,address,int24,int24,bytes32)") + pool_id[2:]
             + enc_address(owner) + V4._enc_int(tl) + V4._enc_int(tu) + salt[2:])
    return int(words(r)[0], 16) if r else None


def read(token: str, log: Log) -> dict:
    token = token.lower()
    ad = call(CHAIN, AIRLOCK, "0x" + selector("getAssetData(address)") + enc_address(token))
    if not ad:
        return {"error": "Airlock record unreadable"}
    w = words(ad)
    asset = {"numeraire": _a(w[0]), "timelock": _a(w[1]), "migrator": _a(w[3]), "initializer": _a(w[4]),
             "pool": _a(w[5]), "total_supply": int(w[8], 16) / 1e18, "integrator": _a(w[9])}
    if int(asset["initializer"], 16) == 0:
        return {"error": "not a Doppler (Airlock) token"}
    if asset["integrator"] != BANKR_FEE_WALLET:
        return {"error": f"Doppler token, but not launched by Bankr (integrator {asset['integrator']})"}
    c = creation(token)
    if c is None:
        return {"error": "creation transaction unreadable, or no Airlock Create event for this token"}
    log.add("Doppler Airlock record", asset, "raw", f"getAssetData on {AIRLOCK}; creation tx {c['tx']}")

    # token contract: a clone of the verified template, owned by the Airlock
    code = rpc(CHAIN, "eth_getCode", [token, "latest"])
    impl = clone_target(code)
    owner = (lambda r: _a(r) if r else None)(call(CHAIN, token, "0x" + selector("owner()")))
    hi = asset["initializer"]
    st = call(CHAIN, hi, "0x" + selector("getState(address)") + enc_address(token)) if hi in VERIFIED_PARTS else None
    sw = words(st) if st else None
    key = {"currency0": _a(sw[5]), "currency1": _a(sw[6]), "fee": int(sw[7], 16), "tickSpacing": _int(sw[8], 24),
           "hooks": _a(sw[9])} if sw else None
    hook, status = (_a(sw[2]), int(sw[4], 16)) if sw else (None, None)
    parts = [hi, asset["migrator"]] + ([hook] if hook and int(hook, 16) else [])
    unknown_parts = [p for p in parts if p not in VERIFIED_PARTS]
    if impl != TOKEN_IMPL:
        unknown_parts.append(f"token template {impl}")
    checks = {"token_template": "DopplerERC20V1" if impl == TOKEN_IMPL else impl, "owner_is_airlock": owner == AIRLOCK,
              "migrator_noop": asset["migrator"] == "0x6ddfed58d238ca3195e49d8ac3d4cea6386e5c33",
              "timelock_zero": int(asset["timelock"], 16) == 0, "pool_status": STATUS.get(status, status)}
    log.add("Bankr/Doppler safety checks", dict(checks, parts={p: VERIFIED_PARTS.get(p, "NOT YET VERIFIED") for p in parts}),
            "facts", "eth_getCode / owner() / getState on the initializer")
    locked_design = checks["owner_is_airlock"] and checks["migrator_noop"] and checks["timelock_zero"] and status == 2

    uri, meta = _metadata(token)
    nm = call(CHAIN, token, "0x" + selector("name()")); sy = call(CHAIN, token, "0x" + selector("symbol()"))
    c["name"] = dec_string(nm, words(nm)[0]) if nm else None
    c["symbol"] = dec_string(sy, words(sy)[0]) if sy else None
    c["metadata"], c["token_uri"] = meta, uri
    supply_raw = C.erc20_int(token, "totalSupply()")
    supply = supply_raw / 1e18 if supply_raw is not None else None
    paired = asset["numeraire"]
    dec_paired = C.erc20_int(paired, "decimals()")
    if paired == C.WETH:
        q_usd, q_src = native_price("base", "ETH")
    else:
        q_usd = alchemy_prices_usd(addresses=(paired,), network=C.NETWORK).get(paired, (None,))[0]
        q_src = f"Alchemy Prices API ({paired})"
    log.add("paired asset price", q_usd, "USD", q_src)

    out = {"status": "pool (Uniswap v4, Doppler)", "supply": supply, "quote_usd": q_usd, "real_usd": None, "valuation_usd": None,
           "lp_buckets": None, "creation": c, "unknown_parts": unknown_parts, "links": links(meta), "paired": paired,
           "checks": checks, "locked_design": locked_design, "hook": hook}
    pool_id = None
    if key:
        enc = "".join(sw[5:10])
        pool_id = "0x" + keccak256(bytes.fromhex(enc)).hex()
        out["pool_id"] = pool_id
        token_is0 = key["currency0"] == token
        pool = V4.read_pool(CHAIN, pool_id, key["tickSpacing"])
        if pool and pool["liquidity_check"] and dec_paired is not None:
            a0, a1 = V4.amounts(pool["ranges"], pool["sqrtPriceX96"], pool["tick"])
            paired_raw, token_raw = (a1, a0) if token_is0 else (a0, a1)
            px = C.price_in_paired(pool["sqrtPriceX96"], token_is0, 18, dec_paired)
            out["price_paired"], out["pool_paired"], out["pool_tokens"] = float(px), float(paired_raw) / 10 ** dec_paired, float(token_raw) / 1e18
            if q_usd and supply:
                out["real_usd"] = out["pool_paired"] * q_usd
                out["valuation_usd"] = float(px) * supply * q_usd
            log.add("Uniswap v4 pool", {"pool_id": pool_id, "tick": pool["tick"], "pool_liquidity": pool["pool_liquidity"],
                                        "rebuilt_liquidity_matches": True, "paired_in_pool": out["pool_paired"], "tokens_in_pool": out["pool_tokens"]},
                    "raw", f"StateView {V4.STATEVIEW[CHAIN]}")
            # permanence: value held by the launch positions (locked by design) + Rehype's own fee-LP position
            mine = [p for p in c["launch_positions"] if p["pool_id"].lower() == pool_id and p["owner"] == hi]
            liqs = _S.pmap(lambda p: position_liquidity(pool_id, p["owner"], p["tick_lower"], p["tick_upper"], p["salt"]), mine)
            rp = call(CHAIN, hook, "0x" + selector("getPosition(bytes32)") + pool_id[2:]) if hook in VERIFIED_PARTS else None
            if locked_design and mine and all(x is not None for x in liqs):
                ranges = [(p["tick_lower"], p["tick_upper"], L) for p, L in zip(mine, liqs) if L > 0]
                if rp:
                    rw = words(rp); tl, tu, salt = _int(rw[0], 24), _int(rw[1], 24), "0x" + rw[3]
                    L = position_liquidity(pool_id, hook, tl, tu, salt)
                    if L:
                        ranges.append((tl, tu, L))
                l0, l1 = V4.amounts(ranges, pool["sqrtPriceX96"], pool["tick"])
                lp_, lt_ = (l1, l0) if token_is0 else (l0, l1)
                pxr = V4.price1_per_0(pool["sqrtPriceX96"]); pxr = pxr if token_is0 else 1 / pxr
                total_val, locked_val = paired_raw + token_raw * pxr, lp_ + lt_ * pxr
                share = float(min(Decimal(1), locked_val / total_val)) if total_val else None
                if share is not None:
                    out["lp_buckets"] = [("locked_forever", share)] + ([("wallet", 1 - share)] if share < 1 - 1e-9 else [])
                log.add("liquidity locked by design", {"launch_positions": len(mine), "rehype_fee_lp": bool(rp), "locked_share_of_pool_value": share},
                        "share", "creation-tx ModifyLiquidity + StateView.getPositionInfo")
        else:
            log.add("Uniswap v4 pool", "unreadable, or rebuilt liquidity did not match the pool (refused)", "-", "StateView")
    log.add("real money / valuation", [out["real_usd"], out["valuation_usd"]], "USD", "Uniswap v4 ranges x paired price")

    # fees: beneficiaries, schedule, split (selling step = asset fees routed to a paired-token buyback)
    b = call(CHAIN, hi, "0x" + selector("getBeneficiaries(address)") + enc_address(token))
    bw = words(b) if b else []
    bens = [(_a(bw[2 + 2 * i]), int(bw[3 + 2 * i], 16) / 1e18) for i in range(int(bw[1], 16))] if bw else None
    out["beneficiaries"] = bens
    out["sell_step"] = None
    if pool_id and hook in VERIFIED_PARTS:
        fd = call(CHAIN, hook, "0x" + selector("getFeeDistributionInfo(bytes32)") + pool_id[2:])
        fs = call(CHAIN, hook, "0x" + selector("getFeeSchedule(bytes32)") + pool_id[2:])
        if fd:
            f = [int(x, 16) / 1e18 for x in words(fd)]
            out["fee_split"] = f
            out["sell_step"] = f[1] > 0
        if fs:
            s = [int(x, 16) for x in words(fs)]
            out["fee_schedule"] = {"start_fee": s[1] / 1e6, "end_fee": s[2] / 1e6, "decay_seconds": s[4]}
        log.add("Bankr fee setup (Rehype)", {"beneficiaries": bens, "schedule": out.get("fee_schedule"),
                                            "token_fees_sold_share": (out.get("fee_split") or [None, None])[1]},
                "raw", f"getBeneficiaries on {hi}; getFeeDistributionInfo/getFeeSchedule on {hook}")

    # creator vest
    vs = []
    for v in c["vesting"]:
        r = call(CHAIN, token, "0x" + selector("vestingOf(address,uint256)") + enc_address(v["beneficiary"]) + enc_uint(v["schedule"]))
        rel = int(words(r)[1], 16) / 1e18 if r else None
        cl, du = c["schedules"].get(v["schedule"], (None, None))
        vs.append(dict(v, released=rel, cliff_days=cl and cl / 86400, duration_days=du and du / 86400))
    out["vesting"] = vs
    if vs:
        log.add("creator vesting (locked allocation)", vs, "tokens / days", f"VestingAllocated in tx {c['tx']}; vestingOf on {token}")
    if out["links"].get("x_accounts"):
        log.add("X accounts named by Bankr (who launched it / who gets the fees)", out["links"]["x_accounts"], "X handle",
                f"token metadata {uri} (immutable: only the Airlock could change it)")
    md = meta or {}
    out["named"] = {"deployer": [((md.get("initial_deployer") or {}).get("address") or "").lower()],
                    "fee recipient": [((md.get("initial_fee_recipient") or {}).get("address") or "").lower()]
                                     + [w for w, _ in (bens or [])],
                    "vesting": [v["beneficiary"] for v in vs]}
    return out
