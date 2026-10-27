import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { GeckoPools, parseNewPools, POOL_EVERY_MS } from "./geckopools.ts";
import { BACKGROUND_CEILING, GeckoBudget } from "./geckobudget.ts";
import { cleanCoin, coinToken, PumpfunUniverse, RECORD_EVERY_MS, type PumpFetch } from "./pumpfun.ts";
import type { WireToken } from "./translate.ts";

// One real answer saved from GeckoTerminal (2026-10-15 00:53 UTC): the 20 newest Solana pools, 14 of them on the exchange "pump-fun".
const SAVED = JSON.parse(readFileSync(new URL("./fixtures/geckoterminal-new-pools.json", import.meta.url), "utf8"));
const NOW = Date.parse("2026-10-15T00:54:00Z");
const M1 = "EuQq6eT3nGU2pH6RAxksVkXaGs4xpnrH3qz4o4jrpump";

describe("the pool of new coins, read from a saved GeckoTerminal answer", () => {
  const coins = parseNewPools(SAVED, NOW);
  it("keeps the bonding-curve pools only, each with a mint, a creation time, name, symbol and size", () => {
    expect(coins).toHaveLength(14);
    const c = coins.find((x) => x.mint === M1)!;
    expect(c).toBeTruthy();
    expect(c.name).toBe("gobwins");
    expect(c.symbol).toBe("gobwin");
    expect(c.createdMs).toBe(Date.parse("2026-10-15T00:52:30Z"));
    expect(c.capUsd).toBeCloseTo(4045.28, 1);
    expect(c.priceUsd).toBeGreaterThan(0);
    expect(c.graduated).toBe(false);
    for (const x of coins) expect(x.mint).toMatch(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/);
  });
  it("leaves what a pool does not give as missing: no creator, links, all-time high or last trade", () => {
    const c = coins[0]!;
    expect([c.creator, c.twitter, c.telegram, c.website, c.athCapUsd, c.lastTradeMs, c.curve]).toEqual([null, null, null, null, null, null, null]);
  });
  it("drops graduated and other exchanges' pools, and anything malformed", () => {
    expect(parseNewPools(null, NOW)).toEqual([]);
    expect(parseNewPools({ data: "x" }, NOW)).toEqual([]);
    const bad = { data: [{ attributes: { pool_created_at: "nope", fdv_usd: "5", base_token_price_usd: "1" }, relationships: { dex: { data: { id: "pump-fun" } }, base_token: { data: { id: "solana_x" } } } }], included: [] };
    expect(parseNewPools(bad, NOW)).toEqual([]);
  });
});

describe("the reader", () => {
  const ok = (): PumpFetch => async () => ({ status: 200, json: async () => SAVED });
  it("fills the pool, behind the same pool list the page and the scanner read", async () => {
    let now = NOW;
    const u = new PumpfunUniverse(undefined, () => now);
    const g = new GeckoPools(u, ok(), () => now);
    await g.tick();
    expect(u.size).toBe(14);
    const list = u.list("new", 50, 0);
    expect(list).toHaveLength(14);
    expect(list.every((c) => c.mint && c.createdMs > 0)).toBe(true);
    expect(list[0]!.createdMs).toBeGreaterThanOrEqual(list[list.length - 1]!.createdMs);
    expect(g.stats().lastPools).toBe(14);
  });
  it("asks at most every minute, rests two minutes after a refusal (doubling), and a failed page changes nothing", async () => {
    let now = NOW;
    const calls: number[] = [];
    let status = 200;
    const get: PumpFetch = async () => (calls.push(now), { status, json: async () => (status === 200 ? SAVED : {}), text: async () => "limit" });
    const u = new PumpfunUniverse(undefined, () => now);
    const g = new GeckoPools(u, get, () => now);
    const spy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      await g.tick();
      now += 10_000;
      await g.tick();
      expect(calls).toHaveLength(1);
      status = 429;
      now += POOL_EVERY_MS;
      await g.tick();
      expect(calls).toHaveLength(2);
      status = 200;
      now += POOL_EVERY_MS; // inside the two minutes' rest
      await g.tick();
      expect(calls).toHaveLength(2);
      now += 70_000;
      await g.tick();
      expect(calls).toHaveLength(3);
      expect(u.size).toBe(14);
    } finally {
      spy.mockRestore();
    }
  });
  it("every figure carries its true source and read time: GeckoTerminal's size and price are labelled GeckoTerminal, never Pump.fun", async () => {
    const now = NOW;
    const u = new PumpfunUniverse(undefined, () => now);
    await new GeckoPools(u, async () => ({ status: 200, json: async () => SAVED }), () => now).tick();
    const c = u.coin(M1)!;
    expect(c.figSource).toBe("GeckoTerminal");
    expect(c.figAtMs).toBe(now);
    const t = coinToken(c);
    expect([t.quoteSource, t.capSource, t.priceSource]).toEqual(["GeckoTerminal", "GeckoTerminal", "GeckoTerminal"]);
    expect([t.quoteAtMs, t.capAtMs]).toEqual([now, now]);
    const [filled] = u.fill([{ ...t, priceUsd: null, quoteSource: undefined, capSource: undefined, valuationUsd: null } as unknown as WireToken]);
    expect([filled!.quoteSource, filled!.capSource, filled!.quoteAtMs]).toEqual(["GeckoTerminal", "GeckoTerminal", now]);
  });
  it("a pool refresh never overwrites the figures Pump.fun's own record gave: they keep their source and read time", async () => {
    let now = 2_000_000_000_000;
    const rec = JSON.parse(readFileSync(new URL("./fixtures/CdgYz6aBCtUm2Fy5j4vbhBsDLRadEGJmuuTH6MMpump.fresh.json", import.meta.url), "utf8")).pumpfun_coin;
    const u = new PumpfunUniverse(async () => ({ status: 200, json: async () => rec }), () => now);
    const mint = rec.mint as string;
    const poolCoin = { ...cleanCoin(rec, now)!, figSource: "GeckoTerminal" as const, figAtMs: now, capUsd: 1111, priceUsd: 0.000001, athCapUsd: null, creator: null };
    u.ingest([poolCoin]);
    expect(u.coin(mint)!.figSource).toBe("GeckoTerminal");
    u.want([mint]);
    await u.tick(); // the record is read: its figures replace the pool's, labelled Pump.fun
    const readAt = now;
    expect(u.coin(mint)!.figSource).toBe("Pump.fun");
    const recCap = u.coin(mint)!.capUsd;
    expect(recCap).toBeCloseTo(15923.28, 1);
    now += 40_000;
    u.ingest([{ ...poolCoin, capUsd: 99_999, priceUsd: 0.5, figAtMs: now, seenMs: now }]);
    const kept = u.coin(mint)!;
    expect([kept.capUsd, kept.figSource, kept.figAtMs]).toEqual([recCap, "Pump.fun", readAt]);
    expect(kept.seenMs).toBe(now);
    expect(coinToken(kept).capSource).toBe("Pump.fun");
    expect(coinToken(kept).capAtMs).toBe(readAt);
  });
  it("a pool refresh never throws away what the coin's own record gave", async () => {
    let now = 2_000_000_000_000;
    const rec = JSON.parse(readFileSync(new URL("./fixtures/CdgYz6aBCtUm2Fy5j4vbhBsDLRadEGJmuuTH6MMpump.fresh.json", import.meta.url), "utf8")).pumpfun_coin;
    const get: PumpFetch = async () => ({ status: 200, json: async () => rec });
    const u = new PumpfunUniverse(get, () => now);
    // the coin arrives from a pool page, bare
    const bare = { ...cleanCoin(rec, now)!, creator: null, athCapUsd: null, twitter: null, figSource: "GeckoTerminal" as const };
    u.ingest([bare]);
    u.want([bare.mint]);
    await u.tick(); // its own record is read
    expect(u.coin(bare.mint)!.athCapUsd).toBeCloseTo(25350.32, 1);
    now += 40_000;
    u.ingest([{ ...bare, capUsd: 77_000, seenMs: now }]); // the next pool page
    const kept = u.coin(bare.mint)!;
    expect(kept.capUsd).toBeCloseTo(15923.28, 1); // the record's figure stays (see the next test)
    expect([kept.creator, kept.twitter]).toEqual([rec.creator, rec.twitter]);
    expect(kept.athCapUsd).toBeCloseTo(25350.32, 1);
  });
});

describe("a coin's own record (creator, links, picture, all-time high), one at a time", () => {
  const record = JSON.parse(readFileSync(new URL("./fixtures/CdgYz6aBCtUm2Fy5j4vbhBsDLRadEGJmuuTH6MMpump.fresh.json", import.meta.url), "utf8")).pumpfun_coin;
  it("is read for the coins on screen first, at most every 10 seconds, and fills the all-time high with its receipt", async () => {
    let now = 2_000_000_000_000;
    const asked: string[] = [];
    const get: PumpFetch = async (u) => (asked.push(u), { status: 200, json: async () => record });
    const uni = new PumpfunUniverse(get, () => now);
    const mint = record.mint as string;
    uni.want([mint]);
    await uni.tick();
    expect(asked).toHaveLength(1);
    expect(asked[0]).toContain(`/coins-v2/${mint}`);
    await uni.tick(); // inside the 10 s: nothing
    expect(asked).toHaveLength(1);
    const tok = { chain: "solana", address: mint, priceUsd: null, imageUrl: null, valuationUsd: null } as unknown as WireToken;
    const [filled] = uni.fill([tok]);
    expect(filled!.athUsd).toBeCloseTo(25350.32, 1);
    expect(filled!.athSource).toBe("Pump.fun");
    expect(filled!.athAtMs).toBe(now);
    now += RECORD_EVERY_MS + 1;
    await uni.tick(); // already read: not asked again within its keeping time
    expect(asked).toHaveLength(1);
  });
  it("a missing record (404) or a refusal never invents a figure, and a refusal rests the reader", async () => {
    let now = 2_000_000_000_000;
    let status = 404;
    const asked: string[] = [];
    const get: PumpFetch = async (u) => (asked.push(u), { status, json: async () => ({}) });
    const uni = new PumpfunUniverse(get, () => now);
    uni.want(["CdgYz6aBCtUm2Fy5j4vbhBsDLRadEGJmuuTH6MMpump", "3BhS4YSoWjqyqmiKrbpZv7pyQx3Xok7HHxeaG6zBpump"]);
    await uni.tick();
    now += RECORD_EVERY_MS + 1;
    status = 429;
    await uni.tick();
    expect(asked).toHaveLength(2);
    now += RECORD_EVERY_MS + 1; // inside the minute's rest
    await uni.tick();
    expect(asked).toHaveLength(2);
    const tok = { chain: "solana", address: "CdgYz6aBCtUm2Fy5j4vbhBsDLRadEGJmuuTH6MMpump", priceUsd: null, imageUrl: null } as unknown as WireToken;
    expect(uni.fill([tok])[0]!.athUsd).toBeUndefined();
    expect(cleanCoin({}, 1)).toBeNull();
  });

  it("rests twice as long for each refusal in a row (ten minutes at most), and a good page starts it over", async () => {
    let now = NOW;
    let status = 429;
    let n = 0;
    const get: PumpFetch = async () => (n++, { status, json: async () => (status === 200 ? SAVED : {}), text: async () => "limit" });
    const g = new GeckoPools(new PumpfunUniverse(undefined, () => now), get, () => now);
    const spy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      await g.tick(); // refusal 1: rests 2 minutes
      now += 119_000;
      await g.tick();
      expect(n).toBe(1);
      now += 2_000;
      await g.tick(); // refusal 2: rests 4 minutes
      expect(n).toBe(2);
      now += 239_000;
      await g.tick();
      expect(n).toBe(2);
      status = 200;
      now += 2_000;
      await g.tick(); // a good page
      expect(n).toBe(3);
      status = 429;
      now += POOL_EVERY_MS;
      await g.tick(); // refusal again: back to two minutes
      now += 119_000;
      await g.tick();
      expect(n).toBe(4);
    } finally {
      spy.mockRestore();
    }
  });

  it("makes no call while the shared allowance has no room for a background reader", async () => {
    let now = NOW;
    let n = 0;
    const get: PumpFetch = async () => (n++, { status: 200, json: async () => SAVED, text: async () => "" });
    const budget = new GeckoBudget(() => now);
    for (let i = 0; i < BACKGROUND_CEILING; i++) budget.record(); // the market reader and the charts have used it
    const g = new GeckoPools(new PumpfunUniverse(undefined, () => now), get, () => now, budget);
    await g.tick();
    expect(n).toBe(0);
    now += 61_000; // the minute has passed
    await g.tick();
    expect(n).toBe(1);
  });
});
