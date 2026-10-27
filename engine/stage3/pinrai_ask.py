""""Ask PINRai". The operator asks PINRai about one coin on pinr.io/control (Cloudflare Access, his only);
PINRai answers from that coin's evidence with its own instructions, the funded key and the
daily cap, and names the evidence each answer rests on. Answers are private: nothing here writes a public
file. A correction he marks as one is kept as a teaching example (PINRAI-TEACHING.jsonl, beside TEACHING-EXAMPLES.md,
kept apart from every formula: no named coin in any rule) that PINRai reads on every later coin.

His words and every piece of coin text are data handed to the model, never instructions to the engine: nothing in a
question, a teaching example or the evidence chooses a file, a command, a setting or a coin.

Run by control/server.mjs:  python3 stage3/pinrai_ask.py ask   < {"coin", "question", "history"?}   (JSON on stdin)"""
from __future__ import annotations
import json, os, re, sqlite3, sys, time
from typing import Callable, Optional

HERE = os.path.dirname(os.path.abspath(__file__))
ENGINE = os.path.dirname(HERE)
sys.path[:0] = [HERE, os.path.join(ENGINE, "scanner"), os.path.join(ENGINE, "stage2")]
import pinrbot as PB

RESULTS_DIR = os.path.join(ENGINE, "stage2", "results")
SCANNER_DB = os.path.join(ENGINE, "scanner", "scanner.sqlite")
COIN_RE = re.compile(r"^[1-9A-HJ-NP-Za-km-z]{32,44}$")
QUESTION_MAX = 1000
HISTORY_MAX = 10                 # earlier turns of this conversation sent back with the question
TURN_MAX = 2000
ROWS_MAX = 120                   # evidence-table rows handed in
ANSWER_MAX_TOKENS = 3000

ASK_SYSTEM = ""  # redacted in the public copy

ASK_SCHEMA = {}  # redacted in the public copy


# ------------------------------------------------------------------ teaching examples (kept in pinrbot.py, read by both)
teaching, teaching_block = PB.teaching, PB.teaching_block


# ------------------------------------------------------------------ the coin's evidence
def coin_rows(mint: str, db_path=None) -> list:
    """The coin's evidence-table rows, read-only, each with an id e1..: [{id, from, to, what, value, unit, at,
    source, link, on_chain}]. None readable = []."""
    try:
        c = sqlite3.connect(f"file:{db_path or SCANNER_DB}?mode=ro", uri=True, timeout=10)
        rows = c.execute("SELECT from_kind, from_id, to_kind, to_id, what, value, unit, at, source, link, onchain FROM evidence "
                         "WHERE coin=? ORDER BY at DESC LIMIT ?", (mint, ROWS_MAX)).fetchall()
        c.close()
    except Exception:
        return []
    out = []
    for i, (fk, fid, tk, tid, what, value, unit, at, source, link, onchain) in enumerate(rows, 1):
        try:
            v = json.loads(value) if value is not None else None
        except Exception:
            v = value
        out.append({"id": f"e{i}", "from": f"{fk} {fid}", "to": f"{tk} {tid}", "what": what, "value": PB._short(v), "unit": unit,
                    "at": at, "source": source, "link": link, "on_chain": bool(onchain)})
    return out


def bundle(mint: str, results_dir=None, own_read: Optional[Callable] = None, db_path=None, cache_dir=None) -> dict:
    """Everything PINRai may answer from: v1's bundle (the score's receipts and the coin's own record: d1, c1, ...), the
    evidence-table rows (e1, ...) and its own last reading. Each id is unique in the whole message."""
    try:
        res = json.load(open(os.path.join(results_dir or RESULTS_DIR, mint + ".json")))
    except Exception:
        res = {}
    items = [r for r in res.get("receipts") or [] if isinstance(r, dict)]
    if own_read is None:
        import readers as R
        own_read = lambda m: R.read_token_links(m, R.Log())
    try:
        own = own_read(mint) or {}
    except Exception:
        own = {}
    last = PB.cached(mint, cache_dir)
    reading = None
    if last:
        reading = {"status": last.get("status"), "read_at": last.get("read_at"),
                   "items": [{"kind": it.get("kind"), "why": it.get("why"), "evidence": it.get("evidence")} for it in last.get("items") or []]}
    return {"bundle": PB.gather(mint, items, own), "rows": coin_rows(mint, db_path), "last_reading": reading}


def _ids(ev: dict) -> dict:
    out = {}
    for b in ev["bundle"]:
        out[b["id"]] = {"id": b["id"], "what": b.get("what"), "value": b.get("value"), "source": b.get("source"),
                        "as_of": b.get("as_of"), "on_chain": bool(b.get("on_chain"))}
    for r in ev["rows"]:
        out[r["id"]] = {"id": r["id"], "what": r.get("what"), "value": r.get("value"), "source": r.get("source"),
                        "as_of": r.get("at"), "on_chain": r.get("on_chain"), "link": r.get("link")}
    return out


def _history(h) -> list:
    """Earlier turns, newest kept: [{"role": "founder"|"pinrai", "text"}], each cut to TURN_MAX; anything else dropped."""
    out = []
    for t in (h if isinstance(h, list) else [])[-HISTORY_MAX:]:
        if isinstance(t, dict) and t.get("role") in ("founder", "pinrai") and isinstance(t.get("text"), str):
            out.append({"role": t["role"], "text": t["text"][:TURN_MAX]})
    return out


# ------------------------------------------------------------------ the answer
def answer(coin, question, history=None, *, settings_path=None, http: Callable = PB._http, spend_path=None, key=None,
           results_dir=None, own_read=None, db_path=None, cache_dir=None, teaching_path=None) -> dict:
    """{"status": "answered" | words, "answer", "evidence": [{id, what, value, source, as_of, on_chain, link?}],
    "unknown_ids", "cost_usd", "model"}. Never raises; nothing public is written."""
    out = {"status": "not answered", "answer": None, "evidence": [], "unknown_ids": [], "cost_usd": 0.0, "model": None,
           "asked_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())}
    try:
        if not isinstance(coin, str) or not COIN_RE.match(coin):
            out["status"] = "not answered: coin must be a Solana address"; return out
        if not isinstance(question, str) or not question.strip():
            out["status"] = "not answered: a question is needed"; return out
        cfg, why = PB.settings(settings_path)
        if cfg is None:
            out["status"] = "not answered: " + why; return out
        key = key if key is not None else PB.api_key()
        if not key:
            out["status"] = "not answered: ANTHROPIC_API_KEY is not in the engine's .env"; return out
        text, _iv = PB.instructions()
        if text is None:
            out["status"] = "not answered: PINRai's instructions could not be found"; return out
        ev = bundle(coin, results_dir, own_read, db_path, cache_dir)
        known = _ids(ev)
        user = json.dumps({"coin": coin, "evidence_bundle": ev["bundle"], "evidence_rows": ev["rows"],
                           "your_last_reading": ev["last_reading"], "founder_teaching_examples": teaching_block(teaching_path),
                           "earlier_turns": _history(history), "question": question[:QUESTION_MAX]},
                          ensure_ascii=False, default=str)
        out["model"] = cfg["model"]
        ans, status, cost = PB.ask(cfg["model"], ASK_SYSTEM + text, user, ASK_SCHEMA, ANSWER_MAX_TOKENS, cfg["effort"], cfg, key, http, spend_path)
        out["cost_usd"] = round(cost or 0.0, 6)
        if ans is None:
            out["status"] = status.replace("not read", "not answered", 1); return out
        cited = [i for i in ans.get("evidence") or [] if isinstance(i, str)]
        out["answer"] = str(ans.get("answer") or "")
        out["evidence"] = [known[i] for i in dict.fromkeys(cited) if i in known]
        out["unknown_ids"] = [i for i in dict.fromkeys(cited) if i not in known]   # cited but not in the message: shown as such, never trusted
        out["status"] = "answered"
        return out
    except Exception as e:
        out["status"] = f"not answered: {type(e).__name__}"
        return out


if __name__ == "__main__":
    if sys.argv[1:] == ["ask"]:
        try:
            req = json.load(sys.stdin)
        except Exception:
            req = {}
        req = req if isinstance(req, dict) else {}
        print(json.dumps(answer(req.get("coin"), req.get("question"), req.get("history")), ensure_ascii=False, default=str))
    else:
        print(json.dumps({"status": "usage: pinrai_ask.py ask < JSON"}))
