import type { FlowSummary, TradeRow, TradesFile } from "./trades.ts";
import type { Candle } from "./market.ts";
import { USER_AGENT, type PumpFetch } from "./pumpfun.ts";

/**
 * The tape: the recent trades of the coins somebody is LOOKING AT, read from Pump.fun's own per-coin trade list
 * (`swap-api.pump.fun/v2/coins/<mint>/trades`, free, no key; read, do not record). There is no recorder behind it, and no
 * list for every tile: a coin is read only after `want()` (its chart, candles or trades were asked for) and forgotten two minutes after
 * it was last wanted. Tiles of coins nobody opened take their buy/sell mix from DexScreener instead (quotes.ts).
 *   - the buy/sell mix and "Large buy" / "Volume surge" event lines (for wanted coins), the time of the last trade
 *   - CANDLES, only when the list holds the coin's whole life (a young coin with fewer trades than one page); otherwise the market
 *     service (GeckoTerminal) draws the chart
 * Budget: Pump.fun's trade service lets about 12 requests a minute through; the tape takes at most 8, one page of 100 trades each.
 * Wallet addresses are never read; a transaction id is read only to count a trade once and is never served.
 */
const PAGE = 100;
const WINDOW_S = 3600;
const KEEP_MS = 120_000;
const REFRESH_MS = 20_000;
const GAP_MS = 7_500;
const MAX_COINS = 40;
const MAX_PRICES = 1000;
/** Pump.fun's trade list lets about 12 reads a minute through. The chart-request reads and the periodic reads together stay under this many. */
const ENSURE_CEILING = 10;
const MINT = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const SWAP = "https://swap-api.pump.fun/v2/coins";
const defaultGet: PumpFetch = (url) => fetch(url, { headers: { accept: "application/json", "user-agent": USER_AGENT }, signal: AbortSignal.timeout(12_000) });

interface Minute {
  buy: number;
  sell: number;
  n: number;
  nBuy: number;
}
interface CoinTape {
  minutes: Map<number, Minute>;
  rows: TradeRow[];
  prices: { t: number; p: number; usd: number }[];
  /** ids of trades already counted, with their time, so a trade is counted once however often the list is read */
  seen: Map<string, number>;
  lastAt: number;
  oldest: number;
  /** the list held the coin's whole life when first read (fewer trades than one page) and has not outgrown a page since */
  whole: boolean;
  event: TapeEvent | null;
  wantedAt: number;
  fetchedAt: number;
  asOf: number | null;
}
export interface TapeEvent {
  kind: "large_buy" | "large_sell" | "volume_surge";
  usd: number;
  atSec: number;
}

/** A single trade this big (dollars) is called large: at least $300 and at least 3% of the coin's recent hour of volume. */
const LARGE_MIN = 300;
const LARGE_SHARE = 0.03;
/** A minute with this many times the hour's average minute, and at least this many dollars, is a surge. */
const SURGE_TIMES = 5;
const SURGE_MIN = 500;

export class Tape {
  private coins = new Map<string, CoinTape>();
  private pausedUntil = 0;
  private lastCallAt = 0;
  private busy = false;
  private errors = 0;
  private calls = 0;
  private callTimes: number[] = [];
  private firstPage = new Map<string, Promise<void>>();
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(
    private get: PumpFetch = defaultGet,
    private now: () => number = Date.now,
  ) {}

  start(everyMs = 2000): void {
    this.timer = setInterval(() => void this.tick(), everyMs);
  }
  stop(): void {
    clearInterval(this.timer);
  }

  /** Somebody is looking at this coin: read its trades soon and keep them fresh for the next two minutes. */
  want(mint: string): void {
    if (!MINT.test(mint)) return;
    let c = this.coins.get(mint);
    if (!c) {
      if (this.coins.size >= MAX_COINS) this.drop();
      if (this.coins.size >= MAX_COINS) return;
      c = { minutes: new Map(), rows: [], prices: [], seen: new Map(), lastAt: 0, oldest: 0, whole: false, event: null, wantedAt: 0, fetchedAt: 0, asOf: null };
      this.coins.set(mint, c);
    }
    c.wantedAt = this.now();
  }

  private drop(): void {
    const t = this.now();
    for (const [m, c] of this.coins) if (t - c.wantedAt > KEEP_MS) this.coins.delete(m);
  }

  /** One request at most, for the wanted coin that has waited longest. Safe to call every couple of seconds. */
  async tick(): Promise<void> {
    const t = this.now();
    if (this.busy || t < this.pausedUntil || t - this.lastCallAt < GAP_MS) return;
    // The periodic read keeps to the same minute as the reads a chart request starts: together never past the ceiling.
    this.callTimes = this.callTimes.filter((x) => t - x < 60_000);
    if (this.callTimes.length >= ENSURE_CEILING) return;
    this.drop();
    let pick: [string, CoinTape] | null = null;
    for (const e of this.coins) if (t - e[1].fetchedAt >= REFRESH_MS && (!pick || e[1].fetchedAt < pick[1].fetchedAt)) pick = e;
    if (!pick) return;
    const [mint, c] = pick;
    this.busy = true;
    try {
      await this.fetchPage(mint, c);
    } finally {
      this.busy = false;
    }
  }

  /** Read one page of a coin's trades now and merge it. A refusal rests the whole tape a minute; any other fault, 15 seconds. */
  private async fetchPage(mint: string, c: CoinTape): Promise<void> {
    const t = this.now();
    this.lastCallAt = t;
    c.fetchedAt = t;
    this.calls++;
    this.callTimes = this.callTimes.filter((x) => t - x < 60_000);
    this.callTimes.push(t);
    try {
      const res = await this.get(`${SWAP}/${mint}/trades?limit=${PAGE}&cursor=9999999999999999999999-${t + 1000}`);
      if (res.status === 429) return void (this.pausedUntil = this.now() + 60_000);
      if (res.status !== 200) {
        this.errors++;
        this.pausedUntil = this.now() + 15_000;
        return;
      }
      const body = (await res.json()) as { trades?: unknown };
      if (!body || !Array.isArray(body.trades)) throw new Error("not a trade list");
      this.take(c, body.trades);
    } catch {
      this.errors++;
      this.pausedUntil = this.now() + 15_000;
    }
  }

  /**
   * A chart request for a coin the tape has never read: fetch its first page now, with the request, so the chart does not meet an empty tape
   * . Several requests for one coin share one read; nothing is read while the tape rests or the service's minute is nearly used.
   */
  async ensure(mint: string): Promise<void> {
    this.want(mint);
    const c = this.coins.get(mint);
    if (!c || c.asOf !== null) return;
    return this.read(mint);
  }

  /**
   * Read a coin's newest page now, subject to the same minute ceiling as every other read; a coin
   * already being read shares that read. Nothing is read while the tape rests. The answer is in `activity`.
   */
  async read(mint: string): Promise<void> {
    this.want(mint);
    const c = this.coins.get(mint);
    if (!c) return;
    const running = this.firstPage.get(mint);
    if (running) return running;
    const t = this.now();
    this.callTimes = this.callTimes.filter((x) => t - x < 60_000);
    if (t < this.pausedUntil || this.callTimes.length >= ENSURE_CEILING) return;
    const p = this.fetchPage(mint, c).finally(() => this.firstPage.delete(mint));
    this.firstPage.set(mint, p);
    return p;
  }

  /** Merge one page of the list, oldest first, counting each trade once. */
  private take(c: CoinTape, list: unknown[]): void {
    const first = c.asOf === null;
    const rows: { id: string; t: number; side: "buy" | "sell"; usd: number; price: number | null }[] = [];
    for (const r of list) {
      if (!r || typeof r !== "object") continue;
      const o = r as Record<string, unknown>;
      const t = typeof o.timestamp === "string" ? Math.floor(Date.parse(o.timestamp) / 1000) : NaN;
      const usd = typeof o.amountUsd === "string" || typeof o.amountUsd === "number" ? Number(o.amountUsd) : NaN;
      const price = typeof o.priceUsd === "string" || typeof o.priceUsd === "number" ? Number(o.priceUsd) : NaN;
      const id = typeof o.tx === "string" ? o.tx : typeof o.slotIndexId === "string" ? o.slotIndexId : "";
      if (!id || !Number.isFinite(t) || !Number.isFinite(usd) || usd < 0 || usd > 1e9 || (o.type !== "buy" && o.type !== "sell")) continue;
      rows.push({ id, t, side: o.type, usd, price: Number.isFinite(price) && price > 0 ? price : null });
    }
    rows.sort((a, b) => a.t - b.t);
    let fresh = 0;
    for (const r of rows) {
      if (c.seen.has(r.id)) continue;
      c.seen.set(r.id, r.t);
      fresh++;
      this.add(c, r.t, r.side, r.usd, r.price);
    }
    const full = list.length >= PAGE;
    if (first) c.whole = !full;
    else if (full && fresh === rows.length) c.whole = false; // a whole page of new trades: some in between were never read
    c.asOf = Math.floor(this.now() / 1000);
    this.trim(c, c.asOf, new Set(rows.map((r) => r.id)));
  }

  private add(c: CoinTape, t: number, side: "buy" | "sell", usd: number, price: number | null): void {
    const m = Math.floor(t / 60);
    const b = c.minutes.get(m) ?? { buy: 0, sell: 0, n: 0, nBuy: 0 };
    if (side === "buy") (b.buy += usd, b.nBuy++);
    else b.sell += usd;
    b.n++;
    c.minutes.set(m, b);
    c.rows.push([t, side, usd]);
    if (price !== null) c.prices.push({ t, p: price, usd });
    if (t > c.lastAt) c.lastAt = t;
    if (c.oldest === 0 || t < c.oldest) c.oldest = t;
    // events: only for trades that are fresh (a backlog read on first sight is history, not news)
    if (this.now() / 1000 - t < 90) {
      let hour = 0;
      for (const v of c.minutes.values()) hour += v.buy + v.sell;
      if (usd >= LARGE_MIN && usd >= LARGE_SHARE * hour) c.event = { kind: side === "buy" ? "large_buy" : "large_sell", usd, atSec: t };
      else {
        const mins = Math.max(1, c.minutes.size);
        const cur = c.minutes.get(m)!;
        const spent = cur.buy + cur.sell;
        if (spent >= SURGE_MIN && mins >= 4 && spent >= SURGE_TIMES * ((hour - spent) / (mins - 1 || 1))) c.event = { kind: "volume_surge", usd: spent, atSec: t };
      }
    }
  }

  /** `page` holds the ids on the page just read: a trade still on the newest page is never forgotten, or the next read would count it again. */
  private trim(c: CoinTape, nowSec: number, page: Set<string>): void {
    const oldest = Math.floor((nowSec - WINDOW_S) / 60);
    for (const m of c.minutes.keys()) if (m < oldest) c.minutes.delete(m);
    if (c.rows.length > 500) c.rows = c.rows.slice(-500);
    if (c.prices.length > MAX_PRICES) c.prices = c.prices.slice(-MAX_PRICES);
    // Forget counted trades one by one, never all at once: first those older than the hour kept, then (a coin trading very fast) the oldest.
    if (c.seen.size > 3000) {
      for (const [id, t] of c.seen) if (t < nowSec - WINDOW_S && !page.has(id)) c.seen.delete(id);
      for (const id of c.seen.keys()) {
        if (c.seen.size <= 3000) break;
        if (!page.has(id)) c.seen.delete(id);
      }
    }
  }

  /** How many trades and how many dollars in the window since `sinceSec`, from the page held; null when the coin was never read. A busy coin's page can hold less than the window. */
  activity(mint: string, sinceSec: number): { n: number; usd: number } | null {
    const c = this.coins.get(mint);
    if (!c || c.asOf === null) return null;
    let n = 0;
    let usd = 0;
    for (const [t, , d] of c.rows) if (t >= sinceSec) (n++, (usd += d));
    return { n, usd };
  }

  /** Buy and sell dollars over the last 5 minutes and hour for a read coin, or null. `complete` is false when the page held reaches back less than an hour. */
  flow(mint: string, nowSec = Math.floor(this.now() / 1000)): FlowSummary | null {
    const c = this.coins.get(mint);
    if (!c || c.asOf === null) return null;
    const s: FlowSummary = { buy5m: 0, sell5m: 0, buy1h: 0, sell1h: 0, n5m: 0, n1h: 0, lastAt: c.lastAt || null, complete: c.whole || (c.oldest > 0 && c.oldest <= nowSec - WINDOW_S), asOf: nowSec };
    const m5 = Math.floor((nowSec - 300) / 60);
    const h1 = Math.floor((nowSec - 3600) / 60);
    for (const [m, v] of c.minutes) {
      if (m < h1) continue;
      s.buy1h += v.buy;
      s.sell1h += v.sell;
      s.n1h += v.n;
      if (m >= m5) {
        s.buy5m += v.buy;
        s.sell5m += v.sell;
        s.n5m += v.n;
      }
    }
    return s.n1h > 0 ? s : null;
  }

  lastTradeMs(mint: string): number | null {
    const t = this.coins.get(mint)?.lastAt;
    return t ? t * 1000 : null;
  }

  /** The newest event for a coin if it happened in the last 60 seconds. */
  event(mint: string, nowSec = Math.floor(this.now() / 1000)): TapeEvent | null {
    const e = this.coins.get(mint)?.event ?? null;
    return e && nowSec - e.atSec <= 60 ? e : null;
  }

  /** True when the list held the coin's whole life, so candles built from it are the coin's real history. */
  complete(mint: string): boolean {
    const c = this.coins.get(mint);
    return !!c && c.asOf !== null && c.whole;
  }

  /**
   * Candles built from the held trades of one coin: [time, open, high, low, close, dollar volume], oldest first. A trade's price is the
   * list's own dollar price. Gaps (no trades) have no candle; nothing is filled in. `fromSec` bounds the history.
   */
  candles(mint: string, bucketSec: number, fromSec: number, limit = 1000): Candle[] {
    const c = this.coins.get(mint);
    if (!c) return [];
    const out: Candle[] = [];
    let cur: Candle | null = null;
    for (const r of [...c.prices].sort((a, b) => a.t - b.t)) {
      if (r.t < fromSec) continue;
      const b = Math.floor(r.t / bucketSec) * bucketSec;
      if (!cur || cur[0] !== b) {
        cur = [b, r.p, r.p, r.p, r.p, 0];
        out.push(cur);
      }
      cur[2] = Math.max(cur[2], r.p);
      cur[3] = Math.min(cur[3], r.p);
      cur[4] = r.p;
      cur[5] += r.usd;
    }
    return out.slice(-limit);
  }

  /**
   * Candles at `bucketSec` when that gives two or more; otherwise the finest size that does (5 minutes, then 1 minute), and failing that
   * whatever the held trades give. `bucketSec` says which size was given, as the tick files do. Null with no candle at all.
   */
  candlesBest(mint: string, bucketSec: number, limit = 1000): { candles: Candle[]; bucketSec: number } | null {
    const sizes = [...new Set([bucketSec, ...(bucketSec > 300 ? [300] : []), ...(bucketSec > 60 ? [60] : [])])];
    let best: { candles: Candle[]; bucketSec: number } | null = null;
    for (const b of sizes) {
      const cs = this.candles(mint, b, 0, limit);
      if (cs.length >= 2) return { candles: cs, bucketSec: b };
      if (!best && cs.length) best = { candles: cs, bucketSec: b };
    }
    return best;
  }

  /** The recent trades as a trades file ([time, side, dollars], newest 500, oldest first), or null when the coin was never read. */
  file(mint: string): TradesFile | null {
    const c = this.coins.get(mint);
    if (!c || c.asOf === null) return null;
    return { trades: [...c.rows].sort((a, b) => a[0] - b[0]), coversFrom: c.oldest || null, complete: c.whole, asOf: c.asOf };
  }

  stats(): { coins: number; calls: number; errors: number; ready: boolean } {
    return { coins: this.coins.size, calls: this.calls, errors: this.errors, ready: true };
  }
}
