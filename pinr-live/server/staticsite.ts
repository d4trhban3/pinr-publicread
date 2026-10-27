import { createReadStream, existsSync, readFileSync, statSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { extname, join, normalize, resolve, sep } from "node:path";
import { DIRECT_IMAGE_HOSTS } from "./imagehosts.ts";

/**
 * Serving the built site and the security headers.
 * Nothing here reads a secret or the engine's files; it hands out the files of `dist/` and nothing outside it.
 */

/**
 * The headers on every answer. The page loads only its own scripts, styles, fonts, pictures and the one background video from its own origin, and talks
 * only to its own /api (a token's picture and chart data are fetched by the server, never by the visitor's browser). Inline styles are used by the
 * page, so styles allow 'unsafe-inline'; scripts do not.
 */
// the small charts load in the visitor's browser from DexScreener's and GeckoTerminal's free APIs, so exactly those two addresses may
// be connected to and nothing else. No frames. Anything added here needs a decision.
/** The picture hosts a browser may load from directly (server/imagehosts.ts); every other picture comes through the server. */
const IMG_HOSTS = DIRECT_IMAGE_HOSTS.map((h) => `https://${h}`).join(" ");
export const SECURITY_HEADERS: Readonly<Record<string, string>> = {
  "content-security-policy": `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: ${IMG_HOSTS}; media-src 'self'; font-src 'self'; connect-src 'self' https://api.dexscreener.com https://api.geckoterminal.com; worker-src 'self' blob:; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'`,
  "strict-transport-security": "max-age=31536000; includeSubDomains",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  "referrer-policy": "no-referrer",
  "permissions-policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()",
  "cross-origin-opener-policy": "same-origin",
  "cross-origin-resource-policy": "same-origin",
};

export function setSecurityHeaders(res: ServerResponse): void {
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.setHeader(k, v);
}

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".webp": "image/webp",
  ".mp4": "video/mp4",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".ico": "image/x-icon",
  ".txt": "text/plain; charset=utf-8",
};

/** The file a request path names inside `root`, or null (not there, a directory, or an attempt to leave `root`). `/` is the page; `/privacy` is the privacy page. */
export function resolveStatic(pathname: string, root: string): string | null {
  let p: string;
  try {
    p = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  if (p.includes("\0")) return null;
  if (p === "/" || p === "") p = "/index.html";
  if (p === "/privacy") p = "/privacy.html";
  if (p === "/control" || p === "/control/") p = "/control/index.html"; // the blueprint page, behind Cloudflare Access
  const base = resolve(root);
  const file = resolve(join(base, normalize(p)));
  if (file !== base && !file.startsWith(base + sep)) return null;
  try {
    return existsSync(file) && statSync(file).isFile() ? file : null;
  } catch {
    return null;
  }
}

/**
 * Hashed build files never change under their name, and neither does an `/art/` file asked for by its content's own `?v=` (artversions.ts:
 * a changed picture gets a new address), so both are kept a year; everything else is checked each time.
 */
export function cacheControlFor(pathname: string, search = ""): string {
  if (pathname.startsWith("/assets/")) return "public, max-age=31536000, immutable";
  if (pathname.startsWith("/art/") && /(^|[?&])v=[0-9a-f]{10}(&|$)/.test(search.replace(/^\?/, ""))) return "public, max-age=31536000, immutable";
  return "no-cache";
}

/** One byte range of a file (Safari asks for the video this way), or null for the whole file; "bad" when the range cannot be served. */
export function parseRange(header: string | undefined, size: number): { start: number; end: number } | null | "bad" {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m || (m[1] === "" && m[2] === "")) return "bad";
  let start: number;
  let end: number;
  if (m[1] === "") {
    const n = Number(m[2]);
    start = Math.max(0, size - n);
    end = size - 1;
  } else {
    start = Number(m[1]);
    end = m[2] === "" ? size - 1 : Math.min(Number(m[2]), size - 1);
  }
  if (!(start <= end) || start >= size) return "bad";
  return { start, end };
}

/**
 * The site's own page with the server's score switch on its <html> tag (`data-score="on"`), so the page starts with the right words and tabs
 * instead of learning the switch from the feed seconds later. No inline script: the policy forbids it.
 */
const marked = new Map<string, { mtimeMs: number; body: Buffer }>();
export function markedPage(file: string, scoreOn: boolean): Buffer {
  const mtimeMs = statSync(file).mtimeMs;
  const key = `${file}|${scoreOn}`;
  const had = marked.get(key);
  if (had && had.mtimeMs === mtimeMs) return had.body;
  const html = readFileSync(file, "utf8");
  const body = Buffer.from(scoreOn ? html.replace(/<html(\s|>)/i, '<html data-score="on"$1') : html);
  marked.set(key, { mtimeMs, body });
  return body;
}

/** Answer a GET or HEAD for a file of the built site. Returns false when there is no such file (the caller says 404). */
export function serveStatic(req: IncomingMessage, res: ServerResponse, pathname: string, root: string, scoreOn?: boolean): boolean {
  const file = resolveStatic(pathname, root);
  if (!file) return false;
  if (scoreOn !== undefined && file === join(resolve(root), "index.html")) {
    const body = markedPage(file, scoreOn);
    res.writeHead(200, { "content-type": TYPES[".html"] ?? "text/html; charset=utf-8", "cache-control": "no-cache", "content-length": String(body.length) });
    res.end(req.method === "HEAD" ? undefined : body);
    return true;
  }
  const size = statSync(file).size;
  const type = TYPES[extname(file).toLowerCase()] ?? "application/octet-stream";
  const range = parseRange(req.headers.range, size);
  const common = { "content-type": type, "cache-control": cacheControlFor(pathname, new URL(req.url ?? "/", "http://local").search), "accept-ranges": "bytes" };
  if (range === "bad") {
    res.writeHead(416, { ...common, "content-range": `bytes */${size}` });
    res.end();
    return true;
  }
  const head = range ? { ...common, "content-range": `bytes ${range.start}-${range.end}/${size}`, "content-length": String(range.end - range.start + 1) } : { ...common, "content-length": String(size) };
  res.writeHead(range ? 206 : 200, head);
  if (req.method === "HEAD") res.end();
  else createReadStream(file, range ?? undefined).pipe(res);
  return true;
}

/** What the page never reads is not sent to the public: the providers' counters and the workers' and desk's stats stay on the server. */
export function publicSnapshot(body: string): string {
  const o = JSON.parse(body) as Record<string, unknown>;
  for (const k of ["quotes", "pumpfun", "pool", "tape", "vampDesk", "images"]) delete o[k];
  return JSON.stringify(o);
}

export const isLoopback = (addr: string | undefined): boolean => !!addr && (addr === "127.0.0.1" || addr === "::1" || addr === "::ffff:127.0.0.1");
