"""a design decision, the team's order (2026-10-23): new coins from every Solana launchpad, by the cheapest open route
(facts/LAUNCHPAD-ROUTES.md). Pump.fun coins already come in through the app's pool; this adds the rest:
  - Jupiter's keyless "recent" list (every launchpad Jupiter indexes: Meteora DBC and the others), every pass;
  - Raydium's own LaunchLab list (every LaunchLab platform: Stonk.fun, letsbonk.fun and the smaller ones);
  - Bags' own launch feed.
Each new coin gets a seen feed file with only what that list itself gave; nothing is guessed. A coin is
written once (an existing file, scored or seen, is never replaced). Its own thread in the scanner; read-only lists."""
from __future__ import annotations
import calendar, json, os, sys, threading, time, traceback, urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path[:0] = [HERE, os.path.join(HERE, "..", "feed")]

PASS_S = 30
UA = {"User-Agent": "PINR-live/1.0 (read-only launch lists)", "accept": "application/json"}
JUP_RECENT = "https://lite-api.jup.ag/tokens/v2/recent"
RAYDIUM_NEW = "https://launch-mint-v1.raydium.io/get/list?sort=new&size=100"
BAGS_FEED = "https://api2.bags.fm/api/v1/token-launch/feed"
MAX_AGE_S = 86400                       # a coin older than a day is not a new launch

# Jupiter's launchpad names, in the words the feed uses. Pump.fun coins come through the app's pool; LaunchLab coins
# through Raydium's own list (it names the platform), so Jupiter is used for every other launchpad.
JUP_SKIP = {"pump.fun", "stonkfun", "letsbonk.fun", "raydium", "launchlab", "bonk.fun"}
JUP_WORDS = {"met-dbc": "Meteora DBC", "bags.fun": "Bags (Meteora DBC)", "moonshot": "Moonshot", "boop.fun": "Boop",
             "believe": "Believe (Meteora DBC)", "heaven": "Heaven", "jup-studio": "Jupiter Studio (Meteora DBC)"}


def _get(url, fetch=None):
    if fetch:
        return fetch(url)
    try:
        return json.load(urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=10))
    except Exception:
        return None


def _ts(v) -> float | None:
    if isinstance(v, (int, float)) and not isinstance(v, bool) and v > 0:
        return v / 1000 if v > 1e12 else float(v)
    if isinstance(v, str):
        try:
            return float(calendar.timegm(time.strptime(v[:19], "%Y-%m-%dT%H:%M:%S")))
        except ValueError:
            return None
    return None


def from_jupiter(rows) -> list:
    """Jupiter's recent coins outside Pump.fun and LaunchLab, as records: {mint, launchpad, name, ticker, image, launched_at, by}."""
    out = []
    for x in rows if isinstance(rows, list) else []:
        lp = x.get("launchpad") if isinstance(x, dict) else None
        if not isinstance(x, dict) or not isinstance(x.get("id"), str) or not lp or str(lp).lower() in JUP_SKIP:
            continue
        out.append({"mint": x["id"], "launchpad": JUP_WORDS.get(str(lp).lower(), f"{lp} (as Jupiter names it)"),
                    "name": x.get("name"), "ticker": x.get("symbol"), "image": x.get("icon"),
                    "launched_at": _ts(x.get("createdAt") or (x.get("firstPool") or {}).get("createdAt")), "by": "jupiter_recent"})
    return out


def from_raydium(body) -> list:
    """Raydium's own LaunchLab list (every platform), as records; the platform named as Raydium names it."""
    rows = ((body or {}).get("data") or {}).get("rows") if isinstance(body, dict) else None
    out = []
    for x in rows or []:
        if not isinstance(x, dict) or not isinstance(x.get("mint"), str):
            continue
        plat = (x.get("platformInfo") or {}).get("name") if isinstance(x.get("platformInfo"), dict) else None
        out.append({"mint": x["mint"], "launchpad": f"LaunchLab curve ({plat})" if plat else "LaunchLab curve",
                    "name": x.get("name"), "ticker": x.get("symbol"), "image": x.get("imgUrl"),
                    "launched_at": _ts(x.get("createAt") or x.get("createdAt")), "by": "raydium_list"})
    return out


def from_bags(body) -> list:
    """Bags' own launch feed, as records (Bags launches on Meteora DBC)."""
    rows = (body or {}).get("response") if isinstance(body, dict) else None
    out = []
    for x in rows or []:
        if not isinstance(x, dict) or not isinstance(x.get("tokenMint"), str):
            continue
        out.append({"mint": x["tokenMint"], "launchpad": "Bags (Meteora DBC)", "name": x.get("name"), "ticker": x.get("symbol"),
                    "image": x.get("image"), "launched_at": None, "by": "bags_feed"})
    return out


def write_new(records: list, now: float | None = None, write=None, exists=None) -> dict:
    """One seen file per new coin (an existing file is never replaced); a coin launched over a day ago is left out.
    Returns {by: written}."""
    import seen_feed as SF
    now = now or time.time()
    write = write or SF.write_seen
    exists = exists or (lambda m: SF.read_file(m) is not None)
    out = {}
    for r in records:
        if r.get("launched_at") and now - r["launched_at"] > MAX_AGE_S:
            continue
        if exists(r["mint"]):
            continue
        rec = SF.seen_record(r["mint"], r["by"], now, launchpad=r["launchpad"], name=r.get("name"), ticker=r.get("ticker"),
                             image_url=r.get("image"), launched_at=r.get("launched_at"))
        if write(rec):
            out[r["by"]] = out.get(r["by"], 0) + 1
    return out


JUP_SEARCH = "https://lite-api.jup.ag/tokens/v2/search?query="


def fill_times(records: list, fetch=None) -> None:
    """A list that gives no launch time (Bags' feed): the time from Jupiter's own record, 100 coins a call; still unknown
    stays None and the coin is not written (its age cannot be told, so it is not called a new launch)."""
    need = [r["mint"] for r in records if not r.get("launched_at")]
    for i in range(0, len(need), 100):
        rows = _get(JUP_SEARCH + ",".join(need[i:i + 100]), fetch)
        at = {x.get("id"): _ts(x.get("createdAt") or (x.get("firstPool") or {}).get("createdAt"))
              for x in rows if isinstance(x, dict)} if isinstance(rows, list) else {}
        for r in records:
            if not r.get("launched_at") and at.get(r["mint"]):
                r["launched_at"] = at[r["mint"]]


def one_pass(fetch=None, now=None, write=None, exists=None) -> dict:
    import routing as RT                                      # each launchpad's discovery on or off
    recs = ((from_jupiter(_get(JUP_RECENT, fetch)) if RT.discovery_on("jupiter_recent") else [])
            + (from_raydium(_get(RAYDIUM_NEW, fetch)) if RT.discovery_on("launchlab") else [])
            + (from_bags(_get(BAGS_FEED, fetch)) if RT.discovery_on("bags") else []))
    exists_ = exists or (lambda m: __import__("seen_feed").read_file(m) is not None)
    recs = [r for r in recs if not exists_(r["mint"])]
    fill_times(recs, fetch)
    recs = [r for r in recs if r.get("launched_at")]
    recs.sort(key=lambda r: {"raydium_list": 0, "bags_feed": 1}.get(r["by"], 2))   # the team's W1: order first, then one a coin,
    seen, uniq = set(), []                                    # so a launchpad's own list wins over Jupiter's for the same coin
    for r in recs:
        if r["mint"] not in seen:
            seen.add(r["mint"]); uniq.append(r)
    return write_new(uniq, now, write, exists)


def start(say=print) -> threading.Thread:
    def run():
        while True:
            try:
                got = one_pass()
                if got:
                    say(time.strftime("%H:%M:%S") + " discovery: " + ", ".join(f"{k} {v}" for k, v in got.items()))
            except Exception:
                traceback.print_exc()
            time.sleep(PASS_S)
    t = threading.Thread(target=run, name="discovery", daemon=True)
    t.start()
    return t
