import { palette } from "../ui/theme";
import type { Camera, View } from "./camera";

/**
 * Infinite dot grid. Dots keep a comfortable on-screen spacing at every zoom depth by
 * crossfading between powers-of-two grids, which is what makes the zoom feel endless.
 */
export class GridLayer {
  private ctx: CanvasRenderingContext2D;
  /** What was drawn last: the dots only need redrawing when the camera (or the canvas) changed. */
  private key = "";
  constructor(private canvas: HTMLCanvasElement) {
    this.ctx = canvas.getContext("2d")!;
  }

  resize(w: number, h: number, dpr: number): void {
    this.canvas.width = Math.round(w * dpr);
    this.canvas.height = Math.round(h * dpr);
    this.key = "";
  }

  draw(cam: Camera, v: View, dpr: number): void {
    const key = `${cam.x.toFixed(2)}|${cam.y.toFixed(2)}|${cam.scale.toFixed(5)}|${v.w}|${v.h}`;
    if (key === this.key) return;
    this.key = key;
    const ctx = this.ctx;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, v.w, v.h);

    const s = cam.scale;
    const base = 48; // world units between dots at zoom 1
    // Level k has spacing base * 2^k in world units; pick the level whose screen spacing is ~[48, 96).
    const levelF = Math.log2(64 / (base * s));
    const k0 = Math.floor(levelF);
    const t = levelF - k0; // 0..1 crossfade
    for (let d = -1; d <= 1; d++) {
      const k = k0 + d;
      const spacing = base * Math.pow(2, k);
      const px = spacing * s;
      if (px < 14) continue;
      // Level k0 fades out as t -> 1, level k0+1 fades in; finer level fades with it.
      let a = d === 0 ? 1 - t : d === 1 ? t : 0;
      if (d === -1) a = 0;
      a = Math.min(a, 1);
      if (a < 0.02) continue;
      ctx.fillStyle = `rgba(${palette().text},${(0.16 * a).toFixed(3)})`;
      const x0 = Math.floor((cam.x - v.w / 2 / s) / spacing) * spacing;
      const y0 = Math.floor((cam.y - v.h / 2 / s) / spacing) * spacing;
      const x1 = cam.x + v.w / 2 / s;
      const y1 = cam.y + v.h / 2 / s;
      const r = 1.1;
      for (let wx = x0; wx <= x1; wx += spacing) {
        const sx = (wx - cam.x) * s + v.w / 2;
        for (let wy = y0; wy <= y1; wy += spacing) {
          const sy = (wy - cam.y) * s + v.h / 2;
          ctx.fillRect(sx - r / 2, sy - r / 2, r, r);
        }
      }
    }
  }
}
