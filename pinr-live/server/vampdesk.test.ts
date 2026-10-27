import { describe, expect, it } from "vitest";
import { VampDesk } from "./vampdesk.ts";
import { PictureHashes } from "./imagehash.ts";
import { ChainCreators, type CreatorRpc } from "./chaincheck.ts";
import { cleanCoin, type PumpCoin } from "./pumpfun.ts";

const mint = (n: number): string => `${"ABCDEFGHJKLMNPQRSTUVWXYZ"[n]}7rRfLf67GMp5DFeY7s4kUaZLZbbz6UFPM5XYSg2pump`.slice(0, 44);
const W1 = "Bvscx2uvsjcJ9YuMM95zFYvXQGDh9KKMdaLuAiPVNgj";
const W2 = "CvscxA2uvsjcJ9YuMM95zFYvXQGDh9KKMdaLuAiPVNg";
function coin(n: number, image: string, creator: string, createdMs: number): PumpCoin {
  return cleanCoin({ mint: mint(n), name: `C${n}`, symbol: `C${n}`, usd_market_cap: 5000, total_supply: 1e15, base_decimals: 6, created_timestamp: createdMs, image_uri: image, creator, bonding_curve: mint(n + 10) }, 1)!;
}
const IMG_A = "https://img.example/a.png";
const IMG_B = "https://img.example/b.png";

/** A picture store with chosen hashes (no network). */
function pictures(map: Record<string, string>): PictureHashes {
  const p = new PictureHashes();
  (p as unknown as { hashes: Map<string, string> }).hashes = new Map(Object.entries(map));
  return p;
}
function creators(map: Record<string, string | null>): ChainCreators {
  const c = new ChainCreators((async () => ({ status: "ok", creator: null })) as CreatorRpc, () => 0);
  (c as unknown as { known: Map<string, { creator: string | null; at: number }> }).known = new Map(Object.entries(map).map(([k, v]) => [k, { creator: v, at: 0 }]));
  return c;
}

describe("VampDesk", () => {
  const now = () => 100_000;
  it("flags the same file as a copy, and says the chain has not been read yet", () => {
    const desk = new VampDesk(pictures({}), creators({}), now);
    const v = desk.judge([coin(0, IMG_A, W1, 1000), coin(1, IMG_A, W2, 2000)], []).verdicts;
    expect(v.get(mint(1))).toMatchObject({ id: mint(0), basis: "same file", chain: "unchecked" });
    expect(v.has(mint(0))).toBe(false);
  });
  it("confirms a copy when the chain shows two different wallets, and drops it when the chain shows one wallet", () => {
    const two = new VampDesk(pictures({}), creators({ [mint(0)]: "WALLET-ONE", [mint(1)]: "WALLET-TWO" }), now);
    expect(two.judge([coin(0, IMG_A, W1, 1000), coin(1, IMG_A, W2, 2000)], []).verdicts.get(mint(1))?.chain).toBe("confirmed");
    const same = new VampDesk(pictures({}), creators({ [mint(0)]: "WALLET-ONE", [mint(1)]: "WALLET-ONE" }), now);
    expect(same.judge([coin(0, IMG_A, W1, 1000), coin(1, IMG_A, W2, 2000)], []).verdicts.size).toBe(0);
  });
  it("calls a near match a copy only when the chain confirms two wallets", () => {
    // two different files whose hashes differ by two bits
    const hashes = { [IMG_A]: "f0ba49251a4caef0", [IMG_B]: "f0ba49251a4caef3" };
    const open = new VampDesk(pictures(hashes), creators({}), now);
    const coins = [coin(0, IMG_A, W1, 1000), coin(1, IMG_B, W2, 2000)];
    const first = open.judge(coins, []);
    expect(first.verdicts.size).toBe(0);
    expect(first.candidates[0]).toMatchObject({ copy: mint(1), original: { id: mint(0), basis: "near match" } });
    const later = new VampDesk(pictures(hashes), creators({ [mint(0)]: "WALLET-ONE", [mint(1)]: "WALLET-TWO" }), () => 200_000);
    expect(later.judge(coins, []).verdicts.get(mint(1))).toMatchObject({ basis: "near match", chain: "confirmed" });
  });
  it("does not match pictures that look different, or a bland one-tone picture", () => {
    const d = new VampDesk(pictures({ [IMG_A]: "f0ba49251a4caef0", [IMG_B]: "0f45b6dae5b3510f" }), creators({ [mint(0)]: "A", [mint(1)]: "B" }), now);
    expect(d.judge([coin(0, IMG_A, W1, 1000), coin(1, IMG_B, W2, 2000)], []).verdicts.size).toBe(0);
    const bland = new VampDesk(pictures({ [IMG_A]: "0000000000000000", [IMG_B]: "0000000000000000" }), creators({ [mint(0)]: "A", [mint(1)]: "B" }), () => 300_000);
    expect(bland.judge([coin(0, IMG_A, W1, 1000), coin(1, IMG_B, W2, 2000)], []).verdicts.size).toBe(0);
  });
});
