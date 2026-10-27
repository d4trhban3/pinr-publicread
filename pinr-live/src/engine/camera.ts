import { makeSpring, springSettled, stepSpring, type Spring } from "./spring";

/**
 * Infinite-canvas camera.
 *  - (x, y) is the world point shown at the centre of the screen.
 *  - zoom is stored as a natural-log scale so zooming feels even at every depth
 *    (a pinch of the same size always means "the same amount closer").
 * Zooming OUT is effectively unlimited. Zooming IN is capped at 20x for now: deeper than that a
 * single tile is hundreds of thousands of pixels wide and the browser stalls, and there is no new
 * detail to see there yet. Lift this when drill-down content exists (the flowing streams, step 4).
 */
export const MIN_LOG_ZOOM = Math.log(1e-4);
export const MAX_LOG_ZOOM = Math.log(20);

/** Move from `from` to `to` inside [lo, hi]; only the part of the move beyond an edge is resisted (rubber band). */
export function resist(from: number, to: number, lo: number, hi: number, k = 0.4): number {
  if (to < lo) return from >= lo ? lo + (to - lo) * k : from + (to - from) * (to < from ? k : 1);
  if (to > hi) return from <= hi ? hi + (to - hi) * k : from + (to - from) * (to > from ? k : 1);
  return to;
}

export interface View {
  w: number;
  h: number;
}

export class Camera {
  x = 0;
  y = 0;
  logZoom = 0;

  /** Inertia, in world units/s and log-zoom/s. */
  vx = 0;
  vy = 0;
  vz = 0;
  /** Screen point the current zoom inertia is anchored to. */
  anchorX = 0;
  anchorY = 0;

  /** Hard-lock sideways movement (x stays put). */
  lockX = false;
  /** Sideways limits. When the content is narrower than the screen the app sets both to 0, which locks it in the middle. */
  minX = -Infinity;
  maxX = Infinity;
  /** Vertical limits of the content (world y of the screen centre). The edge gives like rubber, then springs back. */
  minY = -Infinity;
  maxY = Infinity;
  /** True while a finger is down: overscroll is allowed (with resistance) only then. */
  touching = false;
  /** Zoom limits (log scale) for the current gesture; the app narrows these to the range of tile counts it offers. */
  zoomLo = MIN_LOG_ZOOM;
  zoomHi = MAX_LOG_ZOOM;

  private home = { x: 0, y: 0, logZoom: 0 };
  private homing = false;
  private sx: Spring = makeSpring();
  private sy: Spring = makeSpring();
  private sz: Spring = makeSpring();

  get scale(): number {
    return Math.exp(this.logZoom);
  }

  setHome(x: number, y: number, scale: number): void {
    this.home = { x, y, logZoom: Math.log(scale) };
  }

  jumpHome(): void {
    this.x = this.home.x;
    this.y = this.home.y;
    this.logZoom = this.home.logZoom;
    this.stopMotion();
  }

  /** Spring back to the home view. Any direct touch cancels it. */
  flyHome(): void {
    this.flyTo(this.home.x, this.home.y, Math.exp(this.home.logZoom));
  }

  /** Glide to a position and zoom. Any direct touch cancels it. */
  flyTo(x: number, y: number, scale: number): void {
    this.stopInertia();
    this.sx = { x: this.x, v: 0, target: x };
    this.sy = { x: this.y, v: 0, target: y };
    this.sz = { x: this.logZoom, v: 0, target: Math.log(scale) };
    this.homing = true;
  }

  /** Which way, and how far, x is past the limits (0 when inside). */
  overscrollX(): number {
    if (this.x < this.minX) return this.x - this.minX;
    if (this.x > this.maxX) return this.x - this.maxX;
    return 0;
  }

  /** Which way, and how far, y is past the limits (0 when inside). Positive = past the bottom. */
  overscroll(): number {
    if (this.y < this.minY) return this.y - this.minY;
    if (this.y > this.maxY) return this.y - this.maxY;
    return 0;
  }

  stopMotion(): void {
    this.stopInertia();
    this.homing = false;
  }

  stopInertia(): void {
    this.vx = this.vy = this.vz = 0;
  }

  cancelHoming(): void {
    this.homing = false;
  }

  screenToWorld(sx: number, sy: number, v: View): { x: number; y: number } {
    const s = this.scale;
    return { x: (sx - v.w / 2) / s + this.x, y: (sy - v.h / 2) / s + this.y };
  }

  /** Pan by a screen-space delta (finger moved dx, dy pixels). */
  panByScreen(dx: number, dy: number): void {
    const s = this.scale;
    // Pulling past an edge gets heavy, like a rubber band.
    if (!this.lockX) this.x = resist(this.x, this.x - dx / s, this.minX, this.maxX);
    this.y = resist(this.y, this.y - dy / s, this.minY, this.maxY);
  }

  /** Change zoom while keeping the world point under (sx, sy) fixed on screen. */
  zoomAbout(newLogZoom: number, sx: number, sy: number, v: View): void {
    const clamped = Math.min(Math.min(MAX_LOG_ZOOM, this.zoomHi), Math.max(Math.max(MIN_LOG_ZOOM, this.zoomLo), newLogZoom));
    const before = this.screenToWorld(sx, sy, v);
    this.logZoom = clamped;
    const s = this.scale;
    if (!this.lockX) this.x = before.x - (sx - v.w / 2) / s;
    this.y = before.y - (sy - v.h / 2) / s;
  }

  /** Advance inertia / homing by dt seconds. Returns true while anything is still moving. */
  step(dt: number, v: View): boolean {
    if (this.homing) {
      stepSpring(this.sx, 9, dt);
      stepSpring(this.sy, 9, dt);
      stepSpring(this.sz, 9, dt);
      this.x = this.sx.x;
      this.y = this.sy.x;
      this.logZoom = this.sz.x;
      if (springSettled(this.sx, 1e-3) && springSettled(this.sy, 1e-3) && springSettled(this.sz, 1e-5)) {
        this.homing = false;
      }
      return true;
    }

    let moving = false;
    if (this.lockX) this.vx = 0;
    // Rest threshold is in screen pixels per second so it behaves the same at every zoom depth.
    if (Math.hypot(this.vx, this.vy) * this.scale > 0.5) {
      this.x += this.vx * dt;
      this.y += this.vy * dt;
      const k = Math.exp(-2.6 * dt);
      this.vx *= k;
      this.vy *= k;
      moving = true;
    }
    // Past the top or bottom with no finger down: drag the momentum out and spring back to the edge.
    const over = this.overscroll();
    if (over !== 0 && !this.touching) {
      this.vy *= Math.exp(-14 * dt);
      const edge = over < 0 ? this.minY : this.maxY;
      this.y += (edge - this.y) * (1 - Math.exp(-12 * dt));
      if (Math.abs(this.y - edge) < 0.01) this.y = edge;
      moving = true;
    }
    const overX = this.lockX ? 0 : this.overscrollX();
    if (overX !== 0 && !this.touching) {
      this.vx *= Math.exp(-14 * dt);
      const edgeX = overX < 0 ? this.minX : this.maxX;
      this.x += (edgeX - this.x) * (1 - Math.exp(-12 * dt));
      if (Math.abs(this.x - edgeX) < 0.01) this.x = edgeX;
      moving = true;
    }
    if (Math.abs(this.vz) > 1e-4) {
      this.zoomAbout(this.logZoom + this.vz * dt, this.anchorX, this.anchorY, v);
      this.vz *= Math.exp(-7 * dt);
      moving = true;
    }
    return moving;
  }
}
