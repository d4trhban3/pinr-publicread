import { existsSync, readdirSync, readFileSync, statSync, watch } from "node:fs";
import { join } from "node:path";
import type { Candle } from "./market.ts";
import { dexscreener, type QuoteFetch } from "./quotes.ts";

/**
 * Curve coins' own trades: the engine's websocket on the curve accounts writes `frontend-feed/ticks/<mint>.json` (contract
 * "ticks-1", `ops/PLAN-206-WEBSOCKET.md` section 5): up to 500 trades and 24 hours of 5-minute candles, priced in the curve's quote coin (SOL),
 * written whole by a rename about every 2 s for a coin that traded. This reads them with a folder watch and a per-file stamp (as the feed
 * reader does), gives the charts their candles in dollars, and hands the stream each trade not handed before.
 *
 * Dollars: a SOL price is multiplied in at the SOL price PINR read last (DexScreener, once a minute), the same for every candle of the 24 hours;
 * a trade or candle in any other quote coin is left out, never priced by a guess. A trade's time is when the engine heard it (`t_is_receipt`).
 */
export const SOL_MINT = "So11111111111111111111111111111111111111112";
const MINT = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
/** A Base or BNB coin's contract address (checklist 11: their own trades, charted the same way). */
const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const isKey = (m: string): boolean => MINT.test(m) || EVM_ADDRESS.test(m);
/** The chains whose own trades the engine writes as tick files; the file says which. */
export const TICK_SOURCES = ["Solana chain", "BNB chain", "Base chain"] as const;

export interface Trade {
  /** the engine's own key for the trade: its signature (or slot) and index */
  key: string;
  atMs: number;
  side: "buy" | "sell";
  /** SOL price and size; null for a coin quoted in another coin (USD1 and others), which counts only by its own dollar figures */
  priceSol: number | null;
  sol: number | null;
  /** the tick's own dollar price and size */
  priceUsd?: number;
  usd?: number;
}

/**
 * A tick whose price is far from the coin's other prices is not drawn (the team, 26 Oct: one tick in a near-empty pool put $7.83e41 on a tile and its chart, where
 * GeckoTerminal said $1.8e-14). Against the coin's own price from another source (`ref`, when the server knows it) a tick more than REF_FACTOR times above or below
 * is dropped; with no other price, a tick more than MEDIAN_FACTOR times from the median of the file's own trades is (three trades or more). Missing stays missing:
 * the tick is left out, never corrected.
 */
export const REF_FACTOR = 100;
/**
 * Only a trade under this old goes down the live stream (ENGINE, 26 Oct: the engine writes a newly listed coin's last 24 hours into its tick file, and the stream carried trades up to
 * 10.9 h old as new). An older one still counts for the chart and the ribbon, which read the file; it is never "live".
 */
export const LIVE_FRESH_MS = 5000;
/** No tick prices a token above this, whatever the coin's other price says (the other price may be made from the same bad tick). */
export const MAX_TICK_PRICE_USD = 1e9;
export const MEDIAN_FACTOR = 1000;
export function dropOutliers(trades: readonly Trade[], ref: number | null): Trade[] {
  const px = (t: Trade): number | null => (t.priceUsd !== undefined ? t.priceUsd : t.priceSol);
  const vals = trades.map(px).filter((v): v is number => v !== null && v > 0).sort((a, b) => a - b);
  const med = vals.length >= 3 ? vals[Math.floor(vals.length / 2)]! : null;
  return trades.filter((t) => {
    const p = px(t);
    if (p === null || !(p > 0)) return false;
    if (t.priceUsd !== undefined && t.priceUsd > MAX_TICK_PRICE_USD) return false;
    if (ref !== null && ref > 0 && ref <= MAX_TICK_PRICE_USD && t.priceUsd !== undefined) return t.priceUsd <= ref * REF_FACTOR && t.priceUsd >= ref / REF_FACTOR;
    return med === null || (p <= med * MEDIAN_FACTOR && p >= med / MEDIAN_FACTOR);
  });
}

/** A trade in dollars: its own dollar figures first, else its SOL figures at the SOL price; null when it has neither (missing stays missing). */
export function dollars(t: Trade, solUsd: number | null): { price: number; usd: number } | null {
  if (t.priceUsd !== undefined && t.usd !== undefined) return { price: t.priceUsd, usd: t.usd };
  if (t.priceSol !== null && t.sol !== null && solUsd !== null && solUsd > 0) return { price: t.priceSol * solUsd, usd: t.sol * solUsd };
  return null;
}
interface TickFile {
  mtimeMs: number;
  size: number;
  readAtMs: number;
  /** which chain the engine read the trades from */
  source: (typeof TICK_SOURCES)[number];
  trades: Trade[];
  /** 5-minute candles in SOL: [time s, open, high, low, close, volume SOL] */
  candles5m: Candle[];
  /** the last hour's trades, counted by the writer (absent until it has counted a whole hour; never a part-hour count) */
  hour?: { n: number; buys: number; sells: number };
  /** The last `activity` answer for this file: the window start in 10-second buckets and the SOL price it used, so the same coin asked again within 10 s is not summed again. */
  act?: { bucket: number; sol: number | null; v: { n: number; usd: number; atLeast?: boolean } | null };
}

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** One tick file's content, cleaned: only SOL-quoted trades and candles with every number in place. Null when it is not a ticks-1 file. */
export function parseTicks(raw: unknown): Omit<TickFile, "mtimeMs" | "size"> | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  const source = TICK_SOURCES.find((s) => s === r.source);
  if (r.contract !== "ticks-1" || !source) return null;
  const readAtMs = typeof r.read_at === "string" ? Date.parse(r.read_at) : NaN;
  const solQuoted = (q: unknown): boolean => q === undefined || q === null || q === SOL_MINT;
  const trades: Trade[] = [];
  for (const x of Array.isArray(r.ticks) ? r.ticks : []) {
    if (typeof x !== "object" || x === null) continue;
    const o = x as Record<string, unknown>;
    const atMs = num(o.t);
    const price = num(o.price_sol);
    const sol = num(o.sol);
    if (atMs === null || (o.side !== "buy" && o.side !== "sell")) continue;
    const bySol = price !== null && price > 0 && sol !== null && sol >= 0 && solQuoted(o.quote ?? r.quote);
    const pu = num(o.price_usd), u = num(o.usd);
    const byUsd = pu !== null && pu > 0 && u !== null && u >= 0 && typeof o.price_usd_src === "string" && o.price_usd_src.length > 0;
    if (!bySol && !byUsd) continue;
    trades.push({ key: `${String(o.sig ?? "")}:${String(o.i ?? 0)}`, atMs, side: o.side, priceSol: bySol ? price : null, sol: bySol ? sol : null, ...(byUsd ? { priceUsd: pu!, usd: u! } : {}) });
  }
  const candles5m: Candle[] = [];
  if (solQuoted(r.quote))
    for (const x of Array.isArray(r.candles_5m) ? r.candles_5m : []) {
      if (typeof x !== "object" || x === null) continue;
      const o = x as Record<string, unknown>;
      const t = num(o.t), op = num(o.o), h = num(o.h), l = num(o.l), c = num(o.c), v = num(o.v);
      if (t === null || op === null || h === null || l === null || c === null || v === null || !(op > 0 && h > 0 && l > 0 && c > 0) || v < 0) continue;
      candles5m.push([Math.floor(t / 1000), op, h, l, c, v]);
    }
  candles5m.sort((a, b) => a[0] - b[0]);
  const n1 = num(r.trades_1h), b1 = num(r.buys_1h), s1 = num(r.sells_1h);
  const hour = n1 !== null && n1 >= 0 && b1 !== null && b1 >= 0 && s1 !== null && s1 >= 0 ? { n: n1, buys: b1, sells: s1 } : undefined;
  return { readAtMs: Number.isFinite(readAtMs) ? readAtMs : 0, source, trades, candles5m, ...(hour ? { hour } : {}) };
}

/** Candles of `bucketSec` (5 minutes or longer) from the 5-minute ones, in dollars at `solUsd`. */
export function aggregate(c5: readonly Candle[], bucketSec: number, solUsd: number): Candle[] {
  const out: Candle[] = [];
  for (const k of c5) {
    const t = Math.floor(k[0] / bucketSec) * bucketSec;
    const last = out[out.length - 1];
    if (last && last[0] === t) {
      last[2] = Math.max(last[2], k[2] * solUsd);
      last[3] = Math.min(last[3], k[3] * solUsd);
      last[4] = k[4] * solUsd;
      last[5] += k[5] * solUsd;
    } else out.push([t, k[1] * solUsd, k[2] * solUsd, k[3] * solUsd, k[4] * solUsd, k[5] * solUsd]);
  }
  return out;
}

/** 1-minute candles from the trades themselves (the 5-minute file has nothing finer), in dollars. */
export function fromTrades(trades: readonly Trade[], bucketSec: number, solUsd: number | null): Candle[] {
  const out: Candle[] = [];
  for (const tr of [...trades].sort((a, b) => a.atMs - b.atMs)) {
    const d = dollars(tr, solUsd);
    if (!d) continue;
    const t = Math.floor(tr.atMs / 1000 / bucketSec) * bucketSec;
    const p = d.price;
    const last = out[out.length - 1];
    if (last && last[0] === t) {
      last[2] = Math.max(last[2], p);
      last[3] = Math.min(last[3], p);
      last[4] = p;
      last[5] += d.usd;
    } else out.push([t, last ? last[4] : p, Math.max(p, last ? last[4] : p), Math.min(p, last ? last[4] : p), p, d.usd]);
  }
  return out;
}

export type FolderWatch = (dir: string, changed: (name: string | null) => void) => () => void;
const nodeWatch: FolderWatch = (dir, changed) => {
  const w = watch(dir, { persistent: false }, (_e, name) => changed(typeof name === "string" ? name : null));
  w.on("error", () => changed(null));
  return () => w.close();
};
const FULL_PASS_MS = 10 * 60_000;
/** A later full pass is spread over the 2-second passes, this many files each, so it never holds the server up (it took 2.2 s at once on the server, 2026-10-25). */
const FULL_CHUNK = 400;
/** How many trades an engine tick file keeps at most (the newest 500); a file this full may not reach back across a window. */
export const KEEP_TRADES_FLOOR = 500;
/** A tick file untouched this long is left on disk, not held in memory. */
export const STALE_FILE_MS = 24 * 3600_000;

/** The tick folder, read through a watch and kept per file; a full stat pass every 10 minutes catches anything the watch missed. */
export class TickReader {
  private files = new Map<string, TickFile>();
  /** The coin's price from another source (the feed's own figure), when known: the check against one stray tick. Set by the server. */
  ref: ((address: string) => number | null) | null = null;
  /** lower-case address to the file's own spelling, rebuilt after each refresh (a miss used to scan every file: thousands of lookups a request made the server crawl) */
  private lower: Map<string, string> | null = null;
  private dirty = new Set<string>();
  private needFull = true;
  private lastFull = 0;
  /** The files a spread-out full pass has still to look at. */
  private fullQueue: string[] = [];
  private stop: (() => void) | null = null;
  /** per coin, the trades already handed to the stream */
  private handed = new Map<string, Set<string>>();
  /** told the moment the watch sees a tick file change, so new trades go out at once instead of at the next 2-second pass. */
  private changeFns: (() => void)[] = [];
  onChange(fn: () => void): void {
    this.changeFns.push(fn);
  }

  constructor(
    private dir: string,
    private now: () => number = Date.now,
    private watcher: FolderWatch | null = nodeWatch,
  ) {
    this.attach();
  }

  private attach(): void {
    if (this.stop || !this.watcher || !existsSync(this.dir)) return;
    try {
      this.stop = this.watcher(this.dir, (name) => {
        if (name === null) this.needFull = true;
        else if (name.endsWith(".json") && !name.startsWith("_")) this.dirty.add(name.slice(0, -5));
        else return;
        for (const fn of this.changeFns) fn();
      });
    } catch {
      this.needFull = true;
    }
  }

  close(): void {
    this.stop?.();
    this.stop = null;
  }

  /** True once the first full pass over the tick folder has read every file (a coin's last trade time is known only after its file is read). */
  firstPassDone(): boolean {
    return this.lastFull > 0 && this.fullQueue.length === 0;
  }

  /** Read one coin's file if it changed; true when the held copy is new. */
  private readOne(mint: string): boolean {
    const path = join(this.dir, `${mint}.json`);
    let st;
    try {
      st = statSync(path);
    } catch {
      this.files.delete(mint);
      return false;
    }
    const had = this.files.get(mint);
    if (had && had.mtimeMs === st.mtimeMs && had.size === st.size) return false;
    // A coin with no trade for a day is on no list: its file is not parsed or kept, which was most of the server's memory
    // (10,500 files, 144 MB of trades on disk, on 2026-10-25). It is read again the moment it changes.
    if (this.now() - st.mtimeMs > STALE_FILE_MS) {
      this.files.delete(mint);
      this.handed.delete(mint);
      return false;
    }
    try {
      const p = parseTicks(JSON.parse(readFileSync(path, "utf8")));
      if (p) {
        p.trades = dropOutliers(p.trades, this.ref?.(mint) ?? null);
        this.files.set(mint, { mtimeMs: st.mtimeMs, size: st.size, ...p });
        return true;
      }
      this.files.delete(mint);
    } catch {
      /* half-written or unreadable: the last good copy stays until the next rename */
    }
    return false;
  }

  /** Bring the held files up to date; returns the coins whose file changed. */
  refresh(): string[] {
    const t0 = performance.now();
    const out = this.refreshInner();
    const ms = performance.now() - t0;
    if (ms > 1000) console.log(`ticks: a pass took ${(ms / 1000).toFixed(1)} s (${this.files.size} files held)`);
    return out;
  }

  private refreshInner(): string[] {
    this.attach();
    this.lower = null;
    const changed = new Set<string>();
    const look = (m: string): void => {
      if (isKey(m) && this.readOne(m)) changed.add(m);
    };
    if (this.needFull || this.now() - this.lastFull >= FULL_PASS_MS) {
      // Every full pass, the first after a start too, is queued and spread over the next passes (FULL_CHUNK each), so a restart answers its
      // first visitors at once instead of reading 4,000 files in one go (checklist 4: 4.0 s blocked on the server). A file that changes meanwhile is
      // read at once through `dirty`.
      this.needFull = false;
      this.lastFull = this.now();
      const names = existsSync(this.dir) ? readdirSync(this.dir).filter((n) => n.endsWith(".json") && !n.startsWith("_")).map((n) => n.slice(0, -5)) : [];
      const keep = new Set(names);
      for (const m of [...this.files.keys()]) if (!keep.has(m)) this.files.delete(m);
      this.fullQueue = names;
    }
    for (const m of this.dirty) look(m);
    this.dirty.clear();
    if (this.fullQueue.length) for (const m of this.fullQueue.splice(0, FULL_CHUNK)) look(m);
    return [...changed];
  }

  /**
   * The candles for one coin with a tick file, in dollars: at `bucketSec` when that gives two or more; a young coin with fewer at that size
   * gets the finest size that has two (5 minutes, then 1 minute from the trades), and failing that whatever it has (one candle is still
   * its own chart, and its trades extend it live). Null only with no tick file, no SOL price, or no candle at all; the other sources then answer.
   * `bucketSec` in the answer says which size was given.
   */
  candles(mint: string, bucketSec: number, limit: number, solUsd: number | null): { candles: Candle[]; bucketSec: number } | null {
    const f = this.files.get(mint) ?? this.files.get(this.byLower(mint) ?? "");
    if (!f) return null;
    const sol = solUsd !== null && solUsd > 0 ? solUsd : null;
    // Five minutes and up from the engine's SOL candles; a coin quoted in another coin has none, so its own trades are added up instead.
    const at = (b: number): Candle[] => (b < 300 || !sol || !f.candles5m.length ? fromTrades(f.trades, b, sol) : aggregate(f.candles5m, b, sol));
    const sizes = [...new Set([bucketSec, ...(bucketSec > 300 ? [300] : []), ...(bucketSec > 60 ? [60] : [])])];
    let best: { candles: Candle[]; bucketSec: number } | null = null;
    for (const b of sizes) {
      const cs = at(b);
      if (cs.length >= 2) return { candles: cs.slice(-limit), bucketSec: b };
      if (!best && cs.length) best = { candles: cs.slice(-limit), bucketSec: b };
    }
    return best;
  }

  /** Trades and dollars since `sinceMs` for a coin with a tick file, in dollars at the SOL price; null with no tick file or no SOL price (then another source is tried). */
  activity(mint: string, sinceMs: number, solUsd: number | null): { n: number; usd: number; atLeast?: boolean } | null {
    const f = this.files.get(mint) ?? this.files.get(this.byLower(mint) ?? "");
    if (!f) return null;
    // The copy groups ask for every member's last 30 minutes at each rebuild (about 20,000 coins, each a pass over up to 500 trades: DEBUG measured loadServed at
    // 340 to 485 ms on the server). The window moves slowly, so an answer is kept for 10 seconds per file.
    const bucket = Math.floor(sinceMs / 10_000);
    if (f.act && f.act.bucket === bucket && f.act.sol === solUsd) return f.act.v;
    const v = this.activityOf(f, sinceMs, solUsd);
    f.act = { bucket, sol: solUsd, v };
    return v;
  }

  private activityOf(f: TickFile, sinceMs: number, solUsd: number | null): { n: number; usd: number; atLeast?: boolean } | null {
    let n = 0;
    let usd = 0;
    let oldest = Infinity;
    for (const t of f.trades) if (t.atMs < oldest) oldest = t.atMs;
    // The file keeps the newest trades only: when even its oldest is inside the window, more trades may lie before it, so the sums are a floor.
    const atLeast = f.trades.length >= KEEP_TRADES_FLOOR && oldest > sinceMs;
    for (const t of f.trades) {
      if (t.atMs < sinceMs) continue;
      const d = dollars(t, solUsd);
      if (!d) return null; // a trade with no dollar figure: the sum would be short, so another source is asked
      n++;
      usd += d.usd;
    }
    return { n, usd, ...(atLeast ? { atLeast: true } : {}) };
  }

  /** the last hour's trades as the writer counted them; null when the file does not carry them yet. */
  hourCounts(mint: string): { n: number; buys: number; sells: number } | null {
    const f = this.files.get(mint) ?? this.files.get(this.byLower(mint) ?? "");
    return f?.hour ?? null;
  }

  /** the coin's recent trades from its tick file, as the coin page's rows (seconds, side, dollars), newest 500; null with no priced trade. */
  tradesFile(mint: string, solUsd: number | null): { trades: [number, "buy" | "sell", number][]; coversFrom: number | null; complete: boolean; asOf: number | null } | null {
    const f = this.files.get(mint) ?? this.files.get(this.byLower(mint) ?? "");
    if (!f) return null;
    const rows: [number, "buy" | "sell", number][] = [];
    for (const t of f.trades) {
      const d = dollars(t, solUsd);
      if (d) rows.push([Math.floor(t.atMs / 1000), t.side, d.usd]);
    }
    if (!rows.length) return null;
    rows.sort((a, b) => b[0] - a[0]);
    const kept = rows.slice(0, 500);
    return { trades: kept, coversFrom: kept[kept.length - 1]![0], complete: false, asOf: f.readAtMs > 0 ? Math.floor(f.readAtMs / 1000) : null };
  }

  /** Candles at exactly `bucketSec` from the tick file (its own trades, or the engine's five-minute candles for five minutes and up), for a chart's live end. */
  candlesAt(mint: string, bucketSec: number, solUsd: number | null): Candle[] {
    const f = this.files.get(mint) ?? this.files.get(this.byLower(mint) ?? "");
    if (!f) return [];
    const sol = solUsd !== null && solUsd > 0 ? solUsd : null;
    return bucketSec < 300 || !sol || !f.candles5m.length ? fromTrades(f.trades, bucketSec, sol) : aggregate(f.candles5m, bucketSec, sol);
  }

  /** The chain a coin's tick file was read from ("Solana chain", "BNB chain", "Base chain"), or null with no file. */
  sourceOf(mint: string): (typeof TICK_SOURCES)[number] | null {
    return (this.files.get(mint) ?? this.files.get(this.byLower(mint) ?? ""))?.source ?? null;
  }

  /** The newest trade the engine's tick file holds for a coin (ms), or null with no file or no trade. */
  lastTradeMs(mint: string): number | null {
    const f = this.files.get(mint) ?? this.files.get(this.byLower(mint) ?? "");
    let last = 0;
    for (const t of f?.trades ?? []) if (t.atMs > last) last = t.atMs;
    return last > 0 ? last : null;
  }

  private byLower(mint: string): string | undefined {
    if (!this.lower) this.lower = new Map([...this.files.keys()].map((k) => [k.toLowerCase(), k]));
    return this.lower.get(mint.toLowerCase());
  }

  /** The trades of these coins not handed on before, in dollars; a coin's first sighting only records what is there (no flood on a start). */
  newTrades(mints: readonly string[], solUsd: number | null): { address: string; atMs: number; side: "buy" | "sell"; priceUsd: number; usd: number }[] {
    const out: { address: string; atMs: number; side: "buy" | "sell"; priceUsd: number; usd: number }[] = [];
    for (const mint of mints) {
      const f = this.files.get(mint);
      if (!f) continue;
      const seen = this.handed.get(mint);
      if (!seen) {
        this.handed.set(mint, new Set(f.trades.map((t) => t.key)));
        continue;
      }
      const freshFrom = this.now() - LIVE_FRESH_MS;
      for (const t of f.trades) {
        if (seen.has(t.key)) continue;
        seen.add(t.key); // an old trade is noted as handed too, so it is never handed later
        if (t.atMs < freshFrom) continue;
        const d = dollars(t, solUsd);
        if (d) out.push({ address: mint, atMs: t.atMs, side: t.side, priceUsd: d.price, usd: d.usd });
      }
      // keep the memory to what the file still holds
      if (seen.size > 2000) this.handed.set(mint, new Set(f.trades.map((t) => t.key)));
    }
    return out;
  }

  /**
   * trades the engine pushes the moment it hears them (pushin.ts), in the tick file's own shape. Each new one is handed
   * out once, now; the same trade read later from the file is not handed again (the same `sig:i` key).
   */
  pushed(mint: string, ticks: unknown, solUsd: number | null, source: (typeof TICK_SOURCES)[number] = "Solana chain"): { address: string; atMs: number; side: "buy" | "sell"; priceUsd: number; usd: number }[] {
    if (!isKey(mint)) return [];
    const p = parseTicks({ contract: "ticks-1", source, ticks });
    if (!p) return [];
    p.trades = dropOutliers(p.trades, this.ref?.(mint) ?? null);
    let seen = this.handed.get(mint);
    if (!seen) this.handed.set(mint, (seen = new Set()));
    const out: { address: string; atMs: number; side: "buy" | "sell"; priceUsd: number; usd: number }[] = [];
    const freshFrom = this.now() - LIVE_FRESH_MS;
    for (const t of p.trades) {
      if (seen.has(t.key)) continue;
      seen.add(t.key);
      if (t.atMs < freshFrom) continue;
      const d = dollars(t, solUsd);
      if (d) out.push({ address: mint, atMs: t.atMs, side: t.side, priceUsd: d.price, usd: d.usd });
    }
    return out;
  }

  get size(): number {
    return this.files.size;
  }

  /** The engine's status file, as it is (connected, node, coins, the day's shares), for the health page. */
  status(): unknown {
    try {
      return JSON.parse(readFileSync(join(this.dir, "_status.json"), "utf8"));
    } catch {
      return null;
    }
  }
}

/** SOL's dollar price from DexScreener's deepest pair, once a minute; null until read or when older than 10 minutes. */
export class SolPrice {
  private v: { usd: number; atMs: number } | null = null;
  constructor(
    private get: QuoteFetch = (url) => fetch(url, { headers: { accept: "application/json", "user-agent": "PINR-live/1.0 (read-only market data)" }, signal: AbortSignal.timeout(10_000) }),
    private now: () => number = Date.now,
  ) {}
  start(): void {
    void this.read();
    setInterval(() => void this.read(), 60_000);
  }
  async read(): Promise<void> {
    try {
      const ans = await dexscreener.fetch("solana", [SOL_MINT], this.get);
      const q = ans.status === "ok" ? ans.quotes.get(SOL_MINT.toLowerCase()) : undefined;
      if (q && q.priceUsd > 0) this.v = { usd: q.priceUsd, atMs: this.now() };
    } catch {
      /* the last price stays until it is stale */
    }
  }
  usd(): number | null {
    return this.v && this.now() - this.v.atMs < 10 * 60_000 ? this.v.usd : null;
  }
}

/**
 * a chart's history from its source (Pump.fun's candles, GeckoTerminal) with its live end from the coin's own trades: every tick candle
 * from the source's last candle on replaces or extends it. Nothing older is touched; with no tick candles the history stands as it is.
 */
export function withLiveEnd(history: readonly Candle[], live: readonly Candle[]): Candle[] {
  if (!live.length || !history.length) return history.slice();
  const lastT = history[history.length - 1]![0];
  const tail = live.filter((c) => c[0] >= lastT).map((c) => [...c] as Candle);
  if (!tail.length) return history.slice();
  // The source's last candle and the trades' one for the same time: the tick file holds only the latest trades, so it may start mid-candle.
  // Merged: the source's open, the higher high, the lower low, the trades' close, the larger volume.
  const h = history[history.length - 1]!;
  if (tail[0]![0] === lastT) {
    const t = tail[0]!;
    tail[0] = [lastT, h[1], Math.max(h[2], t[2]), Math.min(h[3], t[3]), t[4], Math.max(h[5], t[5])];
  }
  return [...history.slice(0, -1), ...(tail[0]![0] === lastT ? [] : [h]), ...tail];
}
