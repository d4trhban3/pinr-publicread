"""Engine -> live app feed (data contract v1.1, pinr-live/contract/DATA-CONTRACT.md).

Writes one JSON file per token into frontend-feed/. Only what PINR actually has goes in; anything unknown is left out
(never 0, "" or a guess). Scoring detail (readings, receipts, flags, notes, real money) is NOT written: it stays
server-side. What IS written since contract v1.1: `facts`, the public chain and
launchpad figures the dossier shows (valuation, launch time, launcher, fee wallet, the dev's launch count, duplicate
relaunches), each with its source, the time it was read and a link where one exists, built from the result's own
receipts; and `links`, the coin's website, X and Telegram as the Pump.fun record gives them, with the time read.

Display-only facts the result files don't hold are read from the chain itself and cached in feed/meta_cache.json:
  EVM:    name() / symbol() on the token, the token's own image (imageUrl() / image() / tokenURI metadata), and the
          block time of its first transfer (the mint) as the launch time.
  Solana: name / symbol / image from the token's on-chain metadata; launch time from the result's
          own receipt.

  python3 feed/feed_export.py            -> (re)writes the feed from every saved result (newest per token)
  from feed_export import export_one     -> called by the scorers after each result
"""
from __future__ import annotations
import glob, json, os, sys, time, urllib.request
HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
for p in ("stage2", "stage3", "stage4", "pinr-score", "feed"):
    sys.path.insert(0, os.path.join(ROOT, p))
FEED_DIR = os.path.join(ROOT, "frontend-feed")
CACHE = os.path.join(HERE, "meta_cache.json")
RESULT_DIRS = [os.path.join(ROOT, d) for d in ("stage2/results", "gate3/results", "stage4/results")]
CONTRACT_VERSION = "1.1"
READ_LINKS = True                 # a bulk re-export from saved results sets this False: cached links only, no record read, nothing marked tried
# The fixed list of PUBLIC source names a fact may carry: the launchpad by name, the market
# readers, or the chain itself. Never the provider behind a chain read (no Helius, Shyft, Alchemy, PublicNode), never a
# receipt's own words. Anything else is not written.
PUBLIC_SOURCES = {"Pump.fun", "Clanker", "Bankr", "Flap.sh", "four.meme", "Raydium LaunchLab", "DexScreener", "CoinGecko", "GeckoTerminal",
                  "Solana chain", "Base chain", "BNB chain", "Stonk.fun", "Jupiter"}      # the last two: a design decision (shown, never scored)
# the design's shown facts: the ids the exporter passes from a result's `shown` (stage2/shown_facts.py), and the extra
# fields each may carry. Anything else in `shown` is dropped; a fact without its whole receipt is dropped.
SHOWN_IDS = {"holder_count", "top_holders_share", "dev_mints", "organic_score", "jupiter_verified", "buys_24h", "sells_24h",
             "traders_24h", "mint_authority_jupiter", "freeze_authority_jupiter", "launchpad_transfer_fee", "rewards_paid",
             "rewards_payouts", "rewards_wallets_paid", "rewards_last_payout", "fee_recipients", "fee_share_creator",
             "stonkfun_launches", "dex_paid_orders", "dex_boosts"}
SHOWN_EXTRA = {"organic_score": ("band",), "dex_paid_orders": ("kinds",)}
PUMPFUN_COIN = "https://pump.fun/coin/%s"
PUMPFUN_PROFILE = "https://pump.fun/profile/%s"
SOLSCAN_TX = "https://solscan.io/tx/%s"
SOLSCAN_ACCOUNT = "https://solscan.io/account/%s"
SOLSCAN_TOKEN = "https://solscan.io/token/%s"
DEXSCREENER_PAIR = "https://dexscreener.com/solana/%s"
NO_SCORE_LABELS = ("VAMP", "BOT/RUG", "MAYHEM", "HONEYPOT")
LAUNCHPAD_NAMES = {"flap": "Flap.sh", "fourmeme": "four.meme", "clanker": "Clanker", "clanker_old": "Clanker",
                   "bankr": "Bankr", "zora": "Zora"}


def _cache():
    try:
        return json.load(open(CACHE))
    except Exception:
        return {}


def _https(url):
    if not isinstance(url, str) or not url.strip():
        return None
    u = url.strip()
    if u.startswith("ipfs://"):
        u = "https://ipfs.io/ipfs/" + u[7:].lstrip("/").removeprefix("ipfs/")
    return u if u.startswith("https://") else None


def _iso(ts):
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(int(ts))) if isinstance(ts, (int, float)) and ts > 0 else None


def _evm_meta(chain: str, token: str, links: dict | None) -> dict:
    from evm import call, selector, words, dec_string, rpc
    import calendar
    def s(fn):
        r = call(chain, token, "0x" + selector(fn))
        try:
            v = dec_string(r, words(r)[0]).strip() if r else None
            return v or None
        except Exception:
            return None
    m = {"name": s("name()"), "ticker": s("symbol()")}
    img = _https((links or {}).get("image")) or _https(s("imageUrl()")) or _https(s("image()"))
    if not img:
        uri = _https(s("tokenURI()"))
        if uri:
            try:
                from readers import metadata_document          # the team 2026-10-24: the gateways not resting, one try each
                j = metadata_document(uri)
                img = _https((j or {}).get("image"))
            except Exception:
                img = None
    m["image_url"] = img
    r = rpc(chain, "alchemy_getAssetTransfers", [{"contractAddresses": [token], "category": ["erc20"], "order": "asc",
                                                  "maxCount": "0x1", "withMetadata": True, "fromBlock": "0x0"}])
    if isinstance(r, dict) and r.get("transfers"):
        m["launch_ts"] = calendar.timegm(time.strptime(r["transfers"][0]["metadata"]["blockTimestamp"][:19], "%Y-%m-%dT%H:%M:%S"))
    return m


def _counted(S, name: str, answered: bool) -> None:
    try:                                  # the saved request count per source (`scanner.py status`); never in the way
        S.count(name, answered)
    except Exception:
        pass


def _solana_meta(mint: str) -> dict:
    """Name, ticker and picture from the token's own metadata on chain (the chain's standard methods,
    `readers.free_assets`; no provider-only API)."""
    from readers import free_assets
    a = free_assets([mint]).get(mint) or {}
    return {"name": (a.get("name") or "").strip() or None, "ticker": (a.get("symbol") or "").strip() or None,
            "image_url": _https(a.get("image"))}


def meta_for(o: dict, cache: dict | None = None) -> dict:
    cache = _cache() if cache is None else cache
    mint = o["mint"]
    chain = o.get("chain") or ("solana" if o.get("venue") else None)
    if mint in cache and (cache[mint].get("image_url") is not None or cache[mint].get("_image_tried", 0) >= 2):
        m = cache[mint]                                      # known (or tried twice: no image is the honest answer)
        if chain == "solana" and READ_LINKS and "links" not in m and m.get("_links_tried", 0) < 2:
            got = _pumpfun_links(mint)                       # cached before contract v1.1: its links are read once now
            m.update(got if got else {"_links_tried": m.get("_links_tried", 0) + 1})
            cache[mint] = m
            tmp = CACHE + ".tmp"
            json.dump(cache, open(tmp, "w"), indent=1)
            os.replace(tmp, CACHE)
        return m
    if chain == "solana":
        m = _solana_meta(mint)
        lt = next((r.get("value") for r in o.get("receipts") or [] if str(r.get("what", "")).startswith("launch time")), None)
        m["launch_ts"] = lt if isinstance(lt, (int, float)) else None
        m.update(_pumpfun_links(mint))                       # the coin's own links from the Pump.fun record (contract v1.1)
    elif chain in ("bsc", "base", "eth"):
        m = _evm_meta(chain, mint, o.get("links"))
    else:
        m = {}
    if m.get("image_url") is None:
        m["_image_tried"] = (cache.get(mint) or {}).get("_image_tried", 0) + 1
    cache[mint] = m
    tmp = CACHE + ".tmp"
    json.dump(cache, open(tmp, "w"), indent=1)
    os.replace(tmp, CACHE)
    return m


def _pumpfun_links(mint: str) -> dict:
    """{"links": {website, x, telegram}, "links_read_at": ISO} from Pump.fun's coin record; {} when the record was not read
    (missing stays missing). Only http(s) links are carried; the app re-checks them."""
    try:
        import pumpfun_api as PF
        r = PF.coin(mint)
    except Exception:
        return {}
    if not isinstance(r, dict):
        return {}
    out = {}
    for ours, theirs in (("website", "website"), ("x", "twitter"), ("telegram", "telegram")):
        v = r.get(theirs)
        if isinstance(v, str) and v.strip().lower().startswith(("http://", "https://")):
            out[ours] = v.strip()
    return {"links": out, "links_read_at": _now_iso()}


def _own_links(o: dict):
    """(links, read_at) from the engine's own receipts of the coin's metadata document (the dev's own choice, named on chain;
    for LaunchLab and StonkFun coins the launchpad's record names the same document): {} when the document listed none;
    (None, None) when it was not read, or there is no receipt at all (a result from before this reading)."""
    rs = [r for r in o.get("receipts") or [] if isinstance(r, dict)]
    if any(str(r.get("what")) == "token's own links" and r.get("value") == "not read" for r in rs):
        return None, None
    out, read_at, seen = {}, None, False
    for ours, theirs in (("website", "website"), ("x", "twitter"), ("telegram", "telegram")):
        r = next((r for r in rs if str(r.get("what")) == f"token's own {theirs} link"), None)
        if r is None:
            continue
        seen = True
        read_at = read_at or (r.get("as_of") if isinstance(r.get("as_of"), str) and r["as_of"][:2] == "20" else None)
        v = r.get("value")
        if isinstance(v, str) and v.strip().lower().startswith(("http://", "https://")):
            out[ours] = v.strip()
    if not seen:
        if any(str(r.get("what")) == "token's own links" and r.get("value") == "none published" for r in rs):
            r = next(r for r in rs if str(r.get("what")) == "token's own links")
            return {}, (r.get("as_of") if isinstance(r.get("as_of"), str) and r["as_of"][:2] == "20" else None)
        return None, None
    return out, read_at


def _now_iso() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def _receipt(o: dict, what: str) -> dict | None:
    """The first receipt whose `what` starts with these words, or None."""
    return next((r for r in o.get("receipts") or [] if isinstance(r, dict) and str(r.get("what", "")).startswith(what)), None)


def _read_at(r: dict, score_time: str | None) -> tuple:
    """(ISO time the figure was read, slot or None). A receipt stamped with a slot was read in this score run: the run's
    time stands for it, with the slot kept beside it. None when neither is known (then the fact is not written)."""
    a = r.get("as_of")
    if isinstance(a, str) and a[:2] == "20":
        return a, None
    if isinstance(a, str) and a.startswith("slot ") and a[5:].isdigit():
        return score_time, int(a[5:])
    return None, None


def _count_value(v, words=None):
    """'460+' -> (460, True): a real minimum, however many more the list left unstated; '27' or 27 -> (27, False). Absent,
    never 0 (Z1, M1): a count the receipt itself gives as not stated ("None+", "None", nothing), a lower bound of nothing
    ("0+": nothing was read), and a zero that no list stated (a "0" whose words say "no launchpad lists this wallet"; a zero
    is a count only when the words say the list "lists 0 coins")."""
    words = str(words or "").lower()
    if isinstance(v, bool):
        return None, False
    if isinstance(v, int):
        return (v, False) if v > 0 or "lists 0 coins" in words else (None, False)
    if isinstance(v, str):
        s = v.strip()
        if s.endswith("+") and s[:-1].isdigit():
            return (int(s[:-1]), True) if int(s[:-1]) > 0 else (None, False)
        if s.isdigit():
            n = int(s)
            return (n, False) if n > 0 or "lists 0 coins" in words else (None, False)
    return None, False


FEE_CASES = ("none", "rewards_standard", "standard_unknown", "reason_found", "no_reason", "not_checked")   # a design decision


def facts_for(o: dict, meta: dict, score_time: str | None) -> list:
    """The public figures the dossier shows, each with its public source name, the time it was read and its link
   . Built from the result's
    own receipts, but a receipt's words never leave: `source` is one of PUBLIC_SOURCES (K1). Nothing from scoring."""
    mint, out = o.get("mint"), []
    pump = str(o.get("venue", "")).startswith("Pump")
    def fact(id_, label, value, unit, r, source, link, minimum=False):
        read_at, slot = _read_at(r, score_time)
        if value is None or read_at is None or source not in PUBLIC_SOURCES or not link:
            return                                            # no value, no time, no public source or no link: not a figure
        f = {"id": id_, "label": label, "value": value, "unit": unit, "source": source, "read_at": read_at, "link": link}
        if minimum:
            f["minimum"] = True
        if slot is not None:
            f["slot"] = slot
        out.append(f)
    import re
    def _pair_link(words):                                    # "DexScreener pair <address>" in a receipt's source -> the pair's page
        m_ = re.search(r"DexScreener pair ([1-9A-HJ-NP-Za-km-z]{32,44})", str(words or ""))
        return DEXSCREENER_PAIR % m_.group(1) if m_ else None
    def _vault_link(words):                                   # "vault <address>" -> the vault account on the explorer
        m_ = re.search(r"vault ([1-9A-HJ-NP-Za-km-z]{32,44})", str(words or ""))
        return SOLSCAN_ACCOUNT % m_.group(1) if m_ else None
    fee = o.get("transfer_fee") if isinstance(o.get("transfer_fee"), dict) else None     # ONE fact, the site's contract shape (X1)
    r = _receipt(o, "transfer fee")
    if fee is not None and r is not None and isinstance(fee.get("fee_bps"), int) and fee.get("fee_kind") in ("none", "rewards_standard", "outside_norm", "standard_unknown"):
        read_at, slot = _read_at(r, score_time)
        if read_at is not None:
            f = {"id": "transfer_fee", "label": "Transfer fee", "value": fee["fee_bps"] / 100, "unit": "percent", "fee_kind": fee["fee_kind"],
                 "source": "Solana chain", "read_at": read_at, "link": SOLSCAN_TOKEN % mint}
            if fee.get("program") and fee["fee_kind"] != "none":
                f["program"] = str(fee["program"])[:40]
            basis, links = fee.get("standard_basis"), fee.get("standard_links")
            if (isinstance(fee.get("standard_pct"), (int, float)) and fee["fee_kind"] in ("rewards_standard", "outside_norm") and fee.get("program")
                    and basis in ("settings", "observed") and (basis == "settings" or (isinstance(links, list) and 1 <= len(links) <= 10 and all(str(l).startswith("https://") for l in links)))):
                f["standard_pct"], f["standard_basis"] = fee["standard_pct"], basis        # X2: the basis is written exactly when the rate is
                if basis == "observed":
                    f["standard_links"] = [str(l) for l in links]                        # the launches the rate was observed on: its receipts
            if slot is not None:
                f["slot"] = slot
            fr = o.get("fee_reason") if isinstance(o.get("fee_reason"), dict) else None    # which case applied, for the site's line
            if fr and fr.get("case") in FEE_CASES and _receipt(o, "fee reason") is not None:
                f["fee_case"] = fr["case"]
                if fr["case"] == "no_reason" and isinstance(fr.get("items"), list) and fr["items"]:
                    # T1, the site's contract shape: coded items, every one written, no cut; the words are the app's
                    f["reason_why"] = [dict(it) for it in fr["items"] if isinstance(it, dict) and isinstance(it.get("kind"), str) and it["kind"]]
                if fr["case"] == "reason_found" and isinstance(fr.get("recipients"), int):
                    f["holders_paid"] = fr["recipients"]
            agrees = ((f["fee_kind"] == "none" and f["value"] == 0)
                      or (f["fee_kind"] == "standard_unknown" and "program" in f and "standard_pct" not in f and f["value"] > 0)
                      or (f["fee_kind"] == "rewards_standard" and "program" in f and "standard_pct" in f and f["value"] > 0)
                      or (f["fee_kind"] == "outside_norm" and f["value"] > 0 and ("program" not in f or "standard_pct" in f)))
            if agrees:
                out.append(f)                                 # a fact whose fields disagree with the contract's table is not written (the site would show a dash)
    # fees paid to the dev group are a fact of their own, with the collector's transactions as the receipt
    fr = o.get("fee_reason") if isinstance(o.get("fee_reason"), dict) else None
    rp = _receipt(o, "fees paid to the dev group")
    if fr and isinstance(fr.get("dev_payouts"), dict) and fr["dev_payouts"] and rp is not None:
        read_at, _slot = _read_at(rp, score_time)
        coll = re.search(r"\(([1-9A-HJ-NP-Za-km-z]{32,44});", str(rp.get("source", "")))
        if read_at is not None and coll:
            out.append({"id": "fee_dev_payouts", "label": "Fees paid to the dev group", "value": int(sum(int(v) for v in fr["dev_payouts"].values())), "unit": "transfers",
                        "wallets": sorted(fr["dev_payouts"])[:10], "source": "Solana chain", "read_at": read_at, "link": SOLSCAN_ACCOUNT % coll.group(1)})
    r = _receipt(o, "spot-implied valuation")
    if r and isinstance(r.get("value"), (int, float)) and not isinstance(r["value"], bool) and r["value"] >= 0 and pump:
        if "DexScreener" in str(r.get("source", "")):        # T2: the chain read gave nothing; DexScreener's market cap stood in
            fact("valuation", "Valuation", r["value"], "USD", r, "DexScreener", _pair_link(r.get("source")))
        else:
            fact("valuation", "Valuation", r["value"], "USD", r, "Solana chain", PUMPFUN_COIN % mint)
    r = _receipt(o, "real money in pool")                     # the coin's liquidity as the score read it: the QUOTE side
    if r and isinstance(r.get("value"), (int, float)) and not isinstance(r["value"], bool) and r["value"] >= 0:
        side = re.search(r"\(([^;()]+?) side", str(r.get("what", "")))
        label = f"Real money in pool ({side.group(1).strip()} side)" if side else "Real money in pool (quote side)"
        if "DexScreener" in str(r.get("source", "")):
            fact("liquidity_usd", label, r["value"], "USD", r, "DexScreener", _pair_link(r.get("source")))
        else:
            fact("liquidity_usd", label, r["value"], "USD", r, "Solana chain", _vault_link(r.get("source")))
    r = _receipt(o, "market figures (DexScreener)")           # T3: the figures the page shows, from the score's own DexScreener read
    v = r.get("value") if r and isinstance(r.get("value"), dict) else None
    if v and isinstance(v.get("pair"), str):
        link = v.get("url") if isinstance(v.get("url"), str) else DEXSCREENER_PAIR % v["pair"]
        for id_, label, key in (("market_cap", "Market cap", "market_cap"), ("volume_24h", "24-hour volume", "volume_h24"), ("price_usd", "Price", "price_usd")):
            x = v.get(key)
            if isinstance(x, (int, float)) and not isinstance(x, bool) and x >= 0:
                fact(id_, label, x, "USD", r, "DexScreener", link)
        q = v.get("liquidity_quote_usd")                       # only the quote side may be the liquidity fact (P1, P2); the two-sided figure is the app's own
        if not any(f_["id"] == "liquidity_usd" for f_ in out) and isinstance(q, (int, float)) and not isinstance(q, bool) and q >= 0:
            fact("liquidity_usd", f"Real money in pool ({v.get('quote_symbol') or 'quote'} side)", q, "USD", r, "DexScreener", link)
    r = _receipt(o, "venue")                                  # T3: where the coin trades (curve, PumpSwap, LaunchLab, CPMM)
    if r and isinstance(r.get("value"), str) and r["value"]:
        fact("venue", "Trading venue", r["value"], "text", r, "Solana chain", PUMPFUN_COIN % mint if pump else SOLSCAN_TOKEN % mint)
    r = _receipt(o, "launch time")
    if r and isinstance(r.get("value"), (int, float)) and not isinstance(r["value"], bool):
        import re
        m = re.search(r"launch tx ([1-9A-HJ-NP-Za-km-z]{60,90})", str(r.get("source", "")))
        if m:                                                 # Pump.fun's first trade, checked on the chain: the launch transaction is the link
            fact("launched_at", "Launched", _iso(r["value"]), "time", r, "Pump.fun", SOLSCAN_TX % m.group(1))
        elif pump:
            fact("launched_at", "Launched", _iso(r["value"]), "time", r, "Solana chain", PUMPFUN_COIN % mint)
    r = _receipt(o, "creation record")
    if r and isinstance(r.get("value"), list) and len(r["value"]) == 2 and isinstance(r["value"][0], str):
        launcher, fee = r["value"]
        fact("launcher", "Launcher wallet", launcher, "wallet", r, "Pump.fun", SOLSCAN_ACCOUNT % launcher)
        if isinstance(fee, str) and fee and fee != launcher:
            fact("fee_wallet", "Fee wallet (the curve's creator)", fee, "wallet", r, "Pump.fun", SOLSCAN_ACCOUNT % fee)
    elif isinstance(o.get("creator"), str) and o["creator"]:
        r = _receipt(o, "creator (from curve)")
        if r:
            fact("fee_wallet", "Fee wallet (the curve's creator)", o["creator"], "wallet", r, "Solana chain", SOLSCAN_ACCOUNT % o["creator"])
    # x2: the wallet the engine scores as the dev is the curve's creator NOW; where the fees were moved after launch
    # it differs from the launch's fee receiver (and from the launcher) and gets its own line.
    now_dev = o.get("creator") if isinstance(o.get("creator"), str) and o.get("creator") else None
    at_launch = {x.get("value") for x in out if x.get("id") in ("launcher", "fee_wallet")}
    if now_dev and at_launch and now_dev not in at_launch:
        r = _receipt(o, "creator (from curve)")
        if r:
            fact("dev_wallet", "Wallet scored as the developer (the fees were moved here)", now_dev, "wallet", r, "Solana chain", SOLSCAN_ACCOUNT % now_dev)
    dev = o.get("creator") if isinstance(o.get("creator"), str) and o.get("creator") else None
    profile = lambda w: PUMPFUN_PROFILE % w if pump else SOLSCAN_ACCOUNT % w
    src = lambda words: "Pump.fun" if "Pump.fun" in str(words or "") else "Solana chain"   # the launchpad's own list, or the chain's history
    # A launch count is shown beside the wallet it was counted for, labelled for what that wallet is (the team's X1; decisions
    # 81 and 82): the launcher's count when the coin has a launcher on record, the fee wallet's own count as its own line.
    bw = _receipt(o, "launch counts by wallet")
    bw = bw.get("value") if bw and isinstance(bw.get("value"), dict) else None
    counted = None                                            # the wallet the duplicate-relaunch count belongs with
    if bw:
        launcher, fee = bw.get("launcher"), bw.get("fee_wallet")
        if isinstance(launcher, str) and launcher:
            n, lower = _count_value(bw.get("launcher_launches"), bw.get("launcher_from"))
            fact("dev_launches", "Launches by the launcher", n, "tokens created", _receipt(o, "launch counts by wallet"), src(bw.get("launcher_from")), profile(launcher), minimum=lower)
            counted = launcher
            if isinstance(fee, str) and fee and fee != launcher:
                n, lower = _count_value(bw.get("fee_wallet_launches"), bw.get("fee_wallet_from"))
                fact("fee_wallet_launches", "Launches by the fee wallet", n, "tokens created", _receipt(o, "launch counts by wallet"), src(bw.get("fee_wallet_from")), profile(fee), minimum=lower)
        elif isinstance(fee, str) and fee:
            n, lower = _count_value(bw.get("fee_wallet_launches"), bw.get("fee_wallet_from"))
            fact("dev_launches", "Launches by the fee wallet (the curve's creator)", n, "tokens created", _receipt(o, "launch counts by wallet"), src(bw.get("fee_wallet_from")), profile(fee), minimum=lower)
            counted = fee
    else:                                                     # a result from before that receipt existed
        lr = _receipt(o, "launcher of this token")
        if lr and isinstance(lr.get("value"), dict) and isinstance(lr["value"].get("wallet"), str):
            n, lower = _count_value(lr["value"].get("launches"), lr.get("source"))
            fact("dev_launches", "Launches by the launcher", n, "tokens created", lr, src(lr.get("source")), profile(lr["value"]["wallet"]), minimum=lower)
            counted = lr["value"]["wallet"]                   # the fee wallet's own count is not on record apart: not written
        else:
            r = _receipt(o, "dev launches")
            if r and dev:
                n, lower = _count_value(r.get("value"), r.get("source"))
                fact("dev_launches", "Launches by the fee wallet (the curve's creator)", n, "tokens created", r, src(r.get("source")), profile(dev), minimum=lower)
                counted = dev
    r = _receipt(o, "duplicate relaunches of this token")
    if r and counted:
        n, _lower = _count_value(r.get("value"), r.get("source"))
        fact("duplicate_relaunches", "Duplicate relaunches", n, "copies by the same developer", r, "Solana chain", profile(counted))
    return out


# The dossier sections the app shows (its own names for the engine's readings), and the fixed public reasons a section may
# carry for not having been read (contract v1.1 `not_read`; the team 2026-10-13): the app shows the words, it never guesses
# from the engine's sentences.
SECTIONS = ("liquidity_depth", "liquidity_permanence", "contract_authorities", "pair_health", "dev_conduct", "creator_holdings",
            "track_record", "reward_flow_pressure", "top_holders")      # top_holders: the who-holds brakes' read (no band: read = Clear, failed = could not be read)
DEV_SECTIONS = ("dev_conduct", "creator_holdings", "track_record")
NOT_READ_REASONS = ("dev not identified", "launch count not stated", "could not be read")


def not_read_for(o: dict, facts: list | None = None) -> dict:
    """{section: reason} for every dossier section the engine did not read, from the result's readings and its own notes;
    {} when every section was read. Reasons are from NOT_READ_REASONS only. The reason follows the engine's own verdict
    for the section, never the presence of a count line: a
    track record the engine could not judge because the launch count was unknown, or a minimum the serial-launcher rule
    could not use, says "launch count not stated" even when a count line ("45+", another wallet's) is in the feed."""
    rd = o.get("readings") if isinstance(o.get("readings"), dict) else {}
    notes = " ".join(str(n) for n in (o.get("notes") or []) if isinstance(n, str)).lower()
    label = f"{o.get('label') or ''} {o.get('display') or ''}".lower()
    dev_hidden = "dev hidden" in notes or "launch bot" in label
    count_unknown = rd.get("dev_launches") is None or "launch count unknown" in notes or "launch count is a lower bound" in notes
    out = {}
    for s in SECTIONS:
        v = rd.get(s)
        if isinstance(v, (int, float)) and not isinstance(v, bool):
            continue                                              # read: a number the app bands
        if s in DEV_SECTIONS and dev_hidden:
            out[s] = "dev not identified"
        elif s == "track_record" and count_unknown:
            out[s] = "launch count not stated"
        elif v == "no_penalty":
            continue                                              # the rule ran and found nothing to penalise: read, no band (the app's "Clear")
        else:
            out[s] = "could not be read"                          # unknown, error or missing
    return out


CHAIN_VIEW = {"base": ("Base chain", "https://basescan.org/address/%s", "https://basescan.org/token/%s"),
              "bsc": ("BNB chain", "https://bscscan.com/address/%s", "https://bscscan.com/token/%s")}


def _chain_view(o: dict) -> tuple:
    """(public source name, account link, token link) for the coin's own chain: Base and BNB coins by their chain (or a 0x
    address with no chain named: not guessed, left out), every other coin Solana's."""
    ch = o.get("chain")
    if ch in CHAIN_VIEW:
        return CHAIN_VIEW[ch]
    if str(o.get("mint") or "").startswith("0x"):
        return (None, "%s", "%s")                              # a 0x coin whose chain is not named: no source (left out, never Solana)
    return ("Solana chain", SOLSCAN_ACCOUNT, SOLSCAN_TOKEN)


def check_sources_for(o: dict, score_time: str | None) -> dict:
    """a design decision, contract `check_sources`: for each DeepScan check the score read, the receipt it rests on as
    {source, read_at, url}: a name from PUBLIC_SOURCES, an ISO time and an https link. A check not read, or a receipt
    missing any of the three, is left out (the page shows a dash, never a made-up source). Top holders first."""
    import re
    mint, creator = o.get("mint"), o.get("creator")
    chain_name, account_url, token_url = _chain_view(o)       # line 7: the coin's own chain and explorer
    rd = o.get("readings") if isinstance(o.get("readings"), dict) else {}
    def read(check):
        v = rd.get(check)
        return (isinstance(v, (int, float)) and not isinstance(v, bool)) or v == "no_penalty"
    def one(r, source, url):
        if not r:
            return None
        at, _slot = _read_at(r, score_time)
        if at is None or source not in PUBLIC_SOURCES or not (isinstance(url, str) and url.startswith("https://")):
            return None
        return {"source": source, "read_at": at, "url": url}
    out = {}
    r = _receipt(o, "top holders read")
    if read("top_holders") and r:
        out["top_holders"] = one(r, "Pump.fun", PUMPFUN_COIN % mint) if str(r.get("source")) == "Pump.fun top holders" else \
            one(r, chain_name, token_url % mint)
    r = _receipt(o, "real money in pool") or _receipt(o, "real money on curve")
    if read("liquidity_depth") and r:
        src = str(r.get("source", ""))
        pair = re.search(r"DexScreener pair ([1-9A-HJ-NP-Za-km-z]{32,44})", src)
        vault = re.search(r"vault ([1-9A-HJ-NP-Za-km-z]{32,44})", src)
        out["liquidity_depth"] = (one(r, "DexScreener", DEXSCREENER_PAIR % pair.group(1)) if pair else
                                  one(r, chain_name, account_url % vault.group(1)) if vault else
                                  one(r, chain_name, token_url % mint))
    r = _receipt(o, "token program")
    if read("contract_authorities") and r:
        out["contract_authorities"] = one(r, chain_name, token_url % mint)
    r = _receipt(o, "LP tokens currently in existence")
    lp = re.search(r"getAccountInfo ([1-9A-HJ-NP-Za-km-z]{32,44})", str((r or {}).get("source", "")))
    if read("liquidity_permanence") and r and lp:
        out["liquidity_permanence"] = one(r, chain_name, token_url % lp.group(1))
    r = _receipt(o, "dev conduct (group)")
    if r and isinstance(creator, str) and creator:
        for check in ("dev_conduct", "creator_holdings"):
            if read(check):
                out[check] = one(r, chain_name, account_url % creator)
    r = _receipt(o, "track record")
    if read("track_record") and r and isinstance(creator, str) and creator:
        out["track_record"] = one(r, chain_name, account_url % creator)
    r = _receipt(o, "collector sells, last 24h")
    if read("reward_flow_pressure") and r:
        out["reward_flow_pressure"] = one(r, chain_name, token_url % mint)
    return {k: v for k, v in out.items() if v}


FUNDING_WORDS_MAX = 140


def funding_fact(o: dict, score_time: str | None) -> dict | None:
    """a design decision, contract `funding_source`: the funding trace's plain words, source "Solana chain", the time read, and
    the explorer page of the dev wallet's first incoming transfer; "not read" carries no link. Shown, not graded."""
    import re
    if _chain_view(o)[0] != "Solana chain":                  # line 7: Solana's trace format; a Base/BNB coin's funding is its evidence rows
        return None
    r = _receipt(o, "funding source")
    v = r.get("value") if r and isinstance(r.get("value"), dict) else None
    if not v:
        return None
    at, _slot = _read_at(r, score_time)
    if at is None:
        return None
    if str(v.get("kind")) in ("not_read", "no_launch_time"):
        return {"id": "funding_source", "label": "Funding source", "value": "not read", "unit": "text", "source": "Solana chain", "read_at": at}
    words = re.sub(r"[^A-Za-z0-9 ,.;:()'/-]", "", str(v.get("words") or ""))[:FUNDING_WORDS_MAX].strip()
    chain = v.get("trace") if isinstance(v.get("trace"), list) else []
    first = chain[0] if chain and isinstance(chain[0], dict) else {}
    sig, dev = first.get("signature"), first.get("wallet")
    link = (SOLSCAN_TX % sig if isinstance(sig, str) and re.fullmatch(r"[1-9A-HJ-NP-Za-km-z]{64,90}", sig) else
            SOLSCAN_ACCOUNT % dev if isinstance(dev, str) and re.fullmatch(r"[1-9A-HJ-NP-Za-km-z]{32,44}", dev) else None)
    if not words or not link:
        return None
    return {"id": "funding_source", "label": "Funding source", "value": words, "unit": "text", "source": "Solana chain",
            "read_at": at, "link": link}


def shown_facts_for(o: dict) -> list:
    """The result's decision-197 facts, each passed only with a known id, a public source, its whole receipt and a
    figure (missing stays missing); the score's own facts keep their ids, so a shown id never repeats one of them."""
    sh = o.get("shown") if isinstance(o.get("shown"), dict) else {}
    out, seen = [], set()
    for f in sh.get("facts") or []:
        if not isinstance(f, dict) or f.get("id") not in SHOWN_IDS or f["id"] in seen or f.get("source") not in PUBLIC_SOURCES:
            continue
        if f.get("value") is None or not f.get("read_at") or not _https(f.get("link")) or not isinstance(f.get("label"), str):
            continue
        keep = {k: f[k] for k in ("id", "label", "value", "unit", "source", "read_at", "link")}
        keep.update({k: f[k] for k in SHOWN_EXTRA.get(f["id"], ()) if f.get(k) is not None})
        out.append(keep)
        seen.add(f["id"])
    return out


def shown_links_for(o: dict) -> dict | None:
    """Stonk.fun's own record of the coin's website, X and Telegram, beside the coin's `links`, never
    replacing them; http/https only; None when Stonk.fun gave none."""
    sh = o.get("shown") if isinstance(o.get("shown"), dict) else {}
    lk = sh.get("launchpad_links")
    if not isinstance(lk, dict) or lk.get("source") not in PUBLIC_SOURCES or not lk.get("read_at"):
        return None
    got = {k: lk[k] for k in ("website", "x", "telegram") if isinstance(lk.get(k), str) and lk[k].startswith(("https://", "http://"))}
    return dict(got, source=lk["source"], read_at=lk["read_at"]) if got else None


def ath_for(o: dict) -> dict:
    """SITE's All-time high row: Pump.fun's own all-time high market cap in dollars at the peak's own time (never a later SOL
    price), its time and the trade it was matched to; {} when it was not read (the row keeps its dash)."""
    r = _receipt(o, "all-time high (market cap)")
    v = (r or {}).get("value")
    if not isinstance(v, dict):
        return {}
    cap, at, tx = v.get("cap_usd"), v.get("at"), v.get("tx")
    if not (isinstance(cap, (int, float)) and not isinstance(cap, bool) and cap > 0 and isinstance(at, (int, float)) and at > 0):
        return {}
    out = {"ath_cap_usd": float(cap), "ath_at": _iso(at), "ath_source": "Pump.fun"}
    if isinstance(tx, str) and 43 <= len(tx) <= 90 and tx.isalnum():
        out["ath_tx"] = tx
    return out


def to_feed(o: dict, meta: dict) -> dict | None:
    """One result -> one contract record. None if the result has no usable score fields (e.g. a reader error)."""
    if "error" in o or "mint" not in o or "display" not in o or "coverage" not in o:
        return None
    score = o.get("score")
    score = score if isinstance(score, int) and not isinstance(score, bool) and 1 <= score <= 99 else None
    label = o.get("label")
    label = label.strip() if isinstance(label, str) and label.strip() else None
    display = str(o["display"]).strip()
    if label in NO_SCORE_LABELS or display in NO_SCORE_LABELS:
        score = None                                         # the no-score rule: a proven label never carries a number
    if score is None and label is None and display not in ("0",) and not display.isdigit():
        label = display                                      # e.g. "Technical error, retrying": a plain note
    cov = o["coverage"]
    if not isinstance(cov, (int, float)):
        return None
    rec = {"mint": o["mint"], "score": score, "display": display,
           "coverage": round(min(1.0, max(0.0, float(cov))), 3), "label": label}
    chain = o.get("chain") or ("solana" if o.get("venue") else None)
    lp = o.get("launchpad")
    opt = {"chain": chain,
           "launchpad": LAUNCHPAD_NAMES.get(lp, lp) if lp else (f"{o.get('venue')} ({o['platform']})" if o.get("platform") else o.get("venue")),   # a LaunchLab coin names its platform
           "name": meta.get("name"), "ticker": (meta.get("ticker") or "").lstrip("$") or None,
           "image_url": meta.get("image_url"),
           "valuation_usd": o["valuation_usd"] if isinstance(o.get("valuation_usd"), (int, float)) and o["valuation_usd"] >= 0 else None,
           "launched_at": _iso(meta.get("launch_ts"))}
    times = [r.get("as_of") for r in o.get("receipts") or [] if isinstance(r.get("as_of"), str) and r["as_of"][:2] == "20"]
    opt["as_of"] = max(times) if times else None
    facts = facts_for(o, meta, opt["as_of"])                 # contract v1.1: source, time read and link on every figure
    facts = (facts or []) + shown_facts_for(o)              # shown beside the score's own facts, never scored
    ff = funding_fact(o, opt["as_of"])                      # the funding answer, shown not graded
    if ff:
        facts = [f for f in facts if f.get("id") != "funding_source"] + [ff]
    opt["facts"] = facts or None
    opt["check_sources"] = check_sources_for(o, opt["as_of"]) or None   # per-check receipts (source, time, link)
    opt["launchpad_links"] = shown_links_for(o)
    opt.update(ath_for(o))
    opt["not_read"] = not_read_for(o, facts) or None         # the sections not read, each with its fixed public reason
    if isinstance(o.get("social_waits"), bool):               # "not_checked" only where the X
        opt["social_check"] = "not_checked" if o["social_waits"] else "done"   # account's parts wait (the page shows "Social: not checked
                                                              # yet" beside the score); "done" where nothing waits, a no-links coin too
    if isinstance(meta.get("links"), dict) and meta.get("links_read_at") and meta["links"]:
        opt["links"] = dict(meta["links"], source="Pump.fun", read_at=meta["links_read_at"])      # the launchpad's record
    else:                                                     # no launchpad record with links: the coin's own metadata document
        own, own_at = _own_links(o)                           # (named on chain; LaunchLab's record names the same document)
        if own is not None and own_at and _chain_view(o)[0]:  # line 7: the coin's own chain names its document
            opt["links"] = dict(own, source=_chain_view(o)[0], read_at=own_at)
        elif isinstance(meta.get("links"), dict) and meta.get("links_read_at"):
            opt["links"] = dict(meta["links"], source="Pump.fun", read_at=meta["links_read_at"])  # the record was read and lists none
        else:                                                 # neither was read: not read, never "not listed" 
            opt["not_read"] = dict(opt["not_read"] or {}, links="could not be read")
    rec.update({k: v for k, v in opt.items() if v is not None})
    return rec


import contextlib, fcntl


@contextlib.contextmanager
def file_lock(mint: str):
    """One lock per coin's feed file, shared by every writer (the scorer's exporter, the early file, the seen file, the design's
    R1): a lock file beside the feed, held across processes with flock, so a check-then-write never crosses another's write."""
    safe = "".join(ch for ch in mint if ch.isalnum())
    d = os.path.join(os.path.dirname(os.path.abspath(FEED_DIR)), ".feed-locks")     # beside the feed, never inside it (the app reads the feed folder whole)
    os.makedirs(d, exist_ok=True)
    fd = os.open(os.path.join(d, safe + ".lock"), os.O_CREAT | os.O_RDWR, 0o644)
    try:
        fcntl.flock(fd, fcntl.LOCK_EX)
        yield
    finally:
        fcntl.flock(fd, fcntl.LOCK_UN)
        os.close(fd)


TAG_ORDER = ("vamp", "bot", "serial_launcher")              # the tags a coin keeps wherever it appears
TAG_OF = {"earlier_lookalike": "vamp", "bot_launch": "bot", "serial_launcher": "serial_launcher",
          "fast_launcher": "serial_launcher", "same_creator_relaunch": "serial_launcher"}


def gate_tags(gate) -> list:
    """The coin's tags from its gate section (the evidence file's `gate`): a held or bot coin's observed items, in TAG_ORDER;
    [] for a passed, unread or missing one. The evidence behind each tag stays in that section."""
    if not isinstance(gate, dict) or gate.get("status") not in ("held", "bot"):
        return []
    have = {TAG_OF.get(it.get("kind")) for it in gate.get("items") or [] if isinstance(it, dict)}
    return [t for t in TAG_ORDER if t in have]


def tags_for(mint: str, feed_dir: str | None = None) -> list:
    """The tags as the coin's evidence file on disk states them (no database): for a seen file or a score written now."""
    safe = "".join(ch for ch in mint if ch.isalnum())
    try:
        return gate_tags(json.load(open(os.path.join(feed_dir or FEED_DIR, "evidence", safe + ".json"))).get("gate"))
    except Exception:
        return []


def set_tags(mint: str, tags: list, feed_dir: str | None = None) -> bool:
    """the coin's feed file (seen or scored, any chain) carries `tags` as its gate states them now, left out
    when none; the file is only rewritten when they change, under the coin's lock. False when there is no file to change."""
    safe = "".join(ch for ch in mint if ch.isalnum())
    path = os.path.join(feed_dir or FEED_DIR, safe + ".json")
    with file_lock(mint):
        try:
            d = json.load(open(path))
        except Exception:
            return False
        if not isinstance(d, dict) or d.get("mint") != mint or (d.get("tags") or []) == list(tags):
            return False
        if tags:
            d["tags"] = list(tags)
        else:
            d.pop("tags", None)
        json.dump(d, open(path + ".tmp", "w"), indent=1)
        os.replace(path + ".tmp", path)
    return True


KEPT_NAMES = ("name", "ticker", "image_url", "chain", "launchpad", "launched_at")


def _keep_names(rec: dict, path: str) -> None:
    """the team 2026-10-26: a result that brings no name (a failed score reads no chain,
    so no look-up is made) keeps the name, ticker, picture, chain, launchpad and launch time the coin's file already had (its seen file, or an earlier score); a field the
    new result does carry wins. Nothing is made up: what neither has stays missing."""
    if all(rec.get(k) for k in KEPT_NAMES):
        return
    try:
        old = json.load(open(path))
    except Exception:
        return
    if not isinstance(old, dict) or old.get("mint") != rec.get("mint"):
        return
    for k in KEPT_NAMES:
        if not rec.get(k) and isinstance(old.get(k), str) and old[k].strip():
            rec[k] = old[k]


def counts(rec: dict) -> bool:
    """A record worth writing: a score, or a proven no-score label. A failed score ("Technical error, retrying") is not:
    checklist 7 (the team 2026-10-25: error text is never a coin's public note; the coin keeps what it showed and is tried
    again), as Base/BNB already do (stage4/run_evm.py `counts`)."""
    return rec.get("score") is not None or rec.get("label") in NO_SCORE_LABELS or rec.get("display") in NO_SCORE_LABELS


def export_one(o: dict, cache: dict | None = None) -> str | None:
    if o.get("early"):                                       # an early score: no look-up for its display facts
        return export_early(o)
    rec = to_feed(o, meta_for(o, cache) if "error" not in o else {})
    if rec is None or not counts(rec):                       # a failed score leaves the coin's file as it was (its seen file
        return None                                          # or last score); with none, nothing is written
    os.makedirs(FEED_DIR, exist_ok=True)
    safe = "".join(ch for ch in rec["mint"] if ch.isalnum())
    path = os.path.join(FEED_DIR, safe + ".json")
    tmp = path + ".tmp"
    tags = tags_for(rec["mint"])
    if tags:
        rec["tags"] = tags                                   # 271(b): a score keeps the coin's tags from its gate
    with file_lock(rec["mint"]):                             # R1: under the coin's lock, so a seen-file writer never crosses this
        _keep_names(rec, path)
        json.dump(rec, open(tmp, "w"), indent=1)
        os.replace(tmp, path)                                # atomic: the app never reads a half-written file
    try:
        from chart_events import record                      # dated score / flag changes for the chart
        record(rec, NO_SCORE_LABELS, FEED_DIR)
    except Exception:
        pass                                                 # events are optional; the result file is already written
    try:
        from metric import record as metric_record           # PINRmetric: the score over time
        metric_record(rec, NO_SCORE_LABELS, FEED_DIR)
    except Exception:
        pass                                                 # optional too
    return path


def _early_meta(o: dict) -> dict:
    """Name, ticker and launch time of an early result, from its own receipts (they come from the creation record)."""
    meta = {}
    for r in o.get("receipts") or []:
        what, v = str(r.get("what", "")), r.get("value")
        if what.startswith("name and ticker") and isinstance(v, (list, tuple)) and len(v) == 2:
            meta["name"], meta["ticker"] = (v[0] if isinstance(v[0], str) else None), (v[1] if isinstance(v[1], str) else None)
        elif what.startswith("launch time") and isinstance(v, (int, float)) and not isinstance(v, bool):
            meta["launch_ts"] = v
    return meta


def export_early(o: dict) -> str | None:
    """An early score's file: the same contract record plus the one optional field `early`, built
    with no look-up. Name, ticker and launch time come from the result's own receipts (the coin's creation record); the
    picture is not read yet, so `image_url` is absent. Never replaces a full score's file. No chart event and no
    PINRmetric point is written for an early score."""
    meta = _early_meta(o)
    rec = to_feed(o, meta)
    if rec is None or not counts(rec):                       # checklist 7: a failed early score writes nothing either
        return None
    rec["early"] = True
    os.makedirs(FEED_DIR, exist_ok=True)
    safe = "".join(ch for ch in rec["mint"] if ch.isalnum())
    path = os.path.join(FEED_DIR, safe + ".json")
    tmp = path + ".tmp"
    with file_lock(rec["mint"]):
        try:
            d = json.load(open(path))
            if not d.get("early") and not d.get("seen"):
                return None                                  # a full score is already there
        except FileNotFoundError:
            pass
        except Exception:
            return None                                      # unreadable: leave it alone
        json.dump(rec, open(tmp, "w"), indent=1)
        os.replace(tmp, path)
    return path


def withdraw_early(mint: str) -> bool:
    """Remove a coin's feed file if, and only if, it is an early one (its early score has ended with no full score)."""
    safe = "".join(ch for ch in mint if ch.isalnum())
    path = os.path.join(FEED_DIR, safe + ".json")
    try:
        if json.load(open(path)).get("early") is not True:
            return False
    except Exception:
        return False                                         # no file, or unreadable: nothing is removed
    os.remove(path)
    return True


def export_all() -> int:
    newest = {}
    for d in RESULT_DIRS:
        for f in glob.glob(os.path.join(d, "*.json")):
            try:
                o = json.load(open(f))
            except Exception:
                continue
            if not isinstance(o, dict) or "mint" not in o:
                continue
            t = os.path.getmtime(f)
            if o["mint"] not in newest or t > newest[o["mint"]][0]:
                newest[o["mint"]] = (t, o)
    cache = _cache()
    n = 0
    for mint, (_, o) in sorted(newest.items()):
        if export_one(o, cache):
            n += 1
    return n


if __name__ == "__main__":
    print(f"{export_all()} token file(s) written to {FEED_DIR}")
