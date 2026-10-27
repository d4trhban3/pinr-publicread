import { cleanTileLinks } from "./linkview.ts";
import type { PriceChanges, QuoteFetch } from "./quotes.ts";
import type { WireToken } from "./translate.ts";
import { isVamp } from "./vamp.ts";
import { visibleText } from "../src/world/visibletext.ts";

/**
 * Names, pictures, links, holders and a price cross-check for every listed Solana coin from Jupiter Tokens v2 (free, keyless, 100 coins a call, about 0.2 s):
 * `GET api.jup.ag/tokens/v2/search?query=<mint,mint,...>`. Pump.fun's own records refuse the server (Cloudflare's bot challenge, 2026-10-23), so this and
 * PumpPortal's launch messages carry a coin's name and picture instead. A sweep takes the coins read longest ago first, at most 100 a call and one call
 * every 6 s (10 a minute, inside the server's half of Jupiter's shared keyless allowance), so each listed coin is read again about every minute.
 * Jupiter only FILLS: a name, picture, link, price, volume, liquidity or change another source already gave is never replaced (DexScreener comes first).
 */
export const SEARCH_URL = "https://api.jup.ag/tokens/v2/search";
export const BATCH = 100;
export const EVERY_MS = 6000;
/** A coin read within this long is not asked again: with 500 coins a sweep of five calls is done in 30 s and the next starts about a minute after the last read. */
export const FRESH_MS = 50_000;
/** An answer older than this stops filling (a source gone quiet must not leave an old price looking current). */
export const STALE_MS = 10 * 60_000;
export const REST_MS = 60_000;
const MINT = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export interface JupInfo {
  name: string | null;
  symbol: string | null;
  imageUrl: string | null;
  links: ReturnType<typeof cleanTileLinks>;
  holders: number | null;
  priceUsd: number | null;
  mcapUsd: number | null;
  liquidityUsd: number | null;
  volume24hUsd: number | null;
  change24hPct: number | null;
  /** Jupiter's measured price changes over 5 minutes, 1, 6 and 24 hours (for the lite line of a coin DexScreener has no changes for) */
  changes: PriceChanges | null;
  createdAtMs: number | null;
  atMs: number;
}

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const pos = (v: unknown): number | null => (num(v) !== null && (v as number) > 0 ? (v as number) : null);
const text = (v: unknown, max: number): string | null => (typeof v === "string" && visibleText(v) !== "" ? visibleText(v).slice(0, max) : null);

/** Jupiter's answer into clean figures by lower-case address; a row that is not a coin is dropped. */
export function parseJupiter(body: unknown, atMs: number): Map<string, JupInfo> {
  const out = new Map<string, JupInfo>();
  if (!Array.isArray(body)) return out;
  for (const r of body) {
    if (typeof r !== "object" || r === null) continue;
    const x = r as Record<string, any>;
    if (typeof x.id !== "string" || !MINT.test(x.id)) continue;
    const icon = typeof x.icon === "string" && /^https:\/\//.test(x.icon) && x.icon.length < 300 ? x.icon : null;
    const s = typeof x.stats24h === "object" && x.stats24h !== null ? x.stats24h : null;
    const buy = num(s?.buyVolume);
    const sell = num(s?.sellVolume);
    const change = num(s?.priceChange);
    const chg = (k: string): number | null => (num(x[k]?.priceChange) !== null && x[k].priceChange > -100 ? x[k].priceChange : null);
    const changes: PriceChanges = { m5: chg("stats5m"), h1: chg("stats1h"), h6: chg("stats6h"), h24: chg("stats24h") };
    const created = typeof x.firstPool?.createdAt === "string" ? Date.parse(x.firstPool.createdAt) : typeof x.createdAt === "string" ? Date.parse(x.createdAt) : NaN;
    out.set(x.id.toLowerCase(), {
      name: text(x.name, 60),
      symbol: text(x.symbol, 24),
      imageUrl: icon,
      links: cleanTileLinks({ x: x.twitter, telegram: x.telegram, website: x.website }),
      holders: num(x.holderCount) !== null && x.holderCount >= 0 ? x.holderCount : null,
      priceUsd: pos(x.usdPrice),
      mcapUsd: pos(x.mcap),
      liquidityUsd: num(x.liquidity) !== null && x.liquidity >= 0 ? x.liquidity : null,
      volume24hUsd: buy !== null && sell !== null && buy + sell >= 0 ? buy + sell : null,
      change24hPct: change !== null && change > -100 ? change : null,
      changes: Object.values(changes).some((v) => v !== null) ? changes : null,
      createdAtMs: Number.isFinite(created) && created > 0 ? created : null,
      atMs,
    });
  }
  return out;
}

export class JupiterMeta {
  private info = new Map<string, JupInfo>();
  private readAt = new Map<string, number>();
  private pausedUntil = 0;
  private busy = false;
  private timer: ReturnType<typeof setInterval> | undefined;
  stat = { calls: 0, errors: 0, coins: 0 };

  constructor(
    private get: QuoteFetch,
    private now: () => number = Date.now,
    private key?: string,
  ) {}

  /** One call for the coins read longest ago (up to 100, never within FRESH_MS of their last read). Safe to call often. */
  async tick(tokens: readonly WireToken[]): Promise<void> {
    if (this.busy || this.now() < this.pausedUntil) return;
    const t = this.now();
    const due = tokens
      .filter((x) => x.chain === "solana" && !!x.address && MINT.test(x.address) && !isVamp(x))
      .map((x) => ({ a: x.address, last: this.readAt.get(x.address.toLowerCase()) ?? 0 }))
      .filter((x) => t - x.last >= FRESH_MS)
      .sort((p, q) => p.last - q.last)
      .slice(0, BATCH);
    if (!due.length) return;
    this.busy = true;
    try {
      this.stat.calls++;
      const res = await this.get(`${SEARCH_URL}?query=${due.map((x) => x.a).join(",")}`, this.key ? { "x-api-key": this.key } : undefined);
      if (res.status === 429) return void (this.pausedUntil = this.now() + REST_MS);
      if (res.status !== 200) {
        this.stat.errors++;
        this.pausedUntil = this.now() + 15_000;
        return;
      }
      const got = parseJupiter(await res.json(), this.now());
      for (const x of due) this.readAt.set(x.a.toLowerCase(), this.now()); // a coin Jupiter does not know is asked again in a minute, not at once
      for (const [k, v] of got) this.info.set(k, v);
      this.stat.coins = this.info.size;
    } catch {
      this.stat.errors++;
      this.pausedUntil = this.now() + 15_000;
    } finally {
      this.busy = false;
    }
  }

  start(getTokens: () => readonly WireToken[], everyMs = EVERY_MS): void {
    this.timer = setInterval(() => void this.tick(getTokens()), everyMs);
    this.timer.unref?.();
  }
  stop(): void {
    clearInterval(this.timer);
  }

  /** Jupiter's measured price changes for a coin, when its last answer is recent. */
  changesFor(t: Pick<WireToken, "address">): PriceChanges | null {
    const j = this.info.get(t.address.toLowerCase());
    return j && this.now() - j.atMs <= STALE_MS ? j.changes : null;
  }

  /** Jupiter's own figures for one coin from its last answer (under 10 minutes old), or null. */
  figures(x: WireToken): { price: number | null; volume: number | null; liquidity: number | null; cap: number | null; atMs: number } | null {
    if (x.chain !== "solana" || !x.address) return null;
    const j = this.info.get(x.address.toLowerCase());
    if (!j || this.now() - j.atMs > STALE_MS) return null;
    return { price: j.priceUsd, volume: j.volume24hUsd, liquidity: j.liquidityUsd, cap: j.mcapUsd, atMs: j.atMs };
  }

  /** Fill what is still empty from Jupiter's last answer for each coin; nothing already there is replaced. */
  fill(tokens: WireToken[]): WireToken[] {
    const t = this.now();
    return tokens.map((x) => {
      if (x.chain !== "solana" || !x.address || isVamp(x)) return x;
      const j = this.info.get(x.address.toLowerCase());
      if (!j || t - j.atMs > STALE_MS) return x;
      let f = x;
      const set = (patch: Partial<WireToken>): void => void (f = { ...f, ...patch });
      if (f.name === null && j.name) set({ name: j.name });
      if (f.ticker === null && j.symbol) set({ ticker: `$${j.symbol}` });
      if (f.imageUrl === null && j.imageUrl) set({ imageUrl: j.imageUrl });
      if (j.links) {
        const merged = { ...j.links, ...(f.links ?? {}) };
        if (JSON.stringify(merged) !== JSON.stringify(f.links ?? {})) set({ links: merged });
      }
      // A price that only a launchpad's launch message gave (PumpPortal, a Pump.fun record) is never refreshed by that source: a Jupiter price read after it replaces it
      // (with its market cap), so the figure is at most about a minute old, not as old as the coin.
      const launchOnly = f.quoteSource === "PumpPortal" || f.quoteSource === "Pump.fun";
      if (launchOnly && j.priceUsd !== null && (f.quoteAtMs ?? 0) < j.atMs) {
        set({ priceUsd: j.priceUsd, quoteSource: "Jupiter", quoteAtMs: j.atMs });
        if (j.mcapUsd !== null) set({ valuationUsd: j.mcapUsd, capSource: "Jupiter", capAtMs: j.atMs });
      }
      if (f.priceUsd === null && j.priceUsd !== null) {
        set({ priceUsd: j.priceUsd, quoteSource: f.quoteSource ?? "Jupiter", quoteAtMs: f.quoteAtMs ?? j.atMs });
        if (f.valuationUsd === null && j.mcapUsd !== null) set({ valuationUsd: j.mcapUsd, capSource: "Jupiter", capAtMs: j.atMs });
      }
      if (f.valuationUsd === null && j.mcapUsd !== null && f.priceUsd !== null) set({ valuationUsd: j.mcapUsd, capSource: "Jupiter", capAtMs: j.atMs });
      if (f.volume24hUsd === null && j.volume24hUsd !== null) set({ volume24hUsd: j.volume24hUsd, figSrc: { ...(f.figSrc ?? {}), volume: { source: "Jupiter", atMs: j.atMs } } });
      if (f.liquidityUsd === null && j.liquidityUsd !== null) set({ liquidityUsd: j.liquidityUsd, figSrc: { ...(f.figSrc ?? {}), liquidity: { source: "Jupiter", atMs: j.atMs } } });
      if (f.change24hPct === null && j.change24hPct !== null) set({ change24hPct: j.change24hPct });
      return f;
    });
  }
}
