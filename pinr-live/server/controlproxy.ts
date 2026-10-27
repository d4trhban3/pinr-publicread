import { request, type IncomingMessage, type ServerResponse } from "node:http";

/**
 * pinr.io/api/control/* to the control service on the server. the engine's service listens on 127.0.0.1:8790 and verifies Cloudflare Access's
 * signed token itself (`Cf-Access-Jwt-Assertion`), so this passes the request through UNCHANGED (method, path, query, every header, the body) and returns its
 * answer as it is: the feed server decides nothing and checks nothing here. Only a path under `/api/control/` and only GET or POST get through (and DELETE on the one teaching path); the service
 * is never reachable by any other path, a dot segment or another method; the body is capped; a service that is down answers 502.
 */
export const CONTROL_PORT = 8790;
export const MAX_BODY = 16 * 1024;
/** A map submitted from /control: the whole map and its changes, so a larger body is allowed on that one path. */
export const SUBMIT_PATH = "/api/control/submissions";
export const MAX_SUBMIT_BODY = 1024 * 1024;
export const TIMEOUT_MS = 10_000;
/** "Ask PINRai" waits for a model: up to a minute or more, so that one path gets a long wait; everything else keeps the short one. */
export const ASK_PATH = "/api/control/pinrai/ask";
export const ASK_TIMEOUT_MS = 170_000;
/** The one path that may be DELETEd (a saved teaching is removed; the engine's service decides the rest). */
export const TEACH_PATH = "/api/control/pinrai/teach";
const HOP = new Set(["connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailer", "transfer-encoding", "upgrade", "host"]);

/** Is this request for the control service? Decided on the normalised path, so `/api/control/../x` and `//` tricks are not. */
export function isControlPath(rawUrl: string | undefined): boolean {
  if (!rawUrl || rawUrl.includes("\\") || /%2e|%2f|%5c/i.test(rawUrl.split("?")[0]!)) return false;
  try {
    const u = new URL(rawUrl, "http://local");
    const raw = rawUrl.split("?")[0]!;
    return u.pathname === raw && u.pathname.startsWith("/api/control/") && !u.pathname.includes("//");
  } catch {
    return false;
  }
}

export function proxyControl(req: IncomingMessage, res: ServerResponse, port: number = CONTROL_PORT, timeoutOverride?: number): void {
  const path = (req.url ?? "").split("?")[0];
  const timeoutMs = timeoutOverride ?? (path === ASK_PATH ? ASK_TIMEOUT_MS : TIMEOUT_MS);
  const fail = (code: number, msg: string): void => {
    if (res.headersSent || res.writableEnded) return; // already answered (a timeout, then the error its own destroy raises)
    res.writeHead(code, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
    res.end(JSON.stringify({ error: msg }));
  };
  if (req.method !== "GET" && req.method !== "POST" && !(req.method === "DELETE" && path === TEACH_PATH)) return fail(405, "method not allowed");
  const headers: Record<string, string | string[]> = {};
  for (const [k, v] of Object.entries(req.headers)) if (v !== undefined && !HOP.has(k.toLowerCase())) headers[k] = v;
  const up = request({ host: "127.0.0.1", port, method: req.method, path: req.url, headers, timeout: timeoutMs }, (r) => {
    const out: Record<string, string | string[]> = {};
    for (const [k, v] of Object.entries(r.headers)) if (v !== undefined && !HOP.has(k.toLowerCase())) out[k] = v;
    out["cache-control"] = "no-store";
    res.writeHead(r.statusCode ?? 502, out);
    r.pipe(res);
  });
  up.on("timeout", () => (up.destroy(), fail(504, "the control service did not answer")));
  up.on("error", () => fail(502, "the control service is not reachable"));
  let size = 0;
  req.on("data", (c: Buffer) => {
    size += c.length;
    if (size > (path === SUBMIT_PATH && req.method === "POST" ? MAX_SUBMIT_BODY : MAX_BODY)) {
      up.destroy();
      fail(413, "body too large");
      req.destroy();
    }
  });
  req.pipe(up);
}
