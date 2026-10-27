"""Checklist 6, CHAINS: a Base/BNB coin's funding source, the Funders group of its evidence trail (●), the way
stage3/funding_source.py traces it for Solana: the creator's oldest incoming ETH/BNB transfer and who sent it, then that
wallet's, up to HOPS wallets back. The trace stops at a wallet that is not fresh (its first funding came more than
linked_wallets.FRESH_DAYS before the moment it mattered: the launch for the creator, the payment it made for a funder), at
a wallet with no incoming transfer in its history, at a contract, or at one that could not be read.

Only a person's wallet is traced: a creator that is a contract (a launch service such as a Flap
or Four.meme router, or a smart wallet) is not, because its oldest incoming payment is whoever first paid the service, not the
creator's money. Checklist 6:
the person behind such a launch is the wallet that sent the launch transaction, which SQD gives with the factory event
(chains/bnb.py; for past launches, their own block replayed): a ● "launched by" row, and that wallet's funding is traced. A wallet with no code is a person's, and so is one whose code is only an
EIP-7702 delegation (0xef0100 + an address: still the person's own key). A funder that is a contract is shown (it did pay) but
not followed.

Read by stage4/flap_reader.first_funding (Alchemy's transfer history on the official key, counted under its cap). Network
reads first, then short writes. A trace with an unread wallet keeps the rows it read and is tried again later (at most
TRIES times); a creator with no incoming transfer gets no row, so its group still says "not checked yet" (never "none")."""
from __future__ import annotations
import os, sys, time

HERE = os.path.dirname(os.path.abspath(__file__))
for _p in ("../stage3", "../stage4"):
    sys.path.insert(0, os.path.join(HERE, _p))

HOPS = 3
FUNDING_VER = 2                        # 2: a launch service's creator is followed through the launch transaction's sender (checklist 6)
LAUNCH_SOURCE = "BNB chain (the launch transaction's sender, read through {via})"
TRIES = 3
RETRY_S = 3600
FRESH_DAYS = 7                       # as linked_wallets.FRESH_DAYS (stage3); read from it when it imports
try:
    from linked_wallets import FRESH_DAYS
except Exception:
    pass
EXPLORER = {"base": "https://basescan.org", "bsc": "https://bscscan.com"}
SOURCE = "Alchemy transfer records (the wallet's oldest incoming {unit})"


CODE_FN = None                       # the code read when none is given (the tests put a stand-in here)
SHOWN_FN = None                      # the site's list when none is given (the tests put a stand-in here)
SENDER_FN = None                     # the launch sender's read when none is given (the tests put a stand-in here)
DELEGATION = "0xef0100"             # EIP-7702: a person's wallet that delegates to code keeps this prefix and an address


def is_person(chain: str, wallet: str, code_fn=None) -> bool | None:
    """True for a wallet with no code (or only a 7702 delegation), False for a contract, None when its code was not read."""
    code_fn = code_fn or CODE_FN
    if code_fn is None:
        from evm import rpc
        code_fn = lambda ch, w: rpc(ch, "eth_getCode", [w, "latest"])
    code = code_fn(chain, wallet)
    if not isinstance(code, str):
        return None
    code = code.lower()
    return code in ("0x", "") or (code.startswith(DELEGATION) and len(code) == len(DELEGATION) + 40)


def trace(chain: str, creator: str, launch_ts: float | None, first_fn=None, code_fn=None, sender: str | None = None) -> tuple[list, bool]:
    """([hop, ...], complete): each hop {"wallet", "funder", "value", "unit", "funded_at", "tx", "block"}, creator first.
    complete is False when a wallet on the way could not be read. `sender`: who sent the launch transaction; traced in the
    creator's place when the creator is a contract and the sender a person."""
    if first_fn is None:
        import flap_reader as FL
        first_fn = FL.first_funding
    hops, wallet, moment, seen = [], creator.lower(), launch_ts, set()
    for i in range(HOPS):
        seen.add(wallet)
        person = is_person(chain, wallet, code_fn)
        if person is None:
            return hops, False
        if not person and i == 0 and sender and sender.lower() != wallet:
            wallet = sender.lower(); seen.add(wallet)          # the launch service's creator: the person who sent the launch
            person = is_person(chain, wallet, code_fn)
            if person is None:
                return hops, False
        if not person:
            return hops, True                                  # a contract: not traced (the creator: no row; a funder: shown, not followed)
        f = first_fn(chain, wallet)
        if f is None:
            return hops, False
        if not f.get("funder"):
            return hops, True
        hops.append(f)
        fresh = moment is not None and f.get("funded_at") is not None and moment - f["funded_at"] <= FRESH_DAYS * 86400
        if not fresh or f["funder"] in seen:
            return hops, True
        wallet, moment = f["funder"], f["funded_at"]
    return hops, True


def rows(chain: str, mint: str, hops: list, launcher: str | None = None, launch_tx: str | None = None, via: str = "SQD Portal") -> list:
    ex = EXPLORER[chain]
    out = []
    if launcher:                                               # the person who sent a launch-service launch (SQD's transaction sender)
        out.append({"coin": mint, "from_kind": "token", "from_id": mint, "to_kind": "wallet", "to_id": launcher, "what": "launched by",
                    "value": None, "unit": None, "at": None, "source": LAUNCH_SOURCE.format(via=via) + (f", tx {launch_tx}" if launch_tx else ""),
                    "link": f"{ex}/tx/{launch_tx}" if launch_tx else f"{ex}/address/{launcher}", "onchain": 1, "receipt": "launch transaction sender"})
    for h in hops:
        tx = h.get("tx")
        out.append({"coin": mint, "from_kind": "wallet", "from_id": h["funder"], "to_kind": "wallet", "to_id": h["wallet"], "what": "funded",
                    "value": None if h.get("value") is None else str(h["value"]), "unit": h.get("unit"), "at": h.get("funded_at"),
                    "source": SOURCE.format(unit=h.get("unit") or "transfer") + (f", tx {tx}" if tx else ""),
                    "link": f"{ex}/tx/{tx}" if tx else f"{ex}/address/{h['funder']}", "onchain": 1, "receipt": "funding source"})
    return out


_LAST_LIST: dict = {"coins": None}


def _site_list() -> set | None:
    """The coins on the site's first page (the feed server on this machine). When it does not answer (an empty answer: the
    site never lists nothing), the last list it gave (the team's F1 on 59102803: an empty list for 30 s dropped that pass's
    trades); None before any list was read: the caller decides what that means."""
    try:
        import pinrbot as PB
        got = {m.lower() for m in PB._site_shown() if isinstance(m, str)}
    except Exception:
        got = set()
    if got:
        _LAST_LIST["coins"] = got
        return got
    return _LAST_LIST["coins"]


def one_pass(c, g, feed_dir: str, now: float | None = None, limit: int = 5, first_fn=None, code_fn=None, shown_fn=None, sender_fn=None) -> int:
    """Coins (not quiet, not bot launches) with a creator and no funding read yet, the site's listed coins first, then newest
    first: trace (network first), then the rows and the evidence file. A BNB coin read before the launch sender was kept
    (funding_ver below FUNDING_VER) is read again once. Rows written."""
    import evidence_evm as EE, evidence as EV
    now = now or time.time()
    shown = (shown_fn or SHOWN_FN or _site_list)() or set()   # no list yet: the newest first, as before
    due = ("creator IS NOT NULL AND bot_at IS NULL AND chain IN ('base', 'bsc') AND COALESCE(funding_tries, 0) < ? "
           "AND (funding_try_at IS NULL OR funding_try_at < ?) AND (funding_at IS NULL OR (chain='bsc' AND COALESCE(funding_ver, 0) < ?))")
    args = (TRIES, now - RETRY_S, FUNDING_VER)
    first = []
    if shown:
        ms = sorted(shown)
        first = c.execute(f"SELECT mint, chain, creator, launched_at FROM coins WHERE {due} AND mint IN ({','.join('?' * len(ms))}) "
                          "ORDER BY launched_at DESC", args + tuple(ms)).fetchall()
    rest = c.execute(f"SELECT mint, chain, creator, launched_at FROM coins WHERE {due} AND funding_at IS NULL ORDER BY launched_at DESC LIMIT 200",
                     args).fetchall()
    rows_ = first + [r for r in rest if r[0] not in {x[0] for x in first}]
    if not rows_:
        return 0
    try:
        quiet = {m for (m,) in g.execute(f"SELECT mint FROM quiet WHERE state='quiet' AND mint IN ({','.join('?' * len(rows_))})",
                                         [r[0] for r in rows_])}
    except Exception:
        quiet = set()
    try:
        import gate as G                                       # 271: no funding read for a bot launch
        bots = G.bot_mints(g)
    except Exception:
        bots = set()
    todo = [r for r in rows_ if r[0] not in quiet and r[0] not in bots][:limit]
    import bnb as B
    sender_fn = sender_fn or SENDER_FN or B.launch_sender
    got, senders = {}, {}
    for m, ch, cr, at in todo:                                 # network first (the launch sender, the trace); writes after
        s, tx, launcher, via, unread = None, None, None, "SQD Portal", False
        if ch == "bsc" and is_person(ch, cr, code_fn) is False:
            s, blk, tx = c.execute("SELECT launch_sender, block, launch_tx FROM coins WHERE mint=?", (m,)).fetchone()
            if not s and blk and tx:
                read = sender_fn(blk, tx)
                if read is None:
                    unread = True                              # the team's F1 on 65842868: not read is never "no sender"
                else:
                    s, via = read
                    senders[m] = s
            launcher = s if s and s.lower() != cr.lower() and is_person(ch, s, code_fn) else None
        hops, complete = trace(ch, cr, at, first_fn, code_fn, sender=launcher)
        got[m] = (ch, (hops, complete and not unread), launcher, tx, via)
    n = 0
    for m, s in senders.items():
        if s:
            c.execute("UPDATE coins SET launch_sender=? WHERE mint=?", (s, m))
    for m, (ch, (hops, complete), launcher, tx, via) in got.items():
        r = rows(ch, m, hops, launcher, tx, via)
        if r:
            n += EE.store(g, r, now)
            EV.write_coin_file(g, m, feed_dir)
        if complete:
            c.execute("UPDATE coins SET funding_at=?, funding_ver=? WHERE mint=?", (now, FUNDING_VER, m))
        else:
            c.execute("UPDATE coins SET funding_tries=COALESCE(funding_tries, 0) + 1, funding_try_at=? WHERE mint=?", (now, m))
    c.commit()
    return n
