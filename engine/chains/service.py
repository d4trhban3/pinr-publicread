"""PINR_Chains: Base and BNB coins into PINR, as one service beside the scanner.

  python3 chains/service.py run      the service (three threads: discovery + gate, documents, market + quiet)
  python3 chains/service.py once     one pass of each, printed (a dry check on a machine)
  python3 chains/service.py status   coins per launchpad in the store

Per new coin: its seen feed file, its gate row in the scanner's own gate table, its picture and links (Flap: the coin's metadata
document through the shared IPFS gateway rests), and once pooled its price, liquidity and 24-hour trades
(GeckoTerminal on Base, DexScreener on BNB), which also feed the quiet rule through `scanner/quiet.py`.
Each launchpad can be switched off from /control once it is in the routing catalog (`scanner/routing.py`), or here with
PINR_CHAINS_OFF=clanker,zora,... . Nothing is deleted; a seen file that never gets a score leaves after a day, as every
seen file does (the scanner's `seen_feed.expire`).

Shared stores this touches: `frontend-feed/` (seen files, evidence files, `_quiet.json`) and `scanner/scanner.sqlite`
(tables gate, gate_events, quiet). Its own store: `chains/chains.sqlite`. Outside connections: the five free keyless
sources in sources.py, bnb.py and market.py, and the public IPFS gateways (stage2/readers.py's list and rests)."""
from __future__ import annotations
import calendar, json, os, sqlite3, sys, threading, time, traceback

HERE = os.path.dirname(os.path.abspath(__file__))
ENGINE = os.path.dirname(HERE)
sys.path[:0] = [HERE, os.path.join(ENGINE, "feed"), os.path.join(ENGINE, "scanner"), os.path.join(ENGINE, "stage2")]
import sources as S
import bnb as B
import feed as FD
import market as MK

STORE = os.environ.get("PINR_CHAINS_DB") or os.path.join(HERE, "chains.sqlite")
SCANNER_DB = os.environ.get("PINR_SCANNER_DB") or os.path.join(ENGINE, "scanner", "scanner.sqlite")
PASS_S = 15
BNB_EVERY = 30
DOCS_BUDGET = 20             # Flap documents read a pass (one gateway request each, the gateways taken in turn)
COUNT_BUDGET = 20            # Base creators' launch counts asked a pass (one request each to the launchpad's own API)
MARKET_EVERY = 300           # a listed coin's price and trades are read again after this long
MARKET_CALLS = 4             # calls per chain a market pass (30 coins each)
QUIET_EVERY = 120
QUIET_CALLS = 20             # calls per chain a quiet pass (30 coins each): every listed Base/BNB coin, old files included
OLD_EVERY = 1800             # the feed folder's other Base/BNB files are listed again after this long
SCORE_EVERY = 20             # seconds between scores (one coin at a time; a score itself takes minutes on the free nodes)
WATCH_LAG_S = 300            # a curve coin is judged only while its launchpad's trade watch has read to within this of now
LISTED_S = 2 * 86400         # coins the market and quiet passes follow: launched in the last two days, file still there
DISCOVERY_NAMES = {"clanker": "clanker", "zora": "zora", "virtuals": "virtuals", "gecko_virtuals": "virtuals",
                   "fourmeme": "fourmeme", "flap": "flap"}


def store(path: str = None):
    c = sqlite3.connect(path or STORE, timeout=30)
    c.execute("PRAGMA journal_mode=WAL")
    c.execute("""CREATE TABLE IF NOT EXISTS coins (mint TEXT PRIMARY KEY, chain TEXT, launchpad TEXT, by TEXT, creator TEXT,
                 launched_at REAL, name TEXT, ticker TEXT, image TEXT, meta_uri TEXT, first_seen REAL, written INTEGER,
                 doc_at REAL, doc_done INTEGER DEFAULT 0, dev_count INTEGER, gated_at REAL, market_at REAL)""")
    c.execute("CREATE INDEX IF NOT EXISTS coins_creator ON coins(chain, creator)")
    c.execute("CREATE INDEX IF NOT EXISTS coins_launched ON coins(launched_at)")
    have = [r[1] for r in c.execute("PRAGMA table_info(coins)")]
    for col, kind in (("launch_tx", "TEXT"), ("block", "INTEGER"), ("score_tries", "INTEGER DEFAULT 0"), ("score_at", "REAL"), ("scored", "REAL"),
                      ("facts_at", "REAL"), ("social_at", "REAL"), ("scored_ver", "INTEGER"),
                      ("funding_at", "REAL"), ("funding_tries", "INTEGER DEFAULT 0"), ("funding_try_at", "REAL"), ("named_at", "REAL"), ("bot_at", "REAL"), ("bot", "TEXT"),
                      ("launch_sender", "TEXT"), ("funding_ver", "INTEGER"),   # checklist 6: who sent the launch (SQD); the funding read's version
                      ("quote", "TEXT")):                    # line 11: a BNB coin's quote coin ("BNB" or its address), read once   # chains/funding.py (checklist 6)   # scored_ver: the launchpad's reader version (score.READER_VER)   # social_at: a Zora coin's creator profile written (chains/zora_social.py)                     # facts_at: a Virtuals coin's verifiable facts written (chains/virtuals_facts.py)
        if col not in have:                                    # the creation the scorer needs, and its attempts
            c.execute(f"ALTER TABLE coins ADD COLUMN {col} {kind}")
    c.execute("CREATE TABLE IF NOT EXISTS cursors (kind TEXT PRIMARY KEY, block INTEGER)")
    c.execute("CREATE TABLE IF NOT EXISTS gaps (kind TEXT, from_block INTEGER, to_block INTEGER, noted REAL)")   # BNB ranges no node served
    c.execute("CREATE TABLE IF NOT EXISTS trades (mint TEXT PRIMARY KEY, last REAL)")       # a BNB curve coin's latest trade event read
    c.execute("CREATE TABLE IF NOT EXISTS watch (kind TEXT PRIMARY KEY, since REAL)")       # when each trade watch last began unbroken
    if "read_to" not in [r[1] for r in c.execute("PRAGMA table_info(watch)")]:
        c.execute("ALTER TABLE watch ADD COLUMN read_to REAL")                               # the time of the last block it has read
    return c


def scanner_db(path: str = None):
    return sqlite3.connect(path or SCANNER_DB, timeout=30)


def on(name: str) -> bool:
    """A launchpad's discovery: off by PINR_CHAINS_OFF, or by the operator's routing once the catalog names it."""
    key = DISCOVERY_NAMES.get(name, name)
    if key in {x.strip() for x in os.environ.get("PINR_CHAINS_OFF", "").split(",") if x.strip()}:
        return False
    try:
        import routing as RT
        if key in RT.defaults()["discovery"]:
            return RT.discovery_on(key)
    except Exception:
        pass
    return True


_TICKS = {}                                                    # the tick files (one writer: this service) and BNB's price, kept between passes
TICKS_BACK_CALLS = 4                                           # history calls a pass for coins listed before their file existed
BNB_PRICE_EVERY = 60


def _bnb_usd(now: float):
    """(BNB's dollar price, its source) from Chainlink's feed on the chain, read at most once a minute; (None, why) unread."""
    got = _TICKS.get("bnb")
    if not got or now - got[2] >= BNB_PRICE_EVERY:
        from evm import native_usd
        p, why = native_usd("bsc")
        got = (p, why, now) if p else (got[0], got[1], got[2]) if got else (None, why, now)
        _TICKS["bnb"] = got
    return got[0], got[1]


TICKS_VER = 2                          # 2: coins quoted in another coin are priced too; a sweep under 1 is done again for them


def _quote_price(q: str):
    """(dollars a whole quote coin, its source, its symbol) for an 18-decimal quote coin, from its own PancakeSwap pool
    anchored to Chainlink (stage4/quote_price.py, the scorer's reader); None when it names no price or is not 18 decimals."""
    try:
        from flap_reader import erc20
        from evm import dec, dec_string
        from quote_price import quote_usd
        d = erc20(q, "decimals()")
        if not d or dec(d[0], "uint256") != 18:
            return None
        p, src = quote_usd(q)
        if not p:
            return None
        w = erc20(q, "symbol()")
        try:
            sym = dec_string("0x" + "".join(w), w[0]) if w else None
        except Exception:
            sym = None
        return (p, src, sym or q[:10])
    except Exception:
        return None


def ticks_pass(c, ticks: list, now: float, cursors: dict, post=None, sleep=time.sleep, exists=None, quote_fn=None, quote_price_fn=None,
               shown_fn=None) -> int:
    """Line 11: the pass's trades into the listed BNB coins' tick files; then, for listed coins with no file yet, their
    history up to the live cursor, a few SQD calls a pass (a sweep from the oldest such coin's launch block). Network
    first (BNB's price, quotes, history), then the files and short writes. Ticks written."""
    import ticks_evm as TE, feed_export as FE
    files = _TICKS.get("files")
    if files is None or files.dir != os.path.join(FE.FEED_DIR, "ticks"):
        files = _TICKS["files"] = TE.TickFiles(os.path.join(FE.FEED_DIR, "ticks"))
    import funding as FN_
    shown = (shown_fn or FN_.SHOWN_FN or FN_._site_list)()     # SITE's measure of 26 Oct: files for the site's listed coins only (7,236
    rows = [r for r in listed(c, now, exists or _feed_has) if r[1] == "bsc" and (shown is None or r[0] in shown)]   # were written, every
    # BNB coin of 2 days); no list read yet (the feed down since this service started): every listed coin, so no trade is lost
    on_list = {m for m, _ch, _at in rows}
    c.execute("CREATE TABLE IF NOT EXISTS ticks_back (kind TEXT PRIMARY KEY, block INTEGER)")   # the sweep's own place, never the
    back = dict(c.execute("SELECT kind, block FROM ticks_back").fetchall())                       # discovery cursors
    done_to = back.pop("ticks_back_done", 0)
    if back.pop("ticks_ver", 0) < TICKS_VER:                   # coins left out by an earlier version: swept again
        done_to = 0
        back.pop("ticks_back", None); back.pop("ticks_back_end", None)
        c.execute("DELETE FROM ticks_back"); c.execute("INSERT INTO ticks_back VALUES ('ticks_ver', ?)", (TICKS_VER,))
        c.commit()                                             # never held open across the sweep's network reads (07:40-13:23 UTC, 26 Oct)
    if "ticks_back" not in back:                               # a sweep for the coins listed with no file yet, launched after the last sweep
        need = [m for m, blk in c.execute(f"SELECT mint, block FROM coins WHERE mint IN ({','.join('?' * len(on_list))})", sorted(on_list))
                if blk and blk > done_to and not files.has(m)] if on_list else []
        if need:
            lo = c.execute(f"SELECT MIN(block) FROM coins WHERE mint IN ({','.join('?' * len(need))})", need).fetchone()[0]
            end = min(v for k, v in cursors.items() if k in B.TRADES) if any(k in B.TRADES for k in cursors) else None
            if lo and end and lo <= end:
                back = {"ticks_back": lo - 1, "ticks_back_end": end}
    old, old_read = [], None
    if "ticks_back" in back and back["ticks_back"] < back["ticks_back_end"]:
        lo = back["ticks_back"] + 1
        hi = min(back["ticks_back_end"], lo + B.NODES[0][1] * TICKS_BACK_CALLS - 1)
        got_all, times, read = {}, {}, True
        for kind, (address, t0) in B.TRADES.items():
            got = B.logs(address, t0, lo, hi, **({"post": post} if post else {}), sleep=sleep)
            if got is None:
                read = False; break
            B.decode_trades(kind, got, post or B._post, times, {}, None, old)
        old_read = hi if read else None                        # advanced below only once the trades could be priced
    kinds = {m: kind for kind, m, *_ in ticks + old if m in on_list}
    quotes = {m: q for m, q in c.execute(f"SELECT mint, quote FROM coins WHERE mint IN ({','.join('?' * len(kinds))})", sorted(kinds))} if kinds else {}
    fresh = {}
    for m, kind in kinds.items():
        if quotes.get(m) is None:
            q = (quote_fn or _quote)(m, kind)
            if q:
                fresh[m] = quotes[m] = q
    bnb, src = _bnb_usd(now)
    if old_read is not None and bnb:                           # the team's note on a32a466a: no BNB price, the range is read again
        back["ticks_back"] = old_read
    prices = {"BNB": (bnb, src or "", "BNB") if bnb else None}
    for q in {quotes.get(m) for m in kinds} - {None, "BNB"}:   # each other quote coin's price, read before any write
        hit = _TICKS.setdefault("quotes", {}).get(q)
        if not hit or now - hit[1] >= BNB_PRICE_EVERY:
            hit = ((quote_price_fn or _quote_price)(q), now)
            _TICKS["quotes"][q] = hit
        prices[q] = hit[0]
    n = TE.add_trades(files, ticks + old, on_list, lambda m: prices.get(quotes.get(m)))
    files.flush(now)
    for m, q in fresh.items():
        c.execute("UPDATE coins SET quote=? WHERE mint=?", (q, m))
    for k in ("ticks_back", "ticks_back_end"):
        if k in back:
            c.execute("INSERT INTO ticks_back VALUES (?,?) ON CONFLICT(kind) DO UPDATE SET block=excluded.block", (k, back[k]))
    if back.get("ticks_back") is not None and back["ticks_back"] >= back.get("ticks_back_end", 0):   # the sweep is done: a coin
        c.execute("DELETE FROM ticks_back WHERE kind IN ('ticks_back', 'ticks_back_end')")           # launched after its end starts
        c.execute("INSERT INTO ticks_back VALUES ('ticks_back_done', ?) ON CONFLICT(kind) DO UPDATE SET block=excluded.block", (back["ticks_back_end"],))
    c.commit()
    return n


def _quote(mint: str, kind: str) -> str | None:
    """A BNB coin's quote coin from its launchpad's own contract (Four.meme's helper, Flap's portal): "BNB" for the zero
    address, else the address; None unread."""
    try:
        if kind == "fourmeme_trades":
            import fourmeme_reader as FM
            q = (FM.info(mint) or {}).get("quote")
        else:
            import flap_reader as FL
            q = (FL.state(mint) or {}).get("quoteTokenAddress")
    except Exception:
        return None
    if not isinstance(q, str) or not q.startswith("0x"):
        return None
    return "BNB" if int(q, 16) == 0 else q.lower()


def _feed_has(mint: str) -> bool:
    import seen_feed as SF
    return SF.read_file(mint) is not None


def add(c, records: list, now: float, write=None) -> dict:
    """New coins into the store and their seen files. A coin already in the store is left as first read. Returns
    {seen_by: written}."""
    fresh, seen = [], set()
    for r in records:
        if not r.get("mint") or r["mint"] in seen:
            continue
        seen.add(r["mint"])
        if c.execute("SELECT 1 FROM coins WHERE mint=?", (r["mint"],)).fetchone():
            continue
        fresh.append(r)
    got = FD.write_new(fresh, now, write)
    for r in fresh:
        c.execute("INSERT OR IGNORE INTO coins (mint, chain, launchpad, by, creator, launched_at, name, ticker, image, meta_uri, first_seen, written, doc_done, launch_tx, block, named_at, launch_sender) "
                  "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                  (r["mint"], r["chain"], r["launchpad"], r["by"], r.get("creator"), r.get("launched_at"), r.get("name"), r.get("ticker"),
                   r.get("image"), r.get("meta_uri"), now, 1 if r.get("launched_at") and now - r["launched_at"] <= FD.MAX_AGE_S else 0,
                   0 if (r.get("by") == "flap_chain" and r.get("meta_uri")) else 1,
                   r.get("launch_tx") if isinstance(r.get("launch_tx"), str) and r["launch_tx"].startswith("0x") else None, r.get("block"),
                   now, r.get("launch_sender")))               # named_at: its file is written with the feed's launchpad words already
    c.commit()
    return got


_BNB_FAILS: dict = {}            # passes in a row each BNB factory's range went unserved (bnb.GAP_TRIES)
_TRADE_FAILS: dict = {}


def discover(c, now: float, due: dict, fetch=None, post=None, write=None) -> dict:
    """One discovery pass: the Base lists that are due and the BNB factory events. Returns {seen_by: written}."""
    recs = []
    for name, (url, parse, every) in S.LISTS.items():
        if now - due.get(name, 0) < every or not on(name):
            continue
        due[name] = now
        st, body = S.get(url, fetch)
        if st == 200:
            recs += parse(body)
    if now - due.get("bnb", 0) >= BNB_EVERY and (on("fourmeme") or on("flap")):
        due["bnb"] = now
        cur = {k: b for k, b in c.execute("SELECT kind, block FROM cursors")}
        gaps = []
        got, cur2 = B.one_pass(cur, **({"post": post} if post else {}), fails=_BNB_FAILS, gaps=gaps)
        for kind, lo, hi in gaps:
            c.execute("INSERT INTO gaps VALUES (?,?,?,?)", (kind, lo, hi, now))
            print(f"chains: BNB {kind} blocks {lo}-{hi} served by no node after {B.GAP_TRIES} passes: noted as a gap, passed over", flush=True)
        recs += [r for r in got if on("fourmeme" if r["by"] == "fourmeme_chain" else "flap")]
        c.commit()                                                 # the gap notes, before the trades' network read (no write held open)
        tgaps = []
        sink = []                                                  # each trade with its sender, for the bot read (271c)
        ticks = []                                                 # each trade with its amounts, for the coins' tick files (line 11)
        last, cur3, began = B.trades_pass(cur2, **({"post": post} if post else {}), fails=_TRADE_FAILS, gaps=tgaps, sink=sink, ticks_out=ticks)
        try:
            ticks_pass(c, ticks, now, cur3, **({"post": post} if post else {}))
        except Exception:
            traceback.print_exc()                                  # a chart file never stops the trade watch
        import bots as BT
        BT.record(c, sink, now)
        c.executemany("INSERT INTO trades VALUES (?,?) ON CONFLICT(mint) DO UPDATE SET last=MAX(last, excluded.last)", list(last.items()))
        broken = {kind for kind, _lo, _hi in tgaps}
        for kind, lo, hi in tgaps:
            c.execute("INSERT INTO gaps VALUES (?,?,?,?)", (kind, lo, hi, now))
        for kind, (t0, t1) in began.items():                       # an unbroken watch starts at its first block; a gap restarts it
            c.execute("INSERT INTO watch (kind, since) VALUES (?,?) ON CONFLICT(kind) DO NOTHING", (kind, t0 or now))
            if t1:
                c.execute("UPDATE watch SET read_to=MAX(COALESCE(read_to, 0), ?) WHERE kind=?", (t1, kind))
        for kind in broken:
            c.execute("UPDATE watch SET since=? WHERE kind=?", (now, kind))
        for k, b in cur3.items():
            c.execute("INSERT INTO cursors VALUES (?,?) ON CONFLICT(kind) DO UPDATE SET block=excluded.block", (k, b))
        c.commit()
    order = {"clanker_api": 0, "zora_explore": 0, "virtuals_api": 0, "fourmeme_chain": 0, "flap_chain": 0, "gecko_virtuals": 1}
    recs.sort(key=lambda r: order.get(r["by"], 2))               # a launchpad's own record wins over GeckoTerminal's
    return add(c, recs, now, write)


def read_docs(c, now: float, docs=None, update=None, budget: int = DOCS_BUDGET) -> int:
    """Flap coins' metadata documents: the picture and the links the creator launched with. A document no gateway
    answered is tried again after an hour (missing stays missing, never "no links")."""
    if docs is None:
        import basic as BA                                          # the scanner's paced reader: ONE gateway a document, shared rests
        docs = BA.PacedDocs()
    if update is None:
        import seen_feed as SF
        update = SF.update_seen
    import basic as BA
    rows = c.execute("SELECT mint, meta_uri FROM coins WHERE doc_done=0 AND meta_uri IS NOT NULL AND (doc_at IS NULL OR doc_at < ?) "
                     "ORDER BY launched_at DESC LIMIT ?", (now - 3600, budget)).fetchall()
    n = 0
    for mint, uri in rows:
        doc = docs(uri)
        if not isinstance(doc, dict):
            c.execute("UPDATE coins SET doc_at=? WHERE mint=?", (now, mint))
            c.commit()                                             # never a write open across the next network read
            continue
        img = S.picture(doc.get("image"))
        lk = {k: v for k, v in BA.links_from(doc).items() if v}
        fields = {}
        if img:
            fields["image_url"] = img
        if lk:
            fields["links"] = dict(lk, source="Flap metadata (IPFS)", read_at=FD._iso(now))
        if fields:
            try:
                update(mint, **fields)
            except Exception:
                pass
        # a coin the gate took before its picture was read is taken again with it (the picture checks need it)
        c.execute("UPDATE coins SET doc_at=?, doc_done=1, image=COALESCE(?, image), gated_at=CASE WHEN ? IS NULL THEN gated_at END "
                  "WHERE mint=?", (now, img, img, mint))
        c.commit()
        n += 1
    c.commit()
    return n


def gate(c, g, now: float, feed_dir: str, fetch=None, budget: int = COUNT_BUDGET) -> int:
    """Coins not yet in the gate whose token data is read (Flap: its document read or tried): their creator's launch count,
    then the gate's own record and results. A Base count the launchpad did not give leaves the coin for a later pass."""
    rows = c.execute("SELECT mint, chain, launchpad, by, creator, launched_at, name, ticker, image FROM coins WHERE gated_at IS NULL "
                     "AND (doc_done=1 OR doc_at IS NOT NULL) ORDER BY launched_at DESC LIMIT 200").fetchall()
    out, asked = [], 0
    for mint, chain, lp, by, creator, at, name, ticker, image in rows:
        r = {"mint": mint, "chain": chain, "launchpad": lp, "by": by, "creator": creator, "launched_at": at, "name": name, "ticker": ticker, "image": image}
        n = None
        if creator and chain == "bsc":
            n = c.execute("SELECT COUNT(*) FROM coins WHERE chain=? AND creator=?", (chain, creator)).fetchone()[0]
        elif creator:
            if asked >= budget:
                continue
            asked += 1
            n = S.creator_count(lp, creator, fetch)
            if n is None:
                continue                                           # not answered: asked again next pass
        out.append(FD.gate_row(r, n))
    touched = FD.gate_feed(g, out, feed_dir, now) if out else 0     # every network read is done: short writes only from here
    c.executemany("UPDATE coins SET gated_at=?, dev_count=? WHERE mint=?",
                  [(now, x["audit"]["devMints"], x["id"]) for x in out])
    c.commit()
    return touched


def listed(c, now: float, exists=_feed_has) -> list:
    """[(mint, chain, launched_at)] the market and quiet passes follow: launched in LISTED_S and its feed file still there."""
    return [(m, ch, at) for m, ch, at in c.execute("SELECT mint, chain, launched_at FROM coins WHERE launched_at > ? AND bot_at IS NULL "
                                                   "ORDER BY launched_at DESC",
                                                   (now - LISTED_S,)) if exists(m)]


def market_pass(c, now: float, get=None, update=None, exists=_feed_has) -> dict:
    """Price, liquidity and 24-hour volume into the seen files of the coins due, newest first. Returns {chain: coins answered}."""
    if update is None:
        import seen_feed as SF
        update = SF.update_seen
    out = {}
    due_at = {m: t for m, t in c.execute("SELECT mint, market_at FROM coins WHERE launched_at > ?", (now - LISTED_S,))}
    shown = {m: FD.SHOWN[lp] for m, lp in c.execute("SELECT mint, launchpad FROM coins WHERE launched_at > ?", (now - LISTED_S,)) if lp in FD.SHOWN}
    coins = listed(c, now, exists)
    for chain in ("base", "bsc"):
        due = [m for m, ch, _at in coins if ch == chain and not (due_at.get(m) and now - due_at[m] < MARKET_EVERY)]
        if not due:
            continue
        got = MK.read(chain, due, **({"get": get} if get else {}), calls_max=MARKET_CALLS)
        for m, q in got.items():
            f = MK.fields(q)
            if f:
                if m in shown:
                    f["launchpad"] = shown[m]                      # an earlier seen file's launchpad words, put right with its prices
                try:
                    update(m, **f)
                except Exception:
                    pass
            c.execute("UPDATE coins SET market_at=? WHERE mint=?", (now, m))
        c.commit()                                                 # before the next chain's network read
        out[chain] = len(got)
    return out


def rename_pass(c, now: float, update=None, limit: int = 500) -> int:
    """One launchpad, one name (chains17, finished): every seen BNB coin's file gets the feed's own launchpad words once
    (feed.SHOWN), whether or not it has prices (a coin still on its curve has none, so the market pass never reaches it). A file
    that is no longer a seen one (scored) already has the feed's words. No network; files renamed."""
    if update is None:
        import seen_feed as SF
        update = SF.update_seen
    rows = c.execute(f"SELECT mint, launchpad FROM coins WHERE named_at IS NULL AND launchpad IN ({','.join('?' * len(FD.SHOWN))}) LIMIT ?",
                     (*FD.SHOWN, limit)).fetchall()
    n = 0
    for m, lp in rows:
        try:
            n += bool(update(m, launchpad=FD.SHOWN[lp]))
        except Exception:
            continue                                           # unreadable now: tried again next pass
        c.execute("UPDATE coins SET named_at=? WHERE mint=?", (now, m))
    c.commit()
    return n


_OLD = {"at": 0.0, "dir": None, "coins": []}


def feed_evm_coins(feed_dir: str, skip: set, now: float | None = None) -> list:
    """[(mint, chain, launched seconds or None)] of every other Base/BNB coin file in the feed folder (the team 2026-10-25:
    the ~4,700 files of 12 October are listed and no quiet pass checked them); kept OLD_EVERY. A file that cannot be read,
    or names no chain, is left out (missing stays missing)."""
    now = now or time.time()
    if _OLD["dir"] != feed_dir or now - _OLD["at"] >= OLD_EVERY:
        out = []
        try:
            names = os.listdir(feed_dir)
        except FileNotFoundError:
            names = []
        for n in names:
            if not (n.startswith("0x") and n.endswith(".json")):
                continue
            try:
                d = json.load(open(os.path.join(feed_dir, n)))
            except Exception:
                continue
            m, ch = d.get("mint"), str(d.get("chain") or "").lower()
            ch = "bsc" if ch == "bnb" else ch
            if isinstance(m, str) and m.lower() == n[:-5].lower() and ch in FD.CHAINS:
                at = calendar.timegm(time.strptime(d["launched_at"][:19], "%Y-%m-%dT%H:%M:%S")) if isinstance(d.get("launched_at"), str) and len(d["launched_at"]) >= 19 else None
                out.append((m.lower(), ch, at, d.get("launchpad") if isinstance(d.get("launchpad"), str) else None))
        _OLD.update(at=now, dir=feed_dir, coins=out)
    return [x for x in _OLD["coins"] if x[0] not in skip]


def curve_watch(launchpad) -> str | None:
    """The trade watch that covers a BNB launchpad's curve coins, by the launchpad's words ("Flap", "Flap.sh", "four.meme")."""
    w = str(launchpad or "").lower()
    return "flap_trades" if "flap" in w else "fourmeme_trades" if "four" in w else None


def quiet_pass(c, g, now: float, get=None, exists=_feed_has, feed_file=None, tape=None, feed_dir=None) -> dict:
    """a design decision for Base and BNB coins: the scanner's own quiet pass, unchanged, with these chains' pairs. It follows
    this service's own coins and every other Base/BNB file in the feed folder (`feed_dir`, the old files of 12 October)."""
    import quiet as Q
    lp_of = dict(c.execute("SELECT mint, launchpad FROM coins WHERE launched_at > ?", (now - LISTED_S,)))
    coins = [(m, ch, at, lp_of.get(m)) for m, ch, at in listed(c, now, exists)]
    if feed_dir:
        coins += feed_evm_coins(feed_dir, {x[0] for x in coins}, now)
    chain_of = {x[0]: x[1] for x in coins}
    watch_of = {x[0]: curve_watch(x[3]) for x in coins if x[1] == "bsc"}
    watch = {k: (s0, r1) for k, s0, r1 in c.execute("SELECT kind, since, read_to FROM watch")}

    def pairs(due):
        res = {}
        for chain in ("base", "bsc"):
            part = [m for m in due if chain_of.get(m) == chain]
            if part:
                res.update({m: q["pairs"] for m, q in MK.read(chain, part, **({"get": get} if get else {}), calls_max=QUIET_CALLS).items()})
        curve = [m for m in due if res.get(m) == [] and watch_of.get(m)]
        last = dict(c.execute(f"SELECT mint, last FROM trades WHERE mint IN ({','.join('?' * len(curve))})", curve)) if curve else {}
        for m in curve:                                            # no pair anywhere: still on its launchpad's curve
            since, read_to = watch.get(watch_of[m], (None, None))
            if not read_to or now - read_to > WATCH_LAG_S:
                continue                                           # the watch is behind: judged on nothing, so not judged (F1)
            traded = bool(last.get(m) and read_to - last[m] < Q.QUIET_S)
            watched = bool(since and read_to - since >= Q.QUIET_S)
            if traded or watched:                                  # a trade seen, or a whole day read with none
                res[m] = [{"dex": "launchpad curve (PINR's read of its trade events)", "created": None, "txns_h24": 1 if traded else 0}]
        return res
    kw = {"feed_file": feed_file} if feed_file else {}
    if tape:
        kw["tape_fn"] = tape
    # own: this pass looks after the 0x coins only; the scanner's own pass keeps the Solana rows (the engine's builder/chainsgate)
    return Q.one_pass(g, [(x[0], x[2] or 0) for x in coins], now=now, pairs_fn=pairs, calls_max=QUIET_CALLS,
                      own=lambda m: str(m).startswith("0x"), **kw)


def status(c) -> dict:
    out = {f"{ch} {lp}": n for ch, lp, n in c.execute("SELECT chain, launchpad, COUNT(*) FROM coins GROUP BY chain, launchpad ORDER BY 1, 2")}
    gaps = c.execute("SELECT COUNT(*), COALESCE(SUM(to_block - from_block + 1), 0) FROM gaps").fetchone()
    if gaps[0]:
        out["BNB gaps (ranges no node served)"] = f"{gaps[0]} ranges, {gaps[1]} blocks"
    return out


ERRORS: list = []           # (thread name, error) of every pass that failed, newest last (kept short; read by the tests)


def _loop(name, every, make, say, passes=None):
    """One thread: `make()` runs INSIDE the thread and returns its pass function, so every database connection the pass
    uses is opened in the thread that uses it (sqlite3 refuses a connection from another thread: the server, 2026-10-25).
    `passes`: stop after that many (the tests); None = for ever."""
    def run():
        while True:                                            # a setup that fails (a busy database) is tried again, never given up
            try:
                fn = make()
                break
            except Exception as e:
                ERRORS.append((name, repr(e))); del ERRORS[:-50]
                traceback.print_exc()
                time.sleep(5)
        n = 0
        while passes is None or n < passes:
            n += 1
            t = time.time()
            try:
                got = fn(t)
                if got:
                    say(time.strftime("%H:%M:%S") + f" chains {name}: {got}")
            except Exception as e:
                ERRORS.append((name, repr(e))); del ERRORS[:-50]
                traceback.print_exc()
            if passes is None or n < passes:
                time.sleep(max(1.0, every - (time.time() - t)))
    th = threading.Thread(target=run, name=f"chains-{name}", daemon=True)
    th.start()
    return th


def threads(feed_dir: str, say=print, passes=None, fetch=None, post=None, get=None, docs=None, scorer=None, results_dir=None,
            virtuals_read=None, zora_read=None, funding_read=None, code_read=None) -> list:
    """The service's three threads (discovery and gate; Flap documents; market and quiet), each with its own connections.
    The keyword sources stand in for the network in the tests."""
    store().close()                                            # the store's one-time setup (WAL, tables) before any thread opens it
    due: dict = {}

    def make_disc():
        c, g = store(), scanner_db()
        def disc(now):
            got = discover(c, now, due, fetch=fetch, post=post)
            gated = gate(c, g, now, feed_dir, fetch=fetch)
            return {k: v for k, v in (("new", got), ("gated", gated)) if v}
        return disc

    def make_docs():
        c = store()
        return lambda now: read_docs(c, now, docs=docs)

    def make_mq():
        c, g = store(), scanner_db()
        last_quiet = [0.0]
        def mq(now):
            out = {"market": market_pass(c, now, get=get), "renamed": rename_pass(c, now)}
            try:
                import virtuals_facts as VF                    # the team 2026-10-25: Virtuals coins listed with what is verifiable
                v = VF.one_pass(c, g, feed_dir, read_fn=virtuals_read)
                if v:
                    out["virtuals_facts"] = v
                import zora_social as ZS                       # a Zora coin's creator and linked accounts (○)
                zs = ZS.one_pass(c, g, feed_dir, read_fn=zora_read)
                if zs:
                    out["zora_profiles"] = zs
                import bots as BT                              # 271c: obvious bot trading, labelled; the coin gets no more work
                bt = BT.one_pass(c, g, feed_dir, now)
                if bt:
                    out["bot_labelled"] = bt
                import ticks_base as TB                        # line 11: listed Base coins' own trades as their tick files
                import funding as FN_
                shown = (FN_.SHOWN_FN or FN_._site_list)() or set()   # the site's listed coins (the page's charts); before any list, none
                # this pass (a Base pool is read from where it was read to, so nothing is lost)
                tb = TB.one_pass(c, g, now, feed_dir, [(m, b) for (m, b) in c.execute(
                    "SELECT mint, block FROM coins WHERE chain='base' AND bot_at IS NULL AND launched_at > ?", (now - LISTED_S,)) if m in shown])
                if tb:
                    out["base_ticks"] = tb
                import funding as FN                           # checklist 6 (268): the creator's funding source (●)
                fu = FN.one_pass(c, g, feed_dir, now, first_fn=funding_read, code_fn=code_read)
                if fu:
                    out["funding"] = fu
            except Exception:
                traceback.print_exc()
            if now - last_quiet[0] >= QUIET_EVERY:
                last_quiet[0] = now
                q = quiet_pass(c, g, now, get=get, feed_file=os.path.join(feed_dir, "_quiet.json"), feed_dir=feed_dir)   # the team's F1 on a745fd2b
                if q.get("went_quiet") or q.get("woke"):
                    out["quiet"] = q
            return {k: v for k, v in out.items() if v}
        return mq
    def make_score():
        import score as SC                                     # PINR Index for Base/BNB coins, one at a time
        c, g = store(), scanner_db()
        return lambda now: SC.one_pass(c, g, now, scorer=scorer, results_dir=results_dir)
    out = [_loop("discovery", PASS_S, make_disc, say, passes), _loop("docs", PASS_S, make_docs, say, passes),
           _loop("market", 30, make_mq, say, passes)]
    if os.environ.get("PINR_CHAINS_SCORE", "on") != "off":
        out.append(_loop("score", SCORE_EVERY, make_score, say, passes))
    return out


def main(cmd: str, say=print) -> None:
    import feed_export as F
    results_dir = None
    if os.environ.get("PINR_CHAINS_FEED_DIR"):                  # a dry run into another folder (never the live feed): its score
        F.FEED_DIR = os.environ["PINR_CHAINS_FEED_DIR"]          # results go beside it, never into stage4/results
        results_dir = os.environ.get("PINR_CHAINS_RESULTS_DIR") or os.path.join(os.path.dirname(os.path.abspath(F.FEED_DIR)), "results")
    feed_dir = F.FEED_DIR
    if cmd == "status":
        say(status(store()))
        return
    due: dict = {}
    if cmd == "once":
        c, g, now = store(), scanner_db(), time.time()
        say({"discovered": discover(c, now, due), "docs": read_docs(c, now), "gated": gate(c, g, now, feed_dir),
             "market": market_pass(c, now), "store": status(c)})
        return
    try:                                                       # line 1 (26 Oct): yield the server's CPU to the site's feed server
        os.nice(int(os.environ.get("PINR_ENGINE_NICE", "10")))
    except OSError:
        pass
    try:
        import control                                         # the operator's switches and paces on pinr.io/control
        control.install()                                      # apply to this service's requests too, and each is counted there
    except Exception:
        traceback.print_exc()
    threads(feed_dir, say, results_dir=results_dir)
    while True:
        time.sleep(3600)


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else "status")
