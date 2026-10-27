"""Grok relay: the social scan, run by hand through the Grok app until an xAI API key exists.

  python3 grok_relay.py prompt <mint>   -> writes relay/<mint>/"... - PROMPT.txt" (paste it into Grok)
  python3 grok_relay.py check  <mint>   -> reads relay/<mint>/"... - ANSWER.txt" (paste Grok's reply there),
                                           validates it and writes relay/<mint>/result.json
  python3 grok_relay.py batch  <name> <mint> <mint> ...   -> one prompt for up to 5 tokens: relay/batch-<name>/"... - PROMPT.txt"
  python3 grok_relay.py checkbatch <name>                 -> validates relay/batch-<name>/"... - ANSWER.txt" token by token

Split of work for the two-way proof:
- PINR reads the token's OWN links from its on-chain metadata (the dev's choice).
- Grok reads the X / Telegram / website side: does it show the contract address or link back?
Every Grok finding must carry a source link and an as-of time, or say not_found. Anything else is rejected
and treated as unknown (never as a zero). Grok's words are leads; only validated facts reach the engine.
"""
from __future__ import annotations
import datetime, json, os, re, sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "stage2"))
sys.path.insert(0, os.path.join(HERE, "..", "pinr-score"))
import score_engine_v1 as E

SCHEMA_VERSION = "pinr-grok-social-v1"

# Every leaf below is a FACT: {"value": ..., "source": "<https link>", "as_of": "<ISO time>"}
# or {"not_found": true, "reason": "..."}.
FACT_FIELDS = {}  # redacted in the public copy
NEW_X = set()  # redacted in the public copy
OPTIONAL_GROUPS = {"farcaster": "farcaster"}      # group -> links key; asked and validated only when that link exists
LIST_FIELDS = ["kol_promotions", "red_flags", "intent_evidence"]
INTENT_KINDS = []  # redacted in the public copy


def _fact_template():
    return {"value": "...", "source": "https://...", "as_of": "2026-10-04T00:00:00Z"}


FARCASTER_BLOCK = ""  # redacted in the public copy


def build_prompt(mint: str, links: dict | None, chain: str = "Solana", token_page: str | None = None) -> str:
    """Redacted in the public copy."""
    raise NotImplementedError("redacted: proprietary PINR logic is not included in the public copy")


def build_batch_prompt(items: list, chain: str = "Solana") -> str:
    """Redacted in the public copy."""
    raise NotImplementedError("redacted: proprietary PINR logic is not included in the public copy")


# ------------------------------------------------------------------ validation
def extract_json(text: str):
    m = re.search(r"```(?:json)?\s*(\{.*\})\s*```", text, re.S)
    body = m.group(1) if m else text[text.find("{"): text.rfind("}") + 1]
    return json.loads(body)


def _valid_time(s) -> bool:
    if not isinstance(s, str):
        return False
    try:
        datetime.datetime.fromisoformat(s.replace("Z", "+00:00"))
        return True
    except ValueError:
        return False


def check_fact(f) -> tuple[str, object, str]:
    """('ok', value, '') | ('not_found', None, reason) | ('rejected', None, why)."""
    if not isinstance(f, dict):
        return "rejected", None, "not a fact object"
    if f.get("not_found") is True:
        return "not_found", None, str(f.get("reason", ""))
    if "value" not in f or f["value"] in ("...", None, ""):
        return "rejected", None, "no value"
    src = f.get("source")
    if not isinstance(src, str) or not src.startswith(("http://", "https://")) or src == "https://...":
        return "rejected", None, "no source link"
    if not _valid_time(f.get("as_of")):
        return "rejected", None, "no valid as-of time"
    return "ok", f["value"], ""


def _truthy(v):
    if isinstance(v, bool):
        return v
    if isinstance(v, str):
        return v.strip().lower() in ("true", "yes")
    return None


# ------------------------------------------------------------------ relay files
# Every relay folder holds "<what it is> - PROMPT.txt" (paste into Grok) and "<what it is> - ANSWER.txt" (Grok's reply).
RELAY = os.path.join(HERE, "relay")


def _is_answer(name: str) -> bool:
    return name.lower().endswith("answer.txt")


def answer_path(folder: str) -> str | None:
    """The folder's answer file ("... - ANSWER.txt", or the older plain answer.txt)."""
    if not os.path.isdir(folder):
        return None
    hits = sorted(n for n in os.listdir(folder) if _is_answer(n))
    return os.path.join(folder, hits[0]) if hits else None


def all_answer_paths() -> list[str]:
    """Every Grok answer file in relay/<folder>/, sorted by full path: the same order the scoring has always used
    (e.g. "batch-G4BASE-FC/..." sorts before "batch-G4BASE/...", so the newer Farcaster check is read first)."""
    out = []
    for d in os.listdir(RELAY):
        p = answer_path(os.path.join(RELAY, d))
        if p and d != "reviews":
            out.append(p)
    return sorted(out)


def write_pair(folder: str, label: str, prompt_text: str) -> tuple[str, str]:
    """Write "<label> - PROMPT.txt" and an empty "<label> - ANSWER.txt" (an existing answer is never overwritten)."""
    os.makedirs(folder, exist_ok=True)
    p, a = os.path.join(folder, f"{label} - PROMPT.txt"), os.path.join(folder, f"{label} - ANSWER.txt")
    open(p, "w").write(prompt_text)
    open(a, "a").close()
    return p, a


def apply_followups(answer: dict, mint: str) -> dict:
    """Merge any relay/"Follow-up ... - ANSWER.txt" for this mint into the X section (follow-up questions
    answer one or two fields). Each merged field still has to pass check_fact."""
    import copy, glob
    a = copy.deepcopy(answer)
    for p in sorted(os.path.join(RELAY, n) for n in os.listdir(RELAY)
                    if n.lower().startswith("follow-up") and _is_answer(n)):
        try:
            f = extract_json(open(p).read())
        except Exception:
            continue
        if f.get("mint") != mint:
            continue
        for k, v in f.items():
            if k != "mint" and k in FACT_FIELDS["x"]:
                a.setdefault("x", {})[k] = v
    return a


def _num(v):
    try:
        return float(str(v).replace(",", "").replace("%", "").strip())
    except (TypeError, ValueError):
        return None


def _date(v):
    try:
        return datetime.datetime.fromisoformat(str(v).replace("Z", "+00:00")[:25]).replace(tzinfo=datetime.timezone.utc) \
            if len(str(v)) > 10 else datetime.datetime.fromisoformat(str(v)[:10]).replace(tzinfo=datetime.timezone.utc)
    except ValueError:
        return None


def _count(v):
    if isinstance(v, list):
        return len(v)
    n = _num(v)
    return None if n is None else int(n)


# Social grading figures: redacted in the public copy
AGE_STEPS = None   # redacted in the public copy
SHILL_PROMOTED_MIN, SHILL_CAP = None, None   # redacted in the public copy
ENGAGEMENT_LOW, ENGAGEMENT_OK = None, None   # redacted in the public copy
BOT_REPLY_MAX, SPIKE_CAP = None, None   # redacted in the public copy


def grade_account_history(created, promoted, renamed, launch_ts, receipts=()):
    """Redacted in the public copy."""
    raise NotImplementedError("redacted: proprietary PINR logic is not included in the public copy")


def grade_audience(followers, avg_likes, spike, bot_share, receipts=()):
    """Redacted in the public copy."""
    raise NotImplementedError("redacted: proprietary PINR logic is not included in the public copy")


def grade_activity(posts_7d, repliers_7d, receipts=()):
    """Redacted in the public copy."""
    raise NotImplementedError("redacted: proprietary PINR logic is not included in the public copy")


# the X check's further parts, each graded only when read (else unknown, never zero).
SHOWN_POINTS = None   # redacted in the public copy
LINK_FACTOR = None   # redacted in the public copy
POST_STEPS = None   # redacted in the public copy
REGULAR_DAYS, DAY_MAX, SPAM_DAY, SPAM_SAME, SPAM_GRADE = None, None, None, None, None   # redacted in the public copy
REPLIES_FULL, REPOSTS_FULL = None, None   # redacted in the public copy
NO_BADGE = None   # redacted in the public copy
ORGANIC_STEPS = None   # redacted in the public copy


def _steps(n, steps):
    """Redacted in the public copy."""
    raise NotImplementedError("redacted: proprietary PINR logic is not included in the public copy")


def grade_link_proof(base, shows_ca, shows_wallet, link_kind, is_reply, receipts=(), by_owner=None):
    """Redacted in the public copy."""
    raise NotImplementedError("redacted: proprietary PINR logic is not included in the public copy")


def grade_original_posts(n, receipts=()):
    """Redacted in the public copy."""
    raise NotImplementedError("redacted: proprietary PINR logic is not included in the public copy")


def grade_regularity(days, max_day, same_share, receipts=()):
    """Redacted in the public copy."""
    raise NotImplementedError("redacted: proprietary PINR logic is not included in the public copy")


def grade_engagement(med_replies, med_reposts, receipts=()):
    """Redacted in the public copy."""
    raise NotImplementedError("redacted: proprietary PINR logic is not included in the public copy")


def grade_badge(badge, receipts=()):
    """Redacted in the public copy."""
    raise NotImplementedError("redacted: proprietary PINR logic is not included in the public copy")


def grade_organic(n, receipts=()):
    """Redacted in the public copy."""
    raise NotImplementedError("redacted: proprietary PINR logic is not included in the public copy")


def grade_telegram(messages_7d, posters_7d, receipts=()):
    """Redacted in the public copy."""
    raise NotImplementedError("redacted: proprietary PINR logic is not included in the public copy")


def validate(answer: dict, mint: str, links: dict | None, launch_ts: int | None = None) -> dict:
    """Redacted in the public copy."""
    raise NotImplementedError("redacted: proprietary PINR logic is not included in the public copy")


# ------------------------------------------------------------------ command line
def _reading_text(r: E.Reading) -> str:
    g = "" if r.grade is None else f" {r.grade:g}"
    return f"{r.state.value}{g}" + (f" ({'; '.join(r.flags)})" if r.flags else "")


def _report(out):
    readable = dict(out, readings={k: _reading_text(v) for k, v in out["readings"].items()})
    print(f"\n{out['mint']}")
    print("  Verified link:", readable["readings"]["social.verified_link"])
    print("  Website path back:", readable["readings"]["website.path_back"])
    print("  Real home:", {True: "yes", False: "NO (presence cap applies)", None: "not decided yet"}[out["has_real_home"]])
    print(f"  Rejected findings ({len(out['rejected'])}):", *out["rejected"], sep="\n    ")
    return readable


def main(argv):
    from readers import Log, read_token_links
    if len(argv) >= 4 and argv[1] == "batch":
        d = os.path.join(HERE, "relay", f"batch-{argv[2]}")
        os.makedirs(d, exist_ok=True)
        items = [(m, read_token_links(m, Log())) for m in argv[3:]]
        p, a = write_pair(d, f"Batch {argv[2]} ({len(items)} tokens)", build_batch_prompt(items))
        json.dump({m: l for m, l in items}, open(os.path.join(d, "links.json"), "w"), indent=1)
        print(f"Prompt written to {p}\nPaste Grok's full reply into {a}, then run: python3 grok_relay.py checkbatch {argv[2]}")
        return 0
    if len(argv) == 3 and argv[1] == "checkbatch":
        d = os.path.join(HERE, "relay", f"batch-{argv[2]}")
        links = json.load(open(os.path.join(d, "links.json")))
        ap = answer_path(d)
        text = open(ap).read() if ap else ""
        if not text.strip():
            print("The ANSWER file is empty: paste Grok's reply first."); return 1
        answers = {a.get("mint"): a for a in extract_json(text).get("tokens", [])}
        results = {}
        for mint, l in links.items():
            if mint not in answers:
                print(f"\n{mint}\n  Grok gave no answer for this token: everything stays unknown"); continue
            results[mint] = _report(validate(answers[mint], mint, l))
        json.dump(results, open(os.path.join(d, "result.json"), "w"), indent=1, default=str)
        return 0
    if len(argv) != 3 or argv[1] not in ("prompt", "check"):
        print(__doc__); return 2
    mint = argv[2]
    d = os.path.join(HERE, "relay", mint)
    os.makedirs(d, exist_ok=True)
    links = read_token_links(mint, Log())
    if argv[1] == "prompt":
        p, a = write_pair(d, f"Single token {mint[:8]}", build_prompt(mint, links))
        print(f"Prompt written to {p}\nPaste Grok's full reply into {a}, then run: python3 grok_relay.py check {mint}")
        return 0
    ap = answer_path(d)
    text = open(ap).read() if ap else ""
    if not text.strip():
        print("The ANSWER file is empty: paste Grok's reply first."); return 1
    readable = _report(validate(extract_json(text), mint, links))
    json.dump(readable, open(os.path.join(d, "result.json"), "w"), indent=1, default=str)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
