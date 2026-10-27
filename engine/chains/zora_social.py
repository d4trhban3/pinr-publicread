"""a Zora coin's creator and the accounts the creator linked, from Zora's own coin record
(`api-sdk.zora.engineering/coin`, keyless), as ○ reported facts in the evidence trail: the creator's Zora profile and each
linked X, Farcaster, Instagram and TikTok account. Only what Zora's record lists; an account it lists as empty gets no row
(never "none"), and a record not read is tried again next pass. Neynar (Farcaster posts) needs a free key: the operator's
step, not built here."""
from __future__ import annotations
import json, time, urllib.request

COIN = "https://api-sdk.zora.engineering/coin?chain=8453&address="
UA = {"User-Agent": "PINR-live/1.0 (read-only; pinr.io)", "accept": "application/json"}
PROFILE_URL = {"twitter": "https://x.com/%s", "farcaster": "https://farcaster.xyz/%s", "instagram": "https://www.instagram.com/%s",
               "tiktok": "https://www.tiktok.com/@%s"}
KIND = {"twitter": "x", "farcaster": "farcaster", "instagram": "instagram", "tiktok": "tiktok"}
# Each site's own username characters: a name outside them would make a broken or wrong
# profile link, so it gets no row (never a name with characters taken out: that could be someone else's account).
import re
VALID = {"twitter": re.compile(r"^[A-Za-z0-9_]{1,15}$"), "farcaster": re.compile(r"^[a-z0-9][a-z0-9.-]{0,30}$"),
         "instagram": re.compile(r"^[A-Za-z0-9._]{1,30}$"), "tiktok": re.compile(r"^[A-Za-z0-9._]{2,24}$")}
HANDLE = re.compile(r"^[A-Za-z0-9_.-]{1,40}$")


def read(mint: str, get=None) -> dict | None:
    """{"handle", "accounts": {kind: username}} from Zora's record; {} when Zora does not know the coin; None when unread."""
    try:
        body = get(COIN + mint) if get else json.load(urllib.request.urlopen(urllib.request.Request(COIN + mint, headers=UA), timeout=15))
    except Exception:
        return None
    if not isinstance(body, dict):
        return None
    t = body.get("zora20Token")
    if not isinstance(t, dict):
        return {}
    p = t.get("creatorProfile") if isinstance(t.get("creatorProfile"), dict) else {}
    acc = {}
    for k, v in (p.get("socialAccounts") or {}).items():
        u = (v or {}).get("username") if isinstance(v, dict) else None
        if k in PROFILE_URL and isinstance(u, str) and VALID[k].match(u.strip().lstrip("@")):
            fc = v.get("followerCount")
            acc[k] = {"username": u.strip().lstrip("@"), "followers": fc if isinstance(fc, int) and not isinstance(fc, bool) and fc >= 0 else None}
    handle = p.get("handle").strip() if isinstance(p.get("handle"), str) and HANDLE.match(p.get("handle").strip()) else None
    return {"handle": handle, "accounts": acc, "creator": str(t.get("creatorAddress") or "").lower() or None}


def rows(mint: str, f: dict) -> list:
    src = "Zora's own coin record (creator profile)"
    base = {"coin": mint, "at": None, "source": src, "onchain": 0, "receipt": "Zora creator profile", "unit": None}
    out = []
    if f.get("handle"):
        out.append(dict(base, from_kind="token", from_id=mint, to_kind="zora", to_id=f["handle"], what="creator's Zora profile",
                        value=None, link=f"https://zora.co/@{f['handle']}"))
    for k, a in sorted((f.get("accounts") or {}).items()):
        u = a["username"]
        out.append(dict(base, from_kind="token", from_id=mint, to_kind=KIND[k], to_id=PROFILE_URL[k] % u, what="creator's linked account",
                        value=json.dumps({k2: v for k2, v in (("username", u), ("followers", a.get("followers"))) if v is not None}), link=PROFILE_URL[k] % u))
    return out


def one_pass(c, g, feed_dir: str, limit: int = 10, read_fn=None) -> int:
    """Zora coins in the store without their creator profile yet: read (network first), then rows and the evidence file."""
    import evidence_evm as EE, evidence as EV
    todo = [m for (m,) in c.execute("SELECT mint FROM coins WHERE launchpad='Zora' AND social_at IS NULL ORDER BY launched_at DESC LIMIT ?", (limit,))]
    got = {m: (read_fn or read)(m) for m in todo}
    n = 0
    for m, f in got.items():
        if f is None:
            continue                                           # unread: tried again next pass
        r = rows(m, f) if f else []
        if r:
            n += EE.store(g, r)
            EV.write_coin_file(g, m, feed_dir)
        c.execute("UPDATE coins SET social_at=? WHERE mint=?", (time.time(), m))
    c.commit()
    return n
