import { describe, expect, it } from "vitest";
import { beforeEach } from "vitest";
import { readHoldings, resetWalletCache, type Rpc } from "./wallet.ts";
import { translate, type WireToken } from "./translate.ts";

const tok = (mint: string, chain: string, over: Record<string, unknown> = {}): WireToken =>
  translate({ mint, chain, score: 40, display: "40", label: null, coverage: 0.5, name: "Tok", ticker: "TOK", ...over }).token!;

const A = "0xaaa0000000000000000000000000000000000001";
const B = "0xbbb0000000000000000000000000000000000002";
const OWNER = "0x1111111111111111111111111111111111111111";
const hex = (n: bigint): string => "0x" + n.toString(16).padStart(64, "0");

describe("wallet holdings (read-only)", () => {
  beforeEach(() => resetWalletCache());
  it("reads EVM balances of tracked tokens, applies decimals and prices, skips zero balances", async () => {
    const a = tok(A, "bsc", { price_usd: 2 });
    const b = tok(B, "bsc");
    const calls: string[] = [];
    const rpc: Rpc = async (_url, body) => {
      const list = body as { id: number; params: { to: string; data: string }[] }[];
      return list.map((c) => {
        const { to, data } = c.params[0]!;
        calls.push(data.slice(0, 10));
        if (data.startsWith("0x313ce567")) return { id: c.id, result: hex(6n) };
        return { id: c.id, result: to === A ? hex(5_000_000n) : hex(0n) }; // A: 5 tokens at 6 decimals, B: nothing
      });
    };
    const v = await readHoldings(OWNER, "evm", [a, b], rpc, () => 1);
    expect(v.status).toBe("ok");
    expect(v.holdings).toHaveLength(1);
    expect(v.holdings[0]).toMatchObject({ address: A, balance: 5, usd: 10, score: 40 });
    expect(v.totalUsd).toBe(10);
    expect(new Set(calls)).toEqual(new Set(["0x70a08231", "0x313ce567"]));
  });
  it("only ever sends read calls (balanceOf, decimals, getTokenAccountsByOwner)", async () => {
    const methods = new Set<string>();
    const rpc: Rpc = async (_u, body) => {
      for (const c of Array.isArray(body) ? body : [body]) methods.add((c as { method: string }).method);
      return Array.isArray(body) ? body.map((c: { id: number }) => ({ id: c.id, result: hex(0n) })) : { result: { value: [] } };
    };
    await readHoldings("0x2222222222222222222222222222222222222222", "evm", [tok(A, "base")], rpc, () => 1);
    await readHoldings("SoLOwner1111111111111111111111111111111111", "solana", [tok("So1Mint11111111111111111111111111111111111", "solana")], rpc, () => 1);
    expect([...methods].sort()).toEqual(["eth_call", "getTokenAccountsByOwner"]);
  });
  it("reads Solana token accounts and keeps only tracked mints", async () => {
    const MINT = "3idYNqXE4fAJJNUHujGTbQNHCzhH52HwZyGoXBJ2bznW";
    const t = tok(MINT, "solana", { price_usd: 0.5, label: "MAYHEM", score: null, display: "MAYHEM" });
    const rpc: Rpc = async () => ({
      result: {
        value: [
          { account: { data: { parsed: { info: { mint: MINT, tokenAmount: { uiAmount: 100 } } } } } },
          { account: { data: { parsed: { info: { mint: "SomethingNotTracked1111111111111111111111111", tokenAmount: { uiAmount: 9 } } } } } },
          { account: { data: { parsed: { info: { mint: MINT, tokenAmount: { uiAmount: 0 } } } } } },
        ],
      },
    });
    const v = await readHoldings("So1Owner11111111111111111111111111111111111", "solana", [t], rpc, () => 1);
    expect(v.holdings.map((h) => [h.address, h.balance, h.usd])).toEqual([[MINT, 100, 50], [MINT, 100, 50]]); // two programs answered the same fake
    expect(v.holdings[0]!.noScoreLabel).toBe("MAYHEM");
    expect(v.holdings[0]!.score).toBeNull(); // a flagged token shows its label and no score
  });
  it("says so when a chain cannot be read, instead of guessing", async () => {
    const a = tok(A, "bsc");
    const b = tok(B, "base");
    const rpc: Rpc = async (url, body) => {
      if (url.includes("base")) throw new Error("down");
      return (body as { id: number }[]).map((c) => ({ id: c.id, result: hex(0n) }));
    };
    const v = await readHoldings("0x3333333333333333333333333333333333333333", "evm", [a, b], rpc, () => 1);
    expect(v.status).toBe("partial");
    expect(v.unavailable).toEqual(["base"]);
    const all = await readHoldings("0x4444444444444444444444444444444444444444", "evm", [a, b], async () => { throw new Error("down"); }, () => 1);
    expect(all.status).toBe("error");
  });
  it("leaves unpriced tokens out of the total", async () => {
    const a = tok(A, "bsc", { price_usd: 1 });
    const b = tok(B, "bsc");
    const rpc: Rpc = async (_u, body) => (body as { id: number; params: { data: string }[] }[]).map((c) => ({ id: c.id, result: c.params[0]!.data.startsWith("0x313ce567") ? hex(0n) : hex(3n) }));
    const v = await readHoldings("0x5555555555555555555555555555555555555555", "evm", [a, b], rpc, () => 1);
    expect(v.holdings).toHaveLength(2);
    expect(v.totalUsd).toBe(3);
    expect(v.holdings.find((h) => h.address === B)!.usd).toBeNull();
  });
});
