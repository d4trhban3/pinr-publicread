import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { padOf } from "../src/world/marks.ts";
import { coinToken, PumpfunUniverse, type PumpFetch } from "./pumpfun.ts";
import { parseEvent, PumpPortalFeed, PUMPPORTAL_URL, toPumpCoin, type SocketLike } from "./pumpportal.ts";
import { JUPITER_PRICE_URL, jupiter, jupiterWith, providersFromEnv, type QuoteFetch } from "./quotes.ts";

/** The first messages of one real test connection (2026-10-18), saved as received. */
const REAL = (JSON.parse(readFileSync(join(import.meta.dirname, "fixtures", "pumpportal-2026-10-18.json"), "utf8")) as { messages: string[] }).messages;
const CREATE = REAL.find((m) => m.includes('"txType":"create"'))!;
const MIGRATE = REAL.find((m) => m.includes('"txType":"migrate"'))!;
/** A bonk.fun create in the same shape with pool "bonk" (none arrived in the 73 s test; the shape is PumpPortal's, the coin is made up). */
const BONK = JSON.stringify({ ...JSON.parse(CREATE), mint: "Bonk1111111111111111111111111111111111bonk", pool: "bonk", name: "Made-up bonk coin" });
const SOL_MINT = "So11111111111111111111111111111111111111112";

class FakeSocket implements SocketLike {
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: unknown }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  sent: string[] = [];
  closed = false;
  constructor(public url: string) {}
  send(d: string): void {
    this.sent.push(d);
  }
  close(): void {
    this.closed = true;
  }
}

/** A SOL price answer in DexScreener's shape, or a failure. */
const solGet = (price: number | null): QuoteFetch => async () =>
  price === null ? { status: 500, json: async () => ({}) } : { status: 200, json: async () => [{ chainId: "solana", baseToken: { address: SOL_MINT, symbol: "SOL" }, quoteToken: { symbol: "USDC" }, priceUsd: String(price), liquidity: { usd: 1e7 } }] };

const noPump: PumpFetch = async () => ({ status: 404, json: async () => ({}) });

describe("PumpPortal events (the real shape)", () => {
  it("reads a create, a graduation and PumpPortal's own notices", () => {
    const c = parseEvent(CREATE, 1000);
    expect(c.kind).toBe("create");
    const raw = JSON.parse(CREATE);
    if (c.kind === "create") expect(c.coin).toEqual({ mint: raw.mint, name: raw.name, symbol: raw.symbol, creator: raw.traderPublicKey, curve: raw.bondingCurveKey, capSol: raw.marketCapSol, launchpad: "pump", atMs: 1000 });
    expect(parseEvent(MIGRATE, 1000)).toEqual({ kind: "migrate", mint: JSON.parse(MIGRATE).mint });
    expect(parseEvent(REAL[0], 1000).kind).toBe("notice");
    expect(parseEvent(BONK, 1000)).toMatchObject({ kind: "create", coin: { launchpad: "bonk" } });
  });
  it("skips anything it cannot use: bad JSON, another pool, no market cap, a bad address", () => {
    expect(parseEvent("not json", 1).kind).toBe("other");
    expect(parseEvent(JSON.stringify({ ...JSON.parse(CREATE), pool: "other" }), 1).kind).toBe("other");
    expect(parseEvent(JSON.stringify({ ...JSON.parse(CREATE), marketCapSol: 0 }), 1).kind).toBe("other");
    expect(parseEvent(JSON.stringify({ ...JSON.parse(CREATE), mint: "x" }), 1).kind).toBe("other");
  });
  it("prices a coin from its SOL market cap and a SOL price, labelled PumpPortal's, with no picture made up", () => {
    const ev = parseEvent(CREATE, 5000);
    if (ev.kind !== "create") throw new Error("no create");
    const c = toPumpCoin(ev.coin, 200);
    expect(c.capUsd).toBeCloseTo(ev.coin.capSol * 200, 6);
    expect(c.priceUsd).toBeCloseTo((ev.coin.capSol * 200) / 1e9, 15);
    expect(c).toMatchObject({ figSource: "PumpPortal", figAtMs: 5000, createdMs: 5000, image: null, graduated: false, launchpad: "pump" });
  });
});

describe("the one connection", () => {
  let sockets: FakeSocket[];
  let now: number;
  let feed: PumpPortalFeed;
  let pool: PumpfunUniverse;
  beforeEach(() => {
    vi.useFakeTimers();
    sockets = [];
    now = Date.parse("2026-10-18T12:00:00Z");
    pool = new PumpfunUniverse(noPump, () => now);
    feed = new PumpPortalFeed(pool, (url) => (sockets.push(new FakeSocket(url)), sockets.at(-1)!), solGet(150), () => now);
  });
  afterEach(() => {
    feed.stop();
    vi.useRealTimers();
  });

  it("opens one socket and sends only the two free subscriptions, never a metered one", () => {
    feed.start();
    feed.connect();
    feed.connect();
    expect(sockets.length).toBe(1);
    expect(sockets[0]!.url).toBe(PUMPPORTAL_URL);
    sockets[0]!.onopen!();
    expect(sockets[0]!.sent.map((m) => JSON.parse(m).method)).toEqual(["subscribeNewToken", "subscribeMigration"]);
    expect(sockets[0]!.sent.join()).not.toMatch(/TokenTrade|AccountTrade/);
  });

  it("reconnects after a drop, waiting longer each time up to two minutes, and from the start again after a healthy minute", () => {
    feed.start();
    const waits: number[] = [];
    for (let i = 0; i < 9; i++) {
      const before = sockets.length;
      sockets.at(-1)!.onclose!();
      let waited = 0;
      while (sockets.length === before) {
        vi.advanceTimersByTime(1000);
        waited += 1000;
      }
      waits.push(waited);
    }
    expect(waits).toEqual([2000, 4000, 8000, 16000, 32000, 64000, 120000, 120000, 120000]);
    const s = sockets.at(-1)!;
    s.onopen!();
    now += 61_000;
    s.onclose!();
    const before = sockets.length;
    vi.advanceTimersByTime(2000);
    expect(sockets.length).toBe(before + 1);
  });

  it("closes a socket that has been silent two minutes and opens a new one", () => {
    feed.start();
    sockets[0]!.onopen!();
    now += 121_000;
    feed.checkSilence();
    expect(sockets[0]!.closed).toBe(true);
    vi.advanceTimersByTime(2000);
    expect(sockets.length).toBe(2);
  });

  it("survives a socket that runs its close handler the moment it is closed (the crash loop of 2026-10-23: Cannot read properties of null, reading 'onclose')", () => {
    class SyncClose extends FakeSocket {
      override close(): void {
        this.closed = true;
        this.onclose?.(); // some sockets answer close() at once
      }
    }
    const made: SyncClose[] = [];
    const f = new PumpPortalFeed(pool, (url) => (made.push(new SyncClose(url)), made.at(-1)!), solGet(150), () => now);
    f.start();
    made[0]!.onopen!();
    now += 121_000;
    expect(() => f.checkSilence()).not.toThrow();
    expect(made[0]!.closed).toBe(true);
    vi.advanceTimersByTime(2000);
    expect(made.length).toBe(2); // and it reconnects
    f.stop();
  });

  it("gives up a handshake that is not answered in 30 s and tries again (W1)", () => {
    feed.start();
    now += 31_000;
    feed.checkSilence();
    expect(sockets[0]!.closed).toBe(true);
    vi.advanceTimersByTime(2000);
    expect(sockets.length).toBe(2);
  });

  it("is off unless the .env says PINR_PUMPPORTAL=on, so no copy but the server's opens a second connection (H1)", () => {
    const src = readFileSync(join(import.meta.dirname, "server.ts"), "utf8");
    expect(src).toMatch(/env\.PINR_PUMPPORTAL === "on" \? new PumpPortalFeed/);
    expect(src).not.toMatch(/PINR_PUMPPORTAL !== "off"/);
    const envExample = readFileSync(join(import.meta.dirname, "..", ".env.example"), "utf8");
    expect(envExample).toMatch(/^# PINR_PUMPPORTAL=on$/m);
  });

  it("puts new coins in the pool, Pump.fun and bonk.fun, and marks a graduation", async () => {
    await feed.readSol();
    feed.onMessage(CREATE);
    feed.onMessage(BONK);
    const mint = JSON.parse(CREATE).mint as string;
    expect(pool.coin(mint)).toMatchObject({ figSource: "PumpPortal", launchpad: "pump" });
    expect(coinToken(pool.coin(mint)!).launchpad).toBe("Pump.fun curve");
    const bonk = coinToken(pool.coin("Bonk1111111111111111111111111111111111bonk")!);
    expect(bonk).toMatchObject({ launchpad: "bonk.fun LaunchLab curve", score: null, note: "Not scored yet", quoteSource: "PumpPortal" });
    expect(padOf({ launchpad: bonk.launchpad ?? undefined })).toBe("launchlab");
    // The engine's pool route stays Pump.fun-only unless it asks for every launchpad.
    expect(pool.list("new", 200, 0, "pump").map((c) => c.mint)).toEqual([mint]);
    expect(pool.list("new", 200, 0).length).toBe(2);
    feed.onMessage(JSON.stringify({ ...JSON.parse(MIGRATE), mint }));
    expect(pool.coin(mint)!.graduated).toBe(true);
    expect(feed.stats()).toMatchObject({ created: 2, bonk: 1, graduated: 1, solUsd: 150 });
  });

  it("holds new coins without a price until a SOL price is read; a failed read prices nothing", async () => {
    const cold = new PumpPortalFeed(pool, (url) => new FakeSocket(url), solGet(null), () => now);
    cold.onMessage(CREATE);
    await cold.readSol();
    expect(pool.size).toBe(0);
    expect(cold.stats().waitingForSolPrice).toBe(1);
    const warm = new PumpPortalFeed(pool, (url) => new FakeSocket(url), solGet(150), () => now);
    warm.onMessage(CREATE);
    expect(pool.size).toBe(0);
    await warm.readSol();
    expect(pool.size).toBe(1);
    expect(warm.stats().waitingForSolPrice).toBe(0);
  });

  it("does not ask Pump.fun's record service about bonk.fun coins", async () => {
    const asked: string[] = [];
    const p = new PumpfunUniverse(async (u) => (asked.push(u), { status: 404, json: async () => ({}) }), () => now);
    const f = new PumpPortalFeed(p, (url) => new FakeSocket(url), solGet(150), () => now);
    await f.readSol();
    f.onMessage(BONK);
    await p.recordTick();
    expect(asked).toEqual([]);
    f.onMessage(CREATE);
    now += 11_000;
    await p.recordTick();
    expect(asked).toEqual([`https://frontend-api-v3.pump.fun/coins-v2/${JSON.parse(CREATE).mint}`]);
  });
});

describe("Jupiter's new gateway", () => {
  const calls: { url: string; headers?: Record<string, string> }[] = [];
  const get: QuoteFetch = async (url, headers) => (calls.push({ url, headers }), { status: 200, json: async () => ({}) });
  it("asks api.jup.ag, keyless at one request every 4 s (15 a minute: half the limit, the engine has the other half)", async () => {
    calls.length = 0;
    await jupiter.fetch("solana", ["A"], get);
    expect(JUPITER_PRICE_URL).toBe("https://api.jup.ag/price/v3");
    expect(calls[0]!.url).toBe("https://api.jup.ag/price/v3?ids=A");
    expect(calls[0]!.headers).toBeUndefined();
    expect(jupiter.minIntervalMs).toBe(4000);
  });
  it("sends x-api-key when the .env has a key, at one request every 2 s (30 a minute, half); the setting overrides the share", async () => {
    calls.length = 0;
    const p = providersFromEnv("jupiter", "test-key").find((x) => x.id === "jupiter")!;
    await p.fetch("solana", ["A"], get);
    expect(calls[0]!.headers).toEqual({ "x-api-key": "test-key" });
    expect(p.minIntervalMs).toBe(2000);
    expect(jupiterWith(undefined, 6000).minIntervalMs).toBe(6000);
    expect(providersFromEnv("jupiter")[0]).toBe(jupiter);
  });
});

describe("a create must be that coin's own launch (2026-10-25: PUMP listed as \"Blind Ape\", then \"Mega Jack\")", () => {
  const PUMP = "pumpCmXqMfrsAkQ5r49WcJnRayYRqmXz6ae8H7H9Dfn";
  const now = Date.parse("2026-10-25T19:00:00Z");
  const createOf = (mint: string, curve: string, name = "Mega Jack") => JSON.stringify({ ...JSON.parse(CREATE), mint, bondingCurveKey: curve, name });
  const tick = () => new Promise((r) => setTimeout(r, 0));

  it("derives a coin's own Pump.fun curve (checked against live pool coins and the chain)", async () => {
    const { pumpCurveOf } = await import("./pumpcurve.ts");
    const real = JSON.parse(CREATE);
    expect(pumpCurveOf(real.mint)).toBe(real.bondingCurveKey);
    expect(pumpCurveOf("VWFEkZUymJpp3n74bVn11zEEKMhRL3ZuenX9xfhXxCb")).toBe("G6AiJKsuuQmbgJrNbXiCVctW6K5qxXNiLMykP6ALKXUm");
    // RUGD: PumpPortal sent another curve; its own (this one) is a Pump.fun account on chain.
    expect(pumpCurveOf("JH98FWHy5oWpn7t9Hh7ggvnScPnLfdeFwcZVBvn9ese")).toBe("Di1bJXpVK4WGtPhqr5oqGNkgxZtK5v6bZwcQ3o2H98es");
  });

  it("drops a create naming PUMP with another coin's curve when PUMP's own curve holds no Pump.fun account", async () => {
    const pool = new PumpfunUniverse(noPump, () => now);
    const asked: string[] = [];
    const f = new PumpPortalFeed(pool, (url) => new FakeSocket(url), solGet(150), () => now, async (a) => (asked.push(a), false));
    await f.readSol();
    f.onMessage(createOf(PUMP, "9fdeUutRbxdnQ6s1nm3SStbFYeMFh6Ns5D8SLSKxpump"));
    await tick();
    expect(asked.length).toBe(1);
    expect(pool.coin(PUMP)).toBeUndefined();
  });

  it("keeps a real coin PumpPortal gave the wrong curve, with its own curve, once the chain shows that curve", async () => {
    const pool = new PumpfunUniverse(noPump, () => now);
    const f = new PumpPortalFeed(pool, (url) => new FakeSocket(url), solGet(150), () => now, async () => true);
    await f.readSol();
    f.onMessage(createOf("JH98FWHy5oWpn7t9Hh7ggvnScPnLfdeFwcZVBvn9ese", "BwWK17cbHxwWBKZkUYvzxLcNQ1YVyaFezduWbtm2de6s", "RUGD"));
    await tick();
    expect(pool.coin("JH98FWHy5oWpn7t9Hh7ggvnScPnLfdeFwcZVBvn9ese")?.curve).toBe("Di1bJXpVK4WGtPhqr5oqGNkgxZtK5v6bZwcQ3o2H98es");
  });

  it("without a chain check an unmatched create is dropped, and a matched one never asks the chain", async () => {
    const pool = new PumpfunUniverse(noPump, () => now);
    const f = new PumpPortalFeed(pool, (url) => new FakeSocket(url), solGet(150), () => now);
    await f.readSol();
    f.onMessage(createOf(PUMP, "9fdeUutRbxdnQ6s1nm3SStbFYeMFh6Ns5D8SLSKxpump"));
    f.onMessage(CREATE);
    expect(pool.coin(PUMP)).toBeUndefined();
    expect(pool.coin(JSON.parse(CREATE).mint)).toBeDefined();
  });

  it("never takes a create for a coin already held with an older launch", async () => {
    let t = now;
    const pool = new PumpfunUniverse(noPump, () => t);
    const f = new PumpPortalFeed(pool, (url) => new FakeSocket(url), solGet(150), () => t);
    await f.readSol();
    f.onMessage(CREATE);
    const first = pool.coin(JSON.parse(CREATE).mint)!;
    t += 2 * 3600_000;
    f.onMessage(JSON.stringify({ ...JSON.parse(CREATE), name: "Blind⁠ Ape" }));
    expect(pool.coin(JSON.parse(CREATE).mint)!.name).toBe(first.name);
    expect(pool.coin(JSON.parse(CREATE).mint)!.createdMs).toBe(first.createdMs);
  });
});
