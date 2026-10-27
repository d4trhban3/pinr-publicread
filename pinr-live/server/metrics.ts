import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DROP_DIR } from "./feed.ts";

/**
 * PINRmetric: the engine's own finished series for one token (a score line, a signal line and a histogram, like an RSI and a MACD in one pane).
 * One file per token in `frontend-feed/metrics/<address>.json`. The engine calculates everything; this only reads, cleans and passes it on.
 * Nothing here carries inputs, weights or steps. Missing stays missing: no file means no pane, a gap is never filled with zeros.
 */
export type Point = [number, number];

export interface Metric {
  name: "PINRmetric";
  /** the candle size the engine calculated it on, e.g. "1h" ("" when not said) */
  timeframe: string;
  /** when the engine last calculated it (ISO text), "" when not said */
  asOf: string;
  /** the main line, 0 to 100 (the token's score over time) */
  series: Point[];
  /** the smoothed companion line, same scale (optional) */
  signal: Point[];
  /** the gap between the two, signed (optional) */
  histogram: Point[];
  /** horizontal guide levels, e.g. [30, 70] (optional) */
  levels: number[];
}

const MAX_POINTS = 1500;
const MAX_LEVELS = 4;
const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/** [[time_in_seconds, value], ...] to clean points: bad rows are dropped one by one, order is by time, a repeated time keeps the last. */
function cleanPoints(raw: unknown, lo: number, hi: number): Point[] {
  if (!Array.isArray(raw)) return [];
  const byTime = new Map<number, number>();
  for (const p of raw) {
    if (!Array.isArray(p) || p.length < 2 || !finite(p[0]) || !finite(p[1])) continue;
    if (p[0] <= 0 || p[1] < lo || p[1] > hi) continue;
    byTime.set(Math.floor(p[0]), p[1]);
  }
  return [...byTime.entries()].sort((a, b) => a[0] - b[0]).slice(-MAX_POINTS);
}

/** The cleaned metric, or null when the content is not a usable PINRmetric file (the main line is required). */
export function cleanMetric(raw: unknown): Metric | null {
  if (typeof raw !== "object" || raw === null) return null;
  const doc = raw as Record<string, unknown>;
  if (typeof doc.contract !== "string" || !doc.contract.startsWith("1.")) return null;
  const series = cleanPoints(doc.series, 0, 100);
  if (series.length < 2) return null;
  const levels = Array.isArray(doc.levels) ? doc.levels.filter((v): v is number => finite(v) && v >= 0 && v <= 100).slice(0, MAX_LEVELS) : [];
  return {
    name: "PINRmetric",
    timeframe: typeof doc.timeframe === "string" ? doc.timeframe.replace(/[^0-9a-z]/gi, "").slice(0, 6) : "",
    asOf: typeof doc.as_of === "string" ? doc.as_of.replace(/[^0-9TZ:.+\-]/g, "").slice(0, 32) : "",
    series,
    signal: cleanPoints(doc.signal, 0, 100),
    histogram: cleanPoints(doc.histogram, -100, 100),
    levels,
  };
}

/** The metrics folder. PINR_METRICS_DIR points it somewhere else (used only to test the screens with sample files). */
const METRICS_DIR = process.env.PINR_METRICS_DIR || join(DROP_DIR, "metrics");

/** The metric for one token, or null when it has no file. */
export function readMetric(address: string, dir = METRICS_DIR): Metric | null {
  if (!/^[0-9a-zA-Z]{20,64}$/.test(address)) return null;
  const file = join(dir, `${address}.json`);
  if (!existsSync(file)) return null;
  try {
    return cleanMetric(JSON.parse(readFileSync(file, "utf8")));
  } catch {
    return null;
  }
}
