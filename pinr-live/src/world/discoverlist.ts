import { isHidden, selectAndRank, sortBy, type SortDir } from "./filters";
import type { Item } from "./model";
import { visibleText } from "./visibletext";

/**
 * What the Discover page lists. Four tabs, like the filters on the PINR header:
 *   movers   the largest 24h price moves, up or down
 *   trending the most active right now (same ranking as the PINR filter)
 *   fresh    launched under an hour ago, newest first
 *   pinrscore the scored tokens, highest PINRscore first
 * Each can be ordered default, ascending or descending (the header's sort choice).
 * A search looks through every token, not just the tab's, and ranks the heaviest first.
 * The list is a snapshot: it is re-ranked only when a tab is chosen, the search changes, or Refresh is pressed.
 */
export type DiscoverTab = "movers" | "trending" | "fresh" | "pinrscore" | "chains";
/** the Base/BNB tab lists coins on these chains. */
export const TAB_CHAINS = ["base", "bsc"];
export const DISCOVER_ROWS = 30;

/** Size of a 24h move; a token with no 24h figure ranks below every token that has one (missing is not zero, and not a move). */
const moveSize = (it: Item): number | null => (Number.isFinite(it.change24h) ? Math.abs(it.change24h) : null);

export function rankDiscover(tab: DiscoverTab, all: readonly Item[], query: string, dir: SortDir = "default"): Item[] {
  // A search finds everything (even what the switches hide, so a token can always be looked up); the lists respect the switches.
  const items = query.trim() ? all : all.filter((it) => !isHidden(it));
  const q = visibleText(query).toLowerCase().replace(/^\$/, "");
  if (q) {
    return items
      .filter((it) => it.name.toLowerCase().includes(q) || it.ticker.toLowerCase().includes(q) || (it.address !== null && q.length >= 6 && it.address.toLowerCase().includes(q)))
      .sort((a, b) => b.base - a.base || a.id - b.id)
      .slice(0, DISCOVER_ROWS);
  }
  const byId = new Map(items.map((it) => [it.id, it]));
  let list: Item[];
  if (tab === "chains") {
    // Base and BNB Chain coins, newest first (when PINR met it, else its launch); the switches, copies, the gate and quiet coins apply as on every list.
    const nowMs = Date.now();
    const newAt = (it: Item): number => it.seenAtMs ?? (Number.isFinite(it.ageMin) ? nowMs - it.ageMin * 60_000 : -Infinity);
    list = items.filter((it) => TAB_CHAINS.includes((it.chain ?? "").toLowerCase())).sort((a, b) => newAt(b) - newAt(a) || a.id - b.id);
  } else if (tab === "movers") list = sortBy(items, moveSize, dir, "desc", (a, b) => a.id - b.id);
  else list = selectAndRank(tab === "trending" ? "trending" : tab === "pinrscore" ? "pinrscore" : "new", items, DISCOVER_ROWS, Date.now(), dir).map((r) => byId.get(r.id)!);
  return list.slice(0, DISCOVER_ROWS);
}

/** 1_234_567 -> "$1.23M". Missing stays missing. */
export function money(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "—";
  if (n >= 1e9) return `$${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `$${(n / 1e6).toFixed(2)}M`;
  if (n >= 1e3) return `$${(n / 1e3).toFixed(1)}K`;
  // under a dollar: cents, so a small real amount never reads "$0" (checklist 7)
  if (n < 0.01) return "<$0.01";
  if (n < 1) return `$${n.toFixed(2)}`;
  return `$${Math.round(n)}`;
}

/** +62.9 -> "+62.9%", -4 -> "−4.0%". */
export function signedPct(n: number): string {
  if (!Number.isFinite(n)) return "—";
  const a = Math.abs(n);
  const body = a >= 1000 ? Math.round(a).toLocaleString("en-US") : a.toFixed(1);
  return `${n < 0 ? "−" : "+"}${body}%`;
}

/** Minutes since launch as "12m", "9h" or "3d". */
export function ageText(min: number): string {
  if (!Number.isFinite(min)) return "—";
  if (min < 60) return `${Math.max(1, Math.round(min))}m`;
  if (min < 60 * 48) return `${Math.round(min / 60)}h`;
  return `${Math.round(min / 1440)}d`;
}
