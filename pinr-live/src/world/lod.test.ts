import { describe, expect, it } from "vitest";
import { CARD_W, GAP, LOD_AT, LOD_DESIGN_W, lodFor } from "./cards";

describe("semantic zoom levels", () => {
  it("picks more detail as tiles get bigger on screen", () => {
    expect(lodFor(60, 0)).toBe(0);
    expect(lodFor(100, 0)).toBe(1);
    expect(lodFor(150, 1)).toBe(2);
    expect(lodFor(300, 2)).toBe(3);
  });

  it("can jump several levels in one step (a fast pinch)", () => {
    expect(lodFor(400, 0)).toBe(3);
    expect(lodFor(30, 3)).toBe(0);
  });

  it("does not flicker right at a boundary", () => {
    const edge = LOD_AT[0]!;
    // Hovering around the boundary keeps whichever level it was already on.
    expect(lodFor(edge * 1.02, 0)).toBe(0);
    expect(lodFor(edge * 0.98, 1)).toBe(1);
    expect(lodFor(edge * 1.1, 0)).toBe(1);
    expect(lodFor(edge * 0.9, 1)).toBe(0);
  });

  it("keeps text within a sane band wherever a different level exists to switch to", () => {
    // Text is scaled by (on-screen width / design width). Levels 0 and 3 have nothing smaller / bigger
    // to switch to, so they are the zoomed-out overview and the infinite-zoom end; the rest must stay close to 1.
    for (let sw = 20; sw < 4000; sw *= 1.05) {
      const lod = lodFor(sw, 0);
      const k = sw / LOD_DESIGN_W[lod]!;
      if (lod === 0) expect(k).toBeLessThan(1.35);
      if (lod === 3) expect(k).toBeGreaterThan(0.78);
      if (lod === 1 || lod === 2) {
        expect(k).toBeGreaterThan(0.78);
        expect(k).toBeLessThan(1.35);
      }
    }
  });

  it("puts 5 tiles across a 390 px phone at home", () => {
    const cols = 5;
    const width = cols * CARD_W + (cols + 1) * GAP;
    const scale = 390 / width;
    expect(Math.floor(390 / (CARD_W * scale + GAP * scale))).toBeGreaterThanOrEqual(5);
    expect(lodFor(CARD_W * scale, 0)).toBe(0);
  });
});
