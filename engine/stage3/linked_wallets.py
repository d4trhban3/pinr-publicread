"""Dev group / linked wallets. One hop from the dev.

Pure decision logic first (tested offline in test_linked_wallets.py); chain readers below it.
A wallet joins the dev group by:
  1. bundled buy   - bought in the same block (slot) as the token's creation
  2. funded sniper - got SOL from the dev within 24 h before launch AND bought within the first 60 s
  3. bag handoff   - got >= 1% of supply or >= 10% of the dev's bag from the dev, AND is fresh
                     (first activity within 7 days before receiving, or dev-funded) OR sold half+ within 24 h
Airdrops (10+ recipients in one distribution, each < 0.5% of supply, established wallets) are NEVER linked;
they are reported as incentive context. A "disguised handoff" (an airdrop whose recipients mostly dump within
1 h) is flagged and those recipients are linked.
Exchange and verified-launchpad wallets never count.
"""
from __future__ import annotations
from dataclasses import dataclass, field
from typing import Optional

AIRDROP_MIN_RECIPIENTS = 10
AIRDROP_MAX_SHARE = 0.005          # of total supply, per recipient
HANDOFF_MIN_SUPPLY_SHARE = 0.01
HANDOFF_MIN_BAG_SHARE = 0.10
FRESH_DAYS = 7
DUMP_WINDOW_S = 86400
DISGUISED_DUMP_WINDOW_S = 3600
SNIPER_FUNDING_WINDOW_S = 86400
SNIPER_BUY_WINDOW_S = 60
DISTRIBUTION_WINDOW_S = 3600       # transfers within an hour of each other form one distribution


@dataclass
class Recipient:
    wallet: str
    amount: float                  # tokens received from the dev
    t: int                         # time received
    signature: str
    first_activity: Optional[int] = None   # wallet's first-ever transaction time (None = unknown)
    dev_funded: bool = False
    sold_within_24h_share: Optional[float] = None   # share of what it received that it sold within 24 h
    sold_within_1h_share: Optional[float] = None
    excluded: bool = False         # exchange / verified launchpad / pool


@dataclass
class GroupResult:
    linked: dict = field(default_factory=dict)        # wallet -> (rule, receipt signature)
    airdrops: list = field(default_factory=list)      # incentive context
    context: list = field(default_factory=list)       # in-between transfers, not linked
    flags: list = field(default_factory=list)


def _distributions(recipients: list[Recipient]) -> list[list[Recipient]]:
    rs = sorted(recipients, key=lambda r: r.t)
    groups, cur = [], []
    for r in rs:
        if cur and r.t - cur[0].t > DISTRIBUTION_WINDOW_S:
            groups.append(cur); cur = []
        cur.append(r)
    if cur:
        groups.append(cur)
    return groups


def _established(r: Recipient) -> Optional[bool]:
    if r.first_activity is None:
        return None
    return r.t - r.first_activity > FRESH_DAYS * 86400 and not r.dev_funded


def classify_handoffs(recipients: list[Recipient], total_supply: float, dev_bag: float, res: GroupResult) -> None:
    for dist in _distributions([r for r in recipients if not r.excluded]):
        small = all(r.amount < AIRDROP_MAX_SHARE * total_supply for r in dist)
        if len(dist) >= AIRDROP_MIN_RECIPIENTS and small:
            dumped = [r for r in dist if (r.sold_within_1h_share or 0) >= 0.5]
            if len(dumped) > len(dist) / 2:
                res.flags.append(f"disguised handoff: {len(dumped)} of {len(dist)} airdrop recipients sold half+ within 1 h")
                for r in dumped:
                    res.linked[r.wallet] = ("disguised handoff", r.signature)
                continue
            est = [_established(r) for r in dist]
            if sum(1 for e in est if e) >= len(dist) / 2:
                res.airdrops.append({"recipients": len(dist), "total": sum(r.amount for r in dist),
                                     "first_tx": dist[0].signature})
                continue
        for r in dist:
            big = r.amount >= HANDOFF_MIN_SUPPLY_SHARE * total_supply or (dev_bag and r.amount >= HANDOFF_MIN_BAG_SHARE * dev_bag)
            fresh = r.dev_funded or (r.first_activity is not None and r.t - r.first_activity <= FRESH_DAYS * 86400)
            dumps = (r.sold_within_24h_share or 0) >= 0.5
            if big and (fresh or dumps):
                why = "handoff: " + ("fresh wallet" if fresh else "") + (" + " if fresh and dumps else "") + ("sold half+ within 24 h" if dumps else "")
                res.linked[r.wallet] = (why, r.signature)
            else:
                res.context.append({"wallet": r.wallet, "amount": r.amount, "tx": r.signature})


def classify_bundles(create_slot: int, early_buys: list[dict], dev: str, excluded: set, res: GroupResult) -> None:
    """early_buys: [{"wallet", "slot", "t", "signature"}] for the token's first buys."""
    for b in early_buys:
        if b["wallet"] != dev and b["wallet"] not in excluded and b["slot"] == create_slot:
            res.linked.setdefault(b["wallet"], ("bundled buy (same block as creation)", b["signature"]))


def classify_snipers(launch_ts: int, early_buys: list[dict], dev_sol_out: list[dict], dev: str, excluded: set,
                     res: GroupResult) -> None:
    """dev_sol_out: [{"to", "t", "signature"}] SOL sent by the dev."""
    funded = {}
    for o in dev_sol_out:
        if launch_ts - SNIPER_FUNDING_WINDOW_S <= o["t"] <= launch_ts:
            funded.setdefault(o["to"], o["signature"])
    for b in early_buys:
        w = b["wallet"]
        if w in funded and w != dev and w not in excluded and b["t"] - launch_ts <= SNIPER_BUY_WINDOW_S:
            res.linked.setdefault(w, ("funded sniper (dev sent SOL <24 h before launch; bought in first minute)",
                                      f"{funded[w]} + {b['signature']}"))


# ------------------------------------------------------------------ chain readers (Helius)
import sys as _sys, os as _os
_sys.path.insert(0, _os.path.join(_os.path.dirname(_os.path.abspath(__file__)), "..", "stage2"))
from b58 import b58d, oc as _on_curve
from readers import VERIFIED_LAUNCHPAD_PROGRAM_ACCOUNTS, VERIFIED_LAUNCHPAD_WALLETS
from dev_history import conduct_from_balances
from scan_c import dev_token_account, parse, rpc

EXCLUDED = set(VERIFIED_LAUNCHPAD_PROGRAM_ACCOUNTS) | set(VERIFIED_LAUNCHPAD_WALLETS)


def _is_program_account(addr: str) -> bool:
    """Pools, curves and other program-controlled accounts are off-curve addresses."""
    try:
        return not _on_curve(b58d(addr))
    except Exception:
        return True


def _bal_changes(t: dict, mint: str):
    for acc in t.get("accountData") or []:
        for b in acc.get("tokenBalanceChanges") or []:
            if b.get("mint") == mint and b.get("userAccount"):
                r = b.get("rawTokenAmount") or {}
                yield b["userAccount"], int(r.get("tokenAmount", 0)) / 10 ** int(r.get("decimals", 0))


def early_buys(mint: str, h, window_s: int = SNIPER_BUY_WINDOW_S):
    """Buys in the token's first minute, read oldest-first. Returns (buys, create_slot, launch_ts).
    Pump.fun coins: Pump.fun's own trade list + its launch (chain-checked); other coins: the chain."""
    got = early_buys_pumpfun(mint, window_s)
    if got is not None:
        return got
    return early_buys_chain(mint, h, window_s)


def early_buys_pumpfun(mint: str, window_s: int = SNIPER_BUY_WINDOW_S):
    import pumpfun_api as P
    if not P.coin(mint):
        return None
    launch_ts, create_slot, _sig = P.launch(mint)
    if launch_ts is None:
        return None
    rows, complete = P.trades(mint, launch_ts, launch_ts + window_s)
    if rows is None or not complete:
        return None
    # Pump.fun says which transactions are buys (complete, no cap); the chain says who RECEIVED the tokens in each
    # (PINR's definition of a buyer: a buy placed for another wallet credits that wallet, as before).
    from solana_rpc import fetch_txs
    sigs = list(dict.fromkeys(r["tx"] for r in rows if r["side"] == "buy"))
    parsed = fetch_txs(sigs)
    if parsed is None:
        return None
    buys = []
    for t in parsed:
        for user, delta in _bal_changes(t, mint):
            if delta > 0 and not _is_program_account(user):
                buys.append({"wallet": user, "slot": t.get("slot"), "t": t["timestamp"], "signature": t["signature"]})
    return buys, create_slot, launch_ts


def early_buys_chain(mint: str, h, window_s: int = SNIPER_BUY_WINDOW_S):
    from solana_rpc import history_asc, history_full, as_enhanced
    full, _ = history_full(mint, max_items=1)
    if full:                                                  # one pass, 100 full transactions per call
        launch_ts, create_slot = full[0]["blockTime"], full[0]["slot"]
        txs, _ = history_full(mint, max_items=200, until_ts=launch_ts + window_s)
        parsed = None if txs is None else [as_enhanced(t) for t in txs]
    else:                                                     # Helius full read unavailable: the older two-step read
        first, _ = history_asc(mint, max_items=400)
        if not first:
            return None, None, None
        first = [s for s in first if not s.get("err") and s.get("blockTime")]
        launch_ts, create_slot = first[0]["blockTime"], first[0]["slot"]
        window = [s["signature"] for s in first if s["blockTime"] - launch_ts <= window_s][:200]
        parsed = parse(h, window)
    buys = []
    if parsed is None:
        return None, None, None
    for t in parsed:
        for user, delta in _bal_changes(t, mint):
            if delta > 0 and not _is_program_account(user):
                buys.append({"wallet": user, "slot": t.get("slot"), "t": t["timestamp"], "signature": t["signature"]})
    return buys, create_slot, launch_ts


def dev_sol_out_before(dev: str, launch_ts: int, h, limit: int = 300):
    """SOL the dev sent out in the 24 h before launch."""
    sg = rpc("getSignaturesForAddress", [dev, {"limit": 1000}])
    if not isinstance(sg, list):
        return None
    pick = [s["signature"] for s in sg if s.get("blockTime") and launch_ts - SNIPER_FUNDING_WINDOW_S <= s["blockTime"] <= launch_ts][:limit]
    out = []
    parsed = parse(h, pick)
    if parsed is None:
        return None
    for t in parsed:
        for n in t.get("nativeTransfers") or []:
            if n.get("fromUserAccount") == dev and n.get("toUserAccount") and n.get("amount", 0) > 0:
                out.append({"to": n["toUserAccount"], "t": t["timestamp"], "signature": t["signature"]})
    return out


def wallet_first_activity(w: str) -> Optional[int]:
    sg = rpc("getSignaturesForAddress", [w, {"limit": 1000}])
    if not isinstance(sg, list) or not sg:
        return None
    if len(sg) == 1000:
        return 0                   # 1,000+ transactions: long-established
    return sg[-1].get("blockTime")


def wallet_moves(w: str, mint: str, h):
    ata = dev_token_account(w, mint)
    sg = rpc("getSignaturesForAddress", [ata, {"limit": 1000}]) if ata else None
    if not isinstance(sg, list):
        return None
    return parse(h, [s["signature"] for s in sg if not s.get("err")])


def dev_group(dev: str, mint: str, total_supply: float, h, dev_txs: list, max_recipients: int = 30) -> dict:
    """Find linked wallets and measure the whole group. dev_txs: parsed txs on the dev's token account."""
    res = GroupResult()
    buys, create_slot, launch_ts = early_buys(mint, h)
    if buys is None:
        return {"complete": False, "reason": "could not read the token's first transactions"}
    sol_out = dev_sol_out_before(dev, launch_ts, h)
    if sol_out is None:
        return {"complete": False, "reason": "could not read the dev's SOL transfers before launch"}
    funded = {o["to"] for o in sol_out}
    classify_bundles(create_slot, buys, dev, EXCLUDED, res)
    classify_snipers(launch_ts, buys, sol_out, dev, EXCLUDED, res)
    dev_c = conduct_from_balances(dev_txs, dev, mint, launch_ts)
    recips = {}
    for t in dev_txs:
        changes = dict(_bal_changes(t, mint))
        if changes.get(dev, 0) >= 0:
            continue
        # a recipient needs BOTH a direct transfer from the dev's wallet and a matching balance increase
        direct = {x.get("toUserAccount") for x in t.get("tokenTransfers") or []
                  if x.get("mint") == mint and x.get("fromUserAccount") == dev}
        for user, delta in changes.items():
            if user in direct and user != dev and delta > 0 and not _is_program_account(user):
                recips.setdefault(user, Recipient(user, delta, t["timestamp"], t["signature"]))
    from solana_rpc import pmap

    def check(r):
        r.excluded = r.wallet in EXCLUDED
        r.first_activity = wallet_first_activity(r.wallet)
        r.dev_funded = r.wallet in funded
        mv = wallet_moves(r.wallet, mint, h)
        if mv is not None:
            c = conduct_from_balances(mv, r.wallet, mint, r.t)
            got = c["acquired"] or r.amount
            out24 = sum(m["amount"] for m in c["moves"] if m["dir"] == "out" and m["t"] <= r.t + DUMP_WINDOW_S)
            out1h = sum(m["amount"] for m in c["moves"] if m["dir"] == "out" and m["t"] <= r.t + DISGUISED_DUMP_WINDOW_S)
            r.sold_within_24h_share, r.sold_within_1h_share = min(1, out24 / got), min(1, out1h / got)
        return r

    pmap(check, list(recips.values())[:max_recipients], workers=4)
    classify_handoffs(list(recips.values()), total_supply, dev_c["acquired"], res)
    # measure the group: combine every member's movements on this token
    internal = {recips[w].signature for w in res.linked if w in recips}     # dev -> linked wallet: stays in the group
    moves = [m for m in dev_c["moves"] if not (m["dir"] == "out" and m["signature"] in internal)]
    acquired = dev_c["acquired"]
    members = list(res.linked)
    member_txs = pmap(lambda w: wallet_moves(w, mint, h), members, workers=4)
    for w, mv in zip(members, member_txs):
        if mv is None:
            return {"complete": False, "reason": f"could not read linked wallet {w}"}
        c = conduct_from_balances(mv, w, mint, launch_ts)
        handoff_in = recips[w].amount if w in recips else 0   # tokens from the dev are not new acquisition
        acquired += max(0.0, c["acquired"] - handoff_in)
        moves += [m for m in c["moves"] if not (m["dir"] == "in" and w in recips and m["signature"] == recips[w].signature)]
    moves.sort(key=lambda m: m["t"])
    return {"complete": True, "launch_ts": launch_ts, "create_slot": create_slot, "linked": res.linked,
            "airdrops": res.airdrops, "context": res.context, "flags": res.flags,
            "group_acquired": acquired, "group_moves": moves, "members": [dev] + list(res.linked)}
