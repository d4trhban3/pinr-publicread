"""Stage 4: score a BNB Chain launchpad token (Flap.sh or four.meme) with the same engine and rules as Solana.
Readings that EVM can't provide yet are UNKNOWN, never guessed (dev launch counts / track record need a paid
history service; linked wallets on EVM are not built yet). Every number carries a receipt."""
from __future__ import annotations
import calendar, glob, json, os, sys, time, urllib.request
HERE = os.path.dirname(os.path.abspath(__file__))
for p in ("../stage2", "../stage3", "../pinr-score"):
    sys.path.insert(0, os.path.join(HERE, p))
import score_engine_v1 as E
from readers import Log, http_json, metadata_document
from evm import rpc, call, selector, enc_address, words, dec
import flap_reader as FL
from evm_linked import dev_group as evm_dev_group
import fourmeme_reader as FM
from grok_relay import validate as grok_validate, extract_json as grok_json, all_answer_paths as relay_answers
from website_checks import check_website
import social_wait as _SW
import solana_rpc as _S

RESULTS = os.path.join(HERE, "results")
os.makedirs(RESULTS, exist_ok=True)



def counts(out: dict) -> bool:
    """A result worth showing: a score, or a proven label. "Technical error, retrying" and the like are not (checklist 7,
    the team 2026-10-25: error text is never a coin's public note; the coin keeps what it showed and is tried again)."""
    try:
        sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "feed"))
        from feed_export import NO_SCORE_LABELS
    except Exception:
        NO_SCORE_LABELS = ("VAMP", "BOT/RUG", "MAYHEM", "HONEYPOT")
    if not isinstance(out, dict) or "error" in out:
        return False
    s = out.get("score")
    if isinstance(s, int) and not isinstance(s, bool) and 1 <= s <= 99:
        return True
    return out.get("label") in NO_SCORE_LABELS or str(out.get("display") or "") in NO_SCORE_LABELS


def _write_result(token: str, out: dict) -> None:
    """The score's result file, and the coin's feed file only when the result counts (a failed score never replaces what
    the coin showed; checklist 7)."""
    if not counts(out):
        return
    json.dump(out, open(os.path.join(RESULTS, f"{token}.json"), "w"), indent=1, default=str)
    _feed(out)


SINK = [_write_result]        # chains/score.py puts its guarded writer here (a failed score replaces nothing)


def _feed(out: dict) -> None:
    """Update this token's file for the live app (data contract v1.0). Never breaks scoring if it fails."""
    try:
        sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "feed"))
        from feed_export import export_one
        export_one(json.loads(json.dumps(out, default=str)))
    except Exception as e:
        print(f"(live-app feed not updated for {out.get('mint')}: {type(e).__name__})")



def _people(chain: str, wallets, log: Log):
    """contracts are launch bots / services, never people. Returns (people, hidden, receipts):
    hidden = every named dev wallet is a contract, with each contract's code as the receipt."""
    from evm_linked import is_route
    people, bots = [], []
    for w in sorted({w.lower() for w in wallets if w}):
        code = rpc(chain, "eth_getCode", [w, "latest"])
        if isinstance(code, str) and is_route(code):
            bots.append((w, code))
        else:
            people.append(w)                     # a wallet (or unreadable: the dev readers will report that)
    receipts = tuple(E.Receipt(f"eth_getCode({w})", f"{(len(code) - 2) // 2} bytes of contract code", "contract", "read time", True)
                     for w, code in bots)
    if bots:
        log.add("launched through a contract (launch bot / service), not a person", [w for w, _ in bots], "addresses", "eth_getCode")
    return people, (not people and bool(bots)), receipts

def _dev_launch_history(chain: str, wallets, token: str, log: Log, notes: list):
    """Redacted in the public copy."""
    raise NotImplementedError("redacted: proprietary PINR logic is not included in the public copy")

def flap_links(meta_cid: str | None):
    if not meta_cid:
        return None
    url = meta_cid if meta_cid.startswith("http") else "https://ipfs.io/ipfs/" + meta_cid
    j = metadata_document(url)                     # the team's F1 on c7255ae3: the gateways not resting, one try each
    if not j:
        return None
    pick = lambda k: (j.get(k) or "").strip() or None
    return {"name": j.get("name"), "symbol": j.get("symbol"), "image": j.get("image"),
            "twitter": pick("twitter"), "website": pick("website"), "telegram": pick("telegram")}


def goplus(token: str):
    j = http_json(f"https://api.gopluslabs.io/api/v1/token_security/56?contract_addresses={token}", tries=2)
    return ((j or {}).get("result") or {}).get(token.lower())


def sampled_prices(lp: str, token: str, first_block: int, head: int, graduated_pool: str | None, n: int = 40):
    """Price at n evenly spaced past blocks (archive reads). The peak found is a LOWER bound on the true peak, which only
    ever makes 'pump retained' look better for the token; the dump rule is applied only when conclusive."""
    blocks = sorted({first_block + 1 + (head - first_block - 1) * i // (n - 1) for i in range(n)})
    def price_at(b):
        if lp == "flap":
            st = FL.state(token, hex(b))
            if st and st["status"] == 1:
                return st["price"] / 1e18
        else:
            st = FM.info(token, hex(b))
            if st and not st["liquidityAdded"]:
                return st["lastPrice"] / 1e18 or None
        if graduated_pool:
            res = call("bsc", graduated_pool, "0x" + selector("getReserves()"), hex(b))
            t0 = call("bsc", graduated_pool, "0x" + selector("token0()"), hex(b))
            if res and t0:
                r0, r1 = dec(words(res)[0], "uint256"), dec(words(res)[1], "uint256")
                tr, qr = (r0, r1) if ("0x" + t0[-40:]).lower() == token.lower() else (r1, r0)
                return qr / tr if tr else None
        return None
    return [(b, p) for b, p in zip(blocks, _S.pmap(price_at, blocks)) if p]


def social_and_site(token: str, links: dict | None, launch_ts, names: tuple, links_source: str, log: Log):
    """Redacted in the public copy."""
    raise NotImplementedError("redacted: proprietary PINR logic is not included in the public copy")


def score_token(launchpad: str, token: str) -> dict:
    """BNB token, every current-state read pinned to one block (so all free providers describe the same moment)."""
    import evm
    evm.pin("bsc")
    try:
        return _score_token(launchpad, token)
    finally:
        evm.unpin("bsc")


def _score_token(launchpad: str, token: str) -> dict:
    """Redacted in the public copy."""
    raise NotImplementedError("redacted: proprietary PINR logic is not included in the public copy")


def borrowed_post(post_url: str | None, launcher: str | None) -> str | None:
    """the account whose post the token links, when it is NOT the launcher the launchpad recorded.
    Handles compare exactly (case-insensitive): a look-alike such as ig0ryuzo vs igoryuzo is a different account."""
    import re
    m = re.search(r"(?:x|twitter)\.com/([^/?#]+)/status/", post_url or "", re.I)
    if not m or not launcher:
        return None
    return m.group(1) if m.group(1).lower() != launcher.strip().lstrip("@").lower() else None


def _profile(launchpad: str, token: str, r: dict) -> dict:
    """Redacted in the public copy."""
    raise NotImplementedError("redacted: proprietary PINR logic is not included in the public copy")


def score_clanker(token: str) -> dict:
    return score_base("clanker", token)


def score_clanker_old(token: str) -> dict:
    return score_base("clanker_old", token)


def score_zora(token: str) -> dict:
    return score_base("zora", token)


def score_bankr(token: str) -> dict:
    return score_base("bankr", token)


READ_CREATION: dict = {}             # token -> the creation the reader found ({"tx", "block"}), for chains/score.py (checklist 6)


def score_base(launchpad: str, token: str) -> dict:
    """Base token, every current-state read pinned to one block (so all free providers describe the same moment)."""
    import evm
    evm.pin("base")
    try:
        return _score_base(launchpad, token)
    finally:
        evm.unpin("base")


def _score_base(launchpad: str, token: str) -> dict:
    """Redacted in the public copy."""
    raise NotImplementedError("redacted: proprietary PINR logic is not included in the public copy")
