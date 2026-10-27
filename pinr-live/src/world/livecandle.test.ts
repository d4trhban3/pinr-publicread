import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { foldPrice, withLiveHead, type Candle } from "./livecandle";
import { fillItem, LiveFeed } from "./livefeed";
import type { Item } from "./model";
import type { WireToken } from "../../server/translate";

/** the charts move with the stream's prices, no reload; a coin with no chart is not given one by price ticks. */
const T0 = 1_800_000_000; // seconds, on a 15-minute boundary
describe("live candles", () => {
  it("a price inside the newest candle moves its high, low and close; volume only from a trade", () => {
    const cs: Candle[] = [[T0, 1, 1.2, 0.9, 1.1, 500]];
    expect(foldPrice(cs, 900, 1.5, (T0 + 60) * 1000)).toBe(true);
    expect(cs).toEqual([[T0, 1, 1.5, 0.9, 1.5, 500]]);
    expect(foldPrice(cs, 900, 0.8, (T0 + 120) * 1000, { usd: 40 })).toBe(true);
    expect(cs).toEqual([[T0, 1, 1.5, 0.8, 0.8, 540]]);
  });
  it("a price past the newest candle opens the next one at the last close", () => {
    const cs: Candle[] = [[T0, 1, 1.2, 0.9, 1.1, 500]];
    foldPrice(cs, 900, 1.3, (T0 + 900 + 5) * 1000);
    expect(cs[1]).toEqual([T0 + 900, 1.1, 1.3, 1.1, 1.3, 0]);
  });
  it("an older price, a bad price, or a price with no chart to join changes nothing; a trade may start a chart", () => {
    const cs: Candle[] = [[T0, 1, 1.2, 0.9, 1.1, 500]];
    expect(foldPrice(cs, 900, 2, (T0 - 10) * 1000)).toBe(false);
    expect(foldPrice(cs, 900, 0, (T0 + 10) * 1000)).toBe(false);
    expect(foldPrice(cs, 900, NaN, (T0 + 10) * 1000)).toBe(false);
    expect(cs).toEqual([[T0, 1, 1.2, 0.9, 1.1, 500]]);
    const empty: Candle[] = [];
    expect(foldPrice(empty, 900, 1, T0 * 1000)).toBe(false);
    expect(foldPrice(empty, 900, 1, T0 * 1000, { usd: 25, start: true })).toBe(true);
    expect(empty).toEqual([[T0, 1, 1, 1, 1, 25]]);
  });
  it("the tracked line ends at the live price; a line too short, a bad or unchanged price is left as it is", () => {
    expect(withLiveHead([1, 2, 3], 4)).toEqual([1, 2, 3, 4]);
    expect(withLiveHead([1, 2, 3], 3)).toEqual([1, 2, 3]);
    expect(withLiveHead([1], 4)).toEqual([1]);
    expect(withLiveHead([1, 2], NaN)).toEqual([1, 2]);
  });
});

class FakeES {
  static last: FakeES | null = null;
  readyState = 1;
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  private on = new Map<string, (e: { data: string }) => void>();
  constructor(public url: string) {
    FakeES.last = this;
  }
  addEventListener(kind: string, fn: (e: { data: string }) => void): void {
    this.on.set(kind, fn);
  }
  emit(kind: string, data: unknown): void {
    this.on.get(kind)?.({ data: JSON.stringify(data) });
  }
  close(): void {}
}
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("the tracked line on tiles and Discover", () => {
  it("the live price is added in dollars and the line stays in ratios to its first point: no plunge to zero", () => {
    const it0 = { id: 1, hist: [], chart: [] } as unknown as Item;
    const t = { address: "A", score: null, coverage: 0, launchedAtMs: null, priceSeries: [3.6e-7, 3.7e-7, 3.65e-7, 3.8e-7], priceUsd: 3.9e-7 } as unknown as WireToken;
    fillItem(it0, t, 0.2, Date.now());
    expect(it0.chart.length).toBe(5);
    expect(it0.chart[0]).toBe(1);
    expect(it0.chart[4]).toBeCloseTo(3.9 / 3.6, 6);
    expect(Math.min(...it0.chart)).toBeGreaterThan(0.9);
    fillItem(it0, { ...t, priceUsd: 3.8e-7 }, 0.2, Date.now());
    expect(it0.chart.length).toBe(4); // the price equals the newest point: nothing added
  });
});

describe("the stream's prices reach the charts", () => {
  it("every price in a change message is handed on, with the time it was heard", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("EventSource", FakeES);
    vi.stubGlobal("fetch", async () => ({ ok: true, json: async () => ({ contract: "1.1", mode: "feed", asOfMs: 1, files: 0, problems: [], tokens: [{ address: "A", priceUsd: 1 }], stream: { boot: "aaaaaaaa", seq: 1 } }) }));
    const feed = new LiveFeed();
    for (let i = 0; i < 10; i++) await Promise.resolve();
    const got: [string, number, number | undefined][] = [];
    feed.onPrice((a, p, _t, usd) => got.push([a, p, usd]));
    FakeES.last!.emit("changes", { boot: "aaaaaaaa", seq: 2, seen: [{ address: "B", priceUsd: 3 }], score: [], graduation: [], tick: [{ address: "A", priceUsd: 2 }, { address: "A", valuationUsd: 9 }], gone: [], rest: [], restGone: [] });
    expect(got).toEqual([["B", 3, undefined], ["A", 2, undefined]]);
    // a curve coin's own trade arrives with its time and dollar amount, which lets it start a chart.
    FakeES.last!.emit("changes", { boot: "aaaaaaaa", seq: 3, seen: [], score: [], graduation: [], tick: [], gone: [], rest: [], restGone: [], trades: [{ address: "C", atMs: 5, side: "buy", priceUsd: 4, usd: 12 }] });
    expect(got.at(-1)).toEqual(["C", 4, 12]);
  });
  it("the page hands them to the coin page and to Discover; both fold them into what they show", () => {
    const main = readFileSync(join(import.meta.dirname, "..", "main.ts"), "utf8");
    expect(main).toMatch(/liveFeed\.onPrice\(\(address, price, atMs, usd\) => \{\n  coinPage\.livePrice\(address, price, atMs, usd\);\n  discover\.livePrice\(address, price, atMs, usd\);/);
    const page = readFileSync(join(import.meta.dirname, "..", "ui", "coinpage.ts"), "utf8");
    expect(page).toMatch(/if \(foldPrice\(candles, bucket, price, atMs, \{ usd, start: trade \}\)\) \{/);
    expect(page).toMatch(/bucket = res\.bucketSec \?\? /);
    expect(page).toMatch(/const trade = usd !== undefined;/);
    expect(readFileSync(join(import.meta.dirname, "..", "ui", "discover.ts"), "utf8")).toMatch(/foldPrice\(res\.candles as LiveCandle\[\], res\.bucketSec \?\? tfSec, price, atMs/);
  });
  it("each real trade the stream brings reaches the ribbons: the feed calls onTrade, the page notes it, both drawers use the real mode (a design decision)", () => {
    const read = (...p: string[]): string => readFileSync(join(import.meta.dirname, "..", ...p), "utf8");
    expect(read("world", "livefeed.ts")).toMatch(/for \(const fn of this\.tradeFns\) fn\(t\);/);
    expect(read("main.ts")).toMatch(/liveFeed\.onTrade\(\(t\) => \{\n  hearTrade\(t\.address, t\.side, t\.usd, t\.priceUsd, t\.atMs, Date\.now\(\)\);/);
    // the open coin page takes each trade at once too (price, the chart's current candle, Recent trades), one redraw a frame.
    expect(read("main.ts")).toMatch(/deepscan\.liveTrade\(t\);/);
    expect(read("ui", "deepscan.ts")).toMatch(/liveFrame = requestAnimationFrame/);
    for (const f of [["engine", "streams.ts"], ["ui", "discover.ts"]]) {
      const src = read(...f);
      expect(src, f.join("/")).toMatch(/ribbonMode\(it, /);
      expect(src, f.join("/")).toMatch(/stepReal\(/);
      expect(src, f.join("/")).toMatch(/COUNTED_DIM/);
    }
    expect(read("world", "cards.ts")).toMatch(/Each dot is one real trade/);
  });
});
