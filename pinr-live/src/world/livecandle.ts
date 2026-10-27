/**
 * Live candles: the chart moves between reads, from what the stream brings. One price (a price tick now; one trade once the
 * engine's own trade feed for curve coins arrives, a design decision) is folded into the candle of its time: the last candle's high, low and
 * close move, or a new candle opens at the last close. A price tick carries no traded amount, so it adds no volume; a trade adds its own.
 * A chart is only extended, never started, from price ticks alone (a coin with no chart says so plainly); trades may start one.
 */
export type Candle = [number, number, number, number, number, number]; // [time s, open, high, low, close, volume USD]

export function foldPrice(candles: Candle[], tfSec: number, price: number, atMs: number, opts: { usd?: number; start?: boolean } = {}): boolean {
  if (!(price > 0) || !Number.isFinite(price) || !(tfSec > 0) || !Number.isFinite(atMs)) return false;
  const usd = opts.usd !== undefined && opts.usd > 0 && Number.isFinite(opts.usd) ? opts.usd : 0;
  const t = Math.floor(atMs / 1000 / tfSec) * tfSec;
  const last = candles[candles.length - 1];
  if (!last) {
    if (!opts.start) return false;
    candles.push([t, price, price, price, price, usd]);
    return true;
  }
  if (t < last[0]) return false; // older than the newest candle: the next read carries it
  if (t === last[0]) {
    last[2] = Math.max(last[2], price);
    last[3] = Math.min(last[3], price);
    last[4] = price;
    last[5] += usd;
    return true;
  }
  const open = last[4];
  candles.push([t, open, Math.max(open, price), Math.min(open, price), price, usd]);
  return true;
}

/** A tracked line with the live price as its newest point: only on a line that already has two points, and only when the price moved. */
export function withLiveHead(series: number[], price: number): number[] {
  if (series.length < 2 || !(price > 0) || !Number.isFinite(price) || series[series.length - 1] === price) return series;
  return [...series, price];
}
