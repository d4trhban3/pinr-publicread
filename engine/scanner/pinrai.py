"""PINRai, the reading of a developer's intent, for the coins that passed the gate (237). PINRbot v1
(stage3/pinrbot.py) does the reading itself: its instructions, the checks on every item, the second model's review of a
big move, and the cost set aside against the operator's daily cap before every call (nothing is sent past it). This pass
makes sure every gate-passed coin on the site's first page gets a reading even when it was scored on the Mac (where
PINRai never runs): from the coin's result file (the score's receipts) and its own links, then the coin's evidence file is
written again so the reading shows. Its own thread in the scanner; nothing is sent while PINRai is off."""
from __future__ import annotations
import json, os, sys, threading, time, traceback

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path[:0] = [HERE, os.path.join(ROOT, "stage2"), os.path.join(ROOT, "stage3")]

PASS_S = 60
PER_PASS = 3                    # coins read a pass at most (each a first call, and a review only for a big move)
RESULTS_DIR = os.path.join(ROOT, "stage2", "results")
FEE_BONUS_WORDS = "custom rewards set up properly"   # the design's bonus, as the scorer's notes say it (216(1))


def quiet(m: str) -> bool:
    try:
        import quiet as Q
        return Q.is_quiet(m)
    except Exception:
        return False


def candidates(page: list, passed, has_reading, results_dir: str = RESULTS_DIR) -> list:
    """The page's coins, in its order, that passed the gate, have a result file and no current reading."""
    out = []
    for m in page:
        if not passed(m) or has_reading(m) or quiet(m):          # a quiet coin is not read
            continue
        if os.path.exists(os.path.join(results_dir, m + ".json")):
            out.append(m)
    return out


def read_one(mint: str, results_dir: str = RESULTS_DIR, read=None, own_read=None) -> dict:
    """PINRbot's reading for one coin from its result file: the score's receipts, the coin's own links (read again, one
    document), and whether the design's bonus fired (its fee item then stands aside, 216(1))."""
    import pinrbot as PB
    res = json.load(open(os.path.join(results_dir, mint + ".json")))
    items = [r for r in res.get("receipts") or [] if isinstance(r, dict)]
    if own_read is None:
        import readers as R
        own_read = lambda m: R.read_token_links(m, R.Log())
    try:
        own = own_read(mint) or {}
    except Exception:
        own = {}
    bonus = any(FEE_BONUS_WORDS in str(n) for n in res.get("notes") or [])
    return (read or PB.read)(mint, items, own, fee_bonus_fired=bonus)


def one_pass(page_fn, write_file, passed=None, has_reading=None, read_fn=None, results_dir: str = RESULTS_DIR,
             per_pass: int = PER_PASS) -> dict:
    import pinrbot as PB
    if PB.settings()[0] is None:
        return {"off": True}
    if passed is None:
        import gate as G
        passed = lambda m: G.passed(m)[0]
    if has_reading is None:
        has_reading = lambda m: PB.cached(m) is not None
    todo = candidates(page_fn() or [], passed, has_reading, results_dir)[:per_pass]
    out = {"asked": len(todo), "read": 0, "not_read": 0}
    for m in todo:
        r = (read_fn or read_one)(m)
        try:                                                   # PINRai's wires, where its reading crosses
            import wires as _W
            _W.meter("e_x|then|e_ai|run", 1, {"coin": m})
            if r.get("status") == "read":
                _W.meter("s_claude|model|e_ai|model", 1, {"model": r.get("model")})
                _W.meter("e_ai|reading + receipts|e_build|PINRai reading", 1, {"coin": m, "items": len(r.get("items") or [])})
                _W.meter("e_build|evidence file|e_ai|evidence so far", 1, {"coin": m})
            else:
                _W.error("e_ai|reading + receipts|e_build|PINRai reading", str(r.get("status"))[:120])
        except Exception:
            pass
        if r.get("status") == "read":
            out["read"] += 1
        else:
            out["not_read"] += 1
        try:
            write_file(m)
        except Exception:
            pass
        if "dollar cap would be passed" in str(r.get("status", "")):
            break                                          # the cap is reached: nothing more today
    PB.write_budget()
    return out


def start(db, page_fn, feed_dir: str, say=print) -> threading.Thread:
    import evidence as EV
    def run():
        c = db()
        while True:
            try:
                got = one_pass(lambda: [m for m, _b in (page_fn() or [])], lambda m: EV.write_coin_file(c, m, feed_dir))
                if got.get("asked"):
                    say(time.strftime("%H:%M:%S") + " PINRai: " + ", ".join(f"{k} {v}" for k, v in got.items()))
            except Exception:
                traceback.print_exc()
            time.sleep(PASS_S)
    t = threading.Thread(target=run, name="pinrai", daemon=True)
    t.start()
    return t
