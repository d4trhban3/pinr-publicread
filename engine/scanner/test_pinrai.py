"""a design decision, PINRai (scanner/pinrai.py, stage3/pinrbot.py's settings, scanner/evidence.py's section). Made-up coins;
the API is never called (PINRbot v1's own suite covers the reading itself)."""
import json, os, sys, tempfile
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path[:0] = [HERE, os.path.join(HERE, "..", "stage2"), os.path.join(HERE, "..", "stage3")]
import pinrbot as PB
import pinrai as AI
import evidence as EV

PB.write_budget = lambda *a, **k: {}          # the public meter is PINRbot's own suite's; nothing written here
results = []
def case(n, title, should, fn):
    try:
        ok, text = fn()
    except Exception as e:
        import traceback; traceback.print_exc()
        ok, text = False, f"CRASH {type(e).__name__}: {e}"
    results.append(ok)
    print(f"\n{n:>2}. {title}\n    should: {should}\n    did:    {text}\n    {'PASS' if ok else 'FAIL'}")


d = tempfile.mkdtemp()
SET, CTL = os.path.join(d, "settings.json"), os.path.join(d, "control.json")
BASE = {"pinrbot_model": "m1", "pinrbot_review_model": "m2", "pinrbot_prices_per_mtok": {"m1": [1, 2], "m2": [3, 4]}}
def files(setting, ctl):
    json.dump({**BASE, **setting}, open(SET, "w"))
    json.dump(ctl, open(CTL, "w")) if ctl is not None else (os.path.exists(CTL) and os.remove(CTL))


def c1():
    out = {}
    files({"pinrbot": "on", "pinrbot_daily_dollar_cap": 5}, None); out["setting on"] = PB.settings(SET, CTL)[0]["cap"]
    files({"pinrbot": "on", "pinrbot_daily_dollar_cap": 5}, {"pinrai": {"on": False}}); out["control off"] = PB.settings(SET, CTL)[1]
    files({"pinrbot": "off", "pinrbot_daily_dollar_cap": 5}, {"pinrai": {"on": True}}); out["control on"] = PB.settings(SET, CTL)[0]["cap"]
    files({"pinrbot": "on", "pinrbot_daily_dollar_cap": 5}, {"pinrai": {"daily_dollar_cap": 2.5}}); out["control cap"] = PB.settings(SET, CTL)[0]["cap"]
    files({"pinrbot": "on", "pinrbot_daily_dollar_cap": 5}, {"pinrai": {"daily_dollar_cap": 500}}); out["cap too big"] = PB.settings(SET, CTL)[0]["cap"]
    files({"pinrbot": "off", "pinrbot_daily_dollar_cap": 5}, None); out["setting off"] = PB.settings(SET, CTL)[1]
    files({"pinrbot": "off"}, {"pinrai": {"on": True}}); out["no cap anywhere"] = PB.settings(SET, CTL)[0]
    return (out["setting on"] == 5 and out["control off"] == "PINRai off (pinr.io/control)" and out["control on"] == 5 and out["control cap"] == 2.5
            and out["cap too big"] == 5 and out["setting off"] == "PINRbot off (setting)" and out["no cap anywhere"] is None), str(out)
case(1, "pinr.io/control's switch and cap", "control off always stops PINRai; control on starts it under the cap; a control cap above 0 and at most $25 replaces the setting's; nothing runs with no cap anywhere", c1)


def c2():
    rd = tempfile.mkdtemp()
    for m in ("A", "B", "C", "D"):
        if m != "C":
            json.dump({"mint": m, "receipts": []}, open(os.path.join(rd, m + ".json"), "w"))
    got = AI.candidates(["A", "B", "C", "D", "E"], passed=lambda m: m != "B", has_reading=lambda m: m == "D", results_dir=rd)
    return got == ["A"], f"page A–E: picked {got} (B held at the gate, C not scored, D already read, E no result)"
case(2, "Only gate-passed coins with a score and no reading yet", "the first page's coins in its order, that passed the gate (237), have a result file and no current reading", c2)


def c3():
    rd = tempfile.mkdtemp()
    for m in ("A", "B", "C", "D"):
        json.dump({"mint": m, "receipts": []}, open(os.path.join(rd, m + ".json"), "w"))
    files({"pinrbot": "off", "pinrbot_daily_dollar_cap": 5}, None)
    PB.SETTINGS, PB.CONTROL = SET, CTL
    calls, written = [], []
    off = AI.one_pass(lambda: ["A"], written.append, passed=lambda m: True, has_reading=lambda m: False,
                      read_fn=lambda m: calls.append(m) or {"status": "read"}, results_dir=rd)
    files({"pinrbot": "on", "pinrbot_daily_dollar_cap": 5}, None)
    answers = {"A": {"status": "read"}, "B": {"status": "not read: today's PINRbot dollar cap would be passed"}, "C": {"status": "read"}}
    on = AI.one_pass(lambda: ["A", "B", "C", "D"], written.append, passed=lambda m: True, has_reading=lambda m: False,
                     read_fn=lambda m: calls.append(m) or answers[m], results_dir=rd, per_pass=3)
    return (off == {"off": True} and calls == ["A", "B"] and on == {"asked": 3, "read": 1, "not_read": 1} and written == ["A", "B"]), \
        f"off: {off}, nothing asked; on: {on}; asked {calls}; files written {written} (the cap stopped the pass at B; D over the pass's share)"
case(3, "The pass: nothing while off; at most a few coins; stops at the cap", "PINRai off sends nothing; on, at most the pass's share of coins; each coin's evidence file written after its reading; the day's cap stops the pass", c3)


def c4():
    rd = tempfile.mkdtemp()
    json.dump({"mint": "A", "receipts": [{"what": "creator", "value": "W"}, "junk"], "notes": ["transfer fee 3%: ... custom rewards set up properly, +4"]},
              open(os.path.join(rd, "A.json"), "w"))
    seen = {}
    def read(m, items, own, fee_bonus_fired):
        seen.update(m=m, items=items, own=own, bonus=fee_bonus_fired); return {"status": "read"}
    AI.read_one("A", results_dir=rd, read=read, own_read=lambda m: {"description": "own words"})
    return (seen == {"m": "A", "items": [{"what": "creator", "value": "W"}], "own": {"description": "own words"}, "bonus": True}), str(seen)
case(4, "A reading from the coin's result file", "the score's receipts, the coin's own links read again, and the design's bonus from the notes (its fee item then stands aside, 216(1)) go to PINRbot's own reading", c4)


def c5():
    cd = tempfile.mkdtemp()
    sig = "5" * 88
    json.dump({"status": "read", "read_at": "2026-10-24T18:00:00Z", "model": "m1", "cost_usd": 0.0123, "evidence": ["x"],
               "items": [{"kind": "gradual_selling", "why": "w" * 400, "reviewed": True, "evidence": ["c1"],
                          "receipts": [{"id": "c1", "what": "dev group's sells", "value": 12.5, "source": "getTransaction " + sig, "as_of": "t", "on_chain": True}]},
                         {"kind": "an_unlisted_kind", "why": "x", "receipts": []}],
               "dropped": [{"kind": "x", "reason": "r"}], "pending": []}, open(os.path.join(cd, "A.json"), "w"))
    json.dump({"status": "not read: today's PINRbot dollar cap would be passed"}, open(os.path.join(cd, "B.json"), "w"))
    sec, capped = EV.pinrai_section("A", cd), EV.pinrai_section("B", cd)
    text = json.dumps(sec)
    it = sec["items"][0]
    return (sec["status"] == "read" and len(sec["items"]) == 1 and it["words"] == "the developer sold gradually" and "why" not in it
            and it["receipts"][0] == {"source": "Solana chain", "value": 12.5, "link": "https://solscan.io/tx/" + sig, "as_of": "t", "onchain": True}
            and "cost" not in text and capped["status"] == "not read yet" and "cap" not in json.dumps(capped) and EV.pinrai_section("Nope", cd) is None), \
        f"{sec['status']}: {it['kind']} as \"{it['words']}\"; receipt {it['receipts'][0]}; an unlisted kind not shown; no why, no cost; a capped reading shown as {capped['status']!r}"
case(5, "The reading in the coin's evidence file", "each listed kind in fixed words with its receipts (source from the fixed list, a number/address/signature value, an explorer link); an unlisted kind not shown; never the model's sentences, the cost or a status's own words", c5)


def c6():
    cd = tempfile.mkdtemp()
    json.dump({"status": "read", "model": "m1", "items": [{"kind": "misleading_claim", "why": "SAFE TO BUY: the dev promises 100x, bundled buys, funded snipers",
               "receipts": [{"id": "r1", "what": "bundled buys, funded snipers within the window", "value": "the dev's own words: SAFE TO BUY", "source": "Helius parsed history (rule 7b)", "on_chain": False},
                            {"id": "p1", "what": "post by @coin (promise)", "value": "a quote", "source": "https://x.com/i/status/1234567890", "on_chain": False}]}]},
              open(os.path.join(cd, "P.json"), "w"))
    text = json.dumps(EV.pinrai_section("P", cd))
    leaks = [w for w in ("SAFE TO BUY", "bundled buys", "funded snipers", "Helius", "rule 7b", "100x") if w in text]
    sec = json.loads(text)
    r1, r2 = sec["items"][0]["receipts"]
    return (not leaks and r1 == {"source": None, "value": None, "link": None, "as_of": None, "onchain": False}
            and r2["source"] == "X" and r2["link"] == "https://x.com/i/status/1234567890"), f"words leaked: {leaks or 'none'}; an engine receipt shown as {r1}; the X post as {r2['source']} {r2['link']}"
case(6, "the team's F1 and F2 on b09decef: nothing engine-worded or developer-worded reaches the file", "the model's why, a receipt's own what/source/value words and the developer's claims never appear; a receipt with nothing public keeps only its shape; an X post keeps its link", c6)


def c7():
    cd = tempfile.mkdtemp()
    addr = "SAFEToBUYnowGreatDev1111111111111111111111"
    json.dump({"status": "read", "model": "m1", "items": [{"kind": "misleading_claim", "receipts": [
        {"id": "d1", "what": "the coin's own description (its launchpad record)", "value": addr, "source": "the coin's own record", "on_chain": False},
        {"id": "x1", "what": "the coin's own X link (its launchpad record)", "value": "https://x.com/scammer/status/999", "source": "the coin's own record", "on_chain": False},
        {"id": "m3", "what": "token's own website link", "value": addr, "source": "metadata document", "on_chain": False},
        {"id": "p2", "what": "post by @x", "value": "https://x.com/scammer/status/888", "source": "not a post address", "on_chain": False},
        {"id": "c4", "what": "creator", "value": addr, "source": "getAccountInfo " + addr, "on_chain": False}]}]}, open(os.path.join(cd, "F.json"), "w"))
    text = json.dumps(EV.pinrai_section("F", cd))
    r = json.loads(text)["items"][0]["receipts"]
    leaks = [w for w in ("SAFEToBUY", "scammer") if w in text]
    return (not leaks and [x["source"] for x in r[:3]] == ["launchpad record"] * 3 and all(x["value"] is None and x["link"] is None for x in r)
            and r[3]["source"] == "X" and r[4]["source"] is None), f"leaked: {leaks or 'none'}; own-record receipts {[x['source'] for x in r[:3]]} with no value or link; a post whose source is not a post address: no link; a chain receipt not read on chain: {r[4]}"
case(7, "the team's F3 on 410872c8: nothing from the developer's own record becomes a value or a link", "the coin's own record and creator-chosen words show 'launchpad record' with no value or link; an X link only from the post PINR read; an address value only when read on chain", c7)


def c8():
    pd, cd = tempfile.mkdtemp(), tempfile.mkdtemp()
    sig = "5" + "K" * 87
    json.dump({"events": [{"kind": "add_liquidity", "sig": sig, "t": 1761400000000, "base": 1000, "quote": 2.5, "user": "Us3r" + "1" * 40}]},
              open(os.path.join(pd, "G.json"), "w"))
    items = PB._pool_items("G", pd)
    json.dump({"status": "read", "model": "m1", "items": [{"kind": "words_contradict_actions", "receipts": items}]}, open(os.path.join(cd, "G.json"), "w"))
    r = EV.pinrai_section("G", cd)["items"][0]["receipts"]
    want = {"source": "Solana chain", "value": None, "link": EV.tx(sig), "as_of": items[0]["as_of"], "onchain": True}
    return (items and items[0]["id"].startswith("q") and r == [want]), f"a cited pool event shows as {r}"
case(8, "the team's F1 on 135b625c: a pool event PINRai cites keeps its public receipt", "the real pool item, read back through the public receipt, shows 'Solana chain', its transaction link and its time, on chain, and none of its own words", c8)


def c_pool():
    cd = tempfile.mkdtemp(); sig = "7" * 88
    rc = [{"id": "q1", "what": "pool: liquidity removed", "value": "by " + "W" * 44, "source": "tx " + sig, "as_of": "t", "on_chain": True}]
    json.dump({"status": "read", "read_at": "2026-10-25T21:00:00Z", "model": "m1",
               "items": [{"kind": k, "why": "x", "receipts": rc} for k in ("pool_liquidity_removed_by_creator", "pool_liquidity_added_by_creator", "pool_buyback_burn")]},
              open(os.path.join(cd, "P.json"), "w"))
    json.dump({"status": "not read: today's PINRbot dollar cap would be passed", "read_at": "2026-10-25T21:01:00Z"}, open(os.path.join(cd, "C.json"), "w"))
    sec, capped = EV.pinrai_section("P", cd), EV.pinrai_section("C", cd)
    words = [i["words"] for i in sec["items"]]
    return (words == ["liquidity was removed from the pool by the creator's wallets", "liquidity was added to the pool by the creator's wallets",
                      "tokens were bought back and burned from the pool"] and sec["read_at"] == "2026-10-25T21:00:00Z"
            and capped["status"] == "not read yet" and capped["read_at"] is None), \
        f"pool kinds shown as {words}; a read reading keeps its time; a capped try: {capped['status']!r}, read_at {capped['read_at']}"
case(9, "PINRai's pool kinds in fixed words; no read time for a reading that did not happen", "the three pool kinds in the team's words with their receipts; a 'not read' try shows 'not read yet' with no read time", c_pool)


def c_words13():
    cd = tempfile.mkdtemp()
    json.dump({"status": "read", "read_at": "2026-10-26T02:00:00Z", "model": "m1",
               "items": [{"kind": "coordinated_manipulation", "why": "x", "receipts": []}]}, open(os.path.join(cd, "W.json"), "w"))
    w = EV.pinrai_section("W", cd)["items"][0]["words"]
    return w == "wallets were observed acting together" and "manipulation" not in w, f"coordinated_manipulation shown as \"{w}\""
case(10, "The operator's wording for wallets acting together (checklist 13)", "PINRai's coordinated_manipulation kind is shown in the operator's words, never 'manipulation'", c_words13)


print(f"\n{sum(results)}/{len(results)} passed")
raise SystemExit(0 if all(results) else 1)
