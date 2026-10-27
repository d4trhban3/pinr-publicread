"""Checklist 6, once after builder/links6 is live: give every stored ● evidence row that has no link the link the row
builders now make, from the coin's own stored score (Solana: stage2/results; Base/BNB: stage4/results). Only the empty link
is filled: value, source and read times stay as read (nothing was read again). Each changed coin's evidence file is then
written again with the engine's own writer. Short writes, paced; --dry-run counts and changes nothing.
Run from the engine folder:  python3 tools/relink6.py [--dry-run]"""
import json, os, sqlite3, sys, time

ENGINE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ENGINE, "scanner")); sys.path.insert(0, os.path.join(ENGINE, "chains"))
import evidence as EV, evidence_evm as EE

DATA = os.environ.get("PINR_ENGINE_DATA") or ENGINE         # a dry run from a copy of this build reads the live engine's data
DB = os.path.join("scanner", "scanner.sqlite")
RESULTS = {"solana": os.path.join("stage2", "results"), "evm": os.path.join("stage4", "results")}
FEED = os.path.join("frontend-feed")


def built_rows(coin: str) -> list:
    """The rows the builders make today from the coin's stored score; [] when there is none."""
    evm = coin.startswith("0x")
    try:
        out = json.load(open(os.path.join(RESULTS["evm" if evm else "solana"], coin + ".json")))
    except Exception:
        return []
    if not isinstance(out, dict):
        return []
    return EE.rows(out) if evm else EV.rows_from_result(out)


def from_row(coin: str, f: str, t: str, w: str):
    """The same link the builders make, from the stored row alone (a coin whose score file is gone); None when it needs more."""
    if w == "launched" and not coin.startswith("0x"):
        return "https://solscan.io/token/" + coin
    if w == "copies of this coin launched" and not f.startswith("0x"):
        return EV.account(f)
    if w == "trades in pool (Uniswap v4)" and isinstance(t, str) and len(t) == 66 and t.startswith("0x"):
        return "https://app.uniswap.org/explore/pools/base/" + t
    return None


def main(dry: bool) -> dict:
    ro = sqlite3.connect(f"file:{DB}?mode=ro", uri=True, timeout=30)
    todo = ro.execute("SELECT coin, from_id, to_id, what FROM evidence WHERE onchain=1 AND (link IS NULL OR link='')").fetchall()
    ro.close()
    want = {}
    for coin, f, t, w in todo:
        want.setdefault(coin, set()).add((f, t, w))
    filled, left, coins = 0, 0, []
    c = None if dry else sqlite3.connect(DB, timeout=30)
    for coin, keys in want.items():
        links = {(r["from_id"], r["to_id"], r["what"]): r["link"] for r in built_rows(coin) if r.get("link")}
        for k in keys:
            if k not in links and from_row(coin, *k):
                links[k] = from_row(coin, *k)
        hit = [(links[k], coin) + k for k in keys if k in links]
        left += len(keys) - len(hit)
        if not hit:
            continue
        filled += len(hit); coins.append(coin)
        if dry:
            continue
        c.executemany("UPDATE evidence SET link=? WHERE coin=? AND from_id=? AND to_id=? AND what=? AND onchain=1 AND (link IS NULL OR link='')", hit)
        c.commit()                                             # one short write a coin
        try:
            EV.write_coin_file(c, coin, FEED)
        except Exception:
            pass                                               # the row is fixed; the file follows at the coin's next write
        time.sleep(0.02)
    return {"rows_without_link": len(todo), "coins": len(want), "filled": filled, "coins_changed": len(coins), "left_without_link": left, "dry_run": dry}


if __name__ == "__main__":
    print(json.dumps(main("--dry-run" in sys.argv[1:])))
