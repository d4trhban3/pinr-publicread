import { describe, expect, it } from "vitest";
import { BATCH, FRESH_MS, JupiterMeta, parseJupiter, REST_MS, SEARCH_URL, STALE_MS } from "./jupmeta";
import { dexLinks } from "./quotes";
import type { WireToken } from "./translate";

const mint = (n: number): string => `${"J".repeat(30)}${[...String(n).padStart(10, "0")].map((c) => "ABCDEFGHJK"[Number(c)]).join("")}`;
const tok = (n: number, over: Partial<WireToken> = {}): WireToken => ({ address: mint(n), chain: "solana", launchpad: "Pump.fun curve", name: null, ticker: null, imageUrl: null, score: null, coverage: 0, noScoreLabel: null, note: null, valuationUsd: null, volume24hUsd: null, change24hPct: null, priceSeries: null, launchedAtMs: null, asOfMs: null, rank: null, priceUsd: null, liquidityUsd: null, quotePair: null, changeWindowH: null, priceSource: null, flow: null, lastTradeMs: null, ...over }) as WireToken;
const row = (n: number, over: Record<string, unknown> = {}) => ({ id: mint(n), name: `Coin ${n}`, symbol: `C${n}`, icon: `https://cdn.example/${n}.webp`, twitter: "https://x.com/abc", website: "https://abc.example", holderCount: 12, mcap: 5000, usdPrice: 0.000005, liquidity: 3000, stats24h: { priceChange: -20, buyVolume: 100, sellVolume: 50 }, firstPool: { createdAt: "2026-10-23T12:00:00Z" }, ...over });

describe("Jupiter Tokens v2 reading", () => {
  it("reads name, picture, links, holders, price, market cap, liquidity, volume and change", () => {
    const m = parseJupiter([row(1)], 1000).get(mint(1).toLowerCase())!;
    expect(m).toMatchObject({ name: "Coin 1", symbol: "C1", imageUrl: "https://cdn.example/1.webp", links: { x: "https://x.com/abc", website: "https://abc.example/" }, holders: 12, priceUsd: 0.000005, mcapUsd: 5000, liquidityUsd: 3000, volume24hUsd: 150, change24hPct: -20, createdAtMs: Date.parse("2026-10-23T12:00:00Z"), atMs: 1000 });
  });
  it("reads the measured price changes for the lite line", () => {
    const m = parseJupiter([row(1, { stats5m: { priceChange: 1 }, stats1h: { priceChange: 5 }, stats6h: { priceChange: -10 }, stats24h: { priceChange: 100, buyVolume: 1, sellVolume: 1 } })], 1).get(mint(1).toLowerCase())!;
    expect(m.changes).toEqual({ m5: 1, h1: 5, h6: -10, h24: 100 });
    expect(parseJupiter([{ id: mint(2), name: "x" }], 1).get(mint(2).toLowerCase())!.changes).toBeNull();
  });
  it("leaves a missing figure missing (an unpriced new coin has a name and a picture but no price), and drops rows that are not coins", () => {
    const m = parseJupiter([{ id: mint(2), name: "New", symbol: "N", icon: "http://insecure.example/x.png" }, { id: "../x" }, null, 5], 1).get(mint(2).toLowerCase())!;
    expect(m).toMatchObject({ name: "New", imageUrl: null, priceUsd: null, liquidityUsd: null, volume24hUsd: null, change24hPct: null });
    expect(parseJupiter("nope", 1).size).toBe(0);
  });
});

describe("the sweep: every listed coin about once a minute, paced", () => {
  const rig = (rows: (urlMints: string[]) => unknown[], status = 200) => {
    const calls: string[] = [];
    const get = async (url: string) => (calls.push(url), { status, json: async () => rows(url.split("query=")[1]!.split(",")) });
    return { calls, get };
  };
  it("asks for up to 100 coins a call, the longest unread first, with the search address", async () => {
    let now = 1_000_000;
    const r = rig((ms) => ms.map((m) => ({ ...row(0), id: m })));
    const j = new JupiterMeta(r.get, () => now);
    const all = Array.from({ length: 230 }, (_, i) => tok(i + 1));
    await j.tick(all);
    expect(r.calls).toHaveLength(1);
    expect(r.calls[0]!.startsWith(`${SEARCH_URL}?query=`)).toBe(true);
    expect(r.calls[0]!.split("query=")[1]!.split(",")).toHaveLength(BATCH);
    now += 6000;
    await j.tick(all);
    expect(r.calls[1]!.split("query=")[1]!.split(",")).toHaveLength(BATCH);
    await j.tick(all); // the third takes the last 30
    expect(r.calls[2]!.split("query=")[1]!.split(",")).toHaveLength(30);
    now += 6000;
    await j.tick(all);
    expect(r.calls).toHaveLength(3); // all fresh: nothing to ask yet
    now += FRESH_MS;
    await j.tick(all);
    expect(r.calls).toHaveLength(4); // a minute later the sweep starts again
  });
  it("skips other chains and copies, and rests a minute after a 429", async () => {
    let now = 1_000_000;
    const r = rig(() => [], 429);
    const j = new JupiterMeta(r.get, () => now);
    await j.tick([tok(1, { chain: "base" }), tok(2, { noScoreLabel: "VAMP" })]);
    expect(r.calls).toHaveLength(0);
    await j.tick([tok(3)]);
    expect(r.calls).toHaveLength(1);
    now += 30_000;
    await j.tick([tok(3)]);
    expect(r.calls).toHaveLength(1); // resting
    now += REST_MS;
    await j.tick([tok(3)]);
    expect(r.calls).toHaveLength(2);
  });
});

describe("what Jupiter fills, and what it never replaces", () => {
  const filledBy = async (t: WireToken, over: Record<string, unknown> = {}): Promise<WireToken> => {
    const now = 5_000_000;
    const j = new JupiterMeta(async () => ({ status: 200, json: async () => [row(1, over)] }), () => now);
    await j.tick([t]);
    return j.fill([t])[0]!;
  };
  it("fills an empty name, ticker, picture, links, price, market cap, volume, liquidity and change, with Jupiter as the source", async () => {
    const f = await filledBy(tok(1));
    expect(f).toMatchObject({ name: "Coin 1", ticker: "$C1", imageUrl: "https://cdn.example/1.webp", links: { x: "https://x.com/abc", website: "https://abc.example/" }, priceUsd: 0.000005, valuationUsd: 5000, volume24hUsd: 150, liquidityUsd: 3000, change24hPct: -20, quoteSource: "Jupiter", capSource: "Jupiter" });
    expect(f.figSrc).toMatchObject({ volume: { source: "Jupiter" }, liquidity: { source: "Jupiter" } });
  });
  it("never replaces what another source gave (DexScreener comes first), and merges only the links that are missing", async () => {
    const own = tok(1, { name: "Real", ticker: "$R", imageUrl: "https://own.example/p.png", priceUsd: 9, valuationUsd: 99, volume24hUsd: 7, liquidityUsd: 8, change24hPct: 3, links: { x: "https://x.com/own" } });
    const f = await filledBy(own);
    expect(f).toMatchObject({ name: "Real", ticker: "$R", imageUrl: "https://own.example/p.png", priceUsd: 9, valuationUsd: 99, volume24hUsd: 7, liquidityUsd: 8, change24hPct: 3 });
    expect(f.links).toEqual({ x: "https://x.com/own", website: "https://abc.example/" });
  });
  it("replaces a price that only the launch message gave (PumpPortal) with a Jupiter price read after it, and leaves a DexScreener price alone", async () => {
    const launch = tok(1, { priceUsd: 1e-7, valuationUsd: 100, quoteSource: "PumpPortal", quoteAtMs: 1_000, capSource: "PumpPortal", capAtMs: 1_000 });
    const f = await filledBy(launch);
    expect(f).toMatchObject({ priceUsd: 0.000005, valuationUsd: 5000, quoteSource: "Jupiter", capSource: "Jupiter", quoteAtMs: 5_000_000 });
    const dex = tok(1, { priceUsd: 9, valuationUsd: 99, quoteSource: "DexScreener", quoteAtMs: 1_000 });
    expect(await filledBy(dex)).toMatchObject({ priceUsd: 9, quoteSource: "DexScreener" });
    const newer = tok(1, { priceUsd: 2e-7, quoteSource: "PumpPortal", quoteAtMs: 9_000_000 }); // newer than Jupiter's read: stays
    expect((await filledBy(newer)).priceUsd).toBe(2e-7);
  });
  it("stops filling from an answer older than ten minutes, and leaves a coin it does not know alone", async () => {
    let now = 1_000_000;
    const j = new JupiterMeta(async () => ({ status: 200, json: async () => [row(1)] }), () => now);
    const t = tok(1);
    expect(j.fill([t])[0]).toBe(t); // nothing read yet
    await j.tick([t]);
    expect(j.fill([t])[0]!.name).toBe("Coin 1");
    now += STALE_MS + 1;
    expect(j.fill([t])[0]).toBe(t); // too old to fill from
    expect(j.fill([tok(2)])[0]!.name).toBeNull(); // a coin it never read
  });
});

describe("DexScreener's links", () => {
  it("takes the website and the X and Telegram links from `info`, cleaned", () => {
    expect(dexLinks({ websites: [{ url: "https://abc.example" }], socials: [{ type: "twitter", url: "https://x.com/abc" }, { type: "telegram", url: "https://t.me/abc" }] })).toEqual({ x: "https://x.com/abc", telegram: "https://t.me/abc", website: "https://abc.example/" });
    expect(dexLinks({ socials: [{ type: "twitter", url: "https://evil.example/x" }] })).toBeUndefined();
    expect(dexLinks(null)).toBeUndefined();
  });
});
