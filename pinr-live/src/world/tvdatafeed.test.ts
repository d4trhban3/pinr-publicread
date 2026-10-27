import { describe, expect, it } from "vitest";
import type { Candle } from "./livecandle";
import { createDatafeed, priceScaleFor, resolutionOf, SUPPORTED, type Bar, type FeedSource, type SymbolInfo } from "./tvdatafeed";
import { LIBRARY_PATH, TV_ADVANCED, widgetOptions } from "./tvadvanced";

const A = "A7rRfLf67GMp5DFeY7s4kUaZLZbbz6UFPM5XYSg2pump";
const candles = (n: number, sec = 900, t0 = 999_900): Candle[] => Array.from({ length: n }, (_, i) => [t0 + i * sec, 1 + i, 2 + i, 0.5 + i, 1.5 + i, 10] as Candle);
const source = (cs: Candle[] | null, over: Partial<FeedSource> = {}): FeedSource & { asked: string[] } => {
  const asked: string[] = [];
  return { asked, fetchCandles: async (a, tf) => (asked.push(`${a}|${tf}`), cs ? { candles: cs } : null), coin: (a) => (a === A ? { ticker: "$GOOB", name: "Goob", launchpad: "Pump.fun curve", priceUsd: 0.000004 } : null), ...over };
};
const resolve = (feed: ReturnType<typeof createDatafeed>["feed"], name = A): Promise<SymbolInfo> => new Promise((ok, no) => feed.resolveSymbol(name, ok, no));
const bars = (feed: ReturnType<typeof createDatafeed>["feed"], s: SymbolInfo, r: string, p: { from: number; to: number; countBack: number; firstDataRequest?: boolean }): Promise<{ bars: Bar[]; noData: boolean }> =>
  new Promise((ok, no) => feed.getBars(s, r, { firstDataRequest: true, ...p }, (b, m) => ok({ bars: b, noData: m.noData }), no));

describe("the TradingView datafeed over our candles (Advanced Charts adapter)", () => {
  it("onReady names the resolutions and the crypto type", async () => {
    const { feed } = createDatafeed(source(null));
    const c = await new Promise<{ supported_resolutions: string[]; symbols_types: { value: string }[] }>((ok) => feed.onReady(ok));
    expect(c.supported_resolutions).toEqual(["1", "5", "15", "60", "240", "1D"]);
    expect(c.symbols_types[0]!.value).toBe("crypto");
  });
  it("resolves a coin by its address into a 24x7 UTC crypto symbol with a price scale fine enough for a tiny price", async () => {
    const s = await resolve(createDatafeed(source(null)).feed);
    expect(s).toMatchObject({ name: "GOOB", ticker: A, description: "Goob", type: "crypto", session: "24x7", timezone: "Etc/UTC", exchange: "Pump.fun curve", has_intraday: true, data_status: "streaming" });
    expect(s.pricescale).toBe(10 ** 10); // $0.000004 needs ten digits
    expect(s.supported_resolutions).toEqual(SUPPORTED);
  });
  it("accepts EXCHANGE:ADDRESS and refuses an unknown symbol or junk", async () => {
    const { feed } = createDatafeed(source(null));
    expect((await resolve(feed, `PUMP:${A}`)).ticker).toBe(A);
    await expect(resolve(feed, "../x")).rejects.toBe("unknown symbol");
    await expect(resolve(feed, "B7rRfLf67GMp5DFeY7s4kUaZLZbbz6UFPM5XYSg2pump")).rejects.toBe("unknown symbol");
  });
  it("picks the price scale from the price", () => {
    expect(priceScaleFor(1)).toBe(10 ** 4);
    expect(priceScaleFor(150)).toBe(10 ** 2);
    expect(priceScaleFor(0.000004)).toBe(10 ** 10);
    expect(priceScaleFor(1e-20)).toBe(10 ** 12);
    expect(priceScaleFor(0)).toBe(100);
    expect(priceScaleFor(NaN)).toBe(100);
  });
  it("maps resolutions to timeframes", () => {
    expect(resolutionOf("15")).toEqual({ tf: "15m", sec: 900 });
    expect(resolutionOf("D")).toEqual({ tf: "1D", sec: 86_400 });
    expect(resolutionOf("3")).toBeNull();
  });
  it("gives bars in milliseconds within the asked range, oldest first, and asks the source once while fresh", async () => {
    const src = source(candles(10));
    const { feed } = createDatafeed(src);
    const s = await resolve(feed);
    const r = await bars(feed, s, "15", { from: 999_900 + 2 * 900, to: 999_900 + 6 * 900, countBack: 4 });
    expect(r.noData).toBe(false);
    expect(r.bars.map((b) => b.time)).toEqual([2, 3, 4, 5].map((i) => (999_900 + i * 900) * 1000));
    expect(r.bars[0]).toMatchObject({ open: 3, high: 4, low: 2.5, close: 3.5, volume: 10 });
    await bars(feed, s, "15", { from: 0, to: 9_999_999, countBack: 5 });
    expect(src.asked).toEqual([`${A}|15m`]);
  });
  it("tops up with older bars when the range holds fewer than countBack, and says noData when there is nothing", async () => {
    const { feed } = createDatafeed(source(candles(10)));
    const s = await resolve(feed);
    const r = await bars(feed, s, "15", { from: 999_900 + 8 * 900, to: 999_900 + 10 * 900, countBack: 5 });
    expect(r.bars).toHaveLength(5);
    expect(r.bars.map((b) => b.time)).toEqual(r.bars.map((b) => b.time).sort((a, b) => a - b));
    const none = await bars(feed, s, "15", { from: 0, to: 500, countBack: 5 });
    expect(none).toEqual({ bars: [], noData: true });
  });
  it("reports an error, never a made-up bar, when the coin has no candles or the resolution is unknown", async () => {
    const { feed } = createDatafeed(source(null));
    const s = await resolve(feed);
    await expect(bars(feed, s, "15", { from: 0, to: 9e9, countBack: 5 })).rejects.toBe("no chart for this coin");
    await expect(bars(feed, s, "3", { from: 0, to: 9e9, countBack: 5 })).rejects.toBe("no chart for this coin");
  });
  it("folds a live trade into the newest bar and tells every subscriber of that coin; an unsubscribed one hears nothing", async () => {
    let now = 5_000_000_000;
    const cs = candles(3, 900);
    const { feed, pushTrade } = createDatafeed(source(cs), () => now);
    const s = await resolve(feed);
    await bars(feed, s, "15", { from: 0, to: 9e9, countBack: 3 });
    const heard: Bar[] = [];
    const other: Bar[] = [];
    feed.subscribeBars(s, "15", (b) => heard.push(b), "uid1");
    feed.subscribeBars(s, "15", (b) => other.push(b), "uid2");
    const lastT = cs[2]![0];
    pushTrade(A, 9, lastT * 1000 + 1000, 25);
    expect(heard).toHaveLength(1);
    expect(heard[0]).toMatchObject({ time: lastT * 1000, high: 9, close: 9, volume: 35 });
    feed.unsubscribeBars("uid2");
    pushTrade(A, 8, lastT * 1000 + 2000, 5);
    expect(heard).toHaveLength(2);
    expect(other).toHaveLength(1);
    pushTrade("B7rRfLf67GMp5DFeY7s4kUaZLZbbz6UFPM5XYSg2pump", 1, lastT * 1000, 1);
    expect(heard).toHaveLength(2);
    now += 1;
  });
  it("opens a new bar when a trade falls in a later period, from the last close", async () => {
    const cs = candles(2, 900);
    const { feed, pushTrade } = createDatafeed(source(cs));
    const s = await resolve(feed);
    await bars(feed, s, "15", { from: 0, to: 9e9, countBack: 2 });
    const heard: Bar[] = [];
    feed.subscribeBars(s, "15", (b) => heard.push(b), "u");
    pushTrade(A, 7, (cs[1]![0] + 900) * 1000, 3);
    expect(heard[0]).toMatchObject({ time: (cs[1]![0] + 900) * 1000, open: cs[1]![4], close: 7, volume: 3 });
  });
});

describe("the switch and the licence's rules", () => {
  it("is off, so nothing loads until the library is granted", () => {
    expect(TV_ADVANCED).toBe(false);
  });
  it("never disables TradingView's logo, and offers one coin per page", () => {
    const o = widgetOptions(A, {}, "x", "dark");
    expect(JSON.stringify(o.disabled_features)).not.toMatch(/logo|attribution|branding/i);
    expect(JSON.stringify(o)).not.toMatch(/logo/i);
    expect(o.library_path).toBe(LIBRARY_PATH);
    expect(o.symbol).toBe(A);
    expect(o.autosize).toBe(true);
  });
});
