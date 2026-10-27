/**
 * PINRbot's reading, as DeepScan's "Intent" section shows it.
 *
 * The engine's result file carries `pinrbot` when the bot has read the coin. Only what a reader may see leaves the server, in the words
 * `pinrbot/V1-PROPOSAL.md` section 5 accepted: the kind in plain words, and each receipt's what / source / time / value, with a
 * link only where the source is a post address (https) or names a transaction. NOT the model's free note (it reads the creator's text and is not
 * an approved sentence; the team's F1). Never `dropped`, `cost_usd`, `model`, `calibration_version`, the review's reasons or anything with points.
 * Missing stays missing: no reading, an "off" or "not read" status, or no kept item gives nothing (the page shows no section, or says no evidence).
 */

export interface IntentReceipt {
  what: string;
  source: string;
  readAtMs?: number;
  /** the receipt's value as text (it can quote the coin's own words or a post): the page sets it as text, never as HTML */
  value?: string;
  /** true when PINR read it from the chain itself */
  onChain: boolean;
  link?: string;
}
export interface IntentItem {
  kind: string;
  label: string;
  /** the stronger model's review called it supported; false is shown as "not reviewed yet"  */
  reviewed: boolean;
  receipts: IntentReceipt[];
}
export interface IntentView {
  /** true when the reading is an earlier one kept until the coin is read again ("kept reading of ...") */
  kept: boolean;
  readAtMs?: number;
  /** empty: PINRbot read the coin and has no evidence ("No evidence found") */
  items: IntentItem[];
}

/** the design's kinds in plain words. Anything else is ignored. */
export const INTENT_KINDS: Record<string, { label: string }> = {
  deleted_posts_after_dump: { label: "Posts deleted after a dump" },
  misleading_claim: { label: "A misleading claim" },
  words_contradict_actions: { label: "Words that contradict actions" },
  fake_partnership: { label: "A partnership that is not real" },
  impersonation: { label: "Impersonation of another project" },
  fake_audit: { label: "An audit that is not real" },
  confirmed_drainer: { label: "A confirmed wallet drainer" },
  coordinated_manipulation: { label: "Wallets acting together" },
  vesting_lock: { label: "A vesting lock" },
  fees_to_project_wallet_spent: { label: "Fees paid to the project wallet and spent on it" },
  preannounced_sells_match: { label: "Sells announced in advance, then made as announced" },
  gradual_selling: { label: "Gradual selling by the developer" },
  survived_30d: { label: "Survived 30 days" },
};

const clean = (v: unknown, max: number): string | null => {
  if (typeof v !== "string") return null;
  // eslint-disable-next-line no-control-regex
  const t = v.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
  return t ? (t.length > max ? `${t.slice(0, max - 1)}…` : t) : null;
};

const httpsOnly = (v: string): string | null => {
  try {
    const u = new URL(v);
    return u.protocol === "https:" && !u.username && !u.password && u.hostname.includes(".") && u.href.length <= 220 ? u.href : null;
  } catch {
    return null;
  }
};

/** A receipt's link: a post address (https) as it is, or the explorer page of a named transaction signature. Nothing else gets one. */
export function receiptLink(source: string): string | undefined {
  if (/^https?:\/\//i.test(source)) return httpsOnly(source) ?? undefined;
  const m = /^(?:tx|CREATE tx|Pump\.fun creation transaction)\s*:?\s*([1-9A-HJ-NP-Za-km-z]{64,90})$/.exec(source);
  return m ? `https://solscan.io/tx/${m[1]}` : undefined;
}

const ADDRESS = /^(0x[0-9a-fA-F]{40}|[1-9A-HJ-NP-Za-km-z]{32,44})$/;
const shortAddr = (a: string): string => (a.length > 14 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a);
const plainNumber = (n: number): string =>
  Math.abs(n) >= 1e9 ? `${(n / 1e9).toFixed(1)}B` : Math.abs(n) >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : Math.abs(n) >= 1e3 ? `${(n / 1e3).toFixed(1)}K` : n.toLocaleString("en-US", { maximumSignificantDigits: 4 });
/** The engine's field names in a receipt's record, in words (anything else: its name with spaces). */
const FIELD_WORDS: Record<string, (v: string) => string> = {
  members: (v) => `${v} ${v === "1" ? "wallet" : "wallets"}`,
  acquired: (v) => `${v} tokens acquired`,
  half_out_after_s: (v) => `half sent on after ${v} s`,
};
/**
 * A receipt's value in plain words (checklist 7 and 13: no raw engine notes on the page). The engine sometimes sends a record as JSON text: a list of
 * wallets with a word each becomes "N wallets: <word>"; any other record becomes "<words> · <words>"; braces, quotes and field names never show.
 */
export function plainValue(v: unknown): string | null {
  if (typeof v === "number") return Number.isFinite(v) ? String(v) : null;
  const text = clean(v, 2000);
  if (!text) return null;
  if (!/^[[{]/.test(text)) return text.length > 240 ? `${text.slice(0, 239)}…` : text;
  let o: unknown;
  try {
    o = JSON.parse(text);
  } catch {
    return null; // broken record text: shown as nothing, never as code
  }
  if (Array.isArray(o)) {
    const words = o.filter((x): x is string | number => typeof x === "string" || typeof x === "number").map((x) => (typeof x === "string" && ADDRESS.test(x) ? shortAddr(x) : String(x)));
    return words.length ? clean(words.slice(0, 8).join(", "), 240) : null;
  }
  if (typeof o !== "object" || o === null) return null;
  const entries = Object.entries(o as Record<string, unknown>);
  if (entries.length && entries.every(([k, x]) => ADDRESS.test(k) && typeof x === "string")) {
    const count = new Map<string, number>();
    for (const [, x] of entries) count.set(x as string, (count.get(x as string) ?? 0) + 1);
    return clean([...count].map(([w, n]) => `${n} ${n === 1 ? "wallet" : "wallets"}: ${w}`).join("; "), 240);
  }
  const parts: string[] = [];
  for (const [k, x] of entries.slice(0, 6)) {
    const val = typeof x === "number" && Number.isFinite(x) ? plainNumber(x) : typeof x === "string" ? (ADDRESS.test(x) ? shortAddr(x) : clean(x, 60)) : typeof x === "boolean" ? (x ? "yes" : "no") : null;
    if (val === null) continue; // missing stays missing
    parts.push(FIELD_WORDS[k] ? FIELD_WORDS[k]!(val) : `${k.replace(/_/g, " ")} ${val}`);
  }
  return parts.length ? clean(parts.join(" · "), 240) : null;
}
/** A receipt's source as a reader sees it: a chain read named by its method (getTokenAccountsByOwner, ...) is "Solana chain". */
export function plainSource(source: string): string {
  return /\bget[A-Z][A-Za-z]+\b/.test(source) ? "Solana chain" : source;
}

function receiptsOf(v: unknown): IntentReceipt[] {
  if (!Array.isArray(v)) return [];
  const out: IntentReceipt[] = [];
  for (const r of v.slice(0, 12)) {
    if (typeof r !== "object" || r === null) continue;
    const o = r as Record<string, unknown>;
    // the operator's "soften all five": the engine's "dev conduct" is "developer activity" on the page
    const what = clean(o.what, 120)?.replace(/^dev conduct\b/i, "developer activity") ?? null;
    const rawSource = clean(o.source, 160);
    if (!what || !rawSource) continue; // a receipt with no name or no source is not shown
    const at = typeof o.as_of === "string" ? Date.parse(o.as_of) : typeof o.as_of === "number" && Number.isFinite(o.as_of) ? (o.as_of < 1e11 ? o.as_of * 1000 : o.as_of) : NaN;
    const value = plainValue(o.value);
    const link = receiptLink(rawSource);
    const source = plainSource(rawSource);
    out.push({ what, source, ...(Number.isFinite(at) ? { readAtMs: at } : {}), ...(value ? { value } : {}), onChain: o.on_chain === true, ...(link ? { link } : {}) });
  }
  return out;
}

/** The view of a result file's `pinrbot`, or null when there is nothing to show (off, not read, absent, or malformed). */
export function intentFrom(result: unknown): IntentView | null {
  const r = typeof result === "object" && result !== null ? (result as Record<string, unknown>).pinrbot : undefined;
  if (typeof r !== "object" || r === null) return null;
  const p = r as Record<string, unknown>;
  const status = typeof p.status === "string" ? p.status : "";
  const kept = status.startsWith("kept reading of");
  if (status !== "read" && !kept) return null;
  const supported = new Set<string>();
  const rev = typeof p.review === "object" && p.review !== null ? (p.review as Record<string, unknown>).verdicts : undefined;
  if (Array.isArray(rev)) {
    for (const v of rev) {
      const o = typeof v === "object" && v !== null ? (v as Record<string, unknown>) : null;
      if (o && o.verdict === "supported" && typeof o.kind === "string") supported.add(o.kind);
    }
  }
  // every finding is shown at once with its evidence. Findings the review has not run on (the result's `pending`, or an item the
  // review has not called supported) are shown too, marked "not reviewed yet". The model's own note (`why`) is not part of the evidence and is not carried.
  const items: IntentItem[] = [];
  const take = (list: unknown, held: boolean): void => {
    for (const it of Array.isArray(list) ? list.slice(0, 20) : []) {
      if (typeof it !== "object" || it === null) continue;
      const o = it as Record<string, unknown>;
      const kind = typeof o.kind === "string" ? INTENT_KINDS[o.kind] : undefined;
      if (!kind || items.some((x) => x.label === kind.label)) continue;
      items.push({ kind: o.kind as string, label: kind.label, reviewed: !held && (supported.has(o.kind as string) || o.reviewed === true), receipts: receiptsOf(o.receipts) });
    }
  };
  take(p.items, false);
  take(p.pending, true);
  const at = typeof p.read_at === "string" ? Date.parse(p.read_at) : NaN;
  return { kept, ...(Number.isFinite(at) ? { readAtMs: at } : {}), items };
}
