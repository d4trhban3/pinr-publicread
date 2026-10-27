"""The scanner's stop (order item 4; the server, 2026-10-17): plain-English tests that start a small scanner-like process
with the scanner's own worker setup and stop handler, send it the stop signal, and read what it printed. Reads no
chain, sends no request, touches no live file or lock of the running scanner: the child makes its own pool and locks.
Run:  python3 test_stop.py"""
import os, signal, subprocess, sys, tempfile, time

HERE = os.path.dirname(os.path.abspath(__file__))
results = []
def case(n, title, should, fn):
    try:
        ok, text = fn()
    except Exception as e:
        ok, text = False, f"CRASH {type(e).__name__}: {e}"
    results.append(ok)
    print(f"\n{n:>2}. {title}\n    should: {should}\n    did:    {text}\n    {'PASS' if ok else 'FAIL'}")


CHILD = r'''
import gc, os, signal, sys, time
sys.path.insert(0, %r)
import scanner as S
from multiprocessing import get_context

def work(x):
    return x

if __name__ == "__main__":
    guard, wipe = sys.argv[1] == "guard", sys.argv[2] == "wipe"
    signal.signal(signal.SIGTERM, S._stop_main)              # as the scanner's run loop sets it
    if guard:
        S._quiet_lock_cleanup()
    with get_context("spawn").Pool(2, initializer=S._worker_init) as pool:
        pool.map(work, [1, 2])                               # the workers are up
        if wipe:                                             # what logind's RemoveIPC did on the server: the lock names gone
            import _multiprocessing, multiprocessing.synchronize as sy
            n = 0
            for o in list(gc.get_objects()):
                if isinstance(o, sy.SemLock) and getattr(o, "_semlock", None) is not None and o._semlock.name:
                    try:
                        _multiprocessing.sem_unlink(o._semlock.name); n += 1
                    except FileNotFoundError:
                        pass
            print("WIPED", n, flush=True)
        print("READY", flush=True)
        while True:
            time.sleep(0.2)
'''


def stop_child(guard: bool, wipe: bool):
    """Start the child, wait for READY, send SIGTERM, return (exit code, stdout, stderr)."""
    d = tempfile.mkdtemp()
    script = os.path.join(d, "child.py")
    open(script, "w").write(CHILD % HERE)
    p = subprocess.Popen([sys.executable, script, "guard" if guard else "plain", "wipe" if wipe else "keep"],
                         stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    out = ""
    deadline = time.time() + 60
    while "READY" not in out and time.time() < deadline:
        line = p.stdout.readline()
        if not line and p.poll() is not None:
            break
        out += line
    os.kill(p.pid, signal.SIGTERM)
    try:
        rest, err = p.communicate(timeout=60)
    except subprocess.TimeoutExpired:
        p.kill(); rest, err = p.communicate()
        err += "\nCHILD DID NOT STOP"
    return p.returncode, out + rest, err


def t1():
    code, out, err = stop_child(guard=True, wipe=False)
    return code == 0 and "READY" in out and "Traceback" not in err and "NOTE" not in err, \
        f"exit {code}; stderr {len(err.strip().splitlines())} line(s); tracebacks {err.count('Traceback')}; notes {err.count('NOTE')}"
case(1, "A plain stop is quiet", "the stop signal ends the child with exit 0, no traceback and no note", t1)

def t2():
    code, out, err = stop_child(guard=False, wipe=True)
    wiped = int(out.split("WIPED")[1].split()[0]) if "WIPED" in out else 0
    cleanup = sum(1 for l in err.splitlines() if "_run_finalizers" in l)      # the exit cleanup's own tracebacks, one per lock
    return wiped >= 1 and cleanup >= 1 and ("sem_unlink" in err or "_cleanup" in err), \
        f"{wiped} lock name(s) wiped first; without the guard the exit cleanup printed {cleanup} traceback(s) of {err.count('Traceback')} in all"
case(2, "Without the guard a stop after the locks are wiped prints tracebacks", "the fault the server showed: one traceback per lock in the exit cleanup (so this test can see it)", t2)

def t3():
    code, out, err = stop_child(guard=True, wipe=True)
    wiped = int(out.split("WIPED")[1].split()[0]) if "WIPED" in out else 0
    notes = [l for l in err.splitlines() if l.startswith("NOTE")]
    said = notes[0] if notes else ""
    cleanup = sum(1 for l in err.splitlines() if "_run_finalizers" in l)      # S1: a worker started after the wipe may die with its own
    workers = sum(1 for l in err.splitlines() if "spawn_main" in l)           # traceback; that is the fault shown, not the stop's noise
    return (code == 0 and wiped >= 1 and cleanup == 0 and len(notes) == 1 and f"{wiped} worker lock" in said
            and "shared memory cleared" in said), f"{wiped} wiped; exit {code}; exit-cleanup tracebacks {cleanup} (a worker's own at start, not counted: {workers}); note: {said[:80]!r}"
case(3, "With the guard the same stop is one NOTE line", "exit 0, no exit-cleanup traceback, one NOTE naming how many locks were gone and why (a worker that starts after the wipe and dies shows its own fault; that is right)", t3)


print(f"\n{sum(results)}/{len(results)} passed")
sys.exit(0 if all(results) else 1)
