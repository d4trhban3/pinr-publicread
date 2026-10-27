"""bonk.fun's launches an hour, from GeckoTerminal's newest-pools list (bonk.fun's daily count; the operator's yes
2026-10-17 for sixty keyless reads). One read a minute for an hour of `new_pools` page 1 (the 20 newest Solana pools across
every exchange, with the exchange id), each answer kept whole; nothing queued, nothing scored. The count is made afterwards
from the saved file (`count_bonk_sample.py`): distinct pools on bonk.fun's exchange created inside the hour. Because one page
is 20 pools and Solana launches more than that in some minutes, a minute whose page did not reach back to the previous
read's newest pool is a GAP: the count is then a minimum, and the file says which minutes. Run from `tools/`:
  python3 sample_bonk_hour.py            (an hour; writes profiles/2026-10-17-bonkfun-hour-sample.json as it goes)"""
import json, os, time, urllib.request

URL = "https://api.geckoterminal.com/api/v2/networks/solana/new_pools?include=dex&page=1"
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "profiles", "2026-10-17-bonkfun-hour-sample.json")
READS, EVERY = 60, 60.0


def get(url):
    req = urllib.request.Request(url, headers={"accept": "application/json", "user-agent": "PINR scanner"})
    with urllib.request.urlopen(req, timeout=20) as r:
        return r.status, json.load(r)


def main():
    reads = []
    t0 = time.time()
    for i in range(READS):
        at = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
        try:
            status, answer = get(URL)
            pools = [{"address": it["attributes"].get("address"), "dex": ((it.get("relationships") or {}).get("dex") or {}).get("data", {}).get("id"),
                      "created": it["attributes"].get("pool_created_at"),
                      "mint": (((it.get("relationships") or {}).get("base_token") or {}).get("data") or {}).get("id")}
                     for it in answer.get("data", []) if isinstance(it, dict) and isinstance(it.get("attributes"), dict)]
            reads.append({"read_at": at, "status": status, "pools": pools})
            print(f"{i + 1:>2}/{READS} {at} {status} {len(pools)} pools, dexes {sorted(set(p['dex'] for p in pools))}", flush=True)
        except Exception as e:
            reads.append({"read_at": at, "status": None, "error": f"{type(e).__name__}: {e}"[:200], "pools": []})
            print(f"{i + 1:>2}/{READS} {at} FAILED {type(e).__name__}: {e}", flush=True)
        json.dump({"started": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(t0)), "url": URL, "reads": reads}, open(OUT, "w"), indent=0)
        if i + 1 < READS:
            time.sleep(max(0.0, t0 + (i + 1) * EVERY - time.time()))
    print("done:", OUT)


if __name__ == "__main__":
    main()
