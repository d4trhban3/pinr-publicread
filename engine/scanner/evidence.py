"""a design decision (c), step 3; PINR's own evidence table, the paper trail (facts/EVIDENCE-SOURCE-MAP.md).

One table `evidence` in the scanner's existing database. One row per fact: what links to what (from, to), what it is,
its value, when it happened, when PINR read it, the public source, a link to see it, and whether it was read on chain
(onchain 1, shown ●) or taken from someone's own words or a third party (onchain 0, shown ○). Fed from the receipts every
finished score already writes: no new read. A re-score that reads the same fact again updates its value and read time;
nothing is ever deleted. Missing stays missing: a receipt that is absent or not in its shape gives no row."""
from __future__ import annotations
import json, os, re, time

SCHEMA = ("CREATE TABLE IF NOT EXISTS evidence (coin TEXT NOT NULL, from_kind TEXT, from_id TEXT NOT NULL, to_kind TEXT, "
          "to_id TEXT NOT NULL, what TEXT NOT NULL, value TEXT, unit TEXT, at REAL, first_read REAL, read_at REAL, source TEXT, "
          "link TEXT, onchain INTEGER, receipt TEXT, PRIMARY KEY (coin, from_id, to_id, what))")
INDEXES = ("CREATE INDEX IF NOT EXISTS evidence_from ON evidence (from_id)", "CREATE INDEX IF NOT EXISTS evidence_to ON evidence (to_id)")
_ADDR = re.compile(r"^(?:[1-9A-HJ-NP-Za-km-z]{32,44}|0x[0-9a-f]{40})$")   # a Solana address, or a Base/BNB one in lowercase (CHAINS, 249)
_SIG = re.compile(r"\b[1-9A-HJ-NP-Za-km-z]{86,88}\b")
_URL = re.compile(r"^https?://\S+$")


def ensure(c) -> None:
    c.execute(SCHEMA)
    for q in INDEXES:
        c.execute(q)


def account(a: str) -> str:
    return "https://solscan.io/account/" + a


def tx(sig: str) -> str:
    return "https://solscan.io/tx/" + sig


def _sig_in(text) -> str | None:
    m = _SIG.search(str(text or ""))
    return m.group(0) if m else None


def _addr(v) -> str | None:
    return v if isinstance(v, str) and _ADDR.match(v) else None


def rows_from_result(out: dict) -> list:
    """The evidence rows one score's receipts hold, as dicts; a receipt not in its expected shape gives none."""
    coin = out.get("mint")
    if not _addr(coin):
        return []
    rec = {}
    for r in out.get("receipts") or []:
        if isinstance(r, dict) and isinstance(r.get("what"), str):
            rec.setdefault(r["what"], r)
    rows = []

    def row(r, fk, fid, tk, tid, what, value=None, unit=None, at=None, link=None, onchain=1):
        if not fid or not tid:
            return
        rows.append({"coin": coin, "from_kind": fk, "from_id": fid, "to_kind": tk, "to_id": tid, "what": what,
                     "value": None if value is None else json.dumps(value, default=str), "unit": unit, "at": at,
                     "source": str(r.get("source") or "")[:300], "link": link, "onchain": onchain, "receipt": r.get("what")})

    creator = None
    for name in ("creator (from curve)", "creator (from LaunchLab pool)", "creator (launch record)", "creator (Jupiter's token list)"):
        r = rec.get(name)
        if r and _addr(r.get("value")):
            creator = r["value"]
            row(r, "token", coin, "wallet", creator, "created by", link=account(creator), onchain=1 if name in CHAIN_CREATORS else 0)
            break
    r = rec.get("creation record (launcher, fee receiver at launch)")
    if r and isinstance(r.get("value"), list) and len(r["value"]) == 2:
        sig = _sig_in(r.get("source"))
        for who, what in zip(r["value"], ("launched by", "fee receiver at launch")):
            if _addr(who):
                row(r, "token", coin, "wallet", who, what, link=tx(sig) if sig else account(who))
    r = rec.get("launcher of this token")
    if r and isinstance(r.get("value"), dict) and _addr(r["value"].get("wallet")):
        row(r, "wallet", r["value"]["wallet"], "launchpad", "count", "coins launched (the launchpad's list)", r["value"].get("launches"), "coins", onchain=0)
    r = rec.get("dev launches")
    if r and creator and r.get("value") not in (None, "None+"):
        row(r, "wallet", creator, "launchpad", "count", "coins launched (the launchpad's list)", r["value"], "coins", onchain=0)
    r = rec.get("duplicate relaunches of this token")
    if r and creator and isinstance(r.get("value"), int):
        row(r, "wallet", creator, "token", coin, "copies of this coin launched", r["value"], "coins", link=account(creator))   # checklist 6: the creator's launches
    r = rec.get("dev group (linked wallets)")
    if r and creator and isinstance(r.get("value"), dict):
        for w, why in r["value"].items():
            if _addr(w) and w != creator:
                row(r, "wallet", creator, "wallet", w, "linked: " + str(why)[:80], link=account(w))
    r = rec.get("funding source")
    if r and isinstance(r.get("value"), dict):
        for hop in r["value"].get("trace") or []:
            if isinstance(hop, dict) and _addr(hop.get("wallet")) and _addr(hop.get("funder")):
                sig = hop.get("signature") if isinstance(hop.get("signature"), str) and _SIG.fullmatch(hop.get("signature") or "") else None
                row(r, "wallet", hop["funder"], "wallet", hop["wallet"], "funded", hop.get("sol"), "SOL",
                    at=hop.get("funded_at") if isinstance(hop.get("funded_at"), (int, float)) else None, link=tx(sig) if sig else account(hop["funder"]))
    r = rec.get("holders (evidence)")
    if r and isinstance(r.get("value"), list):
        chain = r.get("source") == "getTokenLargestAccounts"
        for h in r["value"]:
            if isinstance(h, dict) and _addr(h.get("wallet")):
                v = {k: h.get(k) for k in ("amount", "program", "dev", "sniper", "bundler") if h.get(k) is not None}
                row(r, "wallet", h["wallet"], "token", coin, "holds", v, "tokens",
                    link=account(h["wallet"]) if chain else "https://pump.fun/coin/" + coin, onchain=1 if chain else 0)
    for name in ("PumpSwap pool (derived canonical PDA, verified owner and base mint)", "LaunchLab pool (Raydium's record, verified on chain)"):
        r = rec.get(name)
        if r and _addr(r.get("value")):
            row(r, "token", coin, "pool", r["value"], "trades in pool", link=account(r["value"]))
    for name, kind in (("token's own twitter link", "x"), ("token's own website link", "site"), ("token's own telegram link", "telegram")):
        r = rec.get(name)
        if r and isinstance(r.get("value"), str) and _URL.match(r["value"]):
            row(r, "token", coin, kind, r["value"], "lists its own link", link=r["value"], onchain=0)
    r = rec.get("token metadata URI")
    if r and isinstance(r.get("value"), str) and _URL.match(r["value"]):
        row(r, "token", coin, "document", r["value"], "metadata document", link=r["value"])
    for name in ("launch time (launch transaction)", "launch time (oldest mint transaction)"):
        r = rec.get(name)
        if r and isinstance(r.get("value"), (int, float)) and not isinstance(r.get("value"), bool):
            sig = _sig_in(r.get("source"))
            row(r, "token", coin, "event", "launch", "launched", at=r["value"],
                link=tx(sig) if sig else "https://solscan.io/token/" + coin)   # checklist 6: no signature kept: the token's chain record
            break
    r = rec.get("venue")
    if r and isinstance(r.get("value"), str):
        row(r, "token", coin, "launchpad", r["value"], "trades on", link="https://solscan.io/token/" + coin)
    r = rec.get("market figures (DexScreener)")
    if r and isinstance(r.get("value"), dict) and _addr(r["value"].get("pair")):
        v = r["value"]
        row(r, "token", coin, "pair", v["pair"], "market pair", {k: v.get(k) for k in ("dex", "market_cap", "liquidity_usd", "volume_h24")},
            "USD", link=v.get("url") if isinstance(v.get("url"), str) and _URL.match(v["url"]) else None, onchain=0)
    r = rec.get("X check")
    if r and isinstance(r.get("value"), str):
        row(r, "token", coin, "x", "check", "X check", r["value"][:200], onchain=0)
    return rows


def store(c, out: dict, now: float | None = None) -> int:
    """Write one score's evidence rows; a fact already kept has its value, source, link and read time renewed. Rows written."""
    now = now or time.time()
    rows = rows_from_result(out)
    for r in rows:
        c.execute("INSERT INTO evidence (coin, from_kind, from_id, to_kind, to_id, what, value, unit, at, first_read, read_at, source, link, onchain, receipt) "
                  "VALUES (:coin, :from_kind, :from_id, :to_kind, :to_id, :what, :value, :unit, :at, :now, :now, :source, :link, :onchain, :receipt) "
                  "ON CONFLICT (coin, from_id, to_id, what) DO UPDATE SET "      # the newest read wins; the first read is the earliest ever (backfill-safe)
                  "value=CASE WHEN excluded.read_at >= evidence.read_at THEN excluded.value ELSE evidence.value END, "
                  "unit=CASE WHEN excluded.read_at >= evidence.read_at THEN excluded.unit ELSE evidence.unit END, "
                  "at=COALESCE(CASE WHEN excluded.read_at >= evidence.read_at THEN excluded.at ELSE evidence.at END, evidence.at, excluded.at), "
                  "source=CASE WHEN excluded.read_at >= evidence.read_at THEN excluded.source ELSE evidence.source END, "
                  "link=CASE WHEN excluded.read_at >= evidence.read_at THEN excluded.link ELSE evidence.link END, "
                  "onchain=CASE WHEN excluded.read_at >= evidence.read_at THEN excluded.onchain ELSE evidence.onchain END, "
                  "receipt=CASE WHEN excluded.read_at >= evidence.read_at THEN excluded.receipt ELSE evidence.receipt END, "
                  "first_read=MIN(evidence.first_read, excluded.first_read), read_at=MAX(evidence.read_at, excluded.read_at)", dict(r, now=now))
    return len(rows)


def store_file(c, mint: str, results_dir: str, now: float | None = None) -> int:
    """The same from the coin's result file; 0 when there is none or it cannot be read."""
    try:
        with open(os.path.join(results_dir, mint + ".json")) as f:
            out = json.load(f)
    except Exception:
        return 0
    return store(c, out, now) if isinstance(out, dict) and out.get("mint") == mint else 0


ORDER = ("created by", "launched by", "fee receiver at launch", "funded", "linked", "holds", "trades in pool", "lists its own link",
         "metadata document", "launched", "trades on", "market pair", "X check", "coins launched (the launchpad's list)", "copies of this coin launched")
CONTRACT = "evidence/1"
# the team's F1 and F2 on e0ed1d63: the public file names only a public source (the feed's fixed list, K1) and states no rule.
# The table keeps the receipt's own words for PINR; the file never carries them.
CHAIN_RECEIPTS = {"creator (from curve)", "creator (from LaunchLab pool)", "creation record (launcher, fee receiver at launch)",
                  "dev group (linked wallets)", "funding source", "PumpSwap pool (derived canonical PDA, verified owner and base mint)",
                  "token metadata URI", "launch time (launch transaction)", "launch time (oldest mint transaction)", "venue",
                  "duplicate relaunches of this token"}
# the team's rulings on F1 and F2 : the file's sources and a linked wallet's words, both fixed lists.
SOURCES = ("Solana chain", "Pump.fun", "DexScreener", "GeckoTerminal", "Jupiter", "X", "launchpad record", "Base chain", "BNB chain", "GoPlus")
CHAIN_CREATORS = ("creator (from curve)", "creator (from LaunchLab pool)")   # read on chain (●); the rest are reported (○)
REPORTERS = ("GoPlus",)      # the team on K1, from an outside reporter whose claim is shown is named (○ rows)
EVM_CHAIN = {"base": "Base chain", "bsc": "BNB chain"}     # CHAINS (249, 252): a Base or BNB coin's own chain, the feed's names
EVM_LAUNCHPADS = ("Clanker", "Zora", "Virtuals", "Four.meme", "four.meme", "Flap", "Bankr")
LINKED_PLAIN = (("bundled buy", "bought in the creation block"), ("funded sniper", "funded by the creator before launch"),
                ("handoff", "received tokens from the creator"))
LINKED_OTHER = "linked to the creator"   # a reason not in the list above: the plain fact only, never the engine's words


def linked_words(reason: str) -> str:
    """The plain observed fact for a dev-group row: never a window, share, threshold or rule name."""
    for start, words in LINKED_PLAIN:
        if str(reason or "").startswith(start):
            return words
    return LINKED_OTHER


def public_source(receipt: str, source: str, chain: str | None = None, onchain: bool = False):
    """The public source name for a row, from the feed's fixed list (K1), or None: never a receipt's own words. A Base or
    BNB coin's row (`chain` base or bsc; the team's note on a6f9dec4): read on its own chain, that chain's name; from a
    launchpad's own record or API, "launchpad record"; anything else (a provider such as GoPlus): None."""
    words = str(source or "")
    for r in REPORTERS:
        if not onchain and (r in words or str(receipt or "").startswith(r)):
            return r
    if chain in EVM_CHAIN:
        if onchain:
            return EVM_CHAIN[chain]
        return "launchpad record" if any(lp in words for lp in EVM_LAUNCHPADS) else None
    if receipt == "market figures (DexScreener)":
        return "DexScreener"
    if receipt == "X check":
        return "X"
    if receipt == "LaunchLab pool (Raydium's record, verified on chain)":
        return "launchpad record"
    if receipt in CHAIN_RECEIPTS or (receipt == "holders (evidence)" and words == "getTokenLargestAccounts"):
        return "Solana chain"
    if receipt == "creator (launch record)":
        return "Pump.fun"
    if receipt == "creator (Jupiter's token list)":      # checklist 6: a young coin's creator before its full score
        return "Jupiter"
    if receipt in ("launcher of this token", "dev launches", "holders (evidence)", "token's own twitter link", "token's own website link", "token's own telegram link"):
        return "Pump.fun" if "Pump.fun" in words else "launchpad record" if ("Raydium" in words or words.startswith("metadata document")) else None
    return None


def _iso(t):
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(t)) if isinstance(t, (int, float)) and not isinstance(t, bool) else None


def _rank(what: str) -> int:
    for i, w in enumerate(ORDER):
        if what == w or what.startswith(w + ":") or (w == "linked" and (what == LINKED_OTHER or what in dict(LINKED_PLAIN).values())):
            return i
    return len(ORDER)


PINRAI_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "index", "pinrbot")


# the team's F2 on b09decef: the model's own sentences (it reads the developer's own words) never reach a page; each kind
# PINRai may name is shown in these fixed, observed words, with its receipts. A kind not listed here is not shown.
PINRAI_WORDS = {
    "deleted_posts_after_dump": "posts were deleted after selling was observed",
    "misleading_claim": "a claim in the developer's own words does not match what was observed",
    "words_contradict_actions": "the developer's stated plans and what the chain shows differ",
    "fake_partnership": "a stated partnership was not confirmed by the partner's own account",
    "impersonation": "the coin presents itself as another project",
    "fake_audit": "a stated audit was not confirmed by the auditor",
    "confirmed_drainer": "a wallet-draining contract was observed",
    "coordinated_manipulation": "wallets were observed acting together",   # the operator's wording, checklist 13 (the site's label)
    "vesting_lock": "a vesting lock was observed",
    "fees_to_project_wallet_spent": "fees reached a project wallet and were spent",
    "preannounced_sells_match": "the developer's sells matched what was announced beforehand",
    "gradual_selling": "the developer sold gradually",
    "survived_30d": "the coin has traded for 30 days",
    "pool_liquidity_removed_by_creator": "liquidity was removed from the pool by the creator's wallets",   # 262, the team's
    "pool_liquidity_added_by_creator": "liquidity was added to the pool by the creator's wallets",        # words 2026-10-25
    "pool_buyback_burn": "tokens were bought back and burned from the pool",
}
_B58 = re.compile(r"^[1-9A-HJ-NP-Za-km-z]{32,90}$")
_XPOST = re.compile(r"https://(?:x|twitter)\.com/[A-Za-z0-9_/]+/status/\d+|https://x\.com/i/status/\d+")


def _pinrai_receipt(x: dict) -> dict:
    """the team's F1 and F3: a cited receipt as the public file may show it, by what PINRbot v1 says it is (its id):
      the coin's own record or the creator's own words (d, w, x, m): "launchpad record", no value, no link (never the
        developer's text, an address-shaped string in it, or a link planted in it);
      a post PINR read (p: the X check; g: the relay): "X", the post's own address (the source PINR read) as the link;
      a chain read (c) or a pool event: the evidence table's source or "Solana chain", a number, address or signature value and its
        explorer link;
      another record (r): the evidence table's source only, a number value only, no link.
    Never the receipt's own words; anything else: an empty receipt."""
    rid, what, src, val = str(x.get("id") or ""), str(x.get("what") or ""), str(x.get("source") or ""), x.get("value")
    as_of = x.get("as_of") if isinstance(x.get("as_of"), str) else None
    num = val if isinstance(val, (int, float)) and not isinstance(val, bool) else None
    empty = {"source": None, "value": None, "link": None, "as_of": None, "onchain": False}
    if rid[:1] in ("d", "w", "x", "m"):
        return {"source": "launchpad record", "value": None, "link": None, "as_of": None, "onchain": False}
    if rid[:1] in ("p", "g"):
        post = _XPOST.fullmatch(src.strip())
        return {"source": "X", "value": None, "link": post.group(0) if post else None, "as_of": as_of, "onchain": False}
    if rid[:1] in ("c", "q") and x.get("on_chain"):
        keep = num if num is not None else (val if isinstance(val, str) and _B58.match(val) else None)
        sig = next(iter(re.findall(r"[1-9A-HJ-NP-Za-km-z]{64,90}", src + " " + (val if isinstance(val, str) else ""))), None)
        link = tx(sig) if sig else (account(keep) if isinstance(keep, str) and len(keep) <= 44 else None)
        return {"source": public_source(what, src) or "Solana chain", "value": keep, "link": link, "as_of": as_of, "onchain": True}
    if rid[:1] == "r":
        return {"source": public_source(what, src), "value": num, "link": None, "as_of": as_of, "onchain": False}
    return empty


GROKBOT_SOURCE = "GrokBot (X, browser)"
GROKBOT_CLASSES = {"post": "post", "account": "account", "partner_source": "partner", "original_source": "original", "auditor_list": "auditor"}


def grokbot_section(mint: str, dirs=None) -> dict | None:
    """GrokBot's checked findings for the coin, as the evidence hub shows a reported (○) read:
    each row the link that opened, the time it was opened (as_of), its class, and the reported words; never on chain, never
    a score move, never a person named (the relay file names none). Only rows that pass stage3/pinrbot.py's relay guards
    (an id, a checked phrase: "quote in post" for a post, "<party>'s own account read" for an outside source); a row without
    them is left out, as the team's F1 on 8a asked. None when the coin has no relay file (missing stays missing)."""
    try:
        import pinrbot as PB
        r = PB.relay_file(mint, dirs)
        if r is None:
            return None
        rows = PB.relay_evidence(r)
    except Exception:
        return None
    out = []
    for e in rows:
        link = e.get("source") if isinstance(e.get("source"), str) and e["source"].startswith("https://") else None
        out.append({"id": e["id"], "kind": GROKBOT_CLASSES.get(e["class"], e["class"]), "what": e.get("what"), "value": e.get("value"),
                    "link": link, "as_of": e.get("as_of") if isinstance(e.get("as_of"), str) else None,
                    "own_account": bool(e.get("own_account")), "removed": bool(e.get("removed")), "source": GROKBOT_SOURCE, "onchain": False})
    dropped = [d for d in r.get("dropped_before_filing") or [] if isinstance(d, dict) and isinstance(d.get("reason"), str)]
    return {"source": GROKBOT_SOURCE, "read_at": r.get("read_at") if isinstance(r.get("read_at"), str) else None,
            "request": r.get("request") if isinstance(r.get("request"), str) else None,
            "rows": out, "dropped": [{"reason": d["reason"][:120]} for d in dropped][:20], "onchain": False}


def pinrai_section(mint: str, cache_dir: str | None = None) -> dict | None:
    """PINRai's reading for the coin's evidence file: the status, when it was read, the model, and each item
    PINRai named, in fixed words, with its receipts (the team's F1 and F2: never the model's sentences, never a receipt's
    own words, never the cost); None when the coin has no reading."""
    try:
        r = json.load(open(os.path.join(cache_dir or PINRAI_DIR, mint + ".json")))
    except Exception:
        return None
    if not isinstance(r, dict) or not isinstance(r.get("status"), str):
        return None
    items = []
    for it in r.get("items") or []:
        if not isinstance(it, dict) or it.get("kind") not in PINRAI_WORDS:
            continue
        items.append({"kind": it["kind"], "words": PINRAI_WORDS[it["kind"]], "reviewed": bool(it.get("reviewed")),
                      "receipts": [_pinrai_receipt(x) for x in it.get("receipts") or [] if isinstance(x, dict)][:12]})
    status = r["status"] if r["status"] in ("read", "off") else ("not read yet" if r["status"].startswith("not read") else "not read yet")
    # the team's W7: a read time only for a reading that happened (a "not read" try, such as the day's cap, stamps its time)
    return {"status": status, "read_at": r.get("read_at") if status == "read" else None, "model": r.get("model"), "items": items,
            "dropped": len(r.get("dropped") or []), "pending": len(r.get("pending") or [])}


EVM_RESULTS = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "stage4", "results")


def _evm_chain(c, mint: str) -> str | None:
    """base or bsc for a 0x coin (its gate row, else the scanner's record), None for any other coin or when not known."""
    if not str(mint or "").startswith("0x"):
        return None
    try:
        import gate as G
        ch = G.chain_of(c, mint)
        if ch in EVM_CHAIN:
            return ch
        r = c.execute("SELECT chain FROM tokens WHERE token=? AND chain IN ('base', 'bsc') LIMIT 1", (mint,)).fetchone()
        return r[0] if r else None
    except Exception:
        return None


def _evm_scored(mint: str, results_dir: str | None = None) -> bool:
    """True when the coin's EVM score finished: its result file is there and holds no error."""
    try:
        r = json.load(open(os.path.join(results_dir or EVM_RESULTS, mint + ".json")))
    except Exception:
        return False
    return isinstance(r, dict) and "error" not in r and r.get("mint", mint).lower() == mint.lower()


def coin_file(c, mint: str, now: float | None = None) -> dict:
    """231 step 4, the per-coin evidence file's body (contract "evidence/1", shared with the site): the coin's own rows
    only, ordered by kind, times as ISO UTC or null, a link only when https, onchain true (●) or false (○)."""
    rows = c.execute("SELECT from_kind, from_id, to_kind, to_id, what, value, unit, at, first_read, read_at, source, link, onchain, receipt "
                     "FROM evidence WHERE coin=?", (mint,)).fetchall()
    chain = _evm_chain(c, mint)
    out = []
    read_creator = any(r[4] == "created by" and r[12] for r in rows)   # the team's F1 on creator6: once the chain names the creator,
    for fk, fid, tk, tid, what, value, unit, at, first, read, source, link, onchain, receipt in rows:   # Jupiter's stands aside on the
        if read_creator and what == "created by" and receipt == "creator (Jupiter's token list)":    # page (kept in the table: 232)
            continue
        try:
            v = json.loads(value) if value is not None else None
        except Exception:
            v = None
        source = public_source(receipt, source, chain, bool(onchain))
        if what.startswith("linked: "):
            what, v = linked_words(what[len("linked: "):]), None
        out.append({"from": {"kind": fk, "id": fid}, "to": {"kind": tk, "id": tid}, "what": what, "value": v, "unit": unit,
                    "at": _iso(at), "first_read": _iso(first), "read": _iso(read), "source": source,
                    "link": link if isinstance(link, str) and link.startswith("https://") else None, "onchain": bool(onchain)})
    out.sort(key=lambda r: (_rank(r["what"]), r["what"], -(r["value"].get("amount") or 0) if isinstance(r["value"], dict) and isinstance(r["value"].get("amount"), (int, float)) else 0))
    try:                                                   # the team, 231: "basic" until the coin's full scan has added to it
        if chain:
            scan = "full" if _evm_scored(mint) else "basic"  # a Base/BNB coin: its EVM score's own result file (CHAINS, 252)
        else:
            full = c.execute("SELECT last_ok FROM tokens WHERE chain='solana' AND token=?", (mint,)).fetchone()
            scan = "full" if full and full[0] else "basic"
    except Exception:
        scan = "basic"
    body = {"contract": CONTRACT, "mint": mint, "as_of": _iso(now or time.time()), "scan": scan, "rows": out}
    try:                                                   # the gate's result in observed words, with its links
        import gate as G
        g = G.section(c, mint)
    except Exception:
        g = None
    if g is not None:
        body["gate"] = g
    ai = pinrai_section(mint)
    if ai is not None:
        body["pinrai"] = ai
    gb = grokbot_section(mint)                             # GrokBot's checked findings, ○, as read
    if gb is not None:
        body["grokbot"] = gb
    return body


def write_coin_file(c, mint: str, feed_dir: str, now: float | None = None) -> str | None:
    """Writes `<feed_dir>/evidence/<mint>.json` whole (a temporary file, then one rename); None when the coin has no rows."""
    if not _ADDR.match(mint or ""):
        return None
    body = coin_file(c, mint, now)
    if not body["rows"] and "gate" not in body and "pinrai" not in body:
        return None
    d = os.path.join(feed_dir, "evidence")
    os.makedirs(d, exist_ok=True)
    path = os.path.join(d, mint + ".json")
    with open(path + ".tmp", "w") as f:
        json.dump(body, f)
    os.replace(path + ".tmp", path)
    try:                                                   # the coin's feed file follows its gate's tags
        import sys as _sys
        _sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "feed"))
        import feed_export as _F
        _F.set_tags(mint, _F.gate_tags(body.get("gate")), feed_dir)
    except Exception:
        pass                                               # the evidence file is written; the tags follow at its next write
    try:                                                   # the evidence builder into the store
        import wires as _W
        _W.meter("e_build|evidence file|e_store|evidence file", 1, {"coin": mint, "rows": len(body["rows"]), "gate": (body.get("gate") or {}).get("status")})
    except Exception:
        pass
    return path


def backfill(c, results_dir: str, feed_dir: str, first=(), say=None) -> dict:
    """the team's order after 231 step 4: every coin PINR already scored gets its rows and its file, from the result files
    already on disk (no new read). The coins in `first` (the site's first page) go first, then every other result, newest
    first. Each result's read time is its file's own time, so an older result never overwrites a newer fact."""
    names = [n[:-5] for n in os.listdir(results_dir) if n.endswith(".json") and _ADDR.match(n[:-5])]
    have = set(names)
    when = {}
    for n in names:
        try:
            when[n] = os.path.getmtime(os.path.join(results_dir, n + ".json"))
        except OSError:
            pass
    order = [m for m in first if m in have] + sorted((m for m in names if m not in set(first)), key=lambda m: -when.get(m, 0))
    out = {"results": len(order), "stored": 0, "files": 0, "first_files": 0, "unreadable": 0}
    page = set(first)
    for i, m in enumerate(order):
        if store_file(c, m, results_dir, when.get(m)):
            out["stored"] += 1
            if write_coin_file(c, m, feed_dir, when.get(m)):
                out["files"] += 1
                out["first_files"] += m in page
        else:
            out["unreadable"] += 1
        if i % 200 == 199:
            c.commit()
            if say:
                say(f"{i + 1} of {len(order)} results")
    c.commit()
    return out


def for_coin(c, mint: str) -> list:
    """Every row kept for a coin and every row naming it, as dicts (newest read first)."""
    cur = c.execute("SELECT coin, from_kind, from_id, to_kind, to_id, what, value, unit, at, first_read, read_at, source, link, onchain, receipt "
                    "FROM evidence WHERE coin=? OR from_id=? OR to_id=? ORDER BY read_at DESC", (mint, mint, mint))
    names = [d[0] for d in cur.description]
    return [dict(zip(names, r)) for r in cur.fetchall()]
