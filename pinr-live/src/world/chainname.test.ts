import { describe, expect, it } from "vitest";
import { chainName } from "./chainname";

describe("chainName", () => {
  it("names each chain the feed sends", () => {
    expect(["base", "bsc", "solana", "ethereum"].map(chainName)).toEqual(["Base", "BNB Chain", "Solana", "Ethereum"]);
  });
  it("leaves an id it does not know as it came", () => {
    expect(chainName("tron")).toBe("tron");
  });
});
