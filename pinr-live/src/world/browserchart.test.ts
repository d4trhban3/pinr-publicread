import { afterEach, describe, expect, it, vi } from "vitest";
import { BrowserCharts, bestPair, bestPool, cleanOhlcv, ERR_MS, GT_NETWORK, GT_GAP_MS, GT_REST_MS, NEG_MS, POS_MS, TIMEFRAMES } from "./browserchart";

const MINT = "A7rRfLf67GMp5DFeY7s4kUaZLZbbz6UFPM5XYSg2pump";
const P1 = "P1rRfLf67GMp5DFeY7s4kUaZLZbbz6UFPM5XYSg2pump";
const P2 = "P2rRfLf67GMp5DFeY7s4kUaZLZbbz6UFPM5XYSg2pump";
const ds = (pairs: unknown[]): unknown => ({ pairs });
const pair = (id: string, liq: number, extra: Record<string, unknown> = {}): unknown => ({ chainId: "solana", pairAddress: id, baseToken: { address: MINT }, liquidity: { usd: liq }, ...extra });
const ohlcv = (n: number): unknown => ({ data: { attributes: { ohlcv_list: Array.from({ length: n }, (_, i) => [1_800_000_000 + i * 900, 1, 2, 0.5, 1.5, 100]) } } });

/** A scripted fetch: one handler per host path; records every call. */
function rig(handlers: { ds?: () => { status: number; body?: unknown }; gtOhlcv?: () => { status: number; body?: unknown } }) {
  const urls: string[] = [];
  let now = 1_000_000;
  const get = async (url: string): Promise<{ status: number; json(): Promise<unknown> }> => {
    urls.push(url);
    const h = url.includes("api.dexscreener.com") ? handlers.ds : handlers.gtOhlcv;
    const r = h ? h() : { status: 404 };
    return { status: r.status, json: async () => r.body ?? {} };
  };
  const c = new BrowserCharts(get, () => now, 0);
  return { c, urls, advance: (ms: number) => void (now += ms) };
}

afterEach(() => vi.useRealTimers());

describe("DexScreener's pair for a coin", () => {
  it("takes the Solana pair of that token with the most liquidity, and ignores other chains, other base tokens and odd addresses", () => {
    const body = ds([pair(P1, 10), pair(P2, 500), pair(P1, 9000, { chainId: "base" }), pair(P1, 9000, { baseToken: { address: "other" } }), pair("not an address", 99999)]);
    expect(bestPair(body, MINT)).toBe(P2);
    expect(bestPair(ds([]), MINT)).toBeNull();
    expect(bestPair({ pairs: null }, MINT)).toBeNull();
    expect(bestPair(null, MINT)).toBeNull();
  });
});

describe("candles from GeckoTerminal's list", () => {
  it("come back oldest first, with a bad row dropped", () => {
    const list = [[200, 1, 2, 1, 2, 5], [100, 1, 2, 1, 2, 5], [300, 0, 2, 1, 2, 5], [400, 1, 2, 1], "x"];
    expect(cleanOhlcv(list).map((c) => c[0])).toEqual([100, 200]);
    expect(cleanOhlcv(undefined)).toEqual([]);
  });
});

describe("the browser's own look-ups", () => {
  it("looks a pair up once for several askers, keeps it ten minutes, and keeps 'no pair' two", async () => {
    const r = rig({ ds: () => ({ status: 200, body: ds([pair(P1, 10)]) }) });
    expect(await Promise.all([r.c.dexPair(MINT), r.c.dexPair(MINT)])).toEqual([P1, P1]);
    expect(r.urls).toHaveLength(1);
    r.advance(POS_MS - 1);
    await r.c.dexPair(MINT);
    expect(r.urls).toHaveLength(1);
    r.advance(2);
    await r.c.dexPair(MINT);
    expect(r.urls).toHaveLength(2);
    const none = rig({ ds: () => ({ status: 200, body: ds([]) }) });
    expect(await none.c.dexPair(MINT)).toBeNull();
    none.advance(NEG_MS - 1);
    await none.c.dexPair(MINT);
    expect(none.urls).toHaveLength(1);
    none.advance(2);
    await none.c.dexPair(MINT);
    expect(none.urls).toHaveLength(2);
  });
  it("tries again after half a minute when the provider could not be read, and never asks about a malformed address", async () => {
    const r = rig({ ds: () => ({ status: 500 }) });
    expect(await r.c.dexPair(MINT)).toBeNull();
    r.advance(ERR_MS + 1);
    await r.c.dexPair(MINT);
    expect(r.urls).toHaveLength(2);
    expect(await r.c.dexPair("not an address")).toBeNull();
    expect(r.urls).toHaveLength(2);
  });
  it("reads an 0x token's pool on Base or BNB Chain, from its network, case-insensitively, and never a Solana pair for it", () => {
    const EV = "0xAbCdEf0123456789aBcDeF0123456789AbCdEf01";
    const evPair = (id: string, chainId: string, liq: number, base = EV.toLowerCase()) => ({ chainId, pairAddress: id, baseToken: { address: base }, liquidity: { usd: liq } });
    const P = "0x" + "1".repeat(40);
    const Q = "0x" + "2".repeat(40);
    expect(bestPool({ pairs: [evPair(P, "base", 10), evPair(Q, "bsc", 500), evPair(Q, "solana", 9999)] }, EV)).toEqual({ id: Q, network: "bsc" });
    expect(bestPool({ pairs: [evPair(P, "base", 10)] }, EV)).toEqual({ id: P, network: "base" });
    expect(bestPool({ pairs: [evPair(P, "base", 10, "0x" + "9".repeat(40))] }, EV)).toBeNull();
    expect(GT_NETWORK).toMatchObject({ solana: "solana", base: "base", bsc: "bsc", ethereum: "eth" });
  });
  it("asks GeckoTerminal on the pool's own network for an 0x coin", async () => {
    const EV = "0x" + "a".repeat(40);
    const P = "0x" + "1".repeat(40);
    const urls: string[] = [];
    const get = async (url: string): Promise<{ status: number; json(): Promise<unknown> }> => {
      urls.push(url);
      return url.includes("dexscreener") ? { status: 200, json: async () => ({ pairs: [{ chainId: "base", pairAddress: P, baseToken: { address: EV }, liquidity: { usd: 5 } }] }) } : { status: 200, json: async () => ohlcv(4) };
    };
    const c = new BrowserCharts(get, () => 1_000_000, 0);
    expect(await c.candles(EV, TIMEFRAMES["15m"]!)).toHaveLength(4);
    expect(urls.some((u) => u.startsWith(`https://api.geckoterminal.com/api/v2/networks/base/pools/${P}/ohlcv/`))).toBe(true);
  });
});

describe("small charts from this browser", () => {
  const spec = TIMEFRAMES["15m"]!;
  it("reads the candles through the coin's pair, once for a repeat, and gives nothing for a coin with no pair (no GeckoTerminal call)", async () => {
    const r = rig({ ds: () => ({ status: 200, body: ds([pair(P1, 10)]) }), gtOhlcv: () => ({ status: 200, body: ohlcv(5) }) });
    const cs = await r.c.candles(MINT, spec);
    expect(cs).toHaveLength(5);
    expect(r.urls.find((u) => u.includes("/ohlcv/"))).toBe(`https://api.geckoterminal.com/api/v2/networks/solana/pools/${P1}/ohlcv/minute?aggregate=15&limit=1000`);
    await r.c.candles(MINT, spec);
    expect(r.urls.filter((u) => u.includes("/ohlcv/"))).toHaveLength(1); // kept for the timeframe's own time
    const none = rig({ ds: () => ({ status: 200, body: ds([]) }), gtOhlcv: () => ({ status: 200, body: ohlcv(5) }) });
    expect(await none.c.candles(MINT, spec)).toBeNull();
    expect(none.urls.some((u) => u.includes("/ohlcv/"))).toBe(false);
  });
  it("gives nothing for an empty or one-candle answer, and rests a minute after a 429", async () => {
    const one = rig({ ds: () => ({ status: 200, body: ds([pair(P1, 10)]) }), gtOhlcv: () => ({ status: 200, body: ohlcv(1) }) });
    expect(await one.c.candles(MINT, spec)).toBeNull();
    const limited = rig({ ds: () => ({ status: 200, body: ds([pair(P1, 10)]) }), gtOhlcv: () => ({ status: 429 }) });
    expect(await limited.c.candles(MINT, spec)).toBeNull();
    const before = limited.urls.length;
    expect(await limited.c.candles(MINT, TIMEFRAMES["5m"]!)).toBeNull();
    expect(limited.urls.filter((u) => u.includes("/ohlcv/")).length).toBe(2); // the one read and its one retry; then resting: no third call
    expect(limited.urls.length).toBe(before); // and not even a look-up
  });
  it("rests a minute after a network error too: a refusal without a cross-origin header looks like one", async () => {
    let n = 0;
    const get = async (url: string): Promise<{ status: number; json(): Promise<unknown> }> => {
      if (url.includes("/ohlcv/")) {
        n++;
        throw new TypeError("Failed to fetch");
      }
      return { status: 200, json: async () => ds([pair(P1, 10)]) };
    };
    let now = 1_000_000;
    const c = new BrowserCharts(get, () => now, 0);
    expect(await c.candles(MINT, spec)).toBeNull();
    expect(await c.candles(MINT, TIMEFRAMES["5m"]!)).toBeNull();
    expect(n).toBe(2); // the read and its one retry
    await c.candles(MINT, TIMEFRAMES["5m"]!);
    expect(n).toBe(2); // resting: the next did not go out
    now += GT_REST_MS + 1;
    await c.candles(MINT, TIMEFRAMES["1h"]!);
    expect(n).toBe(4);
  });
  it("tries a refused read once more after a short wait, and gives the candles when the second goes through", async () => {
    let calls = 0;
    const get = async (url: string): Promise<{ status: number; json(): Promise<unknown> }> => {
      if (url.includes("/ohlcv/")) {
        calls++;
        if (calls === 1) throw new TypeError("Failed to fetch");
        return { status: 200, json: async () => ohlcv(5) };
      }
      return { status: 200, json: async () => ds([pair(P1, 10)]) };
    };
    const c = new BrowserCharts(get, () => 1_000_000, 0);
    const got = await c.candles(MINT, spec);
    expect(got).toHaveLength(5);
    expect(calls).toBe(2);
    // and a 429 the first time, then a good answer
    let n429 = 0;
    const get2 = async (url: string): Promise<{ status: number; json(): Promise<unknown> }> => (url.includes("/ohlcv/") ? (++n429 === 1 ? { status: 429, json: async () => ({}) } : { status: 200, json: async () => ohlcv(4) }) : { status: 200, json: async () => ds([pair(P1, 10)]) });
    expect(await new BrowserCharts(get2, () => 1_000_000, 0).candles(MINT, spec)).toHaveLength(4);
  });
  it("paces its calls GT_GAP_MS apart, and sends a chart to the server when the line is too long", async () => {
    vi.useFakeTimers();
    const r = rig({ ds: () => ({ status: 200, body: ds([pair(P1, 10)]) }), gtOhlcv: () => ({ status: 200, body: ohlcv(3) }) });
    const specs = ["1m", "5m", "15m", "1h", "4h", "1D"].map((k) => TIMEFRAMES[k]!);
    const runs = specs.map((s) => r.c.candles(MINT, s));
    await vi.advanceTimersByTimeAsync(0);
    expect(r.urls.filter((u) => u.includes("/ohlcv/"))).toHaveLength(1); // the first goes at once
    await vi.advanceTimersByTimeAsync(GT_GAP_MS);
    expect(r.urls.filter((u) => u.includes("/ohlcv/"))).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(GT_GAP_MS * 6);
    const results = await Promise.all(runs);
    expect(results.filter((x) => x !== null).length).toBeGreaterThanOrEqual(4);
    expect(results.filter((x) => x === null).length).toBeGreaterThanOrEqual(1); // the last in line (over ten seconds) was left to the server
  });
});
