import { DIRECT_IMAGE_HOSTS } from "./imagehosts";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, request, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cacheControlFor, isLoopback, parseRange, publicSnapshot, resolveStatic, SECURITY_HEADERS, serveStatic, setSecurityHeaders } from "./staticsite.ts";

const root = mkdtempSync(join(tmpdir(), "pinr-site-"));
mkdirSync(join(root, "assets"));
mkdirSync(join(root, "control"));
writeFileSync(join(root, "control", "index.html"), "<title>blueprint</title>");
writeFileSync(join(root, "index.html"), "<!doctype html><title>PINR</title>");
writeFileSync(join(root, "privacy.html"), "<h1>Privacy</h1>");
writeFileSync(join(root, "assets", "app-abc123.js"), "console.log(1)");
writeFileSync(join(root, "movie.mp4"), Buffer.from("0123456789"));
writeFileSync(join(tmpdir(), "pinr-secret.txt"), "secret");

describe("which file a request names", () => {
  it("serves the page, the privacy page and files, and nothing else", () => {
    expect(resolveStatic("/", root)).toBe(join(root, "index.html"));
    expect(resolveStatic("/privacy", root)).toBe(join(root, "privacy.html"));
    expect(resolveStatic("/control", root)).toBe(join(root, "control", "index.html")); // the blueprint page
    expect(resolveStatic("/control/", root)).toBe(join(root, "control", "index.html"));
    expect(resolveStatic("/privacy.html", root)).toBe(join(root, "privacy.html"));
    expect(resolveStatic("/assets/app-abc123.js", root)).toBe(join(root, "assets", "app-abc123.js"));
    expect(resolveStatic("/nope.js", root)).toBeNull();
    expect(resolveStatic("/assets", root)).toBeNull(); // a folder is not a file
  });
  it("never leaves the site's folder", () => {
    for (const bad of ["/../pinr-secret.txt", "/%2e%2e/pinr-secret.txt", "/assets/../../pinr-secret.txt", "/..%2fpinr-secret.txt", "/a\0b", "/%E0%A4%A"]) expect(resolveStatic(bad, root), bad).toBeNull();
  });
  it("hashed build files are cached for good; the rest is checked each time", () => {
    expect(cacheControlFor("/assets/app-abc123.js")).toContain("immutable");
    expect(cacheControlFor("/index.html")).toBe("no-cache");
    // an /art/ file asked for by its own content hash is kept a year; without one, or with anything else, it is checked each time.
    expect(cacheControlFor("/art/pinr-bg-creep240.mp4", "?v=121ac8f366")).toBe("public, max-age=31536000, immutable");
    expect(cacheControlFor("/art/pinr-blade.svg", "")).toBe("no-cache");
    expect(cacheControlFor("/art/pinr-blade.svg", "?v=nothex")).toBe("no-cache");
    expect(cacheControlFor("/index.html", "?v=121ac8f366")).toBe("no-cache");
  });
});

describe("byte ranges (Safari asks for the video this way)", () => {
  it("reads the three forms and refuses the rest", () => {
    expect(parseRange(undefined, 10)).toBeNull();
    expect(parseRange("bytes=2-5", 10)).toEqual({ start: 2, end: 5 });
    expect(parseRange("bytes=2-", 10)).toEqual({ start: 2, end: 9 });
    expect(parseRange("bytes=-3", 10)).toEqual({ start: 7, end: 9 });
    expect(parseRange("bytes=2-500", 10)).toEqual({ start: 2, end: 9 });
    for (const bad of ["bytes=20-30", "bytes=5-2", "bytes=-", "items=1-2", "bytes=a-b"]) expect(parseRange(bad, 10), bad).toBe("bad");
  });
});

describe("the security headers", () => {
  it("allow only the site's own origin, no frames, no sniffing, HTTPS only", () => {
    const csp = SECURITY_HEADERS["content-security-policy"]!;
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("script-src 'self'");
    expect(csp).not.toMatch(/script-src[^;]*unsafe/);
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("connect-src 'self' https://api.dexscreener.com https://api.geckoterminal.com");
    expect(csp).not.toContain("frame-src"); // no embedded frames: default-src 'self' covers them
    expect(csp).toContain("default-src 'self'");
    // no other outside address anywhere in the policy (TradingView's two hosts are frame-src only, never script or connect)
    const hosts = [...csp.matchAll(/https?:\/\/[^\s;]+/g)].map((m) => m[0]);
    expect(hosts.sort()).toEqual([...["https://api.dexscreener.com", "https://api.geckoterminal.com", ...DIRECT_IMAGE_HOSTS.map((h) => `https://${h}`)]].sort());
    expect(csp).toMatch(/img-src 'self' data: blob: https:\/\/ipfs\.io/); // pictures may come straight from the listed picture hosts, and from no other
    expect(csp.match(/script-src[^;]*/)![0]).toBe("script-src 'self'");
    expect(SECURITY_HEADERS["x-content-type-options"]).toBe("nosniff");
    expect(SECURITY_HEADERS["strict-transport-security"]).toMatch(/max-age=\d{7,}/);
    expect(SECURITY_HEADERS["referrer-policy"]).toBe("no-referrer");
    expect(SECURITY_HEADERS["x-frame-options"]).toBe("DENY");
  });
});

describe("an HTTP round trip over the built-site folder", () => {
  let server: Server;
  let port = 0;
  beforeAll(async () => {
    server = createServer((req, res) => {
      setSecurityHeaders(res);
      if (!serveStatic(req, res, new URL(req.url ?? "/", "http://x").pathname, root)) {
        res.writeHead(404);
        res.end("Not found");
      }
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    port = (server.address() as { port: number }).port;
  });
  afterAll(() => void server.close());
  const get = (path: string, headers: Record<string, string> = {}, method = "GET"): Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: string }> =>
    new Promise((resolve, reject) => {
      const r = request({ host: "127.0.0.1", port, path, method, headers }, (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString() }));
      });
      r.on("error", reject);
      r.end();
    });
  it("serves the page with the headers on, and 404 with the headers for the rest", async () => {
    const a = await get("/");
    expect(a.status).toBe(200);
    expect(a.body).toContain("PINR");
    expect(a.headers["content-type"]).toContain("text/html");
    expect(a.headers["content-security-policy"]).toBe(SECURITY_HEADERS["content-security-policy"]);
    expect(a.headers["x-content-type-options"]).toBe("nosniff");
    const b = await get("/nothing");
    expect(b.status).toBe(404);
    expect(b.headers["x-frame-options"]).toBe("DENY");
    expect((await get("/../pinr-secret.txt")).status).toBe(404);
  });
  it("answers a byte range with 206 and the right bytes, and HEAD with no body", async () => {
    const r = await get("/movie.mp4", { range: "bytes=2-5" });
    expect(r.status).toBe(206);
    expect(r.body).toBe("2345");
    expect(r.headers["content-range"]).toBe("bytes 2-5/10");
    expect((await get("/movie.mp4", { range: "bytes=50-60" })).status).toBe(416);
    const h = await get("/index.html", {}, "HEAD");
    expect(h.status).toBe(200);
    expect(h.body).toBe("");
  });
});

describe("what the public snapshot leaves out", () => {
  it("drops the providers' counters and the workers' stats, keeps what the page reads", () => {
    const body = JSON.stringify({ contract: "1.0", mode: "feed", files: 3, tokens: [{ address: "a" }], market: { source: "GeckoTerminal", covered: 1, none: 0, pausedForS: 0 }, quotes: [{ id: "x" }], pumpfun: { calls: 9 }, pool: { calls: 1 }, tape: {}, vampDesk: { pictures: 1 }, images: { fetched: 2 } });
    const o = JSON.parse(publicSnapshot(body)) as Record<string, unknown>;
    expect(Object.keys(o).sort()).toEqual(["contract", "files", "market", "mode", "tokens"]);
  });
  it("tells a visitor from the machine itself", () => {
    expect(isLoopback("127.0.0.1")).toBe(true);
    expect(isLoopback("::1")).toBe(true);
    expect(isLoopback("203.0.113.9")).toBe(false);
    expect(isLoopback(undefined)).toBe(false);
  });
});

describe("the site's source is ready for production", () => {
  const siteRoot = join(import.meta.dirname, "..");
  const walk = (d: string): string[] => readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(d, e.name)) : [join(d, e.name)]));
  it("no localhost or fixed local address in the page's source or its files", () => {
    const files = [...walk(join(siteRoot, "src")).filter((f) => /\.(ts|css)$/.test(f) && !/\.test\.ts$/.test(f)), join(siteRoot, "index.html"), ...walk(join(siteRoot, "public")).filter((f) => /\.(html|svg|css|js)$/.test(f))];
    expect(files.length).toBeGreaterThan(10);
    for (const f of files) {
      const src = readFileSync(f, "utf8");
      // a line of comment may name the dev address; code and markup may not
      const code = src.split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");
      expect(/localhost|127\.0\.0\.1|0\.0\.0\.0|:8787|:5173/.test(code), `${f.replace(siteRoot, "")} names a local address`).toBe(false);
    }
  });
  it("the page has no inline script (the security headers allow only scripts from its own origin)", () => {
    const html = readFileSync(join(siteRoot, "index.html"), "utf8");
    const scripts = html.match(/<script\b[^>]*>/gi) ?? [];
    expect(scripts.length).toBeGreaterThan(0);
    for (const tag of scripts) expect(tag, tag).toMatch(/\bsrc=/);
    expect(readFileSync(join(siteRoot, "public", "theme-init.js"), "utf8")).toContain("pinr.theme");
  });
  it("the privacy page is plain, links back, names no tracker, is final, and has no blank left", () => {
    const html = readFileSync(join(siteRoot, "public", "privacy.html"), "utf8");
    expect(html).toContain("no accounts");
    expect(html).toContain("no cookies");
    expect(html).not.toMatch(/<script/i);
    expect(html).not.toMatch(/\bsafe\b|guarantee/i);
    expect(html).not.toMatch(/Draft|FOUNDER TO FILL|to be confirmed/);
    expect(html).toContain("reaches you through Cloudflare");
    expect(html).toContain("contact@example.com");
    expect(html).toContain("kept for 14 days");
    expect(html).toContain('href="/"');
  });
});

describe("Android App Links (the team: a tapped pinr.io/?coin= link opens the Android app)", () => {
  const file = join(import.meta.dirname, "..", "public", ".well-known", "assetlinks.json");
  it("names the app and its public certificate fingerprint, and nothing else", () => {
    const links = JSON.parse(readFileSync(file, "utf8"));
    expect(links).toHaveLength(1);
    expect(links[0].relation).toEqual(["delegate_permission/common.handle_all_urls"]);
    expect(links[0].target.namespace).toBe("android_app");
    expect(links[0].target.package_name).toBe("io.pinr.app");
    for (const f of links[0].target.sha256_cert_fingerprints) expect(f).toMatch(/^([0-9A-F]{2}:){31}[0-9A-F]{2}$/);
  });
  it("is served from the build as JSON at /.well-known/assetlinks.json", () => {
    const dist = join(import.meta.dirname, "..", "public");
    const at = resolveStatic("/.well-known/assetlinks.json", dist);
    expect(at).toBe(file);
  });
});

describe("the site's page carries the server's score switch", () => {
  const site = mkdtempSync(join(tmpdir(), "pinr-mark-"));
  mkdirSync(join(site, "control"), { recursive: true });
  writeFileSync(join(site, "index.html"), '<!doctype html>\n<html lang="en">\n<head><title>PINR</title></head></html>');
  writeFileSync(join(site, "control", "index.html"), '<html lang="en"><title>blueprint</title></html>');
  let server: Server;
  let port = 0;
  let on = true;
  beforeAll(async () => {
    server = createServer((req, res) => {
      setSecurityHeaders(res);
      if (!serveStatic(req, res, new URL(req.url ?? "/", "http://x").pathname, site, on)) {
        res.writeHead(404);
        res.end();
      }
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    port = (server.address() as { port: number }).port;
  });
  afterAll(() => void server.close());
  const get = (path: string): Promise<{ headers: Record<string, string | string[] | undefined>; body: string }> =>
    new Promise((resolve, reject) => {
      const r = request({ host: "127.0.0.1", port, path }, (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => resolve({ headers: res.headers, body: Buffer.concat(chunks).toString() }));
      });
      r.on("error", reject);
      r.end();
    });
  it("marks the page's <html> when the score is shown, never with a script, and checked each time", async () => {
    on = true;
    const a = await get("/");
    expect(a.body).toContain('<html data-score="on" lang="en">');
    expect(a.body).not.toContain("<script");
    expect(a.headers["cache-control"]).toBe("no-cache");
    expect(a.headers["content-security-policy"]).toBe(SECURITY_HEADERS["content-security-policy"]);
    expect(Number(a.headers["content-length"])).toBe(Buffer.byteLength(a.body));
    expect((await get("/index.html")).body).toBe(a.body);
  });
  it("leaves the page unmarked when the score is hidden, and leaves other pages alone", async () => {
    on = false;
    expect((await get("/")).body).not.toContain("data-score");
    on = true;
    expect((await get("/control")).body).not.toContain("data-score");
  });
});
