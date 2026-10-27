"""CHAINS: a Base or BNB coin's seen feed file (the design's shape, `feed/seen_feed.py`) and its gate row (a design decision,
`scanner/gate.py`), so the site, the gate and the quiet rule take these coins as they take Solana's.

The seen file is the same record `seen_feed.seen_record` builds, with the coin's own chain ("base" or "bsc") where that
builder writes "solana", and the launchpad's own `seen_by` word. It is written through `seen_feed.write_seen` (create
only, under the coin's lock) and later fields through `seen_feed.update_seen`, so a scored file is never replaced."""
from __future__ import annotations
import os, sys, time, traceback

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path[:0] = [os.path.join(HERE, "..", "feed"), os.path.join(HERE, "..", "scanner")]

CHAINS = ("base", "bsc")
SEEN_BY = ("clanker_api", "zora_explore", "virtuals_api", "gecko_virtuals", "fourmeme_chain", "flap_chain")
MAX_AGE_S = 86400                     # a coin launched over a day ago is not a new launch
# The launchpad words a coin's file shows: the feed's own (feed_export.LAUNCHPAD_NAMES), so a seen coin and a scored one read
# the same on the site (2026-10-26: "Flap" beside "Flap.sh", "Four.meme" beside "four.meme").
SHOWN = {"Flap": "Flap.sh", "Four.meme": "four.meme"}
COUNT_SOURCE = {"Clanker": "Clanker", "Zora": "Zora", "Virtuals": "Virtuals", "Four.meme": "PINR", "Flap": "PINR"}
DATA_SOURCE = {"clanker_api": "Clanker", "zora_explore": "Zora", "virtuals_api": "Virtuals", "gecko_virtuals": "GeckoTerminal",
               "fourmeme_chain": "Four.meme factory event (BNB Chain)", "flap_chain": "Flap factory event (BNB Chain)"}


def _iso(t) -> str | None:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(int(t))) if isinstance(t, (int, float)) and t > 0 else None


def _pos(v) -> float | None:
    return float(v) if isinstance(v, (int, float)) and not isinstance(v, bool) and v > 0 else None


def seen_record(r: dict, seen_at: float) -> dict:
    """The contract record for a seen Base / BNB coin; only what its list or chain read gave (absent = not read)."""
    import seen_feed as SF
    if r.get("chain") not in CHAINS or r.get("by") not in SEEN_BY:
        raise ValueError("chain must be base or bsc and seen_by a CHAINS word")
    rec = SF.seen_record(r["mint"], "jupiter_recent", seen_at, launchpad=SHOWN.get(r.get("launchpad"), r.get("launchpad")), name=r.get("name"),
                         ticker=r.get("ticker"), image_url=r.get("image"), launched_at=r.get("launched_at"))
    rec["seen_by"], rec["chain"] = r["by"], r["chain"]           # the builder's own shape; only these two words differ
    lk = {k: v for k, v in (r.get("links") or {}).items() if k in ("x", "website", "telegram") and isinstance(v, str)}
    if lk:
        rec["links"] = dict(lk, source=r["launchpad"], read_at=_iso(seen_at))
    if _pos(r.get("price_usd")):
        rec["price_usd"] = r["price_usd"]
    if _pos(r.get("valuation_usd")):
        rec["valuation_usd"] = r["valuation_usd"]
    rec["as_of"] = rec.pop("as_of")                                # keep as_of last, as the builder writes it
    return rec


def write_new(records: list, now: float | None = None, write=None) -> dict:
    """One seen file per new coin (never replacing a file); a coin over a day old or of unknown age is left out.
    Returns {seen_by: written}."""
    import seen_feed as SF
    now = now or time.time()
    write = write or SF.write_seen
    out = {}
    for r in records:
        at = r.get("launched_at")
        if not at or now - at > MAX_AGE_S:
            continue
        if write(seen_record(r, now)):
            out[r["by"]] = out.get(r["by"], 0) + 1
    return out


def gate_row(r: dict, dev_count: int | None) -> dict:
    """The gate's token-data row in the shape `gate.record` reads ({id, dev, name, symbol, icon, audit.devMints,
    createdAt}, and for a Base/BNB coin `chain`, `source` and `audit.devMintsSource`: the engine's builder/chainsgate). `devMints`
    is the launchpad's own count of the creator's coins (Clanker, Zora, Virtuals) or, on BNB, the creator's coins PINR read
    from both factories' events; `devMintsSource` names which, `source` who gave the token data."""
    return {"id": r["mint"], "dev": r.get("creator"), "name": r.get("name"), "symbol": r.get("ticker"), "icon": r.get("image"),
            "chain": r.get("chain"), "source": DATA_SOURCE.get(r.get("by")),
            "audit": {"devMints": dev_count, "devMintsSource": COUNT_SOURCE.get(r.get("launchpad")) if dev_count is not None else None},
            "createdAt": _iso(r.get("launched_at"))}


def gate_feed(c, rows: list, feed_dir: str, now: float | None = None) -> int:
    """Records the rows in the gate's own table and keeps each changed result, exactly as the scanner's basic pass does
    after a Jupiter read (`scanner/basic.py`): the coin and every coin its read can change (`gate.affected`) get their
    evidence file and their gate event. Returns how many coins were touched."""
    import gate as G, gategraph as GG, evidence as EV
    now = now or time.time()
    if not rows:
        return 0
    G.record(c, rows, now)
    EV.ensure(c)                                                   # the evidence table, as the scanner keeps it (create if missing)
    c.commit()
    touched = []
    for x in rows:
        for m in [x["id"]] + G.affected(c, x["id"]):
            if m not in touched:
                touched.append(m)
    for m in touched:
        try:
            GG.note(c, m, G.verdict(c, m), now)
            c.commit()
        except Exception:
            traceback.print_exc()
        try:
            EV.write_coin_file(c, m, feed_dir, now)
        except Exception:
            traceback.print_exc()
    c.commit()
    return len(touched)
