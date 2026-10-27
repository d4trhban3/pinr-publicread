import { describe, expect, it } from "vitest";
import { Camera, resist } from "./camera";
import { makeSpring, stepSpring } from "./spring";

const view = { w: 390, h: 844 };

describe("spring", () => {
  it("settles on its target without overshoot (critically damped)", () => {
    const s = makeSpring(0);
    s.target = 100;
    let max = 0;
    for (let i = 0; i < 600; i++) {
      stepSpring(s, 12, 1 / 120);
      max = Math.max(max, s.x);
    }
    expect(s.x).toBeCloseTo(100, 3);
    expect(max).toBeLessThanOrEqual(100.0001);
  });

  it("gives the same answer at 60, 120 and 240 fps", () => {
    const run = (hz: number) => {
      const s = makeSpring(0);
      s.target = 50;
      for (let i = 0; i < hz * 0.5; i++) stepSpring(s, 14, 1 / hz);
      return s.x;
    };
    expect(run(60)).toBeCloseTo(run(120), 9);
    expect(run(120)).toBeCloseTo(run(240), 9);
  });

  it("stays finite for a huge time step", () => {
    const s = makeSpring(0);
    s.target = 1;
    stepSpring(s, 30, 5);
    expect(Number.isFinite(s.x)).toBe(true);
    expect(s.x).toBeCloseTo(1, 6);
  });
});

describe("camera", () => {
  it("keeps the point under the finger fixed while zooming", () => {
    const cam = new Camera();
    cam.x = 120;
    cam.y = -40;
    const sx = 300;
    const sy = 200;
    const before = cam.screenToWorld(sx, sy, view);
    cam.zoomAbout(Math.log(3.7), sx, sy, view);
    const after = cam.screenToWorld(sx, sy, view);
    expect(after.x).toBeCloseTo(before.x, 9);
    expect(after.y).toBeCloseTo(before.y, 9);
  });

  it("zooming in then out by the same amount returns to the start", () => {
    const cam = new Camera();
    cam.x = 10;
    cam.y = 20;
    cam.zoomAbout(Math.log(5), 100, 600, view);
    cam.zoomAbout(Math.log(1), 100, 600, view);
    expect(cam.x).toBeCloseTo(10, 9);
    expect(cam.y).toBeCloseTo(20, 9);
  });

  it("pans by exactly the finger distance on screen at any zoom", () => {
    const cam = new Camera();
    cam.zoomAbout(Math.log(8), 195, 422, view);
    const p0 = cam.screenToWorld(50, 50, view);
    cam.panByScreen(30, -20);
    const p1 = cam.screenToWorld(80, 30, view);
    expect(p1.x).toBeCloseTo(p0.x, 9);
    expect(p1.y).toBeCloseTo(p0.y, 9);
  });

  it("stays usable at extreme depth in both directions, with zoom-in capped at 20x", () => {
    const cam = new Camera();
    cam.zoomAbout(Math.log(1e9), 195, 422, view);
    expect(cam.scale).toBeCloseTo(20, 6);
    cam.zoomAbout(Math.log(1e-9), 195, 422, view);
    expect(cam.scale).toBeCloseTo(1e-4, 9);
    expect(Number.isFinite(cam.x)).toBe(true);
  });

  it("flies home and stops there", () => {
    const cam = new Camera();
    cam.setHome(500, 700, 1.1);
    cam.zoomAbout(Math.log(6), 10, 10, view);
    cam.x = -3000;
    cam.flyHome();
    for (let i = 0; i < 600; i++) cam.step(1 / 120, view);
    expect(cam.x).toBeCloseTo(500, 2);
    expect(cam.y).toBeCloseTo(700, 2);
    expect(cam.scale).toBeCloseTo(1.1, 4);
  });

  it("fling inertia decays to rest", () => {
    const cam = new Camera();
    cam.vx = 2000;
    let moving = true;
    for (let i = 0; i < 1200 && moving; i++) moving = cam.step(1 / 120, view);
    expect(moving).toBe(false);
  });
});

describe("horizontal lock and scroll limits", () => {
  const v = { w: 390, h: 844 };

  it("ignores sideways drags when locked, but still scrolls up and down", () => {
    const cam = new Camera();
    cam.lockX = true;
    cam.panByScreen(120, 40);
    expect(cam.x).toBe(0);
    expect(cam.y).toBeCloseTo(-40, 9);
  });

  it("keeps the grid centred while zooming, from any pinch point", () => {
    const cam = new Camera();
    cam.lockX = true;
    cam.zoomAbout(Math.log(1.7), 20, 600, v);
    cam.zoomAbout(Math.log(0.8), 370, 100, v);
    expect(cam.x).toBe(0);
  });

  it("still keeps the point under the finger fixed vertically while locked", () => {
    const cam = new Camera();
    cam.lockX = true;
    const before = cam.screenToWorld(200, 500, v).y;
    cam.zoomAbout(Math.log(2), 200, 500, v);
    expect(cam.screenToWorld(200, 500, v).y).toBeCloseTo(before, 9);
  });

  it("gives like rubber past the edge, then springs back to it when let go", () => {
    const cam = new Camera();
    cam.lockX = true;
    cam.minY = 0;
    cam.maxY = 1000;
    cam.touching = true;
    cam.y = 0;
    cam.panByScreen(0, 100); // finger drags down: content moves down: y goes up toward -100 (past the top)
    expect(cam.y).toBeLessThan(0);
    expect(cam.y).toBeGreaterThan(-100); // resisted: less than the full finger distance
    cam.touching = false;
    for (let i = 0; i < 300; i++) cam.step(1 / 120, v);
    expect(cam.y).toBeCloseTo(0, 3);
  });

  it("does not resist moving back toward the content once past an edge", () => {
    const cam = new Camera();
    cam.minY = 0;
    cam.maxY = 1000;
    cam.touching = true;
    cam.y = -50;
    cam.panByScreen(0, -30); // finger up: y increases back toward the content
    expect(cam.y).toBeCloseTo(-20, 9);
  });

  it("a hard fling cannot carry the view far beyond the end", () => {
    const cam = new Camera();
    cam.lockX = true;
    cam.minY = 0;
    cam.maxY = 1000;
    cam.y = 990;
    cam.vy = 6000;
    let worst = 0;
    for (let i = 0; i < 600; i++) { cam.step(1 / 120, v); worst = Math.max(worst, cam.y - 1000); }
    expect(worst).toBeLessThan(260);
    expect(cam.y).toBeCloseTo(1000, 2);
  });

  it("limits zoom to the range the app sets, so a pinch cannot go past the offered tile counts", () => {
    const cam = new Camera();
    cam.zoomLo = Math.log(0.5);
    cam.zoomHi = Math.log(2);
    cam.zoomAbout(Math.log(50), 100, 100, v);
    expect(cam.scale).toBeCloseTo(2, 9);
    cam.zoomAbout(Math.log(0.001), 100, 100, v);
    expect(cam.scale).toBeCloseTo(0.5, 9);
  });

  it("glides to a chosen position and zoom, and stops there", () => {
    const cam = new Camera();
    cam.lockX = true;
    cam.flyTo(0, 400, 1.4);
    for (let i = 0; i < 600; i++) cam.step(1 / 120, v);
    expect(cam.y).toBeCloseTo(400, 2);
    expect(cam.scale).toBeCloseTo(1.4, 4);
  });
});

describe("sideways limits", () => {
  const v = { w: 390, h: 844 };

  it("lets a zoomed-in grid pan sideways inside its own edges, with a rubber band at each end", () => {
    const cam = new Camera();
    cam.minX = -100;
    cam.maxX = 100;
    cam.touching = true;
    cam.panByScreen(-60, 0); // finger left: view moves right
    expect(cam.x).toBeCloseTo(60, 9);
    cam.panByScreen(-200, 0); // 140 more would pass the edge: only the part beyond is resisted
    expect(cam.x).toBeGreaterThan(100);
    expect(cam.x).toBeLessThan(260);
    cam.touching = false;
    for (let i = 0; i < 300; i++) cam.step(1 / 120, v);
    expect(cam.x).toBeCloseTo(100, 3);
  });

  it("holds the grid in the middle when the limits are both zero (zoomed out)", () => {
    const cam = new Camera();
    cam.minX = cam.maxX = 0;
    cam.touching = true;
    cam.panByScreen(80, 0);
    cam.touching = false;
    for (let i = 0; i < 300; i++) cam.step(1 / 120, v);
    expect(cam.x).toBeCloseTo(0, 3);
  });

  it("the edge function resists only what goes past the edge, in both directions", () => {
    expect(resist(0, 50, -100, 100)).toBe(50);
    expect(resist(50, 150, -100, 100, 0.5)).toBe(125);
    expect(resist(150, 100, -100, 100)).toBe(100); // coming back is free
    expect(resist(-50, -150, -100, 100, 0.5)).toBe(-125);
  });
});

