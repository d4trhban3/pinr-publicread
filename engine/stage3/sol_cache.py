"""Solana dev-history cache (cost fixes approved 2026-10-05). History on chain only ever grows, so PINR keeps what it
has already read and fetches only what is new. Results are identical to a fresh read:

  - creates: every CREATE this wallet paid for. First read = every transaction read (ChainHistory.creates); later reads
    fetch only creations newer than the newest one already stored ("until" = that signature) and merge.
  - history: the wallet's newest transactions (up to max_pages x 100, like ChainHistory.history). Later reads fetch only the
    pages newer than the newest stored signature; the merged list is cut back to the same size a fresh read returns,
    and "reached the start of history" is true only if a fresh read would say so.
  - assets: token names / tickers / images per mint (fixed at creation): only unknown mints are asked for.
  - track verdicts: a design decision judges each past launch on its first 5 minutes, which never change: stored forever.
Storage: index/solana_cache.sqlite (local data, not in git).
"""
from __future__ import annotations
import json, os, sqlite3, time
HERE = os.path.dirname(os.path.abspath(__file__))
DB = os.path.join(HERE, "..", "index", "solana_cache.sqlite")


def _db():
    c = sqlite3.connect(DB, timeout=60)
    c.execute("CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT, updated REAL)")
    return c


def _get(key):
    row = _db().execute("SELECT v FROM kv WHERE k=?", (key,)).fetchone()
    return json.loads(row[0]) if row else None


def _put(key, value):
    c = _db()
    c.execute("INSERT OR REPLACE INTO kv VALUES (?,?,?)", (key, json.dumps(value), time.time()))
    c.commit()


def creates(h, address: str):
    """Same as ChainHistory.creates (txs, complete), reading only what's new after the first time."""
    key = f"creates:{address}"
    cached = _get(key)
    if not cached or not cached.get("complete"):
        txs, complete = h.creates(address)
        if complete:
            _put(key, {"txs": txs, "complete": True})
        return txs, complete
    old = cached["txs"]
    newest = max(old, key=lambda t: t["timestamp"])["signature"] if old else None
    if newest is None:
        txs, complete = h.creates(address)                 # nothing stored to anchor on: read it all again
        if complete:
            _put(key, {"txs": txs, "complete": True})
        return txs, complete
    new = h._creates_window(address, None, newest, 600)
    if new is None:
        return old, False                                   # couldn't read the new part: say so, never guess
    seen = {t["signature"] for t in old}
    merged = [t for t in new if t["signature"] not in seen] + old
    _put(key, {"txs": merged, "complete": True})
    return merged, True


def history(h, address: str, max_pages: int = 20):
    """Same as ChainHistory.history (txs newest first, reached_start), reading only newer pages after the first time."""
    key = f"history:{address}"
    cap = max_pages * 100
    cached = _get(key)
    if not cached:
        txs, complete = h.history(address, max_pages=max_pages)
        _put(key, {"txs": txs, "complete": complete})
        return txs, complete
    old, old_complete = cached["txs"], cached["complete"]
    newest = old[0]["signature"] if old else None
    from dev_history import free_history                       # the chain's standard methods only
    new, _end = free_history(address, cap, until=newest)
    if not new and not _end:
        return old, False                                       # could not read what is new: say so
    seen = {t["signature"] for t in old}
    merged = [t for t in new if t["signature"] not in seen] + old
    complete = old_complete and len(merged) <= cap
    merged = merged[:cap]
    _put(key, {"txs": merged, "complete": complete})
    return merged, complete


def assets(h, mints: list[str]) -> dict:
    out, missing = {}, []
    for m in mints:
        v = _get(f"asset:{m}")
        if v is None:
            missing.append(m)
        else:
            out[m] = v
    if missing:
        got = h.assets(missing)
        for m, v in got.items():
            if not v.get("image_unread"):
                _put(f"asset:{m}", v)                 # an image that could not be fetched is asked for again later
            out[m] = v
    return out


def get_verdict(mint: str, dev: str):
    return _get(f"track:{mint}:{dev}")


def put_verdict(mint: str, dev: str, value: dict):
    _put(f"track:{mint}:{dev}", value)
