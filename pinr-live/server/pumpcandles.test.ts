import { describe, expect, it } from "vitest";
import { allInterval, CHALLENGE_REST_MS, cleanCandles, finerSizes, isPumpLaunchpad, PumpCandles, RANGE_PLAN, REST_MS, SECONDS, TTL_MS, type PumpGet } from "./pumpcandles";

const M = "A7rRfLf67GMp5DFeY7s4kUaZLZbbz6UFPM5XYSg2pump";
const row = (tMs: number, o: string, h: string, l: string, c: string, v = "10") => ({ timestamp: tMs, open: o, high: h, low: l, close: c, volume: v });

describe("Pump.fun's candle history", () => {
  it("reads string prices into numbers, in seconds, oldest first, volume in dollars", () => {
    const c = cleanCandles([row(120_000, "0.2", "0.4", "0.1", "0.3", "5.5"), row(60_000, "0.1", "0.2", "0.1", "0.2", "2")], 60);
    expect(c).toEqual([[60, 0.1, 0.2, 0.1, 0.2, 2], [120, 0.2, 0.4, 0.1, 0.3, 5.5]]);
  });
  it("fills a quiet stretch with flat candles of the last close and no volume, as Pump.fun's own chart draws it", () => {
    const c = cleanCandles([row(60_000, "1", "2", "1", "2"), row(240_000, "2", "3", "2", "3")], 60);
    expect(c.map((x) => x[0])).toEqual([60, 120, 180, 240]);
    expect(c[1]).toEqual([120, 2, 2, 2, 2, 0]);
    expect(c[2]).toEqual([180, 2, 2, 2, 2, 0]);
  });
  it("drops a bad row alone: no price, a zero price, a high under the low, a repeat time", () => {
    const c = cleanCandles([row(60_000, "1", "2", "1", "2"), { timestamp: 120_000 }, row(180_000, "0", "1", "0", "1"), row(240_000, "1", "1", "2", "1"), row(60_000, "9", "9", "9", "9"), "x", null], 60);
    expect(c).toHaveLength(1);
    expect(c[0]![4]).toBe(2);
  });
  it("is empty for anything that is not a list", () => {
    expect(cleanCandles(null, 60)).toEqual([]);
    expect(cleanCandles({ statusCode: 400 }, 60)).toEqual([]);
  });
});

describe("the server's pass-through", () => {
  const ok = (rows: unknown[], calls: string[] = []): PumpGet => async (u) => (calls.push(u), { status: 200, json: async () => rows });
  it("asks Pump.fun's endpoint for dollars, with a createdTs integer, and returns the newest `limit`", async () => {
    const calls: string[] = [];
    let now = 1_000_000;
    const p = new PumpCandles(ok([row(60_000, "1", "2", "1", "2"), row(120_000, "2", "3", "2", "3"), row(180_000, "3", "4", "3", "4")], calls), () => now);
    const c = await p.candles(M, "1m", 2, 1_791_670_556_000);
    expect(c!.map((x) => x[0])).toEqual([120, 180]);
    expect(calls[0]).toContain(`swap-api.pump.fun/v2/coins/${M}/candles?interval=1m`);
    expect(calls[0]).toContain("currency=USD");
    expect(calls[0]).toContain("createdTs=1791670556000");
    await p.candles(M, "1m", 2); // no launch time: still an integer
    now += TTL_MS["1m"] + 1;
    await p.candles(M, "1m", 2);
    expect(calls[calls.length - 1]).toContain("createdTs=1791670556000".replace("1791670556000", "1"));
  });
  it("keeps an answer for its size's time and does not ask again", async () => {
    const calls: string[] = [];
    let now = 1_000_000;
    const p = new PumpCandles(ok([row(60_000, "1", "2", "1", "2"), row(120_000, "2", "3", "2", "3")], calls), () => now);
    await p.candles(M, "5m", 100);
    now += TTL_MS["5m"] - 1;
    await p.candles(M, "5m", 100);
    expect(calls).toHaveLength(1);
    expect(p.stat.hits).toBe(1);
  });
  it("rests a minute when Pump.fun refuses (a 403 or 429) and serves what it held meanwhile", async () => {
    let now = 1_000_000;
    let status = 200;
    const calls: string[] = [];
    const get: PumpGet = async () => (calls.push("x"), { status, json: async () => [row(60_000, "1", "2", "1", "2"), row(120_000, "2", "3", "2", "3")] });
    const p = new PumpCandles(get, () => now);
    expect(await p.candles(M, "5m", 100)).toHaveLength(2);
    now += TTL_MS["5m"] + 1;
    status = 429;
    expect(await p.candles(M, "5m", 100)).toHaveLength(2); // the held answer
    const n = calls.length;
    now += 10_000;
    await p.candles(M, "1h", 100);
    expect(calls).toHaveLength(n); // resting
    now += REST_MS;
    status = 200;
    await p.candles(M, "1h", 100);
    expect(calls).toHaveLength(n + 1);
  });
  it("answers null for a bad address, an unknown size, or no candles", async () => {
    const p = new PumpCandles(ok([]));
    expect(await p.candles("../x", "1m", 10)).toBeNull();
    expect(await p.candles(M, "2m" as never, 10)).toBeNull();
    expect(await p.candles(M, "1m", 10)).toBeNull();
  });
});

describe("which size each range takes", () => {
  it("plans the page's ranges, and the whole life at the finest size that fits about 300 candles", () => {
    expect(RANGE_PLAN["1D"]).toEqual({ interval: "15m", limit: 96 });
    expect(Object.keys(RANGE_PLAN)).toEqual(["1D", "1W", "1M", "3M"]);
    expect(allInterval(3 * 3600)).toBe("1m");
    expect(allInterval(5 * 86400)).toBe("30m");
    expect(allInterval(1000 * 86400)).toBe("12h");
    for (const i of Object.keys(SECONDS)) expect(TTL_MS[i as keyof typeof TTL_MS]).toBeGreaterThan(0);
  });
  it("recognises Pump.fun and PumpSwap coins only", () => {
    for (const l of ["Pump.fun curve", "PumpSwap (graduated)", "pumpfun"]) expect(isPumpLaunchpad(l)).toBe(true);
    for (const l of ["bonk.fun LaunchLab curve", "Clanker", null, undefined, ""]) expect(isPumpLaunchpad(l as never)).toBe(false);
  });
  it("tries finer sizes for a young coin, ending at fifteen seconds", () => {
    expect(finerSizes("15m")).toEqual(["15m", "5m", "1m", "30s", "15s"]);
    expect(finerSizes("12h")[0]).toBe("12h");
    expect(finerSizes("15s")).toEqual(["15s"]);
  });
  it("rests ten minutes on Pump.fun's bot challenge (403), and does not ask meanwhile", async () => {
    let now = 1_000_000;
    const calls: string[] = [];
    const get: PumpGet = async () => (calls.push("x"), { status: 403, json: async () => ({}) });
    const p = new PumpCandles(get, () => now);
    expect(await p.candles(M, "5m", 100)).toBeNull();
    now += CHALLENGE_REST_MS - 1000;
    expect(await p.candles(M, "1h", 100)).toBeNull();
    expect(calls).toHaveLength(1);
    now += 2000;
    await p.candles(M, "1h", 100);
    expect(calls).toHaveLength(2);
  });
});
