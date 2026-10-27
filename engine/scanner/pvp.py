"""the PvP Arena's battles. A battle is one coin's versions by different creators: coins that share its name and
ticker, or its picture (the same address, the same file, or a near-identical picture) together with its name or its ticker
(a picture alone can be a placeholder many coins share), the gate's own look-alike matches
(scanner/gate.py). For every coin the site lists, its look-alikes are found and joined into groups; each group is named by
its earliest-launched version. Written to `frontend-feed/_pvp.json` (contract "pvp-1") every PASS_S; the site ranks the
versions itself (the site: volume, X presence, chart). Read-only on the gate; no network. Its own thread in the scanner."""
from __future__ import annotations
import json, os, sys, threading, time, traceback

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import gate as G

PASS_S = 60
MAX_MEMBERS = 20                 # a group's newest versions at most (a name copied hundreds of times stays readable)
FILE = "_pvp.json"
NAMELESS: list = []              # the last pass's members with no name or ticker: basic.py asks Jupiter for them


def matches(c, mint: str) -> dict:
    """{other mint: (launched_at, how)} for one coin: other creators' coins with the same name and ticker, or the same picture."""
    r = c.execute("SELECT dev, name_key, symbol_key, launched_at FROM gate WHERE mint=?", (mint,)).fetchone()
    if r is None or not r[0]:
        return {}
    dev, name, sym, _at = r
    out = {}
    if name and sym:
        for m, t in c.execute(f"SELECT mint, launched_at FROM gate WHERE name_key=? AND symbol_key=? AND mint<>? AND dev IS NOT NULL AND dev<>? "
                              f"AND {G.CHAIN_EXPR}=?", (name, sym, mint, dev, G.chain_of(c, mint))):   # one chain (252)
            out[m] = (t, "same name and ticker")
    for m, t, _d, how in G.same_picture(c, mint, same_creator=False):
        o = c.execute("SELECT name_key, symbol_key FROM gate WHERE mint=?", (m,)).fetchone()
        if o and ((name and o[0] == name) or (sym and o[1] == sym)):       # a picture alone can be a shared placeholder (a site's
            out.setdefault(m, (t, how + (" and name" if name and o[0] == name else " and ticker")))   # default image): it counts
    return out                                                          # with the same name or ticker too


def build(c, listed) -> list:
    """The battles among the listed coins and their look-alikes: [{id, launched_at, members: [{mint, launched_at, how, name?, ticker?}]}],
    the busiest-looking (most versions) first. `how` says how each version matches the group's first one or a listed one."""
    G.ensure(c)
    parent, born, how = {}, {}, {}

    def find(x):
        while parent.setdefault(x, x) != x:
            parent[x] = parent[parent[x]]; x = parent[x]
        return x

    bots = G.bot_mints(c)                                            # 271(c): a bot launch never appears on PINR, the Arena included
    for m in listed:
        r = c.execute("SELECT launched_at FROM gate WHERE mint=?", (m,)).fetchone()
        if r is None or m in bots:
            continue
        born.setdefault(m, r[0])
        for other, (t, why) in matches(c, m).items():
            if other in bots:
                continue
            born.setdefault(other, t); how.setdefault(other, why); how.setdefault(m, why)
            a, b = find(m), find(other)
            if a != b:
                parent[a] = b
    groups = {}
    for m in parent:
        groups.setdefault(find(m), []).append(m)
    out = []
    for members in groups.values():
        if len(members) < 2:
            continue
        members.sort(key=lambda m: (born.get(m) is None, born.get(m) or 0, m))
        first = members[0]
        kept = [first] + sorted(members[1:], key=lambda m: -(born.get(m) or 0))[:MAX_MEMBERS - 1]
        out.append({"id": first, "launched_at": _iso(born.get(first)), "versions": len(members),
                    "members": [_member(c, m, born.get(m), how.get(m)) for m in kept]})
    out.sort(key=lambda g: (-g["versions"], g["id"]))
    NAMELESS[:] = [x["mint"] for g in out for x in g["members"] if "name" not in x and "ticker" not in x]
    return out


def _member(c, m, at, why) -> dict:
    """One version: its address, launch time, how it matches, and its name and ticker as Jupiter's list gave
    them, each left out when the gate has none (the site then shows the short address)."""
    out = {"mint": m, "launched_at": _iso(at), "how": why}
    r = c.execute("SELECT name, ticker FROM gate WHERE mint=?", (m,)).fetchone()
    for k, v in zip(("name", "ticker"), r or ()):
        if isinstance(v, str) and v:
            out[k] = v
    return out


def _iso(t):
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(t)) if isinstance(t, (int, float)) else None


def write(feed_dir: str, groups: list, now: float | None = None) -> None:
    body = {"contract": "pvp-1", "as_of": _iso(now or time.time()), "groups": groups}
    p = os.path.join(feed_dir, FILE)
    with open(p + ".tmp", "w") as f:
        json.dump(body, f)
    os.replace(p + ".tmp", p)


def start(db, coins_fn, feed_dir: str) -> threading.Thread:
    def run():
        c = db()
        while True:
            try:
                write(feed_dir, build(c, [m for m, _b in (coins_fn() or [])]))
            except Exception:
                traceback.print_exc()
            time.sleep(PASS_S)
    t = threading.Thread(target=run, name="pvp", daemon=True)
    t.start()
    return t
