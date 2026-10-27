import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/**
 * every wire on /control shows its true state, measured where the data crosses in the code, never
 * drawn by hand. A wire is LIVE while data crossed it in the last LIVE_MS (with items a minute, the last item's time and the last item as a
 * sample), quiet when nothing crossed since, and NOT LIVE with the error when its source refused last. The feed server measures its own
 * wires here (into and out of /api/tokens, /api/evidence, /api/chart, /api/img, the trade stream and the site's pages); the engine's control
 * service measures the engine's. A wire is named "<from node>><to node>:<to pin>", the ids of the map in public/control/blueprint.js.
 */
export const LIVE_MS = 5 * 60_000;
const BUCKET_MS = 60_000;
const KEEP_BUCKETS = 10;

export type WireState = "live" | "quiet" | "error";
export interface WireReading {
  state: WireState;
  /** items in the last minute, and in the last ten */
  perMin: number;
  last10: number;
  lastMs: number | null;
  /** the last item, as text (a coin address, a trade, a picture link) */
  sample: string | null;
  error: string | null;
  errorMs: number | null;
  /** why a quiet wire is quiet, when the meter knows: a visitor-driven wire after a restart waits for a visitor (DEBUG M1) */
  reason?: string;
}
interface Wire {
  buckets: Map<number, number>;
  lastMs: number | null;
  sample: string | null;
  error: string | null;
  errorMs: number | null;
}

/**
 * A wire is driven by visitors' requests when it goes into the site's pages or the apps (">w_"), or into an endpoint that answers only when asked: the evidence
 * (p_evid), the charts (p_chart) and the pictures (p_img). With no visitor it is quiet, and that is not a fault (DEBUG M1, then 26 Oct: e_store>p_evid and a_trades>p_chart).
 */
export const isVisitorWire = (key: string): boolean => key.includes(">w_") || /^[^>]*>(p_evid|p_chart|p_img):/.test(key);

export class WireMeter {
  private wires = new Map<string, Wire>();
  private totals = new Map<string, number>();
  readonly startedMs: number;
  /** The last time anything crossed each wire, kept across a restart (a file), so a restart does not read as "never". */
  private lastSeen = new Map<string, number>();
  private dirtySeen = false;
  constructor(
    private now: () => number = Date.now,
    private persistPath: string | null = null,
  ) {
    this.startedMs = now();
    if (persistPath) {
      try {
        const j = JSON.parse(readFileSync(persistPath, "utf8")) as Record<string, unknown>;
        for (const [k, v] of Object.entries(j)) if (typeof v === "number" && Number.isFinite(v)) this.lastSeen.set(k, v);
      } catch {
        /* no file yet, or unreadable: the meter starts empty, as before */
      }
    }
  }

  /** Write the last-seen times, when any changed (called on a timer, never on a request). */
  save(): void {
    if (!this.persistPath || !this.dirtySeen) return;
    this.dirtySeen = false;
    try {
      mkdirSync(dirname(this.persistPath), { recursive: true });
      writeFileSync(`${this.persistPath}.tmp`, JSON.stringify(Object.fromEntries(this.lastSeen)));
      renameSync(`${this.persistPath}.tmp`, this.persistPath);
    } catch {
      /* the next save tries again */
    }
  }

  /** The wires this server measures, listed from the start, so one nothing has crossed yet shows as quiet rather than missing. */
  expect(keys: readonly string[]): void {
    for (const k of keys) this.wire(k);
  }

  /** A worker's own running count (pictures fetched, files parsed): what it grew by since the last look crosses the wire. The first look only sets the start. */
  tally(key: string, total: number, sample?: string | null): void {
    if (!Number.isFinite(total)) return;
    const was = this.totals.get(key);
    this.totals.set(key, total);
    if (was !== undefined && total > was) this.hit(key, total - was, sample);
  }

  private wire(key: string): Wire {
    let w = this.wires.get(key);
    if (!w) this.wires.set(key, (w = { buckets: new Map(), lastMs: null, sample: null, error: null, errorMs: null }));
    return w;
  }

  /** `n` items crossed the wire now; `sample` is the last of them. */
  hit(key: string, n = 1, sample?: string | null): void {
    if (n <= 0) return;
    const t = this.now();
    const w = this.wire(key);
    const b = Math.floor(t / BUCKET_MS);
    w.buckets.set(b, (w.buckets.get(b) ?? 0) + n);
    for (const k of w.buckets.keys()) if (k < b - KEEP_BUCKETS) w.buckets.delete(k);
    w.lastMs = t;
    this.lastSeen.set(key, t);
    this.dirtySeen = true;
    if (sample) w.sample = sample.slice(0, 200);
  }

  /** The wire's source refused (an HTTP error, a timeout): the wire shows red with this until data crosses again. */
  fail(key: string, error: string): void {
    const w = this.wire(key);
    w.error = error.slice(0, 160);
    w.errorMs = this.now();
  }

  reading(key: string): WireReading {
    const t = this.now();
    const w = this.wires.get(key) ?? { buckets: new Map<number, number>(), lastMs: null, sample: null, error: null, errorMs: null };
    const seenBefore = this.lastSeen.get(key) ?? null;
    const b = Math.floor(t / BUCKET_MS);
    let last10 = 0;
    for (const [k, n] of w.buckets) if (k > b - KEEP_BUCKETS) last10 += n;
    // This minute so far and half the last, so a quiet second never reads 0; never under the last ten minutes' average (DEBUG M7: "LIVE 0/min" with 131 in 10 minutes).
    const perMin = Math.max((w.buckets.get(b) ?? 0) + (w.buckets.get(b - 1) ?? 0) / 2, last10 / KEEP_BUCKETS);
    const lastMs = w.lastMs ?? seenBefore;
    const failedLast = w.errorMs !== null && (lastMs === null || w.errorMs > lastMs);
    const state: WireState = failedLast ? "error" : lastMs !== null && t - lastMs <= LIVE_MS ? "live" : "quiet";
    const waiting = state === "quiet" && w.lastMs === null && isVisitorWire(key);
    return {
      state,
      perMin: Math.round(perMin * 10) / 10,
      last10,
      lastMs,
      sample: w.sample,
      error: failedLast ? w.error : null,
      errorMs: failedLast ? w.errorMs : null,
      ...(waiting ? { reason: "waiting for a visitor: this wire is driven by visitors' requests, and none has come since the feed server started" } : {}),
    };
  }

  /** Every wire measured so far. */
  snapshot(): Record<string, WireReading> {
    return Object.fromEntries([...this.wires.keys()].sort().map((k) => [k, this.reading(k)]));
  }
}

/** Who asked: the iPhone app (the system's CFNetwork), the Android app (Dalvik), or a browser; the apps' wires are measured by this. */
export function askerOf(userAgent: string | undefined): "app" | "browser" | "other" {
  const ua = userAgent ?? "";
  if (/CFNetwork|Dalvik/i.test(ua)) return "app";
  if (/Mozilla/i.test(ua)) return "browser";
  return "other";
}
