import { scoreShown } from "./hub";
import type { TransferFee } from "../../server/transferfee";
/**
 * The data the interface shows. Everything is SIMULATED for now and every card is tagged SIM.
 * The Feed interface is the seam where real PINR readers plug in later (step 9): the cards only
 * ever see Items, never where they came from.
 *
 * Two kinds of importance, deliberately separate:
 *   - base  : long-term weight. Decides the card's permanent size and place. Rarely changes.
 *   - spike : what is happening right now. Decays. Only ever shows as in-place heat and swelling.
 */
export interface Item {
  id: number;
  name: string;
  /** The ticker including the dollar sign, e.g. "$ZORIN". */
  ticker: string;
  /** URL of the token's picture. Null until there is one: the card then shows a plain circle with the initial. */
  image: string | null;
  detail: string;
  /** PINRscore 1..99. */
  value: string;
  /** Share of readings that loaded, 0..100. */
  coverage: number;
  /** When the engine made the score shown (the feed's `as_of`, ms), or absent. Shown as "scored 41 min ago". */
  scoredAtMs?: number;
  /** When the trigger first saw it, for a coin not scored yet; see `recentAt` in server/feed.ts. */
  seenAtMs?: number;
  /** Receipts of the app's own figures (DeepScan shows them under the figure): where they came from and when they were read (ms). */
  quoteSource?: string;
  quoteAtMs?: number;
  capSource?: string;
  capAtMs?: number;
  /** All-time-high market cap (dollars) where a launchpad's record states it, with its receipt; NaN when not stated. */
  ath: number;
  athSource?: string;
  athAtMs?: number;
  athLink?: string;
  /** The coin's transfer fee, when read; see server/transferfee.ts. */
  transferFee?: TransferFee;
  figSrc?: { volume?: { source: string; atMs: number }; liquidity?: { source: string; atMs: number }; pair?: { source: string; atMs: number } };
  /** True while the score is an early one (slower readings still to come). Shown as the word "Early" beside the score. */
  early: boolean;
  /** True while the coin's X check has not run (feed `social_check` "not_checked"). Shown as "Social: not checked yet" beside the score on Discover and DeepScan. */
  socialNotChecked?: boolean;
  /** Resting importance 0..1. */
  base: number;
  /** Temporary extra importance from a live event. Decays over time. */
  spike: number;
  /** The latest event, shown for a few seconds on the card it happened to. */
  note: string | null;
  /** Counts up on every event so the card knows when a new one arrived. */
  noteSeq: number;
  /** Seconds the note stays visible. */
  noteLeft: number;
  /** Importance sampled every SIM.histEvery seconds, oldest first (HIST_N samples). Drives the stream ribbon. */
  hist: number[];
  /** Seconds since the newest sample was taken. */
  histAge: number;
  /** Share of recent trades that were buys, 0..1. Tips the stream toward lime (buys) or mandarin (sells). */
  buyShare: number;
  /** The lean this token returns to when nothing is happening: above 0.5 mostly buying, below mostly selling. */
  restBuy: number;
  /** Which side its latest event favoured: 1 = good news / buying (lime), 0 = red flag / selling (mandarin). */
  evSide: 0 | 1;
  /** Where this token's reading stands. */
  status: Status;
  /** For a flagged token: what was proven. Flagged tokens show this instead of a score. */
  flagKind: FlagKind | null;
  /** Seconds until a `checking` or `error` status changes. */
  statusLeft: number;
  /** Minutes since this token launched. Under NEW_LAUNCH_MIN counts as a new launch. */
  ageMin: number;
  /** Recent signed score movement. Large either way means a mover. Fades with time. */
  moved: number;
  /**
   * Market cap and 24h volume in dollars, 24h price change in percent, for the Discover list. NaN means MISSING (not known
   * yet): it shows as a dash and is never read as zero. In the simulation these are made-up numbers.
   */
  mcap: number;
  volume24h: number;
  change24h: number;
  /** Price over the last 24h for the Discover line chart, oldest first. Empty means missing. */
  chart: number[];
  /** The tracked or measured price line in dollars, oldest first (what the coin page draws when no candles can be had); undefined when none. */
  series?: number[];
  /** True when this token has a real or simulated trade stream. Without one, no buy/sell streaks are drawn for it. */
  hasFlow: boolean;
  /** True when the buy/sell mix is a count of trades (DexScreener), not dollars: it is labelled "counted". */
  flowCount?: boolean;
  /** The token's address on its chain, when known (real results). */
  address: string | null;
  /** The name, ticker and picture as the feed gave them (the item's own may be masked by the rude-name filter). */
  raw?: { name: string; ticker: string; image: string | null };
  /** Latest price in dollars, NaN when unknown. */
  priceUsd: number;
  /** Dollars of liquidity in the trading pool, NaN when unknown. */
  liquidity: number;
  /** The trading pair (e.g. "RYSM / WETH"), or "" when unknown. */
  quotePair: string;
  /** The chain ("solana", "base", "bsc") and launchpad ("Pump.fun curve", "Clanker") when known. They pick the logos on the picture. */
  chain?: string;
  launchpad?: string;
  /** Short plain-language findings from the engine's label (e.g. "Serial launcher (83 launches)"); empty when none. */
  findings: string[];
  /** Hours the price history and change actually cover (under 24 for a young token); NaN when unknown. */
  changeWindowH: number;
  /** Where the price figures came from (e.g. "GeckoTerminal"), or "" when the engine's own or none. */
  priceSource: string;
  /** When the server stopped listing this token (ms); it leaves the page only after a few minutes. Undefined while listed. */
  missingSinceMs?: number;
  /** When the launchpad last saw a trade in this token (ms since 1970); undefined or NaN when not known. */
  lastTradeMs?: number;
  /** no trade for 24 hours. Such a coin is on no list and tile; it is only found by searching its address. */
  quiet?: boolean;
  /** The coin's own X, Telegram and website (clean web addresses), when the feed or its launchpad record states them. */
  links?: { x?: string; telegram?: string; website?: string };
  /** True when the engine's note (or the launchpad record) says the creator is a serial launcher. */
  serial?: boolean;
  /** the coin's tags (copy, bot launch, serial launcher), shown wherever it appears (world/tags.ts). */
  tags?: import("../../server/translate").CoinTag[];
  /** Time (ms) of the newest tape event already shown on this token, so each one shows once. */
  lastEventMs?: number;
  /** For a VAMP: the ticker and address of the original it copies. */
  /** Trades the launchpad tape saw in the last 5 minutes (how busy it is right now); undefined when unknown. */
  trades5m?: number;
  /** the number of trades in the last hour (buys and sells), shown on the tile; undefined when no source counts it. */
  trades1h?: number;
  copyOf?: string;
  copyOfAddress?: string;
  /** For a copy (VAMP): "chain" when two different creator wallets were read from the chain, "unchecked" when that has not been done. */
  copyProof?: "chain" | "unchecked";
  /** A scored token whose picture matches an earlier coin by another creator: a warning, its score is kept. */
  possibleCopy?: { ticker: string; address: string; proof: "chain" | "unchecked" };
  /** Small label on the tile: "SIM" for made-up data, empty for real results. */
  tag: string;
}

/** The standard filled "verified" seal (PINR Art Pack: pinr-chk-light). Shown once, on the PINR wordmark on the Discover page. (The tokens no longer wear a verification badge: their pair and launchpad logos sit there instead.) */
export const BADGE_VERIFIED_SRC = "/art/pinr-chk-light.svg";

/** The letter in a token's circle. A bare address has no letter worth showing, so it gets a dot. */
export function avatarChar(name: string): string {
  const c = name.trim().slice(0, 1);
  return /^[0-9a-z]/i.test(c) && !/^0x/i.test(name.trim()) ? c.toUpperCase() : "·";
}

/** A token launched less than this many minutes ago is a "New Launch". */
export const NEW_LAUNCH_MIN = 60;

/**
 * ok       readings loaded
 * checking PINRbot is reading it right now (no number yet)
 * error    a reading failed: "technical error, try again" on that one reading only
 * flag     proven BOT / RUG / VAMP: a label with receipts and NO score; the system stops spending data on it
 */
export type Status = "ok" | "checking" | "error" | "flag";
/** Proven labels that carry no score. The engine uses BOT/RUG as one label; the simulation shows BOT and RUG separately. */
export type FlagKind = "BOT" | "RUG" | "VAMP" | "BOT/RUG" | "MAYHEM" | "HONEYPOT";

/** Below this share of readings loaded, a score is shown dimmer with a dotted texture ("low coverage"). */
export const THIN_BELOW = 55;

export type LookKind = "ok" | "thin" | "checking" | "error" | "flag" | "hidden";

export interface StatusLook {
  kind: LookKind;
  /** What the big number slot shows. Never a made-up number: missing is a dash, a flag is its label. */
  text: string;
  /** True only when `text` is a real score that may roll. */
  numeric: boolean;
}

/** One place that decides what a token's score slot shows. Missing stays missing: never a fake zero. */
export function statusLook(it: Pick<Item, "status" | "flagKind" | "coverage" | "value">): StatusLook {
  // the score slot is empty while the score is hidden; a copy (VAMP) keeps its label as a fact.
  if (!scoreShown() && !(it.status === "flag" && it.flagKind === "VAMP")) return { kind: "hidden", text: "", numeric: false };
  if (it.status === "flag") return { kind: "flag", text: it.flagKind ?? "FLAG", numeric: false };
  if (it.status === "checking") return { kind: "checking", text: "—", numeric: false };
  if (it.status === "error") return { kind: "error", text: "—", numeric: false };
  // Nothing loaded at all: a dash, never a score.
  if (it.coverage <= 0) return { kind: "thin", text: "—", numeric: false };
  // A reading with no score number (the engine had coverage but no score) is a dash, never a "NaN".
  if (!Number.isFinite(Number(it.value))) return { kind: "thin", text: "—", numeric: false };
  return { kind: it.coverage < THIN_BELOW ? "thin" : "ok", text: it.value, numeric: true };
}

/** Points in a token's simulated 24h price chart. */
export const CHART_N = 48;

/** Number of history samples kept per item. */
export const HIST_N = 32;

/** Importance right now: resting weight plus whatever is happening. */
export function liveImportance(it: Item): number {
  return Math.min(1, Math.max(0.04, it.base + it.spike));
}

/** Importance is quantised for layout so card sizes come in a few clean steps. */
export const IMP_LEVELS = 10;
export function quantImp(imp: number): number {
  return Math.round(imp * IMP_LEVELS) / IMP_LEVELS;
}

/** Every tunable number for the simulation lives here, so calibration is one place. */
export const SIM = {
  /** 5 columns x 30 rows. */
  tokens: 150,
  /** How fast a spike fades: its half-life in seconds. */
  spikeHalfLife: 10,
  /** Average seconds between events. */
  eventEvery: 1.8,
  spikeMin: 0.25,
  spikeMax: 0.6,
  /** How long an event line stays on a card. */
  noteSeconds: 6,
  /** How much a card swells at full heat: 0.08 = 8% larger. */
  maxSwell: 0.08,
  /** How much a tile swells under a mouse hover, and when touched and held. */
  hoverSwell: 0.14,
  holdSwell: 0.3,
  /** Seconds between history samples (the ribbon shows HIST_N of these: about 38 s). */
  histEvery: 1.2,
  /** Half-life, in seconds, of a buy/sell lean fading back to the token's resting lean. */
  buyShareHalfLife: 8,
  /** Half-life, in seconds, of a token's recent-movement figure. */
  movedHalfLife: 120,
};

export interface Store {
  items: Item[];
  nextId: number;
  /** Bumped whenever tokens are added or removed, so the tiles know to resync. */
  rev: number;
  /** Tokens that could not be read and were skipped (the rest are still drawn). */
  skipped: number;
}

export function makeStore(): Store {
  return { items: [], nextId: 0, rev: 0, skipped: 0 };
}

/** A source of items. Step 9 adds real ones. */
export interface Feed {
  tick(store: Store, dt: number): void;
}
