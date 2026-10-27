import { describe, expect, it } from "vitest";
import { orderRoster } from "./feed";
import { byFirstPage, firstPageKey } from "./firstpage";
import type { WireToken } from "./translate";

const NOW = Date.parse("2026-10-25T12:00:00Z");
const tok = (address: string, o: Partial<WireToken>) => ({ address, score: null, seen: false, asOfMs: null, launchedAtMs: null, rank: null, valuationUsd: null, ...o }) as unknown as WireToken;

describe("the first page puts scored coins first", () => {
  it("groups: scored in the last day, then unscored new in the last day, then the rest", () => {
    expect(firstPageKey({ scored: true, scoredAtMs: NOW - 1000 }, NOW)[0]).toBe(0);
    expect(firstPageKey({ scored: true, scoredAtMs: NOW - 30 * 3600_000 }, NOW)[0]).toBe(2);
    expect(firstPageKey({ scored: false, newAtMs: NOW - 1000 }, NOW)[0]).toBe(1);
    expect(firstPageKey({ scored: false, newAtMs: null }, NOW)[0]).toBe(2);
    expect(byFirstPage([0, 5], [0, 9])).toBeGreaterThan(0); // newer first
    expect(byFirstPage([2, -Infinity], [2, -Infinity])).toBe(0);
  });
  it("orders /api/tokens' roster: newest-scored first, then the newest unscored, then the rest by rank", () => {
    const list = [
      tok("old-scored", { score: 40, asOfMs: NOW - 40 * 3600_000, rank: 1 }),
      tok("seen-new", { seen: true, seenAtMs: NOW - 600_000, asOfMs: NOW - 600_000 }),
      tok("scored-2h", { score: 55, asOfMs: NOW - 7200_000 }),
      tok("pool-new", { launchedAtMs: NOW - 60_000 }),
      tok("scored-now", { score: 30, asOfMs: NOW - 60_000 }),
    ];
    expect(orderRoster(list, 10, NOW).tokens.map((t) => t.address)).toEqual(["scored-now", "scored-2h", "pool-new", "seen-new", "old-scored"]);
  });
});

describe("the scored block orders by the real score time (a design decision (d))", () => {
  it("uses scored_at when the file states it, and as_of only when it does not", () => {
    const list = [
      tok("reread-old", { score: 40, asOfMs: NOW - 60_000, scoredAtMs: NOW - 5 * 24 * 3600_000 }), // re-read a minute ago, scored 5 days ago: the rest
      tok("scored-1h", { score: 55, asOfMs: NOW - 30_000, scoredAtMs: NOW - 3600_000 }),
      tok("no-scored-at", { score: 30, asOfMs: NOW - 7200_000 }),
      tok("new-bnb", { seen: true, seenAtMs: NOW - 600_000, asOfMs: NOW - 600_000 }),
    ];
    expect(orderRoster(list, 10, NOW).tokens.map((t) => t.address)).toEqual(["scored-1h", "no-scored-at", "new-bnb", "reread-old"]);
  });
});
