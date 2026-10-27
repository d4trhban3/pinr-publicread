import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { Candle } from "./market.ts";

/**
 * Pump.fun's own candles for the site's Pump.fun coins, read by the engine (Pump.fun answers the engine's client, not the feed
 * server's) and saved as `frontend-feed/candles/<mint>.json` (format `candles-1`, the candles format). This reads a coin's file, keeps it until the
 * file changes, and answers a chart size from it: 1m, 5m, 15m and 1h as Pump.fun gave them, 4h and 1D added up from 1h, 5m and 15m from 1m when absent. Missing stays missing:
 * a size the file does not hold, or one with fewer than two candles, is no answer, and the next source is asked.
 */
export const CONTRACT = "candles-1";
/** A size read longer ago than this is still shown, but as stale with its read time: three of the engine's waits for it (1m every 2 min, 5m every 5,
 *  15m every 15, 1h every 60; the candles format), and never less than half an hour, since only a handful of coins fit Pump.fun's budget at 1m. */
export const STALE_AFTER_MS = 30 * 60_000;
const STALE_MS: Record<"1m" | "5m" | "15m" | "1h", number> = { "1m": STALE_AFTER_MS, "5m": STALE_AFTER_MS, "15m": 45 * 60_000, "1h": 3 * 60 * 60_000 };
const MAX = 1000;
const MINT = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const GIVEN = { "1m": 60, "5m": 300, "15m": 900, "1h": 3600 } as const;
type Given = keyof typeof GIVEN;
export type CandleSize = Given | "4h" | "1D";
const SIZE_SEC: Record<CandleSize, number> = { ...GIVEN, "4h": 14_400, "1D": 86_400 };

interface Parsed {
  readAtMs: number;
  /** each size's own read time, where the file gives it (`read: {interval: ISO}`); else the file's `read_at` */
  readOf: Partial<Record<"1m" | "5m" | "15m" | "1h", number>>;
  link: string | null;
  sizes: Partial<Record<Given, Candle[]>>;
}

/** One interval's rows into candles (seconds), oldest first, empty buckets filled flat at the last close with no volume (as Pump.fun's own chart). */
export function rowsToCandles(rows: unknown, bucketSec: number): Candle[] {
  if (!Array.isArray(rows)) return [];
  const ok: Candle[] = [];
  for (const r of rows) {
    if (!Array.isArray(r) || r.length < 6 || !r.slice(0, 6).every((n) => typeof n === "number" && Number.isFinite(n))) continue;
    const [tMs, o, h, l, c, v] = r as number[];
    if (tMs! <= 0 || o! <= 0 || h! <= 0 || l! <= 0 || c! <= 0 || h! < l! || v! < 0) continue;
    ok.push([Math.floor(tMs! / 1000), o!, h!, l!, c!, v!]);
  }
  ok.sort((a, b) => a[0] - b[0]);
  const out: Candle[] = [];
  for (const r of ok) {
    const prev = out[out.length - 1];
    if (prev && r[0] === prev[0]) continue;
    if (prev) for (let t = prev[0] + bucketSec; t < r[0] && out.length < MAX * 4; t += bucketSec) out.push([t, prev[4], prev[4], prev[4], prev[4], 0]);
    out.push(r);
  }
  return out.slice(-MAX);
}

/** Bigger candles from smaller ones: open of the first, highest high, lowest low, close of the last, volumes added. */
export function addUp(cs: readonly Candle[], bucketSec: number): Candle[] {
  const out: Candle[] = [];
  for (const c of cs) {
    const start = Math.floor(c[0] / bucketSec) * bucketSec;
    const last = out[out.length - 1];
    if (last && last[0] === start) (last[2] = Math.max(last[2], c[2])), (last[3] = Math.min(last[3], c[3])), (last[4] = c[4]), (last[5] += c[5]);
    else out.push([start, c[1], c[2], c[3], c[4], c[5]]);
  }
  return out;
}

/** A `candles-1` file's content, checked; null when it is not one, or is not this coin's. */
export function parseCandleFile(body: unknown, mint: string): Parsed | null {
  if (typeof body !== "object" || body === null) return null;
  const b = body as Record<string, unknown>;
  if (b.contract !== CONTRACT || b.mint !== mint || b.currency !== "USD") return null;
  const readAtMs = typeof b.read_at === "string" ? Date.parse(b.read_at) : typeof b.read_at === "number" ? b.read_at : NaN;
  if (!Number.isFinite(readAtMs)) return null;
  const iv = typeof b.intervals === "object" && b.intervals !== null ? (b.intervals as Record<string, unknown>) : {};
  const sizes: Parsed["sizes"] = {};
  for (const k of Object.keys(GIVEN) as Given[]) if (k in iv) sizes[k] = rowsToCandles(iv[k], GIVEN[k]);
  const link = typeof b.link === "string" && b.link.startsWith("https://pump.fun/") ? b.link : null;
  const readOf: Parsed["readOf"] = {};
  const rd = typeof b.read === "object" && b.read !== null ? (b.read as Record<string, unknown>) : {};
  for (const k of Object.keys(GIVEN) as Given[]) {
    const v = typeof rd[k] === "string" ? Date.parse(rd[k] as string) : NaN;
    if (Number.isFinite(v)) readOf[k] = v;
  }
  return { readAtMs, readOf, link, sizes };
}

export class CandleFiles {
  private held = new Map<string, { mtimeMs: number; parsed: Parsed | null }>();
  stat = { reads: 0, served: 0 };
  constructor(
    private dir: string,
    private now: () => number = Date.now,
  ) {}

  private read(mint: string): Parsed | null {
    if (!MINT.test(mint)) return null;
    const file = join(this.dir, `${mint}.json`);
    let mtimeMs: number;
    try {
      mtimeMs = statSync(file).mtimeMs;
    } catch {
      this.held.delete(mint);
      return null; // never read: no file
    }
    const h = this.held.get(mint);
    if (h && h.mtimeMs === mtimeMs) return h.parsed;
    let parsed: Parsed | null = null;
    try {
      this.stat.reads++;
      parsed = parseCandleFile(JSON.parse(readFileSync(file, "utf8")), mint);
    } catch {
      parsed = null; // half-written or damaged: no answer this time
    }
    this.held.set(mint, { mtimeMs, parsed });
    if (this.held.size > 2000) for (const k of [...this.held.keys()].slice(0, 500)) this.held.delete(k);
    return parsed;
  }

  /** Candles at one size, `limit` newest at most, with status ok (or stale, with its read time, when the file is old); null when the file cannot answer it. */
  candles(mint: string, size: CandleSize, limit: number): { candles: Candle[]; bucketSec: number; status: "ok" | "stale"; asOfMs?: number } | null {
    const p = this.read(mint);
    if (!p) return null;
    // 4h and 1D are added up from 1h; 5m and 15m from 1m when the file has no read of their own.
    let from: Given;
    let cs: Candle[] | null;
    if (size === "4h" || size === "1D") (from = "1h"), (cs = p.sizes["1h"] ? addUp(p.sizes["1h"], SIZE_SEC[size]) : null);
    else if ((size === "5m" || size === "15m") && !p.sizes[size]) (from = "1m"), (cs = p.sizes["1m"] ? addUp(p.sizes["1m"], SIZE_SEC[size]) : null);
    else (from = size), (cs = p.sizes[size] ?? null);
    if (!cs || cs.length < 2) return null;
    this.stat.served++;
    const readAt = p.readOf[from] ?? p.readAtMs;
    const old = this.now() - readAt > STALE_MS[from];
    return { candles: cs.slice(-limit), bucketSec: SIZE_SEC[size], status: old ? "stale" : "ok", ...(old ? { asOfMs: readAt } : {}) };
  }

  /** The chart ranges from the file: 1D in 15-minute candles, 1W in 1-hour, 1M in 4-hour, 3M in days, the whole life at the finest size that fits in about 300. */
  range(mint: string, range: string): ReturnType<CandleFiles["candles"]> {
    const plan: Record<string, [CandleSize, number]> = { "1D": ["15m", 96], "1W": ["1h", 168], "1M": ["4h", 180], "3M": ["1D", 90] };
    if (plan[range]) {
      // A coin too young for two candles at the range's size is drawn at the finest size that gives two (its own first minutes), as Pump.fun's page does.
      const [size, limit] = plan[range]!;
      const order: CandleSize[] = ["1D", "4h", "1h", "15m", "5m", "1m"];
      for (const s of order.slice(order.indexOf(size))) {
        const r = this.candles(mint, s, s === size ? limit : MAX);
        if (r) return r;
      }
      return null;
    }
    if (range !== "ALL") return null;
    for (const s of ["1m", "5m", "15m", "1h", "4h", "1D"] as CandleSize[]) {
      const r = this.candles(mint, s, MAX);
      if (r && r.candles.length <= 300) return r;
    }
    return this.candles(mint, "1D", MAX);
  }
}
