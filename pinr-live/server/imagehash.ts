import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import sharp from "sharp";
import { imageKey } from "./vamp.ts";

/**
 * Picture matching. A copy often is not the same FILE: it is resized, re-encoded, recoloured a little or cropped a hair. A perceptual
 * hash (dHash) turns a picture into 64 bits that barely change under those edits, so two pictures a person would call the same differ
 * in only a few bits (their Hamming distance).
 *
 * The pictures come from addresses that token creators wrote, so fetching them is treated as untrusted: https only, the address must
 * resolve to a public internet address (never this machine or a private network), redirects are followed by hand and checked each hop,
 * the answer must be an image, and it is cut off at a size limit. Hashes are kept on disk (a picture's hash never changes).
 */
export const NEAR = 5; // bits of 64 that may differ and still be "the same picture"
const MAX_BYTES = 4 * 1024 * 1024;
const MAX_HOPS = 3;

/** True for addresses that are not on the public internet. */
export function isPrivateAddress(ip: string): boolean {
  if (isIP(ip) === 4) {
    const [a, b] = ip.split(".").map(Number) as [number, number];
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  const x = ip.toLowerCase();
  return x === "::1" || x === "::" || x.startsWith("fc") || x.startsWith("fd") || x.startsWith("fe80") || x.startsWith("::ffff:") || x.startsWith("ff");
}

export type HostCheck = (host: string) => Promise<boolean>;
const publicHost: HostCheck = async (host) => {
  if (isIP(host)) return !isPrivateAddress(host);
  try {
    const all = await lookup(host, { all: true });
    return all.length > 0 && all.every((a) => !isPrivateAddress(a.address));
  } catch {
    return false;
  }
};

export interface ImageGet {
  (url: string): Promise<{ status: number; location: string | null; type: string | null; bytes: () => Promise<Uint8Array> }>;
}
const defaultGet: ImageGet = async (url) => {
  const r = await fetch(url, { redirect: "manual", headers: { accept: "image/*", "user-agent": "PINR-live/1.0 (read-only market data)" }, signal: AbortSignal.timeout(8000) });
  return {
    status: r.status,
    location: r.headers.get("location"),
    type: r.headers.get("content-type"),
    bytes: async () => {
      const len = Number(r.headers.get("content-length") ?? 0);
      if (len > MAX_BYTES) throw new Error("too big");
      const buf = new Uint8Array(await r.arrayBuffer());
      if (buf.length > MAX_BYTES) throw new Error("too big");
      return buf;
    },
  };
};

/** Download a picture safely. Null when it cannot be fetched or is not a picture. */
export async function fetchPicture(url: string, get: ImageGet = defaultGet, ok: HostCheck = publicHost): Promise<Uint8Array | null> {
  let cur = url;
  for (let hop = 0; hop <= MAX_HOPS; hop++) {
    let u: URL;
    try {
      u = new URL(cur);
    } catch {
      return null;
    }
    if (u.protocol !== "https:" || !(await ok(u.hostname))) return null;
    let r;
    try {
      r = await get(u.toString());
    } catch {
      return null;
    }
    if (r.status >= 300 && r.status < 400 && r.location) {
      cur = new URL(r.location, u).toString();
      continue;
    }
    const type = (r.type ?? "").toLowerCase();
    if (r.status !== 200 || !type.startsWith("image/") || type.includes("svg")) return null; // a picture, never an SVG (those can carry scripts and links)
    try {
      return await r.bytes();
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * Where to get a picture from. An IPFS picture is the same bytes on every gateway (its address IS its content), and the main public
 * gateway, ipfs.io, turns most visitors away with "too many requests", so the others are tried first.
 */
export function pictureSources(url: string): string[] {
  const m = /^https:\/\/[^/]+\/ipfs\/([A-Za-z0-9]{20,}(?:\/[^?#]*)?)/.exec(url);
  if (!m) return [url];
  return [`https://pump.mypinata.cloud/ipfs/${m[1]}`, `https://dweb.link/ipfs/${m[1]}`, `https://ipfs.io/ipfs/${m[1]}`];
}

/** fetchPicture over every place the picture can come from; the first that answers wins. */
export async function fetchPictureAny(url: string, get?: ImageGet, ok?: HostCheck): Promise<Uint8Array | null> {
  for (const u of pictureSources(url)) {
    const b = await fetchPicture(u, get, ok);
    if (b) return b;
  }
  return null;
}

/** The 64-bit difference hash of a picture as 16 hex characters, or null when it cannot be read. */
export async function dHash(bytes: Uint8Array): Promise<string | null> {
  try {
    const raw = await sharp(bytes, { limitInputPixels: 40_000_000 }).flatten({ background: "#ffffff" }).greyscale().resize(9, 8, { fit: "fill" }).raw().toBuffer();
    let bits = 0n;
    for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) bits = (bits << 1n) | (raw[y * 9 + x]! > raw[y * 9 + x + 1]! ? 1n : 0n);
    return bits.toString(16).padStart(16, "0");
  } catch {
    return null;
  }
}

export function hamming(a: string, b: string): number {
  let x = BigInt(`0x${a}`) ^ BigInt(`0x${b}`);
  let n = 0;
  while (x) {
    n += Number(x & 1n);
    x >>= 1n;
  }
  return n;
}

/** A picture so plain (all one tone) that its hash would match countless others: it carries no evidence. */
export function isBlandHash(h: string): boolean {
  return /^0{16}$/.test(h) || /^f{16}$/i.test(h);
}

/** Hashes remembered by picture identity (never recomputed), plus pictures that could not be read (tried again later). */
export class PictureHashes {
  private hashes = new Map<string, string>();
  private failed = new Map<string, number>();
  private dirty = false;
  stat = { fetched: 0, failed: 0 };

  constructor(private now: () => number = Date.now) {}

  get(key: string): string | undefined {
    return this.hashes.get(key);
  }
  get size(): number {
    return this.hashes.size;
  }
  /** True when this picture should be fetched now (no hash yet, and not failed in the last 30 minutes). */
  wants(key: string): boolean {
    if (this.hashes.has(key)) return false;
    const f = this.failed.get(key);
    return f === undefined || this.now() - f > 30 * 60_000;
  }

  async learn(url: string, get?: ImageGet, ok?: HostCheck): Promise<string | null> {
    const key = imageKey(url);
    if (!key) return null;
    const bytes = await fetchPictureAny(url, get, ok);
    const h = bytes ? await dHash(bytes) : null;
    if (h) {
      this.hashes.set(key, h);
      this.dirty = true;
      this.stat.fetched++;
    } else {
      this.failed.set(key, this.now());
      this.stat.failed++;
    }
    return h;
  }

  saveTo(file: string): void {
    if (!this.dirty) return;
    this.dirty = false;
    try {
      mkdirSync(dirname(file), { recursive: true });
      const tmp = `${file}.tmp`;
      writeFileSync(tmp, JSON.stringify({ v: 1, hashes: [...this.hashes] }));
      renameSync(tmp, file);
    } catch {
      /* a failed save only means the pictures are looked at again */
    }
  }
  loadFrom(file: string): number {
    try {
      if (!existsSync(file)) return 0;
      const doc = JSON.parse(readFileSync(file, "utf8")) as { v?: number; hashes?: [string, string][] };
      if (doc.v !== 1 || !Array.isArray(doc.hashes)) return 0;
      for (const [k, h] of doc.hashes) if (typeof k === "string" && /^[0-9a-f]{16}$/.test(h)) this.hashes.set(k, h);
      return this.hashes.size;
    } catch {
      return 0;
    }
  }
}
