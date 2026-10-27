"""Tests for quote_check.py: offline, on X's real oEmbed answer saved on 2026-10-15 (fixtures/), no network."""
import io, json, os, sys, urllib.error
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import quote_check as Q

REAL = json.load(open(os.path.join(HERE, "fixtures", "oembed-2026-10-15-one-read.json")))
POST = "https://x.com/CogentsLive/status/2110127367347917091"
results = []


def case(n, title, fn):
    ok, said = fn()
    results.append(ok)
    print(f"{n}. {title}\n   {'PASS' if ok else 'FAIL'}: {said}")


def fake(answers):
    asked = []
    def get(u):
        asked.append(u)
        a = answers.get(u.split("url=", 1)[1])
        if isinstance(a, Exception):
            raise a
        return a
    return get, asked


def claims(*cs):
    return {"coin": "made-up-mint", "claims": [dict(post_url=u, quote=q, kind=8) for u, q in cs]}


def c1():
    get, asked = fake({Q.urllib.parse.quote(POST, safe=""): REAL})
    r = Q.check(claims((POST, "Every day, 100% of the $GENTS creator fees are sent to the wallet of the bot at the top of the leaderboard."),
                       (POST, "one day,  one winner, paid on-chain.")), get=get, gap=0)
    ok = r["quote_check"] == {"reads": 1, "confirmed": 2, "not_confirmed": 0, "source": "X oEmbed (publish.x.com)"} and len(asked) == 1 \
        and all(c["check"]["result"] == "confirmed" and c["post_status"] == "present" for c in r["claims"])
    return ok, f"two quotes from the real answer, one read for both, spacing and case evened: {r['quote_check']}"


def c2():
    get, _ = fake({Q.urllib.parse.quote(POST, safe=""): REAL})
    r = Q.check(claims((POST, "House bots and user bots compete on the leaderboard every single day")), get=get, gap=0)
    nc = r["not_confirmed"][0]["check"]
    return (r["claims"] == [] and nc["reason"] == "the post's text was cut short before the quote could be seen"), \
        f"a quote past X's cut is not confirmed with that reason, never 'not said': {nc['reason']}"


def c3():
    get, _ = fake({Q.urllib.parse.quote(POST, safe=""): {"html": "<blockquote><p>Short and complete post.</p></blockquote>"}})
    r = Q.check(claims((POST, "a quote the post never had")), get=get, gap=0)
    return r["not_confirmed"][0]["check"]["reason"] == "the quote is not in the post's text", "a whole post without the quote: not confirmed"


def c4():
    gone = urllib.error.HTTPError(POST, 404, "Not Found", {}, io.BytesIO(b""))
    busy = urllib.error.HTTPError(POST, 429, "Too Many", {}, io.BytesIO(b""))
    other = "https://x.com/someone/status/1"
    get, _ = fake({Q.urllib.parse.quote(POST, safe=""): gone, Q.urllib.parse.quote(other, safe=""): busy})
    r = Q.check(claims((POST, "x"), (other, "y"), ("https://example.com/post", "z")), get=get, gap=0)
    reasons = [c["check"]["reason"] for c in r["not_confirmed"]]
    return reasons == ["post gone or private", "read failed (HTTP 429)", "not an X post link"] and r["claims"] == [], f"{reasons}"


def c5():
    text, cut = Q.post_text(REAL)
    return (cut and text.startswith("Daily prize") and "pic.twitter.com" not in text), f"the real answer's text read, cut marked {cut}"


def c6():
    """the team's Q1: a quote must be whole words; only case, spaces and curly quote marks are evened out"""
    post = {"html": "<blockquote><p>We burned 100% of the LP. Don’t miss the unlock</p></blockquote>"}
    get, _ = fake({Q.urllib.parse.quote(POST, safe=""): post})
    tries = {"urned 100% of the LP": False,          # starts inside a word
             "We burned 100% of th": False,          # ends inside a word
             "lock": False,                          # a word inside "unlock"
             "we  BURNED 100% of the lp.": True,     # case and spaces only
             "Don't miss": True,                     # straight against curly mark
             "Dont miss": False,                     # a dropped mark is a different text
             "burned 100 % of": False}               # an added space inside a figure is not evened
    got = {}
    for q in tries:
        r = Q.check(claims((POST, q)), get=get, gap=0)
        got[q] = bool(r["claims"])
    return got == tries, f"{got}"


for i, f in enumerate((c1, c2, c3, c4, c5, c6), 1):
    case(i, f.__doc__ or f.__name__, f)
print(f"\n{sum(results)}/{len(results)} passed")
raise SystemExit(0 if all(results) else 1)
