import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parsePoolEvents, POOL_SHOWN, readPoolEvents } from "./poolevents.ts";

const MINT = "So1PumpCoin111111111111111111111111111111111";
const SIG = "5".repeat(88);
const ev = (t: number, kind: string, over: Record<string, unknown> = {}) => ({ t, slot: 1, sig: SIG, i: 0, kind, pool: "Po" + "1".repeat(40), quote_mint: "So11111111111111111111111111111111111111112", raw: false, ...over });
const file = (events: unknown[]) => ({ contract: "pool-events-1", mint: MINT, source: "Solana chain", as_of: "2026-10-25T18:00:00Z", events });

describe("a coin's pool events, observed on chain", () => {
  it("keeps the five kinds, newest first, each with its transaction; checked fields only, a missing one absent (never zero)", () => {
    const p = parsePoolEvents(file([ev(1000, "pool created", { pool_base: 1e9, pool_quote: 30 }), ev(3000, "liquidity removed", { user: "Us" + "1".repeat(40), base: 5e6, quote: 2 }), ev(2000, "wash trade"), ev(4000, "coin creator changed", { old_coin_creator: "Ol" + "1".repeat(40), new_coin_creator: "Ne" + "1".repeat(40) }), { ...ev(5000, "liquidity added"), sig: "short" }]), MINT)!;
    expect(p.state).toBe("read");
    expect(p.events.map((e) => e.kind)).toEqual(["coin creator changed", "liquidity removed", "pool created"]);
    expect(p.events[1]).toMatchObject({ user: "Us" + "1".repeat(40), base: 5e6, quote: 2, quoteSymbol: "SOL", raw: false });
    expect(p.events[2]).toMatchObject({ poolBase: 1e9, poolQuote: 30 });
    expect("base" in p.events[2]!).toBe(false);
    expect(p.asOfMs).toBe(Date.parse("2026-10-25T18:00:00Z"));
  });
  it("a row's id may be a Solana signature or a 0x hash; the chain names the explorer; a row fitting neither is dropped", () => {
    const addr = "0x" + "ab".repeat(20);
    const h = "0x" + "cd".repeat(32);
    const sol = "5".repeat(88);
    const rows = [{ t: 1_700_000_000_000, kind: "pool created", sig: h }, { t: 1_700_000_001_000, kind: "liquidity added", sig: sol }, { t: 1_700_000_002_000, kind: "liquidity removed", sig: "0xzz" }];
    const r = parsePoolEvents({ contract: "pool-events-1", mint: addr, chain: "base", events: rows }, addr);
    expect(r?.chain).toBe("base");
    expect(r?.events.map((e) => e.sig).sort()).toEqual([h, sol].sort());
    expect(parsePoolEvents({ contract: "pool-events-1", mint: addr, chain: "bnb", events: rows }, addr)?.chain).toBe("bnb");
    expect(parsePoolEvents({ contract: "pool-events-1", mint: addr, chain: "bsc", events: rows }, addr)?.chain).toBe("bnb");
    expect(parsePoolEvents({ contract: "pool-events-1", mint: "A".repeat(44), events: [] }, "A".repeat(44))?.chain).toBe("solana");
  });
  it("is not checked yet with no file, and no events observed with an empty one; another coin's or another contract's file is no answer", () => {
    const dir = mkdtempSync(join(tmpdir(), "pool-"));
    expect(readPoolEvents(MINT, dir).state).toBe("none");
    writeFileSync(join(dir, `${MINT}.json`), JSON.stringify(file([])));
    expect(readPoolEvents(MINT, dir)).toMatchObject({ state: "read", events: [] });
    expect(parsePoolEvents({ ...file([]), mint: "Other1111111111111111111111111111111111111" }, MINT)).toBeNull();
    expect(parsePoolEvents({ ...file([]), contract: "pool-events-2" }, MINT)).toBeNull();
    expect(readPoolEvents("../etc/passwd", dir).state).toBe("none");
  });
  it("shows at most the newest POOL_SHOWN events", () => {
    const p = parsePoolEvents(file(Array.from({ length: 300 }, (_, i) => ev(i + 1, "liquidity added", { base: 1 }))), MINT)!;
    expect(p.events).toHaveLength(POOL_SHOWN);
    expect(p.events[0]!.atMs).toBe(300);
  });
});
