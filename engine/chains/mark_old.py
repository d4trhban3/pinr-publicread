"""the team 2026-10-25: the Base/BNB feed files scored by the earlier EVM scoring (12 October; launchpad words
"Flap.sh", "four.meme", "Bankr", "Clanker") were scored under the rules before a design decision (13 to 17 October),
so their scores are not today's. Each is marked unscored, nothing deleted:
  - its feed file becomes an unscored coin file (score null, "not scored yet"), keeping only the coin's own identity (chain,
    launchpad, name, ticker, picture, launch time, its own links) and its original read time; the old file is copied whole
    to <engine>/old-evm-scores/feed/;
  - its old result file (stage4/results/<coin>.json, which the coin page reads) is moved to <engine>/old-evm-scores/results/.
An old result file whose coin has no feed file any more is moved there too, so the site
no longer lists it from the result alone. A file CHAINS scored (read on or after CUTOFF), a seen file and a Solana file are
never touched. A file already marked is left as it is (running it twice changes nothing).

  python3 chains/mark_old.py            what it would do (counts by launchpad), writing nothing
  python3 chains/mark_old.py --apply    do it (under each coin's own feed lock)"""
from __future__ import annotations
import calendar, json, os, shutil, sys, time

HERE = os.path.dirname(os.path.abspath(__file__))
ENGINE = os.path.dirname(HERE)
sys.path[:0] = [os.path.join(ENGINE, "feed")]

CUTOFF = "2026-10-24T00:00:00Z"        # no Base/BNB coin was scored between 12 October and CHAINS' scoring (25 October)
KEEP = ("mint", "chain", "launchpad", "name", "ticker", "image_url", "launched_at", "links")
WORDS = "not scored yet"


def _t(iso) -> float | None:
    try:
        return float(calendar.timegm(time.strptime(str(iso)[:19], "%Y-%m-%dT%H:%M:%S")))
    except (TypeError, ValueError):
        return None


def is_old(d: dict, cutoff: float) -> bool:
    """An old EVM score: a Base/BNB coin file, not seen, not already marked, read before the cutoff (or with no read time)."""
    if not isinstance(d, dict) or str(d.get("chain") or "").lower() not in ("base", "bsc", "bnb") or d.get("seen") is True:
        return False
    if d.get("score") is None and d.get("display") == WORDS:
        return False                                           # already marked
    at = _t(d.get("as_of"))
    return at is None or at < cutoff


def marked(d: dict) -> dict:
    """The unscored coin file: the four required fields first (as every feed file), then the coin's own identity."""
    rec = {"mint": d["mint"], "score": None, "display": WORDS, "coverage": 0, "label": "Not scored yet"}
    for k in KEEP[1:]:
        if d.get(k) is not None:
            rec[k] = d[k]
    if d.get("as_of"):
        rec["as_of"] = d["as_of"]
    return rec


def run(feed_dir: str, results_dirs: list, old_dir: str, apply: bool = False, cutoff: str = CUTOFF, lock=None) -> dict:
    import feed_export as F
    lock = lock or F.file_lock
    cut = _t(cutoff)
    out = {"looked_at": 0, "old": 0, "marked": 0, "results_moved": 0, "by_launchpad": {}}
    for n in sorted(os.listdir(feed_dir)):
        if not (n.startswith("0x") and n.endswith(".json")):
            continue
        p = os.path.join(feed_dir, n)
        out["looked_at"] += 1
        try:
            d = json.load(open(p))
        except Exception:
            continue
        if not is_old(d, cut):
            continue
        out["old"] += 1
        lp = str(d.get("launchpad") or "none")
        out["by_launchpad"][lp] = out["by_launchpad"].get(lp, 0) + 1
        if not apply:
            continue
        mint = n[:-5]
        with lock(mint):
            try:
                d = json.load(open(p))                         # read again under the lock: a score may have just landed
            except Exception:
                continue
            if not is_old(d, cut):
                continue
            os.makedirs(os.path.join(old_dir, "feed"), exist_ok=True)
            shutil.copy2(p, os.path.join(old_dir, "feed", n))
            tmp = p + ".tmp"
            json.dump(marked(d), open(tmp, "w"), indent=1)
            os.replace(tmp, p)
            out["marked"] += 1
        for rd in results_dirs:
            rp = os.path.join(rd, n)
            if os.path.exists(rp):
                os.makedirs(os.path.join(old_dir, "results"), exist_ok=True)
                os.replace(rp, os.path.join(old_dir, "results", n))
                out["results_moved"] += 1
    # An old result file whose coin has no feed file any more: the
    # site lists it from the result alone (no name, no picture, an old score). Its read times are its receipts' own.
    for rd in results_dirs:
        try:
            names = sorted(os.listdir(rd))
        except FileNotFoundError:
            continue
        for n in names:
            if not (n.startswith("0x") and n.endswith(".json")) or os.path.exists(os.path.join(feed_dir, n)):
                continue
            rp = os.path.join(rd, n)
            try:
                d = json.load(open(rp))
            except Exception:
                continue
            if str(d.get("chain") or "bsc").lower() not in ("base", "bsc", "bnb"):
                continue
            times = [_t(r.get("as_of")) for r in d.get("receipts") or [] if isinstance(r, dict)]
            times = [t for t in times if t]
            if times and max(times) >= cut:
                continue                                       # read on or after the cutoff: CHAINS' own score
            out["orphan_results"] = out.get("orphan_results", 0) + 1
            if apply:
                os.makedirs(os.path.join(old_dir, "results"), exist_ok=True)
                os.replace(rp, os.path.join(old_dir, "results", n))
                out["results_moved"] += 1
    return out


if __name__ == "__main__":
    import feed_export as F
    print(json.dumps(run(F.FEED_DIR, [os.path.join(ENGINE, "stage4", "results")], os.path.join(ENGINE, "old-evm-scores"),
                         apply="--apply" in sys.argv), indent=1))
