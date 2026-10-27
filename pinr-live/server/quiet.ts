import { readFileSync } from "node:fs";
import type { WireToken } from "./translate.ts";

/**
 * a coin whose last trade is more than 24 hours old goes quiet. It leaves every list and tile (the first page, the rest, the streams) and is found
 * only by its contract address, which opens its page as usual (nothing is deleted: 232). It comes back on its next trade. Only a trade time the server KNOWS counts
 * (`lastTradeMs`): a coin with no trade time is never taken off the lists on a guess (missing stays missing). the engine's own "quiet" mark, when it posts one, joins here.
 */
export const QUIET_AFTER_MS = 24 * 60 * 60 * 1000;

/**
 * the engine's own mark (`frontend-feed/_quiet.json`, "quiet-1": the engine found no trade in 24 hours on DexScreener's pairs and the tape): the mints it lists. The file is
 * written whole every 2 minutes; one whose `as_of` is older than this is not trusted (a coin that trades again drops out of the file, so a stale file would hide
 * it wrongly), and no file, a bad one or a wrong contract is no marks at all.
 */
export const QUIET_FILE_FRESH_MS = 15 * 60 * 1000;
export function quietMarks(raw: unknown, nowMs: number = Date.now()): Set<string> {
  const out = new Set<string>();
  if (typeof raw !== "object" || raw === null) return out;
  const d = raw as { contract?: unknown; as_of?: unknown; quiet?: unknown };
  if (d.contract !== "quiet-1" || typeof d.quiet !== "object" || d.quiet === null || Array.isArray(d.quiet)) return out;
  const at = typeof d.as_of === "string" ? Date.parse(d.as_of) : NaN;
  if (!Number.isFinite(at) || nowMs - at > QUIET_FILE_FRESH_MS || at - nowMs > 5 * 60 * 1000) return out;
  for (const k of Object.keys(d.quiet as Record<string, unknown>)) if (/^[0-9a-zA-Z]{20,64}$/.test(k)) out.add(k.toLowerCase());
  return out;
}
/** The marks read from the file, at most every 20 seconds (the file is written every 2 minutes). */
export function quietReader(path: string, readMs: number = 20_000): (nowMs?: number) => Set<string> {
  let at = 0;
  let marks = new Set<string>();
  return (nowMs = Date.now()) => {
    if (nowMs - at < readMs) return marks;
    at = nowMs;
    try {
      marks = quietMarks(JSON.parse(readFileSync(path, "utf8")), nowMs);
    } catch {
      marks = new Set();
    }
    return marks;
  };
}

export function isQuiet(t: Pick<WireToken, "lastTradeMs"> & { address?: string }, nowMs: number = Date.now(), marks?: ReadonlySet<string>): boolean {
  if (marks && typeof t.address === "string" && marks.has(t.address.toLowerCase())) return true;
  const last = t.lastTradeMs;
  return typeof last === "number" && Number.isFinite(last) && last > 0 && nowMs - last > QUIET_AFTER_MS;
}

/** The tokens to list and the quiet ones set apart (each marked `quiet`, for the address lookup). */
export function splitQuiet<T extends Pick<WireToken, "lastTradeMs"> & { address?: string }>(tokens: readonly T[], nowMs: number = Date.now(), marks?: ReadonlySet<string>): { shown: T[]; quiet: (T & { quiet: true })[] } {
  const shown: T[] = [];
  const quiet: (T & { quiet: true })[] = [];
  for (const t of tokens) {
    if (isQuiet(t, nowMs, marks)) quiet.push({ ...t, quiet: true });
    else shown.push(t);
  }
  return { shown, quiet };
}
