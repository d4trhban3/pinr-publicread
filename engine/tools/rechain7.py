"""Line 7, once after builder/chain7 is live: every stored Base/BNB feed file gets its `check_sources` built again from its own
stored score with today's builder (the coin's own chain and explorer, never Solana's). Only that field changes; a file whose
field is already right is left alone; each write is a whole new file renamed into place. --dry-run counts and writes nothing.
Run from the engine folder:  python3 tools/rechain7.py [--dry-run]"""
import glob, json, os, sys

ENGINE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ENGINE, "feed")); sys.path.insert(0, os.path.join(ENGINE, "scanner"))
import feed_export as F

DATA = os.environ.get("PINR_ENGINE_DATA") or ENGINE         # a dry run from a copy of this build reads the live engine's data
RESULTS = os.path.join("stage4", "results")
FEED = os.path.join("frontend-feed")


def main(dry: bool) -> dict:
    seen = changed = solana_before = 0
    for p in glob.glob(os.path.join(RESULTS, "0x*.json")):
        mint = os.path.basename(p)[:-5]
        fp = os.path.join(FEED, mint + ".json")
        try:
            o, f = json.load(open(p)), json.load(open(fp))
        except Exception:
            continue
        if not isinstance(f, dict) or "check_sources" not in f:
            continue
        seen += 1
        times = [r.get("as_of") for r in o.get("receipts") or [] if isinstance(r, dict) and isinstance(r.get("as_of"), str) and r["as_of"][:2] == "20"]
        new = F.check_sources_for(o, max(times) if times else None) or None
        if "Solana chain" in json.dumps(f.get("check_sources")):
            solana_before += 1
        if new == f.get("check_sources"):
            continue
        changed += 1
        if dry:
            continue
        f["check_sources"] = new
        tmp = fp + ".rechain7"
        with open(tmp, "w") as out:
            json.dump(f, out)
        os.replace(tmp, fp)
    return {"files_with_check_sources": seen, "naming_solana_before": solana_before, "changed": changed, "dry_run": dry}


if __name__ == "__main__":
    print(json.dumps(main("--dry-run" in sys.argv[1:])))
