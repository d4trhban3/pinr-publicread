import { describe, expect, it } from "vitest";
import { Tape } from "./tape.ts";

const M = "A7rRfLf67GMp5DFeY7s4kUaZLZbbz6UFPM5XYSg2pump";
const NOW = 1_800_000_000;
const iso = (s: number): string => new Date(s * 1000).toISOString();
let n = 0;
const trade = (ago: number, type: "buy" | "sell", usd: number, price = 0.001): Record<string, unknown> => ({
  tx: `tx${++n}`,
  slotIndexId: `${String(n).padStart(12, "0")}-1`,
  timestamp: iso(NOW - ago),
  userAddress: "WALLET-SECRET",
  type,
  amountUsd: String(usd),
  priceUsd: String(price),
});

function setup(pages: unknown[][], status = 200) {
  const urls: string[] = [];
  let clock = NOW * 1000;
  const get = async (url: string) => (urls.push(url), { status, json: async () => ({ trades: pages[Math.min(urls.length - 1, pages.length - 1)] }) });
  const tape = new Tape(get, () => clock);
  return { tape, urls, advance: (ms: number) => void (clock += ms) };
}

describe("Tape (Pump.fun's trade list, only for coins somebody looks at)", () => {
  it("reads nothing for a coin nobody asked about", async () => {
    const { tape, urls } = setup([[trade(10, "buy", 5)]]);
    await tape.tick();
    expect(urls).toEqual([]);
    expect(tape.flow(M, NOW)).toBeNull();
    expect(tape.file(M)).toBeNull();
  });

  it("sums buys and sells over 5 minutes and an hour for a wanted coin, and keeps no wallet or transaction id in what it serves", async () => {
    const { tape, urls } = setup([[trade(60, "buy", 10), trade(120, "sell", 4), trade(1800, "buy", 100)]]);
    tape.want(M);
    await tape.tick();
    expect(urls[0]).toContain(`/v2/coins/${M}/trades?limit=100`);
    expect(tape.flow(M, NOW)).toMatchObject({ buy5m: 10, sell5m: 4, n5m: 2, buy1h: 110, sell1h: 4, n1h: 3 });
    expect(tape.lastTradeMs(M)).toBe((NOW - 60) * 1000);
    expect(JSON.stringify(tape.file(M))).not.toMatch(/WALLET|tx\d/);
    expect(tape.file(M)!.trades.map((t) => t[1])).toEqual(["buy", "sell", "buy"]);
  });

  it("counts a trade once when the list is read again, and waits between reads", async () => {
    const t1 = trade(100, "buy", 5);
    const { tape, urls, advance } = setup([[t1], [trade(20, "sell", 3), t1]]);
    tape.want(M);
    await tape.tick();
    await tape.tick(); // too soon: no second request
    expect(urls.length).toBe(1);
    advance(21_000);
    await tape.tick();
    expect(urls.length).toBe(2);
    expect(tape.flow(M, NOW + 21)).toMatchObject({ buy1h: 5, sell1h: 3, n1h: 2 });
  });

  it("calls a big fresh trade a large buy, and a quiet one nothing", async () => {
    const quiet = setup([[trade(500, "buy", 100), trade(400, "sell", 50)]]);
    quiet.tape.want(M);
    await quiet.tape.tick();
    expect(quiet.tape.event(M, NOW)).toBeNull();
    const loud = setup([[trade(500, "buy", 100), trade(5, "buy", 900)]]);
    loud.tape.want(M);
    await loud.tape.tick();
    expect(loud.tape.event(M, NOW)).toMatchObject({ kind: "large_buy", usd: 900 });
    expect(loud.tape.event(M, NOW + 120)).toBeNull();
  });

  it("builds candles from the list's prices, only when the list held the coin's whole life", async () => {
    const short = setup([[trade(1000, "buy", 5, 1), trade(900, "buy", 5, 3), trade(100, "sell", 5, 2)]]);
    short.tape.want(M);
    await short.tape.tick();
    expect(short.tape.complete(M)).toBe(true);
    const cs = short.tape.candles(M, 900, 0);
    expect(cs.length).toBeGreaterThanOrEqual(2);
    expect(cs.flatMap((c) => [c[2], c[3]])).toContain(3);
    const full = setup([Array.from({ length: 100 }, (_, i) => trade(i, "buy", 1))]);
    full.tape.want(M);
    await full.tape.tick();
    expect(full.tape.complete(M)).toBe(false); // a whole page: older trades were not read
    expect(full.tape.flow(M, NOW)!.complete).toBe(false);
  });

  it("drops bad rows one by one, rests after a refusal, and forgets a coin nobody wants any more", async () => {
    const { tape, advance } = setup([[{ nonsense: 1 }, trade(5, "buy", 7)]]);
    tape.want(M);
    await tape.tick();
    expect(tape.flow(M, NOW)).toMatchObject({ n1h: 1, buy1h: 7 });
    advance(121_000);
    await tape.tick();
    expect(tape.flow(M, NOW + 121)).toBeNull();
    const limited = setup([[]], 429);
    limited.tape.want(M);
    await limited.tape.tick();
    limited.advance(10_000);
    await limited.tape.tick();
    expect(limited.urls.length).toBe(1); // paused 60 s after a 429
    expect(limited.tape.flow(M, NOW)).toBeNull();
  });

  it("ignores a malformed address without asking", async () => {
    const { tape, urls } = setup([[]]);
    tape.want("../x");
    await tape.tick();
    expect(urls).toEqual([]);
  });

  it("does not count a trade twice after it has read thousands (the list of counted trades is never emptied at once)", async () => {
    // 62 reads of 50 new trades each, with the newest 100 of the source returned every time (the app's view of a busy coin)
    const all: Record<string, unknown>[] = [];
    const pages: unknown[][] = [];
    for (let r = 0; r < 62; r++) {
      for (let k = 0; k < 50; k++) all.push(trade(3000 - (r * 50 + k) * 0.9, "buy", 1));
      pages.push(all.slice(-100));
    }
    const { tape, advance } = setup(pages);
    tape.want(M);
    for (let r = 0; r < 62; r++) {
      await tape.tick();
      advance(21_000);
      tape.want(M);
    }
    expect(tape.file(M)!.trades.length).toBe(500); // capped list, but the counts below are exact
    expect(tape.flow(M, NOW + 62 * 21)!.n1h).toBeLessThanOrEqual(3100);
  });

  it("a slow coin whose old trades stay on the newest page is not counted again when the counted list is cleared", async () => {
    // 3,050 trades older than an hour are already counted; the newest page still lists 100 of them plus a new one
    const old = Array.from({ length: 100 }, (_, i) => trade(7200 - i, "buy", 1));
    const { tape, advance } = setup([old, old, old]);
    tape.want(M);
    // pretend the coin has been read a great many times: fill the counted list past 3,000
    const c = (tape as unknown as { coins: Map<string, { seen: Map<string, number> }> }).coins.get(M)!;
    for (let i = 0; i < 3000; i++) c.seen.set(`filler${i}`, NOW - 9000);
    await tape.tick();
    advance(21_000);
    await tape.tick();
    advance(21_000);
    await tape.tick();
    expect(tape.file(M)!.trades.length).toBe(100); // each of the 100 trades listed once, never twice
  });

  it("fetches a coin's first page with the request that asks for it, once for several requests", async () => {
    const { tape, urls } = setup([[trade(30, "buy", 5), trade(20, "sell", 4)]]);
    expect(tape.flow(M, NOW)).toBeNull();
    await Promise.all([tape.ensure(M), tape.ensure(M)]);
    expect(urls).toHaveLength(1);
    expect(tape.flow(M, NOW)).toMatchObject({ n1h: 2 });
    await tape.ensure(M); // already read: no second request
    expect(urls).toHaveLength(1);
  });

  it("does not fetch for a malformed address, while the tape rests, or when the service's minute is nearly used", async () => {
    const bad = setup([[trade(30, "buy", 5)]]);
    await bad.tape.ensure("not-a-mint");
    expect(bad.urls).toHaveLength(0);
    const rest = setup([[trade(30, "buy", 5)]], 429);
    await rest.tape.ensure(M); // a refusal rests the tape
    await rest.tape.ensure("B7rRfLf67GMp5DFeY7s4kUaZLZbbz6UFPM5XYSg2pump");
    expect(rest.urls).toHaveLength(1);
    const busy = setup([[trade(30, "buy", 5)]]);
    for (let k = 0; k < 10; k++) await busy.tape.ensure(`${"C".repeat(43)}${k}`);
    await busy.tape.ensure(M);
    expect(busy.urls).toHaveLength(10); // the ceiling: the eleventh coin waits for the periodic read
  });

  it("answers with the finest size that gives two candles, and says which (as the tick files do)", async () => {
    const { tape } = setup([[trade(600, "buy", 5, 0.001), trade(300, "sell", 4, 0.002), trade(30, "buy", 6, 0.003)]]);
    await tape.ensure(M);
    // the three trades share one 15-minute window (one candle there), so 15 minutes gives the 5-minute size (two candles)
    const asked = tape.candlesBest(M, 900, 1000)!;
    expect([asked.bucketSec, asked.candles.length]).toEqual([300, 2]);
    expect(tape.candlesBest(M, 300, 1000)!.bucketSec).toBe(300); // a size that already gives two is kept
    expect(tape.candlesBest(M, 86_400, 1000)!.bucketSec).toBe(300);
    expect(tape.candlesBest("D".repeat(44), 900)).toBeNull();
  });

  it("keeps the chart-request reads and the periodic reads together under the minute's ceiling", async () => {
    const { tape, urls, advance } = setup([[trade(30, "buy", 5)]]);
    for (let k = 0; k < 12; k++) await tape.ensure(`${"E".repeat(43)}${String.fromCharCode(97 + k)}`); // 12 coins opened at once: 10 are read
    expect(urls).toHaveLength(10);
    for (let s2 = 0; s2 < 20; s2++) {
      advance(2_000);
      await tape.tick();
    }
    expect(urls.length).toBeLessThanOrEqual(10); // the 40 seconds that follow add none: the minute is full
    advance(30_000);
    await tape.tick();
    expect(urls.length).toBeGreaterThan(10); // a minute after the first reads, the periodic read goes on
  });

  it("counts the trades and dollars in a window from the page held, and says nothing for a coin never read", async () => {
    const { tape } = setup([[trade(60, "buy", 10), trade(600, "sell", 5), trade(3000, "buy", 100)]]);
    expect(tape.activity(M, NOW - 1800)).toBeNull(); // never read
    await tape.read(M);
    expect(tape.activity(M, NOW - 1800)).toEqual({ n: 2, usd: 15 }); // the trade 50 minutes ago is outside 30 minutes
    expect(tape.activity(M, NOW - 4000)).toEqual({ n: 3, usd: 115 });
    expect(tape.activity("D".repeat(44), NOW - 1800)).toBeNull();
  });

  it("read() refreshes a coin already read, within the same minute ceiling", async () => {
    const { tape, urls } = setup([[trade(30, "buy", 5)]]);
    await tape.read(M);
    await tape.read(M);
    expect(urls).toHaveLength(2); // unlike ensure, which fetches only a coin never read
    await tape.ensure(M);
    expect(urls).toHaveLength(2);
  });
});
