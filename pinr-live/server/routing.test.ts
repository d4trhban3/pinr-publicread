import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { candleOrder, CANDLES_TODAY, routeToken, routingFrom, routingReader, TODAY, type Figures } from "./routing";
import type { WireToken } from "./translate";

const catalog = {
  fields: {
    price: { sources: ["pumpportal", "jupiter", "dexscreener", "geckoterminal", "pumpfun", "tape"], default: ["pumpportal", "jupiter", "dexscreener", "geckoterminal", "pumpfun", "tape"] },
    volume: { sources: ["dexscreener", "geckoterminal", "pumpfun", "tape"], default: ["dexscreener", "geckoterminal", "pumpfun", "tape"] },
    liquidity: { sources: ["dexscreener", "jupiter", "geckoterminal"], default: ["dexscreener", "jupiter", "geckoterminal"] },
    candles: { sources: ["pumpfun", "tape", "geckoterminal"], default: ["pumpfun", "tape", "geckoterminal"] },
    picture: { sources: ["jupiter", "ipfs"], default: ["jupiter", "ipfs"] },
  },
  discovery: { pumpfun: { default: true } },
};
const file = (routes: object, discovery: object = { pumpfun: true }) => ({ version: 3, routing: { routes, discovery } });
const tok = (o: Partial<WireToken> = {}) => ({ address: "A", chain: "solana", priceUsd: 0.5, valuationUsd: 500, volume24hUsd: 10, liquidityUsd: 20, quoteSource: "DexScreener", figSrc: { volume: { source: "DexScreener", atMs: 1 } }, ...o }) as unknown as WireToken;
const figs: Figures = { jupiter: { price: 0.002, cap: 2000, volume: 70, liquidity: 30, atMs: 50 }, dexscreener: { price: 0.001, cap: 1000, volume: 99, liquidity: 40, atMs: 40 }, geckoterminal: { price: 0.003, volume: 5, liquidity: null, atMs: 60 } };

describe("the feed follows the operator's wires", () => {
  it("with no file, a bad file, or every field on its default order, behaves as today", () => {
    expect(routingFrom(null, catalog)).toEqual(TODAY);
    expect(routingFrom({ routing: "x" }, catalog)).toEqual(TODAY);
    const defaults = Object.fromEntries(Object.entries(catalog.fields).map(([f, d]) => [f, d.default]));
    expect(routingFrom(file(defaults), catalog).orders).toEqual({});
    expect(routeToken(tok(), figs, routingFrom(file(defaults), catalog))).toEqual(tok());
  });
  it("uses only an order the catalog allows: no foreign source, no repeat, not empty", () => {
    expect(routingFrom(file({ price: ["jupiter", "ipfs"] }), catalog).orders.price).toBeUndefined();
    expect(routingFrom(file({ price: ["jupiter", "jupiter"] }), catalog).orders.price).toBeUndefined();
    expect(routingFrom(file({ price: [] }), catalog).orders.price).toBeUndefined();
    expect(routingFrom(file({ price: ["jupiter", "dexscreener"] }), catalog).orders.price).toEqual(["jupiter", "dexscreener"]);
    expect(routingFrom(file({ picture: ["ipfs"] }), catalog).orders).toEqual({}); // the engine's field is not the feed's
  });
  it("fills a reordered price from the first source that has one, with that source's market cap and receipt", () => {
    const r = routingFrom(file({ price: ["geckoterminal", "jupiter"] }), catalog);
    const t = routeToken(tok(), figs, r);
    expect(t).toMatchObject({ priceUsd: 0.003, quoteSource: "GeckoTerminal", quoteAtMs: 60, valuationUsd: null }); // GeckoTerminal gives no cap: a dash, not the engine's
    const j = routeToken(tok(), figs, routingFrom(file({ price: ["jupiter", "dexscreener"] }), catalog));
    expect(j).toMatchObject({ priceUsd: 0.002, quoteSource: "Jupiter", valuationUsd: 2000, capSource: "Jupiter" });
  });
  it("never uses a source the operator took off, and says a dash when none of his sources has the figure", () => {
    const t = routeToken(tok(), { dexscreener: figs.dexscreener! }, routingFrom(file({ price: ["jupiter", "geckoterminal"] }), catalog));
    expect(t.priceUsd).toBeNull();
    expect(t.valuationUsd).toBeNull();
    expect(t.quoteSource).toBeUndefined();
  });
  it("fills a reordered volume or liquidity with its receipt, and leaves the fields he did not reorder untouched", () => {
    const r = routingFrom(file({ volume: ["geckoterminal", "dexscreener"], liquidity: ["geckoterminal", "jupiter"] }), catalog);
    const t = routeToken(tok(), figs, r);
    expect(t.volume24hUsd).toBe(5);
    expect(t.figSrc?.volume).toEqual({ source: "GeckoTerminal", atMs: 60 });
    expect(t.liquidityUsd).toBe(30); // GeckoTerminal has none: Jupiter's
    expect(t.figSrc?.liquidity).toEqual({ source: "Jupiter", atMs: 50 });
    expect(t.priceUsd).toBe(0.5); // price not reordered
  });
  it("tries the candles in his order, else today's; switches Pump.fun's discovery off only when he does", () => {
    expect(candleOrder(TODAY)).toEqual(CANDLES_TODAY);
    expect(candleOrder(routingFrom(file({ candles: ["geckoterminal", "pumpfun", "tape"] }), catalog))).toEqual(["geckoterminal", "pumpfun", "tape"]);
    expect(routingFrom(file({}, { pumpfun: false }), catalog).pumpfunOn).toBe(false);
    expect(routingFrom(file({}, {}), catalog).pumpfunOn).toBe(true);
  });
  it("reads the file live from disk, and no file is today's behaviour", () => {
    const dir = mkdtempSync(join(tmpdir(), "routing-"));
    writeFileSync(join(dir, "routing-catalog.json"), JSON.stringify(catalog));
    const read = routingReader(join(dir, "routing.json"), join(dir, "routing-catalog.json"), 1000);
    expect(read(0)).toEqual(TODAY);
    writeFileSync(join(dir, "routing.json"), JSON.stringify(file({ liquidity: ["jupiter", "dexscreener"] })));
    expect(read(500).orders).toEqual({}); // inside the wait
    expect(read(2000).orders.liquidity).toEqual(["jupiter", "dexscreener"]);
  });
});
