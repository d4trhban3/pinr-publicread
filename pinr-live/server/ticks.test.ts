import { mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { StreamHub } from "./stream";
import { aggregate, dollars, dropOutliers, fromTrades, parseTicks, SOL_MINT, TickReader, withLiveEnd, type FolderWatch } from "./ticks";

/** curve coins' own trades from the engine's tick files (contract "ticks-1", ops/PLAN-206-WEBSOCKET.md section 5). */
const MINT = "Ab1kBXb1nPp4qLoDw8pWpY6M7pRcHhVq6nZyK2vGpump";
const T = 1_792_552_500_000; // ms, on a 5-minute boundary
const tick = (i: number, side: "buy" | "sell", price: number, sol: number, dt = 0) => ({ t: T + dt, t_is_receipt: true, slot: 459469437 + i, sig: `slot:${459469437 + i}`, side, tokens: sol / price, sol, price_sol: price, quote: SOL_MINT, from_state: true, merged_possible: true, i: 0 });
/** the engine's example shape, section 5 of the plan. */
const file = (ticks: unknown[], over: Record<string, unknown> = {}) => ({
  contract: "ticks-1", mint: MINT, source: "Solana chain", read_at: "2026-10-21T03:00:00Z", quote: SOL_MINT, ticks,
  candles_5m: [
    { t: T, o: 4.16e-8, h: 4.16e-8, l: 3.51e-8, c: 3.76e-8, v: 4.17, buys: 1, sells: 10 },
    { t: T + 300_000, o: 3.76e-8, h: 4.0e-8, l: 3.7e-8, c: 3.9e-8, v: 1.5, buys: 3, sells: 1 },
    { t: T + 900_000, o: 3.9e-8, h: 4.2e-8, l: 3.9e-8, c: 4.1e-8, v: 2, buys: 2, sells: 0 },
  ],
  graduated_at: null, gaps: [], ...over,
});
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const write = (dir: string, body: unknown): void => {
  const tmp = join(dir, `_tmp-${MINT}.json`);
  writeFileSync(tmp, JSON.stringify(body));
  renameSync(tmp, join(dir, `${MINT}.json`));
};
const manual = (): { watch: FolderWatch; fire: (n: string | null) => void } => {
  let cb: (n: string | null) => void = () => {};
  return { watch: (_d, c) => ((cb = c), () => {}), fire: (n) => cb(n) };
};

describe("the tick file", () => {
  it("reads the engine's shape: trades and 5-minute candles in SOL; another quote coin, a bad row or another contract is left out", () => {
    const p = parseTicks(file([tick(1, "buy", 4e-8, 0.01), { ...tick(2, "sell", 4e-8, 0.01), quote: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v" }, { side: "buy" }]))!;
    expect(p.trades.map((t) => t.key)).toEqual(["slot:459469438:0"]);
    expect(p.candles5m).toEqual([[T / 1000, 4.16e-8, 4.16e-8, 3.51e-8, 3.76e-8, 4.17], [T / 1000 + 300, 3.76e-8, 4.0e-8, 3.7e-8, 3.9e-8, 1.5], [T / 1000 + 900, 3.9e-8, 4.2e-8, 3.9e-8, 4.1e-8, 2]]);
    expect(parseTicks({ ...file([]), contract: "ticks-2" })).toBeNull();
    expect(parseTicks({ ...file([]), source: "Helius" })).toBeNull();
    expect(parseTicks(file([], { quote: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v" }))!.candles5m).toEqual([]);
  });
  it("candles in dollars at the SOL price: 15 minutes from the 5-minute ones, 1 minute from the trades", () => {
    const p = parseTicks(file([]))!;
    const c15 = aggregate(p.candles5m, 900, 200);
    expect(c15.length).toBe(2);
    expect(c15[0]![0]).toBe(Math.floor(T / 1000 / 900) * 900);
    expect(c15[0]![2]).toBeCloseTo(4.16e-8 * 200, 15);
    expect(c15[0]![3]).toBeCloseTo(3.51e-8 * 200, 15);
    expect(c15[0]![4]).toBeCloseTo(3.9e-8 * 200, 15);
    expect(c15[0]![5]).toBeCloseTo((4.17 + 1.5) * 200, 9);
    const m1 = fromTrades(parseTicks(file([tick(1, "buy", 4e-8, 0.01), tick(2, "sell", 5e-8, 0.02, 30_000), tick(3, "buy", 4.5e-8, 0.03, 70_000)]))!.trades, 60, 200);
    expect(m1.map((k) => k[4] / 200)).toEqual([5e-8, 4.5e-8]);
    expect(m1[1]![1]).toBeCloseTo(5e-8 * 200, 15); // opens at the last close
  });
});

describe("looking a coin up by its lower-case address (bounded: it was a scan of every file per lookup)", () => {
  it("finds a file by the lower-case spelling, after a change too, and gives nothing for an unknown coin", () => {
    const dir = mkdtempSync(join(tmpdir(), "pinr-ticks-"));
    dirs.push(dir);
    const w = manual();
    const r = new TickReader(dir, () => T, w.watch);
    write(dir, file([tick(1, "buy", 4e-8, 0.01)]));
    w.fire(`${MINT}.json`);
    r.refresh();
    expect(r.activity(MINT.toLowerCase(), 0, 200)).toEqual({ n: 1, usd: 0.01 * 200 });
    expect(r.activity("zzzzzzzz".repeat(5), 0, 200)).toBeNull();
    rmSync(join(dir, `${MINT}.json`));
    w.fire(`${MINT}.json`);
    r.refresh();
    expect(r.activity(MINT.toLowerCase(), 0, 200)).toBeNull(); // the index follows the files
  });
  it("answers thousands of lookups for coins with no file in a small fraction of a second", () => {
    const dir = mkdtempSync(join(tmpdir(), "pinr-ticks-"));
    dirs.push(dir);
    const r = new TickReader(dir, () => T, null);
    for (let n = 0; n < 4; n++) writeFileSync(join(dir, `${MINT.slice(0, -1)}${"abcd"[n]}.json`), JSON.stringify(file([tick(1, "buy", 4e-8, 0.01)], { mint: `${MINT.slice(0, -1)}${"abcd"[n]}` })));
    r.refresh();
    const t0 = Date.now();
    for (let i = 0; i < 20_000; i++) r.activity(`Q${i}`.padEnd(40, "x"), 0, 200);
    expect(Date.now() - t0).toBeLessThan(1500);
  });
});

describe("the tick reader", () => {
  it("gives a coin's candles only with a SOL price and at least two; a changed file is read again; each trade goes to the stream once, none on first sight", () => {
    const dir = mkdtempSync(join(tmpdir(), "pinr-ticks-"));
    dirs.push(dir);
    const w = manual();
    let now = T;
    const r = new TickReader(dir, () => now, w.watch);
    write(dir, file([tick(1, "buy", 4e-8, 0.01)]));
    w.fire(`${MINT}.json`);
    expect(r.refresh()).toEqual([MINT]);
    expect(r.candles(MINT, 300, 288, null)).toBeNull();
    expect(r.candles(MINT, 300, 288, 200)!.candles.length).toBe(3);
    expect(r.newTrades([MINT], 200)).toEqual([]); // first sight: recorded, not flooded
    write(dir, file([tick(1, "buy", 4e-8, 0.01), tick(2, "sell", 5e-8, 0.02, 1000)]));
    w.fire(`${MINT}.json`);
    now += 2000;
    expect(r.refresh()).toEqual([MINT]);
    expect(r.newTrades([MINT], 200)).toEqual([{ address: MINT, atMs: T + 1000, side: "sell", priceUsd: 5e-8 * 200, usd: 0.02 * 200 }]);
    expect(r.newTrades([MINT], 200)).toEqual([]);
    rmSync(join(dir, `${MINT}.json`));
    w.fire(`${MINT}.json`);
    r.refresh();
    expect(r.candles(MINT, 300, 288, 200)).toBeNull();
  });
  it("counts a coin's trades and dollars in a window from its tick file, and gives nothing without a file or a SOL price", () => {
    const dir = mkdtempSync(join(tmpdir(), "pinr-ticks-"));
    dirs.push(dir);
    const w = manual();
    const r = new TickReader(dir, () => T + 3_600_000, w.watch);
    write(dir, file([tick(1, "buy", 4e-8, 0.01), tick(2, "sell", 5e-8, 0.02, 1_790_000)]));
    w.fire(`${MINT}.json`);
    r.refresh();
    // the second trade is 10 seconds before the 30-minute mark's end: it falls inside a window that starts at T + 1_790_000 - 1
    expect(r.activity(MINT, T + 1_700_000, 200)).toEqual({ n: 1, usd: 0.02 * 200 });
    expect(r.activity(MINT, T - 1, 200)).toEqual({ n: 2, usd: (0.01 + 0.02) * 200 });
    expect(r.activity(MINT, T - 1, null)).toBeNull();
    expect(r.activity("Z".repeat(44), T - 1, 200)).toBeNull();
  });
  it("a young coin with too few candles at the asked size gets the finest size that has two, else what it has (the engine's live find)", () => {
    const dir = mkdtempSync(join(tmpdir(), "pinr-ticks-"));
    dirs.push(dir);
    const w = manual();
    const r = new TickReader(dir, () => T, w.watch);
    // three 5-minute candles inside one quarter hour: 15 minutes gives one, 5 minutes gives three
    write(dir, file([tick(1, "buy", 4e-8, 0.01), tick(2, "sell", 5e-8, 0.02, 70_000)], { candles_5m: [
      { t: T, o: 4e-8, h: 4e-8, l: 4e-8, c: 4e-8, v: 1, buys: 1, sells: 0 },
      { t: T + 300_000, o: 4e-8, h: 5e-8, l: 4e-8, c: 5e-8, v: 1, buys: 1, sells: 0 },
      { t: T + 600_000, o: 5e-8, h: 5e-8, l: 4.5e-8, c: 4.5e-8, v: 1, buys: 0, sells: 1 } ] }));
    w.fire(`${MINT}.json`);
    r.refresh();
    expect(r.candles(MINT, 900, 96, 200)).toMatchObject({ bucketSec: 300 });
    expect(r.candles(MINT, 900, 96, 200)!.candles.length).toBe(3);
    // one candle only, and the trades fall in one minute too: the one candle is still given
    write(dir, file([tick(1, "buy", 4e-8, 0.01)], { candles_5m: [{ t: T, o: 4e-8, h: 4e-8, l: 4e-8, c: 4e-8, v: 1, buys: 1, sells: 0 }] }));
    w.fire(`${MINT}.json`);
    r.refresh();
    expect(r.candles(MINT, 900, 96, 200)).toMatchObject({ bucketSec: 900 });
    expect(r.candles(MINT, 900, 96, 200)!.candles.length).toBe(1);
    // no candle and no trade: nothing from the ticks, the other sources answer
    write(dir, file([], { candles_5m: [] }));
    w.fire(`${MINT}.json`);
    r.refresh();
    expect(r.candles(MINT, 900, 96, 200)).toBeNull();
  });

  it("the stream carries the trades as one message", () => {
    const hub = new StreamHub();
    const out: string[] = [];
    const res = { writeHead: () => res, write: (t: string) => (out.push(t), true), end: () => {}, on: () => res } as never;
    const req = { headers: {}, on: () => req } as never;
    hub.publishFirst([], {});
    hub.attach(req, res, { boot: hub.boot, seq: 0 });
    hub.publishTrades([{ address: MINT, atMs: T, side: "buy", priceUsd: 8e-6, usd: 2 }]);
    const msg = JSON.parse(/data: (.*)\n\n$/.exec(out.join(""))![1]!);
    expect(msg.trades).toEqual([{ address: MINT, atMs: T, side: "buy", priceUsd: 8e-6, usd: 2 }]);
    hub.publishTrades([]);
    expect(out.filter((t) => t.includes("event: changes")).length).toBe(1);
  });
});

describe("a changed tick file is told at once", () => {
  it("calls back when the watch sees a coin's file change, and not for other names", () => {
    const dir = mkdtempSync(join(tmpdir(), "tk-"));
    const w = manual();
    const r = new TickReader(dir, () => 0, w.watch);
    let n = 0;
    r.onChange(() => n++);
    w.fire("So1Coin1111111111111111111111111111111111111.json");
    w.fire("_index.json");
    w.fire("notes.txt");
    w.fire(null);
    expect(n).toBe(2); // the coin's file, and a full pass asked for
  });
});

describe("ticks-1's dollar fields", () => {
  const USD1 = "USD1ttGY1N17NEEHLmELoaybftRBUSErhqYiQzvEmuB";
  const T0 = 1_792_900_000_000;
  const usdTick = (i: number, price: number, usd: number) => ({ t: T0 + i * 1000, sig: `u${i}`, i: 0, side: i % 2 ? "sell" : "buy", quote: USD1, quote_amount: usd, price_quote: price, price_usd: price, usd, price_usd_src: "Jupiter price v3, read 2026-10-25T12:00:00Z" });
  it("keeps a trade quoted in another coin when it carries all three dollar fields, and leaves it out otherwise", () => {
    const p = parseTicks({ contract: "ticks-1", source: "Solana chain", ticks: [usdTick(1, 0.002, 10), { ...usdTick(2, 0.002, 10), price_usd_src: undefined }, { ...usdTick(3, 0.002, 10), price_usd: undefined }] })!;
    expect(p.trades.map((t) => t.key)).toEqual(["u1:0"]);
    expect(p.trades[0]).toMatchObject({ priceSol: null, sol: null, priceUsd: 0.002, usd: 10 });
  });
  it("prefers a trade's own dollar figures, else its SOL ones at the SOL price, else nothing", () => {
    expect(dollars({ key: "a", atMs: 0, side: "buy", priceSol: 1e-8, sol: 0.5, priceUsd: 2e-6, usd: 49 }, 100)).toEqual({ price: 2e-6, usd: 49 });
    expect(dollars({ key: "b", atMs: 0, side: "buy", priceSol: 1e-8, sol: 0.5 }, 100)).toEqual({ price: 1e-6, usd: 50 });
    expect(dollars({ key: "c", atMs: 0, side: "buy", priceSol: 1e-8, sol: 0.5 }, null)).toBeNull();
    expect(dollars({ key: "d", atMs: 0, side: "buy", priceSol: null, sol: null }, 100)).toBeNull();
  });
  it("sends a pushed dollar-priced trade to the stream even with no SOL price, and draws candles from such trades", () => {
    const dir = mkdtempSync(join(tmpdir(), "tq-"));
    const r = new TickReader(dir, () => T0 + 3_000, null); // the trades are 1 to 2 s old
    const mint = "So1Usd1Coin111111111111111111111111111111111";
    expect(r.pushed(mint, [usdTick(1, 0.002, 10), usdTick(2, 0.0021, 12)], null)).toEqual([
      { address: mint, atMs: T0 + 1000, side: "sell", priceUsd: 0.002, usd: 10 },
      { address: mint, atMs: T0 + 2000, side: "buy", priceUsd: 0.0021, usd: 12 },
    ]);
    expect(fromTrades(parseTicks({ contract: "ticks-1", source: "Solana chain", ticks: [usdTick(1, 0.002, 10), usdTick(70, 0.003, 5)] })!.trades, 60, null).map((c) => c[4])).toEqual([0.002, 0.003]);
  });
});

describe("the coin page from the coin's own trades", () => {
  it("gives the recent trades as the page's rows, newest first, in dollars", () => {
    const dir = mkdtempSync(join(tmpdir(), "tr-"));
    const r = new TickReader(dir, () => 0, null);
    const mint = MINT;
    write(dir, { contract: "ticks-1", source: "Solana chain", read_at: new Date(5_000_000).toISOString(), ticks: [{ t: 1_000_000, sig: "a", i: 0, side: "buy", sol: 1, price_sol: 1e-8 }, { t: 2_000_000, sig: "b", i: 0, side: "sell", sol: 0.5, price_sol: 1e-8 }] });
    r.refresh();
    expect(r.tradesFile(mint, 100)).toEqual({ trades: [[2000, "sell", 50], [1000, "buy", 100]], coversFrom: 1000, complete: false, asOf: 5000 });
    expect(r.tradesFile(mint, null)).toBeNull(); // no dollar figure for SOL trades without a SOL price
  });
  it("lays the trades' candles over a chart's live end, merging the shared candle and touching nothing older", () => {
    const hist: [number, number, number, number, number, number][] = [[0, 1, 2, 0.5, 1.5, 10], [60, 1.5, 3, 1, 2, 20]];
    const live: [number, number, number, number, number, number][] = [[30, 9, 9, 9, 9, 9], [60, 2.2, 4, 1.8, 3.5, 5], [120, 3.5, 3.6, 3.4, 3.5, 2]];
    expect(withLiveEnd(hist, live)).toEqual([[0, 1, 2, 0.5, 1.5, 10], [60, 1.5, 4, 1, 3.5, 20], [120, 3.5, 3.6, 3.4, 3.5, 2]]);
    expect(withLiveEnd(hist, [])).toEqual(hist);
    expect(withLiveEnd(hist, [[0, 5, 5, 5, 5, 5]])).toEqual(hist); // older than the history's end: left alone
  });
});

describe("memory: a tick file untouched for a day is not held", () => {
  it("leaves a stale file on disk and out of memory, and reads it again once it changes", async () => {
    const { STALE_FILE_MS } = await import("./ticks");
    const { utimesSync } = await import("node:fs");
    const dir = mkdtempSync(join(tmpdir(), "ts-"));
    let now = Date.now();
    const r = new TickReader(dir, () => now, null);
    write(dir, { contract: "ticks-1", source: "Solana chain", ticks: [{ t: now, sig: "s", i: 0, side: "buy", sol: 1, price_sol: 1e-8 }] });
    const old = (now - STALE_FILE_MS - 60_000) / 1000;
    utimesSync(join(dir, `${MINT}.json`), old, old);
    r.refresh();
    expect(r.size).toBe(0);
    utimesSync(join(dir, `${MINT}.json`), now / 1000, now / 1000);
    now += 11 * 60_000; // the next full pass
    r.refresh();
    expect(r.size).toBe(1);
  });
});

describe("the writer's own count of the last hour's trades", () => {
  it("is read when all three counts are there, and is no answer otherwise (never a part-hour count)", () => {
    expect(parseTicks({ contract: "ticks-1", source: "Solana chain", ticks: [], trades_1h: 40, buys_1h: 25, sells_1h: 15 })!.hour).toEqual({ n: 40, buys: 25, sells: 15 });
    expect(parseTicks({ contract: "ticks-1", source: "Solana chain", ticks: [], trades_1h: 40 })!.hour).toBeUndefined();
  });
});

describe("a busy coin's 30-minute figures are a floor when its file's kept trades do not reach back the whole window", () => {
  it("marks the sums 'at least' when 500 kept trades all sit inside the window, and not when the file reaches back past it", async () => {
    const { KEEP_TRADES_FLOOR } = await import("./ticks");
    const dir = mkdtempSync(join(tmpdir(), "tf-"));
    const now = Date.now();
    const r = new TickReader(dir, () => now, null);
    const ticks = (from: number) => Array.from({ length: KEEP_TRADES_FLOOR }, (_, i) => ({ t: from + i * 1000, sig: `s${i}`, i: 0, side: "buy", sol: 0.1, price_sol: 1e-8 }));
    write(dir, { contract: "ticks-1", source: "Solana chain", ticks: ticks(now - 600_000) });
    r.refresh();
    expect(r.activity(MINT, now - 1_800_000, 100)).toMatchObject({ n: KEEP_TRADES_FLOOR, atLeast: true });
    write(dir, { contract: "ticks-1", source: "Solana chain", ticks: ticks(now - 3_600_000) });
    const r2 = new TickReader(dir, () => now, null);
    r2.refresh();
    expect(r2.activity(MINT, now - 1_800_000, 100)!.atLeast).toBeUndefined();
  });

  it("spreads every full pass, the first after a start too, over the 2-second passes, so it never holds the server up (2.2 s at once on the server, 2026-10-25)", () => {
    const dir = mkdtempSync(join(tmpdir(), "pinr-ticks-"));
    dirs.push(dir);
    let now = T;
    const r = new TickReader(dir, () => now, null);
    // Lower case and digits only: two names that differ only in case are one file on a Mac's disk.
    const A = "123456789abcdefghijkmnopqrstuvwxyz";
    const mints = Array.from({ length: 900 }, (_, i) => `${MINT.slice(0, -2)}${A[Math.floor(i / A.length)]}${A[i % A.length]}`);
    const put = (sol: number) => {
      for (const m of mints) writeFileSync(join(dir, `${m}.json`), JSON.stringify(file([tick(1, "buy", 4e-8, sol)], { mint: m })));
    };
    put(0.01);
    // checklist 4: the first pass after a start is spread too (it held the server up 4.0 s), and still reaches every file
    const start = new Set(r.refresh());
    expect(start.size).toBeLessThanOrEqual(400);
    for (let i = 0; i < 5; i++) for (const m of r.refresh()) start.add(m);
    expect(start.size).toBe(mints.length);
    put(0.02);
    now += 10 * 60_000;
    const seen = new Set<string>();
    const first = r.refresh();
    expect(first.length).toBeLessThanOrEqual(400);
    for (const m of first) seen.add(m);
    for (let i = 0; i < 5; i++) for (const m of r.refresh()) seen.add(m);
    expect(seen.size).toBe(mints.length); // and the spread-out pass still reaches every file
  });
});


/** Checklist 11: a BNB or Base coin's own trades, from the engine's tick file, give it a chart and a trade ribbon (replayed from stored trades). */
describe("a BNB or Base coin's tick file (checklist 11)", () => {
  const BNB = "0xdd6882c0cb9930c5c724deae12c5627641957777";
  const evmTick = (i: number, side: "buy" | "sell", priceUsd: number, usd: number, dt: number) => ({ t: T + dt, side, sig: `0xabc${i}`, i: 0, price_usd: priceUsd, usd, price_usd_src: "the swap's own USD pair" });
  const evmFile = (ticks: unknown[], source = "BNB chain") => ({ contract: "ticks-1", mint: BNB, source, read_at: "2026-10-26T03:00:00Z", ticks });
  const stored = [evmTick(1, "buy", 0.00001, 5, 0), evmTick(2, "buy", 0.000012, 8, 30_000), evmTick(3, "sell", 0.000011, 3, 70_000), evmTick(4, "buy", 0.000013, 6, 130_000)];

  it("reads a BNB file (no SOL fields, dollars on each trade) and names its chain; an unknown chain is refused", () => {
    const p = parseTicks(evmFile(stored))!;
    expect(p.source).toBe("BNB chain");
    expect(p.trades).toHaveLength(4);
    expect(parseTicks(evmFile(stored, "Tron chain"))).toBeNull();
  });
  it("charts the replayed trades as one-minute candles in dollars, with no SOL price at all, and says where they came from", () => {
    const dir = mkdtempSync(join(tmpdir(), "ticks-evm-"));
    dirs.push(dir);
    writeFileSync(join(dir, `${BNB}.json`), JSON.stringify(evmFile(stored)));
    const r = new TickReader(dir, () => T + 200_000, null);
    r.refresh();
    expect(r.sourceOf(BNB)).toBe("BNB chain");
    const c = r.candles(BNB, 60, 100, null)!;
    expect(c.bucketSec).toBe(60);
    expect(c.candles.map((k) => [k[0], k[1], k[2], k[3], k[4], k[5]])).toEqual([
      [T / 1000, 0.00001, 0.000012, 0.00001, 0.000012, 13],
      [T / 1000 + 60, 0.000012, 0.000012, 0.000011, 0.000011, 3],
      [T / 1000 + 120, 0.000011, 0.000013, 0.000011, 0.000013, 6],
    ]);
    const tf = r.tradesFile(BNB, null)!;
    expect(tf.trades.map((x) => x[2])).toEqual([6, 3, 8, 5]);
    expect(r.candles(MINT, 60, 100, null)).toBeNull(); // a coin with no file: nothing, so the caller says "no trades read yet", never a blank chart
  });
  it("takes a pushed BNB trade and hands it out once", () => {
    const dir = mkdtempSync(join(tmpdir(), "ticks-evm-"));
    dirs.push(dir);
    const r = new TickReader(dir, () => T, null);
    const out = r.pushed(BNB, [evmTick(9, "sell", 0.00002, 4, 0)], null, "BNB chain");
    expect(out).toEqual([{ address: BNB, atMs: T, side: "sell", priceUsd: 0.00002, usd: 4 }]);
    expect(r.pushed(BNB, [evmTick(9, "sell", 0.00002, 4, 0)], null, "BNB chain")).toEqual([]);
  });
});

describe("one stray tick never sets a coin's price", () => {
  const BASE = "0x5989cfa0000000000000000000000000000000aa";
  const t = (i: number, usd: number): Record<string, unknown> => ({ t: T + i * 1000, side: "buy", sig: `0x${i}`, i: 0, price_usd: usd, usd: 5, price_usd_src: "the swap's own USD pair" });
  it("against the coin's other price: a tick 100 times above or below is dropped, the rest stay", () => {
    const p = parseTicks({ contract: "ticks-1", source: "Base chain", ticks: [t(1, 1.8e-14), t(2, 7.83e41), t(3, 2.0e-14), t(4, 1e-18)] })!;
    expect(dropOutliers(p.trades, 1.82e-14).map((x) => x.priceUsd)).toEqual([1.8e-14, 2.0e-14]);
    expect(dropOutliers(p.trades.filter((x) => x.priceUsd === 7.83e41), 1.82e-14)).toEqual([]);   // the lone tick of a near-empty pool
  });
  it("with no other price: a tick 1,000 times from the file's own median goes (three trades or more); two trades are left as they are", () => {
    const p = parseTicks({ contract: "ticks-1", source: "Base chain", ticks: [t(1, 1e-6), t(2, 1.1e-6), t(3, 0.9e-6), t(4, 5e3)] })!;
    expect(dropOutliers(p.trades, null)).toHaveLength(3);
    const two = parseTicks({ contract: "ticks-1", source: "Base chain", ticks: [t(1, 1e-6), t(2, 5e3)] })!;
    expect(dropOutliers(two.trades, null)).toHaveLength(2);
  });
  it("a price above $1e9 is never a price, even when the coin's other price is the same bad number (the feed file's price came from that tick)", () => {
    const p = parseTicks({ contract: "ticks-1", source: "Base chain", ticks: [t(1, 7.83e41)] })!;
    expect(dropOutliers(p.trades, 7.83e41)).toEqual([]);
  });
  it("the reader drops it from the chart too, once the server tells it the coin's other price", () => {
    const dir = mkdtempSync(join(tmpdir(), "ticks-out-"));
    dirs.push(dir);
    writeFileSync(join(dir, `${BASE}.json`), JSON.stringify({ contract: "ticks-1", mint: BASE, source: "Base chain", read_at: "2026-10-26T03:00:00Z", ticks: [t(1, 7.83e41)] }));
    const r = new TickReader(dir, () => T + 60_000, null);
    r.ref = () => 1.82e-14;
    r.refresh();
    expect(r.candles(BASE, 60, 100, null)).toBeNull();      // nothing to draw: the page says so, never $7.83e41
    expect(r.tradesFile(BASE, null)).toBeNull();
  });
});

describe("a coin's last-30-minutes activity is summed once per 10 seconds (DEBUG, 26 Oct: loadServed 340 to 485 ms on the server)", () => {
  it("the same coin asked again inside 10 s gets the same answer without a new pass; a later window or another SOL price sums again", () => {
    const dir = mkdtempSync(join(tmpdir(), "ticks-act-"));
    dirs.push(dir);
    writeFileSync(join(dir, `${MINT}.json`), JSON.stringify(file([tick(1, "buy", 4e-8, 0.01), tick(2, "sell", 4e-8, 0.02, 1000)])));
    const r = new TickReader(dir, () => T, null);
    r.refresh();
    const a = r.activity(MINT, T - 1_800_000, 150);
    expect(a).toMatchObject({ n: 2 });
    expect(r.activity(MINT, T - 1_800_000 + 4_000, 150)).toBe(a);           // inside the same 10 s bucket: the kept answer
    const later = r.activity(MINT, T - 1_800_000 + 60_000, 150);            // a window a minute on: summed again
    expect(later).not.toBe(a);
    expect(later).toMatchObject({ n: 2 });
    expect(r.activity(MINT, T - 1_800_000 + 60_000, 200)).not.toBe(later); // another SOL price: summed again (the dollars differ)
    expect(r.activity("NoSuchCoin1111111111111111111111111111111111", T, 150)).toBeNull();
  });
});

describe("firstPassDone: the quiet coins are known only once every tick file is read", () => {
  it("is false before the first full pass and true after it has read the folder", () => {
    const dir = mkdtempSync(join(tmpdir(), "ticks-fp-"));
    dirs.push(dir);
    writeFileSync(join(dir, `${MINT}.json`), JSON.stringify(file([tick(1, "buy", 4e-8, 0.01)])));
    const r = new TickReader(dir, () => T, null);
    expect(r.firstPassDone()).toBe(false);
    r.refresh();
    expect(r.firstPassDone()).toBe(true);
  });
});

describe("only a fresh trade goes down the live stream (ENGINE, 26 Oct: a coin's last 24 hours written into its file went out as new, up to 10.9 h old)", () => {
  it("newTrades hands on a trade under 5 s old and not one older, which still counts for the chart; it is never handed later", () => {
    const dir = mkdtempSync(join(tmpdir(), "ticks-fresh-"));
    dirs.push(dir);
    let now = T + 10_000;
    const write = (ticks: unknown[]) => writeFileSync(join(dir, `${MINT}.json`), JSON.stringify(file(ticks)));
    write([tick(1, "buy", 4e-8, 0.01, -3_600_000)]); // an hour old at first sight
    const r = new TickReader(dir, () => now, null);
    r.refresh();
    expect(r.newTrades([MINT], 150)).toEqual([]); // the first sight only records what is there
    // the engine writes the coin's earlier history and one trade just now
    write([tick(1, "buy", 4e-8, 0.01, -3_600_000), tick(2, "sell", 4e-8, 0.02, -36_000_000), tick(3, "buy", 4e-8, 0.03, 9_000)]);
    (r as any).needFull = true;
    r.refresh();
    const out = r.newTrades([MINT], 150);
    expect(out.map((x) => x.atMs)).toEqual([T + 9_000]); // only the fresh one
    expect(r.candles(MINT, 60, 100, 150)!.candles.length).toBeGreaterThan(0); // the old ones are in the chart from the file
    now += 60_000;
    expect(r.newTrades([MINT], 150)).toEqual([]); // the old ones are not handed later either
  });
  it("pushed skips a trade older than 5 s too", () => {
    const dir = mkdtempSync(join(tmpdir(), "ticks-fresh-"));
    dirs.push(dir);
    const r = new TickReader(dir, () => T + 20_000, null);
    const out = r.pushed(MINT, [tick(1, "buy", 4e-8, 0.01, 0), tick(2, "sell", 4e-8, 0.02, 18_000)], 150);
    expect(out.map((x) => x.atMs)).toEqual([T + 18_000]);
  });
});
