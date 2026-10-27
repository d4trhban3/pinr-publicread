"""the gate in front of the X check and PINRai. Vamps, duplicates and serial launchers are found from the token
data first (name, ticker, picture, creator and the creator's launch count, as Jupiter's token list gives them); only a coin
that passes is sent to the X check or PINRai. The gate says what it observed in plain words and never scores anything.

A coin's answer: "passed" (all three checks read, none observed), "held" (one or more observed, each said), or
"not read yet" (no token data yet, or the creator or its launch count unknown: missing stays missing, nothing is sent)."""
from __future__ import annotations
import json, os, re, sqlite3, sys, time, unicodedata

HERE = os.path.dirname(os.path.abspath(__file__))
DB = os.path.join(HERE, "scanner.sqlite")


def ensure(c) -> None:
    if c.execute("SELECT 1 FROM sqlite_master WHERE name='gate_img_sha'").fetchone() and \
            c.execute("SELECT 1 FROM pragma_table_info('gate') WHERE name='ticker'").fetchone() and \
            c.execute("SELECT 1 FROM sqlite_master WHERE name='gate_bot'").fetchone():
        return                                                       # already in its newest shape: nothing to write
    try:                                                             # a coin marked as a bot launch, with receipts
        c.execute("""CREATE TABLE IF NOT EXISTS gate_bot (mint TEXT PRIMARY KEY, words TEXT NOT NULL, wallets TEXT, source TEXT,
                     receipts TEXT, first_at REAL, at REAL)""")
        c.execute("""CREATE TABLE IF NOT EXISTS gate_bot_wallets (wallet TEXT PRIMARY KEY, first_coin TEXT, coins INTEGER,
                     first_at REAL, at REAL)""")             # the operator's "known" bots, learned from PINR's own receipts
    except sqlite3.OperationalError:
        pass                                                         # a read-only reader: the scanner adds it
    c.execute("""CREATE TABLE IF NOT EXISTS gate (mint TEXT PRIMARY KEY, dev TEXT, name_key TEXT, symbol_key TEXT, image_key TEXT,
                 dev_mints INTEGER, first_seen REAL, read_at REAL, launched_at REAL)""")
    have = [r[1] for r in c.execute("PRAGMA table_info(gate)")]
    for col, kind in (("launched_at", "REAL"), ("img_sha", "TEXT"), ("img_phash", "TEXT"), ("img_read", "REAL"),
                      ("chain", "TEXT"), ("source", "TEXT"), ("dev_mints_source", "TEXT"),   # CHAINS (249): Base/BNB rows
                      ("name", "TEXT"), ("ticker", "TEXT")):            # as Jupiter's list gives them, for the Arena
        if col not in have:
            try:
                c.execute(f"ALTER TABLE gate ADD COLUMN {col} {kind}")
            except sqlite3.OperationalError:                         # a read-only reader (the X check, PINRai): the scanner adds it
                return
    c.execute("CREATE INDEX IF NOT EXISTS gate_img_sha ON gate(img_sha)")
    c.execute("CREATE INDEX IF NOT EXISTS gate_dev ON gate(dev)")
    c.execute("CREATE INDEX IF NOT EXISTS gate_name ON gate(name_key, symbol_key)")
    c.execute("CREATE INDEX IF NOT EXISTS gate_image ON gate(image_key)")


def _key(v) -> str | None:
    """A name or ticker as compared: invisible format characters (a word joiner U+2060, zero-width spaces and joiners, a
    direction mark) dropped first, so a copy that hides one still matches; spaces collapsed; lower case."""
    v = "".join(ch for ch in v if unicodedata.category(ch) != "Cf") if isinstance(v, str) else ""
    s = re.sub(r"\s+", " ", v).strip().lower()
    return s or None


_REKEYED = []


def rekey(c) -> int:
    """Once a process: the rows kept before `_key` dropped invisible characters get their name and ticker keys made again (a
    key is its own source: `_key` of a key is the key). Returns how many rows changed; 0 for a read-only reader."""
    if _REKEYED:
        return 0
    _REKEYED.append(True)
    n = 0
    try:
        for mint, nk, sk in c.execute("SELECT mint, name_key, symbol_key FROM gate").fetchall():
            if (nk and _key(nk) != nk) or (sk and _key(sk) != sk):
                c.execute("UPDATE gate SET name_key=?, symbol_key=? WHERE mint=?", (_key(nk) if nk else nk, _key(sk) if sk else sk, mint))
                n += 1
    except sqlite3.OperationalError:
        return 0
    return n


def image_key(url) -> str | None:
    """The picture's own file: an IPFS picture by its content id (the same file on any gateway), else the address itself."""
    if not isinstance(url, str) or not url.strip():
        return None
    m = re.search(r"/ipfs/([A-Za-z0-9]{40,})", url) or re.match(r"ipfs://([A-Za-z0-9]{40,})", url.strip())
    return ("ipfs:" + m.group(1)) if m else url.strip().lower()


def launched(x: dict) -> float | None:
    """The coin's launch time (Unix seconds) as Jupiter's record gives it: `createdAt`, else its first pool's; none, None."""
    import calendar
    for v in (x.get("createdAt"), (x.get("firstPool") or {}).get("createdAt") if isinstance(x.get("firstPool"), dict) else None):
        if isinstance(v, str):
            try:
                return float(calendar.timegm(time.strptime(v[:19], "%Y-%m-%dT%H:%M:%S")))
            except ValueError:
                pass
    return None


SHOWN_MAX = 200         # a name or ticker kept for showing is cut at this length, never otherwise changed


def record(c, rows: list, now: float | None = None) -> int:
    """Each row as Jupiter's token list gives it ({id, dev, name, symbol, icon, audit: {devMints}}); newest read wins,
    the first sighting is kept. Returns how many rows were written. A Base/BNB row (CHAINS, 249) adds `chain` (base | bsc),
    `source` (who gave the token data) and `audit.devMintsSource` (who gave the count); a Solana row leaves them out (Jupiter)."""
    now = now or time.time()
    ensure(c)
    rekey(c)
    n = 0
    for x in rows or []:
        if not isinstance(x, dict) or not isinstance(x.get("id"), str):
            continue
        dm = (x.get("audit") or {}).get("devMints")
        words = lambda v: v.strip()[:60] if isinstance(v, str) and v.strip() else None
        shown = lambda v: v.strip()[:SHOWN_MAX] if isinstance(v, str) and v.strip() else None    # as given, never re-cased
        chain = x.get("chain") if x.get("chain") in CHAINS else None
        c.execute("""INSERT INTO gate (mint, dev, name_key, symbol_key, image_key, dev_mints, first_seen, read_at, launched_at, chain, source, dev_mints_source,
                     name, ticker)
                     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
                     ON CONFLICT(mint) DO UPDATE SET dev=excluded.dev, name_key=excluded.name_key, symbol_key=excluded.symbol_key,
                     name=excluded.name, ticker=excluded.ticker,
                     image_key=excluded.image_key, dev_mints=excluded.dev_mints, read_at=excluded.read_at,
                     chain=excluded.chain, source=excluded.source, dev_mints_source=excluded.dev_mints_source,
                     launched_at=COALESCE(excluded.launched_at, gate.launched_at),
                     img_sha=CASE WHEN gate.image_key IS excluded.image_key THEN gate.img_sha END,
                     img_phash=CASE WHEN gate.image_key IS excluded.image_key THEN gate.img_phash END,
                     img_read=CASE WHEN gate.image_key IS excluded.image_key THEN gate.img_read END""",
                  (x["id"], x.get("dev") if isinstance(x.get("dev"), str) else None, _key(x.get("name")), _key(x.get("symbol")),
                   image_key(x.get("icon")), dm if isinstance(dm, int) and dm >= 0 else None, now, now, launched(x),
                   chain, words(x.get("source")), words((x.get("audit") or {}).get("devMintsSource")), shown(x.get("name")), shown(x.get("symbol"))))
        n += 1
    return n


_NAME_ASKED: set = set()


def name_need(c, mints, limit: int) -> list:
    """the design's catch-up: of `mints` (the Arena's members), the Solana rows kept before the gate kept names for showing,
    whose name or ticker key says Jupiter gave one: read again from Jupiter's list, each once a process (a coin Jupiter no
    longer knows is not asked every pass). A row Jupiter gave none for is never asked."""
    out = []
    for m in mints or []:
        if len(out) >= limit:
            break
        if m in _NAME_ASKED:
            continue
        try:
            r = c.execute("SELECT 1 FROM gate WHERE mint=? AND name IS NULL AND ticker IS NULL AND chain IS NULL "
                          "AND (name_key IS NOT NULL OR symbol_key IS NOT NULL)", (m,)).fetchone()
        except sqlite3.OperationalError:                              # a store without the columns yet
            return []
        if r:
            out.append(m); _NAME_ASKED.add(m)
    return out


PHASH_NEAR = 5          # bits a 64-bit perceptual hash may differ by and still be the same picture (re-saved, resized, re-hosted)
IMG_RETRY_S = 3600      # a picture that could not be fetched or decoded is tried again after this long


def record_image(c, mint: str, sha: str | None, phash: str | None, now: float | None = None) -> None:
    """The picture's own file: its SHA-256 and its perceptual hash (open-source, imagehash/phash.mjs); None when not read."""
    ensure(c)
    c.execute("UPDATE gate SET img_sha=?, img_phash=?, img_read=? WHERE mint=?", (sha, phash, now or time.time(), mint))


def fill_images(c, feed_dir: str, limit: int = 300) -> int:
    """A coin Jupiter gave no picture for takes the picture its tile shows (`image_url` in its feed file, from the coin's own
    metadata document), so the gate compares what buyers see. Returns how many were filled."""
    import json
    n = 0
    for (m,) in c.execute("SELECT mint FROM gate WHERE image_key IS NULL ORDER BY launched_at DESC LIMIT ?", (limit,)).fetchall():
        try:
            url = json.load(open(os.path.join(feed_dir, m + ".json"))).get("image_url")
        except Exception:
            continue
        k = image_key(url) if isinstance(url, str) and url.startswith("https://") else None
        if k:
            c.execute("UPDATE gate SET image_key=?, img_sha=NULL, img_phash=NULL, img_read=NULL WHERE mint=? AND image_key IS NULL", (k, m))
            n += 1
    return n


def image_need(c, limit: int, now: float | None = None) -> list:
    """[(mint, picture url)] still to fetch: never tried, or tried and not read over IMG_RETRY_S ago; newest launches first."""
    ensure(c)
    now = now or time.time()
    return c.execute("SELECT mint, image_key FROM gate WHERE image_key IS NOT NULL AND image_key NOT LIKE 'ipfs:%' AND "
                     "(img_read IS NULL OR (img_sha IS NULL AND img_read < ?)) ORDER BY launched_at DESC LIMIT ?",
                     (now - IMG_RETRY_S, limit)).fetchall() + \
           [(m, "https://ipfs.io/ipfs/" + k[5:]) for m, k in c.execute(
               "SELECT mint, image_key FROM gate WHERE image_key LIKE 'ipfs:%' AND (img_read IS NULL OR (img_sha IS NULL AND img_read < ?)) "
               "ORDER BY launched_at DESC LIMIT ?", (now - IMG_RETRY_S, limit)).fetchall()]


def _near(a: str | None, b: str | None) -> bool:
    return bool(a and b) and bin(int(a, 16) ^ int(b, 16)).count("1") <= PHASH_NEAR


MATCH_KINDS = ("address", "file", "near")
_HOW = {"same picture address": "address", "same picture file": "file", "near-identical picture": "near"}


def graph() -> dict:
    """the gate's control graph in force (scanner/gategraph.py), {} when none (every check on, as built)."""
    try:
        import gategraph
        return gategraph.current()
    except Exception:
        return {}


# The server's stalls: comparing a picture with every other one took most of a core. Two 64-bit hashes
# within PHASH_NEAR (under 6) differing bits agree exactly on at least one of these 6 slices (pigeonhole), so only the
# coins sharing a slice are compared. The index only proposes; every candidate is read again from the store and checked.
BANDS = ((0, 11), (11, 22), (22, 33), (33, 44), (44, 54), (54, 64))
_PH = {}                     # store path -> {"rowid", "read", "ph": {mint: hash}, "bands": {(slice, value): {mints}}}


def _slices(ph: str) -> list:
    v = int(ph, 16)
    return [(i, (v >> s) & ((1 << (e - s)) - 1)) for i, (s, e) in enumerate(BANDS)]


def _ph_index(c) -> dict:
    """The perceptual-hash index for this store, brought up to date with the rows added or re-read since the last call."""
    try:
        key = c.execute("PRAGMA database_list").fetchone()[2] or id(c)
    except Exception:
        key = id(c)
    if key not in _PH:
        try:                                                     # the pictures read since: found by their own index (one-time)
            c.execute("CREATE INDEX IF NOT EXISTS gate_img_read ON gate(img_read)"); c.commit()
        except sqlite3.OperationalError:
            pass                                                 # a read-only reader: the same answers, read the slower way
    ix = _PH.setdefault(key, {"rowid": 0, "read": -1.0, "ph": {}, "bands": {}})
    q = "SELECT rowid, mint, img_phash, img_read FROM gate WHERE "
    got = c.execute(q + "rowid>?", (ix["rowid"],)).fetchall() + c.execute(q + "img_read>?", (ix["read"],)).fetchall()
    for rid, m, ph, rd in got:
        old = ix["ph"].get(m)
        if old:
            for b in _slices(old):
                ix["bands"].get(b, set()).discard(m)
        if ph:
            try:
                for b in _slices(ph):
                    ix["bands"].setdefault(b, set()).add(m)
                ix["ph"][m] = ph
            except ValueError:
                ix["ph"].pop(m, None)
        else:
            ix["ph"].pop(m, None)
        ix["rowid"] = max(ix["rowid"], rid)
        if isinstance(rd, (int, float)):
            ix["read"] = max(ix["read"], rd)
    return ix


# copy families stay within one chain (CHAINS 2026-10-25: a BNB "Walmart" named a Solana coin as its earlier
# look-alike). A row's chain as compared: a 0x address takes its row's chain (base | bsc; unknown matches nothing), any
# other address is Solana. Look-alikes and relaunches compare within it; the creator's own launch count does not.
CHAIN_EXPR = "(CASE WHEN mint LIKE '0x%' THEN chain ELSE 'solana' END)"


def _chain_key(c, mint: str):
    try:
        return chain_of(c, mint)
    except Exception:
        return None


def same_picture(c, mint: str, same_creator: bool, kinds=None) -> list:
    """[(mint, launched_at, dev, how)] of the coins showing the same picture as `mint` (by its creator or by others): the same
    address, the same file (SHA-256) or a near-identical picture (perceptual hash), on any host. the team 2026-10-23, the
    operator: "tokens slipping through the duplicate image gate"; the picture alone is enough, no shared name needed."""
    r = c.execute("SELECT dev, image_key, img_sha, img_phash FROM gate WHERE mint=?", (mint,)).fetchone()
    if r is None or not r[0]:
        return []
    dev, img, sha, ph = r
    ck = _chain_key(c, mint)
    cols = f"SELECT mint, launched_at, dev, image_key, img_sha, img_phash, {CHAIN_EXPR} FROM gate WHERE "   # each by its own index;
    rows = {}                                                                                 # the creator is checked below
    if img:
        rows.update({x[0]: x for x in c.execute(cols + "image_key=?", (img,))})
    if sha:
        rows.update({x[0]: x for x in c.execute(cols + "img_sha=?", (sha,))})
    if ph and PHASH_NEAR >= len(BANDS):                           # the slice rule no longer holds: compare with every picture
        rows.update({x[0]: x for x in c.execute(cols + "img_phash IS NOT NULL")})
    elif ph:
        try:
            ix = _ph_index(c)
            cand = set().union(*[ix["bands"].get(b, set()) for b in _slices(ph)]) - {mint} - set(rows)
        except ValueError:
            cand = set()
        cand = list(cand)
        for i in range(0, len(cand), 500):
            part = cand[i:i + 500]
            rows.update({x[0]: x for x in c.execute(cols + "mint IN (" + ",".join("?" * len(part)) + ")", part)})
    out = {}
    for row in rows.values():
        if row[0] == mint or row[2] is None or (row[2] == dev) != same_creator:   # a creatorless coin is nobody's (as the SQL had it)
            continue
        if ck is None or row[6] != ck:                                # another chain's coin is never this one's look-alike (252)
            continue
        how = ("same picture address" if img and row[3] == img else "same picture file" if sha and row[4] == sha
               else "near-identical picture" if _near(ph, row[5]) else None)
        if how and (kinds is None or _HOW[how] in kinds):
            out[row[0]] = (row[0], row[1], row[2], how)
    return sorted(out.values(), key=lambda x: (x[1] is None, x[1] or 0, x[0]))   # ties by address: one fixed order


def has(c, mint: str) -> bool:
    ensure(c)
    return c.execute("SELECT 1 FROM gate WHERE mint=?", (mint,)).fetchone() is not None


def _serial_line() -> int:
    """Redacted in the public copy."""
    raise NotImplementedError("redacted: proprietary PINR logic is not included in the public copy")


SETTINGS = os.path.join(HERE, "settings.json")


def fast_rate(path: str | None = None) -> tuple | None:
    """the operator's fast-launch rate, (coins, minutes), from the scanner's private settings
    (`gate_fast_launch_coins`, `gate_fast_launch_minutes`); None while unset or unusable (the rate check is then off)."""
    try:
        import json
        cfg = json.load(open(path or SETTINGS))
        n, m = cfg.get("gate_fast_launch_coins"), cfg.get("gate_fast_launch_minutes")
    except Exception:
        return None
    if isinstance(n, int) and not isinstance(n, bool) and n >= 2 and isinstance(m, (int, float)) and not isinstance(m, bool) and m > 0:
        return n, float(m)
    return None


def fast_burst(c, dev: str, mint: str, at: float | None, rate: tuple | None) -> list:
    """The creator's coins (this one included) in the busiest window of the rate's length that holds this coin's launch,
    when that window holds at least the rate's count; [] otherwise. [(mint, launched_at), ...] by launch time."""
    if not rate or not dev or at is None:
        return []
    n, minutes = rate
    span = minutes * 60
    rows = c.execute("SELECT mint, launched_at FROM gate WHERE dev=? AND launched_at BETWEEN ? AND ? ORDER BY launched_at",
                     (dev, at - span, at + span)).fetchall()
    best = []
    for i, (_m, t0) in enumerate(rows):
        if t0 > at:
            break
        win = [r for r in rows[i:] if r[1] <= t0 + span]
        if win[-1][1] >= at and len(win) > len(best):
            best = win
    return best if len(best) >= n else []


def launch_count(c, dev: str, jupiter: int | None, source: str | None = "Jupiter") -> tuple:
    """(count, source): the larger of Jupiter's count (or, for a Base/BNB coin, its launchpad's: `source` names it) and the
    creator's coins PINR has itself read; "PINR" when PINR's
    own count is the larger (then a lower bound)."""
    own = c.execute("SELECT COUNT(*) FROM gate WHERE dev=?", (dev,)).fetchone()[0] if dev else 0
    if jupiter is None or own > jupiter:
        return own, "PINR"
    return jupiter, source


def _sources(c, mint: str) -> tuple:
    """(chain, who gave the token data, who gave the count) for a coin's gate row; a Solana coin's are Jupiter's, a Base/BNB
    coin's its row's own words or None (never Jupiter's). A reader before the scanner added the columns: the same, from the address."""
    try:
        r = c.execute("SELECT chain, source, dev_mints_source FROM gate WHERE mint=?", (mint,)).fetchone() or (None, None, None)
    except sqlite3.OperationalError:
        r = (None, None, None)
    if not str(mint or "").startswith("0x"):
        return "solana", r[1] or "Jupiter", r[2] or "Jupiter"
    return (r[0] if r[0] in CHAINS else None), r[1], r[2]


def _count_words(src, evm: bool) -> str:
    # the team's W3 on 4631c0d8: Base and BNB share one address space, so PINR's own count takes this wallet on both (one key)
    if src == "PINR" and evm:
        return "PINR's count, this wallet on Base and BNB together"
    return f"{src}'s count" if src else "the launchpad's count"


BOT_WALLETS_MAX = 20     # the bot wallets kept as a bot mark's receipts (the rest are counted in its words)


def mark_bot(c, mint: str, words: str, wallets: list, source: str, receipts: list, now: float | None = None) -> None:
    """the coin is a bot launch, as observed (`words`, plain and observed, never a verdict), with the wallets
    and receipts that show it and who read it (`source`). From then on the gate says "bot": never listed, no further scan,
    score or PINRai. The newest reading wins; the first time it was seen is kept."""
    ensure(c)
    now = now or time.time()
    c.execute("""INSERT INTO gate_bot (mint, words, wallets, source, receipts, first_at, at) VALUES (?,?,?,?,?,?,?)
                 ON CONFLICT(mint) DO UPDATE SET words=excluded.words, wallets=excluded.wallets, source=excluded.source,
                 receipts=excluded.receipts, at=excluded.at""",
              (mint, words, json.dumps([w for w in wallets if isinstance(w, str)][:BOT_WALLETS_MAX]), source, json.dumps(receipts), now, now))
    for w in {w for w in wallets if isinstance(w, str) and w}:      # the team 2026-10-26: every wallet that drove a bot coin is known
        c.execute("""INSERT INTO gate_bot_wallets (wallet, first_coin, coins, first_at, at) VALUES (?,?,1,?,?)
                     ON CONFLICT(wallet) DO UPDATE SET coins=gate_bot_wallets.coins + (gate_bot_wallets.first_coin<>excluded.first_coin), at=excluded.at""",
                  (w, mint, now, now))


def known_bots(c, wallets, before: str | None = None) -> list:
    """Of `wallets`, those PINR has seen driving a bot launch (sorted); [] for a store without the list. `before`: a coin;
    only wallets whose first bot coin came before that coin count (the team's F1 on tags271: "earlier" must be true)."""
    ws = sorted({w for w in wallets or [] if isinstance(w, str) and w})
    if not ws:
        return []
    q = f"SELECT w.wallet FROM gate_bot_wallets w WHERE w.wallet IN ({','.join('?' * len(ws))})"
    if before is not None:
        q = (f"SELECT w.wallet FROM gate_bot_wallets w JOIN gate g ON g.mint = ? LEFT JOIN gate f ON f.mint = w.first_coin "
             f"WHERE w.wallet IN ({','.join('?' * len(ws))}) AND {LATER_SQL}")
        ws = [before] + ws
    try:
        return sorted(w for (w,) in c.execute(q, ws))
    except sqlite3.OperationalError:
        return []


def first_bot_coin(c, wallet: str) -> str | None:
    try:
        r = c.execute("SELECT first_coin FROM gate_bot_wallets WHERE wallet=?", (wallet,)).fetchone()
    except sqlite3.OperationalError:
        return None
    return r[0] if r else None


# A creator's coin is a bot launch by a known wallet only when it came AFTER that wallet's first bot coin (the team's F1 on
# tags271: an earlier coin is not "an earlier bot launch"): its launch, else first-seen, else read time, against the first
# bot coin's own (launch, else first-seen, else read time), else the time the wallet was first marked. A coin with no time
# at all is not counted (missing stays missing).
LATER_SQL = ("COALESCE(g.launched_at, g.first_seen, g.read_at) > COALESCE(f.launched_at, f.first_seen, f.read_at, w.first_at)")


def bot_of(c, mint: str) -> dict | None:
    """The coin's bot mark {"words", "wallets", "source", "receipts", "at"}, or None (also for a store without the table).
    A coin with no mark whose creator is a known bot wallet is a bot launch too: read here, never written,
    so a reader (a graph preview, the X check) changes nothing and no scan is spent on it."""
    try:
        r = c.execute("SELECT words, wallets, source, receipts, at FROM gate_bot WHERE mint=?", (mint,)).fetchone()
    except sqlite3.OperationalError:
        return None
    if r is not None:
        load = lambda v: json.loads(v) if isinstance(v, str) and v else []
        return {"words": r[0], "wallets": load(r[1]), "source": r[2], "receipts": load(r[3]), "at": r[4]}
    g = c.execute("SELECT dev, read_at FROM gate WHERE mint=?", (mint,)).fetchone()
    if not g or not g[0] or not known_bots(c, [g[0]], before=mint):
        return None                                            # not known, or this coin came before its creator's first bot coin
    first = first_bot_coin(c, g[0])
    return {"words": "launched by a wallet seen driving an earlier bot launch", "wallets": [g[0]], "source": "PINR's read (earlier bot launch)",
            "receipts": [{"what": "earlier bot launch by this wallet", "value": first, "link": link(chain_of(c, first), "token", first) if first else None}],
            "at": g[1]}


def bot_mints(c) -> set:
    """Every bot launch: the marked coins and those a known bot wallet launched after its first bot coin (for the Arena and the lists)."""
    try:
        return {m for (m,) in c.execute("SELECT mint FROM gate_bot UNION SELECT g.mint FROM gate g JOIN gate_bot_wallets w ON g.dev = w.wallet "
                                        f"LEFT JOIN gate f ON f.mint = w.first_coin WHERE {LATER_SQL}")}
    except sqlite3.OperationalError:
        return set()


def verdict(c, mint: str, serial_over: int | None = None, rate="settings", cfg=None) -> dict:
    """{"status": "passed" | "held" | "bot" | "not read yet", "observed": [plain words]}. `cfg`: the gate graph,
    the one in force when not given; a check switched off is not run, its values and picture kinds as the graph says.
    A coin marked as a bot launch (271(c)) is "bot" before anything else."""
    ensure(c)
    b = bot_of(c, mint)
    if b:
        return {"status": "bot", "observed": [b["words"]]}

    cfg = graph() if cfg is None else cfg
    on = lambda k: ((cfg.get("checks") or {}).get(k) or {}).get("on", True) is not False
    vals = cfg.get("values") or {}
    kinds = ((cfg.get("checks") or {}).get("lookalike_picture") or {}).get("match") or list(MATCH_KINDS)
    r = c.execute("SELECT dev, name_key, symbol_key, image_key, dev_mints, launched_at FROM gate WHERE mint=?", (mint,)).fetchone()
    if r is None:
        return {"status": "not read yet", "observed": ["token data not read yet"]}
    dev, name, sym, img, dev_mints, at = r
    if not dev or dev_mints is None:
        return {"status": "not read yet", "observed": ["creator or its launch count not known yet"]}
    seen = []
    if on("serial_launcher"):
        over = serial_over if serial_over is not None else (vals["mass_line"] if isinstance(vals.get("mass_line"), int) else _serial_line())
        _chain, _data, count_src = _sources(c, mint)
        n, src = launch_count(c, dev, dev_mints, count_src)
        if n > over:
            seen.append(f"this coin's creator has launched {'at least ' if src == 'PINR' else ''}{n} coins ({_count_words(src, mint.startswith('0x'))})")
    if on("fast_launcher"):
        if rate == "settings":
            rate = ((vals["fast_coins"], float(vals["fast_minutes"])) if isinstance(vals.get("fast_coins"), int) and vals.get("fast_minutes")
                    else fast_rate())
        burst = fast_burst(c, dev, mint, at, rate)
        if burst:                                                       # the rate's own figures are never in the words
            seen.append(f"this coin's creator launched {len(burst)} coins in quick succession around this one")
    same = []
    if on("same_creator_relaunch"):
        for what, col, v in (("name", "name_key", name), ("ticker", "symbol_key", sym)):
            if v and c.execute(f"SELECT 1 FROM gate WHERE dev=? AND mint<>? AND {col}=? AND {CHAIN_EXPR}=? LIMIT 1",
                               (dev, mint, v, _chain_key(c, mint))).fetchone():
                same.append(what)
        if same_picture(c, mint, same_creator=True, kinds=kinds):
            same.append("picture")
    if same:
        seen.append("the same creator launched another coin with the same " + " and ".join(same))
    # The vamp check: another creator's coin LAUNCHED earlier.
    import gategraph as _GG                                             # the operator's order for the checks
    pos = _GG.order_of(cfg)
    alike = [("name and ticker", c.execute(f"SELECT launched_at FROM gate WHERE dev<>? AND mint<>? AND name_key=? AND symbol_key=? AND {CHAIN_EXPR}=?",
                                           (dev, mint, name, sym, _chain_key(c, mint))).fetchall() if name and sym and on("lookalike_name_ticker") else []),
             ("picture", [(x[1],) for x in same_picture(c, mint, same_creator=False, kinds=kinds)] if on("lookalike_picture") else [])]
    alike.sort(key=lambda a: pos["lookalike_name_ticker" if a[0] == "name and ticker" else "lookalike_picture"])   # the first found is said
    unread = False
    for what, others in alike:
        times = [o[0] for o in others]
        if at is not None and any(t is not None and t < at for t in times):
            seen.append(f"an earlier-launched coin by another creator has the same {what}")
            break
        if times and (at is None or None in times):
            unread = True                                               # a look-alike whose order cannot be told: not read yet
    if seen:                                                            # said in the operator's order of the checks
        seen.sort(key=lambda w: pos.get((_GG.kinds_of([w]) or ["not_read_yet"])[0], len(pos)))
        return {"status": "held", "observed": seen}
    if unread:
        return {"status": "not read yet", "observed": ["a look-alike coin by another creator; which launched first is not known yet"]}
    return {"status": "passed", "observed": []}


def passed(mint: str, path: str | None = None) -> tuple[bool, str]:
    """(True, "passed") only for a coin that passed; otherwise (False, why). An unreadable store sends nothing."""
    try:
        c = sqlite3.connect(f"file:{path or DB}?mode=ro", uri=True, timeout=10)  # read-only: a missing store is never created
        try:
            if c.execute("SELECT 1 FROM sqlite_master WHERE name='gate'").fetchone() is None:
                return False, "not read yet: token data not read yet"
            v = verdict(c, mint)
        finally:
            c.close()
    except Exception as e:
        return False, f"gate not readable: {type(e).__name__}"
    return v["status"] == "passed", "passed" if v["status"] == "passed" else f"{v['status']}: " + "; ".join(v["observed"])


def _iso(t):
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(t)) if isinstance(t, (int, float)) else None


CHAINS = ("base", "bsc")                                             # CHAINS (249): the EVM chains a gate row may name
_EXPLORER = {"solana": ("https://solscan.io/token/", "https://solscan.io/account/"),
             "base": ("https://basescan.org/token/", "https://basescan.org/address/"),
             "bsc": ("https://bscscan.com/token/", "https://bscscan.com/address/")}


def chain_of(c, m: str) -> str | None:
    """A coin's chain: a 0x address takes the chain its gate row names (base | bsc), else unknown (None); any other is Solana."""
    if not str(m or "").startswith("0x"):
        return "solana"
    try:
        r = c.execute("SELECT chain FROM gate WHERE mint=?", (m,)).fetchone()
    except sqlite3.OperationalError:                                 # a reader before the scanner has added the column
        return None
    return r[0] if r and r[0] in CHAINS else None


def link(chain: str | None, kind: str, ident: str | None) -> str | None:
    """The explorer page of a coin (kind "token") or a wallet ("account") on its chain; None when the chain is unknown."""
    e = _EXPLORER.get(chain)
    return (e[0] if kind == "token" else e[1]) + ident if e and ident else None


def _coin(c, m, at):
    return {"coin": m, "launched_at": _iso(at), "link": link(chain_of(c, m), "token", m)}


def section(c, mint: str, serial_over: int | None = None, rate="settings") -> dict | None:
    """the coin's `gate` section for its evidence file, in observed words with links; None when never read.
    {"status", "words", "items": [{"kind", "words", ...links}], "creator": {"id", "link", "launch_count", "other_coins"},
     "launched_at", "source": "Jupiter" (a Base/BNB coin: its row's own source, or null), "read"}. The serial-launcher line itself is never shown, only the count."""
    ensure(c)
    bot = bot_of(c, mint)
    r = c.execute("SELECT dev, name_key, symbol_key, image_key, dev_mints, launched_at, read_at FROM gate WHERE mint=?", (mint,)).fetchone()
    if r is None and not bot:
        return None
    if bot:                                                          # 271(c): the label and its evidence, nothing else read further
        ch = chain_of(c, mint)
        item = {"kind": "bot_launch", "words": bot["words"], "source": bot["source"],
                "wallets": [{"id": w, "link": link(ch, "account", w)} for w in bot["wallets"]], "receipts": bot["receipts"]}
        return {"status": "bot", "words": [bot["words"]], "items": [item], "launched_at": _iso(r[5]) if r else None,
                "read": _iso(bot["at"])}
    dev, name, sym, img, dev_mints, at, read = r
    evm = mint.startswith("0x")
    chain, data_src, count_src = _sources(c, mint)                   # CHAINS (249); missing stays missing: never "Jupiter" for a 0x coin
    v = verdict(c, mint, serial_over, rate)
    items = []
    for words in v["observed"]:
        if "in quick succession" in words:
            b = fast_burst(c, dev, mint, at, fast_rate() if rate == "settings" else rate)
            items.append({"kind": "fast_launcher", "words": words, "count": len(b), "coins": [_coin(c, m, t) for m, t in b if m != mint][:10]})
        elif "has launched" in words:
            n, src = launch_count(c, dev, dev_mints, count_src)
            items.append({"kind": "serial_launcher", "words": words, "launch_count": n, "launch_count_source": src})
        elif words.startswith("the same creator launched"):
            same = [w for w in ("name", "ticker", "picture") if w in words.split("same ", 2)[-1]]
            cols = {"name": ("name_key", name), "ticker": ("symbol_key", sym)}
            found = {}
            text_same = [w for w in same if w in cols]
            if text_same:
                q = " OR ".join(f"{cols[w][0]}=?" for w in text_same)
                for m, t in c.execute(f"SELECT mint, launched_at FROM gate WHERE dev=? AND mint<>? AND ({q}) AND {CHAIN_EXPR}=?",
                                      (dev, mint, *[cols[w][1] for w in text_same], _chain_key(c, mint))):
                    found[m] = t
            if "picture" in same:
                for m, t, _d, _how in same_picture(c, mint, same_creator=True):
                    found[m] = t
            rows = sorted(found.items(), key=lambda x: (x[1] is None, x[1] or 0))[:10]
            items.append({"kind": "same_creator_relaunch", "words": words, "same": same, "coins": [_coin(c, m, t) for m, t in rows]})
        elif words.startswith("an earlier-launched coin"):
            same = "picture" if words.endswith("picture") else "name and ticker"
            how = None
            if same == "picture":
                pics = [x for x in same_picture(c, mint, same_creator=False) if x[1] is not None and at is not None and x[1] < at]
                e = pics[0][:3] if pics else None
                how = pics[0][3] if pics else None
            else:
                e = c.execute("SELECT mint, launched_at, dev FROM gate WHERE dev<>? AND mint<>? AND name_key=? AND symbol_key=? "
                              f"AND launched_at<? AND {CHAIN_EXPR}=? ORDER BY launched_at LIMIT 1", (dev, mint, name, sym, at, _chain_key(c, mint))).fetchone()
            it = {"kind": "earlier_lookalike", "words": words, "same": same}
            if how:
                it["match"] = how
            if e:
                it.update(_coin(c, e[0], e[1]), creator=e[2], creator_link=link(chain_of(c, e[0]), "account", e[2]))
            items.append(it)
        else:
            items.append({"kind": "not_read_yet", "words": words})
    others = c.execute("SELECT mint, launched_at FROM gate WHERE dev=? AND mint<>? ORDER BY launched_at DESC LIMIT 10", (dev, mint)).fetchall() if dev else []
    n, src = launch_count(c, dev, dev_mints, count_src) if dev else (dev_mints, count_src)
    creator = {"id": dev, "link": link(chain, "account", dev), "launch_count": n,
               "launch_count_source": src, "other_coins": [_coin(c, m, t) for m, t in others]}
    return {"status": v["status"], "words": v["observed"], "items": items, "creator": creator, "launched_at": _iso(at),
            "source": data_src, "read": _iso(read)}


AFFECTED_MAX = 200                                                   # files rewritten for one newly read coin, newest launches first


def affected(c, mint: str) -> list:
    """The coins whose gate result can change when `mint` is read: the same creator's coins (a
    relaunch, a serial count) and other creators' look-alikes (the same name and ticker, or the same picture by address,
    file or near-identical hash). Newest launches first, at most AFFECTED_MAX."""
    ensure(c)
    r = c.execute("SELECT dev, name_key, symbol_key, image_key FROM gate WHERE mint=?", (mint,)).fetchone()
    if r is None:
        return []
    dev, name, sym, img = r
    q, args = ["dev=?"], [dev]
    if name and sym:
        q.append("(name_key=? AND symbol_key=?)"); args += [name, sym]
    if img:
        q.append("(image_key=? AND (name_key=? OR symbol_key=?))"); args += [img, name, sym]
    rows = c.execute(f"SELECT mint, launched_at FROM gate WHERE mint<>? AND ({' OR '.join(q)})", (mint, *args)).fetchall()
    found = dict(rows)
    for m, t, _d, _how in same_picture(c, mint, same_creator=False):    # the picture alone (address, file or near-identical)
        found[m] = t
    return [m for m, _t in sorted(found.items(), key=lambda x: -(x[1] or 0))][:AFFECTED_MAX]
