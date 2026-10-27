import { readFileSync } from "node:fs";

/**
 * The public daily PINRbot budget meter. The engine writes `frontend-feed/_pinrbot-budget.json`
 * (`{ day, used_pct, status, as_of }`, the leading "_" keeps the feed reader from taking it for a coin). Only a percentage and whether the bot is
 * running ever leave: never a dollar figure. A file that is missing, from another day, old or malformed gives nothing (missing stays missing).
 */
export interface BudgetMeter {
  status: "on" | "off";
  /** 0 to 100, whole percent */
  usedPct: number;
  asOfMs: number;
}
/** A reading older than this is not shown (the engine rewrites it at each score). */
export const MAX_AGE_MS = 6 * 3_600_000;

export function readBudget(path: string, nowMs: number = Date.now()): BudgetMeter | null {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
  if (typeof raw !== "object" || raw === null) return null;
  const o = raw as Record<string, unknown>;
  const status = o.status === "on" || o.status === "off" ? o.status : null;
  const pct = typeof o.used_pct === "number" && Number.isFinite(o.used_pct) && o.used_pct >= 0 && o.used_pct <= 100 ? Math.round(o.used_pct) : null;
  const asOf = typeof o.as_of === "string" ? Date.parse(o.as_of) : NaN;
  const today = new Date(nowMs).toISOString().slice(0, 10);
  if (!status || pct === null || !Number.isFinite(asOf) || o.day !== today || nowMs - asOf > MAX_AGE_MS || asOf - nowMs > 3_600_000) return null;
  return { status, usedPct: status === "off" ? 0 : pct, asOfMs: asOf };
}
