import type { Item } from "./model";

/**
 * The words about copies (VAMP and "possible copy"), in one place so every page says the same thing. a copy
 * is called "confirmed" only when Pump.fun's record confirmed two different creator wallets; a link to the original is its proof.
 */
type CopyFields = Pick<Item, "flagKind" | "copyProof">;

/** True when a copy's creator check confirmed two different wallets. */
export const chainProven = (it: CopyFields): boolean => it.flagKind === "VAMP" && it.copyProof === "chain";

/** The line under a flagged token's ring on DeepScan. */
export function flagLine(it: CopyFields): string {
  if (it.flagKind === "VAMP") return chainProven(it) ? "Copy confirmed from Pump.fun's record: no score is shown" : "Possible copy, not confirmed yet (creators not checked yet): no score is shown";
  return "Labelled by the checks: no score is shown";
}

/** The word beside a flagged token on a Discover row. */
export function flagWord(it: CopyFields): string {
  return it.flagKind === "VAMP" && !chainProven(it) ? "unchecked" : "confirmed";
}

/** The opening sentence of the VAMP box. */
export function vampIntro(proof: Item["copyProof"]): string {
  return proof === "chain"
    ? "This token copies another token's picture, and Pump.fun's record shows a different wallet made it. PINR keeps no price, chart, stats or trades for a copy, and gives it no score. Only the original gets data."
    : "This token has the same picture as an earlier token by another creator, so it is shown as a copy. The check on the two creators (Pump.fun's record) has not been done yet, so this is not confirmed. PINR keeps no price, chart, stats or trades for it. Only the original gets data.";
}

/** The warning on a token (scored or not) whose picture matches an earlier coin. */
export function possibleLine(pc: NonNullable<Item["possibleCopy"]>, hasScore = true): string {
  return `Its picture matches ${pc.ticker}, launched earlier by another creator. ${pc.proof === "chain" ? "Pump.fun's record shows two different wallets." : "The creator check has not been done."} PINR's picture matching has not been inspected yet, so this is a warning, not a verdict: ${hasScore ? "the score below is the engine's and stays." : "nothing is hidden or removed."}`;
}

/**
 * A public page for the original token, for when the app does not hold it. The address is always known; the chain of the original is
 * only guessed from the copy when that is unambiguous (a Solana-style address is Solana; an 0x address takes the copy's chain when
 * that is an EVM chain). Otherwise no link is made up, and the page shows the address itself.
 */
export function originalLink(address: string, copyChain: string | undefined): string | null {
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$|^0x[0-9a-fA-F]{40}$/.test(address)) return null;
  if (!address.startsWith("0x")) return `https://dexscreener.com/solana/${address}`;
  return copyChain === "base" || copyChain === "bsc" ? `https://dexscreener.com/${copyChain}/${address}` : null;
}

/** A long address as start…end. */
export const shortAddr = (a: string): string => (a.length > 14 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a);
