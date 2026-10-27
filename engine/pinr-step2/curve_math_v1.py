"""Bonding-curve arithmetic (Stage 2 piece).

A token still on its launchpad curve has no normal pool. Its price comes from the
curve formula, which uses "virtual" (pretend) reserves. Liquidity depth must use only
the REAL quote money buyers deposited, never the virtual part.

Formulas, each checked against live mainnet state on 2026-10-04
(facts/launchpad-facts-2026-10-03.md, section 7):
- Pump.fun: constant product on virtual reserves.
    spot = virtual_sol_reserves / virtual_token_reserves
    real money = real_sol_reserves
- Raydium LaunchLab constant-product curve (curve_type 0):
    spot = (virtual_quote + real_quote) / (virtual_base - real_base)
    real money = real_quote (quote raised, excluding fees)
- LaunchLab fixed-price curve: spot = virtual_quote / virtual_base (from Raydium docs, not yet
  checked on chain).

Refused, because they are unconfirmed (missing stays missing):
- Pump.fun "mayhem mode" curves (their virtual reserves do not follow the standard rule)
- LaunchLab linear curves
- any curve that has completed / graduated (use the post-graduation pool instead)
"""
from __future__ import annotations
from dataclasses import dataclass
from enum import Enum
from typing import Optional


class CurveKind(str, Enum):
    PUMP_VIRTUAL_CPMM = "pump_virtual_cpmm"
    LAUNCHLAB_CONSTANT_PRODUCT = "launchlab_constant_product"
    LAUNCHLAB_FIXED_PRICE = "launchlab_fixed_price"
    LAUNCHLAB_LINEAR = "launchlab_linear"


@dataclass(frozen=True)
class CurveState:
    """Raw on-chain integers, exactly as read. Field meaning differs by launchpad:
    Pump.fun:  real_base = real_token_reserves (tokens still for sale on the curve)
    LaunchLab: real_base = base sold so far"""
    kind: CurveKind
    base_decimals: int
    quote_decimals: int
    total_supply_raw: int
    virtual_base_raw: int
    virtual_quote_raw: int
    real_base_raw: int
    real_quote_raw: int
    complete: bool = False
    mayhem_mode: bool = False


def _check(state: CurveState) -> None:
    if state.complete:
        raise ValueError("curve is complete; price the post-graduation pool instead")
    if state.mayhem_mode:
        raise ValueError("Pump mayhem-mode curve: pricing rule unconfirmed")
    if state.kind is CurveKind.LAUNCHLAB_LINEAR:
        raise ValueError("LaunchLab linear curve: pricing rule unconfirmed on chain")
    if state.total_supply_raw <= 0:
        raise ValueError("total supply must be positive")


def spot_price_quote_per_token(state: CurveState) -> float:
    """Price of one whole token in whole quote units (for example SOL or USDC)."""
    _check(state)
    scale = 10 ** (state.base_decimals - state.quote_decimals)
    if state.kind is CurveKind.PUMP_VIRTUAL_CPMM:
        if state.virtual_base_raw <= 0:
            raise ValueError("virtual token reserves must be positive")
        return state.virtual_quote_raw / state.virtual_base_raw * scale
    if state.kind is CurveKind.LAUNCHLAB_CONSTANT_PRODUCT:
        remaining = state.virtual_base_raw - state.real_base_raw
        if remaining <= 0:
            raise ValueError("virtual base minus base sold must be positive")
        return (state.virtual_quote_raw + state.real_quote_raw) / remaining * scale
    if state.kind is CurveKind.LAUNCHLAB_FIXED_PRICE:
        if state.virtual_base_raw <= 0:
            raise ValueError("virtual base must be positive")
        return state.virtual_quote_raw / state.virtual_base_raw * scale
    raise ValueError(f"unsupported curve kind {state.kind}")


def real_quote_deposited(state: CurveState) -> float:
    """Real quote money on the curve, in whole quote units. Never includes virtual reserves."""
    _check(state)
    return state.real_quote_raw / 10 ** state.quote_decimals


def curve_depth_inputs(state: CurveState, quote_usd: Optional[float]) -> tuple[Optional[float], Optional[float]]:
    """(real money in USD, spot-implied valuation in USD) for the liquidity-depth grade.
    Valuation uses total supply. Unknown quote price -> (None, None), never a guess."""
    price = spot_price_quote_per_token(state)
    real = real_quote_deposited(state)
    if quote_usd is None:
        return None, None
    if quote_usd <= 0:
        raise ValueError("quote price must be positive")
    supply_tokens = state.total_supply_raw / 10 ** state.base_decimals
    return real * quote_usd, price * supply_tokens * quote_usd
