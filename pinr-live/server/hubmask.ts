import { MAX_PRICE_USD, type WireToken } from "./translate.ts";
import type { Dossier, ObservedWord } from "./dossier.ts";

/**
 * PINR is the evidence hub, and the PINRscore is "no longer shown on pinr.io". The switch is the server's own setting
 * (`PINR_SHOW_SCORE=on` in the .env; off when absent), so no visitor can turn it on. While it is off, nothing served carries a score,
 * coverage-as-score, a score label (VAMP stays, as a fact about the coin) or a PINRbot field. The engine's files keep everything.
 */
export const scoreServed = (env: NodeJS.ProcessEnv = process.env): boolean => env.PINR_SHOW_SCORE === "on";

/**
 * The last guard on a price before it is served, whichever source filled it (the feed file, DexScreener, Jupiter, Pump.fun, GeckoTerminal, a chart's last candle):
 * a price per token above MAX_PRICE_USD is not a price, so it is missing.
 */
export function sanePrice(t: WireToken): WireToken {
  return t.priceUsd !== null && t.priceUsd !== undefined && t.priceUsd > MAX_PRICE_USD ? { ...t, priceUsd: null } : t;
}

/** One token as served while the score is off: no number, no coverage, no early flag, no label but VAMP, no note that goes with a label. */
export function maskToken(t0: WireToken, shown: boolean = scoreServed()): WireToken {
  const t = sanePrice(t0);
  if (shown) return t;
  const keep = t.noScoreLabel === "VAMP";
  const { early: _early, ...rest } = t;
  void _early;
  return { ...rest, score: null, coverage: 0, noScoreLabel: keep ? t.noScoreLabel : null, note: keep ? t.note : null };
}

/** A check's band as said while the score is off. A band is a judge's word; what was observed is not. */
export function observedBand(b: string): ObservedWord {
  if (b === "Weak" || b === "worth a closer look") return "worth a closer look";
  if (b === "Strong" || b === "Fair" || b === "Clear" || b === "observed") return "observed";
  return "not checked yet"; // "Not read" and anything else
}

/** The dossier as served while the score is off: PINRbot's reading is left out and each check carries the observed word, never the band. */
export function maskDossier(d: Dossier, shown: boolean = scoreServed()): Dossier {
  if (shown) return d;
  const { intent: _intent, ...rest } = d;
  void _intent;
  return { ...rest, checks: rest.checks.map((c) => ({ ...c, band: observedBand(c.band) })) };
}

/** The chart events as served while the score is off: only a measured surge stays; score moves, flags, "verified" and free notes are the score's story and are left out. */
export function maskEvents<T extends { kind: string }>(events: T[], shown: boolean = scoreServed()): T[] {
  return shown ? events : events.filter((e) => e.kind === "surge");
}
