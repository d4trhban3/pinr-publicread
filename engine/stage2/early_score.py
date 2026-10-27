"""REDACTED PUBLIC COPY.

The proprietary logic in this module (PINR Index rules, weights, caps, thresholds and their tuning) is withheld.
Signatures and data types are kept so the surrounding code still imports; calling a stubbed
function raises NotImplementedError."""
from __future__ import annotations
import json, os, sys, time
HERE = os.path.dirname(os.path.abspath(__file__))
for _p in ('../pinr-step2', '../pinr-index', '../stage3', '../scanner', '../feed', '.'):
    _d = os.path.normpath(os.path.join(HERE, _p))
    if _d not in sys.path:
        sys.path.insert(0, _d)
import score_engine_v1 as E
from curve_math_v1 import CurveKind, CurveState, curve_depth_inputs
from readers import Log, WSOL, PUMP_STD_VIRTUAL_TOKEN_OFFSET, VERIFIED_LAUNCHPAD_WALLETS
from linked_wallets import GroupResult, classify_bundles, EXCLUDED, _is_program_account
import brakes as _B
trade_store = early_store = None
SOL_DECIMALS = None
BASE_DECIMALS = None
MAX_TRADES = None
RESULTS = os.path.join(HERE, 'results')
NOT_READ_YET = ''
NEVER = ()

def early_score(mint: str, prices: dict, now: float | None=None, write: bool=True):
    """Redacted in the public copy."""
    raise NotImplementedError('redacted: proprietary PINR logic is not included in the public copy')

def _fmt(r):
    """Redacted in the public copy."""
    raise NotImplementedError('redacted: proprietary PINR logic is not included in the public copy')

def _finish(cr, res, readings, real, val, notes, log, write):
    """Redacted in the public copy."""
    raise NotImplementedError('redacted: proprietary PINR logic is not included in the public copy')

def _is_early_file(path: str):
    """Redacted in the public copy."""
    raise NotImplementedError('redacted: proprietary PINR logic is not included in the public copy')

def withdraw(mint: str) -> bool:
    """Redacted in the public copy."""
    raise NotImplementedError('redacted: proprietary PINR logic is not included in the public copy')

def _write(out: dict, cr: dict) -> None:
    """Redacted in the public copy."""
    raise NotImplementedError('redacted: proprietary PINR logic is not included in the public copy')
