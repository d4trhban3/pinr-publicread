import { describe, expect, it } from "vitest";
import { cleanMetric } from "./metrics";

const base = { contract: "1.1", timeframe: "1h", as_of: "2026-10-10T10:00:00Z" };
describe("cleanMetric", () => {
  it("keeps real points in time order and drops bad rows", () => {
    const m = cleanMetric({ ...base, series: [[200, 50], [100, 40], [150, null], [160, 130], ["x", 1], [100, 41]], signal: [[100, 45], [200, 46]], histogram: [[100, -3], [200, 4]], levels: [30, 70, 999] })!;
    expect(m.series).toEqual([[100, 41], [200, 50]]);
    expect(m.signal).toHaveLength(2);
    expect(m.histogram).toEqual([[100, -3], [200, 4]]);
    expect(m.levels).toEqual([30, 70]);
  });
  it("is null without a usable main line or a 1.x contract", () => {
    expect(cleanMetric({ ...base, series: [[1, 5]] })).toBeNull();
    expect(cleanMetric({ contract: "2.0", series: [[1, 5], [2, 6]] })).toBeNull();
    expect(cleanMetric(null)).toBeNull();
  });
  it("never turns missing optional lines into zeros", () => {
    const m = cleanMetric({ ...base, series: [[1, 5], [2, 6]] })!;
    expect(m.signal).toEqual([]);
    expect(m.histogram).toEqual([]);
  });
});
