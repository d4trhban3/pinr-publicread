import { describe, expect, it } from "vitest";
import { askerOf, LIVE_MS, WireMeter } from "./wiremeter.ts";

describe("a wire's state is measured, never drawn", () => {
  it("is live while data crossed it in the last few minutes, quiet after, red with the error when its source refused last", () => {
    let now = 1_000_000;
    const m = new WireMeter(() => now);
    expect(m.reading("a>b:x").state).toBe("quiet");
    m.hit("a>b:x", 3, "coin1");
    expect(m.reading("a>b:x")).toMatchObject({ state: "live", last10: 3, lastMs: now, sample: "coin1", error: null });
    now += LIVE_MS + 1;
    expect(m.reading("a>b:x").state).toBe("quiet");
    m.fail("a>b:x", "HTTP 403");
    expect(m.reading("a>b:x")).toMatchObject({ state: "error", error: "HTTP 403" });
    now += 1000;
    m.hit("a>b:x", 1, "coin2");
    expect(m.reading("a>b:x")).toMatchObject({ state: "live", error: null, sample: "coin2" });
  });
  it("counts the last ten minutes only", () => {
    let now = 0;
    const m = new WireMeter(() => now);
    m.hit("w", 5);
    now += 11 * 60_000;
    m.hit("w", 2);
    expect(m.reading("w").last10).toBe(2);
    expect(Object.keys(m.snapshot())).toEqual(["w"]);
  });
  it("tells the apps from a browser by their request library", () => {
    expect(askerOf("PINR/12 CFNetwork/1498 Darwin/24.0.0")).toBe("app");
    expect(askerOf("Dalvik/2.1.0 (Linux; U; Android 14)")).toBe("app");
    expect(askerOf("Mozilla/5.0 (Macintosh)")).toBe("browser");
    expect(askerOf(undefined)).toBe("other");
  });
  it("lists the expected wires from the start, and a worker's running count crosses only by what it grew", () => {
    let now = 0;
    const m = new WireMeter(() => now);
    m.expect(["p>w:list"]);
    expect(Object.keys(m.snapshot())).toEqual(["p>w:list"]);
    expect(m.reading("p>w:list")).toMatchObject({ state: "quiet", lastMs: null });
    m.tally("s>p:pics", 40, "a");
    expect(m.reading("s>p:pics").last10).toBe(0); // the first look only sets the start
    now = 1000;
    m.tally("s>p:pics", 43, "b");
    m.tally("s>p:pics", 43, "c");
    expect(m.reading("s>p:pics")).toMatchObject({ state: "live", last10: 3, sample: "b" });
  });
});

describe("DEBUG, 26 Oct: a restart does not blank a wire, a quiet visitor wire says why, and the rate is never 0 beside a busy ten minutes", () => {
  it("a wire's last time survives a restart through the file; a visitor wire with none waits for a visitor", async () => {
    const { mkdtempSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = mkdtempSync(join(tmpdir(), "wm-"));
    const path = join(dir, "wiremeter.json");
    let now = 5_000_000;
    const a = new WireMeter(() => now, path);
    a.hit("p_evid>w_coin:evidence", 3, "coin1");
    a.save();
    now += 60_000; // a restart a minute later
    const b = new WireMeter(() => now, path);
    expect(b.reading("p_evid>w_coin:evidence")).toMatchObject({ state: "live", lastMs: 5_000_000 });
    expect(b.reading("p_evid>w_coin:evidence").reason).toBeUndefined();
    const c = new WireMeter(() => now + 3_600_000, join(dir, "none.json"));
    c.expect(["p_img>w_home:picture", "a_pool>p_tokens:coin list"]);
    expect(c.reading("p_img>w_home:picture")).toMatchObject({ state: "quiet", reason: expect.stringMatching(/waiting for a visitor/) });
    expect(c.reading("a_pool>p_tokens:coin list").reason).toBeUndefined();       // an engine-driven wire has no such excuse
    c.expect(["e_store>p_evid:evidence", "a_trades>p_chart:own ticks", "s_dex>p_chart:DexScreener", "a_trades>p_trades:trades"]);
    for (const k of ["e_store>p_evid:evidence", "a_trades>p_chart:own ticks", "s_dex>p_chart:DexScreener"]) expect(c.reading(k).reason).toMatch(/waiting for a visitor/);
    expect(c.reading("a_trades>p_trades:trades").reason).toBeUndefined();         // the trade stream runs without a visitor
    rmSync(dir, { recursive: true, force: true });
  });
  it("items a minute is never under the last ten minutes' average (131 in ten minutes does not read 0 a minute)", () => {
    let now = 10 * 60_000 * 3;
    const m = new WireMeter(() => now);
    m.hit("w", 131);
    now += 3 * 60_000;
    const r = m.reading("w");
    expect(r.last10).toBe(131);
    expect(r.perMin).toBeGreaterThanOrEqual(13);
  });
});
