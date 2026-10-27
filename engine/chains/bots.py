"""obvious bot trading on BNB launchpad coins, observed in PINR's own read of the launchpads' trade
events (Four.meme TokenPurchase/TokenSale, Flap TokenBought/TokenSold, streamed by chains/bnb.py), labelled with the wallets
and transactions behind it. A labelled coin leaves the lists and gets no further work (score, funding, prices); a search by
its address shows the label and its evidence. The label states what was observed, never a verdict.

Three patterns, each read per trader, from the store alone (no network):
  - an event wallet named under many different senders is a router (the team's F2 on chains19: 0xd36b6d64…, a contract,
    named under many senders): never named as a trader;
  - a sender that sent for many different person wallets (routers and itself not counted) is a relayer or trading service
    acting for many people: each (relayer, person) pair is its own
    trader, named by the person's wallet; the relayer is never named or made a known bot wallet; its trades through a
    router name no person and are not counted;
  - every other sender is its own trader, named by its own address, whether it traded through a router or directly.
  - repeat: one wallet trading the coin many times in a short span;
  - churn: several wallets each buying and selling the coin again and again within minutes (a volume bot's pattern);
  - launch-block bundle: many wallets buying the coin in its own launch block (a bundled launch).
A trade read from a public node carries no sender and is not counted (missing stays missing): a coin is labelled only on
what was read. The counts and windows PINR uses are withheld from the public copy (None below); observe() is redacted.
Base coins are not read here yet (their pools' trades are not streamed per trade): "not checked yet"."""
from __future__ import annotations
import json, os, time

KEEP_S = 2 * 86400                   # trades kept for the read; older ones are pruned
REPEAT_TRADES = None   # one wallet's trades of the coin within REPEAT_SPAN_S
REPEAT_SPAN_S = None   
CHURN_EACH = None   # buys and sells, each at least, by one wallet
CHURN_SPAN_S = None   # ... all within this span
CHURN_WALLETS = None   # wallets showing it
CHURN_SHARE = None   # ... making at least this share of the coin's read trades
BUNDLE_WALLETS = None   # wallets buying in the launch block (the creator not counted)
READ_WITHIN_S = 86400                # coins launched in the last day are read
ROUTER_SENDERS = None   # an event wallet named under this many senders is a router, never a trader
RELAY_WALLETS = None   # a sender acting for this many person wallets is a relayer
EXPLORER = "https://bscscan.com"
SOURCE = "PINR's read of the launchpad's trade events (BNB chain)"
GATE_SOURCE = "PINR's read"            # the gate's own word for a bot mark PINR observed (scanner/gate.mark_bot)
TAG = "bot"


def ensure(c) -> None:
    c.execute("CREATE TABLE IF NOT EXISTS btrades (mint TEXT, sender TEXT, side TEXT, t REAL, tx TEXT, block INTEGER, wallet TEXT)")
    if "wallet" not in [r[1] for r in c.execute("PRAGMA table_info(btrades)")]:
        c.execute("ALTER TABLE btrades ADD COLUMN wallet TEXT")    # a store from before the relayer fix; its rows say no wallet
    c.execute("CREATE INDEX IF NOT EXISTS btrades_mint ON btrades(mint, sender)")
    c.execute("CREATE INDEX IF NOT EXISTS btrades_sender ON btrades(sender, wallet)")


def record(c, sink: list, now: float | None = None) -> int:
    """The trades pass's trades (with a sender and an event wallet) into the store; older than KEEP_S pruned. Short writes only."""
    ensure(c)
    rows = [(m, s, side, t, tx, b, w) for m, s, w, side, t, tx, b in sink if s and w]
    c.executemany("INSERT INTO btrades (mint, sender, side, t, tx, block, wallet) VALUES (?,?,?,?,?,?,?)", rows)
    c.execute("DELETE FROM btrades WHERE t < ?", ((now or time.time()) - KEEP_S,))
    c.commit()
    return len(rows)


def observe(c, mint: str, creator: str | None, launch_block: int | None) -> dict | None:
    """Redacted in the public copy."""
    raise NotImplementedError("redacted: proprietary PINR logic is not included in the public copy")


def rows(mint: str, seen: dict, now: float) -> list:
    """Evidence rows (chains/evidence_evm's shape), ● on chain, one a wallet, each linked to a transaction."""
    out = []
    for w, v in sorted(seen["wallets"].items()):
        tx = v.get("tx")
        if v["pattern"] == "repeat":
            what, value = "traded it dozens of times within an hour", {k: v[k] for k in ("trades", "buys", "sells")}
        elif v["pattern"] == "churn":
            what, value = "bought and sold it again and again within minutes", {k: v[k] for k in ("buys", "sells", "minutes")}
        else:
            what, value = "bought it in its own launch block", None
        if v.get("via"):
            value = dict(value or {}, sent_by=v["via"])
        out.append({"coin": mint, "from_kind": "wallet", "from_id": w, "to_kind": "token", "to_id": mint, "what": what,
                    "value": None if value is None else json.dumps(value), "unit": None, "at": None,
                    "source": SOURCE + (f", tx {tx}" if tx else ""), "link": f"{EXPLORER}/tx/{tx}" if tx else f"{EXPLORER}/address/{w}",
                    "onchain": 1, "receipt": "bot trading (observed)"})
    return out


def label(seen: dict, now: float) -> dict:
    """The label kept in the CHAINS store for the gate (gate status "bot", item "bot_launch"; the
    coin file carries only its tags): what was observed, its kinds, wallets and source."""
    return {"words": "; ".join(seen["words"]), "kind": seen["kind"], "wallets": sorted(seen["wallets"]), "source": SOURCE,
            "at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(now))}


def one_pass(c, g, feed_dir: str, now: float | None = None, limit: int = 200) -> int:
    """BNB coins launched in the last day and not labelled: read (store only, no network), then label, evidence and file.
    Coins labelled."""
    import evidence_evm as EE, evidence as EV
    ensure(c)
    now = now or time.time()
    todo = c.execute("SELECT mint, creator, block FROM coins WHERE chain='bsc' AND bot_at IS NULL AND launched_at > ? "
                     "AND mint IN (SELECT DISTINCT mint FROM btrades) ORDER BY launched_at DESC LIMIT ?", (now - READ_WITHIN_S, limit)).fetchall()
    n = 0
    for m, cr, blk in todo:
        seen = observe(c, m, cr, blk)
        if not seen:
            continue
        b = label(seen, now)
        c.execute("UPDATE coins SET bot_at=?, bot=? WHERE mint=?", (now, json.dumps(b), m))
        c.commit()
        import gate as G                                       # the engine's gate (271): status "bot", never listed; its wallets become known
        G.mark_bot(g, m, b["words"], b["wallets"], GATE_SOURCE,
                   [{"what": r["what"], "value": r["from_id"], "link": r["link"]} for r in rows(m, seen, now)], now)
        g.commit()
        try:
            if EE.store(g, rows(m, seen, now), now):
                EV.write_coin_file(g, m, feed_dir)
        except Exception:
            pass
        n += 1                                                 # the file's "bot" tag arrives with the evidence write (the engine's tags)
    return n
