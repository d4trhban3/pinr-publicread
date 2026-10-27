import { describe, expect, it } from "vitest";
import { poolRowsOf } from "./poolevents.ts";
import type { Evidence } from "./evidence.ts";

const row = (what: string, to: { kind: string; id: string }, extra: Record<string, unknown> = {}) => ({
  from: { kind: "token", id: "0xabc" }, to, what, value: null, unit: null, atMs: null, firstReadMs: 1, readMs: 2, source: "Base chain", link: null, onchain: true, ...extra,
});

describe("pool rows from the evidence file (checklist 6, Base coin 0xc944…)", () => {
  it("keeps the pool trades and the liquidity lock, with no link where the file has none, and leaves other rows out", () => {
    const ev = { rows: [row("creator", { kind: "wallet", id: "0x1" }), row("liquidity locked", { kind: "locker", id: "Clanker locker" }, { value: 1, unit: "share of pool value" }), row("trades in pool (Uniswap v4)", { kind: "pool", id: "0xcb9e" })] } as unknown as Evidence;
    const out = poolRowsOf(ev);
    expect(out.map((r) => r.what)).toEqual(["liquidity locked", "trades in pool (Uniswap v4)"]);
    expect(out[0]).toMatchObject({ value: 1, unit: "share of pool value", onchain: true, link: null });
    expect(poolRowsOf(null)).toEqual([]);
  });
});
