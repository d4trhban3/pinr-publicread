import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { addUp, CandleFiles, CONTRACT, parseCandleFile, rowsToCandles, STALE_AFTER_MS } from "./candlefile.ts";

const MINT = "9shxhuNrptQZqC8pPJbrhgj4TscYHxTFsZrdBqrHGnmy";
const T0 = Date.UTC(2026, 9, 25, 4, 0);
const rows = (n: number, stepMs: number, from = T0) => Array.from({ length: n }, (_, i) => [from + i * stepMs, 1 + i, 2 + i, 0.5 + i, 1.5 + i, 10]);
const file = (over: Record<string, unknown> = {}) => ({ contract: CONTRACT, mint: MINT, source: "Pump.fun", link: `https://pump.fun/coin/${MINT}`, read_at: new Date(T0 + 3_600_000).toISOString(), currency: "USD", intervals: { "1m": rows(30, 60_000), "15m": rows(4, 900_000), "1h": rows(10, 3_600_000) }, ...over });

describe("Pump.fun's candles as the engine saves them", () => {
  it("reads the rows into candles in seconds, oldest first, empty buckets filled flat with no volume, bad rows left out", () => {
    const cs = rowsToCandles([[T0 + 120_000, 2, 3, 1, 2.5, 5], [T0, 1, 2, 0.5, 1.5, 10], [T0, 9, 9, 9, 9, 9], ["x"], [T0 + 60_000, -1, 1, 1, 1, 1]], 60);
    expect(cs).toEqual([
      [T0 / 1000, 1, 2, 0.5, 1.5, 10],
      [T0 / 1000 + 60, 1.5, 1.5, 1.5, 1.5, 0],
      [T0 / 1000 + 120, 2, 3, 1, 2.5, 5],
    ]);
  });
  it("adds smaller candles up into bigger ones", () => {
    const cs = rowsToCandles(rows(8, 3_600_000), 3600);
    const four = addUp(cs, 14_400);
    expect(four).toHaveLength(2);
    expect(four[0]).toEqual([T0 / 1000, 1, 5, 0.5, 4.5, 40]);
  });
  it("takes only a candles-1 file of this coin in dollars; an interval not in the file is no answer, not an empty chart", () => {
    expect(parseCandleFile(file(), MINT)).not.toBeNull();
    expect(parseCandleFile(file({ contract: "candles-2" }), MINT)).toBeNull();
    expect(parseCandleFile(file(), "OtherMint1111111111111111111111111111111111")).toBeNull();
    expect(parseCandleFile(file({ currency: "SOL" }), MINT)).toBeNull();
    expect(parseCandleFile(file({ read_at: "never" }), MINT)).toBeNull();
    const p = parseCandleFile(file(), MINT)!;
    expect(Object.keys(p.sizes).sort()).toEqual(["15m", "1h", "1m"]);
    expect(p.link).toBe(`https://pump.fun/coin/${MINT}`);
  });
  it("answers each size from the file (4h and 1D from 1h), stale with its read time once old, and nothing for a coin with no file or a damaged one", () => {
    const dir = mkdtempSync(join(tmpdir(), "cf-"));
    writeFileSync(join(dir, `${MINT}.json`), JSON.stringify(file()));
    let t = T0 + 3_600_000 + 60_000;
    const f = new CandleFiles(dir, () => t);
    const m1 = f.candles(MINT, "1m", 1000)!;
    expect(m1.status).toBe("ok");
    expect(m1.bucketSec).toBe(60);
    expect(m1.candles).toHaveLength(30);
    expect(f.candles(MINT, "5m", 1000)!.candles).toHaveLength(6); // not in this file: added up from 1m
    expect(f.candles(MINT, "4h", 1000)!.candles.length).toBe(3);
    expect(f.candles(MINT, "1D", 1000)).toBeNull(); // ten hours make one day: not a chart
    expect(f.range(MINT, "1D")!.bucketSec).toBe(900);
    expect(f.range(MINT, "ALL")!.bucketSec).toBe(60); // the whole life at the finest size
    t += STALE_AFTER_MS;
    const old = f.candles(MINT, "1m", 10)!;
    expect(old.status).toBe("stale");
    expect(old.asOfMs).toBe(T0 + 3_600_000);
    expect(old.candles).toHaveLength(10);
    expect(f.candles("NoFile111111111111111111111111111111111111", "1m", 10)).toBeNull();
    expect(f.candles("../etc/passwd", "1m", 10)).toBeNull();
    writeFileSync(join(dir, `${MINT}.json`), "{half");
    expect(f.candles(MINT, "1m", 10)).toBeNull();
  });
});

describe("each size's own read time (read: {interval: ISO})", () => {
  it("judges a size stale by its own read time and its own pace: 1h is fresh for three hours, 1m for half an hour", () => {
    const dir = mkdtempSync(join(tmpdir(), "cf-"));
    const readAt = T0 + 3_600_000;
    writeFileSync(join(dir, `${MINT}.json`), JSON.stringify(file({ read: { "1m": new Date(readAt).toISOString(), "1h": new Date(readAt - 50 * 60_000).toISOString() } })));
    let t = readAt + 31 * 60_000;
    const f = new CandleFiles(dir, () => t);
    expect(f.candles(MINT, "1m", 10)!.status).toBe("stale");
    expect(f.candles(MINT, "1h", 10)!.status).toBe("ok"); // read 81 minutes ago, on an hourly pace
    expect(f.candles(MINT, "4h", 10)!.status).toBe("ok"); // added up from 1h, judged by 1h's read
    t = readAt - 50 * 60_000 + 3 * 60 * 60_000 + 1000;
    const h = f.candles(MINT, "1h", 10)!;
    expect(h.status).toBe("stale");
    expect(h.asOfMs).toBe(readAt - 50 * 60_000);
  });
});

describe("a coin too young for the range's size", () => {
  it("is drawn at the finest size that gives two candles, as Pump.fun's page does", () => {
    const dir = mkdtempSync(join(tmpdir(), "cf-"));
    writeFileSync(join(dir, `${MINT}.json`), JSON.stringify(file({ intervals: { "1m": rows(5, 60_000), "5m": rows(2, 300_000), "15m": rows(1, 900_000) } })));
    const f = new CandleFiles(dir, () => T0 + 3_600_000);
    const r = f.range(MINT, "1D")!;
    expect(r.bucketSec).toBe(300); // 15m has one candle: 5m gives two
    expect(f.range(MINT, "1W")!.bucketSec).toBe(300); // no 1h in the file: the finest that gives two
    expect(f.candles(MINT, "15m", 1000)).toBeNull(); // a timeframe asked for by name stays that size
  });
});

describe("5m and 15m from 1m", () => {
  it("adds 1m up into 5m and 15m when the file has no read of its own, judged by 1m's read time; a read of its own wins", () => {
    const dir = mkdtempSync(join(tmpdir(), "cf-"));
    const readAt = T0 + 3_600_000;
    writeFileSync(join(dir, `${MINT}.json`), JSON.stringify(file({ intervals: { "1m": rows(30, 60_000), "1h": rows(3, 3_600_000) }, read: { "1m": new Date(readAt).toISOString() } })));
    let t = readAt + 60_000;
    const f = new CandleFiles(dir, () => t);
    const five = f.candles(MINT, "5m", 1000)!;
    expect(five.bucketSec).toBe(300);
    expect(five.candles).toHaveLength(6);
    expect(five.candles[0]).toEqual([T0 / 1000, 1, 6, 0.5, 5.5, 50]);
    expect(f.candles(MINT, "15m", 1000)!.candles).toHaveLength(2);
    expect(f.range(MINT, "1D")!.bucketSec).toBe(900);
    t = readAt + 31 * 60_000;
    expect(f.candles(MINT, "15m", 1000)!.status).toBe("stale"); // 1m's read time and pace
    writeFileSync(join(dir, `${MINT}.json`), JSON.stringify(file({ intervals: { "1m": rows(30, 60_000), "5m": rows(2, 300_000) } })));
    expect(f.candles(MINT, "5m", 1000)!.candles).toHaveLength(2); // Pump.fun's own 5m
  });
});
