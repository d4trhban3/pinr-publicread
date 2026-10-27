#!/usr/bin/env python3
"""GrokBot relay, run as the X API would (PINRBOT, 2026-10-15; the operator's word: "make grokbot run scans like we
would if xapi was plugged in").

  relay.py request [--n 8]   pick the newest scored coins not yet asked about, write REQUEST-NNN.md, open a PR for GrokBot
  relay.py collect           save each new GrokBot answer unchanged as RESPONSE-NNN.md and write CHECK-NNN.md beside it
  relay.py check NNN         re-run the offline check on a saved answer

Public facts only go out (address, name, ticker, the coin's X link). The offline check reads only GrokBot's own text and
the feed file: it opens no X page, so it measures form, not truth. A quote is true only after the X check.
"""
import json, os, re, subprocess, sys, time
from datetime import datetime, timezone, timedelta

HERE = os.path.dirname(os.path.abspath(__file__))
RELAY = os.path.dirname(HERE)
ROOT = os.path.dirname(os.path.dirname(RELAY))
FEED = os.path.join(ROOT, "engine/frontend-feed")
STATE = os.path.join(HERE, "state.json")                       # kept out of git (.git/info/exclude)
CLONE = os.environ.get("COMMS_CLONE") or sys.exit("set COMMS_CLONE to the local copy of pinr-bot-comms")
REPO = os.environ.get("COMMS_REPO", "<owner>/<comms-repo>")
STATUS = re.compile(r"^https://(?:x|twitter)\.com/([A-Za-z0-9_]+)/status/(\d+)$")
B58 = re.compile(r"^[1-9A-HJ-NP-Za-km-z]{32,44}$")
WORDS = "zero one two three four five six seven eight nine ten eleven twelve".split()

def sh(*a, cwd=None):
    return subprocess.run(a, cwd=cwd, check=True, capture_output=True, text=True).stdout.strip()

def load_state():
    try: return json.load(open(STATE))
    except Exception: return {"requests": {}}

def save_state(s):
    json.dump(s, open(STATE, "w"), indent=1)

def now(): return datetime.now(timezone.utc)
def iso(t): return t.strftime("%Y-%m-%dT%H:%M:%SZ")

def feed(mint):
    try: return json.load(open(os.path.join(FEED, mint + ".json")))
    except Exception: return None

def launched(d):
    for f in (d or {}).get("facts") or []:
        if f.get("id") == "launched_at" and f.get("value"):
            try: return datetime.fromisoformat(f["value"].replace("Z", "+00:00"))
            except Exception: return None

def x_cell(d):
    x = ((d.get("links") or {}).get("x") or "").split("?")[0]
    m = re.match(r"^https://(?:x|twitter)\.com/([A-Za-z0-9_]+)/?$", x)
    if m: return "@" + m.group(1)
    if STATUS.match(x): return "none listed; its launchpad page links this post: " + x
    return "none listed"

# ---------- request ----------
def candidates(n, asked):
    rows = []
    for name in os.listdir(FEED):
        if not name.endswith(".json") or name[:-5] in asked: continue
        p = os.path.join(FEED, name)
        if time.time() - os.path.getmtime(p) > 86400: continue       # a dossier read in the last day (older figures cannot be compared)
        d = feed(name[:-5])
        if not isinstance(d, dict) or d.get("score") is None or not launched(d): continue
        if not (d.get("links") or {}).get("x"): continue              # the team's strategy: coins with an X link, biggest first
        fx = {f.get("id"): f.get("value") for f in d.get("facts") or []}
        v, c = float(fx.get("volume_24h") or 0), float(fx.get("valuation") or 0)
        pop = ((v * c) ** 0.5, v, c)         # the operator: most popular first; traded AND sized, so a huge volume on a near-worthless coin does not lead
        rows.append((pop, name[:-5], d))
    rows.sort(reverse=True)
    return rows[:n]

def render(num, coins):
    """Redacted in the public copy."""
    raise NotImplementedError("redacted: proprietary PINR logic is not included in the public copy")

def request(n):
    """Redacted in the public copy."""
    raise NotImplementedError("redacted: proprietary PINR logic is not included in the public copy")

# ---------- collect ----------
def answer(num, r):
    pr = r["pr"].rstrip("/").split("/")[-1]
    out = json.loads(sh("gh", "api", "repos/%s/issues/%s/comments?per_page=100" % (REPO, pr)))
    for c in out:
        if re.search(r"^COIN 1:", c.get("body") or "", re.M):
            return c["body"], "comment on PR #%s, %s" % (pr, c["created_at"])
    try:
        meta = json.loads(sh("gh", "api", "repos/%s/contents/responses/RESPONSE-%s.md?ref=claude/request-%s" % (REPO, num, num)))
        import base64
        return base64.b64decode(meta["content"]).decode(), "file responses/RESPONSE-%s.md on its branch" % num
    except subprocess.CalledProcessError:
        return None, None

def collect():
    s = load_state(); saved = []
    for num, r in sorted(s["requests"].items()):
        if r.get("answered_at") or num == "001": continue
        body, where = answer(num, r)
        if not body: continue
        path = os.path.join(RELAY, "RESPONSE-%s.md" % num)
        open(path, "w").write("# RESPONSE-%s (GrokBot, %s), saved unchanged by PINRbot\n\n%s\n" % (num, where, body))
        r["answered_at"] = iso(now())
        meth = re.search(r"^method:\s*(.+)$", body, re.M | re.I); took = re.search(r"^minutes taken:\s*(.+)$", body, re.M | re.I)
        summary = ("method %s, %s min by GrokBot; " % (meth.group(1).strip() if meth else "not stated", took.group(1).strip() if took else "?")
                   + check(num, r["mints"]) + "; " + confirm(num, r["mints"]))
        r["summary"] = summary; saved.append(num)
        mins = (datetime.fromisoformat(r["answered_at"].replace("Z", "+00:00")) - datetime.fromisoformat(r["opened_at"].replace("Z", "+00:00"))).total_seconds() / 60
        print("RESPONSE-%s saved (%.0f min after the request): %s" % (num, mins, summary), flush=True)
        res = os.path.join(RELAY, "RESULTS.md")
        if not os.path.exists(res):
            open(res, "w").write("# GrokBot relay results\n\n")
        open(res, "a").write("- %s REQUEST-%s (%s): answered in %.0f min; %s\n" % (r["answered_at"], num, r["pr"], mins, summary))
    save_state(s)
    if saved:
        files = [os.path.join("pinrbot/grok-relay", "%s-%s.md" % (k, n)) for n in saved for k in ("REQUEST", "RESPONSE", "CHECK")] + ["pinrbot/grok-relay/RESULTS.md"]
        sh("git", "add", *files, cwd=ROOT)
        sh("git", "commit", "-q", "-m", "PINRBOT: GrokBot answers %s, saved unchanged, with offline checks" % ", ".join(saved), cwd=ROOT)
        try: sh("git", "push", "-q", "origin", "main", cwd=ROOT)
        except subprocess.CalledProcessError as e: print("PUSH FAILED:", e.stderr.strip(), flush=True)

# ---------- offline check ----------
def parse(text):
    coins, cur, claim = {}, None, None
    for line in text.splitlines():
        line = line.strip()
        m = re.match(r"^COIN (\d+):", line)
        if m: cur = coins.setdefault(int(m.group(1)), {"looked": None, "none": False, "claims": []}); claim = None; continue
        if cur is None: continue
        if line.startswith("posts looked at:"):
            cur["looked"] = line.split(":", 1)[1].strip()
        elif line.lower() == "none found": cur["none"] = True
        elif re.match(r"^CLAIM \d+\.\d+$", line): claim = {}; cur["claims"].append(claim)
        elif claim is not None and ":" in line:
            k, v = line.split(":", 1); claim[k.strip()] = v.strip()
    return coins

def status_time(url):
    m = STATUS.match(url or "")
    return datetime.fromtimestamp(((int(m.group(2)) >> 22) + 1288834974657) / 1000, timezone.utc) if m else None

def check(num, mints):
    text = open(os.path.join(RELAY, "RESPONSE-%s.md" % num)).read()
    coins = parse(text)
    rows, tot = [], dict(claims=0, posts=0, link_bad=0, handle_bad=0, time_bad=0, kind_bad=0, ca_own=0, ca_other=0, before_launch=0, none=0)
    for i, mint in enumerate(mints, 1):
        c = coins.get(i); d = feed(mint) or {}; la = launched(d)
        if not c: rows.append("| %d | `%s` | missing from the answer | | | | | |" % (i, mint)); continue
        tot["none"] += c["none"] and not c["claims"]
        n = dict(link_bad=0, handle_bad=0, time_bad=0, kind_bad=0, ca_own=0, ca_other=0, before_launch=0)
        for cl in c["claims"]:
            link = cl.get("link", "").split("?")[0]; m = STATUS.match(link); st = status_time(link)
            if not m: n["link_bad"] += 1; continue
            if cl.get("handle", "").lstrip("@").lower() != m.group(1).lower(): n["handle_bad"] += 1
            try:
                pt = datetime.strptime(cl.get("posted_utc", ""), "%Y-%m-%d %H:%M").replace(tzinfo=timezone.utc)
                if abs((st - pt).total_seconds()) > 120: n["time_bad"] += 1
            except ValueError: n["time_bad"] += 1
            if cl.get("kind") not in [str(k) for k in range(1, 11)]: n["kind_bad"] += 1
            if cl.get("kind") == "10":
                a = cl.get("stated", "").strip()
                n["ca_own" if a == mint else "ca_other"] += 1
            if la and st < la - timedelta(minutes=5): n["before_launch"] += 1
        posts = len({cl.get("link", "").split("?")[0] for cl in c["claims"]})
        for k in n: tot[k] += n[k]
        tot["claims"] += len(c["claims"]); tot["posts"] += posts
        rows.append("| %d | `%s` | %s | %d / %d | %d | %d | %d | %d own, %d other | %d |" % (i, mint, c["looked"], len(c["claims"]), posts,
                    n["link_bad"], n["handle_bad"], n["time_bad"], n["ca_own"], n["ca_other"], n["before_launch"]))
    out = ["# CHECK-%s: offline check of GrokBot's RESPONSE-%s (PINRbot, %s)" % (num, num, iso(now())), "",
           "Form only: GrokBot's own text against the post links and the feed files. **No X page was opened, so no quote is confirmed yet.**", "",
           "| # | Coin | Posts looked at | Claims / posts | Bad link | Handle not the link's | Time not the link's (>2 min) | Address claims (kind 10) | Posts before launch |",
           "|---|---|---|---|---|---|---|---|---|"] + rows
    open(os.path.join(RELAY, "CHECK-%s.md" % num), "w").write("\n".join(out) + "\n")
    return ("%d claims in %d posts, %d coins none found; bad link %d, handle mismatch %d, time mismatch %d, bad kind %d; "
            "address claims %d own / %d other; before launch %d" % (tot["claims"], tot["posts"], tot["none"], tot["link_bad"],
            tot["handle_bad"], tot["time_bad"], tot["kind_bad"], tot["ca_own"], tot["ca_other"], tot["before_launch"]))

# ---------- quote check by X's embed service, and filing ----------
SCAN_OUT = os.path.join(ROOT, "marketing/scan-output")
COMPARE = os.path.join(ROOT, "marketing/scan/compare.py")
_embed = {}

def norm(s):
    import unicodedata
    s = unicodedata.normalize("NFKC", s).replace("‘", "'").replace("’", "'").replace("“", '"').replace("”", '"')
    return re.sub(r"\s+", " ", s).strip()

def embed(url):
    """The post's own text, author and read time from X's public embed service (keyless; one read per post)."""
    if url in _embed: return _embed[url]
    import html, urllib.request, urllib.parse
    q = "https://publish.x.com/oembed?" + urllib.parse.urlencode({"url": url, "omit_script": 1, "dnt": "true"})
    try:
        with urllib.request.urlopen(urllib.request.Request(q, headers={"User-Agent": "PINR quote check"}), timeout=15) as r:
            d = json.load(r)
        p = re.search(r"<p[^>]*>(.*?)</p>", d.get("html", ""), re.S)
        text = html.unescape(re.sub(r"<[^>]+>", "", re.sub(r"<br\s*/?>", "\n", p.group(1)))) if p else ""
        out = {"text": text, "handle": (d.get("author_url") or "").rstrip("/").split("/")[-1], "read_at": iso(now()), "error": None}
    except Exception as e:
        out = {"text": None, "handle": None, "read_at": iso(now()), "error": str(getattr(e, "code", "")) or type(e).__name__}
    time.sleep(1)                                                      # one read a second, human pace
    _embed[url] = out
    return out

def stated(kind, s, quote):
    s = (s or "").strip()
    if kind == 10: return {"text": s}
    if kind == 8:
        if re.search(r"\bATH\b|all[- ]time", s + " " + quote, re.I): return {"text": s}   # a past peak, not today's size
        num = r"\$?\s*([\d][\d,]*(?:\.\d+)?)\s*([KkMmBb])?\b"
        for src in (quote, s):                                       # the figure beside the words "market cap", never the first number
            m = re.search(r"(?:market ?cap|mcap|\bmc\b)\s*[:=]?\s*" + num, src, re.I) or re.search(num + r"\s*(?:market ?cap|mcap|\bmc\b)", src, re.I)
            if m:
                n = float(m.group(1).replace(",", "")) * {"k": 1e3, "m": 1e6, "b": 1e9}.get((m.group(2) or "").lower(), 1)
                return {"number": n, "unit": "market cap", "text": s}
        return {"text": s}
    if kind == 5 and not re.search(r"launch", s + " " + quote, re.I):
        return {"text": s}                                           # a date that is not a launch day is not compared
    if kind == 5:
        m = re.search(r"(\d{4}-\d{2}-\d{2})(?:[ T](\d{2}:\d{2}))?", s)
        if m: return {"time": m.group(1) + "T" + (m.group(2) or "00:00") + ":00Z", "precision": "minute" if m.group(2) else "day", "text": s}
    if kind == 6:
        for k in ("first launch", "new dev"):
            if k in (s + " " + quote).lower(): return {"text": k}
    return {"text": s}

def confirm(num, mints):
    """Every claim's quote against its post's own text; only confirmed claims are filed, each drop listed with its reason."""
    text = open(os.path.join(RELAY, "RESPONSE-%s.md" % num)).read()
    coins, kept, dropped, files = parse(text), 0, [], []
    for i, mint in enumerate(mints, 1):
        c = coins.get(i) or {"looked": None, "claims": []}
        d = feed(mint) or {}
        claims, drops = [], []
        for cl in c["claims"]:
            link = cl.get("link", "").split("?")[0]; q = cl.get("quote", "").strip()
            if len(q) > 1 and q[0] == q[-1] == '"': q = q[1:-1]
            e = embed(link) if STATUS.match(link) else {"text": None, "error": "not a post link"}
            if e["text"] is None:
                why = "the post could not be read (%s)" % e["error"]
            elif e["handle"] and e["handle"].lower() != STATUS.match(link).group(1).lower():
                why = "the post is by another account than its link says"
            elif norm(q) in norm(e["text"]):
                why = None
            elif e["text"].rstrip().endswith("…"):
                why = "the post's text is cut short where the embed service stops; quote not confirmed"
            else:
                why = "the quote is not word for word in the post"
            if why:
                drops.append({"post_url": link, "quote": q, "kind": cl.get("kind"), "reason": why}); continue
            k = int(cl["kind"]) if str(cl.get("kind")).isdigit() else 0
            claims.append({"post_url": link, "channel": "x", "handle": "@" + STATUS.match(link).group(1), "quote": q, "kind": k,
                           "stated": stated(k, cl.get("stated"), q), "read_at": e["read_at"]})
        kept += len(claims); dropped += [dict(x, coin=mint) for x in drops]
        if not (d and d.get("facts")): continue                        # no dossier: nothing to compare against
        cf = {"coin": mint, "name": d.get("name"), "scanned_at": iso(now()), "run_id": "grok-relay-" + num,
              "sources": {"x": {"posts_read": c.get("looked"), "found_by": "GrokBot (X search)",
                                "quotes_checked_by": "X's public embed service, word for word"}},
              "gaps": [], "checks_used": len({x["post_url"] for x in claims + drops}), "claims": claims}
        tmp = os.path.join(HERE, "claims-%s-%d.json" % (num, i)); json.dump(cf, open(tmp, "w"), indent=1)
        out = os.path.join(SCAN_OUT, mint + ".json")
        sh("python3", COMPARE, tmp, os.path.join(FEED, mint + ".json"), out)
        o = json.load(open(out)); o["not_recorded"] = (o.get("not_recorded") or []) + drops; json.dump(o, open(out, "w"), indent=1)
        os.remove(tmp); files.append(mint)
    lines = ["", "## Embed check (X's public embed service, %s): %d kept, %d dropped; %d scan files written" % (iso(now()), kept, len(dropped), len(files))]
    if dropped:
        lines += ["| Coin | Post | Kind | Why dropped |", "|---|---|---|---|"]
        lines += ["| `%s…` | %s | %s | %s |" % (x["coin"][:8], x["post_url"], x["kind"], x["reason"]) for x in dropped]
    open(os.path.join(RELAY, "CHECK-%s.md" % num), "a").write("\n".join(lines) + "\n")
    return "embed check: %d kept, %d dropped, %d scan files" % (kept, len(dropped), len(files))

if __name__ == "__main__":
    a = sys.argv[1:]
    if a[:1] == ["request"]: request(int(a[a.index("--n") + 1]) if "--n" in a else 8)
    elif a[:1] == ["collect"]: collect()
    elif a[:1] == ["check"]: print(check(a[1], load_state()["requests"][a[1]]["mints"]))
    elif a[:1] == ["confirm"]: print(confirm(a[1], load_state()["requests"][a[1]]["mints"]))
    else: print(__doc__)
