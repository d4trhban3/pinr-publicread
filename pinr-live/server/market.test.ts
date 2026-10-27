import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { GeckoBudget } from "./geckobudget.ts";
import { CHART_REST_MS, cleanCandles, isChartRange, isTimeframe, MarketWorker, networkFor, parseOhlcv, STALE_KEEP_MS, TIMEFRAMES, WARM_EVERY_MS, WARM_TOP, type Fetcher } from "./market.ts";
import { translate, type WireToken } from "./translate.ts";

const tok = (over: Record<string, unknown> = {}): WireToken =>
  translate({ mint: "0xabc0000000000000000000000000000000000001", chain: "base", score: 30, display: "30", label: null, coverage: 0.5, ...over }).token!;

// newest first, like the real API: three hourly candles
const CANDLES = [
  [10800, 2, 2.2, 1.9, 2.1, 50],
  [7200, 1.5, 2.1, 1.4, 2, 30],
  [3600, 1, 1.6, 0.9, 1.5, 20],
];

function fakeFetch(plan: Record<string, { status: number; body?: unknown }>): { f: Fetcher; calls: string[] } {
  const calls: string[] = [];
  const f: Fetcher = async (url) => {
    calls.push(url);
    const hit = Object.entries(plan).find(([k]) => url.includes(k));
    const r = hit?.[1] ?? { status: 404 };
    return { status: r.status, json: async () => r.body ?? {} };
  };
  return { f, calls };
}

describe("market data", () => {
  it("reads hour candles into a series, a change, a window and a volume", () => {
    const p = parseOhlcv(CANDLES)!;
    expect(p.series).toEqual([1.5, 2, 2.1]);
    expect(p.changePct).toBeCloseTo(110, 6); // first open 1 -> last close 2.1
    expect(p.windowH).toBe(3);
    expect(p.volumeUsd).toBe(100);
  });

  it("rejects what cannot make a chart: too few candles, junk rows, non-positive prices", () => {
    expect(parseOhlcv([CANDLES[0]])).toBeNull();
    expect(parseOhlcv([])).toBeNull();
    expect(parseOhlcv("nope")).toBeNull();
    expect(parseOhlcv([[1, 0, 0, 0, 0, 1], [2, 1, 1, 1, 1, 1]])).toBeNull();
    expect(parseOhlcv([[1, 1, 1, 1, 1, 1], ["x", 1, 1, 1, 1, 1], [2, 1, 1, 1, 2, 1]])!.series).toEqual([1, 2]);
  });

  it("maps chains to GeckoTerminal networks and ignores chains it does not know", () => {
    expect(networkFor("bsc")).toBe("bsc");
    expect(networkFor("Base")).toBe("base");
    expect(networkFor("solana")).toBe("solana");
    expect(networkFor("someothernet")).toBeNull();
    expect(networkFor(null)).toBeNull();
  });

  it("makes one call per step: pool first, then the price history, and fills only what the engine left out", async () => {
    const { f, calls } = fakeFetch({
      "/tokens/": { status: 200, body: { data: [{ attributes: { address: "0xpool" } }] } },
      "/ohlcv/": { status: 200, body: { data: { attributes: { ohlcv_list: CANDLES } } } },
    });
    const w = new MarketWorker(f, () => 1_000_000);
    const tokens = [tok()];
    await w.step(tokens);
    expect(calls.length).toBe(1);
    expect(w.enrich(tokens)[0]!.priceSeries).toBeNull(); // not there yet
    await w.step(tokens);
    expect(calls.length).toBe(2);
    const e = w.enrich(tokens)[0]!;
    expect(e).toMatchObject({ priceSeries: [1.5, 2, 2.1], volume24hUsd: 100, changeWindowH: 3, priceSource: "GeckoTerminal" });
    expect(e.change24hPct).toBeCloseTo(110, 6);
    await w.step(tokens);
    expect(calls.length).toBe(2); // fresh: nothing more to do
  });

  it("never replaces the engine's own figures", async () => {
    const { f } = fakeFetch({
      "/tokens/": { status: 200, body: { data: [{ attributes: { address: "0xpool" } }] } },
      "/ohlcv/": { status: 200, body: { data: { attributes: { ohlcv_list: CANDLES } } } },
    });
    const w = new MarketWorker(f);
    const tokens = [tok({ volume_24h_usd: 999, change_24h_pct: 5, price_series: [1, 2, 3] })];
    await w.step(tokens);
    await w.step(tokens);
    // the engine's three figures stay; the pool facts it did not send (price, liquidity, pair) are credited to the source
    expect(w.enrich(tokens)[0]).toMatchObject({ volume24hUsd: 999, change24hPct: 5, priceSeries: [1, 2, 3], priceSource: "GeckoTerminal" });
  });

  it("a token with no pool gets nothing: missing, not guessed", async () => {
    const { f } = fakeFetch({ "/tokens/": { status: 404 } });
    const w = new MarketWorker(f);
    const tokens = [tok()];
    await w.step(tokens);
    expect(w.enrich(tokens)[0]).toMatchObject({ priceSeries: null, change24hPct: null, volume24hUsd: null, priceSource: null });
    const { f: f2 } = fakeFetch({ "/tokens/": { status: 200, body: { data: [] } } });
    const w2 = new MarketWorker(f2);
    await w2.step(tokens);
    expect(w2.stats().none).toBe(1);
  });

  it("skips chains it does not cover, and backs off for a minute after a rate-limit reply", async () => {
    let t = 0;
    const { f, calls } = fakeFetch({ "/tokens/": { status: 429 } });
    const w = new MarketWorker(f, () => t);
    await w.step([tok({ chain: "someothernet" })]);
    expect(calls.length).toBe(0);
    await w.step([tok()]);
    expect(calls.length).toBe(1);
    await w.step([tok()]);
    expect(calls.length).toBe(1); // paused
    t = 61_000;
    await w.step([tok()]);
    expect(calls.length).toBe(2);
  });

  it("a network failure is an error on that token only, retried later", async () => {
    const w = new MarketWorker(async () => {
      throw new Error("offline");
    }, () => 0);
    await w.step([tok()]);
    expect(w.stats()).toMatchObject({ calls: 1, errors: 1 });
  });

  it("pool facts (liquidity, trading pair, latest price) are filled in, never over the engine's own", async () => {
    const first = tok();
    const { f } = fakeFetch({
      "/tokens/multi/": {
        status: 200,
        body: {
          data: [{ attributes: { address: first.address }, relationships: { top_pools: { data: [{ id: "base_0xpool" }] } } }],
          included: [{ id: "base_0xpool", attributes: { address: "0xpool", name: "RYSM / WETH", reserve_in_usd: "9204.2" } }],
        },
      },
      "/ohlcv/": { status: 200, body: { data: { attributes: { ohlcv_list: CANDLES } } } },
    });
    const w = new MarketWorker(f);
    const tokens = [first, tok({ mint: "0xabc0000000000000000000000000000000000002", liquidity_usd: 5, quote_pair: "X / Y", price_usd: 9 })];
    await w.step(tokens);
    await w.step(tokens);
    const [a, b] = w.enrich(tokens);
    expect(a).toMatchObject({ liquidityUsd: 9204.2, quotePair: "RYSM / WETH", priceUsd: 2.1 });
    expect(b!.liquidityUsd).toBe(5); // untouched: not looked up yet, and engine values would win anyway
  });
});

describe("chart ranges for the DeepScan page", () => {
  const poolBody = { data: [{ attributes: { address: "0xpool", name: "A / B", reserve_in_usd: "100" } }] };
  const rows = [
    [3600, 1, 2, 0.5, 1.5, 10],
    [7200, 1.5, 3, 1, 2, 20],
    [1800, 1, 1, 1, 1, 5],
  ];

  it("offers the ranges and refuses any other", () => {
    for (const r of ["1D", "1W", "1M", "3M", "ALL"]) expect(isChartRange(r)).toBe(true);
    for (const r of ["1H", "5Y", "toString", "", "constructor"]) expect(isChartRange(r)).toBe(false);
  });

  it("cleans candles: oldest first, numbers only, positive prices", () => {
    const c = cleanCandles([...rows, [9, 0, 1, 1, 1, 1], ["x", 1, 1, 1, 1, 1], [5, 1, 1, 1, 1]]);
    expect(c.map((r) => r[0])).toEqual([1800, 3600, 7200]);
    expect(cleanCandles("nope")).toEqual([]);
  });

  it("looks the pool up, fetches the range's candles with the right size, and keeps the answer for a while", async () => {
    let t = 0;
    const { f, calls } = fakeFetch({ "/tokens/": { status: 200, body: poolBody }, "/ohlcv/": { status: 200, body: { data: { attributes: { ohlcv_list: rows } } } } });
    const w = new MarketWorker(f, () => t);
    const token = tok();
    const r1 = await w.chartFor(token, "1W");
    expect(r1.status).toBe("ok");
    expect(r1.candles.length).toBe(3);
    expect(calls[1]).toContain("/ohlcv/hour?aggregate=1&limit=168");
    const r2 = await w.chartFor(token, "1W");
    expect(r2).toEqual(r1);
    expect(calls.length).toBe(2); // second ask came from the keep
    await w.chartFor(token, "1D");
    expect(calls[2]).toContain("/ohlcv/minute?aggregate=15&limit=96");
    expect(calls.length).toBe(3); // the pool was already known
    t = 10 * 60_000;
    await w.chartFor(token, "1W");
    expect(calls.length).toBe(4); // kept answer expired
  });

  it("says so when there is no pool, when the free service is busy, or when it fails; nothing is invented", async () => {
    const none = new MarketWorker(fakeFetch({ "/tokens/": { status: 404 } }).f);
    expect((await none.chartFor(tok(), "1D")).status).toBe("none");
    const busy = new MarketWorker(fakeFetch({ "/tokens/": { status: 429 } }).f);
    expect((await busy.chartFor(tok(), "1D")).status).toBe("busy");
    expect((await busy.chartFor(tok(), "1D")).status).toBe("busy"); // paused, no second call
    const broken = new MarketWorker(async () => {
      throw new Error("offline");
    });
    expect((await broken.chartFor(tok(), "1D")).status).toBe("error");
    expect((await new MarketWorker().chartFor(tok({ chain: "someothernet" }), "1D")).status).toBe("none");
  });

  it("one candle is not a chart", async () => {
    const w = new MarketWorker(fakeFetch({ "/tokens/": { status: 200, body: poolBody }, "/ohlcv/": { status: 200, body: { data: { attributes: { ohlcv_list: [rows[0]] } } } } }).f);
    const r = await w.chartFor(tok(), "ALL");
    expect(r.status).toBe("none");
    expect(r.candles.length).toBe(1);
  });
});

describe("the page being looked at comes first", () => {
  it("background lookups wait for 30 seconds after a chart is asked for", async () => {
    let t = 0;
    const { f, calls } = fakeFetch({
      "/tokens/": { status: 200, body: { data: [{ attributes: { address: "0xpool", name: "A / B", reserve_in_usd: "1" } }] } },
      "/ohlcv/": { status: 200, body: { data: { attributes: { ohlcv_list: [[3600, 1, 2, 1, 1.5, 1], [7200, 1.5, 2, 1, 2, 1]] } } } },
    });
    const w = new MarketWorker(f, () => t);
    await w.chartFor(tok(), "1D");
    const before = calls.length;
    const other = [tok({ mint: "0xabc0000000000000000000000000000000000009" })];
    await w.step(other);
    expect(calls.length).toBe(before); // waiting
    t = 31_000;
    await w.step(other);
    expect(calls.length).toBe(before + 1);
  });
});

describe("chart timeframes", () => {
  const poolBody = { data: [{ attributes: { address: "0xpool", name: "A / B", reserve_in_usd: "100" } }] };
  const rows = [
    [3600, 1, 2, 0.5, 1.5, 10],
    [7200, 1.5, 3, 1, 2, 20],
  ];
  it("offers exactly the candle sizes the free service has, and refuses any other", () => {
    for (const t of ["1m", "5m", "15m", "1h", "4h", "1D"]) expect(isTimeframe(t)).toBe(true);
    for (const t of ["2m", "30m", "12h", "1W", "toString", ""]) expect(isTimeframe(t)).toBe(false);
    expect(Object.keys(TIMEFRAMES).length).toBe(6);
  });
  it("asks for the right size of candle, and each timeframe is kept separately", async () => {
    let t = 0;
    const { f, calls } = fakeFetch({ "/tokens/": { status: 200, body: poolBody }, "/ohlcv/": { status: 200, body: { data: { attributes: { ohlcv_list: rows } } } } });
    const w = new MarketWorker(f, () => t);
    const token = tok();
    const a = await w.candlesFor(token, "5m");
    expect(a.status).toBe("ok");
    expect(a.candles.map((c) => c[0])).toEqual([3600, 7200]);
    expect(calls[1]).toContain("/ohlcv/minute?aggregate=5&limit=1000");
    await w.candlesFor(token, "4h");
    expect(calls[2]).toContain("/ohlcv/hour?aggregate=4&limit=1000");
    await w.candlesFor(token, "5m");
    expect(calls.length).toBe(3); // 5m came from the keep
    t = 40_000;
    await w.candlesFor(token, "5m");
    expect(calls.length).toBe(4); // kept answer for 5m expired (30 s)
  });

  it("looks up many unseen tokens on one network in a single call", async () => {
    const a = tok({ mint: "0xaaa0000000000000000000000000000000000001" });
    const b = tok({ mint: "0xbbb0000000000000000000000000000000000002" });
    const c = tok({ mint: "0xccc0000000000000000000000000000000000003" });
    const { f, calls } = fakeFetch({
      "/tokens/multi/": {
        status: 200,
        body: {
          data: [
            { attributes: { address: a.address }, relationships: { top_pools: { data: [{ id: "base_P1" }] } } },
            { attributes: { address: b.address }, relationships: { top_pools: { data: [] } } },
          ],
          included: [{ id: "base_P1", attributes: { address: "P1", name: "AAA / WETH 1%", reserve_in_usd: "1234.5" } }],
        },
      },
    });
    const w = new MarketWorker(f, () => 1_000_000);
    await w.step([a, b, c]);
    expect(calls.length).toBe(1);
    expect(calls[0]).toContain("/tokens/multi/");
    expect(calls[0]).toContain(a.address);
    expect(calls[0]).toContain(c.address);
    // a has a pool but no price yet; b and c (not returned) have no pool
    const out = w.enrich([a, b, c]);
    expect(out[0]!.priceUsd).toBeNull();
    expect(w.stats().none).toBe(2);
  });

  it("keeps what it learned across a restart, and drops what is too old", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pinr-mkt-"));
    const file = join(dir, "market.json");
    const t = tok();
    let now = 1_000_000;
    const { f } = fakeFetch({
      "/pools?page=1": { status: 200, body: { data: [{ attributes: { address: "P1", name: "X / WETH", reserve_in_usd: "500" } }] } },
      "/ohlcv/hour": { status: 200, body: { data: { attributes: { ohlcv_list: CANDLES } } } },
    });
    const w = new MarketWorker(f, () => now);
    await w.step([t]);
    await w.step([t]);
    expect(w.stats().covered).toBe(1);
    w.saveTo(file);
    const w2 = new MarketWorker(f, () => now + 10 * 60_000);
    expect(w2.loadFrom(file)).toBe(1);
    expect(w2.stats().covered).toBe(1);
    expect(w2.enrich([t])[0]!.priceUsd).toBe(2.1);
    const w3 = new MarketWorker(f, () => now + 2 * 3600_000); // two hours later: the price reading is too old to show
    expect(w3.loadFrom(file)).toBe(0);
    expect(new MarketWorker(f).loadFrom(join(dir, "missing.json"))).toBe(0);
  });
});

describe("a busy chart service", () => {
  const CANDLES_FULL = Array.from({ length: 6 }, (_, i) => [3600 * (6 - i), 1, 2, 0.5, 1.5, 10]);
  const plan = (flip: { busy: boolean }): { f: Fetcher; calls: string[] } => {
    const calls: string[] = [];
    const f: Fetcher = async (url) => {
      calls.push(url);
      if (url.includes("/ohlcv/")) return flip.busy ? { status: 429, json: async () => ({}) } : { status: 200, json: async () => ({ data: { attributes: { ohlcv_list: CANDLES_FULL } } }) };
      return { status: 200, json: async () => ({ data: [{ attributes: { address: "pool1", name: "A / B", reserve_in_usd: "1000" } }] }) };
    };
    return { f, calls };
  };

  it("shows the last good chart as stale, with its own read time, while the service is busy; an empty busy answer when it never had one", async () => {
    let t = 1_000_000;
    const flip = { busy: false };
    const { f } = plan(flip);
    const w = new MarketWorker(f, () => t);
    expect((await w.chartFor(tok(), "1D")).status).toBe("ok");
    flip.busy = true;
    t += 2 * 60_000; // past the 1-minute freshness
    const shown = await w.chartFor(tok(), "1D");
    expect(shown.status).toBe("stale"); // never "ok": it is not current
    expect(shown.asOfMs).toBe(1_000_000); // the time the candles were really read
    expect(shown.candles.length).toBe(6);
    const tf = await w.candlesFor(tok(), "1m");
    expect(tf.status).toBe("busy"); // no 1m read was ever good: nothing to show
    t += 70 * 60_000; // still within the two hours the last good chart is kept
    expect((await w.chartFor(tok(), "1D")).status).toBe("stale");
    t += STALE_KEEP_MS; // far too old: no stale chart any more
    expect((await w.chartFor(tok(), "1D")).status).toBe("busy");
    const fresh = new MarketWorker(f, () => t);
    expect((await fresh.chartFor(tok({ mint: "0xabc0000000000000000000000000000000000002" }), "1W")).status).toBe("busy");
  });

  it("a refused chart read rests the charts 20 s each time; the background rests longer after each refusal in a row and starts over after a good answer", async () => {
    let t = 5_000_000;
    const flip = { busy: true };
    const { f, calls } = plan(flip);
    const w = new MarketWorker(f, () => t);
    await w.chartFor(tok(), "1D"); // refused: the charts rest 20 s, the background 60 s
    expect(w.stats().pausedForS).toBe(60);
    const n1 = calls.length;
    t += 10_000;
    await w.chartFor(tok(), "1D");
    expect(calls.length).toBe(n1); // still resting
    t += 11_000;
    await w.chartFor(tok(), "1D"); // asked again, refused again: the background now rests 120 s
    expect(calls.length).toBe(n1 + 1);
    expect(w.stats().pausedForS).toBe(120);
    t += 21_000;
    flip.busy = false;
    expect((await w.chartFor(tok(), "1D")).status).toBe("ok");
    t += 30_000;
    await w.chartFor(tok(), "1D");
    flip.busy = true;
    t += 61_000;
    await w.chartFor(tok(), "1D");
    expect(w.stats().pausedForS).toBe(60); // a good answer started the count over
  });

  it("keeps room for the pool: chart reads stop at the ceiling, and viewers of one chart share one call", async () => {
    let t = 9_000_000;
    const flip = { busy: false };
    const { f, calls } = plan(flip);
    const budget = new GeckoBudget(() => t);
    const w = new MarketWorker(f, () => t, undefined, budget);
    const [a, b] = await Promise.all([w.chartFor(tok(), "1D"), w.chartFor(tok(), "1D")]);
    expect(a.status).toBe("ok");
    expect(b.status).toBe("ok");
    expect(calls.filter((u) => u.includes("/ohlcv/")).length).toBe(1);
    while (budget.chartMayCall()) budget.record(); // the pool and others have used the allowance
    const before = calls.length;
    expect((await w.chartFor(tok({ mint: "0xabc0000000000000000000000000000000000003" }), "1D")).status).toBe("busy");
    expect(calls.length).toBe(before);
    t += 61_000; // a minute later the room is back
    expect((await w.chartFor(tok({ mint: "0xabc0000000000000000000000000000000000003" }), "1D")).status).toBe("ok");
  });

  it("the background sweep makes no call while the shared allowance is used, so the charts keep their room", async () => {
    let t = 9_000_000;
    const { f, calls } = plan({ busy: false });
    const budget = new GeckoBudget(() => t);
    const w = new MarketWorker(f, () => t, undefined, budget);
    while (budget.backgroundMayCall()) budget.record();
    await w.step([tok()]);
    expect(calls.length).toBe(0);
    expect(budget.chartMayCall()).toBe(true); // a chart read still has room
    t += 61_000;
    await w.step([tok()]);
    expect(calls.length).toBe(1);
  });
});

describe("chart reads under the home address's shared allowance (the team: every coin page in the apps said \"Chart busy\")", () => {
  const poolBody = { data: [{ attributes: { address: "0xpool", name: "A / B", reserve_in_usd: "100" } }] };
  const ohlcv = { data: { attributes: { ohlcv_list: [[3600, 1, 2, 0.5, 1.5, 10], [7200, 1.5, 3, 1, 2, 20]] } } };
  /** A fetcher whose answer can be switched between "refused" and "fine". */
  function switchable(): { f: Fetcher; calls: string[]; refuse: (on: boolean) => void } {
    const calls: string[] = [];
    let no = false;
    const f: Fetcher = async (url) => {
      calls.push(url);
      if (no) return { status: 429, json: async () => ({}) };
      return { status: 200, json: async () => (url.includes("/ohlcv/") ? ohlcv : url.includes("/tokens/multi/") ? { data: [] } : poolBody) };
    };
    return { f, calls, refuse: (on) => (no = on) };
  }
  it("a refused chart read rests the chart reads only briefly; the background readers keep their longer rest", async () => {
    let t = 0;
    const { f, calls, refuse } = switchable();
    const w = new MarketWorker(f, () => t);
    refuse(true);
    expect((await w.candlesFor(tok(), "1m")).status).toBe("busy");
    const n = calls.length;
    t = CHART_REST_MS - 1000;
    expect((await w.candlesFor(tok(), "1m")).status).toBe("busy");
    expect(calls.length).toBe(n); // still resting
    refuse(false);
    t = CHART_REST_MS + 1000;
    expect((await w.candlesFor(tok(), "1m")).status).toBe("ok"); // asked again after 20 s, not after a minute or five
    t += 31_000;
    const before = calls.length;
    await w.step([tok({ mint: "0xabc0000000000000000000000000000000000009" })]);
    expect(calls.length).toBe(before); // the background still rests (a minute after a refusal)
    expect(w.stats().chartPausedForS).toBe(0);
  });
  it("shows the last good candles, marked stale with their time, for up to two hours while the service refuses", async () => {
    let t = 1_000;
    const { f, refuse } = switchable();
    const w = new MarketWorker(f, () => t);
    expect((await w.candlesFor(tok(), "1m")).status).toBe("ok");
    refuse(true);
    t = 1_000 + 60 * 60_000;
    const r = await w.candlesFor(tok(), "1m");
    expect(r.status).toBe("stale");
    expect(r.asOfMs).toBe(1_000);
    expect(r.candles.length).toBe(2);
    t = 1_000 + STALE_KEEP_MS + 60_000;
    expect((await w.candlesFor(tok(), "1m")).status).toBe("busy"); // too old to show: nothing is shown as current
  });
  it("reads ahead the first coins' 1-minute candles, one per turn, again only after a while, without holding the background back", async () => {
    let t = 0;
    const { f, calls } = switchable();
    const w = new MarketWorker(f, () => t);
    const coins = Array.from({ length: WARM_TOP + 2 }, (_, i) => tok({ mint: `0xabc00000000000000000000000000000000000${String(10 + i)}` }));
    for (let i = 0; i < WARM_TOP + 2; i++) {
      t += 61_000; // each turn's two calls (pool, candles) are out of the last minute by the next
      await w.warm(coins);
    }
    const looked = new Set(calls.filter((u) => u.includes("/pools?page=1")).map((u) => u.split("/tokens/")[1]!.split("/")[0]));
    expect(looked.size).toBe(WARM_TOP); // the first six coins only
    for (const c of coins.slice(WARM_TOP)) expect(looked.has(c.address)).toBe(false);
    expect(calls.filter((u) => u.includes("/ohlcv/minute?aggregate=1&")).length).toBeGreaterThanOrEqual(WARM_TOP); // each read; the oldest again after three minutes
    const n = calls.length;
    const r = await w.candlesFor(coins[0]!, "1m");
    expect(["ok"].includes(r.status) || r.status === "stale").toBe(true);
    t += WARM_EVERY_MS;
    expect(await w.warm(coins)).toBe(true);
    expect(calls.length).toBeGreaterThan(n);
    const before = calls.length;
    await w.step([tok({ mint: "0xabc0000000000000000000000000000000000099" })]);
    expect(calls.length).toBe(before + 1); // a read-ahead is not a viewer: the background is not held back
  });
  it("leaves room: no read-ahead while the last minute is near the chart ceiling", async () => {
    const budget = new GeckoBudget(() => 0);
    for (let i = 0; i < 5; i++) budget.record();
    const { f, calls } = switchable();
    const w = new MarketWorker(f, () => 0, undefined, budget);
    expect(await w.warm([tok()])).toBe(false);
    expect(calls.length).toBe(0);
  });
});

describe("where the GeckoTerminal allowance goes", () => {
  it("counts the calls and the refusals of each kind: background market figures, a viewer's chart, a read-ahead, the new-pools reader", async () => {
    let t = 0;
    const budget = new GeckoBudget(() => t);
    const calls: string[] = [];
    let refuse = false;
    const f: Fetcher = async (url) => {
      calls.push(url);
      if (refuse) return { status: 429, json: async () => ({}) };
      return { status: 200, json: async () => (url.includes("/ohlcv/") ? { data: { attributes: { ohlcv_list: [[3600, 1, 2, 0.5, 1.5, 10], [7200, 1.5, 3, 1, 2, 20]] } } } : { data: [{ attributes: { address: "0xpool", name: "A / B", reserve_in_usd: "1" } }] }) };
    };
    const w = new MarketWorker(f, () => t, undefined, budget);
    await w.candlesFor(tok(), "1m"); // a viewer: pool lookup + candles
    t = 61_000;
    await w.warm([tok({ mint: "0xabc0000000000000000000000000000000000007" })]); // read ahead: pool lookup + candles
    t = 200_000;
    refuse = true;
    await w.step([tok({ mint: "0xabc0000000000000000000000000000000000008" })]); // background: refused
    budget.record("pools");
    const s = budget.stats();
    expect(s.calls).toEqual({ market: 1, chart: 2, ahead: 2, pools: 1 });
    expect(s.refused).toEqual({ market: 1, chart: 0, ahead: 0, pools: 0 });
    expect(s.sinceMin).toBe(3);
  });
});
