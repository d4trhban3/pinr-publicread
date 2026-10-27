"""the team 2026-10-25: Virtuals' scorer is parked (its bonding curve, implementation 0xC818…1b6a, has no verified source we can
read keylessly), but each Virtuals coin is listed with what is verifiable, as ● facts in the evidence trail:
  - the coin is an EIP-1167 clone of AgentTokenV4 0x950f…9aa8 (Sourcify exact match, read 2026-10-25);
  - its owner (`owner()`), and the powers AgentTokenV4's verified source gives the owner (onlyOwnerOrFactory): add and remove
    addresses on a blacklist, change the buy and sell tax rates, change which pools count as pools, and withdraw tokens and
    ETH the coin's contract holds;
  - its buy and sell tax now (`totalBuyTaxBasisPoints`, `totalSellTaxBasisPoints`) and who the tax goes to
    (`projectTaxRecipient`).
The bonding curve gets no row, so the coin page shows the pool as "not checked yet". Missing stays missing: a coin of another
implementation, or a read that did not answer, gets no row."""
from __future__ import annotations
import json, os, sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path[:0] = [os.path.join(HERE, "..", "stage4")]

AGENT_TOKEN_V4 = "0x950ff75579560e8f391406274790fcb8bf749aa8"
OWNER_POWERS = ["add and remove addresses on a blacklist", "change the buy and sell tax rates",
                "change which pools count as pools", "withdraw tokens and ETH the coin's contract holds"]
BASESCAN = "https://basescan.org"


def read(mint: str, call=None, code=None) -> dict | None:
    """{owner, buy_bps, sell_bps, tax_to} for an AgentTokenV4 coin; {} when it is another implementation (no facts, for good);
    None when a read did not answer (tried again next pass)."""
    from evm import call as _call, rpc, selector, words
    call = call or (lambda fn: _call("base", mint, "0x" + selector(fn)))
    code = code if code is not None else rpc("base", "eth_getCode", [mint, "latest"])
    if not isinstance(code, str):
        return None
    if not (code.startswith("0x363d3d373d3d3d363d73") and ("0x" + code[22:62]).lower() == AGENT_TOKEN_V4):
        return {}
    out = {}
    for key, fn in (("owner", "owner()"), ("tax_to", "projectTaxRecipient()"), ("buy_bps", "totalBuyTaxBasisPoints()"), ("sell_bps", "totalSellTaxBasisPoints()")):
        r = call(fn)
        if not r or len(r) < 66:
            return None
        out[key] = ("0x" + r[-40:]).lower() if key in ("owner", "tax_to") else int(r[2:66], 16)
    return out


def rows(mint: str, f: dict) -> list:
    """Evidence rows (chains/evidence_evm's shape), all ● read on chain."""
    src = f"eth_call owner()/projectTaxRecipient()/totalBuyTaxBasisPoints()/totalSellTaxBasisPoints() on {mint}; AgentTokenV4 verified source (Sourcify)"
    base = {"coin": mint, "at": None, "source": src, "onchain": 1, "receipt": "Virtuals token (AgentTokenV4)"}
    return [dict(base, from_kind="token", from_id=mint, to_kind="wallet", to_id=f["owner"], what="owned by (contract owner)",
                 value=json.dumps({"can": OWNER_POWERS, "template": "AgentTokenV4 (verified)"}), unit=None, link=f"{BASESCAN}/address/{f['owner']}"),
            dict(base, from_kind="token", from_id=mint, to_kind="check", to_id="tax", what="trading tax",
                 value=json.dumps({"buy_pct": f["buy_bps"] / 100, "sell_pct": f["sell_bps"] / 100}), unit="percent", link=f"{BASESCAN}/token/{mint}"),
            dict(base, from_kind="token", from_id=mint, to_kind="wallet", to_id=f["tax_to"], what="tax paid to",
                 value=None, unit=None, link=f"{BASESCAN}/address/{f['tax_to']}")]


def one_pass(c, g, feed_dir: str, limit: int = 10, read_fn=None) -> int:
    """Virtuals coins in the store without their facts yet: read (network first), then write rows and the evidence file."""
    import evidence_evm as EE, evidence as EV
    todo = [m for (m,) in c.execute("SELECT mint FROM coins WHERE launchpad='Virtuals' AND facts_at IS NULL ORDER BY launched_at DESC LIMIT ?", (limit,))]
    got = {m: (read_fn or read)(m) for m in todo}
    import time
    n = 0
    for m, f in got.items():
        if f is None:
            continue                                           # unread: tried again next pass
        if f:
            n += EE.store(g, rows(m, f))
            EV.write_coin_file(g, m, feed_dir)
        c.execute("UPDATE coins SET facts_at=? WHERE mint=?", (time.time(), m))
    c.commit()
    return n
