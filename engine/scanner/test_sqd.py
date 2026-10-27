"""SQD Portal blocks and Pump.fun's events decoded through its own IDL. Made-up
answers built from the IDL's field list; no network. Run:  python3 test_sqd.py"""
import base64, io, json, os, struct, sys, urllib.error
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path[:0] = [HERE, os.path.join(HERE, "..", "stage2")]
import sqd as Q
from b58 import b58e

results = []
def case(n, title, should, fn):
    try:
        ok, text = fn()
    except Exception as e:
        import traceback; traceback.print_exc()
        ok, text = False, f"CRASH {type(e).__name__}: {e}"
    results.append(ok)
    print(f"\n{n:>2}. {title}\n    should: {should}\n    did:    {text}\n    {'PASS' if ok else 'FAIL'}")

IDL = Q.Idl()
TAG = {v: k for k, v in IDL.events.items()}
KEY = lambda i: bytes([i]) * 32


def encode(t, v):
    """Borsh, as the IDL names the type: the test's own writer, so the reader is checked against the IDL, not itself."""
    fixed = {"u8": "<B", "u16": "<H", "u32": "<I", "u64": "<Q", "i64": "<q"}
    if isinstance(t, str) and t in fixed:
        return struct.pack(fixed[t], v)
    if t == "bool":
        return bytes([1 if v else 0])
    if t == "pubkey":
        return v
    if t == "string":
        b = v.encode(); return struct.pack("<I", len(b)) + b
    if isinstance(t, dict) and "vec" in t:
        return struct.pack("<I", len(v)) + b"".join(encode(t["vec"], x) for x in v)
    if isinstance(t, dict) and "defined" in t:
        spec = IDL.types[t["defined"]["name"]]
        return b"".join(encode(f["type"], v[f["name"]]) for f in spec["fields"])
    raise ValueError(t)


def sample(name, upto=None):
    vals, out = {}, TAG[name]
    for i, f in enumerate(IDL.types[name]["fields"][:upto]):
        t = f["type"]
        v = (KEY(i + 1) if t == "pubkey" else True if t == "bool" else "ix" + str(i) if t == "string" else
             [] if isinstance(t, dict) and "vec" in t else 100 + i)
        vals[f["name"]] = v
        out += encode(t, v)
    return out, vals


def c1():
    data, vals = sample("TradeEvent")
    name, f = IDL.event(data)
    short, _ = sample("TradeEvent", upto=12)                  # an older version of the event: fewer fields, at the end
    n2, f2 = IDL.event(short)
    unknown = IDL.event(b"\x00" * 8 + data[8:])
    return (name == "TradeEvent" and f["mint"] == b58e(KEY(1)) and f["sol_amount"] == vals["sol_amount"] and f["is_buy"] is True
            and f["user"] == b58e(KEY(5)) and len(f) == len(IDL.types["TradeEvent"]["fields"])
            and n2 == "TradeEvent" and len(f2) == 12 and "creator" not in f2 and unknown is None), \
        f"{name}: {len(f)} fields read in the IDL's order (mint, amounts, side, wallet); an older 12-field version: {len(f2)} fields, the rest absent; an unknown tag: {unknown}"
case(1, "Pump.fun's events read through its own IDL", "a trade event's fields come out in the IDL's order and types; an older version that ends early keeps only the fields it has (none filled in); a tag the IDL does not list is not read", c1)


def block(n, logs, txs):
    return {"header": {"number": n, "timestamp": 1_792_900_000 + n}, "transactions": txs, "logs": logs}


def c2():
    trade, _ = sample("TradeEvent"); create, _ = sample("CreateEvent")
    logs = [{"transactionIndex": 3, "programId": Q.PUMP, "kind": "data", "message": base64.b64encode(trade).decode()},
            {"transactionIndex": 4, "programId": Q.PUMP, "kind": "data", "message": base64.b64encode(create).decode()},
            {"transactionIndex": 3, "programId": Q.PUMP, "kind": "log", "message": "Instruction: Buy"},
            {"transactionIndex": 5, "programId": "SomeOtherProgram111111111111111111111111111", "kind": "data", "message": base64.b64encode(trade).decode()},
            {"transactionIndex": 6, "programId": Q.PUMP, "kind": "data", "message": "not base64 at all"}]
    txs = [{"transactionIndex": 3, "signatures": ["SigThree"], "feePayer": "PayerThree"}, {"transactionIndex": 4, "signatures": ["SigFour"]}]
    counts = {}
    ev = Q.events(block(7, logs, txs), IDL, counts)
    return ([e["kind"] for e in ev] == ["trade", "create"] and ev[0]["sig"] == "SigThree" and ev[0]["fee_payer"] == "PayerThree"
            and ev[0]["block"] == 7 and ev[1]["fields"]["name"] == "ix0" and counts.get("trade") == 1 and counts.get("create") == 1), \
        f"{[(e['kind'], e['sig']) for e in ev]}; counts {counts}; another program's data and plain log lines not read"
case(2, "A block's Pump.fun events with their transaction", "only Pump.fun's own data lines are decoded; each event carries its block, time, signature and fee payer; anything else is left out", c2)


class Ans:
    def __init__(self, t): self.t = t
    def read(self): return self.t.encode()


def c3():
    sent = []
    parts = {100: [block(100, [], []), block(101, [], [])], 102: [block(105, [], [])]}
    def urlopen(req, timeout=60):
        body = json.loads(req.data.decode()); sent.append((body["fromBlock"], body["toBlock"], body["instructions"][0].get("a2")))
        if len(sent) == 1:
            raise urllib.error.HTTPError(req.full_url, 429, "busy", {}, io.BytesIO(b""))
        return Ans("\n".join(json.dumps(b) for b in parts.get(body["fromBlock"], [])))
    Q.PACE_S = 0
    got = [b["header"]["number"] for b in Q.blocks(100, 105, ["Mint1"], urlopen) if "header" in b]
    def never(req, timeout=60):
        raise urllib.error.HTTPError(req.full_url, 503, "busy", {}, io.BytesIO(b""))
    gave_up = list(Q.blocks(1, 2, None, never))
    return (got == [100, 101, 105] and sent[1][0] == 100 and sent[2][0] == 102 and sent[1][2] == ["Mint1"] and gave_up == [{"unanswered_from": 1}]), \
        f"blocks {got}; requests from {[s[0] for s in sent]} (the busy one asked again, the next after the last block sent; the coins filter as account 2); always busy: {gave_up}"
case(3, "The Portal's answers, a part at a time", "a busy answer is asked again a few times; the next request starts after the last block sent; when a part is never answered the read stops and says from where (never a guessed gap)", c3)


print(f"\n{sum(results)}/{len(results)} passed")
raise SystemExit(0 if all(results) else 1)
