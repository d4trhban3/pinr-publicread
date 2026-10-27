"""optional extra scoring workers on a second machine.

The worker machine asks the server for page coins (`scanner.py lease N` over its SSH key to the server), scores them with the
engine's own scorer, reading Solana only through the RPC providers configured in its own .env (RPC_A_SOLANA_URL,
RPC_B_SOLANA_URL, RPC_C_SOLANA_URL: your RPC provider endpoints), and hands each result to the server (`scanner.py handin`),
which writes everything the site reads. Before each batch it copies PINR's memory of labelled coins from the server.
It writes no feed file of its own and stops when its process ends.

Run from the worker machine's engine copy:  python3 scanner/extra_worker.py [workers, 1 to 16; 4 when not given]
"""
from __future__ import annotations
import json, os, re, subprocess, sys, time
from multiprocessing import get_context

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
for _p in ("stage2", "stage3", "pinr-index", "pinr-step2", "feed", "scanner"):
    sys.path.insert(0, os.path.join(ROOT, _p))

AIR = os.environ.get("PINR_AIR", "user@your-server")
AIR_KEY = os.path.expanduser(os.environ.get("PINR_AIR_KEY", "~/.ssh/pinr_server"))
AIR_ENGINE = "~/pinr/engine"
EXTRA_NODES = ("rpc_a", "rpc_b", "rpc_c",      # your RPC providers for this machine; every other node stays on the server,
             "helius_official", "alchemy_official")         # except the operator's official keys
WORKERS_DEFAULT, WORKERS_MAX = 4, 16                         # the most workers allowed
IDLE_S = 20                                                  # nothing handed out: ask again after this
PUMPFUN_SHARE = 1 / 3                                        # the worker machine's share of Pump.fun's per-address budgets 
MEMORY = os.path.join(ROOT, "stage3", "memory", "labeled_tokens.json")
_MINT_RE = re.compile(r"^[1-9A-HJ-NP-Za-km-z]{32,44}$")
_REMEMBERED: list = []


def extra_endpoints(env=None) -> list:
    """the worker machine's node list: its configured RPC providers and the official keys that have their line in the .env, in that order; [] when none has."""
    import solana_rpc as R
    return R.build_endpoints(list(EXTRA_NODES), R._ENV if env is None else env)


def workers(arg=None) -> int:
    try:
        n = int(arg)
    except (TypeError, ValueError):
        return WORKERS_DEFAULT
    return n if 1 <= n <= WORKERS_MAX else WORKERS_DEFAULT


def setup_scoring() -> None:
    """In each scoring process: Solana through the worker machine's nodes only; the server writes the feed (at hand-in), so no feed file
    here; every label the scorer remembers is kept to hand to the server; Pump.fun's per-address budgets at the worker machine's share."""
    os.chdir(os.path.join(ROOT, "stage2"))                   # as the scanner's own worker: Stage 2 reads and writes relative to its folder
    import solana_rpc as R
    R.ENDPOINTS[:] = extra_endpoints()
    R._node_route = lambda method: None                      # the node wires are the server's; this machine keeps its own providers
    import pumpfun_api as P
    P.BUDGET = {h: (max(1, int(b * PUMPFUN_SHARE)), r * PUMPFUN_SHARE) for h, (b, r) in P.BUDGET.items()}
    import run_stage2, brakes
    run_stage2._feed = lambda out: None
    real = brakes.remember
    def remember(*a, **k):
        _REMEMBERED.append(json.loads(json.dumps(list(a), default=str)))
        return real(*a, **k)
    brakes.remember = remember


def score_one(mint: str, score=None) -> dict:
    """One coin, scored here; what is handed to the server: the result, the label to remember, or the failure."""
    t0 = time.time()
    _REMEMBERED.clear()
    try:
        if score is None:
            os.chdir(os.path.join(ROOT, "stage2"))
            import run_stage2
            score = lambda m: run_stage2.score_token("live scan", m, None)
        out = json.loads(json.dumps(score(mint), default=str))
        rem = next((r for r in _REMEMBERED if r and r[0] == mint), None)
        res = {"mint": mint, "result": out, "remember": rem, "seconds": round(time.time() - t0)}
        try:                                                     # the Pump.fun reads this score made, for the server's /control
            import pumpfun_api as _P
            tally = _P.take_tally()
            if tally:
                res["pump"] = tally
        except Exception:
            pass
        return res
    except Exception as e:
        import scanner
        return {"mint": mint, "error": scanner.quiet(f"{type(e).__name__}: {e}")[:300], "seconds": round(time.time() - t0)}


def ssh(cmd: str, stdin: str | None = None, run=subprocess.run) -> str:
    r = run(["ssh", "-i", AIR_KEY, "-o", "BatchMode=yes", "-o", "ConnectTimeout=10", AIR, f"cd {AIR_ENGINE} && {cmd}"],
            input=stdin, capture_output=True, text=True, timeout=180)
    if r.returncode != 0:
        raise RuntimeError(f"the server answered {r.returncode}: {(r.stderr or '').strip()[:200]}")
    return r.stdout


def take_lease(n: int, ssh=ssh) -> list:
    got = json.loads(ssh(f"python3 scanner/scanner.py lease {int(n)}").strip().splitlines()[-1])
    if not isinstance(got, list) or not all(isinstance(m, str) and _MINT_RE.match(m) for m in got):
        raise ValueError("the server's answer is not a list of coins")
    return got


def copy_memory(ssh=ssh, path=None) -> bool:
    """PINR's memory of labelled coins, copied whole from the server; False (the copy kept as it was) when unreadable."""
    path = path or MEMORY
    try:
        mem = json.loads(ssh("cat stage3/memory/labeled_tokens.json 2>/dev/null || echo '{}'"))
        if not isinstance(mem, dict):
            return False
    except Exception:
        return False
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path + ".tmp", "w") as f:
        json.dump(mem, f)
    os.replace(path + ".tmp", path)
    return True


def run_once(imap, n: int, ssh=ssh, say=print, engine=None) -> int:
    """One batch: lease, copy the memory, score, hand each result in as it finishes, each stamped with this copy's
    engine (the server refuses another's). The number handed out."""
    mints = take_lease(n, ssh)
    if not mints:
        return 0
    if not copy_memory(ssh):
        say("PINR's memory could not be copied from the server this batch; the last copy is used")
    for res in imap(score_one, mints):
        res["engine"] = engine
        say(ssh("python3 scanner/scanner.py handin", stdin=json.dumps(res, default=str)).strip())
    return len(mints)


def stoppable() -> None:
    """Ctrl-C always stops the workers, and a SIGTERM stops them the same way (2026-10-25: started in the background by a
    deploy, the worker inherited Ctrl-C as ignored, the next deploy's stop request did nothing, and ending it left its
    pool's processes scoring for no one). Both raise KeyboardInterrupt, so the pool's own exit ends its processes."""
    import signal
    signal.signal(signal.SIGINT, signal.default_int_handler)
    signal.signal(signal.SIGTERM, signal.default_int_handler)


def main(argv) -> int:
    stoppable()
    os.environ.setdefault("PINR_PUMPFUN_REST_FILE", os.path.join(ROOT, "index", "pumpfun_rest.json"))   # one Pump.fun rest on this machine
    nodes = extra_endpoints()
    if not nodes:
        print("No worker-machine node in this copy's .env yet (RPC_A_SOLANA_URL, RPC_B_SOLANA_URL or RPC_C_SOLANA_URL): nothing started.")
        return 2
    n = workers(argv[1] if len(argv) > 1 else None)
    import scanner
    engine = scanner.engine_stamp()
    if engine is None:
        print("This copy's engine version cannot be read (git): nothing started.")
        return 2
    print(f"{n} scoring workers on the worker machine, reading Solana through: {', '.join(name for name, _u, _g in nodes)}")
    with get_context("spawn").Pool(n, initializer=setup_scoring, maxtasksperchild=25) as pool:
        while True:
            try:
                got = run_once(pool.imap_unordered, n, engine=engine)
            except KeyboardInterrupt:
                return 0
            except Exception as e:
                print(time.strftime("%H:%M:%S"), "this batch stopped: " + scanner.quiet(f"{type(e).__name__}: {e}")[:200], flush=True)
                got = 0
            if not got:
                time.sleep(IDLE_S)


if __name__ == "__main__":
    try:
        sys.exit(main(sys.argv))
    except KeyboardInterrupt:
        sys.exit(0)
