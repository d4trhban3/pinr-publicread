"""The hour-sample counter: made-up reads, nothing live. Run:  python3 test_count_bonk_sample.py"""
import count_bonk_sample as C

results = []
def case(n, title, should, fn):
    try:
        ok, text = fn()
    except Exception as e:
        ok, text = False, f"CRASH {type(e).__name__}: {e}"
    results.append(ok)
    print(f"\n{n:>2}. {title}\n    should: {should}\n    did:    {text}\n    {'PASS' if ok else 'FAIL'}")

def t(minute, second=0):
    return f"2026-10-17T20:{minute:02d}:{second:02d}Z"

def read(minute, pools, status=200):
    return {"read_at": t(minute), "status": status, "pools": [{"address": a, "dex": d, "created": t(m, s)} for a, d, m, s in pools]}

def t1():
    reads = [read(0, [("P1", "letsbonk", 0, 0), ("Q1", "pump-fun", 0, 0)]),
             read(1, [("P2", "letsbonk", 0, 50), ("P1", "letsbonk", 0, 0)]),          # reaches back to P1: no gap; P1 repeated
             read(2, [("P3", "letsbonk", 1, 30), ("P2", "letsbonk", 0, 50)])]
    c = C.count_sample(reads, "letsbonk")
    return c["pools"] == 3 and not c["partial"] and c["gaps"] == [] and c["window_hours"] == round(2 / 60, 3) and c["a_day"] == round(3 * 24 / (2 / 60)), f"{C.words(c, 'letsbonk')}"
case(1, "Distinct pools on the exchange inside the window, repeats once, other exchanges not counted, no gaps", "3 bonk pools in 2 minutes, no gaps, a day figure from the window", t1)

def t2():
    reads = [read(0, [("P1", "letsbonk", 0, 0)]),
             read(1, [("P2", "letsbonk", 0, 59)]),                                      # its oldest (0:59) is newer than P1 (0:00): a hole
             read(2, [], status=429),                                                   # a failed read
             read(3, [("P4", "letsbonk", 2, 30)])]
    c = C.count_sample(reads, "letsbonk")
    return c["pools"] == 3 and c["partial"] and set(c["gaps"]) == {t(1), t(2)} and "at least" in C.words(c, "letsbonk") and "minimum" in C.words(c, "letsbonk"), f"{C.words(c, 'letsbonk')}"
case(2, "A page that does not reach back, or a failed read, is a gap: the count is a minimum, said so", "two gaps named; 'at least' and 'a minimum' in the words", t2)

def t3():
    one = C.count_sample([read(0, [("P1", "letsbonk", 0, 0)])], "letsbonk")
    outside = C.count_sample([read(5, [("P0", "letsbonk", 1, 0)]), read(6, [("P9", "letsbonk", 7, 0), ("PX", "letsbonk", 5, 30)])], "letsbonk")
    return one is None and outside["pools"] == 1, f"one read: {one}; pools created before the first read or after the last: counted {outside['pools']} of 3"
case(3, "No window from one read; pools created outside the window are not counted", "None; only the pool inside the window counts", t3)

print(f"\n{sum(results)}/{len(results)} passed")
import sys; sys.exit(0 if all(results) else 1)
