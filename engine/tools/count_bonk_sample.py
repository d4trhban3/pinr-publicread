"""Count a launchpad's launches in the hour sample `sample_bonk_hour.py` saved. Distinct
pools on the named exchange whose creation time falls inside the hour between the first and the last read. A minute whose page
did not reach back to the previous read's newest pool is a gap (launches in between were never seen), so with any gap the
count is a MINIMUM and the gaps are named; a failed read is a gap too. The day figure is the hour's count times 24, said as
"at least" when the hour had gaps. Nothing is read live. Run:  python3 count_bonk_sample.py [profiles/...json] [dex id]"""
import json, sys
from datetime import datetime


def when(s):
    try:
        return datetime.fromisoformat(s.replace("Z", "+00:00")).timestamp()
    except Exception:
        return None


def count_sample(reads, dex):
    """{"pools": n, "gaps": [read_at, ...], "partial": bool, "window_hours": h, "a_day": n * 24 / h, "first", "last"} from the
    saved reads; None when fewer than two reads were answered (no window)."""
    answered = [r for r in reads if r.get("status") == 200 and isinstance(r.get("pools"), list)]
    if len(answered) < 2:
        return None
    first, last = when(answered[0]["read_at"]), when(answered[-1]["read_at"])
    gaps = [r["read_at"] for r in reads if r.get("status") != 200]
    prev_newest = None
    seen = {}
    for r in reads:
        if r.get("status") != 200:
            prev_newest = None
            continue
        times = [t for t in (when(p.get("created") or "") for p in r["pools"]) if t]
        if prev_newest is not None and times and min(times) > prev_newest:
            gaps.append(r["read_at"])                     # this page's oldest pool is newer than the last page's newest: a hole
        if times:
            prev_newest = max(times)
        for p in r["pools"]:
            t = when(p.get("created") or "")
            if p.get("dex") == dex and p.get("address") and t and first <= t <= last:
                seen[p["address"]] = t
    hours = (last - first) / 3600 if last > first else 0
    return {"pools": len(seen), "gaps": gaps, "partial": bool(gaps), "window_hours": round(hours, 3),
            "a_day": round(len(seen) * 24 / hours) if hours else None, "first": answered[0]["read_at"], "last": answered[-1]["read_at"]}


def words(c, dex):
    if c is None:
        return f"{dex}: no window (fewer than two reads answered)"
    least = "at least " if c["partial"] else ""
    return (f"{dex}: {c['pools']} pools created in the {c['window_hours']} hours between {c['first']} and {c['last']}"
            + (f", {len(c['gaps'])} gap(s) ({', '.join(c['gaps'][:6])}{'…' if len(c['gaps']) > 6 else ''}): a minimum" if c["gaps"] else ", no gaps")
            + f"; about {least}{c['a_day']} a day")


if __name__ == "__main__":
    path = sys.argv[1] if len(sys.argv) > 1 else "profiles/2026-10-17-bonkfun-hour-sample.json"
    dex = sys.argv[2] if len(sys.argv) > 2 else "letsbonk-fun"
    d = json.load(open(path))
    print(words(count_sample(d["reads"], dex), dex))
    dexes = {}
    for r in d["reads"]:
        for p in r.get("pools", []):
            dexes[p.get("dex")] = dexes.get(p.get("dex"), 0) + 1
    print("pools seen by exchange (repeats included):", dict(sorted(dexes.items(), key=lambda kv: -kv[1])))
