"""the wires as routes. A temporary routing file; no network.
Run:  python3 test_routing.py"""
import copy, json, os, subprocess, sys, tempfile
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
os.environ["PINR_ROUTING_FILE"] = os.path.join(tempfile.mkdtemp(), "routing.json")
import routing as RT

results = []
def case(n, title, should, fn):
    try:
        ok, text = fn()
    except Exception as e:
        import traceback; traceback.print_exc()
        ok, text = False, f"CRASH {type(e).__name__}: {e}"
    results.append(ok)
    print(f"\n{n:>2}. {title}\n    should: {should}\n    did:    {text}\n    {'PASS' if ok else 'FAIL'}")

CAT = RT.catalog()
def fresh():
    RT._cur[0] = None
    if os.path.exists(RT.routing_file()):
        os.remove(RT.routing_file())

def write(r, version=3):
    json.dump({"version": version, "routing": r, "applied_by": "test"}, open(RT.routing_file(), "w"))
    RT._cur[0] = None


def c1():
    fresh()
    d = RT.defaults()
    sound = all(set(v["default"]) <= set(v["sources"]) and v["default"] and v["owner"] in ("engine", "feed") for v in CAT["fields"].values())
    return (sound and RT.current() == d and RT.validate(d) == [] and RT.version() == 0 and RT.route("picture") == ["jupiter", "ipfs", "pumpfun"]
            and RT.discovery_on("launchlab") and RT.route("nope") == []), \
        f"no file: today's order in force (version {RT.version()}), picture {RT.route('picture')}, every launchpad on: {all(RT.current()['discovery'].values())}; the catalog's defaults use only each field's own sources"
case(1, "Nothing changes until the operator applies a routing", "with no routing file, every field keeps today's order and every launchpad stays on; the catalog's own defaults are valid", c1)


def c2():
    d = RT.defaults()
    bad = {}
    r = copy.deepcopy(d); r["routes"]["picture"] = []; bad["empty field"] = RT.validate(r)
    r = copy.deepcopy(d); del r["routes"]["links"]; bad["missing field"] = RT.validate(r)
    r = copy.deepcopy(d); r["routes"]["token_data"] = ["jupiter", "dexscreener"]; bad["source it cannot use"] = RT.validate(r)
    r = copy.deepcopy(d); r["routes"]["price"] = ["jupiter", "jupiter"]; bad["listed twice"] = RT.validate(r)
    r = copy.deepcopy(d); r["routes"]["mood"] = ["jupiter"]; bad["unknown field"] = RT.validate(r)
    r = copy.deepcopy(d); r["discovery"] = {k: False for k in r["discovery"]}; bad["every launchpad off"] = RT.validate(r)
    r = copy.deepcopy(d); r["discovery"]["bags"] = "off"; bad["not on/off"] = RT.validate(r)
    r = copy.deepcopy(d); r["discovery"]["madeup"] = True; bad["unknown launchpad"] = RT.validate(r)
    bad["not an object"] = RT.validate(["x"])
    return all(bad.values()), "; ".join(f"{k}: {v[0]}" for k, v in bad.items())
case(2, "The server refuses a routing that would leave a field with no source", "an empty or missing field, a source the field cannot use, a source listed twice, an unknown field or launchpad, every launchpad off, or a switch that is not on/off are each refused, in plain words", c2)


def c3():
    fresh()
    r = RT.defaults(); r["routes"]["picture"] = ["ipfs", "jupiter"]; r["discovery"]["bags"] = False
    write(r, 4)
    live = (RT.route("picture"), RT.discovery_on("bags"), RT.version())
    bad = RT.defaults(); bad["routes"]["picture"] = []
    write(bad, 5)
    refused = RT.route("picture")
    json.dump("not a routing", open(RT.routing_file(), "w")); RT._cur[0] = None
    junk = RT.route("picture")
    return (live == (["ipfs", "jupiter"], False, 4) and refused == RT.defaults()["routes"]["picture"] and junk == refused), \
        f"applied version 4: picture {live[0]}, bags {'on' if live[1] else 'off'}; a file that fails validation: today's order {refused}; an unreadable file: {junk}"
case(3, "The engine reads the routing live", "an applied routing is followed at the next read (no restart); a file that fails validation or cannot be read is never followed: today's order holds", c3)


def c4():
    fresh()
    r = RT.defaults(); r["routes"]["picture"] = ["ipfs"]; r["routes"]["links"] = ["pumpfun", "ipfs"]; r["discovery"]["stonkfun"] = False
    p = RT.preview(r)
    by = {c.get("field") or c.get("launchpad"): c for c in p["changes"]}
    bad = RT.defaults(); bad["routes"]["links"] = []
    pb = RT.preview(bad)
    idle = RT.defaults(); idle["routes"]["price"] = ["dexscreener", "jupiter"]; idle["discovery"]["pumpfun"] = False
    unread = copy.deepcopy(CAT); unread["fields"]["price"]["followed"] = False; unread["discovery"]["pumpfun"]["followed"] = False
    pi = RT.preview(idle, unread)                            # the team's W1: a wire nothing reads is refused
    pf = RT.preview(idle)                                    # since the site's 09975098 the feed reads its wires: the same change is valid
    tmp = os.path.join(tempfile.mkdtemp(), "p.json"); json.dump(r, open(tmp, "w"))
    cli = json.loads(subprocess.run([sys.executable, os.path.join(HERE, "routing.py"), "preview", tmp], capture_output=True, text=True, timeout=60).stdout)
    return (p["valid"] and p["changed_count"] == 3 and by["picture"]["dropped"] == ["jupiter", "pumpfun"] and by["picture"]["owner"] == "engine"
            and by["links"]["after"] == ["pumpfun", "ipfs"] and by["stonkfun"]["before"] is True and by["stonkfun"]["after"] is False
            and pb == {"valid": False, "problems": pb["problems"]} and pb["problems"] and cli["changed_count"] == 3
            and pi["valid"] is False and len(pi["problems"]) == 2 and all("not followed yet" in x for x in pi["problems"])
            and pf["valid"] and pf["changed_count"] == 2 and {c["owner"] for c in pf["changes"]} == {"feed"}), \
        (f"{p['changed_count']} changes: picture drops {by['picture']['dropped']} (engine), links {by['links']['before']} → {by['links']['after']}, Stonk.fun on → off; "
         f"an invalid one: {pb['problems'][0]}; price and Pump.fun discovery on a catalog where nothing reads them: {pi['problems'][0]}; on today's catalog (the feed reads them): {pf['changed_count']} changes, owner feed; the control service's command gives the same")
case(4, "The before/after the operator sees before Apply", "each field and launchpad that would change, before and after, what a field loses, and who follows it (engine or feed); an invalid routing gives only its problems; a wire nothing reads yet is refused, never shown as applied; the feed's wires are read since the site's 09975098", c4)


KINDS = list(CAT["nodes"]["kinds"])
def wired(**over):
    r = RT.defaults()
    r["nodes"] = {k: ["public", "publicnode"] for k in KINDS}
    r["nodes"].update(over)
    return r

def c5():
    bad = {}
    r = wired(); r["nodes"]["largest_holders"] = []; bad["a kind with no node"] = RT.validate(r)
    r = wired(); del r["nodes"]["transactions"]; bad["a kind left out"] = RT.validate(r)
    r = wired(); r["nodes"]["other"] = ["public", "madeup"]; bad["unknown node"] = RT.validate(r)
    r = wired(); r["nodes"]["token_accounts"] = ["public", "public"]; bad["node twice"] = RT.validate(r)
    r = wired(); r["nodes"]["mood"] = ["public"]; bad["unknown kind"] = RT.validate(r)
    r = RT.defaults(); r["trade_feed"] = {"nodes": [], "coins": 40}; bad["feed with no node"] = RT.validate(r)
    r = RT.defaults(); r["trade_feed"] = {"nodes": ["public", "publicnode", "chainstack"], "coins": 40}; bad["feed with three nodes"] = RT.validate(r)
    r = RT.defaults(); r["trade_feed"] = {"nodes": ["public", "instantnodes"], "coins": 40}; bad["feed unknown node"] = RT.validate(r)
    r = RT.defaults(); r["trade_feed"] = {"nodes": ["public"], "coins": 0}; bad["feed 0 coins"] = RT.validate(r)
    r = RT.defaults(); r["trade_feed"] = {"nodes": ["public"], "coins": True}; bad["feed coins not a number"] = RT.validate(r)
    good = wired(); good["trade_feed"] = {"nodes": ["public", "chainstack"], "coins": 200}
    return all(bad.values()) and RT.validate(good) == [], "; ".join(f"{k}: {v[0]}" for k, v in bad.items()) + f"; a sound wiring: {RT.validate(good) or 'no problems'}"
case(5, "Node wires and the trade feed's wire are checked like the others", "each kind of read needs at least one known node, none twice; the trade feed takes one or two known nodes and a whole coin count in range; a sound wiring passes", c5)


def c6():
    env = {"CHAINSTACK_SOLANA_URL": "https://made-up.example/x"}
    r = wired(largest_holders=["helius_official", "public"]); r["trade_feed"] = {"nodes": ["public", "shyft"], "coins": 40}
    lp = RT.live_problems(r, env=env, control={"sources": {}})
    off = wired(other=["chainstack", "public"])
    import solana_rpc as S
    lo = RT.live_problems(off, env=env, control={"sources": {S.COUNT_NAMES.get("chainstack", "chainstack"): {"on": False}}})
    ok = wired(other=["chainstack", "public"]); ok["trade_feed"] = {"nodes": ["public", "chainstack"], "coins": 40}
    lk = RT.live_problems(ok, env=env, control={"sources": {}})
    return (any("helius_official" in x and ".env" in x for x in lp) and any("trade_feed: shyft" in x for x in lp)
            and any("chainstack" in x and "switched off" in x for x in lo) and lk == [] and not any("made-up" in x for x in lp + lo)), \
        f"no key for it: {lp}; switched off on /control: {lo}; addresses present and on: {lk or 'no problems'} (never a value in the words)"
case(6, "Before Apply, the server checks each wired node can really be used", "a node with no address in the server's .env, or one switched off on /control, is refused at preview in plain words that never show the address; nodes that are present and on pass", c6)


def c7():
    fresh()
    before = (RT.node_route("largest_holders"), RT.trade_feed())
    r = wired(largest_holders=["publicnode", "public"]); r["trade_feed"] = {"nodes": ["publicnode"], "coins": 70}
    write(r, 6)
    after = (RT.node_route("largest_holders"), RT.node_route(RT.kind_of("getTokenLargestAccounts")), RT.kind_of("getTransaction"), RT.kind_of("getBalance"), RT.trade_feed())
    p = RT.preview(wired(largest_holders=["public"]))
    ch = [c for c in p.get("changes", []) if c.get("nodes") == "largest_holders"]
    fresh()
    return (before == (None, None) and after[0] == ["publicnode", "public"] and after[1] == after[0] and after[2] == "transactions" and after[3] == "other"
            and after[4] == {"nodes": ["publicnode"], "coins": 70} and p["valid"] and ch and ch[0]["before"] == ["publicnode", "public"] and ch[0]["after"] == ["public"]), \
        f"no wires: {before}; applied: largest holders {after[0]}, getTransaction is {after[2]}, getBalance is {after[3]}, the feed {after[4]}; preview shows largest holders {ch[0]['before'] if ch else None} → {ch[0]['after'] if ch else None}"
case(7, "The node wires are read live by kind of read", "with no wires, today's order (None); an applied wiring gives each kind its nodes in order, each method its kind (an unlisted one is 'other'), the feed its nodes and coins; the preview shows each kind's before and after", c7)


def c8():
    import solana_rpc as S
    fresh()
    saved_env, saved_ep = dict(S._ENV), list(S.ENDPOINTS)
    try:
        S.ENDPOINTS[:] = [("shyft", "https://shyft.test/", 0.0), ("helius", "https://helius.test/", 0.0), ("public", "https://public.test/", 0.0)]
        off = {"sources": {"helius": {"on": False}}}
        eff = RT.effective_nodes(control=off)
        tf = RT.live_problems({"trade_feed": {"nodes": ["public", "helius"], "coins": 40}}, env={"HELIUS_API_KEY": "made-up"}, control=off)
        none_yet = RT.nodes_fallback()
        S._ENV.clear(); S._ROUTED.clear()                    # every wired node loses its .env line after apply
        write(wired(largest_holders=["shyft"], token_accounts=["shyft"]), 8)
        fell = RT.nodes_fallback()
    finally:
        S._ENV.clear(); S._ENV.update(saved_env); S.ENDPOINTS[:] = saved_ep; S._ROUTED.clear(); fresh()
    return (all("helius" not in v and v for v in eff.values()) and any("trade_feed: helius is switched off" in x for x in tf)
            and none_yet == [] and fell == ["largest_holders", "token_accounts"]), \
        f"in force with Helius switched off: {eff}; the trade feed wired to Helius: {tf}; no wires: fallback {none_yet}; wires whose nodes lost their .env line: {fell}"
case(8, "the team's W2 and W3 on cb95edd6: what /control is told", "the node order in force leaves out a node switched off on /control (no read goes to it); the trade feed's nodes get the same switched-off check; a kind whose wired nodes all lost their address is named as served by today's order", c8)


print(f"\n{sum(results)}/{len(results)} passed")
raise SystemExit(0 if all(results) else 1)
