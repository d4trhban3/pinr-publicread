"""Figures PINR SHOWS but never scores: Jupiter's token data, Stonk.fun's own ledger, DexScreener's paid
orders. Read once a score (first scores and follow-ups: the coins PINR shows), returned as finished contract facts with
their receipt (`source`, `read_at`, `link`), kept in the result as `shown` and written by the exporter beside the score's
own facts. Nothing here reaches `pinr_index`: scoring from these needs a rules version first.

Shapes are the ones read on 2026-10-18 (one sample per endpoint on the operator's yes;
`tools/profiles/2026-10-18-shown-facts-samples.json`), plus Stonk.fun's documented row fields where the sample coin had
none. Whole or nothing per answer: an answer that is missing or not that shape gives no facts from it, never a part or a
guess; a field the answer leaves out is not written (missing stays missing).

Jupiter: `api.jup.ag` (a design decision; the old `lite-api` is being phased out), `x-api-key` from the engine's `.env`
(`JUPITER_API`, the same name as the feed server's) when it is there, keyless otherwise. Jupiter's search also matches names and symbols (its docs), so only
the record whose `id` is the mint itself is used.
"""
from __future__ import annotations
import datetime, json, os, urllib.error, urllib.request

JUPITER = "https://api.jup.ag"
STONK = "https://www.stonkfun.xyz"
DEX = "https://api.dexscreener.com"
LINK_JUP = "https://jup.ag/tokens/%s"
LINK_STONK = "https://www.stonkfun.xyz/token/%s"
LINK_DEX = "https://dexscreener.com/solana/%s"
KEY_NAME = "JUPITER_API"            # the .env line's name, the same as the feed server's


def _key() -> str | None:
    try:
        import solana_rpc
        v = solana_rpc._ENV.get(KEY_NAME)
    except Exception:
        v = None
    v = v or os.environ.get(KEY_NAME)
    return v.strip() if isinstance(v, str) and v.strip() else None


def jupiter_headers() -> dict:
    """The header Jupiter's gateway wants when PINR has a key; none when keyless. The value is never logged."""
    k = _key()
    return {"x-api-key": k} if k else {}


def _count(url: str, answered: bool) -> None:
    try:
        import solana_rpc
        solana_rpc.count(solana_rpc.label(url), answered)
    except Exception:
        pass


def _get(url: str, headers: dict | None = None):
    """(status, answer): the HTTP status and the JSON body, or (status, None) when the body is not JSON; (None, None) when
    there was no answer at all. One try: these reads are shown, never needed for a score."""
    req = urllib.request.Request(url, headers=dict({"accept": "application/json", "user-agent": "PINR scanner"}, **(headers or {})))
    try:
        with urllib.request.urlopen(req, timeout=10) as r:
            body = json.load(r)
        _count(url, True)
        return r.status, body
    except urllib.error.HTTPError as e:
        _count(url, e.code == 404)                  # a 404 is an answer ("none"), not a failure
        return e.code, None
    except Exception:
        _count(url, False)
        return None, None


def _now() -> str:
    return datetime.datetime.now(datetime.timezone.utc).replace(microsecond=0).isoformat()


def _num(v):
    return v if isinstance(v, (int, float)) and not isinstance(v, bool) else None


def _fact(out: list, id_, label, value, unit, source, read_at, link, **extra) -> None:
    if value is None or not read_at or not link:
        return
    f = {"id": id_, "label": label, "value": value, "unit": unit, "source": source, "read_at": read_at, "link": link}
    f.update({k: v for k, v in extra.items() if v is not None})
    out.append(f)


# ------------------------------------------------------------------ Jupiter Tokens v2
def jupiter_facts(mint: str, get=_get, now=_now) -> list:
    st, ans = get(f"{JUPITER}/tokens/v2/search?query={mint}", jupiter_headers())
    if st != 200 or not isinstance(ans, list):
        return []
    rec = next((r for r in ans if isinstance(r, dict) and r.get("id") == mint), None)   # a search: the exact mint only
    if rec is None:
        return []
    at, link, out = now(), LINK_JUP % mint, []
    _fact(out, "holder_count", "Holders", _num(rec.get("holderCount")), "wallets", "Jupiter", at, link)
    audit = rec.get("audit") if isinstance(rec.get("audit"), dict) else {}
    top = _num(audit.get("topHoldersPercentage"))
    _fact(out, "top_holders_share", "Top holders' share", None if top is None else round(top, 2), "percent", "Jupiter", at, link)
    _fact(out, "dev_mints", "Coins minted by the dev (Jupiter's count)", _num(audit.get("devMints")), "tokens created", "Jupiter", at, link)
    for key, id_, label in (("mintAuthorityDisabled", "mint_authority_jupiter", "Mint authority (Jupiter's audit)"),
                            ("freezeAuthorityDisabled", "freeze_authority_jupiter", "Freeze authority (Jupiter's audit)")):
        v = audit.get(key)
        _fact(out, id_, label, ("disabled" if v else "enabled") if isinstance(v, bool) else None, "text", "Jupiter", at, link)
    score, band = _num(rec.get("organicScore")), rec.get("organicScoreLabel")
    _fact(out, "organic_score", "Organic score", score, "of 100", "Jupiter", at, link,
          band=band if band in ("high", "medium", "low") else None)
    v = rec.get("isVerified")
    _fact(out, "jupiter_verified", "Verified on Jupiter", ("yes" if v else "no") if isinstance(v, bool) else None, "text", "Jupiter", at, link)
    s24 = rec.get("stats24h") if isinstance(rec.get("stats24h"), dict) else {}
    _fact(out, "buys_24h", "Buys (24 h)", _num(s24.get("numBuys")), "trades", "Jupiter", at, link)
    _fact(out, "sells_24h", "Sells (24 h)", _num(s24.get("numSells")), "trades", "Jupiter", at, link)
    _fact(out, "traders_24h", "Traders (24 h)", _num(s24.get("numTraders")), "wallets", "Jupiter", at, link)
    return out


# ------------------------------------------------------------------ Stonk.fun's own ledger (Stonk.fun coins only)
def _amount(block: dict):
    """A paid figure from Stonk.fun's `rewards` block: tokens when decimals were known, else None (the raw integer is
    not a figure a person reads)."""
    return _num(block.get("distributedTokens")) if isinstance(block, dict) else None


def stonkfun_facts(mint: str, get=_get, now=_now) -> tuple[list, dict | None]:
    out, links, link = [], None, LINK_STONK % mint
    st, ans = get(f"{STONK}/api/public/v1/tokens/{mint}")
    data = ans.get("data") if st == 200 and isinstance(ans, dict) and isinstance(ans.get("data"), dict) else None
    creator = None
    if data is not None:
        at = now()
        tok = data.get("token") if isinstance(data.get("token"), dict) else {}
        launch = data.get("launch") if isinstance(data.get("launch"), dict) else {}
        tf = tok.get("transferFee") if isinstance(tok.get("transferFee"), dict) else launch.get("transferFee")
        bps = _num(tf.get("bps")) if isinstance(tf, dict) else None
        _fact(out, "launchpad_transfer_fee", "Transfer fee (Stonk.fun's record)", bps, "basis points", "Stonk.fun", at, link)
        c = launch.get("creator")
        creator = c if isinstance(c, str) and 32 <= len(c) <= 44 else None
    if creator:
        st, ans = get(f"{STONK}/api/public/v1/launches?creator={creator}&pageSize=1")
        pg = ans.get("data", {}).get("pagination") if st == 200 and isinstance(ans, dict) and isinstance(ans.get("data"), dict) else None
        if isinstance(pg, dict):
            _fact(out, "stonkfun_launches", "Launches by the creator on Stonk.fun", _num(pg.get("total")), "tokens created",
                  "Stonk.fun", now(), f"https://solscan.io/account/{creator}")
    st, ans = get(f"{STONK}/api/v2/tokens/{mint}/rewards")
    if st == 200 and isinstance(ans, dict) and ans.get("basis") == "ledger" and isinstance(ans.get("rewards"), dict):
        at, rw = now(), ans["rewards"]
        sym = ans.get("quote", {}).get("symbol") if isinstance(ans.get("quote"), dict) else None
        if isinstance(sym, str) and sym:
            _fact(out, "rewards_paid", "Rewards paid to holders", _amount(rw), sym, "Stonk.fun", at, link)
        _fact(out, "rewards_payouts", "Payouts", _num(rw.get("payoutCount")), "payouts", "Stonk.fun", at, link)
        _fact(out, "rewards_wallets_paid", "Wallets paid", _num(rw.get("walletsPaid")), "wallets", "Stonk.fun", at, link)
        last = rw.get("lastPayoutAt")
        _fact(out, "rewards_last_payout", "Last payout", last if isinstance(last, str) and last[:2] == "20" else None, "time", "Stonk.fun", at, link)
    st, ans = get(f"{STONK}/api/v2/tokens/{mint}/rewards/fee-recipients?limit=100")
    if st == 200 and isinstance(ans, dict) and isinstance(ans.get("rows"), list):
        at, rows = now(), [r for r in ans["rows"] if isinstance(r, dict)]
        _fact(out, "fee_recipients", "Fee recipients", _num(ans.get("recipientCount")), "wallets", "Stonk.fun", at, link)
        whole = ans.get("page", {}).get("nextCursor") is None if isinstance(ans.get("page"), dict) else False
        mine = [_num(r.get("shareBps")) for r in rows if r.get("isCreator") is True]
        if whole and rows and all(v is not None for v in mine):          # every row read, every creator share given
            _fact(out, "fee_share_creator", "Fee share to the creator", sum(mine), "basis points", "Stonk.fun", at, link)
    st, ans = get(f"{STONK}/api/v2/tokens/{mint}/socials")
    if st == 200 and isinstance(ans, dict):
        got = {k: ans[s] for k, s in (("website", "website"), ("x", "twitter"), ("telegram", "telegram"))
               if isinstance(ans.get(s), str) and ans[s].startswith(("https://", "http://"))}
        if got:
            links = dict(got, source="Stonk.fun", read_at=now())
    return out, links


def stonkfun_platforms(get=_get) -> dict | None:
    """Stonk.fun's own LaunchLab platform accounts by mode, {"standard": id, ...}; None when not read whole. A lead to
    compare with the engine's list, never trusted alone: each id is still checked on chain."""
    st, ans = get(f"{STONK}/api/public/v1/launchlab/platforms")
    p = ans.get("data", {}).get("platform") if st == 200 and isinstance(ans, dict) and isinstance(ans.get("data"), dict) else None
    if not isinstance(p, dict) or not p or not all(isinstance(v, str) and 32 <= len(v) <= 44 for v in p.values()):
        return None
    return dict(p)


# ------------------------------------------------------------------ DexScreener: did the coin pay for promotion
def dexscreener_facts(mint: str, get=_get, now=_now) -> list:
    st, ans = get(f"{DEX}/orders/v1/solana/{mint}")
    if st != 200 or not isinstance(ans, dict) or not isinstance(ans.get("orders"), list) or not isinstance(ans.get("boosts"), list):
        return []
    at, link, out = now(), LINK_DEX % mint, []
    orders = ans["orders"]
    kinds = [o.get("type") for o in orders if isinstance(o, dict)]
    if len(kinds) == len(orders) and all(isinstance(k, str) and k for k in kinds):      # an order without its type: not written
        _fact(out, "dex_paid_orders", "Paid DexScreener orders", len(orders), "orders", "DexScreener", at, link,
              kinds=sorted(set(kinds)) or None)
    _fact(out, "dex_boosts", "DexScreener boosts", len(ans["boosts"]), "boosts", "DexScreener", at, link)
    return out


# ------------------------------------------------------------------ one call a score
def switched_on(path=None) -> bool:
    """`shown_reads` in scanner/settings.json: "off" stops these reads (the scores go on); anything else, or no setting, is on."""
    try:
        import solana_rpc
        with open(path or solana_rpc.SETTINGS) as f:
            return str(json.load(f).get("shown_reads", "on")).lower() != "off"
    except Exception:
        return True


def read_all(mint: str, stonkfun: bool, get=_get, now=_now) -> dict:
    """Every shown figure for one coin: {"facts": [...], "launchpad_links": {...} | None}. Never raises: a reader that
    fails gives nothing, and the score goes on without it."""
    facts, links = [], None
    for fn in (jupiter_facts, dexscreener_facts):
        try:
            facts += fn(mint, get, now)
        except Exception:
            pass
    if stonkfun:
        try:
            f, links = stonkfun_facts(mint, get, now)
            facts += f
        except Exception:
            pass
    return {"facts": facts, "launchpad_links": links}
