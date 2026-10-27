"""SQD Portal (portal.sqd.dev, free and keyless, about a second behind the chain) as a reader of
Pump.fun's trades and launches. One request returns a block range's Pump.fun instructions with their transactions and
logs; the trade, create and complete events in those logs are decoded with Pump.fun's own published program definition
(its IDL, `stage2/idl/pump.json`, copied unchanged from github.com/pump-fun/pump-public-docs `idl/pump.json` on
2026-10-25): the decoder follows the IDL's field list, nothing about the layout is written here by hand.

  python3 scanner/sqd.py head                      the Portal's newest block
  python3 scanner/sqd.py events <from> <to>        Pump.fun's decoded events in that block range, as JSON lines

Read-only. Paced (one request at a time per process, PACE_S apart); "busy" (429/503) is waited out a few times, then the
read is given up (None), never guessed. An event whose data is not in the IDL's shape is left out, and counted."""
from __future__ import annotations
import base64, json, os, struct, sys, time, urllib.error, urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
ENGINE = os.path.dirname(HERE)
sys.path[:0] = [p for p in (HERE, os.path.join(ENGINE, "stage2")) if p not in sys.path]
from b58 import b58e

PORTAL = "https://portal.sqd.dev/datasets/solana-mainnet"
PUMP = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P"
PUMP_AMM = "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA"     # PumpSwap: a graduated coin's trades
IDL_PATH = os.path.join(ENGINE, "stage2", "idl", "pump.json")
AMM_IDL_PATH = os.path.join(ENGINE, "stage2", "idl", "pump_amm.json")   # idl/pump_amm.json, the same repo and day
UA = {"User-Agent": "PINR-live/1.0 (read-only; pinr.io)", "content-type": "application/json"}
PACE_S = 0.6                  # the Portal's public limit is about 20 requests per 10 s (its docs, vendor page): kept under
BUSY_TRIES = 5
KINDS = {"TradeEvent": "trade", "CreateEvent": "create", "CompleteEvent": "complete"}
AMM_KINDS = {"BuyEvent": "trade", "SellEvent": "trade", "CreatePoolEvent": "pool"}
AMM_POOL, AMM_MINT = 0, 3     # PumpSwap's buy, buy_exact_quote_in and sell list the pool first and the coin (base mint) fourth (its IDL)
_last = [0.0]


class _Short(Exception):
    """The event's data ended before this field: an older version of the event (newer ones add fields at the end)."""


class Idl:
    """Pump.fun's events, read from its IDL: each event's 8-byte tag and its fields in order (Borsh, as Anchor writes them)."""
    def __init__(self, path: str | None = None):
        d = json.load(open(path or IDL_PATH))
        self.types = {t["name"]: t["type"] for t in d.get("types", [])}
        self.events = {bytes(e["discriminator"]): e["name"] for e in d.get("events", []) if e.get("discriminator")}

    def _read(self, t, b: bytes, p: int):
        fixed = {"u8": "<B", "i8": "<b", "u16": "<H", "i16": "<h", "u32": "<I", "i32": "<i", "u64": "<Q", "i64": "<q"}
        if isinstance(t, str):
            if t in fixed:
                n = struct.calcsize(fixed[t])
                if p + n > len(b):
                    raise _Short
                return struct.unpack_from(fixed[t], b, p)[0], p + n
            if t in ("u128", "i128"):
                if p + 16 > len(b):
                    raise _Short
                return int.from_bytes(b[p:p + 16], "little", signed=(t == "i128")), p + 16
            if t == "bool":
                if p + 1 > len(b):
                    raise _Short
                return b[p] != 0, p + 1
            if t == "pubkey":
                if p + 32 > len(b):
                    raise _Short
                return b58e(b[p:p + 32]), p + 32
            if t in ("string", "bytes"):
                n, p = self._read("u32", b, p)
                if p + n > len(b):
                    raise _Short
                raw = b[p:p + n]
                return (raw.decode("utf-8", "replace") if t == "string" else raw.hex()), p + n
            raise ValueError("unknown type " + t)
        if "vec" in t:
            n, p = self._read("u32", b, p)
            out = []
            for _ in range(n):
                v, p = self._read(t["vec"], b, p)
                out.append(v)
            return out, p
        if "option" in t:
            flag, p = self._read("u8", b, p)
            return (None, p) if flag == 0 else self._read(t["option"], b, p)
        if "array" in t:
            inner, n = t["array"]
            out = []
            for _ in range(n):
                v, p = self._read(inner, b, p)
                out.append(v)
            return out, p
        if "defined" in t:
            name = t["defined"]["name"] if isinstance(t["defined"], dict) else t["defined"]
            return self._struct(self.types[name], b, p)
        raise ValueError("unknown type " + json.dumps(t))

    def _struct(self, spec, b: bytes, p: int):
        if spec.get("kind") == "enum":                           # a variant's number, then its fields if it has any
            i, p = self._read("u8", b, p)
            vs = spec.get("variants") or []
            if i >= len(vs):
                raise ValueError("unknown variant")
            v = vs[i]
            if v.get("fields"):
                inner, p = self._struct({"kind": "struct", "fields": v["fields"]}, b, p) if isinstance(v["fields"][0], dict) and "name" in v["fields"][0] else (None, p)
                return {v["name"]: inner}, p
            return v["name"], p
        if spec.get("kind") != "struct":
            raise ValueError("not a struct")
        out = {}
        for f in spec.get("fields", []):
            out[f["name"]], p = self._read(f["type"], b, p)
        return out, p

    def event(self, data: bytes):
        """(event name, fields) for one event's bytes, or None when its tag is not one of the IDL's events. Fields the
        data ends before (an older version of the event) are absent, never filled in; a field cut through the middle is
        also absent."""
        name = self.events.get(bytes(data[:8]))
        if name is None:
            return None
        out, p = {}, 8
        for f in self.types[name].get("fields", []):
            try:
                out[f["name"]], p = self._read(f["type"], data, p)
            except _Short:
                break
        return name, out


def _post(url: str, body: dict | None, urlopen=None, sleep=time.sleep):
    """One paced request; the answer's text, or None after BUSY_TRIES busy answers or any other refusal."""
    urlopen = urlopen or urllib.request.urlopen
    for i in range(BUSY_TRIES):
        wait = PACE_S - (time.time() - _last[0])
        if wait > 0:
            sleep(wait)
        _last[0] = time.time()
        try:
            req = urllib.request.Request(url, data=None if body is None else json.dumps(body).encode(), headers=UA)
            return urlopen(req, timeout=60).read().decode()
        except urllib.error.HTTPError as e:
            if e.code in (429, 503, 529):                     # 529: the Portal's "overloaded, try again later" (seen 26 Oct)
                sleep(min(5.0, 0.25 * 2 ** i))                     # "busy, retry in 250 ms": a little longer each time
                continue
            return None
        except Exception:
            return None
    return None


def head(urlopen=None) -> int | None:
    t = _post(PORTAL + "/head", None, urlopen)
    try:
        return int(json.loads(t)["number"])
    except Exception:
        return None


def query(frm: int, to: int, mints: list | None = None, amm: bool = True) -> dict:
    """Pump.fun's (and, with `amm`, PumpSwap's) instructions in the block range, with their transactions and logs, and
    PumpSwap's instruction accounts (its events name the pool; the instruction names the coin). `mints` keeps only Pump.fun
    instructions naming one of them as account 2 (older buys and sells only: newer instructions put the coin elsewhere)."""
    ins = {"programId": [PUMP], "isCommitted": True, "transaction": True, "logs": True}
    if mints:
        ins["a2"] = list(mints)
    q = {"type": "solana", "fromBlock": int(frm), "toBlock": int(to),
         "fields": {"block": {"number": True, "timestamp": True},
                    "transaction": {"transactionIndex": True, "signatures": True, "feePayer": True},
                    "instruction": {"transactionIndex": True, "instructionAddress": True, "programId": True, "accounts": True},
                    "log": {"transactionIndex": True, "instructionAddress": True, "programId": True, "kind": True, "message": True}},
         "instructions": [ins]}
    if amm:
        q["instructions"].append({"programId": [PUMP_AMM], "isCommitted": True, "transaction": True, "logs": True})
    return q


def blocks(frm: int, to: int, mints: list | None = None, urlopen=None, max_requests: int = 2000):
    """Every block of the range the Portal answers for, in order (it answers a part at a time; the next request starts after
    the last block it sent). Stops, and says so in the last item, when a request is not answered."""
    nxt, n = int(frm), 0
    while nxt <= to and n < max_requests:
        t = _post(PORTAL + "/stream", query(nxt, to, mints), urlopen)
        n += 1
        if t is None:
            yield {"unanswered_from": nxt}
            return
        last = None
        for line in t.splitlines():
            if line.strip():
                b = json.loads(line)
                last = b.get("header", {}).get("number")
                yield b
        if last is None:
            return                                                   # nothing more in the range
        nxt = int(last) + 1


def events(block: dict, idl: Idl, counts: dict | None = None, amm_idl: "Idl | None" = None, pools: dict | None = None) -> list:
    """Pump.fun's trade, create and complete events in one block (and PumpSwap's buys, sells and new pools with `amm_idl`),
    each with its block, time and transaction. A PumpSwap trade carries `fields["mint"]`: the coin its own instruction
    names, else the pool's coin from `pools` (a pool seen earlier), else none (missing, never guessed)."""
    hdr = block.get("header") or {}
    sig = {t.get("transactionIndex"): (t.get("signatures") or [None])[0] for t in block.get("transactions") or []}
    payer = {t.get("transactionIndex"): t.get("feePayer") for t in block.get("transactions") or []}
    out = []
    pools = pools if pools is not None else {}
    amm_mint = {}
    for ins in block.get("instructions") or []:
        acc = ins.get("accounts") or []
        if ins.get("programId") == PUMP_AMM and len(acc) > AMM_MINT:
            pools[acc[AMM_POOL]] = acc[AMM_MINT]
            amm_mint[(ins.get("transactionIndex"), tuple(ins.get("instructionAddress") or []))] = acc[AMM_MINT]
    for lg in block.get("logs") or []:
        if amm_idl is not None and lg.get("programId") == PUMP_AMM and lg.get("kind") == "data":
            try:
                got = amm_idl.event(base64.b64decode(lg.get("message") or ""))
            except Exception:
                got = None
            if not got or got[0] not in AMM_KINDS:
                continue
            name, f = got
            ti = lg.get("transactionIndex")
            if name == "CreatePoolEvent":
                if f.get("pool") and f.get("base_mint"):
                    pools[f["pool"]] = f["base_mint"]
                continue
            f = dict(f, is_buy=(name == "BuyEvent"),
                     mint=amm_mint.get((ti, tuple(lg.get("instructionAddress") or []))) or pools.get(f.get("pool")))
            out.append({"kind": "trade", "venue": "PumpSwap", "block": hdr.get("number"), "time": hdr.get("timestamp"),
                        "sig": sig.get(ti), "fee_payer": payer.get(ti), "tx_index": ti, "ix": lg.get("instructionAddress"), "fields": f})
            if counts is not None:
                counts["pumpswap_trade"] = counts.get("pumpswap_trade", 0) + 1
            continue
        if lg.get("programId") != PUMP or lg.get("kind") != "data":
            continue
        try:
            got = idl.event(base64.b64decode(lg.get("message") or ""))
        except Exception:
            got = None
            if counts is not None:
                counts["undecoded"] = counts.get("undecoded", 0) + 1
        if not got or got[0] not in KINDS:
            continue
        name, f = got
        ti = lg.get("transactionIndex")
        out.append({"kind": KINDS[name], "venue": "Pump.fun curve", "block": hdr.get("number"), "time": hdr.get("timestamp"), "sig": sig.get(ti),
                    "fee_payer": payer.get(ti), "tx_index": ti, "ix": lg.get("instructionAddress"), "fields": f})
        if counts is not None:
            counts[KINDS[name]] = counts.get(KINDS[name], 0) + 1
    return out


if __name__ == "__main__":
    if sys.argv[1:2] == ["head"]:
        print(head())
    elif sys.argv[1:2] == ["events"] and len(sys.argv) == 4:
        idl, amm, counts, pools = Idl(), Idl(AMM_IDL_PATH), {}, {}
        for b in blocks(int(sys.argv[2]), int(sys.argv[3])):
            if "unanswered_from" in b:
                print(json.dumps(b)); break
            for e in events(b, idl, counts, amm, pools):
                print(json.dumps(e, default=str))
        print(json.dumps({"counts": counts}), file=sys.stderr)
    else:
        print(__doc__.split("\n\n")[0])
