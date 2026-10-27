import { byFirstPage, firstPageKey } from "../../server/firstpage";
import { liveImportance, NEW_LAUNCH_MIN, quantImp, type Item } from "./model";
import { padOf } from "./marks";

/**
 * The three header filters. A filter chooses WHICH tiles show and RANKS them, best first; the grid fills
 * in that order (top-left first, reading across then down). The base view is Trending; "all" (tap the chosen filter again) ranks by long-term weight.
 * A filter is a snapshot taken when it is chosen: tiles never reshuffle by themselves afterwards.
 */
export type Filter = "all" | "trending" | "movers" | "new" | "pinrindex";

export const FILTERS: { id: Exclude<Filter, "all">; label: string; hint: string }[] = [
  { id: "trending", label: "Trending", hint: "Most active right now" },
  { id: "movers", label: "Movers", hint: "Biggest moves" },
  { id: "new", label: "New Launches", hint: "Under an hour old" },
  { id: "pinrindex", label: "PINR Index", hint: "Real, scored projects by score" },
];

/**
 * Every filter can be ordered three ways: its own order (default), ascending or descending on the number it ranks by.
 * Default is each filter's natural order (best first; newest first for New Launches). The choice is kept per filter on the device.
 */
export type SortDir = "default" | "asc" | "desc";
export const SORTS: { id: SortDir; label: string }[] = [
  { id: "default", label: "Default" },
  { id: "asc", label: "Ascending" },
  { id: "desc", label: "Descending" },
];
const SORT_KEY = "pinr.sort";
let sorts: Partial<Record<Filter, SortDir>> = {};
try {
  const raw = JSON.parse(localStorage.getItem(SORT_KEY) ?? "null") as Record<string, unknown> | null;
  if (raw && typeof raw === "object") {
    for (const k of ["all", "trending", "movers", "new", "pinrindex"] as Filter[]) {
      const v = raw[k];
      if (v === "asc" || v === "desc") sorts[k] = v;
    }
  }
} catch {
  /* no storage: every filter uses its default order */
}
export const getSort = (f: Filter): SortDir => sorts[f] ?? "default";
export function setSort(f: Filter, d: SortDir): void {
  sorts = { ...sorts, [f]: d };
  try {
    localStorage.setItem(SORT_KEY, JSON.stringify(sorts));
  } catch {
    /* the choice lasts until the page closes */
  }
}

/** The PINR Index as a number, or null when the token has none (unscored, flagged, error): missing stays missing, never zero. */
export function scoreOf(it: Pick<Item, "status" | "flagKind" | "coverage" | "value">): number | null {
  if (it.status === "flag" || it.flagKind || it.coverage <= 0) return null;
  const n = Number(it.value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** Order by a number; tokens with no number go last whichever way it runs. `natural` is the filter's own direction. */
export function sortBy<T>(list: readonly T[], measure: (t: T) => number | null, dir: SortDir, natural: "asc" | "desc", tie: (a: T, b: T) => number): T[] {
  const d = dir === "default" ? natural : dir;
  // The number is worked out once per token, not once per comparison (the list can hold thousands).
  const rows = list.map((t) => ({ t, m: measure(t) }));
  rows.sort((a, b) => {
    const x = a.m;
    const y = b.m;
    if (x === null || y === null) return x === y ? tie(a.t, b.t) : x === null ? 1 : -1;
    return (d === "desc" ? y - x : x - y) || tie(a.t, b.t);
  });
  return rows.map((r) => r.t);
}

/**
 * How many tiles the PINR page shows. Every filter shows the TOP of its own ranking, taken from everything the app knows (the
 * scored roster plus the launchpad coins): Trending the top N trending, Movers the top N movers, and so on. The base is 90 to keep the
 * site light; the user can raise it to 200. The choice is saved on the device.
 */
export const ROSTER_DEFAULT = 90;
export const ROSTER_MIN = 30;
export const ROSTER_MAX = 200;
const ROSTER_KEY = "pinr.roster";
export const clampRoster = (n: number): number => (Number.isFinite(n) ? Math.min(ROSTER_MAX, Math.max(ROSTER_MIN, Math.round(n))) : ROSTER_DEFAULT);
let roster = ROSTER_DEFAULT;
try {
  const saved = Number(localStorage.getItem(ROSTER_KEY));
  if (saved) roster = clampRoster(saved);
} catch {
  /* no storage: the base size is used */
}
export const getRoster = (): number => roster;
export function setRoster(n: number): void {
  roster = clampRoster(n);
  try {
    localStorage.setItem(ROSTER_KEY, String(roster));
  } catch {
    /* the size lasts until the page closes */
  }
}

export interface Ranked {
  id: number;
  /** Layout importance 0..1 (best = 1), in clean steps. */
  imp: number;
}

/** Turn a best-first list of ids into ranked entries: rank 0 -> 1.0, last -> 0.25. */
function byRank(ids: number[]): Ranked[] {
  const n = ids.length;
  return ids.map((id, i) => ({ id, imp: quantImp(n <= 1 ? 1 : 1 - 0.75 * (i / (n - 1))) }));
}

/**
 * What the user can take out of the PINR page and Discover. A copy (VAMP) gets a tile that says VAMP, so by default everything shows;
 * these switches remove the rubbish: copies (VAMPs and possible copies), bots and rugs (proven BOT/RUG or HONEYPOT), and serial launchers.
 */
export interface Hides {
  vamp: boolean;
  bots: boolean;
  serial: boolean;
}
const HIDE_KEY = "pinr.hide";
let hides: Hides = { vamp: false, bots: false, serial: false };
try {
  const raw = JSON.parse(localStorage.getItem(HIDE_KEY) ?? "null") as Partial<Hides> | null;
  if (raw && typeof raw === "object") hides = { vamp: raw.vamp === true, bots: raw.bots === true, serial: raw.serial === true };
} catch {
  /* no storage: nothing is hidden */
}
export const getHides = (): Hides => hides;
export function setHides(h: Hides): void {
  hides = { ...h };
  try {
    localStorage.setItem(HIDE_KEY, JSON.stringify(hides));
  } catch {
    /* the choice lasts until the page closes */
  }
}
/** True when the user's switches take this token out. */
export function isHidden(it: Item, h: Hides = hides): boolean {
  if (it.quiet === true) return true; // on no list or tile; only a search by its address shows it
  if (h.vamp && (it.flagKind === "VAMP" || it.possibleCopy !== undefined)) return true;
  if (h.bots && (it.flagKind === "BOT/RUG" || it.flagKind === "HONEYPOT")) return true;
  if (h.serial && it.serial === true) return true;
  return false;
}

/** Seconds for the "something just traded" boost to halve. */
const RECENT_HALF_S = 90;

/** What is happening now: the token's weight and recent heat, plus a boost when the launchpad saw a trade in it moments ago. */
function trendScore(it: Item, nowMs: number): number {
  let sum = 0;
  for (const v of it.hist) sum += v;
  const mean = it.hist.length ? sum / it.hist.length : it.base;
  const age = it.lastTradeMs !== undefined && Number.isFinite(it.lastTradeMs) ? Math.max(0, (nowMs - it.lastTradeMs) / 1000) : Infinity;
  const recent = Number.isFinite(age) ? 0.6 * Math.pow(0.5, age / RECENT_HALF_S) : 0;
  // How busy it is right now (trades in the last five minutes, on a log scale so a thousand is not a hundred times a tenth of that).
  const busy = it.trades5m !== undefined && it.trades5m > 0 ? Math.min(1, Math.log10(1 + it.trades5m) / 2.5) : 0;
  // What a trader looks for is what is moving NOW: busy and just-traded count most; size and long-run weight only break ties.
  return 0.2 * liveImportance(it) + 0.2 * mean + recent + 0.9 * busy;
}

/**
 * the tile page (the first page) holds back a coin that has neither a picture nor a chart line yet; it joins as soon as it has
 * one. It stays on Discover's lists, in search and on its own page. Nothing is hidden for good and nothing about the coin changes.
 */
export function hasSomethingToShow(it: Pick<Item, "image" | "chart">): boolean {
  return it.image !== null || it.chart.length >= 2;
}

/** How long a coin counts as just seen or just scored on the tile page (the same 24 hours as the feed server's first page). */
export const RECENT_MS = 24 * 3600_000;

export function selectAndRank(filter: Filter, all: readonly Item[], limit: number = roster, nowMs: number = Date.now(), dir: SortDir = getSort(filter)): Ranked[] {
  const items = all.filter((it) => !isHidden(it));
  const byId = (a: Item, b: Item): number => a.id - b.id;
  if (filter === "all") {
    // Everything by long-term weight (heaviest first by default), up to the roster size.
    return sortBy(items, (it) => it.base, dir, "desc", byId).slice(0, limit).map((it) => ({ id: it.id, imp: quantImp(it.base) }));
  }
  if (filter === "new") {
    const fresh = items.filter((it) => it.ageMin < NEW_LAUNCH_MIN);
    return byRank(sortBy(fresh, (it) => it.ageMin, dir, "asc", byId).slice(0, limit).map((it) => it.id));
  }
  if (filter === "pinrindex") {
    // Only tokens with a real score: unscored, flagged and errored ones have no number to rank by, so they are not here.
    const scored = items.filter((it) => scoreOf(it) !== null);
    return byRank(sortBy(scored, scoreOf, dir, "desc", byId).slice(0, limit).map((it) => it.id));
  }
  if (filter === "trending" && dir === "default") {
    // The tile page's own order: coins scored in the last 24 hours first, newest-scored first; then unscored coins new
    // in the last 24 hours, newest first; then the rest by what is moving (the design's "seen or scored" first, split in two).
    const key = (it: Item) => {
      const scored = scoreOf(it) !== null;
      return firstPageKey({ scored, scoredAtMs: scored && it.seenAtMs === undefined ? it.scoredAtMs : null, newAtMs: scored ? null : (it.seenAtMs ?? (Number.isFinite(it.ageMin) ? nowMs - it.ageMin * 60_000 : null)) }, nowMs);
    };
    const keys = new Map(items.map((it) => [it, key(it)]));
    const recent = items.filter((it) => keys.get(it)![0] < 2).sort((a, b) => byFirstPage(keys.get(a)!, keys.get(b)!) || byId(a, b));
    const others = sortBy(items.filter((it) => keys.get(it)![0] === 2), (it) => trendScore(it, nowMs), "default", "desc", byId);
    return byRank([...recent, ...others].slice(0, limit).map((it) => it.id));
  }
  const measure = filter === "trending" ? (it: Item) => trendScore(it, nowMs) : (it: Item) => Math.abs(it.moved);
  return byRank(sortBy(items, measure, dir, "desc", byId).slice(0, limit).map((it) => it.id));
}

/**
 * the PINR page features Pump.fun and PumpSwap (graduated) coins. They are ranked first, by the filter's own order; coins from
 * other launchpads stay shown, ranked the same way, only in the room left after them (Discover and search list every coin as before).
 */
export function isFeatured(it: Pick<Item, "launchpad">): boolean {
  return padOf(it) === "pump";
}

export function rankFeatured(filter: Filter, all: readonly Item[], limit: number = roster, nowMs: number = Date.now(), dir: SortDir = getSort(filter)): Ranked[] {
  const first = selectAndRank(filter, all.filter(isFeatured), limit, nowMs, dir);
  if (first.length >= limit) return first;
  const rest = selectAndRank(filter, all.filter((it) => !isFeatured(it)), limit - first.length, nowMs, dir);
  if (!rest.length) return first;
  // "All" sizes tiles by each coin's own weight; every other order by place, so the places are counted again over the whole page.
  return filter === "all" ? [...first, ...rest] : byRank([...first, ...rest].map((r) => r.id));
}
