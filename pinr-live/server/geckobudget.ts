/**
 * GeckoTerminal's keyless allowance (10 calls a minute) is shared by the pool reader, the background market reader and the chart reads.
 * Every reader records its calls here; a chart read (someone is waiting, but the pool matters more) is only allowed while the last
 * minute holds fewer than CHART_CEILING calls, which keeps room for the pool's calls. The pool and the background reader are never held back by it.
 */
export const WINDOW_MS = 60_000;
export const CHART_CEILING = 7;
/** The pool reader and the background market reader make a call only while the last minute holds fewer than this many, so the
 *  keyless allowance of ten always keeps room for the charts: 10 less this ceiling, and the chart ceiling above it. */
export const BACKGROUND_CEILING = 4;

/** What a call was for, so the health page can say where the allowance goes. */
export type GeckoKind = "market" | "chart" | "ahead" | "pools";
const KINDS: readonly GeckoKind[] = ["market", "chart", "ahead", "pools"];

export class GeckoBudget {
  private at: number[] = [];
  private since: number;
  private made: Record<GeckoKind, number> = { market: 0, chart: 0, ahead: 0, pools: 0 };
  private no: Record<GeckoKind, number> = { market: 0, chart: 0, ahead: 0, pools: 0 };
  constructor(private now: () => number = Date.now) {
    this.since = now();
  }

  record(kind: GeckoKind = "market"): void {
    this.at.push(this.now());
    this.made[kind]++;
    this.trim();
  }

  /** A call of this kind was refused ("too many requests"). */
  refused(kind: GeckoKind): void {
    this.no[kind]++;
  }

  /** Calls and refusals by kind since the server started, and calls in the last minute. */
  stats(): { lastMinute: number; sinceMin: number; calls: Record<GeckoKind, number>; refused: Record<GeckoKind, number> } {
    const sinceMin = Math.max(0, Math.round((this.now() - this.since) / 60_000));
    return { lastMinute: this.count(), sinceMin, calls: Object.fromEntries(KINDS.map((k) => [k, this.made[k]])) as Record<GeckoKind, number>, refused: Object.fromEntries(KINDS.map((k) => [k, this.no[k]])) as Record<GeckoKind, number> };
  }

  /** Calls made in the last minute. */
  count(): number {
    this.trim();
    return this.at.length;
  }

  /** May a background reader (the pool reader, the market reader's own sweep) make a call now? */
  backgroundMayCall(): boolean {
    return this.count() < BACKGROUND_CEILING;
  }

  /** May a chart read go out now? */
  chartMayCall(): boolean {
    return this.count() < CHART_CEILING;
  }

  private trim(): void {
    const from = this.now() - WINDOW_MS;
    while (this.at.length && this.at[0]! < from) this.at.shift();
  }
}
