import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { dexscreener, jupiter, pumpfun, providersFromEnv, QuoteWorker, type QuoteFetch, type QuoteProvider } from "./quotes.ts";
import { translate, type WireToken } from "./translate.ts";

const tok = (mint: string, chain: string, over: Record<string, unknown> = {}): WireToken =>
  translate({ mint, chain, score: 30, display: "30", label: null, coverage: 0.5, ...over }).token!;

const A = "0xaaa0000000000000000000000000000000000001";
const B = "0xbbb0000000000000000000000000000000000002";
const SOL = "So1anaMint11111111111111111111111111111111pump";

function fake(plan: (url: string) => { status: number; body?: unknown }): { get: QuoteFetch; calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    get: async (url) => {
      calls.push(url);
      const r = plan(url);
      return { status: r.status, json: async () => r.body ?? {} };
    },
  };
}

const pair = (addr: string, over: Record<string, unknown> = {}) => ({
  chainId: "bsc",
  baseToken: { address: addr, symbol: "AAA" },
  quoteToken: { symbol: "WBNB" },
  priceUsd: "0.5",
  priceChange: { h24: 12.5 },
  volume: { h24: 1000 },
  liquidity: { usd: 5000 },
  pairCreatedAt: 1_000_000,
  ...over,
});

describe("quote providers", () => {
  it("DexScreener: picks the deepest pair for each token, ignores unusable rows", async () => {
    const { get } = fake(() => ({
      status: 200,
      body: [pair(A, { priceUsd: "0.1", liquidity: { usd: 10 } }), pair(A, { priceUsd: "0.5", liquidity: { usd: 9000 } }), pair(B, { priceUsd: "0" }), pair("0xccc", { chainId: "base" })],
    }));
    const r = await dexscreener.fetch("bsc", [A, B], get);
    expect(r.status).toBe("ok");
    if (r.status !== "ok") return;
    expect(r.quotes.get(A)).toMatchObject({ priceUsd: 0.5, change24hPct: 12.5, volume24hUsd: 1000, liquidityUsd: 9000, pair: "AAA / WBNB" });
    expect(r.quotes.has(B)).toBe(false);
    expect(r.quotes.size).toBe(1);
  });
  it("answers limited on 429 and error on anything odd", async () => {
    expect((await dexscreener.fetch("bsc", [A], fake(() => ({ status: 429 })).get)).status).toBe("limited");
    expect((await dexscreener.fetch("bsc", [A], fake(() => ({ status: 500 })).get)).status).toBe("error");
    expect((await dexscreener.fetch("bsc", [A], fake(() => ({ status: 200, body: { nope: 1 } })).get)).status).toBe("error");
  });
  it("Jupiter: Solana prices keyed by address", async () => {
    const { get } = fake(() => ({ status: 200, body: { [SOL]: { usdPrice: 2e-6, priceChange24h: -50, liquidity: 3000, createdAt: "2026-10-06T00:00:00Z" } } }));
    const r = await jupiter.fetch("solana", [SOL], get);
    expect(r.status === "ok" && r.quotes.get(SOL.toLowerCase())).toMatchObject({ priceUsd: 2e-6, change24hPct: -50, liquidityUsd: 3000, volume24hUsd: null });
  });
  it("reads the provider list from settings and ignores unknown names", () => {
    expect(providersFromEnv(undefined).map((p) => p.id)).toEqual(["dexscreener", "pumpfun"]); // Jupiter's price API left the default: Jupiter Tokens v2 (jupmeta.ts) does that job
    expect(providersFromEnv("jupiter, nonsense ,dexscreener").map((p) => p.id)).toEqual(["jupiter", "dexscreener"]);
  });
});

describe("quote worker", () => {
  it("fills what the engine left out and never replaces the engine's own numbers", async () => {
    const a = tok(A, "bsc");
    const b = tok(B, "bsc", { price_usd: 9 });
    const { get } = fake(() => ({ status: 200, body: [pair(A), pair(B)] }));
    const now = 10_000_000;
    const w = new QuoteWorker([dexscreener], get, () => now);
    await w.tick([a, b]);
    const [x, y] = w.enrich([a, b]);
    expect(x).toMatchObject({ priceUsd: 0.5, change24hPct: 12.5, volume24hUsd: 1000, liquidityUsd: 5000, quotePair: "AAA / WBNB" });
    expect(y!.priceUsd).toBe(9); // the engine's price stays
    expect(x!.priceSource).toBeNull();
  });
  it("a pair under a day old says how many hours its change really covers", async () => {
    const now = 100 * 3_600_000;
    const { get } = fake(() => ({ status: 200, body: [pair(A, { pairCreatedAt: now - 5 * 3_600_000 })] }));
    const w = new QuoteWorker([dexscreener], get, () => now);
    const a = tok(A, "bsc");
    await w.tick([a]);
    expect(w.enrich([a])[0]!.changeWindowH).toBe(5);
  });
  it("asks the next provider only about tokens the first one does not know, and does not keep re-asking", async () => {
    const sol = tok(SOL, "solana");
    let now = 5_000_000;
    const urls: string[] = [];
    const { get } = fake((u) => {
      urls.push(u);
      return u.includes("dexscreener") ? { status: 200, body: [] } : { status: 200, body: { [SOL]: { usdPrice: 1, priceChange24h: 1, liquidity: 10 } } };
    });
    const w = new QuoteWorker([dexscreener, jupiter], get, () => now);
    await w.tick([sol]);
    expect(urls.length).toBe(2);
    expect(w.enrich([sol])[0]!.priceUsd).toBe(1);
    now += 40_000; // refresh time: Jupiter holds it; DexScreener is not asked again (it said it does not know it)
    urls.length = 0;
    await w.tick([sol]);
    expect(urls.every((u) => u.includes("jup.ag"))).toBe(true);
  });
  it("a limited provider pauses itself and the others carry on", async () => {
    const sol = tok(SOL, "solana");
    let now = 1_000_000;
    const { get } = fake((u) => (u.includes("dexscreener") ? { status: 429 } : { status: 200, body: { [SOL]: { usdPrice: 2 } } }));
    const w = new QuoteWorker([dexscreener, jupiter], get, () => now);
    await w.tick([sol]);
    const st = w.stats();
    expect(st.find((s) => s.id === "dexscreener")!.pausedForS).toBeGreaterThan(50);
    expect(w.enrich([sol])[0]!.priceUsd).toBe(2);
  });
  it("a quote that is too old is not shown, and a missing one stays missing", async () => {
    const a = tok(A, "bsc");
    let now = 1_000_000;
    const { get } = fake(() => ({ status: 200, body: [pair(A)] }));
    const w = new QuoteWorker([dexscreener], get, () => now);
    await w.tick([a]);
    expect(w.enrich([a])[0]!.priceUsd).toBe(0.5);
    now += 11 * 60_000;
    expect(w.enrich([a])[0]!.priceUsd).toBeNull();
    expect(new QuoteWorker([dexscreener], get, () => now).enrich([tok(B, "bsc")])[0]!.priceUsd).toBeNull();
  });
  it("keeps quotes across a restart (not the old ones)", async () => {
    const file = join(mkdtempSync(join(tmpdir(), "pinr-q-")), "q.json");
    const a = tok(A, "bsc");
    let now = 1_000_000;
    const { get } = fake(() => ({ status: 200, body: [pair(A)] }));
    const w = new QuoteWorker([dexscreener], get, () => now);
    await w.tick([a]);
    w.saveTo(file);
    expect(new QuoteWorker([dexscreener], get, () => now + 60_000).loadFrom(file)).toBe(1);
    expect(new QuoteWorker([dexscreener], get, () => now + 11 * 60_000).loadFrom(file)).toBe(0);
  });
  it("a provider object is all it takes to add a source", async () => {
    const mine: QuoteProvider = { id: "paid", label: "Paid", kind: "paid", chains: ["bsc"], maxBatch: 5, minIntervalMs: 0, fetch: async (_c, addrs) => ({ status: "ok", quotes: new Map(addrs.map((a) => [a.toLowerCase(), { priceUsd: 7, change24hPct: null, volume24hUsd: null, liquidityUsd: null, pair: null, createdAtMs: null }])) }) };
    const a = tok(A, "bsc");
    const w = new QuoteWorker([mine, dexscreener], fake(() => ({ status: 200, body: [pair(A)] })).get);
    await w.tick([a]);
    expect(w.enrich([a])[0]!.priceUsd).toBe(7);
    expect(w.stats()[0]).toMatchObject({ id: "paid", kind: "paid", covered: 1 });
  });

  it("draws PINR's own tracked line when no service has candles, and only from an unbroken run", async () => {
    const a = tok(A, "bsc");
    let now = 1_000 * 300_000;
    let price = 1;
    const { get } = fake(() => ({ status: 200, body: [pair(A, { priceUsd: String(price) })] }));
    const w = new QuoteWorker([dexscreener], get, () => now);
    for (let i = 0; i < 6; i++) {
      await w.tick([a]);
      now += 300_000;
      price += 1;
    }
    const filled = w.fillHistory(w.enrich([a]))[0]!;
    expect(filled.priceSeries).toEqual([1, 2, 3, 4, 5, 6]);
    expect(filled.priceSource).toBe("PINR 5m");
    // a real service line is never replaced
    const withLine = { ...a, priceSeries: [9, 9] };
    expect(w.fillHistory([withLine])[0]!.priceSeries).toEqual([9, 9]);
    // a long silence ends the run: nothing is drawn across the gap
    now += 3 * 3_600_000;
    await w.tick([a]);
    expect(w.fillHistory([a])[0]!.priceSeries).toBeNull();
  });
  it("too few tracked points means no line", async () => {
    const a = tok(A, "bsc");
    const { get } = fake(() => ({ status: 200, body: [pair(A)] }));
    const w = new QuoteWorker([dexscreener], get, () => 5_000_000);
    await w.tick([a]);
    expect(w.fillHistory([a])[0]!.priceSeries).toBeNull();
  });
});

describe("Pump.fun provider", () => {
  const MINT = "A7rRfLf67GMp5DFeY7s4kUaZLZbbz6UFPM5XYSg2pump";
  const rec = (over: Record<string, unknown> = {}) => ({ mint: MINT, usd_market_cap: 4000, total_supply: 1_000_000_000_000_000, base_decimals: 6, canonical_pool_liquidity_usd: 469, complete: false, created_timestamp: 1_791_670_556_000, image_uri: "https://img.example/x.png", ...over });
  it("works the price out from the record's dollar market cap and stated supply", async () => {
    const { get, calls } = fake(() => ({ status: 200, body: rec() }));
    const r = await pumpfun.fetch("solana", [MINT], get);
    expect(calls[0]).toContain(`/coins-v2/${MINT}`);
    expect(r.status === "ok" && r.quotes.get(MINT.toLowerCase())).toMatchObject({ priceUsd: 4e-6, change24hPct: null, volume24hUsd: null, liquidityUsd: 469, pair: "Pump.fun curve", imageUrl: "https://img.example/x.png" });
  });
  it("gives nothing (never a zero) for an unknown coin or an unusable record, and never asks for a malformed address", async () => {
    expect((await pumpfun.fetch("solana", [MINT], fake(() => ({ status: 404 })).get))).toEqual({ status: "ok", quotes: new Map() });
    const noCap = await pumpfun.fetch("solana", [MINT], fake(() => ({ status: 200, body: rec({ usd_market_cap: 0 }) })).get);
    expect(noCap.status === "ok" && noCap.quotes.size).toBe(0);
    const f = fake(() => ({ status: 200, body: rec() }));
    await pumpfun.fetch("solana", ["../etc"], f.get);
    expect(f.calls).toEqual([]);
  });
  it("backs off when limited and drops a picture that is not https", async () => {
    expect((await pumpfun.fetch("solana", [MINT], fake(() => ({ status: 429 })).get)).status).toBe("limited");
    const r = await pumpfun.fetch("solana", [MINT], fake(() => ({ status: 200, body: rec({ image_uri: "http://x/y.png" }) })).get);
    expect(r.status === "ok" && r.quotes.get(MINT.toLowerCase())?.imageUrl).toBeNull();
  });

  it("DexScreener's trade counts give a coin nobody opened its tile mix, marked as counts; a missing number gives nothing", async () => {
    const f = fake(() => ({ status: 200, body: [pair(A, { txns: { m5: { buys: 6, sells: 2 }, h1: { buys: 40, sells: 30 } } }), pair(B, { txns: { m5: { buys: 1 } } })] }));
    const w = new QuoteWorker([dexscreener], f.get, () => 1_000_000);
    await w.tick([tok(A, "bsc"), tok(B, "bsc")]);
    const [a, b] = w.enrich([tok(A, "bsc"), tok(B, "bsc")]);
    expect(a!.flow).toMatchObject({ buy5m: 6, sell5m: 2, n5m: 8, buy1h: 40, sell1h: 30, n1h: 70, basis: "count" });
    expect(b!.flow).toBeNull();
  });

  it("a market cap the engine and the launchpad lack comes from the quote source, with its source and time; an engine value is never replaced", async () => {
    const f = fake(() => ({ status: 200, body: [pair(A, { marketCap: 36238 }), pair(B, { marketCap: 5 })] }));
    const w = new QuoteWorker([dexscreener], f.get, () => 1_000_000);
    // B carries the engine's own price beside its cap: the engine's pair stays whole
    await w.tick([tok(A, "bsc"), tok(B, "bsc", { valuation_usd: 900, price_usd: 0.4 })]);
    const [a, b] = w.enrich([tok(A, "bsc"), tok(B, "bsc", { valuation_usd: 900, price_usd: 0.4 })]);
    expect(a).toMatchObject({ valuationUsd: 36238, capSource: "DexScreener", capAtMs: 1_000_000 });
    expect(b!.valuationUsd).toBe(900);
    expect(b!.capSource).toBeUndefined();
  });

  it("when the price shown is the quote source's, the market cap beside it is that source's too, not the engine's older figure (H1)", async () => {
    const f = fake(() => ({ status: 200, body: [pair(A, { marketCap: 1940, priceUsd: "0.0001" }), pair(B, { priceUsd: "0.2" })] }));
    const w = new QuoteWorker([dexscreener], f.get, () => 1_000_000);
    const old = { valuation_usd: 41_900_000 }; // the engine's figure from a score long ago; no engine price
    await w.tick([tok(A, "bsc", old), tok(B, "bsc", old)]);
    const [a, b] = w.enrich([tok(A, "bsc", old), tok(B, "bsc", old)]);
    expect(a).toMatchObject({ priceUsd: 0.0001, valuationUsd: 1940, capSource: "DexScreener", capAtMs: 1_000_000 });
    // this source gives no cap for B: a dash beside its price (one source, one read); the engine's figure lives in the facts list only
    expect(b).toMatchObject({ priceUsd: 0.2, valuationUsd: null });
    expect(b!.capSource).toBeUndefined();
  });

  it("a source that answers only partly never wipes out a figure another source gave: each figure keeps its own source and time", async () => {
    let clock = 1_000_000;
    let dexKnows = true;
    const dex: QuoteProvider = { id: "dex", label: "DexScreener", kind: "free", chains: ["solana"], maxBatch: 30, minIntervalMs: 0, async fetch(_c, addrs) { return { status: "ok", quotes: new Map(dexKnows ? addrs.map((a) => [a.toLowerCase(), { priceUsd: 1, change24hPct: 5, volume24hUsd: 13_200, liquidityUsd: 11_200, pair: "ABC / SOL", createdAtMs: clock, marketCapUsd: 36_000 }]) : []) }; } };
    const pump: QuoteProvider = { id: "pump", label: "Pump.fun", kind: "free", chains: ["solana"], maxBatch: 1, minIntervalMs: 0, async fetch(_c, addrs) { return { status: "ok", quotes: new Map(addrs.map((a) => [a.toLowerCase(), { priceUsd: 2, change24hPct: null, volume24hUsd: null, liquidityUsd: null, pair: null, createdAtMs: null }])) }; } };
    const w = new QuoteWorker([dex, pump], async () => ({ status: 200, json: async () => ({}) }), () => clock);
    const T = tok(SOL, "solana");
    await w.tick([T]);
    expect(w.enrich([T])[0]!).toMatchObject({ liquidityUsd: 11_200, volume24hUsd: 13_200, valuationUsd: 36_000, figSrc: { liquidity: { source: "DexScreener", atMs: 1_000_000 } } });
    // DexScreener loses the coin; twelve minutes on, Pump.fun answers with a price only
    dexKnows = false;
    clock += 12 * 60_000;
    await w.tick([T]);
    clock += 1_000;
    await w.tick([T]);
    const e = w.enrich([T])[0]!;
    expect(e.liquidityUsd).toBe(11_200);
    expect(e.volume24hUsd).toBe(13_200);
    expect(e.quotePair).toBe("ABC / SOL");
    expect(e.valuationUsd).toBeNull(); // the price is now Pump.fun's and Pump.fun gives no cap: a dash, never DexScreener's older cap beside it (H1, one source one read)
    expect(e.figSrc!.liquidity).toEqual({ source: "DexScreener", atMs: 1_000_000 }); // its own, older receipt
    expect(e.priceUsd).toBe(2); // the price is the fresher source's
    expect(e.quoteSource).toBe("Pump.fun");
    // after six hours the pool figures are gone rather than shown stale
    clock += 7 * 3_600_000;
    expect(w.enrich([T])[0]!.liquidityUsd).toBeNull();
  });
});

describe("an impossible price from a source is missing", () => {
  it("DexScreener's priceUsd above $1e9 per token is not taken; a normal one is", async () => {
    const mk = (price: string) => ({ ok: true, status: 200, json: async () => [{ chainId: "base", baseToken: { address: "0xAbC0000000000000000000000000000000000001" }, priceUsd: price, liquidity: { usd: 10 } }] });
    const { dexscreener } = await import("./quotes.ts");
    const bad = await dexscreener.fetch("base", ["0xabc0000000000000000000000000000000000001"], (async () => mk("7.83e41")) as never);
    const ok = await dexscreener.fetch("base", ["0xabc0000000000000000000000000000000000001"], (async () => mk("0.0000021")) as never);
    expect(bad.status === "ok" ? bad.quotes.size : 0).toBe(0);
    expect(ok.status === "ok" ? ok.quotes.size : 0).toBe(1);
  });
});
