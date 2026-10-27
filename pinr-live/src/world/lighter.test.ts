import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { coinToken, type PumpCoin } from "../../server/pumpfun";
import { COIN_PAGE_ONLY, coinPageFields, tileView } from "../../server/tileview";
import type { WireToken } from "../../server/translate";
import { rankDiscover } from "./discoverlist";
import { hasSomethingToShow, selectAndRank } from "./filters";
import { applyCoinPage, applySnapshot, POLL_EVERY_MS, TILE_URL, type FeedSnapshot } from "./livefeed";
import { makeStore, type Item } from "./model";

/** the site polls a lighter list every 15 s, cached 5 s, and the tile page holds back a coin with no picture and no chart. */
const NOW = 1_800_000_000_000;
const coin = (mint: string, image: string | null): PumpCoin => ({
  mint, name: `Coin ${mint.slice(0, 4)}`, symbol: "C", image, creator: null, createdMs: NOW - 60_000, lastTradeMs: null, capUsd: 5000, priceUsd: 5e-6,
  athCapUsd: null, graduated: false, twitter: null, telegram: null, website: null, seenMs: NOW, curve: null, figSource: "PumpPortal", figAtMs: NOW,
});
const A = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAApump";
const B = "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBpump";
const C = "CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCpump";
const full = (mint: string, image: string | null, over: Partial<WireToken> = {}): WireToken => ({ ...coinToken(coin(mint, image)), liquidityUsd: 1234, figSrc: { liquidity: { source: "DexScreener", atMs: NOW } }, ...over });
const snap = (tokens: Partial<WireToken>[]): FeedSnapshot => ({ contract: "1.1", mode: "feed", asOfMs: NOW, files: 0, tokens: tokens as WireToken[], problems: [] });

describe("the lighter list", () => {
  it("the site reads /api/tokens?view=tile every 15 seconds", () => {
    expect(TILE_URL).toBe("/api/tokens?view=tile");
    expect(POLL_EVERY_MS).toBe(15_000);
  });

  it("the tile list leaves out only the coin page's receipts and two fields the site never reads; the coin page gets them back", () => {
    const t = full(A, "https://img.example/a.png", { rank: 3, seenBy: "pumpfun_pool" });
    const tile = tileView(t);
    for (const k of [...COIN_PAGE_ONLY, "rank", "seenBy"]) expect(k in tile).toBe(false);
    // Everything a tile, Discover or search reads stays.
    for (const k of ["address", "name", "ticker", "imageUrl", "score", "noScoreLabel", "valuationUsd", "priceUsd", "change24hPct", "volume24hUsd", "priceSeries", "flow", "launchpad", "quotePair", "note", "launchedAtMs", "transferFee", "athUsd"] as const)
      expect(k in tile).toBe(k in t);
    expect(coinPageFields(t)).toEqual({ address: A, figSrc: t.figSrc, quoteAtMs: t.quoteAtMs, quoteSource: t.quoteSource, capSource: t.capSource, capAtMs: t.capAtMs, liquidityUsd: 1234 });
  });

  it("a 15-second tile poll never wipes the receipts the coin page read", () => {
    const store = makeStore();
    const by = new Map<string, Item>();
    applySnapshot(store, by, snap([tileView(full(A, "https://img.example/a.png"))]), NOW);
    const it0 = by.get(A.toLowerCase())!;
    applyCoinPage(it0, coinPageFields(full(A, "x")));
    expect(it0).toMatchObject({ liquidity: 1234, quoteSource: "PumpPortal", capSource: "PumpPortal" });
    applySnapshot(store, by, snap([tileView(full(A, "https://img.example/a.png", { priceUsd: 6e-6 }))]), NOW + 15_000);
    expect(it0).toMatchObject({ liquidity: 1234, quoteSource: "PumpPortal", priceUsd: 6e-6 });
    expect(it0.figSrc?.liquidity?.source).toBe("DexScreener");
  });

  it("the server answers both lists with max-age=5, builds each body once per rebuild, and has the coin page's detail route", () => {
    const src = readFileSync(join(import.meta.dirname, "..", "..", "server", "server.ts"), "utf8");
    expect(src).toMatch(/const TOKENS_CACHE = "public, max-age=5";/);
    expect(src).toMatch(/"cache-control": TOKENS_CACHE/);
    expect(src).toMatch(/url === "\/api\/token\/detail"/);
    expect(src).not.toMatch(/publicSnapshot\(tokens\(\)\)/);
  });
});

describe("the first page holds back a coin with no picture and no chart", () => {
  const items = (): Item[] => {
    const store = makeStore();
    const by = new Map<string, Item>();
    applySnapshot(store, by, snap([full(A, "https://img.example/a.png"), full(B, null), full(C, null, { priceSeries: [1, 2, 3, 4] })]), NOW);
    return store.items;
  };
  it("a picture or a chart line is enough", () => {
    const [a, b, c] = items();
    expect([hasSomethingToShow(a!), hasSomethingToShow(b!), hasSomethingToShow(c!)]).toEqual([true, false, true]);
  });
  it("the tile page leaves it out; Discover and search keep it", () => {
    const all = items();
    const shown = selectAndRank("trending", all.filter(hasSomethingToShow), 90, NOW).map((r) => all.find((x) => x.id === r.id)!.address);
    expect(shown.sort()).toEqual([A, C].sort());
    expect(rankDiscover("fresh", all, "").map((x) => x.address)).toContain(B);
    expect(rankDiscover("trending", all, "Coin BBBB").map((x) => x.address)).toEqual([B]);
  });
  it("the tile page's own code filters before it ranks", () => {
    const src = readFileSync(join(import.meta.dirname, "cards.ts"), "utf8");
    expect(src).toMatch(/rankFeatured\(this\.filter, items\.filter\(hasSomethingToShow\)\)/);
  });
});
