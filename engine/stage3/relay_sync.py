"""bring PINRbot's relay readings to the server without pulling code (item 29; PINRBOT's 8a).

  python3 stage3/relay_sync.py        one pass: fetch GitHub's main, copy ONLY pinrbot/relay/readings/*.json into the
                                      engine's ignored index/relay-readings/, and for each new or changed reading put the
                                      coin on PINRbot's wanted list and ask the scanner to score it first

Run every 5 minutes by the user timer ops/systemd/pinr-relay-sync.timer. It reads
files with `git show` from the fetched main: the working tree, the code and the scanner's settings are never touched. A
file that is not the agreed shape ("pinrbot-relay/1", its own mint, a usable name) is not copied. Free: no API is called.
"""
from __future__ import annotations
import json, os, re, subprocess, sys

HERE = os.path.dirname(os.path.abspath(__file__))
ENGINE = os.path.dirname(HERE)
REPO = os.path.dirname(os.path.dirname(ENGINE))
sys.path.insert(0, HERE)
import pinrbot as PB

PATH_IN_REPO = "pinrbot/relay/readings/"
MINT_RE = re.compile(r"[1-9A-HJ-NP-Za-km-z]{32,44}")


def _git(*args, run=subprocess.run) -> tuple:
    p = run(["git", "-C", REPO, *args], capture_output=True, text=True, timeout=120)
    return p.returncode, p.stdout


def sync(git=_git, copy_dir=None, request=None, want=PB.want, say=print) -> dict:
    """One pass. Returns {"copied": [...], "unchanged": n, "refused": [...], "error": None|str}."""
    copy_dir = copy_dir or PB.RELAY_COPY_DIR
    request = request or (lambda mint: subprocess.run([sys.executable, os.path.join(ENGINE, "scanner", "scanner.py"), "request", "solana", mint],
                                                      capture_output=True, text=True, timeout=60))
    out = {"copied": [], "unchanged": 0, "refused": [], "error": None}
    code, _ = git("fetch", "-q", "origin", "main")
    if code != 0:
        out["error"] = "git fetch failed: nothing copied"; say(out["error"]); return out
    code, listing = git("ls-tree", "--name-only", "origin/main", PATH_IN_REPO)
    if code != 0:
        out["error"] = "the readings folder could not be listed"; say(out["error"]); return out
    os.makedirs(copy_dir, exist_ok=True)
    for path in listing.split():
        name = os.path.basename(path)
        mint = name[:-5] if name.endswith(".json") else ""
        if not MINT_RE.fullmatch(mint):
            continue
        code, body = git("show", f"origin/main:{path}")
        try:
            r = json.loads(body) if code == 0 else None
        except Exception:
            r = None
        if not isinstance(r, dict) or r.get("schema") != PB.RELAY_SCHEMA or r.get("mint") != mint:
            out["refused"].append(mint); continue
        dest = os.path.join(copy_dir, name)
        try:
            same = json.load(open(dest)) == r
        except Exception:
            same = False
        if same:
            out["unchanged"] += 1; continue
        with open(dest + ".tmp", "w") as f:
            json.dump(r, f, ensure_ascii=False)
        os.replace(dest + ".tmp", dest)
        want(mint)                                        # in demand: its next score reads PINRbot afresh
        request(mint)                                     # and that score comes first (the scanner's hand request)
        out["copied"].append(mint)
    say(f"relay readings: {len(out['copied'])} new or changed, {out['unchanged']} unchanged, {len(out['refused'])} refused")
    return out


if __name__ == "__main__":
    sync()
