import { describe, expect, it } from "vitest";
import { chainOf, onServedChains, servedChains } from "./chains";

const SOL = "So1aNaTestMint1111111111111111111111111111";
const EVM = "0xabc0000000000000000000000000000000000001";

describe("served chains", () => {
  it("serves Solana, Base and BNB Chain by default, a list when set, and every chain with 'all'", () => {
    expect([...servedChains(undefined)!]).toEqual(["solana", "base", "bsc"]); // Base and BNB Chain beside Solana
    expect([...servedChains("")!]).toEqual(["solana", "base", "bsc"]);
    expect([...servedChains("solana")!]).toEqual(["solana"]); // one setting brings the old Solana-only site back
    expect([...servedChains(" Solana , BSC ")!]).toEqual(["solana", "bsc"]);
    expect(servedChains("all")).toBeNull();
  });

  it("leaves a chain out when it is not served (Solana only by one setting), keeps them all when every chain is served, and deletes nothing", () => {
    const list = [
      { address: SOL, chain: "solana" },
      { address: EVM, chain: "bsc" },
      { address: EVM, chain: "base" },
      { address: SOL, chain: null }, // a file that names no chain, with a Solana address
      { address: EVM, chain: null }, // an EVM address with no chain: which chain is not known
    ];
    expect(onServedChains(list, servedChains("solana")).map((t) => t.chain)).toEqual(["solana", null]);
    expect(onServedChains(list, servedChains(undefined)).map((t) => t.chain)).toEqual(["solana", "bsc", "base", null]); // the default now serves Base and BNB Chain too
    expect(onServedChains(list, servedChains("solana,bsc,base"))).toHaveLength(4);
    expect(onServedChains(list, null)).toHaveLength(5);
    expect(list).toHaveLength(5);
    expect(chainOf({ address: SOL, chain: null })).toBe("solana");
    expect(chainOf({ address: EVM, chain: null })).toBeNull();
  });
});
