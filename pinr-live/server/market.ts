import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { WireToken } from "./translate.ts";

/**
 * Market data: price history, 24h change and 24h volume for the Discover chart and list.
 *
 * Source: GeckoTerminal's public API (CoinGecko's on-chain DEX data): free, no key, covers Solana, Base and BNB pools and
 * brand-new tokens. TradingView does not list fresh DEX tokens, so it cannot be the data source.
 *
 * Rules:
 *   - the engine's own figures always win; this only fills what the engine did not send
 *   - a token with no pool yet (still on a bonding curve, or not indexed) gets NOTHING: missing, not guessed
 *   - the free service rate-limits hard (it answered 429 after about 7 quick calls): ONE call every 12 s from a background loop,
 *     a result is kept 15 minutes, and a 429 pauses everything for a minute. The first pass over a big roster takes a while;
 *     tokens at the top of the roster are looked up first.
 *   - the only thing sent out is a public token address
 * Switch it off with PINR_MARKET=off.
 */
import { CHART_CEILING, GeckoBudget } from "./geckobudget.ts";
import type { GeckoKeyRoute } from "./geckokey.ts";
import { visibleText } from "../src/world/visibletext.ts";

export const SOURCE_NAME = "GeckoTerminal";
const API = "https://api.geckoterminal.com/api/v2";
const NETWORKS: Record<string, string> = { solana: "solana", base: "base", bsc: "bsc", bnb: "bsc", ethereum: "eth", eth: "eth" };

/** How long a result is kept before it is refreshed, by outcome. */
const FRESH_MS = { ok: 15 * 60_000, none: 30 * 60_000, error: 2 * 60_000 };

export function networkFor(chain: string | null): string | null {
  return chain ? (NETWORKS[chain.toLowerCase()] ?? null) : null;
}

export interface Parsed {
  /** Closing prices, oldest first (at least 2). */
  series: number[];
  /** Percent change from the first candle's open to the last close. */
  changePct: number | null;
  /** Hours the candles span. */
  windowH: number;
  /** Total traded volume in USD over the candles. */
  volumeUsd: number | null;
}

/** Hour candles [time, open, high, low, close, volume], newest first, as GeckoTerminal sends them. */
export function parseOhlcv(list: unknown): Parsed | null {
  if (!Array.isArray(list)) return null;
  const rows = list
    .filter((r): r is number[] => Array.isArray(r) && r.length >= 6 && r.slice(0, 5).every((n) => typeof n === "number" && Number.isFinite(n)) && (r[4] as number) > 0 && (r[1] as number) > 0)
    .sort((a, b) => a[0]! - b[0]!);
  if (rows.length < 2) return null;
  const first = rows[0]!;
  const last = rows[rows.length - 1]!;
  const change = (last[4]! / first[1]! - 1) * 100;
  const vols = rows.map((r) => r[5]);
  const volumeUsd = vols.every((v) => typeof v === "number" && Number.isFinite(v) && v >= 0) ? (vols as number[]).reduce((a, b) => a + b, 0) : null;
  return {
    series: rows.map((r) => r[4]!),
    changePct: Number.isFinite(change) && change > -100 ? change : null,
    windowH: (last[0]! - first[0]!) / 3600 + 1,
    volumeUsd,
  };
}

/** Facts about the trading pool, from the pool lookup. */
export interface PoolMeta {
  name: string | null;
  liquidityUsd: number | null;
}

type Entry =
  | { state: "pool"; at: number; pool: string; meta: PoolMeta }
  | { state: "ok"; at: number; pool: string; parsed: Parsed; meta: PoolMeta }
  | { state: "none" | "error"; at: number };

/** A restored price reading older than this is thrown away rather than shown as current. */
const RESTORE_OK_MS = 60 * 60_000;
/**
 * The home address's free GeckoTerminal allowance is shared with the engine's own readers, so a chart read can be refused for calls it never made.
 * A refused chart read rests the chart reads this long only (the background readers keep their longer rest), so the next viewer is asked again soon.
 */
export const CHART_REST_MS = 20_000;
/** The last good candles of a chart are shown (marked stale, with the time they were read) up to this long while the service refuses. */
export const STALE_KEEP_MS = 2 * 60 * 60_000;
/** The first coins of the PINR page whose 1-minute candles (the apps' first chart) are read ahead, and how often each is read again. */
export const WARM_TOP = 6;
export const WARM_EVERY_MS = 3 * 60_000;

export type Fetcher = (url: string) => Promise<{ status: number; json(): Promise<unknown> }>;

const defaultFetch: Fetcher = (url) => fetch(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(10_000) });

/** A fetcher that also sends extra headers (a paid plan's key goes here, from .env, never in the app). */
export function fetcherWith(headers: Record<string, string>): Fetcher {
  return (url) => fetch(url, { headers: { accept: "application/json", ...headers }, signal: AbortSignal.timeout(10_000) });
}

/** The ranges the DeepScan chart offers, each as one price-history request (candle size, how many). */
export const CHART_RANGES = {
  "1D": { path: "minute", aggregate: 15, limit: 96, ttlMs: 60_000 },
  "1W": { path: "hour", aggregate: 1, limit: 168, ttlMs: 5 * 60_000 },
  "1M": { path: "hour", aggregate: 4, limit: 180, ttlMs: 10 * 60_000 },
  "3M": { path: "day", aggregate: 1, limit: 90, ttlMs: 30 * 60_000 },
  ALL: { path: "day", aggregate: 1, limit: 1000, ttlMs: 30 * 60_000 },
} as const;
export type ChartRange = keyof typeof CHART_RANGES;
export const isChartRange = (r: string): r is ChartRange => Object.prototype.hasOwnProperty.call(CHART_RANGES, r);

/** The candle sizes a chart can ask for, each as one price-history request. (The free service offers exactly these sizes.) */
export const TIMEFRAMES = {
  "1m": { path: "minute", aggregate: 1, limit: 1000, ttlMs: 15_000 },
  "5m": { path: "minute", aggregate: 5, limit: 1000, ttlMs: 30_000 },
  "15m": { path: "minute", aggregate: 15, limit: 1000, ttlMs: 60_000 },
  "1h": { path: "hour", aggregate: 1, limit: 1000, ttlMs: 3 * 60_000 },
  "4h": { path: "hour", aggregate: 4, limit: 1000, ttlMs: 10 * 60_000 },
  "1D": { path: "day", aggregate: 1, limit: 1000, ttlMs: 30 * 60_000 },
} as const;
export type Timeframe = keyof typeof TIMEFRAMES;
export const isTimeframe = (t: string): t is Timeframe => Object.prototype.hasOwnProperty.call(TIMEFRAMES, t);

export interface CandlesResult {
  tf: Timeframe;
  source: string;
  candles: Candle[];
  /** "stale": the candles are the last good read, kept while the source is busy; `asOfMs` is when they were read. Never shown as current. */
  status: "ok" | "stale" | "none" | "busy" | "error";
  /** Only with status "stale": the time (ms since 1970) the candles were read. */
  asOfMs?: number;
  /** Set when the candles are of another size than asked: seconds a candle. */
  bucketSec?: number;
}

/** One candle: [time in seconds, open, high, low, close, volume in dollars]. */
export type Candle = [number, number, number, number, number, number];

export interface ChartResult {
  range: ChartRange;
  source: string;
  /** Oldest first. Empty when there is no price history (the reason is in `status`). */
  candles: Candle[];
  status: "ok" | "stale" | "none" | "busy" | "error";
  /** Only with status "stale": the time (ms since 1970) the candles were read. */
  asOfMs?: number;
  /** Set when the candles are of another size than asked: seconds a candle. */
  bucketSec?: number;
}

/** Clean candles from the API's newest-first rows: numbers only, positive prices, oldest first. */
export function cleanCandles(list: unknown): Candle[] {
  if (!Array.isArray(list)) return [];
  return list
    .filter((r): r is number[] => Array.isArray(r) && r.length >= 6 && r.slice(0, 6).every((n) => typeof n === "number" && Number.isFinite(n)) && (r[1] as number) > 0 && (r[2] as number) > 0 && (r[3] as number) > 0 && (r[4] as number) > 0 && (r[5] as number) >= 0)
    .map((r) => [r[0]!, r[1]!, r[2]!, r[3]!, r[4]!, r[5]!] as Candle)
    .sort((a, b) => a[0] - b[0]);
}

export class MarketWorker {
  private cache = new Map<string, Entry>();
  private pausedUntil = 0;
  private chartPausedUntil = 0;
  /** While someone has a chart open, the background lookups wait: the page being looked at comes first. */
  private userUntil = 0;
  private busy = false;
  private timer: ReturnType<typeof setInterval> | undefined;
  private warmTimer: ReturnType<typeof setInterval> | undefined;
  /** Counts for the health page. */
  calls = 0;
  errors = 0;

  constructor(
    private fetchFn: Fetcher = defaultFetch,
    private now: () => number = Date.now,
    /** the service's address: the free public one, or a paid plan's (same paths), set in .env */
    private api: string = API,
    /** the allowance shared with the pool reader (server.ts passes the same one to both) */
    private budget: GeckoBudget = new GeckoBudget(now),
    /** the operator's Demo key, for a viewer's chart reads only (geckokey.ts); none: every read takes the route above */
    private keyed: GeckoKeyRoute | null = null,
  ) {}

  /** A refusal rests every call: a minute, then twice as long for each refusal in a row (five minutes at most); a good answer resets it. */
  private strikes = 0;
  private rest(): void {
    this.strikes = Math.min(this.strikes + 1, 4);
    this.pausedUntil = this.now() + Math.min(60_000 * 2 ** (this.strikes - 1), 300_000);
  }
  private calm(): void {
    this.strikes = 0;
  }
  /** A refused chart read: the chart reads rest briefly; the background readers rest as after any refusal. */
  private chartRest(): void {
    this.chartPausedUntil = this.now() + CHART_REST_MS;
    this.rest();
  }

  /**
   * Read ahead the 1-minute candles of the PINR page's first coins (what the apps' coin page asks for first), one coin per turn, each again
   * after WARM_EVERY_MS, only while the last minute leaves the chart reads two calls of room. The next viewer then gets them at once, or as
   * the last good ones (stale, with their time) while the service refuses.
   */
  async warm(tokens: readonly WireToken[]): Promise<boolean> {
    if (this.now() < this.chartPausedUntil || this.budget.count() >= CHART_CEILING - 2) return false;
    let pick: { t: WireToken; at: number } | null = null;
    for (const t of tokens.slice(0, WARM_TOP)) {
      const key = this.key(t);
      if (!key || this.inflight.has(`${key}|tf:1m`)) continue;
      const e = this.cache.get(key);
      if (e && e.state === "none" && this.now() - e.at < FRESH_MS.none) continue;
      const held = this.charts.get(`${key}|tf:1m`);
      if (held && this.now() - held.at < WARM_EVERY_MS) continue;
      const at = held ? held.at : -Infinity;
      if (!pick || at < pick.at) pick = { t, at };
    }
    if (!pick) return false;
    const key = this.key(pick.t)!;
    const p = this.fetchCandles(pick.t, TIMEFRAMES["1m"], "tf:1m", true).finally(() => this.inflight.delete(`${key}|tf:1m`));
    this.inflight.set(`${key}|tf:1m`, p);
    await p;
    return true;
  }
  /** Chart reads already on their way, so several viewers of one chart cost one call. */
  private inflight = new Map<string, Promise<{ candles: Candle[]; status: ChartResult["status"]; asOfMs?: number }>>();

  private key(t: WireToken): string | null {
    const net = networkFor(t.chain);
    return net ? `${net}:${t.address.toLowerCase()}` : null;
  }

  /** The first token (in roster order) that needs a call, or null. */
  private next(tokens: readonly WireToken[]): { t: WireToken; key: string; net: string } | null {
    const now = this.now();
    // Tokens never covered come first (a token with nothing on screen matters more than a reading a few minutes old); refreshes after.
    let stale: { t: WireToken; key: string; net: string } | null = null;
    for (const t of tokens) {
      const key = this.key(t);
      if (!key) continue;
      const net = networkFor(t.chain)!;
      const e = this.cache.get(key);
      if (!e) return { t, key, net };
      if (e.state === "pool") return { t, key, net };
      if (!stale && now - e.at > FRESH_MS[e.state]) stale = { t, key, net };
    }
    return stale;
  }

  private charts = new Map<string, { at: number; result: ChartResult }>();

  private dirty = false;
  private put(key: string, e: Entry): void {
    this.cache.set(key, e);
    this.dirty = true;
  }

  /**
   * Keep what was learned across restarts, so a restart does not send the worker back to the start of a slow first pass.
   * Only things that cannot mislead are restored: pool addresses (stable) and price readings up to an hour old. A "no pool" or "error"
   * answer is not kept: it is asked again.
   */
  saveTo(file: string): void {
    if (!this.dirty) return;
    this.dirty = false;
    const keep = [...this.cache].filter(([, e]) => e.state === "pool" || e.state === "ok");
    try {
      mkdirSync(dirname(file), { recursive: true });
      const tmp = `${file}.tmp`;
      writeFileSync(tmp, JSON.stringify({ v: 1, entries: keep }));
      renameSync(tmp, file);
    } catch {
      this.dirty = true; // try again next time
    }
  }

  loadFrom(file: string): number {
    let n = 0;
    try {
      if (!existsSync(file)) return 0;
      const doc = JSON.parse(readFileSync(file, "utf8")) as { v?: number; entries?: unknown };
      if (doc.v !== 1 || !Array.isArray(doc.entries)) return 0;
      const now = this.now();
      for (const row of doc.entries) {
        if (!Array.isArray(row) || typeof row[0] !== "string") continue;
        const e = row[1] as Entry | undefined;
        if (!e || typeof e.at !== "number" || typeof (e as { pool?: unknown }).pool !== "string") continue;
        if (e.state === "ok") {
          const parsed = (e as { parsed?: Parsed }).parsed;
          if (!parsed || !Array.isArray(parsed.series) || parsed.series.length < 2 || now - e.at > RESTORE_OK_MS) continue;
        } else if (e.state !== "pool") continue;
        if (!this.cache.has(row[0])) this.cache.set(row[0], e);
        n++;
      }
    } catch {
      /* a damaged file is ignored: the worker starts from scratch */
    }
    return n;
  }

  /**
   * Price history for one token over a range, fetched when someone opens it (and kept for a short while). Only called for tokens
   * that are in the feed. If the free service is rate-limiting, or the token has no pool, the answer says so; nothing is invented.
   */
  async chartFor(t: WireToken, range: ChartRange): Promise<ChartResult> {
    const spec = CHART_RANGES[range];
    const r = await this.loadCandles(t, spec, `range:${range}`);
    return { range, source: SOURCE_NAME, candles: r.candles, status: r.status, ...(r.asOfMs !== undefined ? { asOfMs: r.asOfMs } : {}) };
  }

  /** Candles at one timeframe for a chart (up to 1000 of them), kept for a short while like the chart ranges. */
  async candlesFor(t: WireToken, tf: Timeframe): Promise<CandlesResult> {
    const spec = TIMEFRAMES[tf];
    const r = await this.loadCandles(t, spec, `tf:${tf}`);
    return { tf, source: SOURCE_NAME, candles: r.candles, status: r.status, ...(r.asOfMs !== undefined ? { asOfMs: r.asOfMs } : {}) };
  }

  /**
   * The one place that asks the free price service for candles. Viewers of the same chart share one call; when the service is busy,
   * the last good answer for that chart (kept up to six times its freshness window) is shown instead of an empty chart.
   */
  private loadCandles(
    t: WireToken,
    spec: { path: "minute" | "hour" | "day"; aggregate: number; limit: number; ttlMs: number },
    cacheId: string,
  ): Promise<{ candles: Candle[]; status: ChartResult["status"]; asOfMs?: number }> {
    const key = this.key(t);
    if (!key) return this.fetchCandles(t, spec, cacheId);
    const id = `${key}|${cacheId}`;
    const running = this.inflight.get(id);
    if (running) return running;
    const p = this.fetchCandles(t, spec, cacheId)
      .then((r) => {
        const old = this.charts.get(id);
        if ((r.status === "busy" || r.status === "error") && old && old.result.candles.length >= 2 && this.now() - old.at < Math.max(6 * spec.ttlMs, STALE_KEEP_MS)) {
          return { candles: old.result.candles, status: "stale" as const, asOfMs: old.at };
        }
        return r;
      })
      .finally(() => this.inflight.delete(id));
    this.inflight.set(id, p);
    return p;
  }

  /** Pool lookup if needed, then the candles. */
  private async fetchCandles(
    t: WireToken,
    spec: { path: "minute" | "hour" | "day"; aggregate: number; limit: number; ttlMs: number },
    cacheId: string,
    ahead = false,
  ): Promise<{ candles: Candle[]; status: ChartResult["status"]; asOfMs?: number }> {
    const net = networkFor(t.chain);
    const key = this.key(t);
    const empty = (status: ChartResult["status"]): { candles: Candle[]; status: ChartResult["status"] } => ({ candles: [], status });
    const kind = ahead ? "ahead" : "chart";
    if (!net || !key) return empty("none");
    if (!ahead) this.userUntil = this.now() + 30_000;
    const hit = this.charts.get(`${key}|${cacheId}`);
    if (hit && this.now() - hit.at < spec.ttlMs) return { candles: hit.result.candles, status: hit.result.status };
    const keyed = !ahead && this.keyed && this.keyed.mayCall() ? this.keyed : null;
    if (!keyed && this.now() < this.chartPausedUntil) return empty("busy");
    /** One call: through the Demo key for a viewer while it has room (its own allowance), else the free route under the home address's budget. */
    const get = async (path: string): Promise<{ status: number; json(): Promise<unknown> } | "busy"> => {
      if (keyed && keyed.mayCall()) {
        keyed.used();
        const r = await keyed.fetch(`${keyed.api}${path}`);
        if (r.status !== 429) return r;
        keyed.rest(); // the key's allowance said no: the free route tries
      }
      if (this.now() < this.chartPausedUntil || !this.budget.chartMayCall()) return "busy"; // the pool reader's room is kept
      this.calls++;
      this.budget.record(kind);
      const r = await this.fetchFn(`${this.api}${path}`);
      if (r.status === 429) {
        this.budget.refused(kind);
        this.chartRest();
        return "busy";
      }
      return r;
    };
    try {
      let e = this.cache.get(key);
      let pool = e && (e.state === "pool" || e.state === "ok") ? e.pool : null;
      if (!pool) {
        if (e && e.state === "none" && this.now() - e.at < FRESH_MS.none) return empty("none");
        const r = await get(`/networks/${net}/tokens/${t.address}/pools?page=1`);
        if (r === "busy") return empty("busy");
        if (r.status === 404) {
          this.put(key, { state: "none", at: this.now() });
          return empty("none");
        }
        if (r.status !== 200) throw new Error(`status ${r.status}`);
        const body = (await r.json()) as { data?: { attributes?: { address?: string; name?: string; reserve_in_usd?: string | number } }[] };
        const a = body.data?.[0]?.attributes;
        pool = a?.address ?? null;
        if (!pool) {
          this.put(key, { state: "none", at: this.now() });
          return empty("none");
        }
        const liq = Number(a?.reserve_in_usd);
        this.put(key, { state: "pool", at: this.now(), pool, meta: { name: typeof a?.name === "string" ? a.name : null, liquidityUsd: Number.isFinite(liq) && liq >= 0 ? liq : null } });
        e = this.cache.get(key);
      }
      const res = await get(`/networks/${net}/pools/${pool}/ohlcv/${spec.path}?aggregate=${spec.aggregate}&limit=${spec.limit}`);
      if (res === "busy") return empty("busy");
      if (res.status !== 200) throw new Error(`status ${res.status}`);
      const body = (await res.json()) as { data?: { attributes?: { ohlcv_list?: unknown } } };
      const candles = cleanCandles(body.data?.attributes?.ohlcv_list);
      const result: ChartResult = { range: "1D", source: SOURCE_NAME, candles, status: candles.length >= 2 ? "ok" : "none" };
      this.charts.set(`${key}|${cacheId}`, { at: this.now(), result });
      // Kept for the stale fallback, but not without end (it was never trimmed): past 3,000 charts the oldest 1,000 go.
      if (this.charts.size > 3000) for (const k of [...this.charts.keys()].slice(0, 1000)) this.charts.delete(k);
      this.calm();
      return { candles, status: result.status };
    } catch {
      this.errors++;
      return empty("error");
    }
  }

  /** Make at most one call. Safe to call often. */
  async step(tokens: readonly WireToken[]): Promise<void> {
    if (this.busy || this.now() < this.pausedUntil || this.now() < this.userUntil) return;
    if (!this.budget.backgroundMayCall()) return; // the charts keep their room
    const job = this.next(tokens);
    if (!job) return;
    this.busy = true;
    const { key, net, t } = job;
    const prev = this.cache.get(key);
    try {
      this.calls++;
      this.budget.record("market");
      // Several tokens on one network not seen yet: ask about all of them (and their main pools) in ONE call.
      if (!prev) {
        const batch = this.unseen(tokens, net);
        if (batch.length >= 2) return await this.lookupBatch(net, batch);
      }
      let pool = prev && (prev.state === "pool" || prev.state === "ok") ? prev.pool : null;
      if (!pool) {
        const res = await this.fetchFn(`${this.api}/networks/${net}/tokens/${t.address}/pools?page=1`);
        if (res.status === 429) return void (this.budget.refused("market"), this.rest());
        if (res.status === 404) return void this.put(key, { state: "none", at: this.now() });
        if (res.status !== 200) throw new Error(`status ${res.status}`);
        const body = (await res.json()) as { data?: { attributes?: { address?: string; name?: string; reserve_in_usd?: string | number } }[] };
        const a = body.data?.[0]?.attributes;
        pool = a?.address ?? null;
        if (!pool) return void this.put(key, { state: "none", at: this.now() });
        const liq = Number(a?.reserve_in_usd);
        this.put(key, { state: "pool", at: this.now(), pool, meta: { name: typeof a?.name === "string" ? a.name : null, liquidityUsd: Number.isFinite(liq) && liq >= 0 ? liq : null } });
        return; // the price history is the next call
      }
      const res = await this.fetchFn(`${this.api}/networks/${net}/pools/${pool}/ohlcv/hour?aggregate=1&limit=24`);
      if (res.status === 429) return void (this.budget.refused("market"), this.rest());
      if (res.status !== 200) throw new Error(`status ${res.status}`);
      const body = (await res.json()) as { data?: { attributes?: { ohlcv_list?: unknown } } };
      const parsed = parseOhlcv(body.data?.attributes?.ohlcv_list);
      const meta: PoolMeta = prev && (prev.state === "pool" || prev.state === "ok") ? prev.meta : { name: null, liquidityUsd: null };
      this.put(key, parsed ? { state: "ok", at: this.now(), pool, parsed, meta } : { state: "none", at: this.now() });
    } catch {
      this.errors++;
      this.put(key, { state: "error", at: this.now() });
    } finally {
      this.busy = false;
    }
  }

  /** Tokens on one network with no entry yet, in roster order (at most 30: the service's limit for one call). */
  private unseen(tokens: readonly WireToken[], net: string): WireToken[] {
    const out: WireToken[] = [];
    for (const t of tokens) {
      const key = this.key(t);
      if (!key || networkFor(t.chain) !== net || this.cache.has(key)) continue;
      out.push(t);
      if (out.length >= 30) break;
    }
    return out;
  }

  /** One call for up to 30 tokens: which ones have a trading pool, and its name and liquidity. (Prices follow, one token per call.) */
  private async lookupBatch(net: string, batch: WireToken[]): Promise<void> {
    const res = await this.fetchFn(`${this.api}/networks/${net}/tokens/multi/${batch.map((b) => b.address).join(",")}?include=top_pools`);
    if (res.status === 429) return void (this.budget.refused("market"), this.rest());
    if (res.status !== 200) throw new Error(`status ${res.status}`);
    const body = (await res.json()) as {
      data?: { attributes?: { address?: string }; relationships?: { top_pools?: { data?: { id?: string }[] } } }[];
      included?: { id?: string; attributes?: { address?: string; name?: string; reserve_in_usd?: string | number } }[];
    };
    const pools = new Map<string, { address: string; name: string | null; liq: number | null }>();
    for (const p of body.included ?? []) {
      const addr = p.attributes?.address;
      if (typeof p.id !== "string" || typeof addr !== "string") continue;
      const liq = Number(p.attributes?.reserve_in_usd);
      pools.set(p.id, { address: addr, name: typeof p.attributes?.name === "string" ? p.attributes.name : null, liq: Number.isFinite(liq) && liq >= 0 ? liq : null });
    }
    const byToken = new Map<string, string | undefined>();
    for (const d of body.data ?? []) {
      const a = d.attributes?.address;
      if (typeof a === "string") byToken.set(a.toLowerCase(), d.relationships?.top_pools?.data?.[0]?.id);
    }
    for (const t of batch) {
      const key = this.key(t)!;
      const pool = pools.get(byToken.get(t.address.toLowerCase()) ?? "");
      if (!pool) this.put(key, { state: "none", at: this.now() });
      else this.put(key, { state: "pool", at: this.now(), pool: pool.address, meta: { name: pool.name, liquidityUsd: pool.liq } });
    }
  }

  /** GeckoTerminal's own figures for one coin (its pool's last price, 24-hour volume and liquidity), or null. */
  figures(t: WireToken): { price: number | null; volume: number | null; liquidity: number | null; atMs: number } | null {
    const key = this.key(t);
    const e = key ? this.cache.get(key) : undefined;
    if (!e || e.state !== "ok") return null;
    return { price: e.parsed.series[e.parsed.series.length - 1] ?? null, volume: e.parsed.volumeUsd, liquidity: e.meta.liquidityUsd, atMs: e.at };
  }

  /** Fill what the engine left out. The engine's own figures are never replaced. */
  enrich(tokens: WireToken[]): WireToken[] {
    return tokens.map((t) => {
      const key = this.key(t);
      const e = key ? this.cache.get(key) : undefined;
      if (!e || e.state !== "ok") return t;
      const p = e.parsed;
      const filled = { ...t };
      let used = false;
      if (t.priceSeries === null) {
        filled.priceSeries = p.series;
        used = true;
      }
      if (t.change24hPct === null && p.changePct !== null) {
        filled.change24hPct = p.changePct;
        filled.changeWindowH = filled.changeWindowH ?? p.windowH;
        used = true;
      }
      if (t.volume24hUsd === null && p.volumeUsd !== null) {
        filled.volume24hUsd = p.volumeUsd;
        used = true;
      }
      // Pool facts: what the engine did not send.
      if (t.liquidityUsd === null && e.meta.liquidityUsd !== null) {
        filled.liquidityUsd = e.meta.liquidityUsd;
        used = true;
      }
      if (t.quotePair === null && e.meta.name) {
        filled.quotePair = visibleText(e.meta.name) || null;
        used = true;
      }
      if (t.priceUsd === null) {
        filled.priceUsd = p.series[p.series.length - 1]!;
        used = true;
      }
      if (used) filled.priceSource = SOURCE_NAME;
      return filled;
    });
  }

  start(getTokens: () => WireToken[], everyMs = 12_000, firstPage?: () => readonly WireToken[]): void {
    this.timer = setInterval(() => void this.step(getTokens()), everyMs);
    if (firstPage) this.warmTimer = setInterval(() => void this.warm(firstPage()), 20_000);
  }

  stop(): void {
    clearInterval(this.timer);
    clearInterval(this.warmTimer);
  }

  stats(): { calls: number; errors: number; covered: number; none: number; pausedForS: number; chartPausedForS: number } {
    let covered = 0;
    let none = 0;
    for (const e of this.cache.values()) {
      if (e.state === "ok") covered++;
      else if (e.state === "none") none++;
    }
    return { calls: this.calls, errors: this.errors, covered, none, pausedForS: Math.max(0, Math.round((this.pausedUntil - this.now()) / 1000)), chartPausedForS: Math.max(0, Math.round((this.chartPausedUntil - this.now()) / 1000)) };
  }
}
