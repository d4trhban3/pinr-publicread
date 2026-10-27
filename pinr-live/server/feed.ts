import { readdirSync, readFileSync, statSync, existsSync, watch, writeFileSync, mkdirSync, renameSync } from "node:fs";
import { delimiter, dirname, join, resolve } from "node:path";
import { CONTRACT_VERSION, translate, type Problem, type WireToken } from "./translate.ts";
import { byFirstPage, firstPageKey } from "./firstpage.ts";

/**
 * Reads the engine's result files and hands back tile-ready tokens. Read-only: it never writes, and it never reads
 * anything but *.json result files (no .env, no keys).
 *
 * Folders, in priority order (the first folder that has a token wins):
 *   1. the DROP FOLDER the PINR development side writes its live output to  (mode "feed")
 *   2. the gate runs already on disk, replayed, ONLY while the drop folder has no coin files (mode "replay"; the contract, point 4)
 * Override with PINR_FEED_DIRS (folders separated like PATH).
 */
const REPO = resolve(import.meta.dirname, "..", "..");
const HANDOFF = join(REPO, "engine");
/** D4: `PINR_DROP_DIR` points the whole feed (coin files, evidence, quiet marks, ticks) at another folder, e.g. the sample one `npm run sample:drop` writes. */
export const DROP_DIR = process.env.PINR_DROP_DIR ? resolve(process.env.PINR_DROP_DIR) : join(HANDOFF, "frontend-feed");
const REPLAY_DIRS = [join(HANDOFF, "gate3", "results"), join(HANDOFF, "gate4", "results_before_linked")];

export interface FileProblem {
  file: string;
  problems: Problem[];
}

/**
 * The first page: the scored tokens passed on in full with every poll (chart, trades, live notes). The rest of the scored set is
 * paged separately in lite form (`/api/tokens/rest`), so no scored token is left out and a phone is not sent thousands at once.
 */
export const MAX_TOKENS = 300;
/** At most this often the list is rebuilt for files that changed (a full pass rebuilds at once), once the folder is big enough for a rebuild to cost. */
export const REBUILD_EVERY_MS = 15_000;
export const REBUILD_LIMIT_FROM = 5000;

/** How long a coin counts as just seen or just scored. */
export const RECENT_MS = 24 * 3600_000;

/** When a coin was seen (a seen file) or last scored (a scored file's `as_of`), ms; null when the file does not say. */
export function recentAt(t: Pick<WireToken, "seen" | "seenAtMs" | "asOfMs">): number | null {
  return t.seen ? (t.seenAtMs ?? t.asOfMs ?? null) : (t.asOfMs ?? null);
}

/** the facts the first page orders a coin by (scored coins by score time; unscored ones by when PINR met them, else their launch). */
export function firstPageFactsOf(t: Pick<WireToken, "score" | "seen" | "seenAtMs" | "asOfMs" | "scoredAtMs" | "launchedAtMs">): { scored: boolean; scoredAtMs: number | null; newAtMs: number | null } {
  const scored = typeof t.score === "number";
  return { scored, scoredAtMs: scored && !t.seen ? (t.scoredAtMs ?? t.asOfMs ?? null) : null, newAtMs: scored ? null : (t.seen ? (t.seenAtMs ?? t.asOfMs ?? null) : null) ?? t.launchedAtMs ?? null };
}

/**
 * The roster's order. First every coin scored in the last 24 hours, newest-scored first; then every unscored coin met in the
 * last 24 hours, newest first; then the
 * engine's own `roster_rank` (lowest first), then bigger valuation, then address, so the order never wobbles. The first MAX_TOKENS
 * are the first page; the others are `rest`, in the same order.
 */
export function orderRoster(tokens: WireToken[], max = MAX_TOKENS, nowMs = Date.now()): { tokens: WireToken[]; rest: WireToken[]; cut: number } {
  // Each coin's sort facts are worked out once, not on every comparison (a sort of 56,000 coins makes about a million).
  const rows = tokens.map((t) => ({ t, k: firstPageKey(firstPageFactsOf(t), nowMs), rank: t.rank ?? Infinity, val: t.valuationUsd ?? -1, a: t.address }));
  rows.sort((x, y) => byFirstPage(x.k, y.k) || x.rank - y.rank || y.val - x.val || (x.a < y.a ? -1 : x.a > y.a ? 1 : 0));
  const sorted = rows.map((r) => r.t);
  return { tokens: sorted.slice(0, max), rest: sorted.slice(max), cut: Math.max(0, sorted.length - max) };
}

/** Let the server answer its requests: the next turn of the event loop. */
const breathe = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));
/** How many items one turn works on before it breathes (a slice of this is a few milliseconds even on the server). */
export const STEP = 3000;

/**
 * `rows.sort(cmp)` in turns: slices of STEP sorted one at a time, then merged two at a time, breathing between turns, so a sort of 67,000 coins never holds the
 * server up (DEBUG, 26 Oct: the assembly blocked its loop 650 ms at the median on the server). The result is the same order as one sort (a stable merge).
 */
export async function steppedSort<T>(rows: T[], cmp: (a: T, b: T) => number): Promise<T[]> {
  let runs: T[][] = [];
  for (let i = 0; i < rows.length; i += STEP) {
    runs.push(rows.slice(i, i + STEP).sort(cmp));
    await breathe();
  }
  while (runs.length > 1) {
    const next: T[][] = [];
    for (let r = 0; r < runs.length; r += 2) {
      const a = runs[r]!;
      const b = runs[r + 1];
      if (!b) {
        next.push(a);
        continue;
      }
      const out: T[] = [];
      let i = 0;
      let j = 0;
      while (i < a.length || j < b.length) {
        const stop = out.length + STEP * 2;
        while ((i < a.length || j < b.length) && out.length < stop) out.push(j >= b.length || (i < a.length && cmp(a[i]!, b[j]!) <= 0) ? a[i++]! : b[j++]!);
        if (i < a.length || j < b.length) await breathe();
      }
      next.push(out);
    }
    runs = next;
  }
  return runs[0] ?? [];
}

/** `orderRoster` in turns (the same answer; see steppedSort). */
export async function orderRosterStepped(tokens: WireToken[], max = MAX_TOKENS, nowMs = Date.now()): Promise<{ tokens: WireToken[]; rest: WireToken[]; cut: number }> {
  const rows: { t: WireToken; k: ReturnType<typeof firstPageKey>; rank: number; val: number; a: string }[] = [];
  for (let i = 0; i < tokens.length; i += STEP) {
    for (const t of tokens.slice(i, i + STEP)) rows.push({ t, k: firstPageKey(firstPageFactsOf(t), nowMs), rank: t.rank ?? Infinity, val: t.valuationUsd ?? -1, a: t.address });
    await breathe();
  }
  const sorted = (await steppedSort(rows, (x, y) => byFirstPage(x.k, y.k) || x.rank - y.rank || y.val - x.val || (x.a < y.a ? -1 : x.a > y.a ? 1 : 0))).map((r) => r.t);
  return { tokens: sorted.slice(0, max), rest: sorted.slice(max), cut: Math.max(0, sorted.length - max) };
}

export interface FeedSnapshot {
  contract: string;
  /** "feed" when the drop folder has results; "replay" when only the saved gate runs do; "empty" when there is nothing. */
  mode: "feed" | "replay" | "empty";
  /** Newest file time, ms. */
  asOfMs: number | null;
  files: number;
  tokens: WireToken[];
  /** The scored tokens after the first page, in roster order (served in lite form by /api/tokens/rest). */
  rest: WireToken[];
  /** How many tokens are in `rest`. */
  cut: number;
  problems: FileProblem[];
}

export function feedDirs(env: Record<string, string | undefined> = process.env): { dir: string; feed: boolean }[] {
  const custom = env.PINR_FEED_DIRS;
  if (custom) return custom.split(delimiter).filter(Boolean).map((d, i) => ({ dir: resolve(d), feed: i === 0 }));
  // A drop folder of its own (sample data) is read alone: the gate runs on disk are not mixed in.
  if (env.PINR_DROP_DIR) return [{ dir: resolve(env.PINR_DROP_DIR), feed: true }];
  // The contract (point 4): the saved gate runs are replayed only until the drop folder has files. Once it has, they are left out, so their
  // old lab scores (October's Base/BNB runs, DATA and CHAINS 2026-10-25) never sit beside the live ones.
  return hasCoinFiles(DROP_DIR) ? [{ dir: DROP_DIR, feed: true }] : [{ dir: DROP_DIR, feed: true }, ...REPLAY_DIRS.map((dir) => ({ dir, feed: false }))];
}

/** True when the folder holds at least one coin file (a .json that is not one of the engine's own `_` files). Stops at the first. */
export function hasCoinFiles(dir: string): boolean {
  try {
    for (const name of readdirSync(dir)) if (name.endsWith(".json") && !name.startsWith("_")) return true;
  } catch {
    /* no folder: no files */
  }
  return false;
}

export function loadFeed(dirs = feedDirs()): FeedSnapshot {
  const byAddr = new Map<string, WireToken>();
  const problems: FileProblem[] = [];
  let files = 0;
  let asOfMs: number | null = null;
  let anyFeed = false;
  let anyReplay = false;
  for (const { dir, feed } of dirs) {
    if (!existsSync(dir)) continue;
    for (const name of readdirSync(dir).sort()) {
      if (!name.endsWith(".json") || name.startsWith("_") || name === "trigger-seen.json") continue; // trigger-seen.json is the scanner's queue record (contract), not a coin file
      const path = join(dir, name);
      let raw: unknown;
      try {
        const st = statSync(path);
        if (!st.isFile()) continue;
        files++;
        asOfMs = Math.max(asOfMs ?? 0, st.mtimeMs);
        raw = JSON.parse(readFileSync(path, "utf8"));
      } catch (e) {
        problems.push({ file: name, problems: [{ severity: "error", field: "(file)", message: `could not be read as JSON: ${(e as Error).message}` }] });
        continue;
      }
      const t = translate(raw);
      if (t.problems.length) problems.push({ file: name, problems: t.problems });
      if (!t.token) continue;
      const key = t.token.address.toLowerCase();
      if (byAddr.has(key)) continue; // an earlier (higher-priority) folder already has it
      byAddr.set(key, t.token);
      if (feed) anyFeed = true;
      else anyReplay = true;
    }
  }
  const roster = orderRoster([...byAddr.values()]);
  return {
    contract: CONTRACT_VERSION,
    mode: anyFeed ? "feed" : anyReplay ? "replay" : "empty",
    asOfMs,
    files,
    tokens: roster.tokens,
    rest: roster.rest,
    cut: roster.cut,
    problems,
  };
}

/** One coin file as read: its stamp (time and size), and the token or the problems it gave. */
interface FileEntry {
  mtimeMs: number;
  size: number;
  token: WireToken | null;
  problems: Problem[] | null;
  /** set when the file could not be read as JSON */
  unreadable?: string;
  /** the coin's developer wallet (its `launcher` fact), noted while the file is parsed anyway; null when the file names none */
  launcher?: string | null;
}
const WALLET = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
/** A feed file's `launcher` fact, or null. */
export function launcherFact(raw: unknown): string | null {
  const facts = typeof raw === "object" && raw !== null ? (raw as { facts?: unknown }).facts : undefined;
  const f = Array.isArray(facts) ? (facts as Record<string, unknown>[]).find((x) => x && x.id === "launcher") : undefined;
  return f && typeof f.value === "string" && WALLET.test(f.value) ? f.value : null;
}
const isCoinFile = (name: string): boolean => name.endsWith(".json") && !name.startsWith("_") && name !== "trigger-seen.json";

/** A folder watch: calls back with a changed file name (null when the system could not say which), returns a function that stops it. */
export type FolderWatch = (dir: string, changed: (name: string | null) => void) => () => void;
const nodeWatch: FolderWatch = (dir, changed) => {
  const w = watch(dir, { persistent: false }, (_ev, name) => changed(typeof name === "string" ? name : null));
  w.on("error", () => changed(null));
  return () => w.close();
};
/** A full stat-and-compare pass over every folder this often, so a change the watch missed is never lost for long. */
export const FULL_PASS_MS = 10 * 60_000;

/**
 * The feed server's reader. \`loadFeed\` reads and parses every file each time: about 240 ms for 10,102 files on
 * the Mac and several seconds for 24,000 on the server, all of it blocking the server. This keeps each file's parsed token by name with its time
 * and size. A folder watch marks the names that change (the engine writes a temporary file and renames it over the coin's file); a read then
 * re-reads only those. Every FULL_PASS_MS, at the start, and whenever the watch cannot say which file changed, every file is stat-ed and only the
 * ones whose time or size differ are parsed again. With nothing changed, the last snapshot is given back as it is (its roster is re-ordered once
 * a minute, as the 24-hour window moves). The result is the same as \`loadFeed\` over the same files.
 */
export class FeedReader {
  private files = new Map<string, Map<string, FileEntry>>();
  private dirty = new Map<string, Set<string>>();
  private needFull = true;
  private lastFull = 0;
  private stops: (() => void)[] = [];
  private last: FeedSnapshot | null = null;
  private lastAt = 0;
  /** Each coin's developer wallet, noted when its file is parsed: the copy groups ask for thousands of these, and reading each coin's file again
   *  for it was the 125 s first plan on the server (2026-10-25). Undefined: the file has not been read. */
  private launchers = new Map<string, string | null>();
  launcherOf(addrLower: string): string | null | undefined {
    return this.launchers.get(addrLower);
  }
  /** files changed since the last rebuild (held back on a big folder until REBUILD_EVERY_MS has passed) */
  private pending = false;
  stat = { reads: 0, fullPasses: 0, parsed: 0, lastMs: 0 };

  constructor(
    private dirs = feedDirs(),
    private now: () => number = Date.now,
    watcher: FolderWatch | null = nodeWatch,
  ) {
    for (const { dir } of dirs) {
      this.files.set(dir, new Map());
      this.dirty.set(dir, new Set());
      if (!watcher || !existsSync(dir)) continue;
      try {
        this.stops.push(
          watcher(dir, (name) => {
            if (name === null) this.needFull = true;
            else if (isCoinFile(name)) this.dirty.get(dir)!.add(name);
          }),
        );
      } catch {
        this.needFull = true; // no watch: the full pass carries it
      }
    }
  }

  close(): void {
    for (const s of this.stops) s();
    this.stops = [];
  }

  /**
   * The cold start (2026-10-25: 161 s from a restart to the first answer, the first request parsing all 56,000 files at once).
   * With `warmFrom` set, the first full pass runs in the background in batches, letting requests through between them; until it is done, `read()`
   * gives the first page saved at the last run (`warmFrom`, written at most once a minute), else an empty list. The tests and small folders keep the
   * old way (no `warmFrom`: the first read parses everything at once).
   */
  private warmFrom: string | null = null;
  private warmed = true;
  /** While this answers true after a restart, `read()` gives the saved first page (set by the server). */
  holdWhile: (() => boolean) | null = null;
  private saved: FeedSnapshot | null = null;
  private savedAt = 0;
  startWarm(savedFile: string, batch = 500): void {
    this.warmFrom = savedFile;
    this.warmed = false;
    try {
      const doc = JSON.parse(readFileSync(savedFile, "utf8")) as FeedSnapshot;
      if (doc && Array.isArray(doc.tokens)) this.saved = { ...doc, rest: [], cut: 0, problems: [] };
    } catch {
      /* no saved page yet: an empty list until the first pass is done */
    }
    void (async () => {
      const t0 = performance.now();
      for (const { dir } of this.dirs) {
        if (!existsSync(dir)) continue;
        const map = this.files.get(dir)!;
        const names = readdirSync(dir).filter(isCoinFile);
        for (let i = 0; i < names.length; i += batch) {
          for (const name of names.slice(i, i + batch)) {
            const e = this.readOne(dir, name, map.get(name));
            if (e) map.set(name, e);
          }
          await new Promise((r) => setImmediate(r));
        }
      }
      this.needFull = false;
      this.lastFull = this.now();
      this.stat.fullPasses++;
      this.last = this.assemble();
      this.lastAt = this.now();
      this.warmed = true;
      console.log(`feed: first read of ${this.last.files} files in ${((performance.now() - t0) / 1000).toFixed(1)} s (in the background)`);
    })();
  }

  /** The first page, kept on disk at most once a minute so the next start can show it at once. */
  private saveFirstPage(snap: FeedSnapshot): void {
    if (!this.warmFrom || this.now() - this.savedAt < 60_000) return;
    this.savedAt = this.now();
    try {
      mkdirSync(dirname(this.warmFrom), { recursive: true });
      const tmp = `${this.warmFrom}.tmp`;
      writeFileSync(tmp, JSON.stringify({ ...snap, rest: [], cut: 0, problems: [] }));
      renameSync(tmp, this.warmFrom);
    } catch {
      /* not saved this time */
    }
  }

  /** Read one file into an entry, or null when it is gone or not a file. */
  private readOne(dir: string, name: string, had: FileEntry | undefined): FileEntry | null {
    const path = join(dir, name);
    let st;
    try {
      st = statSync(path);
    } catch {
      return null;
    }
    if (!st.isFile()) return null;
    if (had && had.mtimeMs === st.mtimeMs && had.size === st.size) return had;
    this.stat.parsed++;
    try {
      const raw = JSON.parse(readFileSync(path, "utf8"));
      const t = translate(raw);
      const launcher = launcherFact(raw);
      if (t.token) this.launchers.set(t.token.address.toLowerCase(), launcher);
      return { mtimeMs: st.mtimeMs, size: st.size, token: t.token ?? null, problems: t.problems.length ? t.problems : null, launcher };
    } catch (e) {
      return { mtimeMs: st.mtimeMs, size: st.size, token: null, problems: null, unreadable: (e as Error).message };
    }
  }

  read(): FeedSnapshot {
    const t0 = performance.now();
    this.stat.reads++;
    // After a restart, the saved first page keeps serving while `holdWhile` says the hide rules cannot all be applied yet (the team, 26 Oct: the list grew from 375 to
    // 465 coins for 50 s: the quiet coins are known only once every tick file is read). Never longer than the server's own limit.
    if (!this.warmed || (this.saved && this.holdWhile?.())) return this.saved ?? { contract: CONTRACT_VERSION, mode: "empty", asOfMs: null, files: 0, tokens: [], rest: [], cut: 0, problems: [] };
    const full = this.needFull || this.now() - this.lastFull >= FULL_PASS_MS;
    let changed = full;
    for (const { dir } of this.dirs) {
      const map = this.files.get(dir)!;
      const dirty = this.dirty.get(dir)!;
      if (full) {
        dirty.clear();
        if (!existsSync(dir)) {
          if (map.size) map.clear();
          continue;
        }
        const names = new Set(readdirSync(dir).filter(isCoinFile));
        for (const name of [...map.keys()]) if (!names.has(name)) map.delete(name);
        for (const name of names) {
          const e = this.readOne(dir, name, map.get(name));
          if (e) map.set(name, e);
          else map.delete(name);
        }
      } else if (dirty.size) {
        changed = true;
        for (const name of dirty) {
          const e = this.readOne(dir, name, map.get(name));
          if (e) map.set(name, e);
          else map.delete(name);
        }
        dirty.clear();
      }
    }
    if (full) {
      this.needFull = false;
      this.lastFull = this.now();
      this.stat.fullPasses++;
    }
    // Nothing changed and the roster is less than a minute old: the same snapshot. A file that changed waits for the next rebuild, at most
    // REBUILD_EVERY_MS after the last (a rebuild of 56,000 coins took 341 ms on the server, every 3 s); live prices reach the page by the stream meanwhile.
    if (changed) this.pending = true;
    if (this.last && ((!this.pending && this.now() - this.lastAt < 60_000) || (this.pending && !full && this.heldFiles() > REBUILD_LIMIT_FROM && this.now() - this.lastAt < REBUILD_EVERY_MS))) {
      this.stat.lastMs = performance.now() - t0;
      return this.last;
    }
    // A big folder with a snapshot already serving: the rebuild is made in turns in the background (never one block of hundreds of milliseconds), and the last
    // snapshot stands until it is done. The first snapshot, and small folders, are made at once as before.
    if (this.last && this.heldFiles() > REBUILD_LIMIT_FROM) {
      this.pending = false;
      if (!this.assembling) {
        const nowMs = this.now();
        this.assembling = this.assembleStepped()
          .then((snap) => {
            this.last = snap;
            this.lastAt = nowMs;
            this.saveFirstPage(snap);
          })
          .catch((e: unknown) => {
            this.pending = true; // tried again at the next read
            console.error("feed: a stepped rebuild failed; the last snapshot stays", e);
          })
          .finally(() => {
            this.assembling = null;
          });
      } else this.pending = true; // changes that came while one runs are taken by the next
      this.stat.lastMs = performance.now() - t0;
      return this.last;
    }
    this.last = this.assemble();
    this.lastAt = this.now();
    this.pending = false;
    this.saveFirstPage(this.last);
    this.stat.lastMs = performance.now() - t0;
    return this.last;
  }

  /** A rebuild being made in turns in the background (a big folder); the last snapshot keeps serving until it is done. */
  private assembling: Promise<void> | null = null;

  /** True while a stepped rebuild runs. */
  isAssembling(): boolean {
    return this.assembling !== null;
  }
  /** Wait for a stepped rebuild (tests). */
  async settled(): Promise<void> {
    while (this.assembling) await this.assembling;
  }

  private heldFiles(): number {
    let n = 0;
    for (const m of this.files.values()) n += m.size;
    return n;
  }

  /** A folder's file names in order, sorted again only when the set of names changed (sorting 56,000 names was a good part of each rebuild). */
  private names = new Map<string, { size: number; first: string; last: string; list: string[] }>();
  private sortedNames(dir: string, map: Map<string, FileEntry>): string[] {
    const held = this.names.get(dir);
    if (held && held.size === map.size && held.list.every((n) => map.has(n))) return held.list;
    const list = [...map.keys()].sort();
    this.names.set(dir, { size: map.size, first: list[0] ?? "", last: list[list.length - 1] ?? "", list });
    return list;
  }

  /** The same snapshot as `assemble`, made in turns (STEP files each) so the server answers its requests between them. */
  private async assembleStepped(): Promise<FeedSnapshot> {
    const byAddr = new Map<string, WireToken>();
    const problems: FileProblem[] = [];
    let files = 0;
    let asOfMs: number | null = null;
    let anyFeed = false;
    let anyReplay = false;
    for (const { dir, feed } of this.dirs) {
      const map = this.files.get(dir)!;
      const names = this.sortedNames(dir, map);
      for (let i = 0; i < names.length; i += STEP) {
        for (const name of names.slice(i, i + STEP)) {
          const e = map.get(name);
          if (!e) continue; // gone while the rebuild ran
          files++;
          asOfMs = Math.max(asOfMs ?? 0, e.mtimeMs);
          if (e.unreadable !== undefined) {
            problems.push({ file: name, problems: [{ severity: "error", field: "(file)", message: `could not be read as JSON: ${e.unreadable}` }] });
            continue;
          }
          if (e.problems) problems.push({ file: name, problems: e.problems });
          if (!e.token) continue;
          const key = e.token.address.toLowerCase();
          if (byAddr.has(key)) continue;
          byAddr.set(key, e.token);
          if (feed) anyFeed = true;
          else anyReplay = true;
        }
        await breathe();
      }
    }
    const roster = await orderRosterStepped([...byAddr.values()], MAX_TOKENS, this.now());
    return { contract: CONTRACT_VERSION, mode: anyFeed ? "feed" : anyReplay ? "replay" : "empty", asOfMs, files, tokens: roster.tokens, rest: roster.rest, cut: roster.cut, problems };
  }

  /** The snapshot from the entries held, in the same order and with the same rules as \`loadFeed\`. */
  private assemble(): FeedSnapshot {
    const byAddr = new Map<string, WireToken>();
    const problems: FileProblem[] = [];
    let files = 0;
    let asOfMs: number | null = null;
    let anyFeed = false;
    let anyReplay = false;
    for (const { dir, feed } of this.dirs) {
      const map = this.files.get(dir)!;
      for (const name of this.sortedNames(dir, map)) {
        const e = map.get(name)!;
        files++;
        asOfMs = Math.max(asOfMs ?? 0, e.mtimeMs);
        if (e.unreadable !== undefined) {
          problems.push({ file: name, problems: [{ severity: "error", field: "(file)", message: `could not be read as JSON: ${e.unreadable}` }] });
          continue;
        }
        if (e.problems) problems.push({ file: name, problems: e.problems });
        if (!e.token) continue;
        const key = e.token.address.toLowerCase();
        if (byAddr.has(key)) continue;
        byAddr.set(key, e.token);
        if (feed) anyFeed = true;
        else anyReplay = true;
      }
    }
    const roster = orderRoster([...byAddr.values()], MAX_TOKENS, this.now());
    return { contract: CONTRACT_VERSION, mode: anyFeed ? "feed" : anyReplay ? "replay" : "empty", asOfMs, files, tokens: roster.tokens, rest: roster.rest, cut: roster.cut, problems };
  }
}
