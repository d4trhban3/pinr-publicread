import { describe, expect, it } from "vitest";
import { padOf, pairOf } from "./marks";

describe("pair and launchpad marks", () => {
  it("reads the pair from the quote, or the chain's own coin when there is none", () => {
    expect(pairOf({ quotePair: "", chain: "solana" })).toBe("sol");
    expect(pairOf({ quotePair: "RYSM / WETH", chain: "base" })).toBe("eth");
    expect(pairOf({ quotePair: "X / WBNB", chain: "bsc" })).toBe("bnb");
    expect(pairOf({ quotePair: "X / USDT", chain: "bsc" })).toBe("usdt");
    expect(pairOf({ quotePair: "SOL", chain: "solana" })).toBe("sol");
  });
  it("draws nothing for a pair it does not know", () => {
    expect(pairOf({ quotePair: "ABC / QQQB", chain: "bsc" })).toBeNull();
    expect(pairOf({ quotePair: "", chain: undefined })).toBeNull();
  });
  it("names the launchpad, and draws nothing for an unknown one", () => {
    expect(padOf({ launchpad: "Pump.fun curve" })).toBe("pump");
    expect(padOf({ launchpad: "Zora" })).toBe("zora"); // Base launchpads from PINR_Chains
    expect(padOf({ launchpad: "Virtuals" })).toBe("virtuals");
    expect(padOf({ launchpad: "Four.meme" })).toBe("fourmeme");
    expect(padOf({ launchpad: "Flap" })).toBe("flap");
    expect(padOf({ launchpad: "Clanker" })).toBe("clanker");
    expect(padOf({ launchpad: "PumpSwap (graduated)" })).toBe("pump");
    expect(padOf({ launchpad: "Flap.sh" })).toBe("flap");
    expect(padOf({ launchpad: "four.meme" })).toBe("fourmeme");
    expect(padOf({ launchpad: "Somewhere new" })).toBeNull();
    expect(padOf({ launchpad: undefined })).toBeNull();
  });
});
