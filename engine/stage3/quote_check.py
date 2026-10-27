"""Quote check for the social scan.

  python3 quote_check.py <claims.json> <checked.json>

Reads a claims file in `marketing/scan/compare.py`'s shape and asks X's public oEmbed address (keyless, read only) for
each X post once. A claim is kept only if its exact quote is in the post's own text, compared with
spacing and letter case evened out. Everything else moves to "not_confirmed" with its reason, never dropped silently:
the post is gone or private, the post's text was cut short before the quote could be seen (oEmbed cuts long posts at
about 300 characters), the quote is not in the text, or the read failed. A claim that is not confirmed is never
recorded as "not said": missing stays missing. Nothing here scores anything; the output goes to compare.py as before.
"""
from __future__ import annotations
import html, json, re, sys, time, urllib.error, urllib.parse, urllib.request

OEMBED = "https://publish.x.com/oembed?omit_script=1&dnt=true&url="
POST = re.compile(r"^https://(?:x|twitter)\.com/[A-Za-z0-9_]+/status/\d+")
GAP = 1.0                         # seconds between reads: a polite pace for a public address with no published limit


def _norm(s: str) -> str:
    """Evens out only what does not change what a post says: letter case, runs of spaces, and
    curly against straight quote marks. Nothing else is changed."""
    s = str(s).replace("‘", "'").replace("’", "'").replace("“", '"').replace("”", '"')
    return " ".join(s.split()).lower()


def _quoted(quote: str, text: str) -> bool:
    """The quote is in the text as whole words: it may not start or end inside a word of the post."""
    q, t = _norm(quote), _norm(text)
    if not q:
        return False
    pat = ("(?<!\\w)" if re.match(r"\w", q) else "") + re.escape(q) + ("(?!\\w)" if re.search(r"\w$", q) else "")
    return re.search(pat, t) is not None


def post_text(answer: dict) -> tuple[str, bool]:
    """The post's own words from an oEmbed answer, and whether X cut them short ("…" at the end of the text)."""
    m = re.search(r"<p[^>]*>(.*?)</p>", answer.get("html") or "", re.S)
    if not m:
        return "", False
    text = html.unescape(re.sub(r"<[^>]+>", " ", m.group(1).replace("<br>", "\n")))
    text = re.sub(r"\s*pic\.twitter\.com/\S+\s*$", "", text.strip())
    return text, text.rstrip().endswith("…")


def _read(url: str, get=None):
    """One oEmbed read. Returns (answer dict, None) or (None, reason)."""
    get = get or (lambda u: json.load(urllib.request.urlopen(urllib.request.Request(u, headers={"accept": "application/json",
                                                                                          "user-agent": "PINR quote check"}), timeout=20)))
    try:
        return get(OEMBED + urllib.parse.quote(url, safe="")), None
    except urllib.error.HTTPError as e:
        return None, "post gone or private" if e.code in (403, 404) else f"read failed (HTTP {e.code})"
    except Exception as e:
        return None, f"read failed ({type(e).__name__})"


def check(claims: dict, get=None, now=None, gap: float = GAP) -> dict:
    """Split the claims into confirmed and not confirmed. One read per post, however many claims quote it."""
    out = dict(claims)
    kept, not_confirmed, cache = [], [], {}
    for c in claims.get("claims") or []:
        url = (c.get("post_url") or "").split("?")[0]
        if not POST.match(url):
            not_confirmed.append(dict(c, check={"result": "not confirmed", "reason": "not an X post link"})); continue
        if url not in cache:
            if cache:
                time.sleep(gap)
            cache[url] = (_read(url, get), (now or time.time)())
        (ans, problem), at = cache[url]
        stamp = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(at))
        if ans is None:
            not_confirmed.append(dict(c, check={"result": "not confirmed", "reason": problem, "read_at": stamp})); continue
        text, cut = post_text(ans)
        quote = _norm(c.get("quote") or "")
        if _quoted(quote, text):
            kept.append(dict(c, read_at=stamp, post_status="present",
                             check={"result": "confirmed", "how": "exact quote in the post's own text (X oEmbed)", "read_at": stamp}))
        else:
            reason = ("the post's text was cut short before the quote could be seen" if cut else
                      "the quote is not in the post's text" if quote else "no quote given")
            not_confirmed.append(dict(c, check={"result": "not confirmed", "reason": reason, "read_at": stamp}))
    out["claims"], out["not_confirmed"] = kept, not_confirmed
    out["quote_check"] = {"reads": len(cache), "confirmed": len(kept), "not_confirmed": len(not_confirmed), "source": "X oEmbed (publish.x.com)"}
    return out


if __name__ == "__main__":
    src, dst = sys.argv[1], sys.argv[2]
    res = check(json.load(open(src)))
    json.dump(res, open(dst, "w"), indent=1, ensure_ascii=False)
    q = res["quote_check"]
    print(f"{q['confirmed']} confirmed, {q['not_confirmed']} not confirmed, {q['reads']} posts read")
