import { describe, expect, it } from "vitest";
import { findVamps, imageKey, isVamp, lite, markCopies, stripVamp, type Launch } from "./vamp.ts";
import { coinToken, cleanCoin } from "./pumpfun.ts";
import { translate, type WireToken } from "./translate.ts";

const L = (id: string, image: string | null, creator: string | null, createdMs: number): Launch => ({ id, ticker: `$${id}`, image, creator, createdMs });
const IMG = "https://ipfs.io/ipfs/bafkreibt4os5hm4zusoqluqcbrgqv6ombskfwu3abc";

describe("imageKey", () => {
  it("is the same for one IPFS file on different gateways", () => {
    expect(imageKey(IMG)).toBe(imageKey("https://pump.mypinata.cloud/ipfs/bafkreibt4os5hm4zusoqluqcbrgqv6ombskfwu3abc"));
    expect(imageKey(null)).toBeNull();
    expect(imageKey("https://x.example/a.png")).toBe("https://x.example/a.png");
  });
});

describe("findVamps", () => {
  it("flags only the later copies by a different creator; the earliest is the original", () => {
    const v = findVamps([L("A", IMG, "c1", 100), L("B", IMG, "c2", 200), L("C", IMG, "c3", 300), L("D", "other", "c4", 400)]);
    expect([...v.keys()].sort()).toEqual(["B", "C"]);
    expect(v.get("B")).toEqual({ id: "A", ticker: "$A" });
    expect(v.get("C")!.id).toBe("A");
  });
  it("does not call a creator's own relaunch a copy, and never judges a coin with an unknown creator", () => {
    expect(findVamps([L("A", IMG, "c1", 100), L("B", IMG, "c1", 200)]).size).toBe(0);
    expect(findVamps([L("A", IMG, "c1", 100), L("B", IMG, null, 200)]).size).toBe(0);
  });
  it("treats the same picture at the same moment as no copy (nobody is first)", () => {
    expect(findVamps([L("A", IMG, "c1", 100), L("B", IMG, "c2", 100)]).size).toBe(0);
  });
  it("counts a scored token on another chain as the original when it launched first", () => {
    const v = findVamps([L("S", IMG, "c1", 500)], [{ id: "0xbase", ticker: "$ORIG", image: IMG, launchedMs: 100 }]);
    expect(v.get("S")).toEqual({ id: "0xbase", ticker: "$ORIG" });
    expect(findVamps([L("S", IMG, "c1", 50)], [{ id: "0xbase", ticker: "$ORIG", image: IMG, launchedMs: 100 }]).size).toBe(0);
  });
});

describe("the gate", () => {
  const coin = cleanCoin({ mint: "A7rRfLf67GMp5DFeY7s4kUaZLZbbz6UFPM5XYSg2pump", name: "Copy", symbol: "CP", usd_market_cap: 5000, total_supply: 1e15, base_decimals: 6, created_timestamp: 1_000, image_uri: IMG, creator: "Bvscx2uvsjcJ9YuMM95zFYvXQGDh9KKMdaLuAiPVNgj" }, 5)!;
  it("an unscored coin the matcher calls a copy is only a possible copy: it keeps its market data", () => {
    const t = coinToken(coin, { id: "orig", ticker: "$ORIG", basis: "same file", chain: "unchecked" });
    expect(isVamp(t)).toBe(false);
    expect(t.noScoreLabel).toBeNull();
    expect(t).toMatchObject({ score: null, coverage: 0, name: "Copy", ticker: "$CP", imageUrl: IMG, priceSource: "Pump.fun" });
    expect(t.valuationUsd).toBe(5000);
    expect(t.priceUsd).not.toBeNull();
    expect(t.possibleCopyOf).toEqual({ address: "orig", ticker: "$ORIG", proof: "unchecked" });
    expect(t.note).toContain("$ORIG");
    expect(t.note).toContain("chain not read yet");
    expect(t.note).not.toMatch(/\bcopy of\b/i);
    expect(coinToken(coin, { id: "orig", ticker: "$ORIG", basis: "near match", chain: "confirmed" }).note).toContain("a near match of the picture; the chain shows a different creator wallet");
    expect(coinToken(coin, { id: "orig", ticker: "$ORIG", chain: "confirmed" }).possibleCopyOf!.proof).toBe("chain");
  });
  it("stripVamp still clears a copy the ENGINE labels VAMP", () => {
    const full = { ...coinToken(coin), noScoreLabel: "VAMP" as const, valuationUsd: 9, priceUsd: 1, volume24hUsd: 5, priceSeries: [1, 2], score: null };
    const s = stripVamp(full);
    expect([s.valuationUsd, s.priceUsd, s.volume24hUsd, s.priceSeries, s.imageUrl]).toEqual([null, null, null, null, null]);
    expect(s.noScoreLabel).toBe("VAMP");
  });
});

describe("scored tokens in the paged list", () => {
  const A = "0x" + "a".repeat(40);
  const B = "0x" + "b".repeat(40);
  const scoredTok = (addr: string): WireToken => ({ ...translate({ mint: addr, score: 70, display: "70", label: null, coverage: 0.6, image_url: "https://x/y.png" }).token!, priceSeries: [1, 2], flow: { buy5m: 1, sell5m: 1, buy1h: 1, sell1h: 1, n5m: 2, n1h: 2 } as never });
  it("a desk verdict adds a warning to a scored token and takes nothing away", () => {
    const out = markCopies([scoredTok(A), scoredTok(B)], new Map([[A, { id: "O", ticker: "$OG", chain: "confirmed" as const }]]));
    expect(isVamp(out[0]!)).toBe(false);
    expect(out[0]!.score).toBe(70);
    expect(out[0]!.priceSeries).toEqual([1, 2]);
    expect(out[0]!.possibleCopyOf).toEqual({ address: "O", ticker: "$OG", proof: "chain" });
    expect(out[1]!.possibleCopyOf).toBeUndefined();
  });
  it("an unchecked chain is said to be unchecked, and the engine's own label is never replaced", () => {
    const labelled = { ...scoredTok(A), noScoreLabel: "MAYHEM" as const };
    const out = markCopies([labelled], new Map([[A, { id: "O", ticker: "$OG" }]]));
    expect(out[0]!.noScoreLabel).toBe("MAYHEM");
    expect(out[0]!.possibleCopyOf!.proof).toBe("unchecked");
  });
  it("lite drops the chart and the trade lines but keeps the score", () => {
    const l = lite(scoredTok("A"));
    expect(l.priceSeries).toBeNull();
    expect(l.flow).toBeNull();
    expect(l.score).toBe(70);
  });
});
