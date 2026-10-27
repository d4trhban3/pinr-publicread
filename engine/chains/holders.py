"""a Base/BNB coin's holders, from the coin's own published Transfer logs since its
creation (● on chain), keyless on the free nodes. No holder-list API is free for Base/BNB (checked 2026-10-25: Etherscan V2's
free tier excludes Base, Ankr and Covalent need a key, Alchemy has no ERC-20 holder list, Moralis has no free plan), so the
chain is the route: read the published logs (`eth_getLogs`, the standard Transfer event) and sum the balances. Nothing is
decoded beyond the standard event.

Bounded per coin: only a coin launched in the last MAX_AGE_S, and only when its whole history is at most MAX_LOGS transfers
(read in full or not at all: a partial history is never shown). The top TOP holders are kept, each with its share of the
supply; the launchpad's own contracts, the pool and the burn addresses are named for what they are."""
from __future__ import annotations
import os, sys, time

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path[:0] = [os.path.join(HERE, "..", "stage4")]

TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef"     # Transfer(address,address,uint256)
MAX_AGE_S = 86400
MAX_LOGS = 20000
TOP = 20
ZERO = "0x0000000000000000000000000000000000000000"
BURN = {ZERO, "0x000000000000000000000000000000000000dead"}


def balances(logs: list) -> dict:
    """{wallet: raw balance} from Transfer logs, oldest first: a mint comes from the zero address and a burn to it leaves the
    supply (neither is a holder); tokens sent to 0x…dead stay counted as held there (shown as the burn address, not a holder)."""
    bal: dict = {}
    for l in sorted(logs, key=lambda l: (int(l["blockNumber"], 16), int(l.get("logIndex") or "0x0", 16))):
        t = l.get("topics") or []
        if len(t) < 3 or t[0] != TRANSFER or l.get("removed"):
            continue
        frm, to = ("0x" + t[1][-40:]).lower(), ("0x" + t[2][-40:]).lower()
        v = int(l["data"], 16) if l.get("data") not in (None, "0x") else 0
        if frm != ZERO:
            bal[frm] = bal.get(frm, 0) - v
        if to != ZERO:                                         # a burn to the zero address leaves the supply
            bal[to] = bal.get(to, 0) + v
    return bal


def read(chain: str, mint: str, from_block: int, launched_at: float | None, now: float | None = None, logs_fn=None, head_fn=None) -> dict | None:
    """{"holders": [(wallet, raw)], "count": holders with a balance, "logs": n, "to_block"}; None when the coin is too old, the
    history too long, or any stretch went unread (missing stays missing)."""
    now = now or time.time()
    if not from_block or not launched_at or now - launched_at > MAX_AGE_S:
        return None
    if head_fn is None:
        from evm import rpc
        head_fn = lambda: (lambda h: int(h, 16) - 3 if isinstance(h, str) else None)(rpc(chain, "eth_blockNumber", []))
    if logs_fn is None:                                        # SQD Portal first, then the free nodes (never Alchemy's slices: its cap)
        def logs_fn(lo, hi):
            import sqd_evm
            from evm import _read_span
            r = sqd_evm.logs(chain, mint, TRANSFER, lo, hi)
            if r is None:
                r = _read_span(chain, {"address": mint, "topics": [TRANSFER]}, lo, hi)
            return (r or [], r is not None)
    tip = head_fn()
    if tip is None or tip < from_block:
        return None
    got, complete = logs_fn(from_block, tip)
    if not complete or len(got) > MAX_LOGS:
        return None
    bal = balances(got)
    held = sorted(((w, b) for w, b in bal.items() if b > 0), key=lambda x: -x[1])
    count = sum(1 for w, _b in held if w not in BURN)          # holders are wallets outside the burn addresses (F1)
    return {"holders": held[:TOP], "count": count, "logs": len(got), "to_block": tip}


def rows(chain: str, mint: str, h: dict, supply_raw: int | None, named: dict | None = None) -> list:
    """Evidence rows (chains/evidence_evm's shape): wallet -> token "holds", ● on chain, with the share of supply when known."""
    import json
    ex = {"base": "https://basescan.org", "bsc": "https://bscscan.com"}[chain]
    named = named or {}
    src = f"Transfer logs since creation, to block {h['to_block']} ({h['logs']} transfers, {h['count']} holders)"
    out = []
    for w, raw in h["holders"]:
        v = {"amount_raw": str(raw), "share": (raw / supply_raw) if supply_raw else None}
        if w in BURN:
            v["note"] = "burn address"
        elif w in named:
            v["note"] = named[w]
        out.append({"coin": mint, "from_kind": "wallet", "from_id": w, "to_kind": "token", "to_id": mint, "what": "holds",
                    "value": json.dumps(v), "unit": "tokens", "at": None, "source": src, "link": f"{ex}/address/{w}", "onchain": 1,
                    "receipt": "holders (Transfer logs)"})
    out.append({"coin": mint, "from_kind": "token", "from_id": mint, "to_kind": "count", "to_id": "holders", "what": "holders counted",
                "value": json.dumps(h["count"]), "unit": "wallets", "at": None, "source": src, "link": f"{ex}/token/{mint}#balances",
                "onchain": 1, "receipt": "holders (Transfer logs)"})
    return out
