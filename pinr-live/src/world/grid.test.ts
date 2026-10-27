import { describe, expect, it } from "vitest";
import { allowedCols, clampCols, defaultCols, fitScale, gridWidth, shownCols, tileScale } from "./grid";

describe("the tiles a screen starts on", () => {
  it("is five across on a wide screen and four on a phone (R1: the tile carries its name)", () => {
    expect(defaultCols(1440)).toBe(5);
    expect(defaultCols(1024)).toBe(5);
    expect(defaultCols(375)).toBe(4);
    expect(defaultCols(440)).toBe(4);
  });
  it("is always a count the screen allows", () => {
    for (const w of [320, 375, 440, 768, 1024, 1440]) expect(clampCols(defaultCols(w), w)).toBe(defaultCols(w));
    expect(allowedCols(375)).toContain(4);
  });
});

describe("a website, not an app frame: the grid fills any window", () => {
  it("a wider window shows more tiles across at the chosen size, never fewer than chosen, and always fills the width", () => {
    for (const w of [700, 1024, 1280, 1600, 1920, 2560, 3840]) {
      for (const c of [4, 5, 6, 8, 10, 12]) {
        const n = shownCols(c, w);
        expect(n).toBeGreaterThanOrEqual(c);
        // filling the width makes a tile at most one tile's share bigger than the chosen size, never smaller
        expect(fitScale(n, w)).toBeGreaterThanOrEqual(tileScale(c, w) - 1e-9);
        if (n > c) expect(fitScale(n, w)).toBeLessThanOrEqual((tileScale(c, w) * (n + 1)) / n);
        expect(gridWidth(n) * fitScale(n, w)).toBeCloseTo(w, 6);
      }
    }
    expect(shownCols(5, 832)).toBe(5); // the old wide-screen room: five across, as before
    expect(shownCols(5, 1600)).toBe(9);
    expect(shownCols(5, 2560)).toBe(15);
    expect(shownCols(10, 1600)).toBeGreaterThan(shownCols(5, 1600)); // a bigger count is smaller tiles
  });
  it("on a phone the chosen count is the count (the apps' tiles)", () => {
    for (const c of [2, 3, 4]) expect(shownCols(c, 390)).toBe(c);
    expect(tileScale(2, 390)).toBe(Math.min(4, fitScale(2, 390)));
  });
});
