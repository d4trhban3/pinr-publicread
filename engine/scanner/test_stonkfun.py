"""New Stonk.fun launches into the trigger: plain-English tests with made-up coins, a made-up Stonk.fun list,
a made-up DexScreener, a made-up GeckoTerminal, a temporary database and settings file. Every network call is blocked and counted; no live file is
touched. Run:  python3 test_stonkfun.py"""
import json, os, socket, tempfile, time, urllib.request

CALLS = []
def _blocked(*a, **k):
    CALLS.append(a[:1])
    raise OSError("network blocked in this test")
urllib.request.urlopen = _blocked
socket.create_connection = _blocked

import scanner as S
import stonkfun as F
import sys
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "stage2"))
from b58 import b58e

TMP = tempfile.mkdtemp()
S.DB = os.path.join(TMP, "scanner.sqlite")
S.SETTINGS = os.path.join(TMP, "settings.json")
S._SITE.update(at=time.time() + 10 ** 6, mints=[]); S._SHOWN.update(at=time.time() + 10 ** 6, mints=[])
NOW = float(int(time.time()) - 7200)
M1, M2, STK, OLD, PUMP, OTHER = (b58e(bytes([i]) * 32) for i in (11, 12, 13, 14, 15, 16))
POOL1, POOL2 = (b58e(bytes([i]) * 32) for i in (21, 22))

results = []
def case(n, title, should, fn):
    try:
        ok, text = fn()
    except Exception as e:
        ok, text = False, f"CRASH {type(e).__name__}: {e}"
    results.append(ok)
    print(f"\n{n:>2}. {title}\n    should: {should}\n    did:    {text}\n    {'PASS' if ok else 'FAIL'}")

def settings(**kw):
    d = {"score_chains": ["solana"], "solana_workers": 4, "solana_rescores": "paused", "solana_trigger": "on",
         "solana_trigger_volume_usd": 10000, "solana_trigger_min_buys": 10, "stonkfun_launches": "on"}
    d.update(kw)
    json.dump({k: v for k, v in d.items() if v is not None}, open(S.SETTINGS, "w"))

def fresh():
    for ext in ("", "-wal", "-shm"):
        if os.path.exists(S.DB + ext):
            os.remove(S.DB + ext)
    S._RUNNING.clear(); S._SITE_RUNNING.clear()
    S._SCORING.update(chains=None, note=None, saved=None); S._SLOTS.update(n=None, note=None)
    S._RESCORES.update(mode=None, note=None); S._TRIG.update(on=None, line=None, buys=None, note=None); S._TRIG.pop("stonk", None)
    S._STONK.update(at=0.0, seen={}, note=None); S._VERIFIED.clear()
    return S.db()

def pair(volume, buys, age_min=5):
    return {"dex": "launchlab", "created": NOW - age_min * 60, "volume_h1": volume, "buys_h1": buys}

class Read:
    def __init__(self, answers):
        self.answers, self.asked = answers, []
    def __call__(self, mints):
        self.asked.append(list(mints))
        return {m: self.answers[m] for m in mints if m in self.answers}

class Gecko:
    """Stands in for GeckoTerminal's pool figures: {pool: figures}, and which pools were asked about."""
    def __init__(self, answers):
        self.answers, self.asked = answers, []
    def __call__(self, pools):
        self.asked.append(list(pools))
        return {p: self.answers[p] for p in pools if p in self.answers}

class Stonk:
    """Stands in for Stonk.fun's ten-minute list: what it would give, and how often it was asked."""
    def __init__(self, coins):
        self.coins, self.calls = coins, 0
    def __call__(self):
        self.calls += 1
        return self.coins

def figs(volume, buys, mint=None, age_min=5):
    return {"dex": "stonkfun", "mint": mint, "created": NOW - age_min * 60, "volume_h1": volume, "buys_h1": buys}

def watch(c, pool, stonk, answers, now=NOW, gecko=None, verify=None):
    """`answers` is DexScreener's {mint: pairs}; `gecko` GeckoTerminal's {pool: figures} ; `verify` the
    on-chain platform check for a Stonk.fun pool (True by default: verified as Stonk.fun's)."""
    r = Read(answers)
    g = Gecko(gecko or {})
    said = S.watch_pumpfun(c, now=now, lists=lambda: pool, read=r, stonk_list=stonk, gecko=g, verify=verify or (lambda m, p: True))
    r.gecko = g
    return said, r

def row(c, token):
    return c.execute("SELECT triggered_at, next_due, queued_at, dropped_at, launchpad FROM tokens WHERE chain='solana' AND token=?", (token,)).fetchone()


def t1():
    answer = {"pools": [{"mint": M1, "poolId": POOL1, "launchedAt": "2026-10-17T12:00:00Z", "pending": True},
                        {"baseMint": M2, "createdMs": 1760000000000}, {"name": "no mint here"}, "junk", {"mint": M1}],
              "degraded": False, "windowMs": 600000}
    got = F.recent(get=lambda u: answer)
    bad = [F.recent(get=lambda u: {"pools": "nope"}), F.recent(get=lambda u: [1, 2]), F.recent(get=lambda u: (_ for _ in ()).throw(OSError("down")))]
    ok = (got == [(M1, 1792238400.0, POOL1), (M2, 1760000000.0, None)] and bad == [None, None, None])
    return ok, f"{len(got)} records (a no-mint record and a duplicate skipped), times {[t for _m, t, _p in got]}; unusable answers: {bad}"
case(1, "The reader takes the coin, its time and its pool from the documented shape, and nothing from junk", "two coins with their times (ISO and milliseconds) and pool; a record with no mint and a repeat skipped; a wrong shape, a list or no answer is None", t1)

def t2():
    c = fresh(); settings(stonkfun_launches="off")
    stonk = Stonk([(STK, NOW - 300)])
    said, r = watch(c, [(PUMP, NOW - 600)], stonk, {})
    return stonk.calls == 0 and "Stonk.fun" not in said and r.asked == [[PUMP]], f"Stonk.fun asked {stonk.calls} times; words: {said!r}"
case(2, "Off unless switched on", "stonkfun_launches off (or not given): Stonk.fun's list is never asked for and the pass is as before", t2)

def t3():
    c = fresh(); settings()
    stonk = Stonk([(STK, NOW - 300, POOL1)])
    said, r = watch(c, [(PUMP, NOW - 600)], stonk, {}, gecko={POOL1: figs(20000, 50, STK)})
    s, p = row(c, STK), row(c, PUMP)
    return (stonk.calls == 1 and r.asked == [[PUMP]] and r.gecko.asked == [[POOL1]] and s and s[0] and s[4] == "launchlab" and p is None
            and "1 queued of 2 looked at" in said and "1 Stonk.fun launches" in said and "1 read from GeckoTerminal" in said), \
        f"DexScreener asked about {r.asked[0]} (the Pump.fun coin only); GeckoTerminal asked about {r.gecko.asked[0]} (the Stonk.fun pool); Stonk.fun coin queued as {s[4] if s else None}; Pump coin (no answer) not queued; words: {said!r}"
case(3, "A Stonk.fun launch is judged under the same rule, read from GeckoTerminal by its pool", "the Pump.fun coin is asked of DexScreener, the Stonk.fun coin's POOL of GeckoTerminal; the Stonk.fun coin, whose figures hit, is queued with launchpad 'launchlab'; the Pump.fun coin with no answer stays unknown", t3)

def t4():
    c = fresh(); settings()
    watch(c, [(PUMP, NOW - 600)], Stonk([(STK, NOW - 300, POOL1)]), {PUMP: [pair(20000, 50, age_min=10)]}, gecko={POOL1: figs(20000, 50, STK)})
    said, _r = watch(c, [(OTHER, NOW - 100)], Stonk([]), {}, now=NOW + 60)
    s, p = row(c, STK), row(c, PUMP)
    return s[3] is None and s[1] is not None and p[3] is not None and "1 dropped" in said, f"Stonk.fun coin: dropped_at {s[3]}, still waiting {s[1] is not None}; Pump.fun coin that left the app's pool: dropped_at set {p[3] is not None}; words: {said!r}"
case(4, "A queued Stonk.fun coin is never dropped for leaving the ten-minute list", "next pass with the list empty: the Stonk.fun coin still waits; a Pump.fun coin that left the app's pool is dropped as before", t4)

def t5():
    c = fresh(); settings()
    said, r = watch(c, [(PUMP, NOW - 600)], Stonk(None), {})
    return r.asked == [[PUMP]] and "Stonk.fun's list could not be read whole" in said, f"the app's coin still looked at; words: {said!r}"
case(5, "Stonk.fun's list unreadable: the pass goes on with the app's pool and says so", "the app's coins are looked at; the words name the unread list; nothing is guessed", t5)

def t6():
    c = fresh(); settings()
    stonk = Stonk([(STK, NOW - 300, POOL1)])
    said, r = watch(c, [], stonk, {}, gecko={POOL1: figs(20000, 50, STK)})
    return r.asked == [] and r.gecko.asked == [] and "could not be read whole" in said and row(c, STK) is None, f"DexScreener asked {len(r.asked)} times, GeckoTerminal {len(r.gecko.asked)}; words: {said!r}"
case(6, "The app's pool unreadable: nothing is looked at, Stonk.fun's list or not", "whole or nothing for the app's pool holds: no coin asked about, none queued", t6)

def t7():
    fresh(); settings(stonkfun_launches="yes")
    cfg = S.trigger_settings()
    return cfg["stonk"] is False and "stonkfun_launches" in (cfg["note"] or ""), f"stonk={cfg['stonk']}; note: {cfg['note']!r}"
case(7, "An unusable setting changes nothing and is named", "'yes' is not on or off: the last good value stays (off at the start) and the note says which setting", t7)

def t8():
    c = fresh(); settings()
    said, r = watch(c, [(PUMP, NOW - 600)], Stonk([(OLD, NOW - 7200, POOL1), (STK, NOW - 300, POOL2)]), {})
    asked = r.gecko.asked[0] if r.gecko.asked else []
    return POOL1 not in asked and POOL2 in asked and STK not in (r.asked[0] if r.asked else []), f"GeckoTerminal asked about {len(asked)} pools; the two-hour-old Stonk.fun coin's pool left out: {POOL1 not in asked}"
case(8, "The first-hour rule holds for Stonk.fun coins too", "a Stonk.fun launch past its first hour is not looked at", t8)

def t9():
    c = fresh(); settings()
    stonk = Stonk([(STK, NOW - 300, POOL1)]); g = {POOL1: figs(20000, 50, STK)}
    first, r1 = watch(c, [(PUMP, NOW - 600)], stonk, {}, gecko=g)
    again, r2 = watch(c, [(PUMP, NOW - 600)], stonk, {}, now=NOW + 60, gecko=g)
    third, r3 = watch(c, [(PUMP, NOW - 600)], stonk, {}, now=NOW + 120, gecko=g)
    q = row(c, STK)
    return ("1 queued" in first and "0 queued" in again and "0 queued" in third and r2.gecko.asked == [] and r3.gecko.asked == [] and q[2] == NOW), \
        f"pass 1: {first.split(';')[0]!r}; pass 2: {again.split(';')[0]!r}, GeckoTerminal asked about its pool again: {r2.gecko.asked != []}; queued_at unchanged: {q[2] == NOW}"
case(9, "A queued Stonk.fun coin is not asked about or counted again (Q1)", "the second and third passes of its hour say 0 queued, GeckoTerminal is not asked about its pool, its row is unchanged", t9)

def t10():
    saved = json.load(open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "tools", "profiles", "2026-10-17-stonkfun-launches-recent.json")))["answer"]
    got = F.recent(get=lambda u: saved)
    keys = sorted(set(k for it in saved["pools"] for k in it))
    ok = got is not None and len(got) == len(saved["pools"]) == 6 and all(t > 1_700_000_000 and p for _m, t, p in got) and "transferTaxBps" in keys and "isRewardLaunch" in keys
    return ok, f"{len(got or [])} of {len(saved['pools'])} real launches parsed, every one with its time and pool; the real item keys include mint, pool, createdAt, isRewardLaunch, transferTaxBps (W4)"
case(10, "The real answer from Stonk.fun (saved 2026-10-17) parses whole", "six launches, each with its mint, time and pool, from the real item fields", t10)


print(f"\nnetwork calls attempted: {len(CALLS)}")
print(f"{sum(results)}/{len(results)} passed")
sys.exit(0 if all(results) and not CALLS else 1)
