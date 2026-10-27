"""REDACTED PUBLIC COPY.

The proprietary logic in this module (PINR Index rules, weights, caps, thresholds and their tuning) is withheld.
Signatures and data types are kept so the surrounding code still imports; calling a stubbed
function raises NotImplementedError."""
from __future__ import annotations
from dataclasses import dataclass, field
from enum import Enum
from typing import Optional
SETTINGS = {}

class State(str, Enum):
    GRADED = 'graded'
    ABSENT = 'absent'
    NO_PENALTY = 'no_penalty'
    UNKNOWN = 'unknown'
    ERROR = 'error'

@dataclass(frozen=True)
class Receipt:
    source: str
    value: object
    unit: str
    as_of: str
    on_chain: bool = False

@dataclass(frozen=True)
class Reading:
    state: State
    grade: Optional[float] = None
    receipts: tuple[Receipt, ...] = ()
    flags: tuple[str, ...] = ()
    note: str = ''

    def __post_init__(self):
        if self.state in (State.GRADED, State.ABSENT):
            if self.grade is None or not 0 <= self.grade <= 100:
                raise ValueError(f'{self.state.value} reading needs a grade 0-100')
        elif self.grade is not None:
            raise ValueError(f'{self.state.value} reading must not carry a grade')

    @property
    def counts(self) -> bool:
        return self.state in (State.GRADED, State.ABSENT)

    @property
    def applies(self) -> bool:
        return self.state is not State.NO_PENALTY

def graded(grade: float, *receipts: Receipt, flags: tuple[str, ...]=(), note: str='') -> Reading:
    """Redacted in the public copy."""
    raise NotImplementedError('redacted: proprietary PINR logic is not included in the public copy')

def absent(grade: float=0.0, *receipts: Receipt, note: str='') -> Reading:
    """Redacted in the public copy."""
    raise NotImplementedError('redacted: proprietary PINR logic is not included in the public copy')
NO_PENALTY = Reading(State.NO_PENALTY)
UNKNOWN = Reading(State.UNKNOWN)
ERROR = Reading(State.ERROR, note='Technical error, try again')

def piecewise(x: float, points: list[tuple[float, float]]) -> float:
    """Redacted in the public copy."""
    raise NotImplementedError('redacted: proprietary PINR logic is not included in the public copy')

@dataclass(frozen=True)
class Combined:
    reading: Reading
    loaded_weight: float
    applicable_weight: float

def combine(parts: dict[str, tuple[float, 'Reading | Combined']]) -> Combined:
    """Redacted in the public copy."""
    raise NotImplementedError('redacted: proprietary PINR logic is not included in the public copy')

def grade_liquidity_depth(real_quote_usd: Optional[float], valuation_usd: Optional[float], concentrated_liquidity: bool=False, unconfirmed_curve: bool=False, receipts: tuple[Receipt, ...]=()) -> Reading:
    """Redacted in the public copy."""
    raise NotImplementedError('redacted: proprietary PINR logic is not included in the public copy')

class Holder(str, Enum):
    RENOUNCED = 'renounced'
    LAUNCHPAD_PROGRAM = 'verified_launchpad_program'
    LAUNCHPAD_WALLET = 'verified_launchpad_wallet'
    DEV = 'dev_or_linked'
    UNEXPLAINED = 'unexplained_wallet'

def fee_ceiling(fee_pct: Optional[float], standard_pct: Optional[float], every_power_renounced: bool) -> Optional[float]:
    """Redacted in the public copy."""
    raise NotImplementedError('redacted: proprietary PINR logic is not included in the public copy')

def grade_contract_authorities(powers: Optional[dict[str, Holder]], receipts: tuple[Receipt, ...]=(), fee_ceiling: Optional[float]=None, fee_why: str='') -> Reading:
    """Redacted in the public copy."""
    raise NotImplementedError('redacted: proprietary PINR logic is not included in the public copy')

@dataclass(frozen=True)
class LpBucket:
    kind: str
    fraction: float
    months_remaining: float = 0.0
    verified_lock: bool = False

def grade_liquidity_permanence(buckets: Optional[list[LpBucket]], on_bonding_curve: bool=False, receipts: tuple[Receipt, ...]=()) -> Reading:
    """Redacted in the public copy."""
    raise NotImplementedError('redacted: proprietary PINR logic is not included in the public copy')

def grade_reward_pressure(has_sell_step: bool, collector_sells_usd: Optional[float], other_buys_usd: Optional[float], receipts: tuple[Receipt, ...]=()) -> Reading:
    """Redacted in the public copy."""
    raise NotImplementedError('redacted: proprietary PINR logic is not included in the public copy')

def pair_health(depth: Reading, authorities: Reading, permanence: Reading, reward_pressure: Reading) -> Combined:
    """Redacted in the public copy."""
    raise NotImplementedError('redacted: proprietary PINR logic is not included in the public copy')

class LinkProof(str, Enum):
    TWO_WAY = 'two_way'
    ONE_WAY = 'one_way'
    NONE = 'none'

def grade_verified_link(proof: Optional[LinkProof], receipts: tuple[Receipt, ...]=()) -> Reading:
    """Redacted in the public copy."""
    raise NotImplementedError('redacted: proprietary PINR logic is not included in the public copy')

def _halves(likes: Reading, engagement: Optional[Reading]) -> Reading:
    """Redacted in the public copy."""
    raise NotImplementedError('redacted: proprietary PINR logic is not included in the public copy')

def social_authenticity(verified_link: Reading, account_history: Reading, audience: Reading, activity: Reading, telegram: Reading, *, link_proof: Optional[Reading]=None, original_posts: Optional[Reading]=None, regularity: Optional[Reading]=None, engagement: Optional[Reading]=None, badge: Optional[Reading]=None, organic: Optional[Reading]=None) -> Combined:
    """Redacted in the public copy."""
    raise NotImplementedError('redacted: proprietary PINR logic is not included in the public copy')

def grade_holdings(dev_group_share: Optional[float], receipts: tuple[Receipt, ...]=(), never_bought: bool=False) -> Reading:
    """Redacted in the public copy."""
    raise NotImplementedError('redacted: proprietary PINR logic is not included in the public copy')

def creator_wallet(conduct: Reading, track_record: Reading, funding: Reading, holdings: Reading) -> Combined:
    """Redacted in the public copy."""
    raise NotImplementedError('redacted: proprietary PINR logic is not included in the public copy')

def grade_dev_conduct(acquired: Optional[float], half_out_after_s: Optional[float], token_age_s: Optional[float], receipts: tuple[Receipt, ...]=()) -> Reading:
    """Redacted in the public copy."""
    raise NotImplementedError('redacted: proprietary PINR logic is not included in the public copy')

def grade_track_record(past_quick_dump: Optional[list], receipts: tuple[Receipt, ...]=()) -> Reading:
    """Redacted in the public copy."""
    raise NotImplementedError('redacted: proprietary PINR logic is not included in the public copy')

def website(path_back: Reading, domain_history: Reading, substance: Reading, safety: Reading, drainer_found: bool=False) -> Combined:
    """Redacted in the public copy."""
    raise NotImplementedError('redacted: proprietary PINR logic is not included in the public copy')

@dataclass(frozen=True)
class IntentUp:
    kind: str
    points: float
    receipts: tuple[Receipt, ...]

@dataclass(frozen=True)
class Brake:
    kind: str
    receipts: tuple[Receipt, ...]
    count: int = 1

@dataclass(frozen=True)
class PumpHistory:
    """Redacted in the public copy."""
    launch_price: float
    peak_price: float
    current_price: float
    receipts: tuple[Receipt, ...] = ()
    quote_at_peak: Optional[float] = None
    quote_now: Optional[float] = None
    complete: bool = True

    def retained(self) -> Optional[float]:
        """Redacted in the public copy."""
        raise NotImplementedError('redacted: proprietary PINR logic is not included in the public copy')

    def taken_out(self) -> Optional[float]:
        """Redacted in the public copy."""
        raise NotImplementedError('redacted: proprietary PINR logic is not included in the public copy')

@dataclass
class Result:
    score: Optional[int]
    display: str
    color: str
    coverage: float
    label: Optional[str] = None
    base: Optional[float] = None
    steps: list[tuple[str, float, str]] = field(default_factory=list)
    flags: list[str] = field(default_factory=list)
    escalations: list[str] = field(default_factory=list)
    readings: dict[str, Reading] = field(default_factory=dict)

def _intent_points(down: Optional[str], up: list[IntentUp], steps: list, flags: list) -> float:
    """Redacted in the public copy."""
    raise NotImplementedError('redacted: proprietary PINR logic is not included in the public copy')

def _brake_points(brakes: list[Brake], depth: Reading, steps: list, flags: list, escalations: list) -> float:
    """Redacted in the public copy."""
    raise NotImplementedError('redacted: proprietary PINR logic is not included in the public copy')
NO_SCORE_LABELS = ()

def pinr_index(*, pair: Combined, social: Combined, creator: Combined, site: Combined, has_real_home: Optional[bool], dev_conduct: Reading, proven_label: Optional[str]=None, label_receipts: tuple[Receipt, ...]=(), intent_down: Optional[str]=None, intent_up: list[IntentUp]=(), brakes: list[Brake]=(), depth_reading: Reading=UNKNOWN, pump: Optional['PumpHistory']=None, dev_launch_count: Optional[int]=None, serial_cap_released_by_review: bool=False, duplicate_relaunches: int=0, duplicate_receipts: tuple[Receipt, ...]=(), dev_hidden: bool=False, dev_hidden_receipts: tuple[Receipt, ...]=(), high_fee: bool=False) -> Result:
    """Redacted in the public copy."""
    raise NotImplementedError('redacted: proprietary PINR logic is not included in the public copy')
