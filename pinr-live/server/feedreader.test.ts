import { mkdtempSync, readdirSync, renameSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FeedReader, FULL_PASS_MS, loadFeed, type FolderWatch } from "./feed";

/** a design decision fix (2026-10-20): the drop folder read keeps each file's token and re-reads only what changed. */
const coin = (n: number, score = 30) => ({ mint: `0x${String(n).padStart(40, "0")}`, score, display: String(score), label: null, coverage: 0.5 });
const dirs: string[] = [];
const folder = (n: number): string => {
  const dir = mkdtempSync(join(tmpdir(), "pinr-feed-"));
  dirs.push(dir);
  for (let i = 1; i <= n; i++) writeFileSync(join(dir, `c${i}.json`), JSON.stringify(coin(i)));
  return dir;
};
/** Write a file the way the engine does: a temporary file, then a rename over the coin's file; the time set apart so the stamp differs. */
const engineWrite = (dir: string, name: string, body: unknown, tSec: number): void => {
  const tmp = join(dir, `_tmp-${name}`);
  writeFileSync(tmp, JSON.stringify(body));
  utimesSync(tmp, tSec, tSec);
  renameSync(tmp, join(dir, name));
};
/** A watch the test drives by hand. */
const manualWatch = (): { watch: FolderWatch; fire: (name: string | null) => void } => {
  let cb: (name: string | null) => void = () => {};
  return { watch: (_d, changed) => ((cb = changed), () => {}), fire: (name) => cb(name) };
};
const scores = (r: { tokens: { address: string; score: number | null }[]; rest: { address: string; score: number | null }[] }): Record<string, number | null> =>
  Object.fromEntries([...r.tokens, ...r.rest].map((t) => [t.address, t.score]));

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("the feed reader", () => {
  it("gives the same snapshot as reading every file, and the same object again when nothing changed", () => {
    const dir = folder(12);
    let now = 1_800_000_000_000;
    const r = new FeedReader([{ dir, feed: true }], () => now, manualWatch().watch);
    const first = r.read();
    const all = loadFeed([{ dir, feed: true }]);
    expect({ ...first, problems: first.problems }).toEqual({ ...all, tokens: first.tokens, rest: first.rest });
    expect(scores(first)).toEqual(scores(all));
    expect(r.stat.parsed).toBe(12);
    now += 2000;
    expect(r.read()).toBe(first);
    expect(r.stat.parsed).toBe(12);
  });

  it("a changed file: the watch names it and only that file is parsed again", () => {
    const dir = folder(12);
    let now = 1_800_000_000_000;
    const w = manualWatch();
    const r = new FeedReader([{ dir, feed: true }], () => now, w.watch);
    r.read();
    engineWrite(dir, "c3.json", coin(3, 77), 1_900_000_000);
    w.fire("_tmp-c3.json");
    w.fire("c3.json");
    now += 2000;
    const after = r.read();
    expect(r.stat.parsed).toBe(13);
    expect(scores(after)[coin(3).mint]).toBe(77);
  });

  it("a removed file leaves the snapshot", () => {
    const dir = folder(5);
    let now = 1_800_000_000_000;
    const w = manualWatch();
    const r = new FeedReader([{ dir, feed: true }], () => now, w.watch);
    expect(r.read().files).toBe(5);
    rmSync(join(dir, "c2.json"));
    w.fire("c2.json");
    now += 2000;
    const after = r.read();
    expect(after.files).toBe(4);
    expect(coin(2).mint in scores(after)).toBe(false);
  });

  it("a change the watch missed is found by the next full pass (at most 10 minutes), or at once when the watch could not name the file", () => {
    const dir = folder(5);
    let now = 1_800_000_000_000;
    const w = manualWatch();
    const r = new FeedReader([{ dir, feed: true }], () => now, w.watch);
    r.read();
    engineWrite(dir, "c4.json", coin(4, 61), 1_900_000_000);
    now += 2000;
    expect(scores(r.read())[coin(4).mint]).toBe(30); // missed: not yet
    now += FULL_PASS_MS;
    expect(scores(r.read())[coin(4).mint]).toBe(61);
    expect(r.stat.parsed).toBe(6); // the full pass stats every file and parses only the changed one
    engineWrite(dir, "c5.json", coin(5, 44), 1_900_000_100);
    w.fire(null);
    now += 2000;
    expect(scores(r.read())[coin(5).mint]).toBe(44);
  });

  it("the real folder watch sees the engine's rename", { timeout: 20_000 }, async () => {
    const dir = folder(3);
    const r = new FeedReader([{ dir, feed: true }]);
    try {
      r.read();
      // macOS's watch can miss a change made in the first moments after it starts (Linux's inotify does not); give it a second, as the
      // server has long before any engine write. A change it still missed would be caught by the 10-minute full pass, tested above.
      await new Promise((res) => setTimeout(res, 1000));
      engineWrite(dir, "c1.json", coin(1, 88), 1_900_000_000);
      // The system's change notice can take seconds on a busy machine (a run failed at 2 s with this Mac at load 55): wait up to 10 s.
      for (let i = 0; i < 200 && scores(r.read())[coin(1).mint] !== 88; i++) await new Promise((res) => setTimeout(res, 50));
      expect(scores(r.read())[coin(1).mint]).toBe(88);
      expect(readdirSync(dir).length).toBe(3);
    } finally {
      r.close();
    }
  });
});

describe("a big folder is rebuilt at most every 15 s (the server's 56,000 files took 341 ms a rebuild, every 3 s)", () => {
  it("holds a changed file until REBUILD_EVERY_MS after the last rebuild, then takes it", async () => {
    const { REBUILD_EVERY_MS, REBUILD_LIMIT_FROM } = await import("./feed.ts");
    const dir = folder(REBUILD_LIMIT_FROM + 1);
    let now = 1_000_000;
    const w = manualWatch();
    const r = new FeedReader([{ dir, feed: true }], () => now, w.watch);
    r.read();
    engineWrite(dir, "c1.json", coin(1, 77), 2_000);
    w.fire("c1.json");
    now += 3000;
    expect(scores(r.read())[coin(1).mint]).toBe(30); // held: the last rebuild was 3 s ago
    now += REBUILD_EVERY_MS;
    r.read(); // starts the rebuild, made in turns in the background (the last snapshot serves meanwhile)
    expect(scores(r.read())[coin(1).mint]).toBe(30);
    await r.settled();
    expect(scores(r.read())[coin(1).mint]).toBe(77);
  });
});

describe("the snapshot is rebuilt in turns, never in one block (DEBUG finding 1, 26 Oct: 252 slow builds in 45 minutes on the server)", () => {
  it("steppedSort gives the same order as one stable sort, ties included", async () => {
    const { steppedSort, STEP } = await import("./feed.ts");
    const rows = Array.from({ length: STEP * 3 + 417 }, (_, i) => ({ i, k: (i * 7919) % 23 }));
    const cmp = (a: { k: number }, b: { k: number }) => a.k - b.k;
    expect((await steppedSort(rows, cmp)).map((r) => r.i)).toEqual([...rows].sort(cmp).map((r) => r.i));
    expect(await steppedSort([], cmp)).toEqual([]);
  });
  it("replays a run of changes on a big folder: the stepped snapshot equals the one made at once, and the loop is never held over 100 ms", async () => {
    const { REBUILD_EVERY_MS, REBUILD_LIMIT_FROM, STEP } = await import("./feed.ts");
    const n = Math.max(REBUILD_LIMIT_FROM + 1, STEP * 3 + 500);
    const dir = folder(n);
    let now = 1_000_000;
    const w = manualWatch();
    const r = new FeedReader([{ dir, feed: true }], () => now, w.watch);
    r.read();
    // a sampler that notes the longest time the event loop was held while the rebuilds ran
    let worst = 0;
    let lastTick = performance.now();
    const timer = setInterval(() => {
      const t = performance.now();
      worst = Math.max(worst, t - lastTick - 2);
      lastTick = t;
    }, 2);
    for (let round = 0; round < 3; round++) {
      engineWrite(dir, `c${round + 1}.json`, coin(round + 1, 40 + round), 3_000 + round);
      w.fire(`c${round + 1}.json`);
      now += REBUILD_EVERY_MS + 1;
      r.read();
      expect(r.isAssembling()).toBe(true);
      await r.settled();
    }
    clearInterval(timer);
    const stepped = r.read();
    const once = new FeedReader([{ dir, feed: true }], () => now, null).read(); // a fresh reader over the same folder: made at once
    expect(scores(stepped)).toEqual(scores(once));
    expect(stepped.tokens.map((t) => t.address)).toEqual(once.tokens.map((t) => t.address));
    expect(stepped.rest.length).toBe(once.rest.length);
    expect(worst).toBeLessThan(100);
  });
});

describe("the cold start (161 s from a restart to the first answer on the server, 2026-10-25)", () => {
  it("serves the saved first page at once, reads the folder in the background, then serves the full list", async () => {
    const { writeFileSync: w } = await import("node:fs");
    const dir = folder(1200);
    const savedFile = join(mkdtempSync(join(tmpdir(), "pinr-saved-")), "firstpage.json");
    w(savedFile, JSON.stringify({ contract: "1.0", mode: "feed", asOfMs: 1, files: 1, tokens: [{ address: "SavedCoin" }], rest: [], cut: 0, problems: [] }));
    const r = new FeedReader([{ dir, feed: true }], () => Date.now(), manualWatch().watch);
    r.startWarm(savedFile, 100);
    const first = r.read();
    expect(first.tokens.map((t) => t.address)).toEqual(["SavedCoin"]); // at once, from the last run
    for (let i = 0; i < 200 && r.read().files === 1; i++) await new Promise((res) => setTimeout(res, 5));
    const full = r.read();
    expect(full.files).toBe(1200);
    expect(full.tokens.length + full.rest.length).toBe(1200);
  });
});

describe("after a restart the saved list keeps serving until the hide rules can all apply", () => {
  it("serves the saved first page while holdWhile says so, though the folder is read, then the full list", async () => {
    const { writeFileSync: w } = await import("node:fs");
    const dir = folder(600);
    const savedFile = join(mkdtempSync(join(tmpdir(), "pinr-saved-")), "firstpage.json");
    w(savedFile, JSON.stringify({ contract: "1.0", mode: "feed", asOfMs: 1, files: 1, tokens: [{ address: "SavedCoin" }], rest: [], cut: 0, problems: [] }));
    const r = new FeedReader([{ dir, feed: true }], () => Date.now(), manualWatch().watch);
    let hold = true;
    r.holdWhile = () => hold;
    r.startWarm(savedFile, 100);
    await new Promise((res) => setTimeout(res, 400)); // the folder is read by now
    expect(r.read().tokens.map((t) => t.address)).toEqual(["SavedCoin"]); // still the saved list
    hold = false;
    const full = r.read();
    expect(full.files).toBe(600);
    expect(full.tokens.length + full.rest.length).toBe(600);
  });
});

describe("a coin's developer wallet is noted while its file is parsed (the server's first copy-group plan read thousands of files again: 125 s)", () => {
  it("knows each parsed coin's launcher, null when the file names none, and nothing for a file not read", async () => {
    const { writeFileSync: w } = await import("node:fs");
    const dir = mkdtempSync(join(tmpdir(), "pinr-launch-"));
    dirs.push(dir);
    const dev = "Dev1111111111111111111111111111111111111111";
    w(join(dir, "a.json"), JSON.stringify({ ...coin(1), facts: [{ id: "launcher", value: dev }] }));
    w(join(dir, "b.json"), JSON.stringify(coin(2)));
    const r = new FeedReader([{ dir, feed: true }], () => 1_800_000_000_000, manualWatch().watch);
    r.read();
    expect(r.launcherOf(coin(1).mint.toLowerCase())).toBe(dev);
    expect(r.launcherOf(coin(2).mint.toLowerCase())).toBeNull();
    expect(r.launcherOf("never-read")).toBeUndefined();
  });
});
