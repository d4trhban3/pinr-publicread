"""Funding source, creator wallet part 3: where the dev's SOL came from.

Standard free chain reads only (getSignaturesForAddress, getTransaction through the engine's request module; decision
198, 210): for the dev wallet, then for each wallet that funded it, the oldest incoming SOL transfer and who sent it,
up to FUNDING_HOPS hops. A wallet is fresh when its first activity is within linked_wallets.FRESH_DAYS of the moment
it mattered (the launch for the dev; the funding it gave for a funder). The trace stops at the first wallet that is not
fresh (long-standing), at a busy wallet (its history's start is not reached in BUSY_PAGES pages: an exchange looks
like this, but PINR has no exchange list, so it is never named one), or when a hop cannot be read.

Shown, not graded: the part has no cut-offs yet (rules section 14), so the creator grade still passes Unknown for it.
The one graded use is the existing brake "resembles a confirmed rug" , which is handed the funders that
are not busy. Unread stays unread: a hop that cannot be read ends the trace as "not read", never as a clean source.
A wallet whose start was reached never changes, so its answer is kept for good (solana_cache.sqlite). A store that cannot
be opened or written leaves that wallet not read, so the trace ends "not read" and the score goes on.
"""
from __future__ import annotations
import os, sys, time
from typing import Optional

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "stage2"))
import solana_rpc as S
import pumpfun_api as _store
from dev_history import first_funding
from linked_wallets import FRESH_DAYS

FUNDING_HOPS = 3            # starting value: funders followed back from the dev
BUSY_PAGES = 2              # pages of 1,000 signatures read per wallet; past that the wallet is busy (start not reached)
OLDEST_TXS = 8              # the wallet's oldest successful transactions searched for its first incoming SOL
RETRY_S = 1.0               # a wallet whose read failed is asked once more after this long (checklist 6: 25 of 39 "not read" read at once)

WORDS = {
    "long_standing": "the dev wallet was active more than {d} days before the launch",
    "dev_busy": "the dev wallet is busy (more than {p:,} transactions; its start was not reached)",
    "from_established": "the dev wallet is fresh; {n} fresh wallet(s) on the trace, back to a wallet active more than {d} days before it paid",
    "from_busy": "the dev wallet is fresh; {n} fresh wallet(s) on the trace, back to a busy wallet (its start was not reached)",
    "fresh_chain": "every wallet followed back is fresh ({n} wallets, the trace's limit)",
    "funder_not_found": "no incoming SOL in a wallet's oldest transactions; the trace stops there",
    "no_history": "the dev wallet has no transactions of its own on chain (it is only named in the launch); the trace stops there",
    "not_read": "a wallet on the trace could not be read: not read",
    "no_launch_time": "the launch time was not read, so the dev wallet's freshness cannot be judged: not read",
}


def wallet_start(w: str) -> Optional[dict]:
    """{"wallet", "busy", "first_activity", "funder", "sol", "funded_at", "signature"} or None if unreadable."""
    key = f"funding-start:{w}"
    try:
        got = _store._kv(key)
    except Exception:
        return None                      # the store cannot be opened: this wallet is not read, the score goes on (W5)
    if got:
        return got
    items, end = S.sigs_desc(w, max_pages=BUSY_PAGES)
    if items is None:
        return None
    if not items and end:                # the chain answered: this address never took part in a transaction (2026-10-25: 14
        return {"wallet": w, "busy": False, "no_history": True, "first_activity": None, "funder": None, "sol": None,
                "funded_at": None, "signature": None}   # creators named only in a launch read "not read" every score); never kept
    if not end:
        return {"wallet": w, "busy": True, "first_activity": None, "funder": None, "sol": None, "funded_at": None,
                "signature": None, "signatures_read": len(items)}         # never kept: it may still be read later
    times = [x["blockTime"] for x in items if x.get("blockTime")]
    if not times:
        return None
    oldest = [x["signature"] for x in items if not x.get("err")][-OLDEST_TXS:]
    txs = S.fetch_txs(oldest)
    if txs is None:
        return None
    f = first_funding(txs, w, True)
    rec = {"wallet": w, "busy": False, "first_activity": min(times), "funder": f and f["from"], "sol": f and f["sol"],
           "funded_at": f and f["timestamp"], "signature": f and f["signature"]}
    try:
        _store._kv(key, rec)
    except Exception:
        return None                      # the store cannot be written: not read, never a crash (W5)
    return rec


def trace(dev: str, launch_ts: Optional[int]) -> dict:
    """{"kind", "words", "fresh_wallets", "chain": [wallet_start records], "funders": [not-busy funders]}."""
    chain, w, t_ref, kind, fresh = [], dev, launch_ts, "not_read", 0
    for hop in range(FUNDING_HOPS + 1):
        r = wallet_start(w)
        if r is None:
            time.sleep(RETRY_S)                        # one more try: most failed reads are a node's passing refusal
            r = wallet_start(w)
        if r is None:
            kind = "not_read"
            break
        chain.append(r)
        if r["busy"]:
            kind = "dev_busy" if hop == 0 else "from_busy"
            break
        if r.get("no_history"):                        # a funder always has the transfer it paid with: a funder read so
            kind = "no_history" if hop == 0 else "not_read"   # is a node's wrong answer, not a finding
            break
        if t_ref is None:
            kind = "no_launch_time"                    # freshness cannot be judged: not read
            break
        if t_ref - r["first_activity"] > FRESH_DAYS * 86400:
            kind = "long_standing" if hop == 0 else "from_established"
            break
        fresh += 1                                     # this wallet was fresh when it mattered
        if not r["funder"]:
            kind = "funder_not_found"
            break
        if hop == FUNDING_HOPS:
            kind = "fresh_chain"
            break
        w, t_ref = r["funder"], r["funded_at"]
    funders = [r["wallet"] for r in chain[1:] if not r["busy"]]
    return {"kind": kind, "words": WORDS[kind].format(d=FRESH_DAYS, p=BUSY_PAGES * 1000, n=fresh), "fresh_wallets": fresh,
            "chain": chain, "funders": funders}
