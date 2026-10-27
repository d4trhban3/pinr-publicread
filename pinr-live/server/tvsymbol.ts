/**
 * Whether TradingView lists a coin, and under which symbol (the operator: "the crypto data from trading view is free"). TradingView's free
 * embeddable Advanced Chart draws any symbol it lists, with its own data. A coin is looked up through its main pool: DexScreener's free token
 * lookup gives the pool address, TradingView's own symbol search is asked for that address (its answer names the exchange and symbol), and the
 * result is kept only if its description holds that pool address, so a different market can never stand in for the coin.
 * TradingView's search refuses a browser on another site (403), so the server asks, politely (one at a time, 1 s apart), and keeps the answer
 * (a listing for 6 hours, a "not listed" for 30 minutes). Nothing is shown from this but a symbol name that matches `SYMBOL`.
 */
const SEARCH = "https://symbol-search.tradingview.com/symbol_search/v3/";
const DEXSCREENER = "https://api.dexscreener.com/tokens/v1/solana/";
export const POS_MS = 6 * 3_600_000;
export const NEG_MS = 30 * 60_000;
export const GAP_MS = 1000;
export const MAX_WAIT_MS = 8000;
const ADDR = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
/** The only symbol shape handed to the page: EXCHANGE:NAME. */
export const SYMBOL = /^[A-Z0-9_]{2,40}:[A-Z0-9_.\-]{2,60}$/;

export type TvGet = (url: string, headers?: Record<string, string>) => Promise<{ status: number; json(): Promise<unknown> }>;
const defaultGet: TvGet = (url, headers) => fetch(url, { headers: { accept: "application/json", "user-agent": "Mozilla/5.0 (compatible; PINR-live/1.0)", ...headers }, signal: AbortSignal.timeout(10_000) });

/** The pool of most liquidity in DexScreener's token answer. */
export function bestPool(body: unknown, mint: string): string | null {
  if (!Array.isArray(body)) return null;
  let best: { id: string; liq: number } | null = null;
  for (const p of body) {
    const o = p as { chainId?: unknown; pairAddress?: unknown; baseToken?: { address?: unknown }; liquidity?: { usd?: unknown } };
    if (typeof o !== "object" || o === null || o.chainId !== "solana" || typeof o.pairAddress !== "string" || !ADDR.test(o.pairAddress) || o.baseToken?.address !== mint) continue;
    const liq = typeof o.liquidity?.usd === "number" && Number.isFinite(o.liquidity.usd) ? o.liquidity.usd : 0;
    if (!best || liq > best.liq) best = { id: o.pairAddress, liq };
  }
  return best?.id ?? null;
}

/** The symbol for a pool from TradingView's search answer: the entry whose description holds the pool address, the dollar-quoted one first. */
export function symbolFor(body: unknown, pool: string): string | null {
  const list = typeof body === "object" && body !== null ? (body as { symbols?: unknown }).symbols : undefined;
  if (!Array.isArray(list)) return null;
  const hits: string[] = [];
  for (const s of list) {
    const o = s as { symbol?: unknown; prefix?: unknown; source_id?: unknown; description?: unknown };
    if (typeof o !== "object" || o === null || typeof o.symbol !== "string" || typeof o.description !== "string" || !o.description.includes(pool)) continue;
    const ex = typeof o.prefix === "string" ? o.prefix : typeof o.source_id === "string" ? o.source_id : null;
    const full = ex ? `${ex}:${o.symbol}` : null;
    if (full && SYMBOL.test(full)) hits.push(full);
  }
  return hits.find((h) => h.endsWith(".USD")) ?? hits[0] ?? null;
}

export class TvSymbols {
  private cache = new Map<string, { at: number; symbol: string | null }>();
  private chain: Promise<unknown> = Promise.resolve();
  private last = 0;
  stat = { lookups: 0, listed: 0 };
  constructor(
    private get: TvGet = defaultGet,
    private now: () => number = Date.now,
  ) {}

  /** `EXCHANGE:SYMBOL` when TradingView lists the coin, null when it does not; undefined when it could not be asked just now. */
  async symbol(mint: string): Promise<string | null | undefined> {
    if (!ADDR.test(mint)) return null;
    const held = this.cache.get(mint);
    if (held && this.now() - held.at < (held.symbol ? POS_MS : NEG_MS)) return held.symbol;
    const waited = this.now();
    const turn = this.chain.then(async (): Promise<string | null | undefined> => {
      if (this.now() - waited > MAX_WAIT_MS) return undefined;
      const again = this.cache.get(mint);
      if (again && this.now() - again.at < (again.symbol ? POS_MS : NEG_MS)) return again.symbol;
      const wait = this.last + GAP_MS - this.now();
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      this.last = this.now();
      this.stat.lookups++;
      try {
        const ds = await this.get(DEXSCREENER + mint);
        if (ds.status !== 200) return undefined;
        const pool = bestPool(await ds.json(), mint);
        let sym: string | null = null;
        if (pool) {
          const res = await this.get(`${SEARCH}?text=${pool}&hl=0&lang=en&start=0&domain=production`, { origin: "https://www.tradingview.com", referer: "https://www.tradingview.com/" });
          if (res.status !== 200) return undefined;
          sym = symbolFor(await res.json(), pool);
        }
        this.cache.set(mint, { at: this.now(), symbol: sym });
        if (sym) this.stat.listed++;
        if (this.cache.size > 2000) for (const k of [...this.cache.keys()].slice(0, 500)) this.cache.delete(k);
        return sym;
      } catch {
        return undefined;
      }
    });
    this.chain = turn.catch(() => undefined);
    try {
      return await turn; // null is an answer (not listed); undefined means it could not be asked
    } catch {
      return undefined;
    }
  }
}
