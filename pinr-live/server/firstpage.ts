/**
 * the first page puts coins with a score first, newest-scored first, then brand-new unscored coins, newest first; then the rest in
 * their own order. "New" is the last 24 hours, as in a coin scored days ago, or an unscored one met days ago, is in the rest. Plain and shared by the
 * feed server (the order of /api/tokens) and the site (the PINR page and Discovery's own lists), so both say the same thing.
 */
export const NEW_MS = 24 * 3600_000;

export interface FirstPageFacts {
  /** the coin has a PINR Index (a number) */
  scored: boolean;
  /** when it was last scored (ms) */
  scoredAtMs?: number | null;
  /** when PINR first met it unscored (a seen file), or when it launched, for a launchpad coin with no seen time (ms) */
  newAtMs?: number | null;
}

/** [group, time]: 0 = scored in the last day (by score time), 1 = unscored and new in the last day (by when met), 2 = the rest. Sort by group, then time, newest first. */
export function firstPageKey(f: FirstPageFacts, nowMs: number): [0 | 1 | 2, number] {
  const fresh = (t: number | null | undefined): t is number => typeof t === "number" && Number.isFinite(t) && nowMs - t <= NEW_MS && t <= nowMs + 60_000;
  if (f.scored && fresh(f.scoredAtMs)) return [0, f.scoredAtMs];
  if (!f.scored && fresh(f.newAtMs)) return [1, f.newAtMs];
  return [2, -Infinity];
}

/** The usual comparison: group first, then newest first; 0 for two coins in the rest (the caller's own order decides those). */
export function byFirstPage(a: [number, number], b: [number, number]): number {
  return a[0] - b[0] || (a[0] < 2 ? b[1] - a[1] : 0);
}
