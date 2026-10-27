import { createServer, request, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ASK_TIMEOUT_MS, isControlPath, MAX_BODY, proxyControl, TIMEOUT_MS } from "./controlproxy";

/** /api/control/* passes through unchanged to the control service, and nothing else does. */
let upstream: Server;
let front: Server;
let upPort = 0;
let frontPort = 0;
const seen: { method?: string; url?: string; headers: IncomingMessage["headers"]; body: string }[] = [];
const dead = 1; // a port nothing listens on

beforeAll(async () => {
  upstream = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      seen.push({ method: req.method, url: req.url, headers: req.headers, body });
      if (req.url === "/api/control/slow") return; // never answers
      res.writeHead(req.url === "/api/control/refused" ? 403 : 200, { "content-type": "application/json", "x-from": "service" });
      res.end(JSON.stringify({ ok: true, echo: body }));
    });
  });
  await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", r));
  upPort = (upstream.address() as AddressInfo).port;
  front = createServer((req, res) => {
    if (!isControlPath(req.url)) return void (res.writeHead(404), res.end("no"));
    proxyControl(req, res, req.headers["x-test-dead"] ? dead : upPort, req.headers["x-test-timeout"] ? 150 : undefined);
  });
  await new Promise<void>((r) => front.listen(0, "127.0.0.1", r));
  frontPort = (front.address() as AddressInfo).port;
});
afterAll(() => {
  upstream.close();
  front.close();
});

const call = (method: string, path: string, headers: Record<string, string> = {}, body?: string): Promise<{ status: number; headers: IncomingMessage["headers"]; body: string }> =>
  new Promise((resolve, reject) => {
    const r = request({ host: "127.0.0.1", port: frontPort, method, path, headers, agent: false }, (res) => {
      let b = "";
      res.on("data", (c) => (b += c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: b }));
    });
    r.on("error", reject);
    if (body !== undefined) r.write(body);
    r.end();
  });

describe("which paths reach the control service", () => {
  it("accepts a plain path under /api/control/ and nothing that only looks like one", () => {
    for (const ok of ["/api/control/status", "/api/control/set", "/api/control/undo", "/api/control/status?x=1"]) expect(isControlPath(ok)).toBe(true);
    for (const bad of ["/api/control", "/api/controlx/status", "/api/control/../tokens", "/api/control/%2e%2e/tokens", "/api/control//status", "/api/control/a\\b", "/api/tokens", "/control/status", "", undefined]) expect(isControlPath(bad as never)).toBe(false);
  });
});

describe("the pass-through", () => {
  it("passes a GET through unchanged, with the Access token header, and returns the service's answer as it is", async () => {
    const r = await call("GET", "/api/control/status?window=1", { "Cf-Access-Jwt-Assertion": "tok.en.value", "x-other": "kept" });
    expect(r.status).toBe(200);
    expect(r.headers["x-from"]).toBe("service");
    expect(JSON.parse(r.body)).toEqual({ ok: true, echo: "" });
    const s = seen.at(-1)!;
    expect(s.method).toBe("GET");
    expect(s.url).toBe("/api/control/status?window=1");
    expect(s.headers["cf-access-jwt-assertion"]).toBe("tok.en.value");
    expect(s.headers["x-other"]).toBe("kept");
  });
  it("passes a POST's body and content type through, and the service's refusal (403) back as it is", async () => {
    const body = JSON.stringify({ key: "sources.jupiter.on", value: false });
    const r = await call("POST", "/api/control/set", { "content-type": "application/json", "content-length": String(body.length), "Cf-Access-Jwt-Assertion": "t" }, body);
    expect(r.status).toBe(200);
    expect(JSON.parse(r.body).echo).toBe(body);
    const s = seen.at(-1)!;
    expect(s.method).toBe("POST");
    expect(s.headers["content-type"]).toBe("application/json");
    expect(s.body).toBe(body);
    const refused = await call("GET", "/api/control/refused");
    expect(refused.status).toBe(403);
  });
  it("refuses other methods itself (the service is not asked) and a body over the cap", async () => {
    const before = seen.length;
    expect((await call("PUT", "/api/control/set", {}, "{}")).status).toBe(405);
    expect((await call("DELETE", "/api/control/set")).status).toBe(405);
    expect((await call("DELETE", "/api/control/pinrai/ask")).status).toBe(405);
    expect((await call("DELETE", "/api/control/pinrai/teach/x")).status).toBe(405);
    expect(seen.length).toBe(before);
    const big = "x".repeat(MAX_BODY + 100);
    const r = await call("POST", "/api/control/set", { "content-type": "application/json", "content-length": String(big.length) }, big).catch(() => ({ status: 0 }));
    expect([413, 0]).toContain(r.status); // answered 413, or the connection was cut
  });
  it("lets a map submission through at 100 KB (the whole map) on its one path, and still refuses a body over 1 MB there and 16 KB elsewhere", async () => {
    const map = JSON.stringify({ v: 1, map: { nodes: [], wires: [] }, diff: { text: "x" }, note: "y".repeat(100_000) });
    const ok = await call("POST", "/api/control/submissions", { "content-type": "application/json", "content-length": String(map.length) }, map);
    expect(ok.status).toBe(200);
    const huge = "x".repeat(1024 * 1024 + 100);
    const r = await call("POST", "/api/control/submissions", { "content-type": "application/json", "content-length": String(huge.length) }, huge).catch(() => ({ status: 0 }));
    expect([413, 0]).toContain(r.status);
    const other = await call("POST", "/api/control/set", { "content-type": "application/json", "content-length": String(map.length) }, map).catch(() => ({ status: 0 }));
    expect([413, 0]).toContain(other.status);
  });
  it("passes a DELETE on the one teaching path, with its body, and nothing else", async () => {
    const r = await call("DELETE", "/api/control/pinrai/teach", { "content-type": "application/json", "content-length": "11" }, '{"id":"t1"}');
    expect(r.status).toBe(200);
    const last = seen[seen.length - 1]!;
    expect(last.method).toBe("DELETE");
    expect(last.body).toBe('{"id":"t1"}');
  });
  it("gives only the ask path a long wait", () => {
    expect(ASK_TIMEOUT_MS).toBeGreaterThan(60_000);
    expect(TIMEOUT_MS).toBeLessThan(30_000);
  });
  it("answers 502 when the service is down and 504 when it does not answer", async () => {
    expect((await call("GET", "/api/control/status", { "x-test-dead": "1" })).status).toBe(502);
    expect((await call("GET", "/api/control/slow", { "x-test-timeout": "1" })).status).toBe(504);
  });
  it("never lets a request outside /api/control/ through to the service", async () => {
    const before = seen.length;
    expect((await call("GET", "/api/tokens")).status).toBe(404);
    expect((await call("GET", "/api/control/../tokens")).status).toBe(404);
    expect(seen.length).toBe(before);
  });
});
