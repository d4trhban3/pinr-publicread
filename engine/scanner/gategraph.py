"""the gate's control graph (pinr.io/control, phase 1). The graph says which gate checks run, which picture
matches count, and the private values (the mass-launcher line, the fast-launch rate); it lives on the server only
(control/gate.json, outside git) and the gate re-reads it every few seconds. This module also keeps each coin's gate result
as it changes (for the status: per check, the last hour) and previews a proposed graph (before and after) for a staged apply.
  python3 scanner/gategraph.py preview <graph.json>   validation and before/after, as JSON
  python3 scanner/gategraph.py status                 the status, as JSON"""
from __future__ import annotations
import json, os, sqlite3, sys, threading, time

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, HERE)

GATE_FILE = None              # tests set their own; else PINR_GATE_FILE or <engine>/control/gate.json
DB = os.path.join(HERE, "scanner.sqlite")
REREAD_S = 5
CHECKS = ("serial_launcher", "fast_launcher", "same_creator_relaunch", "lookalike_name_ticker", "lookalike_picture")
KINDS = ("address", "file", "near")
_cur = [{}, 0.0]


def gate_file() -> str:
    return GATE_FILE or os.environ.get("PINR_GATE_FILE") or os.path.join(ROOT, "control", "gate.json")


def current() -> dict:
    """The graph in force ({} when no file: every check on, values from the private settings)."""
    now = time.time()
    if now - _cur[1] >= REREAD_S:
        try:
            d = json.load(open(gate_file()))
            _cur[0] = d.get("graph") if isinstance(d, dict) and isinstance(d.get("graph"), dict) else {}
        except Exception:
            _cur[0] = {}
        _cur[1] = now
    return _cur[0]


def validate(g, fallback_rate=None) -> list:
    """Problems with a proposed graph ([] when it can be applied): unknown keys, wrong types, and any check switched on
    whose input is not fed (the fast-launch check needs a rate, from the graph or the private settings; the picture
    check needs at least one match kind)."""
    import gate as G
    p = []
    if not isinstance(g, dict):
        return ["the graph must be an object"]
    for k in g:
        if k not in ("checks", "values", "order"):
            p.append(f"unknown key: {k}")
    o = g.get("order")                                                  # the team 2026-10-25: the operator reorders the checks on the map
    if o is not None and (not isinstance(o, list) or any(x not in CHECKS for x in o) or len(set(map(str, o))) != len(o)):
        p.append(f"order: a list of the checks {list(CHECKS)}, each at most once (those left out follow in that order)")
    checks, vals = g.get("checks") or {}, g.get("values") or {}
    if not isinstance(checks, dict) or not isinstance(vals, dict):
        return p + ["checks and values must be objects"]
    for k, v in checks.items():
        if k not in CHECKS:
            p.append(f"unknown check: {k}")
            continue
        if not isinstance(v, dict) or not isinstance(v.get("on", True), bool):
            p.append(f"{k}.on must be true or false")
            continue
        extra = set(v) - ({"on", "match"} if k == "lookalike_picture" else {"on"})
        if extra:
            p.append(f"{k}: unknown keys {sorted(extra)}")
    for k in vals:
        if k not in ("mass_line", "fast_coins", "fast_minutes"):
            p.append(f"unknown value: {k}")
    ml, fc, fm = vals.get("mass_line"), vals.get("fast_coins"), vals.get("fast_minutes")
    if ml is not None and not (isinstance(ml, int) and not isinstance(ml, bool) and 1 <= ml <= 1_000_000):
        p.append("mass_line: null or a whole number 1 to 1,000,000")
    if fc is not None and not (isinstance(fc, int) and not isinstance(fc, bool) and 2 <= fc <= 10_000):
        p.append("fast_coins: null or a whole number 2 to 10,000")
    if fm is not None and not (isinstance(fm, (int, float)) and not isinstance(fm, bool) and 0 < fm <= 1440):
        p.append("fast_minutes: null or above 0, at most 1440")
    if (fc is None) != (fm is None):
        p.append("fast_coins and fast_minutes go together (both, or neither for the private settings)")
    on = lambda k: (checks.get(k) or {}).get("on", True) is not False
    if on("fast_launcher") and fc is None and (fallback_rate if fallback_rate is not None else G.fast_rate()) is None:
        p.append("fast_launcher is on but no rate is fed (none in the graph or the private settings)")
    m = (checks.get("lookalike_picture") or {}).get("match")
    if m is not None and (not isinstance(m, list) or any(x not in KINDS for x in m) or len(set(m)) != len(m)):
        p.append(f"lookalike_picture.match: a list of {list(KINDS)} without repeats")
    elif on("lookalike_picture") and m == []:
        p.append("lookalike_picture is on but no match kind is fed")
    return p


def order_of(g) -> dict:
    """{check: place}: the graph's `order` first, then every check it leaves out in CHECKS order; CHECKS order with none."""
    o = g.get("order") if isinstance(g, dict) and isinstance(g.get("order"), list) else []
    seq = [k for k in o if k in CHECKS] + [k for k in CHECKS if k not in o]
    return {k: i for i, k in enumerate(seq)}


def kinds_of(observed: list) -> list:
    """Which checks held a coin, from the gate's own words."""
    out = []
    for o in observed:
        k = ("serial_launcher" if "has launched" in o else "fast_launcher" if "quick succession" in o
             else "same_creator_relaunch" if o.startswith("the same creator") else
             "lookalike_picture" if o.startswith("an earlier-launched") and o.endswith("picture") else
             "lookalike_name_ticker" if o.startswith("an earlier-launched") else "not_read_yet")
        if k not in out:
            out.append(k)
    return out


def ensure(c) -> None:
    c.execute("CREATE TABLE IF NOT EXISTS gate_events (mint TEXT, at REAL, status TEXT, kinds TEXT)")
    c.execute("CREATE INDEX IF NOT EXISTS gate_events_at ON gate_events(at)")
    c.execute("CREATE INDEX IF NOT EXISTS gate_events_mint ON gate_events(mint, at)")


def note(c, mint: str, v: dict, now: float | None = None) -> bool:
    """Keep a coin's gate result when it is new or has changed; True when kept."""
    ensure(c)
    status, kinds = v["status"], json.dumps(kinds_of(v["observed"]) if v["status"] == "held" else [])
    last = c.execute("SELECT status, kinds FROM gate_events WHERE mint=? ORDER BY at DESC LIMIT 1", (mint,)).fetchone()
    if last == (status, kinds):
        return False
    c.execute("INSERT INTO gate_events VALUES (?,?,?,?)", (mint, now or time.time(), status, kinds))
    return True


def status(c, now: float | None = None) -> dict:
    """The last hour: per check, coins held and the last 5 examples; coins passed; coins in and out a minute."""
    import gate as G
    ensure(c); G.ensure(c)
    now = now or time.time()
    since = now - 3600
    iso = lambda t: time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(t))
    latest = c.execute("""SELECT e.mint, e.at, e.status, e.kinds FROM gate_events e JOIN
                          (SELECT mint, MAX(at) a FROM gate_events WHERE at >= ? GROUP BY mint) m ON e.mint = m.mint AND e.at = m.a
                          ORDER BY e.at DESC""", (since,)).fetchall()
    per = {k: {"held": 0, "examples": []} for k in CHECKS}
    passed = held = unread = bots = 0
    for mint, at, st, kinds in latest:
        if st == "passed":
            passed += 1
        elif st == "bot":                                              # a bot launch, counted on its own
            bots += 1
        elif st == "held":
            held += 1
            for k in json.loads(kinds or "[]"):
                if k in per:
                    per[k]["held"] += 1
                    if len(per[k]["examples"]) < 5:
                        per[k]["examples"].append({"coin": mint, "at": iso(at), "link": G.link(G.chain_of(c, mint), "token", mint)})
        else:
            unread += 1
    came = c.execute("SELECT COUNT(*) FROM gate WHERE first_seen >= ?", (since,)).fetchone()[0]
    out_ = c.execute("SELECT COUNT(DISTINCT mint) FROM gate_events WHERE at >= ? AND status='passed'", (since,)).fetchone()[0]
    return {"as_of": iso(now), "window_s": 3600, "coins_in_per_min": round(came / 60, 2), "coins_passed_per_min": round(out_ / 60, 2),
            "passed": passed, "held": held, "bot": bots, "not_read_yet": unread, "checks": per, "graph": current()}


def preview(c, proposed: dict, now: float | None = None, limit: int = 2000) -> dict:
    """Validation, then the proposed graph against the one in force over the coins launched in the last day."""
    import gate as G
    problems = validate(proposed)
    if problems:
        return {"valid": False, "problems": problems}
    now = now or time.time()
    mints = [m for (m,) in c.execute("SELECT mint FROM gate WHERE launched_at >= ? ORDER BY launched_at DESC LIMIT ?", (now - 86400, limit))]
    cur = current()
    def count(cfg):
        res, by = {}, {"passed": 0, "held": 0, "bot": 0, "not read yet": 0}
        per = {k: 0 for k in CHECKS}
        for m in mints:
            v = G.verdict(c, m, cfg=cfg)
            res[m] = v["status"]; by[v["status"]] += 1
            if v["status"] == "held":
                for k in kinds_of(v["observed"]):
                    if k in per:
                        per[k] += 1
        return res, {**by, "by_check": per}
    b, before = count(cur)
    a, after = count(proposed)
    changed = [{"coin": m, "before": b[m], "after": a[m]} for m in mints if b[m] != a[m]]
    seq = lambda g: [k for k, _i in sorted(order_of(g).items(), key=lambda x: x[1])]
    return {"valid": True, "problems": [], "coins": len(mints), "before": before, "after": after,
            "changed_count": len(changed), "changed": changed[:20], "order_before": seq(cur), "order_after": seq(proposed)}


def version() -> int:
    try:
        v = json.load(open(gate_file())).get("version")
        return v if isinstance(v, int) else 0
    except Exception:
        return 0


def refresh(c, feed_dir: str, now: float | None = None, limit: int = 5000) -> dict:
    """the team's F1 on 29199fc7: after a new graph version, the last day's coins get their gate result again under it,
    and every coin whose result changed has its file rewritten and the change kept (the public files and the status match
    the gate in force). Returns {"coins", "changed"}."""
    import gate as G, evidence as EV
    _cur[1] = 0.0                                        # read the new graph now, not after REREAD_S
    now = now or time.time()
    ensure(c)
    mints = [m for (m,) in c.execute("SELECT mint FROM gate WHERE launched_at >= ? ORDER BY launched_at DESC LIMIT ?", (now - 86400, limit))]
    changed = 0
    for m in mints:
        try:
            if note(c, m, G.verdict(c, m), now):
                changed += 1
                c.commit()                                   # each change kept at once: the database is never held through the pass
                EV.write_coin_file(c, m, feed_dir, now)
        except Exception:
            pass
    c.commit()
    return {"coins": len(mints), "changed": changed}


def start_status(db, every_s: int = 30, feed_dir: str | None = None) -> threading.Thread:
    path = os.path.join(os.path.dirname(gate_file()), "status-gate.json")
    seen = [version()]
    def run():
        c = db()
        while True:
            try:
                v = version()
                if v != seen[0] and feed_dir:                 # a new graph version: the files and the status follow it
                    seen[0] = v
                    got = refresh(c, feed_dir)
                    print(time.strftime("%H:%M:%S") + f" gate graph version {v}: {got['coins']} coins re-read, {got['changed']} changed")
                body = status(c)
                os.makedirs(os.path.dirname(path), exist_ok=True)
                json.dump(body, open(path + ".tmp", "w"), indent=1)
                os.replace(path + ".tmp", path)
            except Exception:
                pass
            time.sleep(every_s)
    t = threading.Thread(target=run, name="gate-status", daemon=True)
    t.start()
    return t


if __name__ == "__main__":
    c = sqlite3.connect(f"file:{os.environ.get('PINR_GATE_DB') or DB}?mode=ro", uri=True, timeout=30)
    if len(sys.argv) >= 3 and sys.argv[1] == "preview":
        print(json.dumps(preview(c, json.load(open(sys.argv[2])))))
    elif len(sys.argv) >= 2 and sys.argv[1] == "status":
        print(json.dumps(status(c)))
    else:
        print(__doc__)
