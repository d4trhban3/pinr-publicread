import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LiveFeed, POLL_EVERY_MS, TAIL_EVERY_MS } from "./livefeed";

/** the page reads the lists once, then follows the stream; the decision-200 polls run only while the stream is not open. */
class FakeES {
  static last: FakeES | null = null;
  readyState = 0;
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  private on = new Map<string, (e: { data: string }) => void>();
  constructor(public url: string) {
    FakeES.last = this;
  }
  addEventListener(kind: string, fn: (e: { data: string }) => void): void {
    this.on.set(kind, fn);
  }
  emit(kind: string, data: unknown): void {
    this.on.get(kind)?.({ data: JSON.stringify(data) });
  }
  close(): void {
    this.readyState = 2;
  }
}

const list = { contract: "1.1", mode: "feed", asOfMs: 1, files: 0, problems: [], tokens: [{ address: "A", valuationUsd: 1000 }], stream: { boot: "aaaaaaaa", seq: 3 } };
const calls: string[] = [];
const flush = async (): Promise<void> => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  calls.length = 0;
});

describe("the page follows the stream", () => {
  it("reads the lists once, opens the stream from where they stand, and does not poll while it is open; drops back to the polls when it is not", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("EventSource", FakeES);
    vi.stubGlobal("fetch", async (url: string) => {
      calls.push(url);
      return { ok: true, json: async () => (url.includes("/rest") ? { total: 0, offset: 0, tokens: [] } : list) };
    });
    const feed = new LiveFeed();
    await flush();
    // the tiles' list only; the scored set waits until search, Discover or the PINRscore filter asks for it.
    expect(calls).toEqual(["/api/tokens?view=tile"]);
    expect(FakeES.last!.url).toBe("/api/stream?view=tile&boot=aaaaaaaa&since=3");
    FakeES.last!.readyState = 1;
    FakeES.last!.onopen!();
    expect(feed.streaming()).toBe(true);
    calls.length = 0;
    await vi.advanceTimersByTimeAsync(5 * TAIL_EVERY_MS);
    expect(calls).toEqual([]);
    // A change arrives: applied without any read.
    FakeES.last!.emit("changes", { boot: "aaaaaaaa", seq: 4, seen: [{ address: "B", valuationUsd: 5 }], score: [], graduation: [], tick: [], gone: [], rest: [], restGone: [] });
    expect(calls).toEqual([]);
    // The stream drops: the 15-second poll takes over until it is back.
    FakeES.last!.onerror!();
    expect(feed.streaming()).toBe(false);
    await vi.advanceTimersByTimeAsync(POLL_EVERY_MS);
    expect(calls).toContain("/api/tokens?view=tile");
    // The server says this page is too far behind: both lists are read once more.
    calls.length = 0;
    FakeES.last!.onopen!();
    FakeES.last!.emit("reset", {});
    await flush();
    expect(calls).toEqual(["/api/tokens?view=tile"]);
  });

  it("the scored set is read the first time something needs it, once, and then also on a reset", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("EventSource", FakeES);
    vi.stubGlobal("fetch", async (url: string) => (calls.push(url), { ok: true, json: async () => (url.includes("/rest") ? { total: 0, offset: 0, tokens: [] } : list) }));
    const feed = new LiveFeed();
    await flush();
    FakeES.last!.readyState = 1;
    FakeES.last!.onopen!();
    // A scored-set change on the stream before anyone asked: not taken (nothing holds the set yet).
    FakeES.last!.emit("changes", { boot: "aaaaaaaa", seq: 4, seen: [], score: [], graduation: [], tick: [], gone: [], rest: [{ address: "R", valuationUsd: 1 }], restGone: [] });
    expect(calls).toEqual(["/api/tokens?view=tile"]);
    calls.length = 0;
    feed.wantRest();
    feed.wantRest();
    await flush();
    expect(calls).toEqual(["/api/tokens/rest?offset=0&limit=500"]);
    calls.length = 0;
    FakeES.last!.emit("reset", {});
    await flush();
    expect(calls).toEqual(["/api/tokens?view=tile", "/api/tokens/rest?offset=0&limit=500"]);
  });

  it("the Base/BNB tab's coins come straight from the server, filtered by chain, read once", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("EventSource", FakeES);
    vi.stubGlobal("fetch", async (url: string) => (calls.push(url), { ok: true, json: async () => (url.includes("/rest") ? { total: 1, offset: 0, tokens: [{ address: "0xB", chain: "base" }] } : list) }));
    const feed = new LiveFeed();
    await flush();
    calls.length = 0;
    await feed.loadChains(["bsc", "base"]);
    await feed.loadChains(["base", "bsc"]);
    expect(calls).toEqual(["/api/tokens/rest?chains=base%2Cbsc&offset=0&limit=1000"]);
  });

  it("a coin asked for by address goes ahead of the waiting sweep pages, so a ?coin= link opens at once", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("EventSource", FakeES);
    vi.stubGlobal("fetch", async (url: string) => ({ ok: true, json: async () => (url.includes("/find") ? { token: { address: "0xC", chain: "base" } } : url.includes("/rest") ? { total: 1, offset: 0, tokens: [{ address: "0xB", chain: "base" }] } : list) }));
    const feed = new LiveFeed();
    await flush();
    await feed.loadChains(["base"]);
    expect(await feed.find("0xC")).toBe(true);
    const pages = (feed as unknown as { tailPages: { address: string }[][] }).tailPages;
    expect(pages[0]!.map((t) => t.address)).toEqual(["0xC"]);
  });

  it("the opening read and a reset read ask the server itself (no-cache), so an old kept copy with no stream position cannot keep the page off the stream; the fallback poll may use the 5-second copy", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("EventSource", FakeES);
    const modes: [string, string | undefined][] = [];
    vi.stubGlobal("fetch", async (url: string, init?: { cache?: string }) => {
      modes.push([url, init?.cache]);
      return { ok: true, json: async () => (url.includes("/rest") ? { total: 0, offset: 0, tokens: [] } : list) };
    });
    new LiveFeed();
    await flush();
    expect(modes[0]).toEqual(["/api/tokens?view=tile", "no-cache"]);
    FakeES.last!.onerror!();
    await vi.advanceTimersByTimeAsync(POLL_EVERY_MS);
    expect(modes.filter(([u]) => u === "/api/tokens?view=tile").at(-1)).toEqual(["/api/tokens?view=tile", "default"]);
    modes.length = 0;
    FakeES.last!.emit("reset", {});
    await flush();
    expect(modes[0]).toEqual(["/api/tokens?view=tile", "no-cache"]);
  });

  it("without EventSource (an old browser) the page simply keeps the decision-200 polls", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("EventSource", undefined);
    vi.stubGlobal("fetch", async (url: string) => (calls.push(url), { ok: true, json: async () => (url.includes("/rest") ? { total: 0, offset: 0, tokens: [] } : list) }));
    new LiveFeed();
    await flush();
    calls.length = 0;
    await vi.advanceTimersByTimeAsync(POLL_EVERY_MS);
    expect(calls).toContain("/api/tokens?view=tile");
  });

  it("the page asks for the scored set wherever it changes what is shown: Discover (also on the map), every filter or order but the default, a coin's page", () => {
    const main = readFileSync(join(import.meta.dirname, "..", "main.ts"), "utf8");
    expect(main).toMatch(/if \(id === "discover" \|\| id === "deepscan"\) liveFeed\.wantRest\(\);/);
    // the team's F1: every filter or order but the default Trending (the head of the first page's own order), the map's Discover, a coin's page.
    expect(main.match(/if \(rankingNeedsRest\(f\)\) liveFeed\.wantRest\(\);/g)?.length).toBe(2);
    expect(main).toMatch(/return f !== "trending" \|\| getSort\("trending"\) !== "default";/);
    expect(main).toMatch(/if \(rankingNeedsRest\("trending"\)\) liveFeed\.wantRest\(\);/);
    expect(main).toMatch(/onSort: \(\) => \{\n    \/\/ [^\n]*\n    liveFeed\.wantRest\(\);/);
    expect(main).toMatch(/if \(discoverShown\) liveFeed\.wantRest\(\);/);
    expect(main).toMatch(/function openDeepScan\(token: Item\): void \{\n  liveFeed\.wantRest\(\);/);
    expect(main).not.toMatch(/createTerminal|ui\/terminal|openTerminal|terminallink|terminalbase/); // the old chart page is gone
  });
});
