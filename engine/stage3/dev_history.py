"""Dev-history reader (Stage 3, step 2), built on the chain's standard methods.

For one dev wallet it gathers, each with a receipt:
- launches: tokens this wallet created (CREATE transactions it paid for) -> launch count, serial-launcher cap
- duplicates: launches that share a name or symbol (and image, when known)
- conduct on one token: every buy and sell of that mint by the wallet, and % of what it acquired that it
  sold by 5 minutes, 1 hour and 24 hours after launch
- first funding: the oldest incoming SOL transfer, and who sent it

Cost control: every request is counted under its node; a page cap stops long histories. If the cap is hit before the
start of the wallet's history, results that need the full history are marked incomplete (never guessed).
"""
from __future__ import annotations
import json, os, re, sys, time, urllib.error, urllib.request
from collections import defaultdict
from typing import Optional

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "stage2"))
import solana_rpc as S

LAMPORTS = 1_000_000_000


def free_history(address: str, limit: int, until: Optional[str] = None):
    """Helius.history's answer (newest first, parsed fields, successful only) from free standard calls.
    (txs, reached_start). If the transactions cannot all be read: ([], False), never a shorter list."""
    items, end = S.sigs_desc(address, limit=limit, until=until)
    if items is None:
        return [], False
    txs = S.fetch_txs([x["signature"] for x in items if not x.get("err")])
    if txs is None:
        return [], False
    return txs, end


FREE_CREATES_MAX_TXS = 3000            # without Helius, past launches are found by reading every transaction: capped


def _counted(name: str, answered: bool) -> None:
    try:                                  # the saved request count per source (`scanner.py status`); never in the way
        S.count(name, answered)
    except Exception:
        pass


class ChainHistory:
    """A wallet's history from the chain's standard methods only: signatures, then the transactions in
    batches, rebuilt to one parsed shape (`free_history`, `S.fetch_txs`). No key and no provider-only API: any node in
    the rotation serves it. The name `Helius` is kept as an alias so no caller changes."""

    def __init__(self, key: Optional[str] = None):
        self.calls = 0                             # kept for the callers' receipts: no provider-only call is made

    def history(self, address: str, max_pages: int = 20):
        """Newest first. Returns (transactions, reached_start_of_history)."""
        return free_history(address, max_pages * 100)

    def _creates_window(self, address: str, start: Optional[str], until: Optional[str], max_calls: int):
        """Creations between `start` (exclusive, newer side) and `until` (exclusive, older side): every transaction in
        the stretch read (capped); too many to read is None (unknown), never a partial count."""
        items, end = S.sigs_desc(address, limit=FREE_CREATES_MAX_TXS + 1, until=until)
        if items is None or len(items) > FREE_CREATES_MAX_TXS:
            return None
        if start:
            k = next((i for i, x in enumerate(items) if x["signature"] == start), None)
            items = items[k + 1:] if k is not None else items
        txs = S.fetch_txs([x["signature"] for x in items if not x.get("err")])
        return None if txs is None else [t for t in txs if t.get("type") == "CREATE"]

    def creates(self, address: str, max_calls: int = 600, windows: int = 8):
        """Only this wallet's token-creation transactions, complete to the start of its history: every transaction read
        (up to the cap). Returns (txs, complete); past the cap ([], False), unknown, never a partial count."""
        res = self._creates_window(address, None, None, max_calls)
        return (res or []), res is not None

    def assets(self, mints: list[str]) -> dict:
        """Names/symbols/images per mint from the tokens' own metadata on chain (`readers.free_assets`)."""
        from readers import free_assets
        return free_assets(mints)


Helius = ChainHistory                              # the old name, so callers and receipts need no change


# ------------------------------------------------------------------ pure analysis (tested offline)
def launches(txs: list[dict], dev: str) -> list[dict]:
    """CREATE transactions this wallet paid for, oldest first."""
    found = {}
    for t in txs:
        if t.get("type") != "CREATE" or t.get("feePayer") != dev:
            continue
        mints = {x["mint"] for x in t.get("tokenTransfers") or [] if x.get("mint")}
        for acc in t.get("accountData") or []:
            for b in acc.get("tokenBalanceChanges") or []:
                mints.add(b.get("mint"))
        mints.discard(None)
        mints.discard("So11111111111111111111111111111111111111112")
        for m in mints:
            if m not in found or t["timestamp"] < found[m]["timestamp"]:
                found[m] = {"mint": m, "timestamp": t["timestamp"], "signature": t["signature"],
                            "source": t.get("source")}
    return sorted(found.values(), key=lambda x: x["timestamp"])


def duplicates(launch_list: list[dict], meta: dict) -> list[list[str]]:
    """Groups of the dev's own launches sharing a name, a symbol or an image."""
    groups = []
    for field in ("name", "symbol", "image"):
        by = defaultdict(list)
        for l in launch_list:
            v = (meta.get(l["mint"]) or {}).get(field)
            if v:
                by[str(v).strip().lower()].append(l["mint"])
        groups += [sorted(g) for g in by.values() if len(g) > 1]
    uniq = []
    for g in groups:
        if g not in uniq:
            uniq.append(g)
    return uniq


def conduct(txs: list[dict], dev: str, mint: str, launch_ts: int) -> dict:
    """Every movement of `mint` in or out of the dev wallet, and % of acquired tokens sold by each horizon."""
    moves = []
    for t in sorted(txs, key=lambda x: x["timestamp"]):
        for x in t.get("tokenTransfers") or []:
            if x.get("mint") != mint:
                continue
            amt = float(x.get("tokenAmount") or 0)
            if x.get("toUserAccount") == dev and x.get("fromUserAccount") != dev:
                moves.append({"t": t["timestamp"], "dir": "in", "amount": amt, "kind": t.get("type"),
                              "signature": t["signature"], "counterparty": x.get("fromUserAccount")})
            elif x.get("fromUserAccount") == dev and x.get("toUserAccount") != dev:
                moves.append({"t": t["timestamp"], "dir": "out", "amount": amt, "kind": t.get("type"),
                              "signature": t["signature"], "counterparty": x.get("toUserAccount")})
    acquired = sum(m["amount"] for m in moves if m["dir"] == "in")
    out = {"moves": moves, "acquired": acquired, "never_bought": acquired == 0}
    for label, secs in (("5m", 300), ("1h", 3600), ("24h", 86400)):
        sold = sum(m["amount"] for m in moves if m["dir"] == "out" and m["t"] <= launch_ts + secs)
        out[f"pct_out_{label}"] = None if acquired == 0 else min(1.0, sold / acquired)
    out["pct_out_now"] = None if acquired == 0 else min(1.0, sum(m["amount"] for m in moves if m["dir"] == "out") / acquired)
    return out


def conduct_from_balances(txs: list[dict], dev: str, mint: str, launch_ts: int) -> dict:
    """Same output as conduct(), but measured from the dev's actual token-balance changes in each
    transaction (accountData.tokenBalanceChanges), not from transfer labels. Labels can be wrong:
    Helius attributes a Pump CREATE's 793.1M curve tokens to the creator (facts section 13)."""
    moves = []
    for t in sorted(txs, key=lambda x: x["timestamp"]):
        delta = 0.0
        for acc in t.get("accountData") or []:
            for b in acc.get("tokenBalanceChanges") or []:
                if b.get("userAccount") == dev and b.get("mint") == mint:
                    r = b.get("rawTokenAmount") or {}
                    delta += int(r.get("tokenAmount", 0)) / 10 ** int(r.get("decimals", 0))
        if delta:
            moves.append({"t": t["timestamp"], "dir": "in" if delta > 0 else "out", "amount": abs(delta),
                          "kind": t.get("type"), "signature": t["signature"], "counterparty": None})
    acquired = sum(m["amount"] for m in moves if m["dir"] == "in")
    out = {"moves": moves, "acquired": acquired, "never_bought": acquired == 0}
    for label, secs in (("5m", 300), ("1h", 3600), ("24h", 86400)):
        sold = sum(m["amount"] for m in moves if m["dir"] == "out" and m["t"] <= launch_ts + secs)
        out[f"pct_out_{label}"] = None if acquired == 0 else min(1.0, sold / acquired)
    out["pct_out_now"] = None if acquired == 0 else min(1.0, sum(m["amount"] for m in moves if m["dir"] == "out") / acquired)
    return out


def first_funding(txs: list[dict], dev: str, reached_start: bool) -> Optional[dict]:
    """Oldest incoming SOL transfer. Only reported when the whole history was read."""
    if not reached_start:
        return None
    for t in sorted(txs, key=lambda x: x["timestamp"]):
        for n in t.get("nativeTransfers") or []:
            if n.get("closed_account"):
                continue                            # SOL back from closing one's own token account is not funding
            if n.get("toUserAccount") == dev and n.get("fromUserAccount") != dev and n.get("amount", 0) > 0:
                return {"from": n["fromUserAccount"], "sol": n["amount"] / LAMPORTS,
                        "timestamp": t["timestamp"], "signature": t["signature"]}
    return None


LAUNCHPAD_LIST_MAX = 300                # most of a dev's coins read from the launchpads' lists (6 Pump.fun pages)
LAUNCHPAD_SAMPLE = 5                    # listed coins whose creation transaction is checked on chain


def launchpad_launches(dev: str):
    """The dev's past launches from the launchpads' own creator lists (source map 2026-10-06): Pump.fun
    `coins-v2/user-created-coins` and Raydium LaunchLab `get/by/user` (StonkFun, LetsBonk). Every listed coin is checked
    on chain in bulk: its bonding curve / pool must name this wallet as creator; coins that do not are dropped.
    Returns (launches, complete, receipt, total) or None if neither list could be read. complete = every coin the launchpads
    list for this wallet was read and checked. total = the launchpads' OWN count of this wallet's coins (Pump.fun's `count`,
    plus LaunchLab's rows when its list was read to the end), for the serial-launcher cap: the walked list
    stops at LAUNCHPAD_LIST_MAX and cannot reach that line; None when a list was cut off or unreadable. Launch dicts: mint, timestamp, signature (None), source, name, symbol, image."""
    import base64
    import pumpfun_api as PF
    from readers import PUMP, LAUNCHLAB, http_json
    from b58 import b58d, b58e, pda
    out, complete, parts, any_ok = [], True, [], False
    # Pump.fun: its list is by LAUNCHER (the wallet that created the coin; measured 2026-10-10). Pages can be short, so
    # the list ends only at an empty page. Chain check: a random sample of the listed coins' creation transactions must
    # show this wallet as the launcher (the curve's "creator" is the fee receiver and can change, so it is not used).
    coins, total, off, ended = [], None, 0, False
    while off < LAUNCHPAD_LIST_MAX:
        r = PF._get(f"{PF.FRONT}/coins-v2/user-created-coins/{dev}?limit=50&offset={off}&includeNsfw=true")
        if not isinstance(r, dict) or not isinstance(r.get("coins"), list):
            coins = None
            break
        cnt = r.get("count")                                           # Pump.fun's own total; missing stays missing (E1)
        total = int(cnt) if isinstance(cnt, int) and not isinstance(cnt, bool) and cnt >= 0 else None
        if not r["coins"]:
            ended = True
            break
        coins += r["coins"]
        off += 50
    if coins is not None:
        any_ok = True
        listed = len(coins)
        coins = [c_ for c_ in coins if c_.get("creator") == dev]          # only rows Pump.fun records under this wallet
        import random
        rnd = random.Random(dev)                                          # same sample every time for the same wallet
        sample = rnd.sample(coins, min(LAUNCHPAD_SAMPLE, len(coins)))
        checked = [PF.creation(c_["mint"]) for c_ in sample]
        good = sum(1 for cr in checked if cr and cr["launcher"] == dev)
        bad = sum(1 for cr in checked if cr and cr["launcher"] != dev)    # unreadable samples are neither
        if sample and (bad or not good):
            parts.append(f"Pump.fun lists {total} coins for this wallet; sampled creation transactions: {good} confirm it as "
                         f"launcher, {bad} name another wallet, {len(sample) - good - bad} unreadable: list not used")
            complete = False
            total = None                                                  # a list the engine refused states nothing (E2)
        else:
            for c_ in coins:
                out.append({"mint": c_["mint"], "timestamp": int(c_.get("created_timestamp") or 0) // 1000, "signature": None,
                            "source": "PUMP_FUN", "name": c_.get("name"), "symbol": c_.get("symbol"), "image": c_.get("image_uri")})
            if not ended or total != listed:
                complete = False                   # the list was cut off or its count disagrees: a minimum, never a total
            parts.append(f"Pump.fun lists {total if total else 'an unstated number of'} coins launched by this wallet; "
                         f"{len(coins)} read{'' if complete else ' (a minimum)'}; {good} of {good + bad} readable sampled "
                         f"creation transactions confirm it as launcher")
    # Raydium LaunchLab (StonkFun, LetsBonk, ...)
    rows, page_id = [], None
    while len(rows) < LAUNCHPAD_LIST_MAX:
        u = f"https://launch-mint-v1.raydium.io/get/by/user?wallet={dev}&size=100" + (f"&nextPageId={page_id}" if page_id else "")
        r = http_json(u, tries=2)
        d = (r or {}).get("data") if isinstance(r, dict) and r.get("success") else None
        if d is None:
            rows = None
            break
        rows += d.get("rows") or []
        page_id = d.get("nextPageId")
        if not page_id or not d.get("rows"):
            break
    if rows is not None:
        any_ok = True
        if page_id:
            complete = False
        ok_n = 0
        for i in range(0, len(rows), 100):
            part = rows[i:i + 100]
            res = S.rpc("getMultipleAccounts", [[x["poolId"] for x in part], {"encoding": "base64"}])
            vals = res.get("value") if isinstance(res, dict) and "ERROR" not in res else None
            if vals is None:
                complete = False
                continue
            for x, v in zip(part, vals):
                raw = base64.b64decode(v["data"][0]) if v and v.get("owner") == LAUNCHLAB else b""
                if len(raw) >= 365 and b58e(raw[333:365]) == dev and b58e(raw[205:237]) == x["mint"]:
                    ok_n += 1
                    out.append({"mint": x["mint"], "timestamp": int(x.get("createAt") or 0) // 1000, "signature": None,
                                "source": "RAYDIUM_LAUNCHLAB", "name": x.get("name"), "symbol": x.get("symbol"), "image": x.get("imgUrl")})
        if rows:
            parts.append(f"Raydium LaunchLab lists {len(rows)}{'+' if page_id else ''} coins; {ok_n} confirmed on chain (pool creator)")
    if not any_ok:
        return None
    seen, uniq = set(), []
    for l in sorted(out, key=lambda x: x["timestamp"]):
        if l["mint"] not in seen:
            seen.add(l["mint"]); uniq.append(l)
    stated = None                                                         # the launchpads' own total (W2)
    if coins is not None and isinstance(total, int) and rows is not None and not page_id:   # Pump.fun stated a count for an accepted list, LaunchLab read to its end
        stated = total + len(rows)                                        # Pump.fun's count + LaunchLab's list read to its end
    return uniq, complete, "; ".join(parts) or "no launchpad lists this wallet as a creator", stated


def dev_report(dev: str, focus_mint: Optional[str] = None, max_pages: int = 20, h: Optional[Helius] = None) -> dict:
    got = launchpad_launches(dev)
    if got is not None:                        # launchpads' own creator lists, each coin confirmed on chain
        ls, complete, receipt, stated = got
        meta = {l["mint"]: {"name": l.get("name"), "symbol": l.get("symbol"), "image": l.get("image")} for l in ls}
        return {"dev": dev, "transactions_read": 0, "full_history_read": complete,
                "launch_count": len(ls), "launch_count_is_lower_bound": not complete, "launchpad_total": stated,
                "launches": ls, "duplicate_groups": duplicates(ls, meta), "first_funding": None,
                "source": receipt, "helius_calls": 0, "as_of": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())}
    h = h or Helius()
    import sol_cache                           # history only grows: read what's new, keep the rest (identical results)
    txs, complete = sol_cache.history(h, dev, max_pages=max_pages)
    created, created_complete = sol_cache.creates(h, dev)
    ls = launches(created + txs, dev)          # creations-only history gives a complete launch count
    meta = sol_cache.assets(h, [l["mint"] for l in ls]) if ls else {}
    rep = {"dev": dev, "transactions_read": len(txs), "full_history_read": complete,
           "launch_count": len(ls), "launch_count_is_lower_bound": not created_complete, "launchpad_total": None,
           "launches": [dict(l, **(meta.get(l["mint"]) or {})) for l in ls],
           "duplicate_groups": duplicates(ls, meta),
           "first_funding": first_funding(txs, dev, complete),
           "helius_calls": None, "as_of": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())}
    if focus_mint:
        lt = next((l["timestamp"] for l in ls if l["mint"] == focus_mint), None)
        rep["focus"] = {"mint": focus_mint, "launch_timestamp": lt,
                        **(conduct(txs, dev, focus_mint, lt) if lt else {"note": "launch not found in history read"})}
    rep["helius_calls"] = h.calls
    return rep


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("usage: python3 dev_history.py <dev wallet> [focus mint] [max pages]"); sys.exit(2)
    r = dev_report(sys.argv[1], sys.argv[2] if len(sys.argv) > 2 else None,
                   int(sys.argv[3]) if len(sys.argv) > 3 else 20)
    print(json.dumps(r, indent=1, default=str))
