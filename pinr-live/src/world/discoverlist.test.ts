import { describe, expect, it } from "vitest";
import { ageText, money, rankDiscover, signedPct } from "./discoverlist";
import { SimFeed } from "../testing/simfeed";
import { makeStore } from "./model";

const store = () => {
  const s = makeStore();
  new SimFeed().tick(s, 0.016);
  return s;
};

describe("Discover list", () => {
  it("movers are ordered by the size of the 24h move, up or down, at most 30", () => {
    const l = rankDiscover("movers", store().items, "");
    expect(l.length).toBe(30);
    for (let i = 1; i < l.length; i++) expect(Math.abs(l[i - 1]!.change24h)).toBeGreaterThanOrEqual(Math.abs(l[i]!.change24h));
  });
  it("a quiet coin is on no tab, but a search for its address finds it", () => {
    const items = store().items;
    const q = items[0]!;
    q.quiet = true;
    q.address = "0xQuietQuietQuietQuietQuietQuietQuiet0001";
    for (const tab of ["trending", "movers", "fresh"] as const) expect(rankDiscover(tab, items, "").map((i) => i.id)).not.toContain(q.id);
    expect(rankDiscover("trending", items, q.address).map((i) => i.id)).toContain(q.id);
  });
  it("the Base/BNB tab lists only Base and BNB Chain coins, newest first, and never a quiet one", () => {
    const items = store().items.slice(0, 6);
    const now = Date.now();
    items[0]!.chain = "base"; items[0]!.seenAtMs = now - 60_000;
    items[1]!.chain = "bsc"; items[1]!.seenAtMs = now - 10_000;
    items[2]!.chain = "bsc"; items[2]!.seenAtMs = undefined; items[2]!.ageMin = 30;
    items[3]!.chain = "base"; items[3]!.quiet = true;
    items[4]!.chain = "solana";
    const l = rankDiscover("chains", items, "");
    expect(l.map((i) => i.id)).toEqual([items[1]!.id, items[0]!.id, items[2]!.id]);
  });
  it("no simulated price ever falls past -100%", () => {
    for (const it of store().items) expect(it.change24h).toBeGreaterThan(-100);
  });
  it("every simulated price chart starts at 1 and ends where the 24h change says", () => {
    for (const it of store().items) {
      expect(it.chart.length).toBe(48);
      expect(it.chart[0]).toBeCloseTo(1, 6);
      expect(it.chart[47]).toBeCloseTo(Math.max(0.001, 1 + it.change24h / 100), 4);
      for (const v of it.chart) expect(v).toBeGreaterThan(0);
    }
  });
  it("fresh shows only launches under an hour old, newest first", () => {
    const l = rankDiscover("fresh", store().items, "");
    expect(l.length).toBeGreaterThan(0);
    for (const it of l) expect(it.ageMin).toBeLessThan(60);
    for (let i = 1; i < l.length; i++) expect(l[i - 1]!.ageMin).toBeLessThanOrEqual(l[i]!.ageMin);
  });
  it("search looks through every token by name or $ticker, ignoring case and the dollar sign", () => {
    const s = store();
    const t = s.items[100]!;
    expect(rankDiscover("movers", s.items, t.ticker.toLowerCase()).some((i) => i.id === t.id)).toBe(true);
    expect(rankDiscover("movers", s.items, t.name.toUpperCase()).some((i) => i.id === t.id)).toBe(true);
    expect(rankDiscover("movers", s.items, "zzzzzz")).toEqual([]);
  });
  it("formats money, moves and ages; missing stays a dash", () => {
    expect(money(2_160_000)).toBe("$2.16M");
    expect(money(889_000)).toBe("$889.0K");
    expect(money(0)).toBe("—");
    expect(money(NaN)).toBe("—");
    expect(money(0.4)).toBe("$0.40"); // checklist 7: a small real amount is never "$0"
    expect(money(0.004)).toBe("<$0.01");
    expect(money(12.6)).toBe("$13");
    expect(signedPct(62.94)).toBe("+62.9%");
    expect(signedPct(-4)).toBe("−4.0%");
    expect(signedPct(51959)).toBe("+51,959%");
    expect(ageText(9 * 60)).toBe("9h");
    expect(ageText(12)).toBe("12m");
    expect(ageText(60 * 24 * 5)).toBe("5d");
  });
});
