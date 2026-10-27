"""REDACTED PUBLIC COPY.

The proprietary logic in this module (PINR Index rules, weights, caps, thresholds and their tuning) is withheld.
Signatures and data types are kept so the surrounding code still imports; calling a stubbed
function raises NotImplementedError."""
from __future__ import annotations
import os, sys
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'pinr-index'))
import score_engine_v1 as E
DOWN = {}
UP = {}
ORDER = []
OBSERVED = ()

def decide(evidence: list[dict]) -> dict:
    """Redacted in the public copy."""
    raise NotImplementedError('redacted: proprietary PINR logic is not included in the public copy')
