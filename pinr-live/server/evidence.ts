import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DROP_DIR } from "./feed.ts";

/**
 * The per-coin evidence file (a design decision step 4; the engine's `evidence/1`): `frontend-feed/evidence/<mint>.json`, written whole by the scanner from
 * its evidence table. One row per fact: what links to what, what it is, its value, when it happened, when PINR first and last read it, the public
 * source, a link to see it, and whether it was read on chain (● true) or reported (○ false). This only reads, cleans and passes it on:
 * bad rows are dropped one by one, never guessed at; a link is kept only if it is https; times are milliseconds; nothing here is a verdict.
 */
export type Plain = string | number | boolean;
export interface EvidenceRow {
  from: { kind: string; id: string };
  to: { kind: string; id: string };
  what: string;
  /** A plain value, or a small record of plain values (a holding's amount and labels, a market pair's figures); null when none. */
  value: Plain | Record<string, Plain> | null;
  unit: string | null;
  /** When the fact happened, when PINR first read it and when it last read it (ms since 1970), null when not stated. */
  atMs: number | null;
  firstReadMs: number | null;
  readMs: number | null;
  source: string | null;
  link: string | null;
  onchain: boolean;
}
/** What the gate read at launch: observed words, never a verdict. the engine's `gate` section of the evidence file. */
export interface GateCoin {
  coin: string;
  launchedAtMs: number | null;
  link: string | null;
}
export type GateItem =
  | { kind: "earlier_lookalike"; words: string; same: "name and ticker" | "picture" | null; coin: string | null; launchedAtMs: number | null; link: string | null; creator: string | null; creatorLink: string | null }
  | { kind: "same_creator_relaunch"; words: string; same: string[]; coins: GateCoin[] }
  | { kind: "serial_launcher"; words: string; launchCount: number | null }
  /** the creator launched many coins in quick succession around this one (serial-launcher evidence) */
  | { kind: "fast_launcher"; words: string; count: number | null; coins: GateCoin[] }
  /** a launch by a known volume or MEV bot, or obvious bot trading, with the wallets and the free label source behind each */
  | { kind: "bot_launch"; words: string; wallets: { id: string; link: string | null; label: string | null; source: string | null }[] }
  | { kind: "not_read_yet"; words: string };
export interface Gate {
  /** "bot" : a bot launch, never listed; a search by its address shows this section */
  status: "passed" | "held" | "bot" | "not read yet";
  words: string[];
  items: GateItem[];
  creator: { id: string | null; link: string | null; launchCount: number | null; otherCoins: GateCoin[] } | null;
  launchedAtMs: number | null;
  source: "Jupiter" | null;
  readMs: number | null;
}
/** PINRai's reading of the developer's intent (a design decision; the engine's `pinrai` section): each item in the engine's fixed observed words, with the receipts it stands on. Never the model's text, never a cost. */
export interface PinraiReceipt {
  source: string | null;
  value: Plain | null;
  link: string | null;
  asOfMs: number | null;
  onchain: boolean;
}
export interface PinraiItem {
  kind: string;
  words: string;
  reviewed: boolean;
  receipts: PinraiReceipt[];
}
export interface Pinrai {
  status: "read" | "off" | "not read yet";
  readMs: number | null;
  items: PinraiItem[];
}
export interface Evidence {
  contract: "evidence/1";
  asOfMs: number | null;
  rows: EvidenceRow[];
  /** The gate's result for the coin (absent when it was never read for the gate). */
  gate?: Gate;
  /** PINRai's reading (absent when the coin has none). */
  pinrai?: Pinrai;
  /** Why no funding is traced, in observed words, when the engine did not trace it; added by the server from the dossier, never part of the file. */
  fundingNote?: string;
}

/** a developer hidden behind a mass launcher and a brand-new fee wallet is not identified, so the funding is not traced. The words say what was observed. */
export const FUNDING_NOT_TRACED = "Funding not traced: the launcher is a mass launcher and the fee wallet is brand new.";

export const MAX_ROWS = 400;
/** The public names a row's source may carry: anything else is not a source and shows as none. */
export const SOURCES: readonly string[] = ["Solana chain", "Pump.fun", "DexScreener", "GeckoTerminal", "Jupiter", "X", "launchpad record", "Base chain", "BNB chain", "GoPlus"];
const clean = (v: unknown, max: number): string | null => {
  if (typeof v !== "string") return null;
  const s = v.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, max);
  return s === "" ? null : s;
};
const plain = (v: unknown): Plain | null => {
  if (typeof v === "string") return clean(v, 200);
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  return typeof v === "boolean" ? v : null;
};
function value(v: unknown): EvidenceRow["value"] {
  const p = plain(v);
  if (p !== null) return p;
  if (typeof v !== "object" || v === null || Array.isArray(v)) return null;
  const o: Record<string, Plain> = {};
  for (const [k, x] of Object.entries(v as Record<string, unknown>).slice(0, 8)) {
    // a short list of words (what a Virtuals owner can do) is kept as one line; any other list or nesting is dropped
    const words = Array.isArray(x) && x.length && x.every((y) => typeof y === "string") ? clean(x.slice(0, 8).join("; "), 400) : null;
    const px = plain(x) ?? words;
    if (px !== null && /^[a-z_0-9]{1,32}$/i.test(k)) o[k] = px;
  }
  return Object.keys(o).length ? o : null;
}
/** An ISO time (or seconds since 1970) as milliseconds; null when it is neither. */
function time(v: unknown): number | null {
  const ms = typeof v === "number" ? (v < 1e12 ? v * 1000 : v) : typeof v === "string" ? Date.parse(v) : NaN;
  return Number.isFinite(ms) && ms > 0 ? Math.floor(ms) : null;
}
function https(v: unknown): string | null {
  const s = clean(v, 500);
  if (!s) return null;
  try {
    const u = new URL(s);
    return u.protocol === "https:" && !u.username && !u.password ? u.href : null;
  } catch {
    return null;
  }
}
function end(v: unknown): { kind: string; id: string } | null {
  if (typeof v !== "object" || v === null) return null;
  const e = v as Record<string, unknown>;
  const kind = clean(e.kind, 24);
  const id = clean(e.id, 300);
  return kind && id ? { kind, id } : null;
}

const ADDR = /^[1-9A-HJ-NP-Za-km-z]{32,44}$|^0x[0-9a-fA-F]{40}$/; // a Solana address or an EVM one (Base, BNB Chain)
const addr = (v: unknown): string | null => (typeof v === "string" && ADDR.test(v) ? v : null);
const count = (v: unknown): number | null => (typeof v === "number" && Number.isInteger(v) && v >= 0 && v < 1e7 ? v : null);
function gateCoin(v: unknown): GateCoin | null {
  if (typeof v !== "object" || v === null) return null;
  const c = v as Record<string, unknown>;
  const coin = addr(c.coin);
  return coin ? { coin, launchedAtMs: time(c.launched_at), link: https(c.link) } : null;
}
const coins = (v: unknown): GateCoin[] => (Array.isArray(v) ? v.map(gateCoin).filter((c): c is GateCoin => c !== null).slice(0, 10) : []);

/** The gate section, cleaned: a bad item is dropped alone; null when it is not a gate section at all. */
export function cleanGate(raw: unknown): Gate | null {
  if (typeof raw !== "object" || raw === null) return null;
  const g = raw as Record<string, unknown>;
  const status = g.status === "passed" || g.status === "held" || g.status === "bot" || g.status === "not read yet" ? g.status : null;
  if (!status) return null;
  const words = (Array.isArray(g.words) ? g.words : []).map((w) => clean(w, 200)).filter((w): w is string => w !== null).slice(0, 8);
  const items: GateItem[] = [];
  for (const it of Array.isArray(g.items) ? g.items.slice(0, 12) : []) {
    if (typeof it !== "object" || it === null) continue;
    const x = it as Record<string, unknown>;
    const w = clean(x.words, 200);
    if (!w) continue;
    if (x.kind === "earlier_lookalike") items.push({ kind: "earlier_lookalike", words: w, same: x.same === "name and ticker" || x.same === "picture" ? x.same : null, coin: addr(x.coin), launchedAtMs: time(x.launched_at), link: https(x.link), creator: addr(x.creator), creatorLink: https(x.creator_link) });
    else if (x.kind === "same_creator_relaunch") items.push({ kind: "same_creator_relaunch", words: w, same: (Array.isArray(x.same) ? x.same : []).filter((n): n is string => n === "name" || n === "ticker" || n === "picture"), coins: coins(x.coins) });
    else if (x.kind === "serial_launcher") items.push({ kind: "serial_launcher", words: w, launchCount: count(x.launch_count) });
    else if (x.kind === "fast_launcher") items.push({ kind: "fast_launcher", words: w, count: count(x.count), coins: coins(x.coins) });
    else if (x.kind === "bot_launch") {
      const wallets = (Array.isArray(x.wallets) ? x.wallets.slice(0, 12) : []).flatMap((v) => {
        const o = typeof v === "object" && v !== null ? (v as Record<string, unknown>) : {};
        const id = addr(o.id);
        return id ? [{ id, link: https(o.link), label: clean(o.label, 60), source: clean(o.source, 60) }] : [];
      });
      items.push({ kind: "bot_launch", words: w, wallets });
    } else if (x.kind === "not_read_yet") items.push({ kind: "not_read_yet", words: w });
  }
  const c = typeof g.creator === "object" && g.creator !== null ? (g.creator as Record<string, unknown>) : null;
  return {
    status,
    words,
    items,
    creator: c ? { id: addr(c.id), link: https(c.link), launchCount: count(c.launch_count), otherCoins: coins(c.other_coins) } : null,
    launchedAtMs: time(g.launched_at),
    source: g.source === "Jupiter" ? "Jupiter" : null,
    readMs: time(g.read),
  };
}

/** The pinrai section, cleaned: a bad item or receipt is dropped alone; null when it is not a pinrai section at all. */
export function cleanPinrai(raw: unknown): Pinrai | null {
  if (typeof raw !== "object" || raw === null) return null;
  const p = raw as Record<string, unknown>;
  const status = p.status === "read" || p.status === "off" || p.status === "not read yet" ? p.status : null;
  if (!status) return null;
  const items: PinraiItem[] = [];
  for (const it of Array.isArray(p.items) ? p.items.slice(0, 12) : []) {
    if (typeof it !== "object" || it === null) continue;
    const x = it as Record<string, unknown>;
    const kind = clean(x.kind, 60);
    const words = clean(x.words, 200);
    if (!kind || !words) continue;
    const receipts: PinraiReceipt[] = [];
    for (const r of Array.isArray(x.receipts) ? x.receipts.slice(0, 8) : []) {
      if (typeof r !== "object" || r === null) continue;
      const y = r as Record<string, unknown>;
      const source = SOURCES.includes(y.source as string) ? (y.source as string) : null;
      const value = plain(y.value);
      const link = https(y.link);
      if (source === null && value === null && link === null) continue;
      receipts.push({ source, value, link, asOfMs: time(y.as_of), onchain: y.onchain === true || y.onchain === 1 });
    }
    items.push({ kind, words, reviewed: x.reviewed === true, receipts });
  }
  // the public reading is the fixed words and their receipts only; the model, and what was set aside or is
  // waiting, stay on /control.
  return { status, readMs: time(p.read_at), items };
}

/** Turn a file's content into safe rows; null when it is not an `evidence/1` file for this coin. */
export function cleanEvidence(raw: unknown, mint: string): Evidence | null {
  if (typeof raw !== "object" || raw === null) return null;
  const doc = raw as { contract?: unknown; mint?: unknown; as_of?: unknown; rows?: unknown };
  if (typeof doc.contract !== "string" || !doc.contract.startsWith("evidence/1")) return null;
  const same = typeof doc.mint === "string" && (doc.mint === mint || (mint.startsWith("0x") && doc.mint.toLowerCase() === mint.toLowerCase()));
  if (!same || !Array.isArray(doc.rows)) return null;
  const rows: EvidenceRow[] = [];
  for (const r of doc.rows) {
    if (rows.length >= MAX_ROWS) break;
    if (typeof r !== "object" || r === null) continue;
    const x = r as Record<string, unknown>;
    const from = end(x.from);
    const to = end(x.to);
    const what = clean(x.what, 120);
    if (!from || !to || !what) continue;
    rows.push({
      from,
      to,
      what,
      value: value(x.value),
      unit: clean(x.unit, 24),
      atMs: time(x.at),
      firstReadMs: time(x.first_read),
      readMs: time(x.read),
      source: SOURCES.includes(x.source as string) ? (x.source as string) : null,
      link: https(x.link),
      onchain: x.onchain === true || x.onchain === 1,
    });
  }
  const gate = cleanGate((raw as { gate?: unknown }).gate);
  const pinrai = cleanPinrai((raw as { pinrai?: unknown }).pinrai);
  return { contract: "evidence/1", asOfMs: time(doc.as_of), rows, ...(gate ? { gate } : {}), ...(pinrai ? { pinrai } : {}) };
}

/** The evidence for one coin, or null when it has no file (missing stays missing). */
export function readEvidence(address: string, dir = join(DROP_DIR, "evidence")): Evidence | null {
  if (!/^[0-9a-zA-Z]{20,64}$/.test(address)) return null;
  const file = join(dir, `${address}.json`);
  if (!existsSync(file)) return null;
  try {
    return cleanEvidence(JSON.parse(readFileSync(file, "utf8")), address);
  } catch {
    return null;
  }
}
