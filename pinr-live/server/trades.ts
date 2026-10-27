
/**
 * The shape of a token's recent trades and the cleaning of a trades list. The engine no longer writes trades files and the app no longer reads them; the rows now come from Pump.fun's trade list through the tape (tape.ts).
 * Rows are [time in seconds, "buy" or "sell", size in US dollars]. Nothing else is ever in a row: no wallets, no transaction ids.
 *
 * This file reads, cleans and summarises. Bad rows are dropped one by one. No file means no trades are known (never an empty "quiet"
 * token), and nothing is made up to fill a gap: the file's own `complete` flag says whether the engine's stream had a gap.
 */
export type TradeRow = [t: number, side: "buy" | "sell", usd: number];

export interface TradesFile {
  trades: TradeRow[];
  /** the earliest time the list reaches back to, or null if the engine did not say */
  coversFrom: number | null;
  /** true only when the engine said it saw every trade in the window; absent counts as false */
  complete: boolean;
  /** when the engine wrote it (seconds), or null */
  asOf: number | null;
}

/** The buy and sell dollars over recent windows: what the ribbons and the "pressure" bars show. */
export interface FlowSummary {
  buy5m: number;
  sell5m: number;
  buy1h: number;
  sell1h: number;
  n5m: number;
  n1h: number;
  /** time of the newest trade (seconds), or null */
  lastAt: number | null;
  complete: boolean;
  asOf: number | null;
  /** "count" when the buy and sell figures are numbers of trades (DexScreener's counts), not dollars. Absent = dollars. */
  basis?: "count";
}

const MAX_ROWS = 500;
const MAX_AGE_S = 48 * 3600;
const MAX_USD = 1e9;

const toSeconds = (v: unknown): number | null => {
  if (typeof v === "number" && Number.isFinite(v) && v > 0) return v > 1e12 ? Math.floor(v / 1000) : Math.floor(v);
  if (typeof v === "string") {
    const ms = Date.parse(v);
    return Number.isFinite(ms) ? Math.floor(ms / 1000) : null;
  }
  return null;
};

/** Turn a file's content into safe trades, or null when it is not a trades file at all. */
export function cleanTrades(raw: unknown, nowSec: number): TradesFile | null {
  if (typeof raw !== "object" || raw === null) return null;
  const doc = raw as Record<string, unknown>;
  if (typeof doc.contract !== "string" || !doc.contract.startsWith("1.")) return null;
  if (!Array.isArray(doc.trades)) return null;
  const rows: TradeRow[] = [];
  for (const r of doc.trades) {
    if (!Array.isArray(r) || r.length < 3) continue;
    const [t, side, usd] = r as unknown[];
    if (typeof t !== "number" || !Number.isFinite(t) || t <= 0) continue;
    if (side !== "buy" && side !== "sell") continue;
    if (typeof usd !== "number" || !Number.isFinite(usd) || usd <= 0 || usd > MAX_USD) continue;
    if (t > nowSec + 120 || t < nowSec - MAX_AGE_S) continue; // from the future, or older than the file is allowed to carry
    rows.push([Math.floor(t), side, usd]);
  }
  rows.sort((a, b) => a[0] - b[0]);
  return {
    trades: rows.slice(-MAX_ROWS),
    coversFrom: toSeconds(doc.covers_from),
    complete: doc.complete === true,
    asOf: toSeconds(doc.as_of),
  };
}

export function summarize(file: TradesFile, nowSec: number): FlowSummary {
  const s: FlowSummary = { buy5m: 0, sell5m: 0, buy1h: 0, sell1h: 0, n5m: 0, n1h: 0, lastAt: null, complete: file.complete, asOf: file.asOf };
  for (const [t, side, usd] of file.trades) {
    s.lastAt = s.lastAt === null ? t : Math.max(s.lastAt, t);
    const age = nowSec - t;
    if (age > 3600) continue;
    s.n1h++;
    if (side === "buy") s.buy1h += usd;
    else s.sell1h += usd;
    if (age <= 300) {
      s.n5m++;
      if (side === "buy") s.buy5m += usd;
      else s.sell5m += usd;
    }
  }
  return s;
}
