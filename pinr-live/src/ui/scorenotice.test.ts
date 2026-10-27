import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { BY_COUNT, SCORE_NOTICE, SCORE_TAG } from "./scorenotice";

describe("the notice beside every score", () => {
  it("is the operator's wording, letter for letter", () => {
    expect(SCORE_NOTICE).toBe("Social presence unchecked until the X API is connected. This score reads the chain only.");
  });
  it("the short tag is Chain only, and a ribbon made from counts is labelled counted (a design decision)", () => {
    expect(SCORE_TAG).toBe("Chain only");
    expect(BY_COUNT).toBe("counted");
  });
});

import { ADVICE_LINE, makeAdviceTag } from "./scorenotice";
describe("the line beside every score", () => {
  it("is the agreed wording, short, with no promise in it", () => {
    expect(ADVICE_LINE).toBe("Not investment advice");
    expect(ADVICE_LINE.length).toBeLessThan(30);
  });
  it("is on the tiles, the Discover rows and DeepScan, and only beside a numeric score", () => {
    const root = join(import.meta.dirname, "..");
    for (const [f, mark] of [["world/cards.ts", "advtag"], ["ui/discover.ts", "adviceEl.hidden = !look.numeric"], ["ui/deepscan.ts", "adviceLine.hidden = !look.numeric"]] as const) {
      expect(readFileSync(join(root, f), "utf8"), f).toContain(mark);
    }
    expect(typeof makeAdviceTag).toBe("function");
  });
});
