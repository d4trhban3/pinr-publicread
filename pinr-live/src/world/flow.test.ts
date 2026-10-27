import { COUNTED_DIM, KEEP_TRADES, KEEP_TRADES_MS, REAL_FOR_MS, REAL_SPEED, clearRealTrades, hearTrade, lastTradeText, lineFromTrades, noteRealTrade, REG_MAX, realOf, ribbonMode, sizeOfTrade, stepReal, type RealTraded } from "./flow";
import { describe, expect, it } from "vitest";
import { DENSITY, flowSpeed, makeFlow, MAX_PARTICLES, prewarm, ribbonValue, spawnRate, stepFlow } from "./flow";

function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => ((a = (Math.imul(a, 1664525) + 1013904223) >>> 0) / 4294967296);
}

describe("ribbon", () => {
  const hist = [0.2, 0.4, 0.9, 0.5]; // oldest -> newest
  it("ends at the live value on the right (now)", () => {
    expect(ribbonValue(hist, 0.3, 1, 0.77, 1)).toBeCloseTo(0.77, 9);
  });
  it("reads the oldest sample at the far left when a full window has passed", () => {
    expect(ribbonValue(hist, 0, 1, 0.5, 0)).toBeCloseTo(0.2, 9);
  });
  it("never leaves the range of the values it is built from", () => {
    for (let u = 0; u <= 1; u += 0.01) for (const age of [0, 0.4, 0.99]) {
      const v = ribbonValue(hist, age, 1, 0.65, u);
      expect(v).toBeGreaterThanOrEqual(0.2 - 1e-9);
      expect(v).toBeLessThanOrEqual(0.9 + 1e-9);
    }
  });
  it("scrolls smoothly: no jump when a new sample arrives", () => {
    // Just before a sample is taken (age ~ every) vs just after (age ~ 0, history shifted by one).
    const before = ribbonValue([0.2, 0.4, 0.9, 0.5], 0.999, 1, 0.6, 0.5);
    const after = ribbonValue([0.4, 0.9, 0.5, 0.6], 0.001, 1, 0.6, 0.5);
    expect(Math.abs(before - after)).toBeLessThan(0.01);
  });
  it("copes with empty history and a zero age", () => {
    expect(ribbonValue([], 0, 1, 0.3, 0.5)).toBe(0.3);
    expect(Number.isFinite(ribbonValue(hist, 0, 1, 0.3, 0.9))).toBe(true);
  });
  it("is flat when history and live value agree", () => {
    for (let u = 0; u <= 1; u += 0.1) expect(ribbonValue([0.4, 0.4, 0.4], 0.5, 1, 0.4, u)).toBeCloseTo(0.4, 9);
  });
});

describe("particles", () => {
  it("stays inside its limits and never produces NaN", () => {
    const f = makeFlow();
    const r = rng(1);
    for (let i = 0; i < 2000; i++) {
      stepFlow(f, 1 / 120, 60, 1.2, 0.5, r);
      expect(f.n).toBeLessThanOrEqual(MAX_PARTICLES);
      for (let k = 0; k < f.n; k++) {
        expect(Number.isFinite(f.u[k]!)).toBe(true);
        expect(f.u[k]!).toBeGreaterThanOrEqual(0);
        expect(f.u[k]!).toBeLessThanOrEqual(1.08 + 1.2 / 120);
      }
    }
  });
  it("settles near rate / speed particles on screen (a steady stream)", () => {
    const f = makeFlow();
    const r = rng(2);
    const rate = 12;
    const speed = 0.6;
    let sum = 0;
    let count = 0;
    for (let i = 0; i < 6000; i++) {
      stepFlow(f, 1 / 120, rate, speed, 0.5, r);
      if (i > 2000) { sum += f.n; count++; }
    }
    // Particles live (1.08 / speed) seconds on average; expected on screen is rate * lifetime.
    expect(sum / count).toBeGreaterThan(rate * (1 / speed) * 0.8);
    expect(sum / count).toBeLessThan(rate * (1.08 / speed) * 1.25);
  });
  it("makes buys and sells in the proportion it was told", () => {
    for (const share of [0.1, 0.5, 0.9]) {
      const f = makeFlow();
      const r = rng(3);
      let born = 0;
      let buys = 0;
      for (let i = 0; i < 6000; i++) {
        const before = f.n;
        stepFlow(f, 1 / 120, 30, 1.5, share, r);
        if (f.n > before) for (let k = before; k < f.n; k++) { born++; buys += f.side[k]!; }
      }
      expect(buys / born).toBeGreaterThan(share - 0.07);
      expect(buys / born).toBeLessThan(share + 0.07);
    }
  });
  it("does nothing for a zero or negative time step", () => {
    const f = makeFlow();
    prewarm(f, 10, 0.5, 0.5, rng(4));
    const n = f.n;
    const u0 = f.u[0]!;
    stepFlow(f, 0, 50, 1, 0.5, rng(5));
    stepFlow(f, -1, 50, 1, 0.5, rng(5));
    expect(f.n).toBe(n);
    expect(f.u[0]).toBe(u0);
  });
  it("prewarm fills a new tile close to its steady count", () => {
    const f = makeFlow();
    prewarm(f, 12, 0.6, 0.5, rng(6));
    expect(f.n).toBeGreaterThan(12);
    expect(f.n).toBeLessThanOrEqual(MAX_PARTICLES);
  });
  it("hot tiles flow FASTER but not denser: the count on the ribbon stays the same", () => {
    expect(flowSpeed(0.5, 1)).toBeGreaterThan(flowSpeed(0.5, 0));
    expect(flowSpeed(0.9, 0)).toBeGreaterThan(flowSpeed(0.1, 0));
    for (const speed of [0.2, 0.6, 1.4]) {
      // Steady count on the ribbon = births per second x seconds each lives = rate x (1 / speed).
      expect(spawnRate(speed) / speed).toBeCloseTo(DENSITY, 9);
    }
  });
  it("measured over time, a calm and a hot stream carry the same number of trades", () => {
    const count = (speed: number) => {
      const f = makeFlow();
      const r = rng(9);
      let sum = 0;
      let n = 0;
      for (let i = 0; i < 8000; i++) {
        stepFlow(f, 1 / 120, spawnRate(speed), speed, 0.5, r);
        if (i > 3000) { sum += f.n; n++; }
      }
      return sum / n;
    };
    const calm = count(0.25);
    const hot = count(1.2);
    expect(Math.abs(hot - calm) / calm).toBeLessThan(0.12);
  });
  it("a bigger tile carries proportionally more trades", () => {
    expect(spawnRate(0.5, 2)).toBeCloseTo(2 * spawnRate(0.5, 1), 9);
  });

  it("trades arrive in random order across three lanes: top, middle and bottom, about equally", () => {
    const f = makeFlow();
    const r = rng(11);
    const counts = [0, 0, 0];
    for (let i = 0; i < 6000; i++) {
      const before = f.n;
      stepFlow(f, 1 / 120, 60, 1.5, 0.5, r);
      for (let k = before; k < f.n; k++) counts[Math.min(2, Math.max(0, Math.round(f.lane[k]! * 2)))]!++;
    }
    const total = counts[0]! + counts[1]! + counts[2]!;
    for (const c of counts) expect(Math.abs(c / total - 1 / 3)).toBeLessThan(0.06);
  });
});

describe("one dot per real trade (a design decision)", () => {
  const rnd = (): number => 0.5;
  const coin = (over: Partial<RealTraded> = {}): RealTraded => ({ hasFlow: true, ...over });

  it("draws a coin from real trades once one is heard, from counts before that, and nothing with neither", () => {
    const NOW = 1_000_000_000;
    expect(ribbonMode(coin(), NOW)).toBe("counted");
    expect(ribbonMode(coin({ hasFlow: false }), NOW)).toBe("none");
    const it = coin({ hasFlow: false });
    noteRealTrade(it, "buy", 50, NOW - 2000, NOW);
    expect(ribbonMode(it, NOW + 1000)).toBe("real"); // a coin with real trades is drawn from them even with no counts
    expect(ribbonMode(coin({ realHeardMs: NOW }), NOW + REAL_FOR_MS - 1)).toBe("real");
    expect(ribbonMode(coin({ realHeardMs: NOW }), NOW + REAL_FOR_MS + 1)).toBe("counted"); // long quiet: back to the counted ribbon
    expect(ribbonMode(coin({ hasFlow: false, realHeardMs: NOW }), NOW + REAL_FOR_MS + 1)).toBe("none");
  });

  it("turns a trade's dollars into its opacity: small is faint, large is solid, nothing is invented for a bad amount", () => {
    expect(sizeOfTrade(1)).toBeCloseTo(0.1, 1);
    expect(sizeOfTrade(10)).toBeCloseTo(0.35, 1);
    expect(sizeOfTrade(100)).toBeCloseTo(0.67, 1);
    expect(sizeOfTrade(5000)).toBe(1);
    expect(sizeOfTrade(NaN)).toBe(0.05);
    expect(sizeOfTrade(-3)).toBe(0.05);
  });

  it("remembers heard trades briefly, keeps the latest trade's own time, and never more than the cap", () => {
    const it = coin();
    noteRealTrade(it, "buy", 10, 5000, 100_000);
    noteRealTrade(it, "sell", 10, 4000, 100_000); // an older trade heard later does not move the last time back
    expect(it.lastRealMs).toBe(5000);
    expect(it.realTrades!.map((t) => t.side)).toEqual([1, 0]);
    noteRealTrade(it, "buy", 10, 9000, 100_000 + KEEP_TRADES_MS + 1); // the first two are older than the keep time
    expect(it.realTrades!).toHaveLength(1);
    for (let i = 0; i < KEEP_TRADES + 10; i++) noteRealTrade(it, "buy", 1, 9000 + i, 200_000);
    expect(it.realTrades!.length).toBeLessThanOrEqual(KEEP_TRADES);
  });

  it("makes exactly one dot for each trade heard, takes each once per drawer, and spawns nothing at random", () => {
    const it = coin();
    const f = makeFlow();
    let cursor = 0;
    cursor = stepReal(f, 0.016, it.realTrades, cursor, rnd);
    expect(f.n).toBe(0); // no trades: no dots, however long it runs
    for (let i = 0; i < 100; i++) cursor = stepReal(f, 0.016, it.realTrades, cursor, rnd);
    expect(f.n).toBe(0);
    noteRealTrade(it, "buy", 100, 1, 10_000);
    noteRealTrade(it, "sell", 5, 2, 10_001);
    cursor = stepReal(f, 0.016, it.realTrades, cursor, rnd);
    expect(f.n).toBe(2);
    expect([...f.side.slice(0, 2)].sort()).toEqual([0, 1]);
    expect(f.size[0]).toBeCloseTo(sizeOfTrade(100), 5);
    cursor = stepReal(f, 0.016, it.realTrades, cursor, rnd);
    expect(f.n).toBe(2); // the same trades are not spawned again
    // a second drawer with its own cursor sees them too
    const g = makeFlow();
    stepReal(g, 0.016, it.realTrades, 0, rnd);
    expect(g.n).toBe(2);
  });

  it("carries each dot to 'now' in about three seconds, then retires it", () => {
    const it = coin();
    const f = makeFlow();
    noteRealTrade(it, "buy", 10, 1, 10_000);
    let cursor = stepReal(f, 0.016, it.realTrades, 0, rnd);
    expect(f.n).toBe(1);
    for (let t = 0; t < 4; t += 0.05) cursor = stepReal(f, 0.05, it.realTrades, cursor, rnd);
    expect(f.n).toBe(0);
    expect(REAL_SPEED * 3).toBeGreaterThan(0.9);
    expect(COUNTED_DIM).toBeLessThan(0.6);
  });

  it("spaces a burst along the ribbon rather than stacking it, and never exceeds the particle cap", () => {
    const it = coin();
    for (let i = 0; i < 30; i++) noteRealTrade(it, "buy", 10, i, 10_000 + i);
    const f = makeFlow();
    stepReal(f, 0.016, it.realTrades, 0, rnd);
    expect(f.n).toBe(30);
    const us = [...f.u.slice(0, 30)];
    expect(new Set(us.map((u) => u.toFixed(3))).size).toBeGreaterThan(5);
  });

  it("says when the last real trade was, in plain words, and nothing when there is none", () => {
    const N = 1_000_000_000;
    expect(lastTradeText(undefined, N)).toBe("");
    expect(lastTradeText(N - 1000, N)).toBe("last trade just now");
    expect(lastTradeText(N - 12_000, N)).toBe("last trade 10 s ago");
    expect(lastTradeText(N - 50_000, N)).toBe("last trade 50 s ago");
    expect(lastTradeText(N - 5 * 60_000, N)).toBe("last trade 5 min ago");
    expect(lastTradeText(N - 3 * 3_600_000, N)).toBe("last trade 3 h ago");
    expect(lastTradeText(N - 3 * 86_400_000, N)).toBe("last trade 3 d ago");
  });
});

describe("real trades are kept by address (item 57)", () => {
  const NOW = 1_000_000_000;
  it("W1: a trade heard before the coin's row exists is kept, and the row is real when it appears", () => {
    clearRealTrades();
    const A = "FrontierNewCoin11111111111111111111111111pump";
    for (let i = 0; i < 37; i++) hearTrade(A, i % 3 ? "buy" : "sell", 25, 0.001 + i * 1e-5, NOW - 14_000 + i * 300, NOW + i * 300);
    // the row appears later (no state of its own): it finds the trades by address, in any case
    const row = { hasFlow: false, address: A };
    expect(ribbonMode(row, NOW + 20_000)).toBe("real");
    expect(ribbonMode({ hasFlow: true, address: A.toUpperCase() }, NOW + 20_000)).toBe("real");
    expect(realOf(A)!.lastRealMs).toBe(NOW - 14_000 + 36 * 300);
    expect(realOf(A)!.realTrades!.length).toBeGreaterThan(0);
    // a coin never heard is still counted or nothing
    expect(ribbonMode({ hasFlow: true, address: "Other" }, NOW)).toBe("counted");
    expect(ribbonMode({ hasFlow: false, address: "Other" }, NOW)).toBe("none");
  });
  it("W1: a row replaced by another object for the same coin keeps its real ribbon", () => {
    clearRealTrades();
    hearTrade("CoinX", "buy", 10, 0.5, NOW, NOW);
    expect(ribbonMode({ hasFlow: true, address: "CoinX" }, NOW + 1000)).toBe("real");
    expect(ribbonMode({ hasFlow: true, address: "CoinX" }, NOW + 2000)).toBe("real"); // a new object, the same address
  });
  it("W2: a coin with no price series draws its lite line from its real trades; fewer than two is no line", () => {
    clearRealTrades();
    hearTrade("CoinY", "buy", 10, 0.5, NOW, NOW);
    expect(lineFromTrades(realOf("CoinY"))).toEqual([]); // one trade is not a line
    hearTrade("CoinY", "sell", 10, 0.52, NOW + 1000, NOW + 1000);
    hearTrade("CoinY", "buy", 10, 0.49, NOW + 2000, NOW + 2000);
    expect(lineFromTrades(realOf("CoinY"))).toEqual([0.5, 0.52, 0.49]);
    expect(lineFromTrades(undefined)).toEqual([]);
    hearTrade("CoinY", "buy", 10, 0, NOW + 3000, NOW + 3000); // a trade with no usable price adds no point
    hearTrade("CoinY", "buy", 10, NaN, NOW + 3000, NOW + 3000);
    expect(lineFromTrades(realOf("CoinY"))).toHaveLength(3);
  });
  it("keeps only the latest prices for the line, and never more coins than the cap", () => {
    clearRealTrades();
    for (let i = 0; i < 300; i++) hearTrade("CoinZ", "buy", 5, 1 + i, NOW + i, NOW + i);
    expect(lineFromTrades(realOf("CoinZ"))).toHaveLength(120);
    expect(lineFromTrades(realOf("CoinZ"))[119]).toBe(300);
    clearRealTrades();
    for (let i = 0; i < REG_MAX + 50; i++) hearTrade(`Coin${i}`, "buy", 5, 1, NOW + i, NOW + i);
    expect(realOf(`Coin${REG_MAX + 49}`)).toBeDefined(); // the newest is kept
    expect(realOf("Coin0")).toBeUndefined(); // the oldest went first
  });
});
