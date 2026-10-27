import { describe, expect, it } from "vitest";
import { layoutGrid } from "./layout";
import { MAX_PUSH, pressureOffsets, type Body } from "./pressure";

const b = (cx: number, cy: number, grow = 1, w = 170, h = 170): Body => ({ cx, cy, w, h, grow });

describe("pressure field", () => {
  it("does nothing when nobody is swelling", () => {
    const r = pressureOffsets([b(0, 0), b(200, 0), b(0, 200)]);
    expect([...r].every((v) => v === 0)).toBe(true);
  });

  it("pushes neighbours directly away from the swelling card", () => {
    const r = pressureOffsets([b(0, 0, 1.2), b(200, 0), b(0, -200), b(-200, 0)]);
    expect(r[2]!).toBeGreaterThan(5); // right neighbour moves right
    expect(Math.abs(r[3]!)).toBeLessThan(1e-4);
    expect(r[5]!).toBeLessThan(-5); // upper neighbour moves up
    expect(r[6]!).toBeLessThan(-5); // left neighbour moves left
  });

  it("does not move the swelling card itself", () => {
    const r = pressureOffsets([b(0, 0, 1.2), b(200, 0)]);
    expect(r[0]).toBe(0);
    expect(r[1]).toBe(0);
  });

  it("pushes near cards more than far cards", () => {
    const r = pressureOffsets([b(0, 0, 1.2), b(200, 0), b(600, 0)]);
    expect(r[2]!).toBeGreaterThan(r[4]!);
    expect(r[4]!).toBeGreaterThan(0);
  });

  it("scales with how much the card swells", () => {
    const small = pressureOffsets([b(0, 0, 1.05), b(200, 0)]);
    const big = pressureOffsets([b(0, 0, 1.2), b(200, 0)]);
    expect(big[2]!).toBeGreaterThan(small[2]!);
  });

  it("never shoves anything further than the cap, even when crowded", () => {
    const crowd = [b(0, 0, 1.5), b(10, 0, 1.5), b(0, 10, 1.5), b(10, 10, 1.5), b(5, 5)];
    const r = pressureOffsets(crowd);
    for (let i = 0; i < crowd.length; i++) expect(Math.hypot(r[i * 2]!, r[i * 2 + 1]!)).toBeLessThanOrEqual(MAX_PUSH + 1e-4);
  });

  it("keeps a neighbour clear of a swollen card in a real layout", () => {
    // Take the real masonry, swell the middle card by 20%, and check the touching ring is not overlapped.
    const rects = layoutGrid(Array.from({ length: 30 }, (_, id) => id), 5, 66, 40, 8);
    const bodies: Body[] = [...rects.values()].map((r) => ({ cx: r.x + r.w / 2, cy: r.y + r.h / 2, w: r.w, h: r.h, grow: 1 }));
    const g = 12;
    bodies[g]!.grow = 1.24;
    const off = pressureOffsets(bodies, undefined, 66 / 170);
    const A = bodies[g]!;
    const ar = { x0: A.cx - (A.w * 1.2) / 2, x1: A.cx + (A.w * 1.2) / 2, y0: A.cy - (A.h * 1.2) / 2, y1: A.cy + (A.h * 1.2) / 2 };
    let worst = 0;
    bodies.forEach((o, i) => {
      if (i === g) return;
      const x0 = o.cx - o.w / 2 + off[i * 2]!;
      const x1 = o.cx + o.w / 2 + off[i * 2]!;
      const y0 = o.cy - o.h / 2 + off[i * 2 + 1]!;
      const y1 = o.cy + o.h / 2 + off[i * 2 + 1]!;
      const ox = Math.min(ar.x1, x1) - Math.max(ar.x0, x0);
      const oy = Math.min(ar.y1, y1) - Math.max(ar.y0, y0);
      if (ox > 0 && oy > 0) worst = Math.max(worst, Math.min(ox, oy));
    });
    // A few pixels of tuck-under is fine (the swollen card is drawn on top); a big overlap is not.
    expect(worst).toBeLessThan(8);
  });
});
