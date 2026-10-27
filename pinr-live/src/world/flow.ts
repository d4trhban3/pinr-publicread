/**
 * The maths of the streams, with no drawing in it so it can be tested.
 *
 * Each tile has a RIBBON (its last ~38 seconds of importance, "now" at the right edge, scrolling left
 * as time passes) and PARTICLES that ride the ribbon toward "now". A particle stands for one trade:
 * lime if it was a buy, mandarin if it was a sell. Activity changes SPEED only: a hot tile's trades move
 * faster, but there are no more of them per ribbon length and none are thicker. The size of a trade is
 * shown as opacity (bigger = more solid), never as thickness.
 */

/**
 * The ribbon's value at horizontal position u (0 = oldest edge, 1 = now).
 * `hist` is oldest->newest samples spaced `every` seconds apart, the newest taken `age` seconds ago.
 * `nowValue` is the live value at u = 1. Between samples it blends smoothly, so the ribbon scrolls
 * continuously instead of stepping once per sample.
 */
export function ribbonValue(hist: readonly number[], age: number, every: number, nowValue: number, u: number): number {
  const n = hist.length;
  if (n === 0) return nowValue;
  const window = every * n;
  const t = (1 - Math.min(1, Math.max(0, u))) * window; // seconds before now
  if (t <= age) {
    // Between "now" and the newest sample.
    const k = age > 1e-9 ? t / age : 0;
    return nowValue + (hist[n - 1]! - nowValue) * smooth(k);
  }
  const idx = (t - age) / every; // 0 = newest sample, n-1 = oldest
  const i0 = Math.min(n - 1, Math.floor(idx));
  const i1 = Math.min(n - 1, i0 + 1);
  const k = Math.min(1, idx - i0);
  const a = hist[n - 1 - i0]!;
  const b = hist[n - 1 - i1]!;
  return a + (b - a) * smooth(k);
}

const smooth = (k: number): number => k * k * (3 - 2 * k);

export const MAX_PARTICLES = 56;

export interface Flow {
  n: number;
  /** Position along the ribbon, 0..1. */
  u: Float32Array;
  /** Which lane the trade rides in: about 0 (top), 0.5 (middle) or 1 (bottom), with a little jitter. */
  lane: Float32Array;
  /** Speed in ribbon-lengths per second. */
  spd: Float32Array;
  /** 1 = buy, 0 = sell. */
  side: Uint8Array;
  /** Trade size 0..1. Drawn as opacity: bigger = more solid. */
  size: Float32Array;
  /** Fractional particles waiting to be born. */
  acc: number;
}

export function makeFlow(): Flow {
  return {
    n: 0,
    u: new Float32Array(MAX_PARTICLES),
    lane: new Float32Array(MAX_PARTICLES),
    spd: new Float32Array(MAX_PARTICLES),
    side: new Uint8Array(MAX_PARTICLES),
    size: new Float32Array(MAX_PARTICLES),
    acc: 0,
  };
}

/** Particles per ribbon-length. Fixed, so that speeding up never makes a stream look thicker. */
export const DENSITY = 10;

/**
 * Trades born per second. Proportional to speed, so the number on the ribbon at once stays the same
 * whether it drifts or rushes. `sizeK` lets a bigger tile carry proportionally more.
 */
export function spawnRate(speed: number, sizeK = 1): number {
  return DENSITY * speed * sizeK;
}

/** How fast particles travel (ribbon-lengths per second): calm tiles drift, hot tiles rush. */
export function flowSpeed(imp: number, heat: number): number {
  return 0.16 + 0.3 * imp + 0.9 * heat;
}

function spawn(f: Flow, u: number, speed: number, buyShare: number, rnd: () => number): void {
  if (f.n >= MAX_PARTICLES) return;
  const i = f.n++;
  f.u[i] = u;
  // Each trade arrives in a random one of three lanes (top, middle, bottom): together they form the stream's shape.
  f.lane[i] = Math.floor(rnd() * 3) / 2 + (rnd() - 0.5) * 0.12;
  f.spd[i] = speed * (0.75 + 0.5 * rnd());
  f.side[i] = rnd() < buyShare ? 1 : 0;
  // Mostly small and quiet, some large and solid.
  f.size[i] = Math.pow(rnd(), 1.3);
}

/** Move every particle and retire the ones that reached "now". */
function advance(f: Flow, dt: number): void {
  for (let i = 0; i < f.n; ) {
    f.u[i]! += f.spd[i]! * dt;
    if (f.u[i]! > 1.08) {
      const last = --f.n; // swap-remove: order does not matter
      f.u[i] = f.u[last]!;
      f.lane[i] = f.lane[last]!;
      f.spd[i] = f.spd[last]!;
      f.side[i] = f.side[last]!;
      f.size[i] = f.size[last]!;
    } else i++;
  }
}

/** Move every particle, retire the ones that reached "now", and give birth to new ones at the old edge. */
export function stepFlow(f: Flow, dt: number, rate: number, speed: number, buyShare: number, rnd: () => number): void {
  if (!(dt > 0)) return;
  advance(f, dt);
  f.acc += rate * dt;
  while (f.acc >= 1) {
    f.acc -= 1;
    // Born somewhere inside this frame's travel, so births never pile up on one pixel column.
    spawn(f, rnd() * speed * dt, speed, buyShare, rnd);
  }
  if (f.n >= MAX_PARTICLES) f.acc = Math.min(f.acc, 1);
}

/** Fill a freshly visible tile as if it had been streaming all along, so it never starts empty. */
export function prewarm(f: Flow, rate: number, speed: number, buyShare: number, rnd: () => number): void {
  f.n = 0;
  f.acc = 0;
  const expected = Math.min(MAX_PARTICLES, Math.round(rate / Math.max(0.05, speed)));
  for (let i = 0; i < expected; i++) spawn(f, rnd() * 1.05, speed, buyShare, rnd);
}

// ----------------------------------------------------------------------------------------------------------------------------
// one dot per REAL trade. The stream brings each trade of a coin the trade feed watches (side, dollars, its own time). A coin
// that has had one is drawn from its real trades only: a dot when a trade is heard, riding the ribbon to "now", its opacity the trade's size.
// A coin with no real trade keeps the COUNTED ribbon (DexScreener's buy and sell counts, spawned at random), drawn fainter and labelled.
// ----------------------------------------------------------------------------------------------------------------------------

/** A coin that has had a real trade in this long is drawn from real trades only; after it, back to the counted ribbon. */
export const REAL_FOR_MS = 30 * 60_000;
/** How much fainter a counted ribbon is drawn (a fraction of the opacity step), so a real trade is never mistaken for a count. */
export const COUNTED_DIM = 0.45;
/** How fast a real trade's dot crosses the ribbon (ribbon-lengths a second): about three seconds from heard to "now". */
export const REAL_SPEED = 0.33;
/** Heard trades kept on a coin, and for how long: enough for every drawer to see each one once. */
export const KEEP_TRADES = 40;
export const KEEP_TRADES_MS = 15_000;
/** Prices of the latest real trades kept for a lite line. */
export const KEEP_PRICES = 120;

export interface HeardTrade {
  /** when the page heard it (ms) */
  t: number;
  side: 0 | 1;
  /** 0..1, from the dollars */
  size: number;
}
export interface RealTraded {
  hasFlow: boolean;
  /** the coin's address, when it has one: the real-trade state is then looked up by it (a coin's trades are kept whether or not its row exists yet) */
  address?: string | null;
  /** the prices of the latest real trades (dollars, oldest first): a coin with no price series draws its lite line from these */
  prices?: { t: number; p: number }[];
  /** when the coin's latest real trade happened (ms, its own time), from the stream */
  lastRealMs?: number;
  /** when the page last heard a real trade for it (ms) */
  realHeardMs?: number;
  realTrades?: HeardTrade[];
}
export type RibbonMode = "real" | "counted" | "none";

/**
 * Real-trade state by address (item 57). A trade for a coin the page does not hold yet (a launch's first burst), or whose row was replaced, is kept
 * all the same, and the row finds it when it exists. Capped, oldest first out.
 */
const REG = new Map<string, RealTraded>();
export const REG_MAX = 3000;
/** The real-trade state of a coin by its address (any case), or undefined when none was heard. */
export function realOf(address: string | null | undefined): RealTraded | undefined {
  return address ? REG.get(address.toLowerCase()) : undefined;
}
/** A real trade heard from the stream for a coin, by its address. */
export function hearTrade(address: string, side: "buy" | "sell", usd: number, priceUsd: number, atMs: number, heardMs: number): void {
  const key = address.toLowerCase();
  let st = REG.get(key);
  if (!st) {
    st = { hasFlow: false };
    REG.set(key, st);
    if (REG.size > REG_MAX) {
      const oldest = [...REG.entries()].sort((a, b) => (a[1].realHeardMs ?? 0) - (b[1].realHeardMs ?? 0)).slice(0, REG.size - REG_MAX + 200);
      for (const [k] of oldest) if (k !== key) REG.delete(k);
    }
  }
  noteRealTrade(st, side, usd, atMs, heardMs, priceUsd);
}
/** Forget every heard trade (tests). */
export function clearRealTrades(): void {
  REG.clear();
}

/** Real while the coin has had a real trade lately, else the counted ribbon where DexScreener's counts exist, else nothing (no invented motion). */
export function ribbonMode(it: RealTraded, nowMs: number): RibbonMode {
  const st = realOf(it.address) ?? it;
  if (st.realHeardMs !== undefined && nowMs - st.realHeardMs < REAL_FOR_MS) return "real";
  return it.hasFlow ? "counted" : "none";
}

/** A lite line from a coin's real trades (their prices, oldest first), for a coin with no price series; empty with fewer than two. */
export function lineFromTrades(st: RealTraded | undefined): number[] {
  const p = st?.prices ?? [];
  return p.length >= 2 ? p.map((x) => x.p) : [];
}

/** A trade's weight as opacity: $1 about 0.1, $10 about 0.33, $100 about 0.67, $1,000 and over solid. */
export function sizeOfTrade(usd: number): number {
  return Number.isFinite(usd) && usd > 0 ? Math.min(1, Math.log10(1 + usd) / 3) : 0.05;
}

/** A real trade heard for a coin: kept for the drawers (each takes it once) and the time of the latest remembered for the label. */
export function noteRealTrade(it: RealTraded, side: "buy" | "sell", usd: number, atMs: number, heardMs: number, priceUsd?: number): void {
  const list = it.realTrades ?? (it.realTrades = []);
  list.push({ t: heardMs, side: side === "buy" ? 1 : 0, size: sizeOfTrade(usd) });
  while (list.length > KEEP_TRADES || (list.length && heardMs - list[0]!.t > KEEP_TRADES_MS)) list.shift();
  if (Number.isFinite(atMs) && atMs > 0 && (it.lastRealMs === undefined || atMs > it.lastRealMs)) it.lastRealMs = atMs;
  it.realHeardMs = heardMs;
  if (priceUsd !== undefined && priceUsd > 0 && Number.isFinite(priceUsd)) {
    const ps = it.prices ?? (it.prices = []);
    ps.push({ t: Number.isFinite(atMs) && atMs > 0 ? atMs : heardMs, p: priceUsd });
    if (ps.length > KEEP_PRICES) ps.splice(0, ps.length - KEEP_PRICES);
  }
}

/**
 * One frame of a real-trade ribbon: the dots ride on, and each trade heard since `cursor` becomes one dot at the old edge (a burst is spaced
 * along the ribbon so the dots do not pile up). Returns the new cursor. Nothing is born at random.
 */
export function stepReal(f: Flow, dt: number, trades: readonly HeardTrade[] | undefined, cursor: number, rnd: () => number): number {
  if (dt > 0) advance(f, dt);
  let next = cursor;
  let k = 0;
  for (const tr of trades ?? []) {
    if (tr.t <= cursor) continue;
    if (f.n < MAX_PARTICLES) {
      const i = f.n++;
      f.u[i] = Math.min(k++, 10) * 0.02 + rnd() * REAL_SPEED * Math.max(dt, 0.016); // a burst is spaced along the ribbon, not stacked on one point
      f.lane[i] = Math.floor(rnd() * 3) / 2 + (rnd() - 0.5) * 0.12;
      f.spd[i] = REAL_SPEED * (0.9 + 0.2 * rnd());
      f.side[i] = tr.side;
      f.size[i] = tr.size;
    }
    if (tr.t > next) next = tr.t;
  }
  return next;
}

/** "last trade 12 s ago": the time of the latest real trade, in the plainest words; empty when none has been heard. */
export function lastTradeText(lastRealMs: number | undefined, nowMs: number): string {
  if (lastRealMs === undefined || !Number.isFinite(lastRealMs)) return "";
  const s = Math.max(0, Math.round((nowMs - lastRealMs) / 1000));
  if (s < 5) return "last trade just now";
  if (s < 60) return `last trade ${Math.round(s / 5) * 5} s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `last trade ${m} min ago`;
  const h = Math.floor(m / 60);
  return h < 24 ? `last trade ${h} h ago` : `last trade ${Math.floor(h / 24)} d ago`;
}
