"""Engine -> live app chart events (data contract v1.1 draft, "Chart events" in pinr-live/contract/DATA-CONTRACT.md).

Each time a token's result is exported, its public state (score, or a no-score flag) is compared with the last one
recorded for it. A change becomes one dated event:
  score_up / score_down   the whole-number score changed (from, to)
  flag_raised             a no-score label (VAMP, BOT/RUG, MAYHEM, HONEYPOT) appeared, or changed to another one
  flag_cleared            it went away
Texts say what was observed ("Label observed: VAMP"; a design decision, a doctor not a judge: never "Flagged"). The label is already public on the tile.
Nothing else: no reasons, checks, weights, caps or thresholds. No surges here (operator: surges belong on the PINR page,
not the chart). The first state
seen for a token is only remembered (it is a starting point, not a change), so a token with no real change has no file.

History starts when this was switched on (2026-10-06): earlier results were overwritten in place and are not rebuilt.
State and events live in feed/chart_events.sqlite (server side, git-ignored); events/<address>.json is rewritten from it.
"""
from __future__ import annotations
import calendar, json, os, sqlite3, time

HERE = os.path.dirname(os.path.abspath(__file__))
DB = os.path.join(HERE, "chart_events.sqlite")
MAX_EVENTS = 200
TEXT = {"score_up": "Score moved up", "score_down": "Score moved down",
        "flag_raised": "Label observed: {label}", "flag_cleared": "Label no longer observed: {label}"}


def _db():
    c = sqlite3.connect(DB, timeout=60)
    c.execute("CREATE TABLE IF NOT EXISTS state (mint TEXT PRIMARY KEY, t INTEGER, score INTEGER, flagged INTEGER, label TEXT)")
    c.execute("CREATE TABLE IF NOT EXISTS events (mint TEXT, t INTEGER, kind TEXT, sfrom INTEGER, sto INTEGER, label TEXT)")
    for table in ("state", "events"):
        if "label" not in [r[1] for r in c.execute(f"PRAGMA table_info({table})")]:
            c.execute(f"ALTER TABLE {table} ADD COLUMN label TEXT")
    c.execute("CREATE INDEX IF NOT EXISTS by_mint ON events (mint, t)")
    return c


def _seconds(as_of) -> int | None:
    if isinstance(as_of, str) and len(as_of) >= 19:
        try:
            return calendar.timegm(time.strptime(as_of[:19], "%Y-%m-%dT%H:%M:%S"))
        except ValueError:
            return None
    return None


def changes(prev, score, flag):
    """(kind, from, to, label) list for a move from prev = (score, flag) to the new state; flag is the no-score label or
    None. Pure; tested."""
    if prev is None:
        return []
    p_score, p_flag = prev
    if flag and flag != p_flag:
        return [("flag_raised", None, None, flag)]
    if p_flag and not flag:
        return [("flag_cleared", None, None, p_flag)]
    if not flag and p_score is not None and score is not None and score != p_score:
        return [("score_up" if score > p_score else "score_down", p_score, score, None)]
    return []


def record(rec: dict, no_score_labels, feed_dir: str) -> int:
    """Compare one exported feed record with the token's last state; store and publish any change. Returns events added."""
    mint = rec["mint"]
    flag = next((x for x in (rec.get("label"), rec.get("display")) if x in no_score_labels), None)
    flagged = flag is not None
    score = None if flagged else rec.get("score")
    t = _seconds(rec.get("as_of")) or int(time.time())
    c = _db()
    try:
        c.execute("BEGIN IMMEDIATE")                             # several scoring workers may export at once
        row = c.execute("SELECT t, score, flagged, label FROM state WHERE mint=?", (mint,)).fetchone()
        if row is not None and t <= row[0]:
            c.rollback()
            return 0                                             # an older result (e.g. a rebuild): never rewrites history
        if score is None and not flagged:
            c.rollback()
            return 0                                             # no number and no flag (e.g. nothing loaded): not a state
        new = changes(None if row is None else (row[1], (row[3] or "a flag") if row[2] else None), score, flag)
        for kind, a, b, lab in new:
            c.execute("INSERT INTO events (mint, t, kind, sfrom, sto, label) VALUES (?,?,?,?,?,?)", (mint, t, kind, a, b, lab))
        c.execute("INSERT OR REPLACE INTO state (mint, t, score, flagged, label) VALUES (?,?,?,?,?)",
                  (mint, t, score, int(flagged), flag))
        c.commit()
        if new:
            _publish(c, mint, feed_dir)
        return len(new)
    finally:
        c.close()


def _publish(c, mint: str, feed_dir: str) -> None:
    rows = c.execute("SELECT t, kind, sfrom, sto, label FROM events WHERE mint=? ORDER BY t DESC, rowid DESC LIMIT ?",
                     (mint, MAX_EVENTS)).fetchall()[::-1]
    events = []
    for t, kind, a, b, lab in rows:
        e = {"t": t, "kind": kind}
        if kind in ("score_up", "score_down"):
            e.update({"from": a, "to": b})
        e["text"] = TEXT[kind].format(label=lab or "a label")
        events.append(e)
    doc = {"contract": "1.1", "mint": mint, "as_of": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "events": events}
    d = os.path.join(feed_dir, "events")
    os.makedirs(d, exist_ok=True)
    safe = "".join(ch for ch in mint if ch.isalnum())
    path = os.path.join(d, safe + ".json")
    tmp = path + ".tmp"
    json.dump(doc, open(tmp, "w"), indent=1)
    os.replace(tmp, path)                                        # atomic: the app never reads a half-written file
