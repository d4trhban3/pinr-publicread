"""The coin's own links: the metadata document named on chain is read
in both shapes it comes in, Pump.fun's flat keys and the Metaplex one (`extensions`, `properties.links`, `external_url`);
a document that cannot be read is unknown (None), never "none published". The network is blocked.
Run: cd stage2 && python3 test_token_links.py"""
import json, os, sys
HERE = os.path.dirname(os.path.abspath(__file__)); ROOT = os.path.dirname(HERE)
for p in ("stage2", "stage3", "pinr-score", "index", "scanner"):
    sys.path.insert(0, os.path.join(ROOT, p))
import readers as R
import pumpfun_api as PF

results = []


def case(n, title, should, fn):
    try:
        ok, seen = fn()
    except Exception as e:
        ok, seen = False, f"raised {type(e).__name__}: {e}"
    results.append(bool(ok))
    print(f"{'ok  ' if ok else 'FAIL'} {n:>2}. {title}\n      should: {should}\n      seen:   {seen}")


MINT = "9PX6BGM8bWUMfZG2gVWTdoiUa22HW54DWnoULLhEP81z"
URI = "https://gateway.irys.xyz/MadeUpDocument1111111111111111111111111111"
METAPLEX = {"name": "catwifnolimit", "symbol": "$NOLIMIT", "description": "launched on StonkFun.", "image": "https://gateway.irys.xyz/img",
            "external_url": "https://www.catwifnolimit.com/", "extensions": {"website": "https://www.catwifnolimit.com/", "twitter": "https://x.com/catwifnolimit"},
            "properties": {"category": "image", "files": [], "links": {"website": "https://www.catwifnolimit.com/", "twitter": "https://x.com/catwifnolimit"}}}
PUMP = {"name": "made up", "symbol": "MU", "description": "", "image": "https://x/img", "twitter": "https://x.com/made_up", "website": "https://made-up.example", "telegram": "https://t.me/made_up"}


def wire(doc):
    R._LINKS_CACHE.clear()
    R.account_parsed = lambda addr: ({"data": {"parsed": {"info": {"extensions": [{"extension": "tokenMetadata", "state": {"uri": URI}}]}}}}, 1)
    PF.coin = lambda mint: None                                  # no Pump.fun record for this coin
    R.http_json = lambda url, tries=3, timeout=20: doc


def c1():
    wire(METAPLEX); log = R.Log(); got = R.read_token_links(MINT, log)
    ok = got and got["twitter"] == "https://x.com/catwifnolimit" and got["website"] == "https://www.catwifnolimit.com/" and got["telegram"] is None and got["name"] == "catwifnolimit"
    whats = {r["what"]: r["value"] for r in log.items}
    return ok, f"twitter {got and got['twitter']}, website {got and got['website']}, telegram {got and got['telegram']}; receipts: {whats.get(chr(39).join(['token', 's own twitter link']))}"
case(1, "A Metaplex-shaped document (StonkFun, LaunchLab): links under extensions and properties.links", "the X and website links are read; telegram is none; receipts name the document", c1)


def c2():
    wire(PUMP); got = R.read_token_links(MINT, R.Log())
    return got and got["twitter"] == "https://x.com/made_up" and got["website"] == "https://made-up.example" and got["telegram"] == "https://t.me/made_up", f"{got and {k: got[k] for k in ('twitter', 'website', 'telegram')}}"
case(2, "A Pump.fun-shaped document (flat keys)", "all three links read as before", c2)


def c3():
    only_ext = {"name": "n", "symbol": "s", "external_url": "https://only-site.example", "extensions": {}, "properties": {}}
    wire(only_ext); a = R.read_token_links(MINT, R.Log())
    wire({"name": "n", "symbol": "s"}); b = R.read_token_links(MINT, R.Log())
    return a and a["website"] == "https://only-site.example" and a["twitter"] is None and b and not (b["twitter"] or b["website"] or b["telegram"]), f"external_url only: {a and a['website']}; no links at all: {b and {k: b[k] for k in ('twitter', 'website', 'telegram')}} (a dict: listed none)"
case(3, "Only external_url; a document with no links at all", "external_url counts as the website; a document without links gives a dict with none (listed none, not unread)", c3)




def c5():
    """the team's L1: the per-link receipts land in the score's own log, once, also when the document was cached from an earlier read in the scan."""
    wire(METAPLEX); log = R.Log()
    own = R.read_token_links(MINT, log); R.own_links_receipts(own, log)                 # first read in the scan
    again = R.read_token_links(MINT, log); R.own_links_receipts(again, log)             # cached: no second set of receipts
    whats = [r["what"] for r in log.items]
    tw = [r for r in log.items if r["what"] == "token's own twitter link"]
    unread = R.Log(); R.own_links_receipts(None, unread)
    ok = (whats.count("token's own twitter link") == 1 and whats.count("token's own website link") == 1 and whats.count("token's own telegram link") == 1
          and tw[0]["value"] == "https://x.com/catwifnolimit" and tw[0]["source"] == URI and "token links (cached from this scan)" in whats and not unread.items)
    return ok, f"receipts after a read and a cached read: {whats}; the X receipt names the document: {tw and tw[0]['source'] == URI}; an unread document writes no link receipt: {not unread.items}"
case(5, "The per-link receipts in the score's log, read once and read again from the cache", "one receipt per link kind, naming the document, written once; nothing for an unread document; the scorer passes its own log and calls this", c5)


def c6():
    """2026-10-14: Pump.fun's record names the same document but carries no link (a coin launched elsewhere): the document itself is read."""
    wire(METAPLEX)
    PF.coin = lambda mint: {"metadata_uri": URI, "name": "catwifnolimit", "symbol": "$NOLIMIT", "twitter": "", "website": None, "telegram": ""}
    log = R.Log(); a = R.read_token_links(MINT, log)
    from_doc = a and a["twitter"] == "https://x.com/catwifnolimit" and not any("Pump.fun record of" in str(r["source"]) for r in log.items)
    R._LINKS_CACHE.clear()
    PF.coin = lambda mint: {"metadata_uri": URI, "name": "n", "symbol": "s", "twitter": "https://x.com/from_record", "website": "", "telegram": ""}
    log2 = R.Log(); b = R.read_token_links(MINT, log2)
    from_rec = b and b["twitter"] == "https://x.com/from_record" and any("Pump.fun record of" in str(r["source"]) for r in log2.items)
    wire({"foo": 1, "bar": [2]}); c = R.read_token_links(MINT, R.Log())
    return bool(from_doc and from_rec and c is None), f"record without links: the document was read, X {a and a['twitter']} ({from_doc}); record with a link: the record stands in ({from_rec}); a document of unknown shape: {c} (unknown, never none)"
case(6, "Pump.fun's record names the same document: blank link fields (a StonkFun coin), or a link; a document of an unknown shape",
     "blank record fields never mean 'none': the document is read and its links found; a record carrying a link stands in as before; an unknown shape is None", c6)

print(f"\n{sum(results)}/{len(results)} passed")
raise SystemExit(0 if all(results) else 1)
