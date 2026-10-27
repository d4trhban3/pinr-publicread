"""a design decision / 249 (CHAINS): new coins on Base from the launchpads' own keyless lists, as plain records.
Routes (facts/LAUNCHPAD-ROUTES.md, re-tested 2026-10-25 from the Mac, keyless, 200):
  - Clanker: its own list `clanker.world/api/tokens` (newest first; several chains, Base kept: chain_id 8453);
  - Zora: its own list `api-sdk.zora.engineering/explore?listType=NEW`;
  - Virtuals: its own list `api.virtuals.io/api/virtuals` (answered today; it timed out on 2026-10-23), with GeckoTerminal's
    Base new pools on the `virtuals-base` / `virtuals-unicorn-base` venues as the second route.
Each record carries only what the list gave; nothing is guessed (missing stays missing). A creator's launch count is the
launchpad's own count, read from its own per-creator list."""
from __future__ import annotations
import calendar, json, time, urllib.error, urllib.parse, urllib.request

UA = {"User-Agent": "PINR-live/1.0 (read-only launch lists)", "accept": "application/json"}
BASE_ID = 8453
CLANKER_NEW = "https://www.clanker.world/api/tokens?sort=desc&limit=20"
CLANKER_BY = "https://www.clanker.world/api/tokens/fetch-deployed-by-address?address="
ZORA_NEW = "https://api-sdk.zora.engineering/explore?listType=NEW&count=20"
ZORA_BY = "https://api-sdk.zora.engineering/profileCoins?count=1&identifier="
VIRTUALS_NEW = "https://api.virtuals.io/api/virtuals?sort[0]=createdAt:desc&pagination[pageSize]=25&filters[chain]=BASE"
VIRTUALS_BY = "https://api.virtuals.io/api/virtuals?pagination[pageSize]=1&fields[0]=id&filters[walletAddress]="
GECKO_BASE_NEW = "https://api.geckoterminal.com/api/v2/networks/base/new_pools?page=1&include=base_token"
VIRTUALS_DEXES = ("virtuals-base", "virtuals-unicorn-base")
IPFS_SHOW = "https://ipfs.io/ipfs/"         # the picture's address on a host the site loads directly (pinr-live imagehosts.ts)


def get(url: str, fetch=None, timeout: int = 15):
    """(HTTP status, parsed JSON or None). 0 = no answer."""
    if fetch:
        return fetch(url)
    try:
        req = urllib.request.Request(urllib.parse.quote(url, safe=":/?&=,[]%"), headers=UA)
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, json.loads(r.read(5_000_000))
    except urllib.error.HTTPError as e:
        return e.code, None
    except Exception:
        return 0, None


def ts(v) -> float | None:
    """Unix seconds from an ISO time ("2026-10-25T00:25:59.000Z", "+00:00") or a number (seconds or ms)."""
    if isinstance(v, (int, float)) and not isinstance(v, bool) and v > 0:
        return v / 1000 if v > 1e12 else float(v)
    if isinstance(v, str) and len(v) >= 19:
        try:
            return float(calendar.timegm(time.strptime(v[:19], "%Y-%m-%dT%H:%M:%S")))
        except ValueError:
            return None
    return None


def addr(v) -> str | None:
    return v.lower() if isinstance(v, str) and len(v) == 42 and v[:2] == "0x" and all(ch in "0123456789abcdefABCDEF" for ch in v[2:]) else None


def https(v) -> str | None:
    return v if isinstance(v, str) and v.startswith("https://") and len(v) < 300 else None


def picture(uri) -> str | None:
    """An https picture as given; an IPFS one (ipfs://CID, or a bare CID) on ipfs.io, so the gate keys it by its content id."""
    if not isinstance(uri, str) or not uri.strip():
        return None
    u = uri.strip()
    if u.startswith("ipfs://"):
        u = u[7:]
        return IPFS_SHOW + u if len(u) >= 40 and " " not in u else None
    if u.startswith(("bafy", "bafk", "Qm")) and " " not in u and "/" not in u:
        return IPFS_SHOW + u
    return https(u)


def _num(v) -> float | None:
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    return f if f == f and f >= 0 else None


def _links(pairs) -> dict:
    """{x, website, telegram} from [(kind or url, url)]: by the kind's name, else by the link's own host."""
    out = {}
    for kind, url in pairs:
        u = url if isinstance(url, str) and url.lower().startswith(("http://", "https://")) else None
        if not u:
            continue
        k = f"{kind} {u}".lower()
        key = "x" if ("twitter" in k or "x.com/" in k) else "telegram" if ("telegram" in k or "t.me/" in k) else "website" if "website" in k or kind in ("web", "site") else None
        if key and key not in out:
            out[key] = u
    return out


def clanker(body) -> list:
    """Clanker's newest list, Base coins only, as records."""
    out = []
    for x in (body or {}).get("data") or [] if isinstance(body, dict) else []:
        if not isinstance(x, dict) or x.get("chain_id") != BASE_ID or not addr(x.get("contract_address")):
            continue
        soc = [(s.get("name"), s.get("url")) for s in x.get("socialLinks") or [] if isinstance(s, dict)]
        soc += [(s.get("platform"), s.get("url")) for s in ((x.get("metadata") or {}).get("socialMediaUrls") or []) if isinstance(s, dict)]
        mkt = ((x.get("related") or {}).get("market") or {}) if isinstance(x.get("related"), dict) else {}
        out.append({"mint": addr(x["contract_address"]), "chain": "base", "launchpad": "Clanker", "by": "clanker_api",
                    "name": x.get("name"), "ticker": x.get("symbol"), "image": picture(x.get("img_url")),
                    "launched_at": ts(x.get("deployed_at") or x.get("created_at")), "creator": addr(x.get("admin")),
                    "launch_tx": x.get("tx_hash") if isinstance(x.get("tx_hash"), str) else None, "links": _links(soc),
                    "price_usd": _num(mkt.get("priceUsd")), "valuation_usd": _num(mkt.get("marketCap")),
                    "market_as_of": ts(mkt.get("marketDataUpdatedAt"))})
    return out


def zora(body) -> list:
    """Zora's newest coins (Base), as records. The picture is the coin's own media when it is a picture."""
    edges = (((body or {}).get("exploreList") or {}).get("edges") or []) if isinstance(body, dict) else []
    out = []
    for e in edges:
        x = (e or {}).get("node") if isinstance(e, dict) else None
        if not isinstance(x, dict) or x.get("chainId") != BASE_ID or not addr(x.get("address")) or x.get("platformBlocked"):
            continue
        media = x.get("mediaContent") if isinstance(x.get("mediaContent"), dict) else {}
        img = None
        if str(media.get("mimeType") or "").startswith("image/"):
            img = picture(media.get("originalUri")) or https(((media.get("previewImage") or {}) if isinstance(media.get("previewImage"), dict) else {}).get("medium"))
        price = (x.get("tokenPrice") or {}).get("priceInUsdc") if isinstance(x.get("tokenPrice"), dict) else None
        out.append({"mint": addr(x["address"]), "chain": "base", "launchpad": "Zora", "by": "zora_explore",
                    "name": x.get("name"), "ticker": x.get("symbol"), "image": img, "launched_at": ts(x.get("createdAt")),
                    "creator": addr(x.get("creatorAddress")), "meta_uri": x.get("tokenUri") if isinstance(x.get("tokenUri"), str) else None,
                    "price_usd": _num(price) or None, "valuation_usd": _num(x.get("marketCap")) or None})
    return out


def virtuals(body) -> list:
    """Virtuals' own newest list, Base only. Before it graduates a Virtuals coin trades as its bonding token (`preToken`);
    after, as `tokenAddress`. The coin's address is the one it trades as now."""
    out = []
    for x in (body or {}).get("data") or [] if isinstance(body, dict) else []:
        if not isinstance(x, dict) or str(x.get("chain")).upper() != "BASE":
            continue
        mint = addr(x.get("tokenAddress")) or addr(x.get("preToken"))
        if not mint:
            continue
        soc = x.get("socials")
        if isinstance(soc, str):
            try:
                soc = json.loads(soc)
            except ValueError:
                soc = {}
        pairs = []
        if isinstance(soc, dict):
            for k, v in soc.items():
                if isinstance(v, str):
                    pairs.append((k, v))
                elif isinstance(v, dict):
                    pairs += [(f"{k} {k2}", v2) for k2, v2 in v.items() if isinstance(v2, str)]
        out.append({"mint": mint, "chain": "base", "launchpad": "Virtuals", "by": "virtuals_api", "name": x.get("name"),
                    "ticker": x.get("symbol"), "image": https((x.get("image") or {}).get("url") if isinstance(x.get("image"), dict) else None),
                    "launched_at": ts(x.get("launchedAt") or x.get("createdAt")), "creator": addr(x.get("walletAddress")),
                    "links": _links(pairs)})
    return out


def gecko_virtuals(body) -> list:
    """GeckoTerminal's newest Base pools on the Virtuals venues, as records (no creator: GeckoTerminal does not give one)."""
    if not isinstance(body, dict):
        return []
    toks = {t.get("id"): t.get("attributes") or {} for t in body.get("included") or [] if isinstance(t, dict)}
    out = []
    for p in body.get("data") or []:
        rel = (p or {}).get("relationships") or {}
        dex = ((rel.get("dex") or {}).get("data") or {}).get("id")
        if dex not in VIRTUALS_DEXES:
            continue
        tid = ((rel.get("base_token") or {}).get("data") or {}).get("id") or ""
        mint = addr(tid.split("_", 1)[-1])
        if not mint:
            continue
        t = toks.get(tid, {})
        img = https(t.get("image_url"))
        out.append({"mint": mint, "chain": "base", "launchpad": "Virtuals", "by": "gecko_virtuals", "name": t.get("name"),
                    "ticker": t.get("symbol"), "image": img if img and "missing" not in img else None,
                    "launched_at": ts(((p.get("attributes") or {}).get("pool_created_at"))), "creator": None})
    return out


def creator_count(launchpad: str, creator: str, fetch=None) -> int | None:
    """The creator's coins as the launchpad itself counts them; None when it did not answer."""
    if launchpad == "Clanker":
        st, b = get(CLANKER_BY + creator, fetch)
        n = b.get("total") if isinstance(b, dict) else None
    elif launchpad == "Zora":
        st, b = get(ZORA_BY + creator, fetch)
        n = (((b or {}).get("profile") or {}).get("createdCoins") or {}).get("count") if isinstance(b, dict) else None
    elif launchpad == "Virtuals":
        st, b = get(VIRTUALS_BY + creator, fetch)
        n = (((b or {}).get("meta") or {}).get("pagination") or {}).get("total") if isinstance(b, dict) else None
    else:
        return None
    return n if isinstance(n, int) and not isinstance(n, bool) and n >= 0 else None


LISTS = {                                   # name: (address, parser, pace seconds)
    "clanker": (CLANKER_NEW, clanker, 30),
    "zora": (ZORA_NEW, zora, 60),
    "virtuals": (VIRTUALS_NEW, virtuals, 120),
    "gecko_virtuals": (GECKO_BASE_NEW, gecko_virtuals, 180),
}
