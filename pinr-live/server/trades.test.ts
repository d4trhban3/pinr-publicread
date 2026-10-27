import { describe, expect, it } from "vitest";
import { cleanTrades, summarize } from "./trades.ts";

const NOW = 1_791_650_000;

describe("trades files", () => {

  it("keeps good rows, drops bad ones, and sorts oldest first", () => {
    const f = cleanTrades(
      {
        contract: "1.1",
        covers_from: NOW - 600,
        complete: true,
        as_of: "2026-10-10T18:00:00Z",
        trades: [
          [NOW - 10, "sell", 38.1],
          [NOW - 100, "buy", 152.4],
          [NOW - 50, "hold", 5],
          [NOW - 50, "buy", -3],
          [NOW - 50, "buy", 0],
          [NOW - 50, "buy", "12"],
          [NOW + 9999, "buy", 1],
          [NOW - 49 * 3600, "buy", 1],
          "junk",
          [NOW - 5],
        ],
      },
      NOW,
    )!;
    expect(f.trades).toEqual([[NOW - 100, "buy", 152.4], [NOW - 10, "sell", 38.1]]);
    expect(f.complete).toBe(true);
    expect(f.coversFrom).toBe(NOW - 600);
    expect(f.asOf).toBe(Date.parse("2026-10-10T18:00:00Z") / 1000);
  });

  it("only says complete when the file says so, and refuses what is not a trades file", () => {
    expect(cleanTrades({ contract: "1.1", trades: [] }, NOW)!.complete).toBe(false);
    expect(cleanTrades({ contract: "2.0", trades: [] }, NOW)).toBeNull();
    expect(cleanTrades({ contract: "1.1" }, NOW)).toBeNull();
    expect(cleanTrades(null, NOW)).toBeNull();
  });

  it("keeps only the newest 500", () => {
    const trades = Array.from({ length: 700 }, (_, i) => [NOW - 700 + i, "buy", 1]);
    const f = cleanTrades({ contract: "1.1", trades }, NOW)!;
    expect(f.trades).toHaveLength(500);
    expect(f.trades[0]![0]).toBe(NOW - 500);
  });

  it("totals buy and sell dollars over 5 minutes and an hour", () => {
    const f = cleanTrades(
      { contract: "1.1", complete: true, trades: [[NOW - 4000, "buy", 100], [NOW - 3000, "buy", 10], [NOW - 200, "sell", 40], [NOW - 20, "buy", 5]] },
      NOW,
    )!;
    const s = summarize(f, NOW);
    expect(s).toMatchObject({ buy1h: 15, sell1h: 40, n1h: 3, buy5m: 5, sell5m: 40, n5m: 2, lastAt: NOW - 20, complete: true });
  });
});
