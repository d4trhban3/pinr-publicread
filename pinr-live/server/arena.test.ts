import { describe, expect, it } from "vitest";
import { arenaGroups, rankMembers, type ArenaCoin } from "./arena.ts";
import type { Plan } from "./hidden.ts";
import type { WireToken } from "./translate.ts";

const tok = (address: string, over: Partial<WireToken> = {}): WireToken => ({ address, name: "Frog", ticker: "FROG", chain: "solana", launchpad: "Pump.fun curve", imageUrl: null, launchedAtMs: 1000, volume24hUsd: null, change24hPct: null, valuationUsd: null, ...over }) as unknown as WireToken;
const coin = (address: string, over: Partial<ArenaCoin> = {}): ArenaCoin => ({ address, name: "Frog", ticker: "FROG", imageUrl: null, chain: "solana", launchpad: null, launchedAtMs: 1, recentTrades: 0, recentUsd: 0, recentAtLeast: false, recentKnown: true, volume24hUsd: null, xPosts: null, hasX: false, change24hPct: null, valuationUsd: null, earliest: false, tags: [], ...over });

describe("the PvP Arena", () => {
  it("ranks versions strictly by 30-minute volume, then X presence, then the chart; a missing figure ranks last", () => {
    const r = rankMembers([
      coin("a", { recentUsd: 100 }),
      coin("b", { recentUsd: 900 }),
      coin("c", { recentUsd: 100, xPosts: 4 }),
      coin("d", { recentUsd: 100, xPosts: 4, hasX: true }),
      coin("e", { recentUsd: 100, xPosts: null, hasX: false, change24hPct: 50 }),
    ]);
    expect(r.map((c) => c.address)).toEqual(["b", "d", "c", "e", "a"]);
  });
  it("shows every version of an active family, hidden copies too, hottest battle first; a quiet family or a lone coin is no battle", () => {
    const plan: Plan = { groups: [["a1", "a2"], ["b1", "b2", "b3"], ["c1", "c2"], ["d1", "x-gone"]], labels: new Map(), vamps: new Set(), cases: new Map() };
    const by = new Map<string, WireToken>([
      ["a1", tok("A1", { launchedAtMs: 500 })], ["a2", tok("A2")],
      ["b1", tok("B1", { name: "Cat", ticker: "CAT" })], ["b2", tok("B2", { name: "Cat", ticker: "CAT" })], ["b3", tok("B3", { name: "Cat", ticker: "CAT", links: { x: "https://x.com/cat" } as never })],
      ["c1", tok("C1")], ["c2", tok("C2")],
      ["d1", tok("D1")],
    ]);
    const act: Record<string, { n: number; usd: number }> = { a2: { n: 3, usd: 50 }, b2: { n: 9, usd: 400 }, b3: { n: 1, usd: 10 } };
    const g = arenaGroups(plan, by, (a) => act[a] ?? { n: 0, usd: 0 }, (a) => ({ posts: a === "B3" ? 2 : null }), () => null);
    expect(g.map((x) => x.title)).toEqual(["Cat", "Frog"]); // c (no trade in 30 min) and d (one version on the feed) are not battles
    expect(g[0]!.members.map((m) => m.address)).toEqual(["B2", "B3", "B1"]);
    expect(g[0]!.members[1]).toMatchObject({ xPosts: 2, hasX: true });
    expect(g[1]!.members.find((m) => m.address === "A1")!.earliest).toBe(true); // observed, not a judgement
  });
});

describe("the engine's battle groups (pvp-1, frontend-feed/_pvp.json)", () => {
  it("reads each group's members by mint, two or more; another contract, a stale file or no file is no answer", async () => {
    const { pvpGroups, pvpReader } = await import("./arena.ts");
    const { mkdtempSync, writeFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const doc = { contract: "pvp-1", as_of: new Date().toISOString(), groups: [{ id: "A", versions: 2, members: [{ mint: "Aa", how: "name" }, { mint: "Bb", how: "picture" }] }, { id: "C", versions: 1, members: [{ mint: "Cc" }] }] };
    expect(pvpGroups(doc)).toEqual([["aa", "bb"]]);
    expect(pvpGroups({ ...doc, contract: "pvp-2" })).toBeNull();
    const dir = mkdtempSync(join(tmpdir(), "pvp-"));
    const f = join(dir, "_pvp.json");
    expect(pvpReader(f)()).toBeNull();
    writeFileSync(f, JSON.stringify(doc));
    expect(pvpReader(f)()?.groups).toEqual([["aa", "bb"]]);
    writeFileSync(f, JSON.stringify({ ...doc, as_of: new Date(Date.now() - 11 * 60_000).toISOString() }));
    expect(pvpReader(f)()).toBeNull(); // more than 10 minutes old: the site's own families instead
  });
});

describe("battle members' own names", () => {
  it("a member with no feed record shows by the file's name and ticker, figures a dash; a record with no name takes the file's; neither leaves the address", async () => {
    const { pvpNames } = await import("./arena.ts");
    const doc = { contract: "pvp-1", groups: [{ id: "A", members: [{ mint: "A1" }, { mint: "A2", name: "Frog\u200b Two", ticker: "FROG" }, { mint: "A3", name: "Off List", ticker: "OFF" }, { mint: "A4" }, { mint: "A5", name: 7, ticker: "" }] }] };
    const names = pvpNames(doc);
    expect([...names.keys()]).toEqual(["a2", "a3"]); // A1, A4, A5: no usable name or ticker
    expect(names.get("a2")).toEqual({ address: "A2", name: "Frog Two", ticker: "FROG" }); // invisible characters stripped
    const plan: Plan = { groups: [["a1", "a2", "a3", "a4"]], labels: new Map(), vamps: new Set(), cases: new Map() };
    const by = new Map<string, WireToken>([["a1", tok("A1")], ["a2", tok("A2", { name: null as never, ticker: null as never })]]);
    const g = arenaGroups(plan, by, (a) => (a === "a1" ? { n: 2, usd: 30 } : { n: 0, usd: 0 }), () => ({ posts: null }), () => null, 40, names);
    const m = Object.fromEntries(g[0]!.members.map((x) => [x.address, x]));
    expect(Object.keys(m).sort()).toEqual(["A1", "A2", "A3"]); // A4: no record and no name in the file
    expect(m.A2).toMatchObject({ name: "Frog Two", ticker: "FROG", chain: "solana" });
    expect(m.A3).toMatchObject({ name: "Off List", ticker: "OFF", chain: null, launchpad: null, valuationUsd: null, volume24hUsd: null, imageUrl: null, earliest: false });
    expect(m.A1).toMatchObject({ name: "Frog", ticker: "FROG" }); // a record's own name is never replaced
  });
  it("without names in the file nothing changes (before the engine's change is live)", () => {
    const plan: Plan = { groups: [["a1", "a2", "a3"]], labels: new Map(), vamps: new Set(), cases: new Map() };
    const by = new Map<string, WireToken>([["a1", tok("A1")], ["a2", tok("A2")]]);
    const g = arenaGroups(plan, by, () => ({ n: 1, usd: 1 }), () => ({ posts: null }), () => null);
    expect(g[0]!.members.map((x) => x.address).sort()).toEqual(["A1", "A2"]);
  });
});

describe("checklist 7: an Arena member's 30 minutes not read yet is not a zero", () => {
  it("carries recentKnown from the activity board", () => {
    const plan: Plan = { groups: [["a1", "a2"]], labels: new Map(), vamps: new Set(), cases: new Map() };
    const by = new Map<string, WireToken>([["a1", tok("A1")], ["a2", tok("A2")]]);
    const g = arenaGroups(plan, by, (a) => (a === "a1" ? { n: 3, usd: 9 } : { n: 0, usd: 0 }), () => ({ posts: null }), () => null, 40, new Map(), (a) => a === "a1");
    const m = Object.fromEntries(g[0]!.members.map((x) => [x.address, x]));
    expect(m.A1).toMatchObject({ recentTrades: 3, recentKnown: true });
    expect(m.A2).toMatchObject({ recentTrades: 0, recentKnown: false });
  });
});

describe("a battle's versions stay off the lists, its leader stays on", () => {
  it("keeps every version but the Arena's first off the lists", async () => {
    const { behindLeaders } = await import("./arena.ts");
    const by = new Map<string, WireToken>([
      ["a1", tok("A1", { valuationUsd: 900 } as never)],
      ["a2", tok("A2", { valuationUsd: 100 } as never)],
      ["a3", tok("A3", { valuationUsd: 50, launchedAtMs: 1 } as never)],
      ["b1", tok("B1", { launchedAtMs: 5 } as never)],
      ["b2", tok("B2", { launchedAtMs: 2 } as never)],
    ]);
    const act: Record<string, { n: number; usd: number }> = { a2: { n: 3, usd: 40 } };
    const behind = behindLeaders([["a1", "a2", "a3"], ["b1", "b2"]], (a) => by.get(a), (a) => act[a] ?? { n: 0, usd: 0 });
    expect([...behind].sort()).toEqual(["a1", "a3", "b1"]); // a2 leads on 30-min dollars; b2 on the earlier launch when nothing traded
  });
  it("a battle of one, or no battles, keeps nothing off", async () => {
    const { behindLeaders } = await import("./arena.ts");
    expect(behindLeaders([], () => undefined, () => ({ n: 0, usd: 0 })).size).toBe(0);
    expect(behindLeaders([["x"]], () => undefined, () => ({ n: 0, usd: 0 })).size).toBe(0);
  });
});
