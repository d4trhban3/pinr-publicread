"""Escalation reviewer. Manual relay now; Anthropic API (Claude) later.

  python3 review.py queue            -> writes a review prompt for every scored token with escalations:
                                        relay/reviews/<mint>/"... - PROMPT.txt" (paste into Claude or Grok)
  python3 review.py check <mint>     -> reads relay/reviews/<mint>/"... - ANSWER.txt", records the verdicts in
                                        relay/reviews/verdicts.json (the scoring run obeys them)

Each escalation gets a verdict: "supported", "not_supported" or "needs_more_evidence".
Anything other than "supported" WITHHOLDS that move/flag on the next scoring run until resolved.
Every verdict is logged with its reasons and time.
"""
from __future__ import annotations
import datetime, glob, json, os, re, sys

HERE = os.path.dirname(os.path.abspath(__file__))
RESULTS = os.environ.get("PINR_RESULTS", os.path.join(HERE, "..", "stage2", "results"))
REVIEWS = os.path.join(HERE, "relay", "reviews")
VERDICTS = os.path.join(REVIEWS, "verdicts.json")
VALID = ("supported", "not_supported", "needs_more_evidence")

# which scoring input each escalation controls (used by the scoring run to withhold it)
def escalation_key(text: str) -> str:
    t = text.lower()
    for key in ("intent", "partial-dump", "duplicate-relaunch", "drainer", "bot/rug", "brake"):
        if key in t:
            return key
    return "other"


def build_prompt(result: dict) -> str:
    """Redacted in the public copy."""
    raise NotImplementedError("redacted: proprietary PINR logic is not included in the public copy")


def load_verdicts() -> dict:
    try:
        return json.load(open(VERDICTS))
    except (FileNotFoundError, json.JSONDecodeError):
        return {}


def withheld_keys(mint: str) -> set:
    """Escalation keys the scoring run must withhold for this token (not reviewed as 'supported')."""
    return {v["key"] for v in load_verdicts().get(mint, {}).values() if v["verdict"] != "supported"}


def record(mint: str, escalations: list[str], answer: dict) -> dict:
    if answer.get("mint") != mint:
        raise ValueError("review answer is for a different token")
    allv = load_verdicts()
    mine = allv.setdefault(mint, {})
    now = datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds")
    for r in answer.get("reviews", []):
        i = r.get("id")
        if not isinstance(i, int) or not 0 <= i < len(escalations):
            continue
        verdict = r.get("verdict") if r.get("verdict") in VALID else "needs_more_evidence"
        mine[escalations[i]] = {"key": escalation_key(escalations[i]), "verdict": verdict,
                                "reason": str(r.get("reason", ""))[:2000], "reviewed_at": now, "reviewer": "manual relay"}
    os.makedirs(REVIEWS, exist_ok=True)
    json.dump(allv, open(VERDICTS, "w"), indent=1)
    return mine


def main(argv):
    if len(argv) >= 2 and argv[1] == "queue":
        done = load_verdicts()
        n = 0
        for f in sorted(glob.glob(os.path.join(RESULTS, "*.json"))):
            res = json.load(open(f))
            pending = [e for e in res.get("escalations", []) if e not in done.get(res.get("mint"), {})]
            if not pending:
                continue
            d = os.path.join(REVIEWS, res["mint"]); os.makedirs(d, exist_ok=True)
            from grok_relay import write_pair
            p, _ = write_pair(d, f"Review {res['mint'][:8]} (for Claude or Grok)", build_prompt(res))
            n += 1
            print(f"{res['mint']}: {len(pending)} item(s) -> {p}")
        print(f"{n} token(s) queued for review")
        return 0
    if len(argv) == 3 and argv[1] == "check":
        mint = argv[2]
        res = json.load(open(os.path.join(RESULTS, f"{mint}.json")))
        from grok_relay import answer_path
        ap = answer_path(os.path.join(REVIEWS, mint))
        text = open(ap).read() if ap else ""
        m = re.search(r"\{.*\}", text, re.S)
        if not m:
            print("The ANSWER file has no JSON yet"); return 1
        for esc, v in record(mint, res.get("escalations", []), json.loads(m.group(0))).items():
            print(f"- {esc}\n  -> {v['verdict'].upper()}: {v['reason']}")
        return 0
    print(__doc__); return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv))
