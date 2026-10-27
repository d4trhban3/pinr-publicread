import { foldPrice, type Candle } from "./livecandle";

/**
 * A TradingView Advanced Charts datafeed over PINR's own numbers (the operator: "Get tradingview linked up properly to PINR"): the library asks this
 * object for a coin's symbol, its bars and its live ticks (the library's `IBasicDataFeed`: onReady, searchSymbols, resolveSymbol, getBars,
 * subscribeBars, unsubscribeBars); the bars come from what the coin page already reads (Pump.fun's candle history through the server, GeckoTerminal in
 * the browser, the tape), and the live ticks from our trade stream. The library itself is not in this repo (TradingView hands it out by licence request;
 * it stays out until it is granted); the types below are the part of its contract this adapter meets. Behind a switch (world/tvadvanced.ts), off.
 */
export interface Bar {
  /** milliseconds since 1970, the start of the bar */
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}
export interface PeriodParams {
  /** seconds since 1970 */
  from: number;
  to: number;
  countBack: number;
  firstDataRequest: boolean;
}
export interface SymbolInfo {
  name: string;
  ticker: string;
  description: string;
  type: "crypto";
  session: "24x7";
  timezone: "Etc/UTC";
  exchange: string;
  listed_exchange: string;
  format: "price";
  minmov: 1;
  pricescale: number;
  has_intraday: true;
  has_daily: true;
  has_weekly_and_monthly: false;
  supported_resolutions: string[];
  intraday_multipliers: string[];
  volume_precision: number;
  data_status: "streaming";
}
export interface DatafeedConfiguration {
  supported_resolutions: string[];
  exchanges: { value: string; name: string; desc: string }[];
  symbols_types: { name: string; value: string }[];
}
export interface HistoryMeta {
  noData: boolean;
  nextTime?: number;
}
export interface BasicDataFeed {
  onReady(cb: (c: DatafeedConfiguration) => void): void;
  searchSymbols(input: string, exchange: string, type: string, onResult: (r: unknown[]) => void): void;
  resolveSymbol(name: string, onResolve: (s: SymbolInfo) => void, onError: (reason: string) => void): void;
  getBars(s: SymbolInfo, resolution: string, p: PeriodParams, onResult: (bars: Bar[], meta: HistoryMeta) => void, onError: (reason: string) => void): void;
  subscribeBars(s: SymbolInfo, resolution: string, onTick: (bar: Bar) => void, uid: string, onResetCache?: () => void): void;
  unsubscribeBars(uid: string): void;
}

/** The resolutions offered and the candle size (seconds) and `/api/candles` timeframe each one reads. */
export const RESOLUTIONS: Record<string, { tf: "1m" | "5m" | "15m" | "1h" | "4h" | "1D"; sec: number }> = {
  "1": { tf: "1m", sec: 60 },
  "5": { tf: "5m", sec: 300 },
  "15": { tf: "15m", sec: 900 },
  "60": { tf: "1h", sec: 3600 },
  "240": { tf: "4h", sec: 14_400 },
  "1D": { tf: "1D", sec: 86_400 },
};
export const SUPPORTED = Object.keys(RESOLUTIONS);
export const resolutionOf = (r: string): { tf: "1m" | "5m" | "15m" | "1h" | "4h" | "1D"; sec: number } | null => RESOLUTIONS[r === "D" ? "1D" : r] ?? null;

/** What the host gives: a coin's candles at a timeframe (null when none), and the coin's own facts. */
export interface FeedSource {
  fetchCandles(address: string, tf: "1m" | "5m" | "15m" | "1h" | "4h" | "1D"): Promise<{ candles: Candle[]; bucketSec?: number } | null>;
  coin(address: string): { ticker: string; name: string; launchpad: string; priceUsd: number } | null;
}

/** TradingView's price scale: 10^digits so the smallest tick is a fraction of the price (a coin at $0.000004 needs many digits). */
export function priceScaleFor(price: number): number {
  if (!(price > 0) || !Number.isFinite(price)) return 100;
  const digits = Math.min(12, Math.max(2, 4 - Math.floor(Math.log10(price))));
  return 10 ** digits;
}

const MINT = /^[1-9A-HJ-NP-Za-km-z]{32,44}$|^0x[0-9a-fA-F]{40}$/;
const CACHE_MS = 15_000;

export function createDatafeed(src: FeedSource, now: () => number = Date.now): { feed: BasicDataFeed; pushTrade(address: string, priceUsd: number, atMs: number, usd?: number): void } {
  /** per coin and timeframe, the candles last read, which the live trades extend */
  const held = new Map<string, { at: number; candles: Candle[]; sec: number }>();
  const subs = new Map<string, { address: string; key: string; sec: number; onTick: (b: Bar) => void }>();
  const keyOf = (a: string, tf: string): string => `${a}|${tf}`;
  const bar = (c: Candle): Bar => ({ time: c[0] * 1000, open: c[1], high: c[2], low: c[3], close: c[4], volume: c[5] });

  async function candlesFor(address: string, resolution: string): Promise<{ candles: Candle[]; sec: number } | null> {
    const r = resolutionOf(resolution);
    if (!r) return null;
    const k = keyOf(address, r.tf);
    const h = held.get(k);
    if (h && now() - h.at < CACHE_MS) return h;
    const got = await src.fetchCandles(address, r.tf).catch(() => null);
    if (!got || !got.candles.length) return h ?? null;
    const sec = got.bucketSec ?? r.sec;
    const fresh = { at: now(), candles: got.candles.map((c) => [...c] as Candle), sec };
    held.set(k, fresh);
    return fresh;
  }

  const feed: BasicDataFeed = {
    onReady(cb) {
      setTimeout(() => cb({ supported_resolutions: SUPPORTED, exchanges: [], symbols_types: [{ name: "crypto", value: "crypto" }] }), 0);
    },
    searchSymbols(_input, _exchange, _type, onResult) {
      onResult([]); // the page opens one coin: the symbol picker is off
    },
    resolveSymbol(name, onResolve, onError) {
      const address = name.split(":").pop() ?? name;
      const coin = MINT.test(address) ? src.coin(address) : null;
      if (!coin) return void setTimeout(() => onError("unknown symbol"), 0);
      const info: SymbolInfo = {
        name: coin.ticker.replace(/^\$/, "") || address.slice(0, 6),
        ticker: address,
        description: coin.name,
        type: "crypto",
        session: "24x7",
        timezone: "Etc/UTC",
        exchange: coin.launchpad || "PINR",
        listed_exchange: coin.launchpad || "PINR",
        format: "price",
        minmov: 1,
        pricescale: priceScaleFor(coin.priceUsd),
        has_intraday: true,
        has_daily: true,
        has_weekly_and_monthly: false,
        supported_resolutions: SUPPORTED,
        intraday_multipliers: ["1", "5", "15", "60", "240"],
        volume_precision: 2,
        data_status: "streaming",
      };
      setTimeout(() => onResolve(info), 0);
    },
    getBars(s, resolution, p, onResult, onError) {
      void (async () => {
        const got = await candlesFor(s.ticker, resolution);
        if (!got) return onError("no chart for this coin");
        const all = got.candles.map(bar);
        const inRange = all.filter((b) => b.time >= p.from * 1000 && b.time < p.to * 1000);
        // Fewer than asked, and the earliest candle we hold is the coin's first: nothing older exists.
        const older = all.filter((b) => b.time < p.from * 1000);
        const bars = inRange.length < p.countBack ? [...older.slice(-(p.countBack - inRange.length)), ...inRange] : inRange;
        if (!bars.length) return onResult([], { noData: true });
        onResult(bars, { noData: false });
      })().catch(() => onError("the chart could not be read"));
    },
    subscribeBars(s, resolution, onTick, uid) {
      const r = resolutionOf(resolution);
      if (!r) return;
      subs.set(uid, { address: s.ticker, key: keyOf(s.ticker, r.tf), sec: r.sec, onTick });
    },
    unsubscribeBars(uid) {
      subs.delete(uid);
    },
  };

  /** A live trade from our stream: folded into the newest candle of every subscribed timeframe for that coin, and the library told. */
  function pushTrade(address: string, priceUsd: number, atMs: number, usd?: number): void {
    for (const sub of subs.values()) {
      if (sub.address !== address) continue;
      const h = held.get(sub.key);
      if (!h) continue; // nothing read yet: the library asks getBars first
      if (!foldPrice(h.candles, h.sec, priceUsd, atMs, usd === undefined ? {} : { usd })) continue;
      const last = h.candles[h.candles.length - 1];
      if (last) sub.onTick(bar(last));
    }
  }
  return { feed, pushTrade };
}
