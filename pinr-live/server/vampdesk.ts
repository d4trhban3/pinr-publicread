import { hamming, isBlandHash, NEAR, type PictureHashes } from "./imagehash.ts";
import type { ChainCreators } from "./chaincheck.ts";
import { findVamps, imageKey, type Launch, type Original } from "./vamp.ts";
import type { PumpCoin } from "./pumpfun.ts";
import type { WireToken } from "./translate.ts";

/**
 * The VAMP desk: decides which launchpad coins are copies, and of what, with evidence of three kinds that back each other up.
 *   1. the picture: the very same file as an earlier coin, or (after comparing what the pictures look like) a near match of one;
 *   2. the order: the original launched first;
 *   3. the chain: the two coins were made by DIFFERENT wallets, read from Pump.fun's coin record.
 * A near match is only called a copy when the chain confirms two different creators. The same file is called a copy unless the chain
 * shows the same wallet made both (that is a relaunch). Anything the chain could not be asked stays "unchecked", and says so.
 */
interface Prepared {
  coin: PumpCoin;
  key: string | null;
  hash: string | null;
  hi: number;
  lo: number;
  creator: string | null;
}

const popcount = (n: number): number => {
  n -= (n >>> 1) & 0x55555555;
  n = (n & 0x33333333) + ((n >>> 2) & 0x33333333);
  return (((n + (n >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24;
};

export interface DeskCandidate {
  copy: string;
  original: Original;
}

export class VampDesk {
  private cache: { stamp: string; verdicts: Map<string, Original>; candidates: DeskCandidate[] } | null = null;

  constructor(
    private pictures: PictureHashes,
    private creators: ChainCreators,
    private now: () => number = Date.now,
  ) {}

  /** Judge the coins held right now. Cheap to ask often: the answer is kept until something it depends on changes. */
  judge(coins: readonly PumpCoin[], scored: readonly WireToken[]): { verdicts: Map<string, Original>; candidates: DeskCandidate[] } {
    // the answer is kept for ten seconds: the work behind it grows with the square of the coins held, and nothing changes that fast
    const stamp = `${Math.floor(this.now() / 10_000)}|${scored.length > 0}`;
    if (this.cache?.stamp === stamp) return this.cache;
    const prepared: Prepared[] = coins
      .map((coin) => {
        const key = imageKey(coin.image);
        const hash = key ? (this.pictures.get(key) ?? null) : null;
        const usable = hash && !isBlandHash(hash) ? hash : null;
        const chainCreator = this.creators.creator(coin.mint);
        return {
          coin,
          key,
          hash: usable,
          hi: usable ? parseInt(usable.slice(0, 8), 16) : 0,
          lo: usable ? parseInt(usable.slice(8), 16) : 0,
          creator: typeof chainCreator === "string" ? chainCreator : coin.creator,
        } as Prepared;
      })
      .sort((a, b) => a.coin.createdMs - b.coin.createdMs || (a.coin.mint < b.coin.mint ? -1 : 1));

    const byMint = new Map(prepared.map((p) => [p.coin.mint, p]));
    const verdicts = new Map<string, Original>();
    const candidates: DeskCandidate[] = [];

    // the same file (and a scored token on another chain): the original rule, run on the chain-corrected creators
    const launches: Launch[] = prepared.map((p) => ({ id: p.coin.mint, ticker: tick(p.coin), image: p.coin.image, creator: p.creator, createdMs: p.coin.createdMs }));
    const elsewhere = scored
      .filter((t) => t.chain !== "solana" && t.imageUrl && t.launchedAtMs !== null && t.noScoreLabel !== "VAMP")
      .map((t) => ({ id: t.address, ticker: t.ticker ?? t.name ?? t.address, image: t.imageUrl, launchedMs: t.launchedAtMs! }));
    for (const [copy, o] of findVamps(launches, elsewhere)) {
      const c = byMint.get(copy)!;
      const orig = byMint.get(o.id);
      const chainC = this.creators.creator(copy);
      const chainO = orig ? this.creators.creator(o.id) : undefined;
      if (typeof chainC === "string" && typeof chainO === "string" && chainC === chainO) continue; // the same wallet made both: a relaunch
      const confirmed = typeof chainC === "string" && typeof chainO === "string";
      void c;
      candidates.push({ copy, original: { ...o, basis: "same file", chain: confirmed ? "confirmed" : "unchecked" } });
      verdicts.set(copy, { ...o, basis: "same file", chain: confirmed ? "confirmed" : "unchecked" });
    }

    // near matches: a picture that looks the same to a person. Needs the chain to confirm two different creators.
    const withHash = prepared.filter((p) => p.hash);
    for (let i = 0; i < withHash.length; i++) {
      const c = withHash[i]!;
      if (verdicts.has(c.coin.mint) || c.creator === null) continue;
      for (let j = 0; j < i; j++) {
        const o = withHash[j]!;
        if (o.creator === null || o.creator === c.creator || o.coin.createdMs >= c.coin.createdMs) continue;
        if (popcount((c.hi ^ o.hi) >>> 0) + popcount((c.lo ^ o.lo) >>> 0) > NEAR || (o.key !== null && o.key === c.key)) continue;
        // the earliest such coin is the original (the list is oldest first, so the first hit is it)
        const original: Original = { id: o.coin.mint, ticker: tick(o.coin), basis: "near match", chain: "unchecked" };
        const chainC = this.creators.creator(c.coin.mint);
        const chainO = this.creators.creator(o.coin.mint);
        if (typeof chainC === "string" && typeof chainO === "string") {
          if (chainC === chainO) break; // one wallet: a relaunch, not a copy
          original.chain = "confirmed";
          verdicts.set(c.coin.mint, original);
        }
        candidates.push({ copy: c.coin.mint, original });
        break;
      }
    }
    this.cache = { stamp, verdicts, candidates };
    return this.cache;
  }

  /** The next picture worth looking at: the newest coin that has a picture and no hash yet. */
  nextPicture(coins: readonly PumpCoin[]): PumpCoin | null {
    let best: PumpCoin | null = null;
    for (const c of coins) {
      const key = imageKey(c.image);
      if (!key || !c.image || !this.pictures.wants(key)) continue;
      if (!best || c.createdMs > best.createdMs) best = c;
    }
    return best;
  }

  /** The next batch of coins (one at a time) whose creators Pump.fun should be asked about: the coins in pairings that are waiting on it. */
  nextChainReads(coins: readonly PumpCoin[], scored: readonly WireToken[], max = 1): PumpCoin[] {
    const byMint = new Map(coins.map((c) => [c.mint, c]));
    const out = new Map<string, PumpCoin>();
    for (const cand of this.judge(coins, scored).candidates) {
      for (const id of [cand.copy, cand.original.id]) {
        const c = byMint.get(id);
        if (c && this.creators.wants(id) && !out.has(id)) out.set(id, c);
        if (out.size >= max) return [...out.values()];
      }
    }
    return [...out.values()];
  }
}

function tick(c: PumpCoin): string {
  return c.symbol ? (c.symbol.startsWith("$") ? c.symbol : `$${c.symbol}`) : c.name;
}

export { hamming };
