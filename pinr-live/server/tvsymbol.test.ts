import { describe, expect, it } from "vitest";
import { bestPool, NEG_MS, POS_MS, SYMBOL, symbolFor, TvSymbols, type TvGet } from "./tvsymbol";

const M = "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263";
const POOL = "CPK8fQYShAmERZmysQRAGWPvV5qs3AvazQsiR9ctC6ED";
const POOL2 = "3ne4mWqdYuNiYrYZC9TrA3FcfuFdErghH97vNPbjicr1";
const ds = [{ chainId: "solana", pairAddress: POOL2, baseToken: { address: M }, liquidity: { usd: 10 } }, { chainId: "solana", pairAddress: POOL, baseToken: { address: M }, liquidity: { usd: 5000 } }, { chainId: "base", pairAddress: "0xabc", baseToken: { address: M } }];
const sym = (s: string, desc: string, prefix = "RAYDIUMCLMM") => ({ symbol: s, description: desc, prefix, source_id: prefix });

describe("TradingView's listing of a coin (the free Advanced Chart widget)", () => {
  it("takes the pool of most liquidity for the token on Solana", () => {
    expect(bestPool(ds, M)).toBe(POOL);
    expect(bestPool(ds, "another")).toBeNull();
    expect(bestPool({}, M)).toBeNull();
  });
  it("keeps a search result only when its description holds that pool, the dollar-quoted symbol first, as EXCHANGE:NAME", () => {
    const body = { symbols: [sym("BATTBONK_CPK8FQ", `Bat / Bonk on Solana (${POOL})`), sym("BATTBONK_CPK8FQ.USD", `Bat / Bonk on Solana (${POOL}) in USD`), sym("OTHER_AAAAAA", "Other / Sol on Solana (11111111111111111111111111111111)")] };
    expect(symbolFor(body, POOL)).toBe("RAYDIUMCLMM:BATTBONK_CPK8FQ.USD");
    expect(symbolFor(body, POOL2)).toBeNull(); // a different market never stands in
    expect(symbolFor({ symbols: [] }, POOL)).toBeNull();
    expect(symbolFor(null, POOL)).toBeNull();
  });
  it("lets only a clean EXCHANGE:NAME through to the page", () => {
    for (const bad of ["x", "A:b c", "RAY:<script>", "A:B;C", "javascript:alert(1)", ":NAME", "EX:" + "A".repeat(80)]) expect(SYMBOL.test(bad)).toBe(false);
    expect(SYMBOL.test("RAYDIUMCLMM:BATTBONK_CPK8FQ.USD")).toBe(true);
    expect(symbolFor({ symbols: [sym("A B", `x (${POOL})`), sym("OK_1", `x (${POOL})`, "BAD PREFIX")] }, POOL)).toBeNull();
  });
  const route = (listed: boolean, calls: string[] = []): TvGet => async (u, h) => {
    calls.push(u + (h ? " +origin" : ""));
    if (u.includes("dexscreener")) return { status: 200, json: async () => ds };
    return { status: 200, json: async () => ({ symbols: listed ? [sym("BATTBONK_CPK8FQ.USD", `Bat / Bonk (${POOL})`)] : [] }) };
  };
  it("asks DexScreener for the pool, then TradingView's search with its own origin, and keeps a listing for hours", async () => {
    const calls: string[] = [];
    let now = 1_000_000;
    const t = new TvSymbols(route(true, calls), () => now);
    expect(await t.symbol(M)).toBe("RAYDIUMCLMM:BATTBONK_CPK8FQ.USD");
    expect(calls[1]).toContain(`symbol_search/v3/?text=${POOL}`);
    expect(calls[1]).toContain("+origin");
    now += POS_MS - 1;
    await t.symbol(M);
    expect(calls).toHaveLength(2);
    now += 2;
    await t.symbol(M);
    expect(calls).toHaveLength(4);
  });
  it("keeps 'not listed' for half an hour and answers null", async () => {
    const calls: string[] = [];
    let now = 1_000_000;
    const t = new TvSymbols(route(false, calls), () => now);
    expect(await t.symbol(M)).toBeNull();
    now += NEG_MS - 1;
    expect(await t.symbol(M)).toBeNull();
    expect(calls).toHaveLength(2);
  });
  it("says 'could not ask' (undefined), not 'not listed', when a service refuses, and answers null for a bad address", async () => {
    const t = new TvSymbols(async () => ({ status: 429, json: async () => ({}) }));
    expect(await t.symbol(M)).toBeUndefined();
    expect(await t.symbol("../x")).toBeNull();
  });
});
