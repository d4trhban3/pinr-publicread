"""REDACTED PUBLIC COPY.

The proprietary logic in this module (PINR Index rules, weights, caps, thresholds and their tuning) is withheld.
Signatures and data types are kept so the surrounding code still imports; calling a stubbed
function raises NotImplementedError."""
from __future__ import annotations
import time
from typing import Optional
from dev_history import Helius, conduct_from_balances
from scan_c import dev_token_account, parse, rpc
QUICK_DUMP_SECONDS = None

def half_out_after(moves: list[dict], acquired: float, launch_ts: int) -> Optional[int]:
    """Redacted in the public copy."""
    raise NotImplementedError('redacted: proprietary PINR logic is not included in the public copy')

def quick_dump_in_window(moves: list[dict], launch_ts: int, window: int=QUICK_DUMP_SECONDS):
    """Redacted in the public copy."""
    raise NotImplementedError('redacted: proprietary PINR logic is not included in the public copy')

def window_moves(dev: str, mint: str, launch_ts: int, window: int=QUICK_DUMP_SECONDS):
    """Redacted in the public copy."""
    raise NotImplementedError('redacted: proprietary PINR logic is not included in the public copy')

def past_launch_dumps(dev: str, launches: list[dict], exclude_mint: str, h: Helius, max_n: int=20):
    """Redacted in the public copy."""
    raise NotImplementedError('redacted: proprietary PINR logic is not included in the public copy')
