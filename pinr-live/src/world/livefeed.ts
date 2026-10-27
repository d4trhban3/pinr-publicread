import { chainName } from "./chainname";
import { labelShown, scoreShown, setScoreShown } from "./hub";
import { HIST_N, SIM, type Feed, type FlagKind, type Item, type Store } from "./model";
import { MASKED_NAME, MASKED_TICKER, moderation } from "./moderation";
import type { WireToken } from "../../server/translate";
import { withLiveHead } from "./livecandle";
import { visibleText } from "./visibletext";
import { STATUS_NOTE } from "./statusnote";
import { tagsOf } from "./tags";

/**
 * The live feed: real results from the feed server (npm run feed) in place of the simulation. It implements the same
 * `Feed` seam, so the tiles never know the difference.
 *
 * What it does, and what it refuses to do:
 *   - every field the engine gives is shown as given; every field it does not give is MISSING (NaN / empty / a dash)
 *   - tokens carry `hasFlow = true` only when the engine has written real trades for them (see `flow`); with no trades file no buy/sell streaks are drawn
 *   - a score that changed between two readings is a real event: it shows "Score moved +n" and swells the tile
 *   - tile size (importance) comes only from the token's own valuation when known; unknown valuation = a small tile
 *   - if the server says it speaks a different contract version, nothing is shown and the Settings page says so
 */
export interface FeedSnapshot {
  contract: string;
  mode: "feed" | "replay" | "empty";
  asOfMs: number | null;
  files: number;
  /** The server's evidence-hub switch: false = no score, coverage, score label or PINRbot field is served. Absent = leave the page's own default. */
  scoreShown?: boolean;
  tokens: WireToken[];
  cut?: number;
  market?: { source: string; calls: number; errors: number; covered: number; none: number; pausedForS: number } | null;
  problems: { file: string; problems: { severity: string; field: string; message: string }[] }[];
}

export type LinkState = "connecting" | "live" | "offline" | "mismatch";

export interface LinkView {
  state: LinkState;
  /** Scored tokens not on the first page that have been loaded so far, and how many there are (they load in the background). */
  more: { loaded: number; total: number };
  /** How many tokens have price history from the market source, how many were looked up and have none; null when that is off. */
  market: { source: string; covered: number; none: number; pausedForS: number } | null;
  mode: FeedSnapshot["mode"] | null;
  tokens: number;
  files: number;
  fileProblems: number;
  /** When the files were last written, ms. */
  asOfMs: number | null;
  /** When the app last heard from the server, ms. */
  heardMs: number | null;
}

/** The major contract version this app understands. */
export const CONTRACT_MAJOR = "1";

/** A bare address is long: show its start and end. */
export function shortAddress(a: string): string {
  return a.length > 14 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a;
}

/** Layout weight from valuation: log-scaled across the tokens that have one; none = the smallest tile. */
export function importances(tokens: readonly WireToken[]): number[] {
  const logs = tokens.map((t) => (t?.valuationUsd != null && t.valuationUsd > 0 ? Math.log10(t.valuationUsd) : NaN));
  const known = logs.filter(Number.isFinite);
  const lo = Math.min(...known);
  const hi = Math.max(...known);
  return logs.map((l) => (Number.isFinite(l) ? 0.2 + 0.54 * (hi > lo ? (l - lo) / (hi - lo) : 0.5) : 0.12));
}

function chartOf(series: number[] | null): number[] {
  if (!series || series.length < 2) return [];
  const first = series[0]!;
  return series.map((v) => v / first);
}

/** What the page shows for a coin's name, ticker and picture: the real ones, or the masks when the rude-name filter is on and the name is rude. */
export function applyMask(it: Item): void {
  const r = it.raw;
  if (!r) return;
  if (moderation.masks(r.name, r.ticker)) {
    it.name = MASKED_NAME;
    it.ticker = MASKED_TICKER;
    it.image = null;
  } else {
    it.name = r.name;
    it.ticker = r.ticker;
    it.image = r.image;
  }
}

/** Write a token's fields into an item. */
export function fillItem(it: Item, t: WireToken, base: number, nowMs: number): void {
  // The page never shows an invisible character in a name or ticker, whatever source it came from.
  it.raw = { name: (t.name && visibleText(t.name)) || shortAddress(t.address), ticker: (t.ticker && visibleText(t.ticker)) || "—", image: t.imageUrl };
  applyMask(it);
  it.chain = t.chain ?? undefined;
  it.launchpad = t.launchpad ?? undefined;
  it.detail = `${t.chain ? chainName(t.chain) : "chain unknown"} · ${t.launchpad ?? "launchpad unknown"}`;
  it.value = t.score !== null ? String(t.score) : "—";
  it.coverage = t.coverage;
  it.early = t.early === true;
  it.socialNotChecked = t.socialNotChecked === true;
  it.scoredAtMs = t.scoredAtMs ?? t.asOfMs ?? undefined; // the real score time when the file states it
  it.seenAtMs = t.seen ? (t.seenAtMs ?? t.asOfMs ?? undefined) : undefined;
  // The coin page's own figures: the site's tile list leaves them out, so they are taken only when the list carries them; the coin
  // page reads them for its coin from /api/token/detail (applyCoinPage), and a tile poll never wipes them.
  applyCoinPage(it, t);
  it.ath = t.athUsd ?? NaN;
  it.transferFee = t.transferFee;
  // only a copy (VAMP) keeps its label while the score is hidden; BOT/RUG, MAYHEM and HONEYPOT are verdicts and are hidden with it.
  const label = labelShown(t.noScoreLabel) ? t.noScoreLabel : null;
  it.status = label ? "flag" : "ok";
  it.flagKind = (label as FlagKind | null) ?? null;
  it.base = base;
  it.ageMin = t.launchedAtMs !== null ? Math.max(0, (nowMs - t.launchedAtMs) / 60000) : NaN;
  it.mcap = t.valuationUsd ?? NaN;
  it.volume24h = t.volume24hUsd ?? NaN;
  it.change24h = t.change24hPct ?? NaN;
  // the tracked line ends at the live price, so the tile's and Discover's line move with every price the stream brings.
  // The head is added to the dollar series BEFORE it becomes ratios to its first point.
  it.chart = chartOf(t.priceSeries ? withLiveHead(t.priceSeries, t.priceUsd ?? NaN) : null);
  // A snapshot that has no line for the coin this time (its quote just aged out on the server) keeps the line it had: the coin page draws it when no candles exist.
  it.series = t.priceSeries ? withLiveHead(t.priceSeries, t.priceUsd ?? NaN) : it.series;
  it.changeWindowH = t.changeWindowH ?? NaN;
  it.priceUsd = t.priceUsd ?? NaN;
  it.quotePair = t.quotePair ?? "";
  // the engine's own status words ("Technical error, retrying") are not an observation about the coin: never shown
  it.findings = t.note ? t.note.split(";").map((x) => x.trim()).filter((x) => x && !STATUS_NOTE.test(x)) : [];
  it.priceSource = t.priceSource ?? "";
  it.address = t.address;
  it.lastTradeMs = t.lastTradeMs ?? NaN;
  it.quiet = t.quiet === true;
  it.links = t.links;
  it.serial = /serial launcher/i.test(t.note ?? "");
  it.tags = tagsOf({ tags: t.tags, noScoreLabel: t.noScoreLabel, note: t.note }); // a design decision (b)
  it.trades5m = t.flow ? t.flow.n5m : undefined;
  it.trades1h = t.hourTrades ? t.hourTrades.n : t.flow ? t.flow.n1h : undefined; // the engine's own count first
  it.copyOf = t.copyOf?.ticker;
  it.copyOfAddress = t.copyOf?.address;
  it.copyProof = t.copyProof ?? undefined;
  it.possibleCopy = t.possibleCopyOf ? { ticker: t.possibleCopyOf.ticker, address: t.possibleCopyOf.address, proof: t.possibleCopyOf.proof } : undefined;
  // Real trades (the engine's trades file): the streaks show the real mix of buys and sells. No trades in the last hour, no streaks.
  const fl = t.flow;
  if (fl && fl.n1h > 0) {
    const share = (b: number, s: number): number => (b + s > 0 ? b / (b + s) : 0.5);
    // A mix means little from one or two trades: below this many, the streaks show an even mix (they still show that it trades).
    const MIN = 3;
    it.hasFlow = true;
    it.flowCount = fl.basis === "count";
    it.restBuy = fl.n1h >= MIN ? share(fl.buy1h, fl.sell1h) : 0.5;
    it.buyShare = fl.n5m >= MIN ? share(fl.buy5m, fl.sell5m) : it.restBuy;
  } else {
    it.hasFlow = false;
    it.flowCount = false;
  }
}

/** The coin page's own figures, from a full token or `/api/token/detail`: each one only when the answer carries it. */
export function applyCoinPage(it: Item, t: Partial<WireToken>): void {
  if ("quoteSource" in t) it.quoteSource = t.quoteSource;
  if ("quoteAtMs" in t) it.quoteAtMs = t.quoteAtMs;
  if ("capSource" in t) it.capSource = t.capSource;
  if ("capAtMs" in t) it.capAtMs = t.capAtMs;
  if ("athSource" in t) it.athSource = t.athSource;
  if ("athAtMs" in t) it.athAtMs = t.athAtMs;
  if ("athLink" in t) it.athLink = t.athLink;
  if ("figSrc" in t) it.figSrc = t.figSrc;
  if ("liquidityUsd" in t) it.liquidity = t.liquidityUsd ?? NaN;
}

function newItem(id: number): Item {
  return {
    id,
    name: "",
    ticker: "",
    image: null,
    detail: "",
    value: "—",
    coverage: 0,
    early: false,
    base: 0.12,
    spike: 0,
    note: null,
    noteSeq: 0,
    noteLeft: 0,
    // No invented past: the ribbon would start flat, but these tokens draw no streaks at all.
    hist: new Array<number>(HIST_N).fill(0.12),
    histAge: 0,
    buyShare: 0.5,
    restBuy: 0.5,
    evSide: 1,
    status: "ok",
    flagKind: null,
    statusLeft: 0,
    ageMin: NaN,
    moved: 0,
    mcap: NaN,
    ath: NaN,
    volume24h: NaN,
    change24h: NaN,
    chart: [],
    changeWindowH: NaN,
    priceSource: "",
    priceUsd: NaN,
    liquidity: NaN,
    quotePair: "",
    findings: [],
    hasFlow: false,
    address: null,
    tag: "",
  };
}

/** An early score that can no longer be kept current: the tile goes back to "unscored" (a dash), keeping everything else it knows. */
export function blankEarly(it: Item): void {
  it.early = false;
  it.socialNotChecked = false;
  it.value = "—";
  it.coverage = 0;
  it.status = "ok";
  it.flagKind = null;
  it.findings = [];
}

/** How long a token may be missing from the server's list before its tile goes. */
export const GONE_AFTER_MS = 5 * 60_000;

/** The thresholds for what counts as a real surge between two readings of the same token. */
export const SURGE = { mcapPct: 8, coveragePts: 10 };

/** What changed between two readings of one token (null = nothing worth a surge). Every line states a measured change. */
export interface Surge {
  text: string;
  /** 1 good news / rising (lime), 0 bad news / falling (mandarin). */
  side: 0 | 1;
  /** How hot the tile gets, 0..0.75. */
  heat: number;
  /** Signed score change, when that is what moved. */
  scoreDelta: number;
}
export function surgeFor(
  prev: { score: number; coverage: number; flag: FlagKind | null; mcap: number },
  next: { score: number; coverage: number; flag: FlagKind | null; mcap: number },
): Surge | null {
  // Most important first: a proven flag, then the score, then the market cap, then coverage.
  if (next.flag && next.flag !== prev.flag) return { text: `Flag raised: ${next.flag}`, side: 0, heat: 0.75, scoreDelta: 0 };
  if (scoreShown() && Number.isFinite(prev.score) && Number.isFinite(next.score) && next.score !== prev.score) {
    const d = next.score - prev.score;
    return { text: `Score moved ${d > 0 ? "+" : "−"}${Math.abs(d)}`, side: d > 0 ? 1 : 0, heat: Math.min(0.75, 0.25 + Math.abs(d) / 40), scoreDelta: d };
  }
  if (Number.isFinite(prev.mcap) && Number.isFinite(next.mcap) && prev.mcap > 0) {
    const pct = (next.mcap / prev.mcap - 1) * 100;
    if (Math.abs(pct) >= SURGE.mcapPct) return { text: `Market cap ${pct > 0 ? "+" : "−"}${Math.round(Math.abs(pct))}%`, side: pct > 0 ? 1 : 0, heat: Math.min(0.7, 0.3 + Math.abs(pct) / 100), scoreDelta: 0 };
  }
  const dc = next.coverage - prev.coverage;
  if (scoreShown() && Math.abs(dc) >= SURGE.coveragePts) return { text: `Coverage ${dc > 0 ? "+" : "−"}${Math.abs(dc)}%`, side: dc > 0 ? 1 : 0, heat: 0.3, scoreDelta: 0 };
  return null;
}

/** The line a tape event puts on a tile ("Large buy $540", "Volume surge $1.2K"): a measured trade or minute, never a guess. */
export function tapeSurge(ev: NonNullable<WireToken["tapeEvent"]>): Surge {
  const usd = ev.usd >= 1000 ? `$${(ev.usd / 1000).toFixed(1)}K` : `$${Math.round(ev.usd)}`;
  if (ev.kind === "large_buy") return { text: `Large buy ${usd}`, side: 1, heat: Math.min(0.75, 0.35 + ev.usd / 8000), scoreDelta: 0 };
  if (ev.kind === "large_sell") return { text: `Large sell ${usd}`, side: 0, heat: Math.min(0.75, 0.35 + ev.usd / 8000), scoreDelta: 0 };
  return { text: `Volume surge ${usd}`, side: 1, heat: 0.5, scoreDelta: 0 };
}

/**
 * a real trade moves its tile at once. The price becomes the trade's, and the market cap moves with it
 * (the supply does not change between two prices of one coin, so the cap scales by the same ratio). Nothing moves without a real trade price.
 */
export function applyTradePrice(it: Item, priceUsd: number): void {
  if (!(priceUsd > 0) || !Number.isFinite(priceUsd)) return;
  if (it.priceUsd > 0 && it.mcap > 0) it.mcap = it.mcap * (priceUsd / it.priceUsd);
  it.priceUsd = priceUsd;
}
/** A trade price is laid over the list's own for this long, so a slower list price (a quote seconds old) never pulls a tile back past a newer trade. */
export const LIVE_PRICE_MS = 60_000;
/** Lay the newest trade prices over what a snapshot just set; prices older than LIVE_PRICE_MS are forgotten. */
export function overlayLive(byAddress: Map<string, Item>, live: Map<string, { priceUsd: number; atMs: number }>, nowMs: number): void {
  for (const [key, v] of live) {
    if (nowMs - v.atMs > LIVE_PRICE_MS) {
      live.delete(key);
      continue;
    }
    const it = byAddress.get(key);
    if (it) applyTradePrice(it, v.priceUsd);
  }
}

/** Merge a snapshot into the store: new tokens are added, known ones updated in place (so tiles never jump). */
export function applySnapshot(store: Store, byAddress: Map<string, Item>, snap: FeedSnapshot, nowMs: number, keep: ReadonlySet<string> = new Set()): void {
  if (typeof snap.scoreShown === "boolean") setScoreShown(snap.scoreShown);
  // The very first snapshot is the starting picture, not news: nothing surges for simply being there.
  const firstLoad = byAddress.size === 0;
  // A token the snapshot no longer holds leaves, but only after it has been missing for a few minutes: the launchpad lists
  // churn (a coin falls out of "newest" or "biggest" and may come back), and a tile must not vanish and reshuffle the page for that.
  const present = new Set(snap.tokens.map((t) => String(t?.address ?? "").toLowerCase()));
  for (const [key, it] of byAddress) {
    if (present.has(key) || keep.has(key)) {
      it.missingSinceMs = undefined;
      continue;
    }
    // An early score whose file has gone has no score now: "no score yet" at once, never the old number held for minutes.
    if (it.early) blankEarly(it);
    it.missingSinceMs ??= nowMs;
    if (nowMs - it.missingSinceMs < GONE_AFTER_MS) continue;
    byAddress.delete(key);
    store.items.splice(store.items.indexOf(it), 1);
    store.rev++;
  }
  const base = importances(snap.tokens);
  snap.tokens.forEach((t, i) => {
    try {
      applyOne(store, byAddress, t, base[i]!, nowMs, firstLoad);
    } catch (e) {
      // One malformed token is skipped (and counted); it never stops the others from being drawn.
      store.skipped++;
      console.error("PINR: a token could not be read and was skipped:", t?.address, e);
    }
  });
}

function applyOne(store: Store, byAddress: Map<string, Item>, t: WireToken, baseWeight: number, nowMs: number, firstLoad: boolean): void {
  const key = t.address.toLowerCase();
  let it = byAddress.get(key);
  // A coin this person has hidden never joins the store (and leaves it if it is there): it changes no score, it is only not shown here.
  if (moderation.isHidden(key)) {
    if (it) {
      byAddress.delete(key);
      store.items.splice(store.items.indexOf(it), 1);
      store.rev++;
    }
    return;
  }
  let surge: Surge | null = null;
  if (!it) {
    // Filled BEFORE it joins the store, so a token that cannot be read never leaves a half-made tile behind.
    const fresh = newItem(store.nextId);
    fillItem(fresh, t, baseWeight, nowMs);
    store.nextId++;
    it = fresh;
    byAddress.set(key, it);
    store.items.push(it);
    store.rev++;
    if (!firstLoad) surge = { text: "New in the roster", side: 1, heat: 0.4, scoreDelta: 0 };
  } else {
    const wasEarly = it.early;
    const prev = { score: it.status === "ok" && it.value !== "—" ? Number(it.value) : NaN, coverage: it.coverage, flag: it.flagKind, mcap: it.mcap };
    fillItem(it, t, baseWeight, nowMs);
    const next = { score: t.score ?? NaN, coverage: it.coverage, flag: it.flagKind, mcap: it.mcap };
    // An early score moving, or being replaced by the full one, is not news: no "Score moved" or "Coverage" line (a flag or market cap still is).
    if (wasEarly || it.early) {
      prev.score = next.score = NaN;
      prev.coverage = next.coverage;
    }
    surge = surgeFor(prev, next);
  }
  // A new event from the tape (a large trade or a volume surge in the last minute) outranks a market-cap move.
  const ev = t.tapeEvent;
  if (ev && !firstLoad && ev.atMs !== it.lastEventMs) {
    it.lastEventMs = ev.atMs;
    surge = tapeSurge(ev);
  } else if (ev && firstLoad) it.lastEventMs = ev.atMs;
  if (surge) {
    it.note = surge.text;
    it.noteSeq++;
    it.noteLeft = SIM.noteSeconds;
    it.spike = Math.min(0.75, Math.max(it.spike, surge.heat));
    it.moved += surge.scoreDelta;
    it.evSide = surge.side;
  }
}

/** The scored tokens after the first page arrive in pages of this many, and the whole set is read again this often. */
export const TAIL_PAGE = 500;
export const TAIL_EVERY_MS = 60_000;
/** the site reads its lighter tile list every 15 seconds (it was the full list every 5). */
export const TILE_URL = "/api/tokens?view=tile";
export const POLL_EVERY_MS = 15_000;
/** How often a stream the server closed for good is tried again. */
export const STREAM_RETRY_MS = 60_000;

/** Merge one page of the rest of the scored set. Quiet: a token that simply turns up is not news. Weights are measured against the first page's range. */
export function applyTailPage(store: Store, byAddress: Map<string, Item>, first: readonly WireToken[], page: readonly WireToken[], nowMs: number): void {
  const base = importances([...first, ...page]).slice(first.length);
  page.forEach((t, i) => {
    try {
      applyOne(store, byAddress, t, base[i]!, nowMs, true);
    } catch (e) {
      store.skipped++;
      console.error("PINR: a token could not be read and was skipped:", t?.address, e);
    }
  });
}

/** Where a list stands in its stream: the server's boot and the last change it includes. */
export interface StreamPos {
  boot: string;
  seq: number;
}
type Row = Partial<WireToken> & { address: string };
/** One `changes` message of `/api/stream` (server/stream.ts). */
export interface StreamChanges {
  boot: string;
  seq: number;
  seen: Row[];
  score: Row[];
  graduation: Row[];
  tick: Row[];
  gone: string[];
  rest: Row[];
  restGone: string[];
  meta?: Record<string, unknown>;
  /** curve coins' own trades */
  trades?: { address: string; atMs: number; side: "buy" | "sell"; priceUsd: number; usd: number }[];
}

/**
 * The page's copy of the first page: read once from `/api/tokens`, then kept current by the stream's changes. A change from
 * another server boot, or one that skips a number (something was missed), asks for the lists to be read again ("reset"); an old one is ignored.
 */
export class ListCopy {
  first = new Map<string, WireToken>();
  head: Omit<FeedSnapshot, "tokens"> | null = null;
  pos: StreamPos | null = null;

  load(snap: FeedSnapshot & { stream?: StreamPos }): void {
    this.first = new Map(snap.tokens.map((t) => [t.address.toLowerCase(), t]));
    const { tokens: _t, stream, ...head } = snap;
    void _t;
    this.head = head;
    this.pos = stream && typeof stream.boot === "string" && Number.isInteger(stream.seq) ? { boot: stream.boot, seq: stream.seq } : null;
  }

  apply(c: StreamChanges): { rest: WireToken[]; restGone: string[] } | "reset" | null {
    if (!this.pos || c.boot !== this.pos.boot) return "reset";
    if (c.seq <= this.pos.seq) return null;
    if (c.seq > this.pos.seq + 1) return "reset";
    for (const r of c.seen) this.first.set(r.address.toLowerCase(), r as WireToken);
    for (const p of [...c.score, ...c.graduation, ...c.tick]) {
      const key = p.address.toLowerCase();
      const had = this.first.get(key);
      if (had) this.first.set(key, { ...had, ...p } as WireToken);
    }
    for (const k of c.gone) this.first.delete(k.toLowerCase());
    if (c.meta && this.head) this.head = { ...this.head, ...(c.meta as Partial<FeedSnapshot>) };
    this.pos = { boot: this.pos.boot, seq: c.seq };
    return { rest: c.rest as WireToken[], restGone: c.restGone };
  }

  snapshot(): FeedSnapshot | null {
    return this.head ? { ...this.head, tokens: [...this.first.values()] } : null;
  }
}

export class LiveFeed implements Feed {
  private byAddress = new Map<string, Item>();
  /** each coin's newest trade price from the stream, laid over every snapshot for a minute. */
  private live = new Map<string, { priceUsd: number; atMs: number }>();
  private pending: FeedSnapshot | null = null;
  /** The first page as last heard (what the rest is weighed against), the pages waiting to be merged, and the tokens the last whole sweep held. */
  private first: WireToken[] = [];
  private tailPages: WireToken[][] = [];
  private tailKeys = new Set<string>();
  private moderationRev = moderation.rev;
  private lastSnap: FeedSnapshot | null = null;
  private sweeping = false;
  private sweepKeys = new Set<string>();
  private view: LinkView = { state: "connecting", more: { loaded: 0, total: 0 }, market: null, mode: null, tokens: 0, files: 0, fileProblems: 0, asOfMs: null, heardMs: null };

  /** The list's own address without the query: the rest of the scored set is read from `<base>/rest`. */
  private base: string;
  /** the lists are read once, then kept current by the stream; the decision-200 polls run only while it is not open. */
  private copy = new ListCopy();
  private es: EventSource | null = null;
  private streamOpen = false;
  constructor(
    private url = TILE_URL,
    private everyMs = POLL_EVERY_MS,
  ) {
    this.base = url.split("?")[0]!;
    void this.start();
    setInterval(() => {
      if (!this.streamOpen) void this.poll();
    }, this.everyMs);
    if (this.base === "/api/tokens") {
      setInterval(() => {
        if (!this.streamOpen && this.restWanted) void this.sweep();
      }, TAIL_EVERY_MS);
      // A stream the server closed for good (full, or gone) is tried again every minute; the browser retries a dropped one by itself.
      setInterval(() => {
        if (!this.es || this.es.readyState === 2) this.connect();
      }, STREAM_RETRY_MS);
    }
  }

  /**
   * a design decision, round 1: the scored set (44,158 rows, about 2.4 MB, on 2026-10-21) is read only once something needs it: search,
   * Discover or the PINR Index filter. The tiles draw from the first page alone. From then on the stream keeps it current.
   */
  /** look one coin up by its exact address (a coin on no list, such as one quiet for 24 hours). True when the server knows it; the coin joins the store on the next frame. */
  async find(address: string): Promise<boolean> {
    try {
      const r = await fetch(`/api/token/find?address=${encodeURIComponent(address)}`, { cache: "no-store" });
      if (!r.ok) return false;
      const j = (await r.json()) as { token?: WireToken };
      if (!j.token || typeof j.token.address !== "string") return false;
      // the coin someone asked for goes ahead of the background sweep's pages (a ?coin= link waited ~20 s behind them; the team)
      this.tailPages.unshift([j.token]);
      this.tailKeys.add(j.token.address.toLowerCase());
      return true;
    } catch {
      return false;
    }
  }

  /**
   * The Base/BNB tab's coins at once: the server filters the rest of the scored set by chain, so the tab fills in a second or two
   * rather than after the whole background sweep (about 20 s). Read once; the sweep and the stream keep them current after.
   */
  private chainsRead = new Set<string>();
  async loadChains(chains: readonly string[]): Promise<void> {
    const key = [...chains].sort().join(",");
    if (!key || this.chainsRead.has(key) || this.base !== "/api/tokens") return;
    this.chainsRead.add(key);
    try {
      for (let offset = 0; ; offset += 1000) {
        const res = await fetch(`${this.base}/rest?chains=${encodeURIComponent(key)}&offset=${offset}&limit=1000`, { cache: "no-store" });
        if (!res.ok) throw new Error(String(res.status));
        const body = (await res.json()) as { total: number; tokens: WireToken[] };
        this.tailPages.push(body.tokens);
        for (const t of body.tokens) this.tailKeys.add(String(t?.address ?? "").toLowerCase());
        if (body.tokens.length === 0 || offset + 1000 >= body.total) return;
      }
    } catch {
      this.chainsRead.delete(key); // the next click tries again
    }
  }

  private restWanted = false;
  wantRest(): void {
    if (this.restWanted) return;
    this.restWanted = true;
    if (this.view.state === "live" && this.base === "/api/tokens") void this.sweep();
  }

  /** every live price the stream brings, to the charts (the DeepScan page's lite chart, Discover's cards). */
  private priceFns: ((address: string, price: number, atMs: number, usd?: number) => void)[] = [];
  onPrice(fn: (address: string, price: number, atMs: number, usd?: number) => void): void {
    this.priceFns.push(fn);
  }

  /** each real trade the stream brings (side, dollars, its own time), for the ribbons: one dot per trade. */
  private tradeFns: ((t: { address: string; atMs: number; side: "buy" | "sell"; usd: number; priceUsd: number }) => void)[] = [];
  onTrade(fn: (t: { address: string; atMs: number; side: "buy" | "sell"; usd: number; priceUsd: number }) => void): void {
    this.tradeFns.push(fn);
  }

  /** Whether the live stream is open now (false: the page is on the fallback polls). */
  streaming(): boolean {
    return this.streamOpen;
  }

  private async start(): Promise<void> {
    await this.poll(true);
    if (this.base === "/api/tokens") this.connect();
  }

  /** Open the stream from where the list just read stands. Without EventSource (an old browser) the page stays on the polls. */
  private connect(): void {
    if (typeof EventSource === "undefined" || !this.copy.pos) return;
    this.es?.close();
    const view = this.url.includes("view=tile") ? "view=tile&" : "";
    const es = new EventSource(`/api/stream?${view}boot=${this.copy.pos.boot}&since=${this.copy.pos.seq}`);
    this.es = es;
    es.onopen = () => (this.streamOpen = true);
    es.onerror = () => (this.streamOpen = false);
    es.addEventListener("reset", () => void this.reload());
    es.addEventListener("changes", (e) => {
      let c: StreamChanges;
      try {
        c = JSON.parse((e as MessageEvent<string>).data) as StreamChanges;
      } catch {
        return;
      }
      this.streamOpen = true;
      const got = this.copy.apply(c);
      if (got === "reset") return void this.reload();
      if (!got) return;
      const heard = Date.now();
      for (const r of [...c.seen, ...c.score, ...c.graduation, ...c.tick])
        if (typeof r.priceUsd === "number" && r.priceUsd > 0) for (const fn of this.priceFns) fn(r.address, r.priceUsd, heard);
      // each trade with its own time and amount; a trade may start a chart for a coin that had none.
      for (const t of c.trades ?? []) {
        if (!(t.priceUsd > 0 && t.usd >= 0)) continue;
        // the tile moves now, not at the next list.
        const key = t.address.toLowerCase();
        const had = this.live.get(key);
        if (!had || t.atMs >= had.atMs) {
          this.live.set(key, { priceUsd: t.priceUsd, atMs: Math.min(t.atMs, heard) });
          const it = this.byAddress.get(key);
          if (it) applyTradePrice(it, t.priceUsd);
        }
        for (const fn of this.priceFns) fn(t.address, t.priceUsd, t.atMs, t.usd);
        for (const fn of this.tradeFns) fn(t);
      }
      const snap = this.copy.snapshot();
      if (snap) {
        this.pending = snap;
        this.lastSnap = snap;
      }
      if (got.rest.length && this.restWanted) {
        this.tailPages.push(got.rest);
        for (const t of got.rest) this.tailKeys.add(t.address.toLowerCase());
      }
      if (this.restWanted) for (const k of got.restGone) this.tailKeys.delete(k.toLowerCase());
      this.view = { ...this.view, state: "live", heardMs: Date.now(), asOfMs: snap?.asOfMs ?? this.view.asOfMs, tokens: (snap?.tokens.length ?? 0) + this.view.more.loaded };
    });
  }

  /** The stream says this page is too far behind (or the server restarted): read both lists once more. */
  private reloading = false;
  private async reload(): Promise<void> {
    if (this.reloading) return;
    this.reloading = true;
    try {
      await this.poll(true);
      if (this.restWanted) void this.sweep();
    } finally {
      this.reloading = false;
    }
  }

  link(): LinkView {
    return this.view;
  }

  /** Test hook (dev only): hand the feed a snapshot as if the server had sent it. */
  inject(snap: FeedSnapshot): void {
    this.pending = snap;
  }

  /** Read the first page. `fresh`: the opening read and every reset read ask the server itself ("no-cache"), so a copy a browser kept from before
   * the stream (which carries no stream position) can never keep the page off the stream; the fallback polls may use a copy up to 5 s old. */
  private async poll(fresh = false): Promise<void> {
    try {
      // The browser's normal cache rules: the answer says max-age=5, so a shared cache may serve it; "no-store" would ask every cache to skip it.
      const res = await fetch(this.url, { cache: fresh ? "no-cache" : "default" });
      if (!res.ok) throw new Error(`server answered ${res.status}`);
      const snap = (await res.json()) as FeedSnapshot;
      const now = Date.now();
      if (String(snap.contract).split(".")[0] !== CONTRACT_MAJOR) {
        this.view = { ...this.view, state: "mismatch", heardMs: now };
        return;
      }
      this.pending = snap;
      this.lastSnap = snap;
      this.copy.load(snap);
      const firstTime = this.view.state !== "live";
      this.view = { state: "live", more: { loaded: this.view.more.loaded, total: snap.cut ?? this.view.more.total }, market: snap.market ? { source: snap.market.source, covered: snap.market.covered, none: snap.market.none, pausedForS: snap.market.pausedForS } : null, mode: snap.mode, tokens: snap.tokens.length + this.view.more.loaded, files: snap.files, fileProblems: snap.problems.length, asOfMs: snap.asOfMs, heardMs: now };
      // The rest of the scored set starts loading as soon as the first page has been heard.
      if (firstTime && this.base === "/api/tokens" && this.restWanted) void this.sweep();
    } catch {
      this.view = { ...this.view, state: "offline" };
    }
  }

  /** Read the rest of the scored set a page at a time, in the background. A failed page just ends this sweep; the next one starts again. */
  private async sweep(): Promise<void> {
    if (this.sweeping || this.view.state !== "live") return;
    this.sweeping = true;
    this.sweepKeys = new Set();
    try {
      for (let offset = 0; ; offset += TAIL_PAGE) {
        const res = await fetch(`${this.base}/rest?offset=${offset}&limit=${TAIL_PAGE}`, { cache: "no-store" });
        if (!res.ok) return;
        const body = (await res.json()) as { total: number; tokens: WireToken[] };
        this.tailPages.push(body.tokens);
        for (const t of body.tokens) this.sweepKeys.add(String(t?.address ?? "").toLowerCase());
        this.view = { ...this.view, more: { loaded: Math.min(body.total, offset + body.tokens.length), total: body.total } };
        if (body.tokens.length === 0 || offset + TAIL_PAGE >= body.total) {
          // A whole sweep read: the tokens it held are the ones still present.
          this.tailKeys = this.sweepKeys;
          return;
        }
        await new Promise((r) => setTimeout(r, 400));
      }
    } catch {
      /* the next sweep tries again */
    } finally {
      this.sweeping = false;
    }
  }

  /** The hidden coins leave the store and the filter switch re-masks (or un-masks) every name, at once, the moment either changes. */
  private syncModeration(store: Store, byAddress: Map<string, Item>): void {
    if (moderation.rev === this.moderationRev) return;
    this.moderationRev = moderation.rev;
    let removed = false;
    for (const it of [...store.items]) {
      const key = (it.address ?? "").toLowerCase();
      if (moderation.isHidden(key)) {
        byAddress.delete(key);
        store.items.splice(store.items.indexOf(it), 1);
        removed = true;
      } else applyMask(it);
    }
    if (removed) store.rev++;
    // Coins shown again come back with the next reading, so the last first page is read once more now.
    if (this.lastSnap) this.pending = this.lastSnap;
  }

  tick(store: Store, dt: number): void {
    this.syncModeration(store, this.byAddress);
    if (this.pending) {
      this.first = this.pending.tokens;
      applySnapshot(store, this.byAddress, this.pending, Date.now(), new Set([...this.tailKeys, ...this.sweepKeys]));
      overlayLive(this.byAddress, this.live, Date.now());
      this.pending = null;
    }
    // One waiting page of the rest of the scored set per frame, so a big load never stalls the screen.
    const page = this.tailPages.shift();
    if (page) applyTailPage(store, this.byAddress, this.first, page, Date.now());
    // Events fade and heat decays, as in the simulation.
    const decay = Math.pow(0.5, dt / SIM.spikeHalfLife);
    for (const it of store.items) {
      it.spike *= decay;
      it.moved *= Math.pow(0.5, dt / SIM.movedHalfLife);
      if (it.noteLeft > 0) {
        it.noteLeft -= dt;
        if (it.noteLeft <= 0) it.note = null;
      }
      if (Number.isFinite(it.ageMin)) it.ageMin += dt / 60;
    }
  }
}
