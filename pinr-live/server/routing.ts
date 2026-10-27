import { readFileSync } from "node:fs";
import type { WireToken } from "./translate.ts";

/**
 * a design decision phase 2, the feed's half: the operator's wires choose which source fills a coin's price, 24-hour volume and liquidity, which source
 * the chart's candles come from first, and whether Pump.fun's coins are discovered at all. the engine's control service writes `control/routing.json`
 * (`{version, routing: {routes: {field: [source, ...] top wire first}, discovery: {launchpad: bool}}}`); this reads it live.
 *
 * Today's behaviour stands until the operator changes a field: a field whose order is the catalog's own default (or no file at all) is filled exactly
 * as before. Only a field the operator REORDERED is filled by its order: the first source in it that has a figure fills it, with that source's receipt;
 * a source he took off is never used for it; and when none of his sources has the figure it is a dash (missing stays missing; the engine's own
 * score-time figure is not one of the sources he chose).
 */
export const SOURCES = ["pumpportal", "jupiter", "dexscreener", "geckoterminal", "pumpfun", "tape"] as const;
export type SourceId = (typeof SOURCES)[number];
export const FEED_FIELDS = ["price", "volume", "liquidity", "candles"] as const;
export type FeedField = (typeof FEED_FIELDS)[number];
/** The receipt each source signs its figures with on the coin page (the names the feed already uses). */
export const LABEL: Record<SourceId, string> = { pumpportal: "PumpPortal", jupiter: "Jupiter", dexscreener: "DexScreener", geckoterminal: "GeckoTerminal", pumpfun: "Pump.fun", tape: "PINR tape" };

/** One source's current figures for one coin; a figure it does not have is absent or null. */
export interface Figure {
  price?: number | null;
  volume?: number | null;
  liquidity?: number | null;
  /** the market cap beside its price (one source, one read) */
  cap?: number | null;
  atMs: number;
}
export type Figures = Partial<Record<SourceId, Figure>>;

export interface Routing {
  version: number | null;
  /** Only the fields the operator reordered (their order differs from the catalog's default). */
  orders: Partial<Record<FeedField, SourceId[]>>;
  /** Pump.fun and PumpSwap coins discovered (the app's pool). */
  pumpfunOn: boolean;
}
export const TODAY: Routing = { version: null, orders: {}, pumpfunOn: true };

type Catalog = { fields?: Record<string, { sources?: unknown; default?: unknown }>; discovery?: Record<string, { default?: unknown }> };
const sameOrder = (a: readonly string[], b: readonly string[]): boolean => a.length === b.length && a.every((x, i) => x === b[i]);

/** The file's routing, checked against the catalog: an order is used only when every source in it is one the field may use, none twice, at least one. */
export function routingFrom(raw: unknown, catalog: Catalog): Routing {
  if (typeof raw !== "object" || raw === null) return TODAY;
  const doc = raw as { version?: unknown; routing?: { routes?: unknown; discovery?: unknown } };
  const r = doc.routing && typeof doc.routing === "object" ? doc.routing : null;
  if (!r) return TODAY;
  const orders: Routing["orders"] = {};
  const routes = r.routes && typeof r.routes === "object" ? (r.routes as Record<string, unknown>) : {};
  for (const f of FEED_FIELDS) {
    const entry = catalog.fields?.[f];
    const allowed = Array.isArray(entry?.sources) ? (entry!.sources as string[]) : [];
    const def = Array.isArray(entry?.default) ? (entry!.default as string[]) : [];
    const list = routes[f];
    if (!Array.isArray(list) || !list.length || new Set(list).size !== list.length) continue;
    if (!list.every((s) => typeof s === "string" && allowed.includes(s) && (SOURCES as readonly string[]).includes(s))) continue;
    if (sameOrder(list as string[], def)) continue; // the default: today's behaviour
    orders[f] = list as SourceId[];
  }
  const disc = r.discovery && typeof r.discovery === "object" ? (r.discovery as Record<string, unknown>) : {};
  return { version: typeof doc.version === "number" ? doc.version : null, orders, pumpfunOn: disc.pumpfun !== false };
}

/** The routing as the control service last wrote it, read again at most every 10 seconds; no file or a bad one is today's behaviour. */
export function routingReader(routingPath: string, catalogPath: string, readMs = 10_000): (nowMs?: number) => Routing {
  let at = -Infinity;
  let cur = TODAY;
  let catalog: Catalog | null = null;
  return (nowMs = Date.now()) => {
    if (nowMs - at < readMs) return cur;
    at = nowMs;
    try {
      catalog ??= JSON.parse(readFileSync(catalogPath, "utf8")) as Catalog;
      cur = routingFrom(JSON.parse(readFileSync(routingPath, "utf8")), catalog);
    } catch {
      cur = TODAY;
    }
    return cur;
  };
}

const usable = (v: number | null | undefined): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0;

/** One coin with its reordered fields filled by the operator's order. A field he did not reorder is left exactly as it came. */
export function routeToken(t: WireToken, figs: Figures, routing: Routing): WireToken {
  const { price, volume, liquidity } = routing.orders;
  if (!price && !volume && !liquidity) return t;
  const f: WireToken = { ...t };
  const src: NonNullable<WireToken["figSrc"]> = { ...(t.figSrc ?? {}) };
  const first = (order: SourceId[], get: (x: Figure) => number | null | undefined) => {
    for (const s of order) {
      const x = figs[s];
      const v = x ? get(x) : undefined;
      if (usable(v) && (get !== priceOf || v > 0)) return { s, v, x: x! };
    }
    return null;
  };
  if (price) {
    const p = first(price, priceOf);
    if (p) {
      f.priceUsd = p.v;
      f.quoteSource = LABEL[p.s];
      f.quoteAtMs = p.x.atMs;
      // one source, one read: the market cap beside the price is the same source's, or a dash
      f.valuationUsd = usable(p.x.cap) && p.x.cap > 0 ? p.x.cap : null;
      if (f.valuationUsd !== null) {
        f.capSource = LABEL[p.s];
        f.capAtMs = p.x.atMs;
      } else {
        delete f.capSource;
        delete f.capAtMs;
      }
    } else {
      f.priceUsd = null;
      f.valuationUsd = null;
      delete f.quoteSource;
      delete f.quoteAtMs;
      delete f.capSource;
      delete f.capAtMs;
    }
  }
  if (volume) {
    const v = first(volume, (x) => x.volume);
    f.volume24hUsd = v ? v.v : null;
    if (v) src.volume = { source: LABEL[v.s], atMs: v.x.atMs };
    else delete src.volume;
  }
  if (liquidity) {
    const l = first(liquidity, (x) => x.liquidity);
    f.liquidityUsd = l ? l.v : null;
    if (l) src.liquidity = { source: LABEL[l.s], atMs: l.x.atMs };
    else delete src.liquidity;
  }
  f.figSrc = src;
  return f;
}
const priceOf = (x: Figure): number | null | undefined => x.price;

/** The order the chart's candles are tried in: the operator's when he reordered it, else today's (Pump.fun, then PINR's own trades, then GeckoTerminal). */
export const CANDLES_TODAY: SourceId[] = ["pumpfun", "tape", "geckoterminal"];
export const candleOrder = (routing: Routing): SourceId[] => routing.orders.candles ?? CANDLES_TODAY;
