"""PINRbot v1, launch item 4 (a design decision; `pinrbot/V1-PROPOSAL.md`, PINRBOT d9c8562f).

Five steps for one coin:
  gather  - this module: one evidence bundle, every item with an id, from what PINR already read for the score (the
            score's own receipts, chain reads marked on-chain), the coin's own launchpad description and website (216(2):
            the developer's words), the X posts that passed the quote check, the funding trace (215)
  reason  - the first-pass model (`pinrbot_model`, Claude Haiku 5.5 by default) answers in the design's fixed kinds only,
            each item citing bundle ids (JSON constrained to the kinds by the API's structured output)
  check   - this module, before anything is decided: an id not in the bundle voids the item; each kind needs its kind of
            evidence (words alone never earn an up-item; up-items need an on-chain item); 216(1): where the design's fee
            bonus fired, `fees_to_project_wallet_spent` stands aside. Every dropped item is kept with its reason.
  decide  - `stage3/intent.py`, unchanged
  review  - the review model (`pinrbot_review_model`, Claude Opus 5.5 by default) on a move of `escalate_move_at` or more
            and on every BOT/RUG recommendation: only items it calls "supported" count; an off-list
            answer is "needs_more_evidence"
  show    - launch item 7 (the reading is kept in the result as `pinrbot`)

Money (212(k)): off unless `pinrbot` is "on", `pinrbot_daily_dollar_cap` is a dollar figure above 0 and the engine's
.env holds ANTHROPIC_API_KEY. Before every call the most it can cost is set aside against the day's cap in the same
locked transaction as the check (index/requests.sqlite, as x_api.py does); a call that would pass the cap is not sent and
the coin's reading is "not read". After the answer, the set-aside is settled to the tokens the API reports. The key is
never printed, logged or written.

Cache (216(3)): the reading is kept per coin (index/pinrbot/<mint>.json) until the coin's next score, and is stale at once
when a new X check of the coin arrives (`cached`).

Plain HTTP (urllib), like every other reader in the engine: the engine installs no package and its tests run on
Python 3.9.
"""
from __future__ import annotations
import hashlib, json, os, re, sqlite3, sys, time, urllib.error, urllib.request
from typing import Callable, Optional

HERE = os.path.dirname(os.path.abspath(__file__))
ENGINE = os.path.dirname(HERE)
REPO = os.path.dirname(os.path.dirname(ENGINE))
sys.path[:0] = [HERE, os.path.join(ENGINE, "pinr-score")]
import score_engine_v1 as E
import intent as I

SETTINGS = os.path.join(ENGINE, "scanner", "settings.json")
SPEND_DB = os.path.join(ENGINE, "index", "requests.sqlite")
CACHE_DIR = os.path.join(ENGINE, "index", "pinrbot")
PROPOSAL = os.path.join(REPO, "pinrbot", "V1-PROPOSAL.md")
CALIBRATION = os.path.join(REPO, "pinrbot", "CALIBRATION.md")
SCAN_DIR = os.path.join(REPO, "marketing", "scan-output")
POOLS_DIR = os.path.join(ENGINE, "frontend-feed", "pools")   # each listed coin's pool events (scanner/sqd_live.py)
POOL_ITEMS = 40                                              # a coin's newest pool events in one bundle
API = "https://api.anthropic.com/v1/messages"

FIRST_MAX_TOKENS = 8000          # the first pass's ceiling (thinking counts as output)
REVIEW_MAX_TOKENS = 8000
BUNDLE_MAX_ITEMS = 160
VALUE_MAX_CHARS = 600
CHARS_PER_TOKEN = 3.0            # a cautious guess for the set-aside: fewer characters a token than English prose

KINDS = tuple(I.DOWN) + ("coordinated_manipulation",) + tuple(I.UP) + tuple(I.OBSERVED)
# what the coin's pool did, as observed kinds: shown, never scored. Each
# needs a cited pool event of its own kind (the transaction PINR read); "by the creator" needs that event's wallet to be
# named in a cited chain read of the creator or the dev group too.
POOL_KINDS = {"pool_liquidity_removed_by_creator": ("liquidity removed", True),
              "pool_liquidity_added_by_creator": ("liquidity added", True),
              "pool_buyback_burn": ("bought back and burned", False)}
CREATOR_READS = ("creator (", "dev group (")
WORDS = ("description", "website", "post")
# What each kind needs among the items it cites (proposal section 3). "own_words": the coin's own description or website
# (216(2)) or a post by the coin's own account (rule 6); "chain": an item PINR read on chain itself; "fact": chain or a
# record; "removed_post": a post marked removed on a re-read; the three outside sources are not gathered in v1, so those
# kinds are always dropped with that reason.
NEEDS = {
    "deleted_posts_after_dump": ("removed_post", "chain"),
    "misleading_claim": ("own_words", "fact"),
    "words_contradict_actions": ("own_words", "chain"),
    "fake_partnership": ("own_words", "partner_source"),
    "impersonation": ("own_words", "original_source"),
    "fake_audit": ("own_words", "auditor_list"),
    "confirmed_drainer": ("chain",),
    "coordinated_manipulation": ("cluster",),
    "vesting_lock": ("reads",),
    "fees_to_project_wallet_spent": ("reads",),
    "preannounced_sells_match": ("own_words", "reads"),
    "gradual_selling": ("reads",),
    "survived_30d": ("reads",),
    **{k: ("pool",) for k in POOL_KINDS},
}
# On-chain only from PINR's own read names: the source must START with one of these standard method
# names, or name a transaction by its full signature. A word found elsewhere in a source (a creator's URI, a page) never
# makes an item on-chain.
CHAIN_METHODS = ("getAccountInfo", "getSignaturesForAddress", "getTransaction", "getTokenLargestAccounts", "getProgramAccounts",
                 "getTokenAccountsByOwner", "getMultipleAccounts")
_SIG = r"[1-9A-HJ-NP-Za-km-z]{64,90}"
_CHAIN_RE = re.compile(r"^(?:(?:" + "|".join(CHAIN_METHODS) + r")\b|(?:tx|CREATE tx|Pump\.fun creation transaction) " + _SIG + r"\b)")
# each up kind with the chain reads PINR itself makes that can show it, by the score's own log names. An
# up-item counts only when, for every group listed for its kind, it cites at least one read whose name starts with one of
# the group's names; otherwise the code drops it with the reason. PINR makes no read of a vesting lock today, so
# `vesting_lock` has no reads and is always dropped, said so. Down kinds are unchanged.
UP_READS = {
    "vesting_lock": (),
    "fees_to_project_wallet_spent": (("fee reason", "fees paid to the dev group"),),
    "preannounced_sells_match": (("dev conduct (group)",),),
    "gradual_selling": (("dev conduct (group)",),),
    "survived_30d": (("launch time (launch transaction)", "launch time (oldest mint transaction)"),
                     ("pump history (launch, peak, now)", "Pump curve state", "LaunchLab pool state", "real money in pool",
                      "real money on curve")),
}
PINR_READS = tuple(n for groups in UP_READS.values() for g in groups for n in g)
# A named read that the score can also log from an outside figure counts only with PINR's own source (the team's W2,
# item 19): "real money in pool" only from PINR's own vault read, never DexScreener's quote-side liquidity line.
READ_SOURCES = {"real money in pool": ("vault ",)}
# the team's F3(b): "fee reason" is a chain read only when its case was found on the collector's own transactions
# ("reason_found", "no_reason"); "none" (no fee, or the mint not read), "not_checked" and the rewards-program cases are not.
READ_VALUES = {"fee reason": ("reason_found", "no_reason")}


def _named_read(what, source, value=None) -> bool:
    if not (isinstance(what, str) and what.startswith(PINR_READS)):
        return False
    need = next((v for k, v in READ_SOURCES.items() if what.startswith(k)), None)
    if need is not None and not (isinstance(source, str) and source.startswith(need)):
        return False
    vals = next((v for k, v in READ_VALUES.items() if what.startswith(k)), None)
    return vals is None or value in vals

OUTSIDE_CLASSES = ("partner_source", "original_source", "auditor_list")
REVIEW_VERDICTS = ("supported", "not_supported", "needs_more_evidence")


# ------------------------------------------------------------------ settings, key, instructions, calibration
CONTROL = os.path.join(ENGINE, "control", "control.json")   # pinr.io/control's file (PINRai's on/off and cap)
CONTROL_CAP_MAX = 25.0                                       # the most a day /control may set


def settings(path=None, control_path=None) -> tuple:
    """(config, None) when PINRbot may run; (None, why) when it must not. a design decision (PINRai) and 243: pinr.io/control's
    `pinrai.on` wins over the setting (off always stops it), and its `pinrai.daily_dollar_cap` (above 0, at most
    CONTROL_CAP_MAX) replaces the setting's cap."""
    try:
        s = json.load(open(path or SETTINGS))
    except Exception:
        return None, "settings unreadable: PINRbot off"
    try:
        ctl = json.load(open(control_path or CONTROL)).get("pinrai") or {}
    except Exception:
        ctl = {}
    if not isinstance(ctl, dict):
        ctl = {}
    if ctl.get("on") is False:
        return None, "PINRai off (pinr.io/control)"
    if s.get("pinrbot") != "on" and ctl.get("on") is not True:
        return None, "PINRbot off (setting)"
    cap = s.get("pinrbot_daily_dollar_cap")
    cc = ctl.get("daily_dollar_cap")
    if isinstance(cc, (int, float)) and not isinstance(cc, bool) and 0 < cc <= CONTROL_CAP_MAX:
        cap = cc
    if isinstance(cap, bool) or not isinstance(cap, (int, float)) or cap <= 0:
        return None, "pinrbot_daily_dollar_cap not set (the operator's figure, 212(k)): PINRbot off"
    prices = s.get("pinrbot_prices_per_mtok") or {}
    first, review = s.get("pinrbot_model"), s.get("pinrbot_review_model")
    for m in (first, review):
        p = prices.get(m) if isinstance(m, str) else None
        if not (isinstance(p, list) and len(p) == 2 and all(isinstance(x, (int, float)) and x > 0 for x in p)):
            return None, f"no usable price for model {m!r} in pinrbot_prices_per_mtok: PINRbot off"
    effort = s.get("pinrbot_effort") or "medium"
    review_effort = s.get("pinrbot_review_effort") or "high"
    return {"cap": float(cap), "model": first, "review_model": review, "prices": prices,
            "effort": effort, "review_effort": review_effort}, None


def api_key() -> str:
    """ANTHROPIC_API_KEY from the engine's .env (never printed)."""
    path = os.path.join(ENGINE, ".env")
    if os.path.exists(path):
        for line in open(path):
            line = line.strip()
            if line.startswith("ANTHROPIC_API_KEY="):
                return line.split("=", 1)[1].strip().strip('"').strip("'")
    return ""


def instructions(path=None) -> tuple:
    """Redacted in the public copy."""
    raise NotImplementedError("redacted: proprietary PINR logic is not included in the public copy")


def calibration(path=None) -> tuple:
    """Redacted in the public copy."""
    raise NotImplementedError("redacted: proprietary PINR logic is not included in the public copy")


# ------------------------------------------------------------------ the operator's teaching examples
TEACHING = os.path.join(ENGINE, "PINRAI-TEACHING.jsonl")   # beside TEACHING-EXAMPLES.md; written by control/server.mjs only
TEACH_MAX = 2000                 # characters an example may hold
TEACH_IN_PROMPT = 40             # the newest examples a reading or an answer reads
TEACH_NOTE = ""  # redacted in the public copy


def teaching(path=None) -> list:
    """[{id, at, who, coin, text}] in the order kept; a damaged line is skipped, never guessed."""
    out = []
    try:
        lines = open(path or TEACHING, encoding="utf-8").read().splitlines()
    except Exception:
        return out
    for line in lines:
        try:
            t = json.loads(line)
        except Exception:
            continue
        if isinstance(t, dict) and isinstance(t.get("id"), str) and isinstance(t.get("text"), str):
            out.append({"id": t["id"], "at": t.get("at"), "who": t.get("who"), "coin": t.get("coin"), "text": t["text"][:TEACH_MAX]})
    return out


def teaching_block(path=None) -> list:
    """The newest examples as PINRai reads them: [{"coin", "text"}], oldest first."""
    return [{"coin": t.get("coin"), "text": t["text"]} for t in teaching(path)[-TEACH_IN_PROMPT:]]


# ------------------------------------------------------------------ gather
def _is_chain(source) -> bool:
    return isinstance(source, str) and bool(_CHAIN_RE.match(source))


# What the creator chose: the coin's metadata address and document, its name and ticker, its own
# links and website. However PINR read it, even with getAccountInfo, it is the creator's own record, never an on-chain
# receipt; it counts as the developer's own words (216(2)).
CREATOR_CHOSEN = ("token's own", "token links", "token metadata", "name and ticker", "website", "real website")


def _creator_chosen(what) -> bool:
    return isinstance(what, str) and what.lower().startswith(CREATOR_CHOSEN)


def _short(v) -> str:
    s = v if isinstance(v, str) else json.dumps(v, default=str, ensure_ascii=False)
    return s if len(s) <= VALUE_MAX_CHARS else s[:VALUE_MAX_CHARS] + " [cut]"


def _handle(url: Optional[str]) -> Optional[str]:
    m = re.search(r"(?:x|twitter)\.com/@?([A-Za-z0-9_]{1,15})", str(url or ""))
    return m.group(1).lower() if m else None


def _pool_items(mint: str, pools_dir: Optional[str] = None) -> list:
    """the coin's newest pool events as chain items (who added or removed liquidity and when, the pool's
    creation, a creator change, buy-backs), each with its transaction as the receipt; [] when none were read."""
    try:
        evs = json.load(open(os.path.join(pools_dir or POOLS_DIR, mint + ".json"))).get("events") or []
    except Exception:
        return []
    out = []
    for n, e in enumerate([e for e in evs if isinstance(e, dict) and e.get("sig") and e.get("kind")][-POOL_ITEMS:], 1):
        unit = " (raw units)" if e.get("raw") else ""
        parts = [f"{e['base']} coin tokens{unit}" if e.get("base") is not None else None,
                 f"{e['quote']} of the quote coin{unit}" if e.get("quote") is not None else None,
                 f"by {e['user']}" if e.get("user") else None,
                 f"creator {e.get('old_coin_creator')} to {e.get('new_coin_creator')}" if e.get("new_coin_creator") else None]
        out.append({"id": f"q{n}", "class": "chain", "what": f"pool: {e['kind']}", "value": _short(", ".join(x for x in parts if x) or e["kind"]),
                    "source": f"tx {e['sig']}", "as_of": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(e["t"] / 1000)) if isinstance(e.get("t"), (int, float)) else None,
                    "on_chain": True})
    return out


def gather(mint: str, log_items: list, own: Optional[dict], scan_dir: Optional[str] = None, pools_dir: Optional[str] = None) -> list:
    """One bundle: [{"id", "class", "what", "value", "source", "as_of", "on_chain", "own_account"?, "removed"?}]."""
    bundle = []
    own = own or {}
    if own.get("description"):
        bundle.append({"id": "d1", "class": "description", "what": "the coin's own description (its launchpad record)",
                       "value": _short(own["description"]), "source": "the coin's own record", "as_of": None, "on_chain": False})
    if own.get("website"):
        bundle.append({"id": "w1", "class": "website", "what": "the coin's own website (address only in v1)",
                       "value": _short(own["website"]), "source": "the coin's own record", "as_of": None, "on_chain": False})
    if own.get("twitter"):                            # the record's X account or post, the dev's own words
        bundle.append({"id": "x1", "class": "xlink", "what": "the coin's own X link (its launchpad record)",
                       "value": _short(own["twitter"]), "source": "the coin's own record", "as_of": None, "on_chain": False})
    own_handle = _handle(own.get("twitter"))
    try:
        scan = json.load(open(os.path.join(scan_dir or SCAN_DIR, mint + ".json")))
        checked = bool(((scan.get("sources") or {}).get("x") or {}).get("quotes_checked_by"))
    except Exception:
        scan, checked = {}, False
    n = 0
    for c in (scan.get("claims") or []) if checked else []:
        if not isinstance(c, dict) or not c.get("quote") or c.get("post_status") not in ("present", "removed"):
            continue
        n += 1
        handle = str(c.get("handle") or "").lstrip("@").lower()
        bundle.append({"id": f"p{n}", "class": "post", "what": f"post by {c.get('handle')} ({c.get('kind')})",
                       "value": _short(c["quote"]), "source": c.get("post_url"), "as_of": c.get("posted_at"), "on_chain": False,
                       "own_account": bool(own_handle) and handle == own_handle, "removed": c.get("post_status") == "removed"})
    bundle += _pool_items(mint, pools_dir)
    k = 0
    for it in log_items or []:
        if not isinstance(it, dict) or it.get("value") in (None, "", [], {}):
            continue
        k += 1
        mine = _creator_chosen(it.get("what"))
        named = _named_read(it.get("what"), it.get("source"), it.get("value"))
        chain = not mine and (named or _is_chain(it.get("source")))
        cls = "creator" if mine else ("chain" if chain else "record")
        bundle.append({"id": f"c{k}" if chain else (f"m{k}" if mine else f"r{k}"), "class": cls, "what": str(it.get("what")),
                       "value": _short(it.get("value")), "source": str(it.get("source"))[:200], "as_of": it.get("as_of"),
                       "on_chain": chain})
        if len(bundle) >= BUNDLE_MAX_ITEMS:
            break
    return bundle


# ------------------------------------------------------------------ check (the code drops what has no receipt)
def _has_reads(kind: str, cited: list) -> bool:
    groups = UP_READS.get(kind) or ()
    return bool(groups) and all(any(c["on_chain"] and str(c["what"]).startswith(g) for c in cited) for g in groups)


# the X link a coin's own launchpad record lists counts as the developer's own words beside the description
# and website, for these kinds only; never a chain read, never for an up-item (217).
XLINK_KINDS = ("misleading_claim", "words_contradict_actions", "impersonation")


def _is_xlink(c: dict) -> bool:
    return c["class"] == "xlink" or (c["class"] == "creator" and str(c["what"]).lower().startswith("token's own twitter link"))


# a design decision as written: which creator-chosen content counts as the developer's own words,
# and for which kinds. Telegram, the metadata address and document, the name and ticker count for no kind until a decision
# says so. A post by the coin's own account (rule 6) is not creator-chosen content and keeps counting as before.
DESC_SITE_KINDS = ("misleading_claim", "words_contradict_actions", "fake_partnership", "fake_audit", "impersonation")   # 222(c)
OWN_WORDS_KINDS = {"description": DESC_SITE_KINDS,
                   "website": DESC_SITE_KINDS,
                   "xlink": DESC_SITE_KINDS}                   # item 43: the X link like the description and website


def _creator_words(c: dict) -> str | None:
    """Which kind of the developer's own words a bundle item is, or None."""
    if _is_xlink(c):
        return "xlink"
    if c["class"] in ("description", "website"):
        return c["class"]
    if c["class"] == "creator" and str(c["what"]).lower().startswith("token's own website link"):
        return "website"
    return None


def _has(need: str, cited: list, kind: str = "") -> bool:
    if need == "chain":
        return any(c["on_chain"] for c in cited)
    if need == "fact":
        return any(c["class"] in ("chain", "record") for c in cited)
    if need == "own_words":
        return any((c["class"] == "post" and c.get("own_account"))
                   or kind in OWN_WORDS_KINDS.get(_creator_words(c) or "", ()) for c in cited)
    if need == "removed_post":
        return any(c["class"] == "post" and c.get("removed") for c in cited)
    if need == "cluster":
        return sum(1 for c in cited if c["class"] in ("chain", "post")) >= 2
    if need in OUTSIDE_CLASSES:                       # only from the relay's file, its party's own account or page read
        return any(c["class"] == need for c in cited)
    if need == "pool" and kind in POOL_KINDS:
        ev, by_creator = POOL_KINDS[kind]
        events = [c for c in cited if c["class"] == "chain" and c.get("on_chain") and c["what"] == "pool: " + ev]
        if not by_creator:
            return bool(events)
        users = {m.group(1) for c in events for m in [re.search(r"\bby ([1-9A-HJ-NP-Za-km-z]{32,44})\b", str(c["value"]))] if m}
        reads = [c for c in cited if c["class"] == "chain" and c.get("on_chain") and str(c["what"]).startswith(CREATOR_READS)]
        return any(u in str(c["value"]) for u in users for c in reads)
    return False


def check(items, bundle: list, fee_bonus_fired: bool) -> tuple:
    """(kept, dropped): kept items carry their cited bundle items; dropped ones their reason."""
    by_id = {b["id"]: b for b in bundle}
    kept, dropped = [], []
    for it in items if isinstance(items, list) else []:
        kind = it.get("kind") if isinstance(it, dict) else None
        ids = it.get("evidence") if isinstance(it, dict) else None
        why = str((it or {}).get("why") or "")[:400] if isinstance(it, dict) else ""
        if kind not in KINDS:
            dropped.append({"kind": kind, "reason": "not a word from the fixed list"}); continue
        if not isinstance(ids, list) or not ids:
            dropped.append({"kind": kind, "reason": "cites no evidence"}); continue
        missing = [x for x in ids if x not in by_id]
        if missing:
            dropped.append({"kind": kind, "reason": f"cites ids not in the bundle: {missing[:5]}"}); continue
        if kind == "fees_to_project_wallet_spent" and fee_bonus_fired:
            dropped.append({"kind": kind, "reason": "the design's fee bonus already fired: not counted twice (216(1))"}); continue
        cited = [by_id[x] for x in ids]
        if "reads" in NEEDS[kind] and not _has_reads(kind, cited):
            names = "; ".join(" or ".join(g) for g in UP_READS[kind])
            dropped.append({"kind": kind, "reason": (f"cites none of the chain reads that can show it: {names}" if names
                                                     else "PINR makes no chain read that can show it yet")}); continue
        lacking = [n for n in NEEDS[kind] if n != "reads" and not _has(n, cited, kind)]
        if lacking:
            dropped.append({"kind": kind, "reason": f"lacks the evidence its kind needs: {', '.join(lacking)}"}); continue
        kept.append({"kind": kind, "evidence": list(ids), "why": why, "cited": cited})
    return kept, dropped


def evidence(kept: list) -> list:
    """intent.decide's input: each kept item with receipts built from its cited bundle items."""
    out = []
    for it in kept:
        rc = tuple(E.Receipt(str(c.get("source") or c["what"]), c["value"], c["class"], str(c.get("as_of") or "read time"), bool(c["on_chain"]))
                   for c in it["cited"])
        out.append({"kind": it["kind"], "receipts": rc})
    return out


def move_size(decided: dict) -> float:
    """Redacted in the public copy."""
    raise NotImplementedError("redacted: proprietary PINR logic is not included in the public copy")


# ------------------------------------------------------------------ the day's dollars
def _db(path=None):
    c = sqlite3.connect(path or SPEND_DB, timeout=30, isolation_level=None)
    c.execute("CREATE TABLE IF NOT EXISTS pinrbot_spend (day TEXT PRIMARY KEY, dollars REAL, calls INTEGER, reserved REAL)")
    return c


def _day(now=None) -> str:
    return time.strftime("%Y-%m-%d", time.gmtime(now or time.time()))


def worst_cost(model: str, prompt_chars: int, max_tokens: int, prices: dict) -> float:
    p_in, p_out = prices[model]
    return round(prompt_chars / CHARS_PER_TOKEN * p_in / 1e6 + max_tokens * p_out / 1e6, 6)


def reserve(cap: float, worst: float, day=None, path=None) -> bool:
    c = _db(path)
    try:
        c.execute("BEGIN IMMEDIATE")
        r = c.execute("SELECT dollars, calls, reserved FROM pinrbot_spend WHERE day=?", (day or _day(),)).fetchone() or (0.0, 0, 0.0)
        if r[0] + r[2] + worst > cap + 1e-9:
            c.execute("ROLLBACK")
            return False
        c.execute("INSERT OR REPLACE INTO pinrbot_spend VALUES (?,?,?,?)", (day or _day(), r[0], r[1], round(r[2] + worst, 6)))
        c.execute("COMMIT")
        return True
    finally:
        c.close()


def settle(worst: float, cost: Optional[float], day=None, path=None) -> None:
    """cost None = the call never reached the API (nothing billed): the set-aside is given back."""
    c = _db(path)
    try:
        c.execute("BEGIN IMMEDIATE")
        r = c.execute("SELECT dollars, calls, reserved FROM pinrbot_spend WHERE day=?", (day or _day(),)).fetchone() or (0.0, 0, 0.0)
        c.execute("INSERT OR REPLACE INTO pinrbot_spend VALUES (?,?,?,?)",
                  (day or _day(), round(r[0] + (cost or 0.0), 6), r[1] + (cost is not None), round(max(0.0, r[2] - worst), 6)))
        c.execute("COMMIT")
    finally:
        c.close()


def spent(day=None, path=None) -> dict:
    c = _db(path)
    try:
        r = c.execute("SELECT dollars, calls, reserved FROM pinrbot_spend WHERE day=?", (day or _day(),)).fetchone() or (0.0, 0, 0.0)
        return {"dollars": r[0], "calls": r[1], "reserved": r[2]}
    finally:
        c.close()


# ------------------------------------------------------------------ the call
def _http(url: str, headers: dict, body: dict, timeout: float = 180.0) -> tuple:
    """(HTTP status, parsed answer or None). Never raises; never includes the key in anything returned."""
    req = urllib.request.Request(url, data=json.dumps(body).encode(), headers=headers, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, json.load(r)
    except urllib.error.HTTPError as e:
        try:
            return e.code, json.load(e)
        except Exception:
            return e.code, None
    except Exception:
        return 0, None


def ask(model: str, system: str, user: str, schema: dict, max_tokens: int, effort: str, cfg: dict, key: str,
        http: Callable = _http, path=None) -> tuple:
    """One call under the cap: (answer dict or None, status words, dollars billed or None)."""
    worst = worst_cost(model, len(system) + len(user), max_tokens, cfg["prices"])
    if not reserve(cfg["cap"], worst, path=path):
        return None, "not read: today's PINRbot dollar cap would be passed", None
    body = {"model": model, "max_tokens": max_tokens, "system": system,
            "messages": [{"role": "user", "content": user}],
            "output_config": {"effort": effort, "format": {"type": "json_schema", "schema": schema}}}
    headers = {"content-type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01"}
    status, ans = http(API, headers, body)
    if status != 200 or not isinstance(ans, dict):
        settle(worst, None, path=path)               # refused or unreachable: nothing billed
        kind = {401: "the key was refused", 403: "the key may not use this", 429: "the API is busy (429)",
                529: "the API is overloaded (529)"}.get(status, f"the API answered {status}" if status else "the API could not be reached")
        return None, f"not read: {kind}", None
    u = ans.get("usage") or {}
    p_in, p_out = cfg["prices"][model]
    tokens_in = sum(int(u.get(k) or 0) for k in ("input_tokens", "cache_creation_input_tokens", "cache_read_input_tokens"))
    cost = round(tokens_in * p_in / 1e6 + int(u.get("output_tokens") or 0) * p_out / 1e6, 6)
    settle(worst, cost, path=path)
    if ans.get("stop_reason") == "refusal":
        return None, "not read: the model declined", cost
    if ans.get("stop_reason") == "max_tokens":
        return None, "not read: the answer was cut short", cost
    text = "".join(b.get("text", "") for b in ans.get("content") or [] if isinstance(b, dict) and b.get("type") == "text")
    try:
        return json.loads(text), "read", cost
    except Exception:
        return None, "not read: the answer was not JSON", cost


FIRST_SCHEMA = {}  # redacted in the public copy
REVIEW_SCHEMA = {}  # redacted in the public copy

REVIEW_SYSTEM = ""  # redacted in the public copy


# ------------------------------------------------------------------ the whole reading
def read(mint: str, log_items: list, own: Optional[dict], fee_bonus_fired: bool, *, settings_path=None, http: Callable = _http,
         spend_path=None, cache_dir=None, scan_dir=None, key: Optional[str] = None) -> dict:
    """The coin's PINRbot reading. status "read" with items (possibly none: "PINRbot found no intent evidence"), or a
    "not read: <why>" / "off" status; never raises. `evidence` is what the scorer hands to intent.decide."""
    out = {"status": "off", "items": [], "pending": [], "dropped": [], "review": None, "evidence": [], "cost_usd": 0.0,
           "model": None, "calibration_version": None, "instructions_version": None, "x_check": x_stamp(mint, scan_dir),
           "read_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())}
    try:
        cfg, why = settings(settings_path)
        if cfg is None:
            out["status"] = why; return out
        key = key if key is not None else api_key()
        if not key:
            out["status"] = "not read: ANTHROPIC_API_KEY is not in the engine's .env"; return out
        text, iv = instructions()
        if text is None:
            out["status"] = "not read: the instructions (proposal section 2) could not be found"; return out
        cal, cv = calibration()
        system = text + "\n\nThe operator's calibration lines (version " + cv + "):\n" + ("\n".join(cal) or "(none yet)")
        bundle = gather(mint, log_items, own, scan_dir)
        relay = relay_file(mint)                          # GrokBot's checked findings join the bundle as
        if relay:                                         # "g…" receipts (relay_evidence's guards: an opened link, the checked
            bundle = bundle + relay_evidence(relay)       # phrase); PINRai names any kind; nothing moves on the file alone
        msg = {"coin": mint, "calibration_version": cv, "bundle": bundle}
        taught = teaching_block()
        if taught:                                        # the operator's corrections, read on every later coin
            msg["founder_teaching_examples"] = taught
            system += TEACH_NOTE
        user = json.dumps(msg, ensure_ascii=False, default=str)
        out.update(model=cfg["model"], calibration_version=cv, instructions_version=iv, bundle_items=len(bundle))
        ans, status, cost = ask(cfg["model"], system, user, FIRST_SCHEMA, FIRST_MAX_TOKENS, cfg["effort"], cfg, key, http, spend_path)
        out["cost_usd"] = round(out["cost_usd"] + (cost or 0.0), 6)
        if ans is None:
            out["status"] = status; return _keep(mint, out, cache_dir)
        kept, dropped = check(ans.get("items"), bundle, fee_bonus_fired)
        out["dropped"] = dropped
        decided = I.decide(evidence(kept)) if kept else None
        if decided and (move_size(decided) >= E.SETTINGS["escalate_move_at"] or decided["recommend_botrug"]):
            items = [{"id": i, "kind": it["kind"], "why": it["why"], "evidence": it["cited"]} for i, it in enumerate(kept)]
            r_user = json.dumps({"coin": mint, "items": items, "move_points": move_size(decided)}, ensure_ascii=False, default=str)
            r_ans, r_status, r_cost = ask(cfg["review_model"], REVIEW_SYSTEM, r_user, REVIEW_SCHEMA, REVIEW_MAX_TOKENS,
                                          cfg["review_effort"], cfg, key, http, spend_path)
            out["cost_usd"] = round(out["cost_usd"] + (r_cost or 0.0), 6)
            verdicts = {}
            for r in (r_ans or {}).get("reviews") or []:
                if isinstance(r, dict) and isinstance(r.get("id"), int) and 0 <= r["id"] < len(kept):
                    verdicts[r["id"]] = (r.get("verdict") if r.get("verdict") in REVIEW_VERDICTS else "needs_more_evidence",
                                         str(r.get("reason") or "")[:400])
            out["review"] = {"model": cfg["review_model"], "status": r_status,
                             "verdicts": [{"kind": it["kind"], "verdict": verdicts.get(i, ("needs_more_evidence", "no verdict given"))[0],
                                           "reason": verdicts.get(i, ("", ""))[1]} for i, it in enumerate(kept)]}
            if r_ans is not None:                             # a review that ran can reverse; one that did not leaves them counting
                for i, it in enumerate(kept):
                    if verdicts.get(i, ("needs_more_evidence",))[0] == "supported":
                        it["reviewed"] = True
                    else:
                        out["dropped"].append({"kind": it["kind"], "reason": "reversed: the review did not call it supported"})
                kept = [it for i, it in enumerate(kept) if verdicts.get(i, ("needs_more_evidence",))[0] == "supported"]
        out["items"] = [_shown(it) for it in kept]
        out["evidence"] = evidence(kept)
        out["status"] = "read"
        return _keep(mint, out, cache_dir)
    except Exception as e:                                # a fault here never fails the score: the reading is "not read"
        out["status"] = f"not read: {type(e).__name__}"
        out["evidence"] = []
        return out


# ------------------------------------------------------------------ the cache (216(3))
def x_stamp(mint: str, scan_dir=None) -> Optional[str]:
    try:
        return json.load(open(os.path.join(scan_dir or SCAN_DIR, mint + ".json"))).get("scanned_at")
    except Exception:
        return None


def _keep(mint: str, out: dict, cache_dir=None) -> dict:
    try:
        d = cache_dir or CACHE_DIR
        os.makedirs(d, exist_ok=True)
        keep = {k: v for k, v in out.items() if k != "evidence"}
        with open(os.path.join(d, mint + ".json.tmp"), "w") as f:
            json.dump(keep, f, ensure_ascii=False, default=str)
        os.replace(os.path.join(d, mint + ".json.tmp"), os.path.join(d, mint + ".json"))
    except Exception:
        pass                                              # an unwritable cache never fails the score
    return out


def cached(mint: str, cache_dir=None, scan_dir=None) -> Optional[dict]:
    """The coin's kept reading, or None when there is none or a newer X check of the coin has arrived since it was read
    (216(3)). The scorer reads anew at every score, so a kept reading is also replaced at the coin's next score."""
    try:
        r = json.load(open(os.path.join(cache_dir or CACHE_DIR, mint + ".json")))
    except Exception:
        return None
    return r if r.get("x_check") == x_stamp(mint, scan_dir) else None


# ------------------------------------------------------------------ on demand (212(g); the team's F1)
# PINRbot reads a coin afresh only when it is in demand: on the site's first page (the coins it shows), or on the wanted
# list (`index/pinrbot-wanted.json`, {mint: unix time}, kept WANT_KEEP_S): a coin asked for by hand (`pinrbot.py want`),
# and, once the site's feed server writes it, a coin searched or opened on the site. Any other coin is served its kept reading
# while no newer X check has arrived; with none kept it is "not read yet".
SHOWN_URL = "http://127.0.0.1:8787/api/tokens"
WANTED = os.path.join(ENGINE, "index", "pinrbot-wanted.json")
WANTED_SITE = os.path.join(ENGINE, "index", "pinrbot-wanted-site.json")   # written by the site's feed server only (searched or opened)
BUDGET_FILE = os.path.join(ENGINE, "frontend-feed", "_pinrbot-budget.json")   # "_": never read as a coin file
WANT_KEEP_S = 86400
SHOWN_SECONDS = 30
_SHOWN = {"at": 0.0, "mints": set()}


def _site_shown() -> set:
    """The coins on the site's first page, read from the feed server on this machine at most every SHOWN_SECONDS; an
    empty set when it does not answer (then only the wanted list counts)."""
    if time.time() - _SHOWN["at"] < SHOWN_SECONDS:
        return _SHOWN["mints"]
    _SHOWN["at"] = time.time()
    try:
        d = json.load(urllib.request.urlopen(SHOWN_URL, timeout=5))
        toks = d if isinstance(d, list) else (d.get("tokens") or d.get("items") or [])
        _SHOWN["mints"] = {(t.get("token") or t).get("address") for t in toks if isinstance(t, dict)} - {None}
    except Exception:
        _SHOWN["mints"] = set()
    return _SHOWN["mints"]


def _one_wanted(path, now) -> dict:
    try:
        d = json.load(open(path))
    except Exception:
        return {}
    return {m: t for m, t in d.items() if isinstance(m, str) and isinstance(t, (int, float)) and not isinstance(t, bool)
            and now - t <= WANT_KEEP_S} if isinstance(d, dict) else {}


def _wanted(path=None, now=None, site_path=None) -> dict:
    """The hand list (`pinrbot.py want`) and the site's own file (the site's feed server, a coin searched or opened on pinr.io),
    each with one writer, merged here: the latest ask wins; entries older than a day are left out."""
    now = now or time.time()
    out = _one_wanted(path or WANTED, now)
    for m, t in _one_wanted(site_path or WANTED_SITE, now).items():
        out[m] = max(t, out.get(m, 0))
    return out


def want(mint: str, path=None, now=None) -> None:
    """Put a coin on the hand list (the site's searched or opened coins go in its own file, written by the feed server)."""
    d = _one_wanted(path or WANTED, now or time.time())
    d[mint] = now or time.time()
    p = path or WANTED
    os.makedirs(os.path.dirname(p), exist_ok=True)
    with open(p + ".tmp", "w") as f:
        json.dump(d, f)
    os.replace(p + ".tmp", p)


def gate_passed(mint: str) -> bool:
    """the gate's answer for this coin (scanner/gate.py); anything but "passed" sends nothing."""
    sys.path.insert(0, os.path.join(ENGINE, "scanner"))
    import gate
    return gate.passed(mint)[0]


def on_demand(mint: str, shown: Optional[Callable] = None, wanted_path=None, site_path=None) -> tuple:
    """(True, why) when the coin is shown by the site or on the wanted list; (False, None) otherwise. a coin
    that has not passed the gate (vamps, duplicates, serial launchers read from token data first) is never sent."""
    if not gate_passed(mint):
        return False, None
    if mint in _wanted(wanted_path, site_path=site_path):
        return True, "asked for (wanted list)"
    if mint in (shown or _site_shown)():
        return True, "shown on the site's first page"
    return False, None


def served(mint: str, fee_bonus_fired: bool, cache_dir=None, scan_dir=None) -> dict:
    """A coin not in demand: its kept reading (216(3)), with the same items applied again, or "not read yet"."""
    r = cached(mint, cache_dir, scan_dir)
    if r is None or r.get("status") != "read":
        return {"status": "not read yet: not shown, searched or opened since its last X check", "items": [], "pending": [], "dropped": [],
                "review": None, "evidence": [], "cost_usd": 0.0, "model": None, "calibration_version": None,
                "instructions_version": None, "x_check": x_stamp(mint, scan_dir), "demand": None}
    items = [it for it in r.get("items") or [] if not (fee_bonus_fired and it.get("kind") == "fees_to_project_wallet_spent")]
    ev = [{"kind": it["kind"], "receipts": tuple(E.Receipt(str(c.get("source") or c.get("what")), c.get("value"), "kept",
                                                            str(c.get("as_of") or r.get("read_at")), bool(c.get("on_chain")))
                                                  for c in it.get("receipts") or [])} for it in items]
    return dict(r, items=items, evidence=ev, cost_usd=0.0, status=f"kept reading of {r.get('read_at')}", demand=None)


def write_budget(path=None, settings_path=None, spend_path=None, now=None) -> dict:
    """The public budget meter (contract, launch item 7): {"day", "used_pct", "status", "as_of"}. A percentage of today's
    cap, never a dollar figure; "off" with 0 while PINRbot is off. Written whole (temp file, then rename); never raises."""
    now = now or time.time()
    cfg, _why = settings(settings_path)
    rec = {"day": _day(now), "used_pct": 0, "status": "off", "as_of": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(now))}
    try:
        if cfg is not None:
            sp = spent(_day(now), spend_path)
            rec.update(status="on", used_pct=int(min(100, max(0, round((sp["dollars"] + sp["reserved"]) / cfg["cap"] * 100)))))
        p = path or BUDGET_FILE
        os.makedirs(os.path.dirname(p), exist_ok=True)
        with open(p + ".tmp", "w") as f:
            json.dump(rec, f)
        os.replace(p + ".tmp", p)
    except Exception:
        pass
    return rec


if __name__ == "__main__":
    if len(sys.argv) == 3 and sys.argv[1] == "want":
        want(sys.argv[2]); print(f"{sys.argv[2]} is on PINRbot's wanted list for {WANT_KEEP_S // 3600} hours")
    elif len(sys.argv) == 3 and sys.argv[1] == "show":
        print(json.dumps(cached(sys.argv[2]) or {"status": "no kept reading"}, indent=1, ensure_ascii=False, default=str))
    else:
        print("python3 pinrbot.py want <mint>   |   python3 pinrbot.py show <mint>")



# ------------------------------------------------------------------ the relay's checked reading (8a)
# PINRbot (Claude) with PINRbot_Grok write one file per checked coin, `pinrbot/relay/readings/<mint>.json` ("pinrbot-relay/1",
# PINRBOT's section 8a). The server's sync job copies the files from GitHub's main into
# `index/relay-readings/` (no code pulled outside a deploy); this module reads the newer of that copy and the repo's own.
# The file's evidence joins the score's bundle with its own ids; `read:<name>` resolves to the score's own receipt whose
# name starts with it; then the same guards as v1: the 13 kinds, ids that exist, 217's named reads for up-items, own words,
# 216(1). A move of the review size or a BOT/RUG call is withheld "awaiting review" until the review key is in (8b); no
# API is called. Nothing from the relay is ever on-chain.
RELAY_REPO_DIR = os.path.join(REPO, "pinrbot", "relay", "readings")
RELAY_COPY_DIR = os.path.join(ENGINE, "index", "relay-readings")
RELAY_SCHEMA = "pinrbot-relay/1"
RELAY_CLASSES = ("post", "account") + OUTSIDE_CLASSES
# PINRBOT's phrase for an outside source (8a, edcf159a): the party's own account or page was read.
PARTY_READ = re.compile(r"\b(?:party|partner|auditor|original)'s own (?:account|page) read\b", re.IGNORECASE)


def _shown(it: dict) -> dict:
    """An item as the page reads it: kind, the cited ids, the note, and each cited receipt."""
    return {"kind": it["kind"], "evidence": it["evidence"], "why": it["why"], "reviewed": bool(it.get("reviewed")),
            "receipts": [{k: c.get(k) for k in ("id", "what", "value", "source", "as_of", "on_chain")} for c in it["cited"]]}


def relay_file(mint: str, dirs=None) -> Optional[dict]:
    """The coin's relay reading, the newest `read_at` among the copies; None when there is none or it is not usable."""
    best = None
    for d in dirs or (RELAY_COPY_DIR, RELAY_REPO_DIR):
        try:
            r = json.load(open(os.path.join(d, mint + ".json")))
        except Exception:
            continue
        if not isinstance(r, dict) or r.get("schema") != RELAY_SCHEMA or r.get("mint") != mint:
            continue
        if not isinstance(r.get("items"), list) or not isinstance(r.get("evidence"), list):
            continue
        if best is None or str(r.get("read_at") or "") > str(best.get("read_at") or ""):
            best = r
    return best


def relay_evidence(r: dict) -> list:
    """The file's evidence as bundle items: ids "g…", never on-chain; a post counts only with its quote checked, an
    outside source only when its own account or page was read (`checked`)."""
    out = []
    for e in r.get("evidence") or []:
        if not isinstance(e, dict) or not isinstance(e.get("id"), str) or not re.fullmatch(r"g\d{1,4}", e["id"]):
            continue
        cls, checked = e.get("class"), str(e.get("checked") or "")
        if cls not in RELAY_CLASSES or not checked:
            continue
        if cls == "post" and "quote in post" not in checked:
            continue
        if cls in OUTSIDE_CLASSES and not PARTY_READ.search(checked):
            continue                                      # the team's F1: the whole phrase, never a word inside another
        out.append({"id": e["id"], "class": cls, "what": str(e.get("what") or "")[:200], "value": _short(e.get("value")),
                    "source": str(e.get("source") or "")[:300], "as_of": e.get("as_of"), "on_chain": False,
                    "own_account": bool(e.get("own_account")), "removed": bool(e.get("removed")), "checked": checked[:200]})
    return out


def _resolve_reads(items: list, bundle: list) -> list:
    """`read:<name>` -> the id of the score's own chain or record item whose name starts with it (never the creator's);
    unresolved ids stay as written, so the check drops the item as it drops any id not in the bundle."""
    out = []
    for it in items:
        if not isinstance(it, dict):
            continue
        ev = []
        for x in it.get("evidence") or []:
            if isinstance(x, str) and x.startswith("read:"):
                name = x[5:]
                hit = next((b["id"] for b in bundle if b["class"] in ("chain", "record") and name and str(b["what"]).startswith(name)), None)
                ev.append(hit or x)
            else:
                ev.append(x)
        out.append(dict(it, evidence=ev))
    return out


def relay_read(mint: str, log_items: list, own: Optional[dict], fee_bonus_fired: bool, *, dirs=None, scan_dir=None) -> Optional[dict]:
    """The relay's reading through v1's guards, or None when the coin has no relay file. Never raises."""
    try:
        r = relay_file(mint, dirs)
        if r is None:
            return None
        bundle = gather(mint, log_items, own, scan_dir) + relay_evidence(r)
        kept, dropped = check(_resolve_reads(r.get("items") or [], bundle), bundle, fee_bonus_fired)
        review, pending = None, []                        # every finding counts at once, "not reviewed yet"
        decided = I.decide(evidence(kept)) if kept else None
        if decided and (move_size(decided) >= E.SETTINGS["escalate_move_at"] or decided["recommend_botrug"]):
            review = {"model": None, "status": "not reviewed yet: the review runs once the key is in and can reverse it", "verdicts": []}
        return {"status": "read", "model": "relay", "read_at": r.get("read_at"), "request": r.get("request"),
                "read_by": r.get("read_by"), "calibration_version": r.get("calibration_version"), "instructions_version": None,
                "x_check": x_stamp(mint, scan_dir), "cost_usd": 0.0, "review": review, "dropped": dropped, "pending": pending,
                "items": [_shown(it) for it in kept],
                "evidence": evidence(kept)}
    except Exception as e:
        return {"status": f"not read: {type(e).__name__}", "model": "relay", "items": [], "dropped": [], "review": None,
                "evidence": [], "cost_usd": 0.0, "calibration_version": None, "instructions_version": None, "read_at": None, "pending": []}



def combine(v1: dict, relay: Optional[dict]) -> dict:
    """PINRbot v1's reading and the relay's together: the items no review confirmed are sized as ONE move;
    when together they reach the review size or make a BOT/RUG call, they are withheld "review pending" (a design decision,
    220; the team's 8b answer) and only items a review called supported stay. Never raises."""
    if relay is None:
        return v1
    v1_live = v1.get("status") == "read" or str(v1.get("status")).startswith("kept reading")
    base = v1 if v1_live else dict(relay, demand=v1.get("demand"))
    if not v1_live:
        v1_items, v1_ev = [], []
    else:
        v1_items, v1_ev = list(v1.get("items") or []), list(v1.get("evidence") or [])
    reviewed = bool(v1_live and v1.get("review") and v1["review"].get("verdicts"))
    sure_items, sure_ev = (v1_items, v1_ev) if reviewed else ([], [])
    open_items = ([] if reviewed else v1_items) + list(relay.get("items") or [])
    open_ev = ([] if reviewed else v1_ev) + list(relay.get("evidence") or [])
    dropped = (list(v1.get("dropped") or []) if v1_live else []) + list(relay.get("dropped") or [])
    pending = (list(v1.get("pending") or []) if v1_live else []) + list(relay.get("pending") or [])
    # unreviewed items count at once, flagged reviewed false; the review runs later and can reverse them
    return dict(base, items=sure_items + open_items, evidence=sure_ev + open_ev, dropped=dropped, pending=pending,
                model=(f"{v1.get('model')} + relay" if v1_live else "relay"))
