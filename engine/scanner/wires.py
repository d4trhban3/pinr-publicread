"""every engine node and wire on pinr.io/control reports one measured state. A wire is measured where its data
crosses in the code: `meter(wire, n, sample)` counts the items, keeps the last time and one real sample; `error(wire, why)`
keeps a source's refusal; `beat(node)` says a node ran. Each process keeps its own counts and writes them whole to
`control/wires/<process>.json` at most every FLUSH_S; the control service merges the files and says LIVE (data in the last
WINDOW_S) or NOT LIVE with the reason. A wire's name is the map's own: from|fromPort|to|toPort (pinr-live's blueprint).
Nothing here ever stops the work it measures: a failure to count or write is swallowed."""
from __future__ import annotations
import json, os, sys, threading, time

HERE = os.path.dirname(os.path.abspath(__file__))
DIR = os.path.join(HERE, "..", "control", "wires")
FLUSH_S = 15            # how often a process writes its counts
WINDOW_S = 300          # the window a wire counts as LIVE in, and its items/min are measured over
GAP_MIN_S = 60          # a pause longer than this is a gap between bursts; each wire keeps its usual gap (gap_s), and while
GAP_FACTOR = 1.5        # it is quiet less than GAP_FACTOR x that (and never less than WINDOW_S) it reads LIVE "between runs"
GAP_OUTAGE = 1.5        # a pause over GAP_OUTAGE x the usual gap is an outage: it never teaches the wire a longer rhythm
                        # 
                        # (DEBUG's M5, 26 Oct: the X check and the Mac lease run in bursts; 5 minutes is shorter than their gaps)
SAMPLE_MAX = 400        # characters of the sample kept

_lock = threading.Lock()
_wires: dict = {}       # wire -> {"buckets": {minute: n}, "last_at", "sample", "error", "error_at"}
_nodes: dict = {}       # node -> last beat
_proc = [None]
_last_flush = [0.0]


def _short(v):
    try:
        s = json.dumps(v, default=str)
    except Exception:
        s = json.dumps(str(v))
    return json.loads(s) if len(s) <= SAMPLE_MAX else s[:SAMPLE_MAX] + "…"


_merged = [False]


def name(process: str) -> None:
    """The process's own name (its file); the scanner, sqd_live, chains and the X check each set theirs. A short command run
    many times (the Mac's lease and hand-in) shares one name: its first write adds what the last run counted, and it writes
    once more as it ends."""
    _proc[0] = "".join(ch for ch in process if ch.isalnum() or ch in "-_") or None
    import atexit
    atexit.register(lambda: flush(force=True))


def _merge_old(p: str, now: float | None = None) -> None:
    """Once a process: the counts an earlier process of the same name left in `p` (within the window) join this one's."""
    if _merged[0]:
        return
    _merged[0] = True
    try:
        old = json.load(open(p))
    except Exception:
        return
    if old.get("pid") == os.getpid():
        return
    lo = int(((now or time.time()) - WINDOW_S) // 60)
    for node, t in (old.get("nodes") or {}).items():
        _nodes[node] = max(_nodes.get(node, 0), t)
    for k, v in (old.get("wires") or {}).items():
        w = _wires.setdefault(k, {"buckets": {}})
        for m, c in (v.get("buckets") or {}).items():
            if int(m) > lo:
                w["buckets"][int(m)] = w["buckets"].get(int(m), 0) + c
        if (v.get("last_at") or 0) > (w.get("last_at") or 0):
            w["last_at"] = v["last_at"]
            if "sample" in v and "sample" not in w:
                w["sample"] = v["sample"]
        if v.get("gap_s") and not w.get("gap_s"):
            w["gap_s"] = v["gap_s"]
        if (v.get("error_at") or 0) > (w.get("error_at") or 0):
            w["error"], w["error_at"] = v.get("error"), v["error_at"]


def meter(wire: str, n: int = 1, sample=None, now: float | None = None) -> None:
    """`n` items crossed `wire` now; `sample` one of them, as read (kept short). n <= 0 counts nothing."""
    try:
        if not isinstance(n, int) or n <= 0:
            return
        now = now or time.time()
        with _lock:
            w = _wires.setdefault(wire, {"buckets": {}})
            m = int(now // 60)
            w["buckets"][m] = w["buckets"].get(m, 0) + n
            for k in [k for k in w["buckets"] if k < m - WINDOW_S // 60]:
                del w["buckets"][k]
            last = w.get("last_at")
            gap = now - last if last else 0
            if gap > GAP_MIN_S and (not w.get("gap_s") or gap <= GAP_OUTAGE * w["gap_s"]):   # a burst after a pause: the usual gap,
                w["gap_s"] = round(gap if not w.get("gap_s") else 0.5 * w["gap_s"] + 0.5 * gap, 1)   # averaged; a pause far
                                                                                                  # longer is an outage, not a rhythm
            w["last_at"] = now
            if sample is not None:
                w["sample"] = _short(sample)
        flush(now)
    except Exception:
        pass


def error(wire: str, why: str, now: float | None = None) -> None:
    """A source refused or failed on `wire` (shown with NOT LIVE when nothing crossed it since)."""
    try:
        now = now or time.time()
        with _lock:
            w = _wires.setdefault(wire, {"buckets": {}})
            w["error"], w["error_at"] = str(why)[:200], now
        flush(now)
    except Exception:
        pass


def beat(node: str, now: float | None = None) -> None:
    try:
        now = now or time.time()
        with _lock:
            _nodes[node] = now
        flush(now)
    except Exception:
        pass


TMP_STALE_S = 600       # a temporary file this old belongs to a process that died mid-write


def _sweep(p: str, now: float) -> None:
    """Remove this file's leftover temporary copies (`<name>.json.tmp<pid>`) over TMP_STALE_S old."""
    try:
        d, base = os.path.dirname(p), os.path.basename(p) + ".tmp"
        for f in os.listdir(d):
            q = os.path.join(d, f)
            if f.startswith(base) and now - os.path.getmtime(q) > TMP_STALE_S:
                os.remove(q)
    except Exception:
        pass


def flush(now: float | None = None, force: bool = False, path_dir: str | None = None) -> str | None:
    """Write this process's counts whole (a temporary file, then one rename), at most every FLUSH_S unless forced."""
    try:
        now = now or time.time()
        if not _proc[0] and not path_dir:                    # only a named service writes (a test or a one-off counts nothing)
            return None
        if not force and now - _last_flush[0] < FLUSH_S:
            return None
        _last_flush[0] = now
        proc = _proc[0] or f"pid{os.getpid()}"
        with _lock:
            body = {"process": proc, "pid": os.getpid(), "written_at": now, "nodes": dict(_nodes),
                    "wires": {k: {"buckets": {str(m): c for m, c in v["buckets"].items()}, **{x: v[x] for x in ("last_at", "sample", "error", "error_at", "gap_s") if x in v}}
                              for k, v in _wires.items()}}
        d = path_dir or DIR
        os.makedirs(d, exist_ok=True)
        p = os.path.join(d, proc + ".json")
        with _lock:
            _merge_old(p, now)
            body["nodes"] = dict(_nodes)
            body["wires"] = {k: {"buckets": {str(m): c for m, c in v["buckets"].items()}, **{x: v[x] for x in ("last_at", "sample", "error", "error_at", "gap_s") if x in v}}
                             for k, v in _wires.items()}
        tmp = p + ".tmp" + str(os.getpid())
        try:
            with open(tmp, "w") as f:
                json.dump(body, f)
            os.replace(tmp, p)                                     # each process its own temporary name (two may write at once)
        finally:
            if os.path.exists(tmp):
                os.remove(tmp)
        _sweep(p, now)
        return p
    except Exception:
        return None


def state(path_dir: str | None = None, now: float | None = None) -> dict:
    """Every process's file merged: {"as_of", "window_s", "nodes": {node: {state, last_at, reason?}}, "wires": {wire: {state,
    per_min, last_at, sample, reason?}}}. LIVE: an item in the last WINDOW_S; NOT LIVE: the reason (the last error after the
    last item, else how long since data). A node is LIVE when it beat, or a wire out of or into it is LIVE, within the window."""
    now = now or time.time()
    d = path_dir or DIR
    wires, nodes = {}, {}
    try:
        names = [f for f in os.listdir(d) if f.endswith(".json")]
    except OSError:
        names = []
    for f in names:
        try:
            body = json.load(open(os.path.join(d, f)))
        except Exception:
            continue
        for node, t in (body.get("nodes") or {}).items():
            nodes[node] = max(nodes.get(node, 0), t)
        for k, v in (body.get("wires") or {}).items():
            w = wires.setdefault(k, {"buckets": {}, "last_at": None})
            for m, c in (v.get("buckets") or {}).items():
                w["buckets"][int(m)] = w["buckets"].get(int(m), 0) + c
            if (v.get("last_at") or 0) > (w["last_at"] or 0):
                w["last_at"], w["sample"] = v["last_at"], v.get("sample")
            if (v.get("error_at") or 0) > (w.get("error_at") or 0):
                w["error"], w["error_at"] = v.get("error"), v["error_at"]
            w["gap_s"] = max(w.get("gap_s") or 0, v.get("gap_s") or 0) or None
    iso = lambda t: time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(t)) if t else None
    out_w = {}
    for k, w in wires.items():
        lo = int((now - WINDOW_S) // 60)
        n = sum(c for m, c in w["buckets"].items() if m > lo)
        window = max(WINDOW_S, GAP_FACTOR * (w.get("gap_s") or 0))
        live = bool(w["last_at"]) and now - w["last_at"] <= window
        rec = {"state": "live" if live else "not live", "per_min": round(n / (WINDOW_S / 60), 2) if live else 0.0,
               "last_at": iso(w["last_at"]), "sample": w.get("sample")}
        if live and now - w["last_at"] > WINDOW_S:                # quiet, but within its usual gap: it runs in bursts
            rec["between_runs"] = True
            rec["reason"] = f"runs in bursts about every {int(w['gap_s'] // 60)} min; the last {int((now - w['last_at']) // 60)} min ago"
        if not live:
            err = w.get("error") if (w.get("error_at") or 0) >= (w["last_at"] or 0) else None
            rec["reason"] = err or (f"no data for {int((now - w['last_at']) // 60)} min" if w["last_at"] else "no data yet")
        out_w[k] = rec
    for k, rec in out_w.items():
        if rec["state"] == "live":
            a, _p, b, _q = (k.split("|") + ["", "", "", ""])[:4]
            for node in (a, b):
                nodes[node] = max(nodes.get(node, 0), now - 1)       # data crossed a wire of it: it ran
    out_n = {}
    for node, t in nodes.items():
        live = now - t <= WINDOW_S
        out_n[node] = {"state": "live" if live else "not live", "last_at": iso(t)}
        if not live:
            out_n[node]["reason"] = f"no heartbeat for {int((now - t) // 60)} min"
    return {"as_of": iso(now), "window_s": WINDOW_S, "nodes": out_n, "wires": out_w}


if __name__ == "__main__":
    if sys.argv[1:2] == ["state"]:
        print(json.dumps(state()))
    else:
        print(__doc__.split("\n\n")[0])
