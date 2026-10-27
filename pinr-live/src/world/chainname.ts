/** A chain's name as the page shows it ("Base", "BNB Chain", "Solana"), never the feed's raw id ("base", "bsc"). An id not known here is shown as it came. */
const NAMES: Record<string, string> = { solana: "Solana", base: "Base", bsc: "BNB Chain", bnb: "BNB Chain", ethereum: "Ethereum", eth: "Ethereum" };

export function chainName(id: string): string {
  return NAMES[id.trim().toLowerCase()] ?? id;
}
