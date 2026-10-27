"""REDACTED PUBLIC COPY.

The proprietary logic in this module (PINRscore rules, weights, caps, thresholds and their tuning) is withheld.
Signatures and data types are kept so the surrounding code still imports; calling a stubbed
function raises NotImplementedError."""
from __future__ import annotations
import json, os, sys, time, traceback
HERE = os.path.dirname(os.path.abspath(__file__))
ENGINE = os.path.dirname(HERE)
sys.path[:0] = [HERE, os.path.join(ENGINE, 'stage4'), os.path.join(ENGINE, 'feed'), os.path.join(ENGINE, 'scanner')]
SCORABLE = {}
NO_TX_FROM_LIST = set()
RETRY_S = None
TRIES = None
READER_VER = {}
MAX_AGE_S = None

def rescore_older(c) -> int:
    """Redacted in the public copy."""
    raise NotImplementedError('redacted: proprietary PINR logic is not included in the public copy')

def candidates(c, g, now: float, limit: int=20, chain: str | None=None) -> list:
    """Redacted in the public copy."""
    raise NotImplementedError('redacted: proprietary PINR logic is not included in the public copy')

def hint(c, mint: str, block_of=None) -> dict | None:
    """Redacted in the public copy."""
    raise NotImplementedError('redacted: proprietary PINR logic is not included in the public copy')

def counts(out: dict) -> bool:
    """Redacted in the public copy."""
    raise NotImplementedError('redacted: proprietary PINR logic is not included in the public copy')

def writer(c, written: dict, results_dir: str | None=None, g=None):
    """Redacted in the public copy."""
    raise NotImplementedError('redacted: proprietary PINR logic is not included in the public copy')

def export(c, out: dict) -> str | None:
    """Redacted in the public copy."""
    raise NotImplementedError('redacted: proprietary PINR logic is not included in the public copy')

def score_one(c, mint: str, launchpad: str, now: float, scorer=None, block_of=None, results_dir: str | None=None, g=None, holders_fn=None) -> str:
    """Redacted in the public copy."""
    raise NotImplementedError('redacted: proprietary PINR logic is not included in the public copy')

def _named(out: dict) -> dict:
    """Redacted in the public copy."""
    raise NotImplementedError('redacted: proprietary PINR logic is not included in the public copy')

def _supply(chain: str, mint: str):
    """Redacted in the public copy."""
    raise NotImplementedError('redacted: proprietary PINR logic is not included in the public copy')

def holders_step(c, g, mint: str, out: dict, h: dict | None, holders_fn=None, supply_fn=None) -> int:
    """Redacted in the public copy."""
    raise NotImplementedError('redacted: proprietary PINR logic is not included in the public copy')
_LAST = {}

def one_pass(c, g, now: float, scorer=None, block_of=None, results_dir: str | None=None, holders_fn=None) -> dict:
    """Redacted in the public copy."""
    raise NotImplementedError('redacted: proprietary PINR logic is not included in the public copy')
