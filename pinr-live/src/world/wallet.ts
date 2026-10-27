/**
 * Wallet lookup rules for the site. Plain functions, so they can be tested.
 *
 * VIEW ONLY: the site never connects to a wallet. The person pastes a public address and the page shows what that address
 * holds, read from public blockchain data. There is no wallet request of any kind in the code, and a test fails if any file mentions a
 * wallet connection library or a signing or sending call.
 */
export type WalletChain = "evm" | "solana";

/** What is remembered on this device about the lookup: an address, nothing else. Never a key, never a signature. */
export interface WalletProfile {
  chain: WalletChain;
  address: string;
  at: number;
}

export const WALLET_KEY = "pinr.wallet";

const EVM_RE = /^0x[0-9a-fA-F]{40}$/;
const SOL_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export function detectChain(address: string): WalletChain | null {
  if (EVM_RE.test(address)) return "evm";
  if (SOL_RE.test(address)) return "solana";
  return null;
}

/** "0x1a2b…9f0e" / "7xKX…Nq4P". */
export function shortAddr(a: string): string {
  return a.length > 13 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a;
}

/** An address in its one proper form: EVM addresses lower-case (they are not case-sensitive), Solana as given. Null when it is not an address. */
export function cleanAddress(raw: string): { address: string; chain: WalletChain } | null {
  const s = raw.trim();
  const chain = detectChain(s);
  if (!chain) return null;
  return { address: chain === "evm" ? s.toLowerCase() : s, chain };
}

/** A saved lookup, read back. Anything saved by an earlier version (which could also hold a wallet's name) comes back as the plain address it was. */
export function parseProfile(raw: unknown): WalletProfile | null {
  if (typeof raw !== "object" || raw === null) return null;
  const o = raw as Record<string, unknown>;
  if (typeof o.address !== "string") return null;
  const c = cleanAddress(o.address);
  if (!c || (o.chain !== undefined && o.chain !== c.chain)) return null;
  return { chain: c.chain, address: c.address, at: typeof o.at === "number" ? o.at : 0 };
}

/** Three colours from an address, so every profile gets its own steady avatar without any outside picture service. */
export function avatarColors(address: string): [string, string, string] {
  let h = 2166136261;
  const s = address.toLowerCase();
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  const hue = h % 360;
  return [`hsl(${hue} 85% 62%)`, `hsl(${(hue + 70) % 360} 80% 55%)`, `hsl(${(hue + 200) % 360} 75% 45%)`];
}

/** The wording shown on the Wallet page, one source so the page and the tests agree. */
export const VIEW_ONLY_TITLE = "View-only";
export const VIEW_ONLY_POINTS: readonly string[] = [
  "You paste a public wallet address and PINR shows what it holds. That is public blockchain data, the same thing anyone can see on a block explorer.",
  "PINR does not connect to your wallet. It never asks for a signature, a seed phrase or a private key. If anything asks you for them, it is not PINR: stop.",
  "The address is remembered on this device only. You can clear it at any time.",
];
