"""Reporting layer for corrected pair arithmetic.

Deliberately omits holder APR and CLMM reserve identities unless the required
allocation or tick-aware execution data is supplied.
"""
from __future__ import annotations
from dataclasses import dataclass
from pair_math_v2_1 import (
    QuoteAsset, Pool, SupplyBasis, RewardFlow, ExecutionCapacity,
    pool_inventory_fraction, pool_spot_price_usd,
    spot_implied_valuation_from_full_range_cpmm,
    reserve_q_per_selected_token, modeled_reward_usd, modeled_reward_q,
    average_daily_reward_q, kappa_daily, reward_reconciliation, missing_reward_inputs,
    reward_q_purchased_per_issued_token,
    annualized_reward_flow_over_valuation,
)


@dataclass(frozen=True)
class Evaluation:
    quote: QuoteAsset
    pool: Pool
    supply_basis: SupplyBasis
    flow: RewardFlow
    capacity: ExecutionCapacity


def evaluate(e: Evaluation) -> dict[str, object]:
    supply = e.pool.supply.selected(e.supply_basis)
    price_usd = pool_spot_price_usd(e.pool, e.quote)
    valuation = spot_implied_valuation_from_full_range_cpmm(
        e.pool, e.quote, e.supply_basis
    )
    reward_usd = modeled_reward_usd(e.flow)
    reconciliation = reward_reconciliation(e.flow, e.quote.spot_usd)

    return {
        "labels": {
            "valuation": f"spot-implied valuation using {e.supply_basis.value} supply",
            "pool_fraction": "pool inventory fraction; not verified lock fraction",
            "reward_density": "modeled Q purchased per issued token; not backing",
            "annualized_ratio": "annualized reward flow over valuation; not holder APR",
            "capacity": (
                f"execution capacity at {e.capacity.max_price_impact:.1%} max price impact"
            ),
        },
        "units": {
            "flow_window_days": e.flow.days,
            "capacity_horizon_days": e.capacity.horizon_days,
        },
        "pool": {
            "pool_id": e.pool.pool_id,
            "pool_type": e.pool.pool_type.value,
            "spot_price_usd": price_usd,
            "selected_supply": supply,
            "pool_inventory_fraction": pool_inventory_fraction(
                e.pool, e.supply_basis
            ),
            "reserve_q_per_selected_token": reserve_q_per_selected_token(
                e.pool, e.supply_basis
            ),
            "spot_implied_valuation_usd": valuation,
            "lp_lock_verified_fraction": e.pool.lp_lock_verified_fraction,
        },
        "reward": {
            "modeled_reward_usd": reward_usd,
            "modeled_reward_q": modeled_reward_q(e.flow, e.quote.spot_usd),
            "average_daily_reward_q": average_daily_reward_q(
                e.flow, e.quote.spot_usd
            ),
            "reward_q_purchased_per_issued_token": (
                reward_q_purchased_per_issued_token(
                    e.flow, supply, e.quote.spot_usd
                )
            ),
            "annualized_reward_flow_over_valuation": (
                annualized_reward_flow_over_valuation(
                    reward_usd, e.flow.days, valuation
                )
            ),
            "reconciliation": reconciliation,
            "unknown_inputs": missing_reward_inputs(e.flow),
        },
        "execution": {
            "capacity_q": e.capacity.capacity_q,
            "max_price_impact": e.capacity.max_price_impact,
            "timestamp": e.capacity.timestamp,
            "venues": e.capacity.venues,
            "kappa_daily": kappa_daily(e.flow, e.capacity, e.quote.spot_usd),
        },
        "omitted_without_evidence": [
            "holder APR",
            "wallet reward estimate",
            "CLMM valuation from raw reserves",
            "verified liquidity permanence",
            "price-impact prediction from kappa alone",
        ],
    }
