import { describe, expect, it } from "vitest";
import { candlesFromSeries, changeWindowLabel, formatAsOf, formatCandleTime, formatPrice, formatPriceChange, formatPriceCompact, summarize } from "./format";
import type { Candle } from "../../server/market";

describe("price formatting", () => {
  it("shows tiny prices with enough digits to mean something", () => {
    expect(formatPrice(0.00000359)).toBe("$0.00000359");
    expect(formatPrice(0.0345)).toBe("$0.0345");
    expect(formatPrice(0.5)).toBe("$0.500");
    expect(formatPrice(12.3456)).toBe("$12.35");
    expect(formatPrice(1234.5)).toBe("$1,234.50");
  });
  it("missing stays a dash, never $0", () => {
    for (const v of [NaN, 0, -1, Infinity]) expect(formatPrice(v)).toBe("—");
    expect(formatPriceChange(NaN)).toBe("—");
  });
  it("shortens very small prices with a subscript zero count, and leaves the others alone", () => {
    expect(formatPriceCompact(0.0000000922)).toBe("$0.0₇922");
    expect(formatPriceCompact(0.00000359)).toBe("$0.0₅359");
    expect(formatPriceCompact(0.00012)).toBe("$0.000120");
    expect(formatPriceCompact(12.3456)).toBe("$12.35");
    expect(formatPriceCompact(NaN)).toBe("—");
  });
  it("signs a change", () => {
    expect(formatPriceChange(0.00000012)).toBe("+$0.000000120");
    expect(formatPriceChange(-1.2)).toBe("−$1.20");
  });
});

describe("chart numbers", () => {
  const c: Candle[] = [
    [100, 1, 2, 0.5, 1.5, 10],
    [200, 1.5, 3, 1, 2, 20],
    [300, 2, 2.5, 1.8, 2.2, 5],
  ];
  it("summarises candles", () => {
    expect(summarize(c)).toEqual({ open: 1, close: 2.2, high: 3, low: 0.5, volume: 35 });
    expect(summarize([])).toBeNull();
  });
  it("formats the time under the cursor", () => {
    const t = Date.UTC(2026, 9, 5, 15, 30) / 1000;
    expect(formatCandleTime(t, "ALL")).toMatch(/2026/);
    expect(formatCandleTime(t, "1D")).toMatch(/PM|AM/);
    expect(formatCandleTime(t, "3M")).not.toMatch(/PM|AM/);
  });
  it("makes candles from a plain series, ending now", () => {
    const k = candlesFromSeries([1, 2, 3], 1000, 100);
    expect(k.map((x) => x[0])).toEqual([900, 950, 1000]);
    expect(k[2]![4]).toBe(3);
  });

  it("a change over a coin's whole short life says since launch, not past day", () => {
    expect(changeWindowLabel("1D", 49)).toBe("Since launch (49 min)");
    expect(changeWindowLabel("1D", 300)).toBe("Since launch (5 h)");
    expect(changeWindowLabel("1W", 3 * 24 * 60)).toBe("Since launch (3 days)");
    expect(changeWindowLabel("1D", 3000)).toBe("Past day");
    expect(changeWindowLabel("1D", NaN)).toBe("Past day");
    expect(changeWindowLabel("ALL", 10)).toBe("Since launch (10 min)");
  });
});

describe("a figure that is not current says when it was read", () => {
  it("writes 'as of' and the clock time of the read, not of now", () => {
    const at = new Date(2026, 9, 16, 14, 32).getTime();
    expect(formatAsOf(at)).toBe("as of 2:32 PM");
  });
});
