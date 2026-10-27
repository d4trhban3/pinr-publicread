import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import sharp from "sharp";
import { ImageCache } from "./imgcache.ts";
import { pictureSources, type ImageGet } from "./imagehash.ts";

describe("picture sources", () => {
  it("tries the other public IPFS gateways first, since the same file is on all of them", () => {
    const s = pictureSources("https://ipfs.io/ipfs/bafkreibt4os5hm4zusoqluqcbrgqv6ombskfwu3abc");
    expect(s[0]).toContain("pump.mypinata.cloud");
    expect(s[s.length - 1]).toContain("ipfs.io");
    expect(s.every((u) => u.endsWith("bafkreibt4os5hm4zusoqluqcbrgqv6ombskfwu3abc"))).toBe(true);
    expect(pictureSources("https://x.example/a.png")).toEqual(["https://x.example/a.png"]);
  });
});

describe("ImageCache", () => {
  const ok = async (): Promise<boolean> => true;
  it("fetches a picture once, shrinks it, and serves it from disk after that", async () => {
    const big = new Uint8Array(await sharp({ create: { width: 800, height: 500, channels: 3, background: "#3366cc" } }).png().toBuffer());
    let calls = 0;
    const get: ImageGet = async () => (calls++, { status: 200, location: null, type: "image/png", bytes: async () => big });
    const cache = new ImageCache(mkdtempSync(join(tmpdir(), "img-")), get, ok);
    const a = (await cache.picture("https://x.example/a.png"))!;
    const meta = await sharp(a).metadata();
    expect([meta.width, meta.height, meta.format]).toEqual([160, 160, "webp"]);
    await cache.picture("https://x.example/a.png");
    expect(calls).toBe(1);
  });
  it("remembers a picture it could not get and does not hammer the source", async () => {
    let calls = 0;
    const get: ImageGet = async () => (calls++, { status: 429, location: null, type: "text/plain", bytes: async () => new Uint8Array() });
    let now = 0;
    const cache = new ImageCache(mkdtempSync(join(tmpdir(), "img-")), get, ok, () => now);
    expect(await cache.picture("https://x.example/b.png")).toBeNull();
    const before = calls;
    expect(await cache.picture("https://x.example/b.png")).toBeNull();
    expect(calls).toBe(before);
    now += 11 * 60_000;
    await cache.picture("https://x.example/b.png");
    expect(calls).toBeGreaterThan(before);
  });
  it("never serves an SVG", async () => {
    const get: ImageGet = async () => ({ status: 200, location: null, type: "image/svg+xml", bytes: async () => new TextEncoder().encode("<svg onload='x'/>") });
    const cache = new ImageCache(mkdtempSync(join(tmpdir(), "img-")), get, ok);
    expect(await cache.picture("https://x.example/c.svg")).toBeNull();
  });
});
