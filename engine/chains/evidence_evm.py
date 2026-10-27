"""a design decision for Base and BNB coins: a finished score's readings go into the
evidence trail as Solana's do, in the same table and row shape (`scanner/evidence.py`), with ● for what was read on chain
and ○ for what a launchpad's record, an outside service or the coin's own words reported. The links go to the coin's own
chain's explorer (Basescan, BscScan). Only what the score's receipts hold is written; nothing is guessed.

The evidence mapper in scanner/evidence.py reads Solana's receipt names; the EVM scorer (stage4/run_evm.py) names its own,
so this maps those, and writes with the same upsert as evidence.store (the newest read wins, the first read is kept)."""
from __future__ import annotations
import json, re, time

EXPLORER = {"base": "https://basescan.org", "bsc": "https://bscscan.com"}
_ADDR = re.compile(r"^0x[0-9a-fA-F]{40}$")
_TX = re.compile(r"\b(0x[0-9a-fA-F]{64})\b")
_URL = re.compile(r"^https?://\S+$")
LAUNCHPAD_PAGE = {"Clanker": "https://www.clanker.world/clanker/%s", "Zora": "https://zora.co/coin/base:%s",
                  "Four.meme": "https://four.meme/token/%s", "Flap": "https://flap.sh/bnb/%s",
                  "Virtuals": "https://app.virtuals.io/prototypes/%s"}


def _src_addr(r, addr_link):
    """The contract the receipt's own source names (e.g. "PositionManager 0x…"), linked; None when it names none."""
    m = re.search(r"0x[0-9a-fA-F]{40}", str(r.get("source") or ""))
    return addr_link(m.group(0).lower()) if m else None


NOTES_UNIT = "notes GoPlus returned"   # line 13: what GoPlus returned, never "flagged"


def _a(v) -> str | None:
    return v.lower() if isinstance(v, str) and _ADDR.match(v) else None


def rows(out: dict, coin_info: dict | None = None, links: dict | None = None) -> list:
    """The evidence rows of one Base/BNB score. coin_info: this service's own read of the coin ({launchpad, launch_tx,
    launched_at}); links: the coin's own links as its seen file carried them ({x, website, telegram, source, read_at})."""
    coin, chain = _a(out.get("mint")), out.get("chain")
    if not coin or chain not in EXPLORER:
        return []
    ex = EXPLORER[chain]
    addr_link = lambda a: f"{ex}/address/{a}"
    tx_link = lambda h: f"{ex}/tx/{h}"
    rec = {}
    for r in out.get("receipts") or []:
        if isinstance(r, dict) and isinstance(r.get("what"), str):
            rec.setdefault(r["what"], r)
    found = []

    def row(r, fk, fid, tk, tid, what, value=None, unit=None, at=None, link=None, onchain=1):
        if not fid or not tid:
            return
        found.append({"coin": coin, "from_kind": fk, "from_id": fid, "to_kind": tk, "to_id": tid, "what": what,
                      "value": None if value is None else json.dumps(value, default=str), "unit": unit, "at": at,
                      "source": str(r.get("source") or "")[:300], "link": link, "onchain": onchain, "receipt": r.get("what")})

    def txof(r):
        m = _TX.search(str(r.get("source") or ""))
        return m.group(1) if m else None

    creator = None                                             # the creator, from the launchpad's own creation event (● on chain)
    for name in ("creator (Flap TokenCreated)", "creator (four.meme TokenCreate)"):
        r = rec.get(name)
        if r and _a(r.get("value")):
            creator = _a(r["value"])
            h = txof(r)
            row(r, "token", coin, "wallet", creator, "created by", link=tx_link(h) if h else addr_link(creator))
            break
    r = rec.get("Clanker creation (factory TokenCreated)")
    if r and isinstance(r.get("value"), dict) and _a(r["value"].get("creator")):
        creator = _a(r["value"]["creator"])
        h = txof(r)
        row(r, "token", coin, "wallet", creator, "created by", link=tx_link(h) if h else addr_link(creator))
        if _a(r["value"].get("msg_sender")) and _a(r["value"]["msg_sender"]) != creator:
            row(r, "token", coin, "wallet", _a(r["value"]["msg_sender"]), "launched by", link=tx_link(h) if h else None)
    r = rec.get("launched through a contract (launch bot / service), not a person")
    if r and isinstance(r.get("value"), list):
        for w in r["value"]:
            if _a(w):
                row(r, "wallet", _a(w), "contract", "launch service", "is a contract (a launch service, not a person)", link=addr_link(_a(w)))
    r = next((v for k, v in rec.items() if k.startswith("dev team (named by ")), None)    # Clanker's, Zora's (checklist 6)
    if r and isinstance(r.get("value"), dict):
        for role, ws in r["value"].items():
            for w in ws if isinstance(ws, list) else []:
                if _a(w):
                    row(r, "token", coin, "wallet", _a(w), f"dev team: {str(role)[:40]}", link=addr_link(_a(w)))
    r = rec.get("dev buy at launch (EthDevBuy)")
    if r and isinstance(r.get("value"), list):
        h = txof(r)
        for b in r["value"]:
            if isinstance(b, dict) and _a(b.get("recipient")):
                row(r, "wallet", _a(b["recipient"]), "token", coin, "bought at launch", {k: b.get(k) for k in ("eth", "tokens")}, "ETH / tokens",
                    link=tx_link(h) if h else addr_link(_a(b["recipient"])))
    r = rec.get("dev group (linked wallets)")
    if r and creator and isinstance(r.get("value"), dict):
        for w, why in r["value"].items():
            if _a(w) and _a(w) != creator:
                row(r, "wallet", creator, "wallet", _a(w), "linked: " + str(why)[:80], link=addr_link(_a(w)))
    r = rec.get("dev holdings")
    if r and creator and isinstance(r.get("value"), dict):
        row(r, "wallet", creator, "token", coin, "holds (dev team)", {k: r["value"].get(k) for k in ("wallets", "share")}, "tokens / share",
            link=addr_link(creator))
    r = rec.get("dev conduct (group)")
    if r and creator and isinstance(r.get("value"), dict):
        row(r, "wallet", creator, "token", coin, "dev moves", r["value"], r.get("unit"), link=addr_link(creator))
    r = rec.get("creator rewards (locker record)")
    if r and isinstance(r.get("value"), dict):
        for w in r["value"].get("recipients") or []:
            if _a(w):
                row(r, "token", coin, "wallet", _a(w), "creator rewards paid to", link=addr_link(_a(w)))
    r = rec.get("token contract")
    if r and isinstance(r.get("value"), dict):
        v = r["value"]
        if _a(v.get("owner")):
            row(r, "token", coin, "wallet", _a(v["owner"]), "owned by (contract owner)", {k: v.get(k) for k in ("template", "mode") if v.get(k) is not None} or None,
                link=addr_link(_a(v["owner"])))
        if _a(v.get("clone_of")):
            row(r, "token", coin, "contract", _a(v["clone_of"]), "copy of the template", v.get("template"), link=addr_link(_a(v["clone_of"])))
    r = rec.get("PancakeSwap v2 pool")
    if r and isinstance(r.get("value"), dict) and _a(r["value"].get("pool")):
        p = _a(r["value"]["pool"])
        row(r, "token", coin, "pool", p, "trades in pool", {k: r["value"].get(k) for k in ("lp_burned_share",) if r["value"].get(k) is not None} or None,
            link=addr_link(p))
    made = rec.get("Clanker creation (factory TokenCreated)")   # checklist 6: the pool is made and its liquidity locked in the creation tx
    made_tx = txof(made) if made else None
    locker = _a((made or {}).get("value", {}).get("locker")) if isinstance((made or {}).get("value"), dict) else None
    r = rec.get("Uniswap v4 pool")
    if r and isinstance(r.get("value"), dict) and isinstance(r["value"].get("pool_id"), str):
        pid = r["value"]["pool_id"]
        row(r, "token", coin, "pool", pid, "trades in pool (Uniswap v4)",
            link=tx_link(made_tx) if made_tx else (f"https://app.uniswap.org/explore/pools/{chain}/{pid}" if re.fullmatch(r"0x[0-9a-fA-F]{64}", pid) else None))
    r = rec.get("liquidity held by the Clanker locker")
    if r and isinstance(r.get("value"), dict) and r["value"].get("locked_share_of_pool_value") is not None:
        row(r, "token", coin, "locker", "Clanker locker", "liquidity locked", r["value"]["locked_share_of_pool_value"], "share of pool value",
            link=addr_link(locker) if locker else (tx_link(made_tx) if made_tx else _src_addr(r, addr_link)))
    r = rec.get("liquidity held by the Zora hook")
    if r and isinstance(r.get("value"), dict):                # scored as locked; the page shows what the owners can do
        m_hook = re.search(r"0x[0-9a-fA-F]{40}", str(r.get("source") or ""))
        hook = _a(m_hook.group(0)) if m_hook else None
        if hook:
            row(r, "token", coin, "contract", hook, "liquidity held by Zora's hook",
                {"locked_share": r["value"].get("locked_share_of_pool_value"),
                 "owners_can": "move it into another pool on Zora's approved list; no one can withdraw it"},
                "share of pool value", link=addr_link(hook))
    r = rec.get("GoPlus token security (lead)")
    if r and isinstance(r.get("value"), dict):
        flags = {k: v for k, v in r["value"].items() if v not in (None, "", "0")}
        row(r, "token", coin, "check", "GoPlus", "GoPlus security check (a lead)", flags or 0, NOTES_UNIT,   # line 13: observed words, a count when none
            link=f"https://gopluslabs.io/token-security/{56 if chain == 'bsc' else 8453}/{coin}", onchain=0)
    info = coin_info or {}
    lp = info.get("launchpad")
    if lp:                                                    # the launchpad, as this service read it from its list or factory event
        tx = info.get("launch_tx") if isinstance(info.get("launch_tx"), str) and _TX.fullmatch(info["launch_tx"] or "") else None
        src = {"Four.meme": "Four.meme factory event (BNB Chain)", "Flap": "Flap factory event (BNB Chain)"}.get(lp, f"{lp}'s own list")
        base = {"what": "launch (CHAINS)", "source": src + (f", tx {tx}" if tx else "")}
        onchain = 1 if lp in ("Four.meme", "Flap") else 0
        row(base, "token", coin, "launchpad", lp, "launched on", link=(LAUNCHPAD_PAGE[lp] % coin) if lp in LAUNCHPAD_PAGE else None, onchain=onchain)
        if isinstance(info.get("launched_at"), (int, float)):
            row(base, "token", coin, "event", "launch", "launched", at=info["launched_at"], link=tx_link(tx) if tx else None, onchain=onchain)
    lk = links or {}
    for key, kind in (("x", "x"), ("website", "site"), ("telegram", "telegram")):
        u = lk.get(key)
        if isinstance(u, str) and _URL.match(u):
            row({"what": "token's own links", "source": str(lk.get("source") or "")}, "token", coin, kind, u, "lists its own link", link=u, onchain=0)
    return found


def store(c, found: list, now: float | None = None) -> int:
    """The rows into the evidence table, with evidence.store's own upsert (the newest read wins; the first read is kept)."""
    import evidence as EV
    EV.ensure(c)
    now = now or time.time()
    for r in found:
        c.execute("INSERT INTO evidence (coin, from_kind, from_id, to_kind, to_id, what, value, unit, at, first_read, read_at, source, link, onchain, receipt) "
                  "VALUES (:coin, :from_kind, :from_id, :to_kind, :to_id, :what, :value, :unit, :at, :now, :now, :source, :link, :onchain, :receipt) "
                  "ON CONFLICT (coin, from_id, to_id, what) DO UPDATE SET "
                  "value=CASE WHEN excluded.read_at >= evidence.read_at THEN excluded.value ELSE evidence.value END, "
                  "unit=CASE WHEN excluded.read_at >= evidence.read_at THEN excluded.unit ELSE evidence.unit END, "
                  "at=COALESCE(CASE WHEN excluded.read_at >= evidence.read_at THEN excluded.at ELSE evidence.at END, evidence.at, excluded.at), "
                  "source=CASE WHEN excluded.read_at >= evidence.read_at THEN excluded.source ELSE evidence.source END, "
                  "link=CASE WHEN excluded.read_at >= evidence.read_at THEN excluded.link ELSE evidence.link END, "
                  "onchain=CASE WHEN excluded.read_at >= evidence.read_at THEN excluded.onchain ELSE evidence.onchain END, "
                  "receipt=CASE WHEN excluded.read_at >= evidence.read_at THEN excluded.receipt ELSE evidence.receipt END, "
                  "first_read=MIN(evidence.first_read, excluded.first_read), read_at=MAX(evidence.read_at, excluded.read_at)", dict(r, now=now))
    c.commit()
    return len(found)
