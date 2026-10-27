import { describe, expect, it } from "vitest";
import { applyTradePrice, LIVE_PRICE_MS, overlayLive } from "./livefeed";
import type { Item } from "./model";

const item = (priceUsd: number, mcap: number): Item => ({ priceUsd, mcap }) as unknown as Item;

describe("a real trade moves its tile at once (\"as fast as robinhood app\")", () => {
  it("takes the trade's price and scales the market cap by the same ratio; no real price, no change", () => {
    const it1 = item(0.001, 100_000);
    applyTradePrice(it1, 0.0012);
    expect(it1.priceUsd).toBe(0.0012);
    expect(it1.mcap).toBeCloseTo(120_000, 6);
    applyTradePrice(it1, 0);
    applyTradePrice(it1, NaN);
    expect(it1.priceUsd).toBe(0.0012);
    const noCap = item(NaN, NaN);
    applyTradePrice(noCap, 0.5);
    expect(noCap.priceUsd).toBe(0.5);
    expect(Number.isNaN(noCap.mcap)).toBe(true); // missing stays missing
  });
  it("lays the newest trade price over a slower list price for a minute, then lets the list speak", () => {
    const by = new Map<string, Item>([["a", item(0.001, 100_000)]]);
    const live = new Map([["a", { priceUsd: 0.002, atMs: 1_000 }]]);
    overlayLive(by, live, 1_000 + 30_000);
    expect(by.get("a")!.priceUsd).toBe(0.002);
    expect(by.get("a")!.mcap).toBeCloseTo(200_000, 6);
    by.set("a", item(0.0015, 150_000)); // the next list, a little behind
    overlayLive(by, live, 1_000 + LIVE_PRICE_MS + 1);
    expect(by.get("a")!.priceUsd).toBe(0.0015); // the trade is too old to lay over
    expect(live.size).toBe(0);
  });
});
