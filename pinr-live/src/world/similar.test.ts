import { describe, expect, it } from "vitest";
import { similarTokens } from "./similar";
import type { Item } from "./model";

function tok(id: number, detail: string, mcap: number, ageMin: number, tag = ""): Item {
  return { id, detail, mcap, ageMin, tag } as unknown as Item;
}

describe("similarTokens", () => {
  const base = tok(1, "base · pump.fun", 1_000_000, 600);
  it("matches only the same chain, nearest first, never itself", () => {
    const all = [
      base,
      tok(2, "base · pump.fun", 900_000, 700),
      tok(3, "base · other", 1_200_000, 600),
      tok(4, "bnb · pump.fun", 1_000_000, 600),
      tok(5, "base · pump.fun", 900_000_000, 600),
    ];
    expect(similarTokens(base, all).map((t) => t.id)).toEqual([2, 3]);
  });
  it("matches nothing when the chain is unknown", () => {
    const u = tok(1, "chain unknown · pump.fun", 1e6, 10);
    expect(similarTokens(u, [u, tok(2, "chain unknown · pump.fun", 1e6, 10)])).toEqual([]);
  });
  it("skips made-up tokens and missing sizes without faking zero", () => {
    const all = [base, tok(2, "base · pump.fun", NaN, NaN), tok(3, "base · x", NaN, NaN), tok(4, "base · pump.fun", 1e6, 600, "SIM")];
    expect(similarTokens(base, all).map((t) => t.id)).toEqual([2]);
  });
});
