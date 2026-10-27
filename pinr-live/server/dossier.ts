import type { PoolEvents, PoolRow } from "./poolevents.ts";
import { existsSync, readFileSync } from "node:fs";
import { delimiter, join, resolve } from "node:path";
import { NO_SCORE_LABELS } from "./translate.ts";
import type { Social } from "./social.ts";
import { feeFromFact, feeLong } from "./transferfee.ts";
import { devPayoutsFrom, feeCaseView } from "./feereason.ts";
import { intentFrom, type IntentView } from "./intentview.ts";

/**
 * The DeepScan dossier: the evidence behind a token, cleaned for the phone.
 *
 * The engine's result file holds scoring detail (a 0-100 number per check, flags, notes, receipts). NONE of that leaves the server as is.
 * This is a strict ALLOW-LIST: it builds a new object from a few named things and drops everything else, so a new field the engine adds
 * later can never leak by accident. What is let through:
 *   - public chain facts (status, creator wallet, launch counts)
 *   - the token's own public links (website, X, Telegram), checked and rebuilt
 *   - one word band per check (Strong / Fair / Weak / Clear / Not read), never the number
 *   - a handful of engine sentences, each REWRITTEN to an approved plain sentence (an unknown sentence is dropped, not shown)
 * Never: weights, caps, thresholds, the brake maths, the split of the score, the numbers behind a band, receipts, or reason codes.
 */
/** "Not read" is for a section the rules do not read on this coin (with the reason); "Clear" only for one that was read and found nothing. */
export type Band = "Strong" | "Fair" | "Weak" | "Clear" | "Not read";
/** What a check is said as while the score is off: what was observed, never a judge's band. */
export type ObservedWord = "observed" | "worth a closer look" | "not checked yet";
export interface DossierFact {
  /** the fact's fixed id (contract v1.1) */
  id?: string;
  label: string;
  /** the figure as text; a dash when it has no receipt */
  value: string;
  /** a value the reader can copy (a wallet address) */
  copy?: string;
  /** Its receipt (contract v1.1): the public source, when it was read (ms since 1970) and a link to look. All three, or the fact is a dash with `noSource`. */
  source?: string;
  readAtMs?: number;
  link?: string;
  /** true when the figure has no complete receipt: shown as a dash with the words "no source", never as a number */
  noSource?: boolean;
  /** true when the engine has not read this figure yet (the transfer fee): shown as a dash with the words "not read yet" */
  notRead?: boolean;
  /** links under the figure, after a lead-in: the launches an observed standard was seen on, the dev group's wallets that were paid fees */
  moreLinks?: { lead: string; links: { label: string; url: string }[] };
  /** plain sentences under the figure: which fee case applied and why */
  lines?: string[];
  /** a label beside the figure in the warning style: only "High fee"  */
  badge?: "High fee";
}
/** One place a token can have a presence: what the token lists for it. "unknown" when the engine's file does not carry the token's links at all. */
export interface Channel {
  id: "x" | "telegram" | "website" | "farcaster";
  label: string;
  status: "listed" | "not_listed" | "unknown";
  /** a clean link to the listed place, when there is one */
  url?: string;
  /** set when the link is a post, not the token's own account: the author's handle. It is shown as "a post by @author", never as the token's account. */
  post?: string;
}
export interface Dossier {
  /** false when the engine has no file for this token (the page shows a dash, not a guess) */
  available: boolean;
  facts: DossierFact[];
  checks: { name: string; band: Band | ObservedWord; reason?: string; /** its receipt: all three, or none */ source?: string; readAtMs?: number; link?: string }[];
  read: string[];
  links: { label: string; url: string }[];
  /** where the token says it can be found (X, Telegram, website, Farcaster); what is listed, not a verdict on whether it is real */
  channels: Channel[];
  /** The social scan of the coin ("Social (not scored)"), when one was run; added by the server, never part of the engine's file. */
  /** the coin's pool events, observed on chain (server/poolevents.ts). */
  pool?: PoolEvents;
  /** The pool facts in the coin's evidence file, for a coin with no pool-events file (Base, BNB): shown in the Pool section. */
  poolRows?: PoolRow[];
  social?: Social | null;
  /** PINRbot's reading of the coin: only when it was read; see intentview.ts. */
  intent?: IntentView;
  /** "flagged": a flagged token shows a label and no score, so its check bands are held back too */
  held?: "flagged";
  /** a coin seen, not scored yet: its checks are not read yet, said so on the page */
  seen?: true;
  /** What the launchpad's own record lists for the coin, beside the coin's own links, never replacing them. */
  launchpadLinks?: { source: string; readAtMs: number; links: { label: string; url: string }[] };
}

/** The public names a source may carry (contract v1.1, K1). Anything else is not a source. */
export const SOURCES: readonly string[] = ["Pump.fun", "Clanker", "Bankr", "Flap.sh", "four.meme", "Raydium LaunchLab", "Stonk.fun", "Jupiter", "DexScreener", "CoinGecko", "GeckoTerminal", "Solana chain", "Base chain", "BNB chain"];
/** The ids of the facts the page knows how to show, with the label used when a fact has none, and in the order shown. */
const FACT_IDS: [id: string, fallback: string][] = [
  ["valuation", "Valuation"],
  ["price_usd", "Price"],
  ["market_cap", "Market cap"],
  ["liquidity_usd", "Liquidity"],
  ["volume_24h", "24-hour volume"],
  ["venue", "Trading venue"],
  ["launched_at", "Launched"],
  ["launcher", "Launcher wallet"],
  ["fee_wallet", "Fee wallet"],
  ["dev_wallet", "Wallet scored as the developer"],
  // the funding-source answer (launch item 2), shown with its receipt, never graded.
  ["funding_source", "Dev wallet's funding source"],
  ["dev_launches", "Launches by the launcher"],
  ["fee_wallet_launches", "Launches by the fee wallet"],
  ["duplicate_relaunches", "Duplicate relaunches"],
  // shown with their source and time, never scored. Jupiter's token data first, then Stonk.fun's own records, then DexScreener's promotion.
  ["holder_count", "Holders"],
  ["top_holders_share", "Top holders' share"],
  ["dev_mints", "Coins minted by the dev (Jupiter's count)"],
  ["organic_score", "Organic score"],
  ["jupiter_verified", "Verified on Jupiter"],
  ["buys_24h", "Buys (24 h)"],
  ["sells_24h", "Sells (24 h)"],
  ["traders_24h", "Traders (24 h)"],
  ["mint_authority_jupiter", "Mint authority (Jupiter's audit)"],
  ["freeze_authority_jupiter", "Freeze authority (Jupiter's audit)"],
  ["launchpad_transfer_fee", "Transfer fee (Stonk.fun's record)"],
  ["rewards_paid", "Rewards paid to holders"],
  ["rewards_payouts", "Payouts"],
  ["rewards_wallets_paid", "Wallets paid"],
  ["rewards_last_payout", "Last payout"],
  ["fee_recipients", "Fee recipients"],
  ["fee_share_creator", "Fee share to the creator"],
  ["stonkfun_launches", "Launches by the creator on Stonk.fun"],
  ["dex_paid_orders", "Paid DexScreener orders"],
  ["dex_boosts", "DexScreener boosts"],
];
/** Jupiter's organic-score bands, as Jupiter states them. */
const ORGANIC_BANDS = ["high", "medium", "low"];
/** When a file has no facts at all (scored before v1.1) these are shown as dashes with "no source". */
const DEFAULT_DASHES = ["launcher", "dev_launches", "duplicate_relaunches"];

export const EMPTY: Dossier = { available: false, facts: [], checks: [], read: [], links: [], channels: [] };

/** The checks that may be shown, under plain generic names, in this order. */
const CHECKS: [key: string, name: string][] = [
  ["liquidity_depth", "Liquidity depth"],
  ["liquidity_permanence", "Liquidity lock"],
  ["contract_authorities", "Contract authorities"],
  ["pair_health", "Pair health"],
  ["dev_conduct", "Developer activity"],
  ["creator_holdings", "Creator holdings"],
  ["track_record", "Developer's past coins"],
  ["reward_flow_pressure", "Reward flow"],
  ["top_holders", "Top holders"],
  ["social_link", "Social link"],
];

/** The reasons a section may give for not being read (contract v1.1 `not_read`): fixed public wording, nothing else. */
export const NOT_READ_REASONS: readonly string[] = ["dev not identified", "launch count not stated", "could not be read"];

/** The developer-side sections (the ones a hidden or unread developer leaves without a grade), and the engine's two sentences that say the developer is hidden: used ONLY on an old-format feed file (no `facts`), where there is no `not_read` to read. */
const DEV_HIDDEN = [/^dev hidden behind a launch bot/i, /^this token's CREATE was not paid by the on-chain creator/i];
const DEV_SECTIONS = ["dev_conduct", "creator_holdings", "track_record"];

/** The feed's `not_read`: section key to reason. A reason outside the fixed list is kept as "not read" with no words (never invented ones). */
function notReadFrom(feed: unknown): Map<string, string | undefined> {
  const out = new Map<string, string | undefined>();
  const nr = typeof feed === "object" && feed !== null ? (feed as Record<string, unknown>).not_read : undefined;
  if (typeof nr !== "object" || nr === null) return out;
  for (const [k, v] of Object.entries(nr as Record<string, unknown>)) out.set(k, typeof v === "string" && NOT_READ_REASONS.includes(v) ? v : undefined);
  return out;
}

/** A reading (0 to 100, 100 best, or a word) as a band. A reading that is absent is not shown at all. */
export function bandOf(v: unknown): Band | null {
  if (typeof v === "number" && Number.isFinite(v)) return v >= 70 ? "Strong" : v >= 40 ? "Fair" : "Weak";
  if (v === "no_penalty") return "Clear";
  if (v === "unknown") return "Not read"; // the team: "Not read" in place of "No data" (launch item 7)
  return null;
}

/**
 * Engine sentences that may be shown, each replaced by an approved plain sentence. The engine's own wording names internal rules,
 * vendors and decisions, so it is never passed through: a sentence that matches nothing here is dropped.
 */
const APPROVED: [RegExp, string][] = [
  [/^token tax .*where the tax goes/i, "This token has a transfer tax, and where the tax goes has not been verified yet."],
  [/^dev hidden behind a launch bot/i, "The creator is a contract (a launch service), so the person behind the token cannot be seen on chain."],
  [/^launch count and track record unknown/i, "The developer's launch count and past coins are not read yet."],
  [/^dev group = creator wallet only/i, "The developer's launch count and past coins are not read yet."],
  [/^borrowed post:/i, "The token links a post by a different account than the one the launchpad lists as its launcher."],
  [/^pump-on-poor-liquidity needs/i, "One of the checks needs more price history and has not been judged yet."],
  [/^this token's CREATE was not paid by the on-chain creator/i, "The launch was paid for by a different wallet than the creator (a third-party launch tool may have been used), so the developer's launch count is unknown."],
  [/^only part of the price history could be read/i, "Only part of the price history could be read, so one reading is left unknown."],
  [/^dev relaunched duplicates/i, "This developer has relaunched duplicate tokens."],
  [/^top holders: the rug-circle brake fired/i, "Top holders · a limit applied on who holds this coin; see the score's flags"],
  [/^red flag: linked account has no path back/i, "Worth a closer look: the linked account has no path back to the token."],
];

export function approvedSentences(lines: unknown): string[] {
  if (!Array.isArray(lines)) return [];
  const out: string[] = [];
  for (const l of lines) {
    if (typeof l !== "string") continue;
    const hit = APPROVED.find(([re]) => re.test(l.trim()));
    if (hit && !out.includes(hit[1])) out.push(hit[1]);
  }
  return out;
}

const HANDLE = /^[A-Za-z0-9_]{1,15}$/;
const TG = /^[A-Za-z0-9_]{4,32}$/;

/** Rebuild a link from untrusted token metadata. Only plain https/http web addresses and well-formed handles survive. */
export function cleanLinks(raw: unknown): { label: string; url: string }[] {
  if (typeof raw !== "object" || raw === null) return [];
  const l = raw as Record<string, unknown>;
  const out: { label: string; url: string }[] = [];
  const web = typeof l.website === "string" ? l.website.trim() : "";
  if (web) {
    try {
      const u = new URL(/^https?:\/\//i.test(web) ? web : `https://${web}`);
      if ((u.protocol === "https:" || u.protocol === "http:") && !u.username && !u.password && u.hostname.includes(".") && u.href.length <= 200) out.push({ label: "Website", url: u.href });
    } catch {
      /* not a web address: dropped */
    }
  }
  const handleOf = (v: unknown, hosts: RegExp, ok: RegExp): string | null => {
    if (typeof v !== "string") return null;
    const s = v.trim().replace(/^@/, "");
    if (ok.test(s)) return s;
    try {
      const u = new URL(s);
      const h = u.pathname.split("/").filter(Boolean)[0] ?? "";
      return hosts.test(u.hostname) && ok.test(h) ? h : null;
    } catch {
      return null;
    }
  };
  // The feed's links (contract v1.1) call it `x`; older result files call it `twitter`.
  const post = xPostOf(l.x ?? l.twitter);
  const x = post ? null : handleOf(l.x ?? l.twitter, /^(www\.)?(x|twitter)\.com$/i, HANDLE);
  if (post) out.push({ label: `X post by @${post.author}`, url: post.url });
  else if (x) out.push({ label: "X", url: `https://x.com/${x}` });
  const tg = handleOf(l.telegram, /^(www\.)?t\.me$/i, TG);
  if (tg) out.push({ label: "Telegram", url: `https://t.me/${tg}` });
  return out;
}

/** A link to one post on X (x.com/<author>/status/<id>): the author and a rebuilt link, or null when the value is not a post. */
export function xPostOf(v: unknown): { author: string; url: string } | null {
  if (typeof v !== "string") return null;
  try {
    const u = new URL(v.trim());
    if (!/^(www\.)?(x|twitter)\.com$/i.test(u.hostname) || u.protocol !== "https:") return null;
    const [author, kind, id] = u.pathname.split("/").filter(Boolean);
    return author && HANDLE.test(author) && kind === "status" && id && /^\d{1,25}$/.test(id) ? { author, url: `https://x.com/${author}/status/${id}` } : null;
  } catch {
    return null;
  }
}

const FARCASTER = /^[a-z0-9][a-z0-9_.-]{0,31}$/i;

/**
 * The four places a token can list, from its own links. A result file with no `links` at all (Solana results carry none) gives
 * "unknown" for each: the engine did not read them, which is different from the token listing nothing.
 */
export function channelsFrom(rawLinks: unknown): Channel[] {
  const ids: [Channel["id"], string][] = [["x", "X"], ["telegram", "Telegram"], ["website", "Website"], ["farcaster", "Farcaster"]];
  if (typeof rawLinks !== "object" || rawLinks === null) return ids.map(([id, label]) => ({ id, label, status: "unknown" as const }));
  const clean = cleanLinks(rawLinks);
  const byLabel = new Map(clean.map((l) => [l.label.startsWith("X post") ? "X" : l.label, l.url]));
  const l = rawLinks as Record<string, unknown>;
  const xPost = xPostOf(l.x ?? l.twitter);
  const fc = typeof l.farcaster === "string" ? l.farcaster.trim().replace(/^@/, "") : "";
  if (FARCASTER.test(fc)) byLabel.set("Farcaster", `https://warpcast.com/${fc.toLowerCase()}`);
  return ids.map(([id, label]) => {
    const url = byLabel.get(label);
    if (id === "x" && url && xPost) return { id, label, status: "listed" as const, url, post: xPost.author };
    return url ? { id, label, status: "listed" as const, url } : { id, label, status: "not_listed" as const };
  });
}

const shortAddr = (a: string): string => (a.length > 14 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a);
const isAddress = (a: unknown): a is string => typeof a === "string" && /^[0-9a-zA-Z]{20,64}$/.test(a);


const LABEL_OK = /^[\w .'()\-/]{1,60}$/;
const httpsLink = (v: unknown): string | null => {
  if (typeof v !== "string") return null;
  try {
    const u = new URL(v.trim());
    return u.protocol === "https:" && !u.username && !u.password && u.hostname.includes(".") && u.href.length <= 220 ? u.href : null;
  } catch {
    return null;
  }
};

/** A short plain sentence (the funding-source answer): letters, digits and light punctuation only, no markup. */
function sentenceValue(v: unknown): { text: string; copy?: string } | null {
  const t = typeof v === "string" ? v.trim() : "";
  return /^[\w .,;:'()\-/]{1,140}$/.test(t) ? { text: t } : null;
}

/** The feed's `check_sources` : per check id, the public source, the time read and a link. A receipt missing any of the three is not shown. */
function checkSourcesFrom(feed: unknown): Map<string, { source: string; readAtMs: number; link: string }> {
  const out = new Map<string, { source: string; readAtMs: number; link: string }>();
  const cs = typeof feed === "object" && feed !== null ? (feed as Record<string, unknown>).check_sources : undefined;
  if (typeof cs !== "object" || cs === null || Array.isArray(cs)) return out;
  for (const [key, v] of Object.entries(cs as Record<string, unknown>)) {
    if (typeof v !== "object" || v === null) continue;
    const o = v as Record<string, unknown>;
    const source = typeof o.source === "string" && SOURCES.includes(o.source) ? o.source : null;
    const readAtMs = typeof o.read_at === "string" ? Date.parse(o.read_at) : NaN;
    const link = httpsLink(o.url);
    if (source && Number.isFinite(readAtMs) && link) out.set(key, { source, readAtMs, link });
  }
  return out;
}

/** The public text of one fact's value, by unit. Null when the value cannot be shown honestly. */
function factValue(unit: string, v: unknown, minimum: boolean): { text: string; copy?: string } | null {
  if (unit === "text") return typeof v === "string" && /^[\w .\-/()]{1,40}$/.test(v) ? { text: v } : null;
  if (unit === "wallet") return isAddress(v) ? { text: shortAddr(v), copy: v } : null;
  if (unit === "time") {
    const ms = typeof v === "string" ? Date.parse(v) : NaN;
    return Number.isFinite(ms) ? { text: new Date(ms).toISOString().slice(0, 16).replace("T", " ") + " UTC" } : null;
  }
  if (typeof v !== "number" || !Number.isFinite(v) || v < 0) return null;
  // the design's units: a share in percent, a score out of 100, a rate in basis points (shown as a percent), an amount in a quote coin.
  if (unit === "percent") return v <= 100 ? { text: `${trim(v)}%` } : null;
  if (unit === "of 100") return v <= 100 ? { text: `${Math.round(v)} of 100` } : null;
  if (unit === "basis points") return Number.isInteger(v) && v <= 10_000 ? { text: `${trim(v / 100)}%` } : null;
  if (/^[A-Z][A-Z0-9]{1,5}$/.test(unit) && unit !== "USD") return v < 1e9 ? { text: `${v === 0 ? "0" : v < 1 ? v.toPrecision(3) : trim(v)} ${unit}` } : null;
  if (unit === "USD") return { text: v >= 1000 ? `$${Math.round(v).toLocaleString("en-US")}` : v >= 1 ? `$${v.toFixed(2)}` : v > 0 ? `$${v.toPrecision(3)}` : "$0" };
  if (!Number.isInteger(v) || v >= 1e7) return null;
  return { text: `${v.toLocaleString("en-US")}${minimum ? "+" : ""}` };
}

/** A number with at most two decimals and no trailing zeros. */
const trim = (v: number): string => String(Math.round(v * 100) / 100);

/** The plain line under a decision-197 fact: the organic score's band, the kinds of paid DexScreener orders. None when the field is absent or odd. */
function extraLines(id: string, f: Record<string, unknown>): string[] {
  if (id === "organic_score" && typeof f.band === "string" && ORGANIC_BANDS.includes(f.band)) return [`Jupiter's band: ${f.band}`];
  if (id === "dex_paid_orders" && Array.isArray(f.kinds)) {
    const kinds = [...new Set(f.kinds.filter((k): k is string => typeof k === "string" && /^[A-Za-z][\w-]{0,29}$/.test(k)))].slice(0, 6);
    if (kinds.length) return [`Kinds: ${kinds.join(", ")}`];
  }
  return [];
}

/**
 * The dossier's facts, built from the feed file's `facts` (contract v1.1): each with its source, time read and link. A fact that lacks any of
 * the three, names a source off the fixed list, or has a value that cannot be shown is a dash with "no source". A file with no `facts` shows
 * dashes for the launcher, its launch count and the duplicate relaunches. An id the page does not know is ignored.
 */
export function factsFrom(feed: unknown): DossierFact[] {
  const raw = typeof feed === "object" && feed !== null ? (feed as Record<string, unknown>).facts : undefined;
  if (!Array.isArray(raw)) return [FEE_NOT_READ, ...DEFAULT_DASHES.map((id) => ({ id, label: FACT_IDS.find(([i]) => i === id)![1], value: "—", noSource: true }))];
  const byId = new Map<string, Record<string, unknown>>();
  for (const f of raw) {
    const id = typeof f === "object" && f !== null ? (f as Record<string, unknown>).id : undefined;
    if (typeof id === "string" && !byId.has(id)) byId.set(id, f as Record<string, unknown>); // the first fact of an id wins
  }
  const out: DossierFact[] = [];
  for (const [id, fallback] of FACT_IDS) {
    const f = byId.get(id);
    if (!f) continue;
    const label = typeof f.label === "string" && LABEL_OK.test(f.label.trim()) ? f.label.trim() : fallback;
    const source = typeof f.source === "string" && SOURCES.includes(f.source) ? f.source : null;
    const readAt = typeof f.read_at === "string" ? Date.parse(f.read_at) : NaN;
    const link = httpsLink(f.link);
    // The funding-source answer is a short sentence in the engine's plain words; "not read" carries no link and says so (never a made-up source).
    if (id === "funding_source" && typeof f.value === "string" && /^not read\b/i.test(f.value.trim()) && !f.link) {
      out.push({ id, label, value: "—", notRead: true });
      continue;
    }
    const val = id === "funding_source" ? sentenceValue(f.value) : factValue(typeof f.unit === "string" ? f.unit : "", f.value, f.minimum === true);
    if (!source || !Number.isFinite(readAt) || !link || !val) out.push({ id, label, value: "—", noSource: true });
    else {
      const lines = extraLines(id, f);
      out.push({ id, label, value: val.text, ...(val.copy ? { copy: val.copy } : {}), source, readAtMs: readAt, link, ...(lines.length ? { lines } : {}) });
    }
  }
  const dev = devPayoutsFact(byId.get("fee_dev_payouts"));
  out.unshift(feeFact(byId.get("transfer_fee")), ...(dev ? [dev] : []));
  return out;
}

const FEE_NOT_READ: DossierFact = { id: "transfer_fee", label: "Transfer fee", value: "—", notRead: true };

/**
 * The transfer fee: on every coin, first in the list. Not read yet is said so; a fee or receipt that breaks the contract is a
 * dash with "no source"; otherwise the rate and whose fee it is, in plain words (`transferfee.ts`).
 */
function feeFact(f: Record<string, unknown> | undefined): DossierFact {
  if (!f) return FEE_NOT_READ;
  const source = typeof f.source === "string" && SOURCES.includes(f.source) ? f.source : null;
  const readAt = typeof f.read_at === "string" ? Date.parse(f.read_at) : NaN;
  const link = httpsLink(f.link);
  const fee = feeFromFact(f);
  if (!source || !Number.isFinite(readAt) || !link || !fee) return { id: "transfer_fee", label: "Transfer fee", value: "—", noSource: true };
  const why = feeCaseView(f, fee);
  return {
    id: "transfer_fee",
    label: "Transfer fee",
    value: feeLong(fee),
    source,
    readAtMs: readAt,
    link,
    ...(fee.standardLinks ? { moreLinks: { lead: "Standard observed on", links: fee.standardLinks.map((url, i) => ({ label: `launch ${i + 1}`, url })) } } : {}),
    ...(why.lines.length ? { lines: why.lines } : {}),
    ...(why.highFee ? { badge: "High fee" as const } : {}),
  };
}

/** Fees paid to the dev group: a fact of its own, right after the fee, only when the engine wrote it with its receipt. */
function devPayoutsFact(f: Record<string, unknown> | undefined): DossierFact | null {
  if (!f) return null;
  const source = typeof f.source === "string" && SOURCES.includes(f.source) ? f.source : null;
  const readAt = typeof f.read_at === "string" ? Date.parse(f.read_at) : NaN;
  const link = httpsLink(f.link);
  const p = devPayoutsFrom(f);
  const label = "Fees paid to the dev group";
  if (!source || !Number.isFinite(readAt) || !link || !p) return { id: "fee_dev_payouts", label, value: "—", noSource: true };
  const value = `${p.transfers.toLocaleString("en-US")} ${p.transfers === 1 ? "transfer" : "transfers"} to ${p.wallets.length} ${p.wallets.length === 1 ? "wallet" : "wallets"}`;
  return { id: "fee_dev_payouts", label, value, source, readAtMs: readAt, link, moreLinks: { lead: "Paid to", links: p.wallets.map((w) => ({ label: shortAddr(w), url: `https://solscan.io/account/${w}` })) } };
}

/** The token's own links as the feed file carries them (contract v1.1), or null when it has none (then the old place is tried). */
function feedLinks(feed: unknown): unknown {
  const l = typeof feed === "object" && feed !== null ? (feed as Record<string, unknown>).links : undefined;
  return typeof l === "object" && l !== null ? l : null;
}

/** What the launchpad's own record lists (a design decision, `launchpad_links`): only with a source off the fixed list's launchpads and a read time, and only clean links. */
export function launchpadLinksFrom(feed: unknown): Dossier["launchpadLinks"] {
  const l = typeof feed === "object" && feed !== null ? (feed as Record<string, unknown>).launchpad_links : undefined;
  if (typeof l !== "object" || l === null) return undefined;
  const r = l as Record<string, unknown>;
  const readAt = typeof r.read_at === "string" ? Date.parse(r.read_at) : NaN;
  if (r.source !== "Stonk.fun" || !Number.isFinite(readAt)) return undefined;
  const links = cleanLinks(r);
  return links.length ? { source: r.source, readAtMs: readAt, links } : undefined;
}

/** Build the dossier from one engine result file's content (checks, sentences) and its feed file's content (facts and links). */
export function buildDossier(raw: unknown, feed: unknown = null): Dossier {
  if (typeof raw !== "object" || raw === null) return EMPTY;
  const r = raw as Record<string, unknown>;
  const facts = factsFrom(feed);
  const labels: readonly string[] = NO_SCORE_LABELS;
  const flagged = labels.includes(String(r.label ?? "")) || labels.includes(String(r.display ?? ""));
  const checks: Dossier["checks"] = [];
  if (!flagged) {
    const rd = (typeof r.readings === "object" && r.readings !== null ? r.readings : {}) as Record<string, unknown>;
    // A section the feed lists in `not_read` shows "Not read" and its reason, never a band or "Clear". The page matches no sentences to guess a reason.
    const notRead = notReadFrom(feed);
    const receipts = checkSourcesFrom(feed);
    const unread: string[] = [];
    // A feed file with no `facts` at all is old-format (written before contract v1.1). Only there, and only where the engine says the developer is
    // hidden, a developer section with no grade is "Not read" (never "Clear") until the coin is scored again. Everything else keeps its grade or "Clear".
    const oldFormat = !(typeof feed === "object" && feed !== null && Array.isArray((feed as Record<string, unknown>).facts));
    const hiddenDev = oldFormat && [...(Array.isArray(r.notes) ? r.notes : []), ...(Array.isArray(r.flags) ? r.flags : [])].some((n) => typeof n === "string" && DEV_HIDDEN.some((re) => re.test(n.trim())));
    for (const [key, name] of CHECKS) {
      if (hiddenDev && notRead.size === 0 && DEV_SECTIONS.includes(key) && typeof rd[key] !== "number") {
        checks.push({ name, band: "Not read", reason: "not yet re-scored" });
        continue;
      }
      if (notRead.has(key)) {
        const reason = notRead.get(key);
        checks.push({ name, band: "Not read", ...(reason ? { reason } : {}) });
        continue;
      }
      const band = bandOf(rd[key]);
      const rc = receipts.get(key);
      if (band) checks.push({ name, band, ...(rc ? { source: rc.source, readAtMs: rc.readAtMs, link: rc.link } : {}) });
      else unread.push(name);
    }
    // a check PINR never read says so plainly, in its place, on a coin that has other readings (a file with none keeps its own message).
    if (checks.length) {
      const order = CHECKS.map(([, n]) => n);
      for (const name of unread) checks.push({ name, band: "Not read" });
      checks.sort((a, b) => order.indexOf(a.name) - order.indexOf(b.name));
    }
  }
  const read = approvedSentences([...(Array.isArray(r.notes) ? r.notes : []), ...(Array.isArray(r.flags) ? r.flags : [])]);
  const pad = launchpadLinksFrom(feed);
  const intent = flagged ? null : intentFrom(r);
  return { available: true, facts, ...(intent ? { intent } : {}), checks, read, links: cleanLinks(feedLinks(feed) ?? r.links), channels: channelsFrom(feedLinks(feed) ?? r.links), ...(flagged ? { held: "flagged" as const } : {}), ...(pad ? { launchpadLinks: pad } : {}) };
}

const HANDOFF = resolve(import.meta.dirname, "..", "..", "engine");
const FEED_DIR = process.env.PINR_DROP_DIR ? resolve(process.env.PINR_DROP_DIR) : join(HANDOFF, "frontend-feed");
/** Where the engine writes full results: EVM tokens in stage4, Solana tokens in stage2 (same names, a few differences: see the engine's result files). D4: `PINR_RESULTS_DIRS` (folders separated like PATH) for sample data. */
const RESULTS_DIRS = process.env.PINR_RESULTS_DIRS ? process.env.PINR_RESULTS_DIRS.split(delimiter).filter(Boolean).map((d) => resolve(d)) : [join(HANDOFF, "stage4", "results"), join(HANDOFF, "stage2", "results")];

/** The dossier for one token, or EMPTY when the engine has no file for it. */
export function readDossier(address: string, dirs: readonly string[] = RESULTS_DIRS, feedDir: string = FEED_DIR): Dossier {
  if (!/^[0-9a-zA-Z]{20,64}$/.test(address)) return EMPTY;
  for (const dir of dirs) {
    const file = join(dir, `${address}.json`);
    if (!existsSync(file)) continue;
    try {
      let feed: unknown = null;
      try {
        const ff = join(feedDir, `${address}.json`);
        if (existsSync(ff)) feed = JSON.parse(readFileSync(ff, "utf8"));
      } catch {
        /* an unreadable feed file means no facts: dashes with "no source" */
      }
      return buildDossier(JSON.parse(readFileSync(file, "utf8")), feed);
    } catch {
      return EMPTY;
    }
  }
  // a coin the trigger has seen and the engine has not scored has no result file, only its feed file. Its evidence is what
  // that file read: the fee first ("not read yet" while the mint is unread, never "none"), its own links, and no checks yet.
  try {
    const ff = join(feedDir, `${address}.json`);
    if (existsSync(ff)) {
      const feed = JSON.parse(readFileSync(ff, "utf8")) as unknown;
      if (typeof feed === "object" && feed !== null && (feed as Record<string, unknown>).seen === true) return seenDossier(feed);
    }
  } catch {
    /* an unreadable feed file: no evidence, as before */
  }
  return EMPTY;
}

/** The evidence of a coin seen, not scored yet: only what its feed file read, nothing filled in. */
export function seenDossier(feed: unknown): Dossier {
  const f = feed as Record<string, unknown>;
  const facts = factsFrom({ facts: Array.isArray(f.facts) ? f.facts : [] });
  const pad = launchpadLinksFrom(feed);
  return { available: true, facts, checks: [], read: [], links: cleanLinks(feedLinks(feed)), channels: channelsFrom(feedLinks(feed)), seen: true, ...(pad ? { launchpadLinks: pad } : {}) };
}
