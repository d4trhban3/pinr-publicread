"""every engine wire's measured state. Made-up counts in a temporary folder; no network.
Run:  python3 test_wires.py"""
import importlib, json, os, sys, tempfile
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path[:0] = [HERE]
import wires as W

results = []
def case(n, title, should, fn):
    try:
        ok, text = fn()
    except Exception as e:
        import traceback; traceback.print_exc()
        ok, text = False, f"CRASH {type(e).__name__}: {e}"
    results.append(ok)
    print(f"\n{n:>2}. {title}\n    should: {should}\n    did:    {text}\n    {'PASS' if ok else 'FAIL'}")


def fresh_module():
    importlib.reload(W)
    return W


T = 1_790_000_000.0
A = "s_jup|token data|a_token|Jupiter"
B = "e_build|evidence file|e_store|evidence file"
C = "s_x|posts|e_x|posts"


def c1():
    w = fresh_module(); d = tempfile.mkdtemp()
    w.meter(A, 30, {"id": "Coin1"}, now=T - 100)
    w.meter(A, 30, {"id": "Coin2"}, now=T - 40)
    w.meter(B, 1, {"coin": "Old"}, now=T - 900)
    w.error(C, "X refused: 429", now=T - 30)
    w.beat("a_mac", now=T - 1000)
    w.flush(now=T, force=True, path_dir=d)
    st = w.state(path_dir=d, now=T)
    a, b, c = st["wires"][A], st["wires"][B], st["wires"][C]
    return (a["state"] == "live" and a["per_min"] == 12.0 and a["sample"] == {"id": "Coin2"} and a["last_at"] == "2026-09-21T14:12:40Z"
            and b["state"] == "not live" and b["reason"] == "no data for 15 min" and b["per_min"] == 0.0
            and c["state"] == "not live" and c["reason"] == "X refused: 429"
            and st["nodes"]["a_token"]["state"] == "live" and st["nodes"]["s_jup"]["state"] == "live"
            and st["nodes"]["a_mac"]["state"] == "not live" and "heartbeat" in st["nodes"]["a_mac"]["reason"]), \
        (f"a wire with 60 items in the window: {a['state']}, {a['per_min']}/min, its newest sample {a['sample']}; one quiet 15 min: {b['state']} "
         f"({b['reason']}); a source that refused: {c['state']} ({c['reason']}); nodes of a live wire: {st['nodes']['a_token']['state']}; a node with an old beat: {st['nodes']['a_mac']['state']}")
case(1, "LIVE and NOT LIVE, measured", "LIVE with items a minute over the window, the last time and a real sample; NOT LIVE says why: how long since data, or the source's own refusal; a node is live when a wire of it is or it beat in the window", c1)


def c2():
    d = tempfile.mkdtemp()
    w = fresh_module(); w.DIR = d; w._proc[0] = "mac-handin"
    w.meter(A, 2, {"id": "First"}, now=T - 20); w.flush(now=T - 20, force=True)
    one = json.load(open(os.path.join(d, "mac-handin.json")))
    w = fresh_module(); w.DIR = d; w._proc[0] = "mac-handin"
    one["pid"] = -1; json.dump(one, open(os.path.join(d, "mac-handin.json"), "w"))      # as an earlier run of the command left it
    w.meter(A, 3, {"id": "Second"}, now=T - 10); w.flush(now=T - 10, force=True)
    st = w.state(path_dir=d, now=T)
    w._proc[0] = None; importlib.reload(W)
    return st["wires"][A]["per_min"] == 1.0 and st["wires"][A]["sample"] == {"id": "Second"}, \
        f"two runs of a short command under one name: {st['wires'][A]['per_min']}/min (2 + 3 items over 5 min), sample {st['wires'][A]['sample']}"
case(2, "A short command run many times keeps its counts", "a run under the same name adds what the last one left in the window; the newest sample wins", c2)


def c3():
    w = fresh_module()
    real = w.DIR; d = tempfile.mkdtemp(); w.DIR = os.path.join(d, "wires")
    try:
        w.meter(A, 5, {"id": "x"}, now=T)
        w.flush(now=T + 100, force=True)
        nothing = not os.path.exists(w.DIR)
        w.name("scanner"); w.flush(now=T + 200, force=True)
        named = os.path.exists(os.path.join(w.DIR, "scanner.json"))
    finally:
        w.DIR = real; w._proc[0] = None
    big = fresh_module(); big.meter(A, 1, {"x": "y" * 2000}, now=T)
    s = big._wires[A]["sample"]
    return nothing and named and isinstance(s, str) and len(s) <= big.SAMPLE_MAX + 1, \
        f"an unnamed process (a test, a one-off) wrote: {not nothing}; a named service wrote its file: {named}; a long sample kept at {len(s)} characters"
case(3, "Only a named service writes, and a sample stays short", "a test or one-off counts in memory and writes nothing into the engine; a named service writes control/wires/<name>.json; a sample is cut to its limit", c3)


def c4():
    w = fresh_module(); d = tempfile.mkdtemp()
    w.meter(A, 0, {"id": "none"}, now=T); w.meter(A, -3, None, now=T)
    w.flush(now=T, force=True, path_dir=d)
    st = w.state(path_dir=d, now=T)
    empty = w.state(path_dir=os.path.join(d, "missing"), now=T)
    return A not in st["wires"] and empty["wires"] == {} and empty["nodes"] == {}, \
        f"nothing counted for zero or fewer items ({A in st['wires']}); no folder yet: {empty['wires']}"
case(4, "No items is not a reading", "a count of zero or less leaves no trace (never a fake live wire); with no files yet every map is empty", c4)



def c5():
    """the team's W on debugfix: worker-N.json.tmp<pid> files left by processes that died mid-write piled up."""
    W = fresh_module()
    d = tempfile.mkdtemp()
    W.DIR = d                                                  # a named process writes its file: here, never the engine's folder
    W.name("worker-3")
    W.meter(A, 2, {"coin": "X"}, T)
    old, new, other = (os.path.join(d, n) for n in ("worker-3.json.tmp111", "worker-3.json.tmp222", "worker-4.json.tmp333"))
    for q in (old, new, other):
        open(q, "w").write("{}")
    os.utime(old, (T - W.TMP_STALE_S - 5, T - W.TMP_STALE_S - 5)); os.utime(new, (T - 5, T - 5)); os.utime(other, (T - 9999, T - 9999))
    p = W.flush(T, force=True, path_dir=d)
    left = sorted(f for f in os.listdir(d) if ".tmp" in f)
    real_dump = W.json.dump
    try:
        W.json.dump = lambda *a, **k: (_ for _ in ()).throw(OSError("disk full"))
        failed = W.flush(T + 1, force=True, path_dir=d)
    finally:
        W.json.dump = real_dump
    left2 = sorted(f for f in os.listdir(d) if ".tmp" in f)
    W._proc[0] = None
    ok = p and left == ["worker-3.json.tmp222", "worker-4.json.tmp333"] and failed is None and left2 == left
    return ok, f"after a write: left {left} (its own stale copy removed; a fresh one and another process's untouched); a write that fails mid-way leaves no file of its own: {left2 == left}"
case(5, "Leftover temporary files are cleaned up", "a write that fails removes its own temporary file; this process's copies over TMP_STALE_S old are removed; a fresh copy and another process's file are left", c5)


def c6():
    """DEBUG's M5 (26 Oct): the X check and the Mac lease run in bursts; between runs they read NOT LIVE. A recorded burst
    pattern replayed: 57 items, a 6-minute gap, 57 items, a 6-minute gap, 57 items."""
    W = fresh_module()
    d = tempfile.mkdtemp()
    X, ONE = "g_pass|to social scan|e_x|run", "a_pool|coin list|a_mac|coin list"
    for k in range(3):
        W.meter(X, 57, {"mint": "M"}, T + k * 360)
    W.meter(ONE, 12, None, T + 720)
    W.flush(T + 720, force=True, path_dir=d)
    mid = W.state(d, T + 720 + 400)                           # 6.7 min after the last burst: inside its usual gap
    late = W.state(d, T + 720 + 900)                          # 15 min: past 1.5 x the gap: it stopped
    x1, x2, o1 = mid["wires"][X], late["wires"][X], mid["wires"][ONE]
    ok = (x1["state"] == "live" and x1.get("between_runs") and "about every 6 min" in x1.get("reason", "")
          and x2["state"] == "not live" and "no data for 15 min" in x2.get("reason", "")
          and o1["state"] == "not live")
    return ok, f"between bursts: {x1['state']} ({x1.get('reason')}); 15 min after: {x2['state']} ({x2.get('reason')}); a wire with one burst and no rhythm yet: {o1['state']}"
case(6, "A wire that runs in bursts reads LIVE between runs (DEBUG's M5)", "after bursts 6 minutes apart, 6.7 minutes of quiet is 'between runs' (LIVE, said so); 15 minutes is NOT LIVE; a wire with no rhythm yet keeps the 5-minute window", c6)


def c7():
    """the team's W on followups: bursts every 10 min, then a 22-minute outage, then bursts again: the gap stays 10 min, so
    after the next 16 minutes of silence the wire reads NOT LIVE (before: the outage taught it a 16-minute rhythm)."""
    W = fresh_module()
    d = tempfile.mkdtemp()
    X = "s_x|posts|e_x|posts"
    times = [T, T + 600, T + 1200, T + 1200 + 1320, T + 1200 + 1320 + 600]
    for t in times:
        W.meter(X, 50, None, t)
    W.flush(times[-1], force=True, path_dir=d)
    gap = W._wires[X]["gap_s"]
    st = W.state(d, times[-1] + 16 * 60)["wires"][X]
    ok = gap == 600 and st["state"] == "not live"
    return ok, f"learned gap after the outage: {gap / 60:.0f} min; 16 min after the last burst: {st['state']}"
case(7, "An outage never stretches a bursty wire's rhythm", "bursts 10 min apart, a 22-minute outage, then bursts: the learned gap stays 10 min and 16 min of silence reads NOT LIVE", c7)

print(f"\n{sum(results)}/{len(results)} passed")
raise SystemExit(0 if all(results) else 1)
