"""a design decision, the engine's half (scanner/control.py): the control file's switches and pace on every outside request,
and the per-source record behind pinr.io/control's status. urlopen is stubbed; no network."""
import io, json, os, socket, sys, tempfile, time, urllib.error, urllib.request
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path[:0] = [HERE, os.path.join(HERE, "..", "stage2")]

calls = []
def fake_urlopen(url, *a, **k):
    target = url.full_url if isinstance(url, urllib.request.Request) else url
    calls.append(target)
    if "429" in target:
        raise urllib.error.HTTPError(target, 429, "too many", {}, None)
    if "missing" in target:
        raise urllib.error.HTTPError(target, 404, "not found", {}, None)
    if "broken" in target:
        raise urllib.error.HTTPError(target, 500, "server error", {}, None)
    if "slow" in target:
        raise urllib.error.URLError(socket.timeout("timed out"))
    return io.BytesIO(b"{}")
urllib.request.urlopen = fake_urlopen

import control as C
d = tempfile.mkdtemp()
C.CONTROL_FILE = os.path.join(d, "control.json")
C.STATS_DB = os.path.join(d, "stats.sqlite")
import solana_rpc as _SR                                     # the team's finding (2026-10-24): every count into a temporary file,
_SR.COUNT_DB = os.path.join(d, "requests.sqlite")            # never the engine's own request counter
C.REREAD_S = 0
C.install()

results = []
def case(n, title, should, fn):
    try:
        ok, text = fn()
    except Exception as e:
        import traceback; traceback.print_exc()
        ok, text = False, f"CRASH {type(e).__name__}: {e}"
    results.append(ok)
    print(f"\n{n:>2}. {title}\n    should: {should}\n    did:    {text}\n    {'PASS' if ok else 'FAIL'}")


def c1():
    json.dump({"sources": {"pumpfun-coins": {"on": False}}}, open(C.CONTROL_FILE, "w"))
    calls.clear()
    try:
        urllib.request.urlopen("https://frontend-api-v3.pump.fun/coins/M")
        refused = False
    except C.SwitchedOff:
        refused = True
    urllib.request.urlopen("https://api.dexscreener.com/x")
    os.remove(C.CONTROL_FILE)
    urllib.request.urlopen("https://frontend-api-v3.pump.fun/coins/M")
    return (refused and calls == ["https://api.dexscreener.com/x", "https://frontend-api-v3.pump.fun/coins/M"]), f"switched off: refused before sending ({refused}); another source sent; the file gone: every source on again; sent {len(calls)}"
case(1, "A source switched off in the control file is never asked", "the request never leaves the process (an error the reader treats as no answer); other sources untouched; no or unreadable file: every source on", c1)


def c2():
    json.dump({"sources": {"jupiter": {"pace_per_min": 120}}}, open(C.CONTROL_FILE, "w"))
    slept = []
    real_sleep = time.sleep
    C.time.sleep = lambda s: slept.append(round(s, 2))
    C._last_sent.clear()
    for _ in range(3):
        urllib.request.urlopen("https://lite-api.jup.ag/tokens/v2/recent")
    C.time.sleep = real_sleep
    os.remove(C.CONTROL_FILE)
    return (len(slept) == 2 and 0.4 <= slept[0] <= 0.5 and 0.9 <= slept[1] <= 1.0), f"120 a minute, three requests in the same instant: sent at +0, +{slept[0]} s, +{slept[1]} s"
case(2, "A source's pace holds it to so many requests a minute", "with pace 120 a minute, three requests at once go out half a second apart (each takes the next slot; per process)", c2)


def c3():
    for u in ("https://api.dexscreener.com/a", "https://api.dexscreener.com/b", "https://ipfs.io/ipfs/429", "https://api.geckoterminal.com/slow"):
        try:
            urllib.request.urlopen(u)
        except urllib.error.URLError:
            pass
    C.flush()
    h = C.rolling_hour()
    st = C.write_status(os.path.join(d, "status-engine.json"))
    body = json.load(open(st))
    return (h["dexscreener"]["ok"] >= 2 and h["ipfs"]["http429"] == 1 and h["geckoterminal"]["timeouts"] == 1 and h["dexscreener"]["last_ok"]
            and body["window_s"] == 3600 and "dexscreener" in body["sources"]), f"dexscreener {h['dexscreener']}; ipfs {h['ipfs']}; geckoterminal {h['geckoterminal']}; status file written"
case(3, "Each request's outcome per source, the rolling hour, and the status file", "answered, errors, 429s and timeouts counted per source and minute; the last hour summed with the last good read; written whole to status-engine.json for the control service", c3)


def c4():
    """The operator's 2026-10-24: the X check runs from its own timers; its calls must reach the map's counter."""
    import subprocess, solana_rpc
    d4 = tempfile.mkdtemp()
    stats, ctl = os.path.join(d4, "stats.sqlite"), os.path.join(d4, "control.json")
    child = (
        "import sys, urllib.request\n"
        f"sys.path[:0] = [{os.path.join(HERE, '..', 'stage3')!r}, {os.path.join(HERE, '..', 'stage2')!r}]\n"
        "class R:\n    status = 200\n    def read(self, *a): return b'{\"data\": []}'\n"
        "    def __enter__(self): return self\n    def __exit__(self, *a): return False\n"
        "urllib.request.urlopen = lambda *a, **k: R()                      # no network: the made-up answer\n"
        f"import solana_rpc; solana_rpc.COUNT_DB = {os.path.join(d4, 'requests.sqlite')!r}\n"   # the child counts into the case's own file
        "import x_api\n"
        "x_api._count_on_control()\n"
        "try:\n"
        "    urllib.request.urlopen('https://api.x.com/2/tweets/search/recent?query=x')\n"
        "    print('sent')\n"
        "except Exception as e:\n"
        "    print(type(e).__name__)\n"
        "try:\n"                                                            # the team's F1 on c48e6884: the search itself, as a run makes it
        "    x_api.search('MadeUpCoin1111111111111111111111111111pump', 10, 'not-a-token')\n"   # X's real reader, through the record and the switch
        "    print('searched')\n"
        "except x_api.Stop as e:\n"
        "    print('stop billed=' + str(e.billed))\n")                     # exits at once: under the 5-second flush
    env = {**os.environ, "PINR_CONTROL_STATS": stats, "PINR_CONTROL_FILE": ctl}
    json.dump({}, open(ctl, "w"))
    on, on_search = subprocess.run([sys.executable, "-c", child], capture_output=True, text=True, env=env, timeout=60).stdout.split()
    json.dump({"sources": {"x-api": {"on": False}}}, open(ctl, "w"))
    off, off_search = subprocess.run([sys.executable, "-c", child], capture_output=True, text=True, env=env, timeout=60).stdout.split(maxsplit=1)
    old = C.STATS_DB
    try:
        C.STATS_DB = stats
        hour = C.rolling_hour()
    finally:
        C.STATS_DB = old
    x = hour.get("x-api") or {}
    return (solana_rpc.label("https://api.x.com/2/tweets/search/recent") == "x-api" and on == "sent" and off == "SwitchedOff"
            and x.get("calls") == 2 and x.get("ok") == 2 and on_search == "searched" and off_search.strip() == "stop billed=False"), \
        (f"api.x.com named {solana_rpc.label('https://api.x.com/2/tweets/search/recent')!r}; a run that exits at once: {on}, counted {x}; "
         f"switched off on /control: {off}, nothing sent, and the search stops with {off_search.strip()!r} (nothing set against the X cap)")
case(4, "The X check's calls count on pinr.io/control", "a search from the X check's own process is counted under x-api in the rolling hour, even when the process exits within seconds; switched off on /control, it is not sent", c4)

def c5():
    """the official keys share Helius's and Alchemy's hosts; /control shows them as their own nodes, with the month against the cap."""
    import solana_rpc as S
    kept = list(S.ENDPOINTS)
    S.ENDPOINTS[:] = [("helius", "https://mainnet.helius-rpc.com/?api-key=FREEKEY", 0.1), ("helius_official", "https://mainnet.helius-rpc.com/?api-key=OFFICIALKEY", 0.01),
                      ("alchemy_official", "https://solana-mainnet.g.alchemy.com/v2/OFFICIALKEY", 0.025), ("shyft", "https://rpc.shyft.to?api_key=K", 0.1)]
    try:
        names = [C.source_of(u) for u in ("https://mainnet.helius-rpc.com/?api-key=FREEKEY", "https://mainnet.helius-rpc.com/?api-key=OFFICIALKEY",
                                          "https://solana-mainnet.g.alchemy.com/v2/OFFICIALKEY", "https://solana-mainnet.g.alchemy.com/v2/OTHER")]
        S.COUNT_DB = os.path.join(tempfile.mkdtemp(), "requests.sqlite")
        S._spend("alchemy_official", "getTokenLargestAccounts")
        cr = C.credits_now()
        body = json.load(open(C.write_status(os.path.join(d, "status5.json"))))
    finally:
        S.ENDPOINTS[:] = kept
    text = json.dumps(body)
    return (names == ["helius", "helius_official", "alchemy_official", "alchemy"] and cr["alchemy_official"]["used"] == 20
            and cr["alchemy_official"]["unit"] == "compute units" and cr["helius_official"]["cap"] == S.credit_cap(name="helius_official")
            and "shyft" not in cr and "OFFICIALKEY" not in text and "FREEKEY" not in text and "credits" in body), \
        f"named by their whole address: {names}; the status file's month: alchemy_official {cr['alchemy_official']['used']} of {cr['alchemy_official']['cap']:,} {cr['alchemy_official']['unit']}, helius_official {cr['helius_official']['used']} of {cr['helius_official']['cap']:,}; no key in the file"
case(5, "The operator's official keys as their own nodes on /control", "a request to an official key counts under its own name though the host is Helius's or Alchemy's; the status file carries each counted key's month against its cap; no key appears in it", c5)

def c6():
    before = C.rolling_hour().get("pumpfun-trades") or {"calls": 0, "ok": 0, "errors": 0}
    dx = C.rolling_hour().get("dexscreener") or {"ok": 0, "errors": 0}
    for u in ("https://swap-api.pump.fun/v1/coins/missing/first-trade", "https://swap-api.pump.fun/v1/coins/broken/first-trade",
              "https://api.dexscreener.com/moved/missing"):
        try:
            urllib.request.urlopen(u)
        except urllib.error.URLError:
            pass
    C.flush()
    h, dx2 = C.rolling_hour()["pumpfun-trades"], C.rolling_hour()["dexscreener"]
    return (h["calls"] - before["calls"] == 2 and h["ok"] - before["ok"] == 1 and h["errors"] - before["errors"] == 1
            and dx2["errors"] - dx["errors"] == 1 and dx2["ok"] == dx["ok"]), \
        (f"a 404 and a 500 from Pump.fun's trade host: {h['ok'] - before['ok']} answered, {h['errors'] - before['errors']} error; "
         f"a 404 from DexScreener (a moved endpoint): {dx2['errors'] - dx['errors']} error")
case(6, "the team 2026-10-25: a 404 is the service's answer", "Pump.fun's \"not found\" (404) counts as answered on /control, as its own reader counts it; any other refusal, and a 404 from any other source, stays an error", c6)


def c7():
    import solana_rpc as S
    saved = dict(S._ENV)
    try:
        S._ENV.update({"ALCHEMY_OFFICIAL_KEY": "made-up-official", "ALCHEMY_API_KEY": "made-up-older"})
        got = {u.split("/")[2].split(".")[0] + (" (official)" if "official" in u else " (older)"): C.source_of(u) for u in (
            "https://base-mainnet.g.alchemy.com/v2/made-up-official", "https://bnb-mainnet.g.alchemy.com/v2/made-up-official",
            "https://base-mainnet.g.alchemy.com/v2/made-up-older", "https://api.g.alchemy.com/prices/v1/made-up-older/tokens/by-symbol")}
        S._ENV.pop("ALCHEMY_OFFICIAL_KEY")
        no_key = C.source_of("https://base-mainnet.g.alchemy.com/v2/made-up-official")
    finally:
        S._ENV.clear(); S._ENV.update(saved)
    return (got["base-mainnet (official)"] == "alchemy_official" and got["bnb-mainnet (official)"] == "alchemy_official"
            and got["base-mainnet (older)"] == "alchemy" and got["api (older)"] == "alchemy-prices" and no_key == "alchemy"), \
        f"{got}; with no official key line: {no_key}"
case(7, "the official Alchemy key on Base and BNB is its own source on /control", "a Base or BNB call carrying the official key counts, and is switched, as alchemy_official; the older key's calls stay alchemy (switched off, 248) and its prices stay alchemy-prices", c7)


print(f"\n{sum(results)}/{len(results)} passed")
raise SystemExit(0 if all(results) else 1)
