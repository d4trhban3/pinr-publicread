"""Every suite in CHECKS.md, read by its printed count.

    python3 tools/run_checks.py                 from the engine folder: copies the engine to a scratch folder and runs there
    python3 tools/run_checks.py --in-place      runs in this folder: only a builder worktree (never an engine the scanner or
                                                the site reads: the team's finding of 2026-10-24, a suite wrote 450 coin files)
    python3 tools/run_checks.py --only test_x   only the suites whose command contains that text

A suite passes only when its own output says N/N with the count CHECKS.md names; a suite's exit code alone can say
"fine" when a case failed. Prints one line a miss with the suite's last lines, and "<passed>/<total> suites at their
expected count". Exit code 1 on any miss. The copy takes the project's git-tracked files and new files not yet added (never
ignored ones; not the apps or the art) plus
control/ and imagehash/ node_modules (npm ci there when the engine has none), never index/, frontend-feed/ or .env."""
from __future__ import annotations
import os, re, shutil, subprocess, sys, tempfile, time

ENGINE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
NODE_DIRS = ("control", "imagehash")
SKIP_TOP = {"pinr-live", "pinr-android", "pinr-ios", "PINR Art Pack", "Founder"}   # the rest of the project is copied: suites read
                                                                                  # pinrbot/ and marketing/ beside the engine
TIMEOUT_S = 900


def jobs(checks_text: str) -> list:
    """[(folder, command, count)] in CHECKS.md's order, each once."""
    out, seen = [], set()
    for line in checks_text.splitlines():
        m = re.match(r"`(?:cd (\S+) && )?((?:python3|node|bash) \S+)` must print (\d+)/(\d+)", line)
        if not m:
            continue
        d = m.group(1) or "."
        found = [(d, m.group(2), m.group(3))] + [(d, x.group(1), x.group(2)) for x in re.finditer(r"and `(python3 \S+)` (\d+)/(\d+)", line)]
        for j in found:
            if j[:2] not in seen:
                seen.add(j[:2]); out.append(j)
    return out


def in_worktree(path: str) -> bool:
    """True inside a linked git worktree (a builder copy), whose git dir differs from the common one."""
    try:
        g = subprocess.run(["git", "rev-parse", "--git-dir", "--git-common-dir"], cwd=path, capture_output=True, text=True, timeout=30).stdout.splitlines()   # one path a line (they hold spaces)
        return len(g) == 2 and os.path.realpath(os.path.join(path, g[0])) != os.path.realpath(os.path.join(path, g[1]))
    except Exception:
        return False


def scratch_copy(engine: str) -> str:
    """The engine's tracked files in a fresh folder, with the node packages the Node suites need."""
    top = subprocess.run(["git", "rev-parse", "--show-toplevel"], cwd=engine, capture_output=True, text=True, check=True).stdout.strip()
    rel = os.path.relpath(engine, top)
    dest_top = tempfile.mkdtemp(prefix="pinr-checks-")
    files = subprocess.run(["git", "ls-files", "-z", "--cached", "--others", "--exclude-standard"], cwd=top,   # W2: a builder's
                           capture_output=True, check=True).stdout.split(b"\0")                                # new files too
    for f in filter(None, files):
        f = f.decode()
        if f.split("/", 1)[0] in SKIP_TOP:
            continue                                       # the apps and the art: no engine suite reads them
        src, dst = os.path.join(top, f), os.path.join(dest_top, f)
        if os.path.isfile(src):
            os.makedirs(os.path.dirname(dst), exist_ok=True)
            shutil.copy2(src, dst)
    dest = os.path.join(dest_top, rel)
    for d in NODE_DIRS:
        nm = os.path.join(engine, d, "node_modules")
        if os.path.isdir(nm):
            shutil.copytree(nm, os.path.join(dest, d, "node_modules"), symlinks=True)
        elif os.path.isfile(os.path.join(dest, d, "package-lock.json")):
            subprocess.run(["npm", "ci", "--silent"], cwd=os.path.join(dest, d), capture_output=True, timeout=600)
    return dest


def run(engine: str, only: str | None = None, say=print) -> int:
    todo = [j for j in jobs(open(os.path.join(engine, "CHECKS.md")).read()) if not only or only in j[1]]
    bad = []
    t0 = time.time()
    for d, cmd, n in todo:
        try:
            p = subprocess.run(cmd, shell=True, cwd=os.path.join(engine, d), capture_output=True, text=True, timeout=TIMEOUT_S)
            out = p.stdout + p.stderr
        except subprocess.TimeoutExpired:
            out = f"timed out after {TIMEOUT_S} s"
        fails = [l for l in out.splitlines() if re.search(r"\bFAIL\b", l)]       # the team W1: a FAIL line anywhere is a miss,
        if fails or not re.search(rf"\b{n}/{n}\b", out):                      # even when the count also appears
            tail = [l for l in out.splitlines() if l.strip()][-3:]
            bad.append(f"{d}/{cmd} expected {n}/{n}: {tail}")
    say(f"{len(todo) - len(bad)}/{len(todo)} suites at their expected count ({time.time() - t0:.0f} s)")
    for b in bad:
        say("MISS " + b)
    return 1 if bad else 0


if __name__ == "__main__":
    args = sys.argv[1:]
    only = args[args.index("--only") + 1] if "--only" in args else None
    if "--in-place" in args:
        if not in_worktree(ENGINE):
            print("--in-place only in a builder worktree: this folder may be one the scanner or the site reads (run without it)", file=sys.stderr)
            sys.exit(2)
        sys.exit(run(ENGINE, only))
    where = scratch_copy(ENGINE)
    print(f"running in a scratch copy: {where}")
    try:
        code = run(where, only)
    finally:
        shutil.rmtree(where.split(os.sep + "engine")[0], ignore_errors=True)
    sys.exit(code)
