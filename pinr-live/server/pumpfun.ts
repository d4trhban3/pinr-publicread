import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { cleanTileLinks } from "./linkview.ts";
import type { WireToken } from "./translate.ts";
import { findVamps, type Original } from "./vamp.ts";
import type { VampDesk } from "./vampdesk.ts";
import { visibleText } from "../src/world/visibletext.ts";
import { isPumpCurve } from "./pumpcurve.ts";

/**
 * Pump.fun, read directly from the launchpad: the whole stream of coins it lists, not just the ones the engine scores.
 *
 * Pump.fun's public coin list (free, no key) is read in sweeps: the NEWEST launches every few seconds so none is missed, the coins
 * with the most RECENT TRADES, and the BIGGEST by market cap. Each coin is kept as a small clean record (name, ticker, picture,
 * creator, launch time, dollar market cap and the price worked out from it, links, whether it has graduated to PumpSwap). The
 * records are held in memory (the newest/most active MAX_COINS) and saved to disk, so a restart does not begin empty.
 *
 * This is market data only. It carries no score and no opinion: a coin that is not scored by the engine simply has no score, and the app
 * shows it that way. Pump.fun's service rate-limits (about 30 requests a minute, a budget the engine shares), so the three sweeps
 * together use about 9 a minute and back off for a minute on any "too many requests".
 */
export interface PumpCoin {
  mint: string;
  name: string;
  symbol: string;
  image: string | null;
  creator: string | null;
  createdMs: number;
  lastTradeMs: number | null;
  /** dollar market cap as Pump.fun states it */
  capUsd: number;
  /** capUsd divided by the supply the record states */
  priceUsd: number;
  /** The coin's all-time-high market cap in dollars as Pump.fun's own record states it (`ath_market_cap`), when it gave one. */
  athCapUsd: number | null;
  /** Whether the coin has left the bonding curve. */
  graduated: boolean;
  twitter: string | null;
  telegram: string | null;
  website: string | null;
  seenMs: number;
  /** the coin's bonding curve account (where the chain keeps its creator), when the record gave it */
  curve: string | null;
  /** When the coin's own record was read (creator, links, all-time high, picture); absent until it has been. */
  recordAtMs?: number;
  /** Whose figures `capUsd` and `priceUsd` are, and when they were read: Pump.fun's own record, or GeckoTerminal's pool. Absent means Pump.fun's, read at `seenMs` (older saved coins). */
  figSource?: FigSource;
  figAtMs?: number;
  /** Which launchpad made the coin, when PumpPortal said so ("bonk" = bonk.fun on Raydium LaunchLab). Absent means Pump.fun (every other source here is Pump.fun's). */
  launchpad?: "pump" | "bonk";
}

/** PumpPortal's figure is its market cap in SOL at creation, shown in dollars with DexScreener's SOL price (pumpportal.ts). */
export type FigSource = "Pump.fun" | "GeckoTerminal" | "PumpPortal";
/** The true source and read time of a coin's market cap and price (every figure carries its own). */
export const figOf = (c: PumpCoin): { source: FigSource; atMs: number } => ({ source: c.figSource ?? "Pump.fun", atMs: c.figAtMs ?? c.seenMs });

export type PumpFetch = (url: string) => Promise<{ status: number; json(): Promise<unknown>; text?(): Promise<string> }>;
const BASE = "https://frontend-api-v3.pump.fun/coins";
const RECORD_BASE = "https://frontend-api-v3.pump.fun/coins-v2";
/** One coin's own record at most every 10 s (6 a minute: Pump.fun's coin service is shared with the engine scanner and the quote layer). */
export const RECORD_EVERY_MS = 10_000;
/** A record read is kept this long before the coin is read again (its all-time high moves slowly). */
export const RECORD_FRESH_MS = 30 * 60_000;
export const MAX_COINS = 5000;
/** Pump.fun turns away the bare default client name of Node with "too many requests"; an honest name of our own is accepted. */
export const USER_AGENT = "PINR-live/1.0 (read-only market data)";
const defaultGet: PumpFetch = (url) => fetch(url, { headers: { accept: "application/json", "user-agent": USER_AGENT }, signal: AbortSignal.timeout(12_000) });

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const text = (v: unknown, max: number): string | null => (typeof v === "string" && visibleText(v) !== "" ? visibleText(v).slice(0, max) : null);
const link = (v: unknown): string | null => {
  const s = text(v, 300);
  if (!s) return null;
  try {
    const u = new URL(s);
    return u.protocol === "https:" || u.protocol === "http:" ? u.toString() : null;
  } catch {
    return null;
  }
};

/** One raw list row into a clean coin, or null when it is not a usable coin (no price is ever made up). */
export function cleanCoin(raw: unknown, now: number): PumpCoin | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  const mint = typeof r.mint === "string" && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(r.mint) ? r.mint : null;
  const cap = num(r.usd_market_cap) ?? num(r.market_cap_usd);
  const supply = num(r.total_supply);
  const dec = num(r.base_decimals);
  const created = num(r.created_timestamp);
  if (!mint || cap === null || cap <= 0 || supply === null || supply <= 0 || dec === null || dec < 0 || dec > 12 || created === null || created <= 0) return null;
  if (r.is_banned === true) return null;
  const price = cap / (supply / 10 ** dec);
  if (!Number.isFinite(price) || price <= 0) return null;
  const image = typeof r.image_uri === "string" && /^https:\/\//.test(r.image_uri) && r.image_uri.length < 300 ? r.image_uri : null;
  const last = num(r.last_trade_timestamp);
  return {
    mint,
    name: text(r.name, 60) ?? "",
    symbol: text(r.symbol, 24) ?? "",
    image,
    creator: typeof r.creator === "string" && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(r.creator) ? r.creator : null,
    createdMs: created,
    lastTradeMs: last !== null && last > 0 ? last : null,
    capUsd: cap,
    priceUsd: price,
    athCapUsd: (() => { const a = num(r.ath_market_cap); return a !== null && a > 0 ? a : null; })(),
    graduated: r.complete === true,
    twitter: link(r.twitter),
    telegram: link(r.telegram),
    website: link(r.website),
    seenMs: now,
    figSource: "Pump.fun",
    figAtMs: now,
    curve: typeof r.bonding_curve === "string" && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(r.bonding_curve) ? r.bonding_curve : null,
  };
}

type Sweep = { id: "new" | "active" | "top"; query: string; everyMs: number };
const SWEEPS: Sweep[] = [
  { id: "new", query: "limit=70&sort=created_timestamp&order=DESC&includeNsfw=false", everyMs: 12_000 },
  { id: "active", query: "limit=70&sort=last_trade_timestamp&order=DESC&includeNsfw=false", everyMs: 20_000 },
  { id: "top", query: "limit=70&sort=market_cap&order=DESC&includeNsfw=false", everyMs: 60_000 },
];

export class PumpfunUniverse {
  private coins = new Map<string, PumpCoin>();
  private last = new Map<string, number>();
  private pausedUntil = 0;
  private busy = false;
  private dirty = false;
  private stat = { calls: 0, errors: 0, newest: 0 };
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(
    private get: PumpFetch = defaultGet,
    private now: () => number = Date.now,
  ) {}

  private lastFailLogMs = 0;
  /** Pump.fun's own list address answers a Cloudflare challenge (2026-10-14), so the list sweeps are off; the pool comes from GeckoTerminal (geckopools.ts). PINR_PUMPFUN_LIST=on turns them back on. */
  listSweepsOn = process.env.PINR_PUMPFUN_LIST === "on";
  /** Coins read by their own record that are not in the pool (the scored coins on screen), and when each coin was last read. */
  private records = new Map<string, PumpCoin>();
  private recordRead = new Map<string, number>();
  private wanted: string[] = [];
  private lastRecordMs = 0;
  private recordBusy = false;
  private recordPausedUntil = 0;
  private recordStat = { calls: 0, errors: 0 };
  /** Say, at most once a minute, what Pump.fun's list call answered when it did not give coins: the status and the first 200 characters, control characters dropped. No address or key is in either. */
  private noteFailure(sweep: string, what: string, body: string): void {
    const now = this.now();
    if (now - this.lastFailLogMs < 60_000) return;
    this.lastFailLogMs = now;
    console.log(`pumpfun list call ${sweep} failed: ${what}${body ? ` · ${body.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, 200)}` : ""}`);
  }

  /** One round: at most one sweep, the one most overdue. Safe to call often. */
  async tick(): Promise<void> {
    await this.recordTick();
    if (!this.listSweepsOn) return;
    if (this.busy || this.now() < this.pausedUntil) return;
    const now = this.now();
    const due = SWEEPS.filter((s) => now - (this.last.get(s.id) ?? 0) >= s.everyMs).sort((a, b) => (this.last.get(a.id) ?? 0) - (this.last.get(b.id) ?? 0))[0];
    if (!due) return;
    this.busy = true;
    this.last.set(due.id, now);
    this.stat.calls++;
    try {
      const res = await this.get(`${BASE}?${due.query}`);
      if (res.status === 429) {
        this.noteFailure(due.id, "HTTP 429 (rate limit)", "");
        return void (this.pausedUntil = this.now() + 60_000);
      }
      if (res.status !== 200) {
        this.stat.errors++;
        this.noteFailure(due.id, `HTTP ${res.status}`, await (res.text?.() ?? Promise.resolve("")).catch(() => ""));
        this.pausedUntil = this.now() + 15_000;
        return;
      }
      const rows = await res.json();
      if (!Array.isArray(rows)) {
        this.noteFailure(due.id, "HTTP 200 but not a list", JSON.stringify(rows) ?? "");
        throw new Error("not a list");
      }
      for (const row of rows) {
        const c = cleanCoin(row, this.now());
        if (!c) continue;
        this.coins.set(c.mint, c);
        if (c.createdMs > this.stat.newest) this.stat.newest = c.createdMs;
      }
      this.dirty = true;
      this.trim();
    } catch (e) {
      this.stat.errors++;
      this.noteFailure(due.id, `no answer: ${e instanceof Error ? `${e.name} ${e.message}` : "unknown"}`, "");
      this.pausedUntil = this.now() + 15_000;
    } finally {
      this.busy = false;
    }
  }

  /** Coins from a pool source: new ones join, known ones get their size and price refreshed, and nothing the coin's own record gave is thrown away. */
  ingest(fresh: readonly PumpCoin[]): void {
    for (const c of fresh) {
      const had = this.coins.get(c.mint);
      // A pool page never overwrites figures Pump.fun's own record gave: those keep their source and read time (the record refreshes them). Only a coin
      // still holding the pool's own figures takes the newer ones, each with its source and the time it was read.
      const theirs = had && figOf(had).source === "Pump.fun";
      this.coins.set(c.mint, had ? { ...had, ...(theirs ? {} : { capUsd: c.capUsd, priceUsd: c.priceUsd, figSource: figOf(c).source, figAtMs: figOf(c).atMs }), seenMs: c.seenMs, image: had.image ?? c.image, name: had.name || c.name, symbol: had.symbol || c.symbol, creator: had.creator ?? c.creator, curve: had.curve ?? c.curve, ...(had.launchpad ?? c.launchpad ? { launchpad: had.launchpad ?? c.launchpad } : {}) } : c);
      if (c.createdMs > this.stat.newest) this.stat.newest = c.createdMs;
    }
    this.dirty = true;
    this.trim();
  }

  /** A graduation PumpPortal reported: a held coin has left its curve (nothing is added for a coin not held). */
  graduate(mint: string): void {
    const had = this.coins.get(mint);
    if (!had || had.graduated) return;
    this.coins.set(mint, { ...had, graduated: true });
    this.dirty = true;
  }

  /** The coins the page is showing, most important first (the server calls this each time it builds the list); their own records are read in this order. */
  want(mints: readonly string[]): void {
    this.wanted = [...new Set(mints)].slice(0, 150);
  }

  /** One coin's own record, one at a time, for the coins on screen first and then the newest in the pool: gives the creator, links, picture and all-time high. */
  async recordTick(): Promise<void> {
    const now = this.now();
    if (this.recordBusy || now < this.recordPausedUntil || now - this.lastRecordMs < RECORD_EVERY_MS) return;
    const fresh = (m: string): boolean => now - (this.recordRead.get(m) ?? 0) < RECORD_FRESH_MS;
    const mint = [...this.wanted, ...this.list("new", 60, 0).filter((c) => c.launchpad !== "bonk").map((c) => c.mint)].find((m) => !fresh(m) && this.coins.get(m)?.launchpad !== "bonk");
    if (!mint) return;
    this.recordBusy = true;
    this.lastRecordMs = now;
    this.recordRead.set(mint, now); // asked once even when the answer is poor: it is not asked again for a while
    this.recordStat.calls++;
    try {
      const res = await this.get(`${RECORD_BASE}/${mint}`);
      if (res.status === 429) {
        this.recordRead.delete(mint);
        this.recordPausedUntil = this.now() + 60_000;
        return;
      }
      if (res.status !== 200) {
        if (res.status !== 404) {
          this.recordStat.errors++;
          this.recordRead.delete(mint);
          this.recordPausedUntil = this.now() + 15_000;
        }
        return;
      }
      const c = cleanCoin(await res.json(), this.now());
      if (!c || c.mint !== mint) return;
      const full: PumpCoin = { ...c, recordAtMs: this.now() };
      if (this.coins.has(mint)) {
        const had = this.coins.get(mint)!;
        this.coins.set(mint, { ...had, ...full, createdMs: had.createdMs || full.createdMs });
      } else this.records.set(mint, full);
      this.dirty = true;
    } catch {
      this.recordStat.errors++;
      this.recordRead.delete(mint);
      this.recordPausedUntil = this.now() + 15_000;
    } finally {
      this.recordBusy = false;
      // Records of coins no longer on screen are not kept forever.
      if (this.records.size > 600) for (const k of [...this.records.keys()].slice(0, this.records.size - 600)) this.records.delete(k);
    }
  }

  /** Keep the newest and most active MAX_COINS; the ones not seen for the longest go first. */
  private trim(): void {
    if (this.coins.size <= MAX_COINS) return;
    const order = [...this.coins.values()].sort((a, b) => b.seenMs - a.seenMs || b.capUsd - a.capUsd);
    for (const c of order.slice(MAX_COINS)) this.coins.delete(c.mint);
  }

  start(everyMs = 2000): void {
    this.timer = setInterval(() => void this.tick(), everyMs);
  }
  stop(): void {
    clearInterval(this.timer);
  }

  get size(): number {
    return this.coins.size;
  }
  coin(mint: string): PumpCoin | undefined {
    return this.coins.get(mint);
  }
  /** How many held coins each creator has made. */
  private creatorCounts(): Map<string, number> {
    const n = new Map<string, number>();
    for (const c of this.coins.values()) if (c.creator) n.set(c.creator, (n.get(c.creator) ?? 0) + 1);
    return n;
  }

  /**
   * The VAMP gate: which held coins copy an earlier coin's picture (see vamp.ts). Every coin held is judged, not only the ones in the pool,
   * so an original is found even when it has dropped out of the lists.
   */
  /** The VAMP desk (picture matching and the chain check). Without one, only the same-file rule runs. */
  desk: VampDesk | null = null;

  /** Every coin held (for the desk's background work). */
  all(): PumpCoin[] {
    return [...this.coins.values()];
  }

  vamps(scored: readonly WireToken[] = []): Map<string, Original> {
    if (this.desk) return this.desk.judge(this.all(), scored).verdicts;
    const launches = [...this.coins.values()].map((c) => ({ id: c.mint, ticker: c.symbol ? dollar(c.symbol) : c.name, image: c.image, creator: c.creator, createdMs: c.createdMs }));
    const elsewhere = scored
      .filter((t) => t.chain !== "solana" && t.imageUrl && t.launchedAtMs !== null && t.noScoreLabel !== "VAMP")
      .map((t) => ({ id: t.address, ticker: t.ticker ?? t.name ?? t.address, image: t.imageUrl, launchedMs: t.launchedAtMs! }));
    return findVamps(launches, elsewhere);
  }

  /** A coin looked up by its lower-cased address (the app lower-cases addresses in requests). */
  tokenByLower(mintLower: string, scored: readonly WireToken[] = []): WireToken | undefined {
    for (const c of this.coins.values()) if (c.mint.toLowerCase() === mintLower) return coinToken(c, this.vamps(scored).get(c.mint), c.creator ? (this.creatorCounts().get(c.creator) ?? 0) : 0);
    return undefined;
  }

  /** A page of coins: "new" (newest launches), "active" (latest trade) or "top" (biggest). A coin not seen for 30 minutes is not listed. "pump" leaves out bonk.fun's coins. */
  list(sort: "new" | "active" | "top", limit: number, offset: number, pads: "all" | "pump" = "all"): PumpCoin[] {
    const fresh = [...this.coins.values()].filter((c) => this.now() - c.seenMs < 30 * 60_000 && (pads === "all" || c.launchpad !== "bonk"));
    const key = sort === "new" ? (c: PumpCoin) => c.createdMs : sort === "active" ? (c: PumpCoin) => c.lastTradeMs ?? 0 : (c: PumpCoin) => c.capUsd;
    fresh.sort((a, b) => key(b) - key(a));
    return fresh.slice(Math.max(0, offset), Math.max(0, offset) + Math.min(200, Math.max(1, limit)));
  }

  /** the launchpad's own price and market cap for one coin, signed by who gave it (PumpPortal's stream or Pump.fun's record), or null. */
  figures(t: WireToken): { source: "pumpportal" | "pumpfun" | "geckoterminal"; price: number | null; cap: number | null; atMs: number } | null {
    if (t.chain !== "solana" || !t.address) return null;
    const c = this.coins.get(t.address) ?? this.records.get(t.address);
    if (!c) return null;
    const readAt = c.recordAtMs ?? c.seenMs;
    if (this.now() - (this.coins.has(t.address) ? c.seenMs : readAt) > (this.coins.has(t.address) ? 10 * 60_000 : RECORD_FRESH_MS)) return null;
    const fig = figOf(c);
    return { source: fig.source === "PumpPortal" ? "pumpportal" : fig.source === "GeckoTerminal" ? "geckoterminal" : "pumpfun", price: c.priceUsd > 0 ? c.priceUsd : null, cap: c.capUsd > 0 ? c.capUsd : null, atMs: fig.atMs };
  }

  /** For roster tokens the other sources left without a price or picture: fill from the launchpad's own record. Never replaces a value. */
  fill(tokens: WireToken[]): WireToken[] {
    return tokens.map((t) => {
      if (t.chain !== "solana" || !t.address) return t;
      const c = this.coins.get(t.address) ?? this.records.get(t.address);
      if (!c) return t;
      // A pool coin is current for 10 minutes; a coin read only by its own record (a scored coin on screen) for as long as that read is kept.
      const readAt = c.recordAtMs ?? c.seenMs;
      if (this.now() - (this.coins.has(t.address) ? c.seenMs : readAt) > (this.coins.has(t.address) ? 10 * 60_000 : RECORD_FRESH_MS)) return t;
      const f = { ...t };
      if (f.priceUsd === null) {
        f.priceUsd = c.priceUsd;
        const fig = figOf(c);
        if (f.quoteSource === undefined) {
          f.quoteSource = fig.source;
          f.quoteAtMs = fig.atMs;
        }
        // The price is this source's, so the market cap beside it is too (one source), not the engine's older figure.
        if (c.capUsd > 0) {
          f.valuationUsd = c.capUsd;
          f.capSource = fig.source;
          f.capAtMs = fig.atMs;
        }
      }
      if (f.imageUrl === null && c.image) f.imageUrl = c.image;
      // The all-time-high market cap, with its receipt: only where Pump.fun's own record states it (a dash otherwise; nothing is derived or guessed).
      if (typeof c.athCapUsd === "number" && c.athCapUsd > 0) {
        f.athUsd = c.athCapUsd;
        f.athSource = "Pump.fun";
        f.athAtMs = c.recordAtMs ?? c.seenMs;
      }
      // The coin's last trade, where Pump.fun's own list or record states it and nothing fresher is held (a scored coin used to show none).
      if (f.lastTradeMs === null && c.lastTradeMs !== null) f.lastTradeMs = c.lastTradeMs;
      // The coin's own links as its launchpad record states them, where the feed file has none.
      if (!f.links) {
        const l = cleanTileLinks({ x: c.twitter, telegram: c.telegram, website: c.website });
        if (l) f.links = l;
      }
      return f.priceUsd === t.priceUsd && f.imageUrl === t.imageUrl && f.athUsd === undefined && f.lastTradeMs === t.lastTradeMs && f.links === t.links ? t : f;
    });
  }

  /**
   * The coins to add to the app's pool: the newest, the most recently traded and the biggest, minus anything the engine already
   * has (those keep their engine record). Each becomes a token with NO score (`score: null`, coverage 0): market data only.
   */
  poolTokens(skip: ReadonlySet<string>, scored: readonly WireToken[] = [], perList = 120): WireToken[] {
    const seen = new Set<string>();
    const out: WireToken[] = [];
    const copies = this.vamps(scored);
    const perCreator = this.creatorCounts();
    for (const how of ["new", "active", "top"] as const) {
      for (const c of this.list(how, perList, 0)) {
        if (seen.has(c.mint) || skip.has(c.mint.toLowerCase())) continue;
        seen.add(c.mint);
        out.push(coinToken(c, copies.get(c.mint), c.creator ? (perCreator.get(c.creator) ?? 0) : 0));
      }
    }
    return out;
  }

  /** The addresses (lower-cased) of the coins on the app's pool lists: newest, most recently traded and biggest. */
  poolMints(perList = 120): Set<string> {
    const out = new Set<string>();
    for (const how of ["new", "active", "top"] as const) for (const c of this.list(how, perList, 0)) out.add(c.mint.toLowerCase());
    return out;
  }

  stats(): { coins: number; calls: number; errors: number; newestLaunchAgeS: number | null; pausedForS: number; records: number; recordCalls: number; recordErrors: number } {
    const now = this.now();
    return { records: this.records.size, recordCalls: this.recordStat.calls, recordErrors: this.recordStat.errors, coins: this.coins.size, calls: this.stat.calls, errors: this.stat.errors, newestLaunchAgeS: this.stat.newest ? Math.max(0, Math.round((now - this.stat.newest) / 1000)) : null, pausedForS: Math.max(0, Math.round((this.pausedUntil - now) / 1000)) };
  }

  saveTo(file: string): void {
    if (!this.dirty) return;
    this.dirty = false;
    try {
      mkdirSync(dirname(file), { recursive: true });
      const tmp = `${file}.tmp`;
      writeFileSync(tmp, JSON.stringify({ v: 1, coins: [...this.coins.values()], records: [...this.records.values()] }));
      renameSync(tmp, file);
    } catch {
      /* a failed save only means a slower start next time */
    }
  }

  /** Restore saved coins younger than an hour. Returns how many. */
  loadFrom(file: string): number {
    try {
      if (!existsSync(file)) return 0;
      const doc = JSON.parse(readFileSync(file, "utf8")) as { v?: number; coins?: unknown };
      if (doc.v !== 1 || !Array.isArray(doc.coins)) return 0;
      let n = 0;
      for (const c of (doc as { records?: unknown }).records instanceof Array ? ((doc as { records: PumpCoin[] }).records) : []) {
        if (c && typeof c.mint === "string" && typeof c.recordAtMs === "number" && this.now() - c.recordAtMs < RECORD_FRESH_MS && Number.isFinite(c.priceUsd) && c.priceUsd > 0) {
          if (this.records.has(c.mint)) continue; // learned live since the start: newer than the saved copy
          this.records.set(c.mint, c);
          this.recordRead.set(c.mint, c.recordAtMs);
        }
      }
      for (const c of doc.coins as PumpCoin[]) {
        if (c && typeof c.mint === "string" && typeof c.seenMs === "number" && this.now() - c.seenMs < 60 * 60_000 && Number.isFinite(c.priceUsd) && c.priceUsd > 0) {
          if (this.coins.has(c.mint)) continue;
          // A saved PumpPortal create whose curve is not the mint's own was not that coin's launch (PUMP as "Mega Jack", 2026-10-25): left out.
          if (c.figSource === "PumpPortal" && c.launchpad !== "bonk" && !(c.curve && isPumpCurve(c.mint, c.curve))) continue;
          this.coins.set(c.mint, c);
          n++;
        }
      }
      return n;
    } catch {
      return 0;
    }
  }
}

/** A creator with this many coins on the launchpad's lists at once is called a serial launcher (the count is shown, so the reader can judge). */
export const SERIAL_AT = 5;

/** What the picture desk found, in plain words and without calling it a copy: which coin the picture matches, how, and what the chain showed. */
export function vampNote(o: Original): string {
  const how = o.basis === "near match" ? "a near match of the picture" : "the same picture file";
  const chain = o.chain === "confirmed" ? "the chain shows a different creator wallet" : "chain not read yet";
  return `Picture matches ${o.ticker} (${how}; ${chain})`;
}

/** A ticker with exactly one leading dollar sign. */
const dollar = (sym: string): string => (sym.startsWith("$") ? sym : `$${sym}`);

/** A launchpad coin as a pool token. It has no PINRscore (the engine has not scored it): the app shows a dash, never a made-up number. */
export function coinToken(c: PumpCoin, copyOf?: Original, creatorCoins = 0): WireToken {
  // until the picture matcher has been inspected, a coin it calls a copy is only a "possible copy". It keeps its
  // price, chart and picture like any other coin; the note says how it matched and whether the chain agreed, and it carries a link to the original.
  if (copyOf) {
    const plain = coinToken(c, undefined, creatorCoins);
    return { ...plain, note: `${plain.note}; ${vampNote(copyOf)}`, possibleCopyOf: { address: copyOf.id, ticker: copyOf.ticker, proof: copyOf.chain === "confirmed" ? "chain" : "unchecked" } };
  }
  return {
    address: c.mint,
    chain: "solana",
    launchpad: c.launchpad === "bonk" ? (c.graduated ? "bonk.fun (graduated)" : "bonk.fun LaunchLab curve") : c.graduated ? "PumpSwap (graduated)" : "Pump.fun curve",
    name: c.name || null,
    ticker: c.symbol ? dollar(c.symbol) : null,
    imageUrl: c.image,
    score: null,
    coverage: 0,
    noScoreLabel: null,
    note: creatorCoins >= SERIAL_AT ? `Not scored yet; Serial launcher (${creatorCoins} coins seen)` : "Not scored yet",
    valuationUsd: c.capUsd,
    quoteSource: figOf(c).source,
    quoteAtMs: figOf(c).atMs,
    capSource: figOf(c).source,
    capAtMs: figOf(c).atMs,
    volume24hUsd: null,
    change24hPct: null,
    priceSeries: null,
    launchedAtMs: c.createdMs,
    asOfMs: c.seenMs,
    rank: null,
    priceUsd: c.priceUsd,
    liquidityUsd: null,
    quotePair: null,
    changeWindowH: null,
    priceSource: figOf(c).source,
    flow: null,
    lastTradeMs: c.lastTradeMs,
  };
}
