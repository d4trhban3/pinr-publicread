import type { Candle } from "../../server/market";

/**
 * Number and time formatting for the DeepScan page. Small prices are shown the way traders read them:
 * enough digits that the price means something (0.00000359, not 0.00), a normal two decimals once it is above a dollar.
 */
export function formatPrice(p: number): string {
  if (!Number.isFinite(p) || p <= 0) return "—";
  if (p >= 1000) return `$${p.toLocaleString("en-US", { maximumFractionDigits: 2, minimumFractionDigits: 2 })}`;
  // Three significant digits below a dollar: 0.00000359, 0.0345, 0.50.
  const decimals = Math.min(14, Math.max(2, 2 - Math.floor(Math.log10(p))));
  return `$${p.toFixed(p >= 1 ? 2 : decimals)}`;
}

const SUB = ["₀", "₁", "₂", "₃", "₄", "₅", "₆", "₇", "₈", "₉"];
/**
 * A short price for tight spaces. Very small prices use the trader's shorthand: the count of zeros after the point as a small
 * subscript, then three digits: 0.0000000922 -> $0.0₇922. Anything else is as formatPrice.
 */
export function formatPriceCompact(p: number): string {
  if (!Number.isFinite(p) || p <= 0) return "—";
  if (p >= 0.0001) return formatPrice(p);
  const zeros = -Math.floor(Math.log10(p)) - 1; // zeros right after the decimal point
  const digits = Math.round(p * Math.pow(10, zeros + 3)).toString().padStart(3, "0").slice(0, 3);
  const sub = String(zeros)
    .split("")
    .map((d) => SUB[Number(d)])
    .join("");
  return `$0.0${sub}${digits}`;
}

/** A change in price: "+$0.00000012", "−$1.20". */
export function formatPriceChange(d: number): string {
  if (!Number.isFinite(d)) return "—";
  const a = formatPrice(Math.abs(d));
  return `${d < 0 ? "−" : "+"}${a === "—" ? "$0.00" : a}`;
}

export type RangeId = "1D" | "1W" | "1M" | "3M" | "ALL";
export const RANGES: RangeId[] = ["1D", "1W", "1M", "3M", "ALL"];
export const RANGE_LABEL: Record<RangeId, string> = { "1D": "Past day", "1W": "Past week", "1M": "Past month", "3M": "Past 3 months", ALL: "Since launch" };

/** The numbers a range of candles gives: first open, last close, high, low, volume. Null when there is nothing to say. */
export function summarize(candles: readonly Candle[]): { open: number; close: number; high: number; low: number; volume: number } | null {
  if (candles.length < 1) return null;
  let high = -Infinity;
  let low = Infinity;
  let volume = 0;
  for (const c of candles) {
    high = Math.max(high, c[2]);
    low = Math.min(low, c[3]);
    volume += c[5];
  }
  return { open: candles[0]![1], close: candles[candles.length - 1]![4], high, low, volume };
}

/** "as of 14:32": when a figure that is not current was last read. */
export function formatAsOf(ms: number): string {
  return `as of ${new Date(ms).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })}`;
}

/** Time under the cursor while scrubbing: with the time of day for short ranges, the date alone for long ones. */
export function formatCandleTime(tSec: number, range: RangeId): string {
  const d = new Date(tSec * 1000);
  const date = d.toLocaleDateString("en-US", { month: "short", day: "numeric", ...(range === "ALL" || range === "3M" ? { year: "numeric" } : {}) });
  if (range === "1D" || range === "1W" || range === "1M") return `${date}, ${d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })}`;
  return date;
}

/** Evenly spaced candles from a plain (normalised) series: used only for the made-up tokens, so the page still works in the simulation. */
export function candlesFromSeries(series: readonly number[], endSec: number, spanSec: number): Candle[] {
  const n = series.length;
  return series.map((v, i) => {
    const t = endSec - spanSec + (spanSec * i) / Math.max(1, n - 1);
    const o = i > 0 ? series[i - 1]! : v;
    return [t, o, Math.max(o, v), Math.min(o, v), v, 0] as Candle;
  });
}

/**
 * How long ago a score was made, so a first score never passes for fresh: "just now", "41 min ago", "5 h ago", "2 days ago". The time is the
 * feed's own `as_of` (when the engine read the coin); null when the feed gave none (nothing is made up). `short` drops the word "scored" for tight tiles.
 */
export function scoredAgo(scoredMs: number | null | undefined, nowMs: number): string | null {
  if (scoredMs === null || scoredMs === undefined || !Number.isFinite(scoredMs) || scoredMs <= 0) return null;
  const min = Math.max(0, Math.floor((nowMs - scoredMs) / 60_000));
  if (min < 1) return "just now";
  if (min < 60) return `${min} min ago`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h} h ago`;
  const d = Math.floor(h / 24);
  return `${d} ${d === 1 ? "day" : "days"} ago`;
}

/** The same age in the shortest form for a tile's label row: "<1m", "41m", "5h", "2d". */
export function scoredAgoShort(scoredMs: number | null | undefined, nowMs: number): string | null {
  if (scoredMs === null || scoredMs === undefined || !Number.isFinite(scoredMs) || scoredMs <= 0) return null;
  const min = Math.max(0, Math.floor((nowMs - scoredMs) / 60_000));
  if (min < 1) return "<1m";
  if (min < 60) return `${min}m`;
  const h = Math.floor(min / 60);
  return h < 24 ? `${h}h` : `${Math.floor(h / 24)}d`;
}

const RANGE_SECONDS: Record<RangeId, number> = { "1D": 86400, "1W": 7 * 86400, "1M": 30 * 86400, "3M": 90 * 86400, ALL: Infinity };
/**
 * What a price change is a change OVER. A coin younger than the window says "Since launch (49 min)", never "Past day": a change over 49
 * minutes must not read as a measurement of a day. `ageMin` is the coin's age; NaN (unknown) keeps the plain range label.
 */
export function changeWindowLabel(range: RangeId, ageMin: number): string {
  if (Number.isFinite(ageMin) && ageMin >= 0 && ageMin * 60 < RANGE_SECONDS[range]) {
    const t = ageMin < 90 ? `${Math.max(1, Math.round(ageMin))} min` : ageMin < 48 * 60 ? `${Math.round(ageMin / 60)} h` : `${Math.round(ageMin / 1440)} days`;
    return `Since launch (${t})`;
  }
  return RANGE_LABEL[range];
}
