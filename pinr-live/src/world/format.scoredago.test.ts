import { describe, expect, it } from "vitest";
import { scoredAgo, scoredAgoShort } from "./format";

const NOW = 1_800_000_000_000;
describe("how long ago a score was made", () => {
  it("says minutes, hours, then days, and nothing when the feed gave no time", () => {
    expect(scoredAgo(NOW - 20_000, NOW)).toBe("just now");
    expect(scoredAgo(NOW - 41 * 60_000, NOW)).toBe("41 min ago");
    expect(scoredAgo(NOW - 5 * 3600_000, NOW)).toBe("5 h ago");
    expect(scoredAgo(NOW - 24 * 3600_000, NOW)).toBe("1 day ago");
    expect(scoredAgo(NOW - 50 * 3600_000, NOW)).toBe("2 days ago");
    expect(scoredAgo(null, NOW)).toBeNull();
    expect(scoredAgo(NaN, NOW)).toBeNull();
    expect(scoredAgo(NOW + 5 * 60_000, NOW)).toBe("just now"); // a clock a little ahead is never a negative age
  });
  it("has a shortest form for a tile's label row", () => {
    expect(scoredAgoShort(NOW - 20_000, NOW)).toBe("<1m");
    expect(scoredAgoShort(NOW - 41 * 60_000, NOW)).toBe("41m");
    expect(scoredAgoShort(NOW - 5 * 3600_000, NOW)).toBe("5h");
    expect(scoredAgoShort(NOW - 50 * 3600_000, NOW)).toBe("2d");
    expect(scoredAgoShort(null, NOW)).toBeNull();
  });
});
