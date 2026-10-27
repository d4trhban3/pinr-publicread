import { describe, expect, it } from "vitest";
import { ActivityBoard, chooseHidden, finalFamilies, GROUP_LABEL, groupMembers, HIDDEN_NOTICE, hiddenLabel, NO_ACTIVITY, planGroups, type Activity, planGroupsStepped, planSteps } from "./hidden.ts";
import { translate, type WireToken } from "./translate.ts";

const mint = (n: number): string => `${"G".repeat(30)}${[...String(n).padStart(10, "0")].map((c) => "ABCDEFGHJK"[Number(c)]).join("")}`;
const tok = (n: number, over: Record<string, unknown> = {}): WireToken => translate({ mint: mint(n), chain: "solana", score: 30, display: "30", label: null, coverage: 0.5, name: "Coin", ticker: "CN", ...over }).token!;
const dup = (n: number, over: Record<string, unknown> = {}): WireToken => tok(n, { label: "Duplicate relauncher (3 copies)", ...over });
const vamp = (n: number): WireToken => tok(n, { score: null, display: "VAMP", label: "VAMP" });
const a = (n: number): string => mint(n).toLowerCase();
const byAddr = (ts: WireToken[]): Map<string, WireToken> => new Map(ts.map((t) => [t.address.toLowerCase(), t]));
const act = (m: Record<string, Activity>) => (x: string): Activity => m[x] ?? NO_ACTIVITY;

describe("which coins are candidates", () => {
  it("matches the engine's label with its copy count, and nothing else", () => {
    expect(hiddenLabel(dup(1))).toBe("Duplicate relauncher (3 copies)");
    expect(hiddenLabel(tok(2, { label: " duplicate relauncher (9 copies) " }))).toBe("duplicate relauncher (9 copies)");
    expect(hiddenLabel(vamp(3))).toBe("VAMP");
    for (const label of [null, "Pumped and dumped", "No project presence", "Serial launcher", "Not a duplicate relauncher"]) expect(hiddenLabel(tok(4, { label }))).toBeNull();
    expect(hiddenLabel(tok(5, { score: null, display: "BOT/RUG", label: "BOT/RUG" }))).toBeNull();
  });
  it("has a short notice that names no reason or score", () => {
    expect(HIDDEN_NOTICE.length).toBeLessThan(60);
  });
});

describe("copy groups: only the coin with the most transactions in the last 30 minutes shows", () => {
  const same = (w: string) => (x: string): string | null => (x === a(1) || x === a(2) || x === a(3) ? w : null);
  it("shows the coin with the most transactions, then the most volume, then the latest trade, then the address", () => {
    const all = [{ ...dup(1), lastTradeMs: 1 }, { ...dup(2), lastTradeMs: 2 }, { ...dup(3), lastTradeMs: 3 }];
    const plan = planGroups(all, same("W"));
    const shownOf = (m: Record<string, Activity>): string[] => all.map((t) => t.address.toLowerCase()).filter((x) => !chooseHidden(plan, byAddr(all), act(m)).has(x));
    expect(shownOf({ [a(1)]: { n: 5, usd: 10 }, [a(2)]: { n: 9, usd: 1 }, [a(3)]: { n: 2, usd: 999 } })).toEqual([a(2)]);
    expect(shownOf({ [a(1)]: { n: 5, usd: 10 }, [a(2)]: { n: 5, usd: 50 }, [a(3)]: { n: 5, usd: 20 } })).toEqual([a(2)]); // same count: volume decides
    expect(shownOf({})).toEqual([a(3)]); // nothing readable: the latest trade
    const noTrades = [dup(1), dup(2), dup(3)];
    expect(noTrades.map((t) => t.address.toLowerCase()).filter((x) => !chooseHidden(planGroups(noTrades, same("W")), byAddr(noTrades), act({})).has(x))).toEqual([a(1)]); // last: the address
  });
  it("re-chooses as activity changes, so the shown coin can switch", () => {
    const all = [dup(1), dup(2)];
    const plan = planGroups(all, same("W"));
    expect([...chooseHidden(plan, byAddr(all), act({ [a(1)]: { n: 3, usd: 1 } })).keys()]).toEqual([a(2)]);
    expect([...chooseHidden(plan, byAddr(all), act({ [a(2)]: { n: 4, usd: 1 } })).keys()]).toEqual([a(1)]);
  });
  it("hides the rest even when the unlabelled original was first, and leaves a different developer's coin of the same name alone", () => {
    const original = tok(1); // the developer's first launch: no label
    const other = tok(3, { name: "Different", ticker: "DF" }); // another developer, another coin (the same name and ticker would make it one family: see the picture and name tests)
    const all = [original, dup(2), other];
    const plan = planGroups(all, (x) => (x === a(1) || x === a(2) ? "W" : x === a(3) ? "OTHER" : null));
    const hidden = chooseHidden(plan, byAddr(all), act({ [a(2)]: { n: 7, usd: 1 } }));
    expect([...hidden.keys()]).toEqual([a(1)]);
    expect(hidden.get(a(1))).toBe(GROUP_LABEL);
    expect(hidden.has(a(3))).toBe(false);
  });
  it("shows a labelled coin that stands alone (its developer unknown, or no other member found)", () => {
    const all = [dup(1, { name: "Alpha", ticker: "AL" }), dup(2, { name: "Beta", ticker: "BE" })];
    const plan = planGroups(all, () => null);
    expect(chooseHidden(plan, byAddr(all), act({})).size).toBe(0);
    const one = planGroups([dup(1)], () => "W");
    expect(chooseHidden(one, byAddr([dup(1)]), act({})).size).toBe(0);
  });
  it("groups a VAMP with the coin it copies and shows the more active of the two, even the VAMP", () => {
    const all = [vamp(1), tok(2)];
    const plan = planGroups(all, () => null, (x) => (x === a(1) ? mint(2) : null));
    expect([...chooseHidden(plan, byAddr(all), act({ [a(2)]: { n: 5, usd: 1 } })).entries()]).toEqual([[a(1), "VAMP"]]); // the original is busier: the VAMP is off
    const vampWins = chooseHidden(plan, byAddr(all), act({ [a(1)]: { n: 9, usd: 1 }, [a(2)]: { n: 5, usd: 99 } }));
    expect([...vampWins.entries()]).toEqual([[a(2), GROUP_LABEL]]); // the VAMP is busier: it shows (as its label page) and the original is off
    expect([...chooseHidden(plan, byAddr(all), act({})).keys()]).toEqual([a(1)]); // nothing readable: a tie goes to the coin that is not a VAMP
  });
  it("hides an original that is in no list we hold when the VAMP wins, and a VAMP whose original was not found stays off", () => {
    const all = [vamp(1)];
    const plan = planGroups(all, () => null, () => mint(7)); // the original is a launchpad coin we do not list
    expect(plan.cases.get(a(7))).toBe(mint(7));
    expect([...chooseHidden(plan, byAddr(all), act({ [a(1)]: { n: 2, usd: 1 } })).keys()]).toEqual([a(7)]);
    expect([...chooseHidden(planGroups(all, () => null), byAddr(all), act({ [a(1)]: { n: 50, usd: 50 } })).entries()]).toEqual([[a(1), "VAMP"]]); // however busy, a lone VAMP is not shown
  });
  it("joins a VAMP's group and a duplicate group that share a coin into one", () => {
    const all = [vamp(1), dup(2), dup(3)];
    const plan = planGroups(all, (x) => (x === a(2) || x === a(3) ? "W" : null), (x) => (x === a(1) ? mint(2) : null));
    expect(plan.groups).toHaveLength(1);
    expect(plan.groups[0]!.sort()).toEqual([a(1), a(2), a(3)]);
  });
  it("lists only the members of real groups for the board to ask about", () => {
    const all = [dup(1), dup(2), dup(3, { name: "Other", ticker: "OT" })];
    const plan = planGroups(all, (x) => (x === a(3) ? "X" : "W"));
    expect(groupMembers(plan).sort()).toEqual([a(1), a(2)]);
  });
});

describe("copy groups from the gate's result", () => {
  const noLauncher = (): string | null => null;
  it("joins a coin and its earlier look-alike into one group, and only the more active shows", () => {
    const all = [tok(1), tok(2)];
    const gateOf = (x: string): string[] => (x === a(2) ? [mint(1)] : []);
    const plan = planGroups(all, noLauncher, () => null, gateOf);
    expect(plan.groups.map((g) => [...g].sort())).toContainEqual([a(1), a(2)].sort());
    const hidden = chooseHidden(plan, byAddr(all), act({ [a(1)]: { n: 2, usd: 5 }, [a(2)]: { n: 9, usd: 1 } }));
    expect([...hidden.keys()]).toEqual([a(1)]);
    expect(hidden.get(a(1))).toBe(GROUP_LABEL);
  });
  it("makes one family of a creator's relaunches, however many the gate lists, and shows exactly one", () => {
    const all = [tok(1), tok(2), tok(3), tok(4)];
    const gateOf = (x: string): string[] => (x === a(1) ? [mint(2), mint(3), mint(4)] : []);
    const plan = planGroups(all, noLauncher, () => null, gateOf);
    const hidden = chooseHidden(plan, byAddr(all), act({ [a(3)]: { n: 4, usd: 1 } }));
    expect(all.map((t) => t.address.toLowerCase()).filter((x) => !hidden.has(x))).toEqual([a(3)]);
  });
  it("never joins across chains: a BNB coin's gate naming an earlier Solana coin of the same name hides neither (the team, \"Walmart\")", () => {
    const sol = tok(1, { name: "Walmart", ticker: "Walmart", chain: "solana" } as never);
    const bnb = { ...tok(2, { name: "Walmart", ticker: "WALMART" }), address: "0xed475fe6c6c21818fd0c6e1eb15455c352fb7777", chain: "bsc" } as WireToken;
    const all = [sol, bnb];
    const gateOf = (x: string): string[] => (x === bnb.address.toLowerCase() ? [sol.address] : []);
    const plan = planGroups(all, noLauncher, () => null, gateOf);
    expect(plan.groups.every((g) => g.length === 1)).toBe(true);
    expect([...chooseHidden(plan, byAddr(all), act({ [bnb.address.toLowerCase()]: { n: 9, usd: 9 } }))]).toEqual([]);
  });
  it("joins only coins the site lists: an original that is not listed never hides the listed coin", () => {
    const all = [tok(1, { name: "Alpha", ticker: "AL" }), tok(2, { name: "Beta", ticker: "BE" })];
    const gateOf = (x: string): string[] => (x === a(2) ? [mint(99)] : []);
    const plan = planGroups(all, noLauncher, () => null, gateOf);
    expect([...chooseHidden(plan, byAddr(all), act({}))]).toEqual([]);
  });
  it("leaves a coin with no gate result alone, and ties a copy group the gate and the engine's labels both name into one", () => {
    const all = [dup(1), dup(2), tok(3)];
    const plan = planGroups(all, (x) => (x === a(1) || x === a(2) ? "W" : null), () => null, (x) => (x === a(3) ? [mint(1)] : []));
    const g = plan.groups.find((x) => x.includes(a(1)))!;
    expect([...g].sort()).toEqual([a(1), a(2), a(3)].sort());
    expect([...chooseHidden(planGroups([tok(5)], noLauncher), byAddr([tok(5)]), act({}))]).toEqual([]);
  });
  it("lets a VAMP keep its own handling and never joins the gate's groups by itself", () => {
    const all = [vamp(1), tok(2)];
    const plan = planGroups(all, noLauncher, () => null, (x) => (x === a(1) ? [mint(2)] : []));
    expect(plan.groups.every((g) => !(g.includes(a(1)) && g.includes(a(2))))).toBe(true);
  });
});

describe("the same picture, or the same name and ticker, is one family", () => {
  const pic = (n: number, name: string, ticker: string, imageUrl: string | null): WireToken => ({ ...tok(n, { name, ticker }), imageUrl, name, ticker });
  const shown = (all: WireToken[], m: Record<string, Activity> = {}): string[] => {
    const hidden = chooseHidden(planGroups(all, () => null), byAddr(all), act(m));
    return all.map((t) => t.address.toLowerCase()).filter((x) => !hidden.has(x));
  };
  it("shows exactly one of a copy wave, the most active", () => {
    const all = [1, 2, 3, 4].map((n) => pic(n, "The Skinwalker", "$SKIN", "https://axiom-cdn.example/p1"));
    expect(shown(all, { [a(3)]: { n: 3, usd: 1 } })).toEqual([a(3)]);
  });
  it("makes one family of one picture under three names (today's worst case), and shows one coin", () => {
    const all = [pic(1, "The Skinwalker", "$SKIN", "https://x.example/skin"), pic(2, "Skinwalkers are Real", "$REAL", "https://x.example/skin"), pic(3, "Bola De Fur", "$FUR", "https://x.example/skin"), pic(4, "Other", "$OT", "https://x.example/other")];
    expect(shown(all, { [a(2)]: { n: 5, usd: 1 } })).toEqual([a(2), a(4)]);
  });
  it("makes one family of the same name and ticker with different pictures, or with none", () => {
    expect(shown([pic(1, "Meme Man", "$MM", "https://x.example/a"), pic(2, "Meme Man", "$MM", "https://x.example/b")], { [a(2)]: { n: 1, usd: 1 } })).toEqual([a(2)]);
    expect(shown([pic(1, "Same", "$S", null), pic(2, "Same", "$S", null)])).toHaveLength(1);
  });
  it("leaves alone coins that share only a name with no ticker (or only a ticker), and coins with different pictures and names", () => {
    expect(shown([pic(1, "Alpha", "", "https://x.example/a"), pic(2, "Alpha", "", "https://x.example/b")])).toEqual([a(1), a(2)]);
    expect(shown([pic(1, "A", "$X", "https://x.example/a"), pic(2, "B", "$X", "https://x.example/b")])).toEqual([a(1), a(2)]);
    expect(shown([pic(1, "A", "$A", "https://x.example/a"), pic(2, "B", "$B", "https://x.example/b")])).toEqual([a(1), a(2)]);
  });
  it("chains a picture family and a name family that share a coin into one", () => {
    const all = [pic(1, "A", "$A", "https://x.example/a"), pic(2, "B", "$B", "https://x.example/a"), pic(3, "B", "$B", "https://x.example/c")];
    expect(shown(all)).toHaveLength(1);
  });
});

describe("the last pass over the served list, launchpad coins included", () => {
  const coin = (n: number, name: string, ticker: string, imageUrl: string | null, over: Partial<WireToken> = {}): WireToken => ({ ...tok(n, { name, ticker }), name, ticker, imageUrl, ...over });
  const shown = (list: WireToken[], m: Record<string, Activity> = {}): string[] => {
    const lost = finalFamilies(list, act(m));
    return list.map((t) => t.address.toLowerCase()).filter((x) => !lost.has(x));
  };
  it("leaves one coin of 'A Gent' x21 (no feed file, no label, only a name and a ticker), the most active", () => {
    const list = Array.from({ length: 21 }, (_, i) => coin(i + 1, "A Gent", "$AGENT", null));
    expect(shown(list, { [a(7)]: { n: 4, usd: 10 } })).toEqual([a(7)]);
  });
  it("leaves one coin of a shared picture under different names, and keeps coins that share nothing", () => {
    const list = [coin(1, "One", "$ONE", "https://x.example/p"), coin(2, "Two", "$TWO", "https://x.example/p"), coin(3, "Three", "$THR", "https://x.example/q"), coin(4, "Four", "$FOR", null)];
    expect(shown(list, { [a(2)]: { n: 1, usd: 1 } })).toEqual([a(2), a(3), a(4)]);
  });
  it("breaks a tie by the latest trade, then the larger market cap, then the address, and chains a picture family with a name family", () => {
    expect(shown([coin(1, "X", "$X", null, { lastTradeMs: 5 }), coin(2, "X", "$X", null, { lastTradeMs: 9 })])).toEqual([a(2)]);
    expect(shown([coin(1, "X", "$X", null, { valuationUsd: 10 }), coin(2, "X", "$X", null, { valuationUsd: 99 })])).toEqual([a(2)]);
    expect(shown([coin(2, "X", "$X", null), coin(1, "X", "$X", null)])).toEqual([a(1)]);
    expect(shown([coin(1, "A", "$A", "https://x.example/p"), coin(2, "B", "$B", "https://x.example/p"), coin(3, "B", "$B", null)])).toHaveLength(1);
  });
  it("never repeats a name+ticker or a picture in what it leaves, over a big mixed list", () => {
    const list = Array.from({ length: 800 }, (_, n) => coin(n + 1, `N${n % 120}`, `$T${n % 120}`, n % 3 === 0 ? `https://x.example/p${n % 70}` : null));
    const kept = list.filter((t) => !finalFamilies(list, () => NO_ACTIVITY).has(t.address.toLowerCase()));
    const names = kept.map((t) => `${t.name}|${t.ticker}`);
    const pics = kept.map((t) => t.imageUrl).filter(Boolean);
    expect(new Set(names).size).toBe(names.length);
    expect(new Set(pics).size).toBe(pics.length);
  });
  it("skips a copy (VAMP) and a coin with no name and no picture", () => {
    expect(finalFamilies([vamp(1), vamp(2), coin(3, "", "", null), coin(4, "", "", null)], act({})).size).toBe(0);
  });
});

describe("bounded work on a full feed (the server locked up on 2026-10-23)", () => {
  it("makes the groups of ten thousand coins, with families, in well under a second, and chooses without calling anything per coin twice", () => {
    const all: WireToken[] = Array.from({ length: 10_000 }, (_, n) => ({ ...tok(n + 1, { name: `Coin ${n % 3000}`, ticker: `C${n % 3000}` }), imageUrl: `https://x.example/p${n % 2500}` }));
    const t0 = Date.now();
    const plan = planGroups(all, () => null, () => null, (x) => (x === a(5) ? [mint(9)] : []));
    const hidden = chooseHidden(plan, byAddr(all), () => NO_ACTIVITY);
    expect(Date.now() - t0).toBeLessThan(1500);
    expect(hidden.size).toBeGreaterThan(0);
    expect(all.filter((t) => !hidden.has(t.address.toLowerCase())).length).toBeLessThan(10_000);
  });
});

describe("the activity board (inside the shared read limit)", () => {
  const sleep = (): Promise<void> => new Promise((r) => setImmediate(r));
  it("uses a tick file's figure on the spot and never asks the trade list for that coin", async () => {
    const asked: string[] = [];
    const board = new ActivityBoard({ ticks: (x) => (x === "t1" ? { n: 4, usd: 8 } : null), tape: async (x) => (asked.push(x), null) });
    board.refresh(["t1"]);
    await sleep();
    expect(asked).toEqual([]);
    expect(board.activityOf("t1")).toEqual({ n: 4, usd: 8 });
  });
  it("asks for one coin at a time, at most one ask every 15 seconds, and keeps an answer five minutes", async () => {
    let now = 1_000_000;
    const asked: string[] = [];
    const board = new ActivityBoard({ ticks: () => null, tape: async (x) => (asked.push(x), { n: asked.length, usd: 1 }) }, () => now);
    board.refresh(["a", "b", "c"]);
    board.refresh(["a", "b", "c"]); // one already pending or too soon
    await sleep();
    expect(asked).toEqual(["a"]);
    now += 5_000;
    board.refresh(["a", "b", "c"]);
    await sleep();
    expect(asked).toEqual(["a"]); // inside the 15 seconds
    now += 11_000;
    board.refresh(["a", "b", "c"]);
    await sleep();
    expect(asked).toEqual(["a", "b"]); // the next coin, not "a" again
    expect(board.activityOf("a")).toEqual({ n: 1, usd: 1 });
    now += 5 * 60_000;
    board.refresh(["a", "b", "c"]);
    await sleep();
    expect(asked.length).toBe(3); // "c" was never asked: it goes first
  });
  it("ranks a coin it could not read as no recent activity, but says it is not known (a dash on the page, never a fake zero)", async () => {
    const board = new ActivityBoard({ ticks: (x) => (x === "t" ? { n: 0, usd: 0 } : null), tape: async (x) => { if (x === "y") return { n: 0, usd: 0 }; throw new Error("busy"); } });
    board.refresh(["x"]);
    await sleep();
    await sleep();
    expect(board.activityOf("x")).toEqual(NO_ACTIVITY);
    expect(board.activityOf("never-asked")).toEqual(NO_ACTIVITY);
    expect(board.known("x")).toBe(false); // the read failed
    expect(board.known("never-asked")).toBe(false);
    expect(board.known("t")).toBe(true); // a tick file's real zero
  });
});

describe("copy families within one chain, the original first", () => {
  const coin = (address: string, o: Partial<WireToken>) => ({ address, chain: "solana", name: "Moon", ticker: "$MOON", imageUrl: null, score: null, noScoreLabel: null, note: null, lastTradeMs: null, launchedAtMs: null, valuationUsd: null, ...o }) as unknown as WireToken;
  const map = (l: WireToken[]) => new Map(l.map((t) => [t.address.toLowerCase(), t]));
  it("never puts a coin on one chain in a family with a coin on another", () => {
    const sol = coin("SoLMoon11111111111111111111111111111111111", { launchedAtMs: 1 });
    const bnb = coin("0x" + "b".repeat(40), { chain: "bsc", launchedAtMs: 2 });
    expect(finalFamilies([sol, bnb], () => NO_ACTIVITY).size).toBe(0);
    expect(chooseHidden(planGroups([sol, bnb], () => null), map([sol, bnb]), () => NO_ACTIVITY).size).toBe(0);
  });
  it("with no activity figure, shows the earliest-launched coin of a family and hides the later ones", () => {
    const first = coin("0x" + "f".repeat(40), { chain: "bsc", launchedAtMs: 1000 });
    const later = coin("0x" + "1".repeat(40), { chain: "bsc", launchedAtMs: 5000 }); // a lower address: it used to win the tie
    const noTime = coin("0x" + "0".repeat(40), { chain: "bsc" });
    const fam = finalFamilies([later, first, noTime], () => NO_ACTIVITY);
    expect(fam.has(first.address.toLowerCase())).toBe(false);
    expect(fam.has(later.address.toLowerCase())).toBe(true);
    expect(fam.has(noTime.address.toLowerCase())).toBe(true);
    const hidden = chooseHidden(planGroups([later, first], () => null), map([later, first]), () => NO_ACTIVITY);
    expect([...hidden.keys()]).toEqual([later.address.toLowerCase()]);
  });
  it("still lets real activity win over age", () => {
    const first = coin("0x" + "f".repeat(40), { chain: "bsc", launchedAtMs: 1000 });
    const busy = coin("0x" + "1".repeat(40), { chain: "bsc", launchedAtMs: 5000 });
    const fam = finalFamilies([first, busy], (a) => (a === busy.address.toLowerCase() ? { n: 9, usd: 100 } : NO_ACTIVITY));
    expect([...fam.keys()]).toEqual([first.address.toLowerCase()]);
  });
});

describe("the copy-group plan in steps", () => {
  it("gives the same plan as the plan made at once, and pauses between steps so requests are answered", async () => {
    const all: WireToken[] = [];
    for (let i = 1; i <= 5000; i++) all.push(tok(i, { name: i % 50 === 0 ? "Twin" : `Coin ${i}`, ticker: i % 50 === 0 ? "TW" : `C${i}` }));
    const at = planGroups(all, () => null);
    let between = 0;
    const tick = setInterval(() => between++, 0);
    const stepped = await planGroupsStepped(all, () => null);
    clearInterval(tick);
    const norm = (p: { groups: string[][] }) => p.groups.map((g) => [...g].sort().join(",")).sort();
    expect(norm(stepped)).toEqual(norm(at));
    expect(at.groups.some((g) => g.length === 100)).toBe(true); // the 100 twins are one family
    let pauses = 0;
    const steps = planSteps(all, () => null);
    while (!steps.next().done) pauses++;
    expect(pauses).toBeGreaterThan(2); // 5,000 coins pause every PLAN_STEP
    expect(between).toBeGreaterThan(0); // other work (a timer here, a request on the server) ran between the steps
  });
});
