"""Pump.fun's refusal (403, Cloudflare's bot check since 2026-10-23) rests the reader at once: one request, no retries,
every caller answered "not read" until the rest ends; a 404 and a 429 behave as before. Offline: urlopen is stubbed."""
import io, json, os, sys, time, urllib.error, urllib.request
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import pumpfun_api as PF
import tempfile
PF.REST_FILE = os.path.join(tempfile.mkdtemp(), "pumpfun_rest.json")   # the shared rest, in a scratch folder

passed = 0
TOTAL = 10
sent = []


def stub(codes):
    """urlopen answering the given HTTP codes in turn (200 gives a small JSON body)."""
    seq = list(codes)

    def urlopen(req, timeout=None):
        sent.append(req.full_url)
        code = seq.pop(0) if seq else 200
        if code == 200:
            return io.BytesIO(json.dumps({"mint": "M"}).encode())
        raise urllib.error.HTTPError(req.full_url, code, "refused", {}, None)
    return urlopen


def reset(codes):
    sent.clear()
    PF._rest_until[0] = 0.0
    if os.path.exists(PF.REST_FILE):
        os.remove(PF.REST_FILE)
    PF._shared[0], PF._shared[1] = 0.0, 0.0
    PF._last[0] = 0.0
    urllib.request.urlopen = stub(codes)


PF._take = lambda host, max_wait=20.0, lane="": True       # the shared budget file is not touched
PF._counted = lambda url, answered: None
PF.PACE = 0.0
real_sleep = time.sleep
slept = []
time.sleep = lambda s: slept.append(s)


def case(n, title, fn):
    global passed
    ok, note = fn()
    passed += ok
    print(f"{'PASS' if ok else 'FAIL'} {n}. {title}: {note}")


def c1():
    reset([403])
    t0 = time.time()
    r = PF._get("https://frontend-api-v3.pump.fun/coins/M")
    return (r is None and len(sent) == 1 and not slept and PF.resting()
            and PF._rest_until[0] - t0 >= PF.REFUSED_REST_S - 1), f"answer {r}, requests {len(sent)}, waits {slept}, resting {PF.resting()}"


def c2():
    reset([403])
    PF._get("https://frontend-api-v3.pump.fun/coins/M")
    before = len(sent)
    r = PF._get("https://swap-api.pump.fun/v2/coins/M/candles")
    return r is None and len(sent) == before, f"while resting: answer {r}, new requests {len(sent) - before}"


def c3():
    slept.clear()
    reset([404])
    r = PF._get("https://frontend-api-v3.pump.fun/coins/M")
    return r is None and len(sent) == 1 and not PF.resting(), f"404: answer {r}, requests {len(sent)}, resting {PF.resting()}"


def c4():
    slept.clear()
    reset([429, 200])
    r = PF._get("https://frontend-api-v3.pump.fun/coins/M")
    return r == {"mint": "M"} and len(sent) == 2 and slept == [5] and not PF.resting(), f"429 then 200: answer {r}, requests {len(sent)}, waits {slept}"


def c5():
    reset([403])
    PF._get("https://frontend-api-v3.pump.fun/coins/M")
    PF._rest_until[0] = 0.0                                  # another process: its own memory knows nothing
    PF._shared[1] = 0.0
    before = len(sent)
    r = PF._get("https://swap-api.pump.fun/v2/coins/M/candles")
    return r is None and len(sent) == before and PF.resting(), f"another process after the 403: answer {r}, requests {len(sent) - before}, resting {PF.resting()} (from the shared file)"


def c6():
    reset([200, 200])
    PF._set_rest(time.time() - 1)                            # the hour has just run out
    PF._rest_until[0] = 0.0
    PF._shared[1] = 0.0
    first = PF._get("https://frontend-api-v3.pump.fun/coins/M")
    after = PF._shared_until()
    second = PF._get("https://frontend-api-v3.pump.fun/coins/M")
    return (first == {"mint": "M"} and after == 0 and second == {"mint": "M"} and len(sent) == 2), f"the probe: {first}; the rest cleared ({after}); the next caller asks as normal: {second}"


def c7():
    reset([403])
    PF._set_rest(time.time() - 1)
    PF._rest_until[0] = 0.0
    PF._shared[1] = 0.0
    t0 = time.time()
    r = PF._get("https://frontend-api-v3.pump.fun/coins/M")
    PF._shared[1] = 0.0
    blocked = PF._claim_probe()
    return (r is None and len(sent) == 1 and PF._shared_until() - t0 >= PF.REFUSED_REST_S - 1 and not blocked), f"the probe refused: one request, the next hour set; a second claim in that hour: {blocked}"


case(1, "A 403 rests the reader at once", c1)
case(2, "While resting, nothing is sent and callers get 'not read'", c2)
case(3, "A 404 is the service's own 'no such coin', no rest (as before)", c3)
case(4, "A 429 still waits and retries (as before)", c4)
case(5, "the team 2026-10-23: the rest is shared by every engine process", c5)
case(6, "After the hour, one probe; when it gets through, everyone asks again", c6)
def c8():
    reset([404])
    PF._set_rest(time.time() - 1)
    PF._rest_until[0] = 0.0
    PF._shared[1] = 0.0
    r = PF._get("https://frontend-api-v3.pump.fun/coins/M")
    PF._shared[1] = 0.0
    return r is None and PF._shared_until() == 0 and not PF.resting(), f"the probe answered 404: {r}; the rest ended ({PF._shared_until()}), resting {PF.resting()}"


case(7, "A refused probe starts the next hour; no other caller probes in it", c7)
case(8, "the team's F1: a probe answered 404 ends the rest (Pump.fun answered)", c8)
def c9():
    """DEBUG 26 Oct (/control): a coin record and a holders read that get through are counted on their map wires with the coin as the sample."""
    sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "scanner"))
    import wires as W
    W._wires.clear()
    reset([200, 200])
    PF._get("https://frontend-api-v3.pump.fun/coins-v2/M")
    PF._get("https://frontend-api-v3.pump.fun/coins/top-holders/M")
    PF._get("https://swap-api.pump.fun/v2/tokens/M/trades")        # a trade read is not either wire
    a, b = W._wires.get("s_pump|coin record|a_token|Pump.fun"), W._wires.get("s_pump|holders|a_token|Pump.fun")
    return bool(a and b and sum(a["buckets"].values()) == 1 and sum(b["buckets"].values()) == 1 and a["sample"] == {"coin": "M"} and len(W._wires) == 2), f"wires {sorted(W._wires)}"


def c10():
    """A refusal is kept with its reason on the wire it hit (the page shows NOT LIVE with it), and it counts nothing."""
    sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "scanner"))
    import wires as W
    W._wires.clear()
    reset([403])
    PF._get("https://frontend-api-v3.pump.fun/coins-v2/M")
    w = W._wires.get("s_pump|coin record|a_token|Pump.fun")
    return bool(w and "403" in w.get("error", "") and not w["buckets"] and w.get("last_at") is None), f"{w}"


case(9, "DEBUG: record and holders reads are counted on their /control wires", c9)
case(10, "DEBUG: a 403 is kept on its wire with the reason, counting nothing", c10)

time.sleep = real_sleep
print(f"{passed}/{TOTAL} passing")
sys.exit(0 if passed == TOTAL else 1)
