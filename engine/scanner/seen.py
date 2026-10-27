"""Seen coins into the feed before any score, run inside the trigger's pass: every coin the pass looked at from the
app's Pump.fun pool or Stonk.fun's launch list gets a seen file at once (no chain read), then, a budget a pass, the fee of the
LaunchLab (Stonk.fun) coins is read on chain and written (the mint, the pool, the platform account and the curve rule, the last two
cached by the readers), newest first; a Pump.fun coin's fee comes with its score. A read that fails is tried again next pass, never guessed.
Files older than a day that never scored are removed. Nothing simulated: what is not read is absent."""
from __future__ import annotations
import os, sys, time
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "feed")); sys.path.insert(0, os.path.join(HERE, "..", "stage2"))
import seen_feed as SF

SEEN_FEE_BUDGET = 30                 # fee reads a pass (coins), so a seen coin carries its fee within minutes
_STATE: dict = {}                    # mint -> {"seen_by", "pool", "fee": bool, "verified": bool, "created"}: this process's memory of seen coins


def _launchpad_words(seen_by: str, graduated: bool = False) -> str:
    if seen_by == "pumpfun_pool":
        return SF.GRADUATED_WORDS if graduated else "Pump.fun curve"
    return "LaunchLab curve"


def note_seen(records: list, now: float | None = None, write=None) -> int:
    """`records`: [{"mint", "seen_by", "created" (seconds or 0), "name", "symbol", "image", "pool"}] for every coin the pass looked
    at. A coin with no feed file yet gets a seen file; one already scored (any non-seen file) is left alone. Item 54: once the
    launchpad's own record says a Pump.fun coin graduated, its file's launchpad words follow at once, seen or scored, and only
    those words (`seen_feed.follow_graduation`), once per coin. Returns how many files were written."""
    now = now or time.time()
    write = write or SF.write_seen
    n = 0
    for r in records:
        m = r.get("mint")
        if not isinstance(m, str) or not m:
            continue
        st = _STATE.get(m)
        if st is None:
            _STATE[m] = st = {"seen_by": r.get("seen_by"), "pool": r.get("pool"), "fee": SF.has_fee(m), "verified": False, "created": r.get("created") or 0,
                              "seen_at": now, "file": SF.read_file(m) is not None}
            if not st["file"]:
                rec = SF.seen_record(m, r.get("seen_by"), now, launchpad=_launchpad_words(r.get("seen_by"), r.get("graduated") is True), name=r.get("name"), ticker=r.get("symbol"),
                                     image_url=r.get("image"), launched_at=r.get("created") or None)
                if write(rec):
                    n += 1; st["file"] = True
        elif r.get("pool") and not st.get("pool"):
            st["pool"] = r["pool"]
        if r.get("graduated") is True and r.get("seen_by") == "pumpfun_pool" and not st.get("graduated"):
            SF.follow_graduation(m)
            st["graduated"] = True
    return n


def fill_fees(budget: int = SEEN_FEE_BUDGET, read_mint=None, read_pool=None, platform=None, rewards=None, update=None, now=None) -> dict:
    """Read the fee for up to `budget` seen coins that have none yet (Stonk.fun first, then newest first) and write the
    `transfer_fee` fact into their seen files; for a Stonk.fun coin the pool and platform are read and verified first and the
    launchpad words become the verified platform's. Returns {"read": n, "written": n, "failed": n, "skipped": n (no longer a seen file)}."""
    out = {"read": 0, "written": 0, "failed": 0, "skipped": 0}
    # only a LaunchLab coin's fee is read before its score (a Pump.fun coin's fee comes with its score; reading every
    # pool coin's mint cost about 1,800 requests an hour for coins that mostly never score)
    todo = [m for m, st in _STATE.items() if not st["fee"] and st.get("file") and st["seen_by"] == "stonkfun_list"]
    todo.sort(key=lambda m: (0 if _STATE[m]["seen_by"] == "stonkfun_list" else 1, -(_STATE[m]["created"] or _STATE[m]["seen_at"])))
    if not todo:
        return out
    import readers as R
    read_mint = read_mint or R.read_mint
    read_pool = read_pool or R.read_launchlab_pool
    platform = platform or R.launchlab_platform
    rewards = rewards or R.rewards_program
    update = update or SF.update_seen
    for m in todo[:max(0, int(budget))]:
        st = _STATE[m]
        if not SF.is_seen_file(m):
            st["fee"] = True; out["skipped"] += 1                 # scored meanwhile: the full file carries everything
            continue
        log = R.Log()
        out["read"] += 1
        try:
            mint_rec = read_mint(m, log)
        except Exception:
            mint_rec = None
        if mint_rec is None:
            out["failed"] += 1
            continue                                              # tried again next pass
        plat, ll = None, None
        words = None
        if st["seen_by"] == "stonkfun_list" and st.get("pool"):
            try:
                ll = read_pool(st["pool"], m, log)
                if ll is not None:
                    plat = platform(ll["platform_config"], log)
                    if plat and plat.get("verified"):
                        words = f"LaunchLab curve ({plat['words']})"
            except Exception:
                ll = plat = None
        try:
            fee = rewards(mint_rec, plat, log, pool_state=ll)
        except Exception:
            fee = None
        read_at = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(now or time.time()))
        fact = SF.fee_fact(m, fee, log.items, read_at)
        if fact is None:
            out["failed"] += 1
            continue
        if update(m, facts=[fact], launchpad=words):
            st["fee"] = True; st["verified"] = bool(words); out["written"] += 1
        else:
            st["fee"] = True; out["skipped"] += 1
    return out


def expire(now: float | None = None) -> list:
    gone = SF.expire(now)
    for m in gone:
        _STATE.pop(m, None)
    return gone


EXPIRE_EVERY_S = 600          # the sweep of the feed folder (every coin file read) at most this often: a file goes a day after
_expired_at = [0.0]           # it was seen, so ten minutes later is no difference (the server's main loop spent most of its time here)


def pass_seen(records: list, now: float | None = None, budget: int = SEEN_FEE_BUDGET) -> str:
    """The whole step for one trigger pass, in words for the log."""
    n = note_seen(records, now)
    f = fill_fees(budget, now=now)
    gone = []
    if time.time() - _expired_at[0] >= EXPIRE_EVERY_S:
        gone = expire(now); _expired_at[0] = time.time()
    return (f"{n} seen files written; fees read {f['read']}, written {f['written']}" + (f", failed {f['failed']}" if f["failed"] else "")
            + (f"; {len(gone)} unscored seen files past a day removed" if gone else ""))
