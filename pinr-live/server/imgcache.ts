import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import sharp from "sharp";
import { fetchPictureAny, type HostCheck, type ImageGet } from "./imagehash.ts";

/**
 * Token pictures, served by us. A token's picture lives on an address its creator chose (often a public IPFS gateway that refuses most
 * visitors). The app server fetches each picture once, safely (see imagehash.ts), shrinks it to a small square, keeps it on disk, and the
 * app asks THIS server for it. So tiles fill in reliably and fast, and the viewer's phone never talks to a stranger's server.
 */
const SIZE = 160;
const MISS_MS = 10 * 60_000;

export class ImageCache {
  private misses = new Map<string, number>();
  private inflight = new Map<string, Promise<Buffer | null>>();
  private running = 0;
  stat = { served: 0, fetched: 0, missed: 0 };

  constructor(
    private dir: string,
    private get?: ImageGet,
    private ok?: HostCheck,
    private now: () => number = Date.now,
  ) {
    mkdirSync(dir, { recursive: true });
  }

  private file(url: string): string {
    return join(this.dir, `${createHash("sha1").update(url).digest("hex")}.webp`);
  }

  /** The small picture for a source address, or null when it cannot be had (tried again after ten minutes). */
  async picture(url: string): Promise<Buffer | null> {
    const f = this.file(url);
    if (existsSync(f)) {
      this.stat.served++;
      return readFileSync(f);
    }
    const missed = this.misses.get(url);
    if (missed !== undefined && this.now() - missed < MISS_MS) return null;
    const waiting = this.inflight.get(url);
    if (waiting) return waiting;
    // wait for a free place (a screen asks for dozens at once); give up after a while and let the app ask again
    const until = this.now() + 25_000;
    while (this.running >= 4) {
      if (this.now() > until) return null;
      await new Promise((r) => setTimeout(r, 120));
      const again = this.inflight.get(url);
      if (again) return again;
      if (existsSync(f)) return readFileSync(f);
    }
    this.running++;
    const job = (async (): Promise<Buffer | null> => {
      try {
        const bytes = await fetchPictureAny(url, this.get, this.ok);
        if (!bytes) throw new Error("no picture");
        const out = await sharp(bytes, { limitInputPixels: 40_000_000 }).resize(SIZE, SIZE, { fit: "cover" }).webp({ quality: 80 }).toBuffer();
        writeFileSync(f, out);
        this.stat.fetched++;
        this.stat.served++;
        return out;
      } catch {
        this.misses.set(url, this.now());
        this.stat.missed++;
        return null;
      } finally {
        this.running--;
        this.inflight.delete(url);
      }
    })();
    this.inflight.set(url, job);
    return job;
  }
}
