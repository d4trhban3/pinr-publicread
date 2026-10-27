import { describe, expect, it } from "vitest";
import { cellHeightFor, layoutGrid, MAX_ROWS, VISIBLE_ROWS } from "./layout";

const ids = (n: number) => Array.from({ length: n }, (_, i) => i);
const CW = 66;
const CH = 40;
const GAP = 8;

describe("tile grid", () => {
  it("is 5 across, filling row by row in rank order", () => {
    const g = layoutGrid(ids(12), 5, CW, CH, GAP);
    const r = (i: number) => g.get(i)!;
    expect(r(0).y).toBe(0);
    expect(r(4).y).toBe(0);
    expect(r(5).y).toBe(CH + GAP);
    expect(r(5).x).toBe(r(0).x);
    expect(r(1).x - r(0).x).toBe(CW + GAP);
    expect(r(10).y).toBe(2 * (CH + GAP));
  });

  it("never overlaps and every tile is the same size", () => {
    const g = [...layoutGrid(ids(150), 5, CW, CH, GAP).values()];
    expect(new Set(g.map((r) => `${r.w}x${r.h}`)).size).toBe(1);
    for (let i = 0; i < g.length; i++)
      for (let j = i + 1; j < g.length; j++) {
        const a = g[i]!;
        const b = g[j]!;
        const hit = a.x < b.x + b.w - 0.01 && b.x < a.x + a.w - 0.01 && a.y < b.y + b.h - 0.01 && b.y < a.y + a.h - 0.01;
        expect(hit).toBe(false);
      }
  });

  it("is centred on the middle of the screen, with its top edge at zero", () => {
    const g = [...layoutGrid(ids(25), 5, CW, CH, GAP).values()];
    const left = Math.min(...g.map((r) => r.x));
    const right = Math.max(...g.map((r) => r.x + r.w));
    expect(left + right).toBeCloseTo(0, 9);
    expect(Math.min(...g.map((r) => r.y))).toBe(0);
  });

  it("holds at most 50 rows: 250 tiles at 5 across (more than the 200 roster limit), and drops the rest", () => {
    const g = layoutGrid(ids(400), 5, CW, CH, GAP);
    expect(g.size).toBe(5 * MAX_ROWS);
    expect(g.has(249)).toBe(true);
    expect(g.has(250)).toBe(false);
    expect(Math.max(...[...g.values()].map((r) => r.y))).toBe((MAX_ROWS - 1) * (CH + GAP));
  });

  it("shows fewer tiles without gaps when a filter leaves only a few", () => {
    const g = layoutGrid([42, 7, 99], 5, CW, CH, GAP);
    expect([...g.keys()]).toEqual([42, 7, 99]);
    expect(g.get(42)!.x).toBeLessThan(g.get(7)!.x);
  });

  it("handles an empty list and a single column", () => {
    expect(layoutGrid([], 5, CW, CH, GAP).size).toBe(0);
    const g = layoutGrid(ids(4), 1, CW, CH, GAP);
    expect(g.get(3)!.y).toBe(3 * (CH + GAP));
    expect(g.get(0)!.x).toBe(-CW / 2);
  });

  it("is deterministic", () => {
    expect([...layoutGrid(ids(60), 5, CW, CH, GAP)]).toEqual([...layoutGrid(ids(60), 5, CW, CH, GAP)]);
  });

  it("sizes tiles so exactly 15 rows fill the space available on a phone", () => {
    const available = 700;
    const scale = 1.03;
    const ch = cellHeightFor(available, scale, VISIBLE_ROWS, GAP);
    const used = VISIBLE_ROWS * (ch + GAP) * scale;
    expect(used).toBeCloseTo(available, 6);
    expect(ch).toBeGreaterThan(20);
  });
});
