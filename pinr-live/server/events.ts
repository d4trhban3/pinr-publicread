import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DROP_DIR } from "./feed.ts";

/**
 * Chart events: dated moments from the engine that a chart can pin on the price line (a score move, a flag, a surge).
 * One file per token in `frontend-feed/events/<address>.json`. The engine decides WHAT happened and WHEN; this only reads, cleans and passes it on.
 * Nothing here carries reasons, weights or inputs: an event is a date, a kind and a short plain sentence.
 */
export type EventKind = "score_up" | "score_down" | "flag_raised" | "flag_cleared" | "surge" | "verified" | "note";
export type EventTone = "good" | "bad" | "neutral";

export interface ChartEvent {
  /** seconds since 1970 */
  t: number;
  kind: EventKind;
  tone: EventTone;
  /** a short plain sentence, at most 60 characters */
  text: string;
  /** score before and after, for score events only (0 to 100) */
  from?: number;
  to?: number;
}

const KINDS: EventKind[] = ["score_up", "score_down", "flag_raised", "flag_cleared", "surge", "verified", "note"];
const DEFAULT_TONE: Record<EventKind, EventTone> = {
  score_up: "good",
  score_down: "bad",
  flag_raised: "bad",
  flag_cleared: "good",
  surge: "neutral",
  verified: "good",
  note: "neutral",
};
const MAX_EVENTS = 200;
const MAX_TEXT = 60;

const isKind = (k: unknown): k is EventKind => typeof k === "string" && (KINDS as string[]).includes(k);
const isTone = (k: unknown): k is EventTone => k === "good" || k === "bad" || k === "neutral";
const score = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 100 ? Math.round(v) : undefined);

/** Turn a file's content into safe events: bad rows are dropped one by one, never guessed at. */
export function cleanEvents(raw: unknown): ChartEvent[] {
  if (typeof raw !== "object" || raw === null) return [];
  const doc = raw as { contract?: unknown; events?: unknown };
  if (typeof doc.contract !== "string" || !doc.contract.startsWith("1.")) return [];
  if (!Array.isArray(doc.events)) return [];
  const out: ChartEvent[] = [];
  for (const e of doc.events) {
    if (typeof e !== "object" || e === null) continue;
    const r = e as Record<string, unknown>;
    if (typeof r.t !== "number" || !Number.isFinite(r.t) || r.t <= 0 || !isKind(r.kind)) continue;
    const text = typeof r.text === "string" ? r.text.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, MAX_TEXT) : "";
    const ev: ChartEvent = { t: Math.floor(r.t), kind: r.kind, tone: isTone(r.tone) ? r.tone : DEFAULT_TONE[r.kind], text };
    if (r.kind === "score_up" || r.kind === "score_down") {
      const from = score(r.from);
      const to = score(r.to);
      if (from !== undefined) ev.from = from;
      if (to !== undefined) ev.to = to;
    }
    out.push(ev);
  }
  out.sort((a, b) => a.t - b.t);
  return out.slice(-MAX_EVENTS);
}

/** The events for one token, or [] when it has no file (missing stays missing). */
export function readEvents(address: string, dir = join(DROP_DIR, "events")): ChartEvent[] {
  if (!/^[0-9a-zA-Z]{20,64}$/.test(address)) return [];
  const file = join(dir, `${address}.json`);
  if (!existsSync(file)) return [];
  try {
    return cleanEvents(JSON.parse(readFileSync(file, "utf8")));
  } catch {
    return [];
  }
}
