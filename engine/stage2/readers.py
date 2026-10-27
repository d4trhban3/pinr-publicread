"""Stage 2 chain readers: pull a token's real numbers from Solana mainnet, each with a receipt.

Rules: never invent a value. Anything that can't be read comes back as None with a note,
and the engine turns it into "unknown" (lowers coverage), never a zero.
Off-chain APIs are used only as POINTERS (where to look); every pointer is verified on chain.
"""
from __future__ import annotations
import base64, datetime, json, os, sqlite3, struct, sys, time, urllib.error, urllib.request
from typing import Optional
from solana_rpc import rpc
from b58 import b58d, b58e, pda, oc

PUMP = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P"
PUMP_AMM = "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA"
LAUNCHLAB = "LanMV9sAd7wArD4vJFi2qDdfnVhFxYSUg6eADduJ3uj"
CPMM = "CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C"
RAYDIUM_LOCK = "LockrWmn6K5twhz3y9w1dQERbmgSaRkfnTeTKbpofwE"
METAPLEX = "metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s"
WSOL = "So11111111111111111111111111111111111111112"
TOKEN_2022 = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"

# Verified lists (facts/launchpad-facts-2026-10-03.md). Each entry earned with chain evidence.
VERIFIED_LAUNCHPAD_PROGRAM_ACCOUNTS = {
    "WLHv2UAZm6z4KyaaELi5pjdbJh6RESMva1Rnn8pJVVh": "Raydium LaunchLab vault-authority PDA",
}
VERIFIED_LAUNCHPAD_WALLETS = {
    "5KXDF6QnqhBj72hDtJNkkpFaQVUfbFXNybMsp3DiK6tD": "StonkFun tax collector / fee authority",
    "5CEbueQnq1Ym2uSSx2xXds3jQAqT1BDnkA59RZobSPAG": "StonkFun platform wallet (fee key, LP NFT)",
}
VERIFIED_LOCK_OWNERS = {
    "3f7GcQFG397GAaEnv51zR6tsTVihYRydnydDD1cXekxH": "Raydium LP lock (LockCpLiquidity) authority",
}
STONKFUN_COLLECTOR = "5KXDF6QnqhBj72hDtJNkkpFaQVUfbFXNybMsp3DiK6tD"

# The LaunchLab platform accounts: every LaunchLab pool carries the account of the platform that made it
# (`platform_config`, bytes 173 to 205 of the pool state). These are the accounts PINR knows the launchpads by. The ids are
# LEADS until the chain confirms them: Stonk.fun's three are what its `/launchlab/pricing` endpoint reported on 2026-10-17
# (the launchpad brief, section 5.4; Stonk.fun's own page says they can change), bonk.fun's is the brief's section 5.1
# (unverified there). So an entry is never trusted from this list alone: `launchlab_platform()` reads the account on
# chain once a process and uses the name only if the account exists and the LaunchLab program owns it; anything else, and
# any account not listed, is "unknown platform", never a guess.
LAUNCHLAB_PLATFORMS = {
    "4E876qZTE9FJMrBzgVtBrSrzz2TLivB5Y5QXPjB4gZL7": ("stonk", "standard mode"),
    "6BwHHDg3u1854jC8PDLXvR4spTcLNaoBxLJNGC4nTESt": ("stonk", "reward mode"),
    "CUqSiwPs6C4WyntMgaFazLp7wYQfaLp5URbjUP9V7SNi": ("stonk", "community mode"),
    "FfYek5vEz23cMkWsdJwG2oa6EphsvXSHrGpdALN4g6W1": ("bonk", None),
}
# The platform's NAME is read from the account itself: Raydium's LaunchLab platform config keeps a
# 64-byte name after its header (8 discriminator, 8 epoch, two 32-byte wallets, four 8-byte scales and rates: byte 112),
# then its web address. Read 2026-10-17 on all four accounts: "StonkFun" on Stonk.fun's three, "letsbonk.fun" on
# bonk.fun's (tools/profiles/2026-10-17-launchlab-platform-accounts.json). The list above keeps only the mode and the
# stem the chain's name must contain; a name that does not contain it is not trusted.
PLATFORM_NAME_AT = 112
_PLATFORM_CHECKED = {}          # account -> (ok, words, chain name): the chain check, once a process


def platform_config_name(raw: bytes) -> str:
    """The platform's own name from its LaunchLab platform-config account (Raydium's layout), '' if none."""
    try:
        return raw[PLATFORM_NAME_AT:PLATFORM_NAME_AT + 64].split(b"\0")[0].decode("utf-8", "replace").strip()
    except Exception:
        return ""


def now_utc() -> str:
    return datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds")


class Log:
    """Collects receipts: (what, value, unit, source, as_of)."""
    def __init__(self):
        self.items: list[dict] = []

    def add(self, what, value, unit, source, slot=None):
        self.items.append({"what": what, "value": value, "unit": unit, "source": source,
                           "as_of": f"slot {slot}" if slot else now_utc()})
        return value


def _u64(raw, o):
    return struct.unpack_from("<Q", raw, o)[0]


def account_raw(addr):
    r = rpc("getAccountInfo", [addr, {"encoding": "base64"}])
    if not isinstance(r, dict) or "ERROR" in r:
        return None, None, None
    v = r["value"]
    if v is None:
        return None, None, r["context"]["slot"]
    return base64.b64decode(v["data"][0]), v["owner"], r["context"]["slot"]


def account_parsed(addr):
    r = rpc("getAccountInfo", [addr, {"encoding": "jsonParsed"}])
    if not isinstance(r, dict) or "ERROR" in r or r.get("value") is None:
        return None, None
    return r["value"], r["context"]["slot"]


def token_balance_raw(token_account) -> Optional[int]:
    v, _ = account_parsed(token_account)
    if v is None:
        return None
    return int(v["data"]["parsed"]["info"]["tokenAmount"]["amount"])


def _counted(url, answered: bool) -> None:
    try:                                  # the saved request count per source (`scanner.py status`); never in the way
        import solana_rpc
        solana_rpc.count(solana_rpc.label(url), answered)
    except Exception:
        pass


def http_json(url, tries=3, timeout=20, headers=None):
    for i in range(tries):
        try:
            req = urllib.request.Request(url, headers=dict({"User-Agent": "PINR-live/1.0 (read-only; pinr.io)"}, **(headers or {})))
            r = json.load(urllib.request.urlopen(req, timeout=timeout))
        except Exception:
            _counted(url, False)
            time.sleep(2 * (i + 1))
            continue
        _counted(url, True)
        return r
    return None


# ------------------------------------------------------------------ mint and authorities
def read_mint(mint: str, log: Log) -> Optional[dict]:
    v, slot = account_parsed(mint)
    if v is None:
        return None
    info = v["data"]["parsed"]["info"]
    out = {"program": v["owner"], "decimals": info["decimals"], "supply_raw": int(info["supply"]),
           "powers": {}, "unrecognized_extensions": [], "transfer_fee_bps": None,
           "withdraw_withheld_authority": None, "transfer_hook_program": None}
    log.add("token program", v["owner"], "program id", f"getAccountInfo {mint}", slot)
    log.add("total supply", int(info["supply"]) / 10 ** info["decimals"], "tokens", f"getAccountInfo {mint}", slot)
    powers = out["powers"]
    powers["mint"] = info.get("mintAuthority")
    powers["freeze"] = info.get("freezeAuthority")
    for e in info.get("extensions", []):
        name, st = e["extension"], e.get("state") or {}
        if name == "transferFeeConfig":
            powers["transfer_fee_config"] = st.get("transferFeeConfigAuthority")
            out["withdraw_withheld_authority"] = st.get("withdrawWithheldAuthority")
            out["transfer_fee_bps"] = st.get("newerTransferFee", {}).get("transferFeeBasisPoints")
        elif name == "permanentDelegate":
            powers["permanent_delegate"] = st.get("delegate")
        elif name == "transferHook":
            powers["transfer_hook"] = st.get("authority")
            out["transfer_hook_program"] = st.get("programId")
        elif name == "pausableConfig":
            powers["pause"] = st.get("authority")
        elif name == "tokenMetadata":
            powers["metadata_update"] = st.get("updateAuthority")
        elif name == "metadataPointer":
            powers.setdefault("metadata_pointer", st.get("authority"))
        elif name in ("mintCloseAuthority",):
            powers["mint_close"] = st.get("closeAuthority")
        else:
            out["unrecognized_extensions"].append(name)
    if v["owner"] != TOKEN_2022 or "metadata_update" not in powers:
        md = pda([b"metadata", b58d(METAPLEX), b58d(mint)], METAPLEX)
        raw, owner, mslot = account_raw(md)
        if raw is not None and owner == METAPLEX:
            ua = b58e(raw[1:33])
            o = 65
            for _ in range(3):
                n = int.from_bytes(raw[o:o + 4], "little"); o += 4 + n
            o += 2
            if raw[o] == 1:
                n = int.from_bytes(raw[o + 1:o + 5], "little"); o += 5 + n * 34
            else:
                o += 1
            o += 1
            mutable = bool(raw[o])
            powers["metadata_update"] = ua if mutable else None
            log.add("Metaplex metadata update authority", ua if mutable else "immutable", "address",
                    f"getAccountInfo {md}", mslot)
    for k, holder in powers.items():
        log.add(f"power: {k}", holder or "none (renounced)", "address", f"getAccountInfo {mint}", slot)
    return out


def classify_holder(addr: Optional[str], creator: Optional[str]) -> str:
    if addr is None:
        return "renounced"
    if addr in VERIFIED_LAUNCHPAD_PROGRAM_ACCOUNTS:
        return "verified_launchpad_program"
    if addr in VERIFIED_LAUNCHPAD_WALLETS:
        return "verified_launchpad_wallet"
    if creator and addr == creator:
        return "dev_or_linked"
    return "unexplained_wallet"


# ------------------------------------------------------------------ venues
def read_pump_curve(mint: str, log: Log) -> Optional[dict]:
    addr = pda([b"bonding-curve", b58d(mint)], PUMP)
    raw, owner, slot = account_raw(addr)
    if raw is None or owner != PUMP:
        return None
    vt, vs, rt, rs, ts = [_u64(raw, 8 + 8 * i) for i in range(5)]
    d = {"mint": mint, "address": addr, "virtual_token": vt, "virtual_quote": vs, "real_token": rt, "real_quote": rs,
         "total_supply": ts, "complete": bool(raw[48]), "creator": b58e(raw[49:81]),
         "mayhem": bool(raw[81]) if len(raw) > 81 else False,
         "quote_mint": b58e(raw[83:115]) if len(raw) >= 115 and any(raw[83:115]) else WSOL}
    log.add("Pump curve state", {k: d[k] for k in ("virtual_token", "virtual_quote", "real_quote", "complete", "mayhem")},
            "raw units", f"getAccountInfo {addr}", slot)
    log.add("creator (from curve)", d["creator"], "address", f"getAccountInfo {addr}", slot)
    return d


def read_pumpswap_pool(mint: str, log: Log) -> Optional[dict]:
    pa = pda([b"pool-authority", b58d(mint)], PUMP)
    addr = pda([b"pool", (0).to_bytes(2, "little"), b58d(pa), b58d(mint), b58d(WSOL)], PUMP_AMM)
    raw, owner, slot = account_raw(addr)
    if raw is None or owner != PUMP_AMM or b58e(raw[43:75]) != mint:
        return None
    d = {"address": addr, "quote_mint": b58e(raw[75:107]), "lp_mint": b58e(raw[107:139]),
         "base_vault": b58e(raw[139:171]), "quote_vault": b58e(raw[171:203]),
         "lp_supply_state": _u64(raw, 203)}
    log.add("PumpSwap pool (derived canonical PDA, verified owner and base mint)", addr, "address",
            f"getAccountInfo {addr}", slot)
    return d


def read_launchlab_pool(pool: str, mint: str, log: Log, raw=None) -> Optional[dict]:
    """The pool's state from its own account; None when it could not be read or is not a LaunchLab pool of this coin.
    `raw` = the account already read as (raw, owner, slot), so a caller that must tell "unread" from "not a pool" reads once."""
    raw, owner, slot = raw if raw is not None else account_raw(pool)
    if raw is None or owner != LAUNCHLAB or b58e(raw[205:237]) != mint:
        return None
    supply, tbs, vb, vq, rb, rq, target = [_u64(raw, 21 + 8 * i) for i in range(7)]
    d = {"address": pool, "status": raw[17], "base_decimals": raw[18], "quote_decimals": raw[19],
         "virtual_base": vb, "virtual_quote": vq, "real_base": rb, "real_quote": rq,
         "quote_mint": b58e(raw[237:269]), "base_vault": b58e(raw[269:301]),
         "quote_vault": b58e(raw[301:333]), "creator": b58e(raw[333:365]),
         "platform_config": b58e(raw[173:205]), "config_id": b58e(raw[141:173])}
    log.add("LaunchLab pool state", {k: d[k] for k in ("status", "virtual_base", "virtual_quote", "real_base", "real_quote")},
            "raw units", f"getAccountInfo {pool}", slot)
    log.add("creator (from LaunchLab pool)", d["creator"], "address", f"getAccountInfo {pool}", slot)
    return d


LAUNCHLAB_API = "https://launch-mint-v1.raydium.io/get/by/mints?ids="


def launchlab_platform(platform_config: str, log: Log, get=None) -> dict:
    """Which launchpad made a LaunchLab pool, from the pool's own platform account. Returns
    {"name": the platform's name as its own account states it | None, "mode": ..., "words": the dossier's words,
    "verified": bool}. A listed account is used only after one read a process shows it exists on chain, the LaunchLab
    program owns it, and the name it keeps contains the listed stem (W3: the name comes from the chain, the list keeps
    only the mode); an account that fails any of that, or is not listed, gives "unknown platform". A receipt on every
    outcome."""
    get = get or account_raw
    hit = LAUNCHLAB_PLATFORMS.get(platform_config)
    if hit is None:
        log.add("LaunchLab platform", "unknown platform", "text", f"platform_config {platform_config}: not a known launchpad account")
        return {"name": None, "mode": None, "words": "unknown platform", "verified": False}
    stem, mode = hit
    if platform_config not in _PLATFORM_CHECKED:
        try:
            raw, owner, slot = get(platform_config)
            name = platform_config_name(raw) if raw else ""
            if raw is None:                                   # not read this time (the node refused, or no such account): not trusted, asked again
                _PLATFORM_CHECKED[platform_config] = (None, "the account could not be read, or does not exist on chain", "")
            elif owner != LAUNCHLAB:
                _PLATFORM_CHECKED[platform_config] = (False, f"the account is owned by {owner}, not the LaunchLab program", name)
            elif stem not in name.lower():
                _PLATFORM_CHECKED[platform_config] = (False, f"the account's own name is {name!r}, not the launchpad listed for it", name)
            else:
                _PLATFORM_CHECKED[platform_config] = (True, f"exists, owned by the LaunchLab program, names itself {name!r}, {len(raw)} bytes, slot {slot}", name)
        except Exception as e:
            _PLATFORM_CHECKED[platform_config] = (None, f"the account could not be read ({type(e).__name__})", "")
    ok, words, name = _PLATFORM_CHECKED[platform_config]
    if ok:
        said = name + (f" ({mode})" if mode else "")
        log.add("LaunchLab platform", said, "text", f"platform_config {platform_config}: {words} (getAccountInfo)")
        return {"name": name, "mode": mode, "words": said, "verified": True}
    if ok is None:                                           # unread this time: not trusted, and asked again next process
        _PLATFORM_CHECKED.pop(platform_config, None)
    log.add("LaunchLab platform", "unknown platform", "text", f"platform_config {platform_config} is listed for {stem} but {words}")
    return {"name": None, "mode": None, "words": "unknown platform", "verified": False}


# ------------------------------------------------------------------ transfer fees and rewards programs
_STANDARD = {}                 # program -> (result dict, at seconds): read once an hour a process
STANDARD_SECONDS = 3600
STANDARD_SAMPLE = 10
PROGRAM_STEM = {"StonkFun reward mode": "stonk"}      # the program -> the stem its platform account's own name carries
_CURVE_RULE = {}               # (platform, config) -> (result, at seconds): the settings account, read once an hour a process

# Raydium LaunchLab's PlatformCurveRule account (the program's own launch settings; Raydium's published layout, read
# 2026-10-17 from raydium-sdk-V2 src/raydium/launchpad/layout.ts and type.ts): 8 discriminator, bump u8, version u8,
# platformId, configId, epoch u64, 8 reserved u64, then a list of rule groups (u32 count): groupId u16, epoch u64, a list
# of constraints (u32 count): field u8, op u8, value u128. A launch must fit one group. Field 11 is TransferFeeBasisPoints,
# field 10 TransferFeeEnabled; op 0 Eq, 1 Gte (a minimum), 2 Lte (a maximum), 3 Neq. The account's address is derived
# from the platform and global config accounts with the seed "platform_curve_rule" (verified: the derivation gives the
# account Stonk.fun's settings name, and the account read on chain names that platform and config back).
CURVE_RULE_SEED = b"platform_curve_rule"
FIELD_FEE_BPS, FIELD_FEE_ON = 11, 10
OP_EQ, OP_GTE, OP_LTE = 0, 1, 2


def decode_curve_rule(raw: bytes) -> dict:
    """The rule groups of a PlatformCurveRule account, by Raydium's layout; raises on a shape that is not it."""
    pid, cid = b58e(raw[10:42]), b58e(raw[42:74])
    o, groups = 146, []
    n = struct.unpack_from("<I", raw, o)[0]; o += 4
    if n > 10:
        raise ValueError("more rule groups than LaunchLab allows")
    for _ in range(n):
        gid, epoch, nc = struct.unpack_from("<HQI", raw, o); o += 14
        if nc > 25:
            raise ValueError("more constraints than LaunchLab allows")
        cons = []
        for _c in range(nc):
            field, op = raw[o], raw[o + 1]
            lo, hi = struct.unpack_from("<QQ", raw, o + 2); o += 18
            cons.append((field, op, lo + (hi << 64)))
        groups.append({"group": gid, "epoch": epoch, "constraints": cons})
    if o != len(raw):
        raise ValueError(f"{len(raw) - o} bytes left over: not the layout")
    return {"platform_id": pid, "config_id": cid, "version": raw[9], "groups": groups}


def allowed_fee_bps(decoded: dict) -> list:
    """The transfer-fee rates the settings allow, one figure a group: Eq gives the rate, Lte the most, Gte alone says
    nothing about the most; a group with the fee switched off, or with no rate constraint, gives none."""
    out = set()
    for g in decoded["groups"]:
        if any(f == FIELD_FEE_ON and op == OP_EQ and v == 0 for f, op, v in g["constraints"]):
            continue
        eq = [v for f, op, v in g["constraints"] if f == FIELD_FEE_BPS and op == OP_EQ]
        lte = [v for f, op, v in g["constraints"] if f == FIELD_FEE_BPS and op == OP_LTE]
        if eq:
            out.add(int(eq[0]))
        elif lte:
            out.add(int(min(lte)))
    return sorted(out)


def read_curve_rule(platform_config: str, config_id: str, log: Log, get=None, now=None) -> Optional[dict]:
    """The program's own on-chain launch settings for one platform account and global config (the team's R1: the
    standard comes from here, read each time, never typed in): the account derived with the published seed, read, and
    trusted only if the LaunchLab program owns it, it names that platform and config back, and it decodes whole.
    Returns {"address", "allowed_bps", "max_bps", "groups", "words"} or None when there is no such account or it does
    not verify (then the observed route may stand in). Cached an hour a process."""
    now = now if now is not None else time.time()
    key = (platform_config, config_id)
    hit = _CURVE_RULE.get(key)
    if hit and now - hit[1] < STANDARD_SECONDS:
        return hit[0]
    get = get or account_raw
    addr = pda([CURVE_RULE_SEED, b58d(platform_config), b58d(config_id)], LAUNCHLAB)
    out = None
    try:
        raw, owner, slot = get(addr)
        if raw is None:
            words = "no curve-rule account on chain for this platform and config"
        elif owner != LAUNCHLAB:
            words = f"the curve-rule account is owned by {owner}, not the LaunchLab program"
        else:
            d = decode_curve_rule(raw)
            if d["platform_id"] != platform_config or d["config_id"] != config_id:
                words = "the curve-rule account names another platform or config: not trusted"
            else:
                allowed = allowed_fee_bps(d)
                out = {"address": addr, "allowed_bps": allowed, "max_bps": max(allowed) if allowed else None, "groups": len(d["groups"]), "slot": slot,
                       "words": (f"the program's settings allow " + ", ".join(f"{v} bps" for v in allowed) + f" ({len(d['groups'])} rule groups; the highest is the standard)") if allowed else
                                f"the program's settings keep no transfer-fee rate ({len(d['groups'])} rule groups)"}
                words = out["words"]
    except Exception as e:
        words = f"the curve-rule account could not be read or decoded ({type(e).__name__}: {e})"
    log.add("rewards program settings (curve-rule account)", out["allowed_bps"] if out else None, "bps", f"{addr}: {words} (getAccountInfo, Raydium's published layout)")
    if out is not None or "could not be read" not in words:
        _CURVE_RULE[key] = (out, now)
    return out



def program_standard(program: str, log: Log, sample=None, read=None, pool=None, platform=None, now=None, pool_state=None, rule=None) -> dict:
    """A launchpad rewards program's standard transfer fee. The program's own on-chain settings come first
    where it keeps one: Stonk.fun's reward curve-rule account (a LaunchLab account its settings name) holds its rates,
    and reading it by Raydium's published layout is the next step; until then this is the OBSERVED standard: the rate the
    program's own newest VERIFIED reward launches agree on (each mint read on chain for its fee; each coin's pool read
    and its platform account verified as that program's reward mode; the launchpad's keyless list says only which mints
    to read). One standard only when every verified launch carries the same rate; any disagreement is "standard
    unknown", with the rates seen in the receipt. Cached an hour a process. Returns {"standard_bps": int | None,
    "rates_bps": [...], "verified": n, "kind": "observed standard", "words"}."""
    now = now if now is not None else time.time()
    stem = PROGRAM_STEM.get(program)
    if stem is None:
        return {"standard_bps": None, "rates_bps": [], "verified": 0, "kind": "observed standard", "basis": None, "mints": [], "words": f"no reader of {program}'s standard yet"}
    if pool_state and pool_state.get("platform_config") and pool_state.get("config_id"):     # R1: the program's own on-chain settings first
        rule = (rule or read_curve_rule)(pool_state["platform_config"], pool_state["config_id"], log, now=now)
        if rule and rule.get("max_bps") is not None:
            out = {"standard_bps": rule["max_bps"], "rates_bps": rule["allowed_bps"], "verified": None, "kind": "on-chain settings", "basis": "settings", "mints": [],
                   "words": f"standard {rule['max_bps']} bps, the highest the program's own on-chain settings allow ({rule['words']})"}
            log.add("rewards program standard rate", rule["max_bps"], "bps", f"{out['words']}; curve-rule account {rule['address']} (getAccountInfo, Raydium's published layout)")
            return out
    hit = _STANDARD.get(program)
    if hit and now - hit[1] < STANDARD_SECONDS:
        return hit[0]
    read, pool, platform = read or read_mint, pool or find_launchlab_pool, platform or launchlab_platform
    try:
        mints = (sample() if sample else _reward_sample()) or []
    except Exception:
        mints = []
    rates, first = {}, None
    for m in mints[:STANDARD_SAMPLE]:
        quiet = Log()
        pl = pool(m, quiet)
        pf = platform(pl["platform_config"], quiet) if pl else None
        if not (pf and pf.get("verified") and pf.get("mode") == "reward mode" and stem in str(pf.get("name", "")).lower()):
            continue                                        # not a verified launch of this program: its rate says nothing about the program
        mi = read(m, quiet)
        bps = mi.get("transfer_fee_bps") if mi else None
        if isinstance(bps, int) and not isinstance(bps, bool):
            rates[m] = bps
            first = first or m
    seen = sorted(set(rates.values()))
    if not rates:
        words = f"none of the program's newest launches could be verified and read ({len(mints[:STANDARD_SAMPLE])} listed): standard unknown"
        std = None
    elif len(seen) == 1:
        std = seen[0]
        words = f"observed standard {std} bps: all {len(rates)} of the program's newest verified reward launches carry it"
    else:
        std = None
        words = f"standard unknown: the program's {len(rates)} newest verified reward launches carry " + ", ".join(f"{v} bps" for v in seen) + " (its settings may allow more than one rate; which is the standard is not settled)"
    out = {"standard_bps": std, "rates_bps": seen, "verified": len(rates), "kind": "observed standard", "basis": "observed" if std is not None else None,
           "mints": list(rates)[:10], "words": words}
    _STANDARD[program] = (out, now)
    log.add("rewards program standard rate", std, "bps", f"{words}; each mint getAccountInfo (Token-2022 transfer-fee extension), each pool and platform account verified; first sampled mint {first}")
    return out


def _reward_sample() -> list:
    sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "scanner"))
    import stonkfun
    return stonkfun.reward_mints()


def rewards_program(m: Optional[dict], platform: Optional[dict], log: Log, sample=None, read=None, pool=None, plat=None, pool_state=None, rule=None) -> Optional[dict]:
    """a design decision, the reads: the coin's transfer fee and what kind of fee it is. Shown always;
    what it does to the score is the rules' business (v1.16). `m` is read_mint's dict (None: the mint could not be read,
    so nothing is known), `platform` launchlab_platform's dict for the coin's own pool, or None. Returns
    {"fee_bps", "pct", "fee_kind": "none" | "rewards_standard" | "outside_norm" | "standard_unknown", "program",
    "standard_pct", "rates_pct", "authority", "words"}: a fee is a rewards program's only when the withheld-fee
    authority is a verified launchpad wallet AND the coin's pool is that launchpad's verified reward mode; at or below
    the program's standard it is "rewards_standard" (B1), above it "outside_norm" with the program and its standard,
    and with the standard unknown "standard_unknown" (U1: never scored as above until it is known)."""
    if not m:
        return None
    bps = m.get("transfer_fee_bps")
    fee = int(bps) if isinstance(bps, int) and not isinstance(bps, bool) else 0      # a mint read with no fee extension has no fee
    auth = m.get("withdraw_withheld_authority")
    out = {"fee_bps": fee, "pct": fee / 100, "fee_kind": "none", "program": None, "standard_pct": None, "standard_basis": None, "standard_links": None,
           "rates_pct": None, "authority": auth, "words": "no transfer fee"}
    log.add("transfer fee", fee, "bps", "getAccountInfo (Token-2022 transfer-fee extension; none means no fee)")
    if fee == 0:
        return out
    is_program = (auth in VERIFIED_LAUNCHPAD_WALLETS and platform and platform.get("verified") and platform.get("mode") == "reward mode"
                  and any(stem in str(platform.get("name", "")).lower() for stem in PROGRAM_STEM.values()))
    if not is_program:
        who = "a verified launchpad wallet, but the pool is not that program's reward mode" if auth in VERIFIED_LAUNCHPAD_WALLETS else f"withheld-fee authority {auth}"
        out["fee_kind"], out["words"] = "outside_norm", f"{fee / 100:g}%, not a launchpad rewards fee ({who})"
        log.add("rewards program", "none", "text", out["words"])
        return out
    program = f"{platform['name']} reward mode"
    std = program_standard(program, log, sample=sample, read=read, pool=pool, platform=plat, pool_state=pool_state, rule=rule)
    out["program"], out["rates_pct"] = program, [v / 100 for v in std["rates_bps"]] or None
    if std["standard_bps"] is None:
        out["fee_kind"] = "standard_unknown"
        out["words"] = f"{fee / 100:g}%, {program}'s rewards fee; the program's standard was not read ({std['words']})"
    elif fee <= std["standard_bps"]:
        out["fee_kind"], out["standard_pct"] = "rewards_standard", std["standard_bps"] / 100
        out["standard_basis"], out["standard_links"] = std["basis"], ([f"https://solscan.io/token/{m}" for m in std["mints"]] or None)
        out["words"] = f"{fee / 100:g}%, {program}'s rewards fee at or below its standard {std['standard_bps'] / 100:g}% ({std['kind']})"
    else:
        out["fee_kind"], out["standard_pct"] = "outside_norm", std["standard_bps"] / 100
        out["standard_basis"], out["standard_links"] = std["basis"], ([f"https://solscan.io/token/{m}" for m in std["mints"]] or None)
        out["words"] = f"{fee / 100:g}%, above {program}'s standard {std['standard_bps'] / 100:g}%"
    log.add("rewards program", program, "text", out["words"] + f"; withheld-fee authority {auth}, a verified launchpad wallet; the pool's platform verified")
    return out


# ------------------------------------------------------------------ the reason behind a fee outside the norm
FEE_REASON_MIN_RECIPIENTS = 10      # starting value: "many holders" paid by the collector = at least this many distinct wallets
FEE_REASON_POWERS = ("mint", "freeze", "pause", "permanent_delegate", "transfer_fee_config")   # the five the rule names
POWER_WORDS = {"mint": "mint", "freeze": "freeze", "pause": "pause", "permanent_delegate": "permanent delegate", "transfer_fee_config": "fee-rate control"}
HOLDER_WORDS = {"dev_or_linked": "the dev", "unexplained_wallet": "an unexplained wallet"}
POWER_CODES = {"mint": "mint", "freeze": "freeze", "pause": "pause", "permanent_delegate": "permanent_delegate", "transfer_fee_config": "fee_rate_control"}
HOLDER_CODES = {"dev_or_linked": "dev", "unexplained_wallet": "unexplained"}


def held_power_items(holders: Optional[dict]) -> tuple:
    """T1: the held powers of the five, in the rule's order, as (words, coded items):
    "mint held by the dev" and {"kind": "power_held", "power": "mint", "holder": "dev"}; the holder "dev" or "unexplained"."""
    words, items = [], []
    for k in FEE_REASON_POWERS:
        v = (holders or {}).get(k)
        name = str(getattr(v, "value", v)) if v is not None else None
        if name and name not in _SAFE_HOLDERS:
            words.append(f"{POWER_WORDS[k]} held by {HOLDER_WORDS.get(name, 'an unexplained wallet')}")
            items.append({"kind": "power_held", "power": POWER_CODES[k], "holder": HOLDER_CODES.get(name, "unexplained")})
    return words, items
FEE_COLLECTOR_PAGES = 3             # the collector's newest transactions read: pages of 100
_SAFE_HOLDERS = ("renounced", "verified_launchpad_program", "verified_launchpad_wallet")


def _wallet(addr) -> bool:
    """A person's wallet (on the ed25519 curve), not a pool, curve or other program account."""
    try:
        return isinstance(addr, str) and oc(b58d(addr))
    except Exception:
        return False


ATA_PROGRAM = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL"


def _amount(x) -> float:
    try:
        return float(x.get("tokenAmount") if isinstance(x, dict) else x) or 0.0
    except (TypeError, ValueError):
        return 0.0


def _changes(t: dict, mint: str) -> dict:
    """{owner: change of this mint in coins} from the transaction's token-balance changes (both shapes carry them)."""
    out = {}
    for acc in t.get("accountData") or []:
        for b in (acc.get("tokenBalanceChanges") or []) if isinstance(acc, dict) else []:
            if isinstance(b, dict) and b.get("mint") == mint and b.get("userAccount"):
                r = b.get("rawTokenAmount") or {}
                try:
                    out[b["userAccount"]] = out.get(b["userAccount"], 0.0) + int(r.get("tokenAmount", 0)) / 10 ** int(r.get("decimals", 0))
                except (TypeError, ValueError):
                    pass
    return out


def pre_balance_in_tx(sig: str, wallet: str, mint: str):
    """The wallet's balance of the coin BEFORE the transaction, from the chain's own record of it (preTokenBalances): a wallet
    whose coin account appears only after the transaction had none before (0.0); one in neither is unknown (None)."""
    try:
        from solana_rpc import fetch_raw
        t = (fetch_raw([sig]) or [None])[0]
        meta = t.get("meta") if isinstance(t, dict) else None
        if not isinstance(meta, dict):
            return None
        pre = [b for b in meta.get("preTokenBalances") or [] if b.get("owner") == wallet and b.get("mint") == mint]
        post = [b for b in meta.get("postTokenBalances") or [] if b.get("owner") == wallet and b.get("mint") == mint]
        if pre:
            return sum(int(b["uiTokenAmount"]["amount"]) / 10 ** int(b["uiTokenAmount"]["decimals"]) for b in pre)
        return 0.0 if post else None
    except Exception:
        return None


def balance_before(wallet: str, ts, mint: str):
    """The wallet's balance of the coin just before time `ts`, the cheapest way the chain allows: the wallet's coin account's
    newest transaction before `ts` (its signatures, two pages at most) and that transaction's post-balance for the account.
    0.0 when the account had no transaction before `ts` and its whole history was read; None when it could not be settled."""
    try:
        from solana_rpc import sigs_desc, fetch_raw
        ata = pda([b58d(wallet), b58d(TOKEN_2022), b58d(mint)], ATA_PROGRAM)
        items, end = sigs_desc(ata, max_pages=2)
        if items is None:
            return None
        older = [i for i in items if i.get("blockTime") and ts and i["blockTime"] < ts and not i.get("err")]
        if not older:
            return 0.0 if end else None
        t = (fetch_raw([older[0]["signature"]]) or [None])[0]
        meta = t.get("meta") if isinstance(t, dict) else None
        if not isinstance(meta, dict):
            return None
        post = [b for b in meta.get("postTokenBalances") or [] if b.get("owner") == wallet and b.get("mint") == mint]
        return sum(int(b["uiTokenAmount"]["amount"]) / 10 ** int(b["uiTokenAmount"]["decimals"]) for b in post) if post else None
    except Exception:
        return None


WITHDRAW_TYPES = ("withdrawWithheldTokensFromMint", "withdrawWithheldTokensFromAccounts", "harvestWithheldTokensToMint")
MINT_TYPES = ("mintTo", "mintToChecked")
TRANSFER_FEE_EXT, WITHDRAW_SUBS = 26, (2, 3, 4)   # Token-2022's TransferFeeExtension instruction and its withdraw-from-mint / from-accounts / harvest sub-instructions
MINT_TO, MINT_TO_CHECKED = 7, 14                  # Token-2022's MintTo and MintToChecked instructions (the mint is their first account)
_B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"


def _b58_bytes(text: str) -> bytes:
    """Base58 to bytes of any length (instruction data; `b58d` pads to an address's 32 bytes)."""
    n = 0
    for c in text:
        n = n * 58 + _B58.index(c)
    body = n.to_bytes((n.bit_length() + 7) // 8, "big") if n else b""
    return bytes(len(text) - len(text.lstrip("1"))) + body


def _instructions(t: dict):
    """Every instruction of the transaction, inner ones included, in either shape (Helius's enhanced: programId, accounts, data,
    innerInstructions; the free rebuild: programId, type, mint, amount)."""
    for i in t.get("instructions") or []:
        if isinstance(i, dict):
            yield i
            for j in i.get("innerInstructions") or []:
                if isinstance(j, dict):
                    yield j


def _token2022_kind(i: dict, mint: str):
    """What a Token-2022 instruction is, for the fee trace: "withdraw" (withdraw-withheld or harvest FOR THIS MINT), "mint" (MintTo
    or MintToChecked OF THIS MINT), "other" (any other instruction, or one of these for another mint), or None when it cannot be
    decoded (no parsed type and no readable bytes): the fail-safe (M1c), the transaction then never counts."""
    typ = i.get("type")
    if typ:
        if typ in WITHDRAW_TYPES:
            return "withdraw" if i.get("mint") in (None, mint) else "other"
        if typ in MINT_TYPES:
            return "mint" if i.get("mint") in (None, mint) else "other"
        return "other"
    data = i.get("data")
    if not isinstance(data, str) or not data:
        return None
    try:
        b = _b58_bytes(data)
    except Exception:
        return None
    if not b:
        return None
    first = (i.get("accounts") or [None])[0]
    if b[0] == TRANSFER_FEE_EXT and len(b) >= 2 and b[1] in WITHDRAW_SUBS:
        return "withdraw" if first in (None, mint) else "other"
    if b[0] in (MINT_TO, MINT_TO_CHECKED):
        return "mint" if first in (None, mint) else "other"
    return "other"


def fee_withdrawal_in(t: dict, mint: str) -> bool:
    """True when the transaction is a withdrawal of this mint's withheld fees: it
    carries a Token-2022 withdraw-withheld (from the mint or from accounts) or harvest instruction FOR THIS MINT, by the chain's
    parsed type when the shape has it, else by the instruction's own bytes with the mint as its first account; it carries NO
    instruction that mints this coin (MintTo or MintToChecked, top-level or inner, parsed or bytes) and lists no transfer of it
    from nobody (a mint, as Helius lists one); and every Token-2022 instruction in it could be decoded (one that cannot makes
    the transaction not count: fail safe)."""
    found = False
    for i in _instructions(t):
        if i.get("programId") != TOKEN_2022 and i.get("program") != "spl-token-2022":
            continue
        kind = _token2022_kind(i, mint)
        if kind is None or kind == "mint":
            return False
        found = found or kind == "withdraw"
    if any(isinstance(x, dict) and x.get("mint") == mint and not x.get("fromUserAccount") and x.get("toUserAccount") for x in t.get("tokenTransfers") or []):
        return False                                            # a transfer from nobody is a mint, as Helius lists one
    return found


def collector_payouts(txs: list, collector: str, mint: str, quote_mints=(), dev_wallets=(), need: int = FEE_REASON_MIN_RECIPIENTS,
                      pre_balance=None, before=None, pool_accounts=(), decimals: int = 6) -> dict:
    """What the collector paid out OF THIS COIN'S WITHHELD FEES, from
    its own transactions walked oldest first (Helius's parsed shape or the free rebuild of it; both carry balance changes,
    transfers and instructions).
    1. WITHDRAWALS (M1, M1c): the collector's fee coins are only those that arrive through Token-2022's withdraw-withheld (or
       harvest) instructions for this mint (`fee_withdrawal_in`), in a transaction that mints none of this coin and whose
       Token-2022 instructions all decode: the rise of the collector's balance less every fall of this coin in any other balance
       in that transaction (withheld fees sit outside every balance, so that is the fall in withheld amounts the transaction
       shows). A transaction with no such instruction brings no fee coins, whatever arrives.
    2. A COIN PAYOUT is the coin itself sent from the collector to a person's wallet, out of the traced coins only.
    3. A SALE (M3) is the coin sent from the collector into this coin's own verified pool (`pool_accounts`: the pool or curve and
       its vaults); the SOL or quote counted is that pool's own output in the same transaction (its accounts' SOL or quote going
       down, at most what the collector received), for the traced share of the coins sold, at most their amount. A transfer to any
       other program account is not a sale. A SOL or QUOTE PAYOUT is SOL/quote sent from the collector to a person's wallet, out
       of that budget only; SOL from anywhere else never counts.
    4. HELD WHEN PAID: the recipient's balance of the coin BEFORE the payout: for a coin payout the payout transaction's own
       pre-balances (`pre_balance(sig, wallet)`), for a SOL/quote payout the newest balance before it (`before(wallet, ts)`);
       0 = not a holder; None = could not be read, left out, never guessed. A recipient in `dev_wallets` is recorded as a
       dev-group payout and never counts as a holder.
    5. STOP AT `need`: once that many holders outside the dev group qualify, nothing more is read.
    Returns {"holders": {wallet: payouts}, "dev_payouts": {wallet: payouts}, "withdrawn": coins, "traced_left": coins,
    "not_holding": n, "unread": n, "other": n (moves that were not this coin's fees), "signatures": [up to 10], "stopped": bool}."""
    quote = set(q for q in (quote_mints or ()) if isinstance(q, str))
    devs = set(w for w in (dev_wallets or ()) if isinstance(w, str))
    pools = set(a for a in (pool_accounts or ()) if isinstance(a, str))
    holders, dev_pay, sigs = {}, {}, []
    not_holding = unread = other = 0
    withdrawn = traced = 0.0
    budget = {"SOL": 0, **{q: 0.0 for q in quote}}           # SOL in whole lamports (no drift); the quote coin in its own units
    pre_balance = pre_balance or (lambda sig, w: pre_balance_in_tx(sig, w, mint))
    before = before or (lambda w, ts: balance_before(w, ts, mint))
    stopped = False
    ordered = sorted((t for t in txs or [] if isinstance(t, dict)), key=lambda t: (t.get("timestamp") or 0, t.get("slot") or 0))
    EPS = 1e-9
    def in_pool(x, *keys):
        return any(x.get(k) in pools for k in keys if x.get(k))
    for t in ordered:
        if len(holders) >= need:
            stopped = True
            break
        tt = [x for x in (t.get("tokenTransfers") or []) if isinstance(x, dict)]
        nt = [x for x in (t.get("nativeTransfers") or []) if isinstance(x, dict)]
        acc = [a for a in (t.get("accountData") or []) if isinstance(a, dict)]
        ch = _changes(t, mint)
        # 1. withdrawals of withheld fees: only through the withdraw-withheld instruction; the rise less transfers and mints in
        rise = ch.get(collector, 0.0)
        if rise > EPS and fee_withdrawal_in(t, mint):
            # M1c: capped by the fall in withheld amounts the transaction shows: a withheld fee sits outside every balance, so the
            # withdrawn coins are the collector's rise less every fall of this coin in any other balance in the same transaction
            falls = sum(-v for w, v in ch.items() if w != collector and v < 0)
            got = max(0.0, rise - falls)
            withdrawn += got; traced += got
        # 3. a sale: the coin into this coin's own pool, the pool's own SOL or quote output back; only the traced share counts
        sold = sum(_amount(x) for x in tt if x.get("fromUserAccount") == collector and x.get("mint") == mint and in_pool(x, "toTokenAccount", "toUserAccount"))
        if sold > EPS and pools:
            share = min(sold, traced) / sold
            traced -= min(sold, traced)
            coll_sol = next((int(a["nativeBalanceChange"]) for a in acc if a.get("account") == collector and isinstance(a.get("nativeBalanceChange"), (int, float)) and a["nativeBalanceChange"] > 0), 0)
            pool_sol = sum(-int(a["nativeBalanceChange"]) for a in acc if a.get("account") in pools and isinstance(a.get("nativeBalanceChange"), (int, float)) and a["nativeBalanceChange"] < 0)
            pool_sol += sum(int(_amount(x) * 1e9) for x in tt if x.get("mint") == WSOL and x.get("toUserAccount") == collector and in_pool(x, "fromTokenAccount", "fromUserAccount"))
            budget["SOL"] += int(min(coll_sol, pool_sol) * share) if coll_sol and pool_sol else 0
            for q in quote:
                coll_q = sum(_amount(x) for x in tt if x.get("mint") == q and x.get("toUserAccount") == collector and in_pool(x, "fromTokenAccount", "fromUserAccount"))
                pool_q = 0.0
                for a in acc:
                    for b in a.get("tokenBalanceChanges") or []:
                        if isinstance(b, dict) and b.get("mint") == q and (b.get("tokenAccount") in pools or b.get("userAccount") in pools):
                            try:
                                d = int((b.get("rawTokenAmount") or {}).get("tokenAmount", 0)) / 10 ** int((b.get("rawTokenAmount") or {}).get("decimals", 0))
                            except (TypeError, ValueError):
                                d = 0.0
                            pool_q += -d if d < 0 else 0.0
                budget[q] += min(coll_q, pool_q if pool_q else coll_q) * share
        hit = False
        def take(dst, held):
            nonlocal not_holding, unread, hit
            if dst in devs:
                dev_pay[dst] = dev_pay.get(dst, 0) + 1
                return
            if held is None:
                unread += 1
            elif held > EPS:
                holders[dst] = holders.get(dst, 0) + 1; hit = True
            else:
                not_holding += 1
        # 2. coin payouts out of the traced coins
        for x in tt:
            if x.get("fromUserAccount") != collector or x.get("toUserAccount") in (None, "", collector) or not _wallet(x["toUserAccount"]):
                continue
            dst, mt, amt = x["toUserAccount"], x.get("mint"), _amount(x)
            if mt == mint:
                if amt <= 0 or traced + EPS < amt:
                    other += 1; continue                    # more than the fees withdrawn: not fee coins
                traced -= amt
                if len(holders) >= need:
                    continue
                take(dst, pre_balance(t.get("signature"), dst) if dst not in devs else 1.0)
            elif mt in quote:
                if amt <= 0 or budget[mt] + EPS < amt:
                    other += 1; continue
                budget[mt] -= amt
                if len(holders) >= need:
                    continue
                take(dst, before(dst, t.get("timestamp")) if dst not in devs else 1.0)
            else:
                other += 1
        for x in nt:
            if x.get("fromUserAccount") != collector or x.get("toUserAccount") in (None, "", collector) or not _wallet(x["toUserAccount"]):
                continue
            dst, amt = x["toUserAccount"], int(x.get("amount") or 0)
            if amt <= 0 or budget["SOL"] < amt:
                other += 1; continue                        # SOL not traced to a sale of this coin's fees through its pool
            budget["SOL"] -= amt
            if len(holders) >= need:
                continue
            take(dst, before(dst, t.get("timestamp")) if dst not in devs else 1.0)
        if hit and len(sigs) < 10 and t.get("signature"):
            sigs.append(t["signature"])
    return {"holders": holders, "dev_payouts": dev_pay, "withdrawn": round(withdrawn, 9), "traced_left": round(traced, 9),
            "not_holding": not_holding, "unread": unread, "other": other, "signatures": sigs, "stopped": stopped or len(holders) >= need,
            "budget_left": {k: (v / 1e9 if k == "SOL" else round(v, 9)) for k, v in budget.items() if v}}


def fee_reason(fee: Optional[dict], m: Optional[dict], holders: Optional[dict], dev_wallets, log: Log, history=None, mint: Optional[str] = None, quote_mints=(), pre_balance=None, before=None, pool_accounts=()) -> dict:
    """which case a coin's transfer fee falls under, read on chain.
    `fee` is rewards_program's dict (None: the mint was not read), `holders` the contract powers -> holder class (strings or
    the engine's Holder values), `dev_wallets` the dev, the dev team and the linked wallets, `history(address)` the collector's
    newest transactions as (txs, reached_start) (default: Helius's history, free when Helius is closed), `mint` this coin,
    `quote_mints` its pool's quote coin(s), `pool_accounts` the coin's own verified pool or curve and its vaults (M3: the only place a
    sale counts), `pre_balance(sig, wallet)` and `before(wallet, ts)` the recipient's balance of the
    coin before a payout (defaults: the chain's own pre-balances and the account's newest earlier transaction).
    H1 and H2 as the team ruled (2026-10-17): a payout is THIS coin's withheld fees the collector withdrew, sent as the coin or
    as SOL/quote from selling exactly those fees, to wallets that held the coin before, outside the dev group; reading stops
    once FEE_REASON_MIN_RECIPIENTS qualify (`collector_payouts`). Returns
    {"case": "none" | "rewards_standard" | "standard_unknown" | "reason_found" | "no_reason" | "not_checked",
     "recipients": n, "dev_payouts": {wallet: transfers}, "powers_held": [...], "every_power_renounced": bool,
     "signatures": [...], "why": [plain words, one per finding], "items": [the same findings as the site's coded items (T1)], "words": ...}. The cases: a rewards program's fee at or below its standard is
    shown and never scored (1; U1's standard_unknown likewise); any other fee has a reason only when BOTH hold (2): the
    collector has paid the fees out to many holders (at least FEE_REASON_MIN_RECIPIENTS distinct wallets) and to none of the
    dev group, AND the five named powers are renounced or a verified launchpad's; a collector history that could not be read
    is "not checked yet" (5): no reason, checked again at the follow-up score. Payouts to the dev group are a receipt and
    count as no reason. A receipt on every outcome."""
    out = {"case": "none", "recipients": 0, "dev_payouts": {}, "powers_held": [], "every_power_renounced": True, "signatures": [], "why": [], "items": [], "words": "no transfer fee"}
    if not fee or not m or not fee.get("fee_bps"):
        log.add("fee reason", "none", "case", "no transfer fee, or the mint was not read")
        return out
    held_all = [k for k, v in (holders or {}).items() if str(getattr(v, "value", v)) not in _SAFE_HOLDERS]
    out["powers_held"] = sorted(k for k in held_all if k in FEE_REASON_POWERS)
    out["every_power_renounced"] = not out["powers_held"]      # the team's reading (b), 2026-10-17: the ceiling tier reads the same five powers as the reason; metadata edit is not counted
    if fee.get("fee_kind") in ("rewards_standard", "standard_unknown"):
        out["case"] = fee["fee_kind"]
        out["words"] = ("a verified rewards program's fee at or below its standard: shown, never scored" if fee["fee_kind"] == "rewards_standard"
                        else "a verified rewards program's fee whose standard was not read: shown, not scored until it is (U1)")
        log.add("fee reason", out["case"], "case", out["words"])
        return out
    collector = m.get("withdraw_withheld_authority")
    if not collector:
        pw, pi = held_power_items(holders)
        out["case"], out["why"], out["items"] = "no_reason", pw + ["no wallet can withdraw the withheld fees, so they are paid to nobody"], pi + [{"kind": "no_withdraw_authority"}]
        out["words"] = "no reason found: " + "; ".join(out["why"])
        log.add("fee reason", "no_reason", "case", out["words"] + f" (getAccountInfo {m.get('mint', '')}: withdrawWithheldAuthority empty)")
        return out
    try:
        if history is None:
            from dev_history import Helius
            history = lambda a: Helius().history(a, max_pages=FEE_COLLECTOR_PAGES)
        txs, reached = history(collector)
    except Exception as e:
        txs, reached = None, False
    if txs is None or (not txs and not reached):
        out["case"] = "not_checked"
        out["words"] = f"reason not checked yet: the fee collector's transactions could not be read ({collector})"
        log.add("fee reason", "not_checked", "case", out["words"] + "; counts as no reason found; checked again at the follow-up score")
        return out
    mint = mint or m.get("mint")
    pay = collector_payouts(txs, collector, mint, quote_mints, dev_wallets, FEE_REASON_MIN_RECIPIENTS, pre_balance=pre_balance, before=before,
                            pool_accounts=pool_accounts, decimals=int(m.get("decimals") or 0))
    out["dev_payouts"] = pay["dev_payouts"]
    out["recipients"], out["signatures"] = len(pay["holders"]), pay["signatures"]         # holders outside the dev group, counted once each
    why, items = held_power_items(holders)                             # T1: held powers first, one short item each, words and coded alike
    if out["dev_payouts"]:
        why.append(f"fees paid to the dev group: {len(out['dev_payouts'])} wallet(s), {sum(out['dev_payouts'].values())} transfer(s)")
        items.append({"kind": "dev_payouts", "wallets": len(out["dev_payouts"]), "transfers": int(sum(out["dev_payouts"].values()))})
        log.add("fees paid to the dev group", out["dev_payouts"], "wallet -> transfers from the fee collector", f"the collector's transactions ({collector}; {len(txs)} read)")
    if out["recipients"] < FEE_REASON_MIN_RECIPIENTS:
        why.append(f"fees reached {out['recipients']} holder(s) outside the dev group, fewer than {FEE_REASON_MIN_RECIPIENTS}")
        items.append({"kind": "holders_reached", "holders": int(out["recipients"])})            # no starting value in the coded item
        if pay["not_holding"]:
            why.append(f"{pay['not_holding']} paid wallet(s) did not hold the coin"); items.append({"kind": "paid_not_holding", "wallets": int(pay["not_holding"])})
        if pay["unread"]:
            why.append(f"{pay['unread']} paid wallet(s) could not be read"); items.append({"kind": "paid_unread", "wallets": int(pay["unread"])})
        if pay["other"]:
            why.append(f"{pay['other']} transfer(s) not traced to this coin's fees"); items.append({"kind": "not_traced", "transfers": int(pay["other"])})
        if pay["withdrawn"]:
            why.append(f"{pay['withdrawn']:g} of the coin withdrawn as withheld fees"); items.append({"kind": "withdrawn", "amount": pay["withdrawn"]})
        else:
            why.append("no withdrawal of withheld fees seen"); items.append({"kind": "no_withdrawal_seen"})
    src = f"the collector's transactions ({collector}; {len(txs)} read{', the whole history' if reached else ''}{', stopped at ' + str(FEE_REASON_MIN_RECIPIENTS) + ' holders' if pay['stopped'] else ''}; {pay['withdrawn']:g} of the coin withdrawn as withheld fees; each holder's balance before the payout from the chain; getAccountInfo for the powers)"
    if why:
        out["case"], out["why"], out["items"] = "no_reason", why, items
        out["words"] = "no reason found: " + "; ".join(why)
    else:
        out["case"] = "reason_found"
        out["words"] = f"reason found: this coin's fees reached {out['recipients']} holders outside the dev group; the five powers renounced or a verified launchpad's"
    log.add("fee reason", out["case"], "case", out["words"] + "; " + src)
    return out


def find_launchlab_pool(mint: str, log: Log) -> Optional[dict]:
    """A LaunchLab coin's pool (StonkFun, LetsBonk, ...) when the scanner hands over no pointer (the launch index is gone,
    a design decision): Raydium's own LaunchLab record for the mint names the pool (an approved source, keyless; one read), and
    the pool account is then read and verified on chain exactly as a pointer from the scanner is (`read_launchlab_pool`:
    the LaunchLab program owns it and it names this mint). Nothing from the record is used but the pool's address.
    None when the record is missing, names no pool, or the chain disagrees; the caller then says so in its notes."""
    r = http_json(LAUNCHLAB_API + mint, tries=2)
    rows = (r.get("data") or {}).get("rows") if isinstance(r, dict) and r.get("success") else None
    for row in rows or []:
        pid = row.get("poolId") if isinstance(row, dict) else None
        if isinstance(pid, str) and row.get("mint") == mint:
            d = read_launchlab_pool(pid, mint, log)
            if d is not None:
                log.add("LaunchLab pool (Raydium's record, verified on chain)", pid, "address", LAUNCHLAB_API.split("?")[0])
                return d
    return None


def find_cpmm_pool(mint: str, log: Log) -> Optional[dict]:
    """Pointer from Raydium's public API, then verified on chain."""
    r = http_json(f"https://api-v3.raydium.io/pools/info/mint?mint1={mint}&poolType=all&poolSortField=default&sortType=desc&pageSize=10&page=1")
    cands = [p["id"] for p in (r or {}).get("data", {}).get("data", []) if p.get("programId") == CPMM]
    for pid in cands:
        raw, owner, slot = account_raw(pid)
        if raw is None or owner != CPMM:
            continue
        f = [b58e(raw[8 + 32 * i:8 + 32 * (i + 1)]) for i in range(10)]
        if mint not in (f[5], f[6]):
            continue
        d = {"address": pid, "vault0": f[2], "vault1": f[3], "lp_mint": f[4], "mint0": f[5], "mint1": f[6],
             "fees0": _u64(raw, 341) + _u64(raw, 357), "fees1": _u64(raw, 349) + _u64(raw, 365)}
        log.add("Raydium CPMM pool (API pointer, verified on chain)", pid, "address", f"getAccountInfo {pid}", slot)
        return d
    return None


# ------------------------------------------------------------------ prices
_QUOTE_CACHE: dict = {}           # quote mint -> (read time, price): one Jupiter read a minute a mint per worker
QUOTE_CACHE_SECONDS = 60


def quote_usd(quote_mint: str, log: Log) -> Optional[float]:
    """The quote asset's dollar price from Jupiter's gateway `api.jup.ag` (the old lite-api is being phased
    out), with `x-api-key` when the engine's .env has JUPITER_API, keyless otherwise. A price read in the last minute
    is used again (the engine's agreed share of Jupiter's one limit); its receipt says when it was read."""
    hit = _QUOTE_CACHE.get(quote_mint)
    if hit and time.time() - hit[0] < QUOTE_CACHE_SECONDS:
        p = hit[1]
    else:
        from shown_facts import jupiter_headers
        r = http_json(f"https://api.jup.ag/price/v3?ids={quote_mint}", headers=jupiter_headers())
        p = (r or {}).get(quote_mint, {}).get("usdPrice")
        if p is None:
            return None
        _QUOTE_CACHE[quote_mint] = (time.time(), p)
    return log.add(f"quote asset price ({quote_mint[:8]}…)", float(p), "USD", "Jupiter price API v3")


def mint_decimals(mint: str) -> Optional[int]:
    v, _ = account_parsed(mint)
    return None if v is None else v["data"]["parsed"]["info"]["decimals"]


# ------------------------------------------------------------------ holdings and LP
def wallet_balance_raw(owner: str, mint: str, log: Log, what: str) -> Optional[int]:
    r = rpc("getTokenAccountsByOwner", [owner, {"mint": mint}, {"encoding": "jsonParsed"}])
    if not isinstance(r, dict) or "ERROR" in r:
        return None
    total = sum(int(a["account"]["data"]["parsed"]["info"]["tokenAmount"]["amount"]) for a in r["value"])
    log.add(what, total, "raw units", f"getTokenAccountsByOwner {owner}", r["context"]["slot"])
    return total


def lp_status(lp_mint: str, total_ever_raw: Optional[int], log: Log) -> Optional[list[tuple[str, float]]]:
    """Share of LP that is burned / held by a verified lock / elsewhere.
    total_ever_raw: LP the pool still counts as issued (pool state); burned = that minus current mint supply."""
    v, slot = account_parsed(lp_mint)
    if v is None:
        return None
    current = int(v["data"]["parsed"]["info"]["supply"])
    log.add("LP tokens currently in existence", current, "raw units", f"getAccountInfo {lp_mint}", slot)
    if total_ever_raw is None:
        if current == 0:
            return [("burned", 1.0)]
        return None
    if total_ever_raw <= 0:
        return None
    burned = max(0, total_ever_raw - current)
    buckets = [("burned", burned / total_ever_raw)] if burned else []
    remaining = current
    for owner in VERIFIED_LOCK_OWNERS:
        held = wallet_balance_raw(owner, lp_mint, log, "LP held by verified lock")
        if held is None:
            return None
        if held:
            buckets.append(("locked_forever", held / total_ever_raw))
            remaining -= held
    if remaining:
        buckets.append(("wallet", remaining / total_ever_raw))
    log.add("LP breakdown", buckets, "share of LP", "derived from the reads above")
    return buckets


# ------------------------------------------------------------------ reward-flow pressure
def reward_flow_24h(pool: str, quote_vault: str, quote_decimals: int, q_usd: Optional[float],
                    log: Log, max_txs: int = 1500) -> tuple[Optional[float], Optional[float]]:
    """(collector sells USD, everyone else's buys USD) over the last 24h, from the pool's own transactions."""
    if q_usd is None:
        return None, None
    cutoff = time.time() - 86400
    sigs, before = [], None
    while True:
        p = {"limit": 1000}
        if before:
            p["before"] = before
        r = rpc("getSignaturesForAddress", [pool, p])
        if not isinstance(r, list):
            return None, None
        fresh = [s for s in r if s.get("blockTime") and s["blockTime"] >= cutoff and not s.get("err")]
        sigs += fresh
        if len(sigs) > max_txs:
            log.add("reward-flow scan", f"over {max_txs} trades in 24h; too busy for the public RPC", "note", "getSignaturesForAddress")
            return None, None
        if len(r) < 1000 or len(fresh) < len(r):
            break
        before = r[-1]["signature"]
    sells = buys = 0.0
    from solana_rpc import fetch_raw
    fetched = fetch_raw([x["signature"] for x in sigs])         # in batches where a batch source is set (step 4)
    for s, t in zip(sigs, fetched):
        if not isinstance(t, dict) or "ERROR" in t or t.get("meta") is None:
            return None, None
        keys = [k["pubkey"] for k in t["transaction"]["message"]["accountKeys"]]
        signer = keys[0]
        pre = {keys[b["accountIndex"]]: int(b["uiTokenAmount"]["amount"]) for b in t["meta"]["preTokenBalances"]}
        post = {keys[b["accountIndex"]]: int(b["uiTokenAmount"]["amount"]) for b in t["meta"]["postTokenBalances"]}
        delta = post.get(quote_vault, 0) - pre.get(quote_vault, 0)
        usd = abs(delta) / 10 ** quote_decimals * q_usd
        if delta < 0 and signer == STONKFUN_COLLECTOR:
            sells += usd
        elif delta > 0 and signer != STONKFUN_COLLECTOR:
            buys += usd
    log.add("collector sells, last 24h", round(sells, 2), "USD", f"{len(sigs)} pool transactions parsed")
    log.add("other buys, last 24h", round(buys, 2), "USD", f"{len(sigs)} pool transactions parsed")
    return sells, buys


# ------------------------------------------------------------------ pump history
PUMP_STD_VIRTUAL_TOKEN_OFFSET = 279_900_000_000_000     # virtual tokens - real tokens, every standard curve
PUMP_STD_INITIAL_REAL_TOKENS = 793_100_000_000_000
PUMP_STD_K = 1_073_000_000_000_000 * 30_000_000_000          # SOL-quoted standard curves


def _scan(address: str, extract, max_txs: int):
    """Run extract(tx) over the address's successful transactions, newest first (fetched in parallel).
    Returns (values, complete_history). Any unreadable transaction makes the result incomplete, never guessed."""
    from solana_rpc import pmap
    sigs, before, complete = [], None, False
    while True:
        p = {"limit": 1000}
        if before:
            p["before"] = before
        r = rpc("getSignaturesForAddress", [address, p])
        if not isinstance(r, list):
            break
        sigs += [x["signature"] for x in r if not x.get("err")]
        if len(sigs) >= max_txs:
            sigs = sigs[:max_txs]
            break
        if len(r) < 1000:
            complete = True
            break
        before = r[-1]["signature"]
    from solana_rpc import fetch_raw
    txs = fetch_raw(sigs)                                        # in batches where a batch source is set (step 4)
    vals = []
    for t in txs:
        if not isinstance(t, dict) or "ERROR" in t or t.get("meta") is None:
            return vals, False
        v = extract(t)
        if v is not None:
            vals.append(v)
    return vals, complete


def _post_lamports(addr):
    def f(t):
        keys = [k["pubkey"] for k in t["transaction"]["message"]["accountKeys"]]
        return t["meta"]["postBalances"][keys.index(addr)] if addr in keys else None
    return f


def _post_token(addr):
    def f(t):
        keys = [k["pubkey"] for k in t["transaction"]["message"]["accountKeys"]]
        for b in t["meta"]["postTokenBalances"]:
            if keys[b["accountIndex"]] == addr:
                return int(b["uiTokenAmount"]["amount"])
        return None
    return f


def _pair_price(base_vault, quote_vault):
    def f(t):
        q, b = _post_token(quote_vault)(t), _post_token(base_vault)(t)
        return q / b if q is not None and b else None
    return f


def pump_history(curve: dict, log: Log, pool: Optional[dict] = None, max_txs: int = 3000):
    """(launch, peak, current, peak_is_complete, quote_at_peak, quote_now) in raw quote per raw token, or None if not readable;
    the last two are the pool's REAL quote money at the peak and now (raw units; the dump measured against the
    pool's own depth), from the curve's own constants on the curve, from the pool's own constant after graduation.
    Standard Pump curves only (mayhem never reaches here)."""
    vt, vs, rt, rs = curve["virtual_token"], curve["virtual_quote"], curve["real_token"], curve["real_quote"]
    vt0 = PUMP_STD_VIRTUAL_TOKEN_OFFSET + PUMP_STD_INITIAL_REAL_TOKENS
    if curve["complete"] and vt == 0 and vs == 0:
        # Pump zeroes a graduated curve. Standard SOL curves all share k (checked on 9 live curves,
        # facts section 7), so launch and graduation prices are rebuilt from it.
        if curve["quote_mint"] != WSOL:
            return None
        vt, vs = PUMP_STD_VIRTUAL_TOKEN_OFFSET, PUMP_STD_K / PUMP_STD_VIRTUAL_TOKEN_OFFSET
        rt = 0
    if vt - rt != PUMP_STD_VIRTUAL_TOKEN_OFFSET:
        return None
    k = vt * vs
    vs0 = k / vt0
    launch = vs0 / vt0
    price_at = lambda real: (vs0 + real) ** 2 / k
    # Peak from Pump.fun's own all-time high: the SOL price of the trade at that moment (checked on chain: the pool /
    # curve balances right after that trade give exactly this price). One request instead of reading every trade.
    current_now = price_at(rs) if pool is None else None
    if pool is not None:
        q, b = token_balance_raw(pool["quote_vault"]), token_balance_raw(pool["base_vault"])
        current_now = (q / b) if (q is not None and b) else None
    if current_now is not None and curve.get("quote_mint", WSOL) == WSOL:
        try:
            import pumpfun_api as PF
            pk, pk_t, why = PF.peak(curve["mint"]) if curve.get("mint") else (None, None, None)
        except Exception:
            pk = None
        if pk and (PF.PEAK_INFO.get(curve["mint"]) or {}).get("cap_usd"):   # SITE's ATH row: the dollars at the peak's own time
            log.add("all-time high (market cap)", PF.PEAK_INFO[curve["mint"]], "USD",
                    "Pump.fun's own all-time high market cap, matched to the trade at that moment")
        if pk:
            peak = max(pk, launch, current_now)
            log.add("pump history (launch, peak, now)", [launch, peak, current_now], "quote per token (raw)",
                    f"peak: {why}; launch from the standard curve; now from the {'pool' if pool else 'curve'} on chain")
            qp, qn = _quote_from_prices(k, vs0, peak, current_now, pool, log)
            return launch, peak, current_now, True, qp, qn
    raw, _, _ = account_raw(curve["address"])
    lam = rpc("getAccountInfo", [curve["address"], {"encoding": "base64"}])["value"]["lamports"]
    rent = lam - rs if not curve["complete"] else lam
    lams, complete = _scan(curve["address"], _post_lamports(curve["address"]), max_txs)
    curve_prices = [price_at(max(0, l - rent)) for l in lams]
    if curve["complete"]:
        curve_prices.append(vs / vt)                       # price at graduation
    peak = max(curve_prices + [launch])
    if pool is None:
        current = price_at(rs)
    else:
        q, b = token_balance_raw(pool["quote_vault"]), token_balance_raw(pool["base_vault"])
        if q is None or not b:
            return None
        current = q / b
        pool_prices, pool_complete = _scan(pool["address"], _pair_price(pool["base_vault"], pool["quote_vault"]), max_txs)
        peak = max([peak] + pool_prices)
        complete = complete and pool_complete
    log.add("pump history (launch, peak, now)", [launch, peak, current], "quote per token (raw)",
            f"{len(lams)} curve trades{' + pool trades' if pool else ''}; full history read: {complete}")
    qp, qn = _quote_from_prices(k, vs0, peak, current, pool, log)
    return launch, peak, current, complete, qp, qn


def _quote_from_prices(k, vs0, peak, current, pool, log):
    """The pool's real quote money at the peak and now, from the prices. On the curve: price = (vs0 + real)^2 / k,
    so real = sqrt(price * k) - vs0. After graduation the pool is a plain constant-product pool: quote = sqrt(price * k_pool),
    with k_pool the pool's own product now."""
    try:
        if pool is None:
            qp, qn = max(0.0, (peak * k) ** 0.5 - vs0), max(0.0, (current * k) ** 0.5 - vs0)
        else:
            q, b = token_balance_raw(pool["quote_vault"]), token_balance_raw(pool["base_vault"])
            if q is None or not b:
                return None, None
            kp = q * b
            qp, qn = (peak * kp) ** 0.5, float(q)
        log.add("pool's real money at the peak and now", [qp, qn], "quote (raw)", "the curve's own constants" if pool is None else "the pool's own constant")
        return qp, qn
    except Exception:
        return None, None


def launchlab_history(ll: dict, log: Log, max_txs: int = 3000):
    vb, vq, rq = ll["virtual_base"], ll["virtual_quote"], ll["real_quote"]
    k = vq * vb
    launch = vq / vb
    vault_now = token_balance_raw(ll["quote_vault"])
    if vault_now is None:
        return None
    fees_now = max(0, vault_now - rq)
    vals, complete = _scan(ll["address"], _post_token(ll["quote_vault"]), max_txs)
    # vault - fees_now is a LOWER bound on real quote at each moment, so the peak is never overstated
    peak = max([launch] + [(vq + max(0, v - fees_now)) ** 2 / k for v in vals])
    current = (vq + rq) ** 2 / k
    log.add("pump history (launch, peak, now)", [launch, peak, current], "quote per token (raw)",
            f"{len(vals)} curve trades; full history read: {complete}; peak is a lower bound (fees excluded)")
    qp, qn = max(0.0, (peak * k) ** 0.5 - vq), float(rq)              # real quote at the peak and now, from the curve's constants
    log.add("pool's real money at the peak and now", [qp, qn], "quote (raw)", "the curve's own constants")
    return launch, peak, current, complete, qp, qn


IPFS_GATEWAYS = ["https://ipfs.filebase.io/ipfs/", "https://ipfs.io/ipfs/", "https://dweb.link/ipfs/", "https://gateway.pinata.cloud/ipfs/",
                 "https://w3s.link/ipfs/", "https://nftstorage.link/ipfs/"]
# the team 2026-10-23: Filebase's free public gateway answered the server and the Mac when ipfs.io and dweb.link answered 429
# (w3s.link and nftstorage.link only redirect to those two); listed first, every gateway paced on its own.


IPFS_TIMEOUT = 8                   # one try per gateway, all at once, a short timeout; a dead gateway costs seconds, never a minute


IPFS_REST_S = 600                  # a gateway that answers 429 or 403 rests this long, for every process on this machine
IPFS_REST_FILE = None              # tests set their own; else PINR_IPFS_REST_FILE or <engine>/index/ipfs_rest.sqlite


def _rest_file() -> str:
    return IPFS_REST_FILE or os.environ.get("PINR_IPFS_REST_FILE") or os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "index", "ipfs_rest.sqlite")


def resting_gateways(now=None) -> set:
    """the team 2026-10-24 (/control: IPFS ~90% errors): the gateway hosts resting now, shared by the scorer's workers and the
    basic pass. An unreadable file rests nothing: a read is never stopped by the record of rests."""
    try:
        c = sqlite3.connect(_rest_file(), timeout=2)
        try:
            c.execute("CREATE TABLE IF NOT EXISTS rest (host TEXT PRIMARY KEY, until REAL)")
            return {h for (h,) in c.execute("SELECT host FROM rest WHERE until > ?", (now or time.time(),))}
        finally:
            c.close()
    except Exception:
        return set()


def rest_gateway(host: str, seconds: float = IPFS_REST_S, now=None) -> None:
    try:
        os.makedirs(os.path.dirname(_rest_file()), exist_ok=True)
        c = sqlite3.connect(_rest_file(), timeout=2)
        try:
            c.execute("CREATE TABLE IF NOT EXISTS rest (host TEXT PRIMARY KEY, until REAL)")
            c.execute("INSERT INTO rest VALUES (?,?) ON CONFLICT(host) DO UPDATE SET until=MAX(until, excluded.until)", (host, (now or time.time()) + seconds))
            c.commit()
        finally:
            c.close()
    except Exception:
        pass


def _gateway_get(url: str):
    """One try, IPFS_TIMEOUT, PINR's own name (never a browser's). A 429 (too many) or 403 (refused) rests the gateway."""
    try:
        r = urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": "PINR-live/1.0 (read-only metadata)"}), timeout=IPFS_TIMEOUT)
        d = json.loads(r.read(2_000_000))
    except urllib.error.HTTPError as e:
        _counted(url, False)
        if e.code in (403, 429):
            rest_gateway(url.split("/")[2])
        return None
    except Exception:
        _counted(url, False)
        return None
    _counted(url, True)
    return d


def metadata_document(uri: str, get=None):
    """The coin's metadata document: the same content-addressed file from every gateway at once, ONE try each with a short
    timeout, the first valid answer wins (before, the first address got 20 s and then the gateways two tries with
    waits, so a dead gateway could cost a score a minute). None when no gateway answered with a document. the team 2026-10-24:
    a gateway resting (it answered 429 or 403 in the last IPFS_REST_S, any process) is not asked; with all resting, None."""
    from solana_rpc import pmap
    cands = ipfs_alternatives(uri)
    get = get or (_gateway_get if len(cands) > 1 else (lambda u: http_json(u, tries=1, timeout=IPFS_TIMEOUT)))   # not on IPFS: its own host, as before
    if len(cands) > 1:
        resting = resting_gateways()
        cands = [u for u in cands if u.split("/")[2] not in resting]
        if not cands:
            return None
    answers = pmap(get, cands) if len(cands) > 1 else [get(cands[0])]
    return next((m for m in answers if isinstance(m, dict)), None)


def ipfs_alternatives(uri: str) -> list[str]:
    """Same file, several public IPFS gateways (content is addressed by its hash, so any gateway serves it)."""
    cid = None
    if uri.startswith("ipfs://"):
        cid = uri[len("ipfs://"):]
    elif "/ipfs/" in uri:
        cid = uri.split("/ipfs/", 1)[1]
    if not cid:
        return [uri]
    return [uri] + [g + cid for g in IPFS_GATEWAYS if g + cid != uri]


# ------------------------------------------------------------------ token's own links (presence, two-way proof)
_LINKS_CACHE: dict = {}


def own_links_receipts(own: Optional[dict], log: Log) -> None:
    """The per-link receipts of the coin's own document in the score's own log: one line per
    link kind (the link, or "none"), the document as the source; written once per score, whether the document was read
    now or cached from an earlier read in the same scan. Nothing when the document was not read (None)."""
    if own is None or any(str(r.get("what", "")).startswith("token's own twitter link") for r in log.items):
        return
    for k in ("twitter", "website", "telegram"):
        log.add(f"token's own {k} link", own.get(k) or "none", "url", own.get("uri") or "the coin's metadata document")


def read_token_links(mint: str, log: Log) -> Optional[dict]:
    if mint in _LINKS_CACHE:
        log.add("token links (cached from this scan)", _LINKS_CACHE[mint], "links", "same scan")
        return _LINKS_CACHE[mint]
    out = _read_token_links(mint, log)
    if out is not None:
        _LINKS_CACHE[mint] = out
    return out


def _read_token_links(mint: str, log: Log) -> Optional[dict]:
    """Links the token itself publishes: on-chain metadata -> its metadata URI (JSON) -> twitter/website/telegram.
    The URI is named on chain, so these links are the dev's own choice."""
    v, slot = account_parsed(mint)
    if v is None:
        return None
    uri = None
    for e in v["data"]["parsed"]["info"].get("extensions", []):
        if e["extension"] == "tokenMetadata":
            uri = (e.get("state") or {}).get("uri")
    if uri is None:
        md = pda([b"metadata", b58d(METAPLEX), b58d(mint)], METAPLEX)
        raw, owner, _ = account_raw(md)
        if raw is not None and owner == METAPLEX:
            o = 65
            vals = []
            for _ in range(3):
                n = int.from_bytes(raw[o:o + 4], "little"); vals.append(raw[o + 4:o + 4 + n]); o += 4 + n
            uri = vals[2].rstrip(b"\x00").decode("utf-8", "ignore")
    if not uri:
        log.add("token metadata URI", "not found", "url", f"getAccountInfo {mint}", slot)
        return None
    log.add("token metadata URI", uri, "url", f"getAccountInfo {mint}", slot)
    # Pump.fun's record of the same file (fast; no IPFS gateway limits): used only when it names this exact metadata link
    try:
        import pumpfun_api as PF
        rec = PF.coin(mint)
    except Exception:
        rec = None
    if rec and rec.get("metadata_uri") == uri:
        links = {"name": rec.get("name"), "symbol": rec.get("symbol"), "description": rec.get("description"), "uri": uri,
                 "image": rec.get("image_uri"), "twitter": (rec.get("twitter") or "").strip() or None,
                 "website": (rec.get("website") or "").strip() or None, "telegram": (rec.get("telegram") or "").strip() or None}
        if links["twitter"] or links["website"] or links["telegram"]:   # the record stands in for the document only when it carries a link:
            for k in ("twitter", "website", "telegram"):                 # Pump.fun also records coins launched elsewhere (StonkFun) with blank
                log.add(f"token's own {k} link", links[k] or "none", "url", f"Pump.fun record of {uri} (same metadata link as on chain)")
            return links                                                 # link fields, and "none" must come from the document itself (2026-10-14)
    meta = metadata_document(uri)
    if not isinstance(meta, dict):
        log.add("token metadata JSON", "unreadable", "json", uri)
        return None
    if not any(k in meta for k in ("name", "symbol", "image", "description", "extensions", "properties", "twitter", "website", "telegram", "external_url")):
        log.add("token metadata JSON", "unknown shape", "json", uri)        # a document of a shape nobody has read: unknown, never "none"
        return None
    ext = meta.get("extensions") if isinstance(meta.get("extensions"), dict) else {}
    props = meta.get("properties") if isinstance(meta.get("properties"), dict) else {}
    plinks = props.get("links") if isinstance(props.get("links"), dict) else {}        # the Metaplex shape (LaunchLab, StonkFun)
    pick = lambda *keys: next((str(src[k]).strip() for src in (meta, ext, plinks) for k in keys if src.get(k)), None)
    links = {"name": meta.get("name"), "symbol": meta.get("symbol"), "description": meta.get("description"), "uri": uri,
             "image": meta.get("image"),
             "twitter": pick("twitter", "x"), "website": pick("website", "web", "external_url"), "telegram": pick("telegram", "tg")}
    for k in ("twitter", "website", "telegram"):
        log.add(f"token's own {k} link", links[k] or "none", "url", uri)
    return links


def _https_ok(u) -> bool:
    return isinstance(u, str) and u.startswith("https://")


def metadata_uris(mints: list[str]) -> dict:
    """Each mint's own metadata on chain, 100 a call: the Token-2022 metadata extension, else the Metaplex metadata account.
    {mint: {"name", "symbol", "uri", "account"}} (the account the address was read from); a mint not read is left out."""
    from solana_rpc import rpc, pmap
    out = {}
    for i in range(0, len(mints), 100):
        part = mints[i:i + 100]
        r = rpc("getMultipleAccounts", [part, {"encoding": "jsonParsed"}])
        vals = r.get("value") if isinstance(r, dict) and "ERROR" not in r else None
        if vals is None:
            continue
        need_mpl = []
        for m, v in zip(part, vals):
            info = ((((v or {}).get("data") or {}) if isinstance((v or {}).get("data"), dict) else {}).get("parsed") or {}).get("info") or {}
            st = next((e.get("state") or {} for e in info.get("extensions") or [] if e.get("extension") == "tokenMetadata"), None)
            if st:
                out[m] = {"name": st.get("name"), "symbol": st.get("symbol"), "uri": st.get("uri"), "account": m}
            elif v is not None:
                need_mpl.append(m)
        if need_mpl:
            pdas = [pda([b"metadata", b58d(METAPLEX), b58d(m)], METAPLEX) for m in need_mpl]
            r = rpc("getMultipleAccounts", [pdas, {"encoding": "base64"}])
            vals = r.get("value") if isinstance(r, dict) and "ERROR" not in r else None
            for m, v, a in zip(need_mpl, vals or [], pdas):
                if not v or v.get("owner") != METAPLEX:
                    continue
                raw = base64.b64decode(v["data"][0]); o, got = 65, []
                for _ in range(3):
                    n = int.from_bytes(raw[o:o + 4], "little"); got.append(raw[o + 4:o + 4 + n].rstrip(b"\x00").decode("utf-8", "ignore").strip()); o += 4 + n
                out[m] = {"name": got[0] or None, "symbol": got[1] or None, "uri": got[2] or None, "account": a}

    return out


def free_assets(mints: list[str]) -> dict:
    """Name / symbol / image per mint without Helius: the token's own metadata on chain (Token-2022 metadata extension,
    else the Metaplex metadata account), read 100 at a time, then the image from the metadata file it names.
    A mint whose metadata cannot be read is left out (unknown), never filled in. For Pump.fun coins the image comes from
    Pump.fun's own record when it names the same metadata link as the chain (fast, no IPFS gateway limits)."""
    from solana_rpc import rpc, pmap
    out = metadata_uris(mints)
    # Pump.fun's own coin record (free, fast, its own image host). A lead: used only when the metadata link it names is
    # exactly the one on chain for that mint (same coin, same file); otherwise ignored.
    def pump_record(m):
        import pumpfun_api as _PF
        if _PF.resting():                                 # the team 2026-10-23: every Pump.fun caller waits out the shared rest
            return None
        r = http_json(f"https://frontend-api-v3.pump.fun/coins-v2/{m}", tries=1)
        return r if isinstance(r, dict) and r.get("mint") == m else None
    pumped = {}
    for m, rec in zip(list(out), pmap(pump_record, list(out), workers=4)):
        if rec and out[m]["uri"] and rec.get("metadata_uri") == out[m]["uri"] and _https_ok(rec.get("image_uri")):
            pumped[m] = rec["image_uri"]

    def image(uri):
        if not uri:
            return None
        j = metadata_document(uri)                     # the team 2026-10-24: the gateways not resting, one try each (they rate-limit)
        return (j.get("image"), True) if isinstance(j, dict) else (None, False)   # unreachable: image stays unknown
    keys = list(out)
    keys = [k for k in keys if k not in pumped]
    for m in pumped:
        out[m] = {"name": out[m]["name"], "symbol": out[m]["symbol"], "image": pumped[m]}
    for m, (img, read) in zip(keys, pmap(lambda m: image(out[m]["uri"]) if out[m]["uri"] else (None, True), keys, workers=4)):
        out[m] = {"name": out[m]["name"], "symbol": out[m]["symbol"], "image": img}
        if not read:
            out[m]["image_unread"] = True            # not "no image": the file could not be fetched just now
    return out
