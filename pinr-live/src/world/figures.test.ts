import { describe, expect, it } from "vitest";
import { figureOrNotRead } from "./figures";

describe("a figure is shown only with its source named (the team, 26 Oct: \"$486 no source\")", () => {
  it("a value with a source and a time is shown", () => {
    expect(figureOrNotRead("$486", ["Jupiter", 1_000])).toEqual({ value: "$486", notRead: false });
  });
  it("a value with no source, or no read time, is a dash that says not read yet", () => {
    expect(figureOrNotRead("$486", [null, null])).toEqual({ value: "—", notRead: true });
    expect(figureOrNotRead("$486", ["Jupiter", null])).toEqual({ value: "—", notRead: true });
  });
  it("a dash that has a source concept says not read yet too (the all-time high); a figure with no source concept passes", () => {
    expect(figureOrNotRead("—", [null, null])).toEqual({ value: "—", notRead: true });
    expect(figureOrNotRead("1m", undefined)).toEqual({ value: "1m", notRead: false });
    expect(figureOrNotRead("—", undefined)).toEqual({ value: "—", notRead: false });
  });
});

describe("a curve coin has no pool yet, so its Pool section says so", () => {
  it("on a bonding curve: \"On its bonding curve; no pool yet.\"; graduated or unknown: \"Not checked yet.\"", async () => {
    const { noPoolWords, ON_CURVE_WORDS } = await import("./figures");
    expect(noPoolWords("Pump.fun curve")).toBe(ON_CURVE_WORDS);
    expect(noPoolWords("LaunchLab curve")).toBe(ON_CURVE_WORDS);
    expect(noPoolWords("PumpSwap (graduated)")).toBe("Not checked yet.");
    expect(noPoolWords(undefined)).toBe("Not checked yet.");
    expect(ON_CURVE_WORDS).toBe("On its bonding curve; no pool yet.");
  });
});
