import { describe, expect, it } from "vitest";
import { pressureWindows, type TradesView } from "./tradeslist";

const NOW = 1_800_000_000;
const summary = { buy5m: 10, sell5m: 5, buy1h: 10, sell1h: 5, n5m: 40, n1h: 40, lastAt: NOW - 3, complete: false, asOf: NOW };
const view = (over: Partial<TradesView>): TradesView => ({ none: false, trades: [], complete: false, coversFrom: NOW - 120, asOf: NOW, summary, ...over });

describe("the trade windows when the list is capped", () => {
  it("a list that does not reach back five minutes shows ONE line, as a floor, never two equal windows", () => {
    const w = pressureWindows(view({ coversFrom: NOW - 120 }), NOW);
    expect(w).toHaveLength(1);
    expect(w[0]).toMatchObject({ label: "Newest trades (last 2 min)", atLeast: true, n: 40 });
    const unknown = pressureWindows(view({ coversFrom: null }), NOW);
    expect(unknown).toHaveLength(1);
    expect(unknown[0]?.label).toBe("Newest trades");

  });
  it("a list that reaches back past five minutes but not an hour shows the hour as 'at least'", () => {
    const w = pressureWindows(view({ coversFrom: NOW - 900, summary: { ...summary, buy1h: 99, n1h: 300 } }), NOW);
    expect(w.map((x) => [x.label, x.atLeast])).toEqual([["Last 5 minutes", false], ["Last hour (at least)", true]]);
  });
  it("a capped list that reaches back past the hour shows the hour as a measurement, not 'at least'", () => {
    const w = pressureWindows(view({ coversFrom: NOW - 15 * 3600 }), NOW);
    expect(w.map((x) => [x.label, x.atLeast])).toEqual([["Last 5 minutes", false], ["Last hour", false]]);
  });
  it("a complete list shows both windows as measurements", () => {
    const w = pressureWindows(view({ complete: true, coversFrom: NOW - 3600 }), NOW);
    expect(w.map((x) => [x.label, x.atLeast])).toEqual([["Last 5 minutes", false], ["Last hour", false]]);
    expect(pressureWindows(view({ summary: null }), NOW)).toEqual([]);
  });
});

describe("a coin with no trade read", () => {
  it("says \"No trades read yet.\", not that it will fill in in a few seconds", async () => {
    const { NO_TRADES_READ } = await import("./tradeslist");
    expect(NO_TRADES_READ).toBe("No trades read yet.");
    expect(NO_TRADES_READ).not.toMatch(/few seconds/);
  });
});
