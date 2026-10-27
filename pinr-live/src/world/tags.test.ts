import { describe, expect, it } from "vitest";
import { TAG_WORDS, tagsOf, tileTagPlan } from "./tags";

describe("a coin's tags, one list in one order everywhere", () => {
  it("takes the engine's tags, adds a VAMP label or a serial-launcher note the coin already carries, and keeps the order copy, bot, serial", () => {
    expect(tagsOf({ tags: ["serial_launcher", "bot"] })).toEqual(["bot", "serial_launcher"]);
    expect(tagsOf({ noScoreLabel: "VAMP" })).toEqual(["vamp"]);
    expect(tagsOf({ note: "Serial launcher; 40 launches" })).toEqual(["serial_launcher"]);
    expect(tagsOf({ tags: ["vamp", "vamp", "unknown"], flagKind: "VAMP" })).toEqual(["vamp"]);
    expect(tagsOf({})).toEqual([]);
  });
  it("says what each tag observed and where its evidence is, never a verdict or a price call", () => {
    for (const t of Object.values(TAG_WORDS)) {
      expect(t.means).toMatch(/At launch/);
      expect(t.means + t.chip).not.toMatch(/\b(scam|rug|safe|avoid|dump|proven)\b/i);
    }
  });
  it("a tile shows one chip and a count for the rest, so two tags never wrap onto a second line over its figures", () => {
    expect(tileTagPlan(["vamp", "serial_launcher"])).toEqual({ shown: ["vamp"], more: ["serial_launcher"] });
    expect(tileTagPlan(["serial_launcher"])).toEqual({ shown: ["serial_launcher"], more: [] });
    expect(tileTagPlan([])).toEqual({ shown: [], more: [] });
  });
});
