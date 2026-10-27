"""Funding source, creator wallet part 3: plain-English tests on a made-up chain (no network).
Run:  python3 test_funding_source.py"""
import os, sys
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path[:0] = [HERE, os.path.join(HERE, "..", "stage2")]
import solana_rpc as S
import funding_source as F
import pumpfun_api as P
F.RETRY_S = 0

DAY = 86400
LAUNCH = 1_800_000_000
results = []
def case(n, title, should, fn):
    try:
        ok, text = fn()
    except Exception as e:
        ok, text = False, f"CRASH {type(e).__name__}: {e}"
    results.append(ok)
    print(f"\n{n:>2}. {title}\n    should: {should}\n    did:    {text}\n    {'PASS' if ok else 'FAIL'}")

def chain(wallets):
    """wallets: {name: (first_activity, funder, busy) | "unreadable" | "txs_unreadable"}; returns the call log."""
    calls, store = [], {}
    def sigs(w, limit=None, until=None, max_pages=None):
        calls.append(("sigs", w))
        v = wallets.get(w)
        if v is None or v == "unreadable":
            return None, False
        if v == "no_history":
            return [], True
        if isinstance(v, list):                            # a list of answers, one a call: e.g. ["unreadable", (...)]
            v = v.pop(0) if len(v) > 1 else v[0]
            if v == "unreadable":
                return None, False
            wallets["_now_" + w] = v
        if v == "txs_unreadable" or not v[2]:
            t0 = (v[0] if v != "txs_unreadable" else LAUNCH - DAY)
            return [{"signature": f"{w}-late", "blockTime": t0 + 3600}, {"signature": f"{w}-first", "blockTime": t0}], True
        return [{"signature": f"{w}-{i}", "blockTime": LAUNCH} for i in range(2000)], False
    def txs(sigs_):
        calls.append(("txs", tuple(sigs_)))
        w = sigs_[0].rsplit("-", 1)[0]
        v = wallets.get("_now_" + w, wallets[w])
        if v == "txs_unreadable":
            return None
        first, funder, _ = v
        out = []
        for s in sigs_:
            t = first if s.endswith("-first") else first + 3600
            nt = [{"fromUserAccount": w, "toUserAccount": "SomeoneElse", "amount": 5}]
            if s.endswith("-first") and funder:
                nt = [{"fromUserAccount": funder, "toUserAccount": w, "amount": 2_000_000_000}]
            out.append({"signature": s, "timestamp": t, "nativeTransfers": nt})
        return out
    S.sigs_desc, S.fetch_txs = sigs, txs
    P._kv = lambda k, v=None: store.get(k) if v is None else store.__setitem__(k, v)
    return calls, store

def c1():
    chain({"Dev": (LAUNCH - 30 * DAY, "Old", False)})
    r = F.trace("Dev", LAUNCH)
    return r["kind"] == "long_standing" and r["funders"] == [] and r["fresh_wallets"] == 0, f"{r['kind']}: {r['words']}; funders {r['funders']}"
case(1, "A dev wallet active a month before the launch", "long-standing; no funder handed to the brake (its funder was never checked)", c1)

def c2():
    chain({"Dev": (LAUNCH - DAY, "A", False), "A": (LAUNCH - 2 * DAY, "B", False), "B": (LAUNCH - 90 * DAY, "C", False)})
    r = F.trace("Dev", LAUNCH)
    return (r["kind"] == "from_established" and r["fresh_wallets"] == 2 and r["funders"] == ["A", "B"]
            and r["chain"][0]["sol"] == 2.0), f"{r['kind']}: {r['words']}; funders {r['funders']}"
case(2, "A fresh dev funded by a fresh wallet, funded by an old one", "two fresh wallets back to an established one; funders A and B for the brake; the SOL amount kept", c2)

def c3():
    chain({"Dev": (LAUNCH - DAY, "Hot", False), "Hot": (0, None, True)})
    r = F.trace("Dev", LAUNCH)
    return r["kind"] == "from_busy" and r["funders"] == [] and "exchange" not in r["words"], f"{r['kind']}: {r['words']}; funders {r['funders']}"
case(3, "A fresh dev funded by a busy wallet (how an exchange looks)", "ends at the busy wallet, never named an exchange, and a busy wallet is never handed to the brake", c3)

def c4():
    chain({"Dev": (0, None, True)})
    r = F.trace("Dev", LAUNCH)
    return r["kind"] == "dev_busy" and r["funders"] == [], f"{r['kind']}: {r['words']}"
case(4, "A dev wallet with more history than the read reaches", "dev busy, said so; nothing guessed", c4)

def c5():
    out = []
    for w, why in [({"Dev": "unreadable"}, "dev unreadable"), ({"Dev": (LAUNCH - DAY, "A", False), "A": "unreadable"}, "funder unreadable"),
                   ({"Dev": "txs_unreadable"}, "transactions unreadable")]:
        chain(w)
        r = F.trace("Dev", LAUNCH)
        out.append((why, r["kind"] == "not_read" and r["funders"] == []))
    return all(o for _, o in out), "; ".join(f"{w}: {'not read' if o else 'WRONG'}" for w, o in out)
case(5, "A wallet on the trace cannot be read", "not read, never a clean source, and nothing for the brake", c5)

def c6():
    chain({"Dev": (LAUNCH - DAY, None, False)})
    r = F.trace("Dev", LAUNCH)
    return r["kind"] == "funder_not_found" and r["fresh_wallets"] == 1, f"{r['kind']}: {r['words']}"
case(6, "No incoming SOL in a fresh dev's oldest transactions", "funder not found, said so", c6)

def c7():
    chain({"Dev": (LAUNCH - DAY, "A", False), "A": (LAUNCH - DAY, "B", False), "B": (LAUNCH - DAY, "C", False),
           "C": (LAUNCH - DAY, "D", False), "D": (LAUNCH - 90 * DAY, None, False)})
    r = F.trace("Dev", LAUNCH)
    return r["kind"] == "fresh_chain" and r["fresh_wallets"] == F.FUNDING_HOPS + 1 and "D" not in r["funders"], f"{r['kind']}: {r['words']}; funders {r['funders']}"
case(7, "Every wallet followed back is fresh", "stops at the hop limit, said so; nothing read past it", c7)

def c8():
    chain({"Dev": (LAUNCH - DAY, "A", False)})
    r = F.trace("Dev", None)
    return r["kind"] == "no_launch_time" and r["funders"] == [], f"{r['kind']}: {r['words']}"
case(8, "No launch time", "freshness cannot be judged: not read, said so; nothing for the brake", c8)

def c9():
    calls, store = chain({"Dev": (LAUNCH - DAY, "A", False), "A": (LAUNCH - 90 * DAY, None, False), "Hot": (0, None, True)})
    F.trace("Dev", LAUNCH); n1 = len(calls)
    F.trace("Dev", LAUNCH); n2 = len(calls) - n1
    F.wallet_start("Hot"); F.wallet_start("Hot")
    busy_kept = any("Hot" in k for k in store)
    return n1 == 4 and n2 == 0 and not busy_kept, f"first trace {n1} calls, the same trace again {n2}; a busy wallet kept: {busy_kept}"
case(9, "A wallet whose start was read is kept for good", "the same trace again costs nothing; a busy wallet is asked again next time", c9)



def c12():
    out = []
    for when in ("read", "written"):
        chain({"Dev": (LAUNCH - DAY, "A", False), "A": (LAUNCH - 90 * DAY, None, False)})
        def broken(k, v=None, when=when):
            if (v is None) == (when == "read"):
                raise OSError("unable to open database file")
            return None
        P._kv = broken
        r = F.trace("Dev", LAUNCH)
        out.append((when, r["kind"] == "not_read" and r["funders"] == []))
    return all(ok for _, ok in out), "; ".join(f"store cannot be {w}: {'not read, no crash' if ok else 'WRONG'}" for w, ok in out)
case(12, "The funding store cannot be opened", "the wallet is not read, the trace ends 'not read', nothing for the brake, and nothing is raised to fail the score", c12)

def c13():
    calls, _ = chain({"Dev": "no_history"})
    r = F.trace("Dev", LAUNCH)
    calls2, _ = chain({"Dev": (LAUNCH - DAY, "A", False), "A": "no_history"})
    r2 = F.trace("Dev", LAUNCH)
    return (r["kind"] == "no_history" and r["funders"] == [] and r["chain"][0]["wallet"] == "Dev" and "not read" not in r["words"]
            and calls.count(("sigs", "Dev")) == 1 and r2["kind"] == "not_read"), \
        f"a dev with no transactions: {r['kind']}: {r['words']}; asked {calls.count(('sigs', 'Dev'))} time; a funder read so: {r2['kind']}"
case(13, "A dev wallet with no transactions of its own (checklist 6: 14 creators named only in a launch read 'not read')", "said in plain words with the wallet kept for its link, nothing for the brake, never 'not read'; a funder read with no transactions is a wrong answer: not read", c13)


def c14():
    calls, _ = chain({"Dev": ["unreadable", (LAUNCH - 30 * DAY, "Old", False)]})
    r = F.trace("Dev", LAUNCH)
    calls2, _ = chain({"Dev": "unreadable"})
    r2 = F.trace("Dev", LAUNCH)
    return (r["kind"] == "long_standing" and calls.count(("sigs", "Dev")) == 2 and r2["kind"] == "not_read"
            and calls2.count(("sigs", "Dev")) == 2), \
        f"failed once then answered: {r['kind']} after {calls.count(('sigs', 'Dev'))} asks; failing twice: {r2['kind']} after {calls2.count(('sigs', 'Dev'))} asks"
case(14, "A failed wallet read is asked once more (checklist 6: 25 of 39 'not read' creators read at once when asked again)", "a passing refusal then an answer gives the answer; two failures in a row stay 'not read' (two asks, never more)", c14)


print(f"\n{sum(results)}/{len(results)} passed")
raise SystemExit(0 if all(results) else 1)
