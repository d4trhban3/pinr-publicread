import type { WireToken } from "./translate.ts";

/**
 * What a wallet holds of the tokens PINR tracks. READ-ONLY and public: it asks public blockchain nodes for token balances of one
 * address (the same thing any block explorer shows) and matches them to the roster. It holds no keys, makes no transactions, and
 * can only read. The address comes from the person's own wallet connection or from an address they typed to view.
 *
 * Nodes: free public ones by default. A paid node is a setting (PINR_RPC_BSC, PINR_RPC_BASE, PINR_RPC_SOLANA), nothing else changes.
 */
export interface Holding {
  address: string;
  chain: string;
  name: string | null;
  ticker: string | null;
  balance: number;
  /** balance x the token's price, or null when there is no price (such tokens are left out of the total) */
  usd: number | null;
  score: number | null;
  noScoreLabel: string | null;
}
export interface WalletView {
  /** ok: every chain answered; partial: some did not (see `unavailable`); error: none could be read */
  status: "ok" | "partial" | "error";
  holdings: Holding[];
  totalUsd: number | null;
  unavailable: string[];
}

export type Rpc = (url: string, body: unknown) => Promise<unknown>;
const defaultRpc: Rpc = async (url, body) => {
  const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(12_000) });
  if (!res.ok) throw new Error(`node answered ${res.status}`);
  return res.json();
};

const NODES: Record<string, { env: string; url: string }> = {
  bsc: { env: "PINR_RPC_BSC", url: "https://bsc-rpc.publicnode.com" },
  base: { env: "PINR_RPC_BASE", url: "https://base-rpc.publicnode.com" },
  solana: { env: "PINR_RPC_SOLANA", url: "https://api.mainnet-beta.solana.com" },
};
const nodeUrl = (chain: string): string => process.env[NODES[chain]!.env] || NODES[chain]!.url;

const decimalsCache = new Map<string, number>();
const BALANCE_OF = "0x70a08231";
const DECIMALS = "0x313ce567";
const hexNum = (h: unknown): number | null => (typeof h === "string" && /^0x[0-9a-fA-F]*$/.test(h) && h.length > 2 ? Number(BigInt(h)) : null);

const holding = (t: WireToken, balance: number): Holding => ({
  address: t.address,
  chain: t.chain ?? "",
  name: t.name,
  ticker: t.ticker,
  balance,
  usd: t.priceUsd !== null && Number.isFinite(t.priceUsd) ? balance * t.priceUsd : null,
  score: t.noScoreLabel ? null : t.score,
  noScoreLabel: t.noScoreLabel,
});

/** One batched request of eth_call reads (balanceOf, and decimals the first time a token is seen). */
async function evmHoldings(chain: string, owner: string, tokens: WireToken[], rpc: Rpc): Promise<Holding[]> {
  const url = nodeUrl(chain);
  const pad = owner.slice(2).toLowerCase().padStart(64, "0");
  const calls: { id: number; method: string; params: unknown[]; jsonrpc: string }[] = [];
  const need = tokens.filter((t) => !decimalsCache.has(`${chain}:${t.address.toLowerCase()}`));
  tokens.forEach((t, i) => calls.push({ jsonrpc: "2.0", id: i, method: "eth_call", params: [{ to: t.address, data: BALANCE_OF + pad }, "latest"] }));
  need.forEach((t, i) => calls.push({ jsonrpc: "2.0", id: 100_000 + i, method: "eth_call", params: [{ to: t.address, data: DECIMALS }, "latest"] }));
  const answers = new Map<number, unknown>();
  for (let i = 0; i < calls.length; i += 40) {
    const out = await rpc(url, calls.slice(i, i + 40));
    if (!Array.isArray(out)) throw new Error("the node did not answer a batch");
    for (const r of out as { id?: number; result?: unknown }[]) if (typeof r?.id === "number") answers.set(r.id, r.result);
  }
  need.forEach((t, i) => {
    const d = hexNum(answers.get(100_000 + i));
    if (d !== null && d >= 0 && d <= 36) decimalsCache.set(`${chain}:${t.address.toLowerCase()}`, d);
  });
  const out: Holding[] = [];
  tokens.forEach((t, i) => {
    const raw = hexNum(answers.get(i));
    const dec = decimalsCache.get(`${chain}:${t.address.toLowerCase()}`);
    if (raw === null || raw <= 0 || dec === undefined) return;
    out.push(holding(t, raw / 10 ** dec));
  });
  return out;
}

const TOKEN_PROGRAMS = ["TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"];

async function solanaHoldings(owner: string, tokens: WireToken[], rpc: Rpc): Promise<Holding[]> {
  const byMint = new Map(tokens.map((t) => [t.address, t]));
  const url = nodeUrl("solana");
  const out: Holding[] = [];
  for (const programId of TOKEN_PROGRAMS) {
    const res = (await rpc(url, { jsonrpc: "2.0", id: 1, method: "getTokenAccountsByOwner", params: [owner, { programId }, { encoding: "jsonParsed" }] })) as {
      result?: { value?: { account?: { data?: { parsed?: { info?: { mint?: string; tokenAmount?: { uiAmount?: number | null } } } } } }[] };
      error?: unknown;
    };
    if (res?.error || !res?.result?.value) throw new Error("the node did not answer");
    for (const acct of res.result.value) {
      const info = acct.account?.data?.parsed?.info;
      const t = info?.mint ? byMint.get(info.mint) : undefined;
      const amt = info?.tokenAmount?.uiAmount;
      if (t && typeof amt === "number" && amt > 0) out.push(holding(t, amt));
    }
  }
  return out;
}

const cache = new Map<string, { at: number; view: WalletView }>();
/** For tests: forget everything remembered. */
export function resetWalletCache(): void {
  cache.clear();
  decimalsCache.clear();
}
const CACHE_MS = 45_000;

export async function readHoldings(owner: string, chain: "evm" | "solana", roster: readonly WireToken[], rpc: Rpc = defaultRpc, now: () => number = Date.now): Promise<WalletView> {
  const key = `${chain}:${owner}`;
  const hit = cache.get(key);
  if (hit && now() - hit.at < CACHE_MS) return hit.view;
  const jobs: { chain: string; run: () => Promise<Holding[]> }[] =
    chain === "solana"
      ? [{ chain: "solana", run: () => solanaHoldings(owner, roster.filter((t) => t.chain === "solana"), rpc) }]
      : ["bsc", "base"].map((c) => ({ chain: c, run: () => evmHoldings(c, owner, roster.filter((t) => t.chain === c), rpc) }));
  const settled = await Promise.allSettled(jobs.map((j) => j.run()));
  const holdings: Holding[] = [];
  const unavailable: string[] = [];
  settled.forEach((r, i) => {
    if (r.status === "fulfilled") holdings.push(...r.value);
    else unavailable.push(jobs[i]!.chain);
  });
  holdings.sort((a, b) => (b.usd ?? -1) - (a.usd ?? -1));
  const priced = holdings.filter((h) => h.usd !== null);
  const view: WalletView = {
    status: unavailable.length === 0 ? "ok" : unavailable.length === jobs.length ? "error" : "partial",
    holdings: holdings.slice(0, 60),
    totalUsd: priced.length ? priced.reduce((s, h) => s + h.usd!, 0) : null,
    unavailable,
  };
  if (view.status !== "error") cache.set(key, { at: now(), view });
  return view;
}
