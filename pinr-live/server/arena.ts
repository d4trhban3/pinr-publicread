import { readFileSync } from "node:fs";
import type { Activity, Plan } from "./hidden.ts";
import type { CoinTag, WireToken } from "./translate.ts";
import { visibleText } from "../src/world/visibletext.ts";
import { tagsOf } from "../src/world/tags.ts";

/**
 * the PvP Arena. Every version of a contested coin side by side (a copy family: the same picture, the same name and ticker, or the
 * gate's look-alikes and relaunches), with copy hiding OFF on this page only, ranked strictly by volume, X presence and chart figures to show
 * which version is drawing the most money. Nothing here is a verdict: the page shows what was measured, and a missing figure is a dash that ranks last.
 *
 * Volume is the last 30 minutes' trades in dollars, the same measure the copy groups use to pick the version shown elsewhere (it is measured for
 * every version, hidden or not); the 24-hour volume is shown beside it where a source gives it.
 */
export interface ArenaCoin {
  address: string;
  name: string | null;
  ticker: string | null;
  imageUrl: string | null;
  chain: string | null;
  launchpad: string | null;
  launchedAtMs: number | null;
  /** last 30 minutes: trades and dollars */
  recentTrades: number;
  recentUsd: number;
  /** the kept trades do not reach back the whole 30 minutes: the figures are at least these ("500+") */
  recentAtLeast: boolean;
  /** the last 30 minutes were actually read; false: the two figures above are not known yet and show as a dash, never a zero (checklist 7) */
  recentKnown: boolean;
  volume24hUsd: number | null;
  /** posts about the coin the X check found (null: not checked yet), and whether the coin links an X account */
  xPosts: number | null;
  hasX: boolean;
  change24hPct: number | null;
  valuationUsd: number | null;
  /** the earliest launch in its family (observed, not a judgement) */
  earliest: boolean;
  /** the coin's tags, kept in the Arena too */
  tags: CoinTag[];
}
export interface ArenaGroup {
  id: string;
  /** the family's shared name and ticker, from its leader */
  title: string | null;
  ticker: string | null;
  recentUsd: number;
  members: ArenaCoin[];
}

const num = (v: number | null | undefined): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const desc = (a: number | null, b: number | null): number => (a === null && b === null ? 0 : a === null ? 1 : b === null ? -1 : b - a);

/** Ranked strictly: 30-minute volume, then X presence (posts found, then an X link), then the chart (24-hour change, then market cap). */
export function rankMembers(cs: ArenaCoin[]): ArenaCoin[] {
  return [...cs].sort(
    (a, b) =>
      b.recentUsd - a.recentUsd ||
      desc(a.xPosts, b.xPosts) ||
      Number(b.hasX) - Number(a.hasX) ||
      desc(a.change24hPct, b.change24hPct) ||
      desc(a.valuationUsd, b.valuationUsd) ||
      (a.address < b.address ? -1 : 1),
  );
}

/**
 * The active battles: families with at least two versions on the feed, at least one of which traded in the last 30 minutes, hottest first
 * (the family's 30-minute dollars), at most `max`.
 */
export function arenaGroups(
  plan: Plan,
  byAddr: ReadonlyMap<string, WireToken>,
  activityOf: (addrLower: string) => Activity,
  xOf: (address: string) => { posts: number | null },
  picture: (t: WireToken) => string | null,
  max = 40,
  named: ReadonlyMap<string, PvpName> = new Map(),
  knownOf: (addrLower: string) => boolean = () => true,
): ArenaGroup[] {
  const out: ArenaGroup[] = [];
  for (const g of plan.groups) {
    const listed = g.map((a) => byAddr.get(a)).filter((t): t is WireToken => !!t);
    if (listed.length < 2) continue;
    // a member with no feed record still shows, by the name and ticker the engine's battle file gives (Jupiter's token list), its
    // figures a dash; a record with no name takes the file's name too. With neither, the page shows the short address.
    const toks = g.map((a): WireToken | null => {
      const t = byAddr.get(a);
      const n = named.get(a);
      if (t) return n && (!t.name || !t.ticker) ? { ...t, name: t.name || n.name, ticker: t.ticker || n.ticker } : t;
      return n ? ({ address: n.address, name: n.name, ticker: n.ticker } as WireToken) : null;
    }).filter((t): t is WireToken => !!t);
    const launches = toks.map((t) => num(t.launchedAtMs)).filter((v): v is number => v !== null);
    const first = launches.length ? Math.min(...launches) : null;
    const members = toks.map((t): ArenaCoin => {
      const act = activityOf(t.address.toLowerCase());
      return {
        address: t.address,
        name: t.name,
        ticker: t.ticker,
        imageUrl: picture(t),
        chain: t.chain ?? null,
        launchpad: t.launchpad ?? null,
        launchedAtMs: num(t.launchedAtMs),
        recentTrades: act.n,
        recentUsd: act.usd,
        recentAtLeast: !!act.atLeast,
        recentKnown: knownOf(t.address.toLowerCase()),
        volume24hUsd: num(t.volume24hUsd),
        xPosts: xOf(t.address).posts,
        hasX: !!t.links?.x,
        change24hPct: num(t.change24hPct),
        valuationUsd: num(t.valuationUsd),
        earliest: first !== null && t.launchedAtMs === first,
        tags: tagsOf(t),
      };
    });
    if (!members.some((m) => m.recentTrades > 0)) continue;
    const ranked = rankMembers(members);
    out.push({ id: ranked.map((m) => m.address).sort()[0]!, title: ranked[0]!.name, ticker: ranked[0]!.ticker, recentUsd: ranked.reduce((s, m) => s + m.recentUsd, 0), members: ranked });
  }
  return out.sort((a, b) => b.recentUsd - a.recentUsd || (a.id < b.id ? -1 : 1)).slice(0, max);
}

/**
 * the engine's battle groups (`frontend-feed/_pvp.json`, contract `pvp-1`, refreshed every minute by `scanner/pvp.py`): each group's members by mint,
 * from the gate's same name and ticker and same picture, one step out from each listed coin. Read at most every 20 s; null when the file is
 * absent, of another contract, or older than 10 minutes, and the Arena falls back to the site's own copy families.
 */
/** A battle member's own name and ticker as the engine's file gives them: what shows for a member with no feed record. */
export interface PvpName {
  address: string;
  name: string | null;
  ticker: string | null;
}
const label = (v: unknown, max: number): string | null => {
  if (typeof v !== "string") return null;
  const s = visibleText(v).replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, max);
  return s === "" ? null : s;
};
/** Each member's name and ticker from the file, by lower-cased mint; members with neither are left out (the page shows their address). */
export function pvpNames(doc: unknown): Map<string, PvpName> {
  const out = new Map<string, PvpName>();
  const d = typeof doc === "object" && doc !== null ? (doc as Record<string, unknown>) : {};
  for (const g of Array.isArray(d.groups) ? d.groups : []) {
    const ms = typeof g === "object" && g !== null && Array.isArray((g as Record<string, unknown>).members) ? ((g as Record<string, unknown>).members as unknown[]) : [];
    for (const m of ms) {
      if (typeof m !== "object" || m === null) continue;
      const r = m as Record<string, unknown>;
      if (typeof r.mint !== "string") continue;
      const name = label(r.name, 80);
      const ticker = label(r.ticker, 24);
      if (name || ticker) out.set(r.mint.toLowerCase(), { address: r.mint, name, ticker });
    }
  }
  return out;
}

export function pvpGroups(doc: unknown): string[][] | null {
  if (typeof doc !== "object" || doc === null) return null;
  const d = doc as Record<string, unknown>;
  if (d.contract !== "pvp-1" || !Array.isArray(d.groups)) return null;
  const out: string[][] = [];
  for (const g of d.groups) {
    const ms = typeof g === "object" && g !== null && Array.isArray((g as Record<string, unknown>).members) ? ((g as Record<string, unknown>).members as unknown[]) : [];
    const mints = ms.map((m) => (typeof m === "object" && m !== null && typeof (m as Record<string, unknown>).mint === "string" ? ((m as Record<string, unknown>).mint as string).toLowerCase() : "")).filter(Boolean);
    if (mints.length >= 2) out.push([...new Set(mints)]);
  }
  return out;
}
export function pvpReader(path: string, readMs = 20_000, staleMs = 10 * 60_000): (nowMs?: number) => { groups: string[][]; names: Map<string, PvpName> } | null {
  let at = 0;
  let held: { groups: string[][]; names: Map<string, PvpName> } | null = null;
  return (nowMs = Date.now()) => {
    if (nowMs - at < readMs) return held;
    at = nowMs;
    try {
      const doc = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
      const written = typeof doc.as_of === "string" ? Date.parse(doc.as_of) : NaN;
      const groups = Number.isFinite(written) && nowMs - written > staleMs ? null : pvpGroups(doc);
      held = groups ? { groups, names: pvpNames(doc) } : null;
    } catch {
      held = null;
    }
    return held;
  };
}

/**
 * a battle's versions appear nowhere but the Arena and a search by their own address; only each battle's leader is listed.
 * The leader is the version the Arena ranks first: most dollars traded in the last 30 minutes, then most trades, then the larger market cap,
 * then the earliest launch (and the address, so the choice is stable). Returns the members to keep off the lists (lower-case addresses).
 */
export function behindLeaders(groups: readonly string[][], tokenOf: (addrLower: string) => WireToken | undefined, activityOf: (addrLower: string) => Activity): Set<string> {
  const out = new Set<string>();
  for (const g of groups) {
    const ranked = g
      .map((a) => ({ a, t: tokenOf(a), act: activityOf(a) }))
      .sort(
        (x, y) =>
          y.act.usd - x.act.usd ||
          y.act.n - x.act.n ||
          desc(num(x.t?.valuationUsd), num(y.t?.valuationUsd)) ||
          (num(x.t?.launchedAtMs) ?? Infinity) - (num(y.t?.launchedAtMs) ?? Infinity) ||
          (x.a < y.a ? -1 : 1),
      );
    for (const r of ranked.slice(1)) out.add(r.a);
  }
  return out;
}
