import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadFeed, orderRoster } from "./feed.ts";
import { translate, type WireToken } from "./translate.ts";

const tok = (n: number, over: Record<string, unknown> = {}): WireToken =>
  translate({ mint: `0x${String(n).padStart(40, "0")}`, score: 30, display: "30", label: null, coverage: 0.5, ...over }).token!;

describe("the roster", () => {
  it("shows the engine's own order first, then bigger valuation, then address", () => {
    const r = orderRoster([tok(1, { valuation_usd: 10 }), tok(2, { valuation_usd: 500 }), tok(3, { roster_rank: 1 }), tok(4, { roster_rank: 0 }), tok(5)]);
    expect(r.tokens.map((t) => Number(BigInt(t.address)))).toEqual([4, 3, 2, 1, 5]);
  });

  it("is stable: the same files give the same order every time", () => {
    const a = [tok(7), tok(2), tok(9), tok(1)];
    expect(orderRoster(a).tokens.map((t) => t.address)).toEqual(orderRoster([...a].reverse()).tokens.map((t) => t.address));
  });

  it("passes the first 300 in full and keeps every other scored token in `rest`, in the same order", () => {
    const many = Array.from({ length: 310 }, (_, i) => tok(i + 1, { roster_rank: i }));
    const r = orderRoster(many);
    expect(r.rest.length).toBe(10);
    expect(r.tokens.length + r.rest.length).toBe(310);
    expect(r.rest[0]!.address).toBe(many[300]!.address);
    expect(new Set([...r.tokens, ...r.rest].map((t) => t.address)).size).toBe(310);
  });

  it("keeps at most 300 on the first page and says how many are on the rest", () => {
    const many = Array.from({ length: 310 }, (_, i) => tok(i + 1, { roster_rank: i }));
    const r = orderRoster(many);
    expect(r.tokens.length).toBe(300);
    expect(r.cut).toBe(10);
    expect(Number(BigInt(r.tokens[0]!.address))).toBe(1);
    expect(orderRoster(many.slice(0, 3)).cut).toBe(0);
  });

  it("rejects a roster_rank that is not a whole number of zero or more", () => {
    expect(tok(1, { roster_rank: -1 }).rank).toBeNull();
    expect(tok(1, { roster_rank: 2.5 }).rank).toBeNull();
    expect(tok(1, { roster_rank: 3 }).rank).toBe(3);
  });
});

describe("the early field", () => {
  const base = { mint: "0x" + "1".repeat(40), score: 30, display: "30", label: null, coverage: 0.2 };
  it("passes `early: true` on and leaves it absent otherwise", () => {
    expect(translate({ ...base, early: true }).token!.early).toBe(true);
    expect("early" in translate(base).token!).toBe(false);
  });
  it("treats false or junk as not early, with a warning, and never an error", () => {
    for (const v of [false, "yes", 1]) {
      const t = translate({ ...base, early: v });
      expect(t.token).not.toBeNull();
      expect("early" in t.token!).toBe(false);
      expect(t.problems.map((p) => p.severity)).toEqual(["warning"]);
    }
    expect(translate({ ...base, early: null }).problems).toEqual([]);
  });
});

describe("the social_check field", () => {
  const base = { mint: "0x" + "1".repeat(40), score: 30, display: "30", label: null, coverage: 0.2 };
  it('marks only "not_checked"; "done" and absent leave it out, with no problem', () => {
    expect(translate({ ...base, social_check: "not_checked" }).token!.socialNotChecked).toBe(true);
    for (const v of ["done", undefined, null]) {
      const t = translate({ ...base, social_check: v });
      expect("socialNotChecked" in t.token!).toBe(false);
      expect(t.problems).toEqual([]);
    }
    expect("socialNotChecked" in translate(base).token!).toBe(false);
  });
  it("treats any other value as missing, with a warning and no error", () => {
    for (const v of [true, "yes", 1]) {
      const t = translate({ ...base, social_check: v });
      expect("socialNotChecked" in t.token!).toBe(false);
      expect(t.problems.map((p) => p.severity)).toEqual(["warning"]);
    }
  });
});

describe("the feed folder", () => {
  it("never reads the scanner's queue record (trigger-seen.json) as a coin's file", () => {
    const dir = mkdtempSync(join(tmpdir(), "feed-"));
    writeFileSync(join(dir, "trigger-seen.json"), JSON.stringify({ contract: "1.1", as_of: "2026-10-14T00:00:00Z", coins: {} }));
    const snap = loadFeed([{ dir, feed: true }]);
    expect(snap.problems).toEqual([]);
    expect(snap.tokens).toHaveLength(0);
  });
});

describe("the saved gate runs are replayed only until the drop folder has files (the contract, point 4; -10-25)", () => {
  it("tells a folder with coin files from an empty one or one with only the engine's own files", async () => {
    const { mkdtempSync, writeFileSync, mkdirSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { hasCoinFiles } = await import("./feed.ts");
    const d = mkdtempSync(join(tmpdir(), "drop-"));
    expect(hasCoinFiles(d)).toBe(false);
    writeFileSync(join(d, "_quiet.json"), "{}");
    mkdirSync(join(d, "ticks"));
    expect(hasCoinFiles(d)).toBe(false);
    writeFileSync(join(d, "So1Coin.json"), "{}");
    expect(hasCoinFiles(d)).toBe(true);
    expect(hasCoinFiles(join(d, "missing"))).toBe(false);
  });
});
