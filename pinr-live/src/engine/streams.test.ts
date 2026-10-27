import { describe, expect, it } from "vitest";
import { LIME, MANDARIN, SIZE_ALPHAS, sizeBand } from "./streams";

describe("stream look rules", () => {
  it("shows trade size as opacity: bigger is more solid, in steps that only ever rise", () => {
    let prev = -1;
    for (let s = 0; s <= 1.0001; s += 0.01) {
      const b = sizeBand(s);
      expect(b).toBeGreaterThanOrEqual(prev);
      prev = b;
    }
    for (let i = 1; i < SIZE_ALPHAS.length; i++) expect(SIZE_ALPHAS[i]!).toBeGreaterThan(SIZE_ALPHAS[i - 1]!);
    expect(SIZE_ALPHAS[SIZE_ALPHAS.length - 1]!).toBeLessThanOrEqual(1);
  });
  it("uses every opacity step and never goes out of range, even for odd sizes", () => {
    const used = new Set<number>();
    for (let s = 0; s <= 1; s += 0.01) used.add(sizeBand(s));
    expect(used.size).toBe(SIZE_ALPHAS.length);
    expect(sizeBand(-3)).toBe(0);
    expect(sizeBand(7)).toBe(SIZE_ALPHAS.length - 1);
  });
  it("buys are lime and sells are mandarin, and the two are clearly different colours", () => {
    expect(LIME).toBe("214,255,60");
    expect(MANDARIN).toBe("255,140,26");
    const [r1, g1, b1] = LIME.split(",").map(Number) as [number, number, number];
    const [r2, g2, b2] = MANDARIN.split(",").map(Number) as [number, number, number];
    expect(Math.abs(g1 - g2) + Math.abs(r1 - r2) + Math.abs(b1 - b2)).toBeGreaterThan(150);
    expect(r2).toBeGreaterThan(g2); // orange leans red
  });
});

describe("a trade's size is its height", () => {
  it("puts a buy above the line and a sell below, as far as its size, swooping further near now", async () => {
    const { sizeOffset, SIZE_RANGE } = await import("./streams");
    expect(sizeOffset(1, true, 0.5)).toBeCloseTo(-SIZE_RANGE); // a big buy: the top of the range (up is negative on screen)
    expect(sizeOffset(1, false, 0.5)).toBeCloseTo(SIZE_RANGE); // a big sell: the bottom
    expect(Math.abs(sizeOffset(0.1, true, 0.5))).toBeLessThan(Math.abs(sizeOffset(0.9, true, 0.5))); // small trades near the line
    expect(sizeOffset(1, true, 1)).toBeLessThan(sizeOffset(1, true, 0.8)); // the buy swoops up at the end
    expect(sizeOffset(1, false, 1)).toBeGreaterThan(sizeOffset(1, false, 0.8)); // the sell swoops down
    expect(sizeOffset(0, true, 1)).toBeCloseTo(0);
  });
});
