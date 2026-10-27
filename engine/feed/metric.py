"""REDACTED PUBLIC COPY.

The proprietary logic in this module (PINRscore rules, weights, caps, thresholds and their tuning) is withheld.
Signatures and data types are kept so the surrounding code still imports; calling a stubbed
function raises NotImplementedError."""
from __future__ import annotations
import json, os, sqlite3, time
HERE = os.path.dirname(os.path.abspath(__file__))
DB = os.path.join(HERE, 'metric.sqlite')
SIGNAL_PERIOD = None
MAX_POINTS = None
TIMEFRAME = ''

def _db():
    """Redacted in the public copy."""
    raise NotImplementedError('redacted: proprietary PINR logic is not included in the public copy')

def lines(points):
    """Redacted in the public copy."""
    raise NotImplementedError('redacted: proprietary PINR logic is not included in the public copy')

def _path(feed_dir: str, mint: str) -> str:
    """Redacted in the public copy."""
    raise NotImplementedError('redacted: proprietary PINR logic is not included in the public copy')

def _remove(feed_dir: str, mint: str) -> None:
    """Redacted in the public copy."""
    raise NotImplementedError('redacted: proprietary PINR logic is not included in the public copy')

def _publish(c, mint: str, feed_dir: str) -> bool:
    """Redacted in the public copy."""
    raise NotImplementedError('redacted: proprietary PINR logic is not included in the public copy')

def record(rec: dict, no_score_labels, feed_dir: str) -> bool:
    """Redacted in the public copy."""
    raise NotImplementedError('redacted: proprietary PINR logic is not included in the public copy')

def backfill(feed_dir: str, no_score_labels) -> tuple[int, int]:
    """Redacted in the public copy."""
    raise NotImplementedError('redacted: proprietary PINR logic is not included in the public copy')
if __name__ == '__main__':
    import feed_export as F
    print('tokens with readings, files written:', backfill(F.FEED_DIR, F.NO_SCORE_LABELS))
