import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { GeckoBudget } from "./geckobudget.ts";
import { DEMO_API, demoKeyFrom, GeckoKeyRoute, KEY_REST_MS } from "./geckokey.ts";
import { MarketWorker, type Fetcher } from "./market.ts";
import { translate, type WireToken } from "./translate.ts";

const tok = (mint = "0xabc0000000000000000000000000000000000001"): WireToken => translate({ mint, chain: "base", score: 30, display: "30", label: null, coverage: 0.5 }).token!;
const answer = (url: string) => (url.includes("/ohlcv/") ? { data: { attributes: { ohlcv_list: [[3600, 1, 2, 0.5, 1.5, 10], [7200, 1.5, 3, 1, 2, 20]] } } } : { data: [{ attributes: { address: "0xpool", name: "A / B", reserve_in_usd: "1" } }] });
function fake(status = 200): { f: Fetcher; calls: string[]; set: (s: number) => void } {
  const calls: string[] = [];
  let st = status;
  return { calls, set: (s) => (st = s), f: async (url) => (calls.push(url), { status: st, json: async () => answer(url) }) };
}

describe("the operator's CoinGecko Demo key", () => {
  it("is read from the environment, else from the engine's .env, quotes and spaces taken off; none when neither has it", () => {
    const dir = mkdtempSync(join(tmpdir(), "cg-"));
    const f = join(dir, ".env");
    writeFileSync(f, 'OTHER=1\nCOINGECKO_API="demo-abc"\n');
    expect(demoKeyFrom(undefined, f)).toBe("demo-abc");
    expect(demoKeyFrom(" env-key ", f)).toBe("env-key");
    writeFileSync(f, "COINGECKO_API=\n");
    expect(demoKeyFrom(undefined, f)).toBeNull();
    expect(demoKeyFrom(undefined, join(dir, "missing"))).toBeNull();
  });
  it("keeps to its daily share and its monthly cap, counted in a file so a restart cannot reset them, and starts over each day", () => {
    const file = join(mkdtempSync(join(tmpdir(), "cg-")), "count.json");
    let t = Date.UTC(2026, 9, 25, 10);
    const a = new GeckoKeyRoute(fake().f, DEMO_API, file, () => t, 3, 5);
    for (let i = 0; i < 3; i++) (expect(a.mayCall()).toBe(true), a.used());
    expect(a.mayCall()).toBe(false); // the day's share is used
    const b = new GeckoKeyRoute(fake().f, DEMO_API, file, () => t, 3, 5); // a restart
    expect(b.mayCall()).toBe(false);
    t += 24 * 3600_000;
    expect(b.mayCall()).toBe(true); // a new day
    b.used();
    b.used();
    expect(b.mayCall()).toBe(false); // five this month: the month's cap
    expect(b.stats()).toMatchObject({ today: 2, month: 5, monthCap: 5 });
    expect(readFileSync(file, "utf8")).not.toMatch(/key/i); // counts only
    b.rest();
    expect(b.stats().restingS).toBe(KEY_REST_MS / 1000);
  });
  it("carries a viewer's chart reads; the read-ahead and the background readers stay on the free route", async () => {
    let t = Date.UTC(2026, 9, 25, 10);
    const free = fake();
    const key = fake();
    const route = new GeckoKeyRoute(key.f, DEMO_API, null, () => t);
    const w = new MarketWorker(free.f, () => t, undefined, new GeckoBudget(() => t), route);
    expect((await w.candlesFor(tok(), "1m")).status).toBe("ok");
    expect(key.calls.map((u) => u.startsWith(DEMO_API))).toEqual([true, true]); // the pool lookup and the candles
    expect(free.calls).toEqual([]);
    t += 61_000;
    await w.warm([tok("0xabc0000000000000000000000000000000000002")]);
    t += 31_000;
    await w.step([tok("0xabc0000000000000000000000000000000000003")]);
    expect(key.calls.length).toBe(2);
    expect(free.calls.length).toBe(3); // read-ahead (pool + candles) and the background's one call
  });
  it("lets the free route answer when the key is refused or its share is used, and a viewer is asked through the key even while the free route rests", async () => {
    let t = Date.UTC(2026, 9, 25, 10);
    const free = fake(429);
    const key = fake(429);
    const route = new GeckoKeyRoute(key.f, DEMO_API, null, () => t, 300);
    const w = new MarketWorker(free.f, () => t, undefined, new GeckoBudget(() => t), route);
    expect((await w.candlesFor(tok(), "1m")).status).toBe("busy"); // both refused
    expect(key.calls.length).toBe(1);
    expect(free.calls.length).toBe(1);
    key.set(200);
    t += KEY_REST_MS + 1000; // the key's rest is over; the free route's chart rest (20 s) too
    expect((await w.candlesFor(tok(), "1m")).status).toBe("ok");
    const used = new GeckoKeyRoute(fake().f, DEMO_API, null, () => t, 0); // no share left today
    const free2 = fake();
    const w2 = new MarketWorker(free2.f, () => t, undefined, new GeckoBudget(() => t), used);
    expect((await w2.candlesFor(tok(), "1m")).status).toBe("ok");
    expect(free2.calls.length).toBe(2);
  });
});
