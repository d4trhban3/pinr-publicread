"""Line 13, once after builder/goplus13 is live: stored GoPlus rows written as "nothing flagged" / unit "flags" get the
builder's observed words (0 / "notes GoPlus returned"; a row with notes keeps them, its unit renamed). Only those two
fields change; each changed coin's evidence file is written again with the engine's own writer. --dry-run counts.
Run from the engine folder:  python3 tools/goplus13.py [--dry-run]"""
import json, os, sqlite3, sys, time

ENGINE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ENGINE, "scanner")); sys.path.insert(0, os.path.join(ENGINE, "chains"))
import evidence as EV, evidence_evm as EE

DATA = os.environ.get("PINR_ENGINE_DATA") or ENGINE
DB = os.path.join("scanner", "scanner.sqlite")
FEED = os.path.join("frontend-feed")
WHAT = "GoPlus security check (a lead)"


def main(dry: bool) -> dict:
    ro = sqlite3.connect(f"file:{DB}?mode=ro", uri=True, timeout=30)
    rows = ro.execute("SELECT coin, value, unit FROM evidence WHERE what=? AND (unit='flags' OR value=?)", (WHAT, json.dumps("nothing flagged"))).fetchall()
    ro.close()
    coins = sorted({r[0] for r in rows})
    nothing = sum(1 for r in rows if r[1] == json.dumps("nothing flagged"))
    if not dry:
        c = sqlite3.connect(DB, timeout=30)
        for coin in coins:
            c.execute("UPDATE evidence SET value=CASE WHEN value=? THEN ? ELSE value END, unit=? WHERE coin=? AND what=?",
                      (json.dumps("nothing flagged"), json.dumps(0), EE.NOTES_UNIT, coin, WHAT))
            c.commit()                                         # one short write a coin
            try:
                EV.write_coin_file(c, coin, FEED)
            except Exception:
                pass
            time.sleep(0.02)
    return {"rows": len(rows), "nothing_flagged": nothing, "coins": len(coins), "dry_run": dry}


if __name__ == "__main__":
    print(json.dumps(main("--dry-run" in sys.argv[1:])))
