"""Website checks, parts 2-4. PINR only DOWNLOADS and READS the page as text: it never runs the
site's scripts, never clicks anything, never connects a wallet.

Part 2 domain history (20): registration date from the public domain registry (RDAP).
Part 3 substance (30): original text about the project vs a bare template.
Part 4 safety (20): HTTPS, and wallet-drainer code patterns (blanket approvals, "sign all").
A link to a social profile (X, Instagram, a wiki...) is NOT a website: it counts as no website.
"""
from __future__ import annotations
import datetime, json, os, re, sys, urllib.request
from urllib.parse import urlparse

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "pinr-score"))
import score_engine_v1 as E

NOT_A_WEBSITE = ("x.com", "twitter.com", "instagram.com", "facebook.com", "tiktok.com", "youtube.com", "t.me",
                 "discord.gg", "discord.com", "reddit.com", "fandom.com", "wikipedia.org", "huggingface.co",
                 "pump.fun", "stonkfun.xyz", "dexscreener.com", "github.com", "weibo.com", "weibo.cn", "threads.net",
                 "bilibili.com", "douyin.com", "xiaohongshu.com", "vk.com", "linkedin.com", "medium.com", "telegram.org",
                 "four.meme", "flap.sh", "docs.flap.sh", "gmgn.ai", "bscscan.com", "t.co")
FREE_HOSTS = ("vercel.app", "netlify.app", "carrd.co", "linktr.ee", "github.io", "pages.dev", "webflow.io",
              "wixsite.com", "framer.website", "framer.app", "glitch.me", "replit.app", "beacons.ai", "bio.link")
# Strong evidence only. Normal wallet-library functions (signAllTransactions, setApprovalForAll) appear in every
# legitimate dApp and are NOT evidence on their own (a real token game site tripped them, 2026-10-04).
DRAINER_PATTERNS = [r"inferno.?drainer", r"angel.?drainer", r"pink.?drainer", r"monkey.?drainer", r"venom.?drainer",
                    r"ace.?drainer", r"drainer.?(kit|config|js)", r"approve\(\s*[^,]+,\s*(?:ethers\.)?(?:constants\.)?MaxUint256",
                    r"0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff"]
MIN_WORDS_FULL, MIN_WORDS_THIN = 150, 40


def host(url: str) -> str:
    return (urlparse(url if "://" in url else "https://" + url).hostname or "").lower()


def kind(url: str | None) -> str:
    if not url:
        return "none"
    h = host(url)
    if any(h == d or h.endswith("." + d) for d in NOT_A_WEBSITE):
        return "not_a_website"
    if any(h.endswith("." + d) or h == d for d in FREE_HOSTS):
        return "free_subdomain"
    return "domain"


def grade_domain(url_kind: str, registered: datetime.datetime | None, launch_ts: int | None, recycled: bool) -> E.Reading:
    """Redacted in the public copy."""
    raise NotImplementedError("redacted: proprietary PINR logic is not included in the public copy")


def visible_text(html: str) -> str:
    html = re.sub(r"(?is)<(script|style|noscript|svg)[^>]*>.*?</\1>", " ", html)
    return re.sub(r"\s+", " ", re.sub(r"(?s)<[^>]+>", " ", html)).strip()


def grade_substance(html: str | None, names: tuple[str, ...], copied: bool) -> E.Reading:
    """Redacted in the public copy."""
    raise NotImplementedError("redacted: proprietary PINR logic is not included in the public copy")


def drainer_hits(html_and_scripts: str) -> list[str]:
    return [p for p in DRAINER_PATTERNS if re.search(p, html_and_scripts, re.I)]


def grade_safety(url: str, code: str | None) -> tuple[E.Reading, bool]:
    """Redacted in the public copy."""
    raise NotImplementedError("redacted: proprietary PINR logic is not included in the public copy")


# ------------------------------------------------------------------ network (read-only)
def _counted(name: str, answered: bool) -> None:
    try:                                  # the saved request count per source (`scanner.py status`); never in the way
        import solana_rpc
        solana_rpc.count(name, answered)
    except Exception:
        pass


def fetch(url: str, limit: int = 2_000_000) -> str | None:
    try:
        req = urllib.request.Request(url if "://" in url else "https://" + url, headers={"User-Agent": "PINR-live/1.0 (read-only; pinr.io)"})
        body = urllib.request.urlopen(req, timeout=20).read(limit).decode("utf-8", "ignore")
    except Exception:
        _counted("websites", False)
        return None
    _counted("websites", True)
    return body


def same_site_scripts(url: str, html: str, max_scripts: int = 8) -> str:
    """Downloads (never runs) the page's own script files, to read them as text."""
    out = []
    for src in re.findall(r'<script[^>]+src=["\']([^"\']+)["\']', html, re.I)[:max_scripts]:
        full = src if "://" in src else urllib.request.urljoin(url, src)
        js = fetch(full, 1_000_000)
        if js:
            out.append(js)
    return "\n".join(out)


def rdap_registered(url: str) -> datetime.datetime | None:
    h = host(url)
    parts = h.split(".")
    for i in range(len(parts) - 1):
        dom = ".".join(parts[i:])
        try:
            try:
                d = json.load(urllib.request.urlopen(f"https://rdap.org/domain/{dom}", timeout=20))
            except Exception:
                _counted("rdap", False)
                raise
            _counted("rdap", True)
            for ev in d.get("events", []):
                if ev.get("eventAction") == "registration":
                    return datetime.datetime.fromisoformat(ev["eventDate"].replace("Z", "+00:00"))
            return None
        except Exception:
            continue
    return None


def shows_address(html: str | None, scripts: str | None, mint: str) -> bool | None:
    """PINR's own path-back check: does the site itself (page or its own scripts) contain the token's address?"""
    if html is None:
        return None
    blob = (html + "\n" + (scripts or "")).lower()
    return mint.lower() in blob


def check_website(url: str | None, names: tuple[str, ...], launch_ts: int | None, recycled: bool, copied: bool) -> dict:
    k = kind(url)
    if k in ("none", "not_a_website"):
        return {"kind": k, "domain": E.NO_PENALTY, "substance": E.NO_PENALTY, "safety": E.NO_PENALTY, "drainer": False,
                "is_website": False}
    html = fetch(url)
    scripts = None if html is None else same_site_scripts(url if "://" in url else "https://" + url, html)
    code = None if html is None else html + "\n" + scripts
    safety, drainer = grade_safety(url, code)
    return {"kind": k, "domain": grade_domain(k, rdap_registered(url) if k == "domain" else None, launch_ts, recycled),
            "substance": grade_substance(html, names, copied), "safety": safety, "drainer": drainer, "is_website": True,
            "shows_address": shows_address(html, scripts, names[-1]) if names and str(names[-1]).startswith(("0x", "1", "2", "3", "4", "5", "6", "7", "8", "9", "A", "B", "C", "D", "E", "F", "G", "H")) else None}
