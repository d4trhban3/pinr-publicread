"""the wires on pinr.io/control become real routes. For each field the engine or the feed fills,
the sources that may fill it, in wire order (top first), and each launchpad's discovery on or off.

  control/routing-catalog.json   what each field can really use, who fills it, today's order (in git)
  control/routing.json           the operator's routing, {"version", "routing": {"routes", "discovery"}, ...}, written
                                 only by the control service after a preview and one Apply; versions kept beside it

Missing or unusable file = today's order (the catalog's defaults): nothing changes until the operator applies a routing.
A route names only sources its field can use; a field is never left with no source; at least one launchpad stays on;
a field or launchpad nothing follows yet (catalog "followed": false) cannot be changed.
Read live (every REREAD_S); the engine asks route(field) and discovery_on(name).

  python3 scanner/routing.py preview <file>   validation and the before/after for a proposed routing (the control service)"""
from __future__ import annotations
import json, os, sys, time

HERE = os.path.dirname(os.path.abspath(__file__))
ENGINE = os.path.dirname(HERE)
CATALOG = os.path.join(ENGINE, "control", "routing-catalog.json")
REREAD_S = 5
_cur = [None, 0.0]


def routing_file() -> str:
    return os.environ.get("PINR_ROUTING_FILE") or os.path.join(ENGINE, "control", "routing.json")


def catalog(path=None) -> dict:
    return json.load(open(path or CATALOG))


def defaults(cat=None) -> dict:
    cat = cat or catalog()
    return {"routes": {f: list(v["default"]) for f, v in cat["fields"].items()},
            "discovery": {d: bool(v["default"]) for d, v in cat["discovery"].items()}}


def validate(r, cat=None) -> list:
    """Problems in plain words; [] when the routing may be applied. Every field and launchpad must be named."""
    cat = cat or catalog()
    if not isinstance(r, dict):
        return ["a routing must be an object with routes and discovery"]
    out = []
    routes, disc = r.get("routes"), r.get("discovery")
    if not isinstance(routes, dict):
        out.append("routes: an object, one list of sources a field")
        routes = {}
    if not isinstance(disc, dict):
        out.append("discovery: an object, one on/off a launchpad")
        disc = {}
    for f in routes:
        if f not in cat["fields"]:
            out.append(f"unknown field: {f}")
    for f, spec in cat["fields"].items():
        lst = routes.get(f)
        if not isinstance(lst, list) or not lst:
            out.append(f"{f}: needs at least one source ({spec['words']} would have none)")
            continue
        bad = [s for s in lst if s not in spec["sources"]]
        if bad:
            out.append(f"{f}: cannot be filled by {', '.join(map(str, bad))} (it can use {', '.join(spec['sources'])})")
        if len(set(map(str, lst))) != len(lst):
            out.append(f"{f}: a source is listed twice")
    for d in disc:
        if d not in cat["discovery"]:
            out.append(f"unknown launchpad: {d}")
    for d in cat["discovery"]:
        if not isinstance(disc.get(d), bool):
            out.append(f"{d}: discovery must be on or off")
    if disc and not any(disc.get(d) is True for d in cat["discovery"]):
        out.append("discovery: at least one launchpad must stay on (no new coins otherwise)")
    out += _validate_nodes(r.get("nodes"), cat) + _validate_trade_feed(r.get("trade_feed"), cat)
    return out


def _validate_nodes(nodes, cat) -> list:
    """optional; absent or null = today's order. Every read kind named, each a
    list of known nodes in wire order, none twice."""
    if nodes is None or "nodes" not in cat:
        return []
    if not isinstance(nodes, dict):
        return ["nodes: an object, one list of nodes a kind of read"]
    spec, out = cat["nodes"], []
    for k in nodes:
        if k not in spec["kinds"]:
            out.append(f"nodes: unknown kind of read: {k}")
    for k, kv in spec["kinds"].items():
        lst = nodes.get(k)
        if not isinstance(lst, list) or not lst:
            out.append(f"nodes.{k}: needs at least one node ({kv['words']} would have none)")
            continue
        bad = [n for n in lst if n not in spec["names"]]
        if bad:
            out.append(f"nodes.{k}: unknown node {', '.join(map(str, bad))}")
        if len(set(map(str, lst))) != len(lst):
            out.append(f"nodes.{k}: a node is listed twice")
    return out


def _validate_trade_feed(tf, cat) -> list:
    if tf is None or "trade_feed" not in cat:
        return []
    spec = cat["trade_feed"]
    if not isinstance(tf, dict):
        return ["trade_feed: an object with nodes and coins"]
    out, nodes, coins = [], tf.get("nodes"), tf.get("coins")
    if not isinstance(nodes, list) or not 1 <= len(nodes) <= spec["max_nodes"]:
        out.append(f"trade_feed.nodes: one or {spec['max_nodes']} nodes (the first, then the overflow)")
    else:
        bad = [n for n in nodes if n not in spec["names"]]
        if bad:
            out.append(f"trade_feed.nodes: unknown node {', '.join(map(str, bad))}")
        if len(set(map(str, nodes))) != len(nodes):
            out.append("trade_feed.nodes: a node is listed twice")
    lo, hi = spec["coins"]
    if isinstance(coins, bool) or not isinstance(coins, int) or not lo <= coins <= hi:
        out.append(f"trade_feed.coins: a whole number from {lo} to {hi}")
    return out


TRADE_FEED_ENV = {"chainstack": "CHAINSTACK_SOLANA_URL", "helius": "HELIUS_API_KEY", "shyft": "SHYFT_API_KEY"}   # public, publicnode: keyless


def _switched_off(control=None) -> set:
    """The sources switched off on /control, by their /control label."""
    if control is None:
        try:
            control = json.load(open(os.path.join(ENGINE, "control", "control.json")))
        except Exception:
            control = {}
    return {k for k, v in (control.get("sources") or {}).items() if isinstance(v, dict) and v.get("on") is False}


def live_problems(r, env=None, control=None) -> list:
    """Only at preview, on the server: a wired node needs its address in the server's .env (its name checked, never its value) and must
    not be switched off on /control."""
    out = []
    try:
        sys.path.insert(0, os.path.join(ENGINE, "stage2"))
        import solana_rpc as S
        env = S._ENV if env is None else env
        known = S._KNOWN
        label = lambda n: S.COUNT_NAMES.get(n, n)
    except Exception:
        return out
    off = _switched_off(control)
    named = sorted({n for lst in (r.get("nodes") or {}).values() if isinstance(lst, list) for n in lst if n in known})
    for n in named:
        if not known[n][0](env):
            out.append(f"{n}: no address for it in the server's .env")
        if label(n) in off:
            out.append(f"{n}: switched off on /control (switch it on there first)")
    for n in ((r.get("trade_feed") or {}).get("nodes") or []):
        v = TRADE_FEED_ENV.get(n)
        if v and not str(env.get(v) or "").strip():
            out.append(f"trade_feed: {n} has no address in the server's .env")
        if label(n) in off:                                   # the team's W2 on cb95edd6
            out.append(f"trade_feed: {n} is switched off on /control (switch it on there first)")
    return out


def current() -> dict:
    """The routing in force: the applied file's, or today's order. A file that fails validation is not used."""
    now = time.time()
    if _cur[0] is None or now - _cur[1] >= REREAD_S:
        try:
            d = json.load(open(routing_file()))
            r = d.get("routing") if isinstance(d, dict) else None
            _cur[0] = r if not validate(r) else defaults()
        except Exception:
            _cur[0] = defaults()
        _cur[1] = now
    return _cur[0]


def version() -> int:
    try:
        v = json.load(open(routing_file())).get("version")
        return v if isinstance(v, int) else 0
    except Exception:
        return 0


def node_route(kind: str):
    """The applied node order for one kind of read, or None (today's order)."""
    n = current().get("nodes")
    return list(n[kind]) if isinstance(n, dict) and isinstance(n.get(kind), list) else None


def kind_of(method: str) -> str:
    try:
        for k, kv in catalog()["nodes"]["kinds"].items():
            if isinstance(kv["methods"], list) and method in kv["methods"]:
                return k
    except Exception:
        pass
    return "other"


def trade_feed():
    t = current().get("trade_feed")
    return dict(t) if isinstance(t, dict) else None


def route(field: str) -> list:
    """The sources that may fill this field, top wire first. An unknown field: []."""
    return list((current().get("routes") or {}).get(field) or [])


def discovery_on(name: str) -> bool:
    return (current().get("discovery") or {}).get(name) is True


def effective_nodes(control=None) -> dict:
    """The node order in force now for each kind of read (applied wires, else today's settings order), without the nodes
    switched off on /control (the request module never sends to those)."""
    out = {}
    try:
        sys.path.insert(0, os.path.join(ENGINE, "stage2"))
        import solana_rpc as S
        off = _switched_off(control)
        for k, kv in catalog()["nodes"]["kinds"].items():
            m = kv["methods"][0] if isinstance(kv["methods"], list) else "getAccountInfo"
            out[k] = [e[0] for e in S._order(m) if S.COUNT_NAMES.get(e[0], e[0]) not in off]
    except Exception:
        pass
    return out


def nodes_fallback() -> list:
    """the team's W3 on cb95edd6: the kinds of read whose applied wire has no usable node left (every one lost its `.env`
    line), so today's order serves them instead; [] when every wire is followed or none is set."""
    out = []
    try:
        sys.path.insert(0, os.path.join(ENGINE, "stage2"))
        import solana_rpc as S
        for k, kv in catalog()["nodes"]["kinds"].items():
            m = kv["methods"][0] if isinstance(kv["methods"], list) else "getAccountInfo"
            if node_route(k) and not S._node_route(m):
                out.append(k)
    except Exception:
        pass
    return out


def preview(proposed, cat=None) -> dict:
    """Validation, then each field and launchpad whose routing would change, before and after, with who must follow it."""
    cat = cat or catalog()
    problems = validate(proposed, cat)
    if not problems and isinstance(proposed, dict):
        problems = live_problems(proposed)
    if problems:
        return {"valid": False, "problems": problems}
    cur = current()
    changes = []
    for f, spec in cat["fields"].items():
        b, a = cur["routes"].get(f), proposed["routes"][f]
        if b != a:
            dropped = [s for s in b or [] if s not in a]
            changes.append({"field": f, "words": spec["words"], "owner": spec["owner"], "before": b, "after": a,
                            "dropped": dropped, "added": [s for s in a if s not in (b or [])]})
    for d, spec in cat["discovery"].items():
        b, a = cur["discovery"].get(d), proposed["discovery"][d]
        if b != a:
            changes.append({"launchpad": d, "words": spec["words"], "owner": spec["owner"], "before": b, "after": a})
    if "nodes" in cat and isinstance(proposed.get("nodes"), dict):
        eff = effective_nodes()
        for k in cat["nodes"]["kinds"]:
            b, a = (cur.get("nodes") or {}).get(k) or eff.get(k), proposed["nodes"][k]
            if b != a:
                changes.append({"nodes": k, "words": cat["nodes"]["kinds"][k]["words"], "owner": "engine", "before": b, "after": a})
    if "trade_feed" in cat and isinstance(proposed.get("trade_feed"), dict) and proposed["trade_feed"] != cur.get("trade_feed"):
        changes.append({"trade_feed": True, "words": cat["trade_feed"]["words"], "owner": "engine",
                        "before": cur.get("trade_feed"), "after": proposed["trade_feed"]})
    # the team's W1 on d6bbeb11: a wire nothing reads yet is never shown as applied
    def spec_of(ch):
        if "nodes" in ch:
            return cat.get("nodes") or {}
        if "trade_feed" in ch:
            return cat.get("trade_feed") or {}
        return cat["fields"].get(ch.get("field")) or cat["discovery"].get(ch.get("launchpad")) or {}
    idle = [ch for ch in changes if spec_of(ch).get("followed") is not True]
    if idle:
        return {"valid": False, "problems": [f"{ch.get('field') or ch.get('launchpad') or ch.get('nodes') or 'trade_feed'}: not followed yet (the "
                                             f"{spec_of(ch).get('owner', 'feed')} does not read this wire yet); leave it as it is for now" for ch in idle]}
    return {"valid": True, "problems": [], "changes": changes, "changed_count": len(changes)}


if __name__ == "__main__":
    if sys.argv[1:2] == ["preview"] and len(sys.argv) == 3:
        try:
            p = json.load(open(sys.argv[2]))
        except Exception:
            p = None
        print(json.dumps(preview(p)))
    else:
        print(__doc__.split("\n\n")[0])
