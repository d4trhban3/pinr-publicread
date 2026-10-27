"""a design decision, pinr.io/control, the engine's half: every outside request an engine process makes goes through Python's
urllib, so one wrapper there (installed once per process) can
  - honour the control file (`control/control.json`, re-read every few seconds): a source switched off is not asked at
    all, and a source with a pace is held to it (per process);
  - record each request's outcome per minute (answered, error, 429, timeout) in `index/control_stats.sqlite`;
and the scanner writes the rolling hour per source to `control/status-engine.json` for the control service.
A source is the request counter's name for the host (stage2/solana_rpc.py LABELS). Nothing here reads or writes a key."""
from __future__ import annotations
import json, os, socket, sqlite3, sys, threading, time, urllib.error, urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, os.path.join(ROOT, "stage2"))

CONTROL_FILE = None          # tests set their own; else PINR_CONTROL_FILE or <engine>/control/control.json
STATS_DB = None              # tests set their own; else PINR_CONTROL_STATS or <engine>/index/control_stats.sqlite
REREAD_S = 5
_cfg = [{}, 0.0]
_last_sent: dict = {}
_lock = threading.Lock()
_pending: dict = {}           # (minute, source) -> [calls, ok, errors, http429, timeouts, last_ok]
_flushed = [0.0]
_installed = [None]


def control_file() -> str:
    return CONTROL_FILE or os.environ.get("PINR_CONTROL_FILE") or os.path.join(ROOT, "control", "control.json")


def stats_db() -> str:
    return STATS_DB or os.environ.get("PINR_CONTROL_STATS") or os.path.join(ROOT, "index", "control_stats.sqlite")


def config() -> dict:
    """The control file, re-read at most every REREAD_S; an unreadable or missing file means every source on, no pace."""
    now = time.time()
    if now - _cfg[1] >= REREAD_S:
        try:
            d = json.load(open(control_file()))
            _cfg[0] = d if isinstance(d, dict) else {}
        except Exception:
            _cfg[0] = {}
        _cfg[1] = now
    return _cfg[0]


OWN_NODES = ("helius_official", "alchemy_official")   # the same hosts as Helius and Alchemy, their own nodes on /control


OWN_KEYS = {"alchemy_official": ("ALCHEMY_OFFICIAL_KEY", ".g.alchemy.com"), "helius_official": ("HELIUS_OFFICIAL_KEY", "helius")}


def source_of(url: str) -> str:
    try:
        import solana_rpc
        for name, node, _pace in solana_rpc.ENDPOINTS:      # told apart by the whole node address (never printed), not the host
            if name in OWN_NODES and url.startswith(node):
                return name
        host = url.split("/")[2].split("@")[-1].split(":")[0].lower() if "//" in url else ""
        for name, (var, part) in OWN_KEYS.items():          # 252: the official key on another network (Base, BNB) is still its own
            key = str(solana_rpc._ENV.get(var) or "").strip()   # source on /control, never the switched-off older key (248)
            if key and part in host and key in url:
                return name
        return solana_rpc.label(url)
    except Exception:
        return "other"


def credits_now() -> dict:
    """each counted provider that is listed, its month so far against its cap: {name: {used, cap, unit, month}}."""
    try:
        import solana_rpc as S
        out = {}
        for name, _node, _pace in S.ENDPOINTS:
            if name in S.CREDIT_COST:
                out[name] = {"used": S.month_credits(name), "cap": S.credit_cap(name=name), "month": S._month(),
                             "unit": "compute units" if name.startswith("alchemy") else ("request units" if name == "chainstack" else "credits")}
        return out
    except Exception:
        return {}


def rule(source: str) -> dict:
    r = (config().get("sources") or {}).get(source)
    return r if isinstance(r, dict) else {}


class SwitchedOff(urllib.error.URLError):
    """A source switched off in pinr.io/control: the request is never sent."""


def _record(source: str, kind: str, now: float | None = None) -> None:
    t = now or time.time()
    minute = int(t // 60) * 60
    with _lock:
        row = _pending.setdefault((minute, source), [0, 0, 0, 0, 0, None])
        row[0] += 1
        if kind == "ok":
            row[1] += 1; row[5] = t
        else:
            row[2] += 1
            if kind == "429":
                row[3] += 1
            elif kind == "timeout":
                row[4] += 1
        due = time.time() - _flushed[0] >= 5
    if due:
        flush()


def flush() -> None:
    with _lock:
        rows, _pending_copy = list(_pending.items()), None
        _pending.clear()
        _flushed[0] = time.time()
    if not rows:
        return
    try:
        os.makedirs(os.path.dirname(stats_db()), exist_ok=True)
        c = sqlite3.connect(stats_db(), timeout=10)
        c.execute("CREATE TABLE IF NOT EXISTS stats (minute INTEGER, source TEXT, calls INTEGER, ok INTEGER, errors INTEGER, "
                  "http429 INTEGER, timeouts INTEGER, last_ok REAL, PRIMARY KEY (minute, source))")
        for (minute, source), (n, ok, err, r429, to, last) in rows:
            c.execute("""INSERT INTO stats VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(minute, source) DO UPDATE SET
                         calls=calls+excluded.calls, ok=ok+excluded.ok, errors=errors+excluded.errors, http429=http429+excluded.http429,
                         timeouts=timeouts+excluded.timeouts, last_ok=MAX(COALESCE(last_ok,0), COALESCE(excluded.last_ok,0))""",
                      (minute, source, n, ok, err, r429, to, last))
        c.execute("DELETE FROM stats WHERE minute < ?", (int(time.time()) - 2 * 86400,))
        c.commit(); c.close()
    except Exception:
        pass


def install() -> None:
    """Wrap urllib.request.urlopen in this process (once): the control file's switch and pace, and the outcome record."""
    if _installed[0] is not None:
        return
    real = urllib.request.urlopen
    _installed[0] = real
    import atexit
    atexit.register(flush)                                   # a short run (the X check's timers) keeps its last calls too

    def urlopen(url, *a, **k):
        target = url.full_url if isinstance(url, urllib.request.Request) else str(url)
        source = source_of(target)
        r = rule(source)
        if r.get("on") is False:
            raise SwitchedOff(f"{source} is switched off in pinr.io/control")
        pace = r.get("pace_per_min")
        if isinstance(pace, (int, float)) and not isinstance(pace, bool) and pace > 0:
            with _lock:
                wait = _last_sent.get(source, 0) + 60.0 / pace - time.time()
                _last_sent[source] = time.time() + max(0.0, wait)
            if wait > 0:
                time.sleep(wait)
        try:
            resp = real(url, *a, **k)
        except urllib.error.HTTPError as e:
            # the team 2026-10-25: Pump.fun's 404 ("not found": the first trade of a coin it has none for) is its own answer, as
            # pumpfun_api counts it; anywhere else a 404 may be a moved endpoint and stays an error
            _record(source, "ok" if e.code == 404 and source.startswith("pumpfun") else "429" if e.code == 429 else "error")
            raise
        except (socket.timeout, TimeoutError) as e:
            _record(source, "timeout")
            raise
        except urllib.error.URLError as e:
            _record(source, "timeout" if isinstance(getattr(e, "reason", None), (socket.timeout, TimeoutError)) else "error")
            raise
        _record(source, "ok")
        return resp

    urllib.request.urlopen = urlopen


def rolling_hour(now: float | None = None) -> dict:
    """{source: {calls, ok, errors, http429, timeouts, last_ok}} over the last 60 minutes, from the stats file."""
    now = now or time.time()
    flush()
    try:
        c = sqlite3.connect(f"file:{stats_db()}?mode=ro", uri=True, timeout=10)
        rows = c.execute("SELECT source, SUM(calls), SUM(ok), SUM(errors), SUM(http429), SUM(timeouts), MAX(last_ok) FROM stats "
                         "WHERE minute >= ? GROUP BY source", (int(now) - 3600,)).fetchall()
        last = dict(c.execute("SELECT source, MAX(last_ok) FROM stats GROUP BY source").fetchall())
        c.close()
    except Exception:
        return {}
    iso = lambda t: time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(t)) if t else None
    return {s: {"calls": n, "ok": ok, "errors": err, "http429": r429, "timeouts": to, "last_ok": iso(last.get(s))}
            for s, n, ok, err, r429, to, _l in rows}


def nodes_effective() -> dict:
    """243 phase 2: the Solana node order in force for each kind of read (the wires when set, else today's order); {} when unreadable."""
    try:
        sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
        import routing
        return routing.effective_nodes()
    except Exception:
        return {}


def nodes_fallback() -> list:
    """the team's W3 on cb95edd6: the kinds of read whose wire lost every usable node (today's order serves them); []."""
    try:
        sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
        import routing
        return routing.nodes_fallback()
    except Exception:
        return []


def write_status(path: str | None = None, now: float | None = None) -> str:
    """control/status-engine.json for the control service, written whole."""
    path = path or os.path.join(os.path.dirname(control_file()), "status-engine.json")
    body = {"as_of": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(now or time.time())), "window_s": 3600,
            "sources": rolling_hour(now), "credits": credits_now(), "control": config(), "nodes_effective": nodes_effective(),
            "nodes_fallback": nodes_fallback()}
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = path + ".tmp"
    json.dump(body, open(tmp, "w"), indent=1)
    os.replace(tmp, path)
    return path


def start_status(every_s: int = 30) -> threading.Thread:
    def run():
        while True:
            try:
                write_status()
            except Exception:
                pass
            time.sleep(every_s)
    t = threading.Thread(target=run, name="control-status", daemon=True)
    t.start()
    return t
