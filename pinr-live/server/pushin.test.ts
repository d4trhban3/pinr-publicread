import { mkdtempSync, renameSync, writeFileSync } from "node:fs";
import { request, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { MAX_BODY, MAX_TICKS, readPush, startPushIn } from "./pushin.ts";
import { TickReader } from "./ticks.ts";

const MINT = "So1Coin1111111111111111111111111111111111111";
const tick = (i: number) => ({ t: 1_792_900_000_000 + i, sig: `sig${i}`, i: 0, slot: 1, side: i % 2 ? "sell" : "buy", sol: 0.5, price_sol: 2e-8, seen_ms: 1_792_900_000_100 + i });
const post = (port: number, path: string, body: string, method = "POST"): Promise<number> =>
  new Promise((ok, no) => {
    const r = request({ host: "127.0.0.1", port, path, method, headers: { "content-type": "application/json" } }, (res) => (res.resume(), ok(res.statusCode ?? 0)));
    r.on("error", (e) => (String(e).includes("ECONNRESET") ? ok(413) : no(e)));
    r.end(body);
  });

describe("trades pushed by the engine", () => {
  it("takes only a ticks-1 body with a mint and at most 500 ticks", () => {
    expect(readPush(JSON.stringify({ contract: "ticks-1", mint: MINT, ticks: [tick(1)] }))).toEqual({ mint: MINT, ticks: [tick(1)] });
    expect(readPush(JSON.stringify({ contract: "ticks-2", mint: MINT, ticks: [] }))).toBeNull();
    expect(readPush(JSON.stringify({ contract: "ticks-1", ticks: [] }))).toBeNull();
    expect(readPush(JSON.stringify({ contract: "ticks-1", mint: MINT, ticks: Array.from({ length: MAX_TICKS + 1 }, (_, i) => tick(i)) }))).toBeNull();
    expect(readPush("{half")).toBeNull();
  });
  it("hands each pushed trade out once, in dollars, and never again when the tick file later holds it", () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-"));
    const r = new TickReader(dir, () => 0, null);
    const a = r.pushed(MINT, [tick(1), tick(2), { side: "buy" }], 100);
    expect(a).toEqual([
      { address: MINT, atMs: tick(1).t, side: "sell", priceUsd: 2e-6, usd: 50 },
      { address: MINT, atMs: tick(2).t, side: "buy", priceUsd: 2e-6, usd: 50 },
    ]);
    expect(r.pushed(MINT, [tick(2), tick(3)], 100).map((t) => t.atMs)).toEqual([tick(3).t]);
    const tmp = join(dir, "x.tmp");
    writeFileSync(tmp, JSON.stringify({ contract: "ticks-1", source: "Solana chain", read_at: new Date().toISOString(), ticks: [tick(1), tick(2), tick(3), tick(4)] }));
    renameSync(tmp, join(dir, `${MINT}.json`));
    const changed = r.refresh();
    expect(r.newTrades(changed, 100).map((t) => t.atMs)).toEqual([tick(4).t]); // only the one never pushed
    expect(r.pushed(MINT, [tick(5)], null)).toEqual([]); // no SOL price: no dollar figure is made up
    expect(r.pushed("../x", [tick(6)], 100)).toEqual([]);
  });
  let srv: Server | null = null;
  afterAll(() => srv?.close());
  it("listens on 127.0.0.1 only, answers 204 before handing the ticks on, and refuses anything else", async () => {
    const got: [string, unknown[]][] = [];
    srv = startPushIn((m, t) => got.push([m, t]), 0);
    await new Promise((r) => srv!.once("listening", r));
    const addr = srv.address() as { address: string; port: number };
    expect(addr.address).toBe("127.0.0.1");
    expect(await post(addr.port, "/internal/ticks", JSON.stringify({ contract: "ticks-1", mint: MINT, ticks: [tick(1)] }))).toBe(204);
    expect(got).toEqual([[MINT, [tick(1)]]]);
    expect(await post(addr.port, "/internal/ticks", "{bad")).toBe(400);
    expect(await post(addr.port, "/api/tokens", "{}")).toBe(404);
    expect(await post(addr.port, "/internal/ticks", "", "GET")).toBe(404);
    expect(await post(addr.port, "/internal/ticks", "x".repeat(MAX_BODY + 10))).toBe(413);
    expect(got).toHaveLength(1);
  });
});
