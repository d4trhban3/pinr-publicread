import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { cleanTileLinks, type TileLinks } from "./linkview.ts";
import type { WireToken } from "./translate.ts";

/**
 * Quotes: the current price, 24h change, 24h volume and liquidity of a token, from whichever market-data source answers.
 *
 * Every source is a small PROVIDER with the same shape, listed in priority order (`PINR_QUOTE_PROVIDERS`, default
 * "dexscreener,pumpfun"; Jupiter's price API is no longer in the default list: Jupiter Tokens v2 (server/jupmeta.ts) does that job and more, inside the same allowance). A token's quote comes from the first provider that knows it. The engine's own figures always win over any
 * provider. To use a paid source later: add one provider object here (or point the Gecko settings at the paid host in .env) and put it
 * first in the list. Nothing else in the app changes.
 *
 * Each provider has its own pace and back-off, so one source being busy never slows the others. A token a provider does not know is
 * remembered for 10 minutes, so it is not asked about again and again. Missing stays missing: no provider, no number.
 */
export interface Quote {
  priceUsd: number;
  change24hPct: number | null;
  volume24hUsd: number | null;
  liquidityUsd: number | null;
  pair: string | null;
  /** when the trading pair was created (ms), used to say how many hours "24h change" really covers */
  createdAtMs: number | null;
  /** the token's picture, when the source has one (https only); used only where the engine has none */
  imageUrl?: string | null;
  /** the pair's market cap in dollars, when the source gives one (DexScreener's `marketCap`) */
  marketCapUsd?: number | null;
  /** DexScreener's counts of buys and sells over the last 5 minutes and hour (numbers of trades, not dollars), when it gives them */
  txns?: { b5: number; s5: number; b1: number; s1: number } | null;
  /** DexScreener's measured price changes over 5 minutes, 1, 6 and 24 hours (percent), each null when it does not give it */
  changes?: PriceChanges | null;
  /** the coin's own X, Telegram and website where the source lists them (DexScreener's `info`) */
  links?: TileLinks;
}
export interface PriceChanges {
  m5: number | null;
  h1: number | null;
  h6: number | null;
  h24: number | null;
}

export type ProviderAnswer = { status: "ok"; quotes: Map<string, Quote> } | { status: "limited" } | { status: "error" };
export type QuoteFetch = (url: string, headers?: Record<string, string>) => Promise<{ status: number; json(): Promise<unknown> }>;

export interface QuoteProvider {
  id: string;
  label: string;
  /** "free" or "paid": shown on the health page */
  kind: "free" | "paid";
  chains: readonly string[];
  /** most tokens one request may ask about */
  maxBatch: number;
  /** the least time between two requests to this provider */
  minIntervalMs: number;
  /** keys of the result are lower-case addresses */
  fetch(chain: string, addresses: string[], get: QuoteFetch): Promise<ProviderAnswer>;
}

const num = (v: unknown): number | null => {
  const n = typeof v === "string" ? Number(v) : v;
  return typeof n === "number" && Number.isFinite(n) ? n : null;
};
const pos = (v: unknown): number | null => {
  const n = num(v);
  return n !== null && n > 0 ? n : null;
};
/** A price per token: a number above $1e9 is not a price (a coin would be worth more than every dollar there is), so it is missing. */
const priceOf = (v: unknown): number | null => {
  const n = pos(v);
  return n !== null && n <= 1e9 ? n : null;
};
const nonNeg = (v: unknown): number | null => {
  const n = num(v);
  return n !== null && n >= 0 ? n : null;
};
const pct = (v: unknown): number | null => {
  const n = num(v);
  return n !== null && n > -100 ? n : null;
};

function answer(status: number): ProviderAnswer | null {
  if (status === 429) return { status: "limited" };
  if (status !== 200) return { status: "error" };
  return null;
}

/** The links DexScreener lists for a token (`info.websites` and `info.socials`), cleaned to plain web addresses. */
export function dexLinks(info: any): TileLinks | undefined {
  if (typeof info !== "object" || info === null) return undefined;
  const site = Array.isArray(info.websites) ? info.websites.find((w: any) => typeof w?.url === "string")?.url : undefined;
  const social = (type: string): string | undefined => (Array.isArray(info.socials) ? info.socials.find((s: any) => s?.type === type && typeof s?.url === "string")?.url : undefined);
  return cleanTileLinks({ website: site, x: social("twitter"), telegram: social("telegram") });
}

/** DexScreener's trade counts for a pair, or null when any of the four numbers is missing (nothing is guessed). */
function txnsOf(t: any): Quote["txns"] {
  const n = (v: unknown): number | null => (typeof v === "number" && Number.isInteger(v) && v >= 0 ? v : null);
  const b5 = n(t?.m5?.buys), s5 = n(t?.m5?.sells), b1 = n(t?.h1?.buys), s1 = n(t?.h1?.sells);
  return b5 === null || s5 === null || b1 === null || s1 === null ? null : { b5, s5, b1, s1 };
}

/** DexScreener: free, no key, about 300 requests a minute, up to 30 tokens per request. Covers BNB and Solana well; Base Uniswap-v4 launches are missing. */
export const dexscreener: QuoteProvider = {
  id: "dexscreener",
  label: "DexScreener",
  kind: "free",
  chains: ["bsc", "base", "solana"],
  maxBatch: 30,
  minIntervalMs: 1000,
  async fetch(chain, addresses, get) {
    const res = await get(`https://api.dexscreener.com/tokens/v1/${chain}/${addresses.join(",")}`);
    const bad = answer(res.status);
    if (bad) return bad;
    const body = await res.json();
    if (!Array.isArray(body)) return { status: "error" };
    const best = new Map<string, { liq: number; q: Quote }>();
    for (const p of body as Record<string, any>[]) {
      const addr = String(p?.baseToken?.address ?? "").toLowerCase();
      const price = priceOf(p?.priceUsd);
      if (!addr || price === null || p?.chainId !== chain) continue;
      const liq = nonNeg(p?.liquidity?.usd);
      const score = liq ?? 0;
      if (best.has(addr) && best.get(addr)!.liq >= score) continue;
      best.set(addr, {
        liq: score,
        q: {
          priceUsd: price,
          change24hPct: pct(p?.priceChange?.h24),
          volume24hUsd: nonNeg(p?.volume?.h24),
          liquidityUsd: liq,
          pair: p?.baseToken?.symbol && p?.quoteToken?.symbol ? `${String(p.baseToken.symbol).slice(0, 20)} / ${String(p.quoteToken.symbol).slice(0, 20)}` : null,
          createdAtMs: pos(p?.pairCreatedAt),
          marketCapUsd: pos(p?.marketCap),
          txns: txnsOf(p?.txns),
          links: dexLinks(p?.info),
          changes: { m5: pct(p?.priceChange?.m5), h1: pct(p?.priceChange?.h1), h6: pct(p?.priceChange?.h6), h24: pct(p?.priceChange?.h24) },
          imageUrl: typeof p?.info?.imageUrl === "string" && /^https:\/\//.test(p.info.imageUrl) && p.info.imageUrl.length < 300 ? p.info.imageUrl : null,
        },
      });
    }
    return { status: "ok", quotes: new Map([...best].map(([k, v]) => [k, v.q])) };
  },
};

/** Jupiter's gateway: `api.jup.ag`, which replaces `lite-api.jup.ag` (to be phased out). */
export const JUPITER_PRICE_URL = "https://api.jup.ag/price/v3";
/**
 * The feed server's share of Jupiter's one limit per organisation (a 60-second window shared by the engine and this server, and by Price and
 * Tokens): keyless 30 a minute, a free key 60 a minute. The split: half each, so this server takes
 * one request every 4 s keyless (15 a minute), every 2 s with the key (30). PINR_JUPITER_EVERY_MS overrides it.
 */
export const JUPITER_EVERY_MS = { keyless: 4000, keyed: 2000 } as const;

/** Jupiter's price API (Solana only): up to 50 tokens per request; `x-api-key` sent only when a key is set in the `.env`, keyless otherwise. */
export function jupiterWith(key?: string, everyMs?: number): QuoteProvider {
  const headers = key ? { "x-api-key": key } : undefined;
  return {
    id: "jupiter",
    label: "Jupiter",
    kind: "free",
    chains: ["solana"],
    maxBatch: 50,
    minIntervalMs: everyMs && everyMs > 0 ? everyMs : key ? JUPITER_EVERY_MS.keyed : JUPITER_EVERY_MS.keyless,
    fetch: (chain, addresses, get) => jupiterFetch(chain, addresses, get, headers),
  };
}

async function jupiterFetch(_chain: string, addresses: string[], get: QuoteFetch, headers?: Record<string, string>): Promise<ProviderAnswer> {
  const res = await get(`${JUPITER_PRICE_URL}?ids=${addresses.join(",")}`, headers);
  const bad = answer(res.status);
  if (bad) return bad;
  const body = (await res.json()) as Record<string, any> | null;
  if (!body || typeof body !== "object") return { status: "error" };
  const out = new Map<string, Quote>();
  for (const [addr, v] of Object.entries(body)) {
    const price = priceOf(v?.usdPrice);
    if (price === null) continue;
    const created = typeof v?.createdAt === "string" ? Date.parse(v.createdAt) : NaN;
    out.set(addr.toLowerCase(), { priceUsd: price, change24hPct: pct(v?.priceChange24h), volume24hUsd: null, liquidityUsd: nonNeg(v?.liquidity), pair: null, createdAtMs: Number.isFinite(created) ? created : null });
  }
  return { status: "ok", quotes: out };
}

/** Jupiter keyless, at the keyless share. */
export const jupiter: QuoteProvider = jupiterWith();

/**
 * Pump.fun's own public coin record (Solana). Free, no key, but one coin per request and its service rate-limits bursts (about 30 a
 * minute, a budget the engine shares), so this asks slowly (one coin every 6 seconds) and sits LAST in the list: only coins DexScreener
 * and Jupiter do not know (new ones still on the bonding curve) are ever asked about. Price is the record's own dollar market cap
 * divided by the supply it states. It gives a one-hour volume only, so the 24h volume and 24h change stay missing.
 */
export const pumpfun: QuoteProvider = {
  id: "pumpfun",
  label: "Pump.fun",
  kind: "free",
  chains: ["solana"],
  maxBatch: 1,
  // One lookup at most every 10 s (6 a minute): Pump.fun's free budget is shared with the engine scanner (the app stays under 20 a minute in all).
  minIntervalMs: 10_000,
  async fetch(_chain, addresses, get) {
    const mint = addresses[0];
    if (!mint || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(mint)) return { status: "ok", quotes: new Map() };
    const res = await get(`https://frontend-api-v3.pump.fun/coins-v2/${mint}`);
    if (res.status === 404) return { status: "ok", quotes: new Map() };
    const bad = answer(res.status);
    if (bad) return bad;
    const c = (await res.json()) as Record<string, any> | null;
    if (!c || typeof c !== "object" || c.mint !== mint) return { status: "error" };
    const cap = pos(c.usd_market_cap ?? c.market_cap_usd);
    const supply = pos(c.total_supply);
    const dec = num(c.base_decimals);
    if (cap === null || supply === null || dec === null || dec < 0 || dec > 12) return { status: "ok", quotes: new Map() };
    const price = cap / (supply / 10 ** dec);
    if (!Number.isFinite(price) || price <= 0 || price > 1e9) return { status: "ok", quotes: new Map() };
    const image = typeof c.image_uri === "string" && /^https:\/\//.test(c.image_uri) && c.image_uri.length < 300 ? c.image_uri : null;
    const created = num(c.created_timestamp);
    return {
      status: "ok",
      quotes: new Map([[mint.toLowerCase(), { priceUsd: price, change24hPct: null, volume24hUsd: null, liquidityUsd: nonNeg(c.canonical_pool_liquidity_usd), pair: c.complete === true ? "PumpSwap" : "Pump.fun curve", createdAtMs: created !== null && created > 0 ? created : null, imageUrl: image }]]),
    };
  },
};

/** Every provider the app knows. Add a paid one here, then name it in PINR_QUOTE_PROVIDERS. */
export const REGISTRY: Record<string, QuoteProvider> = { dexscreener, jupiter, pumpfun };

export function providersFromEnv(list: string | undefined, jupiterKey?: string, jupiterEveryMs?: number): QuoteProvider[] {
  const ids = (list ?? "dexscreener,pumpfun").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  const reg: Record<string, QuoteProvider> = { ...REGISTRY, jupiter: jupiterKey || jupiterEveryMs ? jupiterWith(jupiterKey || undefined, jupiterEveryMs) : jupiter };
  return ids.map((id) => reg[id]).filter((p): p is QuoteProvider => !!p);
}

/** Tracked history: one price per 5 minutes, kept for a day. A line drawn from it is PINR's own record since it began watching the token. */
const BUCKET_MS = 5 * 60_000;
const KEEP_BUCKETS = 288;
/** Fewer than this many buckets (about 15 minutes) is not a line worth drawing. */
const MIN_LINE = 4;
/** A silence longer than this (server was off) ends a run: the line starts after the gap rather than joining across it. */
const GAP_MS = 30 * 60_000;
export const TRACKED_SOURCE = "PINR 5m";

const REFRESH_MS = 30_000;
/** A quote older than this is not shown (a source that went quiet must not leave an old price looking current). */
const TTL_MS = 10 * 60_000;
const MISS_MS = 10 * 60_000;
/** How long a pool figure (volume, liquidity, pair, market cap) from a source stays shown when no fresher source has it. */
const POOL_KEEP_MS = 6 * 3_600_000;
const defaultGet: QuoteFetch = (url, headers) => fetch(url, { headers: { accept: "application/json", "user-agent": "PINR-live/1.0 (read-only market data)", ...headers }, signal: AbortSignal.timeout(10_000) });

interface Held {
  q: Quote;
  at: number;
  provider: string;
}

export class QuoteWorker {
  private held = new Map<string, Held>();
  /** Every provider's latest answer for a token, so a source that answers only partly never wipes out a figure another source gave (each figure keeps its own receipt). */
  private latest = new Map<string, Map<string, Held>>();
  /** key -> [bucket number, price], oldest first */
  private hist = new Map<string, [number, number][]>();
  private miss = new Map<string, number>();
  private pace = new Map<string, { last: number; pausedUntil: number; calls: number; errors: number }>();
  private busy = false;
  private dirty = false;
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(
    private providers: QuoteProvider[],
    private get: QuoteFetch = defaultGet,
    private now: () => number = Date.now,
  ) {
    for (const p of providers) this.pace.set(p.id, { last: 0, pausedUntil: 0, calls: 0, errors: 0 });
  }

  private key(t: WireToken): string | null {
    return t.chain && t.address ? `${t.chain}:${t.address.toLowerCase()}` : null;
  }
  private rank(id: string): number {
    const i = this.providers.findIndex((p) => p.id === id);
    return i < 0 ? 99 : i;
  }

  /** each provider's own figures for one coin, by provider id (price and change under 10 minutes old, pool figures under 6 hours). */
  figures(t: WireToken): Record<string, { price: number | null; volume: number | null; liquidity: number | null; cap: number | null; atMs: number }> {
    const key = this.key(t);
    const out: Record<string, { price: number | null; volume: number | null; liquidity: number | null; cap: number | null; atMs: number }> = {};
    if (!key) return out;
    const now = this.now();
    const entries = new Map<string, Held>(this.latest.get(key) ?? []);
    const primary = this.held.get(key);
    if (primary && !entries.has(primary.provider)) entries.set(primary.provider, primary);
    for (const e of entries.values()) {
      if (now - e.at > POOL_KEEP_MS) continue;
      const fresh = now - e.at <= TTL_MS;
      out[e.provider] = { price: fresh ? e.q.priceUsd : null, volume: e.q.volume24hUsd, liquidity: e.q.liquidityUsd, cap: fresh ? (e.q.marketCapUsd ?? null) : null, atMs: e.at };
    }
    return out;
  }

  /** One round: each provider makes at most one request for the tokens it should be asked about. Safe to call often. */
  async tick(tokens: readonly WireToken[]): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      const now = this.now();
      await Promise.all(
        this.providers.map(async (p, pi) => {
          const st = this.pace.get(p.id)!;
          if (now < st.pausedUntil || now - st.last < p.minIntervalMs) return;
          // the tokens this provider should be asked about, grouped by chain (one request is for one chain)
          const byChain = new Map<string, WireToken[]>();
          for (const t of tokens) {
            const key = this.key(t);
            if (!key || !p.chains.includes(t.chain!)) continue;
            if ((this.miss.get(`${p.id}|${key}`) ?? 0) > now) continue;
            const h = this.held.get(key);
            const fresh = h && now - h.at < REFRESH_MS;
            const due = !h || (h.provider === p.id && !fresh) || this.rank(h.provider) > pi || now - h.at > TTL_MS;
            if (!due) continue;
            const list = byChain.get(t.chain!) ?? [];
            if (list.length < p.maxBatch) list.push(t);
            byChain.set(t.chain!, list);
          }
          const first = [...byChain.entries()][0];
          if (!first) return;
          const [chain, batch] = first;
          st.last = now;
          st.calls++;
          let ans: ProviderAnswer;
          try {
            ans = await p.fetch(chain, batch.map((t) => t.address), this.get);
          } catch {
            ans = { status: "error" };
          }
          if (ans.status === "limited") return void (st.pausedUntil = this.now() + 60_000);
          if (ans.status === "error") {
            st.errors++;
            st.pausedUntil = this.now() + 15_000;
            return;
          }
          for (const t of batch) {
            const key = this.key(t)!;
            const q = ans.quotes.get(t.address.toLowerCase());
            if (q) {
              const lm = this.latest.get(key) ?? new Map<string, Held>();
              lm.set(p.id, { q, at: this.now(), provider: p.id });
              this.latest.set(key, lm);
              const h = this.held.get(key);
              if (!h || this.rank(h.provider) >= pi || now - h.at > TTL_MS) {
                this.held.set(key, { q, at: this.now(), provider: p.id });
                this.dirty = true;
              }
              this.record(key, q.priceUsd, this.now());
              this.miss.delete(`${p.id}|${key}`);
            } else this.miss.set(`${p.id}|${key}`, this.now() + MISS_MS);
          }
        }),
      );
    } finally {
      this.busy = false;
    }
  }

  private record(key: string, price: number, at: number): void {
    const b = Math.floor(at / BUCKET_MS);
    const list = this.hist.get(key) ?? [];
    const last = list[list.length - 1];
    if (last && last[0] === b) last[1] = price;
    else list.push([b, price]);
    while (list.length > KEEP_BUCKETS) list.shift();
    this.hist.set(key, list);
    this.dirty = true;
  }

  /** The newest measured price changes any source gave for a token (recent only: a source gone quiet leaves no old figure looking current). */
  changesFor(t: Pick<WireToken, "chain" | "address">): PriceChanges | null {
    const key = this.key(t as WireToken);
    const now = this.now();
    for (const e of [...(this.latest.get(key ?? "")?.values() ?? [])].sort((a, b) => this.rank(a.provider) - this.rank(b.provider))) {
      if (now - e.at <= TTL_MS && e.q.changes) return e.q.changes;
    }
    return null;
  }

  /** The unbroken recent run of tracked prices for a token, or null when there are too few to draw. */
  private run(key: string): number[] | null {
    const list = this.hist.get(key);
    if (!list) return null;
    let from = 0;
    for (let i = list.length - 1; i > 0; i--) {
      if ((list[i]![0] - list[i - 1]![0]) * BUCKET_MS > GAP_MS) {
        from = i;
        break;
      }
    }
    const pts = list.slice(from).map((p) => p[1]);
    return pts.length >= MIN_LINE ? pts : null;
  }

  /**
   * For tokens that still have no price line from any service, draw PINR's own tracked line. Run this AFTER the services have had
   * their turn: a real candle history always wins.
   */
  fillHistory(tokens: WireToken[]): WireToken[] {
    return tokens.map((t) => {
      if (t.priceSeries !== null) return t;
      const key = this.key(t);
      const pts = key ? this.run(key) : null;
      return pts ? { ...t, priceSeries: pts, priceSource: TRACKED_SOURCE } : t;
    });
  }

  /**
   * Fill what the engine left out from the quotes. The engine's own figures are never replaced. Each figure comes from the best-ranked source that
   * HAS it (a fresher source that lacks a figure never replaces it with a dash), and carries its own receipt in `figSrc`. Price and change must be
   * recent (10 minutes); pool figures (volume, liquidity, pair, market cap) may be up to six hours old and say how old they are.
   */
  enrich(tokens: WireToken[]): WireToken[] {
    const now = this.now();
    return tokens.map((t) => {
      const key = this.key(t);
      if (!key) return t;
      const entries = new Map<string, Held>(this.latest.get(key) ?? []);
      const primary = this.held.get(key);
      if (primary && !entries.has(primary.provider)) entries.set(primary.provider, primary);
      const ranked = [...entries.values()].filter((e) => now - e.at <= POOL_KEEP_MS).sort((a, b) => this.rank(a.provider) - this.rank(b.provider));
      if (!ranked.length) return t;
      const labelOf = (id: string): string | undefined => this.providers.find((p) => p.id === id)?.label;
      const pick = <T>(get: (q: Quote) => T | null | undefined, maxAge: number): { v: T; e: Held; label: string } | null => {
        for (const e of ranked) {
          if (now - e.at > maxAge) continue;
          const v = get(e.q);
          const label = labelOf(e.provider);
          if (v !== null && v !== undefined && label) return { v, e, label };
        }
        return null;
      };
      const f = { ...t };
      const src: NonNullable<WireToken["figSrc"]> = { ...(t.figSrc ?? {}) };
      const price = pick((q) => q.priceUsd, TTL_MS);
      let priceFromQuote = false;
      if (price) {
        f.quoteSource = price.label;
        f.quoteAtMs = price.e.at;
        if (f.priceUsd === null) {
          f.priceUsd = price.v;
          // The price is this source's, so the market cap beside it is the SAME source's (one pair), never the engine's score-time figure
          // (hours or days old) next to a live price. If this source gives no cap, the engine's stays with its own receipt (its age).
          // One source, one read: where this source gives no cap, the market cap is a dash here; the engine's figure lives in the facts list only.
          const sameCap = pos(price.e.q.marketCapUsd);
          f.valuationUsd = sameCap;
          if (sameCap !== null) {
            f.capSource = price.label;
            f.capAtMs = price.e.at;
          } else {
            delete f.capSource;
            delete f.capAtMs;
          }
          priceFromQuote = true;
        }
      }
      const chg = pick((q) => q.change24hPct, TTL_MS);
      if (f.change24hPct === null && chg) {
        f.change24hPct = chg.v;
        // a pair under a day old: its "24h" change really covers only the hours since it began
        const created = chg.e.q.createdAtMs;
        const ageH = created !== null ? (now - created) / 3_600_000 : null;
        f.changeWindowH = f.changeWindowH ?? (ageH !== null && ageH < 24 ? Math.max(1, Math.round(ageH)) : 24);
      }
      const vol = pick((q) => q.volume24hUsd, POOL_KEEP_MS);
      if (f.volume24hUsd === null && vol) {
        f.volume24hUsd = vol.v;
        src.volume = { source: vol.label, atMs: vol.e.at };
      }
      const liq = pick((q) => q.liquidityUsd, POOL_KEEP_MS);
      if (f.liquidityUsd === null && liq) {
        f.liquidityUsd = liq.v;
        src.liquidity = { source: liq.label, atMs: liq.e.at };
      }
      const pair = pick((q) => q.pair, POOL_KEEP_MS);
      if (f.quotePair === null && pair) {
        f.quotePair = pair.v;
        src.pair = { source: pair.label, atMs: pair.e.at };
      }
      // No market cap from the engine or a launchpad list: the quote source's own, with its receipt (never a dash beside a source that has it).
      const cap = pick((q) => q.marketCapUsd, POOL_KEEP_MS);
      if (f.valuationUsd === null && cap && !priceFromQuote) {
        f.valuationUsd = cap.v;
        f.capSource = cap.label;
        f.capAtMs = cap.e.at;
      }
      const img = pick((q) => q.imageUrl, POOL_KEEP_MS);
      if (f.imageUrl === null && img) f.imageUrl = img.v;
      // The tile's buy/sell mix for a coin nobody has opened: DexScreener's counts of trades (the open coin's real dollars come from the tape and win).
      const tx = pick((q) => (q.txns && q.txns.b1 + q.txns.s1 > 0 ? q.txns : null), TTL_MS);
      if (f.flow === null && tx) {
        const x = tx.v;
        f.flow = { buy5m: x.b5, sell5m: x.s5, buy1h: x.b1, sell1h: x.s1, n5m: x.b5 + x.s5, n1h: x.b1 + x.s1, lastAt: null, complete: true, asOf: Math.floor(tx.e.at / 1000), basis: "count" };
      }
      // The coin's own links, where DexScreener lists them and the feed has none.
      if (!f.links) {
        const lk = pick((q) => q.links ?? null, POOL_KEEP_MS);
        if (lk) f.links = lk.v;
      }
      if (Object.keys(src).length) f.figSrc = src;
      return f;
    });
  }

  start(getTokens: () => WireToken[], everyMs = 2000): void {
    this.timer = setInterval(() => void this.tick(getTokens()), everyMs);
  }
  stop(): void {
    clearInterval(this.timer);
  }

  stats(): { id: string; label: string; kind: string; calls: number; errors: number; covered: number; pausedForS: number }[] {
    const now = this.now();
    return this.providers.map((p) => {
      const st = this.pace.get(p.id)!;
      let covered = 0;
      for (const h of this.held.values()) if (h.provider === p.id && now - h.at < TTL_MS) covered++;
      return { id: p.id, label: p.label, kind: p.kind, calls: st.calls, errors: st.errors, covered, pausedForS: Math.max(0, Math.round((st.pausedUntil - now) / 1000)) };
    });
  }

  saveTo(file: string): void {
    if (!this.dirty) return;
    this.dirty = false;
    try {
      mkdirSync(dirname(file), { recursive: true });
      const tmp = `${file}.tmp`;
      writeFileSync(tmp, JSON.stringify({ v: 1, held: [...this.held], hist: [...this.hist] }));
      renameSync(tmp, file);
    } catch {
      this.dirty = true;
    }
  }

  loadFrom(file: string): number {
    let n = 0;
    try {
      if (!existsSync(file)) return 0;
      const doc = JSON.parse(readFileSync(file, "utf8")) as { v?: number; held?: unknown; hist?: unknown };
      if (doc.v !== 1 || !Array.isArray(doc.held)) return 0;
      const now = this.now();
      if (Array.isArray(doc.hist)) {
        const oldest = Math.floor(now / BUCKET_MS) - KEEP_BUCKETS;
        for (const row of doc.hist) {
          if (!Array.isArray(row) || typeof row[0] !== "string" || !Array.isArray(row[1])) continue;
          const pts = (row[1] as unknown[]).filter((p): p is [number, number] => Array.isArray(p) && typeof p[0] === "number" && typeof p[1] === "number" && p[0] > oldest && p[1] > 0);
          if (pts.length && !this.hist.has(row[0])) this.hist.set(row[0], pts);
        }
      }
      for (const row of doc.held) {
        if (!Array.isArray(row) || typeof row[0] !== "string") continue;
        const h = row[1] as Held | undefined;
        if (!h || typeof h.at !== "number" || now - h.at > TTL_MS || typeof h.q?.priceUsd !== "number" || !(h.q.priceUsd > 0) || typeof h.provider !== "string") continue;
        if (!this.held.has(row[0])) this.held.set(row[0], h);
        n++;
      }
    } catch {
      /* a damaged file is ignored */
    }
    return n;
  }
}
