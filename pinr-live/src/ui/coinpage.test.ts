import { describe, expect, it } from "vitest";
import { candleTime, changeFrom, changeText, chartLinks, DEFAULT_RANGE, keyStats, periodText, spanText, tradingViewHref } from "./coinpage";
import type { Item } from "../world/model";

const A = "A7rRfLf67GMp5DFeY7s4kUaZLZbbz6UFPM5XYSg2pump";

describe("the DeepScan page's links out for a full chart", () => {
  it("gives DexScreener, GeckoTerminal and, for a Pump.fun coin, its Pump.fun page", () => {
    expect(chartLinks({ address: A, chain: "solana", launchpad: "Pump.fun curve" })).toEqual([
      { label: "DexScreener", href: `https://dexscreener.com/solana/${A}` },
      { label: "GeckoTerminal", href: `https://www.geckoterminal.com/solana/tokens/${A}` },
      { label: "Pump.fun", href: `https://pump.fun/coin/${A}` },
      { label: "Solscan", href: `https://solscan.io/token/${A}` },
      { label: "TradingView", href: "https://www.tradingview.com/chart/" },
    ]);
    expect(chartLinks({ address: A, chain: "solana", launchpad: "PumpSwap (graduated)" }).map((l) => l.label)).toEqual(["DexScreener", "GeckoTerminal", "Pump.fun", "Solscan", "TradingView"]);
  });
  it("leaves the Pump.fun link off for another launchpad, and keeps to the chains the outside sites list", () => {
    expect(chartLinks({ address: A, chain: "solana", launchpad: "Raydium LaunchLab" }).map((l) => l.label)).toEqual(["DexScreener", "GeckoTerminal", "Solscan", "TradingView"]);
    expect(chartLinks({ address: "0x" + "a".repeat(40), chain: "base", launchpad: undefined }).map((l) => l.href)).toEqual([`https://dexscreener.com/base/0x${"a".repeat(40)}`, `https://www.geckoterminal.com/base/tokens/0x${"a".repeat(40)}`, `https://basescan.org/token/0x${"a".repeat(40)}`, "https://www.tradingview.com/chart/"]);
    expect(chartLinks({ address: A, chain: "somechain", launchpad: undefined })).toEqual([]);
    expect(chartLinks({ address: "", chain: "solana", launchpad: "Pump.fun" })).toEqual([]);
  });
  it("links a Base or BNB coin to its explorer and its launchpad's own page (Virtuals by the address the coin trades as)", () => {
    const V = "0xd839" + "0".repeat(30) + "ba42";
    expect(chartLinks({ address: V, chain: "base", launchpad: "Virtuals" }).find((l) => l.label === "Virtuals")?.href).toBe(`https://app.virtuals.io/prototypes/${V}`);
    expect(chartLinks({ address: V, chain: "base", launchpad: "Virtuals" }).map((l) => l.label)).toEqual(["DexScreener", "GeckoTerminal", "Basescan", "Virtuals", "TradingView"]);
    expect(chartLinks({ address: V, chain: "bsc", launchpad: "Virtuals" }).some((l) => l.label === "Virtuals")).toBe(false); // Virtuals here is Base only
    expect(chartLinks({ address: V, chain: "base", launchpad: "Zora" }).map((l) => l.label)).toContain("Zora");
  });
  it("encodes the address", () => {
    expect(chartLinks({ address: "a/b?c", chain: "solana", launchpad: undefined })[0]!.href).toBe("https://dexscreener.com/solana/a%2Fb%3Fc");
  });
});

describe("the DeepScan page's top", () => {
  it("starts on the day, the first of the ranges the server draws", () => {
    expect(DEFAULT_RANGE).toBe("1D");
  });
  it("labels a point on the scrub by its time: the day and the time under a day's candles, the date for a day", () => {
    const t = Date.UTC(2026, 9, 22, 14, 15) / 1000;
    expect(candleTime(t, 900)).toMatch(/^Oct 22, \d{1,2}:\d\d (AM|PM)$/);
    expect(candleTime(t, 86_400)).toBe("Oct 22, 2026");
  });
  it("measures the change from where the range starts, in price and percent, and says up or down", () => {
    expect(changeFrom(2, 3)).toEqual({ delta: 1, pct: 50, up: true });
    expect(changeFrom(4, 3)).toEqual({ delta: -1, pct: -25, up: false });
    expect(changeFrom(1, 1)).toEqual({ delta: 0, pct: 0, up: true });
    expect(changeFrom(0, 3)).toBeNull(); // no start to measure from
    expect(changeFrom(NaN, 3)).toBeNull();
    expect(changeFrom(2, NaN)).toBeNull();
  });
  it("writes the change with an arrow, the price move and the percent, and no plus sign", () => {
    expect(changeText({ delta: 1.5, pct: 3.6, up: true })).toBe("▲ $1.50 (3.6%)");
    expect(changeText({ delta: -1.5, pct: -3.6, up: false })).toBe("▼ $1.50 (3.6%)");
    expect(changeText({ delta: 0.0000012, pct: 12, up: true })).toMatch(/^▲ \$0\.0.*\(12\.0%\)$/);
  });
  it("shows the key stats with a dash for anything not known (missing stays missing)", () => {
    const it = { mcap: 1_200_000, volume24h: NaN, liquidity: 85_000, ath: NaN, ageMin: 125, launchpad: "Pump.fun curve", chain: "solana", change24h: -6.5, quotePair: "" } as unknown as Item;
    const m = Object.fromEntries(keyStats(it).map((s) => [s.label, s.value]));
    expect(m["Market cap"]).toBe("$1.20M");
    expect(m["Volume (24h)"]).toBe("—");
    expect(m["Liquidity"]).toBe("$85.0K");
    expect(m["All-time high"]).toBe("—");
    expect(m["Launched"]).toBe("2h ago");
    expect(m["Launchpad"]).toBe("Pump.fun curve");
    expect(m["Chain"]).toBe("Solana");
    expect(m["Change (24h)"]).toMatch(/6\.5%/);
    expect(m["Pair"]).toBe("—");
    expect(keyStats(it)).toHaveLength(9);
  });
  it("says a length of time in plain words", () => {
    expect(spanText(40)).toBe("1 min");
    expect(spanText(45 * 60)).toBe("45 min");
    expect(spanText(31 * 3600)).toBe("31 h");
    expect(spanText(3 * 86_400)).toBe("3 days");
  });
  describe("what the change is a change over", () => {
    const NOW = 1_800_000_000;
    const h = 3600;
    const base = { bucketSec: 900, nowSec: NOW };
    it("keeps the range's own words when the candles start where the range starts and run to now", () => {
      expect(periodText({ ...base, range: "1D", ageMin: 5 * 24 * 60, firstSec: NOW - 24 * h, lastSec: NOW - 900 })).toBe("Past day");
      expect(periodText({ ...base, range: "1W", ageMin: 30 * 24 * 60, firstSec: NOW - 7 * 24 * h, lastSec: NOW })).toBe("Past week");
    });
    it("says since launch for a coin younger than the range whose candles start at its launch", () => {
      expect(periodText({ ...base, range: "1D", ageMin: 49, firstSec: NOW - 49 * 60, lastSec: NOW - 900 })).toBe("Since launch (49 min)");
    });
    it("never says past day for a sparse answer: the real case, 6 tape candles from 91 h to 60 h ago on a 91-hour-old coin", () => {
      const label = periodText({ ...base, range: "1D", ageMin: 91 * 60, firstSec: NOW - 91 * h, lastSec: NOW - 60 * h - 900 });
      expect(label).toBe("Over 31 h, ending 60 h ago");
      expect(label).not.toMatch(/Past day|Since launch/);
    });
    it("bounds the first candle on both sides of the range's start: an early first candle with a fresh last one is another span", () => {
      expect(periodText({ ...base, range: "1D", ageMin: 91 * 60, firstSec: NOW - 91 * h, lastSec: NOW - 600 })).toBe("Over 4 days");
      expect(periodText({ ...base, range: "1W", ageMin: 90 * 24 * 60, firstSec: NOW - 30 * 86_400, lastSec: NOW - 900 })).toBe("Over 30 days");
      expect(periodText({ ...base, range: "1D", ageMin: 20 * 24 * 60, firstSec: NOW - 30 * h, lastSec: NOW - 900 })).toBe("Over 30 h"); // 30 h is not a day
      // and a first candle just either side of the start still counts as the range's own span
      expect(periodText({ ...base, range: "1D", ageMin: 20 * 24 * 60, firstSec: NOW - 24 * h - 900, lastSec: NOW - 900 })).toBe("Past day");
      expect(periodText({ ...base, range: "1D", ageMin: 20 * 24 * 60, firstSec: NOW - 23.5 * h, lastSec: NOW - 900 })).toBe("Past day"); // within 5% of the start
      expect(periodText({ ...base, range: "1D", ageMin: 20 * 24 * 60, firstSec: NOW - 22 * h, lastSec: NOW - 900 })).toBe("Over 22 h"); // 22 h is not a day
    });
    it("says the span when the candles start late for an old coin, and when a young coin's candles start long after its launch", () => {
      expect(periodText({ ...base, range: "1D", ageMin: 10 * 24 * 60, firstSec: NOW - 3 * h, lastSec: NOW - 900 })).toBe("Over 3 h");
      expect(periodText({ ...base, range: "1D", ageMin: 600, firstSec: NOW - 5 * h, lastSec: NOW - 900 })).toBe("Over 5 h");
    });
    it("says when the answer ended long ago even if it covered the range, and treats an unknown age as an old coin", () => {
      expect(periodText({ ...base, range: "1D", ageMin: 5 * 24 * 60, firstSec: NOW - 3 * 86_400, lastSec: NOW - 2 * 86_400 })).toBe("Over 24 h, ending 48 h ago");
      expect(periodText({ ...base, range: "1D", ageMin: NaN, firstSec: NOW - 24 * h, lastSec: NOW - 900 })).toBe("Past day");
      expect(periodText({ ...base, range: "1D", ageMin: NaN, firstSec: NOW - 2 * h, lastSec: NOW - 900 })).toBe("Over 2 h");
    });
  });
});

describe("the TradingView link", () => {
  it("opens the coin's own chart for a listed symbol and TradingView's chart page otherwise", () => {
    expect(tradingViewHref("RAYDIUMCLMM:BATTBONK_CPK8FQ.USD")).toBe("https://www.tradingview.com/chart/?symbol=RAYDIUMCLMM%3ABATTBONK_CPK8FQ.USD");
    for (const bad of [null, undefined, "", "x", "javascript:alert(1)", "A:b c"]) expect(tradingViewHref(bad)).toBe("https://www.tradingview.com/chart/");
  });
  it("sits last in every coin's link row on a chain the outside sites list", () => {
    expect(chartLinks({ address: A, chain: "solana", launchpad: "Clanker" }).map((l) => l.label).at(-1)).toBe("TradingView");
  });
});

describe("links out for Base and BNB Chain coins", () => {
  const E = "0x" + "b".repeat(40);
  it("gives each chain its own explorer and the launchpad's own page where it has one", () => {
    const names = (chain: string, launchpad: string): string[] => chartLinks({ address: E, chain, launchpad }).map((l) => l.label);
    expect(names("base", "Clanker")).toEqual(["DexScreener", "GeckoTerminal", "Basescan", "Clanker", "TradingView"]);
    expect(names("base", "Zora")).toEqual(["DexScreener", "GeckoTerminal", "Basescan", "Zora", "TradingView"]);
    expect(names("bsc", "Four.meme")).toEqual(["DexScreener", "GeckoTerminal", "BscScan", "Four.meme", "TradingView"]);
    expect(names("bsc", "Flap.sh")).toEqual(["DexScreener", "GeckoTerminal", "BscScan", "Flap", "TradingView"]);
    expect(names("bsc", "Other")).toEqual(["DexScreener", "GeckoTerminal", "BscScan", "TradingView"]);
    expect(chartLinks({ address: E, chain: "base", launchpad: "Clanker" }).find((l) => l.label === "Basescan")!.href).toBe(`https://basescan.org/token/${E}`);
    expect(chartLinks({ address: E, chain: "bsc", launchpad: "Flap.sh" }).find((l) => l.label === "Flap")!.href).toBe(`https://flap.sh/bnb/${E}`);
  });
});
