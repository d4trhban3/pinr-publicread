import { onLook, palette } from "../ui/theme";
import type { StreamTile } from "../world/cards";
import { SIM } from "../world/model";
import { COUNTED_DIM, flowSpeed, makeFlow, prewarm, REAL_SPEED, realOf, ribbonMode, ribbonValue, spawnRate, stepFlow, stepReal, type Flow, type RibbonMode } from "../world/flow";

/**
 * Flowing streams. Drawn on one canvas that sits ABOVE the blurred glass and BELOW the text, so the
 * streams stay sharp and the numbers stay crisp on top of them.
 *
 * Per tile: a faint RIBBON (the last ~38 s of activity, "now" at the right edge) and PARTICLES riding it
 * toward "now". A particle is one trade: lime = buy, mandarin = sell.
 *
 * The rules, set by the operator:
 *   - there is no line and no halo: the stream's shape and overall colour come ONLY from the trades, each a lime (buy) or mandarin (sell) streak
 *   - a trade's SIZE is its HEIGHT. A buy rides above the stream's line, a sell below it, as far as its
 *     size: a big buy streaks along the top of the range and swoops up at the end, a big sell along the bottom and swoops down; small trades stay
 *     near the line. So the stream shows volume (how many), trade size (how high or low) and how fast money moves (speed, streak length)
 *   - activity changes SPEED (never thickness)
 * All particles of one colour and brightness are stroked in a single batch, so cost barely grows with count.
 */
const SAMPLES = 18; // points per ribbon
export let LIME = "214,255,60";
export let MANDARIN = "255,140,26";
onLook(() => {
  LIME = palette().live;
  MANDARIN = palette().mandarin;
});
/** Opacity steps. */
export const SIZE_ALPHAS = [0.2, 0.38, 0.56, 0.74, 0.92];
/** How far above (buy) or below (sell) the line a trade of the largest size rides, as a share of the tile's height; and its extra swoop at "now". */
export const SIZE_RANGE = 0.17;
export const SWOOP = 0.6;
/** Where a trade of this size (0..1) rides, in tile heights from the stream's line: up for a buy, down for a sell; the head swoops further near "now" (u = 1). */
export function sizeOffset(size: number, buy: boolean, u: number): number {
  const s = Math.min(1, Math.max(0, size));
  const swoop = u > 0.82 ? SWOOP * ((u - 0.82) / 0.18) ** 2 : 0;
  return (buy ? -1 : 1) * s * SIZE_RANGE * (1 + swoop);
}
/** Tiles narrower than this on screen are too small to show a stream. */
const MIN_TILE_PX = 26;

/** Which opacity step a trade of this size (0..1) gets. */
export function sizeBand(size: number): number {
  return Math.min(SIZE_ALPHAS.length - 1, Math.max(0, Math.floor(size * SIZE_ALPHAS.length)));
}

function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface TileState {
  flow: Flow;
  seen: number;
  /** which ribbon this state is drawing, and (real) the time of the newest trade already turned into a dot */
  mode: RibbonMode;
  cursor: number;
}

export class StreamLayer {
  private ctx: CanvasRenderingContext2D;
  private states = new Map<number, TileState>();
  private rnd = mulberry32(5);
  private frame = 0;
  private xs = new Float32Array(SAMPLES);
  private ys = new Float32Array(SAMPLES);
  /** [sell, buy][opacity step] */
  private buckets: Path2D[][] = [[], []];
  /** True while the camera is moving fast: the canvas is cleared once and left alone until things settle. */
  private held = false;
  /** Set true to show ribbons only (people who asked their device to reduce motion). */
  still = false;

  constructor(private canvas: HTMLCanvasElement) {
    this.ctx = canvas.getContext("2d")!;
    this.resetBuckets();
  }

  private resetBuckets(): void {
    for (const side of this.buckets) {
      side.length = 0;
      for (let b = 0; b < SIZE_ALPHAS.length; b++) side.push(new Path2D());
    }
  }

  resize(w: number, h: number, dpr: number): void {
    this.canvas.width = Math.round(w * dpr);
    this.canvas.height = Math.round(h * dpr);
  }

  /** Forget every stream's state (e.g. after the grid is rearranged), so they start fresh and full. */
  reset(): void {
    this.states.clear();
  }

  /** Pause drawing (and clear what is showing). Cheap to call every frame. */
  hold(): void {
    if (this.held) return;
    this.held = true;
    this.ctx.setTransform(1, 0, 0, 1, 0, 0);
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
  }

  draw(tiles: StreamTile[], count: number, dt: number, W: number, H: number, dpr: number, nowSec: number): void {
    this.held = false;
    const nowMs = Date.now();
    const ctx = this.ctx;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    this.frame++;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    this.resetBuckets();
    let lw = 1;

    for (let ti = 0; ti < count; ti++) {
      const t = tiles[ti]!;
      if (t.w < MIN_TILE_PX) continue;
      const it = t.item;
      // Flagged tokens stop being tracked, and a token being read has nothing to show yet: no stream.
      // Tokens with no trade stream (real results do not carry one yet) get no streaks: motion would be invented.
      // a coin with real trades is drawn from them (one dot each); else the counted ribbon, fainter; else nothing.
      const mode = ribbonMode(it, nowMs);
      if (mode === "none" || it.status === "flag" || it.status === "checking") continue;
      const real = mode === "real";
      let st = this.states.get(t.id);
      const speed = real ? REAL_SPEED : flowSpeed(t.imp, t.heat);
      const sizeK = Math.min(2, Math.max(0.6, Math.sqrt(t.w / 66)));
      const rate = spawnRate(speed, sizeK);
      if (!st) {
        st = { flow: makeFlow(), seen: this.frame, mode, cursor: nowMs };
        if (!real) prewarm(st.flow, rate, speed, it.buyShare, this.rnd);
        this.states.set(t.id, st);
      } else if (st.mode !== mode) {
        // The coin's first real trade (or the return to counts): nothing carries over, and a real ribbon never starts with made-up dots.
        st.flow.n = 0;
        st.flow.acc = 0;
        st.mode = mode;
        st.cursor = nowMs;
        if (!real) prewarm(st.flow, rate, speed, it.buyShare, this.rnd);
      } else if (this.frame - st.seen > 1) {
        // Was off screen: a counted ribbon starts already flowing; a real one starts empty and takes the trades heard from now on.
        if (real) {
          st.flow.n = 0;
          st.cursor = nowMs;
        } else prewarm(st.flow, rate, speed, it.buyShare, this.rnd);
      }
      st.seen = this.frame;
      if (!this.still) {
        if (real) st.cursor = stepReal(st.flow, dt, realOf(it.address)?.realTrades, st.cursor, this.rnd);
        else stepFlow(st.flow, dt, rate, speed, it.buyShare, this.rnd);
      }

      // The ribbon: where this tile's activity has been, left (oldest) to right (now).
      const x0 = t.x + t.w * 0.07;
      const iw = t.w * 0.86;
      const wob = t.h * 0.012;
      const flowT = nowSec * (0.6 + 1.5 * t.heat) + t.id * 1.7;
      for (let j = 0; j < SAMPLES; j++) {
        const u = j / (SAMPLES - 1);
        const v = ribbonValue(it.hist, it.histAge, SIM.histEvery, t.imp, u);
        this.xs[j] = x0 + iw * u;
        // The stream runs through the lower middle of the tile, leaving room above it for event messages; the recent activity only bends it gently up or down.
        this.ys[j] = t.y + t.h * (0.62 - 0.16 * (v - 0.5)) + Math.sin(u * 7 + flowT) * wob * (0.4 + u);
      }
      // Thickness follows the tile's size on screen (zoom), never the data.
      lw = Math.min(3, Math.max(0.7, (t.w / 66) * 1.1));

      // Particles: trades riding the ribbon toward "now".
      if (!this.still) {
        const f = st.flow;
        const jitter = lw * 1.2; // a little spread so trades of one size do not sit on one line
        for (let i = 0; i < f.n; i++) {
          const u = f.u[i]!;
          if (u > 1) continue;
          // A faster trade leaves a longer streak. A mix counted in trades (DexScreener's counts, not dollars) is drawn as faint dots near the line.
          const trail = real ? 0.03 + 0.04 * f.spd[i]! : 0.002;
          const u0 = Math.max(0, u - trail);
          const buy = f.side[i] === 1;
          const size = real ? f.size[i]! : f.size[i]! * COUNTED_DIM * 0.5;
          const j = (f.lane[i]! - 0.5) * jitter;
          const path = this.buckets[f.side[i]!]![real ? SIZE_ALPHAS.length - 1 : 1]!;
          path.moveTo(x0 + iw * u0, this.interpY(u0) + sizeOffset(size, buy, u0) * t.h + j);
          path.lineTo(x0 + iw * u, this.interpY(u) + sizeOffset(size, buy, u) * t.h + j);
        }
      }

    }

    // One stroke per (colour, opacity step): the whole field of particles in ten draw calls. Same width for all.
    for (let s = 0; s < 2; s++) {
      for (let b = 0; b < SIZE_ALPHAS.length; b++) {
        ctx.strokeStyle = `rgba(${s === 1 ? LIME : MANDARIN},${SIZE_ALPHAS[b]})`;
        ctx.lineWidth = lw;
        ctx.stroke(this.buckets[s]![b]!);
      }
    }

    // Forget tiles that have been off screen for a while.
    if (this.frame % 120 === 0) for (const [id, st] of this.states) if (this.frame - st.seen > 240) this.states.delete(id);
  }

  /** The ribbon's height at u, from the samples computed for the current tile this frame. */
  private interpY(u: number): number {
    const f = Math.min(SAMPLES - 1, Math.max(0, u * (SAMPLES - 1)));
    const i = Math.min(SAMPLES - 2, Math.floor(f));
    const k = f - i;
    return this.ys[i]! + (this.ys[i + 1]! - this.ys[i]!) * k;
  }
}
