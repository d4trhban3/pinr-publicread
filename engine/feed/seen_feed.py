"""A SEEN coin's feed file: one file per coin the trigger has seen,
written before any score, replaced by the full file when a score lands, never the other way round. Nothing in it is simulated:
what was not read is absent. Run nothing here; the scanner calls it inside its trigger pass (`scanner/seen.py`)."""
from __future__ import annotations
import calendar, datetime, json, os, time
HERE = os.path.dirname(os.path.abspath(__file__))
import sys
sys.path.insert(0, HERE)
import feed_export as F

SEEN_WINDOW = 86400                 # a seen file lives while the coin is in its first day; unscored after that, it is removed
SEEN_BY = ("pumpfun_pool", "stonkfun_list", "jupiter_recent", "raydium_list", "bags_feed")   # the last three: the design's discovery


def _path(mint: str) -> str:
    safe = "".join(ch for ch in mint if ch.isalnum())
    return os.path.join(F.FEED_DIR, safe + ".json")


def _iso(ts) -> str | None:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(int(ts))) if isinstance(ts, (int, float)) and ts > 0 else None


def seen_record(mint: str, seen_by: str, seen_at: float, launchpad: str | None = None, name=None, ticker=None, image_url=None,
                launched_at=None, links: dict | None = None, as_of: float | None = None) -> dict:
    """The contract record for a seen coin: the four required fields (score null, display "not scored yet", coverage 0, label null),
    `seen: true` with `seen_at` and `seen_by`, and only what the list record that saw it gave (absent = not read)."""
    if seen_by not in SEEN_BY:
        raise ValueError(f"seen_by must be one of {SEEN_BY}")
    rec = {"mint": mint, "score": None, "display": "not scored yet", "coverage": 0, "label": None,
           "seen": True, "seen_at": _iso(seen_at), "seen_by": seen_by, "chain": "solana"}
    if launchpad:
        rec["launchpad"] = launchpad
    if isinstance(name, str) and name.strip():
        rec["name"] = name.strip()[:60]
    if isinstance(ticker, str) and ticker.strip().lstrip("$"):
        rec["ticker"] = ticker.strip().lstrip("$")[:24]
    if isinstance(image_url, str) and image_url.startswith("https://") and len(image_url) < 300:
        rec["image_url"] = image_url
    if _iso(launched_at):
        rec["launched_at"] = _iso(launched_at)
    if isinstance(links, dict) and links.get("source") and links.get("read_at"):
        rec["links"] = links
    rec["as_of"] = _iso(as_of if as_of else seen_at)
    return rec


def read_file(mint: str) -> dict | None:
    try:
        return json.load(open(_path(mint)))
    except FileNotFoundError:
        return None
    except Exception:
        return {"_unreadable": True}


def is_seen_file(mint: str) -> bool:
    d = read_file(mint)
    return bool(d and d.get("seen") is True)


def write_seen(rec: dict) -> str | None:
    """Create the seen file, and only create: an exclusive create under the coin's lock (shared with the scorer's exporter), so a
    file that exists for any reason (a score landing this instant, an early file, an unreadable file, an earlier seen file) is
    never replaced. Later fields go in through `update_seen`."""
    os.makedirs(F.FEED_DIR, exist_ok=True)
    path = _path(rec["mint"])
    tags = F.tags_for(rec["mint"])
    if tags:
        rec = dict(rec, tags=tags)                           # 271(b): a seen file carries the coin's tags from its gate
    with F.file_lock(rec["mint"]):
        try:
            fd = os.open(path, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o644)
        except FileExistsError:
            return None
        with os.fdopen(fd, "w") as f:
            json.dump(rec, f, indent=1)
    return path


def update_seen(mint: str, **fields) -> bool:
    """Add read fields to a seen file (the fee fact, the verified launchpad words); False when the file is no longer a seen one."""
    path = _path(mint); tmp = path + ".tmp"
    with F.file_lock(mint):                                  # R1: read and replace under the coin's lock; a score that landed wins
        d = read_file(mint)
        if not d or d.get("seen") is not True:
            return False
        for k, v in fields.items():
            if v is None:
                continue
            d[k] = v
        d["as_of"] = _iso(time.time())
        json.dump(d, open(tmp, "w"), indent=1)
        os.replace(tmp, path)
    return True


GRADUATED_WORDS = "PumpSwap (graduated)"                     # the scorer's own words for a graduated Pump.fun coin (stage2/run_stage2.py)


def follow_graduation(mint: str) -> bool:
    """Item 54: a Pump.fun coin the launchpad's own record shows graduated: its feed file's launchpad words go from "Pump.fun
    curve" to the scorer's own graduated words at once, a seen file or a scored one, under the coin's lock with a re-read (R1);
    nothing else in the file changes (a score's figures and time stay as scored; its next score reads the chain itself). False
    when there is no file, it cannot be read, or its words are not "Pump.fun curve"."""
    path = _path(mint); tmp = path + ".tmp"
    with F.file_lock(mint):
        d = read_file(mint)
        if not d or d.get("_unreadable") or d.get("launchpad") != "Pump.fun curve":
            return False
        d["launchpad"] = GRADUATED_WORDS
        json.dump(d, open(tmp, "w"), indent=1)
        os.replace(tmp, path)
    return True


def has_fee(mint: str) -> bool:
    d = read_file(mint)
    return bool(d and any(isinstance(f, dict) and f.get("id") == "transfer_fee" for f in d.get("facts") or []))


def fee_fact(mint: str, fee: dict | None, receipts: list, read_at: str | None) -> dict | None:
    """The `transfer_fee` fact exactly as the contract has it, through the same builder the scored file uses, from the fee
    read (`rewards_program`'s dict) and its receipts; `fee_case` only for the cases known before a score (none,
    rewards_standard, standard_unknown). None when nothing usable was read."""
    if not isinstance(fee, dict):
        return None
    kind = fee.get("fee_kind")
    o = {"mint": mint, "transfer_fee": fee, "receipts": list(receipts or [])}
    if kind in ("none", "rewards_standard", "standard_unknown"):
        o["fee_reason"] = {"case": kind}
        o["receipts"].append({"what": "fee reason", "value": kind, "unit": "case", "source": "seen before any score: the fee's own kind", "as_of": read_at or _iso(time.time())})
    facts = F.facts_for(o, {}, read_at)
    return next((f for f in facts if f.get("id") == "transfer_fee"), None)


SCANNER_DB = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "scanner", "scanner.sqlite")


def never_scored(mint: str, db: str | None = None) -> bool:
    """True only when the scanner's record shows the coin never finished a score (a failed re-score also writes a technical
    error over a scored coin's file: that one stays). Unreadable, or no record: False, so nothing is removed on a guess."""
    import sqlite3
    try:
        c = sqlite3.connect(f"file:{db or SCANNER_DB}?mode=ro", uri=True, timeout=5)
        r = c.execute("SELECT last_ok FROM tokens WHERE token=?", (mint,)).fetchone()
        c.close()
    except Exception:
        return False
    return r is not None and r[0] is None


def expire(now: float | None = None) -> list:
    """Remove seen files older than SEEN_WINDOW that never got a score, and failed-score files whose last try is that old (a scored
    file is never touched). Returns the mints removed."""
    now = now or time.time()
    gone = []
    try:
        names = os.listdir(F.FEED_DIR)
    except FileNotFoundError:
        return gone
    for n in names:
        if not n.endswith(".json") or n.startswith("trigger-"):
            continue
        p = os.path.join(F.FEED_DIR, n)
        mint = n[:-5]
        with F.file_lock(mint):                              # R1: the check and the removal under the coin's lock; a saved result stays
            try:
                d = json.load(open(p))
            except Exception:
                continue
            if not isinstance(d.get("mint"), str):
                continue
            # the team 2026-10-25: a coin whose only file is a failed score ("Technical error, retrying", no score) never scored
            # either; a day after its last try its retries are over, so it goes the same way (its result file stays in results)
            failed = d.get("seen") is not True and d.get("score") is None and str(d.get("display") or "").startswith("Technical error")
            if d.get("seen") is not True and not failed:
                continue
            try:
                if failed:
                    t = datetime.datetime.fromisoformat(str(d.get("as_of") or "").replace("Z", "+00:00")).timestamp()
                else:
                    t = calendar.timegm(time.strptime(d.get("seen_at", ""), "%Y-%m-%dT%H:%M:%SZ"))     # UTC whatever the machine's zone
            except Exception:
                continue
            if failed and now - t > SEEN_WINDOW and not never_scored(d["mint"]):
                continue                                     # the scanner's record asked only for a file old enough to go
            if now - t > SEEN_WINDOW:
                try:
                    os.remove(p); gone.append(d["mint"])
                except OSError:
                    pass
    return gone
