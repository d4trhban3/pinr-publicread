import type { Candle } from "./market.ts";

/**
 * A Pump.fun or PumpSwap coin's full candle history, from Pump.fun's own free endpoint (`swap-api.pump.fun/v2/coins/<mint>/candles`), the same
 * one its own chart reads (the operator: "why is pumpfun running better charts than our lite chart"). It answers in dollars with a volume, from the
 * coin's first trade. Its CORS allows only pump.fun, so a visitor's browser is refused (checked 2026-10-22: 403 "Origin not allowed"); this thin
 * pass-through runs on the server instead, with a short cache and one request at a time so the server's one home address stays polite. `createdTs` must
 * be an integer, but its value does not change the answer; the coin's launch time is sent when known.
 * Missing buckets (no trade in that time) are filled with a flat candle of the last close and no volume, as Pump.fun's own chart draws them.
 */
const BASE = "https://swap-api.pump.fun/v2/coins/";
export const USER_AGENT = "PINR-live/1.0 (read-only market data)";
export type PumpInterval = "15s" | "30s" | "1m" | "5m" | "15m" | "30m" | "1h" | "4h" | "6h" | "12h";
export const SECONDS: Record<PumpInterval, number> = { "15s": 15, "30s": 30, "1m": 60, "5m": 300, "15m": 900, "30m": 1800, "1h": 3600, "4h": 14400, "6h": 21600, "12h": 43200 };
/** How long an answer is kept, by size: a minute chart moves, a daily one hardly does. */
export const TTL_MS: Record<PumpInterval, number> = { "15s": 8000, "30s": 10_000, "1m": 15_000, "5m": 30_000, "15m": 60_000, "30m": 90_000, "1h": 3 * 60_000, "4h": 10 * 60_000, "6h": 15 * 60_000, "12h": 20 * 60_000 };
export const GAP_MS = 1000;
export const REST_MS = 60_000;
/** Pump.fun answers every non-browser client with Cloudflare's bot challenge (403, `cf-mitigated: challenge`, seen 2026-10-23): it is not asked again for this long. Never worked around. */
export const CHALLENGE_REST_MS = 10 * 60_000;
export const MAX_WAIT_MS = 8000;
export const MAX_CANDLES = 1200;
const MINT = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export type PumpGet = (url: string) => Promise<{ status: number; json(): Promise<unknown> }>;
const defaultGet: PumpGet = (url) => fetch(url, { headers: { accept: "application/json", "user-agent": USER_AGENT }, signal: AbortSignal.timeout(12_000) });

const num = (v: unknown): number | null => {
  const n = typeof v === "string" ? Number(v) : v;
  return typeof n === "number" && Number.isFinite(n) ? n : null;
};

/** Pump.fun's rows (oldest first, prices and volume as strings) into clean candles [time s, o, h, l, c, volume USD]; a bad row is dropped, and gaps are filled flat. */
export function cleanCandles(body: unknown, bucketSec: number): Candle[] {
  if (!Array.isArray(body)) return [];
  const rows: Candle[] = [];
  for (const r of body) {
    if (typeof r !== "object" || r === null) continue;
    const x = r as Record<string, unknown>;
    const t = num(x.timestamp);
    const o = num(x.open), h = num(x.high), l = num(x.low), c = num(x.close), v = num(x.volume);
    if (t === null || t <= 0 || o === null || h === null || l === null || c === null || o <= 0 || h <= 0 || l <= 0 || c <= 0 || h < l) continue;
    rows.push([Math.floor(t / 1000), o, h, l, c, v !== null && v >= 0 ? v : 0]);
  }
  rows.sort((a, b) => a[0] - b[0]);
  const out: Candle[] = [];
  for (const r of rows) {
    const prev = out[out.length - 1];
    if (prev && r[0] === prev[0]) continue;
    if (prev) {
      for (let t = prev[0] + bucketSec; t < r[0] && out.length < MAX_CANDLES * 4; t += bucketSec) out.push([t, prev[4], prev[4], prev[4], prev[4], 0]);
    }
    out.push(r);
  }
  return out.slice(-MAX_CANDLES);
}

export class PumpCandles {
  private cache = new Map<string, { at: number; candles: Candle[] }>();
  private pausedUntil = 0;
  private lastCall = 0;
  private chain: Promise<unknown> = Promise.resolve();
  stat = { calls: 0, errors: 0, hits: 0 };

  constructor(
    private get: PumpGet = defaultGet,
    private now: () => number = Date.now,
  ) {}

  /** Candles for a coin at one size, `limit` newest at most; null when Pump.fun has none, refuses, or the line for the server's turn is too long. */
  async candles(mint: string, interval: PumpInterval, limit: number, createdMs?: number | null): Promise<Candle[] | null> {
    if (!MINT.test(mint) || !(interval in SECONDS)) return null;
    const key = `${mint}|${interval}`;
    const held = this.cache.get(key);
    if (held && this.now() - held.at < TTL_MS[interval]) {
      this.stat.hits++;
      return held.candles.length ? held.candles.slice(-limit) : null;
    }
    if (this.now() < this.pausedUntil) return held && held.candles.length ? held.candles.slice(-limit) : null;
    const waited = this.now();
    const turn = this.chain.then(async () => {
      if (this.now() - waited > MAX_WAIT_MS) return undefined; // too long in line: the caller's other sources answer
      const again = this.cache.get(key);
      if (again && this.now() - again.at < TTL_MS[interval]) return again.candles;
      if (this.now() < this.pausedUntil) return undefined;
      const wait = this.lastCall + GAP_MS - this.now();
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      this.lastCall = this.now();
      this.stat.calls++;
      const created = createdMs && createdMs > 0 ? Math.floor(createdMs) : 1;
      try {
        const res = await this.get(`${BASE}${mint}/candles?interval=${interval}&limit=1000&currency=USD&createdTs=${created}`);
        if (res.status === 429 || res.status === 403 || res.status >= 500) {
          this.stat.errors++;
          this.pausedUntil = this.now() + (res.status === 403 ? CHALLENGE_REST_MS : REST_MS);
          return undefined;
        }
        if (res.status !== 200) return [];
        const cs = cleanCandles(await res.json(), SECONDS[interval]);
        this.cache.set(key, { at: this.now(), candles: cs });
        if (this.cache.size > 400) for (const k of [...this.cache.keys()].slice(0, 100)) this.cache.delete(k);
        return cs;
      } catch {
        this.stat.errors++;
        this.pausedUntil = this.now() + 15_000;
        return undefined;
      }
    });
    this.chain = turn.catch(() => undefined);
    const got = (await turn.catch(() => undefined)) as Candle[] | undefined;
    const use = got ?? (held ? held.candles : undefined);
    return use && use.length ? use.slice(-limit) : null;
  }
}

/** The size and number of candles Pump.fun's chart gives for each of the page's ranges (the coin's whole life for ALL, at the finest size that fits). */
export const RANGE_PLAN: Record<string, { interval: PumpInterval; limit: number }> = {
  "1D": { interval: "15m", limit: 96 },
  "1W": { interval: "1h", limit: 168 },
  "1M": { interval: "4h", limit: 180 },
  "3M": { interval: "12h", limit: 180 },
};
/** The size for the whole life: the finest that keeps it to about 300 candles. */
export function allInterval(ageSec: number): PumpInterval {
  for (const i of ["1m", "5m", "15m", "30m", "1h", "4h", "6h", "12h"] as const) if (ageSec / SECONDS[i] <= 300) return i;
  return "12h";
}
export const isPumpLaunchpad = (launchpad: string | null | undefined): boolean => /pump\.?fun|pumpswap/i.test(launchpad ?? "");

/** The sizes to try, finest last, when a young coin has fewer than two candles at the size the range asks for (as Pump.fun's own chart shows a new coin). */
export function finerSizes(from: PumpInterval): PumpInterval[] {
  const order: PumpInterval[] = ["12h", "6h", "4h", "1h", "30m", "15m", "5m", "1m", "30s", "15s"];
  return order.slice(order.indexOf(from));
}
