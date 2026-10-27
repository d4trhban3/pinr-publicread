"""the worker machine's scoring workers, with made-up coins.
A temporary database, settings, result and memory folders; no network, no ssh, no chain read, no live file touched.
Run:  python3 test_extra_worker.py"""
import json, os, sys, tempfile, time
import scanner as S
import extra_worker as M

TMP = tempfile.mkdtemp()
S.DB = os.path.join(TMP, "scanner.sqlite")
S.SETTINGS = os.path.join(TMP, "settings.json")
json.dump({"score_chains": ["solana"], "solana_workers": 6, "solana_rescores": "follow-ups"}, open(S.SETTINGS, "w"))
S._SITE.update(at=time.time() + 10 ** 6, mints=[]); S._SHOWN.update(at=time.time() + 10 ** 6, mints=[], page=[])
S._WANTED.update(at=time.time() + 10 ** 6, coins={})

results = []
def case(n, title, should, fn):
    try:
        ok, text = fn()
    except Exception as e:
        ok, text = False, f"CRASH {type(e).__name__}: {e}"
    results.append(ok)
    print(f"\n{n:>2}. {title}\n    should: {should}\n    did:    {text}\n    {'PASS' if ok else 'FAIL'}")


def coin(tag):                                                   # a made-up Solana address of the right form
    base = "MadeUpCoin" + tag
    return (base + "1" * 44)[:44].replace("0", "1").replace("O", "P").replace("I", "J").replace("l", "k")


class _Job:
    def ready(self):
        return False


class _Pool:
    def __init__(self):
        self.sent = []
    def apply_async(self, fn, args):
        self.sent.append(args[0]); return _Job()


def fresh():
    for ext in ("", "-wal", "-shm"):
        if os.path.exists(S.DB + ext):
            os.remove(S.DB + ext)
    S._RUNNING.clear(); S._SITE_RUNNING.clear(); S._FOLLOWUP_RUNNING.clear()
    S._SCORING.update(chains=None, note=None, saved=None); S._SLOTS.update(n=None, note=None); S._RESCORES.update(mode=None, note=None)
    return S.db()


def lists(page=(), wanted=None):
    S._SHOWN.update(at=time.time() + 10 ** 6, mints=[], page=list(page)); S._WANTED.update(at=time.time() + 10 ** 6, coins=dict(wanted or {}))


def relay_dirs(folder):
    import pinrbot
    real = (pinrbot.RELAY_COPY_DIR, pinrbot.RELAY_REPO_DIR)
    pinrbot.RELAY_COPY_DIR = pinrbot.RELAY_REPO_DIR = folder
    return lambda: setattr(pinrbot, "RELAY_COPY_DIR", real[0]) or setattr(pinrbot, "RELAY_REPO_DIR", real[1])


def c1():
    import solana_rpc as R
    env = {"RPC_A_SOLANA_URL": " https://made-up.rpc-a.example/k/ ", "RPC_B_SOLANA_URL": "http://not-https.example",
           "RPC_C_SOLANA_URL": "", "SHYFT_API_KEY": "s", "HELIUS_API_KEY": "h", "CHAINSTACK_SOLANA_URL": "https://made-up.chainstack"}
    built = R.build_endpoints(["rpc_a", "rpc_b", "rpc_c"], env)
    gaps = {n: R._KNOWN[n][1] for n in ("rpc_a", "rpc_b", "rpc_c")}
    all3 = R.build_endpoints(["rpc_a", "rpc_b", "rpc_c"], {"RPC_A_SOLANA_URL": "https://a", "RPC_B_SOLANA_URL": "https://b", "RPC_C_SOLANA_URL": "https://c"})
    repo = json.load(open(os.path.join(os.path.dirname(S.__file__), "settings.json")))["solana_providers"]
    official = [n for n, _u, _g in M.extra_endpoints({"RPC_A_SOLANA_URL": "https://a", "HELIUS_OFFICIAL_KEY": "h", "ALCHEMY_OFFICIAL_KEY": "a"})]   # a design decision
    folder = tempfile.mkdtemp(); p = os.path.join(folder, "s.json"); json.dump({"solana_providers": ["shyft", "rpc_a"]}, open(p, "w"))
    ok = (built == [("rpc_a", "https://made-up.rpc-a.example/k/", gaps["rpc_a"])] and gaps["rpc_a"] >= 1 / 15 and gaps["rpc_b"] >= 1 / 10
          and gaps["rpc_c"] == 0.5 and [n for n, _u, _g in all3] == ["rpc_a", "rpc_b", "rpc_c"]
          and not set(repo) & set(M.EXTRA_NODES[:3]) and set(M.EXTRA_NODES[3:]) == {"helius_official", "alchemy_official"}
          and official == ["rpc_a", "helius_official", "alchemy_official"] and R.provider_order(p) == ["shyft", "rpc_a"])
    return ok, f"built from a made-up .env: {[n for n, _u, _g in built]} (http and blank lines left out); with the official keys' lines too: {official}; gaps {gaps}; the repo's (the server's) order {repo}; a listed name accepted by the settings check"
case(1, "The three free nodes in the request module", "each used only with an https address in the .env, paced at or under its published free limit (RPC provider A's trial 15 a second, RPC provider B's 10) and RPC provider C at a polite two a second; none of them in the server's list", c1)


def c2():
    env = {"SHYFT_API_KEY": "s", "HELIUS_API_KEY": "h", "CHAINSTACK_SOLANA_URL": "https://made-up.chainstack", "RPC_B_SOLANA_URL": "https://made-up.rpc_b"}
    one = [n for n, _u, _g in M.extra_endpoints(env)]
    none = M.extra_endpoints({"SHYFT_API_KEY": "s", "HELIUS_API_KEY": "h", "CHAINSTACK_SOLANA_URL": "https://made-up.chainstack"})
    import io, contextlib
    real = M.extra_endpoints; M.extra_endpoints = lambda env=None: []
    buf = io.StringIO()
    try:
        with contextlib.redirect_stdout(buf):
            code = M.main(["extra_worker.py"])
    finally:
        M.extra_endpoints = real
    ws = [M.workers(x) for x in (None, "6", "0", "17", "six")]   # 17: past the ceiling (16 since 2026-10-24)
    return one == ["rpc_b"] and none == [] and code == 2 and "nothing started" in buf.getvalue() and ws == [4, 6, 4, 4, 4], f"with the server's keys and RPC provider B's line: {one}; with the server's keys only: {none}, so the worker stops with code {code}: '{buf.getvalue().strip()[:60]}...'; workers asked for: {ws}"
case(2, "The worker machine reads Solana only through its own sign-ups", "the server's nodes (Shyft, Helius, Chainstack, the public node) are never in the worker machine's list even when their keys are present; with no Mac node the worker starts nothing; 1 to 16 workers, 4 otherwise", c2)




def c4():
    c = fresh(); now = time.time()
    folder = tempfile.mkdtemp(); undo = relay_dirs(folder)
    a, b, d, e, f, g, h, k, m, q = (coin(x) for x in "ABDEFGHKMQ")
    json.dump({"mint": f}, open(os.path.join(folder, f + ".json"), "w"))                                          # f: a relay reading
    c.execute("INSERT INTO tokens (chain, token, launchpad, first_seen, next_due) VALUES ('solana',?,'pumpfun',1.0,0)", (g,))                        # g: a hand request
    c.execute("INSERT INTO tokens (chain, token, launchpad, first_seen, scores, last_scored, last_ok) VALUES ('solana',?,'pumpfun',1.0,1,?,?)", (h, now - 99, now - 99))   # h: scored
    c.execute("INSERT INTO tokens (chain, token, launchpad, first_seen, last_scored, fails) VALUES ('solana',?,'pumpfun',1.0,?,1)", (k, now - 99))   # k: failed
    c.execute("INSERT INTO tokens (chain, token, launchpad, first_seen, held_until, held_by) VALUES ('solana',?,'pumpfun',1.0,?,'air')", (m, now + 300))   # m: the server is on it
    c.commit()
    page = [(a, now - 100), (b, now - 400), (d, now - 300), (e, now - 10), (f, now - 50), (g, now - 60), (h, now - 70), (k, now - 80), (m, now - 90), (q, now - 200)]
    lists(page, {d: now - 5})                                                                                      # d: on the wanted list
    try:
        first = S.lease(c, 3, now=now)
        second = S.lease(c, 3, now=now + 1)
        held = c.execute("SELECT token, held_by FROM tokens WHERE held_by='mac' ORDER BY token").fetchall()
        later = S.lease(c, 8, now=now + S.HOLD_S + 2)
        many = [(coin("N" + "ABCDEFGHJKMNPQRSTUVWXYZ"[i]), now - 100 - i) for i in range(20)]
        lists(many)
        big = S.lease(c, 50, now=now + 2 * S.HOLD_S + 4)
    finally:
        undo(); lists()
    ok = first == [a, q, b] and second == [] and len(held) == 3 and later == [e, m, a, q, b] and big == [m_ for m_, _t in many[:S.LEASE_MAX]] and S.LEASE_MAX == 16
    return ok, f"first lease {['ABQ'[[a, b, q].index(x)] if x in (a, b, q) else x[:12] for x in first]} (newest first; the young, wanted, relay, hand-requested, scored, failed and Air-held coins left); again at once: {second}; after the hold: {len(later)} back (A, Q, B again, the server's coin once its hold ended, the young coin once a minute old); asked for 50 of 20: {len(big)}, the newest"
case(4, "The server hands out work", "only never-scored page coins, newest launch first; never a hand request, a wanted coin, a relay coin, a coin under a minute old, one scored or failed, or one the server is scoring; each held 10 minutes, then handed out again", c4)


def c5():
    c = fresh(); now = time.time()
    a, b = coin("A"), coin("B")
    lists([(a, now - 100), (b, now - 400)])
    try:
        S.lease(c, 1, now=now)                                                                                     # a is the worker machine's now
        pool = _Pool(); S.dispatch(c, pool)
        took = [t for _c, t, _l in pool.sent]
        airheld = c.execute("SELECT held_by FROM tokens WHERE token=?", (b,)).fetchone()
        mac_now = S.lease(c, 2, now=time.time())
        S._RUNNING.clear()
        real = S.time.time; S.time.time = lambda: now + S.HOLD_S + 5
        try:
            pool2 = _Pool(); S.dispatch(c, pool2)
        finally:
            S.time.time = real
        back = [t for _c, t, _l in pool2.sent]
    finally:
        lists()
    return took == [b] and airheld == ("air",) and mac_now == [] and a in back, f"the server's page lane took {['B' if t == b else 'A' for t in took]} (A is the worker machine's) and held B as the server's ({airheld}); the worker machine asked again: {mac_now}; after the hold the server takes A: {a in back}"
case(5, "The server's own page lane and the worker machine never start the same coin", "the server skips a coin handed to the worker machine until its hold ends, and holds the coin it starts so it is never handed out meanwhile", c5)


def c6():
    c = fresh(); now = time.time()
    a, b, x = coin("A"), coin("B"), coin("X")
    lists([(a, now - 100), (b, now - 200)])
    S.lease(c, 2, now=now)
    lists()
    out = {"mint": a, "frame": "live scan", "score": 46, "display": 46, "coverage": 0.6, "label": None, "readings": {}, "receipts": [{"what": "made-up"}]}
    fed, rem = [], []
    rdir = tempfile.mkdtemp()
    kw = dict(results_dir=rdir, feed=fed.append, remember=lambda *a_: rem.append(a_), stamp=lambda: "E1")
    said = [S.hand_in(c, {"mint": a, "result": out, "remember": [a, None, ["w"], None, "N", None, None], "seconds": 40, "engine": "E1"}, **kw)]
    row = c.execute("SELECT scores, last_ok IS NOT NULL, held_by, last_result FROM tokens WHERE token=?", (a,)).fetchone()
    said.append(S.hand_in(c, {"mint": "0xnot-solana", "result": out}, **kw))
    said.append(S.hand_in(c, {"mint": x, "result": dict(out, mint=x)}, **kw))                                       # never handed out
    said.append(S.hand_in(c, {"mint": b, "result": out, "engine": "E1"}, **kw))                                     # another coin's result
    said.append(S.hand_in(c, {"mint": b, "result": {"mint": b, "score": 1}, "engine": "E1"}, **kw))                                 # not the scorer's shape
    said.append(S.hand_in(c, {"mint": b, "error": "made-up failure", "engine": "E1"}, **kw))
    fail = c.execute("SELECT fails, last_ok, next_due IS NOT NULL, held_by FROM tokens WHERE token=?", (b,)).fetchone()
    S.lease(c, 0); c.execute("UPDATE tokens SET held_by='mac', held_until=? WHERE token=?", (now + 300, a)); c.commit()
    said.append(S.hand_in(c, {"mint": a, "result": out}, **kw))                                                     # scored on the server meanwhile
    saved = json.load(open(os.path.join(rdir, a + ".json")))
    ok = (said[0].endswith("handed in, 46") and row[0] == 1 and row[1] == 1 and row[2] is None and '"by": "mac"' in row[3]
          and fed == [out] and rem and rem[0][0] == a and saved == out
          and said[1].startswith("refused: not a Solana") and "not handed to the worker machine" in said[2] and "scorer's shape" in said[3] and "scorer's shape" in said[4]
          and "recorded as a failed try" in said[5] and fail[0] == 1 and fail[1] is None and fail[2] == 1 and fail[3] is None
          and "scored on the server meanwhile" in said[6] and len(fed) == 1)
    return ok, f"accepted: '{said[0][-20:]}', result file written, feed written once, label remembered, the record {row[:3]}; refused: {[s.split(':', 1)[-1].strip()[:28] for s in said[1:5]]}; a failure: fails {fail[0]}, a retry set {bool(fail[2])}; a late one: '{said[6][-26:]}'"
case(6, "The server takes a result back", "exactly as its own score: the result file, the feed (chart event, score history), the label in PINR's memory, the scanner's record marked 'by mac', the hold cleared; refused: not a Solana coin, not handed to the worker machine, another coin's result, a result not in the scorer's shape, a coin scored on the server meanwhile; a failure the worker machine reports is a failed try with the usual retry", c6)


def c7():
    a, b = coin("A"), coin("B")
    calls, said = [], []
    mem = os.path.join(tempfile.mkdtemp(), "memory", "labeled_tokens.json")
    def fake_ssh(cmd, stdin=None):
        calls.append((cmd, stdin))
        if "lease" in cmd:
            return "\n" + json.dumps([a, b]) + "\n"
        if cmd.startswith("cat stage3/memory"):
            return json.dumps({"labeled": {a: "x"}})
        return "handed in"
    real_mem = M.MEMORY; M.MEMORY = mem
    try:
        scored = lambda f, ms: [{"mint": m, "result": {"mint": m}, "remember": None, "seconds": 1} for m in ms]
        n = M.run_once(scored, 2, ssh=fake_ssh, say=said.append, engine="E1")
        ins = [json.loads(s)["mint"] for c_, s in calls if "handin" in c_]
        stamped = {json.loads(s).get("engine") for c_, s in calls if "handin" in c_}
        copied = json.load(open(mem))
        calls.clear()
        empty = M.run_once(scored, 2, ssh=lambda cmd, stdin=None: calls.append(cmd) or "[]", say=said.append)
        bad = None
        try:
            M.run_once(scored, 2, ssh=lambda cmd, stdin=None: '["not a coin"]', say=said.append)
        except ValueError as e:
            bad = str(e)
        said.clear()
        unread = M.run_once(scored, 1, ssh=lambda cmd, stdin=None: (json.dumps([a]) if "lease" in cmd else "not json" if cmd.startswith("cat") else "ok"), say=said.append)
    finally:
        M.MEMORY = real_mem
    ok = n == 2 and ins == [a, b] and stamped == {"E1"} and copied == {"labeled": {a: "x"}} and empty == 0 and calls == ["python3 scanner/scanner.py lease 2"] and bad and unread == 1 and "could not be copied" in said[0]
    return ok, f"one batch: {n} leased, the memory copied first, {len(ins)} handed in; nothing to do: {empty} with only the lease asked; an answer that is not a list of coins: '{bad}'; the memory unreadable: '{said[0][:52]}...' and the batch still runs"
case(7, "the worker machine's batch", "ask the server for work, copy PINR's memory, score, hand each result in; nothing handed out means nothing else asked; an answer that is not a list of coins stops the batch; an unreadable memory keeps the last copy and says so", c7)


def c8():
    a = coin("A")
    M._REMEMBERED.clear()
    def score(m):
        M._REMEMBERED.append([m, "Pumped and dumped", ["w"], None, "N", None, None]); M._REMEMBERED.append(["other", None, [], None, None, None, None])
        return {"mint": m, "score": 25}
    good = M.score_one(a, score=score)
    def broken(m):
        raise RuntimeError("made-up read failure")
    bad = M.score_one(a, score=broken)
    return (good["result"] == {"mint": a, "score": 25} and good["remember"][0] == a and "error" not in good
            and bad.get("error", "").startswith("RuntimeError: made-up") and "result" not in bad), f"a score: result and the label to remember for this coin ({good['remember'][:2]}); a failure: '{bad.get('error')}'"
case(8, "One coin scored on the worker machine", "the result with this coin's remembered label only; a failure handed in as a failure, never as a result", c8)


def c9():
    import subprocess
    repo = tempfile.mkdtemp(); eng = os.path.join(repo, "engine"); os.makedirs(os.path.join(eng, "stage2"))
    git = lambda *a: subprocess.run(["git", "-C", repo] + list(a), capture_output=True, text=True)
    git("init", "-q"); git("config", "user.email", "t@t"); git("config", "user.name", "t")
    open(os.path.join(eng, "stage2", "reader.py"), "w").write("x = 1\n"); open(os.path.join(eng, "stage2", "notes.md"), "w").write("a\n")
    git("add", "-A"); git("commit", "-qm", "one")
    first = S.engine_stamp(eng)
    open(os.path.join(eng, "stage2", "notes.md"), "w").write("b\n"); open(os.path.join(eng, "stage2", "data.json"), "w").write("{}"); git("add", "-A"); git("commit", "-qm", "docs")
    docs = S.engine_stamp(eng)
    open(os.path.join(eng, "stage2", "reader.py"), "w").write("x = 2\n")
    uncommitted = S.engine_stamp(eng)
    git("add", "-A"); git("commit", "-qm", "code")
    code = S.engine_stamp(eng)
    none = S.engine_stamp(tempfile.mkdtemp())
    c = fresh(); now = time.time(); a = coin("A")
    lists([(a, now - 100)]); S.lease(c, 1, now=now); lists()
    out = {"mint": a, "frame": "live scan", "score": 46, "display": 46, "coverage": 0.6, "readings": {}, "receipts": []}
    kw = dict(results_dir=tempfile.mkdtemp(), feed=lambda o: None, remember=lambda *x: None)
    old = S.hand_in(c, {"mint": a, "result": out, "engine": "OLD"}, stamp=lambda: "NEW", **kw)
    missing = S.hand_in(c, {"mint": a, "result": out}, stamp=lambda: "NEW", **kw)
    unreadable = S.hand_in(c, {"mint": a, "result": out, "engine": None}, stamp=lambda: None, **kw)
    still = c.execute("SELECT held_by, last_ok FROM tokens WHERE token=?", (a,)).fetchone()
    secret = "https://made-up.rpc-a.example/SECRETTOKEN123/"
    q = S.quiet(f"URLError: <urlopen error {secret} timed out> then http://x.example/?api_key=K2")
    err = M.score_one(a, score=lambda m: (_ for _ in ()).throw(OSError(f"refused by {secret}")))
    S.hand_in(c, {"mint": a, "error": f"OSError: refused by {secret}", "engine": "NEW"}, stamp=lambda: "NEW", **kw)
    stored = c.execute("SELECT last_result FROM tokens WHERE token=?", (a,)).fetchone()[0]
    ok = (first and docs == first and uncommitted == first and code != first and none is None
          and all("not the server's" in x for x in (old, missing, unreadable)) and still == ("mac", None)
          and "SECRETTOKEN" not in q and "K2" not in q and q.count("<address>") == 2
          and "SECRETTOKEN" not in err["error"] and "<address>" in err["error"] and "SECRETTOKEN" not in stored)
    return ok, f"the stamp: same after a document and a data file changed {docs == first}, same with an edit not committed {uncommitted == first}, new after a code commit {code != first}, none outside git {none}; a result from another copy, without a stamp or with the server's unreadable: refused ('{old[-62:]}'), the coin still held for the worker machine; an error with a node address: '{q}', and none reaches the server's record"
case(9, "the team's W1 and W4 on 228: the engine copy and the error text", "the server takes a result only from a worker-machine copy whose committed code is its own (the stamp over every .py file in the code folders, unchanged by documents, data or edits not committed); no address, so no key, in any error the worker machine prints, hands in or the server records", c9)


def c10():
    import gategraph as GG
    now = time.time()
    a, b, d, q = (coin(x) for x in ("GA", "GB", "GD", "GQ"))
    page = [(a, now - 100), (b, now - 400), (d, now - 150), (q, now - 200)]
    c = fresh()
    lists(page)
    try:
        plain = S.lease(c, 4, now=now)                                         # no gate result kept anywhere: newest first, as before
        c = fresh()
        GG.ensure(c)
        c.executemany("INSERT INTO gate_events VALUES (?,?,?,?)", [(b, now - 50, "passed", "[]"), (d, now - 60, "passed", "[]"), (d, now - 30, "held", '["serial_launcher"]'),
                                                                     (a, now - 40, "held", '["fast_launcher"]')])
        c.commit()
        air = S._page_next(c, set())
        c.execute("DELETE FROM tokens"); c.commit()
        mac = S.lease(c, 4, now=now)
    finally:
        lists()
    return (plain == [a, d, q, b] and air[0] == b and mac == [b, a, d, q]), \
        (f"no gate result kept: {['A' if m == a else 'D' if m == d else 'Q' if m == q else 'B' for m in plain]} (newest first); "
         f"with B passed, D passed then held, A held, Q not read: the server's lane starts {'B' if air[0] == b else air[0]}, the worker machine gets "
         f"{['A' if m == a else 'D' if m == d else 'Q' if m == q else 'B' for m in mac]}")
case(10, "the team 2026-10-24: gate-passed coins scored first", "on the server's page lane and in the worker machine's lease, the site's coins the gate passed (its latest result) come first, newest first, then every other coin newest first; with no gate result kept the order is the design's, unchanged", c10)

def c_stop():
    """2026-10-25: a worker started in the background ignored Ctrl-C; ended, its pool kept scoring."""
    import signal, subprocess
    d = tempfile.mkdtemp()
    child = os.path.join(d, "w.py")
    open(child, "w").write(
        "import signal, sys, time\n"
        "signal.signal(signal.SIGINT, signal.SIG_IGN)          # as a background start leaves it\n"
        f"sys.path.insert(0, {os.path.dirname(os.path.abspath(M.__file__))!r})\n"
        "import extra_worker as M\n"
        "from multiprocessing import get_context\n"
        "if __name__ == '__main__':\n"
        "    M.stoppable()\n"
        "    try:\n"
        "        with get_context('spawn').Pool(2) as pool:\n"
        "            print(' '.join(str(p.pid) for p in pool._pool), flush=True)\n"
        "            pool.map(time.sleep, [60, 60])\n"
        "    except KeyboardInterrupt:\n"
        "        print('stopped', flush=True)\n")
    out = {}
    for sig in (signal.SIGTERM, signal.SIGINT):
        p = subprocess.Popen([sys.executable, child], stdout=subprocess.PIPE, text=True)
        pids = [int(x) for x in p.stdout.readline().split()]
        time.sleep(1.0)
        p.send_signal(sig)
        try:
            rest = p.communicate(timeout=20)[0]
        except subprocess.TimeoutExpired:
            p.kill(); rest = "still running"
        time.sleep(0.5)
        alive = []
        for pid in pids:
            try:
                os.kill(pid, 0); alive.append(pid)
            except OSError:
                pass
        out[sig.name] = ("stopped" in rest, len(pids), alive)
    return all(ok and n == 2 and not left for ok, n, left in out.values()), \
        "; ".join(f"{k}: stopped {ok}, pool processes left {len(left)} of {n}" for k, (ok, n, left) in out.items())
case(11, "The workers stop on Ctrl-C or SIGTERM, pool and all, however they were started (checklist 4)", "Ctrl-C is restored at start even when the start left it ignored; a SIGTERM stops the same way; the pool's processes end with the worker", c_stop)


def c12():
    """the team's F1 on 2bf68510: the holders read runs in scoring workers, so (1) the server's pool worker names its meter file, (2) a worker-machine worker hands its
    Pump.fun tally in with the result, and (3) the server's hand-in counts it on the two Pump.fun wires and nothing else."""
    import signal, wires as W
    import pumpfun_api as PF
    W._wires.clear(); W._proc[0] = None
    keep = signal.signal
    signal.signal = lambda *a, **k: None                          # _worker_init sets stop handlers: not in the test process
    os.environ.pop("PINR_WORKER_WIRES", None)
    try:
        S._worker_init()
        unset = W._proc[0]                                        # a pool that is not the running service's names nothing (no file in control/wires)
        os.environ["PINR_WORKER_WIRES"] = "1"
        S._worker_init()
    finally:
        signal.signal = keep
        os.environ.pop("PINR_WORKER_WIRES", None)
    named = W._proc[0]
    W._proc[0] = None
    a = coin("P")
    PF.TALLY.clear()
    def score(m):
        PF._wire("https://frontend-api-v3.pump.fun/coins/top-holders/" + m)
        PF._wire("https://frontend-api-v3.pump.fun/coins-v2/" + m, why="refused (403): every reader rests an hour, then one probe")
        return {"mint": m, "score": 25}
    got = M.score_one(a, score=score)
    again = M.score_one(a, score=lambda m: {"mint": m, "score": 25})          # the tally was taken: a second coin carries none
    W._wires.clear()
    got["pump"]["s_somewhere|else|x|y"] = {"n": 5, "error": None}             # anything but the two Pump.fun wires is ignored
    S._meter_pump(got); S._meter_pump({"pump": "junk"}); S._meter_pump(None)
    h, r = W._wires.get("s_pump|holders|a_token|Pump.fun"), W._wires.get("s_pump|coin record|a_token|Pump.fun")
    ok = (unset is None and bool(named and named.startswith("worker-")) and "pump" in got and "pump" not in again
          and bool(h and sum(h["buckets"].values()) == 1 and h["sample"] == {"coin": a}) and bool(r and "403" in r["error"] and not r["buckets"])
          and sorted(W._wires) == ["s_pump|coin record|a_token|Pump.fun", "s_pump|holders|a_token|Pump.fun"])
    return ok, f"worker meter named {named}; Mac result carries {sorted(got['pump'])[:2]}; the server counted {sorted(W._wires)}"
case(12, "the team's F1 on 2bf68510: Pump.fun reads in scoring workers reach /control", "the server's pool worker names its meter file; a worker-machine worker hands its tally in with each result (taken, so the next coin carries only its own); the hand-in counts it on the two Pump.fun wires and ignores anything else", c12)


print(f"\n{sum(results)}/{len(results)} passed")
raise SystemExit(0 if all(results) else 1)
