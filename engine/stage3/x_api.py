"""The social scan's search through the X API (a design decision; the team 2026-10-16; plan `stage3/X-API-PLAN.md`).

  python3 x_api.py run [--max-coins N]     search X for the scored Solana coins, check the quotes, file the results
  python3 x_api.py daily                   the coins scored since the last daily run, biggest 24-hour volume first,
                                           until the daily dollar cap; what the timer runs (ops/systemd/pinr-xscan.timer)
  python3 x_api.py demand                  a design decision, launch item 6: the X check on demand: the coins in demand (PINRbot's
                                           wanted list first, then the site's first page, biggest 24-hour volume first), each
                                           at most once per `x_api_rescan_hours` (the cache), until `x_demand_daily_dollar_cap`;
                                           off unless `x_demand` is "on"; what the 15-minute timer runs (ops/systemd/pinr-xdemand.timer)
  python3 x_api.py spend                   today's spend against the daily cap (UTC day); sends nothing

For each scored Solana coin it asks X's recent search (last 7 days) for posts that name the coin's own contract address,
picks the sentences that make a claim (the keyword list in `marketing/scan/KEYWORDS.md`), keeps a claim only if its exact
quote is in the post (`quote_check.py`, X's free oEmbed, unchanged), and files the comparison with the dossier through
`marketing/scan/compare.py` into `marketing/scan-output/<mint>.json` ("Social (not scored)"; never moves a score).

Money: X charges per resource returned ($0.005 a post, $0.010 a user; X's pricing page, read 2026-10-16). Before every
search the reader sets aside the most that search can cost (posts per coin x the post price; the search asks for no authors, which X bills as user reads), in one locked transaction with the cap check, and
refuses the search if today's spend plus everything set aside plus that would pass `x_api_daily_dollar_cap`. After X
answers, the reservation is settled to what X returned, in `index/requests.sqlite` (table `x_api_spend`), so the cap
holds across runs at the same time, workers and restarts. X's own spending limit in its console is
the second, outer stop.

Off unless `x_api` is "on" in `scanner/settings.json` and `X_BEARER_TOKEN` is in the engine's `.env`; a missing or
unusable setting sends nothing. a design decision, the team's F1: one cap for every X path. A hand run, the daily run and
the check on demand all stop at the smaller of `x_api_daily_dollar_cap` and the operator's small figure
`x_demand_daily_dollar_cap`, on one shared ledger; with the small figure unset (0) nothing searches at all. The token is never printed or written anywhere.
"""
from __future__ import annotations
import importlib.util, json, os, re, sqlite3, sys, tempfile, time, urllib.error, urllib.parse, urllib.request

_HERE = os.path.dirname(os.path.abspath(__file__))
ENGINE = os.path.dirname(_HERE)
REPO = os.path.dirname(os.path.dirname(ENGINE))
SETTINGS = os.path.join(ENGINE, "scanner", "settings.json")
FEED_DIR = os.path.join(ENGINE, "frontend-feed")
OUT_DIR = os.path.join(REPO, "marketing", "scan-output")
COMPARE = os.path.join(REPO, "marketing", "scan", "compare.py")
KEYWORDS = os.path.join(REPO, "marketing", "scan", "KEYWORDS.md")
SPEND_DB = os.path.join(ENGINE, "index", "requests.sqlite")

SEARCH = "https://api.x.com/2/tweets/search/recent"
PRICE_POST, PRICE_USER = 0.005, 0.010      # X's pay-per-use prices per resource returned (docs.x.com pricing, 2026-10-16)
WINDOW_DAYS = 7                            # recent search reaches back 7 days
COUNTER_NAME = "x-api"                     # its line in the per-source daily request counter

sys.path.insert(0, _HERE)
sys.path.insert(0, os.path.join(ENGINE, "stage2"))
import quote_check  # noqa: E402


# ------------------------------------------------------------------ settings: off unless every one is usable
def settings(path=None) -> tuple[dict | None, str]:
    """The reader's settings, or (None, why) when it must not run. Nothing is guessed: an unusable cap means no search."""
    try:
        s = json.load(open(path or SETTINGS))
    except Exception as e:
        return None, f"settings.json not usable ({type(e).__name__}): no search"
    if s.get("x_api") != "on":
        return None, "x_api is not on in settings.json: no search"
    cap, n, hours = s.get("x_api_daily_dollar_cap"), s.get("x_api_posts_per_coin"), s.get("x_api_rescan_hours")
    if isinstance(cap, bool) or not isinstance(cap, (int, float)) or not 0 < cap <= 25:
        return None, "x_api_daily_dollar_cap not usable (a dollar figure above 0 and at most 25): no search"
    small = s.get("x_demand_daily_dollar_cap")              # one small cap for every X path
    if isinstance(small, bool) or not isinstance(small, (int, float)) or not 0 < small <= 25:
        return None, "x_demand_daily_dollar_cap (the operator's small X cap, 212(h)) not set: no search on any X path"
    cap = min(cap, small)
    if isinstance(n, bool) or not isinstance(n, int) or not 10 <= n <= 100:
        return None, "x_api_posts_per_coin not usable (a whole number from 10 to 100, X's own range): no search"
    if isinstance(hours, bool) or not isinstance(hours, (int, float)) or not 1 <= hours <= 24 * WINDOW_DAYS:
        return None, "x_api_rescan_hours not usable (1 to 168): no search"
    return {"cap": float(cap), "posts": n, "rescan_hours": float(hours)}, ""


def demand_settings(path=None) -> tuple[dict | None, str]:
    """the on-demand check's own switch and its small daily cap, typed by the operator;
    the posts per coin and the cache time are the reader's own. Off, cap 0 or anything unusable: no search."""
    try:
        s = json.load(open(path or SETTINGS))
    except Exception as e:
        return None, f"settings.json not usable ({type(e).__name__}): no search"
    if s.get("x_demand") != "on":
        return None, "x_demand is not on in settings.json: no search"
    cap, n, hours = s.get("x_demand_daily_dollar_cap"), s.get("x_api_posts_per_coin"), s.get("x_api_rescan_hours")
    if isinstance(cap, bool) or not isinstance(cap, (int, float)) or not 0 < cap <= 25:
        return None, "x_demand_daily_dollar_cap not usable: no search"
    other = s.get("x_api_daily_dollar_cap")                # one cap for every X path: never above the reader's own either
    if isinstance(other, (int, float)) and not isinstance(other, bool) and 0 < other < cap:
        cap = other
    if isinstance(n, bool) or not isinstance(n, int) or not 10 <= n <= 100:
        return None, "x_api_posts_per_coin not usable (a whole number from 10 to 100, X's own range): no search"
    if isinstance(hours, bool) or not isinstance(hours, (int, float)) or not 1 <= hours <= 24 * WINDOW_DAYS:
        return None, "x_api_rescan_hours not usable (1 to 168): no search"
    return {"cap": float(cap), "posts": n, "rescan_hours": float(hours)}, ""


def worst_cost(posts: int) -> float:
    """The most one search can cost: every post returned. No author is asked for: X bills authors added to a search
    as user reads, so the search leaves them out."""
    return round(posts * PRICE_POST, 6)


# ------------------------------------------------------------------ the spend ledger (one row a UTC day)
# the team's C1: the worst cost is written down as "reserved" BEFORE a search is sent, in the same locked transaction
# that checks the cap, so runs at the same time can never all pass on the same figure. The lock is the one the
# request counter and the pacing clock use: SQLite's write lock on the shared file (BEGIN IMMEDIATE), held by one
# process at a time. After X answers, the reservation is settled to what X returned; a search X answered with nothing
# releases it. A reservation that is never settled (a crash) stays counted: the cap errs on the side of spending less.
def _db(path=None):
    c = sqlite3.connect(path or SPEND_DB, timeout=30, isolation_level=None)
    c.execute("CREATE TABLE IF NOT EXISTS x_api_spend (day TEXT PRIMARY KEY, dollars REAL, posts INTEGER, users INTEGER, "
              "searches INTEGER, reserved REAL)")
    if "reserved" not in [r[1] for r in c.execute("PRAGMA table_info(x_api_spend)")]:
        c.execute("ALTER TABLE x_api_spend ADD COLUMN reserved REAL")
    return c


def _day(now=None) -> str:
    return time.strftime("%Y-%m-%d", time.gmtime(now if now is not None else time.time()))


def _row(c, day):
    r = c.execute("SELECT dollars, posts, users, searches, reserved FROM x_api_spend WHERE day=?", (day,)).fetchone()
    return [x or 0 for x in (r or (0.0, 0, 0, 0, 0.0))]


def spent(day=None, path=None) -> dict:
    c = _db(path)
    try:
        return dict(zip(("dollars", "posts", "users", "searches", "reserved"), _row(c, day or _day())))
    finally:
        c.close()


def reserve(cap: float, posts: int, day=None, path=None) -> tuple[bool, float]:
    """Set aside the most one search can cost, if it fits under today's cap with everything spent and set aside so far.
    Check and write are one locked transaction. Returns (set aside, dollars spent or set aside before this one)."""
    day, worst = day or _day(), worst_cost(posts)
    c = _db(path)
    try:
        c.execute("BEGIN IMMEDIATE")
        dollars, p, u, n, held = _row(c, day)
        if dollars + held + worst > cap + 1e-9:
            c.execute("ROLLBACK")
            return False, dollars + held
        c.execute("INSERT OR REPLACE INTO x_api_spend VALUES (?,?,?,?,?,?)", (day, dollars, p, u, n, round(held + worst, 6)))
        c.execute("COMMIT")
        return True, dollars + held
    finally:
        c.close()


def settle(posts: int, users: int, reserved_for: int, day=None, path=None, count=True, cost=None) -> float:
    """Turn a reservation into what X really returned, priced at X's figures (or into `cost` when what X returned is
    not known). Returns that search's cost."""
    day = day or _day()
    cost = round(posts * PRICE_POST + users * PRICE_USER, 6) if cost is None else round(cost, 6)
    c = _db(path)
    try:
        c.execute("BEGIN IMMEDIATE")
        dollars, p, u, n, held = _row(c, day)
        c.execute("INSERT OR REPLACE INTO x_api_spend VALUES (?,?,?,?,?,?)",
                  (day, round(dollars + cost, 6), p + posts, u + users, n + bool(count), round(max(0.0, held - worst_cost(reserved_for)), 6)))
        c.execute("COMMIT")
        return cost
    finally:
        c.close()


def release(reserved_for: int, day=None, path=None) -> None:
    """A search X answered with an error returned nothing and costs nothing: its reservation is given back."""
    settle(0, 0, reserved_for, day, path, count=False)


# ------------------------------------------------------------------ the token and the request counter
def token(name: str = "X_BEARER_TOKEN") -> str:
    """One token from the engine's .env by its name (never printed): X_BEARER_TOKEN, or X_BEARER_TOKEN_BACKUP
   ."""
    path = os.path.join(ENGINE, ".env")
    if os.path.exists(path):
        for line in open(path):
            line = line.strip()
            if line.startswith(name + "="):
                return line.split("=", 1)[1].strip().strip('"').strip("'")
    return ""


FALLBACK_CODES = (401, 402)      # the backup token only when X refuses the main one for auth or credits


def _count(answered: bool) -> None:
    try:
        import solana_rpc
        solana_rpc.count(COUNTER_NAME, answered)
        solana_rpc.save_counts()
    except Exception:
        pass


# ------------------------------------------------------------------ the search
class Stop(Exception):
    """A refusal that ends the whole run (the token refused, the rate limit, X's spending limit). `billed` is False only
    when X itself answered with an HTTP error, which returns nothing and costs nothing; any other failure once the
    request has gone out (a timeout, a cut connection, a body that cannot be read) may have been billed, so it keeps
    the whole reservation."""
    def __init__(self, why, billed=False, code=None, reset_at=None):
        super().__init__(why)
        self.billed, self.code, self.reset_at = billed, code, reset_at


def _http_get(url: str, bearer: str):
    req = urllib.request.Request(url, headers={"authorization": "Bearer " + bearer, "user-agent": "PINR social scan"})
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.load(r)


def search(mint: str, n: int, bearer: str, get=None) -> dict:
    """Posts naming the coin's address, newest first, at most n. Returns {"posts": [...], "users": k, "more": bool}.
    X's current reference names the field list `post.fields` (long text `note_post`); the older name `tweet.fields`
    (`note_tweet`) is tried once if X refuses the first with HTTP 400, which returns nothing and costs nothing."""
    get = get or _http_get
    base = {"query": f'"{mint}" -is:retweet', "max_results": str(n)}       # no expansions: authors cost $0.010 each
    for fields, long in (("post.fields", "note_post"), ("tweet.fields", "note_tweet")):
        q = dict(base, **{fields: f"created_at,author_id,{long}"})
        try:
            ans = get(SEARCH + "?" + urllib.parse.urlencode(q), bearer)
        except urllib.error.HTTPError as e:
            _count(False)
            if e.code == 400 and fields == "post.fields":
                continue
            if e.code in (401, 403):
                raise Stop(f"X refused the token (HTTP {e.code})", code=e.code)
            if e.code == 429:
                reset = (e.headers or {}).get("x-rate-limit-reset") if hasattr(e, "headers") else None
                try:
                    reset_at = int(reset) if reset is not None else None
                except (TypeError, ValueError):
                    reset_at = None
                raise Stop("X's rate limit" + (f" until {time.strftime('%H:%M UTC', time.gmtime(reset_at))}" if reset_at else ""),
                           code=429, reset_at=reset_at)
            if e.code == 402:
                raise Stop("X's spending limit or credits used up (HTTP 402)", code=402)
            raise Stop(f"X answered HTTP {e.code}")
        except Exception as e:
            off = getattr(sys.modules.get("control"), "SwitchedOff", None)   # the team's F1 on c48e6884: never sent, never billed
            if off is not None and isinstance(e, off):
                raise Stop("x-api is switched off in pinr.io/control: nothing sent", billed=False)
            _count(False)
            raise Stop(f"X search failed after the request went out ({type(e).__name__}); its most possible cost is kept", billed=True)
        try:
            users = {u.get("id"): u.get("username") for u in (ans.get("includes") or {}).get("users") or []}   # none asked for
            posts = []
            for p in ans.get("data") or []:
                text = ((p.get("note_post") or p.get("note_tweet") or {}).get("text")) or p.get("text") or ""
                posts.append({"id": str(p.get("id")), "text": text, "created_at": p.get("created_at"),
                              "username": users.get(p.get("author_id"))})
            meta = ans.get("meta") or {}
        except Exception as e:
            _count(False)
            raise Stop(f"X's answer could not be read ({type(e).__name__}); its most possible cost is kept", billed=True)
        _count(True)
        return {"posts": posts, "users": len(users), "more": bool(meta.get("next_token"))}
    raise Stop("X refused both field-list names (HTTP 400)")


# ------------------------------------------------------------------ the claims picker (the keyword list)
def keywords(path=None) -> list[tuple[int, list[str]]]:
    """The claim kinds and their phrases, read from the keyword list's table each run (it is INTERN's and PINRbot's)."""
    rows = []
    for line in open(path or KEYWORDS):
        m = re.match(r"^\|\s*(\d+)\s[^|]*\|\s*([^|]+)\|", line)
        if m:
            rows.append((int(m.group(1)), [w.strip() for w in m.group(2).split(",") if w.strip()]))
    return sorted(rows, key=lambda r: (r[0] == 9, r[0]))        # a promise is the last thing a sentence is read as


def _hit(phrase: str, sentence: str) -> bool:
    pat = ("(?<!\\w)" if re.match(r"\w", phrase) else "") + re.escape(phrase.lower()) + ("(?!\\w)" if re.search(r"\w$", phrase) else "")
    return re.search(pat, sentence.lower()) is not None


_MCAP = re.compile(r"(?:market ?cap|mcap)\D{0,12}\$?\s*(\d+(?:[.,]\d+)?)\s*([kmb])?\b|\$?\s*(\d+(?:[.,]\d+)?)\s*([kmb])?\s*(?:market ?cap|mcap)", re.I)


def _stated(kind: int, sentence: str) -> dict:
    """The figure a size claim states, when it states a market cap in plain digits; nothing is guessed otherwise."""
    if kind != 8:
        return {}
    m = _MCAP.search(sentence)
    if not m:
        return {}
    num, unit = (m.group(1), m.group(2)) if m.group(1) else (m.group(3), m.group(4))
    v = float(num.replace(",", ".")) * {"k": 1e3, "m": 1e6, "b": 1e9}.get((unit or "").lower(), 1)
    return {"number": v, "unit": "market cap", "text": m.group(0).strip()}


def claims_from(posts: list, kinds: list) -> list:
    """One claim for each sentence that carries a keyword: its exact words, its kind, the post's link and time."""
    out = []
    for p in posts:
        url = f"https://x.com/{p.get('username') or 'i'}/status/{p['id']}"     # x.com/i/status/<id>: X's link for a post by its number alone
        for s in re.split(r"(?<=[.!?])\s+|\n+", p.get("text") or ""):
            s = s.strip()
            kind = next((k for k, phrases in kinds if any(_hit(w, s) for w in phrases)), None)
            if s and kind:
                out.append({"post_url": url, "channel": "x", "handle": "@" + p["username"] if p.get("username") else None,
                            "posted_at": p.get("created_at"), "quote": s, "kind": kind, "stated": _stated(kind, s)})
    return out


# ------------------------------------------------------------------ which coins, and filing one
def _iso(t):
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(t))


def _when(s):
    try:
        from datetime import datetime
        return datetime.fromisoformat(str(s).replace("Z", "+00:00")).timestamp()
    except Exception:
        return None


def pick(rescan_hours: float, feed_dir=None, out_dir=None, now=None) -> list:
    """Scored Solana coins read in the last 7 days, newest first, skipping any with a scan filed in the last rescan_hours."""
    now = now if now is not None else time.time()
    feed_dir, out_dir = feed_dir or FEED_DIR, out_dir or OUT_DIR
    found = []
    for name in os.listdir(feed_dir):
        if not name.endswith(".json"):
            continue
        try:
            d = json.load(open(os.path.join(feed_dir, name)))
        except Exception:
            continue
        t = _when(d.get("as_of"))
        if d.get("chain") != "solana" or not d.get("mint") or t is None or now - t > WINDOW_DAYS * 86400:
            continue
        done = os.path.join(out_dir, d["mint"] + ".json")
        if os.path.exists(done) and now - os.path.getmtime(done) < rescan_hours * 3600:
            continue
        found.append((t, d["mint"], os.path.join(feed_dir, name), d.get("name")))
    return [f[1:] for f in sorted(found, reverse=True)]


def _compare():
    spec = importlib.util.spec_from_file_location("pinr_compare", COMPARE)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def file_coin(mint: str, name, feed_path: str, found: dict, n: int, kinds: list, out_dir=None, oembed=None, now=None) -> dict:
    """The claims file for one coin, through the quote check and compare.py, into the scan-output folder."""
    now = now if now is not None else time.time()
    posts = found["posts"]
    gaps = []
    if not posts:
        gaps.append("no post naming the coin's address on X in the last 7 days")
    elif found.get("more") or len(posts) >= n:
        gaps.append(f"only the newest {len(posts)} posts naming the coin's address were read")
    claims = {"coin": mint, "name": name, "scanned_at": _iso(now), "run_id": "x-api-" + time.strftime("%Y%m%dT%H%M%SZ", time.gmtime(now)),
              "sources": {"x": {"posts_read": len(posts), "found_by": "X API recent search (posts naming the coin's address, last 7 days)",
                                "quotes_checked_by": "X's public embed service, word for word"}},
              "gaps": gaps, "checks_used": None, "claims": claims_from(posts, kinds)}
    checked = quote_check.check(claims, get=oembed)
    os.makedirs(out_dir or OUT_DIR, exist_ok=True)          # the folder is git-ignored, so a fresh copy has none
    out = os.path.join(out_dir or OUT_DIR, mint + ".json")
    with tempfile.TemporaryDirectory() as tmp:
        cp = os.path.join(tmp, "claims.json")
        json.dump(checked, open(cp, "w"), indent=1, ensure_ascii=False)
        _compare().main(cp, feed_path, out)
    return json.load(open(out))


# ------------------------------------------------------------------ the daily run
# X's recent search allows a window of requests (450 in 15 minutes, read on the first run, 2026-10-21). The daily run
# waits out the window and carries on with the same coin until the cap stops it: it waits until
# X's own reset time (`x-rate-limit-reset`) plus a few seconds, never longer than WAIT_MAX_S at a time and never more
# than WAITS_MAX times a run; past that the run stops unfinished, as any X stop. A hand run (`run`) still stops at once.
WAIT_PAD_S = 5
WAIT_MAX_S = 16 * 60
WAITS_MAX = 12


def wait_for(reset_at, now: float) -> float:
    """Seconds to wait for X's window: until its reset time plus WAIT_PAD_S; X's whole window when it gave no time;
    never more than WAIT_MAX_S, never less than WAIT_PAD_S."""
    if reset_at is None:
        return float(WAIT_MAX_S - 60)
    return float(min(WAIT_MAX_S, max(WAIT_PAD_S, reset_at - now + WAIT_PAD_S)))
# One row a daily run in the same ledger file: when it started and finished, how many coins it searched and why it
# stopped. The next run searches the coins scored since the last run that FINISHED started. A run finishes only when its
# list ran out or the daily cap stopped it; a run that crashed, or that X stopped (an error, more than was asked, both
# tokens refused), is not finished, so its coins are searched again next time. With no finished run
# yet: the last 24 hours.
def _runs(c):
    c.execute("CREATE TABLE IF NOT EXISTS x_api_runs (started REAL, finished REAL, since REAL, searched INTEGER, stopped TEXT)")
    return c


def last_run(path=None):
    """When the last finished daily run started (seconds since 1970), or None if none has finished."""
    c = _runs(_db(path))
    try:
        r = c.execute("SELECT MAX(started) FROM x_api_runs WHERE finished IS NOT NULL").fetchone()
        return r[0] if r and r[0] is not None else None
    finally:
        c.close()


def _log_run(started, since, searched=None, stopped=None, finished=None, path=None):
    c = _runs(_db(path))
    try:
        if finished is None:
            c.execute("INSERT INTO x_api_runs VALUES (?,?,?,?,?)", (started, None, since, None, None))
        else:
            c.execute("UPDATE x_api_runs SET finished=?, searched=?, stopped=? WHERE started=?", (finished, searched, stopped, started))
    finally:
        c.close()


def volume_24h(d: dict):
    """The coin's 24-hour volume in dollars from its own feed file (the `volume_24h` fact), or None when the file has
    none (missing stays missing: such a coin goes after every coin with a volume, never as a zero)."""
    for f in d.get("facts") or []:
        if isinstance(f, dict) and f.get("id") == "volume_24h":
            v = f.get("value")
            return float(v) if isinstance(v, (int, float)) and not isinstance(v, bool) and v >= 0 else None
    return None


def _quiet(mint: str) -> bool:
    """a coin with no trade for 24 hours gets no X search."""
    try:
        sys.path.insert(0, os.path.join(ENGINE, "scanner"))
        import quiet as Q
        return Q.is_quiet(mint)
    except Exception:
        return False


def gate_passed(mint: str) -> bool:
    """only a coin that passed the gate (vamps, duplicates and serial launchers read from token data first) is searched."""
    sys.path.insert(0, os.path.join(ENGINE, "scanner"))
    import gate
    return gate.passed(mint)[0]


def pick_daily(since: float, rescan_hours: float, feed_dir=None, out_dir=None, now=None, gate_ok=None) -> list:
    """Solana coins scored since `since` (their file's `as_of`), inside X's 7-day window, not seen-only and
    not scanned in the last rescan_hours; biggest 24-hour volume first, coins with no volume after them, newest first
    within a tie."""
    now = now if now is not None else time.time()
    feed_dir, out_dir = feed_dir or FEED_DIR, out_dir or OUT_DIR
    found = []
    for name in os.listdir(feed_dir):
        if not name.endswith(".json"):
            continue
        try:
            d = json.load(open(os.path.join(feed_dir, name)))
        except Exception:
            continue
        t = _when(d.get("as_of"))
        if d.get("seen") or d.get("chain") != "solana" or not d.get("mint") or t is None or t <= since or now - t > WINDOW_DAYS * 86400:
            continue
        done = os.path.join(out_dir, d["mint"] + ".json")
        if os.path.exists(done) and now - os.path.getmtime(done) < rescan_hours * 3600:
            continue
        if not (gate_ok or gate_passed)(d["mint"]) or _quiet(d["mint"]):     # no X search for a quiet coin
            continue
        v = volume_24h(d)
        found.append(((v is not None, v or 0.0, t), d["mint"], os.path.join(feed_dir, name), d.get("name")))
    return [f[1:] for f in sorted(found, key=lambda f: f[0], reverse=True)]


def pick_demand(rescan_hours: float, wanted=None, shown=None, feed_dir=None, out_dir=None, now=None, gate_ok=None) -> list:
    """the coins in demand, the same as PINRbot's (a design decision): the wanted list first, most recently
    asked first; then the site's first page, biggest 24-hour volume first. Only scored Solana coins with a feed file, not
    seen-only, and not checked in the last rescan_hours (the cache: a checked coin is not searched again until then)."""
    now = now if now is not None else time.time()
    feed_dir, out_dir = feed_dir or FEED_DIR, out_dir or OUT_DIR
    if wanted is None or shown is None:
        import pinrbot as _PB
        wanted = _PB._wanted() if wanted is None else wanted
        shown = _PB._site_shown() if shown is None else shown
    first = [m for m, _ in sorted(wanted.items(), key=lambda kv: -kv[1])]
    rest = [m for m in shown if m not in wanted]
    out, seen = [], set()
    for group, by_volume in ((first, False), (rest, True)):
        found = []
        for mint in group:
            if mint in seen:
                continue
            path = os.path.join(feed_dir, mint + ".json")
            try:
                d = json.load(open(path))
            except Exception:
                continue
            if d.get("seen") or d.get("chain") != "solana" or d.get("mint") != mint:
                continue
            done = os.path.join(out_dir, mint + ".json")
            if os.path.exists(done) and now - os.path.getmtime(done) < rescan_hours * 3600:
                continue
            if not (gate_ok or gate_passed)(mint) or _quiet(mint):
                continue
            seen.add(mint)
            v = volume_24h(d)
            found.append(((v is not None, v or 0.0), mint, path, d.get("name")))
        if by_volume:
            found.sort(key=lambda f: f[0], reverse=True)
        out += [f[1:] for f in found]
    return out


def run(max_coins=None, get=None, oembed=None, settings_path=None, spend_path=None, feed_dir=None, out_dir=None, kw_path=None,
        bearer=None, say=print, now=None, backup=None, daily=False, sleep=time.sleep, demand=False, wanted=None, shown=None) -> dict:
    """One pass over the coins, inside the cap. Returns a summary; prints one line a coin with the token's NAME (main or
    backup), never its value. the backup token is used only after X refuses the main one with 401 or
    402, then for the rest of the run; one token at a time, never both; one daily dollar cap across both."""
    s, why = demand_settings(settings_path) if demand else settings(settings_path)
    if not s:
        say(why); return {"searched": 0, "stopped": why}
    bearer = bearer if bearer is not None else token()
    backup = backup if backup is not None else token("X_BEARER_TOKEN_BACKUP")
    keys = [k for k in (("main", bearer), ("backup", backup)) if k[1]]
    if not keys or keys[0][0] != "main":
        say("X_BEARER_TOKEN is not in the engine's .env: no search"); return {"searched": 0, "stopped": "no token"}
    which = 0                                              # the token in use: keys[which]
    kinds = keywords(kw_path)
    done, stopped, waits, sample = 0, None, 0, None
    started = time.time() if now is None else now
    if daily:                                              # since the last finished run, biggest volume first
        prev = last_run(spend_path)
        since = prev if prev is not None else started - 86400
        _log_run(started, since, path=spend_path)
        coins = pick_daily(since, s["rescan_hours"], feed_dir, out_dir, now)
        say(f"daily run: {len(coins)} coins scored since {_iso(since)}, biggest 24-hour volume first")
    elif demand:                                           # the coins in demand, the wanted ones first
        coins = pick_demand(s["rescan_hours"], wanted, shown, feed_dir, out_dir, now)
        say(f"on demand: {len(coins)} coins in demand not checked in the last {s['rescan_hours']:g} hours")
    else:
        coins = pick(s["rescan_hours"], feed_dir, out_dir, now)
    for mint, feed_path, name in coins:
        if max_coins is not None and done >= max_coins:
            break
        found = None
        while found is None:
            label, key = keys[which]
            day = _day()
            fits, so_far = reserve(s["cap"], s["posts"], day=day, path=spend_path)
            if not fits:
                stopped = f"daily cap reached: ${so_far:.3f} spent or set aside of ${s['cap']:.2f}, a search may cost up to ${worst_cost(s['posts']):.2f}"
                break
            try:
                found = search(mint, s["posts"], key, get)
            except Stop as e:
                if e.billed:
                    settle(0, 0, s["posts"], day=day, path=spend_path, cost=worst_cost(s["posts"]))
                else:
                    release(s["posts"], day=day, path=spend_path)
                if e.code in FALLBACK_CODES and which + 1 < len(keys):
                    which += 1
                    say(f"the {label} token was refused (HTTP {e.code}): the {keys[which][0]} token from here on")
                    continue
                if daily and e.code == 429 and waits < WAITS_MAX:  # X's window: wait it out, then the same coin again
                    waits += 1
                    secs = wait_for(e.reset_at, time.time())
                    say(f"{e} ({label} token): waiting {secs:.0f} s for X's window, wait {waits} of {WAITS_MAX}, then carrying on")
                    sleep(secs)
                    continue
                stopped = f"{e} ({label} token)"
                break
        if found is None:
            break
        cost = settle(len(found["posts"]), found["users"], s["posts"], day=day, path=spend_path)
        res = file_coin(mint, name, feed_path, found, s["posts"], kinds, out_dir, oembed, now)
        done += 1
        first = (found["posts"] or [{}])[0].get("id")            # one real item for the wires, checkable at its source
        sample = {"mint": mint, "posts": len(found["posts"]), "post": first, "link": f"https://x.com/i/status/{first}" if first else None}
        say(f"{mint} {name or ''}: {len(found['posts'])} posts, {len(res.get('claims') or [])} claims, ${cost:.3f}, {keys[which][0]} token | {json.dumps(res.get('totals'))}")
        if found["users"]:                                # X sent authors though none were asked for: billed, counted, and the run ends
            stopped = f"X returned more than the search asked for ({found['users']} authors, ${cost:.3f} for this search)"
            break
    total = spent(path=spend_path)
    if daily:                                              # the team's F1: finished only when the list ran out or the cap stopped it;
        cap_stop = isinstance(stopped, str) and stopped.startswith("daily cap reached")   # an X error, X sending more than asked or
        if stopped is None or cap_stop:                    # both tokens refused leave the run unfinished, so its coins are tried again
            _log_run(started, None, searched=done, stopped=stopped, finished=time.time(), path=spend_path)
        else:
            say("the run did not finish: the next daily run starts from the same point (coins searched today are not searched again for "
                f"{s['rescan_hours']:g} hours)")
    say(f"searched {done} coins; today ${total['dollars']:.3f} of ${s['cap']:.2f}" + (f"; stopped: {stopped}" if stopped else ""))
    return {"searched": done, "stopped": stopped, "spent": total["dollars"], "token": keys[which][0], "sample": sample}


def meter_wires(got, W) -> None:
    """the X check's wires from one on-demand pass, each with the last coin searched as its sample (its
    address, and its first post's id and link when X returned one; the team's W2 on wires273: never a bare count)."""
    n = (got or {}).get("searched") if isinstance(got, dict) else None
    if isinstance(n, int) and n > 0:
        sample = got.get("sample")
        W.meter("g_pass|to social scan|e_x|run", n, sample and {"mint": sample["mint"]})
        W.meter("s_x|posts|e_x|posts", n, sample)
        W.meter("e_x|social evidence|e_build|social", n, sample)
    elif isinstance(got, dict) and got.get("stopped"):
        W.error("s_x|posts|e_x|posts", str(got.get("stopped"))[:120])


def _count_on_control() -> None:
    """The operator's 2026-10-24: the X check's calls count on pinr.io/control's map. Its timers run it as its own process,
    so it turns on the same per-source record (and the same switch and pace) the scanner uses."""
    try:
        sys.path.insert(0, os.path.join(ENGINE, "scanner"))
        import control
        control.install()
    except Exception:
        pass                                               # no record is never a reason not to run


if __name__ == "__main__":
    a = sys.argv[1:]
    if a[:1] in (["demand"], ["daily"], ["run"]):
        _count_on_control()
    if a[:1] == ["spend"]:
        s, why = settings()
        t = spent()
        print(f"today (UTC) ${t['dollars']:.3f} spent, {t['posts']} posts, {t['users']} users, {t['searches']} searches"
              + (f"; cap ${s['cap']:.2f}" if s else f"; {why}"))
    elif a[:1] == ["demand"]:
        sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "scanner"))
        import wires as _W
        _W.name("xcheck")                                      # the X check's wires, from its own pass
        got = run(demand=True, say=lambda line: print(time.strftime("%H:%M:%S ", time.gmtime()) + line, flush=True))
        meter_wires(got, _W)
    elif a[:1] == ["daily"]:
        run(daily=True, say=lambda line: print(time.strftime("%H:%M:%S ", time.gmtime()) + line, flush=True))   # the log shows progress as it goes
    elif a[:1] == ["run"]:
        m = int(a[a.index("--max-coins") + 1]) if "--max-coins" in a else None
        run(max_coins=m)
    else:
        print(__doc__.split("\n\n")[0])
