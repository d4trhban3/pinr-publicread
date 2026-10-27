"""Minimal Solana JSON-RPC client.

Endpoints, tried in the order scanner/settings.json gives (`solana_providers`), every one through the chain's standard
JSON-RPC methods only (no provider-only API; Helius and Alchemy are ordinary free nodes, never first,
never required; keys from the git-ignored ../.env). Keys are never printed or logged. Rate limits are retried patiently; a persistent failure
comes back as {"ERROR": ...} so callers mark the reading unknown instead of guessing."""
import json, os, sys, threading, time, urllib.error, urllib.request
import concurrent.futures as _cf

_HERE = os.path.dirname(os.path.abspath(__file__))


def _load_env():
    env = {}
    path = os.path.join(_HERE, "..", ".env")
    if os.path.exists(path):
        for line in open(path):
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                k, v = line.split("=", 1)
                env[k.strip()] = v.strip().strip('"').strip("'")
    return env


_ENV = _load_env()

# ------------------------------------------------------------------ providers and their order (a setting)
# Every Solana node PINR may read from. A provider with no key in .env simply is not there.
#   name: (address builder, seconds between requests to this provider, ALL workers together)
# The gap belongs to the provider, not to a worker: one account or one address has one allowance however many workers
# share it. Shyft's is its documented 10 requests a second (facts/SOURCE-MAP.md). The others are the rates the
# two-worker scanner ran at: half the old per-worker gap, so together the workers ask them no more often than before.
_KNOWN = {
    "public": (lambda e: "https://api.mainnet-beta.solana.com", 0.25),   # 4 a second for all workers: under Solana's published 100 per 10 s per IP and 40 per method
    "shyft": (lambda e: e.get("SHYFT_API_KEY") and "https://rpc.shyft.to?api_key=" + e["SHYFT_API_KEY"], 0.1),   # 10 a second: its free plan's published limit (docs.shyft.to solana-rpc-limits, read 2026-10-21)
    "alchemy": (lambda e: e.get("ALCHEMY_API_KEY") and "https://solana-mainnet.g.alchemy.com/v2/" + e["ALCHEMY_API_KEY"], 0.025),
    # Helius (the operator's Developer plan, 50 requests a second, 10,000,000 credits a month; the same key name
    # as the free key it replaces): 40 a second for all workers together; its credits are counted against a monthly cap
    "helius": (lambda e: e.get("HELIUS_API_KEY") and "https://mainnet.helius-rpc.com/?api-key=" + e["HELIUS_API_KEY"], 0.1),   # 10 a second: its free plan's published limit
    # PublicNode: for the reads the others refuse (Shyft's 403 on the
    # largest-accounts read); a polite pace, two requests a second for all workers together, its allowance not published
    "publicnode": (lambda e: "https://solana-rpc.publicnode.com", 0.5),
    # dRPC: tested for the largest-accounts read the others refuse;
    # a polite pace, two requests a second for all workers together, until its page's limit is read
    "drpc": (lambda e: e.get("DRPC_API_KEY") and "https://lb.drpc.org/ogrpc?network=solana&dkey=" + e["DRPC_API_KEY"], 0.5),
    # Chainstack free: the operator's own node, its HTTPS address in .env as CHAINSTACK_SOLANA_URL; first for
    # the largest-accounts read, after Shyft for the rest; its plan says 25 requests a second, PINR asks at most ten for all workers
    "chainstack": (lambda e: (e.get("CHAINSTACK_SOLANA_URL") or "").strip().startswith("https://") and e["CHAINSTACK_SOLANA_URL"].strip() or None, 0.05),   # 20 a second, under its Developer plan's published 25 RPS
    # Your RPC providers for the worker machine's scoring workers: each its HTTPS
    # address in the worker machine's .env, used on the worker machine only (scanner/extra_worker.py sets the worker machine's list to these three), never with a card.
    # RPC provider A's free trial 15 requests a second and RPC provider B's free 10: PINR asks at most that, for all
    # workers together; RPC provider C a polite two a second until its own page's limit is read
    "rpc_a": (lambda e: (e.get("RPC_A_SOLANA_URL") or "").strip().startswith("https://") and e["RPC_A_SOLANA_URL"].strip() or None, 0.07),
    "rpc_b": (lambda e: (e.get("RPC_B_SOLANA_URL") or "").strip().startswith("https://") and e["RPC_B_SOLANA_URL"].strip() or None, 0.1),
    "rpc_c": (lambda e: (e.get("RPC_C_SOLANA_URL") or "").strip().startswith("https://") and e["RPC_C_SOLANA_URL"].strip() or None, 0.5),
    # the operator's official keys: behind every free source except the two reads FIRST_FOR names, each under its cap
    "alchemy_official": (lambda e: e.get("ALCHEMY_OFFICIAL_KEY") and "https://solana-mainnet.g.alchemy.com/v2/" + e["ALCHEMY_OFFICIAL_KEY"], 0.025),
    "helius_official": (lambda e: e.get("HELIUS_OFFICIAL_KEY") and "https://mainnet.helius-rpc.com/?api-key=" + e["HELIUS_OFFICIAL_KEY"], 0.01),
}
DEFAULT_ORDER = ["public", "shyft", "alchemy", "helius"]     # free sources only; the official keys are never a default; publicnode when listed
COUNT_NAMES = {"publicnode": "publicnode-solana", "drpc": "drpc-solana", "chainstack": "chainstack"}           # the counter line a provider's reads go under when it differs from its name (PublicNode also serves Base and BNB)
FIRST_FOR = {"getTokenLargestAccounts": ["helius_official", "alchemy_official"],    # the operator's official keys first for
             "getTokenAccountsByOwner": ["helius_official", "alchemy_official"]}  # the two reads no free source on the server answers
# (before 246: a provider named first for one read, whatever the order (a design decision meant Chainstack for the largest-accounts read; its
                          # free plan answered on 2026-10-14 that the read "is only available on dedicated nodes", so nothing is named until one is)
SETTINGS = os.path.join(_HERE, "..", "scanner", "settings.json")
ORDER_NOTE = [None]


def provider_order(path=None) -> list:
    """The providers to ask, in order, from "solana_providers" in scanner/settings.json. A provider left out is
    switched off. No list, or a list that cannot be used (unknown name, a name twice, empty), gives the built-in
    order of free sources: the official keys are used only when the file names them."""
    try:
        with open(path or SETTINGS) as f:
            want = json.load(f).get("solana_providers")
        if want is None:
            ORDER_NOTE[0] = None
            return list(DEFAULT_ORDER)
        if not isinstance(want, list) or not want or len(set(want)) != len(want) or any(n not in _KNOWN for n in want):
            raise ValueError("solana_providers must list each of these at most once: " + ", ".join(_KNOWN))
        ORDER_NOTE[0] = None
        return list(want)
    except Exception as e:
        ORDER_NOTE[0] = f"solana_providers not usable ({type(e).__name__}): free sources in the built-in order"
        return list(DEFAULT_ORDER)


def solana_workers(path=None) -> int:
    """How many scoring workers share these providers ("solana_workers" in the settings; 2 if not given or not usable)."""
    try:
        with open(path or SETTINGS) as f:
            n = json.load(f).get("solana_workers")
        return n if isinstance(n, int) and not isinstance(n, bool) and 1 <= n <= 16 else 2
    except Exception:
        return 2


def build_endpoints(order, env) -> list:
    """(name, address, gap) for each listed provider that has an address. The gap is the provider's own: seconds
    between requests from all workers together (see _KNOWN). It does not depend on the number of workers."""
    out = []
    for name in order:
        make, pace = _KNOWN[name]
        url = make(env)
        if url:
            out.append((name, url, pace))
    return out


ENDPOINTS = build_endpoints(provider_order(), _ENV)
if ORDER_NOTE[0]:                                    # loud: a worker's error output goes to the scanner's log
    import sys as _sys
    print("WARNING scanner/settings.json: " + ORDER_NOTE[0], file=_sys.stderr, flush=True)

WORKERS = 8                        # parallel requests (measured 8x faster, same data)

# ------------------------------------------------------------------ pacing: one clock per provider, shared by all workers
# Each provider has one clock, kept in a small file every scoring worker on this machine uses (the same way the
# Pump.fun reader shares its budget). A request reserves the provider's next free turn and waits for it, so all
# workers together ask a provider once per gap, evenly spaced, however many workers there are and whichever of them
# is busy. A request to one provider never delays a request to another. When a provider answers "too many requests",
# its clock is pushed on by a few gaps for everyone, so the workers ease off together instead of one at a time.
# Pacing can never stop a read: if the file cannot be used, the worker paces itself with its own share of the gap
# (the gap times the number of workers), which is how every worker paced before.
PACE_DB = os.path.join(_HERE, "..", "index", "solana_pace.sqlite")
BACKOFF_GAPS = 3                   # after a "too many requests": gaps added to the provider's clock, for every worker
PUSH_MAX = 10.0                    # refusals never move a provider's clock further ahead of now than this
FAR_AHEAD = 60.0                   # a saved turn further ahead than this is not believed (a changed clock, a damaged file)
FILE_WAIT = 1.0                    # seconds to wait for the shared file if another program holds it
FILE_REST = 30.0                   # after the shared file could not be used: seconds this worker leaves it alone
_shared_off_until = [0.0]
_SHARE = [None]                    # this worker's share of the gap for the fall-back: the number of workers, read once
_own = {}                          # the fall-back clocks: provider -> this worker's next free turn
_lock = threading.Lock()
PACE_NOTE = [None]


def _shared_turn(name, gap, push):
    """Reserve the provider's next turn in the shared file and return the seconds to wait for it. With push > 0 nothing
    is reserved: the provider's clock is moved on by `push` seconds from where it stands (from now, if it stands in the
    past), so the ease-off also bites when requests are already waiting, which is when a provider refuses. Refusals
    never move the clock more than PUSH_MAX ahead of now."""
    import sqlite3
    c = sqlite3.connect(PACE_DB, timeout=FILE_WAIT)
    _wal_once(c, PACE_DB)
    try:
        c.execute("PRAGMA synchronous=OFF")
        c.execute("CREATE TABLE IF NOT EXISTS pace (provider TEXT PRIMARY KEY, next REAL)")
        c.execute("BEGIN IMMEDIATE")
        row = c.execute("SELECT next FROM pace WHERE provider=?", (name,)).fetchone()
        now = time.time()
        nxt = row[0] if row and isinstance(row[0], (int, float)) else 0.0
        if nxt > now + FAR_AHEAD:
            nxt = now
        if push > 0:
            c.execute("INSERT OR REPLACE INTO pace VALUES (?,?)", (name, max(nxt, min(max(nxt, now) + push, now + PUSH_MAX))))
            c.commit()
            return 0.0
        turn = max(now, nxt)
        c.execute("INSERT OR REPLACE INTO pace VALUES (?,?)", (name, turn + gap))
        c.commit()
        return turn - now
    finally:
        c.close()


def _turn(name, gap, push=0.0) -> float:
    """Seconds this request must wait before asking `name` (0 = ask now). Never raises."""
    if time.time() >= _shared_off_until[0]:
        try:
            wait = _shared_turn(name, gap, push)
            PACE_NOTE[0] = None
            return wait
        except Exception as e:
            _shared_off_until[0] = time.time() + FILE_REST   # do not pay the wait for the file on every request
            if PACE_NOTE[0] is None:                 # loud, once per spell: a worker's error output goes to the scanner's log
                import sys
                print(f"WARNING shared pacing file not usable ({type(e).__name__}): this worker paces itself", file=sys.stderr, flush=True)
            PACE_NOTE[0] = f"shared pacing file not usable ({type(e).__name__}): this worker paces itself"
    try:                                             # fall back: this worker's own clock, at its share of the gap
        if _SHARE[0] is None:
            _SHARE[0] = solana_workers()
        with _lock:
            now = time.time()
            nxt = _own.get(name, 0.0)
            if push > 0:
                _own[name] = max(nxt, min(max(nxt, now) + push, now + PUSH_MAX))
                return 0.0
            turn = max(now, nxt)
            _own[name] = turn + gap * _SHARE[0]
            return turn - now
    except Exception:
        return 0.0


_dead = set()          # providers set aside: for a rest (a refusal, a 401/403) or for the month ("max usage" words); see _set_aside
_ASIDE_UNTIL = {}      # provider -> when it may be asked again (inf = the month is out: for the worker's life)
_NS_UNTIL = {}         # (provider, method) -> when that kind of read may be asked of it again
PROVIDER_REST = 600.0  # the built-in rest; the setting "solana_provider_rest_seconds" overrides it


def provider_rest(path=None) -> float:
    """Seconds a provider set aside for a refusal rests before it is asked again: "solana_provider_rest_seconds" in
    scanner/settings.json (10 to 86400); the built-in rest when not given or not usable."""
    try:
        with open(path or SETTINGS) as f:
            g = json.load(f).get("solana_provider_rest_seconds")
        if g is None:
            return PROVIDER_REST
        return float(g) if isinstance(g, (int, float)) and not isinstance(g, bool) and 10 <= g <= 86400 else PROVIDER_REST
    except Exception:
        return PROVIDER_REST


def _set_aside(name, why, forever=False, method=None) -> None:
    """Sets a provider (or one kind of read of it) aside: for the rest, or for the worker's life when the words say the
    month is out. One line to the log each time, so a worker that lost a provider shows it."""
    import sys as _s
    until = float("inf") if forever else time.time() + provider_rest()
    if method is None:
        if name in _dead and (_ASIDE_UNTIL.get(name) == float("inf") or not forever):
            return                                       # already set aside: the first rest stands (a refusal in flight neither prints again nor moves it); only the month's words upgrade it
        _dead.add(name); _ASIDE_UNTIL[name] = until
        print(f"NOTE provider {name} set aside {'for the month' if forever else f'for {provider_rest():.0f} s'}: {str(why)[:100]}", file=_s.stderr, flush=True)
    else:
        if (name, method) in _NOT_SERVED and (_NS_UNTIL.get((name, method)) == float("inf") or not forever):
            return
        _NOT_SERVED.add((name, method)); _NS_UNTIL[(name, method)] = until
        span = "for the worker's life" if forever else f"for {provider_rest():.0f} s"
        print(f"NOTE provider {name} set aside for {method} {span}: {str(why)[:100]}", file=_s.stderr, flush=True)


# Helius bills in credits: the Developer plan carries 10,000,000 a month and, past that, goes on serving
# and bills $5 a million more instead of stopping (helius.dev/pricing, read 2026-10-15). So every answered Helius call's
# credits are added up for the month, across all workers, in the counter file, and Helius is set aside for the rest of
# the month once the cap in settings is reached: the next source takes the read, and no extra credit is ever bought
# silently. Costs from Helius's credits page (read 2026-10-15): every RPC call 1; getProgramAccounts 10;
# getTransactionsForAddress 10 per 100 transactions returned, at least 10; failed calls free.
CREDIT_COST = {"helius": {"getProgramAccounts": 10, "getTransactionsForAddress": 10,     # any other RPC call: 1 credit
                          "enhanced": 100,          # the Enhanced Transactions API (history by address, parse): 100 a call
                          "getAsset": 10,           # DAS getAsset: 10
                          "getAssetBatch": 10},     # DAS getAssetBatch: 10 a call (ASSUMED at the DAS rate; the page names getAsset only)
               # Chainstack: its free Developer plan carries 3,000,000 request units a month and
               # past that BILLS $20 per 1 M instead of stopping (chainstack.com/pricing, read 2026-10-21); a full-node call is 1
               # unit, and so is every websocket notification (the trades service keeps its own daily share of those).
               "chainstack": {}}
# the operator's official keys, each counted against its plan's included allowance so nothing past it is
# ever billed until he raises the cap. Helius's official key bills like Helius (1 credit a standard call). Alchemy bills
# compute units by method (alchemy.com/docs/reference/compute-unit-costs, Solana standard JSON-RPC, read 2026-10-24, no
# date shown); a method that page does not name is counted at 40, its highest standard Solana rate, so the cap errs low.
CREDIT_COST["helius_official"] = dict(CREDIT_COST["helius"])
CREDIT_COST["alchemy_official"] = {"getTokenLargestAccounts": 20, "getTokenAccountsByOwner": 10, "getAccountInfo": 10, "getMultipleAccounts": 20,
                                   "getSignaturesForAddress": 40, "getTransaction": 40, "getBalance": 10, "getProgramAccounts": 20,
                                   "getTokenAccountBalance": 10, "getTokenSupply": 10, "getSlot": 10, "getBlock": 40, "_default": 40}
CREDIT_CAP = 9_500_000         # the built-in cap: below the plan's 10,000,000; "helius_monthly_credit_cap" in settings overrides it
# Each counted provider's built-in monthly cap, "<name>_monthly_credit_cap" in settings overriding it. Chainstack's 1,000,000
# for the scoring reads leaves room for the trades websocket's share (60,000 a day, at most 1.86 M a month) under the 3 M.
CREDIT_CAPS = {"helius": CREDIT_CAP, "chainstack": 1_000_000,
               # the free plans' allowances (helius.dev/pricing: 1,000,000 credits; alchemy.com/pricing: 30,000,000
               # compute units; both read 2026-10-24), 95% of each like Helius's own, HALVED: the server and the worker machine both use the keys
               # and each counts its own use; "<name>_monthly_credit_cap" sets one machine's
               # the logs websocket (livews/logs.mjs) takes most of Helius's
               # month, its own daily share in bytes (scanner/settings.json trades_logs_daily_mb); each machine's reads keep
               # 150,000 (they used 7,495 together on 24 and 25 Oct), so reads and the websocket stay inside the plan's 1,000,000.
               "helius_official": 150_000, "alchemy_official": 14_250_000}
CREDIT_LOOK = 60.0             # seconds between looks at the month's total in the counter file
_credits = {}                  # (month, provider) -> credits spent in this worker and not yet saved
_credit_seen = {"at": 0.0, "month": None, "saved": {}}


def credit_cap(path=None, name="helius") -> int:
    """A counted provider's month cap: "<name>_monthly_credit_cap" in scanner/settings.json (a whole number, 0 to
    100,000,000; 0 keeps it off); its built-in cap (CREDIT_CAPS) when not given or not usable."""
    built_in = CREDIT_CAPS.get(name, CREDIT_CAP)
    try:
        with open(path or SETTINGS) as f:
            g = json.load(f).get(f"{name}_monthly_credit_cap")
        return g if isinstance(g, int) and not isinstance(g, bool) and 0 <= g <= 100_000_000 else built_in
    except Exception:
        return built_in


def _month(t=None) -> str:
    return time.strftime("%Y-%m", time.gmtime(time.time() if t is None else t))


def _spend(name, method, items=None) -> None:
    """Adds one answered call's credits to the month (only for a provider that bills in credits)."""
    cost = CREDIT_COST.get(name)
    if cost is None:
        return
    w = cost.get(method, cost.get("_default", 1))
    if method == "getTransactionsForAddress" and isinstance(items, int) and items > 100:
        w = 10 * -(-items // 100)
    with _count_lock:
        k = (_month(), name)
        _credits[k] = _credits.get(k, 0) + w


def month_credits(name) -> int:
    """The month's credits so far: what every worker saved in the counter file (looked at once a minute) plus this
    worker's unsaved ones."""
    now, m = time.time(), _month()
    if now - _credit_seen["at"] >= CREDIT_LOOK or _credit_seen["month"] != m:
        saved = {}
        try:
            import sqlite3
            c = sqlite3.connect("file:" + os.path.abspath(COUNT_DB) + "?mode=ro", uri=True, timeout=FILE_WAIT)
            try:
                saved = dict(c.execute("SELECT provider, credits FROM credits WHERE month = ?", (m,)).fetchall())
            finally:
                c.close()
        except Exception:
            saved = dict(_credit_seen["saved"]) if _credit_seen["month"] == m else {}   # no file yet, or locked: the last look stands
        _credit_seen.update(at=now, month=m, saved=saved)
    with _count_lock:
        return int(_credit_seen["saved"].get(name, 0)) + _credits.get((m, name), 0)


def _capped(name) -> bool:
    """True, and the provider set aside for the month, once its credits reached the cap."""
    if name not in CREDIT_COST or name in _dead:
        return name in _dead
    used, cap = month_credits(name), credit_cap(name=name)
    if used >= cap:
        _set_aside(name, f"monthly credit cap reached ({used:,} of {cap:,} credits)", forever=True)
        return True
    return False


def helius_closed() -> bool:
    """True when no Helius call may be made: set aside (a refusal, the month's words) or its credits at the cap. Every
    reader that calls Helius outside rpc() asks this first: one counter, one cap, every path."""
    return "helius" in _dead or _capped("helius")


def helius_spend(kind, items=None) -> None:
    """Every answered Helius call outside rpc() adds its credits here."""
    _spend("helius", kind, items)


def _revive() -> None:
    """Providers whose rest is over are asked again."""
    now = time.time()
    for n in [n for n in _dead if _ASIDE_UNTIL.get(n, float("inf")) <= now]:
        _dead.discard(n); _ASIDE_UNTIL.pop(n, None)
    for k in [k for k in _NOT_SERVED if _NS_UNTIL.get(k, float("inf")) <= now]:
        _NOT_SERVED.discard(k); _NS_UNTIL.pop(k, None)
_NOT_SERVED = set()    # (provider, kind of read) a provider's plan refuses, while it serves its other reads


# A provider's own words for "this plan's allowance is used up" (Helius: "max usage reached"; Alchemy: "Monthly
# capacity limit exceeded"). That is not a busy moment that passes in seconds: asking again, or waiting and asking
# again, cannot succeed, so the provider is set aside for the rest of this worker's life and the next source is asked
# for the same read. An ordinary "too many requests" is NOT this, and is still retried patiently as before.
_USED_UP = ("max usage", "monthly capacity", "not available on free plan")   # the last: dRPC's answer when a chain is not on the free plan (read 2026-10-14)


def _used_up(text) -> bool:
    t = str(text).lower()
    return any(w in t for w in _USED_UP)


def _name_of(url):
    return next((n for n, u, _ in ENDPOINTS if u == url), None)


def _call(url, method, params):
    req = urllib.request.Request(url, json.dumps({"jsonrpc": "2.0", "id": 1, "method": method,
                                                  "params": params}).encode(),
                                 {"content-type": "application/json"})
    try:
        return json.load(urllib.request.urlopen(req, timeout=30))
    except urllib.error.HTTPError as e:
        body = e.read()[:300].decode(errors="ignore")    # every refusal's words are read, whatever its code: dRPC says "not available
        if _used_up(body) and _name_of(url):             # on free plan" in an HTTP 400 (its live answer, 2026-10-14), Helius in a 429
            _set_aside(_name_of(url), body, forever=True)    # allowance used up, or the plan does not serve it: stop asking this provider
        raise urllib.error.HTTPError(e.url, e.code, body or e.msg, e.headers, None)


# Operator rule (2026-10-06): fast free sources first, limited ones second, paid swappable. Simple reads go to the free
# public node first (one try; if it is busy we move on at once and give it a short rest), then Alchemy's free key, then
# Helius. Since a design decision no read needs Helius: history and parsed history come from standard calls on any node.
PUBLIC_FIRST = {"getAccountInfo", "getMultipleAccounts", "getTokenLargestAccounts", "getTokenAccountsByOwner", "getSlot",
                "getBalance", "getTokenAccountBalance", "getSignaturesForAddress", "getTransaction", "getBlock",
                "getTokenSupply"}
_rest_until = [0.0]
_WAL_SET = set()


def _wal_once(c, path):
    """Write-ahead logging on the shared pacing and counter files: five workers write them;
    readers no longer wait on a writer. Set once per process; the file keeps the mode."""
    if path not in _WAL_SET:
        try:
            c.execute("PRAGMA journal_mode=WAL")
        except Exception:
            pass
        _WAL_SET.add(path)
STATS: dict = {}


# ------------------------------------------------------------------ saved request count (per source, per day)
# How many requests each outside source answered and refused, and how many our own pacing held back, kept on disk so
# that usage is a number anyone can read (python3 scanner/scanner.py status, or `requests <day>`). Every reader counts
# here: the Solana providers, Pump.fun's coin record and trade list, DexScreener, Helius history, the EVM nodes,
# CoinGecko when it comes (schedule step 5, for PINR_Budget's usage ledger). Counted in memory and written every few
# seconds; a worker that ends between writes loses at most its last few seconds of counts. Counting never changes or
# delays a read: any trouble writing is swallowed. "sent" = answered + refused; "held" = a request our own budget or a
# rest kept from being sent at all (it never reached the source). The busiest minute is the most requests sent to one
# source in one UTC minute of the day, added up across every worker.
COUNT_DB = os.path.join(_HERE, "..", "index", "requests.sqlite")
_counts, _minutes, _count_lock, _count_saved = {}, {}, threading.Lock(), [time.time()]
_count_off_until = [0.0]           # after the count file could not be written: no further try until this time
_pruned = [None]                   # the day the minute rows were last pruned by this worker
KEEP_MINUTE_DAYS = 14              # minute rows older than this are dropped; the day totals stay for good

# A short name per outside host, so the same source counts under one name wherever it is asked from. A host nobody
# listed (a coin's own metadata address, a picture host, anything a creator chose) counts under the one name OTHER,
# never under its own name. Add a line when a new
# source is approved (manager/SOURCES.md).
OTHER = "other"
LABELS = {"frontend-api-v3.pump.fun": "pumpfun-coins", "swap-api.pump.fun": "pumpfun-trades",
          "api.dexscreener.com": "dexscreener", "api.geckoterminal.com": "geckoterminal", "api.coingecko.com": "coingecko",
          "api-v3.raydium.io": "raydium", "launch-mint-v1.raydium.io": "raydium-launchlab", "lite-api.jup.ag": "jupiter", "api.jup.ag": "jupiter",
          "api.helius.xyz": "helius-history", "mainnet.helius-rpc.com": "helius", "api.g.alchemy.com": "alchemy-prices",
          "api.shyft.to": "shyft-parse", "www.stonkfun.xyz": "stonkfun", "stonkfun.xyz": "stonkfun",
          "rpc.ankr.com": "ankr", "api.x.com": "x-api", "api.gopluslabs.io": "goplus", "rdap.org": "rdap",
          "mainnet.base.org": "base-public", "base.drpc.org": "drpc", "base.gateway.tenderly.co": "tenderly",
          "base-rpc.publicnode.com": "publicnode", "bsc-rpc.publicnode.com": "publicnode", "solana-rpc.publicnode.com": "publicnode-solana", "bsc-mainnet.nodereal.io": "nodereal",
          "base-mainnet.public.blastapi.io": "blastapi", "bsc-dataseed.bnbchain.org": "bsc-public", "bsc-dataseed1.binance.org": "bsc-public",
          "bsc-dataseed2.defibit.io": "bsc-public",
          "www.clanker.world": "clanker", "api-sdk.zora.engineering": "zora", "api.virtuals.io": "virtuals",   # CHAINS (249): Base launch lists
          "ipfs.io": "ipfs", "ipfs.filebase.io": "ipfs", "dweb.link": "ipfs", "gateway.pinata.cloud": "ipfs", "w3s.link": "ipfs", "nftstorage.link": "ipfs"}
DESCRIBE = {"shyft": "Solana RPC, Shyft free key", "public": "Solana RPC, the public node", "helius": "Solana RPC, Helius free key",
            "alchemy": "Alchemy free key: Solana, Base and BNB RPC (one allowance)", "pumpfun-coins": "Pump.fun coin record and lists",
            "pumpfun-trades": "Pump.fun per-coin trade list and first trade", "dexscreener": "DexScreener pairs (the Solana trigger)",
            "helius-history": "Helius parsed transaction history", "shyft-parse": "Shyft parsed transactions in batches (step 4)",
            "alchemy-prices": "Alchemy prices (BNB quote coins)",
            "coingecko": "CoinGecko simple price", "geckoterminal": "GeckoTerminal pools and trades", "jupiter": "Jupiter price (cross-check)",
            "stonkfun": "Stonk.fun public API", "raydium": "Raydium pools", "raydium-launchlab": "Raydium LaunchLab records (a coin's pool by mint, launches by a wallet)", "goplus": "GoPlus token security (BNB)",
            "ipfs": "IPFS gateways (coin metadata)", "websites": "the coins' own websites (read-only check)", "rdap": "domain registration dates (RDAP)",
            "ankr": "Ankr RPC", "base-public": "Base public RPC", "bsc-public": "BNB public RPC", "publicnode": "PublicNode RPC (Base, BNB)", "publicnode-solana": "PublicNode RPC (Solana; single reads the other providers refuse)", "drpc-solana": "dRPC", "chainstack": "Chainstack free", "rpc_a": "RPC provider A free trial", "rpc_b": "RPC provider B free", "rpc_c": "RPC provider C free",
            "clanker": "Clanker's own list and creator counts (Base, keyless)", "zora": "Zora's own list and creator counts (Base, keyless)",
            "virtuals": "Virtuals' own list and creator counts (Base, keyless)",
            "nodereal": "NodeReal public RPC (BNB)", "drpc": "dRPC public RPC (Base)", "tenderly": "Tenderly public gateway (Base)", "blastapi": "BlastAPI public RPC (Base)",
            OTHER: "hosts nobody listed: coins' own metadata and picture addresses, and anything else unlisted"}


def label(url: str) -> str:
    """The short source name for a URL: the known name of its host; any host nobody listed is OTHER."""
    try:
        host = url.split("/")[2].split("@")[-1].split(":")[0].lower()
    except Exception:
        return OTHER
    if host in LABELS:
        return LABELS[host]
    if host.endswith(".g.alchemy.com"):
        return "alchemy"
    return OTHER


def _count(name, answered: bool, now=None) -> None:
    """One request that was sent: answered (a usable answer, or the source's own answer such as "no such coin") or
    refused (rate-limited, an error, no answer)."""
    try:
        with _count_lock:
            t = now if now is not None else time.time()
            day, minute = time.strftime("%Y-%m-%d", time.gmtime(t)), time.strftime("%H:%M", time.gmtime(t))
            a, r, h = _counts.get((day, name), (0, 0, 0))
            _counts[(day, name)] = (a + bool(answered), r + (not answered), h)
            _minutes[(day, name, minute)] = _minutes.get((day, name, minute), 0) + 1
            due = time.time() >= _count_off_until[0] and (time.time() - _count_saved[0] >= 5 or sum(x + y for x, y, _z in _counts.values()) >= 50)
        if due:
            save_counts()
    except Exception:
        pass


def held(name, now=None) -> None:
    """One request our own pacing, budget or rest kept from being sent (it never reached the source)."""
    try:
        with _count_lock:
            t = now if now is not None else time.time()
            day = time.strftime("%Y-%m-%d", time.gmtime(t))
            a, r, h = _counts.get((day, name), (0, 0, 0))
            _counts[(day, name)] = (a, r, h + 1)
    except Exception:
        pass


count = _count                     # the name the other readers use


def save_counts() -> None:
    rows, mins, creds = [], [], []
    try:
        with _count_lock:
            rows, mins = [(d, n, a, r, h) for (d, n), (a, r, h) in _counts.items()], [(d, n, m, k) for (d, n, m), k in _minutes.items()]
            creds = [(m, n, k) for (m, n), k in _credits.items()]
            _counts.clear(); _minutes.clear(); _credits.clear()
            _count_saved[0] = time.time()
        if not rows and not creds:
            return
        import sqlite3
        c = sqlite3.connect(COUNT_DB, timeout=FILE_WAIT)
        _wal_once(c, COUNT_DB)
        try:
            c.execute("CREATE TABLE IF NOT EXISTS requests (day TEXT, provider TEXT, answered INTEGER, refused INTEGER, held INTEGER DEFAULT 0, PRIMARY KEY (day, provider))")
            if "held" not in [x[1] for x in c.execute("PRAGMA table_info(requests)")]:      # a file written by the older code
                c.execute("ALTER TABLE requests ADD COLUMN held INTEGER DEFAULT 0")
            c.execute("CREATE TABLE IF NOT EXISTS minutes (day TEXT, provider TEXT, minute TEXT, sent INTEGER, PRIMARY KEY (day, provider, minute))")
            c.executemany("INSERT INTO requests (day, provider, answered, refused, held) VALUES (?,?,?,?,?) "
                          "ON CONFLICT(day, provider) DO UPDATE SET answered = answered + excluded.answered, "
                          "refused = refused + excluded.refused, held = COALESCE(held, 0) + excluded.held", rows)
            c.executemany("INSERT INTO minutes (day, provider, minute, sent) VALUES (?,?,?,?) "
                          "ON CONFLICT(day, provider, minute) DO UPDATE SET sent = sent + excluded.sent", mins)
            c.execute("CREATE TABLE IF NOT EXISTS credits (month TEXT, provider TEXT, credits INTEGER, PRIMARY KEY (month, provider))")
            c.executemany("INSERT INTO credits (month, provider, credits) VALUES (?,?,?) "
                          "ON CONFLICT(month, provider) DO UPDATE SET credits = credits + excluded.credits", creds)
            today = rows[-1][0] if rows else time.strftime("%Y-%m-%d", time.gmtime())
            if _pruned[0] != today:
                c.execute("DELETE FROM minutes WHERE day < ?", (time.strftime("%Y-%m-%d", time.gmtime(time.time() - KEEP_MINUTE_DAYS * 86400)),))
                _pruned[0] = today
            c.commit()
        finally:
            c.close()
    except Exception:
        try:                                         # not written (file locked, no folder): keep the counts for the next
            with _count_lock:                        # try and leave the file alone for a while, so no request pays for it
                for d, n, a, r, h in rows:
                    a0, r0, h0 = _counts.get((d, n), (0, 0, 0))
                    _counts[(d, n)] = (a0 + a, r0 + r, h0 + h)
                for d, n, m, k in mins:
                    _minutes[(d, n, m)] = _minutes.get((d, n, m), 0) + k
                for m, n, k in creds:
                    _credits[(m, n)] = _credits.get((m, n), 0) + k
                _count_off_until[0] = time.time() + FILE_REST
        except Exception:
            pass


def read_counts(day=None) -> list:
    """[(provider, answered, refused)] for a day (UTC, default today), most used first; [] if nothing is saved."""
    try:
        import sqlite3
        c = sqlite3.connect("file:" + os.path.abspath(COUNT_DB) + "?mode=ro", uri=True, timeout=10)
        return c.execute("SELECT provider, answered, refused FROM requests WHERE day=? ORDER BY answered + refused DESC",
                         (day or time.strftime("%Y-%m-%d", time.gmtime()),)).fetchall()
    except Exception:
        return []


def read_day(day=None) -> list:
    """One dict per source for a day (UTC, default today), most sent first: {"source", "sent", "answered", "refused",
    "held", "peak" (most sent in one minute, or None when no minute row is kept), "peak_at" ("HH:MM" UTC, or None)}.
    [] if nothing is saved or the file cannot be read (missing stays missing)."""
    day = day or time.strftime("%Y-%m-%d", time.gmtime())
    try:
        import sqlite3
        c = sqlite3.connect("file:" + os.path.abspath(COUNT_DB) + "?mode=ro", uri=True, timeout=10)
        have_held = "held" in [x[1] for x in c.execute("PRAGMA table_info(requests)")]
        rows = c.execute(f"SELECT provider, answered, refused, {'COALESCE(held, 0)' if have_held else '0'} FROM requests WHERE day=? "
                         "ORDER BY answered + refused DESC, provider", (day,)).fetchall()
        peaks = {}
        try:
            for n, m, k in c.execute("SELECT provider, minute, sent FROM minutes WHERE day=? ORDER BY sent DESC, minute", (day,)):
                peaks.setdefault(n, (k, m))
        except Exception:
            pass
        return [{"source": n, "sent": a + r, "answered": a, "refused": r, "held": h,
                 "peak": peaks.get(n, (None, None))[0], "peak_at": peaks.get(n, (None, None))[1]} for n, a, r, h in rows]
    except Exception:
        return []


def report(day=None) -> list:
    """Plain lines for `scanner.py status` and `scanner.py requests <day>`: one per source, for PINR_Budget's ledger."""
    day = day or time.strftime("%Y-%m-%d", time.gmtime())
    rows = read_day(day)
    head = f"Requests on {day} (UTC), per source. sent = answered + refused; held = kept back by our own pacing, never sent"
    if not rows:
        return [head, "  none saved for that day" + ("" if os.path.exists(COUNT_DB) else " (no count file yet)")]
    w = max(len(r["source"]) for r in rows)
    out = [head]
    for r in rows:
        peak = f"busiest minute {r['peak']:,} at {r['peak_at']}" if r["peak"] is not None else "busiest minute not kept"
        out.append(f"  {r['source']:<{w}}  sent {r['sent']:>9,} | answered {r['answered']:>9,} | refused {r['refused']:>7,} | held {r['held']:>7,} | {peak}"
                   + (f"   ({DESCRIBE[r['source']]})" if r["source"] in DESCRIBE else ""))
    return out


_ROUTED = {}                       # (names...) -> the endpoints built for them, once


def _node_route(method):
    """the operator's node wires for this kind of read, as endpoints, or None (today's
    order). Read live from control/routing.json (on the server; a copy with no routing file, like the worker machine's, keeps its own)."""
    try:
        here = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "scanner")
        if here not in sys.path:
            sys.path.append(here)
        import routing as RT
        names = RT.node_route(RT.kind_of(method))
    except Exception:
        return None
    if not names:
        return None
    key = tuple(names)
    if key not in _ROUTED:
        _ROUTED[key] = build_endpoints([n for n in names if n in _KNOWN], _ENV)
    return list(_ROUTED[key]) or None


def _order(method):
    """The order set in the settings. Reads the free public node cannot do quickly go to it last. The providers named for a
    read go first for it, in that order, when listed."""
    out = list(ENDPOINTS) if method in PUBLIC_FIRST else [e for e in ENDPOINTS if e[0] != "public"] + [e for e in ENDPOINTS if e[0] == "public"]
    routed = _node_route(method)
    if routed:
        return routed                                         # the operator's wires, exactly in their order
    first = FIRST_FOR.get(method) or []
    first = [first] if isinstance(first, str) else list(first)
    lead = [e for n in first for e in out if e[0] == n]          # each named provider that is listed, in the named order
    return lead + [e for e in out if e not in lead]


def _alive() -> list:
    return [n for n, _, _ in ENDPOINTS if n not in _dead]


def _ask(name, url, pace, method, params, quick, tries):
    """Ask one provider. Returns (True, answer) when the read is settled (an answer, or a real error from the chain),
    or (False, reason) when this provider could not serve it and the next source should be asked."""
    err = None
    for i in range(tries if (name == "public" and not quick) else 1):   # one try per keyed provider: a refusal hands the read
                                                         # to the next source at once; only the public node as the last resort is tried again after its rest
        if name == "public" and not quick and time.time() < _rest_until[0]:
            time.sleep(max(0.0, _rest_until[0] - time.time()))   # patient: wait out the public node's rest
        wait = _turn(name, pace)                         # this provider's next turn, shared by all workers
        if wait > 0:
            time.sleep(wait)
        try:
            r = _call(url, method, params)
        except urllib.error.HTTPError as e:
            _count(COUNT_NAMES.get(name, name), False)
            if name in _dead:                            # set aside (resting, or the month is out): no retry, no waiting, next source
                return False, f"{name} set aside ({'for the month' if _ASIDE_UNTIL.get(name) == float('inf') else 'resting'})"
            if e.code == 403 and not quick and name != "public":
                _set_aside(name, f"HTTP 403 on {method}", method=method)   # this plan may not serve this kind of read: skip it for a rest,
                return False, f"{name} does not serve {method}"   # that kind only; its other reads are unaffected
            if e.code in (401, 403) and not quick:
                _set_aside(name, f"HTTP {e.code}")          # refused: set aside for a rest, not for the worker's life
                return False, f"{name} refused ({e.code})"
            err = f"{name} HTTP {e.code}"
            if e.code == 429:
                _turn(name, pace, push=BACKOFF_GAPS * pace)   # every worker eases off this provider together
            if quick:
                _rest_until[0] = time.time() + 10
                return False, err
            if name == "public":
                _rest_until[0] = time.time() + min(20, 2 ** i)   # the public node's rest: at most 20 s, the longest wait on any provider
            else:
                return False, err                            # a keyed provider that refused: the next source, no sleep
            continue
        except Exception as e:
            _count(COUNT_NAMES.get(name, name), False)
            err = f"{name} {type(e).__name__}"
            if quick or name != "public":
                return False, err
            time.sleep(min(20, 2 ** i)); continue
        if "error" in r:
            _count(COUNT_NAMES.get(name, name), False)
            msg = str(r["error"])
            if _used_up(msg) and name != "public":       # the same words inside an ordinary answer: the month is out
                _set_aside(name, msg, forever=True)
                return False, f"{name} allowance used up for the month"
            busy = "429" in msg or "rate" in msg.lower() or "Too many" in msg
            if busy:
                _turn(name, pace, push=BACKOFF_GAPS * pace)
            if quick:                                    # any refusal on the public node: try the next source
                _rest_until[0] = time.time() + (10 if busy else 0)
                return False, r["error"]
            if busy:
                err = r["error"]
                if name != "public":
                    return False, err                        # busy keyed provider: the next source, no sleep (its clock is pushed for every worker)
                time.sleep(min(20, 2 ** i)); continue
            # Any other refusal is this provider's own answer, not the chain's: the next source is asked for the
            # same read, and the read is unknown only if nobody serves it. "Method not found" also means this
            # provider does not serve this kind of read at all, so it is skipped for that kind from now on.
            low = msg.lower()
            if name != "public" and ("-32601" in msg or "method not found" in low or "personal token" in low or "indexed requests" in low):
                _set_aside(name, f"not served: {msg[:60]}", forever=True, method=method)   # this plan does not serve this kind of read (a missing method,
                                                                                  # or PublicNode's "indexed requests require a personal token", the team's N2): skipped for the worker's life, with a NOTE line
            return False, r["error"]
        STATS[name] = STATS.get(name, 0) + 1
        _count(COUNT_NAMES.get(name, name), True)
        _spend(name, method)
        return True, r["result"]
    return False, err


# ------------------------------------------------------------------ the cache inside one score (schedule step 4)
# One full score asked the same question 103 times out of 635 (one busy coin, 2026-10-12). While a score runs, every read
# that was answered is kept, so an exact repeat is served from memory and never sent again; the cache is emptied when the
# next score starts (a balance or a holder list may change between scores, never inside one). A transaction never changes,
# so answered getTransaction reads are kept across scores in this worker as well, up to CACHE_TXS_MAX. Off unless a score
# switched it on (score_cache_start), so a plain read, and the checks, behave as before. PINR_INDEX_CACHE=off in the
# environment keeps it off for a measurement. An error is never cached; an answer is handed out as a copy.
_CACHE = {"on": False, "reads": {}, "txs": {}, "served": 0}
IMMUTABLE = ("getTransaction",)
CACHE_TXS_MAX = 4000


def score_cache_start() -> None:
    _CACHE["on"] = os.environ.get("PINR_INDEX_CACHE", "on").lower() != "off"
    _CACHE["reads"].clear(); _CACHE["served"] = 0


def score_cache_stop() -> None:
    _CACHE["on"] = False
    _CACHE["reads"].clear()


def cache_served() -> int:
    """Reads served from the cache since the score started."""
    return _CACHE["served"]


def rpc(method, params, tries=3):
    """One read (see _rpc_send). While a score runs, an exact repeat of an answered read is served from the score's cache."""
    if not _CACHE["on"]:
        return _rpc_send(method, params, tries)
    try:
        key = json.dumps([method, params], sort_keys=True, default=str)
    except Exception:
        return _rpc_send(method, params, tries)
    hit = _CACHE["reads"].get(key)
    if hit is None and method in IMMUTABLE:
        hit = _CACHE["txs"].get(key)
    if hit is not None:
        _CACHE["served"] += 1
        return json.loads(hit)
    out = _rpc_send(method, params, tries)
    empty = out is None or out == [] or out == {} or (method in IMMUTABLE and not (isinstance(out, dict) and out.get("meta")))
    if not empty and not (isinstance(out, dict) and "ERROR" in out):   # an empty answer ("not here yet") is never kept (P1)
        try:
            kept = json.dumps(out)
            _CACHE["reads"][key] = kept
            if method in IMMUTABLE:
                if len(_CACHE["txs"]) >= CACHE_TXS_MAX:
                    _CACHE["txs"].pop(next(iter(_CACHE["txs"])))   # the oldest goes
                _CACHE["txs"][key] = kept
        except Exception:
            pass
    return out


def _rpc_send(method, params, tries=3):
    """One read. Providers are asked in the set order. The free public node gets one quick try while another source
    is still available (a refusal sends the read on at once and rests the node); when every other source has failed
    or is set aside, the public node is asked again patiently, so a read is given up only when nobody can serve it."""
    _revive()                                        # a provider whose rest is over is asked again
    err, patient_public = None, False
    for name, url, pace in _order(method):
        if name in _dead or (name, method) in _NOT_SERVED or _capped(name):
            continue
        quick = name == "public" and method in PUBLIC_FIRST and len(_alive()) > 1
        if quick and time.time() < _rest_until[0]:
            continue                                     # public node is resting after a refusal
        patient_public = patient_public or (name == "public" and not quick)
        done, out = _ask(name, url, pace, method, params, quick, tries)
        if done:
            return out
        err = out
    pub = next((e for e in ENDPOINTS if e[0] == "public"), None)
    if pub and not patient_public and "public" not in _dead:
        done, out = _ask(pub[0], pub[1], pub[2], method, params, False, tries)   # last resort
        if done:
            return out
        err = out
    return {"ERROR": str(err)}


def acct(a):
    return rpc("getAccountInfo", [a, {"encoding": "jsonParsed"}])


def endpoint_names():
    return [n for n, _, _ in ENDPOINTS if n not in _dead]


def history_asc(address, max_items=2000, until_ts=None):
    """Oldest-first signatures for an address (signature, slot, blockTime, err) from the chain's standard methods
    (`history_asc_free`; no provider-only API). Stops at max_items or once blockTime passes until_ts.
    Returns (items, complete) or (None, False) if unreadable."""
    return history_asc_free(address, max_items=max_items, until_ts=until_ts)


def pmap(fn, items, workers=None):
    """Run fn over items in parallel, results in the SAME order as items (identical data, just faster)."""
    items = list(items)
    if len(items) <= 1:
        return [fn(x) for x in items]
    with _cf.ThreadPoolExecutor(workers or WORKERS) as ex:
        return list(ex.map(fn, items))


def history_full(address, max_items=2000, until_ts=None, asc=True):
    """Full transactions for an address, oldest first, successful only (raw jsonParsed), from the chain's standard
    methods (`history_full_free`). Stops at max_items or once blockTime passes until_ts. Returns
    (txs, complete) or (None, False) if unreadable. Newest first is not served (no caller asks for it)."""
    return history_full_free(address, max_items=max_items, until_ts=until_ts) if asc else (None, False)


def as_enhanced(t):
    """The fields PINR reads from Helius's enhanced (parsed) format, rebuilt from the raw transaction:
    signature, slot, timestamp, feePayer, and per account the SOL change and token-balance changes
    (owner, mint, signed raw amount). Checked identical against the enhanced format before use."""
    msg, meta = t["transaction"]["message"], t["meta"]
    keys = [k["pubkey"] if isinstance(k, dict) else k for k in msg["accountKeys"]]
    keys += (meta.get("loadedAddresses") or {}).get("writable", []) + (meta.get("loadedAddresses") or {}).get("readonly", [])
    pre = {b["accountIndex"]: b for b in meta.get("preTokenBalances") or []}
    post = {b["accountIndex"]: b for b in meta.get("postTokenBalances") or []}
    acc = []
    for i, k in enumerate(keys):
        ch = []
        if i in pre or i in post:
            a, b = pre.get(i), post.get(i)
            ref = b or a
            d = int((b or {}).get("uiTokenAmount", {}).get("amount", 0)) - int((a or {}).get("uiTokenAmount", {}).get("amount", 0))
            if d:
                ch.append({"mint": ref["mint"], "userAccount": (b or {}).get("owner") or (a or {}).get("owner"),
                           "tokenAccount": k, "rawTokenAmount": {"tokenAmount": str(d), "decimals": ref["uiTokenAmount"]["decimals"]}})
        nb = meta["postBalances"][i] - meta["preBalances"][i] if i < len(meta["postBalances"]) else 0
        acc.append({"account": k, "nativeBalanceChange": nb, "tokenBalanceChanges": ch})
    sig = t["transaction"]["signatures"][0]
    return {"signature": sig, "slot": t.get("slot"), "timestamp": t.get("blockTime"), "feePayer": keys[0], "accountData": acc}


PUMP_PROGRAM = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P"
_TOKEN_PROGRAMS = {"spl-token", "spl-token-2022"}
WSOL_MINT = "So11111111111111111111111111111111111111112"


def as_parsed(t):
    """Helius's parsed-transaction fields that PINR reads, rebuilt from a standard jsonParsed transaction (free on the
    public node): everything as_enhanced gives, plus tokenTransfers (from the token-program transfer / mint / burn
    instructions, inner ones included), nativeTransfers (system-program transfers), type ("CREATE" when the Pump.fun
    program logs a Create; otherwise "UNKNOWN") and source ("PUMP_FUN" when the Pump.fun program ran)."""
    e = as_enhanced(t)
    meta, msg = t["meta"], t["transaction"]["message"]
    owner, mint_of, dec_of = {}, {}, {}
    keys = [k["pubkey"] if isinstance(k, dict) else k for k in msg["accountKeys"]]
    for b in (meta.get("preTokenBalances") or []) + (meta.get("postTokenBalances") or []):
        acct = keys[b["accountIndex"]] if b["accountIndex"] < len(keys) else None
        if acct:
            owner[acct] = b.get("owner") or owner.get(acct)
            mint_of[acct] = b["mint"]
            dec_of[b["mint"]] = b["uiTokenAmount"]["decimals"]
    inner = {g["index"]: g.get("instructions") or [] for g in meta.get("innerInstructions") or []}
    ins = []
    for k, i in enumerate(msg.get("instructions") or []):      # execution order: each instruction, then its inner ones
        ins.append(i); ins += inner.get(k, [])
    for i in ins:                                               # owners of token accounts opened and closed in this tx
        p = i.get("parsed")
        if isinstance(p, dict) and i.get("program") in _TOKEN_PROGRAMS and p.get("type", "").startswith("initializeAccount"):
            info = p.get("info") or {}
            owner.setdefault(info.get("account"), info.get("owner"))
            if info.get("mint"):
                mint_of.setdefault(info.get("account"), info["mint"])
    lam = {k: meta["preBalances"][n] for n, k in enumerate(keys) if n < len(meta["preBalances"])}
    tt, nt = [], []
    for i in ins:
        p = i.get("parsed")
        if not isinstance(p, dict):
            continue
        kind, info = p.get("type"), p.get("info") or {}
        if i.get("program") in _TOKEN_PROGRAMS:
            if kind == "closeAccount":                          # the closed account's SOL goes to the destination
                acct, dest = info.get("account"), info.get("destination")
                amt = lam.get(acct, 0)
                # Helius lists the close's SOL unless it exactly undoes an earlier move in this transaction
                # (an account opened and closed again: same SOL straight back)
                if amt and not any(x["fromUserAccount"] == dest and x["toUserAccount"] == acct and x["amount"] == amt for x in nt):
                    nt.append({"fromUserAccount": acct, "toUserAccount": dest, "amount": amt, "closed_account": True})
                lam[dest] = lam.get(dest, 0) + amt; lam[acct] = 0
                continue
            src, dst = info.get("source"), info.get("destination")
            mint = info.get("mint") or mint_of.get(src) or mint_of.get(dst)
            if kind in ("transfer", "transferChecked"):
                amt = (info.get("tokenAmount") or {}).get("amount", info.get("amount"))
                frm, to = owner.get(src) or info.get("authority"), owner.get(dst)
                tfrom, tto = src, dst
                if mint == WSOL_MINT and amt is not None:       # wrapped SOL moves real lamports
                    lam[src] = lam.get(src, 0) - int(amt); lam[dst] = lam.get(dst, 0) + int(amt)
            elif kind in ("mintTo", "mintToChecked"):
                continue                                        # Helius does not list newly minted tokens as transfers
            elif kind in ("burn", "burnChecked"):
                src = info.get("account"); mint = info.get("mint") or mint_of.get(src)
                amt = (info.get("tokenAmount") or {}).get("amount", info.get("amount"))
                frm, to, tfrom, tto = owner.get(src) or info.get("authority"), "", src, ""
            else:
                continue
            if mint is None or amt is None or mint not in dec_of:
                continue
            tt.append({"fromTokenAccount": tfrom, "toTokenAccount": tto, "fromUserAccount": frm or "", "toUserAccount": to or "",
                       "tokenAmount": int(amt) / 10 ** dec_of[mint], "mint": mint})
        elif i.get("program") == "system" and info.get("lamports"):
            if kind in ("transfer", "transferWithSeed"):
                frm, to = info.get("source"), info.get("destination")
            elif kind in ("createAccount", "createAccountWithSeed"):
                frm, to = info.get("source"), info.get("newAccount")
            else:
                continue
            amt = int(info["lamports"])
            nt.append({"fromUserAccount": frm, "toUserAccount": to, "amount": amt})
            lam[frm] = lam.get(frm, 0) - amt; lam[to] = lam.get(to, 0) + amt
    logs = meta.get("logMessages") or []
    pump = any(l.startswith(f"Program {PUMP_PROGRAM} invoke") for l in logs)
    created = pump and any(l in ("Program log: Instruction: Create", "Program log: Instruction: CreateV2") for l in logs)
    # the instructions, compact, so a reader can tell a Token-2022 withdraw-withheld (or harvest) from any
    # other way coins arrive; Helius's enhanced shape carries them as programId + accounts + data, this rebuild as the chain's
    # parsed type and its info (the mint, a minted amount), inner instructions included in execution order
    instr = []
    for i in ins:
        p = i.get("parsed")
        rec = {"programId": i.get("programId"), "program": i.get("program"), "accounts": i.get("accounts"), "data": i.get("data") if not isinstance(p, dict) else None}
        if isinstance(p, dict):
            info = p.get("info") or {}
            rec.update(type=p.get("type"), mint=info.get("mint"), amount=(info.get("tokenAmount") or {}).get("amount", info.get("amount")))
        instr.append(rec)
    e.update({"tokenTransfers": tt, "nativeTransfers": nt, "type": "CREATE" if created else "UNKNOWN",
              "source": "PUMP_FUN" if pump else "UNKNOWN", "instructions": instr})
    return e


# ------------------------------------------------------------------ free replacements for Helius-only reads
FREE_SIG_PAGES = 5                      # most signature pages (1,000 each) read to reach a first transaction for free;
                                        # busier than that = unknown (measured: 60 pages cost minutes and ~60k reads)


def helius_ok() -> bool:
    return any(n == "helius" for n, _, _ in ENDPOINTS) and "helius" not in _dead


def sigs_desc(address, limit=None, until=None, max_pages=FREE_SIG_PAGES):
    """Signatures newest first (standard getSignaturesForAddress, public node first). Stops at `limit`, at the signature
    `until` (exclusive), or at the start of history. Returns (items, reached_end) or (None, False) if unreadable."""
    out, before = [], None
    for _ in range(max_pages):
        p = {"limit": 1000}
        if before:
            p["before"] = before
        if until:
            p["until"] = until
        r = rpc("getSignaturesForAddress", [address, p])
        if not isinstance(r, list):
            return None, False
        out += r
        if limit and len(out) >= limit:
            return out[:limit], False
        if len(r) < 1000:
            return out, True
        before = r[-1]["signature"]
    return out, False


# ------------------------------------------------------------------ transactions in batches (schedule step 4)
# Shyft's transaction API returns up to 100 parsed transactions a call, each with its raw transaction when asked
# (`enable_raw`); the engine's fields are rebuilt from that raw form by the converter it already uses, so a score reads
# exactly what it read one signature at a time. The approved "Solana RPC: Shyft free key, parsed transfers" row (the team,
# 2026-10-13); tools/BUILD-OR-BUY-2026-10-13-batch-parse.md. One call a second (the API's rate as recorded by RESEARCH);
# after "too many requests" the shared clock is pushed for every worker (P2). Any signature the batch does not bring back is
# fetched one by one. The gap is the setting "solana_batch_gap_seconds" .
SHYFT_PARSE_URL = "https://api.shyft.to/sol/v1/transaction/parse_selected"
SHYFT_BATCH = 100
SHYFT_GAP = 1.0                    # the API's rate as RESEARCH recorded it: one call a second, for every worker together
SHYFT_GAP_SETTING = "solana_batch_gap_seconds"


def shyft_gap(path=None) -> float:
    """Seconds between batch calls, all workers together: "solana_batch_gap_seconds" in scanner/settings.json, read on
    every batch call so a change needs no restart. A number from 0.2 to 60. Not given, or not usable, gives the built-in
    gap (SHYFT_GAP). Never raises."""
    try:
        with open(path or SETTINGS) as f:
            g = json.load(f).get(SHYFT_GAP_SETTING)
        if g is None:
            return SHYFT_GAP
        return float(g) if isinstance(g, (int, float)) and not isinstance(g, bool) and 0.2 <= g <= 60 else SHYFT_GAP
    except Exception:
        return SHYFT_GAP
SHYFT_PARSE_NAME = "shyft-parse"   # its line in the counter, and its clock in the shared pacing file (one clock for all workers, P2)
SHYFT_PARSE = [os.environ.get("PINR_BATCH_PARSE", "on").lower() != "off"]   # the batch path; PINR_BATCH_PARSE=off for a measurement


def _shyft_batch(sigs: list, key: str) -> dict:
    """{signature: raw transaction} for the signatures Shyft brought back in one call (up to SHYFT_BATCH); {} on any
    trouble. The raw transaction must look like the chain's own jsonParsed answer (meta and transaction); anything else
    is left out, so the caller fetches it one by one."""
    gap = shyft_gap()                                      # the setting, read now
    wait = _turn(SHYFT_PARSE_NAME, gap)                    # the shared clock: every worker's batch calls together, one a gap
    if wait > 0:
        time.sleep(wait)
    body = json.dumps({"network": "mainnet-beta", "transaction_signatures": list(sigs), "enable_raw": True}).encode()
    req = urllib.request.Request(SHYFT_PARSE_URL, body, {"content-type": "application/json", "x-api-key": key, "User-Agent": "PINR"})
    try:
        r = json.load(urllib.request.urlopen(req, timeout=60))
    except urllib.error.HTTPError as e:
        _count(SHYFT_PARSE_NAME, False)
        if e.code == 429:
            _turn(SHYFT_PARSE_NAME, gap, push=BACKOFF_GAPS * gap)   # every worker eases off together, as for a provider
        return {}
    except Exception:
        _count(SHYFT_PARSE_NAME, False)
        return {}
    _count(SHYFT_PARSE_NAME, True)
    out = {}
    for item in (r.get("result") or []) if isinstance(r, dict) else []:
        raw = item.get("raw") if isinstance(item, dict) else None
        sig = (item.get("signatures") or [None])[0] if isinstance(item, dict) else None
        if isinstance(raw, dict) and isinstance(raw.get("meta"), dict) and isinstance(raw.get("transaction"), dict) and sig in sigs:
            out[sig] = raw
    return out


def _one(sig):
    return rpc("getTransaction", [sig, {"encoding": "jsonParsed", "maxSupportedTransactionVersion": 1}])


def fetch_raw(sigs) -> list:
    """The chain's own jsonParsed transaction for each signature, same order; a {"ERROR": ...} entry where one could not be
    read, so a reader that tolerates a hole sees it in place. In batches of SHYFT_BATCH through Shyft's transaction API when
    a Shyft key is set (step 4); one by one for the rest. Every one-signature read goes through rpc(), so the score's cache
    and the counter see it."""
    sigs = list(sigs)
    if not sigs:
        return []
    got = {}
    _revive()
    key = _ENV.get("SHYFT_API_KEY")
    listed = any(n == "shyft" for n, _u, _p in (_node_route("getTransaction") or ENDPOINTS))   # the batch path honours the provider list (P3)
                                                                                              # and the transactions wire (243 phase 2)
    if key and listed and SHYFT_PARSE[0] and "shyft" not in _dead:
        want = list(dict.fromkeys(sigs))
        for part in [want[i:i + SHYFT_BATCH] for i in range(0, len(want), SHYFT_BATCH)]:
            got.update(_shyft_batch(part, key))
    rest = [s for s in dict.fromkeys(sigs) if s not in got]
    if rest:
        for s, r in zip(rest, pmap(_one, rest)):
            got[s] = r
    return [got.get(s) if got.get(s) is not None else {"ERROR": "not read"} for s in sigs]


def fetch_txs(sigs, parsed=True):
    """Full transactions for these signatures, same order. Every one must come back: if any cannot be
    read, returns None (the reading is unreadable), never a shorter list. parsed=True gives the Helius-style fields."""
    if not sigs:
        return []
    raws = fetch_raw(sigs)
    if any(not isinstance(r, dict) or "ERROR" in r or r.get("meta") is None for r in raws):
        return None
    return [as_parsed(r) for r in raws] if parsed else raws


def history_asc_free(address, max_items=2000, until_ts=None):
    """Same answer as history_asc (oldest first, signature/slot/blockTime/err) from standard calls."""
    items, end = sigs_desc(address)
    if items is None or not end:
        return None, False                                   # could not reach the first transaction: unknown
    out = []
    for d in reversed(items):
        if until_ts is not None and d.get("blockTime") and d["blockTime"] > until_ts:
            return out, True
        out.append({"signature": d["signature"], "slot": d.get("slot"), "blockTime": d.get("blockTime"), "err": d.get("err")})
        if len(out) >= max_items:
            return out, False
    return out, True


def history_full_free(address, max_items=2000, until_ts=None):
    """Same answer as history_full (successful transactions, oldest first, raw jsonParsed) from standard calls."""
    sigs, done = history_asc_free(address, max_items=10 ** 9, until_ts=until_ts)
    if sigs is None:
        return None, False
    ok = [s["signature"] for s in sigs if not s.get("err")]
    txs = fetch_txs(ok[:max_items], parsed=False)
    if txs is None:
        return None, False
    return txs, done and len(ok) <= max_items
