"""until the coin's X check is done, the social parts read from the X account
wait; the social checks PINR reads itself keep counting for every coin. No weight, cap or figure changes: a part that
waits is a reading that does not apply (left out of the score's average and its coverage), carrying the notice.

Which part waits :
- verified link when the coin publishes no links (graded 0 from its own metadata): PINR's own read -> stays
- verified link when the metadata cannot be read (unknown): PINR's own read, failed -> stays (lowers coverage as before)
- verified link's two-way proof when links are published, account history, audience, activity, Telegram: read from
  the X account through the Grok relay -> wait
"""
from __future__ import annotations
import score_engine_v1 as E

SOCIAL_NOT_CHECKED = "Social: not checked yet"
PARTS = ("verified_link", "account_history", "audience", "activity", "telegram")     # the scorer's five readings, in order
EXTRA = ("link_proof", "original_posts", "regularity", "engagement", "badge", "organic")   # rules 0006 [265]: the X check's further parts


def waiting() -> "E.Reading":
    return E.Reading(E.State.NO_PENALTY, note=SOCIAL_NOT_CHECKED)


def social_parts(parts: dict, x_checked: bool, own_read: str) -> tuple[dict, bool]:
    """parts: {part: Reading} as the scorer built them. own_read: "none" (the coin publishes no links: the verified link
    was graded from its own metadata), "unreadable" (its metadata could not be read) or "links" (it publishes links: every
    part is the X account's). Returns (parts to score, whether any part waits)."""
    if x_checked or own_read == "none":
        return dict(parts), False                          # checked, or graded from PINR's own read: as before
    out = {p: waiting() for p in tuple(PARTS) + tuple(k for k in EXTRA if k in parts)}
    if own_read == "unreadable":
        out["verified_link"] = parts["verified_link"]      # PINR's own read failed: unknown, as before
        if "link_proof" in parts:
            out["link_proof"] = parts["verified_link"]
    return out, True
