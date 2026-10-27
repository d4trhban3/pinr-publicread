import { describe, expect, it } from "vitest";
import { axisRange, cameraFor, journeyAt, journeyDip, journeySeconds, mapExtent, mapFitScale, nearestPage, pageFrames, PAGE_ORDER } from "./sitemap";

const PW = 378;
const PH = 675;
const frames = pageFrames(PW, PH);

describe("site map layout", () => {
  it("puts the pages where the operator drew them: PvP Arena north, PINR centre, Discover west, Wallet east, DeepScan south (2026-10-25)", () => {
    const c = (id: keyof typeof frames) => ({ x: frames[id].x + PW / 2, y: frames[id].y + PH / 2 });
    expect(c("pinr").x).toBeCloseTo(0, 9);
    expect(c("arena").x).toBeCloseTo(c("pinr").x, 9);
    expect(c("arena").y).toBeLessThan(c("pinr").y);
    expect(c("deepscan").y).toBeGreaterThan(c("pinr").y);
    expect(c("deepscan").x).toBeCloseTo(c("pinr").x, 9);
    expect(c("discover").x).toBeLessThan(c("pinr").x);
    expect(c("discover").y).toBeCloseTo(c("pinr").y, 9);
    expect(c("wallet").x).toBeGreaterThan(c("pinr").x);
    expect(c("wallet").y).toBeCloseTo(c("pinr").y, 9);
  });

  it("puts an ad area in each corner: north-west, north-east, south-west, south-east", () => {
    expect(frames.ads.y).toBe(frames.arena.y);
    expect(frames.adsne.y).toBe(frames.arena.y);
    expect(frames.ads.x).toBeCloseTo(frames.discover.x, 9);
    expect(frames.adsne.x).toBeCloseTo(frames.wallet.x, 9);
    expect(frames.adsw.x).toBeCloseTo(frames.discover.x, 9);
    expect(frames.adsw.y).toBeCloseTo(frames.deepscan.y, 9);
    expect(frames.adse.x).toBeCloseTo(frames.wallet.x, 9);
    expect(frames.adse.y).toBeCloseTo(frames.deepscan.y, 9);
  });

  it("the PINR guide is not on the map (it opens over the page from the header)", () => {
    expect(Object.keys(frames)).not.toContain("scan");
  });

  it("nothing sticks out past the 3 x 3 grid, so the zoom-out limit is the grid itself", () => {
    const e = mapExtent(frames);
    const ids = Object.keys(frames) as (keyof typeof frames)[];
    expect(ids.length).toBe(9);
    expect(e.left).toBeCloseTo(frames.discover.x, 9);
    expect(e.right).toBeCloseTo(frames.wallet.x + PW, 9);
    expect(e.top).toBeCloseTo(frames.arena.y, 9);
    expect(e.bottom).toBeCloseTo(frames.deepscan.y + PH, 9);
  });

  it("is symmetric about the centre page and never overlaps", () => {
    const c = (id: keyof typeof frames) => frames[id].x + PW / 2;
    expect(c("discover") + c("wallet")).toBeCloseTo(2 * c("pinr"), 9);
    const f = Object.values(frames);
    for (let i = 0; i < f.length; i++)
      for (let j = i + 1; j < f.length; j++) {
        const a = f[i]!;
        const b = f[j]!;
        expect(a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h).toBe(false);
      }
  });

  it("keeps PINR's top edge at 0 and centred, where its tile grid already sits", () => {
    expect(frames.pinr.y).toBe(0);
    expect(frames.pinr.x + PW / 2).toBeCloseTo(0, 9);
  });

  it("the zoom-out limit is exactly where all five pages are in view", () => {
    const view = { w: 375, h: 812, top: 68, bottom: 74 };
    const s = mapFitScale(frames, view.w, view.h, view.top, view.bottom, 1);
    const e = mapExtent(frames);
    expect((e.right - e.left) * s).toBeLessThanOrEqual(view.w + 1e-6);
    expect((e.bottom - e.top) * s).toBeLessThanOrEqual(view.h - view.top - view.bottom + 1e-6);
    // and it is the tightest fit: one of the two sides is exactly full
    const fullW = Math.abs((e.right - e.left) * s - view.w) < 1e-6;
    const fullH = Math.abs((e.bottom - e.top) * s - (view.h - view.top - view.bottom)) < 1e-6;
    expect(fullW || fullH).toBe(true);
    expect(s).toBeLessThan(0.5);
  });

  it("looking at a page puts its top edge just under the header and its centre in the middle of the width", () => {
    const home = 0.992;
    const cam = cameraFor(frames.deepscan, 812, 68, home);
    expect(cam.x).toBeCloseTo(0, 9);
    // screen y of the frame's top = view centre + (frame.y - cam.y) * scale
    expect(812 / 2 + (frames.deepscan.y - cam.y) * home).toBeCloseTo(68, 6);
  });

  it("finds the page the camera is nearest to", () => {
    const home = 0.992;
    for (const id of PAGE_ORDER) {
      const c = cameraFor(frames[id], 812, 68, home);
      expect(nearestPage(frames, c.x + 10, c.y - 12, 812, 68, home)).toBe(id);
    }
  });
});

describe("ranges and journeys", () => {
  it("scroll range keeps content on screen; content smaller than the screen is centred", () => {
    expect(axisRange(0, 1000, 300, 400)).toEqual({ min: 300, max: 600 });
    const r = axisRange(0, 100, 300, 400);
    expect(r.min).toBe(r.max);
    expect(r.min).toBeCloseTo((300 + -300) / 2, 9);
  });

  it("a journey starts and ends exactly on the requested views", () => {
    const a = { x: 0, y: 340, lz: 0 };
    const b = { x: -456, y: 1100, lz: 0 };
    expect(journeyAt(0, a, b, 0.9)).toEqual({ x: 0, y: 340, lz: 0 });
    const end = journeyAt(1, a, b, 0.9);
    expect(end.x).toBeCloseTo(-456, 9);
    expect(end.y).toBeCloseTo(1100, 9);
    expect(end.lz).toBeCloseTo(0, 9);
  });

  it("zooms out in the middle of a trip and back in at the end, never zooming in past where it started", () => {
    const a = { x: 0, y: 0, lz: 0 };
    const b = { x: 100, y: 800, lz: 0 };
    let lowest = 0;
    for (let p = 0; p <= 1.0001; p += 0.01) {
      const s = journeyAt(p, a, b, 1.1);
      lowest = Math.min(lowest, s.lz);
      expect(s.lz).toBeLessThanOrEqual(1e-9);
    }
    expect(lowest).toBeCloseTo(-1.1, 2);
  });

  it("moves steadily in one direction (no overshoot or wobble)", () => {
    const a = { x: 0, y: 0, lz: 0 };
    const b = { x: 0, y: 900, lz: 0 };
    let prev = -1;
    for (let p = 0; p <= 1.0001; p += 0.02) {
      const y = journeyAt(p, a, b, 0.8).y;
      expect(y).toBeGreaterThanOrEqual(prev);
      prev = y;
    }
  });

  it("farther trips zoom out further and take longer, and a tiny hop barely dips", () => {
    const step = 755;
    expect(journeyDip(step * 2, step, 1.2)).toBeGreaterThan(journeyDip(step, step, 1.2));
    expect(journeyDip(step * 2, step, 1.2)).toBeLessThanOrEqual(1.2);
    expect(journeyDip(2, step, 1.2)).toBe(0);
    expect(journeySeconds(step * 2, step)).toBeGreaterThan(journeySeconds(step, step));
    expect(journeySeconds(0, step)).toBeGreaterThan(0.5);
  });
});
