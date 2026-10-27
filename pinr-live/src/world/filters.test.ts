import { describe, expect, it } from "vitest";
import { SIM, HIST_N, NEW_LAUNCH_MIN, type Item } from "./model";
import { clampRoster, getSort, isHidden, setSort, scoreOf, ROSTER_DEFAULT, setHides, ROSTER_MAX, ROSTER_MIN, selectAndRank } from "./filters";
import { clampCols, allowedCols, fitScale, gridWidth } from "./grid";

function item(id: number, over: Partial<Item> = {}): Item {
  return {
    id, name: `T${id}`, ticker: `$T${id}`, image: null, detail: "", value: "50", coverage: 80, early: false, base: 0.3, spike: 0, note: null, noteSeq: 0, noteLeft: 0,
    hist: new Array<number>(HIST_N).fill(0.3), histAge: 0, buyShare: 0.5, restBuy: 0.5, evSide: 1, status: "ok", flagKind: null, statusLeft: 0, ageMin: 5000, moved: 0, mcap: 100000, ath: NaN, volume24h: 50000, change24h: 0, chart: [], hasFlow: true, address: null, tag: "SIM", changeWindowH: 24, priceSource: "", priceUsd: NaN, liquidity: NaN, quotePair: "", findings: [], ...over,
  };
}
const crowd = (n = 90): Item[] => Array.from({ length: n }, (_, i) => item(i, { base: 0.1 + (i % 7) / 10, moved: ((i * 37) % 41) - 20, ageMin: i % 6 === 0 ? 10 + i : 5000 + i }));

describe("filters", () => {
  it("All shows the heaviest tokens first, up to the roster size", () => {
    const items = crowd(250);
    const r = selectAndRank("all", items, 200);
    expect(r.length).toBe(200);
    expect(new Set(r.map((x) => x.id)).size).toBe(200);
    const base = new Map(items.map((i) => [i.id, i.base]));
    for (let i = 1; i < r.length; i++) expect(base.get(r[i - 1]!.id)!).toBeGreaterThanOrEqual(base.get(r[i]!.id)!);
  });

  it("Trending keeps the top of ITS OWN ranking up to the roster size and puts the most active first", () => {
    const items = crowd(300);
    items[17]!.spike = 0.7;
    const r = selectAndRank("trending", items, 90);
    expect(r.length).toBe(90);
    expect(selectAndRank("movers", items, 150).length).toBe(150);
    expect(r[0]!.id).toBe(17);
    expect(r[0]!.imp).toBe(1);
  });

  it("Movers ranks by size of movement, up OR down", () => {
    const items = crowd();
    items[3]!.moved = -55;
    items[4]!.moved = 40;
    const r = selectAndRank("movers", items);
    expect(r[0]!.id).toBe(3);
    expect(r[1]!.id).toBe(4);
  });

  it("New Launches shows only tokens under an hour old, newest first", () => {
    const items = crowd();
    const r = selectAndRank("new", items);
    expect(r.length).toBeGreaterThan(0);
    const byId = new Map(items.map((i) => [i.id, i]));
    for (const x of r) expect(byId.get(x.id)!.ageMin).toBeLessThan(NEW_LAUNCH_MIN);
    for (let i = 1; i < r.length; i++) expect(byId.get(r[i - 1]!.id)!.ageMin).toBeLessThanOrEqual(byId.get(r[i]!.id)!.ageMin);
  });

  it("importance falls steadily with rank, from 1 down to a quarter, and never rises", () => {
    for (const f of ["trending", "movers", "new"] as const) {
      const r = selectAndRank(f, crowd());
      for (let i = 1; i < r.length; i++) expect(r[i]!.imp).toBeLessThanOrEqual(r[i - 1]!.imp);
      expect(r[r.length - 1]!.imp).toBeGreaterThanOrEqual(0.2);
    }
  });

  it("shows everything there is when the crowd is smaller than the roster, and copes with tiny or empty crowds", () => {
    expect(selectAndRank("trending", crowd(20), 90).length).toBe(20);
    expect(selectAndRank("trending", crowd(3)).length).toBe(3);
    for (const f of ["all", "trending", "movers", "new"] as const) expect(selectAndRank(f, [])).toEqual([]);
  });

  it("is deterministic and does not change the tokens it was given", () => {
    const items = crowd();
    const before = JSON.stringify(items);
    expect(selectAndRank("movers", items)).toEqual(selectAndRank("movers", items));
    expect(JSON.stringify(items)).toBe(before);
  });

  it("uses the same threshold the simulation uses for 'new'", () => {
    expect(NEW_LAUNCH_MIN).toBe(60);
    expect(SIM.tokens).toBeGreaterThan(0);
  });
});

describe("tiles per row", () => {
  it("fits the chosen number of columns exactly to the screen width", () => {
    for (const c of [4, 5, 6, 8]) expect(gridWidth(c) * fitScale(c, 390)).toBeCloseTo(390, 6);
  });

  it("a phone offers the apps' 2, 3 and 4 (the phone site mirrors the apps), never a tile too small to read; 600 px and wider are the desktop's", () => {
    const ok = allowedCols(390);
    expect(ok).toEqual([2, 3, 4]);
    expect(allowedCols(600)).toContain(5);
    for (const c of ok) expect(fitScale(c, 390) * 66).toBeGreaterThanOrEqual(30 - 1e-9);
  });

  it("a wide screen offers more choices than a phone", () => {
    expect(allowedCols(1440).length).toBeGreaterThanOrEqual(allowedCols(390).length);
    expect(allowedCols(1440)).toContain(12);
  });

  it("snaps a saved value to something valid for this screen", () => {
    expect(clampCols(5, 390)).toBe(4);
    expect(clampCols(3, 390)).toBe(3);
    expect(allowedCols(390)).toContain(clampCols(12, 390));
    expect(clampCols(99, 390)).toBe(Math.max(...allowedCols(390)));
  });
});

describe("roster size", () => {
  it("starts at 90 and is held between 30 and 200", () => {
    expect(ROSTER_DEFAULT).toBe(90);
    expect(clampRoster(1000)).toBe(ROSTER_MAX);
    expect(clampRoster(5)).toBe(ROSTER_MIN);
    expect(clampRoster(NaN)).toBe(ROSTER_DEFAULT);
    expect(clampRoster(120.4)).toBe(120);
  });
});

describe("live Pump.fun view", () => {
  it("Trending lifts a token that traded moments ago above an equal one that has been quiet, scored or not", () => {
    const now = 10_000_000;
    const items = [item(1, { lastTradeMs: now - 3_600_000, coverage: 80 }), item(2, { lastTradeMs: now - 5_000, coverage: 0 }), item(3, { coverage: 80 })];
    expect(selectAndRank("trending", items, 3, now).map((r) => r.id)[0]).toBe(2);
  });
  it("a copy (VAMP) keeps a tile by default and goes only when the user switches copies off", () => {
    const items = [item(1), item(2, { flagKind: "VAMP", status: "flag" }), item(3)];
    expect(selectAndRank("all", items, 10).map((r) => r.id)).toContain(2);
    setHides({ vamp: true, bots: false, serial: false });
    for (const f of ["all", "trending", "movers"] as const) expect(selectAndRank(f, items, 10).map((r) => r.id)).not.toContain(2);
    setHides({ vamp: false, bots: false, serial: false });
  });
  it("the switches remove copies, bots and rugs, and serial launchers, each on its own", () => {
    const vamp = item(1, { flagKind: "VAMP", status: "flag" });
    const rug = item(2, { flagKind: "BOT/RUG", status: "flag" });
    const pot = item(3, { flagKind: "HONEYPOT", status: "flag" });
    const ser = item(4, { serial: true });
    const fine = item(5);
    const off = { vamp: false, bots: false, serial: false };
    expect([vamp, rug, pot, ser, fine].filter((i) => isHidden(i, off))).toEqual([]);
    expect([vamp, rug, pot, ser, fine].filter((i) => isHidden(i, { ...off, bots: true })).map((i) => i.id)).toEqual([2, 3]);
    expect([vamp, rug, pot, ser, fine].filter((i) => isHidden(i, { ...off, serial: true })).map((i) => i.id)).toEqual([4]);
    expect([vamp, rug, pot, ser, fine].filter((i) => isHidden(i, { vamp: true, bots: true, serial: true })).map((i) => i.id)).toEqual([1, 2, 3, 4]);
  });
  it("a quiet coin is on no list or tile whatever the switches say", () => {
    const quiet = item(7, { quiet: true });
    const off = { vamp: false, bots: false, serial: false };
    expect(isHidden(quiet, off)).toBe(true);
    expect(isHidden(item(8), off)).toBe(false);
    expect(selectAndRank("all", [item(8), quiet], 10).map((r) => r.id)).toEqual([8]);
  });
});

describe("PINR Index filter and sorting", () => {
  const scored = (): Item[] => [
    item(1, { value: "40" }),
    item(2, { value: "85" }),
    item(3, { value: "62" }),
    item(4, { value: "—", coverage: 0 }),
    item(5, { value: "—", status: "flag", flagKind: "VAMP", coverage: 0 }),
  ];
  it("scoreOf never turns a missing score into a number", () => {
    expect(scoreOf(item(1, { coverage: 0 }))).toBeNull();
    expect(scoreOf(item(1, { status: "flag", flagKind: "BOT/RUG" }))).toBeNull();
    expect(scoreOf(item(1, { value: "73" }))).toBe(73);
  });
  it("PINR Index lists only scored tokens, highest first by default", () => {
    expect(selectAndRank("pinrindex", scored(), 90, 0, "default").map((r) => r.id)).toEqual([2, 3, 1]);
  });
  it("ascending and descending run the number both ways", () => {
    expect(selectAndRank("pinrindex", scored(), 90, 0, "asc").map((r) => r.id)).toEqual([1, 3, 2]);
    expect(selectAndRank("pinrindex", scored(), 90, 0, "desc").map((r) => r.id)).toEqual([2, 3, 1]);
  });
  it("every filter honours the direction", () => {
    const items = crowd(120);
    const by = new Map(items.map((i) => [i.id, i]));
    const measures: Record<string, (i: Item) => number> = { all: (i) => i.base, movers: (i) => Math.abs(i.moved), new: (i) => i.ageMin };
    for (const f of ["all", "movers", "new"] as const) {
      const a = selectAndRank(f, items, 200, 0, "asc").map((r) => measures[f]!(by.get(r.id)!));
      const d = selectAndRank(f, items, 200, 0, "desc").map((r) => measures[f]!(by.get(r.id)!));
      expect(a).toEqual([...a].sort((x, y) => x - y));
      expect(d).toEqual([...d].sort((x, y) => y - x));
    }
    const t = (dir: "asc" | "desc") => selectAndRank("trending", items, 200, 0, dir).map((r) => r.id);
    expect(t("asc")[0]).not.toBe(t("desc")[0]);
  });
  it("New Launches default is newest first", () => {
    const items = crowd(60);
    const def = selectAndRank("new", items, 90, 0, "default").map((r) => r.id);
    expect(def).toEqual(selectAndRank("new", items, 90, 0, "asc").map((r) => r.id));
  });
  it("the sort is remembered per filter", () => {
    expect(getSort("movers")).toBe("default");
    setSort("movers", "asc");
    expect(getSort("movers")).toBe("asc");
    expect(getSort("trending")).toBe("default");
    setSort("movers", "default");
  });
});
