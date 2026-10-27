import type { FlowSummary } from "./trades.ts";
import { cleanTileLinks, type TileLinks } from "./linkview.ts";
import { feeFromFeed, type TransferFee } from "./transferfee.ts";
import { visibleText } from "../src/world/visibletext.ts";
import { observedNote } from "../src/world/statusnote.ts";
/**
 * The translator: one engine result file in, one tile-ready token out.
 *
 * This is the ONLY place that knows what an engine result file looks like. The rest of the app only ever sees `WireToken`.
 * It follows the data contract (contract/DATA-CONTRACT.md):
 *   - an allow-list: only the fields named here are passed on. Sub-scores ("readings"), receipts and flags text stay on the server.
 *   - missing stays missing: an absent or wrongly-typed optional field becomes null, never a default that looks like a measurement.
 *   - a broken required field excludes the token and says why, instead of showing a number that may be wrong.
 */
export const CONTRACT_VERSION = "1.0";

/** Labels that mean "proven bad: show the label, never a score". From the engine (NO_SCORE_LABELS). */
export const NO_SCORE_LABELS = ["VAMP", "BOT/RUG", "MAYHEM", "HONEYPOT"] as const;
export type NoScoreLabel = (typeof NO_SCORE_LABELS)[number];

export interface Problem {
  severity: "error" | "warning";
  field: string;
  message: string;
}

/** What the app is allowed to know about a token. */
/** the tags a coin keeps everywhere it appears, in this order. */
/** A price above this per token is not a price (a coin would be worth more than every dollar there is): missing, never shown. */
export const MAX_PRICE_USD = 1e9;
export const COIN_TAGS = ["vamp", "bot", "serial_launcher"] as const;
export type CoinTag = (typeof COIN_TAGS)[number];

export interface WireToken {
  /** The token's address on its chain. */
  address: string;
  chain: string | null;
  launchpad: string | null;
  name: string | null;
  /** With the leading $. */
  ticker: string | null;
  imageUrl: string | null;
  /** 1..99, or null when there is no number (a no-score label, or nothing loaded). */
  score: number | null;
  /** 0..100. */
  coverage: number;
  /** True only while the score is an early one (slower readings still to come); absent on every full score, never false. */
  early?: true;
  /** True only when the feed file says `social_check: "not_checked"` ; absent otherwise, never false. */
  socialNotChecked?: true;
  /** the coin's tags as the engine writes them, kept wherever the coin appears (evidence in its gate section); absent when none */
  tags?: CoinTag[];
  /** Set only for a no-score label. Then `score` is always null. */
  noScoreLabel: NoScoreLabel | null;
  /** Plain label text that goes with a number (e.g. "Serial launcher (83 launches)"), or null. */
  note: string | null;
  valuationUsd: number | null;
  volume24hUsd: number | null;
  change24hPct: number | null;
  /** Price over the last 24h, oldest first, or null. */
  priceSeries: number[] | null;
  /** Launch time in ms since 1970, or null. */
  launchedAtMs: number | null;
  /** When the engine read it, ms since 1970, or null. */
  asOfMs: number | null;
  /** When the engine last SCORED the coin (the engine's `scored_at`; `as_of` moves on every re-read). Absent in a file that does not say: then `as_of` stands in. */
  scoredAtMs?: number;
  /** The engine's own order for the roster (lower shows first), or null. */
  rank: number | null;
  /** Latest price in dollars, or null. */
  priceUsd: number | null;
  /** Dollars of liquidity in the trading pool, or null. */
  liquidityUsd: number | null;
  /** Where the app's own price figures (volume, liquidity, pair) came from and when it read them (ms), when it supplied them: shown as their receipt on DeepScan. */
  quoteSource?: string;
  quoteAtMs?: number;
  /** The same for a market cap the app took from a launchpad's own list. */
  capSource?: string;
  capAtMs?: number;
  /** The coin's all-time-high market cap in dollars, where a launchpad's own record states it, with its receipt. Absent = a dash. */
  athUsd?: number;
  athSource?: string;
  athAtMs?: number;
  /** The transaction the peak is matched to (the engine's receipt), as an explorer link; absent when none is named. */
  athLink?: string;
  /** Each pool figure's own receipt (source and when it was read), when the app supplied it: they can come from different sources. */
  figSrc?: { volume?: { source: string; atMs: number }; liquidity?: { source: string; atMs: number }; pair?: { source: string; atMs: number } };
  /** The trading pair, e.g. "RYSM / WETH", or null. */
  quotePair: string | null;
  /** Hours the price history / 24h change actually covers (a token under a day old has less than 24), or null. */
  changeWindowH: number | null;
  /** a coin the trigger has seen and the engine has not scored yet (`seen: true` in its feed file); absent on every scored file. */
  seen?: true;
  /** When the trigger first saw it (ms) and which list saw it. */
  seenAtMs?: number;
  seenBy?: "pumpfun_pool" | "stonkfun_list";
  /** The coin's transfer fee, from the feed's `transfer_fee` fact; absent when not read or when the fact breaks the contract. */
  transferFee?: TransferFee;
  /** Where the price figures came from, when the app (not the engine) supplied them. Null = the engine's own or none. */
  priceSource: string | null;
  /** Buy and sell dollars over the last 5 minutes and hour, from the engine's trades file, or null when there is no file. */
  flow: FlowSummary | null;
  /** When the launchpad last saw a trade in this token (ms since 1970), or null when not known. */
  lastTradeMs: number | null;
  /** set only on a coin that has had no trade for 24 hours, and only when it is looked up by its address (it is on no list). Absent otherwise, never false. */
  quiet?: true;
  /** The newest large trade or volume surge the tape saw in the last minute (it shows as a line on the tile), or absent. */
  /** For a VAMP: the original it copies (address and ticker). */
  copyOf?: { address: string; ticker: string } | null;
  /** For a copy (VAMP): whether the chain confirmed two different creator wallets ("chain") or that check has not been done ("unchecked"). */
  copyProof?: "chain" | "unchecked" | null;
  /** A scored token whose picture matches an earlier coin by another creator: a warning only (its score and data are untouched). */
  possibleCopyOf?: { address: string; ticker: string; proof: "chain" | "unchecked" } | null;
  /** The coin's own X, Telegram and website (clean web addresses only), when the feed file or a launchpad record states them. */
  links?: TileLinks;
  /** the last hour's trades as the engine's trade writers counted them (ticks-1 `trades_1h`, `buys_1h`, `sells_1h`); absent until a writer has counted the coin a whole hour. */
  hourTrades?: { n: number; buys: number; sells: number };
  tapeEvent?: { kind: "large_buy" | "large_sell" | "volume_surge"; usd: number; atMs: number } | null;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isStr = (v: unknown): v is string => typeof v === "string" && v.trim() !== "";
const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/** An optional number: absent or null is fine (missing); a wrong type is a warning and also missing. */
function optNum(raw: Record<string, unknown>, key: string, problems: Problem[], ok: (n: number) => boolean = () => true): number | null {
  const v = raw[key];
  if (v === undefined || v === null) return null;
  if (!isNum(v) || !ok(v)) {
    problems.push({ severity: "warning", field: key, message: `"${key}" is not a usable number (${JSON.stringify(v)}); treated as missing` });
    return null;
  }
  return v;
}
function optStr(raw: Record<string, unknown>, key: string, problems: Problem[]): string | null {
  const v = raw[key];
  if (v === undefined || v === null) return null;
  if (!isStr(v)) {
    problems.push({ severity: "warning", field: key, message: `"${key}" is not text; treated as missing` });
    return null;
  }
  return v.trim();
}
function optTime(raw: Record<string, unknown>, key: string, problems: Problem[]): number | null {
  const v = raw[key];
  if (v === undefined || v === null) return null;
  const ms = typeof v === "number" ? v : typeof v === "string" ? Date.parse(v) : NaN;
  if (!Number.isFinite(ms) || ms <= 0) {
    problems.push({ severity: "warning", field: key, message: `"${key}" is not a time (use an ISO date like 2026-10-05T12:00:00Z); treated as missing` });
    return null;
  }
  return ms;
}

export interface Translated {
  token: WireToken | null;
  problems: Problem[];
}

export function translate(raw: unknown): Translated {
  const problems: Problem[] = [];
  const bad = (field: string, message: string): Translated => {
    problems.push({ severity: "error", field, message });
    return { token: null, problems };
  };
  if (!isObj(raw)) return bad("(file)", "the file is not a JSON object");

  // --- required ---
  if (!isStr(raw.mint)) return bad("mint", 'required: "mint" (the token address) is missing or empty');
  const address = raw.mint.trim();

  if (!("score" in raw)) return bad("score", 'required: "score" is missing (use null when there is no number)');
  const rawScore = raw.score;
  if (rawScore !== null && (!isNum(rawScore) || !Number.isInteger(rawScore) || rawScore < 1 || rawScore > 99))
    return bad("score", `required: "score" must be a whole number from 1 to 99, or null (got ${JSON.stringify(rawScore)})`);

  if (!isNum(raw.coverage) || raw.coverage < 0 || raw.coverage > 1)
    return bad("coverage", `required: "coverage" must be a number from 0 to 1 (got ${JSON.stringify(raw.coverage)})`);
  const coverage = Math.round(raw.coverage * 100);

  if (!("label" in raw) || (raw.label !== null && typeof raw.label !== "string"))
    return bad("label", 'required: "label" must be text or null');
  if (!isStr(raw.display) && !(typeof raw.display === "number")) return bad("display", 'required: "display" is missing');
  const label = raw.label === null || raw.label.trim() === "" ? null : raw.label.trim();
  const display = String(raw.display).trim();

  // --- the no-score rule: a proven label and a number never appear together ---
  const noScoreLabel = NO_SCORE_LABELS.find((l) => l === label || l === display) ?? null;
  let score = rawScore as number | null;
  if (noScoreLabel && score !== null) {
    problems.push({ severity: "error", field: "score", message: `"${noScoreLabel}" is a no-score label but a score (${score}) was also given; the score is dropped` });
    score = null;
  }
  if (!noScoreLabel && score === null && coverage > 0 && !label)
    problems.push({ severity: "warning", field: "score", message: "score is null with some coverage and no label; shown as 'no number'" });

  // --- optional ---
  const chain = optStr(raw, "chain", problems);
  const launchpad = optStr(raw, "launchpad", problems) ?? optStr(raw, "venue", problems);
  // Names and tickers lose their invisible characters (a hidden U+2060 in "Blind Ape", 2026-10-25); nothing visible left is missing.
  const rawName = optStr(raw, "name", problems);
  const rawTicker = optStr(raw, "ticker", problems);
  const name = rawName === null ? null : visibleText(rawName) || null;
  let ticker = rawTicker === null ? null : visibleText(rawTicker) || null;
  if (ticker && !ticker.startsWith("$")) ticker = `$${ticker}`;
  const imageUrl = optStr(raw, "image_url", problems);
  const valuationUsd = optNum(raw, "valuation_usd", problems, (n) => n >= 0);
  const volume24hUsd = optNum(raw, "volume_24h_usd", problems, (n) => n >= 0);
  const change24hPct = optNum(raw, "change_24h_pct", problems, (n) => n > -100);
  const launchedAtMs = optTime(raw, "launched_at", problems);
  const asOfMs = optTime(raw, "as_of", problems);
  const scoredAtMs = "scored_at" in raw ? optTime(raw, "scored_at", problems) : null;
  const rank = optNum(raw, "roster_rank", problems, (n) => Number.isInteger(n) && n >= 0);
    // The engine's own all-time high (decision: ENGINE's "pump history" receipt): the market cap at the peak in dollars, its source and the transaction; left out when not read.
  const athCap = optNum(raw, "ath_cap_usd", problems, (n) => n > 0 && n <= 1e15);
  const athSrc = typeof raw.ath_source === "string" && ["Pump.fun", "Solana chain"].includes(raw.ath_source) ? raw.ath_source : null;
  const athTx = typeof raw.ath_tx === "string" && /^[1-9A-HJ-NP-Za-km-z]{64,90}$/.test(raw.ath_tx) ? `https://solscan.io/tx/${raw.ath_tx}` : null;
  const ath = athCap !== null && athSrc !== null && asOfMs !== null ? { athUsd: athCap, athSource: athSrc, athAtMs: asOfMs, ...(athTx ? { athLink: athTx } : {}) } : {};
  const priceUsd = optNum(raw, "price_usd", problems, (n) => n > 0 && n <= MAX_PRICE_USD);
  const liquidityUsd = optNum(raw, "liquidity_usd", problems, (n) => n >= 0);
  const quotePair = optStr(raw, "quote_pair", problems);
  const changeWindowH = optNum(raw, "change_window_hours", problems, (n) => n > 0 && n <= 24 * 30);
  const fee = feeFromFeed(raw) ?? null;
  const links = cleanTileLinks(raw.links);
  let priceSeries: number[] | null = null;
  if (raw.price_series !== undefined && raw.price_series !== null) {
    const s = raw.price_series;
    if (Array.isArray(s) && s.length >= 2 && s.length <= 500 && s.every((n) => isNum(n) && n > 0)) priceSeries = s as number[];
    else problems.push({ severity: "warning", field: "price_series", message: '"price_series" must be 2 to 500 positive numbers, oldest first; treated as missing' });
  }

  // `early` is optional and only ever true. Anything else present is not "early" (absent = not early); a false is noted, not shown.
  let early = false;
  if ("early" in raw && raw.early !== undefined && raw.early !== null) {
    if (raw.early === true) early = true;
    else problems.push({ severity: "warning", field: "early", message: `"early" must be true or absent (got ${JSON.stringify(raw.early)}); treated as not early` });
  }

  // `social_check`  is "done" or "not_checked"; only "not_checked" shows the notice. Absent = missing = no notice.
  let socialNotChecked = false;
  if ("social_check" in raw && raw.social_check !== undefined && raw.social_check !== null) {
    if (raw.social_check === "not_checked") socialNotChecked = true;
    else if (raw.social_check !== "done") problems.push({ severity: "warning", field: "social_check", message: `"social_check" must be "done" or "not_checked" (got ${JSON.stringify(raw.social_check)}); treated as missing` });
  }

  // `seen` is optional and only ever true, on a coin with no score yet; "not scored yet" comes from it, never from `display`.
  let seen = false;
  if ("seen" in raw && raw.seen !== undefined && raw.seen !== null) {
    if (raw.seen === true && score === null && !noScoreLabel) seen = true;
    else problems.push({ severity: "warning", field: "seen", message: `"seen" must be true, on a file with no score (got ${JSON.stringify(raw.seen)}); treated as a scored file's` });
  }
  const seenAtMs = seen ? optTime(raw, "seen_at", problems) : null;
  const seenBy = seen && (raw.seen_by === "pumpfun_pool" || raw.seen_by === "stonkfun_list") ? raw.seen_by : null;

  // the engine's tags, only the known ones, in their order; a wrong field is noted, not shown.
  const tags = Array.isArray(raw.tags) ? COIN_TAGS.filter((t) => (raw.tags as unknown[]).includes(t)) : [];
  if (raw.tags !== undefined && raw.tags !== null && !Array.isArray(raw.tags)) problems.push({ severity: "warning", field: "tags", message: `"tags" must be a list (got ${JSON.stringify(raw.tags)}); treated as missing` });

  // The plain label that goes with a number (not a no-score label); a seen coin says it has no score yet, as the launchpad coins do.
  // checklist 7: the engine's own status words ("Technical error, retrying") never leave the server as a note
  const note = observedNote(noScoreLabel ? null : seen ? (label ?? "Not scored yet") : label);

  return {
    token: { address, chain, launchpad, name, ticker, imageUrl, score, coverage, ...(early ? { early: true as const } : {}), ...(socialNotChecked ? { socialNotChecked: true as const } : {}), ...(tags.length ? { tags } : {}), ...(seen ? { seen: true as const, ...(seenAtMs !== null ? { seenAtMs } : {}), ...(seenBy ? { seenBy } : {}) } : {}), noScoreLabel, note, valuationUsd, volume24hUsd, change24hPct, priceSeries, launchedAtMs, asOfMs, ...(scoredAtMs !== null ? { scoredAtMs } : {}), rank, priceUsd, liquidityUsd, quotePair, ...ath, changeWindowH, ...(fee ? { transferFee: fee } : {}), priceSource: null, flow: null, lastTradeMs: null, ...(links ? { links } : {}) },
    problems,
  };
}
