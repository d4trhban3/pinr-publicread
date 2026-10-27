import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isQuiet, QUIET_AFTER_MS, QUIET_FILE_FRESH_MS, quietMarks, quietReader, splitQuiet } from "./quiet";

const NOW = Date.parse("2026-10-24T12:00:00Z");
const t = (lastTradeMs: number | null, address = "a") => ({ address, lastTradeMs });

describe("a coin with no trade for 24 hours goes quiet", () => {
  it("is quiet only when its last trade is known and more than 24 hours old", () => {
    expect(isQuiet(t(NOW - QUIET_AFTER_MS - 1), NOW)).toBe(true);
    expect(isQuiet(t(NOW - QUIET_AFTER_MS), NOW)).toBe(false);
    expect(isQuiet(t(NOW - 60_000), NOW)).toBe(false);
  });
  it("never takes a coin off the lists on a guess: no trade time, a zero or a bad one is not quiet", () => {
    for (const bad of [null, 0, -5, Number.NaN, Infinity]) expect(isQuiet(t(bad as number | null), NOW)).toBe(false);
  });
  it("comes back on its next trade: a fresh trade time makes it listed again", () => {
    const old = t(NOW - 2 * QUIET_AFTER_MS);
    expect(isQuiet(old, NOW)).toBe(true);
    expect(isQuiet({ ...old, lastTradeMs: NOW - 1000 }, NOW)).toBe(false);
  });
  it("sets the quiet ones apart, marked, and keeps the rest in order", () => {
    const list = [t(NOW - 1000, "live1"), t(NOW - 2 * QUIET_AFTER_MS, "old"), t(null, "unknown"), t(NOW - 5000, "live2")];
    const { shown, quiet } = splitQuiet(list, NOW);
    expect(shown.map((x) => x.address)).toEqual(["live1", "unknown", "live2"]);
    expect(quiet).toEqual([{ address: "old", lastTradeMs: NOW - 2 * QUIET_AFTER_MS, quiet: true }]);
    expect(shown.some((x) => "quiet" in x)).toBe(false);
  });
});

describe("the engine's own quiet marks (frontend-feed/_quiet.json, quiet-1)", () => {
  const A = "DM6fTAo26wQwMXj3yNduYjrvYvzDgAR1WFLjEZ8Ppump";
  const B = "0x00092b30a03aaff7ba90da69e61afa932b434444";
  const file = (over: object = {}) => ({ contract: "quiet-1", as_of: new Date(NOW - 60_000).toISOString(), window_s: 86400, quiet: { [A]: { since: "x", checked: "y", by: "DexScreener" }, [B]: { by: "tape" }, "bad key": {} }, ...over });
  it("reads the mints it lists (any case), and ignores keys that are not addresses", () => {
    const m = quietMarks(file(), NOW);
    expect([...m].sort()).toEqual([A.toLowerCase(), B].sort());
  });
  it("marks a coin quiet by the file even with no trade time of its own, and leaves the rest", () => {
    const m = quietMarks(file(), NOW);
    expect(isQuiet({ address: A, lastTradeMs: null }, NOW, m)).toBe(true);
    expect(isQuiet({ address: "other", lastTradeMs: null }, NOW, m)).toBe(false);
    const { shown, quiet } = splitQuiet([{ address: A, lastTradeMs: null }, { address: "z", lastTradeMs: NOW - 1000 }], NOW, m);
    expect(shown.map((x) => x.address)).toEqual(["z"]);
    expect(quiet[0]).toMatchObject({ address: A, quiet: true });
  });
  it("trusts nothing from a file that is not quiet-1, has no quiet list, or is older than 15 minutes (a coin that trades again drops out, so a stale file would hide it wrongly)", () => {
    expect(quietMarks(file({ contract: "quiet-2" }), NOW).size).toBe(0);
    expect(quietMarks(file({ quiet: [A] }), NOW).size).toBe(0);
    expect(quietMarks(file({ quiet: null }), NOW).size).toBe(0);
    expect(quietMarks(file({ as_of: new Date(NOW - QUIET_FILE_FRESH_MS - 1000).toISOString() }), NOW).size).toBe(0);
    expect(quietMarks(file({ as_of: "not a date" }), NOW).size).toBe(0);
    expect(quietMarks(null, NOW).size).toBe(0);
  });
  it("reads the file from disk, no file or a broken one is no marks, and a new one is read after the wait", () => {
    const dir = mkdtempSync(join(tmpdir(), "quiet-"));
    const path = join(dir, "_quiet.json");
    const read = quietReader(path, 1000);
    expect(read(NOW).size).toBe(0); // no file
    writeFileSync(path, JSON.stringify(file()));
    expect(read(NOW + 500).size).toBe(0); // still inside the wait
    expect(read(NOW + 2000).size).toBe(2);
    writeFileSync(path, "{ broken");
    expect(read(NOW + 4000).size).toBe(0);
  });
});
