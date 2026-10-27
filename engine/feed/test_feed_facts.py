"""Contract v1.1, the sources on every figure: plain-English tests with a made-up result.
No network (every call is blocked and counted), no live file: the exporter's facts are built in memory from receipts.
Run:  python3 test_feed_facts.py"""
import json, os, socket, sys, tempfile, time, urllib.request

CALLS = []
def _blocked(*a, **k):
    CALLS.append(a[:1]); raise OSError("network blocked in this test")
urllib.request.urlopen = _blocked
socket.create_connection = _blocked

import feed_export as F
import pumpfun_api as PF

results = []
def case(n, title, should, fn):
    try:
        ok, text = fn()
    except Exception as e:
        ok, text = False, f"CRASH {type(e).__name__}: {e}"
    results.append(ok)
    print(f"\n{n:>2}. {title}\n    should: {should}\n    did:    {text}\n    {'PASS' if ok else 'FAIL'}")

MINT = "MadeUpMint1111111111111111111111111111111pump"
LAUNCHER, FEE = "LauncherWallet111111111111111111111111111111", "FeeWallet11111111111111111111111111111111111"
SIG = "5" * 64
T1, T2 = "2026-10-13T17:33:49+00:00", "2026-10-13T17:35:01+00:00"

def result(**kw):
    o = {"mint": MINT, "venue": "Pump.fun curve", "creator": FEE, "score": 47, "display": "47", "coverage": 0.4, "label": None,
         "valuation_usd": 3363.26, "readings": {"liquidity_depth": 9.1}, "flags": [], "notes": [],
         "receipts": [
             {"what": "token program", "value": "Tokenz", "unit": "program id", "source": f"getAccountInfo {MINT}", "as_of": "slot 456532542"},
             {"what": "creator (from curve)", "value": FEE, "unit": "address", "source": "getAccountInfo MadeUpCurve", "as_of": "slot 456532542"},
             {"what": "spot-implied valuation", "value": 3363.26, "unit": "USD", "source": "curve math v1 × total supply", "as_of": T1},
             {"what": "launch time (launch transaction)", "value": 1791912723, "unit": "unix time", "source": f"Pump.fun first trade, chain-checked: launch tx {SIG}", "as_of": T1},
             {"what": "creation record (launcher, fee receiver at launch)", "value": [LAUNCHER, FEE], "unit": "wallets", "source": "Pump.fun creation transaction 6" + "6" * 63, "as_of": T2},
             {"what": "dev launches", "value": "460+", "unit": "tokens created", "source": "Pump.fun lists 460 coins launched by this wallet; 460 read (a minimum)", "as_of": T2},
             {"what": "launch counts by wallet", "value": {"fee_wallet": FEE, "fee_wallet_launches": "0", "fee_wallet_from": "Pump.fun lists 0 coins launched by this wallet", "launcher": LAUNCHER, "launcher_launches": "460+", "launcher_from": "Pump.fun lists 460 coins launched by this wallet; 460 read (a minimum)"}, "unit": "wallet -> count", "source": "each wallet's own list of coins", "as_of": T2},
             {"what": "duplicate relaunches of this token", "value": 2, "unit": "earlier/later copies by the same dev", "source": "Helius parsed history + DAS metadata", "as_of": T2},
         ]}
    o.update(kw)
    return o

META = {"name": "Made Up", "ticker": "MU", "image_url": "https://ipfs.io/ipfs/x", "launch_ts": 1791912723,
        "links": {"website": "https://made-up.example", "x": "https://x.com/madeup"}, "links_read_at": "2026-10-13T17:53:20Z"}
by_id = lambda rec: {f["id"]: f for f in rec.get("facts", [])}


def c1():
    rec = F.to_feed(result(), META)
    f = by_id(rec)
    ok = set(f) == {"valuation", "launched_at", "launcher", "fee_wallet", "dev_launches", "fee_wallet_launches", "duplicate_relaunches"} \
        and f["valuation"]["value"] == 3363.26 and f["valuation"]["link"] == f"https://pump.fun/coin/{MINT}" and f["valuation"]["read_at"] == T1 and f["valuation"]["source"] == "Solana chain" \
        and f["launched_at"]["value"] == "2026-10-13T17:32:03Z" and f["launched_at"]["link"] == f"https://solscan.io/tx/{SIG}" and f["launched_at"]["source"] == "Pump.fun" \
        and f["launcher"]["value"] == LAUNCHER and f["launcher"]["link"].endswith(LAUNCHER) and f["fee_wallet"]["value"] == FEE \
        and f["dev_launches"]["value"] == 460 and f["dev_launches"]["minimum"] is True and f["dev_launches"]["read_at"] == T2 and f["dev_launches"]["link"] == f"https://pump.fun/profile/{LAUNCHER}" and f["dev_launches"]["source"] == "Pump.fun" and f["dev_launches"]["label"] == "Launches by the launcher" \
        and f["fee_wallet_launches"]["value"] == 0 and "minimum" not in f["fee_wallet_launches"] and f["fee_wallet_launches"]["link"] == f"https://pump.fun/profile/{FEE}" \
        and f["duplicate_relaunches"]["value"] == 2 and "minimum" not in f["duplicate_relaunches"] and f["duplicate_relaunches"]["source"] == "Solana chain" and f["duplicate_relaunches"]["link"].endswith(LAUNCHER) \
        and all(x["source"] in F.PUBLIC_SOURCES and x["read_at"] and x["link"].startswith("https://") and "unit" in x and "label" in x for x in rec["facts"])
    return ok, json.dumps(rec.get("facts"))[:700]
case(1, "A full Pump.fun result with its receipts (a launcher and a different fee wallet)", "seven facts, each with a public source name from the fixed list, the time read and a link; the launch time links its transaction; the launcher's count 460+ is 460 with minimum true, linked to the launcher's own page and labelled as the launcher's; the fee wallet's own count (0) is its own line linked to its page", c1)

def c2():
    rec = F.to_feed(result(), META)
    return rec.get("links") == {"website": "https://made-up.example", "x": "https://x.com/madeup", "source": "Pump.fun", "read_at": "2026-10-13T17:53:20Z"}, json.dumps(rec.get("links"))
case(2, "The coin's own links from the Pump.fun record", "website and X as the record gave them, with the record as source and the time read; no Telegram because the record had none", c2)

def c3():
    o = result(); o["receipts"] = [r for r in o["receipts"] if not r["what"].startswith("creation record")]
    rec = F.to_feed(o, META)
    f = by_id(rec)
    ok = "launcher" not in f and f["fee_wallet"]["value"] == FEE and f["fee_wallet"]["slot"] == 456532542 and f["fee_wallet"]["read_at"] == T2 and f["fee_wallet"]["source"] == "Solana chain"
    return ok, f"facts: {sorted(f)}; fee wallet read_at {f['fee_wallet'].get('read_at')} slot {f['fee_wallet'].get('slot')}"
case(3, "No creation record, only the curve's creator read at a slot", "no launcher fact; the fee wallet comes from the curve with the score run's time as read_at and the slot kept beside it", c3)

def c4():
    o = result(); o["receipts"] = []
    rec = F.to_feed(o, {"name": "x"})
    rec2 = F.to_feed(result(), {"name": "x"})
    return "facts" not in rec and "links" not in rec and "links" not in rec2 and rec["score"] == 47, f"no receipts: keys {sorted(rec)}; receipts but no record read: links present = {'links' in rec2}"
case(4, "A result with no receipts; and one whose Pump.fun record was not read", "no facts and no links are written (missing stays missing); the score fields are as before", c4)

def c5():
    o = result()
    for r in o["receipts"]:
        if r["what"] == "launch counts by wallet": r["value"]["launcher_launches"] = "unknown"
        if r["what"].startswith("spot-implied"): r["as_of"] = "not a time"
    f = by_id(F.to_feed(o, META))
    return "dev_launches" not in f and "fee_wallet_launches" in f and "valuation" not in f and "launcher" in f, f"facts: {sorted(f)}"
case(5, "A launcher's count that is not a number, and a valuation receipt with no usable time", "neither becomes a fact; the fee wallet's own count and the others stand", c5)

def c8():
    o = result()                                               # a result from before the per-wallet receipt existed
    o["receipts"] = [r for r in o["receipts"] if r["what"] != "launch counts by wallet"]
    o["receipts"].append({"what": "launcher of this token", "value": {"wallet": LAUNCHER, "launches": "460+", "funded the fee receiver": False, "fee receiver active a day before launch": False}, "unit": "facts", "source": "Pump.fun lists 460 coins launched by this wallet", "as_of": T2})
    f = by_id(F.to_feed(o, META))
    o2 = result(); o2["receipts"] = [r for r in o2["receipts"] if r["what"] not in ("launch counts by wallet", "creation record (launcher, fee receiver at launch)")]
    g = by_id(F.to_feed(o2, META))
    ok = f["dev_launches"]["link"].endswith(LAUNCHER) and f["dev_launches"]["label"] == "Launches by the launcher" and "fee_wallet_launches" not in f \
        and g["dev_launches"]["link"].endswith(FEE) and g["dev_launches"]["label"].startswith("Launches by the fee wallet") and "launcher" not in g
    return ok, f"with a launcher on record: count linked to {f['dev_launches']['link'][-12:]}, label '{f['dev_launches']['label']}', fee wallet's own count written: {'fee_wallet_launches' in f}; with no launcher at all: count linked to {g['dev_launches']['link'][-12:]}, label '{g['dev_launches']['label']}'"
case(8, "Results from before the per-wallet receipt: one with a launcher on record, one with none", "the count is linked to the launcher's page and labelled as the launcher's (the fee wallet's own count, not on record apart, is not written); with no launcher the fee wallet's count links the fee wallet's page", c8)

def c6():
    rec = F.to_feed(result(), META)
    text = json.dumps(rec)
    bad = [w for w in ("readings", "liquidity_depth", "weight", "cap", "threshold", "real_money", "flags", "notes") if f'"{w}"' in text]
    vendors = [w for w in ("Helius", "Shyft", "Alchemy", "PublicNode", "getAccountInfo", "curve math", "parsed history", "DAS") if w in text]
    return bad == [] and vendors == [] and "receipts" not in rec, f"scoring words found: {bad}; provider or receipt words found: {vendors}"
case(6, "Nothing from scoring and no provider's name in the feed record", "no readings, flags, notes, receipts or check number; no Helius, Shyft, Alchemy, PublicNode or a receipt's own words: a source is a public name from the fixed list", c6)

def c7():
    real = PF.coin
    try:
        PF.coin = lambda mint: {"mint": mint, "website": "https://a.example", "twitter": "ftp://no", "telegram": " https://t.me/x "}
        got = F._pumpfun_links(MINT)
        PF.coin = lambda mint: None
        none = F._pumpfun_links(MINT)
    finally:
        PF.coin = real
    return got.get("links") == {"website": "https://a.example", "telegram": "https://t.me/x"} and "links_read_at" in got and none == {}, f"links {got.get('links')}; record not known: {none}"
case(7, "The Pump.fun record's links are filtered", "only http(s) links are carried (a bad scheme is dropped, spaces trimmed); an unknown coin gives nothing", c7)


def c9():
    moved = "MovedToWallet111111111111111111111111111111"
    o = result(creator=moved)                                   # the curve's creator now is neither the launcher nor the fee receiver at launch
    f = by_id(F.to_feed(o, META))
    g = by_id(F.to_feed(result(), META))                        # fees still with the launch's fee receiver
    ok = f["dev_wallet"]["value"] == moved and f["dev_wallet"]["link"].endswith(moved) and f["dev_wallet"]["source"] == "Solana chain" \
        and f["fee_wallet"]["value"] == FEE and f["launcher"]["value"] == LAUNCHER and "dev_wallet" not in g
    return ok, f"fees moved: lines {sorted(f)}; the scored wallet's line links {f['dev_wallet']['link'][-12:]}; fees not moved: dev_wallet written = {'dev_wallet' in g}"
case(9, "The fees were moved after launch to a third wallet, the one the engine scores as the dev", "that wallet gets its own line beside the launcher and the launch's fee receiver; when nothing moved, no extra line", c9)

def c10():
    o = result()
    for r in o["receipts"]:
        if r["what"] == "launch counts by wallet":
            r["value"]["fee_wallet_launches"] = "0+"                                                       # nothing read: a lower bound of nothing
            r["value"]["launcher_launches"] = "460+"
    f = by_id(F.to_feed(o, META))
    o2 = result()
    for r in o2["receipts"]:
        if r["what"] == "launch counts by wallet":
            r["value"]["fee_wallet_launches"] = "268+"; r["value"]["fee_wallet_from"] = "Pump.fun lists an unstated number of coins launched by this wallet; 247 read (a minimum)"
    g = by_id(F.to_feed(o2, META))
    o3 = result()
    for r in o3["receipts"]:
        if r["what"] == "launch counts by wallet":
            r["value"]["fee_wallet_launches"] = "0"; r["value"]["fee_wallet_from"] = "Pump.fun lists 0 coins launched by this wallet"
    h = by_id(F.to_feed(o3, META))
    ok = "fee_wallet_launches" not in f and f["dev_launches"]["value"] == 460 and g["fee_wallet_launches"]["value"] == 268 and g["fee_wallet_launches"]["minimum"] is True and h["fee_wallet_launches"]["value"] == 0
    return ok, f"'0+' (nothing read): written = {'fee_wallet_launches' in f}; '268+' with more unstated: written = {g.get('fee_wallet_launches', {}).get('value')} as a minimum; a stated 0: written = {'fee_wallet_launches' in h} with value {h.get('fee_wallet_launches', {}).get('value')}"
case(10, "A count that reads nothing ('0+'), a real minimum ('268+', the list leaving more unstated), and a stated zero", "the first is absent; the minimum stays as 268+ ; a stated zero is written as 0 (Z1)", c10)

def c11():
    base = {"liquidity_depth": 100.0, "contract_authorities": 100.0, "liquidity_permanence": "no_penalty", "reward_flow_pressure": "no_penalty",
            "creator_holdings": "no_penalty", "dev_conduct": "no_penalty", "track_record": "no_penalty", "dev_launches": None, "pair_health": 100.0,
            "top_holders": "no_penalty"}                                                                  # the who-holds read ran (case 14 has it failing)
    hidden = result(readings=dict(base), label="Dev hidden behind a launch bot", notes=["dev hidden: launched by a mass launcher with fees sent to a brand-new wallet, so the person behind the token can't be judged", "this token's CREATE was not paid by the on-chain creator (third-party launch tool?): launch count unknown"])
    unknown = result(readings=dict(base, creator_holdings=0.0, dev_conduct=0.0), notes=["this token's CREATE was not paid by the on-chain creator (third-party launch tool?): launch count unknown"])
    unknown["receipts"] = [r for r in unknown["receipts"] if r["what"] not in ("launch counts by wallet", "dev launches", "creation record (launcher, fee receiver at launch)")]   # no count line at all
    failed = result(readings=dict(base, creator_holdings=0.0, dev_conduct=0.0, track_record="unknown", dev_launches=3, pair_health=None, liquidity_depth="error"))
    whole = result(readings=dict({k: 50.0 for k in F.SECTIONS}, liquidity_permanence="no_penalty"))
    h, u, f, w = (F.to_feed(x, META).get("not_read") for x in (hidden, unknown, failed, whole))
    counted = result(readings=dict(base, creator_holdings=0.0, dev_conduct=0.0), notes=["launch count is a lower bound (7+); serial-launcher cap not applied yet"])   # a count line exists (460+ in the receipts) but the engine could not judge
    k = F.to_feed(counted, META).get("not_read")
    ok = h == {"dev_conduct": "dev not identified", "creator_holdings": "dev not identified", "track_record": "dev not identified"} \
        and u == {"track_record": "launch count not stated"} and k == {"track_record": "launch count not stated"} \
        and f == {"track_record": "could not be read", "pair_health": "could not be read", "liquidity_depth": "could not be read"} and w is None \
        and all(v in F.NOT_READ_REASONS for d in (h, u, f) for v in d.values())
    return ok, f"dev hidden: {h}; launch count unknown, no count line: {u}; a minimum the rule could not use, a count line in the feed: {k}; reads marked unknown, error or missing: {f}; everything read or found nothing to penalise: {w}"
case(11, "The sections the engine did not read: a dev hidden behind a launch bot; a dev known but its launch count not stated; a minimum the serial-launcher rule could not use; reads marked unknown, error or missing; everything read", "each unread section carries one fixed reason by the engine's own verdict: 'dev not identified' on the three dev sections, 'launch count not stated' on the track record whenever the engine could not judge it, a count line or not (P4), 'could not be read' for unknown, error or missing (N1); a rule that ran and found nothing is read, no reason (the app's Clear)", c11)

def c12():
    o = result(creator=FEE)                                    # the path of the coin of dossier check 3: no launcher on record, the fee wallet
    o["receipts"] = [r for r in o["receipts"] if not r["what"].startswith("creation record")]   # is the dev; no list knows it; the engine says None+
    for r in o["receipts"]:
        if r["what"] == "launch counts by wallet":
            r["value"] = {"fee_wallet": FEE, "fee_wallet_launches": "0", "fee_wallet_from": "no launchpad lists this wallet as a creator", "launcher": None, "launcher_launches": None, "launcher_from": None}
        if r["what"] == "dev launches":
            r["value"] = "None+"; r["source"] = "parsed wallet history, 40 transactions; full history: False"
    f = by_id(F.to_feed(o, META))
    zero_lines = [x for x in F.to_feed(o, META)["facts"] if x.get("value") == 0]
    return "dev_launches" not in f and "fee_wallet_launches" not in f and zero_lines == [] and "fee_wallet" in f, f"facts written: {sorted(f)}; lines with a zero: {len(zero_lines)}"
case(12, "The path of dossier check 3's coin: no launcher on record, the fee wallet is the dev, no list knows it, the engine's own count is 'None+'", "no launch count line at all, and no zero anywhere; the fee wallet's own line stays", c12)

def c13():
    return CALLS == [], f"network calls attempted in the whole run: {len(CALLS)}"
case(13, "No look-up, whole run", "not one real network call was attempted", c13)


def c14():
    """The coin's links."""
    URI = "https://gateway.irys.xyz/MadeUpDocument"
    def own(*rs):
        o = result(venue="LaunchLab curve"); o["receipts"] = [r for r in o["receipts"] if not r["what"].startswith("token's own")] + list(rs); return o
    a = F.to_feed(own({"what": "token's own twitter link", "value": "https://x.com/catwifnolimit", "unit": "url", "source": URI, "as_of": T1},
                      {"what": "token's own website link", "value": "https://www.catwifnolimit.com/", "unit": "url", "source": URI, "as_of": T1},
                      {"what": "token's own telegram link", "value": "none", "unit": "url", "source": URI, "as_of": T1}), dict(META, links={}, links_read_at=None))
    b = F.to_feed(own({"what": "token's own links", "value": "not read", "unit": "links", "source": "on-chain metadata document", "as_of": T1}), dict(META, links={}, links_read_at=None))
    c = F.to_feed(own({"what": "token's own links", "value": "none published", "unit": "links", "source": "on-chain metadata", "as_of": T1}), dict(META, links={}, links_read_at=None))
    d = F.to_feed(own(), dict(META, links={"x": "https://x.com/made_up"}, links_read_at=T1))
    e = F.to_feed(own(), dict(META, links={}, links_read_at=None))
    ok = (a.get("links") == {"x": "https://x.com/catwifnolimit", "website": "https://www.catwifnolimit.com/", "source": "Solana chain", "read_at": T1}
          and "links" not in b and (b.get("not_read") or {}).get("links") == "could not be read"
          and c.get("links") == {"source": "Solana chain", "read_at": T1} and "links" not in (c.get("not_read") or {})
          and d.get("links") == {"x": "https://x.com/made_up", "source": "Pump.fun", "read_at": T1}
          and "links" not in e and (e.get("not_read") or {}).get("links") == "could not be read")
    return ok, f"own document read: {a.get('links')}; not read: links {b.get('links')}, not_read {b.get('not_read')}; none published: {c.get('links')}; Pump.fun record: {d.get('links')}; no receipt and no record: not_read {e.get('not_read')}"
case(14, "The coin's links: read from its own metadata document; not read; none published; the Pump.fun record; nothing at all",
     "links from the document carry 'Solana chain'; an unread document gives not_read links 'could not be read' and no links; 'none published' gives an empty links block (listed none); the Pump.fun record stays as before; no receipt and no record is not read, never not listed", c14)


def c15():
    """Top holders as a dossier section."""
    base = {"liquidity_depth": 9.1, "contract_authorities": 100.0, "pair_health": 80.0, "liquidity_permanence": "no_penalty", "reward_flow_pressure": "no_penalty",
            "creator_holdings": 50.0, "dev_conduct": 60.0, "track_record": 70.0, "dev_launches": 3}
    failed = F.not_read_for(result(readings=dict(base, top_holders="unknown")))
    read = F.not_read_for(result(readings=dict(base, top_holders="no_penalty")))
    fired = F.not_read_for(result(readings=dict(base, top_holders=0.0)))                  # a who-holds brake fired: graded, never Clear (H2)
    old = F.not_read_for(result(readings=dict(base)))
    ok = failed.get("top_holders") == "could not be read" and "top_holders" not in read and old.get("top_holders") == "could not be read" and "top_holders" not in fired
    return ok, f"read failed: {failed}; read fine: {read}; a brake fired (graded 0, the app bands it): {fired}; a result from before the key existed: {old}"
case(15, "The top-holders read failed, succeeded, or is from before the key existed", "failed or absent gives not_read top_holders 'could not be read' (DeepScan says Not read); read gives no entry (the app's Clear)", c15)

def c16():
    VAULT = "Vau1tAccount1111111111111111111111111111111"
    o = result()
    o["readings"] = {"liquidity_depth": 9.1, "contract_authorities": 100.0, "top_holders": "no_penalty", "dev_conduct": 20.0,
                     "creator_holdings": "unknown", "track_record": "unknown"}
    o["receipts"] = o["receipts"] + [
        {"what": "top holders read", "value": 20, "unit": "wallets", "source": "Pump.fun top holders", "as_of": T1},
        {"what": "real money in pool (fees excluded)", "value": 8000, "unit": "USD", "source": f"vault {VAULT}", "as_of": T1},
        {"what": "dev conduct (group)", "value": {"members": 2}, "unit": "tokens / seconds", "source": "dev group token accounts", "as_of": T2}]
    cs = F.check_sources_for(o, T2)
    keys = list(cs)
    ok = (keys[0] == "top_holders" and cs["top_holders"]["source"] == "Pump.fun" and cs["top_holders"]["url"].startswith("https://pump.fun/coin/")
          and cs["liquidity_depth"]["url"].endswith(VAULT) and cs["liquidity_depth"]["source"] == "Solana chain"
          and cs["contract_authorities"]["read_at"] == T2 and "creator_holdings" not in cs and "track_record" not in cs
          and all(set(v) == {"source", "read_at", "url"} and v["source"] in F.PUBLIC_SOURCES and v["url"].startswith("https://") for v in cs.values()))
    return ok, f"checks with a receipt: {keys}; unread checks left out (creator holdings, track record); every one a public source, a time and an https link"
case(16, "Per-check receipts, `check_sources` ", "each check the score read carries the receipt it rests on as source, time and https link, top holders first; a check not read is left out, never a made-up source", c16)

def c17():
    T = "2026-10-21T12:00:00Z"
    DEV = "DevWa11et" + "1" * 35                         # a valid-looking address (no 0, O, I or l)
    def fact(value):
        o = result(); o["receipts"] = o["receipts"] + [{"what": "funding source", "value": value, "unit": "trace", "source": "getSignaturesForAddress + getTransaction", "as_of": T}]
        return F.funding_fact(o, T)
    a = fact({"kind": "from_busy", "words": "the dev wallet is fresh; 1 fresh wallet(s) on the trace, back to a busy wallet <script>", "fresh wallets": 1,
              "trace": [{"wallet": DEV, "signature": "7" * 88}]})
    b = fact({"kind": "not_read", "words": "a wallet on the trace could not be read: not read", "fresh wallets": 0, "trace": []})
    c = fact({"kind": "dev_busy", "words": "the dev wallet is busy", "fresh wallets": 0, "trace": [{"wallet": DEV, "signature": None}]})
    ok = (a["source"] == "Solana chain" and a["link"] == "https://solscan.io/tx/" + "7" * 88 and "<" not in a["value"] and len(a["value"]) <= 140
          and b["value"] == "not read" and "link" not in b and c["link"] == "https://solscan.io/account/" + DEV)
    return ok, f"traced: '{a['value'][:50]}...' linked to the first incoming transfer; not read: value '{b['value']}', no link; busy dev: the wallet's page"
case(17, "The funding answer, a `funding_source` fact", "the trace's plain words (no markup, at most 140 characters), Solana chain, the time read, the first incoming transfer's explorer page; 'not read' carries no link; shown, not graded", c17)

def c18():
    o = result()
    o["readings"] = {"top_holders": "no_penalty"}
    o["receipts"] = o["receipts"] + [{"what": "top holders read", "value": 20, "unit": "wallets", "source": "getTokenLargestAccounts", "as_of": T1},
                                     {"what": "funding source", "value": {"kind": "long_standing", "words": "the dev wallet was active more than 7 days before the launch",
                                      "trace": [{"wallet": FEE, "signature": "8" * 88}]}, "unit": "trace", "source": "x", "as_of": T1}]
    rec = F.to_feed(o, {})
    ff = [f for f in rec.get("facts") or [] if f["id"] == "funding_source"]
    ok = (rec.get("check_sources", {}).get("top_holders", {}).get("source") == "Solana chain" and len(ff) == 1
          and "score" in rec and rec["score"] == 47)
    return ok, f"feed record: check_sources {list(rec.get('check_sources') or {})}, funding fact {bool(ff)}, score unchanged {rec['score']}"
case(18, "In the feed record", "`check_sources` at the top level and `funding_source` among the facts; the score and every other field unchanged", c18)

def c19():
    d = tempfile.mkdtemp(); keep_dir = F.FEED_DIR; F.FEED_DIR = d
    try:
        json.dump({"mint": MINT, "seen": True, "name": "Alpha", "ticker": "ALP", "image_url": "https://example.invalid/a.png",
                   "chain": "solana", "launchpad": "Pump.fun curve", "launched_at": "2026-10-25T05:58:06Z"},
                  open(os.path.join(d, MINT + ".json"), "w"))
        failed = {"mint": MINT, "score": None, "display": "Technical error, retrying", "coverage": 0, "label": None}
        before = open(os.path.join(d, MINT + ".json")).read()
        wrote = F.export_one(failed, {})
        a = json.load(open(os.path.join(d, MINT + ".json")))
        same = open(os.path.join(d, MINT + ".json")).read() == before
        newer = dict(result(), mint=MINT)
        F.export_one(newer, {MINT: {"name": "Beta", "ticker": "BET", "image_url": None, "_image_tried": 2, "_links_tried": 2}})
        b = json.load(open(os.path.join(d, MINT + ".json")))
        other = "OtherMint111111111111111111111111111111pump"
        wrote_other = F.export_one(dict(failed, mint=other), {})
        c_exists = os.path.exists(os.path.join(d, other + ".json"))
    finally:
        F.FEED_DIR = keep_dir
    ok = (wrote is None and same and a.get("seen") is True and "display" not in a     # checklist 7: no error text written
          and (a["name"], a["ticker"], a["image_url"]) == ("Alpha", "ALP", "https://example.invalid/a.png")
          and (a.get("chain"), a.get("launchpad"), a.get("launched_at")) == ("solana", "Pump.fun curve", "2026-10-25T05:58:06Z")
          and not CALLS
          and (b["name"], b["ticker"], b["image_url"]) == ("Beta", "BET", "https://example.invalid/a.png") and wrote_other is None and not c_exists)
    return ok, f"a failed score leaves the seen file as it was (unchanged: {same}; {a.get('name')}/{a.get('ticker')}, {a.get('chain')}, {a.get('launchpad')}, no error text); network tries {len(CALLS)}; a later score's own name wins ({b.get('name')}), its missing picture kept; a coin with no file before: file written {c_exists}"
case(19, "the team's W4 and checklist 7: a failed score keeps the coin's file and writes no error text", "a failed score leaves the coin's file as it was and writes none for a coin with no file; a later result with no name keeps the name, ticker, picture, chain, launchpad and launch time its file had, with no look-up; a field the new result carries wins; nothing is made up for a coin with no earlier file", c19)


def c20():
    d = tempfile.mkdtemp(); keep_dir = F.FEED_DIR; F.FEED_DIR = d
    try:
        F.export_one(dict(result(), mint=MINT), {MINT: {"name": "Gamma", "ticker": "GAM", "image_url": None, "_image_tried": 2, "_links_tried": 2}})
        good = open(os.path.join(d, MINT + ".json")).read()
        failed = {"mint": MINT, "score": None, "display": "Technical error, retrying", "coverage": 0, "label": None}
        early_failed = dict(failed, early=True)
        r1, r2 = F.export_one(failed, {}), F.export_one(early_failed, {})
        after = open(os.path.join(d, MINT + ".json")).read()
        label = F.export_one({"mint": "LabelMint1111111111111111111111111111pump", "score": None, "display": "HONEYPOT", "coverage": 0.5, "label": "HONEYPOT"}, {})
    finally:
        F.FEED_DIR = keep_dir
    g = json.loads(good)
    return (r1 is None and r2 is None and after == good and isinstance(g.get("score"), int) and label is not None), \
        f"a coin with a score ({g.get('score')}) through a failed score and a failed early score: file unchanged {after == good}; a proven label (HONEYPOT) is still written: {label is not None}"
case(20, "A failed score never replaces a coin's last score (checklist 7)", "the last score, display and label stay; a failed early score writes nothing either; a proven no-score label is still written", c20)


def c21():
    """a coin's vamp, bot and serial-launcher tags travel with it in every feed file."""
    import seen_feed as SF
    d = tempfile.mkdtemp(); keep_dir = F.FEED_DIR; F.FEED_DIR = d
    try:
        os.makedirs(os.path.join(d, "evidence"))
        held = {"status": "held", "items": [{"kind": "serial_launcher", "words": "w"}, {"kind": "earlier_lookalike", "words": "w"},
                                            {"kind": "fast_launcher", "words": "w"}]}
        json.dump({"contract": "evidence/1", "mint": MINT, "rows": [], "gate": held}, open(os.path.join(d, "evidence", MINT + ".json"), "w"))
        SF.write_seen({"mint": MINT, "seen": True, "name": "Alpha"})
        seen = json.load(open(os.path.join(d, MINT + ".json"))).get("tags")
        F.export_one(dict(result(), mint=MINT), {MINT: {"name": "Alpha", "ticker": "ALP", "image_url": None, "_image_tried": 2, "_links_tried": 2}})
        scored = json.load(open(os.path.join(d, MINT + ".json"))).get("tags")
        changed = F.set_tags(MINT, F.gate_tags({"status": "passed", "items": []}))
        after = json.load(open(os.path.join(d, MINT + ".json")))
        bot = F.gate_tags({"status": "bot", "items": [{"kind": "bot_launch"}]})
        unread = F.gate_tags({"status": "not read yet", "items": [{"kind": "not_read_yet"}]})
        none_made = F.set_tags("NoFileMint11111111111111111111111111111pump", ["vamp"]) is False and not os.path.exists(os.path.join(d, "NoFileMint11111111111111111111111111111pump.json"))
    finally:
        F.FEED_DIR = keep_dir
    return (seen == ["vamp", "serial_launcher"] and scored == ["vamp", "serial_launcher"] and changed and "tags" not in after
            and bot == ["bot"] and unread == [] and none_made), \
        f"seen file {seen}; its score {scored}; the gate passed later: tags {after.get('tags', 'none')}; a bot coin {bot}; an unread one {unread}; no file: none made {none_made}"
case(21, "A coin's tags travel with it", "vamp, bot and serial-launcher tags from the coin's gate section reach its seen file and its score file, in a fixed order, each once; they leave when the gate passes it; an unread coin has none; no file is ever made for them", c21)


def c22():
    """Line 7: a Base or BNB coin's check receipts name its own chain and link its own explorer."""
    out = {}
    for chain, mint, dev in (("bsc", "0x" + "1b" * 20, "0x" + "de" * 20), ("base", "0x" + "2c" * 20, "0x" + "ad" * 20), (None, "0x" + "3d" * 20, "0x" + "be" * 20)):
        o = dict(result(), mint=mint, creator=dev, chain=chain)
        o["readings"] = {"dev_conduct": 20.0, "creator_holdings": 50.0}
        o["receipts"] = o["receipts"] + [{"what": "dev conduct (group)", "value": {"members": 2}, "unit": "x", "source": "dev group", "as_of": T2}]
        out[chain] = F.check_sources_for(o, T2)
    flat = json.dumps(out)
    fund = dict(result(), mint="0x" + "1b" * 20, chain="bsc")
    fund["receipts"] = fund["receipts"] + [{"what": "funding source", "value": {"kind": "not_read"}, "unit": "trace", "source": "x", "as_of": T2}]
    ff = F.funding_fact(fund, T2)
    ok = ff is None and (out["bsc"]["dev_conduct"] == {"source": "BNB chain", "read_at": T2, "url": "https://bscscan.com/address/" + "0x" + "de" * 20}
          and out["base"]["creator_holdings"]["source"] == "Base chain" and out["base"]["creator_holdings"]["url"] == "https://basescan.org/address/" + "0x" + "ad" * 20
          and out[None] == {} and "Solana chain" not in flat and "solscan" not in flat)
    return ok, f"BNB: {out['bsc'].get('dev_conduct')}; Base: {out['base'].get('creator_holdings', {}).get('source')}; a 0x coin with no chain named: {out[None]}; Solana's funding words on a BNB coin: {ff}"
case(22, "A Base or BNB coin's check receipts name its own chain", "dev conduct and creator holdings say BNB chain or Base chain and link bscscan or basescan; a 0x coin with no chain named gets none, never Solana's; Solana's funding words never on a Base or BNB coin", c22)


def c23():
    """SITE's ATH row (audit item 4, 26 Oct): Pump.fun's all-time high in dollars at the peak's own time, its trade, and its
    time; the real numbers of 9MJ6JGc5i1…'s receipt ($2,940 market cap, the trade it was matched to)."""
    TX = "2oaikpv4dz53ZRKvswRrYHGKwftLp8ZXtrXCwNyDNy2TVQ8HMFG6n19oPNDuSPgX63mdMg88kQcQYXh4cVDVTNFK"
    o = result()
    o["receipts"] = o["receipts"] + [{"what": "all-time high (market cap)", "value": {"cap_usd": 2940.0, "at": 1792900000, "tx": TX}, "unit": "USD",
                                      "source": "Pump.fun's own all-time high market cap, matched to the trade at that moment", "as_of": T2}]
    rec = F.to_feed(o, {})
    none = F.to_feed(result(), {})
    bad = dict(result()); bad["receipts"] = bad["receipts"] + [{"what": "all-time high (market cap)", "value": {"cap_usd": 0, "at": 1792900000}, "unit": "USD", "source": "x", "as_of": T2}]
    got = {k: rec.get(k) for k in ("ath_cap_usd", "ath_at", "ath_source", "ath_tx")}
    ok = (got == {"ath_cap_usd": 2940.0, "ath_at": "2026-10-25T03:46:40Z", "ath_source": "Pump.fun", "ath_tx": TX}
          and not any(k.startswith("ath_") for k in none) and not any(k.startswith("ath_") for k in F.to_feed(bad, {})))
    return ok, f"{got}; no reading: no ath fields (the dash stays); a zero cap: none"
case(23, "The All-time high in dollars at the peak's own time (SITE's ATH row)", "Pump.fun's ATH market cap, its time and its matched trade go into the coin's feed file; no reading, or a cap of 0, leaves the fields out", c23)


def c24():
    """The ATH record: PF.peak keeps the dollars at the peak's own time and the trade it matched; a peak no trade matches
    keeps nothing (missing stays missing)."""
    TX = "2oaikpv4dz53ZRKvswRrYHGKwftLp8ZXtrXCwNyDNy2TVQ8HMFG6n19oPNDuSPgX63mdMg88kQcQYXh4cVDVTNFK"
    keep = (PF.coin, PF.trades)
    try:
        PF.coin = lambda m: {"ath_market_cap": 2940.0, "ath_market_cap_timestamp": 1792900000123, "total_supply": 10 ** 15, "base_decimals": 6}
        PF.trades = lambda m, a, b, max_trades=0: ([{"t": 1792900000, "tx": TX, "price_usd": 2.94e-6, "price_sol": 1.6e-8}], True)
        PF.PEAK_INFO.clear(); got = PF.peak("CoinA"); info = dict(PF.PEAK_INFO.get("CoinA") or {})
        PF.trades = lambda m, a, b, max_trades=0: ([{"t": 1792900000, "tx": TX, "price_usd": 9.9e-6, "price_sol": 5e-8}], True)
        miss = PF.peak("CoinB"); none = PF.PEAK_INFO.get("CoinB")
    finally:
        PF.coin, PF.trades = keep
    ok = got[0] and info == {"cap_usd": 2940.0, "at": 1792900000, "tx": TX} and miss[0] is None and none is None
    return ok, f"matched: {info}; a peak no trade matches: {miss[2]!r}, nothing kept"
case(24, "Pump.fun's peak keeps its dollars, time and trade for the ATH row", "the matched peak records cap_usd, at and tx; an unmatched one records nothing", c24)


print(f"\n{sum(results)}/{len(results)} passed")
raise SystemExit(0 if all(results) else 1)
