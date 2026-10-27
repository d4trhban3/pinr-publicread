import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readEvidence } from "./evidence";
import { loadFeed } from "./feed";
import { quietMarks } from "./quiet";
// @ts-expect-error a plain script, no types
import { SAMPLE_COINS, SAMPLE_EVIDENCE, SAMPLE_QUIET, writeSampleDrop } from "../tools/sample-drop.mjs";

const TOOLS = join(import.meta.dirname, "..", "tools");

describe("the sample drop folder (D4)", () => {
  const root = mkdtempSync(join(tmpdir(), "sample-drop-"));
  const out = writeSampleDrop(root);
  it("is read by the feed reader with no problems: every sample coin, invented addresses only", () => {
    const f = loadFeed([{ dir: out.drop, feed: true }]);
    expect(f.problems).toEqual([]);
    expect(f.tokens.length + f.rest.length).toBe(SAMPLE_COINS.length);
    for (const c of SAMPLE_COINS) expect(c.mint).toMatch(/Samp1e|5a3b1e/); // never a real coin
  });
  it("has an evidence file with a gate result and a PINRai reading, and a fresh quiet mark", () => {
    const ev = readEvidence(SAMPLE_EVIDENCE, join(out.drop, "evidence"))!;
    expect(ev.gate?.status).toBe("passed");
    expect(ev.pinrai?.items[0]?.receipts[0]?.link).toBe("https://solscan.io/tx/sample");
    const marks = quietMarks(JSON.parse(readFileSync(join(out.drop, "_quiet.json"), "utf8")));
    expect([...marks]).toEqual([SAMPLE_QUIET.toLowerCase()]);
  });
  it("carries no key, password or secret-looking value", () => {
    const src = readFileSync(join(TOOLS, "sample-drop.mjs"), "utf8") + readFileSync(join(TOOLS, "control-standin.mjs"), "utf8");
    expect(src).not.toMatch(/api[_-]?key\s*[:=]|secret\s*[:=]|password|Bearer |sk-[A-Za-z0-9]/i);
  });
});

describe("the control service stand-in (D5)", () => {
  const port = 18_000 + Math.floor(Math.random() * 1000);
  let child: ChildProcess;
  const call = async (method: string, path: string, body?: unknown) => {
    const r = await fetch(`http://127.0.0.1:${port}${path}`, { method, headers: body === undefined ? {} : { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: r.status, j: (await r.json()) as any };
  };
  beforeAll(async () => {
    child = spawn(process.execPath, [join(TOOLS, "control-standin.mjs"), String(port)], { stdio: "ignore" });
    for (let i = 0; i < 50; i++) {
      try { await fetch(`http://127.0.0.1:${port}/api/control/status`); return; } catch { await new Promise((r) => setTimeout(r, 100)); }
    }
  });
  afterAll(() => child?.kill());
  it("answers status, gate and routing in the engine's shapes", async () => {
    const s = await call("GET", "/api/control/status");
    expect(s.j).toMatchObject({ engine: { sources: expect.any(Object) }, control: { pinrai: { on: true } }, gate: { coins_in_per_min: expect.any(Number) } });
    const g = await call("GET", "/api/control/gate");
    expect(g.j).toMatchObject({ version: 1, graph: expect.any(Object), versions: expect.any(Array) });
    const r = await call("GET", "/api/control/routing");
    expect(r.j.catalog.fields.price).toMatchObject({ owner: "feed", followed: false });
    expect(r.j.catalog.fields.picture).toMatchObject({ owner: "engine", followed: true });
  });
  it("refuses what the server refuses, and applies a preview once", async () => {
    const off = await call("POST", "/api/control/gate/preview", { graph: { checks: { lookalike_picture: { on: true, match: [] } } } });
    expect(off.status).toBe(422);
    const r = (await call("GET", "/api/control/routing")).j;
    const routes = Object.fromEntries(Object.entries(r.catalog.fields).map(([f, d]: [string, any]) => [f, d.default]));
    const discovery = Object.fromEntries(Object.keys(r.catalog.discovery).map((l) => [l, true]));
    expect((await call("POST", "/api/control/routing/preview", { routing: { routes: { ...routes, price: ["jupiter"] }, discovery } })).status).toBe(422); // the feed does not follow price yet
    const p = await call("POST", "/api/control/routing/preview", { routing: { routes: { ...routes, picture: ["ipfs", "jupiter"] }, discovery } });
    expect(p.status).toBe(200);
    expect((await call("POST", "/api/control/routing/apply", { preview_id: p.j.preview_id })).status).toBe(200);
    expect((await call("POST", "/api/control/routing/apply", { preview_id: p.j.preview_id })).status).toBe(409);
  });
  it("answers Ask PINRai and keeps, lists and removes a teaching", async () => {
    const a = await call("POST", "/api/control/pinrai/ask", { coin: SAMPLE_EVIDENCE, question: "why?" });
    expect(a.j).toMatchObject({ status: "answered", evidence: expect.any(Array), unknown_ids: ["z9"] });
    expect((await call("POST", "/api/control/pinrai/teach", { coin: SAMPLE_EVIDENCE, text: "a correction" })).status).toBe(200);
    const list = (await call("GET", "/api/control/pinrai/teach")).j.teaching;
    const mine = list.find((t: any) => t.text === "a correction");
    expect((await call("DELETE", "/api/control/pinrai/teach", { id: mine.id })).status).toBe(200);
    expect((await call("GET", "/api/control/pinrai/teach")).j.teaching.some((t: any) => t.text === "a correction")).toBe(false);
  });
});
