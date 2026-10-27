import { describe, expect, it, vi } from "vitest";
import { cleanCoin, PumpfunUniverse, type PumpFetch } from "./pumpfun.ts";
import { translate } from "./translate.ts";

const M1 = "A7rRfLf67GMp5DFeY7s4kUaZLZbbz6UFPM5XYSg2pump";
const M2 = "Bvscx2uvsjcJ9YuMM95zFYvXQGDh9KKMdaLuAiPVNgj";
const row = (mint: string, over: Record<string, unknown> = {}) => ({ mint, name: "Goob", symbol: "GOOB", usd_market_cap: 4000, total_supply: 1e15, base_decimals: 6, created_timestamp: 1_791_670_000_000, last_trade_timestamp: 1_791_672_000_000, complete: false, image_uri: "https://i.example/a.png", creator: M2, ...over });

describe("cleanCoin", () => {
  it("works the price from market cap and stated supply and keeps only clean fields", () => {
    const c = cleanCoin(row(M1, { twitter: "javascript:alert(1)", website: "https://x.example/" }), 5)!;
    expect(c.priceUsd).toBeCloseTo(4e-6, 12);
    expect(c.twitter).toBeNull();
    expect(c.website).toBe("https://x.example/");
    expect(c.graduated).toBe(false);
  });
  it("drops rows with no usable price, a bad address, or a ban (never a zero)", () => {
    expect(cleanCoin(row(M1, { usd_market_cap: 0 }), 5)).toBeNull();
    expect(cleanCoin(row("../x"), 5)).toBeNull();
    expect(cleanCoin(row(M1, { is_banned: true }), 5)).toBeNull();
    expect(cleanCoin(row(M1, { total_supply: null }), 5)).toBeNull();
  });
});

/** These tests exercise the list sweeps, which are off by default now (Pump.fun's list address is behind a bot challenge). */
const sweeping = (u: PumpfunUniverse): PumpfunUniverse => ((u.listSweepsOn = true), u);

describe("PumpfunUniverse", () => {
  const fakeGet = (rows: unknown, status = 200, calls: string[] = []): PumpFetch => async (u) => (calls.push(u), { status, json: async () => rows });
  it("reads a sweep, lists coins by newest or biggest, and drops the bad rows", async () => {
    let now = 1_000_000;
    const u = sweeping(new PumpfunUniverse(fakeGet([row(M1, { usd_market_cap: 500 }), row(M2, { usd_market_cap: 9000, created_timestamp: 1_791_660_000_000 }), { mint: "bad" }]), () => now));
    await u.tick();
    expect(u.size).toBe(2);
    expect(u.list("new", 10, 0).map((c) => c.mint)).toEqual([M1, M2]);
    expect(u.list("top", 10, 0).map((c) => c.mint)).toEqual([M2, M1]);
  });
  it("rests for a minute when limited and does not ask again until then", async () => {
    let now = 1_000_000;
    const calls: string[] = [];
    const u = sweeping(new PumpfunUniverse(fakeGet([], 429, calls), () => now));
    await u.tick();
    now += 30_000;
    await u.tick();
    expect(calls).toHaveLength(1);
    now += 40_000;
    await u.tick();
    expect(calls.length).toBeGreaterThan(1);
  });
  it("fills a Solana roster token's missing price and picture, never replacing one", async () => {
    const u = sweeping(new PumpfunUniverse(fakeGet([row(M1)]), () => 1_000_000));
    await u.tick();
    const bare = translate({ mint: M1, chain: "solana", score: 30, display: "30", label: null, coverage: 0.5 }).token!;
    const [filled] = u.fill([bare]);
    expect(filled!.priceUsd).toBeCloseTo(4e-6, 12);
    expect(filled!.imageUrl).toBe("https://i.example/a.png");
    const priced = { ...bare, priceUsd: 1 };
    expect(u.fill([priced])[0]!.priceUsd).toBe(1);
  });
  it("the all-time-high market cap is Pump.fun's own stated figure with its receipt; a record without one (or a zero) gives none, never a guess (R1)", async () => {
    const u = sweeping(new PumpfunUniverse(fakeGet([row(M1, { ath_market_cap: 123456.5 }), row(M2, { ath_market_cap: 0 })]), () => 1_000_000));
    await u.tick();
    const t = (m: string) => translate({ mint: m, chain: "solana", score: 30, display: "30", label: null, coverage: 0.5, price_usd: 1 }).token!;
    const [a, b] = u.fill([t(M1), t(M2)]);
    expect(a).toMatchObject({ athUsd: 123456.5, athSource: "Pump.fun", athAtMs: 1_000_000, priceUsd: 1 });
    expect(b!.athUsd).toBeUndefined();
    expect(cleanCoin(row(M1), 5)!.athCapUsd).toBeNull();
    expect(cleanCoin(row(M1, { ath_market_cap: 99 }), 5)!.athCapUsd).toBe(99);
  });
  it("says what a failed list call answered, once a minute: the status and the first 200 characters, no control characters", async () => {
    let now = 1_000_000;
    const logs: string[] = [];
    const spy = vi.spyOn(console, "log").mockImplementation((m: string) => void logs.push(String(m)));
    try {
      const get: PumpFetch = async () => ({ status: 403, json: async () => ({}), text: async () => `Forbidden\u0007 ${"x".repeat(500)}` });
      const u = sweeping(new PumpfunUniverse(get, () => now));
      await u.tick();
      now += 20_000; // past the 15 s rest, inside the minute: no second line
      await u.tick();
      expect(logs).toHaveLength(1);
      expect(logs[0]).toContain("HTTP 403");
      expect(logs[0]).toContain("Forbidden x");
      expect(logs[0]).not.toMatch(/[\u0000-\u001f]/);
      expect(logs[0]!.length).toBeLessThan(300);
      expect(logs[0]).not.toContain("https://");
      now += 60_000;
      await u.tick();
      expect(logs).toHaveLength(2);
    } finally {
      spy.mockRestore();
    }
  });
});
