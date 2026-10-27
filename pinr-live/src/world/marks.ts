import type { Item } from "./model";

/**
 * The two small logos a token wears on its picture, like Pump.fun's own: what it trades against (the pair: Solana, Ethereum, BNB,
 * a dollar coin) and where it was launched (the launchpad). Plain functions, so they can be tested without a screen.
 * Missing stays missing: a pair or launchpad we do not know gets no logo, never a guess.
 * The marks are simple drawings of our own, not the companies' official art.
 */
export type PairMark = "sol" | "eth" | "bnb" | "usdt" | "usdc";
export type PadMark = "pump" | "stonk" | "launchlab" | "clanker" | "bankr" | "flap" | "fourmeme" | "zora" | "virtuals";

/** The coin a pool trades against. An empty pair on a launchpad curve means the chain's own coin. */
export function pairOf(it: Pick<Item, "quotePair" | "chain">): PairMark | null {
  const q = it.quotePair.includes("/") ? it.quotePair.split("/").pop()!.trim().toUpperCase() : it.quotePair.trim().toUpperCase();
  if (q === "SOL" || q === "WSOL") return "sol";
  if (q === "ETH" || q === "WETH") return "eth";
  if (q === "BNB" || q === "WBNB") return "bnb";
  if (q === "USDT") return "usdt";
  if (q === "USDC") return "usdc";
  if (q !== "") return null; // some other coin: not drawn
  const c = (it.chain ?? "").toLowerCase();
  return c === "solana" ? "sol" : c === "base" || c === "ethereum" ? "eth" : c === "bsc" || c === "bnb" ? "bnb" : null;
}

export function padOf(it: Pick<Item, "launchpad">): PadMark | null {
  const l = (it.launchpad ?? "").toLowerCase();
  if (l.includes("pump")) return "pump"; // Pump.fun and PumpSwap
  if (l.includes("stonk")) return "stonk"; // Stonk.fun, on Raydium LaunchLab
  if (l.includes("launchlab")) return "launchlab"; // Raydium LaunchLab, platform not read yet
  if (l.includes("clanker")) return "clanker";
  if (l.includes("bankr")) return "bankr";
  if (l.includes("flap")) return "flap";
  if (l.includes("four")) return "fourmeme";
  if (l.includes("zora")) return "zora"; // Base
  if (l.includes("virtuals")) return "virtuals"; // Base
  return null;
}

const wrap = (inner: string): string => `<svg viewBox="0 0 24 24" aria-hidden="true">${inner}</svg>`;
const disc = (fill: string, letter: string, color = "#fff"): string =>
  wrap(`<circle cx="12" cy="12" r="11" fill="${fill}"/><text x="12" y="16.4" text-anchor="middle" font-family="Arial,Helvetica,sans-serif" font-weight="700" font-size="13" fill="${color}">${letter}</text>`);

export const MARK_SVG: Record<PairMark | PadMark, string> = {
  sol: wrap('<path fill="#19f0a0" d="M7 5.6h13.5l-3 3.2H4z"/><path fill="#6f8df5" d="M4 10.4h13.5l3 3.2H7z"/><path fill="#9945ff" d="M7 15.2h13.5l-3 3.2H4z"/>'),
  eth: wrap('<path fill="#9aa4d0" d="M12 2l6 10-6 3.6L6 12z"/><path fill="#c3c9e8" d="M12 17l6-3.8L12 22 6 13.2z"/>'),
  bnb: wrap(
    '<path fill="#f3ba2f" d="M12 3.4l2.5 2.5L12 8.4 9.5 5.9zM6.2 9.2l2.5 2.5-2.5 2.5-2.5-2.5zM17.8 9.2l2.5 2.5-2.5 2.5-2.5-2.5zM12 15l2.5 2.5L12 20l-2.5-2.5zM12 9.3l2.4 2.4-2.4 2.4-2.4-2.4z"/>',
  ),
  usdt: disc("#26a17b", "T"),
  usdc: disc("#2775ca", "$"),
  pump: wrap(
    '<g transform="rotate(-45 12 12)"><path fill="#5fd9a0" d="M9 7.5h3v9H9a4.5 4.5 0 010-9z"/><path fill="#fff" d="M12 7.5h3a4.5 4.5 0 010 9h-3z"/>' +
      '<rect x="4.5" y="7.5" width="15" height="9" rx="4.5" fill="none" stroke="#1d3d30" stroke-width="1.2"/></g>',
  ),
  clanker: disc("#6a4cff", "C"),
  bankr: disc("#1d1d1f", "B"),
  flap: disc("#ef7d2d", "F"),
  fourmeme: disc("#f3ba2f", "4", "#1d1d1f"),
  stonk: disc("#22c55e", "S"),
  launchlab: disc("#5a4fcf", "L"),
  zora: disc("#4f7df5", "Z"),
  virtuals: disc("#3fbfb0", "V", "#0d2b28"),
};
