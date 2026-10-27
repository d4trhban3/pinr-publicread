"""Stage 2 run: read the 10 sampled tokens from Solana mainnet and score them with the engine.
Run:  python3 run_stage2.py
Writes results/<mint>.json (every number with its receipt) and results/SUMMARY.md.
Social, website and the creator-wallet behaviour parts are Stage 3 (Grok / PINRbot): they stay
UNKNOWN here and lower coverage. Presence is unknown, so the presence cap never fires in Stage 2."""
import csv, datetime, json, os, sys
sys.path.insert(0, "../pinr-step2")
sys.path.insert(0, "../pinr-score")
sys.path.insert(0, "../stage3")
from readers import *
from curve_math_v1 import CurveKind, CurveState, curve_depth_inputs
import score_engine_v1 as E
import time as _time
from dev_history import Helius, dev_report, conduct_from_balances as conduct
from scan_c import dev_token_account, parse
from track_record import past_launch_dumps
from linked_wallets import dev_group, wallet_first_activity
import honeypot as _hp
from website_checks import check_website
import brakes as _B
from brake_readers import first_day_trades, top_holders, holders_read
import brake_readers as _BR
import funding_source as _FS
import social_wait as _SW
import pinrbot as _PB
import intent as _I
from review import withheld_keys
import re as _re
import glob as _glob
from grok_relay import validate as _grok_validate, extract_json as _grok_json, all_answer_paths as _relay_answers

os.makedirs("results", exist_ok=True)


def depth_from_curve(state, q_usd, log):
    real, val = curve_depth_inputs(state, q_usd)
    log.add("real money on curve", None if real is None else round(real, 2), "USD", "curve math v1 (real reserves only)")
    log.add("spot-implied valuation", None if val is None else round(val, 2), "USD", "curve math v1 × total supply")
    return real, val



def _feed(out: dict) -> None:
    """Update this token's file for the live app (data contract v1.0). Never breaks scoring if it fails."""
    try:
        sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "feed"))
        from feed_export import export_one
        export_one(json.loads(json.dumps(out, default=str)))
    except Exception as e:
        print(f"(live-app feed not updated for {out.get('mint')}: {type(e).__name__})")

FEE_WALLET_ESTABLISHED_S = 86400        # a fee wallet active at least a day before the launch has its own history


SCAN_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "..", "marketing", "scan-output")


def x_checked(mint: str, scan_dir=None) -> bool:
    """True once PINRsocialscan has filed this coin: its file in marketing/scan-output, schema version 1,
    naming this coin, the same test the feed server makes before showing it. A coin searched with no posts found is
    checked. No file, or one that cannot be read or names another coin: not checked yet."""
    try:
        d = json.load(open(os.path.join(scan_dir or SCAN_DIR, mint + ".json")))
        coin = d.get("coin")
        named = coin.get("mint") if isinstance(coin, dict) else coin
        return d.get("schema_version") in ("1", 1) and named == mint
    except Exception:
        return False


def _funded_by(wallet: str, funder: str):
    """True if `funder` sent SOL to `wallet` in the wallet's earliest transactions; False if they show other funders;
    None if unreadable (a busy wallet whose start cannot be reached is not a brand-new wallet: False)."""
    import solana_rpc as S
    items, end = S.sigs_desc(wallet, max_pages=2)
    if items is None:
        return None
    if not end:
        return False
    oldest = [x["signature"] for x in items if not x.get("err")][-8:]
    txs = S.fetch_txs(oldest)
    if txs is None:
        return None
    for t in txs:
        for n in t.get("nativeTransfers") or []:
            if n.get("toUserAccount") == wallet and n.get("fromUserAccount") == funder and n.get("amount", 0) > 0:
                return True
    return False


def _merge_reports(a: dict, b: dict) -> dict:
    """One dev team's launches from two wallets' reports (no coin counted twice)."""
    from dev_history import duplicates
    seen, ls = set(), []
    for l in sorted(a["launches"] + b["launches"], key=lambda x: x["timestamp"]):
        if l["mint"] not in seen:
            seen.add(l["mint"]); ls.append(l)
    meta = {l["mint"]: {"name": l.get("name"), "symbol": l.get("symbol"), "image": l.get("image")} for l in ls}
    ta, tb = a.get("launchpad_total"), b.get("launchpad_total")
    return dict(a, launches=ls, launch_count=len(ls),
                launch_count_is_lower_bound=a["launch_count_is_lower_bound"] or b["launch_count_is_lower_bound"],
                launchpad_total=(ta + tb) if isinstance(ta, int) and isinstance(tb, int) else None,   # the team's own total, or unknown
                full_history_read=a["full_history_read"] and b["full_history_read"], duplicate_groups=duplicates(ls, meta),
                source="; ".join(x for x in (a.get("source"), b.get("source")) if x))


def _team_track_record(team: list, launches: list, mint: str, h):
    """Track record over the whole dev team: each past launch is judged on what any team wallet did in its first 5 minutes."""
    allv, alld = [], []
    for w in team:
        v, d = past_launch_dumps(w, launches, mint, h)
        if v is None:
            return None, d
        allv.append(v); alld.append(d)
    if len(team) == 1:
        return allv[0], alld[0]
    merged = []
    for row in zip(*allv):                                    # per launch: dumped if any wallet dumped; skipped only if all skipped
        merged.append(True if any(x is True for x in row) else (False if any(x is False for x in row) else None))
    return merged, alld


def score_token(frame, mint, ll_pool_pointer):
    """One full score. The cache inside one score (schedule step 4) is switched on for its length: an exact repeat of an
    answered chain read is served from memory, and the cache is emptied when the next score starts."""
    import solana_rpc as _S
    _S.score_cache_start()
    try:
        o = _score_token(frame, mint, ll_pool_pointer)
        if isinstance(o, dict) and "error" not in o:
            o.setdefault("notes", [])
            o["reads_served_from_cache"] = _S.cache_served()      # how many repeats the score did not send; a count, not scoring
        return o
    finally:
        _S.score_cache_stop()


def is_mass_launcher(rep: dict) -> bool:
    """Redacted in the public copy."""
    raise NotImplementedError("redacted: proprietary PINR logic is not included in the public copy")


def cap_count(rep: dict):
    """Redacted in the public copy."""
    raise NotImplementedError("redacted: proprietary PINR logic is not included in the public copy")


def _score_token(frame, mint, ll_pool_pointer):
    """Redacted in the public copy."""
    raise NotImplementedError("redacted: proprietary PINR logic is not included in the public copy")


if __name__ == "__main__":
    sample = list(csv.DictReader(open("stage2_sample.csv")))
    grok = {r["mint"]: r for r in csv.DictReader(open(os.environ.get("PINR_SAMPLE_CSV", "solana_devsell_sample.csv")))}
    rows = []
    for s in sample:
        ptr = (grok.get(s["mint"]) or {}).get("poolId") or None
        o = score_token(s["frame"], s["mint"], ptr)
        rows.append(o)
        print(o["mint"][:8], o.get("venue"), "score", o.get("display"), "coverage", o.get("coverage"), o.get("readings"))
    with open("results/SUMMARY.md", "w") as f:
        f.write(f"# Stage 2 run, {now_utc()}\n\nEngine: score_engine_v1. Social, website and creator behaviour = unknown (Stage 3).\n\n")
        f.write("| Group | Mint | Venue | Real money $ | Valuation $ | Depth | Authorities | Permanence | Reward pressure | Creator holds | Dev conduct | Dev launches | Pair health | Pump retained | Score | Label | Coverage |\n|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|\n")
        for o in rows:
            r = o.get("readings", {})
            f.write(f"| {o.get('frame')} | `{o['mint']}` | {o.get('venue')} | {o.get('real_money_usd')} | {o.get('valuation_usd')} | "
                    f"{r.get('liquidity_depth')} | {r.get('contract_authorities')} | {r.get('liquidity_permanence')} | "
                    f"{r.get('reward_flow_pressure')} | {r.get('creator_holdings')} | {r.get('dev_conduct')} | {r.get('dev_launches')} | {r.get('pair_health')} | {r.get('pump_retained')} | {o.get('display')} | {o.get('label')} | {o.get('coverage')} |\n")
