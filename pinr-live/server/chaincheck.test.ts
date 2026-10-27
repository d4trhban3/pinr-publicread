import { describe, expect, it } from "vitest";
import { ChainCreators, type CreatorRpc } from "./chaincheck.ts";

const MINT = "A7rRfLf67GMp5DFeY7s4kUaZLZbbz6UFPM5XYSg2pump";
const MINT2 = "B7rRfLf67GMp5DFeY7s4kUaZLZbbz6UFPM5XYSg2pump";
const WALLET = "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin";

describe("the creator from Pump.fun's coin record", () => {
  it("reads one coin per call, remembers it, and does not ask twice", async () => {
    const asked: string[] = [];
    const rpc: CreatorRpc = async (m) => (asked.push(m), { status: "ok", creator: WALLET });
    const c = new ChainCreators(rpc, () => 0);
    expect(c.wants(MINT)).toBe(true);
    await c.read([{ mint: MINT }, { mint: MINT2 }]);
    expect(asked).toEqual([MINT]); // one request per call, never a batch
    expect(c.creator(MINT)).toBe(WALLET);
    expect(c.wants(MINT)).toBe(false);
    await c.read([{ mint: MINT }, { mint: MINT2 }]);
    expect(asked).toEqual([MINT, MINT2]); // the next call moves to the next coin
  });
  it("rests when Pump.fun limits it, and never guesses when the record has no creator", async () => {
    let now = 0;
    const c = new ChainCreators(async () => ({ status: "limited" }), () => now);
    expect(await c.read([{ mint: MINT }])).toBe(false);
    expect(await c.read([{ mint: MINT2 }])).toBe(false);
    expect(c.creator(MINT)).toBeUndefined();
    now = 61_000;
    const none = new ChainCreators(async () => ({ status: "ok", creator: null }), () => 0);
    await none.read([{ mint: MINT }]);
    expect(none.creator(MINT)).toBeNull();
    expect(none.wants(MINT)).toBe(false); // tried today
  });
  it("waits after an error and refuses a malformed address without asking", async () => {
    let calls = 0;
    const c = new ChainCreators(async () => (calls++, { status: "error" }), () => 0);
    await c.read([{ mint: "../x" }]);
    expect(calls).toBe(0);
    expect(await c.read([{ mint: MINT }])).toBe(false);
    expect(await c.read([{ mint: MINT }])).toBe(false);
    expect(calls).toBe(1);
    expect(c.stat.errors).toBe(1);
  });
});
