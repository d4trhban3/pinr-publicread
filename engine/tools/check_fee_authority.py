"""Is Stonk.fun's reward-mode fee authority a launchpad-run wallet?  A read-only check; it goes
live only on the operator's yes:

  python3 tools/check_fee_authority.py [mint ...]

What it reads: (1) the authority's own account (getAccountInfo: who owns it, how big it is) and whether its key lies OFF
the ed25519 curve, which only a program-derived address does (no private key can exist for it, so only a program can
act for it); (2) the withheld-fee authority and fee rate of a sample of reward-mode Token-2022 mints, each read from the
mint itself on chain (the mints given on the command line, else the newest ten from Stonk.fun's keyless list, mode
reward), and each coin's creator from its LaunchLab pool (Raydium's record, verified on chain). The judgement is in
`judge()` and is plain: the sample decides. Only when every sampled reward launch, by several different creators,
names the address as its withheld-fee authority is it the launchpad's (a creator cannot pick it: Stonk.fun's page says
the program assigns the platform's withhold authority at creation); a program-derived address (off the ed25519 curve,
so no private key exists) is then "launchpad-run", a keypair wallet "launchpad-assigned". Off the curve alone says no
key exists, not which program controls it: without the sample nothing is settled.
Writes `facts/stonkfun-fee-authority-<date>.md` with every receipt. Nothing is scored or changed; the engine's verified
list (`stage2/readers.py`) is edited by hand on this evidence, in a copy, for the team.
"""
from __future__ import annotations
import datetime, json, os, sys, urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
ENGINE = os.path.dirname(HERE)
sys.path.insert(0, os.path.join(ENGINE, "stage2"))
sys.path.insert(0, os.path.join(ENGINE, "scanner"))

SYSTEM_PROGRAM = "11111111111111111111111111111111"
SAMPLE_URL = "https://www.stonkfun.xyz/api/public/v1/tokens?mode=reward&sort=newest&pageSize=10"
MIN_SAMPLE, MIN_CREATORS = 5, 3


def judge(authority: str, account: dict | None, on_curve: bool, sample: list) -> dict:
    """The plain judgement. `account` is {"owner", "size"} or None (no such account); `sample` is a list of
    {"mint", "authority", "fee_bps", "creator"} as read from the chain. Returns {"verdict", "words", "counts"}."""
    named = [s for s in sample if s.get("authority") == authority]
    creators = {s["creator"] for s in named if s.get("creator")}
    counts = {"sample": len(sample), "naming_it": len(named), "creators": len(creators)}
    derived = "a program-derived address (off the ed25519 curve, so no private key exists; only a program can act for it)"
    if not on_curve:
        # J1: off the curve says no key exists, not which program controls it; the launchpad's own launches must name it
        if len(sample) >= MIN_SAMPLE and len(named) == len(sample) and len(creators) >= MIN_CREATORS:
            return {"verdict": "launchpad-run", "counts": counts,
                    "words": f"{derived}, and every one of {len(sample)} reward launches by {len(creators)} different creators names it as the withheld-fee authority: launchpad-run"}
        if sample and len(named) < len(sample):
            return {"verdict": "not consistent", "counts": counts,
                    "words": f"{derived}; only {len(named)} of {len(sample)} reward launches name it: not platform context without more evidence"}
        return {"verdict": "not settled", "counts": counts,
                "words": f"{derived}; which program controls it, and whether the launchpad's launches name it, is not shown by the sample ({len(sample)} launches, {len(creators)} creators): not settled"}
    kind = ("no account on chain" if account is None else
            "a plain wallet (owned by the System Program, no data)" if account.get("owner") == SYSTEM_PROGRAM and not account.get("size") else
            f"an account owned by {account.get('owner')} ({account.get('size')} bytes)")
    if len(sample) < MIN_SAMPLE:
        return {"verdict": "not settled", "counts": counts, "words": f"{kind}; the sample is too small ({len(sample)} reward launches, {MIN_SAMPLE} needed): not settled"}
    if len(named) < len(sample):
        return {"verdict": "not consistent", "counts": counts,
                "words": f"{kind}; only {len(named)} of {len(sample)} reward launches name it as their withheld-fee authority: not platform context without more evidence"}
    if len(creators) < MIN_CREATORS:
        return {"verdict": "not settled", "counts": counts,
                "words": f"{kind}; all {len(sample)} launches name it, but by only {len(creators)} creator(s) ({MIN_CREATORS} needed to rule out one dev's own wallet): not settled"}
    return {"verdict": "launchpad-assigned", "counts": counts,
            "words": f"{kind}; every one of {len(sample)} reward launches, by {len(creators)} different creators, names it as the withheld-fee authority, which a creator cannot choose (the launchpad's program assigns it at creation): launchpad-assigned, platform context"}


def page(authority: str, account: dict | None, on_curve: bool, sample: list, result: dict, when: str) -> str:
    lines = [f"# Stonk.fun's reward-mode fee authority: is it launchpad-run? ", "",
             "Read-only chain reads on the operator's yes; every figure carries its receipt. No value here is a secret.", "",
             f"**Result: {result['verdict'].upper()}.** {result['words']}", "",
             "## The account itself",
             f"- Address `{authority}` (Stonk.fun's page names it as `modes.reward.withdrawWithheldAuthority`; the engine's list carries it since 2026-10-03).",
             f"- On the ed25519 curve: **{'yes (a keypair can exist)' if on_curve else 'no (program-derived)'}** (computed from the key itself, `stage2/b58.py` `oc`).",
             ("- Account: none on chain (getAccountInfo returned nothing)." if account is None else
              f"- Account: owner `{account.get('owner')}`, {account.get('size')} bytes, lamports {account.get('lamports')}, slot {account.get('slot')} (getAccountInfo)."),
             "", "## The sample of reward-mode mints (each read from the mint on chain; creator from its LaunchLab pool)",
             "| Mint | Withheld-fee authority on the mint | Fee (bps) | Creator | Source of the mint |", "|---|---|---|---|---|"]
    for s in sample:
        lines.append(f"| `{s.get('mint')}` | `{s.get('authority')}` | {s.get('fee_bps')} | `{s.get('creator')}` | {s.get('from')} |")
    lines += ["", f"Counts: {json.dumps(result['counts'])}.", "",
              "## What this means for the engine",
              "The authorities grade treats a power held by a verified launchpad wallet as platform context, not as the dev's (rules: Contract authorities; `stage2/readers.py`, `VERIFIED_LAUNCHPAD_WALLETS`). "
              + ("This evidence keeps the entry." if result["verdict"] in ("launchpad-run", "launchpad-assigned") else "This evidence does NOT support the entry on its own; the entry stays only on the 2026-10-03 evidence until the team says otherwise.")]
    return "\n".join(lines) + "\n"


def _sample_mints() -> list:
    """The newest reward-mode mints from Stonk.fun's keyless list; [] if the shape is not recognised."""
    import stonkfun
    req = urllib.request.Request(SAMPLE_URL, headers={"accept": "application/json", "user-agent": "PINR scanner"})
    with urllib.request.urlopen(req, timeout=10) as r:
        d = json.load(r)
    items = next((d[k] for k in ("tokens", "items", "data", "results") if isinstance(d, dict) and isinstance(d.get(k), list)), d if isinstance(d, list) else [])
    out = []
    for it in items:
        if isinstance(it, dict):
            m = next((it[k] for k in stonkfun.MINT_KEYS if stonkfun._address(it.get(k))), None)
            if m and m not in out:
                out.append(m)
    return out[:10]


def main(argv):
    import readers as R
    from b58 import b58d, oc
    authority = R.STONKFUN_COLLECTOR
    log = R.Log()
    raw, owner, slot = R.account_raw(authority)
    account = None if raw is None else {"owner": owner, "size": len(raw), "slot": slot, "lamports": None}
    on_curve = oc(b58d(authority))
    mints = argv or _sample_mints()
    sample = []
    for m in mints:
        mi = R.read_mint(m, log) or {}
        pool = R.find_launchlab_pool(m, log)
        sample.append({"mint": m, "authority": mi.get("withdraw_withheld_authority"), "fee_bps": mi.get("transfer_fee_bps"),
                       "creator": pool["creator"] if pool else None, "from": "command line" if argv else "Stonk.fun list, mode reward, newest"})
    result = judge(authority, account, on_curve, sample)
    when = datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%d %H:%M UTC")
    out = os.path.join(ENGINE, "facts", f"stonkfun-fee-authority-{when[:10]}.md")
    open(out, "w").write(page(authority, account, on_curve, sample, result, when))
    print(f"{result['verdict'].upper()}: {result['words']}\nwritten {os.path.relpath(out, ENGINE)}")


if __name__ == "__main__":
    main(sys.argv[1:])
