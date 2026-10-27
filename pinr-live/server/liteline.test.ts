import { describe, expect, it } from "vitest";
import { FROM_CHANGES, FROM_TICKS, LiteFill, lineFromChanges, type TickSource } from "./liteline";
import type { PriceChanges } from "./quotes";
import type { WireToken } from "./translate";

const M = "A7rRfLf67GMp5DFeY7s4kUaZLZbbz6UFPM5XYSg2pump";
const tok = (o: Partial<WireToken> = {}): WireToken => ({ address: M, chain: "solana", launchpad: "Pump.fun curve", name: "Coin", ticker: "$C", imageUrl: null, score: null, coverage: 0, noScoreLabel: null, note: null, valuationUsd: 1, volume24hUsd: 1, change24hPct: 1, priceSeries: null, launchedAtMs: 1, asOfMs: 1, rank: 1, priceUsd: 1, liquidityUsd: 1, quotePair: null, changeWindowH: null, priceSource: null, flow: null, lastTradeMs: null, ...o }) as WireToken;
const noTicks: TickSource = { lastTradeMs: () => null, candles: () => null };
const ch = (o: Partial<PriceChanges> = {}): PriceChanges => ({ m5: 1, h1: 5, h6: -10, h24: 100, ...o });

describe("a line from DexScreener's measured changes", () => {
  it("starts at the price 24 hours ago, ends at the price now, and stays positive", () => {
    const l = lineFromChanges(1, ch())!;
    expect(l).toHaveLength(24);
    expect(l[0]).toBeCloseTo(0.5, 6); // +100% over 24h
    expect(l[23]).toBeCloseTo(1, 6);
    expect(l.every((n) => n > 0)).toBe(true);
  });
  it("lies on the measured prices: with 6 h ago at -10% the line's high is 1/0.9 and its low is the price now", () => {
    const l = lineFromChanges(1, ch({ h24: 0, h1: 0, m5: 0 }))!;
    expect(Math.min(...l)).toBeCloseTo(1, 6);
    expect(Math.max(...l)).toBeCloseTo(1 / 0.9, 2);
  });
  it("needs at least three prices reaching back an hour, else none", () => {
    expect(lineFromChanges(1, null)).toBeNull();
    expect(lineFromChanges(1, ch({ h24: null, h6: null, h1: null }))).toBeNull(); // 5 minutes only
    expect(lineFromChanges(1, ch({ h24: null, h6: null }))).toHaveLength(24); // a young coin: the hour it has
    expect(lineFromChanges(1, { m5: null, h1: null, h6: null, h24: 50 })).toBeNull(); // two prices only
    expect(lineFromChanges(0, ch())).toBeNull();
    expect(lineFromChanges(1, ch({ h24: -100 }))).not.toBeNull(); // -100 is not a measured change: that point is dropped, the rest stand
  });
});

describe("the lite fill (decision: tick files first, then DexScreener's changes)", () => {
  const ticksWith = (closes: number[], last: number | null): TickSource => ({ lastTradeMs: () => last, candles: () => ({ candles: closes.map((c, i) => [i * 900, c, c, c, c, 1] as never), bucketSec: 900 }) });
  it("fills the last-trade time and a line from the engine's ticks", () => {
    const f = new LiteFill(ticksWith([1, 2, 3, 4, 5], 1_000), () => 150, () => null).apply([tok()])[0]!;
    expect(f.lastTradeMs).toBe(1_000);
    expect(f.priceSeries).toEqual([1, 2, 3, 4, 5]);
    expect(f.priceSource).toBe(FROM_TICKS);
  });
  it("falls back to DexScreener's changes when the ticks are too few, and says so", () => {
    const f = new LiteFill(ticksWith([1, 2], null), () => 150, () => ch()).apply([tok()])[0]!;
    expect(f.priceSeries).toHaveLength(24);
    expect(f.priceSource).toBe(FROM_CHANGES);
    expect(f.lastTradeMs).toBeNull();
  });
  it("never replaces a line or a time that is already there", () => {
    const t = tok({ priceSeries: [1, 2, 3], priceSource: "GeckoTerminal", lastTradeMs: 5 });
    expect(new LiteFill(ticksWith([9, 9, 9, 9], 99), () => 150, () => ch()).apply([t])[0]).toBe(t);
  });
  it("leaves a coin with no source alone, and skips copies and other chains", () => {
    expect(new LiteFill(noTicks, () => 150, () => null).apply([tok()])[0]!.priceSeries).toBeNull();
    const vamp = tok({ noScoreLabel: "VAMP" });
    const lf = new LiteFill(ticksWith([1, 2, 3, 4], 9), () => 150, () => ch());
    expect(lf.apply([vamp])).toEqual([vamp]);
    // another chain: no tick file or last-trade time (those are Solana curve coins'), but DexScreener's measured changes still draw its line
    const base = lf.apply([tok({ chain: "base" })])[0]!;
    expect(base.lastTradeMs).toBeNull();
    expect(base.priceSeries).toHaveLength(24);
    expect(base.priceSource).toBe(FROM_CHANGES);
  });
});
