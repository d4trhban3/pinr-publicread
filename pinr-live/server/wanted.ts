import { readFileSync, renameSync, writeFileSync } from "node:fs";

/**
 * The site's own wanted list: the coins somebody opened or searched on pinr.io,
 * so the engine reads PINRbot's judgement for them first. One file the engine only reads, `index/pinrbot-wanted-site.json`, shaped
 * `{ "<mint>": <unix seconds> }`. This server is its only writer (the hand list, `pinrbot-wanted.json`, is the engine's), so no lock is needed.
 *
 * Rules: the engine's folder must already exist (the site never creates it); a valid Solana mint only, taken from a request for a coin the feed knows; written whole to a temporary file and renamed (a reader never
 * sees half a file); at most one write a second; entries older than a day dropped; at most 2000 entries (the oldest go first). A write that fails
 * is counted and forgotten: it never fails a request, and nothing is invented. Nothing here is a score or a figure.
 */
export const MAX_ENTRIES = 2000;
export const KEEP_S = 86_400;
export const WRITE_GAP_MS = 1000;
/** Per visitor: at most this many different coins an hour reach the list, so one script cannot steer what PINRbot reads first. */
export const VISITOR_COINS_PER_HOUR = 30;
const VISITOR_WINDOW_MS = 3_600_000;
const MAX_VISITORS = 5000;
const MINT = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export class Wanted {
  private map = new Map<string, number>();
  private visitors = new Map<string, { since: number; mints: Set<string> }>();
  private dirty = false;
  private lastWriteMs = 0;
  writes = 0;
  failures = 0;

  /** `path` null: switched off (nothing is written). The file's own earlier entries are loaded once, so a restart keeps the day's list. */
  constructor(
    private path: string | null,
    private now: () => number = Date.now,
  ) {
    if (!path) return;
    try {
      const raw: unknown = JSON.parse(readFileSync(path, "utf8"));
      if (typeof raw === "object" && raw !== null && !Array.isArray(raw)) {
        for (const [m, t] of Object.entries(raw as Record<string, unknown>)) if (MINT.test(m) && typeof t === "number" && Number.isFinite(t) && t > 0) this.map.set(m, Math.floor(t));
        this.prune();
      }
    } catch {
      /* no file yet, or unreadable: start empty */
    }
  }

  get size(): number {
    return this.map.size;
  }

  /**
   * May this visitor add this coin now? A coin the visitor already added this hour costs nothing more; a visitor past the hour's limit is
   * ignored (the request itself is still answered). The visitor is held in memory only, never written or logged.
   */
  private allowed(visitor: string, mint: string): boolean {
    const t = this.now();
    let v = this.visitors.get(visitor);
    if (!v || t - v.since >= VISITOR_WINDOW_MS) {
      if (!v && this.visitors.size >= MAX_VISITORS) {
        for (const [k, x] of this.visitors) if (t - x.since >= VISITOR_WINDOW_MS) this.visitors.delete(k);
        if (this.visitors.size >= MAX_VISITORS) this.visitors.clear();
      }
      v = { since: t, mints: new Set() };
      this.visitors.set(visitor, v);
    }
    if (v.mints.has(mint)) return true;
    if (v.mints.size >= VISITOR_COINS_PER_HOUR) return false;
    v.mints.add(mint);
    return true;
  }

  /** Somebody opened this coin. A malformed address is ignored; a valid one is written within a second, unless this visitor is past its hour's limit. */
  add(mint: string, visitor = "local"): void {
    if (!this.path || !MINT.test(mint) || !this.allowed(visitor, mint)) return;
    this.map.set(mint, Math.floor(this.now() / 1000));
    this.dirty = true;
    this.flush();
  }

  private prune(): void {
    const from = Math.floor(this.now() / 1000) - KEEP_S;
    for (const [m, t] of this.map) if (t < from) this.map.delete(m);
    if (this.map.size > MAX_ENTRIES) {
      const keep = [...this.map].sort((a, b) => b[1] - a[1]).slice(0, MAX_ENTRIES);
      this.map = new Map(keep);
    }
  }

  /** Write the list if it changed and a second has passed since the last write. Safe to call often. */
  flush(): void {
    const t = this.now();
    if (!this.path || !this.dirty || t - this.lastWriteMs < WRITE_GAP_MS) return;
    this.prune();
    this.lastWriteMs = t;
    const tmp = `${this.path}.tmp`;
    try {
      writeFileSync(tmp, JSON.stringify(Object.fromEntries(this.map)));
      renameSync(tmp, this.path);
      this.dirty = false;
      this.writes++;
    } catch {
      this.failures++; // try again at the next flush
    }
  }
}
