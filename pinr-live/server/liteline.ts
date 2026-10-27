import type { Candle } from "../src/world/livecandle.ts";
import type { PriceChanges } from "./quotes.ts";
import type { WireToken } from "./translate.ts";
import { isVamp } from "./vamp.ts";

/**
 * The lite line and the last-trade time for a coin that has none from the engine or a market service (operator: "why am i not seeing any chart
 * activity"). Only measured things, in this order: the engine's tick file (the coin's own trades on the chain), then the price changes DexScreener
 * measured over 5 minutes, 1, 6 and 24 hours. Every point of the second line is a price DexScreener's own figures give; the points between them are
 * straight lines, and the line says where it came from (`priceSource`). Nothing is made up: a coin with neither source keeps no line.
 */
const HOURS_BACK = { m5: 5 / 60, h1: 1, h6: 6, h24: 24 } as const;
export const FROM_CHANGES = "DexScreener changes";
export const FROM_TICKS = "Solana chain";
const STEPS = 24;
/** Fewer closes than this is not a line worth drawing. */
const MIN_CLOSES = 4;

export interface TickSource {
  lastTradeMs(mint: string): number | null;
  candles(mint: string, bucketSec: number, limit: number, solUsd: number | null): { candles: Candle[]; bucketSec: number } | null;
}

/** The prices at the times DexScreener measured them, laid evenly from the oldest to now; null with too few to draw. */
export function lineFromChanges(priceUsd: number, ch: PriceChanges | null): number[] | null {
  if (!ch || !Number.isFinite(priceUsd) || priceUsd <= 0) return null;
  const known: { back: number; price: number }[] = [{ back: 0, price: priceUsd }];
  for (const k of ["m5", "h1", "h6", "h24"] as const) {
    const c = ch[k];
    if (c !== null && c !== undefined && Number.isFinite(c) && c > -100) known.push({ back: HOURS_BACK[k], price: priceUsd / (1 + c / 100) });
  }
  if (known.length < 3 || known[known.length - 1]!.back < 1) return null;
  known.sort((a, b) => b.back - a.back); // oldest first
  const span = known[0]!.back;
  const out: number[] = [];
  for (let i = 0; i < STEPS; i++) {
    const back = span * (1 - i / (STEPS - 1));
    let j = 0;
    while (j < known.length - 2 && known[j + 1]!.back > back) j++;
    const a = known[j]!;
    const b = known[j + 1]!;
    const w = a.back === b.back ? 1 : (a.back - back) / (a.back - b.back);
    const v = a.price + (b.price - a.price) * Math.min(1, Math.max(0, w));
    if (!(v > 0) || !Number.isFinite(v)) return null;
    out.push(v);
  }
  return out;
}

export class LiteFill {
  constructor(
    private ticks: TickSource,
    private solUsd: () => number | null,
    private changes: (t: WireToken) => PriceChanges | null,
  ) {}

  /** Fill only what is empty: a line or a time that is already there (an engine, service or tape figure) is never replaced. */
  apply(tokens: WireToken[]): WireToken[] {
    return tokens.map((t) => {
      if (!t.address || isVamp(t)) return t;
      let f = t;
      const sol = t.chain === "solana"; // the engine's tick files are Solana curve coins' own trades; DexScreener's and Jupiter's measured changes serve every chain
      if (sol && f.lastTradeMs === null) {
        const last = this.ticks.lastTradeMs(f.address);
        if (last !== null) f = { ...f, lastTradeMs: last };
      }
      if (f.priceSeries === null) {
        const cs = sol ? this.ticks.candles(f.address, 900, 96, this.solUsd()) : null;
        const closes = cs && cs.candles.length >= MIN_CLOSES ? cs.candles.map((c) => c[4]).filter((n) => Number.isFinite(n) && n > 0) : [];
        if (closes.length >= MIN_CLOSES) f = { ...f, priceSeries: closes, priceSource: FROM_TICKS };
        else {
          const line = f.priceUsd !== null ? lineFromChanges(f.priceUsd, this.changes(f)) : null;
          if (line) f = { ...f, priceSeries: line, priceSource: FROM_CHANGES };
        }
      }
      return f;
    });
  }
}
