import type { Candle } from "../../server/market";

/**
 * Charts loaded in the VISITOR's browser. Every chart used to be fetched by the server from one home address, and the free chart sources
 * allow only a few requests a minute per address, so most charts answered "busy". From a visitor's browser the limit is that visitor's own.
 *   - `candles(mint, spec)`: candles for the small charts, read from GeckoTerminal's free OHLCV, the pool found through DexScreener's free token
 *     lookup. Both allow cross-origin reads from a page (checked 2026-10-22). Null means "not from here": the caller falls back to the server.
 * No key, no store of ours. A provider that refuses (429) rests for a minute; the small charts are paced so one visitor stays under the keyless limit.
 */
const SOL_MINT = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const EVM = /^0x[0-9a-fA-F]{40}$/;
/** A Solana mint or an EVM (Base, BNB Chain, Ethereum) contract address. */
const MINT = /^[1-9A-HJ-NP-Za-km-z]{32,44}$|^0x[0-9a-fA-F]{40}$/;
const DS_TOKENS = "https://api.dexscreener.com/latest/dex/tokens/";
const GT_BASE = "https://api.geckoterminal.com/api/v2/networks/";
/** DexScreener's chain name to GeckoTerminal's network name. */
export const GT_NETWORK: Record<string, string> = { solana: "solana", base: "base", bsc: "bsc", ethereum: "eth" };
export const POS_MS = 10 * 60_000;
export const NEG_MS = 2 * 60_000;
export const ERR_MS = 30_000;
/** Between two OHLCV calls from one browser, and the longest a chart will wait in line before the server answers instead. */
export const GT_GAP_MS = 2500;
export const GT_MAX_WAIT_MS = 10_000;
export const GT_REST_MS = 60_000;
/** A refused read (429, or the network error a refusal looks like) is tried once more after this wait before the provider is rested and the caller settles for another source. */
export const GT_RETRY_MS = 3000;

export interface Spec {
  path: "minute" | "hour" | "day";
  aggregate: number;
  limit: number;
  ttlMs: number;
}
/** The same ranges and timeframes the server draws (server/market.ts), so a chart looks the same from either path. */
export const CHART_RANGES: Record<string, Spec> = {
  "1D": { path: "minute", aggregate: 15, limit: 96, ttlMs: 60_000 },
  "1W": { path: "hour", aggregate: 1, limit: 168, ttlMs: 5 * 60_000 },
  "1M": { path: "hour", aggregate: 4, limit: 180, ttlMs: 10 * 60_000 },
  "3M": { path: "day", aggregate: 1, limit: 90, ttlMs: 30 * 60_000 },
  ALL: { path: "day", aggregate: 1, limit: 1000, ttlMs: 30 * 60_000 },
};
export const TIMEFRAMES: Record<string, Spec> = {
  "1m": { path: "minute", aggregate: 1, limit: 1000, ttlMs: 15_000 },
  "5m": { path: "minute", aggregate: 5, limit: 1000, ttlMs: 30_000 },
  "15m": { path: "minute", aggregate: 15, limit: 1000, ttlMs: 60_000 },
  "1h": { path: "hour", aggregate: 1, limit: 1000, ttlMs: 3 * 60_000 },
  "4h": { path: "hour", aggregate: 4, limit: 1000, ttlMs: 10 * 60_000 },
  "1D": { path: "day", aggregate: 1, limit: 1000, ttlMs: 30 * 60_000 },
};

type Get = (url: string) => Promise<{ status: number; json(): Promise<unknown> }>;
const defaultGet: Get = (url) => fetch(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(8000), referrerPolicy: "no-referrer" });

const ADDR = SOL_MINT;

/** DexScreener's pairs for a token: the pair of that token with the most liquidity, on Solana for a Solana mint, on Base, BNB Chain or Ethereum for an 0x address. */
export function bestPool(body: unknown, mint: string): { id: string; network: string } | null {
  const pairs = typeof body === "object" && body !== null ? (body as { pairs?: unknown }).pairs : undefined;
  if (!Array.isArray(pairs)) return null;
  const evm = EVM.test(mint);
  let best: { id: string; network: string; liq: number } | null = null;
  for (const p of pairs) {
    if (typeof p !== "object" || p === null) continue;
    const o = p as { chainId?: unknown; pairAddress?: unknown; baseToken?: { address?: unknown }; liquidity?: { usd?: unknown } };
    const net = typeof o.chainId === "string" ? GT_NETWORK[o.chainId] : undefined;
    if (!net || (evm ? o.chainId === "solana" : o.chainId !== "solana")) continue;
    const base = o.baseToken?.address;
    if (typeof o.pairAddress !== "string" || !(evm ? EVM.test(o.pairAddress) : ADDR.test(o.pairAddress)) || typeof base !== "string" || (evm ? base.toLowerCase() !== mint.toLowerCase() : base !== mint)) continue;
    const liq = typeof o.liquidity?.usd === "number" && Number.isFinite(o.liquidity.usd) ? o.liquidity.usd : 0;
    if (!best || liq > best.liq) best = { id: o.pairAddress, network: net, liq };
  }
  return best ? { id: best.id, network: best.network } : null;
}
/** The pair's address alone (the older name). */
export const bestPair = (body: unknown, mint: string): string | null => bestPool(body, mint)?.id ?? null;

/** Candles from GeckoTerminal's OHLCV list: oldest first, every number in place, a price above zero. */
export function cleanOhlcv(list: unknown): Candle[] {
  if (!Array.isArray(list)) return [];
  return list
    .filter((r): r is number[] => Array.isArray(r) && r.length >= 6 && r.slice(0, 6).every((n) => typeof n === "number" && Number.isFinite(n)) && r[1]! > 0 && r[2]! > 0 && r[3]! > 0 && r[4]! > 0 && r[5]! >= 0)
    .map((r) => [r[0]!, r[1]!, r[2]!, r[3]!, r[4]!, r[5]!] as Candle)
    .sort((a, b) => a[0] - b[0]);
}

type Memo<T> = { v: T; until: number };

export class BrowserCharts {
  private pairs = new Map<string, Memo<string | null>>();
  /** pair address to its GeckoTerminal network */
  private networks = new Map<string, string>();
  private pairRuns = new Map<string, Promise<string | null>>();
  private series = new Map<string, Memo<Candle[] | null>>();
  private seriesRuns = new Map<string, Promise<Candle[] | null>>();
  private nextGtAt = 0;
  private gtPausedUntil = 0;

  constructor(
    private get: Get = defaultGet,
    private now: () => number = Date.now,
    private retryMs: number = GT_RETRY_MS,
  ) {}

  /** The coin's Solana pair on DexScreener, or null (none, or not readable now: the answer is kept briefly either way). */
  dexPair(mint: string): Promise<string | null> {
    if (!MINT.test(mint)) return Promise.resolve(null);
    const hit = this.pairs.get(mint);
    if (hit && hit.until > this.now()) return Promise.resolve(hit.v);
    const run = this.pairRuns.get(mint);
    if (run) return run;
    const p = (async (): Promise<string | null> => {
      try {
        const r = await this.get(`${DS_TOKENS}${mint}`);
        if (r.status !== 200) {
          this.pairs.set(mint, { v: null, until: this.now() + ERR_MS });
          return null;
        }
        const found = bestPool(await r.json(), mint);
        const id = found?.id ?? null;
        if (found) this.networks.set(found.id, found.network);
        this.pairs.set(mint, { v: id, until: this.now() + (id ? POS_MS : NEG_MS) });
        return id;
      } catch {
        this.pairs.set(mint, { v: null, until: this.now() + ERR_MS });
        return null;
      }
    })().finally(() => this.pairRuns.delete(mint));
    this.pairRuns.set(mint, p);
    return p;
  }

  /** Candles for a small chart, from this browser; null when the coin has no pair, the provider rests, the line is too long or the answer is empty. */
  candles(mint: string, spec: Spec): Promise<Candle[] | null> {
    if (!MINT.test(mint)) return Promise.resolve(null);
    const key = `${mint}|${spec.path}|${spec.aggregate}|${spec.limit}`;
    const hit = this.series.get(key);
    if (hit && hit.until > this.now()) return Promise.resolve(hit.v);
    const run = this.seriesRuns.get(key);
    if (run) return run;
    const p = (async (): Promise<Candle[] | null> => {
      const pool = await this.dexPair(mint);
      if (!pool) return null;
      const t = this.now();
      if (t < this.gtPausedUntil) return null;
      const at = Math.max(t, this.nextGtAt);
      if (at - t > GT_MAX_WAIT_MS) return null; // too many in line: the server answers this one
      this.nextGtAt = at + GT_GAP_MS;
      if (at > t) await new Promise((r) => setTimeout(r, at - t));
      const url = `${GT_BASE}${this.networks.get(pool) ?? "solana"}/pools/${pool}/ohlcv/${spec.path}?aggregate=${spec.aggregate}&limit=${spec.limit}`;
      for (let attempt = 0; attempt < 2; attempt++) {
        let refused = false;
        try {
          const r = await this.get(url);
          if (r.status === 429) refused = true;
          else if (r.status !== 200) return null;
          else {
            const body = (await r.json()) as { data?: { attributes?: { ohlcv_list?: unknown } } };
            const cs = cleanOhlcv(body.data?.attributes?.ohlcv_list);
            const v = cs.length >= 2 ? cs : null;
            this.series.set(key, { v, until: this.now() + (v ? spec.ttlMs : ERR_MS) });
            return v;
          }
        } catch {
          // GeckoTerminal's refusal (429) carries no cross-origin header, so a browser sees it as a network error, not a status (found live, 2026-10-22).
          refused = true;
        }
        if (refused && attempt === 0) {
          await new Promise((r) => setTimeout(r, this.retryMs)); // one more try after a short wait before settling for another source
          if (this.now() < this.gtPausedUntil) return null;
        }
      }
      this.gtPausedUntil = this.now() + GT_REST_MS;
      return null;
    })().finally(() => this.seriesRuns.delete(key));
    this.seriesRuns.set(key, p);
    return p;
  }
}

export const browserCharts = new BrowserCharts();
