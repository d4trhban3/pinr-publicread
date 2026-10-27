"""Solana honeypot detector. A token is a HONEYPOT only with proof that selling is blocked,
read from the token itself. Jupiter's "may not be sellable" warning is never enough on its own: it flagged
a token with live sells (a routing gap).

Proof, any one of:
  - the token is paused (Token-2022 pausable extension, paused = true)
  - new token accounts start frozen (default account state = frozen)
  - an active freeze authority (not renounced, not a verified launchpad) and holder accounts already frozen
EVM tokens (Stage 4): a failed sell simulation from an established checker is the proof.
"""
from __future__ import annotations
import os, sys
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "stage2"))
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "pinr-index"))
import score_engine_v1 as E


def judge(mint_info: dict, frozen_holders: int = 0, freeze_holder_class: str | None = None) -> tuple[bool, list[str]]:
    """Pure decision. mint_info: the parsed mint 'info' object. Returns (is_honeypot, reasons)."""
    reasons = []
    ext = {e["extension"]: (e.get("state") or {}) for e in mint_info.get("extensions", [])}
    if ext.get("pausableConfig", {}).get("paused") is True:
        reasons.append("token is paused: no transfers or sells possible")
    if str(ext.get("defaultAccountState", {}).get("accountState", "")).lower() == "frozen":
        reasons.append("new token accounts start frozen: buyers can't sell")
    if mint_info.get("freezeAuthority") and freeze_holder_class in ("dev_or_linked", "unexplained_wallet") and frozen_holders > 0:
        reasons.append(f"freeze authority active and {frozen_holders} holder account(s) frozen")
    return bool(reasons), reasons


def check(mint: str, mint_info: dict, freeze_holder_class: str | None, rpc) -> tuple[bool, tuple]:
    """Reads the top holder accounts' frozen state only when a freeze authority is active (cheap otherwise)."""
    frozen = 0
    if mint_info.get("freezeAuthority") and freeze_holder_class in ("dev_or_linked", "unexplained_wallet"):
        r = rpc("getTokenLargestAccounts", [mint])
        if isinstance(r, dict) and "value" in r:
            for a in r["value"][:20]:
                v = rpc("getAccountInfo", [a["address"], {"encoding": "jsonParsed"}])
                st = (((v or {}).get("value") or {}).get("data") or {}).get("parsed", {}).get("info", {}).get("state")
                frozen += st == "frozen"
    hp, reasons = judge(mint_info, frozen, freeze_holder_class)
    receipts = tuple(E.Receipt(f"getAccountInfo {mint}", why, "proof", "read time", True) for why in reasons)
    return hp, receipts
