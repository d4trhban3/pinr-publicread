import { describe, expect, it } from "vitest";
import { cleanEvents } from "./events";

describe("chart events", () => {
  it("keeps good rows, drops bad ones, sorts by time", () => {
    const r = cleanEvents({
      contract: "1.1",
      events: [
        { t: 200, kind: "flag_raised", text: "Flag raised" },
        { t: 100, kind: "score_up", from: 40, to: 62, text: "Score up" },
        { t: -5, kind: "surge" },
        { t: 300, kind: "made_up" },
        "junk",
      ],
    });
    expect(r.map((e) => e.t)).toEqual([100, 200]);
    expect(r[0]).toMatchObject({ kind: "score_up", tone: "good", from: 40, to: 62 });
    expect(r[1]).toMatchObject({ kind: "flag_raised", tone: "bad" });
  });
  it("refuses another major version and non-lists", () => {
    expect(cleanEvents({ contract: "2.0", events: [{ t: 1, kind: "surge" }] })).toEqual([]);
    expect(cleanEvents({ contract: "1.1", events: "x" })).toEqual([]);
    expect(cleanEvents(null)).toEqual([]);
  });
  it("trims text and ignores scores outside 0 to 100", () => {
    const r = cleanEvents({ contract: "1.1", events: [{ t: 5, kind: "score_down", from: 300, to: 20, text: "x".repeat(200) }] });
    expect(r[0]!.text.length).toBe(60);
    expect(r[0]!.from).toBeUndefined();
    expect(r[0]!.to).toBe(20);
  });
});
