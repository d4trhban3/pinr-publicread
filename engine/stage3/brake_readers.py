"""Chain readers for the brakes: the token's first-24-hour trades and its top holders.
Each trade: wallet, time, buy/sell (from the trader's real token-balance change) and USD size (from the
trader's SOL balance change x SOL price; includes the network fee, a fraction of a cent).
Cost cap: at most `max_txs` transactions from the first 24 hours; beyond that the result says it's partial.
"""
from __future__ import annotations
from linked_wallets import _bal_changes, _is_program_account
from scan_c import parse, rpc

WSOL = "So11111111111111111111111111111111111111112"


def _first_day_full(mint: str, max_txs: int):
    """First 24 h of successful transactions in one pass, 100 per call (10 credits per 100). The limit counts
    successful transactions only (the older read also counted failed ones). (None, False) if unavailable."""
    from solana_rpc import history_full, as_enhanced
    first, _ = history_full(mint, max_items=1)
    if not first:
        return None, False
    t0 = first[0]["blockTime"]
    txs, done = history_full(mint, max_items=max_txs + 1, until_ts=t0 + 86400)
    if txs is None:
        return None, False
    return [as_enhanced(t) for t in txs[:max_txs]], done and len(txs) <= max_txs


def first_day_trades(mint: str, h, sol_usd: float | None, max_txs: int = 2000):
    """Returns (trades, complete). Pump.fun coins: Pump.fun's own trade list (complete, chain-checked launch);
    other coins: the chain (pages back to the token's first transaction, then reads forward 24 h)."""
    got = first_day_trades_pumpfun(mint, sol_usd, max_txs)         # 1. Pump.fun's trade list (rate-limited)
    if got is not None:                                            # (our own trade record came first until 2026-10-13;
        return got                                                 # a design decision removed it)
    return first_day_trades_chain(mint, h, sol_usd, max_txs)       # 2. the chain


def first_day_trades_pumpfun(mint: str, sol_usd: float | None, max_txs: int = 2000):
    import pumpfun_api as P
    from linked_wallets import _is_program_account
    if not P.coin(mint):
        return None
    t0, _slot, _sig = P.launch(mint)
    if t0 is None:
        return None
    import time as _t
    horizon = int(min(86400, _t.time() - 60 - t0))    # the first day, or as much of it as has happened
    rows, complete = P.first_trades(mint, t0, horizon, max_trades=max_txs)   # the day's FIRST max_txs trades
    if rows is None:
        return None                                   # unreadable: use the chain reader
    trades = [{"wallet": r["user"], "t": r["t"], "side": r["side"],
               "usd": (r["sol"] * sol_usd) if (r["sol"] is not None and sol_usd is not None) else 0.0, "signature": r["tx"]}
              for r in rows if not _is_program_account(r["user"])]
    return trades, complete


def first_day_trades_chain(mint: str, h, sol_usd: float | None, max_txs: int = 2000):
    parsed, complete = _first_day_full(mint, max_txs)
    if parsed is None:                                        # Helius full read unavailable: the older two-step read
        from solana_rpc import history_asc
        first, _ = history_asc(mint, max_items=1)
        if not first:
            return None, False
        t0 = first[0]["blockTime"]
        sigs, done = history_asc(mint, max_items=max_txs + 1, until_ts=t0 + 86400)
        if sigs is None:
            return None, False
        day = [s["signature"] for s in sigs if not s.get("err")]
        complete = done and len(day) <= max_txs
        parsed = parse(h, day[:max_txs])
        if parsed is None:
            return None, False
    trades = []
    for t in parsed:
        payer = t.get("feePayer")
        sol = None
        for acc in t.get("accountData") or []:
            if acc.get("account") == payer:
                sol = acc.get("nativeBalanceChange")
        for user, delta in _bal_changes(t, mint):
            if user != payer or delta == 0 or _is_program_account(user):
                continue
            usd = None if sol is None or sol_usd is None else abs(sol) / 1e9 * sol_usd
            trades.append({"wallet": user, "t": t["timestamp"], "side": "buy" if delta > 0 else "sell",
                           "usd": usd or 0.0, "signature": t["signature"]})
    return trades, complete


def holders_read(holders_top) -> bool:
    """Whether the who-holds brakes had anything to judge: a list with at least one holder. An empty list means every owner
    lookup was refused (or nobody but programs holds), so nothing was checked: not read."""
    return bool(holders_top)


HOLDERS_SOURCE: dict = {}       # mint -> which source answered the last top-holders read (for the score's log)
HOLDERS_ROWS: dict = {}         # mint -> every holder row that read gave, programs marked


def top_holders(mint: str, n: int = 20) -> list[str] | None:
    """The top n holders' owner wallets, largest first, programs left out. Pump.fun coins: Pump.fun's own list
   ; otherwise, or when Pump.fun cannot answer: the chain."""
    got = top_holders_pumpfun(mint, n)
    if got:
        HOLDERS_SOURCE[mint] = "Pump.fun top holders"
        return got
    HOLDERS_SOURCE[mint] = "getTokenLargestAccounts"
    return top_holders_chain(mint, n)


def top_holders_pumpfun(mint: str, n: int = 20) -> list[str] | None:
    """Pump.fun's list for a coin Pump.fun knows; None if it is not a Pump.fun coin, the list is unreadable, or no
    wallet is left once programs are taken out (an empty answer is not a reading: the chain is asked instead)."""
    import pumpfun_api as P
    if not P.coin(mint):
        return None
    rows = P.top_holders(mint)
    if rows is None:
        return None
    HOLDERS_ROWS[mint] = {"source": "Pump.fun top holders", "rows": [
        {"wallet": r["address"], "amount": r.get("amount"), "program": _is_program_account(r["address"]),
         "dev": r.get("isDev") is True, "sniper": r.get("isSniper") is True, "bundler": r.get("isBundler") is True} for r in rows]}
    owners = []
    for r in rows:
        a = r["address"]
        if a not in owners and not _is_program_account(a):
            owners.append(a)
    return owners[:n] or None


def top_holders_chain(mint: str, n: int = 20) -> list[str] | None:
    r = rpc("getTokenLargestAccounts", [mint])
    if not isinstance(r, dict) or "value" not in r:
        return None
    from solana_rpc import pmap
    infos = pmap(lambda a: rpc("getAccountInfo", [a["address"], {"encoding": "jsonParsed"}]), r["value"][:n + 5])
    owners, rows = [], []
    for a, v in zip(r["value"][:n + 5], infos):
        o = (((v or {}).get("value") or {}).get("data") or {}).get("parsed", {}).get("info", {}).get("owner")
        if not o:
            continue
        prog = _is_program_account(o)
        if not prog:
            owners.append(o)
        if len(rows) < n:                                      # S5: a coin whose whole supply sits in a program's
            rows.append({"wallet": o, "amount": a.get("uiAmount"), "program": prog})   # account (a pool or a locker) was
    HOLDERS_ROWS[mint] = {"source": "getTokenLargestAccounts", "rows": rows}   # "not read": the read is kept, programs marked
    return owners[:n]
