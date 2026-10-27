import { describe, expect, it } from "vitest";
import { chainProven, flagLine, flagWord, originalLink, possibleLine, vampIntro } from "./copynote";

describe("the words about copies", () => {
  it("never says confirmed for a copy whose creator check has not been done, and never \"proven\" at all (checklist 13)", () => {
    const unchecked = { flagKind: "VAMP" as const, copyProof: "unchecked" as const };
    const none = { flagKind: "VAMP" as const, copyProof: undefined };
    for (const it of [unchecked, none]) {
      expect(chainProven(it)).toBe(false);
      expect(flagWord(it)).toBe("unchecked");
      expect(flagLine(it).toLowerCase()).not.toMatch(/proven|labelled by|confirmed from/);
      expect(flagLine(it)).toMatch(/not confirmed yet/);
    }
    expect(vampIntro("unchecked")).toMatch(/not confirmed/);
    expect(vampIntro(undefined)).toMatch(/not confirmed/);
  });
  it("says confirmed only when Pump.fun's record confirmed two wallets", () => {
    const proven = { flagKind: "VAMP" as const, copyProof: "chain" as const };
    expect(chainProven(proven)).toBe(true);
    expect(flagWord(proven)).toBe("confirmed");
    expect(flagLine(proven)).toMatch(/confirmed from Pump.fun's record/);
    expect(vampIntro("chain")).toMatch(/record shows a different wallet/);
  });
  it("other labels keep their own wording", () => {
    expect(flagLine({ flagKind: "BOT/RUG", copyProof: undefined })).toBe("Labelled by the checks: no score is shown");
    expect(flagWord({ flagKind: "HONEYPOT", copyProof: undefined })).toBe("confirmed");
  });
  it("a possible copy is a warning that keeps the score and says what the chain showed", () => {
    expect(possibleLine({ ticker: "$X", address: "a", proof: "unchecked" })).toMatch(/creator check has not been done/);
    expect(possibleLine({ ticker: "$X", address: "a", proof: "chain" })).toMatch(/two different wallets/);
    expect(possibleLine({ ticker: "$X", address: "a", proof: "chain" })).toMatch(/score below is the engine's and stays/);
    expect(possibleLine({ ticker: "$X", address: "a", proof: "chain" }, false)).toMatch(/nothing is hidden or removed/);
  });
  it("makes a link to the original only when the chain is clear, never an invented one", () => {
    const sol = "A7rRfLf67GMp5DFeY7s4kUaZLZbbz6UFPM5XYSg2pump";
    const evm = "0x" + "a".repeat(40);
    expect(originalLink(sol, "solana")).toBe(`https://dexscreener.com/solana/${sol}`);
    expect(originalLink(evm, "base")).toBe(`https://dexscreener.com/base/${evm}`);
    expect(originalLink(evm, "solana")).toBeNull();
    expect(originalLink("not an address", "solana")).toBeNull();
  });
});
