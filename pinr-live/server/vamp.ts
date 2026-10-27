import type { WireToken } from "./translate.ts";

/**
 * VAMP: a token that copies another token's picture. It is the FIRST gate after the data comes in: a copy gets a "VAMP" label and
 * nothing else. No price, no chart, no stats, no trades, no score, and no further data is fetched for it. Only the original keeps its data.
 *
 * Evidence for a launchpad coin the engine has not scored (this file's rule, kept plain on purpose):
 *   - the picture is the SAME FILE (the same IPFS content address, or the same web address) as an earlier coin, and
 *   - that earlier coin was made by a DIFFERENT creator (the same creator launching again is a relaunch, which the engine handles
 *     with its own brake, not a copy), and
 *   - the earlier coin launched BEFORE it. The earliest one is the original and is never flagged by this rule.
 * The engine's own VAMP verdicts (a `noScoreLabel` of "VAMP" in its results) are honoured as given and get the same gate.
 */

/** The identity of a picture: its IPFS content address when it has one (the same file on any gateway), else its whole web address. */
export function imageKey(url: string | null | undefined): string | null {
  if (!url) return null;
  const ipfs = /\/ipfs\/([A-Za-z0-9]{20,})/.exec(url);
  return ipfs ? ipfs[1]! : url;
}

export interface Launch {
  id: string;
  ticker: string;
  image: string | null;
  creator: string | null;
  createdMs: number;
}
export interface Original {
  id: string;
  ticker: string;
  /** how the picture matched: the very same file, or a near match found by comparing what the pictures look like */
  basis?: "same file" | "near match";
  /** whether the chain's own record of the two creators was read: "confirmed" = two different wallets */
  chain?: "confirmed" | "unchecked";
}

/**
 * Which of these launches are copies, and of what. `elsewhere` are scored tokens on OTHER chains (their creator is not known to this
 * rule, so they only count as an original for a coin on a different chain, which is where a copied picture most often comes from).
 */
export function findVamps(coins: readonly Launch[], elsewhere: readonly { id: string; ticker: string; image: string | null; launchedMs: number }[] = []): Map<string, Original> {
  const out = new Map<string, Original>();
  const groups = new Map<string, Launch[]>();
  for (const c of coins) {
    const k = imageKey(c.image);
    if (!k) continue;
    const g = groups.get(k) ?? [];
    g.push(c);
    groups.set(k, g);
  }
  const far = new Map<string, { id: string; ticker: string; launchedMs: number }[]>();
  for (const e of elsewhere) {
    const k = imageKey(e.image);
    if (!k) continue;
    const g = far.get(k) ?? [];
    g.push(e);
    far.set(k, g);
  }
  for (const [k, g] of groups) {
    g.sort((a, b) => a.createdMs - b.createdMs || (a.id < b.id ? -1 : 1));
    for (let i = 0; i < g.length; i++) {
      const c = g[i]!;
      if (c.creator === null) continue;
      const earlier = g.slice(0, i).find((o) => o.creator !== null && o.creator !== c.creator && o.createdMs < c.createdMs);
      const abroad = far.get(k)?.find((o) => o.launchedMs < c.createdMs);
      const o = earlier ?? abroad;
      if (o) out.set(c.id, { id: o.id, ticker: o.ticker });
    }
  }
  return out;
}

/** Everything a VAMP carries: its identity, the label and when it appeared (to place its tile), nothing measured. */
export function stripVamp(t: WireToken): WireToken {
  return {
    ...t,
    imageUrl: null,
    score: null,
    coverage: 0,
    valuationUsd: null,
    volume24hUsd: null,
    change24hPct: null,
    priceSeries: null,
    priceUsd: null,
    liquidityUsd: null,
    quotePair: null,
    changeWindowH: null,
    priceSource: null,
    flow: null,
    transferFee: undefined,
    // When it launched and when it last traded are kept only so the copy holds its place in time on the live page; they are not market data.
    rank: t.rank,
  };
}

export const isVamp = (t: Pick<WireToken, "noScoreLabel">): boolean => t.noScoreLabel === "VAMP";

/**
 * The picture desk's verdicts applied to scored tokens: a token whose picture matches an earlier coin by another
 * creator gets a "possible copy" warning with a link to that coin. Its score, label and data are left exactly as the engine gave them.
 */
export function markCopies(tokens: readonly WireToken[], verdicts: ReadonlyMap<string, { id: string; ticker: string; chain?: "confirmed" | "unchecked" }>): WireToken[] {
  return tokens.map((t) => {
    const o = isVamp(t) ? undefined : verdicts.get(t.address);
    // a picture match alone never removes a score. The engine's result stays as it is and carries a warning.
    return o ? { ...t, possibleCopyOf: { address: o.id, ticker: o.ticker, proof: o.chain === "confirmed" ? ("chain" as const) : ("unchecked" as const) } } : t;
  });
}

/** A scored token for the paged "rest" list: no chart and no live trade lines (they are loaded when a token is opened or joins the first page). */
export function lite(t: WireToken): WireToken {
  return { ...t, priceSeries: null, flow: null, tapeEvent: null };
}
