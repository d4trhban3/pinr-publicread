import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DROP_DIR } from "./feed.ts";
import type { Evidence } from "./evidence.ts";

/**
 * a coin's pool events as the engine reads them on chain (`frontend-feed/pools/<mint>.json`, contract `pool-events-1`, the engine's
 * board line): pool created, liquidity added and removed, the coin creator changed, bought back and burned. Each is an observed fact (●) with its
 * transaction as the receipt. Only the fields named here reach the page, each checked; a field the engine did not read is absent, never zero.
 * No file: not checked yet. A file with no events: no pool events observed.
 */
export const POOL_CONTRACT = "pool-events-1";
export const POOL_KINDS = ["pool created", "liquidity added", "liquidity removed", "coin creator changed", "bought back and burned"] as const;
export type PoolKind = (typeof POOL_KINDS)[number];
/** At most this many events reach the page (newest first); the file keeps 500. */
export const POOL_SHOWN = 100;

export interface PoolEvent {
  atMs: number;
  kind: PoolKind;
  /** the transaction (the receipt): a Solana signature, or a 0x hash on BNB and Base */
  sig: string;
  user?: string;
  /** coin tokens and quote coin in the event; `raw`: in raw units, the decimals not read */
  base?: number;
  quote?: number;
  quoteSymbol: string;
  raw: boolean;
  /** the reserves the event states */
  poolBase?: number;
  poolQuote?: number;
  oldCreator?: string;
  newCreator?: string;
}
export interface PoolEvents {
  /** "none": no file (not checked yet); "read": the file was read (events may be empty: none observed) */
  state: "none" | "read";
  source: string | null;
  asOfMs: number | null;
  /** where the events happened; "solana" unless the file says "bnb" ("bsc" is read the same) or "base" */
  chain: "solana" | "bnb" | "base";
  events: PoolEvent[];
}

const MINT = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const EVM_ADDR = /^0x[0-9a-f]{40}$/;
const SIG = /^[1-9A-HJ-NP-Za-km-z]{64,90}$/;
const EVM_SIG = /^0x[0-9a-f]{64}$/;
const QUOTES: Record<string, string> = {
  So11111111111111111111111111111111111111112: "SOL",
  EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v: "USDC",
  Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB: "USDT",
  USD1ttGY1N17NEEHLmELoaybftRBUSErhqYiQzvEmuB: "USD1",
};
const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : undefined);
const wallet = (v: unknown): string | undefined => (typeof v === "string" && (MINT.test(v) || EVM_ADDR.test(v)) ? v : undefined);
const quoteSymbol = (m: unknown): string => (typeof m === "string" && QUOTES[m]) || (typeof m === "string" && (MINT.test(m) || EVM_ADDR.test(m)) ? `${m.slice(0, 4)}…${m.slice(-4)}` : "the quote coin");

/** One file's events, checked and newest first; null when it is not a pool-events-1 file of this coin. */
export function parsePoolEvents(doc: unknown, mint: string): PoolEvents | null {
  if (typeof doc !== "object" || doc === null) return null;
  const d = doc as Record<string, unknown>;
  if (d.contract !== POOL_CONTRACT || typeof d.mint !== "string" || d.mint !== mint || !Array.isArray(d.events)) return null;
  const chain = d.chain === "bnb" || d.chain === "bsc" ? "bnb" : d.chain === "base" ? "base" : "solana";
  const sigOk = (v: string): boolean => SIG.test(v) || EVM_SIG.test(v); // either shape; a row fitting neither is dropped
  const asOf = typeof d.as_of === "string" ? Date.parse(d.as_of) : NaN;
  const out: PoolEvent[] = [];
  for (const x of d.events) {
    if (typeof x !== "object" || x === null) continue;
    const e = x as Record<string, unknown>;
    const atMs = num(e.t);
    if (atMs === undefined || typeof e.sig !== "string" || !sigOk(e.sig) || !POOL_KINDS.includes(e.kind as PoolKind)) continue;
    const ev: PoolEvent = { atMs, kind: e.kind as PoolKind, sig: e.sig, quoteSymbol: quoteSymbol(e.quote_mint), raw: e.raw === true };
    const set = <K extends keyof PoolEvent>(k: K, v: PoolEvent[K] | undefined): void => void (v !== undefined && (ev[k] = v));
    set("user", wallet(e.user));
    set("base", num(e.base));
    set("quote", num(e.quote));
    set("poolBase", num(e.pool_base));
    set("poolQuote", num(e.pool_quote));
    set("oldCreator", wallet(e.old_coin_creator));
    set("newCreator", wallet(e.new_coin_creator) ?? wallet(e.coin_creator));
    out.push(ev);
  }
  out.sort((a, b) => b.atMs - a.atMs);
  return { state: "read", source: typeof d.source === "string" ? d.source.slice(0, 60) : null, asOfMs: Number.isFinite(asOf) ? asOf : null, chain, events: out.slice(0, POOL_SHOWN) };
}

/** A coin's pool events from the engine's folder; `{state: "none"}` when there is no file (or it cannot be read). */
export function readPoolEvents(mint: string, dir = join(DROP_DIR, "pools")): PoolEvents {
  const none: PoolEvents = { state: "none", source: null, asOfMs: null, chain: "solana", events: [] };
  if (!MINT.test(mint) && !EVM_ADDR.test(mint)) return none;
  try {
    return parsePoolEvents(JSON.parse(readFileSync(join(dir, `${mint}.json`), "utf8")), mint) ?? none;
  } catch {
    return none;
  }
}

/** A pool fact from the coin's evidence file (the Base and BNB coins have no pool-events file; their pool facts are evidence rows). */
export interface PoolRow {
  what: string;
  /** a plain number or word, with its unit; null when the row states none */
  value: string | number | boolean | null;
  unit: string | null;
  source: string | null;
  onchain: boolean;
  /** the receipt, when the row has one */
  link: string | null;
  readMs: number | null;
}
const POOL_WHAT = /pool|liquidity/i;
/** The evidence rows about the pool (to a pool, or named for the pool or its liquidity), as the engine wrote them; missing stays missing. */
export function poolRowsOf(ev: Evidence | null): PoolRow[] {
  if (!ev) return [];
  return ev.rows
    .filter((r) => r.to.kind === "pool" || POOL_WHAT.test(r.what))
    .slice(0, 20)
    .map((r) => ({
      what: r.what,
      value: r.value !== null && typeof r.value !== "object" ? r.value : null,
      unit: r.unit,
      source: r.source,
      onchain: r.onchain,
      link: r.link,
      readMs: r.readMs,
    }));
}
