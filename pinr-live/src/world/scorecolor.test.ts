import { describe, expect, it } from "vitest";
import { LIME_RGB, MANDARIN_RGB, scoreColor, scoreRgb, scoreT } from "./scorecolor";

describe("score colour scale", () => {
  it("is mandarin orange at 25 and lime at 95, exactly", () => {
    expect(scoreRgb(25)).toEqual([...MANDARIN_RGB]);
    expect(scoreRgb(95)).toEqual([...LIME_RGB]);
  });

  it("stays mandarin below 25 and lime above 95", () => {
    expect(scoreRgb(1)).toEqual([...MANDARIN_RGB]);
    expect(scoreRgb(10)).toEqual([...MANDARIN_RGB]);
    expect(scoreRgb(99)).toEqual([...LIME_RGB]);
  });

  it("blends smoothly between: every channel moves steadily and never jumps more than a few steps per point", () => {
    let prev = scoreRgb(25);
    for (let s = 26; s <= 95; s++) {
      const cur = scoreRgb(s);
      for (let ch = 0; ch < 3; ch++) {
        const lo = Math.min(MANDARIN_RGB[ch]!, LIME_RGB[ch]!);
        const hi = Math.max(MANDARIN_RGB[ch]!, LIME_RGB[ch]!);
        expect(cur[ch]!).toBeGreaterThanOrEqual(lo);
        expect(cur[ch]!).toBeLessThanOrEqual(hi);
        expect(Math.abs(cur[ch]! - prev[ch]!)).toBeLessThanOrEqual(3);
        // monotonic: moves one way only
        expect((cur[ch]! - prev[ch]!) * (LIME_RGB[ch]! - MANDARIN_RGB[ch]!)).toBeGreaterThanOrEqual(0);
      }
      prev = cur;
    }
  });

  it("the midpoint (60) is half way between the two colours", () => {
    expect(scoreT(60)).toBeCloseTo(0.5, 9);
    const m = scoreRgb(60);
    expect(Math.abs(m[0] - (255 + 214) / 2)).toBeLessThanOrEqual(0.5);
    expect(Math.abs(m[1] - (140 + 255) / 2)).toBeLessThanOrEqual(0.5);
  });

  it("higher scores are always greener (more lime) than lower ones", () => {
    expect(scoreRgb(80)[1]).toBeGreaterThan(scoreRgb(40)[1]);
    expect(scoreRgb(80)[0]).toBeLessThan(scoreRgb(40)[0]);
  });

  it("copes with odd input", () => {
    expect(scoreColor(NaN)).toBe(scoreColor(25));
    expect(scoreColor(-5)).toBe(scoreColor(25));
    expect(scoreColor(1000)).toBe(scoreColor(95));
    expect(scoreColor(60)).toMatch(/^rgb\(\d+,\d+,\d+\)$/);
  });
});
