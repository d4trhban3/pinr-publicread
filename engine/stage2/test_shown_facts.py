"""the design's shown figures (stage2/shown_facts.py, the Jupiter gateway in readers.quote_usd, the exporter's pass):
offline, on the real answers read once per endpoint on the operator's yes (2026-10-18) and on Stonk.fun's documented row
fields where that coin had none. No network call: every read goes through a made-up `get`."""
import json, os, sys
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
sys.path.insert(0, os.path.join(HERE, "..", "feed"))
import shown_facts as S

SAMPLES = json.load(open(os.path.join(HERE, "..", "tools", "profiles", "2026-10-18-shown-facts-samples.json")))
MINT = SAMPLES["_mint"]
NOW = lambda: "2026-10-18T16:00:00+00:00"
passed = failed = 0


def check(name, cond):
    global passed, failed
    if cond:
        passed += 1
        print("PASS", name)
    else:
        failed += 1
        print("FAIL", name)


def real(**override):
    """A `get` answering from the saved samples by URL (status and body as read), with overrides by URL piece; it
    records what was asked."""
    asked = []
    by_piece = [("tokens/v2/search", "jupiter-tokens-v2-search"), ("/orders/v1/", "dexscreener-orders"),
                ("/rewards/fee-recipients", "stonkfun-fee-recipients"), ("/rewards/payouts", "stonkfun-rewards-payouts"),
                ("/rewards/holders", "stonkfun-rewards-holders"), ("/rewards", "stonkfun-rewards"), ("/socials", "stonkfun-socials"),
                ("launches?creator=", "stonkfun-launches-creator"), ("launchlab/platforms", "stonkfun-launchlab-platforms"),
                ("/api/public/v1/tokens/", "stonkfun-token")]

    def get(url, headers=None):
        asked.append((url, dict(headers or {})))
        for piece, ans in override.items():
            if piece in url:
                return ans
        for piece, key in by_piece:
            if piece in url:
                s = SAMPLES[key]
                body = s["answer"] if s["status"] == 200 else None
                return s["status"], body
        raise AssertionError("asked for an address the test does not know: " + url)
    get.asked = asked
    return get


def ids(facts):
    return {f["id"]: f for f in facts}


# 1. Jupiter on the real answer: every figure with its receipt
g = real()
jf = ids(S.jupiter_facts(MINT, g, NOW))
rec = next(r for r in SAMPLES["jupiter-tokens-v2-search"]["answer"] if r["id"] == MINT)
check("1 Jupiter on the real answer: every figure from the exact mint's record, with its receipt",
      jf["holder_count"]["value"] == rec["holderCount"]
      and jf["dev_mints"]["value"] == rec["audit"]["devMints"] and jf["organic_score"]["band"] == "low"
      and jf["mint_authority_jupiter"]["value"] == "disabled" and jf["buys_24h"]["value"] == 2 and jf["sells_24h"]["value"] == 3
      and jf["top_holders_share"]["value"] == round(rec["audit"]["topHoldersPercentage"], 2)
      and all(f["source"] == "Jupiter" and f["link"] == f"https://jup.ag/tokens/{MINT}" and f["read_at"] for f in jf.values()))
check("1b Jupiter: a field the answer leaves out is not written (no isVerified in the answer: no `jupiter_verified`)",
      "isVerified" not in rec and "jupiter_verified" not in jf)
check("1c Jupiter: read on the new gateway api.jup.ag", g.asked[0][0].startswith("https://api.jup.ag/tokens/v2/search?query="))

# 2. Jupiter's search also matches names and symbols (its docs): only the record whose id IS the mint is read; no exact
# match, a refusal, or not a list give nothing
other = [dict(r, id="SomeOtherMint1111111111111111111111111111", holderCount=999) for r in SAMPLES["jupiter-tokens-v2-search"]["answer"]]
both = ids(S.jupiter_facts(MINT, real(**{"tokens/v2": (200, other + SAMPLES["jupiter-tokens-v2-search"]["answer"])}), NOW))
check("2a Jupiter: another coin listed first by the search is skipped, the exact mint's record read", both["holder_count"]["value"] == rec["holderCount"])
check("2 Jupiter: no record with the exact mint, a 429 or a body that is not a list: no facts",
      S.jupiter_facts(MINT, real(**{"tokens/v2": (200, other)}), NOW) == []
      and S.jupiter_facts(MINT, real(**{"tokens/v2": (429, None)}), NOW) == []
      and S.jupiter_facts(MINT, real(**{"tokens/v2": (200, {"error": "x"})}), NOW) == [])

# 3. the key: sent as x-api-key when the .env has it, no header when it does not, never in a fact
import solana_rpc
saved = solana_rpc._ENV.get("JUPITER_API")
os.environ.pop("JUPITER_API", None)
solana_rpc._ENV.pop("JUPITER_API", None)
g0 = real(); S.jupiter_facts(MINT, g0, NOW)
solana_rpc._ENV["JUPITER_API"] = "made-up-test-key"
g1 = real(); f1 = S.jupiter_facts(MINT, g1, NOW)
check("3 Jupiter: keyless without a key; `x-api-key` with one; the key never in a fact",
      g0.asked[0][1] == {} and g1.asked[0][1] == {"x-api-key": "made-up-test-key"} and "made-up-test-key" not in json.dumps(f1))
if saved is None:
    solana_rpc._ENV.pop("JUPITER_API", None)
else:
    solana_rpc._ENV["JUPITER_API"] = saved

# 4. Stonk.fun on the real answers: fee from the record, the creator's launches, the ledger; 404 and {} write nothing
sf, links = S.stonkfun_facts(MINT, real(), NOW)
sf = ids(sf)
check("4 Stonk.fun real answers: transfer fee 100 bps, 1 launch by the creator, ledger 0 paid / 0 payouts / 0 wallets, no last payout",
      sf["launchpad_transfer_fee"]["value"] == 100 and sf["stonkfun_launches"]["value"] == 1
      and sf["rewards_paid"]["value"] == 0 and sf["rewards_paid"]["unit"] == "SOL" and sf["rewards_payouts"]["value"] == 0
      and sf["rewards_wallets_paid"]["value"] == 0 and "rewards_last_payout" not in sf
      and all(f["source"] == "Stonk.fun" and f["link"].startswith("https://") for f in sf.values()))
check("4b Stonk.fun: 'no fee recipients' (404) writes no recipient fact; socials {} gives no launchpad links",
      "fee_recipients" not in sf and "fee_share_creator" not in sf and links is None)

# 5. Stonk.fun's documented fee-recipient rows: the creator's share summed only when every row was read
rows = {"mint": MINT, "quote": {}, "shareBps": 100, "recipientCount": 3,
        "rewards": {"distributedRaw": "5", "distributedTokens": 0.5, "payoutCount": 2, "lastPayoutAt": "2026-10-18T10:00:00Z"}, "base": None,
        "rows": [{"wallet": "A" * 32, "isCreator": True, "slot": 1, "shareBps": 60, "asset": {}, "quote": {}, "base": {}},
                 {"wallet": "B" * 32, "isCreator": True, "slot": 2, "shareBps": 10, "asset": {}, "quote": {}, "base": {}},
                 {"wallet": "C" * 32, "isCreator": False, "slot": 3, "shareBps": 30, "asset": {}, "quote": {}, "base": {}}],
        "page": {"limit": 100, "order": "asc", "nextCursor": None}}
a = ids(S.stonkfun_facts(MINT, real(**{"/fee-recipients": (200, rows)}), NOW)[0])
more = dict(rows, page={"limit": 100, "order": "asc", "nextCursor": "next"})
b = ids(S.stonkfun_facts(MINT, real(**{"/fee-recipients": (200, more)}), NOW)[0])
former = dict(rows, rows=rows["rows"][:1] + [dict(rows["rows"][1], shareBps=None)])
c = ids(S.stonkfun_facts(MINT, real(**{"/fee-recipients": (200, former)}), NOW)[0])
check("5 Stonk.fun fee recipients: 3 wallets, creator share 70 bps; another page unread or a creator share not given: no share",
      a["fee_recipients"]["value"] == 3 and a["fee_share_creator"]["value"] == 70
      and b["fee_recipients"]["value"] == 3 and "fee_share_creator" not in b and "fee_share_creator" not in c)

# 6. the ledger only on basis "ledger"; a last payout written when Stonk.fun gives one
paid = dict(SAMPLES["stonkfun-rewards"]["answer"], rewards={"distributedRaw": "2500000000", "distributedTokens": 2.5,
                                                           "payoutCount": 4, "walletsPaid": 31, "lastPayoutAt": "2026-10-18T12:00:00.000Z"})
waiting = dict(SAMPLES["stonkfun-rewards"]["answer"], basis="awaiting-snapshot", rewards=None)
p = ids(S.stonkfun_facts(MINT, real(**{"/v2/tokens/%s/rewards" % MINT: (200, paid)}), NOW)[0])
w = ids(S.stonkfun_facts(MINT, real(**{"/v2/tokens/%s/rewards" % MINT: (200, waiting)}), NOW)[0])
check("6 Stonk.fun ledger: 2.5 SOL to 31 wallets in 4 payouts, last at its time; 'awaiting-snapshot' writes no ledger fact",
      p["rewards_paid"]["value"] == 2.5 and p["rewards_wallets_paid"]["value"] == 31 and p["rewards_payouts"]["value"] == 4
      and p["rewards_last_payout"]["value"] == "2026-10-18T12:00:00.000Z"
      and not {"rewards_paid", "rewards_payouts", "rewards_wallets_paid"} & set(w))

# 7. socials: http/https only, under their own names
soc = {"website": "https://example.org", "twitter": "https://x.com/someone", "telegram": "javascript:alert(1)"}
_, lk = S.stonkfun_facts(MINT, real(**{"/socials": (200, soc)}), NOW)
check("7 Stonk.fun socials: website and X kept as launchpad links with source and time; a non-web link dropped",
      lk == {"website": "https://example.org", "x": "https://x.com/someone", "source": "Stonk.fun", "read_at": NOW()})

# 8. Stonk.fun's platform list equals the engine's list (a cross-check; the chain check of each id stays)
import readers
mine = {k: v[1].split()[0] for k, v in readers.LAUNCHLAB_PLATFORMS.items() if v[0] == "stonk"}
theirs = S.stonkfun_platforms(real())
check("8 Stonk.fun's launchlab/platforms (read 2026-10-18) names the same three accounts and modes as the engine's list",
      theirs is not None and {v: k for k, v in theirs.items()} == mine
      and S.stonkfun_platforms(real(**{"launchlab/platforms": (200, {"data": {"platform": {"x": "short"}}})})) is None)

# 9. DexScreener: the real answer is 0 orders, 0 boosts; an order without its type writes no order count
d = ids(S.dexscreener_facts(MINT, real(), NOW))
odd = ids(S.dexscreener_facts(MINT, real(**{"/orders/v1/": (200, {"orders": [{"status": "approved"}], "boosts": [{}]})}), NOW))
two = ids(S.dexscreener_facts(MINT, real(**{"/orders/v1/": (200, {"orders": [{"type": "tokenProfile", "status": "approved"},
                                                                             {"type": "tokenAd", "status": "approved"}], "boosts": []})}), NOW))
check("9 DexScreener: real answer 0 paid orders and 0 boosts (read and none); an untyped order: no order count, boosts kept; two kinds named",
      d["dex_paid_orders"]["value"] == 0 and d["dex_boosts"]["value"] == 0 and "kinds" not in d["dex_paid_orders"]
      and d["dex_boosts"]["link"] == f"https://dexscreener.com/solana/{MINT}"
      and "dex_paid_orders" not in odd and odd["dex_boosts"]["value"] == 1
      and two["dex_paid_orders"]["value"] == 2 and two["dex_paid_orders"]["kinds"] == ["tokenAd", "tokenProfile"]
      and S.dexscreener_facts(MINT, real(**{"/orders/v1/": (200, [])}), NOW) == [])

# 10. read_all: Stonk.fun only for Stonk.fun coins; a reader that raises costs only its own facts
g = real()
r = S.read_all(MINT, False, g, NOW)
check("10 read_all: a coin that is not Stonk.fun's asks Jupiter and DexScreener only",
      not any("stonkfun" in u for u, _ in g.asked) and {f["source"] for f in r["facts"]} == {"Jupiter", "DexScreener"})
def boom(url, headers=None):
    if "jup.ag" in url:
        raise RuntimeError("no network")
    return real()(url, headers)
r2 = S.read_all(MINT, True, boom, NOW)
check("10b read_all: Jupiter failing leaves DexScreener's and Stonk.fun's facts", {f["source"] for f in r2["facts"]} == {"DexScreener", "Stonk.fun"})

# 11. the switch
import tempfile
t = tempfile.NamedTemporaryFile("w", suffix=".json", delete=False); json.dump({"shown_reads": "off"}, t); t.close()
u = tempfile.NamedTemporaryFile("w", suffix=".json", delete=False); json.dump({}, u); u.close()
check("11 `shown_reads` \"off\" stops the reads; no setting means on", S.switched_on(t.name) is False and S.switched_on(u.name) is True)

# 12. quote_usd on the new gateway, once a minute a mint, the key as a header
calls = []
def fake_http(url, tries=3, timeout=20, headers=None):
    calls.append((url, headers))
    return {"So11111111111111111111111111111111111111112": {"usdPrice": 150.0}}
orig = readers.http_json
readers.http_json = fake_http
readers._QUOTE_CACHE.clear()
log = readers.Log()
p1 = readers.quote_usd("So11111111111111111111111111111111111111112", log)
p2 = readers.quote_usd("So11111111111111111111111111111111111111112", log)
readers.http_json = orig
check("12 quote_usd: api.jup.ag price v3, one read for two asks inside a minute, both with their receipt",
      p1 == p2 == 150.0 and len(calls) == 1 and calls[0][0].startswith("https://api.jup.ag/price/v3?ids=")
      and sum(1 for it in log.items if "quote asset price" in str(it)) == 2)

# 13. the counter names the new gateway Jupiter
check("13 the request counter counts api.jup.ag under jupiter", solana_rpc.label("https://api.jup.ag/tokens/v2/search?query=x") == "jupiter")

# 14. the exporter: only known ids with their whole receipt; Stonk.fun and Jupiter are public sources; launchpad links beside
import feed_export as F
o = {"shown": {"facts": list(jf.values()) + list(sf.values()) + [
        {"id": "made_up", "label": "x", "value": 1, "unit": "u", "source": "Jupiter", "read_at": NOW(), "link": "https://jup.ag"},
        {"id": "holder_count", "label": "Holders", "value": 9, "unit": "wallets", "source": "Jupiter", "read_at": NOW(), "link": "https://jup.ag"},
        {"id": "dex_boosts", "label": "b", "value": 1, "unit": "boosts", "source": "Helius", "read_at": NOW(), "link": "https://x.y"},
        {"id": "dev_mints", "label": "d", "value": None, "unit": "tokens created", "source": "Jupiter", "read_at": NOW(), "link": "https://jup.ag"}],
     "launchpad_links": {"website": "https://example.org", "telegram": "ftp://x", "source": "Stonk.fun", "read_at": NOW(), "evil": 1}}}
out = F.shown_facts_for(o)
oi = ids(out)
check("14 exporter: known ids only, first of a repeat kept, unknown source and empty figure dropped, extras only as listed",
      "made_up" not in oi and oi["holder_count"]["value"] == rec["holderCount"] and "dex_boosts" not in oi
      and oi["dev_mints"]["value"] == rec["audit"]["devMints"] and oi["organic_score"]["band"] == "low"
      and all(set(f) <= {"id", "label", "value", "unit", "source", "read_at", "link", "band", "kinds"} for f in out)
      and {"Stonk.fun", "Jupiter"} <= F.PUBLIC_SOURCES)
check("14b exporter: launchpad links http/https only with source and time; none when absent",
      F.shown_links_for(o) == {"website": "https://example.org", "source": "Stonk.fun", "read_at": NOW()}
      and F.shown_links_for({}) is None)

print(f"{passed}/{passed + failed} passing")
sys.exit(1 if failed else 0)
