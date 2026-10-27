"""Dev group / linked wallets on BNB Chain. The DECISION rules are the same tested functions used on Solana
(stage3/linked_wallets.py: classify_bundles, classify_snipers, classify_handoffs, airdrop exemption included); only the
data readers here are EVM-specific:
  - early buys: the launchpad's own buy events (Flap TokenBought / four.meme TokenPurchase) in the creation block and the
    first minute (~140 blocks at ~0.45 s)
  - dev SOL->BNB funding: the dev's native-BNB sends in the 24 h before launch (Alchemy transfer records)
  - handoffs: the dev's token transfers out to wallets (launchpad, pool and burn addresses excluded); for each recipient,
    its first-ever activity and how much it sold within 1 h / 24 h of receiving
Anything unreadable makes the group 'incomplete' (the caller falls back to the creator wallet and says so)."""
from __future__ import annotations
import calendar, os, sys, time
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "stage3"))
from linked_wallets import (GroupResult, Recipient, classify_bundles, classify_snipers, classify_handoffs,
                            SNIPER_BUY_WINDOW_S, DUMP_WINDOW_S, DISGUISED_DUMP_WINDOW_S)
from evm import rpc, topic, logs, words, dec
import flap_reader as FL
import fourmeme_reader as FM
import solana_rpc as _S

CHAIN = "bsc"
BLOCKS_PER_MIN = 140
BLOCKS_PER_DAY = 192_000
PER_CHAIN = {"bsc": (140, 192_000), "base": (30, 43_200)}      # blocks per minute / per day
EVENTS = {"flap": (FL.PORTAL, topic("TokenBought(uint256,address,address,uint256,uint256,uint256,uint256)"), 1, 2),
          "fourmeme": (FM.MANAGER, topic("TokenPurchase(address,address,uint256,uint256,uint256,uint256,uint256,uint256)"), 0, 1)}


def is_route(code: str | None) -> bool | None:
    """A contract (router, bot, aggregator, pool) is a trading ROUTE, never a person's side wallet.
    EIP-7702 delegated wallets (code starting 0xef0100) are personal wallets, so they are not routes."""
    if code is None:
        return None
    c = code.lower()
    return len(c) > 2 and not c.startswith("0xef0100")


def code_of(addr: str, chain: str = CHAIN):
    r = rpc(chain, "eth_getCode", [addr, "latest"])
    return r if isinstance(r, str) else None


def _ts(iso: str) -> int:
    return calendar.timegm(time.strptime(iso[:19], "%Y-%m-%dT%H:%M:%S"))


def early_buys(launchpad: str, token: str, create_block: int, launch_ts: int):
    addr, t0, tok_i, buyer_i = EVENTS[launchpad]
    lg, ok = logs(CHAIN, addr, t0, create_block, create_block + BLOCKS_PER_MIN)
    if not ok:
        return None
    out = []
    for l in lg:
        w = words(l["data"])
        if dec(w[tok_i], "address").lower() != token.lower():
            continue
        b = int(l["blockNumber"], 16)
        out.append({"wallet": dec(w[buyer_i], "address").lower(), "slot": b,
                    "t": launch_ts + round((b - create_block) * 60 / BLOCKS_PER_MIN), "signature": l["transactionHash"]})
    return out


def dev_bnb_sends(dev: str, create_block: int, chain: str = CHAIN):
    """The dev's native-coin sends (BNB / ETH) in the day before launch."""
    r = rpc(chain, "alchemy_getAssetTransfers", [{"fromAddress": dev, "category": ["external", "internal"], "withMetadata": True,
                                                  "fromBlock": hex(max(0, create_block - PER_CHAIN[chain][1])), "toBlock": hex(create_block),
                                                  "maxCount": "0x3e8"}])
    if not isinstance(r, dict):
        return None
    return [{"to": t["to"].lower(), "t": _ts(t["metadata"]["blockTimestamp"]), "signature": t["hash"]}
            for t in r.get("transfers", []) if t.get("to")]


def first_activity(wallet: str, chain: str = CHAIN):
    r = rpc(chain, "alchemy_getAssetTransfers", [{"toAddress": wallet, "category": ["external", "internal", "erc20"], "order": "asc",
                                                  "withMetadata": True, "fromBlock": "0x0", "maxCount": "0x1"}])
    if not isinstance(r, dict):
        return None
    t = r.get("transfers") or []
    return _ts(t[0]["metadata"]["blockTimestamp"]) if t else None


def dev_group(launchpad: str, token: str, dev: str, total_supply: float, launch_ts: int, create_block: int,
              exclude: set, max_recipients: int = 30, chain: str = CHAIN, co_devs: tuple = (), early=None) -> dict:
    """co_devs: wallets clearly identified as the dev team by the launchpad's own records; they are
    members from the start, and transfers among the team stay inside the group. early: a launchpad-specific
    first-minute buy reader (Clanker), else the BNB launchpad events."""
    dev = dev.lower()
    team = [dev] + sorted({w.lower() for w in co_devs} - {dev})
    res = GroupResult()
    buys = early() if early else early_buys(launchpad, token, create_block, launch_ts)
    if buys is None:
        return {"complete": False, "reason": "could not read the token's first-minute buys"}
    sends = []
    for w in team:
        sw = dev_bnb_sends(w, create_block, chain)
        if sw is None:
            return {"complete": False, "reason": "could not read the dev team's native-coin sends before launch"}
        sends += sw
    exclude = set(exclude) | set(team)
    # only ordinary wallets can be linked: contracts are trading routes (a sell through a bot router is a sell)
    cands = sorted({b["wallet"] for b in buys} | {s["to"] for s in sends})
    codes = dict(zip(cands, _S.pmap(lambda a: code_of(a, chain), cands)))
    if any(v is None for v in codes.values()):
        return {"complete": False, "reason": "could not check whether candidate wallets are contracts"}
    routes = {a for a, c in codes.items() if is_route(c)}
    exclude = set(exclude) | routes
    classify_bundles(create_block, buys, dev, exclude, res)
    classify_snipers(launch_ts, buys, sends, dev, exclude, res)
    team_mv = _S.pmap(lambda w: FL.dev_moves(token, w, chain), team, workers=4)
    if any(m is None for m in team_mv):
        return {"complete": False, "reason": "could not read the dev team's token moves"}
    tset = set(team)
    dev_mv = sorted([m for mv in team_mv for m in mv if (m.get("counterparty") or "").lower() not in tset], key=lambda m: m["t"])
    funded = {s["to"] for s in sends}
    handoff_block = {m["signature"]: m.get("block") for m in dev_mv if m["dir"] == "out"}
    recips = {}
    for m in dev_mv:
        cp = (m.get("counterparty") or "").lower()
        if m["dir"] == "out" and cp and cp not in exclude:
            recips.setdefault(cp, Recipient(cp, m["amount"], m["t"], m["signature"]))

    rcodes = dict(zip(list(recips), _S.pmap(lambda a: code_of(a, chain), list(recips))))
    if any(v is None for v in rcodes.values()):
        return {"complete": False, "reason": "could not check whether recipients are contracts"}
    exclude = exclude | {a for a, c in rcodes.items() if is_route(c)}

    def check(r):
        r.excluded = r.wallet in exclude
        if r.excluded:
            return r          # routes / platform contracts are never classified, so their histories aren't read
        r.first_activity = first_activity(r.wallet, chain)
        r.dev_funded = r.wallet in funded
        # only the 24 h after receiving matter (the 1 h and 24 h sell windows), so read the recipient's moves up to there
        b = handoff_block.get(r.signature)
        mv = FL.dev_moves(token, r.wallet, chain, to_block=(b + PER_CHAIN[chain][1]) if b is not None else None)
        if mv is not None:
            got = sum(x["amount"] for x in mv if x["dir"] == "in") or r.amount
            out24 = sum(x["amount"] for x in mv if x["dir"] == "out" and x["t"] <= r.t + DUMP_WINDOW_S)
            out1h = sum(x["amount"] for x in mv if x["dir"] == "out" and x["t"] <= r.t + DISGUISED_DUMP_WINDOW_S)
            r.sold_within_24h_share, r.sold_within_1h_share = min(1, out24 / got), min(1, out1h / got)
        return r

    _S.pmap(check, list(recips.values())[:max_recipients], workers=4)
    dev_acq = sum(m["amount"] for m in dev_mv if m["dir"] == "in")
    classify_handoffs(list(recips.values()), total_supply, dev_acq, res)
    # measure the whole group; dev -> linked-wallet transfers stay inside the group
    internal = {recips[w].signature for w in res.linked if w in recips}
    moves = [m for m in dev_mv if not (m["dir"] == "out" and m["signature"] in internal)]
    acquired = dev_acq
    members = list(res.linked)
    member_moves = _S.pmap(lambda w: FL.dev_moves(token, w, chain), members, workers=4)
    for w, mv in zip(members, member_moves):
        if mv is None:
            return {"complete": False, "reason": f"could not read linked wallet {w}"}
        handoff_in = recips[w].amount if w in recips else 0
        acquired += max(0.0, sum(x["amount"] for x in mv if x["dir"] == "in") - handoff_in)
        moves += [x for x in mv if not (x["dir"] == "in" and w in recips and x["signature"] == recips[w].signature)]
    moves.sort(key=lambda m: m["t"])
    return {"complete": True, "linked": res.linked, "airdrops": res.airdrops, "context": res.context, "flags": res.flags,
            "group_acquired": acquired, "group_moves": moves, "members": team + members}
