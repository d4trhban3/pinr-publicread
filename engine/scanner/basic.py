"""a design decision, the team's order (2026-10-22): every listed coin gets a basic evidence file at once, from cheap free reads,
marked "basic" until its full scan adds to it. It does not wait on scoring.

Per coin, newest launch first, the site's first page before the rest of the app's pool:
  - its own metadata on chain (Token-2022 extension or Metaplex account; 100 coins a read) and the metadata document it
    names (public gateways): the picture and the X, Telegram and website it launched with (the creator's own words, ○);
  - its creator from the launch record (the app's Pump.fun pool, ○);
  - Pump.fun's holders list, for a few coins a pass only (Pump.fun's per-address budget is shared with scoring).
The seen file gets the picture and the links (the same `links` shape a scored file has); the evidence table gets the rows,
and the coin's evidence file is written. A coin is read once per process; nothing is retried in a loop. Missing stays
missing: a document no gateway answered leaves the coin for a later pass, never "no links"."""
from __future__ import annotations
import os, sys, threading, time, traceback

HERE = os.path.dirname(os.path.abspath(__file__))
for _p in ("../stage2", "../stage3", "../feed"):
    sys.path.insert(0, os.path.join(HERE, _p))

PASS_S = 30                 # a pass every 30 seconds
BUDGET = 100                # coins read a pass (one batch read of the chain, 100 a call, then their documents)
HOLDERS_BUDGET = 2          # coins a pass whose Pump.fun holders list is read (two Pump.fun calls each, the scorer's budget too)
GATEWAY_GAP_S = 0.5         # each IPFS gateway asked at most once in this long
GATEWAY_REST_S = 600       # a gateway that answers 429 rests this long (the LIMIT of 2026-10-22: all five refused the server)
DOC_WORKERS = 8             # documents read at once (still one request per document; an IPFS gateway still rests after a 429)
NAME_BUDGET = 100           # Arena members a pass read again from Jupiter for the name and ticker the gate now keeps (266; one call)
IMG_BUDGET = 60             # pictures fetched and hashed a pass for the gate's picture check (one request each, paced like documents)
IMG_MAX_BYTES = 3_000_000   # a picture bigger than this is not read (unknown, tried again later)
PUMP_FALLBACK = 8           # coins a pass whose unanswered document is taken from Pump.fun's own coin record (the team 2026-10-22:
                            # a bigger share for pictures, inside the engine's share of Pump.fun's per-address budget; scoring keeps the rest)
_DONE: dict = {}            # mint -> True once read, or the time of a document no gateway answered (tried again after an hour)
_HOLDERS: set = set()
_PACED = None


def _http_link(v):
    return v.strip() if isinstance(v, str) and v.strip().lower().startswith(("http://", "https://")) else None


def links_from(doc: dict) -> dict:
    """The X, Telegram and website a metadata document lists, in both shapes (Pump.fun's and the Metaplex one), http(s) only."""
    ext = doc.get("extensions") if isinstance(doc.get("extensions"), dict) else {}
    props = doc.get("properties") if isinstance(doc.get("properties"), dict) else {}
    plinks = props.get("links") if isinstance(props.get("links"), dict) else {}
    pick = lambda *keys: next((_http_link(src.get(k)) for src in (doc, ext, plinks) for k in keys if _http_link(src.get(k))), None)
    return {"x": pick("twitter", "x"), "website": pick("website", "web", "external_url"), "telegram": pick("telegram", "tg")}


class PacedDocs:
    """The basic pass's own document reader: a launchpad-hosted document is fetched
    once; an IPFS document is asked of ONE gateway, the gateways taken in turn; a gateway answering 429 rests GATEWAY_REST_S;
    with every gateway resting the document waits for a later pass. Never more than one request per document."""

    def __init__(self, fetch=None, alternatives=None, now=time.time, sleep=time.sleep):
        self.rest: dict = {}
        self.next_at: dict = {}                                   # each gateway's own pace
        self.sleep = sleep
        self.turn = 0
        self.now = now
        self.lock = threading.Lock()
        if alternatives is None:
            import readers as R
            alternatives = R.ipfs_alternatives
        self.alternatives = alternatives
        self.fetch = fetch or self._fetch

    @staticmethod
    def _fetch(url):
        """(status, json or None): one plain request, 8 s at most."""
        import json as _json, urllib.request, urllib.error
        try:
            r = urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": "PINR-live/1.0 (read-only metadata)"}), timeout=8)
            body = r.read(2_000_000)
            try:
                return r.status, _json.loads(body)
            except Exception:
                return r.status, None
        except urllib.error.HTTPError as e:
            return e.code, None
        except Exception:
            return 0, None

    @staticmethod
    def _fetch_bytes(url):
        """(status, bytes or None): one plain request, 8 s at most, IMG_MAX_BYTES at most."""
        import urllib.request, urllib.error
        try:
            r = urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": "PINR-live/1.0 (read-only metadata)"}), timeout=8)
            body = r.read(IMG_MAX_BYTES + 1)
            return r.status, (body if len(body) <= IMG_MAX_BYTES else None)
        except urllib.error.HTTPError as e:
            return e.code, None
        except Exception:
            return 0, None

    def _pick(self, cands: list):
        """ONE gateway for this request: not resting, taken in turn, then held to its own pace; None while all rest."""
        with self.lock:
            now = self.now()
            shared = self._shared()                                  # rests any process on this machine recorded
            hosts = [u for u in cands if self.rest.get(u.split("/")[2], 0) <= now and u.split("/")[2] not in shared]
            if not hosts:
                return None
            url = hosts[self.turn % len(hosts)]
            self.turn += 1
            host = url.split("/")[2]
            wait = max(0.0, self.next_at.get(host, 0) - now)
            self.next_at[host] = max(now, self.next_at.get(host, 0)) + GATEWAY_GAP_S
        if wait:
            self.sleep(wait)
        return url

    def _shared(self) -> set:
        try:
            import readers as R
            return R.resting_gateways(self.now())
        except Exception:
            return set()

    def _refused(self, url: str, st) -> None:
        """A 429 (too many) or 403 (refused: the server's address barred) rests the gateway here and for every process."""
        if st in (403, 429):
            host = url.split("/")[2]
            with self.lock:
                self.rest[host] = self.now() + GATEWAY_REST_S
            try:
                import readers as R
                R.rest_gateway(host, GATEWAY_REST_S, self.now())
            except Exception:
                pass

    def raw(self, uri: str, fetch=None):
        """A picture's bytes, by the same rules as a document: its own host once, or ONE IPFS gateway in turn; None if unread."""
        fetch = fetch or self._fetch_bytes
        cands = self.alternatives(uri)
        if len(cands) == 1:
            return fetch(uri)[1]
        url = self._pick(cands)
        if url is None:
            return None
        st, body = fetch(url)
        self._refused(url, st)
        return body

    def __call__(self, uri: str):
        cands = self.alternatives(uri)
        if len(cands) == 1:                                       # not an IPFS address: the host itself, once
            _st, doc = self.fetch(uri)
            return doc if isinstance(doc, dict) else None
        url = self._pick(cands)
        if url is None:
            return None                                           # every gateway resting: unknown, a later pass
        st, doc = self.fetch(url)
        self._refused(url, st)
        return doc if isinstance(doc, dict) else None


def receipts_for(mint: str, meta: dict | None, doc: dict | None, creator: str | None, holders: dict | None,
                 jup_creator: str | None = None) -> list:
    """The receipts the evidence mapper already reads, for what this coin's cheap reads gave. With no launch record's
    creator, the creator Jupiter's token list gives (the gate's row; checklist 6), named as Jupiter's, never Pump.fun's."""
    rc = []
    if creator:
        rc.append({"what": "creator (launch record)", "value": creator, "unit": "address", "source": "Pump.fun launch record", "as_of": None})
    elif jup_creator:
        rc.append({"what": "creator (Jupiter's token list)", "value": jup_creator, "unit": "address", "source": "Jupiter token list (dev)", "as_of": None})
    if meta and meta.get("uri"):
        rc.append({"what": "token metadata URI", "value": meta["uri"], "unit": "url", "source": "getAccountInfo " + str(meta.get("account") or mint), "as_of": None})
    if isinstance(doc, dict):
        lk = links_from(doc)
        src = doc.get("_source") or "metadata document " + str(meta.get("uri"))
        for ours, name in (("x", "twitter"), ("website", "website"), ("telegram", "telegram")):
            rc.append({"what": f"token's own {name} link", "value": lk[ours] or "none", "unit": "url", "source": src, "as_of": None})
    if holders and holders.get("rows"):
        rc.append({"what": "holders (evidence)", "value": holders["rows"][:20], "unit": "holders", "source": holders.get("source"), "as_of": None})
    return rc


JUP_SEARCH = "https://lite-api.jup.ag/tokens/v2/search?query="   # keyless; up to 100 mints a call (tested 2026-10-23)


def jup_rows(mints: list) -> list:
    """a design decision, the token data first: each coin's record as Jupiter's token list already read it (picture, name, ticker,
    creator, the creator's launch count), 100 coins a call; a coin Jupiter does not know, or a failed call, is left out."""
    import json as _json, urllib.request
    out = []
    for i in range(0, len(mints), 100):
        part = mints[i:i + 100]
        try:
            r = urllib.request.urlopen(urllib.request.Request(JUP_SEARCH + ",".join(part), headers={"User-Agent": "PINR-live/1.0 (read-only metadata)"}), timeout=10)
            rows = _json.loads(r.read(5_000_000))
        except Exception:
            continue
        want = set(part)
        out += [x for x in rows if isinstance(x, dict) and x.get("id") in want] if isinstance(rows, list) else []
    return out


def jup_icons(mints: list, rows: list | None = None) -> dict:
    """{mint: picture url} from Jupiter's records (read here when not handed in); no picture, no entry (missing stays missing)."""
    rows = jup_rows(mints) if rows is None else rows
    want = set(mints)
    return {x["id"]: _http_link(x.get("icon")) for x in rows if x.get("id") in want and _http_link(x.get("icon"))}


def _node() -> str | None:
    import shutil
    for p in ("/usr/local/bin/node", os.path.expanduser("~/.local/node/bin/node"), shutil.which("node")):
        if p and os.path.exists(p):
            return p
    return None


def phashes(paths: list) -> dict:
    """{path: perceptual hash (16 hex digits) or None}, from the open-source helper imagehash/phash.mjs, one run for all."""
    import json as _json, subprocess, tempfile
    node = _node()
    if not node or not paths:
        return {}
    with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False) as f:
        _json.dump(paths, f)
    try:
        r = subprocess.run([node, os.path.join(HERE, "..", "imagehash", "phash.mjs"), f.name], capture_output=True, text=True, timeout=120)
        out = _json.loads(r.stdout) if r.returncode == 0 else {}
    except Exception:
        out = {}
    finally:
        os.remove(f.name)
    return {p: v for p, v in out.items() if isinstance(v, str) and len(v) == 16}


def read_images(pairs: list) -> dict:
    """[(mint, picture url)] → {mint: (sha256 or None, perceptual hash or None)}; a picture not fetched gives (None, None)."""
    import hashlib, shutil, tempfile
    global _PACED
    if _PACED is None:
        _PACED = PacedDocs()
    from concurrent.futures import ThreadPoolExecutor
    with ThreadPoolExecutor(max_workers=DOC_WORKERS) as ex:
        bodies = dict(zip([m for m, _u in pairs], ex.map(lambda p: _PACED.raw(p[1]), pairs)))
    d = tempfile.mkdtemp(prefix="pinr-img-")
    try:
        paths = {}
        for m, b in bodies.items():
            if b:
                paths[m] = os.path.join(d, m)
                open(paths[m], "wb").write(b)
        ph = phashes(list(paths.values()))
        return {m: ((hashlib.sha256(bodies[m]).hexdigest(), ph.get(paths[m])) if m in paths else (None, None)) for m in bodies}
    finally:
        shutil.rmtree(d, ignore_errors=True)


def pump_record(m: str, uri: str):
    """the team's fallback: Pump.fun's own coin record, used only when it names this exact metadata file (same coin, same
    document), as a document of the same shape: its picture on Pump.fun's image host and the links it launched with."""
    try:
        import pumpfun_api as PF
        rec = PF.coin(m)
    except Exception:
        return None
    if not isinstance(rec, dict) or rec.get("metadata_uri") != uri:
        return None
    return {"image": rec.get("image_uri"), "twitter": rec.get("twitter"), "website": rec.get("website"), "telegram": rec.get("telegram"),
            "_source": "Pump.fun record of " + uri}


def _meter_gate(W, GG, m, v) -> None:
    """each gate result down the map's own branches (a copy, a relaunch, a serial launcher, or passed)."""
    W.meter("g_in|check|g_vamp|check", 1, {"coin": m, "status": v.get("status")})
    kinds = set(GG.kinds_of(v.get("observed") or [])) if v.get("status") == "held" else set()
    if kinds & {"lookalike_name_ticker", "lookalike_picture"}:
        W.meter("g_vamp|yes|g_held|copy", 1, {"coin": m})
    else:
        W.meter("g_vamp|no|g_dup|no", 1, {"coin": m})
        if "same_creator_relaunch" in kinds:
            W.meter("g_dup|yes|g_held|relaunch", 1, {"coin": m})
        else:
            W.meter("g_dup|no|g_serial|no", 1, {"coin": m})
            if kinds & {"serial_launcher", "fast_launcher"}:
                W.meter("g_serial|yes|g_held|serial", 1, {"coin": m})
            elif v.get("status") == "passed":
                W.meter("g_serial|no|g_pass|no", 1, {"coin": m})
    if v.get("status") == "held":
        W.meter("g_held|gate result|e_build|gate result", 1, {"coin": m, "observed": v.get("observed")})
        W.meter("g_held|gate result|g_copies|gate result", 1, {"coin": m})
    elif v.get("status") == "passed":
        W.meter("g_pass|gate result|e_build|gate result", 1, {"coin": m})


def read_pass(c, coins: list, records: dict, feed_dir: str, now: float | None = None, meta_read=None, doc_read=None, holders_read=None,
              update_seen=None, budget: int = BUDGET, holders_budget: int = HOLDERS_BUDGET, pump_read=None, pump_budget: int = PUMP_FALLBACK,
              icons_read=None, rows_read=None, images_read=None) -> dict:
    """One pass over `coins` (in order): the next `budget` coins not yet read get their basic evidence. Returns counts."""
    import evidence as EV
    now = now or time.time()
    try:                                                                     # no picture pass or other read on a quiet coin
        import quiet as Q
        hush = Q.quiet_set()
        coins = [m for m in coins if m not in hush]
    except Exception:
        pass
    if meta_read is None:
        import readers as R
        meta_read = R.metadata_uris
    if doc_read is None:
        global _PACED
        if _PACED is None:
            _PACED = PacedDocs()
        doc_read = _PACED
    if holders_read is None:
        import brake_readers as B
        def holders_read(m):
            B.HOLDERS_ROWS.pop(m, None)
            B.top_holders_pumpfun(m)
            return B.HOLDERS_ROWS.get(m)
    if update_seen is None:
        import seen_feed as SF
        update_seen = SF.update_seen
    import gate as G
    import routing as RT                                                     # the operator's wires, read live
    pic_route, link_route = RT.route("picture"), RT.route("links")
    doc_order = [x for x in dict.fromkeys(link_route + pic_route) if x in ("ipfs", "pumpfun")]   # who is asked for a coin's own document, in order
    gate_need = [m for m in coins if not G.has(c, m)][:budget] if "jupiter" in RT.route("token_data") else []   # the gate's token data
    if "jupiter" in RT.route("token_data"):
        import pvp as P                                                  # Arena members kept before names were
        gate_need += [m for m in G.name_need(c, list(P.NAMELESS), NAME_BUDGET) if m not in gate_need]
    rows = (rows_read or jup_rows)(gate_need) if gate_need else []
    import wires as W                                                    # measured where the data crosses
    W.meter("a_pool|each new coin|a_token|run", len(gate_need), {"coin": gate_need[0]} if gate_need else None)
    W.meter("s_jup|token data|a_token|Jupiter", len(rows), {k: rows[0].get(k) for k in ("id", "name", "symbol")} if rows else None)
    if rows:
        G.record(c, rows, now)
        W.meter("a_token|token data|g_in|token data", len(rows), {"coin": rows[0].get("id")})
        c.commit()
    filled = G.fill_images(c, feed_dir)                                  # no Jupiter picture: the one the coin's tile shows
    c.commit()                                                           # before any network read: an open write would lock the
    pics = G.image_need(c, IMG_BUDGET, now)                              # scanner's database for every other reader and writer
    hashed = (images_read or read_images)(pics) if pics else {}          # (2026-10-24: "database is locked" while pictures were fetched)
    W.meter("a_token|token data|a_pic|token data", len(pics), {"coin": pics[0]} if pics else None)
    for m, (sha, ph) in hashed.items():
        G.record_image(c, m, sha, ph, now)
    if hashed:
        c.commit()
    if rows or hashed or filled:
        touched = []                                                     # each coin's file carries the gate's result,
        for mint_ in [x["id"] for x in rows] + list(hashed):             # and every coin whose result the new reads can change
            for m in [mint_] + G.affected(c, mint_):
                if m not in touched:
                    touched.append(m)
        import gategraph as GG
        for m in touched:
            try:
                EV.write_coin_file(c, m, feed_dir, now)
                v = G.verdict(c, m)
                GG.note(c, m, v, now)                            # the gate's result kept as it changes (the status)
                _meter_gate(W, GG, m, v)
                c.commit()
            except Exception:
                pass
        c.commit()
    todo = []
    for m in coins:
        d = _DONE.get(m)
        if d is True or (isinstance(d, float) and now - d < 3600):
            continue
        try:
            sc = c.execute("SELECT last_ok FROM tokens WHERE chain='solana' AND token=?", (m,)).fetchone()
        except Exception:
            sc = None
        if sc and sc[0]:
            _DONE[m] = True                                       # fully scored: its chain-read facts are never replaced by basic ones
            continue
        todo.append(m)
        if len(todo) >= budget:
            break
    out = {"asked": len(todo), "files": 0, "pictures": 0, "with_links": 0, "unanswered": 0, "holders": 0, "from_pumpfun": 0, "from_jupiter": 0,
           "gate_read": len(rows), "pictures_hashed": sum(1 for v in hashed.values() if v[0])}
    if not todo:
        return out
    need = [m for m in todo if not (records.get(m) or {}).get("image")] if "jupiter" in pic_route else []
    if not need:
        icons = {}
    elif icons_read:
        icons = icons_read(need) or {}
    else:                                                                  # the gate's records first; one more call only for the rest
        have = {x["id"] for x in rows}
        icons = jup_icons([m for m in need if m in have], rows)
        rest = [m for m in need if m not in have]
        if rest:
            icons.update(jup_icons(rest))
    early = pic_route[:1] == ["jupiter"]                                   # Jupiter the top wire: the picture at once, before any document
    for m, icon in (icons.items() if early else ()):
        try:
            update_seen(m, image_url=icon)
            out["from_jupiter"] += 1
        except Exception:
            pass
    metas = meta_read(todo) or {}
    W.meter("s_rpc|chain reads|a_token|chain reads", len(metas), next(({"coin": k, "uri": v.get("uri")} for k, v in metas.items()), None))
    from concurrent.futures import ThreadPoolExecutor
    uris = {m: metas[m]["uri"] for m in todo if metas.get(m) and metas[m].get("uri")} if doc_order else {}
    docs = {}
    pump_read = pump_read or pump_record
    out_pump = 0
    for src in doc_order:                                                   # each wired source in turn, for the coins still without a document
        left = [m for m in uris if not isinstance(docs.get(m), dict)]
        if src == "ipfs":
            with ThreadPoolExecutor(max_workers=DOC_WORKERS) as ex:        # a few documents at once, each one request
                got = {m: d for m, d in zip(left, ex.map(doc_read, [uris[m] for m in left])) if isinstance(d, dict)}
                docs.update(got)
                W.meter("s_ipfs|picture|a_pic|metadata file", len(got), next(({"coin": k, "image": d.get("image")} for k, d in got.items()), None))
        else:
            for m in left[:pump_budget]:                                    # Pump.fun's own record (its shared budget)
                got = pump_read(m, uris[m])
                if isinstance(got, dict):
                    docs[m] = dict(got, _source=got.get("_source") or "pumpfun")
                    out_pump += 1
    out["from_pumpfun"] = out_pump
    for m in todo:
        meta = metas.get(m)
        doc = docs.get(m)
        if doc_order and meta and meta.get("uri") and not isinstance(doc, dict):
            _DONE[m] = now                                         # no gateway answered: unknown, tried again later
            out["unanswered"] += 1
            continue
        hold = None
        if m not in _HOLDERS and out["holders"] < holders_budget:
            _HOLDERS.add(m)
            hold = holders_read(m)
            out["holders"] += bool(hold and hold.get("rows"))
        rec = records.get(m) or {}
        doc_src = ("pumpfun" if doc.get("_source") else "ipfs") if isinstance(doc, dict) else None
        link_doc = doc if doc_src in link_route else None                   # a document's links only from a source wired to links
        g = c.execute("SELECT dev FROM gate WHERE mint=? AND chain IS NULL", (m,)).fetchone()   # the gate's Jupiter record
        rc = receipts_for(m, meta, link_doc, rec.get("creator") if isinstance(rec.get("creator"), str) else None, hold,
                          g[0] if g and isinstance(g[0], str) else None)
        if rc:
            W.meter("a_token|token data|e_build|token data", 1, {"coin": m, "receipts": [x.get("what") for x in rc]})
        if rc and EV.store(c, {"mint": m, "receipts": rc}, now):
            c.commit()
            if EV.write_coin_file(c, m, feed_dir, now):
                out["files"] += 1
        fields = {}
        if not rec.get("image") and not (early and m in icons):            # the picture: the first wired source that has one
            have = {"jupiter": icons.get(m), doc_src: _http_link(doc.get("image")) if isinstance(doc, dict) else None}
            img = next((have.get(x) for x in pic_route if have.get(x)), None)
            if img:
                fields["image_url"] = img
                out["pictures" if img != icons.get(m) else "from_jupiter"] += 1
        if isinstance(link_doc, dict):
            lk = {k: v for k, v in links_from(link_doc).items() if v}
            out["with_links"] += bool(lk)
            fields["links"] = dict(lk, source="Pump.fun" if link_doc.get("_source") else "Solana chain", read_at=time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(now)))
        if fields:
            try:
                update_seen(m, **fields)                           # seen files only; a scored file keeps its own (the score wrote it)
            except Exception:
                pass
        _DONE[m] = True
    return out


def pass_order(page: list, rest: list, pool: list) -> list:
    """The coins a pass reads, in order: the site's first page (newest first), then its browse list's first page in the site's
    order,
    then the app's pool, newest first; each once."""
    out = [m for m, _b in sorted(page or [], key=lambda mb: -(mb[1] or 0))]
    out += [m for m, _b in rest or []]
    out += [m for m, _b in sorted(pool or [], key=lambda mb: -(mb[1] or 0))]
    return list(dict.fromkeys(out))


def start(db, page_fn, pool_fn, feed_dir: str, say=print, rest_fn=None) -> threading.Thread:
    """The pass on its own thread inside the scanner, every PASS_S: the site's first page first, then its browse list's first
    page, then the app's pool, newest first. Never stops the scanner; an error is printed and the next pass goes on."""
    def run():
        c = db()
        while True:
            try:
                page, pool = page_fn() or [], pool_fn() or []
                rest = (rest_fn() if rest_fn else None) or []
                records = {}
                try:
                    import scanner as S
                    records = dict(S._POOL.get("records") or {})
                except Exception:
                    pass
                got = read_pass(c, pass_order(page, rest, pool), records, feed_dir)
                if got["asked"]:
                    say(time.strftime("%H:%M:%S") + " basic evidence: " + ", ".join(f"{k} {v}" for k, v in got.items()))
            except Exception:
                traceback.print_exc()
            time.sleep(PASS_S)
    t = threading.Thread(target=run, name="basic-evidence", daemon=True)
    t.start()
    return t
