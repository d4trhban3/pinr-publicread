"""a design decision / 249 (CHAINS): new coins on BNB Chain from the launchpads' factory events, read with the standard
`eth_getLogs` on free public nodes (no key, no stream we decode ourselves). Four.meme's own API refuses servers (403,
re-tested 2026-10-25) and Flap has no open list, so the chain is the only open route (facts/LAUNCHPAD-ROUTES.md).

Events, as the engine's stage-4 readers verified them against the chain (stage4/fourmeme_reader.py, flap_reader.py):
  - Four.meme TokenManager2 `TokenCreate(address creator, address token, uint256 requestId, string name, string symbol,
    uint256 totalSupply, uint256 launchTime, uint256 launchFee)`; launchTime 0 means "at once": the block's own time;
  - Flap Portal `TokenCreated(uint256 ts, address creator, uint256 nonce, address token, string name, string symbol,
    string meta)`; `meta` is the IPFS id of the coin's metadata document (picture and links).
Missing stays missing: a range no node served is read again next pass, never skipped."""
from __future__ import annotations
import json, os, sys, time, urllib.error, urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "stage4"))
from evm import topic, words, dec, dec_string                 # pure ABI helpers (no network, no key)

CHAIN = "bsc"
FOUR_MANAGER = "0x5c952063c7fc8610ffdb798152d69f0b9550762b"
FLAP_PORTAL = "0xe2ce6ab80874fa9fa2aae65d277dd6b8e65c9de0"
FOUR_CREATE = topic("TokenCreate(address,address,uint256,string,string,uint256,uint256,uint256)")
FLAP_CREATE = topic("TokenCreated(uint256,address,uint256,address,string,string,string)")
FACTORIES = {"fourmeme": (FOUR_MANAGER, FOUR_CREATE), "flap": (FLAP_PORTAL, FLAP_CREATE)}
# Free keyless BNB log sources in order, blocks a call (stage4/evm.py LOG_SOURCES, measured 2026-10-10; Ankr left out:
# it needs a key). PublicNode keeps about the last hour; NodeReal's public endpoint reaches further back.
NODES = [("https://bsc-rpc.publicnode.com", 2000), ("https://bsc-mainnet.nodereal.io/v1/64a9df0874fb4a93b9d0a3849de012d3", 5000)]
SAFE_BEHIND = 3                     # blocks behind the tip, so every node has them
FIRST_BACK = 8000                   # a first start reads about the last hour (0.45 s blocks)
MAX_CALLS = 8                       # log calls a pass at most; a longer gap is caught up over the next passes
GAP_TRIES = 10                      # passes in a row no node served a range: its old part is noted as a gap and passed over
                                    # 
RECENT_KEEP = 8000                  # ... but never the last ~hour (PublicNode keeps it): an outage of both nodes is waited out
                                    # 
GAP_S = 0.25


def _post(url: str, method: str, params: list, timeout: int = 20):
    """The JSON-RPC result, or None (refused, failed, or an error answer)."""
    try:
        req = urllib.request.Request(url, json.dumps({"jsonrpc": "2.0", "id": 1, "method": method, "params": params}).encode(),
                                     {"content-type": "application/json", "User-Agent": "PINR-live/1.0 (read-only chain logs)"})
        with urllib.request.urlopen(req, timeout=timeout) as r:
            body = json.loads(r.read())
    except Exception:
        return None
    return body.get("result") if isinstance(body, dict) and "error" not in body else None


def head(post=_post) -> int | None:
    for url, _cap in NODES:
        r = post(url, "eth_blockNumber", [])
        if isinstance(r, str):
            return int(r, 16)
    return None


def block_time(n: int, post=_post, cache: dict | None = None) -> float | None:
    if cache is not None and n in cache:
        return cache[n]
    for url, _cap in NODES:
        b = post(url, "eth_getBlockByNumber", [hex(n), False])
        if isinstance(b, dict) and b.get("timestamp"):
            t = float(int(b["timestamp"], 16))
            if cache is not None:
                cache[n] = t
            return t
    return None


SQD_FIRST = True                    # SQD Portal first (keyless; matched the public nodes 35/35 on 2026-10-25)


def logs(address: str, topic0: str, lo: int, hi: int, post=_post, sleep=time.sleep, senders: bool = False) -> list | None:
    """Every log of one event (or a list of events) for blocks lo..hi: SQD Portal first, then the first public node that
    serves the whole range; None if none did. Stand-in nodes (tests) are asked directly."""
    if SQD_FIRST and post is _post:
        import sqd_evm
        got = sqd_evm.logs(CHAIN, address, topic0, lo, hi, senders=senders)    # the public nodes give no sender
        if got is not None:
            return got
    for url, cap in NODES:
        out, a, ok = [], lo, True
        while a <= hi:
            b = min(a + cap - 1, hi)
            r = post(url, "eth_getLogs", [{"address": address, "topics": [topic0], "fromBlock": hex(a), "toBlock": hex(b)}])
            sleep(GAP_S)
            if not isinstance(r, list):
                ok = False
                break
            out += r
            a = b + 1
        if ok:
            return out
    return None


def decode(kind: str, log: dict) -> dict | None:
    """One creation event as a record; None when it is not the event or cannot be read."""
    try:
        if (log.get("topics") or [None])[0] != FACTORIES[kind][1] or log.get("removed"):
            return None
        d, w = log["data"], words(log["data"])
        blk = int(log["blockNumber"], 16)
        bts = log.get("blockTimestamp")
        bts = float(int(bts, 16)) if isinstance(bts, str) and bts.startswith("0x") else None
        if kind == "fourmeme":
            lt = dec(w[6], "uint256")
            return {"mint": dec(w[1], "address").lower(), "chain": "bsc", "launchpad": "Four.meme", "by": "fourmeme_chain",
                    "creator": dec(w[0], "address").lower(), "name": dec_string(d, w[3]), "ticker": dec_string(d, w[4]),
                    "launched_at": float(lt) if lt else bts, "block": blk, "launch_tx": log.get("transactionHash"), "image": None,
                    "launch_sender": _sender(log)}
        return {"mint": dec(w[3], "address").lower(), "chain": "bsc", "launchpad": "Flap", "by": "flap_chain",
                "creator": dec(w[1], "address").lower(), "name": dec_string(d, w[4]), "ticker": dec_string(d, w[5]),
                "launched_at": float(dec(w[0], "uint256")) or bts, "block": blk, "launch_tx": log.get("transactionHash"),
                "meta_uri": ("ipfs://" + dec_string(d, w[6])) if dec_string(d, w[6]) else None, "image": None,
                "launch_sender": _sender(log)}
    except Exception:
        return None


def _sender(log: dict) -> str | None:
    """The wallet that sent the log's transaction, as SQD gives it (checklist 6: the person behind a launch-service creator)."""
    s = log.get("txFrom")
    return s.lower() if isinstance(s, str) and s.startswith("0x") and len(s) == 42 else None


def launch_sender(block: int, tx: str, post=_post, sleep=time.sleep, sqd_logs=None) -> tuple | None:
    """Who sent a past launch transaction, and through what it was read: (wallet, "SQD Portal") from its own block's factory
    logs replayed with their senders (one block, one short call); when SQD cannot answer (busy, refused: 529 since about
    05:15 UTC on 26 Oct), (wallet, "a public BNB node") from the transaction itself. ("", source) when it was read and names
    none; None when neither could be read (missing stays missing: the caller tries again later, never marks it done)."""
    import sqd_evm
    sqd_logs = sqd_logs or sqd_evm.logs
    read = False
    for kind, (address, t0) in FACTORIES.items():
        got = sqd_logs(CHAIN, address, t0, block, block, senders=True)
        if got is None:
            read = False
            break
        read = True
        for l in got:
            if str(l.get("transactionHash") or "").lower() == str(tx).lower():
                return (_sender(l) or "", "SQD Portal")
    if read:
        return ("", "SQD Portal")                              # both factories' logs of that block read: none is this launch
    r = post(NODES[0][0], "eth_getTransactionByHash", [tx])   # the fallback, named as such
    if isinstance(r, dict) and isinstance(r.get("from"), str) and r["from"].startswith("0x"):
        return (r["from"].lower(), "a public BNB node")
    return None


def _advance(kinds: dict, cursors: dict, post, sleep, fails: dict, gaps: list, tip: int) -> tuple[dict, dict]:
    """For each kind {kind: (address, topic0 or [topics])}: the logs since its cursor, at most MAX_CALLS calls. Returns
    ({kind: (logs, from, to)} for each range read, new cursors). The gap rule of one_pass applies to every kind."""
    got_all, cur = {}, dict(cursors)
    for kind, (address, t0) in kinds.items():
        lo = (cur.get(kind) or (tip - FIRST_BACK)) + 1
        hi = min(tip, lo + NODES[0][1] * MAX_CALLS - 1)
        if hi < lo:
            continue
        got = logs(address, t0, lo, hi, post, sleep, senders=True)   # each trade's and each launch's transaction sender (SQD; none from a public node)
        if got is None:
            fails[kind] = fails.get(kind, 0) + 1
            old_end = min(hi, tip - RECENT_KEEP)
            if fails[kind] >= GAP_TRIES and old_end >= lo:
                gaps.append((kind, lo, old_end))
                cur[kind], fails[kind] = old_end, 0
            continue
        fails[kind] = 0
        got_all[kind] = (got, lo, hi)
        cur[kind] = hi
    return got_all, cur


def one_pass(cursors: dict, post=_post, sleep=time.sleep, fails: dict | None = None, gaps: list | None = None) -> tuple[list, dict]:
    """New coins since each factory's cursor (the last block read), at most MAX_CALLS log calls each. Returns (records,
    new cursors); a factory whose range no node served keeps its cursor (read again next pass). After GAP_TRIES such
    passes in a row (`fails` keeps the count between passes) the part of the range older than RECENT_KEEP blocks is appended
    to `gaps` as (kind, from, to) and the cursor moves past it; a recent range is always waited for. Missing stays missing,
    written down, never silently skipped."""
    fails = {} if fails is None else fails
    gaps = [] if gaps is None else gaps
    tip = head(post)
    if tip is None:
        return [], dict(cursors)
    tip -= SAFE_BEHIND
    got_all, cur = _advance(FACTORIES, cursors, post, sleep, fails, gaps, tip)
    out, times = [], {}
    for kind, (got, _lo, _hi) in got_all.items():
        for l in got:
            r = decode(kind, l)
            if r is None:
                continue
            if not r.get("launched_at"):
                r["launched_at"] = block_time(r["block"], post, times)
            out.append(r)
    return out, cur


# The launchpads' own buy and sell events (verified: stage4/fourmeme_reader.py; Flap's published ABI, flap_portal_abi.json).
# On 2026-10-25 every token movement of 90 sampled curve coins through the launchpad contract had its trade event, so a
# coin with no event in a fully watched day had no curve trade that day (the design's quiet rule for curve coins, which
# DexScreener does not list).
FOUR_BUY = topic("TokenPurchase(address,address,uint256,uint256,uint256,uint256,uint256,uint256)")
FOUR_SELL = topic("TokenSale(address,address,uint256,uint256,uint256,uint256,uint256,uint256)")
FLAP_BUY = topic("TokenBought(uint256,address,address,uint256,uint256,uint256,uint256)")
FLAP_SELL = topic("TokenSold(uint256,address,address,uint256,uint256,uint256,uint256)")
TRADES = {"fourmeme_trades": (FOUR_MANAGER, [FOUR_BUY, FOUR_SELL]), "flap_trades": (FLAP_PORTAL, [FLAP_BUY, FLAP_SELL])}
LAUNCHPAD_OF = {"fourmeme_trades": "Four.meme", "flap_trades": "Flap"}


def trades_pass(cursors: dict, post=_post, sleep=time.sleep, fails: dict | None = None, gaps: list | None = None, sink: list | None = None,
                ticks_out: list | None = None):
    """Each curve coin's latest trade since the trade cursors. Returns ({coin: latest trade time}, new cursors,
    {kind: (time of the first block of the range read, time of its last block)} for each kind read this pass) -- the
    caller keeps when its unbroken watch began and the time it has read up to (the team's F1 on 7bc10730: a lagging
    watch must never judge a coin against the clock). Four.meme's events carry no time: the log's `blockTimestamp` (PublicNode and NodeReal give it), else the
    block's own time, read once a block. `sink`: each trade as (coin, sender, event wallet, "buy"/"sell", time, transaction,
    block), for chains/bots.py; the sender is None when the range came from a public node (it gives none).
    `ticks_out`: each trade as (kind, coin, side, time, transaction, log index, tokens raw, quote raw, the launchpad's own price
    raw), for chains/ticks_evm.py (line 11)."""
    fails = {} if fails is None else fails
    gaps = [] if gaps is None else gaps
    tip = head(post)
    if tip is None:
        return {}, dict(cursors), {}
    tip -= SAFE_BEHIND
    got_all, cur = _advance(TRADES, cursors, post, sleep, fails, gaps, tip)
    last, times, began = {}, {}, {}
    for kind, (got, lo, hi) in got_all.items():
        began[kind] = (block_time(lo, post, times), block_time(hi, post, times))
        decode_trades(kind, got, post, times, last, sink, ticks_out)
    return last, cur, began


def decode_trades(kind: str, got: list, post, times: dict, last: dict, sink: list | None = None, ticks_out: list | None = None) -> None:
    """One kind's trade logs into `last` ({coin: newest trade time}), `sink` and `ticks_out` (as trades_pass says)."""
    for l in got:
        try:
            if l.get("removed") or (l.get("topics") or [None])[0] not in TRADES[kind][1]:
                continue
            w = words(l["data"])
            side = "buy" if l["topics"][0] in (FOUR_BUY, FLAP_BUY) else "sell"
            if kind == "flap_trades":
                mint, t = dec(w[1], "address").lower(), float(dec(w[0], "uint256"))
                who = dec(w[2], "address").lower()
            else:                                              # the log's own block time (both nodes give it), else the block's
                bts = l.get("blockTimestamp")
                t = float(int(bts, 16)) if isinstance(bts, str) and bts.startswith("0x") else block_time(int(l["blockNumber"], 16), post, times)
                mint = dec(w[0], "address").lower()
                who = dec(w[1], "address").lower()
        except Exception:
            continue
        if sink is not None and t:
            try:
                sink.append((mint, l.get("txFrom"), who, side, t, l.get("transactionHash"), int(l["blockNumber"], 16)))
            except Exception:
                pass
        if ticks_out is not None and t:
            try:                                               # Four.meme: price, amount, cost; Flap: amount, quote moved, fee, postPrice
                amount, paid = (dec(w[3], "uint256"), dec(w[4], "uint256"))
                price = dec(w[6] if kind == "flap_trades" else w[2], "uint256")
                ticks_out.append((kind, mint, side, t, l.get("transactionHash"), int(l.get("logIndex") or "0x0", 16), amount, paid, price))
            except Exception:
                pass
        if t and t > last.get(mint, 0):
            last[mint] = t
