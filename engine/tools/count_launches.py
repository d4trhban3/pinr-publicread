"""How many coins Stonk.fun and bonk.fun launch a day, against what the server's workers can score. Read-only;
live only on the operator's yes:

  python3 tools/count_launches.py            # the last 24 hours, keyless
  python3 tools/count_launches.py --hours 6

Sources, all approved and keyless: Stonk.fun's launch ledger (`GET /api/public/v1/launches`, newest first, paged, `since`)
for Stonk.fun; Raydium's LaunchLab list by platform account for bonk.fun and, as a cross-check, for Stonk.fun's three
accounts (the list address is a LEAD: tried once, and if Raydium does not serve it the count says "not countable
keyless" instead of guessing). The capacity figure is the server's own: `scanner.py status` says how many scores its
workers finished in the last hour; that times 24 is what they do in a day while also serving Pump.fun coins. The
arithmetic is in `summarise()`, offline; the page it writes carries every figure with its source and the time read.
Nothing is queued or scored by this tool.
"""
from __future__ import annotations
import datetime, json, os, re, subprocess, sys, time, urllib.parse, urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
ENGINE = os.path.dirname(HERE)
sys.path.insert(0, os.path.join(ENGINE, "scanner"))
sys.path.insert(0, os.path.join(ENGINE, "stage2"))

STONK_LEDGER = "https://www.stonkfun.xyz/api/public/v1/launches?pageSize=100&page=%d"
RAYDIUM_LIST = "https://launch-mint-v1.raydium.io/get/list?platformId=%s&sort=new&size=100&page=%d"     # a LEAD, tried once
PLATFORMS = {"Stonk.fun standard": "4E876qZTE9FJMrBzgVtBrSrzz2TLivB5Y5QXPjB4gZL7", "Stonk.fun reward": "6BwHHDg3u1854jC8PDLXvR4spTcLNaoBxLJNGC4nTESt",
             "Stonk.fun community": "CUqSiwPs6C4WyntMgaFazLp7wYQfaLp5URbjUP9V7SNi", "bonk.fun": "FfYek5vEz23cMkWsdJwG2oa6EphsvXSHrGpdALN4g6W1"}
PAGES_MAX = 60                                           # 6,000 records at most a source: enough for a day of any launchpad we know


def _get(url):
    req = urllib.request.Request(url, headers={"accept": "application/json", "user-agent": "PINR scanner"})
    with urllib.request.urlopen(req, timeout=15) as r:
        return json.load(r)


def _items(d):
    if isinstance(d, list):
        return d
    if isinstance(d, dict):
        for k in ("launches", "pools", "items", "data", "rows", "tokens"):
            v = d.get(k)
            if isinstance(v, list):
                return v
            if isinstance(v, dict):
                inner = _items(v)
                if inner:
                    return inner
    return []


def _when(it) -> float:
    import stonkfun
    return next((stonkfun._when(it[k]) for k in ("launchedAt", "createdAt", "createdMs", "launchTime", "createAt", "timestamp", "created_at") if k in it and stonkfun._when(it[k])), 0.0)


def count_window(pages, since: float, now: float) -> dict:
    """Count records whose time falls in [since, now] over newest-first pages; stop at the first page that is wholly
    older. Returns {"count", "per_hour": {hour: n}, "undated", "pages", "oldest", "newest"}."""
    import stonkfun
    seen, per_hour, undated, oldest, newest, used, partial = set(), {}, 0, None, None, 0, None
    for page in pages:
        used += 1
        if isinstance(page, dict) and "_error" in page:        # N1: a page refused mid-way leaves a PARTIAL count, said so
            partial = f"page {used} could not be read ({page['_error']}): the count is a minimum"
            break
        items = [it for it in _items(page) if isinstance(it, dict)]
        if not items:
            break
        older_only = True
        for it in items:
            mint = next((it[k] for k in stonkfun.MINT_KEYS if stonkfun._address(it.get(k))), None)
            t = _when(it)
            if not t:
                undated += 1
                continue
            if t > now:
                continue
            if t >= since:
                older_only = False
                if mint and mint in seen:
                    continue
                if mint:
                    seen.add(mint)
                h = time.strftime("%Y-%m-%d %H:00", time.gmtime(t))
                per_hour[h] = per_hour.get(h, 0) + 1
                oldest = t if oldest is None or t < oldest else oldest
                newest = t if newest is None or t > newest else newest
        if older_only:
            break
    return {"count": sum(per_hour.values()), "per_hour": per_hour, "undated": undated, "pages": used,
            "oldest": oldest, "newest": newest, "partial": partial}


def pages_from(url_pattern: str, get=None):
    get = get or _get
    for i in range(1, PAGES_MAX + 1):
        try:
            yield get(url_pattern % i)
        except Exception as e:
            yield {"_error": f"{type(e).__name__}"}
            return


def air_rate(status_text: str) -> dict | None:
    """From `scanner.py status`: scores finished in the last hour, and how busy the workers were at the read (N3: the
    room left is what the comparison needs, not the work already done)."""
    m = re.search(r"finished in the last hour: (\d+) first scores, (\d+) follow-ups", status_text)
    if not m:
        return None
    out = {"first": int(m.group(1)), "followups": int(m.group(2))}
    b = re.search(r"in progress: (\d+) Solana scores", status_text)
    w = re.search(r"may hold (\d+) of (\d+) scoring workers", status_text)
    if b:
        out["busy"] = int(b.group(1))
    if w:
        out["workers"] = int(w.group(1))
    return out


def summarise(counts: dict, hours: float, rate: dict | None, workers: int) -> dict:
    """The plain comparison. `counts` is {launchpad: {"primary": count_window result or {"error": words},
    "cross_checks": {source: count_window result}}}: one count a launchpad goes into the need (N2: a cross-check never
    adds coins). `rate` is the server's last hour with how busy the workers were; the need is compared with the ROOM LEFT
    (N3), never with the work already done. A partial count is a minimum (N1)."""
    per_day, minimum, cross = {}, {}, {}
    for name, c in counts.items():
        prim = c.get("primary") or {}
        per_day[name] = None if "error" in prim or not prim else round(prim["count"] * 24 / hours)
        minimum[name] = bool(prim.get("partial")) if prim and "error" not in prim else False
        cross[name] = {src: (None if "error" in r else round(r["count"] * 24 / hours)) for src, r in (c.get("cross_checks") or {}).items()}
    known = [v for v in per_day.values() if v is not None]
    need = sum(known) if known else None
    need_is_minimum = any(minimum[n] for n in per_day if per_day[n] is not None)
    peak_hour = max((max(c["primary"]["per_hour"].values()) for c in counts.values() if c.get("primary") and c["primary"].get("per_hour")), default=None)
    out = {"launches_a_day": per_day, "count_is_minimum": minimum, "cross_checks": cross, "need_a_day": need, "need_is_minimum": need_is_minimum,
           "peak_hour": peak_hour, "workers": workers}
    if rate:
        done = rate["first"] + rate["followups"]
        out["air_scores_an_hour"] = done
        out["air_scores_a_day"] = done * 24
        busy, w = rate.get("busy"), rate.get("workers") or workers
        if busy is not None and w:
            out["busy_at_read"] = f"{busy} of {w}"
            capacity = done * w / busy if busy else None            # what the workers could do if all of them were scoring all hour
            room = max(0.0, capacity - done) if capacity is not None else None
            out["room_an_hour"] = None if room is None else round(room, 1)
            out["room_a_day"] = None if room is None else round(room * 24)
            if need is not None and out["room_a_day"] is not None:
                if need > out["room_a_day"]:
                    out["carries_all"] = False                       # even a minimum past the room settles it
                elif need_is_minimum:
                    out["carries_all"] = None                        # a partial count under the room settles nothing
                else:
                    out["carries_all"] = True
    return out


def words(s: dict, hours: float) -> str:
    def n(name):
        v = s["launches_a_day"][name]
        return "not countable keyless" if v is None else (f"at least {v}" if s["count_is_minimum"].get(name) else str(v))
    lines = [f"Launches in the last {hours:g} hours, scaled to a day: " + ", ".join(f"{k} {n(k)}" for k in s["launches_a_day"])]
    for name, cc in s.get("cross_checks", {}).items():
        for src, v in cc.items():
            lines.append(f"  cross-check, {name} by {src}: {v if v is not None else 'no usable answer'} a day (not added to the need).")
    if s["need_a_day"] is not None:
        lines.append(f"Together: {'at least ' if s['need_is_minimum'] else 'about '}{s['need_a_day']} a day" + (f"; the busiest hour had {s['peak_hour']}" if s["peak_hour"] else "") + ".")
    if "air_scores_a_day" in s:
        lines.append(f"The server's {s['workers']} workers finished {s['air_scores_an_hour']} scores in the last hour ({s['air_scores_a_day']} a day at that pace), serving the Pump.fun coins the trigger queues.")
        if "room_a_day" in s and s["room_a_day"] is not None:
            lines.append(f"Room left: {s['room_an_hour']} scores an hour ({s['room_a_day']} a day): the workers were busy {s['busy_at_read']} at the read."
                         + (" No room: the workers are busy all the time, so every launchpad coin scored at launch would take the place of a Pump.fun coin or a follow-up." if s["room_a_day"] == 0 else ""))
        if "carries_all" in s:
            lines.append("They CARRY all of them at launch within the room left." if s["carries_all"] else
                         "They do NOT carry all of them at launch: the launchpads' day is more than the room left." if s["carries_all"] is False else
                         "Not settled: the count is partial and under the room left; read again.")
    return "\n".join(lines)


def main(argv):
    hours = float(argv[argv.index("--hours") + 1]) if "--hours" in argv else 24.0
    now = time.time(); since = now - hours * 3600
    counts, receipts = {"Stonk.fun": {"primary": None, "cross_checks": {}}, "bonk.fun": {"primary": None, "cross_checks": {}}}, []
    c = count_window(pages_from(STONK_LEDGER), since, now)
    counts["Stonk.fun"]["primary"] = c
    receipts.append(f"Stonk.fun `/api/public/v1/launches` (the count), {c['pages']} page(s) of 100, read {time.strftime('%Y-%m-%d %H:%M UTC', time.gmtime(now))}" + (f"; {c['partial']}" if c.get("partial") else ""))
    for name, acct in PLATFORMS.items():
        first = next(pages_from(RAYDIUM_LIST.replace("%d", "1") % acct))
        if "_error" in first or not _items(first):
            r = {"error": "Raydium's list by platform account did not answer or served no records: not countable keyless this way"}
            receipts.append(f"Raydium LaunchLab list for {name} ({acct}): no usable answer")
        else:
            r = count_window(pages_from(RAYDIUM_LIST.replace("%s", acct)), since, now)
            receipts.append(f"Raydium LaunchLab list for {name} ({acct}): {r['pages']} page(s) of 100" + (f"; {r['partial']}" if r.get("partial") else ""))
        if name == "bonk.fun":
            counts["bonk.fun"]["primary"] = r                          # bonk.fun's one count
        else:
            counts["Stonk.fun"]["cross_checks"][name + " (Raydium list)"] = r   # N2: a cross-check of the ledger, never added
    try:
        status = subprocess.run([sys.executable, os.path.join(ENGINE, "scanner", "scanner.py"), "status"], capture_output=True, text=True, timeout=60).stdout
    except Exception:
        status = ""
    rate = air_rate(status)
    try:
        workers = int(json.load(open(os.path.join(ENGINE, "scanner", "settings.json"))).get("scanner_workers", 0))
    except Exception:
        workers = 0
    s = summarise(counts, hours, rate, workers)
    text = words(s, hours)
    when = time.strftime("%Y-%m-%d", time.gmtime(now))
    out = os.path.join(ENGINE, "facts", f"launches-a-day-{when}.md")
    with open(out, "w") as f:
        f.write(f"# Launches a day: Stonk.fun and bonk.fun against the server's workers\n\nRead-only, keyless, on the operator's yes.\n\n{text}\n\n## Figures\n```\n{json.dumps(s, indent=1)}\n```\n\n## Per hour (UTC)\n")
        for name, c in counts.items():
            prim = c.get("primary") or {}
            f.write(f"\n### {name}\n" + ("\n".join(f"- {h}: {n}" for h, n in sorted(prim["per_hour"].items())) if "per_hour" in prim else prim.get("error", "not counted")) + "\n")
        f.write("\n## Receipts\n" + "\n".join(f"- {r}" for r in receipts) + f"\n- The server's rate: `scanner.py status` at the read, {workers} workers in settings.\n")
    print(text + f"\nwritten {os.path.relpath(out, ENGINE)}")


if __name__ == "__main__":
    main(sys.argv[1:])
