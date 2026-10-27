import { describe, expect, it } from "vitest";
import sharp from "sharp";
import { dHash, fetchPicture, hamming, isBlandHash, isPrivateAddress, NEAR, PictureHashes, type ImageGet } from "./imagehash.ts";

async function picture(seed: number, size = 120, tweak = 0): Promise<Uint8Array> {
  // a made-up gradient-and-blocks picture so the hash has structure
  const w = size, h = size;
  const px = Buffer.alloc(w * h * 3);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = (y * w + x) * 3;
    const v = (((x * seed) % 255) + (y > h / 2 ? 90 : 0) + (x > w / 3 && x < w / 2 ? 70 : 0) + tweak) % 255;
    px[i] = v; px[i + 1] = (v * 2) % 255; px[i + 2] = 255 - v;
  }
  return new Uint8Array(await sharp(px, { raw: { width: w, height: h, channels: 3 } }).png().toBuffer());
}

describe("picture hashes", () => {
  it("keeps a picture the same when it is resized or re-encoded, and tells a different one apart", async () => {
    const a = await picture(3);
    const small = new Uint8Array(await sharp(a).resize(48, 48).jpeg({ quality: 60 }).toBuffer());
    const other = await picture(11);
    const ha = (await dHash(a))!, hs = (await dHash(small))!, ho = (await dHash(other))!;
    expect(hamming(ha, hs)).toBeLessThanOrEqual(NEAR);
    expect(hamming(ha, ho)).toBeGreaterThan(NEAR);
    expect(ha).toMatch(/^[0-9a-f]{16}$/);
  });
  it("gives nothing for bytes that are not a picture, and calls a one-tone picture bland", async () => {
    expect(await dHash(new Uint8Array([1, 2, 3]))).toBeNull();
    const flat = new Uint8Array(await sharp({ create: { width: 30, height: 30, channels: 3, background: "#808080" } }).png().toBuffer());
    expect(isBlandHash((await dHash(flat))!)).toBe(true);
  });
});

describe("fetching pictures safely", () => {
  const ok = async (h: string): Promise<boolean> => !h.startsWith("internal");
  const png = (): ImageGet => async () => ({ status: 200, location: null, type: "image/png", bytes: async () => new Uint8Array([1]) });
  it("refuses plain http, private addresses and non-pictures", async () => {
    expect(await fetchPicture("http://x.example/a.png", png(), ok)).toBeNull();
    expect(await fetchPicture("https://internal.example/a.png", png(), ok)).toBeNull();
    expect(await fetchPicture("https://x.example/a", async () => ({ status: 200, location: null, type: "text/html", bytes: async () => new Uint8Array() }), ok)).toBeNull();
    expect(await fetchPicture("https://x.example/a.png", png(), ok)).not.toBeNull();
  });
  it("checks every redirect hop, so a redirect into a private network is refused", async () => {
    const get: ImageGet = async (u) => (u.includes("start") ? { status: 302, location: "https://internal.example/secret", type: null, bytes: async () => new Uint8Array() } : { status: 200, location: null, type: "image/png", bytes: async () => new Uint8Array([1]) });
    expect(await fetchPicture("https://x.example/start", get, ok)).toBeNull();
    const loop: ImageGet = async () => ({ status: 302, location: "https://x.example/again", type: null, bytes: async () => new Uint8Array() });
    expect(await fetchPicture("https://x.example/start", loop, ok)).toBeNull();
  });
  it("knows private address ranges", () => {
    for (const a of ["127.0.0.1", "10.1.2.3", "192.168.0.9", "172.20.0.1", "169.254.169.254", "::1", "fd00::1"]) expect(isPrivateAddress(a)).toBe(true);
    for (const a of ["8.8.8.8", "104.18.0.1"]) expect(isPrivateAddress(a)).toBe(false);
  });
  it("remembers a hash and does not ask again, and retries a failed picture only after a while", async () => {
    let now = 0;
    const store = new PictureHashes(() => now);
    const get: ImageGet = async () => ({ status: 200, location: null, type: "image/png", bytes: async () => picture(5) });
    const h = await store.learn("https://x.example/ipfs-a.png", get, ok);
    expect(h).toMatch(/^[0-9a-f]{16}$/);
    expect(store.wants("https://x.example/ipfs-a.png")).toBe(false);
    await store.learn("https://bad.example/b.png", async () => ({ status: 404, location: null, type: null, bytes: async () => new Uint8Array() }), ok);
    expect(store.wants("https://bad.example/b.png")).toBe(false);
    now += 31 * 60_000;
    expect(store.wants("https://bad.example/b.png")).toBe(true);
  });
});
