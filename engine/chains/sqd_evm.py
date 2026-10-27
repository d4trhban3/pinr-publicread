"""SQD Portal (portal.sqd.dev, free and keyless) as the first source of Base and BNB logs: the
launchpads' creation and trade events and a coin's Transfer logs, by address and event topic, exactly as the chain published
them. Checked 2026-10-25 against the public nodes: 2,000 BNB blocks, the same 35 creation events, one request in 0.7 s.

Answers are given in eth_getLogs' own shape (address, topics, data, transactionHash, logIndex, blockNumber, blockTimestamp,
hex), so every reader keeps its decoder. Paced (one request at a time, PACE_S apart, the Portal's public limit kept under);
a busy answer (429/503) is waited out a few times, then the read is given up (None) and the caller's public nodes read it:
never a guess, never a partial range."""
from __future__ import annotations
import json, threading, time, urllib.error, urllib.request

PORTAL = "https://portal.sqd.dev/datasets/"
DATASET = {"bsc": "binance-mainnet", "base": "base-mainnet"}
UA = {"User-Agent": "PINR-live/1.0 (read-only; pinr.io)", "content-type": "application/json"}
PACE_S = 0.6                      # the Portal's public limit is about 20 requests per 10 s (its docs): kept under
BUSY_TRIES = 5
MAX_REQUESTS = 200                # requests for one range at most (each answers many blocks)
_lock = threading.Lock()
_last = [0.0]


def _post(url: str, body: dict | None, urlopen=None, sleep=time.sleep):
    """The answer's text, or None (refused, failed, or busy after BUSY_TRIES)."""
    urlopen = urlopen or urllib.request.urlopen
    for i in range(BUSY_TRIES):
        with _lock:
            wait = PACE_S - (time.time() - _last[0])
            _last[0] = time.time() + max(0.0, wait)
        if wait > 0:
            sleep(wait)
        try:
            req = urllib.request.Request(url, json.dumps(body).encode() if body is not None else None, UA)
            with urlopen(req, timeout=60) as r:
                return r.read().decode()
        except urllib.error.HTTPError as e:
            if e.code in (429, 503, 529):                     # 529: the Portal's "overloaded, try again later" (seen 26 Oct)
                sleep(min(10, 2 ** i)); continue
            return None
        except Exception:
            return None
    return None


def block_logs(b: dict, senders: bool = False) -> list | None:
    """One answered block's logs in eth_getLogs' shape; None when the block has no number."""
    h = b.get("header") or {}
    n, ts = h.get("number"), h.get("timestamp")
    if not isinstance(n, int):
        return None
    sent = {t.get("transactionIndex"): str(t.get("from") or "").lower() or None for t in b.get("transactions") or []}
    out = []
    for l in b.get("logs") or []:
        out.append({"address": str(l.get("address", "")).lower(), "topics": l.get("topics") or [], "data": l.get("data") or "0x",
                    "transactionHash": l.get("transactionHash"), "logIndex": hex(int(l.get("logIndex") or 0)),
                    "blockNumber": hex(n), "blockTimestamp": hex(int(ts)) if isinstance(ts, (int, float)) else None})
        if senders:
            out[-1]["txFrom"] = sent.get(l.get("transactionIndex"))
    return out


def head(chain: str, urlopen=None) -> int | None:
    t = _post(PORTAL + DATASET[chain] + "/head", None, urlopen)
    try:
        return int(json.loads(t)["number"])
    except Exception:
        return None


def logs(chain: str, addresses, topic0s, lo: int, hi: int, urlopen=None, sleep=time.sleep, senders: bool = False, topic1s=None) -> list | None:
    """Every log of these addresses and event topics in blocks lo..hi, in eth_getLogs' shape, or None when any part of the
    range went unread. `addresses` / `topic0s`: one or a list. `senders`: each log also carries `txFrom`, the wallet that
    sent its transaction (a launchpad's trade event names the router a trade came through, the sender is
    who traded), from the same answer."""
    if chain not in DATASET or hi < lo:
        return [] if hi < lo else None
    adr = [a.lower() for a in (addresses if isinstance(addresses, (list, tuple)) else [addresses])]
    tps = list(topic0s) if isinstance(topic0s, (list, tuple)) else [topic0s]
    q = {"type": "evm", "fromBlock": lo, "toBlock": hi,
         "fields": {"block": {"number": True, "timestamp": True},
                    "log": {"address": True, "topics": True, "data": True, "transactionHash": True, "logIndex": True}},
         "logs": [{"address": adr, "topic0": tps}]}
    if topic1s:                                                # e.g. a Uniswap v4 pool's id: only those pools' events (line 11, Base)
        q["logs"][0]["topic1"] = [t.lower() for t in topic1s]
    if senders:
        q["fields"]["log"]["transactionIndex"] = True
        q["fields"]["transaction"] = {"from": True, "transactionIndex": True}
        q["logs"][0]["transaction"] = True
    out, nxt = [], lo
    for _ in range(MAX_REQUESTS):
        if nxt > hi:
            return out
        t = _post(PORTAL + DATASET[chain] + "/stream", dict(q, fromBlock=nxt), urlopen, sleep)
        if t is None:
            return None
        blocks = []
        try:
            blocks = [json.loads(l) for l in t.splitlines() if l.strip()]
        except ValueError:
            return None
        if not blocks:
            return None                                       # an empty answer before the range's end: not read
        for b in blocks:
            got = block_logs(b, senders)
            if got is None:
                return None
            out += got
        nxt = blocks[-1]["header"]["number"] + 1
    return None                                               # the range was longer than MAX_REQUESTS answers: not read
