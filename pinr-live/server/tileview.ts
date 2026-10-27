import type { WireToken } from "./translate.ts";

/**
 * The site's lighter token list. The page polls `/api/tokens?view=tile` every 15 seconds; that list carries what a tile, the
 * Discover rows and the search need, and leaves out the figures only a coin's own page shows: the receipts beside its price, market cap,
 * all-time high and liquidity. The coin page reads those for its one coin from `/api/token/detail` while it is open. The plain `/api/tokens`
 * (the apps' contract) is unchanged and keeps every field.
 */
export const COIN_PAGE_ONLY = ["figSrc", "quoteAtMs", "quoteSource", "capSource", "capAtMs", "athSource", "athAtMs", "athLink", "liquidityUsd"] as const;
/** Fields the site never reads (the apps may): left out of the site's list only. */
const SITE_NEVER_READS = ["seenBy", "rank"] as const;

export type CoinPageFields = Partial<Pick<WireToken, (typeof COIN_PAGE_ONLY)[number]>> & { address: string };

/** One token as the site's tile list sends it: every field but the coin page's own and the ones the site never reads. */
export function tileView(t: WireToken): Partial<WireToken> {
  const o: Record<string, unknown> = { ...t };
  for (const k of COIN_PAGE_ONLY) delete o[k];
  for (const k of SITE_NEVER_READS) delete o[k];
  return o as Partial<WireToken>;
}

/** The coin page's own figures for one token (its address and the receipts the tile list leaves out). */
export function coinPageFields(t: WireToken): CoinPageFields {
  const o: Record<string, unknown> = { address: t.address };
  for (const k of COIN_PAGE_ONLY) if (k in t) o[k] = (t as unknown as Record<string, unknown>)[k];
  return o as CoinPageFields;
}
