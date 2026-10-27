"""Grok as PINR's social-media scanner.

Sends PINR's existing fact-check prompt to xAI's
Responses API with live X search and web search switched on, saves the prompt and the answer in the relay folder, and
leaves the judging to grok_relay.validate, exactly as for a pasted answer. Grok never scores anything: it reports
facts with links; a fact without a link it opened is thrown away by the validator.

Cost control: every call is logged (tokens, searches) in grok_bot_log.jsonl and a daily call limit is enforced
(GROK_DAILY_CALLS in .env, default 40). The key is read from .env and never printed.

  python3 grok_bot.py <mint> [chain]      scan one token and print what the validator accepted
"""
from __future__ import annotations
import json, os, sys, time, urllib.error, urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "stage2"))
import solana_rpc as S
import grok_relay as G

API = "https://api.x.ai/v1/responses"
MODEL = S._ENV.get("GROK_MODEL", "grok-4.7")
DAILY_CALLS = int(S._ENV.get("GROK_DAILY_CALLS", "40"))
LOG = os.path.join(HERE, "grok_bot_log.jsonl")

JOB = ""  # redacted in the public copy


def _today() -> str:
    return time.strftime("%Y-%m-%d", time.gmtime())


def calls_today() -> int:
    if not os.path.exists(LOG):
        return 0
    return sum(1 for line in open(LOG) if f'"day": "{_today()}"' in line)


def ask(prompt: str, timeout: int = 300):
    """One Grok call with live X and web search. Returns (text, usage dict) or (None, reason)."""
    key = S._ENV.get("XAI_API_KEY")
    if not key:
        return None, "XAI_API_KEY missing from .env"
    if calls_today() >= DAILY_CALLS:
        return None, f"daily limit of {DAILY_CALLS} Grok calls reached"
    body = {"model": MODEL, "instructions": JOB, "input": [{"role": "user", "content": prompt}],
            "tools": [{"type": "x_search"}, {"type": "web_search"}]}
    req = urllib.request.Request(API, json.dumps(body).encode(),
                                 {"content-type": "application/json", "authorization": "Bearer " + key, "User-Agent": "PINR"})
    t0 = time.time()
    try:
        r = json.load(urllib.request.urlopen(req, timeout=timeout))
    except urllib.error.HTTPError as e:
        return None, f"xAI HTTP {e.code}: {e.read()[:300].decode(errors='ignore')}"
    except Exception as e:
        return None, f"xAI {type(e).__name__}"
    text = r.get("output_text") or ""
    if not text:
        for item in r.get("output") or []:
            if item.get("type") == "message":
                for c in item.get("content") or []:
                    if c.get("type") in ("output_text", "text") and c.get("text"):
                        text += c["text"]
    usage = r.get("usage") or {}
    entry = {"day": _today(), "t": int(time.time()), "model": MODEL, "seconds": round(time.time() - t0),
             "usage": usage, "tool_usage": r.get("server_side_tool_usage") or r.get("tool_usage"),
             "citations": len(r.get("citations") or [])}
    with open(LOG, "a") as f:
        f.write(json.dumps(entry) + "\n")
    return (text or None), entry


def _creator(mint: str) -> str | None:
    """The coin's creator wallet from the gate's own record (read-only), so the X check can ask whether the linked page
    shows it (rules 0006 [265], link and proof); None when not recorded."""
    import sqlite3
    try:
        c = sqlite3.connect("file:" + os.path.join(os.path.dirname(HERE), "scanner", "scanner.sqlite") + "?mode=ro", uri=True, timeout=5)
        r = c.execute("SELECT dev FROM gate WHERE mint=?", (mint,)).fetchone()
        c.close()
        return r[0] if r and r[0] else None
    except Exception:
        return None


def scan(mint: str, links: dict | None, chain: str = "Solana", token_page: str | None = None):
    """Scan one token's social links. Writes relay/bot-<mint>/ PROMPT + ANSWER files (picked up by the scorers like
    any pasted answer) and returns (answer dict or None, info). Never overwrites an existing answer."""
    if not links or not any(links.get(k) for k in ("twitter", "website", "telegram", "farcaster")):
        return None, "no social links to scan (nothing to ask)"
    folder = os.path.join(G.RELAY, f"bot-{''.join(ch for ch in mint if ch.isalnum())}")
    existing = G.answer_path(folder)
    if existing and os.path.getsize(existing) > 0:
        return G.extract_json(open(existing).read()), "already scanned (stored answer)"
    if links is not None and not links.get("creator"):
        links = dict(links, creator=_creator(mint))
    prompt = G.build_prompt(mint, links, chain, token_page)
    text, info = ask(prompt)
    if text is None:
        return None, info
    _p, a = G.write_pair(folder, f"Grok bot {mint[:8]}", prompt)
    open(a, "w").write(text)
    try:
        return G.extract_json(text), info
    except Exception:
        return None, dict(info, problem="answer was not valid JSON (kept on file, ignored by scoring)")


if __name__ == "__main__":
    mint = sys.argv[1]
    chain = sys.argv[2] if len(sys.argv) > 2 else "Solana"
    from readers import read_token_links, Log
    links = read_token_links(mint, Log())
    print("token's own links:", {k: links.get(k) for k in ("twitter", "website", "telegram")} if links else None)
    ans, info = scan(mint, links, chain)
    print("call:", info)
    if ans is not None:
        out = G.validate(ans, mint, links, None)
        print("validator accepted:")
        for k, r in out["readings"].items():
            print(f"  {k:28} {G._reading_text(r)}")
        print("  has_real_home:", out.get("has_real_home"))
