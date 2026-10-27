"""Line 11, once after builder/basefix is live (the team's FAIL: a Base tick priced at $7.83e41 from a pool's post-swap
price): every Base tick file (source "Base chain") is moved aside into frontend-feed/ticks-moved-<UTC date>/ (kept, never
deleted), and each WETH pool's read position in chains.sqlite is cleared, so the chains service's next pass reads each pool
from its creation block again with the fixed price. Run from the engine folder, the chains service running or not:
  python3 tools/rebuild_base_ticks.py [--dry-run]"""
import glob, json, os, sqlite3, sys, time

ENGINE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TICKS = os.path.join(ENGINE, "frontend-feed", "ticks")
DB = os.path.join(ENGINE, "chains", "chains.sqlite")


def main(dry: bool) -> dict:
    base = []
    for p in glob.glob(os.path.join(TICKS, "0x*.json")):
        try:
            if json.load(open(p)).get("source") == "Base chain":
                base.append(p)
        except Exception:
            continue
    ro = sqlite3.connect(f"file:{DB}?mode=ro", uri=True, timeout=30)
    try:
        pools = ro.execute("SELECT COUNT(*) FROM base_pools WHERE read_to IS NOT NULL").fetchone()[0]
    except sqlite3.OperationalError:
        pools = 0
    ro.close()
    if not dry:
        aside = os.path.join(os.path.dirname(TICKS), "ticks-moved-" + time.strftime("%Y-%m-%d", time.gmtime()))
        os.makedirs(aside, exist_ok=True)
        for p in base:
            os.replace(p, os.path.join(aside, os.path.basename(p)))
        c = sqlite3.connect(DB, timeout=30)
        c.execute("UPDATE base_pools SET read_to=NULL")
        c.commit()
    return {"base_tick_files": len(base), "pools_read_again": pools, "dry_run": dry}


if __name__ == "__main__":
    print(json.dumps(main("--dry-run" in sys.argv[1:])))
