import type { WireToken } from "./translate.ts";

/**
 * Which chains the feed server serves: only the chains the scanner scores now, by one setting, so a chain comes back with one
 * switch and nothing is deleted. `PINR_CHAINS` is a comma list (default `solana,base,bsc` since a design decision step 2); `all` serves every chain. A coin on any other chain is left
 * out of every list, the search (it searches what is served) and every per-coin route (a direct link answers "unknown token").
 */
export function servedChains(setting: string | undefined): ReadonlySet<string> | null {
  const v = (setting ?? "solana,base,bsc").trim().toLowerCase();
  if (v === "all") return null;
  const set = new Set(v.split(",").map((s) => s.trim()).filter(Boolean));
  return set.size ? set : new Set(["solana", "base", "bsc"]);
}

const SOLANA_ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

/** The coin's chain as the server judges it: its own `chain`, else, for a file that names none, Solana when the address is a Solana one. */
export function chainOf(t: Pick<WireToken, "chain" | "address">): string | null {
  if (t.chain) return t.chain.toLowerCase();
  return SOLANA_ADDRESS.test(t.address) ? "solana" : null;
}

/** Keep only the coins on a served chain (all of them when every chain is served). */
export function onServedChains<T extends Pick<WireToken, "chain" | "address">>(list: readonly T[], chains: ReadonlySet<string> | null): T[] {
  if (!chains) return list.slice();
  return list.filter((t) => {
    const c = chainOf(t);
    return c !== null && chains.has(c);
  });
}
