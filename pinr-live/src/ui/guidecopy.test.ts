import { describe, expect, it } from "vitest";
import { GUIDE_SECTIONS, guideSections } from "./guidecopy";

const all = GUIDE_SECTIONS.flatMap((s) => [s.title, ...s.blocks.map((b) => `${b.lead ?? ""} ${b.text}`)]).join("\n");

describe("the PINR guide's text", () => {
  it("has the seven approved sections, in order", () => {
    expect(GUIDE_SECTIONS.map((s) => s.title)).toEqual([
      "Where everything is",
      "Why the site is laid out this way",
      "What a score is, and is not",
      "How PINR scans",
      "The data, one kind at a time",
      "What PINR does for each kind of trader",
      "What PINR does not do",
    ]);
  });
  it("carries the operator's three changes", () => {
    expect(all).not.toContain("draws real buying");
    expect(GUIDE_SECTIONS[2]!.blocks[0]!.text.startsWith("PINR's summary, from 1 to 99, of what its checks found.")).toBe(true);
    expect(all).toContain("every number with a source line can be traced to its source");
    expect(all).not.toContain("every number can be traced");
    expect(all).not.toContain("A PINRscore is how many");
  });
  it("keeps clear of words the public copy rules forbid", () => {
    expect(all).not.toMatch(/\bsafe\b|safely|guarantee|proven|classroom|holds the floor/i);
  });
});

describe("the guide while the score is hidden", () => {
  const hidden = guideSections(false);
  const text = hidden.flatMap((s) => [s.title, ...s.blocks.map((b) => `${b.lead ?? ""} ${b.text}`)]).join("\n");
  it("is the approved text, untouched, when the score is shown", () => {
    expect(guideSections(true)).toBe(GUIDE_SECTIONS);
  });
  it("drops the sections about the score and says nothing of a score, coverage, PINRbot or a verdict", () => {
    expect(hidden.map((s) => s.title)).toEqual(["Where everything is", "Why the site is laid out this way", "The data, one kind at a time", "What PINR does for each kind of trader", "What PINR does not do"]);
    expect(text).not.toMatch(/PINRscore|\bscore|coverage|PINRbot|Strong|Weak/i);
  });
  it("uses the doctor's words, and keeps clear of words the public copy rules forbid", () => {
    expect(text).toContain("observed, not checked yet, worth a closer look");
    expect(text).not.toMatch(/\bsafe\b|safely|guarantee|proven|classroom|holds the floor/i);
  });
});
