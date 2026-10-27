"""The one batch of read-only live reads for a design decision, on the operator's yes
(2026-10-17). Keyless where the source is keyless; the chain through the engine's own providers. Every raw answer is
saved under tools/profiles/2026-10-17-* so the tests can run on real shapes. Nothing is bought, queued or restarted.

  python3 tools/live_batch_2026-10-17.py [--bonk-mint <mint>]
"""
from __future__ import annotations
import json, os, sys, time, urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
ENGINE = os.path.dirname(HERE)
for p in ("stage2", "scanner"):
    sys.path.insert(0, os.path.join(ENGINE, p))
import readers as R
import stonkfun as F
import dexscreener as D
from b58 import b58d, oc

PROF = os.path.join(HERE, "profiles")
WSOL = "So11111111111111111111111111111111111111112"
PRICING = F.BASE + "/api/public/v1/launchlab/pricing?quoteMint=" + WSOL
GECKO = "https://api.geckoterminal.com/api/v2/networks/solana/new_pools?include=base_token,dex&page=1"
STAMP = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
report = []


def say(line):
    print(line); report.append(line)


def get(url, headers=None):
    req = urllib.request.Request(url, headers={"accept": "application/json", "user-agent": "PINR scanner", **(headers or {})})
    t = time.time()
    with urllib.request.urlopen(req, timeout=20) as r:
        d = json.load(r)
    return d, round(time.time() - t, 2)


def save(name, data):
    path = os.path.join(PROF, f"2026-10-17-{name}.json")
    json.dump({"read_at": STAMP, "answer": data}, open(path, "w"), indent=1)
    return os.path.relpath(path, ENGINE)


def main(argv):
    bonk_mint = argv[argv.index("--bonk-mint") + 1] if "--bonk-mint" in argv else None
    say(f"# Live batch, {STAMP}")

    # 1. Stonk.fun: the ten-minute launch list, raw and parsed
    try:
        d, s = get(F.RECENT); p = save("stonkfun-launches-recent", d)
        pools = d.get("pools") if isinstance(d, dict) else None
        keys = sorted(set(k for it in (pools or []) if isinstance(it, dict) for k in it))
        parsed = F.recent(get=lambda u: d)
        say(f"1. Stonk.fun launches/recent: HTTP ok in {s}s; top keys {sorted(d) if isinstance(d, dict) else type(d).__name__}; {len(pools) if isinstance(pools, list) else 'no'} pools; item keys {keys}; parsed {len(parsed or [])} (mint/time/pool found: {[(m[:6], bool(t), bool(pl)) for m, t, pl in (parsed or [])[:3]]}); saved {p}")
        recent_mints = [m for m, _t, _p in (parsed or [])]
        recent_pools = {m: pl for m, _t, pl in (parsed or [])}
    except Exception as e:
        say(f"1. Stonk.fun launches/recent FAILED: {type(e).__name__}: {e}"); recent_mints, recent_pools = [], {}

    # 2. Stonk.fun pricing: platform ids, reward fee, authority
    try:
        d, s = get(PRICING); p = save("stonkfun-launchlab-pricing", d)
        plat = (d.get("platform") or {}) if isinstance(d, dict) else {}
        modes = (d.get("modes") or {}) if isinstance(d, dict) else {}
        reward = modes.get("reward") or {}
        say(f"2. Stonk.fun launchlab/pricing: ok in {s}s; platform ids {plat}; reward transferFeeBps {reward.get('transferFeeBps')}; withdrawWithheldAuthority {reward.get('withdrawWithheldAuthority')}; curve programId {(d.get('curve') or {}).get('programId') if isinstance(d, dict) else None}; saved {p}")
        listed_ok = {k: (v in R.LAUNCHLAB_PLATFORMS) for k, v in plat.items() if isinstance(v, str)}
        say(f"   the ids against the engine's list: {listed_ok}")
    except Exception as e:
        say(f"2. Stonk.fun pricing FAILED: {type(e).__name__}: {e}"); reward = {}

    # 3. Stonk.fun reward-mode sample
    try:
        d, s = get(F.REWARD_LIST); p = save("stonkfun-tokens-reward-newest", d)
        sample = F.reward_mints(get=lambda u: d)
        say(f"3. Stonk.fun tokens?mode=reward&sort=newest: ok in {s}s; top keys {sorted(d) if isinstance(d, dict) else type(d).__name__}; sample of {len(sample)} mints; saved {p}")
    except Exception as e:
        say(f"3. Stonk.fun reward list FAILED: {type(e).__name__}: {e}"); sample = []

    # 4. The four platform accounts on chain
    for acct, (name, mode) in R.LAUNCHLAB_PLATFORMS.items():
        raw, owner, slot = R.account_raw(acct)
        log = R.Log()
        got = R.launchlab_platform(acct, log)
        say(f"4. {name} {mode or ''} {acct}: {'no account' if raw is None else f'owner {owner}, {len(raw)} bytes, slot {slot}'}; owned by LaunchLab: {owner == R.LAUNCHLAB}; launchlab_platform -> {got['words']!r}")

    # 5. Two real pools: one Stonk.fun (the newest launch), one bonk.fun
    stonk_mint = recent_mints[0] if recent_mints else (sample[0] if sample else None)
    for label, mint in (("Stonk.fun", stonk_mint), ("bonk.fun", bonk_mint)):
        if not mint:
            say(f"5. {label}: no mint to read (none given)"); continue
        log = R.Log()
        ll = R.find_launchlab_pool(mint, log)
        if ll is None:
            say(f"5. {label} mint {mint}: no LaunchLab pool verified (Raydium's record named none that verified)"); continue
        got = R.launchlab_platform(ll["platform_config"], log)
        say(f"5. {label} mint {mint}: pool {ll['address']} status {ll['status']} platform_config {ll['platform_config']} -> {got['words']!r}; creator {ll['creator']}; quote {ll['quote_mint'][:8]}...")

    # 6. The fee authority and the ten reward mints (their rates too)
    auth = R.STONKFUN_COLLECTOR
    raw, owner, slot = R.account_raw(auth)
    say(f"6. fee authority {auth}: {'no account' if raw is None else f'owner {owner}, {len(raw)} bytes, slot {slot}'}; on the curve: {oc(b58d(auth))} ({'a keypair can exist' if oc(b58d(auth)) else 'program-derived'})")
    rows = []
    for m in sample[:10]:
        log = R.Log()
        mi = R.read_mint(m, log) or {}
        pool = R.find_launchlab_pool(m, log)
        plat = R.launchlab_platform(pool["platform_config"], log)["words"] if pool else None
        rows.append({"mint": m, "fee_bps": mi.get("transfer_fee_bps"), "authority": mi.get("withdraw_withheld_authority"), "creator": pool["creator"] if pool else None, "platform": plat})
        say(f"   {m}: fee {mi.get('transfer_fee_bps')} bps, authority {mi.get('withdraw_withheld_authority')}, platform {plat}, creator {pool['creator'] if pool else None}")
    save("stonkfun-reward-sample-chain", rows)
    rates = sorted(set(r["fee_bps"] for r in rows if r["fee_bps"] is not None))
    say(f"   rates seen on chain: {rates}; published reward transferFeeBps: {reward.get('transferFeeBps')}; naming the authority: {sum(1 for r in rows if r['authority'] == auth)} of {len(rows)}; distinct creators: {len(set(r['creator'] for r in rows if r['creator']))}")
    log = R.Log()
    std, words = R.program_standard_rate("Stonk.fun reward mode", log, sample=lambda: sample)
    say(f"   program_standard_rate -> {std}: {words}")

    # 7. Launch counts a day
    try:
        import importlib.util
        spec = importlib.util.spec_from_file_location("count_launches", os.path.join(HERE, "count_launches.py"))
        C = importlib.util.module_from_spec(spec); spec.loader.exec_module(C)
        now = time.time(); since = now - 24 * 3600
        c = C.count_window(C.pages_from(C.STONK_LEDGER), since, now)
        say(f"7. Stonk.fun launches, last 24 h (its ledger): {c['count']} ({c['pages']} pages, {c['undated']} undated); busiest hour {max(c['per_hour'].values()) if c['per_hour'] else 0}")
        counts = {"Stonk.fun (ledger)": c}
        for name, acct in C.PLATFORMS.items():
            try:
                first, s = get(C.RAYDIUM_LIST.replace("%d", "1") % acct)
                items = C._items(first)
                if not items:
                    say(f"   Raydium list by platform for {name}: answered in {s}s but no records recognised; keys {sorted(first) if isinstance(first, dict) else type(first).__name__}"); continue
                cc = C.count_window(C.pages_from(C.RAYDIUM_LIST.replace("%s", acct)), since, now)
                counts[name + " (Raydium list)"] = cc
                say(f"   Raydium list by platform for {name}: {cc['count']} in 24 h ({cc['pages']} pages); first item keys {sorted(items[0])[:12]}")
                if name == "bonk.fun" and not bonk_mint and items:
                    bonk_mint = next((it[k] for it in items for k in F.MINT_KEYS if F._address(it.get(k))), None)
            except Exception as e:
                say(f"   Raydium list by platform for {name}: FAILED {type(e).__name__}: {e}")
        try:
            import subprocess
            st = subprocess.run([sys.executable, os.path.join(ENGINE, "scanner", "scanner.py"), "status"], capture_output=True, text=True, timeout=60).stdout
        except Exception:
            st = ""
        rate = C.air_rate(st)
        say(f"   the Mac's scanner is stopped; the server's rate must be read there (status here: {rate})")
        s7 = C.summarise(counts, 24, None, 4)
        say("   " + C.words(s7, 24).replace("\n", "\n   "))
    except Exception as e:
        say(f"7. counts FAILED: {type(e).__name__}: {e}")

    # 5b. bonk.fun pool if a mint turned up only now
    if bonk_mint and "bonk.fun mint" not in "\n".join(report):
        log = R.Log(); ll = R.find_launchlab_pool(bonk_mint, log)
        if ll:
            got = R.launchlab_platform(ll["platform_config"], log)
            say(f"5b. bonk.fun mint {bonk_mint}: pool {ll['address']} status {ll['status']} platform_config {ll['platform_config']} -> {got['words']!r}")
        else:
            say(f"5b. bonk.fun mint {bonk_mint}: no LaunchLab pool verified")

    # 8. GeckoTerminal newest pools: dexes present, LaunchLab curves?
    try:
        d, s = get(GECKO); p = save("geckoterminal-new-pools", d)
        inc = {i["id"]: i for i in d.get("included", []) if isinstance(i, dict)}
        dexes = {}
        for pool in d.get("data", []):
            dex = (pool.get("relationships", {}).get("dex", {}).get("data") or {}).get("id")
            dexes[dex] = dexes.get(dex, 0) + 1
        ll_pools = [pool for pool in d.get("data", []) if "launchlab" in str((pool.get("relationships", {}).get("dex", {}).get("data") or {}).get("id")).lower() or "bonk" in str((pool.get("relationships", {}).get("dex", {}).get("data") or {}).get("id")).lower()]
        ex = ll_pools[0]["attributes"] if ll_pools else None
        say(f"8. GeckoTerminal new_pools page 1: ok in {s}s; {len(d.get('data', []))} pools; dexes {dexes}; LaunchLab/bonk pools {len(ll_pools)}" + (f"; example volume h1 {ex.get('volume_usd', {}).get('h1')} buys h1 {ex.get('transactions', {}).get('h1', {}).get('buys')} created {ex.get('pool_created_at')}" if ex else "") + f"; saved {p}")
    except Exception as e:
        say(f"8. GeckoTerminal FAILED: {type(e).__name__}: {e}")

    # 9. DexScreener: does it list a fresh Stonk.fun curve coin?
    try:
        probe = [m for m in recent_mints[:5]] or ([stonk_mint] if stonk_mint else [])
        got = D.pairs(probe) if probe else {}
        say(f"9. DexScreener pairs for {len(probe)} fresh Stonk.fun mints: listed {sum(1 for m in probe if got.get(m))} of {len(probe)}; " + "; ".join(f"{m[:6]}: {len(got.get(m) or [])} pair(s)" + (f" dex {got[m][0].get('dex')} vol h1 {got[m][0].get('volume_h1')}" if got.get(m) else "") for m in probe))
        save("dexscreener-stonkfun-fresh", {m: got.get(m) for m in probe})
    except Exception as e:
        say(f"9. DexScreener FAILED: {type(e).__name__}: {e}")

    out = os.path.join(PROF, "2026-10-17-live-batch-report.md")
    open(out, "w").write("\n".join(report) + "\n")
    print(f"\nreport {os.path.relpath(out, ENGINE)}")


if __name__ == "__main__":
    main(sys.argv[1:])
