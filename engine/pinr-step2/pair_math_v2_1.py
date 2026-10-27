"""Corrected pair arithmetic.

Design rule: observed facts, accounting identities, execution estimates, and
scenario assumptions must remain separate. This module does not claim that raw
CLMM balances behave like full-range CPMM reserves.
"""
from __future__ import annotations
import re
from dataclasses import dataclass
from enum import Enum
from typing import Optional, Iterable


class PoolType(str, Enum):
    FULL_RANGE_CPMM = "full_range_cpmm"
    CLMM = "clmm"
    ORDER_BOOK = "order_book"


class SupplyBasis(str, Enum):
    TOTAL = "total"
    CIRCULATING = "circulating"
    EFFECTIVE_FLOAT = "effective_float"


@dataclass(frozen=True)
class Supply:
    total: float
    circulating: Optional[float] = None
    effective_float: Optional[float] = None
    burned: float = 0.0
    treasury: float = 0.0

    def selected(self, basis: SupplyBasis) -> float:
        values = {
            SupplyBasis.TOTAL: self.total,
            SupplyBasis.CIRCULATING: self.circulating,
            SupplyBasis.EFFECTIVE_FLOAT: self.effective_float,
        }
        value = values[basis]
        if value is None or value <= 0:
            raise ValueError(f"Missing positive supply for basis={basis.value}")
        return value


@dataclass(frozen=True)
class QuoteAsset:
    symbol: str
    spot_usd: float
    issued_supply: float


@dataclass(frozen=True)
class Pool:
    chain_id: str
    address: str
    name: str
    pool_type: PoolType
    quote_reserve_q: float
    meme_reserve_tokens: float
    supply: Supply
    base_mint: str = ""
    quote_mint: str = ""
    fee_tier_bps: Optional[int] = None
    lp_lock_verified_fraction: Optional[float] = None
    controller_id: Optional[str] = None

    @property
    def pool_id(self) -> str:
        # EVM addresses are hex and case-insensitive, so they are lowercased.
        # Solana (base58) and other chains are case-SENSITIVE: left untouched.
        addr = self.address
        if re.fullmatch(r"0[xX][0-9a-fA-F]+", addr):
            addr = addr.lower()
        return f"{self.chain_id}:{addr}"


@dataclass(frozen=True)
class ExecutionCapacity:
    """Externally measured or simulated capacity for a stated constraint."""
    horizon_days: float
    max_price_impact: float
    capacity_q: float
    timestamp: str
    venues: tuple[str, ...] = ()


@dataclass(frozen=True)
class RewardFlow:
    """Tax/reward flow for a token. Every input defaults to None = UNKNOWN.
    Nothing is assumed: a blank is never turned into 0% or 100%."""
    name: str
    days: float
    taxable_buy_usd: Optional[float] = None
    taxable_sell_usd: Optional[float] = None
    taxable_transfer_usd: Optional[float] = None
    buy_tax_rate: Optional[float] = None
    sell_tax_rate: Optional[float] = None
    transfer_tax_rate: Optional[float] = None
    collection_rate: Optional[float] = None
    conversion_rate: Optional[float] = None
    execution_rate: Optional[float] = None
    distribution_rate: Optional[float] = None
    average_q_purchase_price_usd: Optional[float] = None
    observed_q_purchased: Optional[float] = None
    q_queued: Optional[float] = None
    q_distributed: Optional[float] = None
    q_claimed: Optional[float] = None


_TAX_PARTS = (
    ("buy", "taxable_buy_usd", "buy_tax_rate"),
    ("sell", "taxable_sell_usd", "sell_tax_rate"),
    ("transfer", "taxable_transfer_usd", "transfer_tax_rate"),
)
_ETA_RATES = ("collection_rate", "conversion_rate", "execution_rate", "distribution_rate")


def validate_rate(name: str, value: float) -> None:
    if not 0 <= value <= 1:
        raise ValueError(f"{name} must be between 0 and 1")


def q_per_token_full_range_cpmm(pool: Pool) -> float:
    if pool.pool_type is not PoolType.FULL_RANGE_CPMM:
        raise ValueError("Raw reserve ratio is CPMM-only; use a tick-aware CLMM engine")
    if pool.meme_reserve_tokens <= 0:
        raise ValueError("meme_reserve_tokens must be positive")
    return pool.quote_reserve_q / pool.meme_reserve_tokens


def pool_spot_price_usd(pool: Pool, quote: QuoteAsset) -> float:
    return q_per_token_full_range_cpmm(pool) * quote.spot_usd


def pool_inventory_fraction(pool: Pool, basis: SupplyBasis) -> float:
    """Fraction of selected supply currently held by this pool; not lock proof."""
    return pool.meme_reserve_tokens / pool.supply.selected(basis)


def spot_implied_valuation_from_full_range_cpmm(
    pool: Pool, quote: QuoteAsset, basis: SupplyBasis
) -> float:
    """Spot-implied valuation, not realizable liquidation value."""
    return pool_spot_price_usd(pool, quote) * pool.supply.selected(basis)


def reserve_q_per_selected_token(pool: Pool, basis: SupplyBasis) -> float:
    """Normalization only; not redeemable backing."""
    return pool.quote_reserve_q / pool.supply.selected(basis)


def reported_valuation_variance_pct(
    reported_valuation_usd: float, token_price_usd: float, selected_supply: float
) -> float:
    calculated = token_price_usd * selected_supply
    if calculated <= 0:
        raise ValueError("Calculated valuation must be positive")
    return reported_valuation_usd / calculated - 1.0


def missing_reward_inputs(flow: RewardFlow) -> list[str]:
    """Names of the inputs that are unknown AND needed for the dollar reward.
    A tax part with a known 0% rate needs no volume figure."""
    missing: list[str] = []
    for _, amount_name, rate_name in _TAX_PARTS:
        rate = getattr(flow, rate_name)
        if rate is None:
            missing.append(rate_name)
        if rate != 0 and getattr(flow, amount_name) is None:
            missing.append(amount_name)
    for name in _ETA_RATES:
        if getattr(flow, name) is None:
            missing.append(name)
    return missing


def _validate_known_rates(flow: RewardFlow) -> None:
    for name in ("buy_tax_rate", "sell_tax_rate", "transfer_tax_rate") + _ETA_RATES:
        value = getattr(flow, name)
        if value is not None:
            validate_rate(name, value)


def expected_tax_usd(flow: RewardFlow) -> Optional[float]:
    """Tax in USD, or None if any needed input is unknown."""
    _validate_known_rates(flow)
    total = 0.0
    for _, amount_name, rate_name in _TAX_PARTS:
        rate = getattr(flow, rate_name)
        amount = getattr(flow, amount_name)
        if rate is None:
            return None
        if rate == 0:
            continue  # a known 0% tax contributes a known 0
        if amount is None:
            return None
        total += amount * rate
    return total


def effective_eta(flow: RewardFlow) -> Optional[float]:
    _validate_known_rates(flow)
    eta = 1.0
    for name in _ETA_RATES:
        value = getattr(flow, name)
        if value is None:
            return None
        eta *= value
    return eta


def modeled_reward_usd(flow: RewardFlow) -> Optional[float]:
    tax = expected_tax_usd(flow)
    eta = effective_eta(flow)
    if tax is None or eta is None:
        return None
    return tax * eta


def modeled_reward_q(flow: RewardFlow, fallback_q_price_usd: Optional[float] = None) -> Optional[float]:
    reward = modeled_reward_usd(flow)
    price = flow.average_q_purchase_price_usd or fallback_q_price_usd
    if reward is None or price is None:
        return None
    if price <= 0:
        raise ValueError("Q purchase price must be positive")
    return reward / price


def average_daily_reward_q(flow: RewardFlow, fallback_q_price_usd: Optional[float] = None) -> Optional[float]:
    if flow.days <= 0:
        raise ValueError("days must be positive")
    q = modeled_reward_q(flow, fallback_q_price_usd)
    return None if q is None else q / flow.days


def kappa_daily(
    flow: RewardFlow,
    capacity: ExecutionCapacity,
    fallback_q_price_usd: Optional[float] = None,
) -> Optional[float]:
    """Daily reward flow over daily execution capacity.
    Returns None (not a number) when capacity, horizon or the reward itself is
    missing or zero-capacity: missing data must never look like a finished number."""
    if capacity.horizon_days <= 0 or capacity.capacity_q <= 0:
        return None
    daily_q = average_daily_reward_q(flow, fallback_q_price_usd)
    if daily_q is None:
        return None
    return daily_q / (capacity.capacity_q / capacity.horizon_days)


def reward_q_purchased_per_issued_token(
    flow: RewardFlow, issued_supply: float, fallback_q_price_usd: Optional[float] = None
) -> Optional[float]:
    if issued_supply <= 0:
        raise ValueError("issued_supply must be positive")
    q = modeled_reward_q(flow, fallback_q_price_usd)
    return None if q is None else q / issued_supply


def reward_reconciliation(
    flow: RewardFlow, fallback_q_price_usd: Optional[float] = None
) -> dict[str, Optional[float]]:
    modeled = modeled_reward_q(flow, fallback_q_price_usd)
    observed = flow.observed_q_purchased
    variance = None if observed is None or modeled is None else observed - modeled
    variance_pct = None if variance is None or modeled == 0 else variance / modeled
    realized_eta = None
    tax = expected_tax_usd(flow)
    price = flow.average_q_purchase_price_usd or fallback_q_price_usd
    if observed is not None and price and tax:
        realized_eta = observed * price / tax
    return {
        "modeled_q": modeled,
        "observed_q": observed,
        "variance_q": variance,
        "variance_pct": variance_pct,
        "realized_eta": realized_eta,
    }


def annualized_reward_flow_over_valuation(
    reward_usd: Optional[float], days: float, selected_valuation_usd: float
) -> Optional[float]:
    """Protocol flow ratio, explicitly not holder APR. None if the reward is unknown."""
    if days <= 0 or selected_valuation_usd <= 0:
        raise ValueError("days and selected_valuation_usd must be positive")
    if reward_usd is None:
        return None
    return (reward_usd / days) * 365.0 / selected_valuation_usd


def shares_by_pool(pools: Iterable[Pool]) -> dict[str, float]:
    rows = list(pools)
    ids = [p.pool_id for p in rows]
    if len(set(ids)) != len(ids):
        raise ValueError("Duplicate immutable pool IDs")
    total = sum(p.quote_reserve_q for p in rows)
    return {p.pool_id: (p.quote_reserve_q / total if total > 0 else 0.0) for p in rows}


def hhi_from_shares(values: Iterable[float]) -> float:
    return sum(v * v for v in values)


def raw_quote_capture(total_meme_q: float, issued_quote_supply: float) -> float:
    if issued_quote_supply <= 0:
        raise ValueError("issued_quote_supply must be positive")
    return total_meme_q / issued_quote_supply
