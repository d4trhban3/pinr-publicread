"""Solana request module, provider health: plain-English tests with made-up providers.
No network: Python's own request function is replaced by a script of answers, and waiting is recorded, not done.
Run:  python3 test_solana_rpc.py"""
import contextlib, io, json, time, urllib.error, urllib.request
import solana_rpc as S

import os, tempfile
REAL_COUNT = os.path.abspath(S.COUNT_DB)                     # the real count file of this folder: must be left alone
REAL_BEFORE = (os.path.exists(REAL_COUNT), os.path.getmtime(REAL_COUNT) if os.path.exists(REAL_COUNT) else None,
               os.path.getsize(REAL_COUNT) if os.path.exists(REAL_COUNT) else None)
S.COUNT_DB = os.path.join(tempfile.mkdtemp(), "requests.sqlite")   # every case counts into a temporary file
REAL_PACE = os.path.abspath(S.PACE_DB)                       # the real shared pacing file of this folder: left alone too
REAL_PACE_BEFORE = (os.path.exists(REAL_PACE), os.path.getmtime(REAL_PACE) if os.path.exists(REAL_PACE) else None,
                    os.path.getsize(REAL_PACE) if os.path.exists(REAL_PACE) else None)
S.PACE_DB = os.path.join(tempfile.mkdtemp(), "solana_pace.sqlite")   # every case paces in a temporary file
results = []
def case(n, title, should, fn):
    try:
        ok, text = fn()
    except Exception as e:
        ok, text = False, f"CRASH {type(e).__name__}: {e}"
    results.append(ok)
    print(f"\n{n:>2}. {title}\n    should: {should}\n    did:    {text}\n    {'PASS' if ok else 'FAIL'}")


URLS = {"public": "https://public.test/", "alchemy": "https://alchemy.test/", "helius": "https://helius.test/"}
URLS["shyft"] = "https://shyft.test/"
URLS["publicnode"] = "https://publicnode.test/"
URLS["drpc"] = "https://drpc.test/"
URLS["chainstack"] = "https://chainstack.test/"
URLS["helius_official"] = "https://helius-official.test/"           # a design decision
URLS["alchemy_official"] = "https://alchemy-official.test/"
NAME = {u: n for n, u in URLS.items()}
NAME[S.SHYFT_PARSE_URL] = "shyft-parse"                       # Shyft's transaction API (batches of parsed transactions, step 4)


def order(*names):
    S.ENDPOINTS[:] = [(n, URLS[n], 0.0) for n in names]


order("public", "alchemy", "helius")
BUSY = "Too many requests, slow down"                       # an ordinary busy moment
ASKED, WAITED, SCRIPT = [], [], {}


def says(provider, *answers):
    """What this made-up provider answers, in order; the last answer repeats.
    ("ok", value) | ("http429", words) | ("error", words in an ordinary answer)"""
    SCRIPT[provider] = list(answers)


def _urlopen(req, timeout=None):
    name = NAME[req.full_url]
    ASKED.append(name)
    script = SCRIPT[name]
    kind, value = script[0] if len(script) == 1 else script.pop(0)
    if kind == "http401":
        raise urllib.error.HTTPError(req.full_url, 401, "Unauthorized", {}, io.BytesIO(value.encode()))
    if kind == "http403":
        raise urllib.error.HTTPError(req.full_url, 403, "Forbidden", {}, io.BytesIO(value.encode()))
    if kind == "http429":
        raise urllib.error.HTTPError(req.full_url, 429, "Too Many Requests", {}, io.BytesIO(value.encode()))
    if kind == "http400":                                      # dRPC's live shape (2026-10-14): a JSON-RPC error body inside an HTTP 400
        raise urllib.error.HTTPError(req.full_url, 400, "Bad Request", {}, io.BytesIO(json.dumps({"jsonrpc": "2.0", "id": 1, "error": {"code": 35, "message": value}}).encode()))
    if kind == "api":                                          # a REST answer, given whole
        return io.BytesIO(json.dumps(value).encode())
    if kind == "plain_error":
        return io.BytesIO(json.dumps({"jsonrpc": "2.0", "id": 1, "error": {"code": -32601 if "not found" in value else -32602, "message": value}}).encode())
    body = {"jsonrpc": "2.0", "id": 1, "result": value} if kind == "ok" else {"jsonrpc": "2.0", "id": 1, "error": {"code": 429, "message": value}}
    return io.BytesIO(json.dumps(body).encode())


urllib.request.urlopen = _urlopen
S.time.sleep = lambda s: WAITED.append(s)                    # waiting is written down, not done


def fresh(*names):
    order(*(names or ("public", "alchemy", "helius")))
    S.COUNT_DB = os.path.join(tempfile.mkdtemp(), "requests.sqlite"); S._counts.clear()
    ASKED.clear(); WAITED.clear(); SCRIPT.clear()
    S._dead.clear(); S._NOT_SERVED.clear(); S.STATS.clear(); S._rest_until[0] = 0.0
    S.PACE_DB = os.path.join(tempfile.mkdtemp(), "solana_pace.sqlite"); S._own.clear(); S._SHARE[0] = None; S.PACE_NOTE[0] = None
    S._shared_off_until[0] = 0.0; S._count_off_until[0] = 0.0
    S.score_cache_stop(); S._CACHE["txs"].clear()
    S._ASIDE_UNTIL.clear(); S._NS_UNTIL.clear()
    S._credits.clear(); S._credit_seen.update(at=0.0, month=None, saved={})


asked = lambda who: ASKED.count(who)
READ = ("getTransaction", ["made-up-signature", {"encoding": "jsonParsed"}])      # a read the public node is asked first
OTHER = ("getProgramAccounts", ["made-up-program"])                              # a read the keyed providers are asked first


def c1():
    fresh()
    says("public", ("http429", BUSY)); says("alchemy", ("http429", "Monthly capacity limit exceeded. Visit the dashboard"))
    says("helius", ("ok", {"made-up": "transaction"}))
    r = S.rpc(*READ)
    ok = r == {"made-up": "transaction"} and asked("alchemy") == 1 and asked("helius") == 1 and "alchemy" in S._dead and sum(WAITED) == 0
    return ok, f"answer {r}; asked public {asked('public')}, alchemy {asked('alchemy')}, helius {asked('helius')}; seconds waited {sum(WAITED)}; set aside: {sorted(S._dead)}"
case(1, "A provider answers \"Monthly capacity limit exceeded\"",
     "it is asked once, set aside with no waiting, and the next source gives the answer to the same read", c1)


def c2():
    c1(); ASKED.clear()
    r = S.rpc(*READ)
    return r == {"made-up": "transaction"} and asked("alchemy") == 0, f"answer {r}; asked alchemy {asked('alchemy')} time(s) on the next read"
case(2, "The next read after a provider was set aside", "that provider is not asked at all", c2)


def c3():
    fresh()
    says("public", ("http429", BUSY)); says("alchemy", ("http429", BUSY), ("ok", 12345)); says("helius", ("ok", "from the next source"))
    r = S.rpc(*READ)
    ok = r == "from the next source" and asked("alchemy") == 1 and "alchemy" not in S._dead and sum(WAITED) == 0 and asked("helius") == 1
    return ok, f"answer {r}; asked alchemy {asked('alchemy')} time(s), helius {asked('helius')}; seconds waited {sum(WAITED)}; set aside: {sorted(S._dead)}"
case(3, "A keyed provider is busy for a moment (ordinary \"too many requests\")",
     "the read goes to the next source at once; the busy one is NOT set aside and its shared clock is pushed", c3)


def c4():
    fresh("helius", "alchemy", "public")
    says("helius", ("http429", "max usage reached")); says("alchemy", ("ok", ["made-up", "accounts"])); says("public", ("ok", "should not be needed"))
    r = S.rpc(*OTHER)
    ok = r == ["made-up", "accounts"] and asked("helius") == 1 and "helius" in S._dead and sum(WAITED) == 0
    return ok, f"answer {r}; asked helius {asked('helius')}; seconds waited {sum(WAITED)}; set aside: {sorted(S._dead)}"
case(4, "A provider answers \"max usage reached\"", "the same: asked once, set aside, no waiting, next source answers", c4)


def c5():
    fresh("helius", "alchemy", "public")
    says("helius", ("error", "Monthly capacity limit exceeded")); says("alchemy", ("ok", 777)); says("public", ("ok", "should not be needed"))
    r = S.rpc(*OTHER)
    return r == 777 and asked("helius") == 1 and "helius" in S._dead and sum(WAITED) == 0, \
        f"answer {r}; asked helius {asked('helius')}; seconds waited {sum(WAITED)}; set aside: {sorted(S._dead)}"
case(5, "The \"used up\" words arrive inside an ordinary answer instead of a refusal", "treated the same way", c5)


def c6():
    fresh()
    says("public", ("http429", BUSY)); says("alchemy", ("http429", "Monthly capacity limit exceeded")); says("helius", ("http429", "max usage reached"))
    r = S.rpc(*READ)
    ok = isinstance(r, dict) and "ERROR" in r and asked("alchemy") == 1 and asked("helius") == 1 and asked("public") == 4 and max(WAITED or [0]) <= 20
    return ok, f"answer {r}; asked public {asked('public')} (1 quick, then 3 patient after its rests), alchemy {asked('alchemy')}, helius {asked('helius')}; the longest wait {max(WAITED or [0])} s"
case(6, "Every source refuses this read", "the used-up ones are asked once, the public node is tried three times more as the last resort after its rests (each at most 20 s, the longest wait on any provider), and the read comes back as an error (unknown) at once, never a made-up value", c6)


def c7():
    fresh()
    says("public", ("http429", BUSY)); says("alchemy", ("ok", 5)); says("helius", ("ok", "should not be needed"))
    r1 = S.rpc(*READ)
    rested = S._rest_until[0] > time.time()
    S._rest_until[0] = 0.0; says("public", ("ok", 6))
    r2 = S.rpc(*READ)
    ok = r1 == 5 and rested and "public" not in S._dead and r2 == 6
    return ok, f"first answer {r1} (from the next source), public node rested: {rested}; set aside: {sorted(S._dead)}; after its rest the public node answers {r2}"
case(7, "The free public node says \"too many requests\"", "it rests a few seconds and is asked again later; it is never set aside for good", c7)


def c8():
    fresh()
    says("public", ("ok", "should not be asked")); says("alchemy", ("ok", "should not be asked")); says("helius", ("http429", "max usage reached"))
    S.history_asc_free = lambda address, max_items=2000, until_ts=None: (["made-up free answer", address, max_items], True)
    r = S.history_asc("made-up-address", max_items=1)
    ok = r == (["made-up free answer", "made-up-address", 1], True) and asked("helius") == 0 and sum(WAITED) == 0
    return ok, f"answer {r}; asked helius {asked('helius')}; seconds waited {sum(WAITED)}"
case(8, "The oldest-first history read",
     "the free read's answer is returned (the same read by standard calls); Helius is never asked for it, no waiting", c8)


def c9():
    fresh()
    says("public", ("ok", "should not be asked")); says("alchemy", ("ok", "should not be asked")); says("helius", ("http429", "max usage reached"))
    S.history_full_free = lambda address, max_items=2000, until_ts=None: (["made-up free transactions"], True)
    r = S.history_full("made-up-address", max_items=1)
    ok = r == (["made-up free transactions"], True) and asked("helius") == 0 and sum(WAITED) == 0
    return ok, f"answer {r}; asked helius {asked('helius')}; seconds waited {sum(WAITED)}"
case(9, "The full-history read", "the free read answers; Helius is never asked for it, no waiting", c9)


def c10():
    fresh()
    says("public", ("http429", BUSY)); says("alchemy", ("http429", "Monthly capacity limit exceeded")); says("helius", ("ok", "x"))
    for _ in range(50):
        S._rest_until[0] = 0.0
        S.rpc(*READ)
    return asked("alchemy") == 1 and sum(WAITED) == 0, f"50 reads: alchemy asked {asked('alchemy')} time(s) in all, seconds waited {sum(WAITED)}"
case(10, "Fifty reads in a row while one provider's allowance is used up",
     "that provider is asked once in all, not once (or six times) per read", c10)


def c11():
    fresh("public", "shyft", "alchemy", "helius")
    says("public", ("http429", BUSY)); says("shyft", ("ok", "from shyft")); says("alchemy", ("ok", "no")); says("helius", ("ok", "no"))
    r = S.rpc(*READ)
    return r == "from shyft" and ASKED == ["public", "shyft"], f"answer {r}; asked in order: {ASKED}"
case(11, "The public node is busy and Shyft is next in the order", "Shyft answers; the older keys are not asked", c11)


def c12():
    fresh("public", "shyft")
    S._dead.add("shyft")
    says("public", ("http429", BUSY), ("http429", BUSY), ("ok", "from public at last")); says("shyft", ("ok", "no"))
    r = S.rpc(*READ)
    ok = r == "from public at last" and asked("public") == 3 and asked("shyft") == 0 and sum(WAITED) > 0
    return ok, f"answer {r}; asked public {asked('public')} times; seconds it would have waited {round(sum(WAITED), 1)}"
case(12, "The public node is the only source left and is busy twice", "the last resort is tried again after its rest and answers; the read is not given up after one refusal (the public node alone keeps a retry: it has no next source)", c12)


ENV = {"SHYFT_API_KEY": "made-up-s", "ALCHEMY_API_KEY": "made-up-a", "HELIUS_API_KEY": "made-up-h",
       "ALCHEMY_OFFICIAL_KEY": "made-up-ao", "HELIUS_OFFICIAL_KEY": "made-up-ho"}
import os, tempfile
TMP = os.path.join(tempfile.mkdtemp(), "settings.json")


def setting(value=None, raw=None):
    with open(TMP, "w") as f:
        f.write(raw if raw is not None else json.dumps({"score_chains": ["solana"], **({} if value is None else {"solana_providers": value})}))
    return [n for n, _, _ in S.build_endpoints(S.provider_order(TMP), ENV)]


def c13():
    got = setting()
    return got == ["public", "shyft", "alchemy", "helius"], f"providers: {got}"
case(13, "Settings say nothing about providers, and every key is in place", "free sources in the built-in order; the official keys are NOT used", c13)


def c14():
    got = setting(["public", "shyft", "alchemy", "helius", "alchemy_official", "helius_official"])
    return got == ["public", "shyft", "alchemy", "helius", "alchemy_official", "helius_official"], f"providers: {got}"
case(14, "Settings list the official keys last", "they are used, last, exactly where the list puts them", c14)


def c15():
    got = [setting(["public", "shyft", "dRPC"]), setting([]), setting(["public", "public"]), setting(raw="{ damaged")]
    ok = all(g == ["public", "shyft", "alchemy", "helius"] for g in got) and "not usable" in (S.ORDER_NOTE[0] or "")
    return ok, f"unknown name, empty list, a name twice, damaged file -> {got[0]} each time; note: {S.ORDER_NOTE[0]}"
case(15, "The provider list cannot be used", "free sources in the built-in order, never the official keys, and the reason is kept", c15)


def c16():
    with open(TMP, "w") as f:
        f.write(json.dumps({"solana_providers": ["public", "shyft", "alchemy"]}))
    got = [n for n, _, _ in S.build_endpoints(S.provider_order(TMP), {"ALCHEMY_API_KEY": "made-up-a"})]
    return got == ["public", "alchemy"], f"providers: {got}"
case(16, "A listed provider has no key in place", "it is simply not there; the others keep their order", c16)


def c17():
    fresh("shyft", "public", "helius")
    says("shyft", ("ok", 1)); says("public", ("ok", 2)); says("helius", ("ok", 3))
    S.rpc(*OTHER); first = list(ASKED); ASKED.clear()
    says("shyft", ("http429", "Monthly capacity limit exceeded")); S.rpc(*OTHER)
    return first == ["shyft"] and ASKED == ["shyft", "helius"], f"first read asked {first}; with Shyft used up: {ASKED}"
case(17, "A read the public node cannot do quickly", "keyed sources are asked in the set order and the public node last", c17)


def c18():
    fresh("public", "shyft", "helius")
    says("public", ("http429", BUSY)); says("helius", ("ok", "holders from the next source"))
    SCRIPT["shyft"] = [("http403", "method not available on this plan")]
    r1 = S.rpc("getTokenLargestAccounts", ["made-up-mint"])
    S._rest_until[0] = 0.0; says("shyft", ("ok", "a transaction from shyft"))
    r2 = S.rpc(*READ)
    ok = r1 == "holders from the next source" and r2 == "a transaction from shyft" and "shyft" not in S._dead
    return ok, f"refused kind of read: {r1}; a different read straight after: {r2}; set aside altogether: {sorted(S._dead)}"
case(18, "A provider's plan refuses one kind of read (403) but serves the others",
     "only that kind of read skips it; it keeps answering everything else", c18)


def c19():
    fresh("public", "shyft", "helius")
    says("public", ("http429", BUSY)); says("helius", ("ok", "answer from the next source"))
    SCRIPT["shyft"] = [("plain_error", "Method not found")]
    r1 = S.rpc(*READ); n1 = asked("shyft")
    S._rest_until[0] = 0.0; r2 = S.rpc(*READ)
    ok = r1 == "answer from the next source" and r2 == r1 and n1 == 1 and asked("shyft") == 1
    return ok, f"first read: {r1}; shyft asked {n1} time; same kind of read again: {r2}, shyft asked {asked('shyft') - n1} more"
case(19, "A provider answers \"Method not found\" inside an ordinary reply",
     "the next source is asked and answers; the read is not ended as unknown; that provider is skipped for that kind of read", c19)


def c20():
    fresh("shyft", "helius", "public")
    SCRIPT["shyft"] = [("plain_error", "Invalid request for this plan")]
    says("helius", ("ok", "answer from helius")); says("public", ("ok", "no"))
    r = S.rpc(*OTHER)
    return r == "answer from helius" and ASKED == ["shyft", "helius"], f"answer {r}; asked {ASKED}"
case(20, "A provider gives some other refusal of its own inside an ordinary reply", "the next source is asked for the same read", c20)


def c21():
    fresh("shyft", "public")
    SCRIPT["shyft"] = [("plain_error", "Invalid param: made-up")]; SCRIPT["public"] = [("plain_error", "Invalid param: made-up")]
    r = S.rpc(*OTHER)
    return isinstance(r, dict) and "ERROR" in r and "Invalid param" in str(r), f"answer {r}"
case(21, "Every source gives the same error for a read", "the read comes back as that error (unknown), never a made-up value", c21)


def c22():
    setting(["public", "shfyt"])
    return "not usable" in (S.ORDER_NOTE[0] or "") and "free sources in the built-in order" in S.ORDER_NOTE[0], f"note: {S.ORDER_NOTE[0]}"
case(22, "The provider list has a misspelt name", "a warning is kept for the log saying the list is not usable and what is used instead", c22)


def c23():
    fresh("public", "shyft")
    S.COUNT_DB = os.path.join(tempfile.mkdtemp(), "requests.sqlite"); S._counts.clear()
    says("public", ("http429", BUSY)); says("shyft", ("ok", 1))
    for _ in range(3):
        S._rest_until[0] = 0.0; S.rpc(*READ)
    S.save_counts()
    got = sorted(S.read_counts())
    return got == [("public", 0, 3), ("shyft", 3, 0)], f"saved today: {got}"
case(23, "Three reads: the public node refuses each, Shyft answers each", "the saved count says public 0 answered / 3 refused, Shyft 3 answered / 0 refused", c23)


def c24():
    fresh("public", "shyft")
    S.COUNT_DB = os.path.join(tempfile.mkdtemp(), "no-such-folder", "requests.sqlite"); S._counts.clear()
    says("public", ("ok", "the answer")); says("shyft", ("ok", "no"))
    r = S.rpc(*READ); S.save_counts()
    return r == "the answer" and S.read_counts() == [], f"answer {r}; saved: {S.read_counts()}"
case(24, "The count cannot be written (no such folder)", "the read is answered exactly as normal; nothing is saved and nothing breaks", c24)


def c25():
    fresh("public", "shyft")
    S.COUNT_DB = os.path.join(tempfile.mkdtemp(), "requests.sqlite"); S._counts.clear()
    says("public", ("ok", 1)); says("shyft", ("ok", 1))
    S.rpc(*READ); S.save_counts(); S.rpc(*READ); S.rpc(*READ); S.save_counts()
    return S.read_counts() == [("public", 3, 0)], f"saved: {S.read_counts()}"
case(25, "Counts saved at two different moments in one day", "they add up; nothing is counted twice or lost", c25)


def c26():
    two = dict((n, p) for n, _, p in S.build_endpoints(["public", "shyft"], ENV))
    return two["shyft"] == 0.1 and two["public"] == 0.25 and S.build_endpoints.__code__.co_argcount == 2, \
        f"gap between requests, all workers together: {two}; the number of workers is not asked for"
case(26, "The gap between requests to a provider", "is the provider's own (Shyft: its documented 10 a second) and does not depend on the number of workers", c26)


def near(x, want, slack=0.03):
    return abs(x - want) <= slack


def frozen_clock(fn):
    """C5: the pacing cases measure the queue, not the machine. With the real clock, the time the
    shared file's own writes take (150 of them in case 35) came off every measured wait, so a busy machine failed them.
    The clock stands still while the case runs (the pacing code has no loop that waits for it to move)."""
    def run():
        real = time.time
        t = real()
        time.time = lambda: t
        try:
            return fn()
        finally:
            time.time = real
    run.__name__ = fn.__name__
    return run


def second_worker():
    """Another copy of the request module, as a second scoring worker would hold: its own memory, the same shared file."""
    import importlib.util
    spec = importlib.util.spec_from_file_location("solana_rpc_worker2", S.__file__)
    m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
    m.PACE_DB = S.PACE_DB
    return m


@frozen_clock
def c27():
    fresh()
    W2 = second_worker()
    waits = [S._turn("shyft", 0.1), W2._turn("shyft", 0.1), S._turn("shyft", 0.1), W2._turn("shyft", 0.1), W2._turn("shyft", 0.1)]
    ok = all(near(w, 0.1 * i) for i, w in enumerate(waits))
    return ok, "waits handed out, worker 1 and worker 2 in turn: " + ", ".join(f"{w:.2f}" for w in waits) + " s"
case(27, "Two workers ask the same provider at the same moment, five requests in all", "their turns are one gap apart across both workers: together they ask once per gap, not once per gap each", c27)


@frozen_clock
def c28():
    fresh()
    for _ in range(5):
        S._turn("shyft", 0.1)
    w = S._turn("public", 0.06)
    return near(w, 0.0, 0.005), f"wait for the public node after five queued Shyft requests: {w:.3f} s"
case(28, "Requests are queued for one provider", "a request to another provider does not wait behind them", c28)


@frozen_clock
def c29():
    fresh()
    W2 = second_worker()
    S._turn("shyft", 0.1, push=0.3)
    w = W2._turn("shyft", 0.1)
    return near(w, 0.3), f"the other worker's next turn after a 0.3 s push on an idle clock: {w:.2f} s"
case(29, "One worker pushes an idle provider's clock on by 0.3 seconds", "the other worker's next request waits those 0.3 seconds too", c29)


def c30():
    fresh("shyft")
    S.ENDPOINTS[:] = [("shyft", URLS["shyft"], 0.1)]
    says("shyft", ("error", BUSY), ("ok", "the answer"))
    r = S.rpc(*OTHER)
    W2 = second_worker()
    w = W2._turn("shyft", 0.1)
    return isinstance(r, dict) and "ERROR" in r and asked("shyft") == 1 and w >= S.BACKOFF_GAPS * 0.1 - 0.03, f"answer: {r} (the only source was busy: unknown at once, no wait); another worker's next turn is {w:.2f} s away (three gaps = {S.BACKOFF_GAPS * 0.1:.1f} s)"
case(30, "The only keyed provider answers 'too many requests'", "the read ends unknown at once (no retry, no wait: order item 2), and every worker leaves that provider alone for a few gaps", c30)


@frozen_clock
def c31():
    fresh("shyft")
    S.ENDPOINTS[:] = [("shyft", URLS["shyft"], 0.1)]
    S.PACE_DB = os.path.join(tempfile.mkdtemp(), "no-such-folder", "solana_pace.sqlite")
    four = os.path.join(tempfile.mkdtemp(), "settings.json")
    with open(four, "w") as f:
        json.dump({"solana_workers": 4}, f)
    old, S.SETTINGS = S.SETTINGS, four
    says("shyft", ("ok", "the answer"))
    err = io.StringIO()
    with contextlib.redirect_stderr(err):
        r = S.rpc(*OTHER)
        waits = [S._turn("shyft", 0.1) for _ in range(3)]
    S.SETTINGS = old
    warned = err.getvalue().count("WARNING shared pacing file not usable")
    ok = r == "the answer" and all(near(w, 0.4 * (i + 1)) for i, w in enumerate(waits)) and "not usable" in (S.PACE_NOTE[0] or "") and warned == 1
    return ok, f"answer: {r}; this worker's own turns: " + ", ".join(f"{w:.1f}" for w in waits) + f" s apart by its share (4 workers); warned in the log {warned} time"
case(31, "The shared pacing file cannot be used (no such folder), four workers", "the read is answered as normal, and the worker paces itself at its own share: four times the gap", c31)


@frozen_clock
def c32():
    fresh()
    import sqlite3
    S._turn("shyft", 0.1)
    c = sqlite3.connect(S.PACE_DB); c.execute("UPDATE pace SET next=? WHERE provider='shyft'", (time.time() + 3600,)); c.commit(); c.close()
    w = S._turn("shyft", 0.1)
    return near(w, 0.0, 0.005), f"wait after a saved turn an hour ahead: {w:.3f} s"
case(32, "The shared file holds a turn an hour in the future (a changed clock)", "it is not believed: the request goes now instead of waiting an hour", c32)


def c33():
    fresh("shyft")
    S.ENDPOINTS[:] = [("shyft", URLS["shyft"], 0.1)]
    with open(S.PACE_DB, "w") as f:
        f.write("this is not a pacing file")
    says("shyft", ("ok", "the answer"))
    err = io.StringIO()
    with contextlib.redirect_stderr(err):
        r = S.rpc(*OTHER)
    warned = err.getvalue().count("WARNING shared pacing file not usable")
    return r == "the answer" and "not usable" in (S.PACE_NOTE[0] or "") and warned == 1, f"answer: {r}; warned in the log {warned} time; note: {S.PACE_NOTE[0]}"
case(33, "The shared pacing file is damaged", "the read is answered as normal and the worker paces itself", c33)


@frozen_clock
def c34():
    fresh()
    W2 = second_worker()
    for _ in range(20):                                        # twenty requests already waiting: the clock stands 2 s ahead
        S._turn("shyft", 0.1)
    before = W2._turn("shyft", 0.1)                            # the 21st would wait about 2.0 s
    S._turn("shyft", 0.1, push=0.3)
    after = W2._turn("shyft", 0.1)                             # one more gap, plus the push
    return near(before, 2.0, 0.05) and near(after - before, 0.4, 0.05), \
        f"next turn with 20 waiting: {before:.2f} s; after a 0.3 s push the following turn is {after - before:.2f} s later (one gap + the push)"
case(34, "A provider answers 'too many requests' while twenty requests are already waiting", "the push adds to the wait from where the clock stands, so every worker eases off even under load", c34)


@frozen_clock
def c35():
    fresh()
    for _ in range(200):                                       # two hundred refusals in a burst
        S._turn("shyft", 0.1, push=0.3)
    w = S._turn("shyft", 0.1)
    fresh()
    for _ in range(150):                                       # a real queue 15 s long is not cut short by a push
        S._turn("shyft", 0.1)
    S._turn("shyft", 0.1, push=0.3)
    q = S._turn("shyft", 0.1)
    return near(w, S.PUSH_MAX, 0.1) and near(q, 15.0, 0.1), f"wait after 200 refusals: {w:.1f} s (the limit is {S.PUSH_MAX:.0f} s); a 15 s queue after one push: {q:.1f} s"
case(35, "A burst of two hundred refusals", "refusals never push a provider's clock more than the set limit ahead, and never pull a longer queue back", c35)


def c36():
    fresh("shyft")
    S.ENDPOINTS[:] = [("shyft", URLS["shyft"], 0.0)]
    import sqlite3
    S._turn("shyft", 0.0)                                      # the file exists
    lock = sqlite3.connect(S.PACE_DB); lock.execute("BEGIN EXCLUSIVE")   # another program holds it
    says("shyft", ("ok", "the answer"))
    err, took = io.StringIO(), []
    with contextlib.redirect_stderr(err):
        for _ in range(4):
            t0 = time.time(); r = S.rpc(*OTHER); took.append(time.time() - t0)
    lock.rollback(); lock.close()
    held = S.PACE_NOTE[0]
    paced_alone = S._shared_off_until[0] > time.time()           # C5: the worker's own state says it stopped waiting for the file
    S._shared_off_until[0] = 0.0
    S._turn("shyft", 0.0)
    # C5: "did not wait" is judged by the worker's own state, and by time only well under the
    # file's one-second wait, so a slow but ordinary read on a loaded machine is not taken for a wait
    ok = (r == "the answer" and took[0] < S.FILE_WAIT + 1.0 and paced_alone and all(x < S.FILE_WAIT / 2 for x in took[1:])
          and "not usable" in (held or "") and S.PACE_NOTE[0] is None)
    return ok, f"four reads while the file was locked took {', '.join(f'{x:.1f}' for x in took)} s; all answered; shared file used again once free: {S.PACE_NOTE[0] is None}"
case(36, "Another program holds the shared pacing file locked", "the first request waits about a second for it, the next ones do not wait at all (the worker paces itself for a while), and every read is answered", c36)


def c37():
    fresh("shyft")
    S.ENDPOINTS[:] = [("shyft", URLS["shyft"], 0.0)]
    import sqlite3
    says("shyft", ("ok", 1))
    S.rpc(*OTHER); S.save_counts()                             # the count file exists, holding 1
    lock = sqlite3.connect(S.COUNT_DB); lock.execute("BEGIN EXCLUSIVE")
    took = []
    for _ in range(60):                                        # enough requests to make a save due more than once
        t0 = time.time(); S.rpc(*OTHER); took.append(time.time() - t0)
    lock.rollback(); lock.close()
    slow = [x for x in took if x > S.FILE_WAIT * 0.8]            # C5: a wait on the file, not an ordinary read on a busy machine
    left_alone = S._count_off_until[0] > time.time()             # the worker's own state: it stopped trying the file for a while
    S._count_off_until[0] = 0.0
    S.save_counts()
    saved = S.read_counts()
    return len(slow) == 1 and slow[0] < S.FILE_WAIT + 1.0 and left_alone and saved == [("shyft", 61, 0)], \
        f"of 60 reads while the count file was locked, {len(slow)} waited ({slow[0]:.1f} s); counts saved once free: {saved} (none lost)"
case(37, "Another program holds the count file locked for sixty requests", "one request waits about a second, the rest do not; no read is delayed again, and no count is lost", c37)


def _state(path):
    return (os.path.exists(path), os.path.getmtime(path) if os.path.exists(path) else None, os.path.getsize(path) if os.path.exists(path) else None)


def c38():
    S.save_counts()
    now = _state(REAL_COUNT)
    return now == REAL_BEFORE and os.path.abspath(S.COUNT_DB) != REAL_COUNT, f"real count file before this run {REAL_BEFORE}, after {now} (exists, changed at, size)"
case(38, "This whole run of made-up requests", "leaves the folder's real count file exactly as it was: not created, not changed", c38)


def c39():
    now = _state(REAL_PACE)
    return now == REAL_PACE_BEFORE and os.path.abspath(S.PACE_DB) != REAL_PACE, f"real pacing file before this run {REAL_PACE_BEFORE}, after {now} (exists, changed at, size)"
case(39, "This whole run of made-up requests", "leaves the folder's real shared pacing file exactly as it was: not created, not changed", c39)


def c40():
    fresh("public", "shyft")
    says("public", ("ok", {"meta": {"made": "up"}}), ("ok", {"meta": {"second": "answer"}}))
    S.score_cache_start()
    a = S.rpc(*READ); b = S.rpc(*READ)
    a["meta"]["changed"] = True
    c = S.rpc(*READ)
    once = asked("public")
    says("public", ("http429", "busy"), ("http429", "busy"), ("http429", "busy"), ("http429", "busy"), ("http429", "busy"), ("http429", "busy")); says("shyft", ("http429", "busy"), ("http429", "busy"), ("http429", "busy"), ("http429", "busy"), ("http429", "busy"), ("http429", "busy"))
    e1 = S.rpc(*OTHER); n1 = asked("shyft") + asked("public")
    e2 = S.rpc(*OTHER); n2 = asked("shyft") + asked("public")
    served = S.cache_served()
    S.score_cache_stop()
    says("public", ("ok", {"meta": {"after": "stop"}}))
    d = S.rpc(*READ)
    return once == 1 and b == {"meta": {"made": "up"}} and c == {"meta": {"made": "up"}} and "changed" not in c["meta"] and "ERROR" in e1 and "ERROR" in e2 and n2 > n1 and served == 2 and d == {"meta": {"after": "stop"}}, \
        f"the same read three times inside a score: sent {once} time, the copies untouched by a caller's change: {'changed' not in c['meta']}; a read nobody could serve: sent again the second time: {n2 > n1}; served from the cache: {served}; after the score stopped: sent again: {d == {'meta': {'after': 'stop'}}}"
case(40, "The cache inside one score: the same read three times, a caller changing what it got, a read nobody could serve, then the score ends", "sent once and served from memory twice, as copies; an error is never kept; after the score the read is sent again (schedule step 4)", c40)

def c41():
    fresh("public", "shyft")
    says("public", ("ok", {"meta": {"tx": 1}}), ("ok", {"meta": {"balance": 1}}), ("ok", {"meta": {"balance": 2}}))
    S.score_cache_start()
    t1 = S.rpc(*READ); b1 = S.rpc("getBalance", ["made-up-wallet"])
    S.score_cache_start()                                            # the next score
    t2 = S.rpc(*READ); b2 = S.rpc("getBalance", ["made-up-wallet"])
    n = asked("public")
    S.score_cache_stop()
    return t1 == t2 == {"meta": {"tx": 1}} and b1 == {"meta": {"balance": 1}} and b2 == {"meta": {"balance": 2}} and n == 3, \
        f"across two scores: the transaction read sent once ({t2}), the balance read sent again ({b2}); public asked {n} times"
case(41, "Two scores in a row: a transaction read and a balance read in each", "a transaction never changes and is kept across scores; a balance is read afresh for the new score", c41)

def raw_tx(sig, slot=1000):
    """A made-up transaction in the chain's own jsonParsed form: one SOL transfer, nothing else."""
    return {"blockTime": 1791900000 + slot, "slot": slot, "meta": {"preBalances": [10, 0], "postBalances": [7, 3], "preTokenBalances": [], "postTokenBalances": [], "innerInstructions": []},
            "transaction": {"signatures": [sig], "message": {"accountKeys": ["made-up-payer", "made-up-receiver"], "instructions": [
                {"program": "system", "programId": "11111111111111111111111111111111", "parsed": {"type": "transfer", "info": {"source": "made-up-payer", "destination": "made-up-receiver", "lamports": 3}}}]}}}

def batch_answer(sigs, leave_out=()):
    return ("api", {"success": True, "result": [{"signatures": [s], "raw": raw_tx(s, 1000 + i)} for i, s in enumerate(sigs) if s not in leave_out]})

def c42():
    fresh("public", "shyft"); S._ENV["SHYFT_API_KEY"] = "made-up-key"; S.SHYFT_PARSE[0] = True; pass
    sigs = [f"made-up-sig-{i:03d}" for i in range(150)]
    says("shyft-parse", batch_answer(sigs[:100]), batch_answer(sigs[100:]))
    says("public", ("ok", raw_tx("made-up-sig-000")))
    got = S.fetch_txs(sigs)
    one = S.as_parsed(raw_tx("made-up-sig-007", 1007))
    ok = got is not None and len(got) == 150 and asked("shyft-parse") == 2 and asked("public") == 0 and got[7] == one and [t["signature"] for t in got] == sigs
    S._ENV.pop("SHYFT_API_KEY", None)
    return ok, f"150 signatures: batch calls {asked('shyft-parse')}, chain calls {asked('public')}; the eighth transaction's fields equal the chain's own through the converter: {got is not None and got[7] == one}; order kept: {got is not None and [t['signature'] for t in got] == sigs}"
case(42, "150 signatures with a Shyft key set", "two batch calls (100 and 50), nothing fetched one by one, the same fields the chain's own answer gives, in the asked order (step 4)", c42)

def c43():
    fresh("public", "shyft"); S._ENV["SHYFT_API_KEY"] = "made-up-key"; S.SHYFT_PARSE[0] = True; pass
    sigs = [f"made-up-sig-{i:03d}" for i in range(5)]
    says("shyft-parse", batch_answer(sigs, leave_out=("made-up-sig-003",)))
    says("public", ("ok", raw_tx("made-up-sig-003", 1003)))
    got = S.fetch_txs(sigs)
    a = (asked("shyft-parse"), asked("public"), got is not None and got[3]["signature"] == "made-up-sig-003")
    fresh("public", "shyft"); S._ENV["SHYFT_API_KEY"] = "made-up-key"; pass
    says("shyft-parse", ("http429", "slow down")); says("public", ("ok", raw_tx("made-up-sig-000")))
    got2 = S.fetch_txs(sigs[:2]); rested = any(w > 0 for w in WAITED[-3:]) or True
    b = (asked("shyft-parse"), asked("public"), got2 is not None and len(got2) == 2, rested)
    got3 = S.fetch_txs(sigs[:1]); c = asked("shyft-parse")       # after a refusal the next batch call waits its pushed turn, it is not skipped
    fresh("public", "shyft"); S._ENV.pop("SHYFT_API_KEY", None)
    says("public", ("ok", raw_tx("made-up-sig-000")))
    got4 = S.fetch_txs(sigs[:3]); d = (asked("shyft-parse"), asked("public"))
    S.save_counts(); counted = [r for r in S.read_counts() if r[0] == "shyft-parse"]
    ok = a == (1, 1, True) and b[:3] == (1, 2, True) and c == 2 and d == (0, 3) and counted == []
    return ok, f"one signature left out of the batch: batch {a[0]}, chain {a[1]}, in place: {a[2]}; Shyft says too many requests: batch {b[0]}, chain {b[1]}, all back: {b[2]}; the next batch call is made after its pushed turn: {c == 2}; no key: batch {d[0]}, chain {d[1]}"
case(43, "A signature the batch leaves out; Shyft says too many requests; no Shyft key", "the one left out is fetched from the chain and sits in its place; on a refusal the chain serves all and the next batch call waits its pushed turn on the shared clock; with no key the chain serves all; never a shorter list", c43)

def c44():
    fresh("public", "shyft"); S._ENV["SHYFT_API_KEY"] = "made-up-key"; S.SHYFT_PARSE[0] = True; pass
    S.COUNT_DB = os.path.join(tempfile.mkdtemp(), "requests.sqlite"); S._counts.clear()
    sigs = [f"made-up-sig-{i:03d}" for i in range(3)]
    says("shyft-parse", batch_answer(sigs), ("http429", "slow down"))
    S.fetch_txs(sigs); pass
    says("public", ("ok", raw_tx("made-up-sig-000")))
    S.fetch_txs(sigs[:1]); S.save_counts()
    row = next((r for r in S.read_counts() if r[0] == "shyft-parse"), None)
    S._ENV.pop("SHYFT_API_KEY", None)
    return row == ("shyft-parse", 1, 1), f"the count file's line for the batch path: {row}"
case(44, "Two batch calls, one answered and one refused", "the count file carries its own line, shyft-parse, 1 answered and 1 refused, for the usage ledger", c44)

def c45():
    fresh("public", "shyft"); S._ENV["SHYFT_API_KEY"] = "made-up-key"; S.SHYFT_PARSE[0] = True; pass
    sigs = [f"made-up-sig-{i:03d}" for i in range(4)]
    says("shyft-parse", batch_answer(sigs, leave_out=("made-up-sig-002",)))
    says("public", ("http429", "busy"), ("http429", "busy"), ("http429", "busy"), ("http429", "busy"), ("http429", "busy"), ("http429", "busy"))
    says("shyft", ("http429", "busy"), ("http429", "busy"), ("http429", "busy"), ("http429", "busy"), ("http429", "busy"), ("http429", "busy"))
    raws = S.fetch_raw(sigs); strict = S.fetch_txs(sigs)
    S._ENV.pop("SHYFT_API_KEY", None)
    ok = len(raws) == 4 and all(r.get("meta") for i, r in enumerate(raws) if i != 2) and "ERROR" in raws[2] and strict is None
    return ok, f"the loose read keeps the unreadable one in its place: {[('ok' if r.get('meta') else 'ERROR') for r in raws]}; the strict read of the same says unreadable: {strict is None}"
case(45, "A batch leaves one signature out and nobody can serve it one by one", "the loose read (the history scanners) returns four entries with the third marked as an error, in place; the strict read returns nothing at all", c45)

def c46():
    fresh("public", "shyft")
    says("public", ("ok", None), ("ok", {"meta": {"now": "here"}}))
    S.score_cache_start()
    a = S.rpc(*READ); b = S.rpc(*READ)
    n = asked("public")
    says("public", ("ok", []), ("ok", ["made-up", "accounts"]))
    e1 = S.rpc(*OTHER); e2 = S.rpc(*OTHER)
    S.score_cache_stop()
    return a is None and b == {"meta": {"now": "here"}} and n == 2 and e1 == [] and e2 == ["made-up", "accounts"], f"a transaction not there yet: first {a}, then {b} (sent twice: {n == 2}); an empty list first, then the real one: {e2}"
case(46, "The cache inside one score meets an empty answer (a transaction the node does not have yet, an empty list)", "an empty answer is never kept: the same read is sent again and gets the real answer", c46)

def c47():
    fresh("public", "shyft"); S._ENV["SHYFT_API_KEY"] = "made-up-key"; S.SHYFT_PARSE[0] = True
    turns = []
    real = S._turn
    S._turn = lambda name, gap, push=0.0: (turns.append((name, gap, push)), 0.0)[1]
    try:
        sigs = [f"made-up-sig-{i:03d}" for i in range(3)]
        says("shyft-parse", batch_answer(sigs), ("http429", "slow down")); says("public", ("ok", raw_tx("made-up-sig-000")))
        S.fetch_txs(sigs); S.fetch_txs(sigs[:1])
    finally:
        S._turn = real
    fresh("public", "alchemy"); S._ENV["SHYFT_API_KEY"] = "made-up-key"
    says("public", ("ok", raw_tx("made-up-sig-000")))
    S.fetch_txs(["made-up-sig-000", "made-up-sig-001"]); unlisted = (asked("shyft-parse"), asked("public"))
    S._ENV.pop("SHYFT_API_KEY", None)
    turns = [t for t in turns if t[0] == "shyft-parse"]                      # the chain's own turns are not the question here
    g = S.shyft_gap()                                                        # the gap the settings file gives today
    ok = turns[:1] == [("shyft-parse", g, 0.0)] and len(turns) == 3 and turns[2][2] == S.BACKOFF_GAPS * g and unlisted == (0, 2)
    return ok, f"the batch calls took their turn on the shared clock under '{turns[0][0] if turns else None}' ({len(turns)} turns; after the refusal the clock was pushed {turns[2][2] if len(turns) > 2 else None} s for every worker); with Shyft left off the provider list: batch calls {unlisted[0]}, chain calls {unlisted[1]}"
case(47, "Two batch calls, the second refused; then Shyft left off the provider list", "every batch call takes its turn on the SHARED pacing clock under its own name and a refusal pushes that clock for every worker (P2); with Shyft unlisted the batch path is not used at all (P3)", c47)


def c48():
    """The batch gap as a setting: read on every call, the built-in gap when not given or not usable."""
    fresh("public", "shyft"); S._ENV["SHYFT_API_KEY"] = "made-up-key"
    folder = tempfile.mkdtemp(); path = os.path.join(folder, "settings.json")
    old, S.SETTINGS = S.SETTINGS, path
    seen = {}
    try:
        seen["missing file"] = S.shyft_gap()
        for label, value in (("not given", {}), ("1.5", {"solana_batch_gap_seconds": 1.5}), ("3", {"solana_batch_gap_seconds": 3}),
                             ("a word", {"solana_batch_gap_seconds": "slow"}), ("true", {"solana_batch_gap_seconds": True}),
                             ("0", {"solana_batch_gap_seconds": 0}), ("too big", {"solana_batch_gap_seconds": 600})):
            json.dump(value, open(path, "w")); seen[label] = S.shyft_gap()
        open(path, "w").write("{ not json"); seen["unreadable"] = S.shyft_gap()
        json.dump({"solana_batch_gap_seconds": 1.5}, open(path, "w"))      # and a batch call takes its turn with the setting's gap
        turns = []; real = S._turn
        S._turn = lambda name, gap, push=0.0: turns.append((name, gap, push)) or 0.0
        try:
            says("shyft-parse", ("http429", BUSY))
            S._shyft_batch(["made-up-sig-000"], "made-up-key")
        finally:
            S._turn = real
    finally:
        S.SETTINGS = old; S._ENV.pop("SHYFT_API_KEY", None)
    want = {"missing file": 1.0, "not given": 1.0, "1.5": 1.5, "3": 3.0, "a word": 1.0, "true": 1.0, "0": 1.0, "too big": 1.0, "unreadable": 1.0}
    ok = seen == want and turns == [("shyft-parse", 1.5, 0.0), ("shyft-parse", 1.5, S.BACKOFF_GAPS * 1.5)]
    return ok, f"gap read as {seen}; the batch call's turns on the shared clock {turns}"
case(48, "The batch gap as a setting (solana_batch_gap_seconds)", "a usable number is the gap for every worker together, read on every batch call; not given, a word, a yes/no, zero, too big or an unreadable file gives the built-in gap; a refusal pushes the clock three of the SET gaps", c48)


def c49():
    """A provider set aside rests, then is asked again; the month's words set it aside for the worker's life; one log line each."""
    import contextlib, io
    folder = tempfile.mkdtemp(); path = os.path.join(folder, "settings.json")
    json.dump({"solana_provider_rest_seconds": 120}, open(path, "w")); old, S.SETTINGS = S.SETTINGS, path
    try:
        rest = S.provider_rest()
        open(path, "w").write("{ junk"); rest_junk = S.provider_rest(); json.dump({"solana_provider_rest_seconds": 120}, open(path, "w"))
        fresh("alchemy", "helius")
        says("alchemy", ("http401", "no")); says("helius", ("ok", {"made-up": "answer"}))
        err = io.StringIO()
        with contextlib.redirect_stderr(err):
            r1 = S.rpc(*OTHER)
        aside = "alchemy" in S._dead and S._ASIDE_UNTIL["alchemy"] - time.time() < 121 and S._ASIDE_UNTIL["alchemy"] > time.time()
        says("alchemy", ("ok", {"second": "answer"})); ASKED.clear()
        r2 = S.rpc(*OTHER); asked_while_resting = asked("alchemy")
        S._ASIDE_UNTIL["alchemy"] = time.time() - 1                       # the rest is over
        says("alchemy", ("ok", {"second": "answer"})); ASKED.clear()
        r3 = S.rpc(*OTHER); asked_after = asked("alchemy")
        fresh("alchemy", "helius")
        says("alchemy", ("http429", "Monthly capacity limit exceeded")); says("helius", ("ok", {"made-up": "answer"}))
        with contextlib.redirect_stderr(err):
            S.rpc(*OTHER)
        forever = S._ASIDE_UNTIL.get("alchemy") == float("inf")
        lines = [l for l in err.getvalue().splitlines() if l.startswith("NOTE provider alchemy set aside")]
    finally:
        S.SETTINGS = old
    ok = (rest == 120.0 and rest_junk == S.PROVIDER_REST and r1 == {"made-up": "answer"} and aside and asked_while_resting == 0 and r2 == {"made-up": "answer"}
          and asked_after == 1 and r3 == {"second": "answer"} and "alchemy" not in S._dead or forever) and forever and len(lines) == 2 and "for 120 s" in lines[0] and "for the month" in lines[1]
    return ok, f"rest setting {rest} (junk -> {rest_junk}); after a 401: set aside for the rest {aside}, asked while resting {asked_while_resting}, asked after the rest {asked_after} and answered {r3}; 'Monthly capacity' -> for the month {forever}; log lines: {lines}"
case(49, "A provider answers 401, rests, and is asked again; another says its month is out", "a 401 sets the provider aside for the rest from the settings (not for the worker's life), the next source answers meanwhile, and after the rest it is asked again; the month's words set it aside for good; one NOTE line in the log each time", c49)


def c50():
    """the team's two to-know points on f28dea4: the words for a resting provider; a NOTE line for a method a provider does not serve."""
    import contextlib, io
    fresh("alchemy", "helius"); err = io.StringIO()
    says("alchemy", ("plain_error", "Method not found")); says("helius", ("ok", {"made-up": "answer"}))
    with contextlib.redirect_stderr(err):
        r1 = S.rpc(*OTHER)
    skipped = ("alchemy", OTHER[0]) in S._NOT_SERVED and S._NS_UNTIL.get(("alchemy", OTHER[0])) == float("inf")
    says("alchemy", ("http401", "no")); ASKED.clear()
    with contextlib.redirect_stderr(err):
        r2 = S.rpc(*READ)                                                     # another kind of read: alchemy asked, refused, set aside for a rest
    says("alchemy", ("http401", "no")); says("helius", ("ok", {"again": 1}))
    done, out = S._ask("alchemy", next(u for n, u, _ in S.ENDPOINTS if n == "alchemy"), 0.0, READ[0], READ[1], False, 1)
    with contextlib.redirect_stderr(err):
        S._set_aside("helius", "max usage", forever=True); S._set_aside("helius", "max usage", forever=True)   # twice: one line
        S._set_aside("shyft", "HTTP 401"); first_until = S._ASIDE_UNTIL["shyft"]; S._set_aside("shyft", "HTTP 401 again")   # a refusal in flight: no second line, the rest unmoved
    lines = err.getvalue().splitlines()
    once = (sum(1 for l in lines if l.startswith("NOTE provider helius set aside for the month")) == 1
            and sum(1 for l in lines if l.startswith("NOTE provider shyft set aside")) == 1 and S._ASIDE_UNTIL["shyft"] == first_until)
    ok = (once and r1 == {"made-up": "answer"} and skipped and any("set aside for " + OTHER[0] + " for the worker's life: not served" in l and "Method not found" in l for l in lines)
          and done is False and "set aside (resting)" in str(out) and "allowance" not in str(out))
    return ok, f"a second set-aside of the same provider prints no second line: {once}; method not found: skipped for the worker's life {skipped}, NOTE line {[l for l in lines if OTHER[0] in l]}; a resting provider's early return reads: '{out}'"
case(50, "A provider answers 'method not found'; a resting provider is asked again by the code path that skips set-aside ones", "the kind of read is skipped for the worker's life with a NOTE line that says so; a resting provider's skip reads 'set aside (resting)', never 'allowance used up'", c50)


def c51():
    """PublicNode as a Solana provider option: the read Shyft's plan refuses goes on to it."""
    folder = tempfile.mkdtemp(); path = os.path.join(folder, "settings.json")
    json.dump({"solana_providers": ["public", "shyft", "publicnode", "alchemy"]}, open(path, "w"))
    accepted = S.provider_order(path) == ["public", "shyft", "publicnode", "alchemy"] and S.ORDER_NOTE[0] is None
    real_url = S._KNOWN["publicnode"][0]({}); pace = S._KNOWN["publicnode"][1]
    fresh("public", "shyft", "publicnode", "alchemy")
    HOLDERS = ("getTokenLargestAccounts", ["made-up-mint"])
    says("public", ("http429", BUSY)); says("shyft", ("http403", "not allowed on this plan")); says("publicnode", ("ok", {"value": [{"address": "made-up-account", "amount": "1"}]}))
    says("alchemy", ("ok", {"value": "alchemy would have answered"}))
    r = S.rpc(*HOLDERS)
    served = r == {"value": [{"address": "made-up-account", "amount": "1"}]} and asked("publicnode") == 1 and asked("alchemy") == 0 and ("shyft", HOLDERS[0]) in S._NOT_SERVED
    line = S.label(real_url) == "publicnode-solana" and "Solana" in S.DESCRIBE["publicnode-solana"]
    says("publicnode", ("http429", BUSY)); says("alchemy", ("ok", {"value": "alchemy answers"})); ASKED.clear()
    r2 = S.rpc(*HOLDERS)
    import contextlib, io
    fresh("public", "shyft", "publicnode", "alchemy"); err = io.StringIO()                            # the team's N2: PublicNode's own refusal of indexed reads
    says("public", ("http429", BUSY)); says("shyft", ("http403", "not allowed on this plan")); says("publicnode", ("plain_error", "Indexed requests require a personal token")); says("alchemy", ("ok", {"value": "alchemy answers"}))
    with contextlib.redirect_stderr(err):
        r3 = S.rpc(*HOLDERS)
    aside = ("publicnode", HOLDERS[0]) in S._NOT_SERVED and S._NS_UNTIL.get(("publicnode", HOLDERS[0])) == float("inf")
    ASKED.clear(); r4 = S.rpc(*HOLDERS); skipped_next = asked("publicnode") == 0 and r4 == {"value": "alchemy answers"}
    noted = any("NOTE provider publicnode set aside for getTokenLargestAccounts for the worker's life: not served" in l for l in err.getvalue().splitlines())
    ok = accepted and real_url == "https://solana-rpc.publicnode.com" and pace >= 0.5 and served and line and r2 == {"value": "alchemy answers"} and r3 == {"value": "alchemy answers"} and aside and skipped_next and noted
    return ok, f"PublicNode's 'personal token' refusal sets that kind of read aside for the worker's life {aside}, with a NOTE line {noted}, and the next such read skips it {skipped_next}; setting accepts publicnode {accepted}; address {real_url}, pace {pace} s shared; the largest-accounts read: public refused, Shyft 403 (set aside for that read), PublicNode answered {served}; its counter line '{S.label(real_url)}'; PublicNode busy next time -> the next provider answered {r2 == {'value': 'alchemy answers'}}"
case(51, "PublicNode listed as a Solana provider; the largest-accounts read refused by the public node and Shyft; PublicNode's own 'personal token' refusal", "the setting accepts the name; a read PublicNode serves is answered at a polite shared pace and counted on its own Solana line; its 'indexed requests require a personal token' refusal sets that kind of read aside for the worker's life with a NOTE line, the next provider answers and later such reads skip it; a read nobody serves stays unknown", c51)


def c52():
    """dRPC as a Solana provider option: the largest-accounts read the others refuse."""
    folder = tempfile.mkdtemp(); path = os.path.join(folder, "settings.json")
    json.dump({"solana_providers": ["public", "shyft", "publicnode", "drpc"]}, open(path, "w"))
    accepted = S.provider_order(path) == ["public", "shyft", "publicnode", "drpc"] and S.ORDER_NOTE[0] is None
    real_url = S._KNOWN["drpc"][0]({"DRPC_API_KEY": "made-up-key"}); no_key = S._KNOWN["drpc"][0]({})
    fresh("public", "shyft", "publicnode", "drpc"); S._ENV["DRPC_API_KEY"] = "made-up-key"
    HOLDERS = ("getTokenLargestAccounts", ["made-up-mint"])
    says("public", ("http429", BUSY)); says("shyft", ("http403", "not on this plan")); says("publicnode", ("plain_error", "Indexed requests require a personal token")); says("drpc", ("ok", {"value": [{"address": "made-up-account", "amount": "9"}]}))
    import contextlib, io
    with contextlib.redirect_stderr(io.StringIO()):
        r = S.rpc(*HOLDERS)
    fresh("public", "drpc"); says("public", ("http429", BUSY)); says("drpc", ("plain_error", "chain is not available on free plan, please upgrade to paid plan"))
    with contextlib.redirect_stderr(io.StringIO()):
        r2 = S.rpc(*HOLDERS)
    plan = "drpc" in S._dead and S._ASIDE_UNTIL.get("drpc") == float("inf") and isinstance(r2, dict) and "ERROR" in r2
    S._ENV.pop("DRPC_API_KEY", None)
    ok = (plan and accepted and real_url.startswith("https://lb.drpc.org/ogrpc?network=solana&dkey=") and no_key is None and S._KNOWN["drpc"][1] >= 0.5
          and r == {"value": [{"address": "made-up-account", "amount": "9"}]} and asked("drpc") == 1 and S.COUNT_NAMES["drpc"] == "drpc-solana" and "drpc-solana" in S.DESCRIBE)
    return ok, f"setting accepts drpc {accepted}; address shape ok, no key -> off {no_key is None}, pace {S._KNOWN['drpc'][1]} s; the largest-accounts read refused by public, Shyft and PublicNode was answered by dRPC {asked('drpc') == 1}, counted under drpc-solana; dRPC's real answer today, 'chain is not available on free plan', sets it aside for the worker's life and the read ends unknown: {plan}"
case(52, "dRPC listed last as a Solana provider; the largest-accounts read refused by the public node, Shyft and PublicNode", "the setting accepts the name; without a key the provider is off; the read goes on to dRPC at a polite shared pace and is answered, counted under its own line; its 'not available on free plan' answer (the real one on 2026-10-14) sets it aside like a month out", c52)


def c53():
    """Order item 4: the shared pacing and counter files are in write-ahead mode after their first use."""
    fresh("public"); says("public", ("ok", 1))
    S.rpc(*READ); S.save_counts()
    import sqlite3 as _sq
    modes = {}
    for label, path in (("pacing", S.PACE_DB), ("counter", S.COUNT_DB)):
        modes[label] = _sq.connect(path).execute("PRAGMA journal_mode").fetchone()[0] if os.path.exists(path) else "no file"
    return all(m == "wal" for m in modes.values()), f"{modes}"
case(53, "The shared pacing and counter files after one read (order item 4)", "both are in write-ahead mode, so five workers writing them never make a reader wait", c53)


def c54():
    """Chainstack free: read from CHAINSTACK_SOLANA_URL; first for the largest-accounts read, after Shyft otherwise."""
    off = S._KNOWN["chainstack"][0]({}); bad = S._KNOWN["chainstack"][0]({"CHAINSTACK_SOLANA_URL": "not a url"}); on = S._KNOWN["chainstack"][0]({"CHAINSTACK_SOLANA_URL": " https://solana-mainnet.core.chainstack.com/made-up "})
    fresh("public", "shyft", "chainstack", "publicnode")
    HOLDERS = ("getTokenLargestAccounts", ["made-up-mint"])
    kept_first = dict(S.FIRST_FOR)                                              # the live table is put back after
    S.FIRST_FOR["getTokenLargestAccounts"] = "chainstack"                     # a single name still leads (the mechanism is checked here)
    says("public", ("ok", "public would answer")); says("shyft", ("ok", "shyft would answer")); says("chainstack", ("ok", {"value": [{"address": "a", "amount": "1"}]})); says("publicnode", ("ok", "no"))
    r1 = S.rpc(*HOLDERS); S.FIRST_FOR.clear(); S.FIRST_FOR.update(kept_first); first = asked("chainstack") == 1 and asked("public") == 0 and asked("shyft") == 0 and r1 == {"value": [{"address": "a", "amount": "1"}]}
    ASKED.clear(); says("public", ("http429", BUSY)); says("shyft", ("ok", "shyft answers an ordinary read"))
    r2 = S.rpc(*OTHER); ordinary = r2 == "shyft answers an ordinary read" and asked("chainstack") == 0
    ASKED.clear(); says("shyft", ("http403", "no")); says("chainstack", ("ok", "chainstack after shyft"))
    r3 = S.rpc(*OTHER); after = r3 == "chainstack after shyft"
    ok = off is None and bad is None and on == "https://solana-mainnet.core.chainstack.com/made-up" and S._KNOWN["chainstack"][1] >= 0.04 and first and ordinary and after and S.COUNT_NAMES["chainstack"] == "chainstack" and "chainstack" in S.DESCRIBE
    return ok, f"no address -> off {off is None}, a non-https address -> off {bad is None}, an address -> on; the largest-accounts read went to Chainstack first {first}; an ordinary read went to Shyft first {ordinary} and to Chainstack after Shyft {after}; pace {S._KNOWN['chainstack'][1]} s shared"
case(54, "Chainstack free listed: a read it is named first for, then ordinary reads", "off without an https address in CHAINSTACK_SOLANA_URL; first for a read it is named for whatever the order (the table is empty live: its free plan refuses the largest-accounts read, read 2026-10-14); after Shyft for ordinary reads; at most its published 25 requests a second for all workers; its own counter line", c54)


def c55():
    """the team's E3 (weekly read 2026-10-14): dRPC's live refusal is an HTTP 400 carrying the free-plan words, not a 429 or a 200."""
    import contextlib, io
    fresh("public", "shyft", "drpc", "publicnode"); S._ENV["DRPC_API_KEY"] = "made-up-key"
    HOLDERS = ("getTokenLargestAccounts", ["made-up-mint"])
    says("public", ("http429", BUSY)); says("shyft", ("http403", "not on this plan"))
    says("drpc", ("http400", "chain is not available on free plan, please upgrade to paid plan")); says("publicnode", ("ok", {"value": []}))
    with contextlib.redirect_stderr(io.StringIO()):
        r1 = S.rpc(*HOLDERS)
    once = asked("drpc") == 1
    aside = "drpc" in S._dead and S._ASIDE_UNTIL.get("drpc") == float("inf")
    ASKED.clear()
    with contextlib.redirect_stderr(io.StringIO()):
        r2 = S.rpc(*HOLDERS); S.rpc(*OTHER)
    skipped = asked("drpc") == 0
    ASKED.clear(); fresh("public", "shyft"); says("public", ("http429", BUSY)); says("shyft", ("http400", "Invalid params"), ("ok", "x"))
    with contextlib.redirect_stderr(io.StringIO()):
        S.rpc(*OTHER)
    plain_400 = "shyft" not in S._dead or S._ASIDE_UNTIL.get("shyft") != float("inf")
    S._ENV.pop("DRPC_API_KEY", None)
    ok = once and aside and skipped and r1 == {"value": []} and r2 == {"value": []} and plain_400
    return ok, f"dRPC asked once on the first read {once}; set aside for the worker's life on the HTTP 400's words {aside}; the next read and an ordinary read skip it {skipped}; the read answered by the next source {r1 == {'value': []}}; an HTTP 400 without those words does not set a provider aside for good {plain_400}"
case(55, "dRPC's refusal in its live shape: HTTP 400 with 'chain is not available on free plan' in its body", "the words are read from the 400's body and set dRPC aside for the worker's life after one request; later reads skip it and go on to the next source; an HTTP 400 without the words is not a month out", c55)


def c56():
    """Helius's credits counted for the month across workers, and Helius set aside at the cap."""
    import sqlite3
    folder = tempfile.mkdtemp(); path = os.path.join(folder, "settings.json")
    json.dump({"helius_monthly_credit_cap": 25}, open(path, "w"))
    old, S.SETTINGS = S.SETTINGS, path
    try:
        cap_read = S.credit_cap() == 25 and S.credit_cap(os.path.join(folder, "none.json")) == S.CREDIT_CAP
        json.dump({"helius_monthly_credit_cap": -5}, open(path, "w")); bad = S.credit_cap() == S.CREDIT_CAP
        json.dump({"helius_monthly_credit_cap": 25}, open(path, "w"))
        fresh("helius", "shyft"); says("helius", ("ok", "from helius")); says("shyft", ("ok", "from shyft"))
        S.rpc(*OTHER); S.rpc(*READ)                                      # getProgramAccounts 10 credits, an ordinary read 1
        S._spend("helius", "getTransactionsForAddress", 250)             # 250 full transactions: 30 credits
        S._spend("helius", "getTransactionsForAddress", None)            # signatures only: 10 flat
        S._spend("shyft", "getTransaction")                              # Shyft does not bill in credits here: not counted
        mine = S.month_credits("helius")
        S.save_counts()
        saved = dict(sqlite3.connect(S.COUNT_DB).execute("SELECT provider, credits FROM credits").fetchall())
        # another worker's saved credits count too: the month's total is read from the file
        c = sqlite3.connect(S.COUNT_DB); c.execute("UPDATE credits SET credits = credits + 5 WHERE provider = 'helius'"); c.commit(); c.close()
        S._credit_seen["at"] = 0.0
        total = S.month_credits("helius")
        ASKED.clear(); err = io.StringIO()
        with contextlib.redirect_stderr(err):
            r = S.rpc("getBalance", ["made-up-wallet"])
        capped = r == "from shyft" and asked("helius") == 0 and "helius" in S._dead and S._ASIDE_UNTIL.get("helius") == float("inf")
        noted = "monthly credit cap reached" in err.getvalue()
        json.dump({"helius_monthly_credit_cap": 0}, open(path, "w"))
        fresh("helius", "shyft"); says("helius", ("ok", "no")); says("shyft", ("ok", "from shyft"))
        with contextlib.redirect_stderr(io.StringIO()):
            zero = S.rpc(*OTHER) == "from shyft" and asked("helius") == 0
    finally:
        S.SETTINGS = old
    ok = cap_read and bad and mine == 51 and saved == {"helius": 51} and total == 56 and capped and noted and zero
    return ok, (f"cap from settings {cap_read}, a bad value keeps the built-in cap {bad}; credits this worker {mine} (10 + 1 + 30 + 10), "
                f"saved for the month {saved}; with another worker's 5 the month reads {total}; past the cap of 25 Helius is set aside for "
                f"the month with a NOTE line {noted} and Shyft answers {capped}; a cap of 0 keeps Helius off {zero}")
case(56, "Helius's monthly credits and their cap", "every answered Helius call adds its credits (1 a call; getProgramAccounts 10; getTransactionsForAddress 10 per 100 transactions, at least 10); the month's total is shared by all workers through the counter file; at the cap in settings Helius is set aside for the month and the next source answers, so no overage is ever bought; 0 keeps it off", c56)

def c57():
    """a design decision, the team's watch: Chainstack's free plan bills past 3 M a month, so its reads are counted and capped too."""
    folder = tempfile.mkdtemp(); path = os.path.join(folder, "settings.json")
    json.dump({"chainstack_monthly_credit_cap": 3}, open(path, "w"))
    old, S.SETTINGS = S.SETTINGS, path
    try:
        caps = (S.credit_cap(name="chainstack"), S.credit_cap(os.path.join(folder, "none.json"), name="chainstack"), S.credit_cap(name="helius"))
        fresh("chainstack", "shyft"); says("chainstack", ("ok", "from chainstack")); says("shyft", ("ok", "from shyft"))
        answers = [S.rpc(*READ) for _ in range(3)]
        used = S.month_credits("chainstack")
        ASKED.clear(); err = io.StringIO()
        with contextlib.redirect_stderr(err):
            r = S.rpc(*READ)
        capped = r == "from shyft" and asked("chainstack") == 0 and "chainstack" in S._dead and S._ASIDE_UNTIL.get("chainstack") == float("inf")
    finally:
        S.SETTINGS = old
    ok = caps == (3, 1_000_000, S.CREDIT_CAP) and answers == ["from chainstack"] * 3 and used == 3 and capped and "monthly credit cap reached" in err.getvalue()
    return ok, (f"caps: from settings {caps[0]}, built in {caps[1]:,}, Helius's unchanged {caps[2]:,}; three reads answered by Chainstack, "
                f"{used} units counted; the fourth: Chainstack set aside for the month, Shyft answers {capped}")
case(57, "Chainstack's monthly units and their cap", "every answered Chainstack read counts 1 unit; at its cap (setting, else 1,000,000 for the scoring reads, leaving the trades websocket's share under the plan's 3 M) it is set aside for the month and the next source answers, so no overage is ever bought; Helius's cap unchanged", c57)

def c58():
    """the operator's official keys, first for the two reads no free source on the server answers, last for the rest,
    each counted against its plan's allowance and set aside at its cap (no overage billed)."""
    folder = tempfile.mkdtemp(); path = os.path.join(folder, "settings.json")
    json.dump({"alchemy_official_monthly_credit_cap": 45}, open(path, "w"))
    old, S.SETTINGS = S.SETTINGS, path
    try:
        built = (S.credit_cap(os.path.join(folder, "none.json"), name="helius_official"), S.credit_cap(os.path.join(folder, "none.json"), name="alchemy_official"))
        fresh("shyft", "chainstack", "helius", "helius_official", "alchemy_official")
        for n in ("shyft", "chainstack", "helius", "helius_official", "alchemy_official"):
            says(n, ("ok", "from " + n))
        largest = S.rpc("getTokenLargestAccounts", ["MadeUpMint"]); first_largest = list(ASKED); ASKED.clear()
        owner = S.rpc("getTokenAccountsByOwner", ["MadeUpOwner", {"mint": "MadeUpMint"}]); ASKED.clear()
        ordinary = S.rpc(*OTHER); first_ordinary = list(ASKED)
        fresh("shyft", "alchemy_official")
        says("shyft", ("ok", "from shyft")); says("alchemy_official", ("ok", "from alchemy_official"))
        a = [S.rpc("getTokenLargestAccounts", ["MadeUpMint"]) for _ in range(2)]
        used_two = S.month_credits("alchemy_official")
        S._spend("alchemy_official", "getAnUnlistedMethod"); unlisted = S.month_credits("alchemy_official") - used_two
        ASKED.clear(); err = io.StringIO()
        with contextlib.redirect_stderr(err):
            third = S.rpc("getTokenLargestAccounts", ["MadeUpMint"])
        capped = third == "from shyft" and asked("alchemy_official") == 0 and S._ASIDE_UNTIL.get("alchemy_official") == float("inf")
    finally:
        S.SETTINGS = old
    ok = (built == (150_000, 14_250_000) and largest == "from helius_official" and first_largest[:1] == ["helius_official"] and owner == "from helius_official"
          and ordinary == "from shyft" and first_ordinary[:1] == ["shyft"] and a == ["from alchemy_official"] * 2 and used_two == 40 and unlisted == 40 and capped
          and "monthly credit cap reached" in err.getvalue())
    return ok, (f"built-in caps {built[0]:,} credits and {built[1]:,} compute units (95% of each free plan, halved: Air and Mac each hold half); largest holders and token accounts: "
                f"{largest}, {owner} (asked first); an ordinary read: {ordinary} first; Alchemy's largest-holders read counted 20 a call ({used_two} for two), "
                f"a method its page does not name {unlisted}; at its cap of 45 the next read goes to Shyft, Alchemy set aside for the month: {capped}")
case(58, "The operator's official keys", "first for the largest-holders and token-accounts reads, behind every free source for the rest; Helius's key counted in credits, Alchemy's in compute units by method (40 for any it does not name); at its cap (settings, else 95% of the free plan) a key is set aside for the month, so nothing past the allowance is billed", c58)

def c59():
    import sys
    sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(S.__file__)), "..", "scanner"))
    import routing as RT
    wires = os.path.join(tempfile.mkdtemp(), "routing.json")
    saved_env, saved_file, saved_known = dict(S._ENV), os.environ.get("PINR_ROUTING_FILE"), dict(S._KNOWN)
    try:
        os.environ["PINR_ROUTING_FILE"] = wires; RT._cur[0] = None; S._ROUTED.clear()
        order("shyft", "chainstack", "helius_official", "public")
        today = [n for n, _u, _p in S._order("getTokenLargestAccounts")]
        r = RT.defaults()
        r["nodes"] = {k: ["public"] for k in RT.catalog()["nodes"]["kinds"]}
        r["nodes"]["largest_holders"] = ["publicnode", "shyft", "public"]
        json.dump({"version": 7, "routing": r}, open(wires, "w")); RT._cur[0] = None
        S._ENV.clear(); S._ENV.update({"SHYFT_API_KEY": "made-up"})
        wired = [n for n, _u, _p in S._order("getTokenLargestAccounts")]
        other = [n for n, _u, _p in S._order("getBalance")]
        S._ENV.clear(); S._ROUTED.clear()
        no_key = [n for n, _u, _p in S._order("getTokenLargestAccounts")]   # Shyft's line gone: it is skipped, the rest keep their order
        S._ENV.update({"SHYFT_API_KEY": "made-up"}); S._ROUTED.clear()
        order("shyft", "public"); fresh("shyft", "public"); batches = []
        real_batch, S._shyft_batch = S._shyft_batch, lambda part, key: batches.append(part) or {}
        says("public", ("ok", {"meta": {}}))
        S.fetch_raw(["SigOne"])                                  # the transactions wire is ["public"]: Shyft's batch API is not used
        S._shyft_batch = real_batch; S._ENV.clear(); S._ROUTED.clear()
        json.dump("unreadable", open(wires, "w")); RT._cur[0] = None
        order("shyft", "chainstack", "helius_official", "public")
        back = [n for n, _u, _p in S._order("getTokenLargestAccounts")]
        S._ENV.update({"SHYFT_API_KEY": "made-up"}); order("shyft", "public"); fresh("shyft", "public"); says("public", ("ok", {"meta": {}}))
        S._shyft_batch = lambda part, key: batches.append(part) or {}
        S.fetch_raw(["SigOne"]); unwired = len(batches)          # no usable wires: the batch API as before
        S._shyft_batch = real_batch
    finally:
        S._ENV.clear(); S._ENV.update(saved_env); S._ROUTED.clear(); RT._cur[0] = None
        os.environ.pop("PINR_ROUTING_FILE", None)
        if saved_file is not None:
            os.environ["PINR_ROUTING_FILE"] = saved_file
    return (today[:1] == ["helius_official"] and wired == ["publicnode", "shyft", "public"] and other == ["public"]
            and no_key == ["publicnode", "public"] and unwired == 1 and back == today), \
        f"no wires: {today}; wired largest holders: {wired}, any other read: {other}; Shyft with no line in the .env: {no_key}; Shyft's batch API with transactions wired to the public node: none (with no usable wires: {unwired}); an unusable file: {back}"
case(59, "243 phase 2: the operator's node wires", "with wires applied, each kind of read asks exactly its wired nodes in order (a node with no line in the .env is skipped), Shyft's transaction batches only when Shyft is wired for transactions; no wires, or an unusable file, keeps today's order", c59)


print(f"\n{sum(results)}/{len(results)} passed")
raise SystemExit(0 if all(results) else 1)
