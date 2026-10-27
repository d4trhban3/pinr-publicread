import { USER_AGENT, type PumpCoin, type PumpFetch, type PumpfunUniverse } from "./pumpfun.ts";

/**
 * The site's pool of new Pump.fun coins, read from GeckoTerminal's newest Solana pools (route A, the team's word of 2026-10-14; the build-or-buy page is
 * `tools/BUILD-OR-BUY-2026-10-14-coin-pool.md`). Pump.fun's own list address answers a Cloudflare challenge, which is not worked around.
 *
 * One page is 20 pools, about a minute of new pools on Solana, so a call every minute keeps up with what PumpPortal does not bring (one of the ten calls a minute the keyless service allows;
 * the market-figure reader shares that allowance, so a 429 here rests this reader for a minute). Only pools on the exchange `pump-fun` (the bonding curve) are
 * kept. A pool gives a coin's mint, its creation time, name, symbol, picture and size; the creator, links and all-time high come from the coin's own record
 * (`PumpfunUniverse` reads that one coin at a time for the coins on screen). Missing stays missing: a page that cannot be read leaves the pool as it was.
 */
const URL_NEW_POOLS = "https://api.geckoterminal.com/api/v2/networks/solana/new_pools?include=base_token,dex";
const MINT = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
/** The exchange id GeckoTerminal gives Pump.fun's bonding curve ("pumpswap" is graduated and is not this pool). */
export const BONDING_CURVE_DEX = "pump-fun";

const num = (v: unknown): number | null => {
  const n = typeof v === "string" ? Number(v) : typeof v === "number" ? v : NaN;
  return Number.isFinite(n) ? n : null;
};
const clean = (v: unknown, max: number): string => (typeof v === "string" ? visibleText(v).slice(0, max) : "");

interface Resource {
  id?: string;
  type?: string;
  attributes?: Record<string, unknown>;
  relationships?: Record<string, { data?: { id?: string; type?: string } | null }>;
}

/** One page of new pools into pool coins: bonding-curve pools only, each with a mint, a creation time and a size. Anything else in the page is skipped. */
export function parseNewPools(body: unknown, nowMs: number): PumpCoin[] {
  if (typeof body !== "object" || body === null) return [];
  const doc = body as { data?: unknown; included?: unknown };
  if (!Array.isArray(doc.data)) return [];
  const included = new Map<string, Resource>();
  if (Array.isArray(doc.included)) for (const r of doc.included as Resource[]) if (r && typeof r.id === "string" && typeof r.type === "string") included.set(`${r.type}:${r.id}`, r);
  const out: PumpCoin[] = [];
  for (const raw of doc.data as Resource[]) {
    const a = raw?.attributes;
    const rel = raw?.relationships;
    if (!a || !rel) continue;
    if (rel.dex?.data?.id !== BONDING_CURVE_DEX) continue;
    const baseRef = rel.base_token?.data;
    const token = baseRef?.id ? included.get(`token:${baseRef.id}`) : undefined;
    const ta = token?.attributes;
    const mint = typeof ta?.address === "string" ? ta.address : typeof baseRef?.id === "string" ? baseRef.id.replace(/^solana_/, "") : "";
    const created = typeof a.pool_created_at === "string" ? Date.parse(a.pool_created_at) : NaN;
    const cap = num(a.fdv_usd);
    const price = num(a.base_token_price_usd);
    if (!MINT.test(mint) || !Number.isFinite(created) || created <= 0 || cap === null || cap <= 0 || price === null || price <= 0) continue;
    const image = typeof ta?.image_url === "string" && /^https:\/\//.test(ta.image_url) && ta.image_url.length < 300 ? ta.image_url : null;
    out.push({
      mint,
      name: clean(ta?.name, 60),
      symbol: clean(ta?.symbol, 24),
      image,
      creator: null,
      createdMs: created,
      lastTradeMs: null,
      // On a bonding curve the coin's whole supply is fixed, so the fully-diluted value is its market cap.
      capUsd: cap,
      priceUsd: price,
      athCapUsd: null,
      graduated: false,
      twitter: null,
      telegram: null,
      website: null,
      seenMs: nowMs,
      // The size and price are GeckoTerminal's, read now; they are labelled so, never as Pump.fun's.
      figSource: "GeckoTerminal",
      figAtMs: nowMs,
      curve: null,
    });
  }
  return out;
}

export interface PoolStats {
  source: string;
  calls: number;
  errors: number;
  lastPools: number;
  lastOkAgeS: number | null;
  pausedForS: number;
}

const defaultGet: PumpFetch = (url) => fetch(url, { headers: { accept: "application/json", "user-agent": USER_AGENT }, signal: AbortSignal.timeout(12_000) });
import type { GeckoBudget } from "./geckobudget.ts";
import { visibleText } from "../src/world/visibletext.ts";

/** One call a minute (was two): PumpPortal brings the new coins now, and the keyless allowance is shared with the charts. */
export const POOL_EVERY_MS = 60_000;
/** After a refusal the reader rests two minutes, then twice as long for each refusal in a row (ten minutes at most); a good page resets it. */
const REST_FIRST_MS = 120_000;
const REST_MAX_MS = 600_000;

export class GeckoPools {
  private stat = { calls: 0, errors: 0, lastPools: 0, lastOkMs: 0 };
  private pausedUntil = 0;
  private lastCallMs = 0;
  private busy = false;
  private lastFailLogMs = 0;
  private strikes = 0;
  private rest(): void {
    this.strikes = Math.min(this.strikes + 1, 4);
    this.pausedUntil = this.now() + Math.min(REST_FIRST_MS * 2 ** (this.strikes - 1), REST_MAX_MS);
  }
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(
    private universe: PumpfunUniverse,
    private get: PumpFetch = defaultGet,
    private now: () => number = Date.now,
    /** the allowance shared with the chart reads: the pool's calls are recorded and never held back by it */
    private budget?: GeckoBudget,
  ) {}

  private noteFailure(what: string, body: string): void {
    const now = this.now();
    if (now - this.lastFailLogMs < 60_000) return;
    this.lastFailLogMs = now;
    console.log(`pool reader (GeckoTerminal new pools) failed: ${what}${body ? ` · ${body.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, 200)}` : ""}`);
  }

  /** One call at most every minute, and only while the shared allowance has room; a refusal rests the reader (two minutes, doubling). A page that could not be read changes nothing. */
  async tick(): Promise<void> {
    const now = this.now();
    if (this.busy || now < this.pausedUntil || now - this.lastCallMs < POOL_EVERY_MS) return;
    if (this.budget && !this.budget.backgroundMayCall()) return; // the charts keep their room
    this.busy = true;
    this.lastCallMs = now;
    this.stat.calls++;
    this.budget?.record("pools");
    try {
      const res = await this.get(URL_NEW_POOLS);
      if (res.status === 429) {
        this.budget?.refused("pools");
        this.noteFailure("HTTP 429 (rate limit)", "");
        this.rest();
        return;
      }
      if (res.status !== 200) {
        this.stat.errors++;
        this.noteFailure(`HTTP ${res.status}`, await (res.text?.() ?? Promise.resolve("")).catch(() => ""));
        this.rest();
        return;
      }
      const coins = parseNewPools(await res.json(), this.now());
      this.strikes = 0;
      this.stat.lastPools = coins.length;
      this.stat.lastOkMs = this.now();
      this.universe.ingest(coins);
    } catch (e) {
      this.stat.errors++;
      this.noteFailure(`no answer: ${e instanceof Error ? `${e.name} ${e.message}` : "unknown"}`, "");
      this.rest();
    } finally {
      this.busy = false;
    }
  }

  start(everyMs = 5000): void {
    void this.tick();
    this.timer = setInterval(() => void this.tick(), everyMs);
  }
  stop(): void {
    clearInterval(this.timer);
  }

  stats(): PoolStats {
    const now = this.now();
    return { source: "GeckoTerminal new pools", calls: this.stat.calls, errors: this.stat.errors, lastPools: this.stat.lastPools, lastOkAgeS: this.stat.lastOkMs ? Math.round((now - this.stat.lastOkMs) / 1000) : null, pausedForS: Math.max(0, Math.round((this.pausedUntil - now) / 1000)) };
  }
}
