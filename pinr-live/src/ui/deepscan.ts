import { observedWords, scoreShown } from "../world/hub";
import { palette } from "./theme";
import type { Dossier } from "../../server/dossier";
import { figureOrNotRead, noPoolWords } from "../world/figures";
import type { SocialClaim } from "../../server/social";
import type { Candle, ChartResult } from "../../server/market";
import { changeWindowLabel, candlesFromSeries, formatAsOf, formatCandleTime, formatPrice, formatPriceChange, formatPriceCompact, RANGES, summarize, type RangeId } from "../world/format";
import { ageText, money, signedPct } from "../world/discoverlist";
import { createBadge } from "./badge";
import { flagLine, originalLink, possibleLine, vampIntro } from "../world/copynote";
import { avatarChar, statusLook, type Item } from "../world/model";
import { scoreColor } from "../world/scorecolor";
import { pictureOf } from "../world/cards";
import { shortAddress } from "../world/livefeed";
import { attachPageGestures, createPlacer, type GestureOptions, type Placement } from "./pageoverlay";
import { similarTokens } from "../world/similar";
import { renderTrades, type TradesState, type TradesView } from "./tradeslist";
import { foldPrice } from "../world/livecandle";
import { ADVICE_LINE, SCORE_NOTICE } from "./scorenotice";
import { scoredAgo } from "../world/format";
import { makeEarlyTag, makeSocialTag, setEarly, showsEarly, showsSocial } from "./earlytag";

/**
 * PINRbot DeepScan: one token's page, laid out the way a stock page is on Robinhood, in our look.
 *   name and price, the change for the chosen range
 *   a line chart you can press and drag through, with range pills under it
 *   the PINR Index with what the engine found
 *   Stats
 *   the checks (a word band each, never the numbers), the evidence facts, a written read and the token's own links, all from the cleaned dossier
 *   similar tokens (same chain, close in size and age)
 *   a bar at the bottom with the 24h volume and Copy contract
 * Every number is a measured one or a dash. Nothing about how the score is worked out is shown here.
 */
export interface DeepScanOptions extends GestureOptions {
  /** Price history for a token over a range (from the feed server). */
  fetchChart(address: string, range: RangeId): Promise<ChartResult>;
  /** The cleaned evidence for a token (the server allow-list: word bands, facts, approved sentences, links). Null when it could not be loaded. */
  fetchDossier(address: string): Promise<Dossier | null>;
  /** The public daily PINRbot budget (a percentage and whether the bot runs); null when it is not known (launch item 7). */
  fetchBudget?(): Promise<{ status: "on" | "off"; usedPct: number; asOfMs: number } | null>;
  /** The engine's recent trades for a token (null when they could not be asked). */
  fetchTrades(address: string): Promise<TradesView | null>;
  /** The coin page's own figures, applied to the item; false when they could not be read. */
  fetchDetail?(item: Item): Promise<boolean>;
  /** Every token currently in the feed (used to find similar ones). */
  items(): readonly Item[];
  /** A token was picked from inside the dossier (a similar coin, the original of a copy): the host page opens it. Without this the page just switches. */
  onPick?(item: Item): void;
}

export interface DeepScan {
  el: HTMLElement;
  /** Open this token's page (null shows the "pick a token" screen). */
  setItem(it: Item | null): void;
  place(p: Placement | null, live: boolean): void;
  /** Keep the live parts fresh (about once a second). */
  update(nowSec: number): void;
  /** one real trade from the live stream, shown at once: the price, the chart's current candle growing in place, the trade at the top of Recent trades. */
  liveTrade(t: { address: string; atMs: number; side: "buy" | "sell"; usd: number; priceUsd: number }): void;
  /**
   * The dossier is the second half of the DeepScan page: move its sections (the VAMP and copy notices, score, trades, checks, facts,
   * the written read, social, similar, stats and the fine print) into `host`, and and the bottom bar (24h volume, Copy contract) at the end.
   * Its own page (price, chart, ranges) is no longer shown.
   */
  mountDossier(host: HTMLElement): void;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

const LIME_RGB = "214,255,60";
const MANDARIN_RGB = "255,140,26";

/** A range's candle size when the chart has only one candle to tell it from (seconds). */
const RANGE_BUCKET_SEC: Partial<Record<RangeId, number>> = { "1D": 900, "1W": 3600, "1M": 14_400, "3M": 86_400 };

interface ChartState {
  candles: Candle[];
  status: ChartResult["status"] | "loading";
  source: string | null;
  fetchedAt: number;
  /** Only for a "stale" answer: when its candles were really read. */
  asOfMs?: number;
  /** Dev mode and tests only: a made-up token's own series. Never set in the production build. */
  simulated?: true;
}
const emptyChart = (): ChartState => ({ candles: [], status: "loading", source: null, fetchedAt: 0 });
/** True only in dev mode and tests, for a made-up token's chart: the production build has no simulated chart. */
const isSim = (c: ChartState): boolean => import.meta.env.DEV && c.simulated === true;

export function createDeepScan(opts: DeepScanOptions): DeepScan {
  const root = el("div", "deepscan");
  root.id = "deepscan";
  const frame = el("div", "dframe");
  const scroller = el("div", "dscroll dsscroll");
  frame.append(scroller);
  root.append(frame);

  // --- the sticky mini bar: name and price slide in once the big price has scrolled away ---
  const mini = el("div", "dsmini");
  const miniName = el("b");
  const miniPrice = el("span");
  mini.append(miniName, miniPrice);

  // --- "pick a token" ---
  const empty = el("div", "dsempty");
  empty.append(el("div", "dsemptyt", "PINRbot DeepScan"), el("div", "dsemptys", "Pick a token on the PINR page or Discover to read its dossier."));

  // --- the token's page ---
  const page = el("div", "dspage");
  const hero = el("section", "dshero");
  const idRow = el("div", "dsid");
  const avwrap = el("div", "avwrap");
  const avatar = el("div", "avatar");
  const badge = createBadge();
  avwrap.append(avatar, badge.el);
  const idText = el("div", "dsidt");
  const tickerEl = el("div", "dsticker");
  const nameEl = el("h1", "dsname");
  idText.append(tickerEl, nameEl);
  idRow.append(avwrap, idText);
  const priceEl = el("div", "dsprice");
  const changeEl = el("div", "dschange");
  const priceRcpt = el("div", "dspricercpt");
  hero.append(idRow, priceEl, changeEl, priceRcpt);

  /** A token picked inside the dossier: the host page opens it (so the chart above it follows), else this page switches. */
  const choose = (o: Item): void => (opts.onPick ? opts.onPick(o) : setItem(o));

  // --- the VAMP notice: a copy of another token has no data anywhere, only this label ---
  const vampBox = el("section", "dsvamp");
  const vampIntroEl = el("p", undefined, "");
  vampBox.append(el("b", undefined, "VAMP"), vampIntroEl);
  const vampNote = el("p", "dsvampnote");
  const vampOpen = el("button", "dsvampopen", "Open the original");
  vampOpen.type = "button";
  vampOpen.hidden = true;
  vampOpen.addEventListener("click", () => {
    const o = item?.copyOfAddress ? opts.items().find((i) => i.address?.toLowerCase() === item!.copyOfAddress!.toLowerCase()) : undefined;
    if (o) choose(o);
  });
  const vampWhere = el("p", "dsorig");
  const vampLink = el("a", "dsvampopen") as HTMLAnchorElement;
  vampLink.target = "_blank";
  vampLink.rel = "noopener noreferrer";
  vampLink.hidden = true;
  vampBox.append(vampNote, vampWhere, vampOpen, vampLink);

  // --- the "possible copy" warning: a scored token whose picture matches an earlier coin. Its score and data are kept; this only warns and links. ---
  const possibleBox = el("section", "dspossible");
  possibleBox.hidden = true;
  const possibleText = el("p");
  const possibleOpen = el("button", "dsvampopen", "Open the original");
  possibleOpen.type = "button";
  possibleOpen.addEventListener("click", () => {
    const o = item?.possibleCopy ? opts.items().find((i) => i.address?.toLowerCase() === item!.possibleCopy!.address.toLowerCase()) : undefined;
    if (o) choose(o);
  });
  const possibleWhere = el("p", "dsorig");
  const possibleLink = el("a", "dsvampopen") as HTMLAnchorElement;
  possibleLink.target = "_blank";
  possibleLink.rel = "noopener noreferrer";
  possibleLink.hidden = true;
  possibleBox.append(el("b", undefined, "Possible copy"), possibleText, possibleWhere, possibleOpen, possibleLink);
  /** The proof is a link to the original: in the app when it holds that token, else its public page, and always its address. */
  const showOriginal = (where: HTMLElement, open: HTMLButtonElement, link: HTMLAnchorElement, ticker: string, address: string, chain: string | undefined, held: Item | undefined): void => {
    where.textContent = `Original: ${ticker} · ${address}`;
    open.hidden = !held;
    open.textContent = `Open the original: ${ticker}`;
    const href = held ? null : originalLink(address, chain);
    link.hidden = !href;
    if (href) {
      link.href = href;
      link.textContent = `Open the original: ${ticker} (public page)`;
    }
  };

  // --- chart ---
  const chartWrap = el("section", "dschart");
  chartWrap.setAttribute("data-own-touch", "");
  const canvas = el("canvas", "dscanvas");
  const scrubTime = el("div", "dsscrub");
  const chartNote = el("div", "dschartnote");
  chartWrap.append(scrubTime, canvas, chartNote);
  const ranges = el("div", "dsranges");
  const rangeBtns = new Map<RangeId, HTMLButtonElement>();
  for (const r of RANGES) {
    const b = el("button", "dsrange", r);
    b.type = "button";
    b.addEventListener("click", () => selectRange(r));
    rangeBtns.set(r, b);
    ranges.append(b);
  }

  // --- the PINR Index ---
  const scoreSec = el("section", "dssec dsscore");
  const ringWrap = el("div", "dsring");
  const ringSvg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  ringSvg.setAttribute("viewBox", "0 0 120 120");
  const ringTrack = document.createElementNS("http://www.w3.org/2000/svg", "circle");
  const ringArc = document.createElementNS("http://www.w3.org/2000/svg", "circle");
  for (const c of [ringTrack, ringArc]) {
    c.setAttribute("cx", "60");
    c.setAttribute("cy", "60");
    c.setAttribute("r", "52");
    c.setAttribute("fill", "none");
    c.setAttribute("stroke-width", "9");
  }
  ringTrack.style.stroke = "rgba(var(--fg-rgb), 0.09)";
  ringArc.setAttribute("stroke-linecap", "round");
  ringArc.setAttribute("transform", "rotate(-90 60 60)");
  ringSvg.append(ringTrack, ringArc);
  const ringNum = el("div", "dsringnum");
  const ringWord = el("div", "dsringword", "PINR Index");
  ringWrap.append(ringSvg, ringNum, ringWord);
  const scoreSide = el("div", "dsscoreside");
  const covLine = el("div", "dscov");
  const findings = el("div", "dsfind");
  const earlyEl = makeEarlyTag();
  const socialEl = makeSocialTag();
  const noticeLine = el("div", "dsnotice", SCORE_NOTICE);
  const adviceLine = el("div", "dsadvice", ADVICE_LINE);
  scoreSide.append(earlyEl, socialEl, covLine, adviceLine, noticeLine, findings);
  scoreSec.append(ringWrap, scoreSide);

  // --- stats ---
  const statsSec = el("section", "dssec");
  statsSec.append(el("h2", "dsh", "Stats"));
  const statsGrid = el("div", "dsstats");
  statsSec.append(statsGrid);

  // --- the dossier: checks, evidence, written read, links (filled from /api/dossier) ---
  const tradesSec = el("section", "dssec");
  tradesSec.append(el("h2", "dsh", "Recent trades"));
  const tradesBody = el("div", "dstrades");
  tradesSec.append(tradesBody);
  // the coin's pool events, observed on chain, newest first, each with its transaction.
  const poolSec = el("section", "dssec");
  poolSec.append(el("h2", "dsh", "Pool"));
  const poolBody = el("div", "dspool");
  poolSec.append(poolBody);
  const checksSec = el("section", "dssec");
  checksSec.append(el("h2", "dsh", "Checks"));
  const checksBody = el("div", "dschecks");
  checksSec.append(checksBody);
  // PINRbot's read: shown only when the bot has read this coin; hidden otherwise.
  const intentSec = el("section", "dssec");
  intentSec.hidden = true;
  intentSec.append(el("h2", "dsh", "PINRbot's read"));
  const intentBody = el("div", "dsintent");
  intentSec.append(intentBody);
  // The public daily PINRbot budget: a percentage and whether the bot runs, never a dollar figure.
  const budgetSec = el("section", "dssec");
  budgetSec.hidden = true;
  budgetSec.append(el("h2", "dsh", "PINRbot's daily budget"));
  const budgetBody = el("div", "dsbudget");
  budgetSec.append(budgetBody);
  const factsSec = el("section", "dssec");
  factsSec.append(el("h2", "dsh", "Evidence"));
  const factsBody = el("div", "dsfacts");
  factsSec.append(factsBody);
  const readSec = el("section", "dssec");
  readSec.append(el("h2", "dsh", "The read"));
  const readBody = el("div", "dsread");
  readSec.append(readBody);
  const socialSec = el("section", "dssec");
  socialSec.append(el("h2", "dsh", "Social and callouts"));
  const linksBody = el("div", "dssocial");
  socialSec.append(linksBody);

  // --- similar tokens: same chain, close in size and age (measured facts only) ---
  const similarSec = el("section", "dssec");
  similarSec.append(el("h2", "dsh", "Similar tokens"));
  const similarBody = el("div", "dssimilar");
  similarSec.append(similarBody);

  const fine = el("p", "dsfine", "Everything on this page is a measured reading or a dash. A dash means it was not measured. PINR is a research tool, not investment advice. ");
  // --- Social (not scored): what posts say about the coin against what the dossier shows (the scanner's file; nothing here feeds a score) ---
  const scanSec = el("section", "dssec");
  // while the score is hidden this section is plain "Social", with no word of a score.
  scanSec.append(el("h2", "dsh", scoreShown() ? "Social (not scored)" : "Social"));
  if (scoreShown()) scanSec.append(el("p", "dsscannote", `${SCORE_NOTICE} Nothing here moves the score.`));
  const scanBody = el("div", "dsscan");
  scanSec.append(scanBody);
  page.append(hero, vampBox, possibleBox, chartWrap, ranges, scoreSec, tradesSec, checksSec, factsSec, readSec, socialSec, scanSec, similarSec, statsSec, fine);

  // --- the bottom bar ---
  const bar = el("div", "dsbar");
  const barText = el("div", "dsbarl");
  const barLabel = el("span", undefined, "24h volume");
  const barValue = el("b");
  barText.append(barLabel, barValue);
  const copyBtn = el("button", "dscopy", "Copy contract");
  copyBtn.type = "button";
  bar.append(barText, copyBtn);

  scroller.append(mini, empty, page, bar);
  // The dossier's own wrapper, filled when the DeepScan page takes the dossier over (mountDossier).
  const dossierWrap = el("div", "dsdossier");

  attachPageGestures(root, scroller, opts);
  const place = createPlacer(root, frame, scroller, () => {});

  // ------------------------------------------------------------------ state ---
  let item: Item | null = null;
  let range: RangeId = "1D";
  const charts = new Map<RangeId, ChartState>();
  let scrubIndex = -1;
  let lastDrawKey = "";
  let lastUpdate = 0;
  let liveFrame = 0;
  let fetchEpoch = 0;
  let dossier: Dossier | null = null;
  let dossierState: "loading" | "ok" | "error" = "loading";
  let dossierAt = 0;
  /** When this coin's own figures were last asked for. */
  let detailAt = 0;
  let detailFor: Item | null = null;
  /** The early mark the shown dossier was fetched under: an early score's check bands must not outlive it (fetched again when the mark changes). */
  let dossierEarly = false;
  let tradesState: TradesState = "loading";
  let tradesView: TradesView | null = null;
  let tradesAt = 0;

  const chartOf = (r: RangeId): ChartState => charts.get(r) ?? emptyChart();

  function selectRange(r: RangeId): void {
    range = r;
    scrubIndex = -1;
    for (const [id, b] of rangeBtns) b.classList.toggle("on", id === r);
    lastDrawKey = "";
    void load(r, false);
    render();
  }

  /** Get a range's candles from the feed server. A token with no address has no chart in production (missing stays missing); in dev mode and tests a made-up token draws its own series. */
  async function load(r: RangeId, silent: boolean): Promise<void> {
    const it = item;
    if (!it) return;
    const epoch = fetchEpoch;
    if (!it.address) {
      if (!import.meta.env.DEV) {
        charts.set(r, { candles: [], status: "none", source: null, fetchedAt: Date.now() });
        return;
      }
      const span = r === "1D" ? 86400 : r === "1W" ? 7 * 86400 : r === "1M" ? 30 * 86400 : r === "3M" ? 90 * 86400 : 120 * 86400;
      charts.set(r, { candles: candlesFromSeries(it.chart, Date.now() / 1000, span), status: it.chart.length >= 2 ? "ok" : "none", source: "simulated", fetchedAt: Date.now(), simulated: true });
      return;
    }
    if (!silent) charts.set(r, { ...chartOf(r), status: chartOf(r).status === "stale" ? "stale" : chartOf(r).candles.length ? "ok" : "loading" });
    const res = await opts.fetchChart(it.address, r);
    if (epoch !== fetchEpoch) return; // another token was opened meanwhile
    charts.set(r, { candles: res.candles, status: res.status, source: res.source, fetchedAt: Date.now(), ...(res.asOfMs !== undefined ? { asOfMs: res.asOfMs } : {}) });
    lastDrawKey = "";
    render();
  }

  async function loadTrades(): Promise<void> {
    const it = item;
    if (!it) return;
    tradesAt = Date.now();
    if (!it.address) {
      tradesState = "ok";
      tradesView = { none: true, trades: [], complete: false, coversFrom: null, asOf: null, summary: null };
      return renderTrades(tradesBody, tradesState, tradesView);
    }
    const epoch = fetchEpoch;
    const got = await opts.fetchTrades(it.address);
    if (epoch !== fetchEpoch) return;
    tradesState = got ? "ok" : "error";
    tradesView = got;
    renderTrades(tradesBody, tradesState, tradesView);
  }

  /** The small line under a figure: its public source, how long ago it was read, and a link to look. A figure without a source says so. */
  function receiptLine(source: string | null, readAtMs: number | null, link: string | null): HTMLElement {
    const line = el("div", "dsrcpt");
    const ago = readAtMs !== null ? scoredAgo(readAtMs, Date.now()) : null;
    if (!source || ago === null) {
      line.append(el("span", "dsnosrc", "no source"));
      return line;
    }
    line.append(el("span", undefined, `${source} · read ${ago}`));
    if (link) {
      const a = document.createElement("a");
      a.href = link;
      a.target = "_blank";
      a.rel = "noopener noreferrer";
      a.textContent = "View";
      line.append(a);
    }
    return line;
  }

  async function loadDossier(): Promise<void> {
    const it = item;
    if (!it) return;
    if (!it.address) {
      dossier = null;
      dossierState = "ok";
      return renderDossier();
    }
    const epoch = fetchEpoch;
    dossierAt = Date.now();
    dossierEarly = showsEarly(it);
    const got = await opts.fetchDossier(it.address);
    if (epoch !== fetchEpoch) return;
    dossier = got;
    dossierState = got ? "ok" : "error";
    renderDossier();
  }

  /** the Pool section, from the dossier's `pool` (observed on chain, ●); missing stays missing. */
  function renderPool(): void {
    const p = dossier?.pool;
    if (dossierState === "loading") return poolBody.replaceChildren(el("p", "dsnone", "Loading…"));
    if (!p || p.state === "none") {
      // No pool-events file (Base, BNB): what the evidence file holds about the pool is shown instead, each row marked ● (read on chain) or ○ (reported), and "no receipt link yet" where it has none.
      const rows = dossier?.poolRows ?? [];
      if (!rows.length) return poolBody.replaceChildren(el("p", "dsnone", noPoolWords(item?.launchpad)));
      const lines = rows.map((x) => {
        const r = el("div", "dspoolrow");
        const dot = el("span", "dsdot", x.onchain ? "●" : "○"); // ● read on chain, ○ reported
        dot.title = x.onchain ? "Read on chain" : "Reported, not read on chain";
        const unit = x.unit ? ` ${x.unit}` : "";
        const val = x.value === null ? "" : ` · ${typeof x.value === "number" && x.unit === "share of pool value" ? `${Math.round(x.value * 100)}%` : x.value}${typeof x.value === "number" && x.unit === "share of pool value" ? " of the pool's value" : unit}`;
        r.append(dot, el("b", undefined, x.what.charAt(0).toUpperCase() + x.what.slice(1)), el("span", "dspoolwhat", `${val} · ${x.source ?? "source not stated"}`));
        if (x.link) r.append(el("span", "dspoolwhat", " · "), linkEl(x.link, "View receipt"));
        else r.append(el("span", "dspoolwhat", " · no receipt link yet"));
        return r;
      });
      return poolBody.replaceChildren(...lines, el("p", "dsnone", "From this coin's evidence file. Pool events are not read for this coin yet."));
    }
    if (!p.events.length) return poolBody.replaceChildren(el("p", "dsnone", "No pool events observed."));
    const short = (a: string): string => `${a.slice(0, 4)}…${a.slice(-4)}`;
    const scan = p.chain === "bnb" ? "https://bscscan.com" : p.chain === "base" ? "https://basescan.org" : "https://solscan.io";
    const acct = (a: string): HTMLAnchorElement => linkEl(`${scan}/${p.chain === "solana" ? "account" : "address"}/${a}`, short(a));
    const amt = (n: number): string => (n >= 1e9 ? `${(n / 1e9).toFixed(2)}B` : n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}K` : n >= 1 ? n.toFixed(2) : n.toLocaleString("en-US", { maximumSignificantDigits: 3, maximumFractionDigits: 12 }));
    const rows = p.events.map((e) => {
      const r = el("div", "dspoolrow");
      r.append(el("span", "dsdot", "●"), el("b", undefined, e.kind.charAt(0).toUpperCase() + e.kind.slice(1)));
      const what: string[] = [];
      // Raw units (the engine did not read the decimals) are said as such, so a raw count is never read as a real amount.
      const coin = e.base !== undefined ? (e.raw ? `${amt(e.base)} raw token units` : `${amt(e.base)} tokens`) : "";
      const q = e.quote !== undefined ? (e.raw ? `${amt(e.quote)} raw ${e.quoteSymbol} units` : `${amt(e.quote)} ${e.quoteSymbol}`) : "";
      if (e.kind === "bought back and burned") what.push([coin && `${coin} burned`, q && `for ${q}`].filter(Boolean).join(" "));
      else if (e.kind === "pool created") {
        const pb = e.poolBase !== undefined ? (e.raw ? `${amt(e.poolBase)} raw token units` : `${amt(e.poolBase)} tokens`) : coin;
        const pq = e.poolQuote !== undefined ? (e.raw ? `${amt(e.poolQuote)} raw ${e.quoteSymbol} units` : `${amt(e.poolQuote)} ${e.quoteSymbol}`) : q;
        what.push([pq, pb].filter(Boolean).join(" and "));
      } else if (e.kind !== "coin creator changed") what.push([q, coin].filter(Boolean).join(" and "));
      for (const w of what) if (w) r.append(el("span", "dspoolwhat", ` · ${w}`));
      if (e.kind === "coin creator changed") {
        r.append(el("span", "dspoolwhat", " · "));
        if (e.oldCreator) r.append(el("span", undefined, "from "), acct(e.oldCreator), el("span", undefined, " "));
        if (e.newCreator) r.append(el("span", undefined, "to "), acct(e.newCreator));
      }
      if (e.user && e.kind !== "coin creator changed") r.append(el("span", "dspoolwhat", " · by "), acct(e.user));
      r.append(el("span", "dspoolwhen", ` · ${when(e.atMs)} · `), linkEl(`${scan}/tx/${e.sig}`, "View transaction"));
      return r;
    });
    const foot = el("p", "dsnone", `Observed on chain${p.source ? ` (${p.source})` : ""}${p.asOfMs ? `, read ${when(p.asOfMs)}` : ""}. Pool history from before PINR listed the coin is not read yet.`);
    poolBody.replaceChildren(...rows, foot);
  }

  /** The band as words: the engine's own while the score is shown, else what was observed. */
  const bandWords = (b: string): string => (scoreShown() ? b : observedWords(b));
  const bandClass = (b: string): string => (!scoreShown() ? (observedWords(b) === "worth a closer look" ? "weak" : "none") : b === "Strong" ? "good" : b === "Fair" ? "fair" : b === "Weak" ? "weak" : b === "Clear" ? "clear" : "none");
  // one clock on the coin page: the viewer's own, as Recent trades shows it (W2)
  const when = (ms: number): string => new Date(ms).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
  const RESULT_WORDS: Record<SocialClaim["result"], string> = { MATCHES: "Matches the dossier", DIVERGES: "Differs from the dossier", UNVERIFIABLE: "Cannot be checked against the dossier", "NOT CHECKABLE": "An opinion or promise, not checkable" };
  function linkEl(url: string, text: string): HTMLAnchorElement {
    const a = el("a", "dslink", text);
    a.href = url;
    a.target = "_blank";
    a.rel = "noopener noreferrer nofollow";
    return a;
  }
  /** The scanner's file for this coin, as the server cleaned it: flags first, then each claim as written with its post, time and link. */
  function renderSocialScan(): void {
    const note = (text: string): void => scanBody.replaceChildren(el("p", "dsnone", text));
    if (dossierState === "loading") return note("Loading…");
    if (dossierState === "error") return note("The social scan is not read yet. PINR asks again shortly.");
    const sc = dossier?.social;
    if (!sc) return note("No social scan has been run for this coin yet. Nothing is claimed either way.");
    const rows: HTMLElement[] = [];
    for (const f of sc.flags) {
      const row = el("div", "dsscanflag");
      row.append(el("p", "dsscanflagt", f.text));
      const line = el("div", "dsrcpt");
      const ago = f.readAtMs !== null ? scoredAgo(f.readAtMs, Date.now()) : null;
      line.append(el("span", undefined, f.source && ago ? `${f.source} · read ${ago}` : "no source"));
      if (f.link) line.append(linkEl(f.link, "View"));
      row.append(line);
      rows.push(row);
    }
    const t = sc.totals;
    const total = t.MATCHES + t.DIVERGES + t["UNVERIFIABLE"] + t["NOT CHECKABLE"];
    rows.push(el("p", "dsscansum", total ? `${total} claim${total === 1 ? "" : "s"} read: ${t.MATCHES} match, ${t.DIVERGES} differ, ${t.UNVERIFIABLE} cannot be checked, ${t["NOT CHECKABLE"]} not checkable.` : "No claims were recorded."));
    for (const c of sc.claims) {
      const row = el("div", "dsscanclaim");
      row.append(el("b", `dsscanres r${c.result.replace(/\s/g, "").toLowerCase()}`, RESULT_WORDS[c.result]), el("p", "dsscanline", c.line));
      const line = el("div", "dsrcpt");
      const ago = c.readAtMs !== null ? scoredAgo(c.readAtMs, Date.now()) : null;
      line.append(el("span", undefined, `${c.handle ? `@${c.handle} · ` : ""}${c.postedAtMs !== null ? `posted ${when(c.postedAtMs)}` : "post time unknown"}${ago ? ` · read ${ago}` : ""}`));
      if (c.removed) line.append(el("span", "dsnosrc", "post removed"));
      else if (c.postUrl) line.append(linkEl(c.postUrl, "View post"));
      if (c.dossierLink) line.append(linkEl(c.dossierLink, "View fact"));
      row.append(line);
      rows.push(row);
    }
    if (sc.gaps.length) {
      rows.push(el("p", "dssocialh", "Not read"));
      const ul = el("ul", "dsnotm");
      for (const g of sc.gaps) ul.append(el("li", undefined, g));
      rows.push(ul);
    }
    scanBody.replaceChildren(...rows);
  }

  /** PINRbot's note and the receipts behind each item. Everything is set as text; a link only where the server gave one. */
  function renderIntent(d: Dossier): void {
    const v = d.intent;
    if (!scoreShown() || !v || d.held || d.seen) {
      intentSec.hidden = true;
      return;
    }
    intentSec.hidden = false;
    const ago = v.readAtMs !== undefined ? scoredAgo(v.readAtMs, Date.now()) : null;
    const head = el("p", "dsnone", `${ago ? `Read ${ago}. ` : ""}${v.kept ? "An earlier reading, kept until the coin is read again." : ""}`.trim());
    if (!v.items.length) {
      intentBody.replaceChildren(head, el("p", "dsnone", "No evidence found."));
      return;
    }
    intentBody.replaceChildren(
      head,
      ...v.items.map((it) => {
        const box = el("div", "dsintitem");
        box.append(el("div", "dsinthead", `PINRbot read: ${it.label}`));
        if (it.receipts.length) box.append(el("div", "dsrcpt", "Evidence:"));
        for (const r of it.receipts) {
          const rago = r.readAtMs !== undefined ? scoredAgo(r.readAtMs, Date.now()) : null;
          const line = el("div", "dsrcpt");
          line.append(el("span", undefined, `${r.what}${r.value ? `: ${r.value}` : ""} · ${r.source}${r.onChain ? " · chain" : ""}${rago ? ` · read ${rago}` : ""}`));
          if (r.link) {
            const a = document.createElement("a");
            a.href = r.link;
            a.target = "_blank";
            a.rel = "noopener noreferrer";
            a.textContent = "View";
            line.append(a);
          }
          box.append(line);
        }
        box.append(el("div", "dsrcpt", it.reviewed ? "Reviewed: yes" : "not reviewed yet"));
        return box;
      }),
    );
  }

  let budgetAt = 0;
  /** The meter is read when the dossier opens, at most once a minute; a budget that is not known hides the section (nothing invented). */
  async function loadBudget(): Promise<void> {
    if (!scoreShown()) {
      budgetSec.hidden = true; // PINRbot and its budget are hidden, not deleted
      return;
    }
    if (!opts.fetchBudget || Date.now() - budgetAt < 60_000) return;
    budgetAt = Date.now();
    const b = await opts.fetchBudget().catch(() => null);
    if (!b) {
      budgetSec.hidden = true;
      return;
    }
    budgetSec.hidden = false;
    const bar = el("div", "dsbudgetbar");
    const fill = el("i");
    fill.style.width = `${b.status === "on" ? b.usedPct : 0}%`;
    bar.append(fill);
    budgetBody.replaceChildren(
      el("p", "dsnone", b.status === "on" ? `${b.usedPct}% of today's PINRbot budget is used. It resets each day.` : "PINRbot is not running yet."),
      ...(b.status === "on" ? [bar] : []),
    );
  }

  function renderDossier(): void {
    void loadBudget();
    renderSocialScan();
    renderPool();
    intentSec.hidden = true;
    const d = dossier;
    const note = (host: HTMLElement, text: string): void => host.replaceChildren(el("p", "dsnone", text));
    if (dossierState === "loading") {
      for (const h of [checksBody, factsBody, readBody, linksBody]) note(h, "Loading…");
      return;
    }
    if (dossierState === "error") {
      for (const h of [checksBody, factsBody, readBody, linksBody]) note(h, "Not read yet. PINR asks again shortly.");
      return;
    }
    if (!d || !d.available) {
      for (const h of [checksBody, factsBody, readBody, linksBody]) note(h, "No evidence file for this token yet.");
      return;
    }
    if (d.held === "flagged") note(checksBody, "This token carries a label and no score. Its checks are not shown.");
    else if (d.seen) note(checksBody, "Not scored yet: the checks are read when the coin is scored.");
    else if (!d.checks.length) note(checksBody, "No checks were read for this token yet.");
    else
      checksBody.replaceChildren(
        ...d.checks.map((c) => {
          const row = el("div", "dscheck");
          row.append(el("span", undefined, c.name), el("b", `dsband ${bandClass(c.band)}`, c.reason ? `${bandWords(c.band)} · ${c.reason}` : bandWords(c.band)));
          // the check's receipt (source, time read, link) under it, when the engine gave one.
          if (!c.source || c.readAtMs === undefined || !c.link) return row;
          const wrap = el("div", "dscheckw");
          wrap.append(row, receiptLine(c.source, c.readAtMs, c.link));
          return wrap;
        }),
      );
    if (!d.facts.length) note(factsBody, "No chain facts read yet.");
    else
      factsBody.replaceChildren(
        ...d.facts.map((f) => {
          const row = el("div", "dsfact");
          const head = el("div", "dsfhead");
          head.append(el("span", "dsstatl", f.label), el("b", "dsstatv", f.value));
          if (f.badge) head.append(el("b", "dsband weak dsfbadge", f.badge));
          row.append(head, f.notRead ? el("div", "dsrcpt", "not read yet") : receiptLine(f.noSource ? null : (f.source ?? null), f.readAtMs ?? null, f.link ?? null));
          // which fee case applied and why, in plain sentences
          for (const l of f.lines ?? []) row.append(el("div", "dsfline", l));
          if (f.moreLinks?.links.length) {
            // links to look at: the launches an observed standard was seen on, or the dev group's wallets that were paid fees
            const line = el("div", "dsrcpt", `${f.moreLinks.lead} `);
            f.moreLinks.links.forEach((k, i) => {
              const a = document.createElement("a");
              a.href = k.url;
              a.target = "_blank";
              a.rel = "noopener noreferrer";
              a.textContent = k.label;
              if (i) line.append(", ");
              line.append(a);
            });
            row.append(line);
          }
          if (f.copy) {
            const b = el("button", "dsfcopy", "Copy");
            b.type = "button";
            b.addEventListener("click", async () => {
              try {
                await navigator.clipboard.writeText(f.copy!);
                b.textContent = "Copied";
              } catch {
                b.textContent = "Hold to copy";
              }
              setTimeout(() => (b.textContent = "Copy"), 1600);
            });
            head.append(b);
          }
          return row;
        }),
      );
    if (!d.read.length) note(readBody, "No notes from the engine for this token.");
    else readBody.replaceChildren(...d.read.map((t) => el("p", "dsreadp", t)));
    renderIntent(d);
    renderSocial(d);
  }

  /** Where the token says it can be found, what PINR checks about those links, and (plainly) what is not measured. */
  function renderSimilar(): void {
    similarBody.replaceChildren();
    const list = item ? similarTokens(item, opts.items()) : [];
    if (list.length === 0) {
      similarBody.append(el("div", "dssimnone", "No close matches yet. Tokens are matched on chain, launchpad, size and age, and only when those are measured."));
      return;
    }
    for (const t of list) {
      const row = el("button", "dssimrow");
      row.type = "button";
      const pic = el("div", "dssimpic");
      if (t.image) pic.append(pictureOf(t.image, t.name, t.address));
      else pic.textContent = avatarChar(t.name);
      const names = el("div", "dssimname");
      names.append(el("b", undefined, t.ticker), el("span", undefined, `${money(t.mcap)} · ${ageText(t.ageMin)} old`));
      const look = statusLook(t);
      const sc = el("div", "dssimscore", look.text);
      if (look.numeric) sc.style.color = scoreColor(Number(t.value));
      row.append(pic, names, sc);
      row.addEventListener("click", () => choose(t));
      similarBody.append(row);
    }
  }

  function renderSocial(d: Dossier): void {
    const rows: HTMLElement[] = [];
    rows.push(el("p", "dssocialh", "Where this token lists itself"));
    for (const c of d.channels) {
      const row = el("div", "dscheck");
      row.append(el("span", undefined, c.label));
      if (c.status === "listed" && c.url) {
        const a = el("a", "dslink dslinkin", c.post ? `A post by @${c.post} · open` : "Listed · open");
        a.href = c.url;
        a.target = "_blank";
        a.rel = "noopener noreferrer nofollow";
        row.append(a);
      } else row.append(el("b", `dsband ${c.status === "unknown" ? "none" : "weak"}`, c.status === "unknown" ? "Not read" : "Not listed"));
      rows.push(row);
    }
    if (d.channels.every((c) => c.status === "unknown")) rows.push(el("p", "dsnone", "PINR has not read this token's links yet (Solana tokens carry none so far), so nothing is claimed either way."));
    // What the launchpad's own record lists, beside the token's own links, never in their place.
    if (d.launchpadLinks) {
      rows.push(el("p", "dssocialh", `What ${d.launchpadLinks.source} lists for it`));
      for (const k of d.launchpadLinks.links) {
        const row = el("div", "dscheck");
        const a = el("a", "dslink dslinkin", "Listed · open");
        a.href = k.url;
        a.target = "_blank";
        a.rel = "noopener noreferrer nofollow";
        row.append(el("span", undefined, k.label), a);
        rows.push(row);
      }
      rows.push(receiptLine(d.launchpadLinks.source, d.launchpadLinks.readAtMs, null));
    }
    const link = d.checks.find((c) => c.name === "Social link");
    if (link) {
      const row = el("div", "dscheck");
      row.append(el("span", undefined, "Links lead back to the token"), el("b", `dsband ${bandClass(link.band)}`, bandWords(link.band)));
      rows.push(row);
    } else if (d.held === "flagged") rows.push(el("p", "dsnone", "This token carries a label, so its checks are not shown."));
    rows.push(el("p", "dssocialh", "Not measured yet"));
    const ul = el("ul", "dsnotm");
    for (const t of ["Follower counts and how old the accounts are", "How active the posts are, and who engages with them", "Callouts: other accounts or tapes mentioning the token"]) ul.append(el("li", undefined, t));
    rows.push(ul, el("p", "dsnone", "PINR does not read these yet. They are shown as not measured, never as zero, and they do not move the score."));
    linksBody.replaceChildren(...rows);
  }

  function setItem(given: Item | null | undefined): void {
    const next = given ?? null;
    const same = next !== null && item !== null && next.id === item.id;
    item = next;
    root.classList.toggle("hastoken", next !== null);
    dossierWrap.classList.toggle("hastoken", next !== null);
    if (next === null) return render();
    if (same) return render();
    fetchEpoch++;
    // THE VAMP GATE: nothing is asked for a copy (the server would refuse anyway).
    const vamp = next.flagKind === "VAMP";
    root.classList.toggle("isvamp", vamp);
    dossierWrap.classList.toggle("isvamp", vamp);
    vampNote.textContent = next.findings.join(" · ");
    vampIntroEl.textContent = vampIntro(next.copyProof);
    const pc = next.possibleCopy;
    possibleBox.hidden = !pc;
    if (pc) {
      possibleText.textContent = possibleLine(pc, next.coverage > 0 && next.value !== "—");
      const orig = opts.items().find((i) => i.address?.toLowerCase() === pc.address.toLowerCase());
      showOriginal(possibleWhere, possibleOpen, possibleLink, pc.ticker, pc.address, next.chain, orig);
    }
    // The original, when the app holds it, opens from here: the copy points to what it copied.
    const original = vamp && next.copyOfAddress ? opts.items().find((i) => i.address?.toLowerCase() === next.copyOfAddress!.toLowerCase()) : undefined;
    if (vamp && next.copyOfAddress) showOriginal(vampWhere, vampOpen, vampLink, next.copyOf ?? "the original", next.copyOfAddress, next.chain, original);
    else {
      vampOpen.hidden = true;
      vampLink.hidden = true;
      vampWhere.textContent = "";
    }
    dossier = null;
    dossierState = "loading";
    tradesState = "loading";
    tradesView = null;
    renderTrades(tradesBody, tradesState, tradesView);
    if (!vamp) {
      void loadDossier();
      void loadTrades();
    }
    renderDossier();
    renderSimilar();
    charts.clear();
    range = "1D";
    scrubIndex = -1;
    lastDrawKey = "";
    for (const [id, b] of rangeBtns) b.classList.toggle("on", id === "1D");
    scroller.scrollTop = 0;
    // identity
    badge.set(next);
    avatar.replaceChildren();
    if (next.image) avatar.append(pictureOf(next.image, next.name, next.address));
    else avatar.textContent = avatarChar(next.name);
    if (!vamp)
      void load("1D", false).then(() => {
        // the stats also use the day's candles, so a second range is fetched in the background if the first was something else
      });
    render();
  }

  // ----------------------------------------------------------------- render ---
  function currentCandles(): Candle[] {
    return chartOf(range).candles;
  }

  function setText(e: HTMLElement, t: string): void {
    if (e.textContent !== t) e.textContent = t;
  }

  function render(): void {
    if (!item) return;
    const it = item;
    const cs = currentCandles();
    const sum = summarize(cs);
    const day = summarize(chartOf("1D").candles);
    const idx = scrubIndex >= 0 && scrubIndex < cs.length ? scrubIndex : cs.length - 1;
    // The headline price is the quote source's (DexScreener's main pair: the same pair its market cap comes from) unless a point on the chart is being
    // scrubbed; the chart's last candle is used only when there is no quote price. So price and market cap can never come from different pairs.
    const scrubbing = scrubIndex >= 0 && scrubIndex < cs.length;
    const quotePx = Number.isFinite(it.priceUsd) && it.priceUsd > 0 ? it.priceUsd : NaN;
    const fromQuote = !scrubbing && Number.isFinite(quotePx);
    const px = fromQuote ? quotePx : cs.length ? cs[idx]![4] : NaN;

    setText(tickerEl, it.ticker !== "—" ? it.ticker : it.detail);
    setText(nameEl, it.name);
    setText(miniName, it.name);

    // price + change for the range (or up to the point being scrubbed)
    const base = sum ? sum.open : NaN;
    const simulated = isSim(chartOf(range));
    const priceText0 = simulated ? "—" : formatPrice(px);
    // The headline price carries its receipt too: the chart's source when the price is a candle's, else the quote provider's. With none it is a dash, not read yet.
    const chr0 = chartOf(range);
    const src0: [string | null, number | null] = simulated || priceText0 === "—" ? [null, null] : !fromQuote && cs.length && chr0.source && !isSim(chr0) ? [chr0.source === "PINR tape" ? "Pump.fun" : chr0.source, chr0.status === "stale" ? (chr0.asOfMs ?? chr0.fetchedAt) : chr0.fetchedAt] : [it.quoteSource ?? null, it.quoteAtMs ?? null];
    const priceFig = priceText0 === "—" ? { value: "—", notRead: false } : figureOrNotRead(priceText0, src0);
    const priceText = priceFig.value;
    setText(priceEl, priceText);
    setText(miniPrice, priceText);
    {
      const chr = chr0;
      const src: [string | null, number | null] = simulated || priceText === "—" ? [null, null] : !fromQuote && cs.length && chr.source && !isSim(chr) ? [chr.source === "PINR tape" ? "Pump.fun" : chr.source, chr.status === "stale" ? (chr.asOfMs ?? chr.fetchedAt) : chr.fetchedAt] : [it.quoteSource ?? null, it.quoteAtMs ?? null];
      const k = `${src[0]}|${src[1] === null ? "" : Math.floor((Date.now() - src[1]) / 60_000)}|${priceText}|${priceFig.notRead}`;
      if (priceRcpt.dataset.k !== k) {
        priceRcpt.dataset.k = k;
        priceRcpt.replaceChildren(priceFig.notRead ? el("span", "dsnosrc", "not read yet") : priceText === "—" ? "" : receiptLine(src[0], src[1], null));
      }
    }
    let pct = NaN;
    let delta = NaN;
    const lastClose = cs.length ? cs[cs.length - 1]![4] : NaN;
    // A change computed from candles of a different pair than the quote's price is not shown as theirs: the quote's own change stands in.
    const sameSeries = !fromQuote || (Number.isFinite(lastClose) && Math.abs(lastClose / px - 1) < 0.25);
    if (cs.length && Number.isFinite(base) && base > 0 && sameSeries) {
      pct = (px / base - 1) * 100;
      delta = px - base;
    } else if (fromQuote && Number.isFinite(it.change24h)) {
      pct = it.change24h;
    } else if (simulated && cs.length) {
      pct = (cs[idx]![4] / cs[0]![1] - 1) * 100;
    }
    const up = !Number.isFinite(pct) || pct >= 0;
    changeEl.classList.toggle("down", Number.isFinite(pct) && pct < 0);
    const staleChart = chartOf(range);
    const when = scrubIndex >= 0 && cs[idx] ? formatCandleTime(cs[idx]![0], range) : staleChart.status === "stale" && !fromQuote && staleChart.asOfMs !== undefined ? `${changeWindowLabel(range, it.ageMin)} · ${formatAsOf(staleChart.asOfMs)}` : changeWindowLabel(range, it.ageMin);
    setText(changeEl, Number.isFinite(pct) ? `${up ? "▲" : "▼"} ${simulated || !Number.isFinite(delta) ? "" : formatPriceChange(delta) + " "}(${signedPct(pct).replace("+", "")}) ${when}` : "—");
    setText(scrubTime, scrubIndex >= 0 && cs[idx] ? formatCandleTime(cs[idx]![0], range) : "");

    // chart note (loading / none / busy / error / source)
    const ch = chartOf(range);
    let note = "";
    if (ch.status === "loading") note = "Loading price history…";
    else if (ch.status === "none") note = it.chain === "bsc" || it.chain === "base" ? "No trades read yet." : "No chart yet.";
    else if (ch.status === "busy") note = "Chart not read yet. PINR asks again shortly.";
    else if (ch.status === "stale" && ch.asOfMs !== undefined) note = `Showing the chart ${formatAsOf(ch.asOfMs)}. PINR asks again shortly.`;
    else if (ch.status === "error") note = "Price history not read yet. PINR asks again shortly.";
    else if (isSim(ch)) note = "Simulated chart";
    else if (ch.source) note = `Price history · ${ch.source}`;
    setText(chartNote, note);
    chartNote.classList.toggle("warn", ch.status === "busy" || ch.status === "error" || ch.status === "stale");
    drawChart();

    // score
    if (!scoreShown()) {
      scoreSec.hidden = true;
      setText(ringNum, "");
      setText(covLine, "");
      findings.dataset.k = "";
      findings.replaceChildren();
    } else {
      scoreSec.hidden = false;
      const look = statusLook(it);
      const flagged = look.kind === "flag";
      if (look.numeric) {
        const sc = Number(it.value);
        setText(ringNum, it.value);
        ringNum.style.color = scoreColor(sc);
        ringArc.style.stroke = scoreColor(sc);
        const circ = 2 * Math.PI * 52;
        ringArc.setAttribute("stroke-dasharray", `${(circ * sc) / 100} ${circ}`);
        ringNum.classList.remove("flag");
      } else {
        setText(ringNum, look.text);
        ringNum.style.color = flagged ? "var(--mandarin)" : "";
        ringNum.classList.toggle("flag", flagged);
        ringArc.style.stroke = flagged ? "var(--mandarin)" : "rgba(var(--fg-rgb), 0.2)";
        ringArc.setAttribute("stroke-dasharray", flagged ? `${2 * Math.PI * 52} 0` : "0 400");
      }
      ringWrap.classList.toggle("thin", look.kind === "thin");
      setEarly(earlyEl, showsEarly(it));
      setEarly(socialEl, showsSocial(it));
      noticeLine.hidden = !look.numeric;
      adviceLine.hidden = !look.numeric;
      setText(covLine, flagged ? flagLine(it) : look.kind === "thin" && it.coverage <= 0 ? "Nothing measured yet" : `${it.coverage}% of the readings loaded${look.numeric && scoredAgo(it.scoredAtMs, Date.now()) ? ` · scored ${scoredAgo(it.scoredAtMs, Date.now())}` : ""}`);
      const want = it.findings.join("|");
      if (findings.dataset.k !== want) {
        findings.dataset.k = want;
        findings.replaceChildren(...it.findings.map((f) => el("span", "dschip", f)));
      }
    }

    // stats
    const parts = it.detail.split(" · ");
    const nowMs = Date.now();
    const val = dossier?.facts.find((f) => f.id === "valuation");
    const fs = it.figSrc ?? {};
    const rc = (r: { source: string; atMs: number } | undefined): [string | null, number | null] => (r ? [r.source, r.atMs] : [null, null]);
    const cap: [string | null, number | null] = it.capSource ? [it.capSource, it.capAtMs ?? null] : val && !val.noSource ? [val.source ?? null, val.readAtMs ?? null] : [null, null];
    const ch1d = chartOf("1D");
    const chartSrc: [string | null, number | null] = day && ch1d.source && !isSim(ch1d) ? [ch1d.source === "PINR tape" ? "Pump.fun" : ch1d.source, ch1d.fetchedAt] : [null, null];
    type Stat = [label: string, value: string, receipt?: [string | null, number | null], link?: string | null];
    const stats: Stat[] = [
      ["Market cap", money(it.mcap), cap],
      ["All-time high (market cap)", Number.isFinite(it.ath) && it.ath > 0 ? money(it.ath) : "—", Number.isFinite(it.ath) && it.ath > 0 ? [it.athSource ?? null, it.athAtMs ?? null] : [null, null], it.athLink ?? null],
      ["Liquidity", money(it.liquidity), rc(fs.liquidity)],
      // a figure a source gave beats a sum of the chart's candles (which can be thin on a young coin)
      ["24h volume", Number.isFinite(it.volume24h) ? money(it.volume24h) : day ? money(day.volume) : "—", Number.isFinite(it.volume24h) ? rc(fs.volume) : chartSrc],
      ["24h open", day ? formatPriceCompact(day.open) : "—", chartSrc],
      ["24h high", day ? formatPriceCompact(day.high) : "—", chartSrc],
      ["24h low", day ? formatPriceCompact(day.low) : "—", chartSrc],
      ["Quote pair", it.quotePair || "—", rc(fs.pair)],
      ["Age", ageText(it.ageMin)],
      ["Chain", parts[0] && !parts[0].includes("unknown") ? parts[0] : "—"],
      ["Launchpad", parts[1] && !parts[1].includes("unknown") ? parts[1] : "—"],
      ...(scoreShown() ? ([["Coverage", `${it.coverage}%`]] as Stat[]) : []), // coverage is the score's, hidden with it
      ["Contract", it.address ? shortAddress(it.address) : "—"],
    ];
    // the team, 26 Oct: a figure is shown only with its source named; with none it is a dash that says "not read yet" (never "$486 no source").
    const shownStats = stats.map(([l, v, r, k]) => {
      const f = figureOrNotRead(v, r);
      return [l, f.value, r, f.notRead, k] as [string, string, typeof r, boolean, string | null | undefined];
    });
    const key = shownStats.map((s) => `${s[1]}|${s[3] ? "n" : ""}|${s[2] ? `${s[2][0]}${s[2][1] === null ? "" : Math.floor((nowMs - s[2][1]) / 60_000)}` : ""}`).join("|");
    if (statsGrid.dataset.k !== key) {
      statsGrid.dataset.k = key;
      statsGrid.replaceChildren(
        ...shownStats.map(([l, v, rc, notRead, link]) => {
          const c = el("div", "dsstat");
          const head = el("div", "dsfhead");
          head.append(el("span", "dsstatl", l), el("b", "dsstatv", v));
          c.append(head);
          // The app's own figures carry their source and time like the engine's (a dash has nothing to source).
          if (notRead) c.append(el("div", "dsrcpt", "not read yet"));
          else if (rc && v !== "—") c.append(receiptLine(rc[0], rc[1], link ?? null));
          return c;
        }),
      );
    }
    setText(barValue, Number.isFinite(it.volume24h) ? money(it.volume24h) : day ? money(day.volume) : money(it.volume24h));
    copyBtn.disabled = !it.address;
  }

  // ------------------------------------------------------------------ chart ---
  function drawChart(): void {
    const cs = currentCandles();
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    if (!w || !h) return;
    const key = `${w}|${h}|${cs.length}|${cs.length ? cs[cs.length - 1]![4] : 0}|${scrubIndex}|${range}`;
    if (key === lastDrawKey) return;
    lastDrawKey = key;
    const dpr = Math.min(devicePixelRatio || 1, 2);
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
    }
    const c = canvas.getContext("2d")!;
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    c.clearRect(0, 0, w, h);
    if (cs.length < 2) return;
    let lo = Infinity;
    let hi = -Infinity;
    for (const k of cs) {
      lo = Math.min(lo, k[4]);
      hi = Math.max(hi, k[4]);
    }
    const open = cs[0]![1];
    lo = Math.min(lo, open);
    hi = Math.max(hi, open);
    // Huge moves are drawn on a log scale, like the Discover chart, so a +5,000% run is still readable.
    const log = hi / lo > 8;
    const f = (v: number): number => (log ? Math.log(v) : v);
    const span = Math.max(1e-12, f(hi) - f(lo));
    const padY = 22;
    const X = (i: number): number => (w * i) / (cs.length - 1);
    const Y = (v: number): number => h - padY - ((f(v) - f(lo)) / span) * (h - padY * 2);
    const up = cs[cs.length - 1]![4] >= open;
    const rgb = up ? LIME_RGB : MANDARIN_RGB;
    // dotted line at the starting price
    c.setLineDash([2, 5]);
    c.lineWidth = 1;
    c.strokeStyle = `rgba(${palette().mute},0.45)`;
    c.beginPath();
    c.moveTo(0, Y(open));
    c.lineTo(w, Y(open));
    c.stroke();
    c.setLineDash([]);
    // the line
    c.lineWidth = 2;
    c.lineJoin = "round";
    c.lineCap = "round";
    c.strokeStyle = `rgb(${rgb})`;
    c.beginPath();
    cs.forEach((k, i) => (i === 0 ? c.moveTo(X(i), Y(k[4])) : c.lineTo(X(i), Y(k[4]))));
    c.stroke();
    // the end dot, or the scrub line
    const si = scrubIndex >= 0 && scrubIndex < cs.length ? scrubIndex : cs.length - 1;
    if (scrubIndex >= 0) {
      c.strokeStyle = `rgba(${palette().text},0.4)`;
      c.lineWidth = 1;
      c.beginPath();
      c.moveTo(X(si), 4);
      c.lineTo(X(si), h - 4);
      c.stroke();
    }
    c.fillStyle = `rgb(${rgb})`;
    c.beginPath();
    c.arc(X(si), Y(cs[si]![4]), scrubIndex >= 0 ? 4.5 : 3.2, 0, Math.PI * 2);
    c.fill();
    root.style.setProperty("--ds-accent", `rgb(${rgb})`);
  }

  // press and drag (or hover) through the chart
  const scrubAt = (clientX: number): void => {
    const cs = currentCandles();
    if (cs.length < 2) return;
    const r = canvas.getBoundingClientRect();
    // clientX is in screen pixels; r.width is the on-screen width (it follows any zoom of the page), so this stays right when scaled
    const t = Math.min(1, Math.max(0, (clientX - r.left) / Math.max(1, r.width)));
    const i = Math.round(t * (cs.length - 1));
    if (i !== scrubIndex) {
      scrubIndex = i;
      render();
    }
  };
  const endScrub = (): void => {
    if (scrubIndex !== -1) {
      scrubIndex = -1;
      render();
    }
  };
  let scrubbing = false;
  canvas.addEventListener("pointerdown", (e) => {
    try {
      canvas.setPointerCapture(e.pointerId);
    } catch {
      /* not a live pointer (some automated tests): scrubbing still works without capture */
    }
    scrubbing = true;
    scrubAt(e.clientX);
  });
  canvas.addEventListener("pointermove", (e) => {
    if (e.pointerType === "mouse" || scrubbing) scrubAt(e.clientX);
  });
  const stop = (): void => {
    scrubbing = false;
    endScrub();
  };
  canvas.addEventListener("pointerup", stop);
  canvas.addEventListener("pointercancel", stop);
  canvas.addEventListener("pointerleave", (e) => {
    if (e.pointerType === "mouse") endScrub();
  });

  // the mini bar
  scroller.addEventListener("scroll", () => {
    mini.classList.toggle("on", scroller.scrollTop > priceEl.offsetTop + priceEl.offsetHeight);
  });

  copyBtn.addEventListener("click", async () => {
    if (!item?.address) return;
    try {
      await navigator.clipboard.writeText(item.address);
      copyBtn.textContent = "Copied";
    } catch {
      copyBtn.textContent = "Press and hold to copy";
    }
    setTimeout(() => (copyBtn.textContent = "Copy contract"), 1600);
  });

  return {
    el: root,
    setItem,
    place,
    mountDossier(host) {
      dossierWrap.append(vampBox, possibleBox, scoreSec, tradesSec, poolSec, checksSec, intentSec, budgetSec, factsSec, readSec, socialSec, scanSec, similarSec, statsSec, fine, bar);
      host.append(dossierWrap);
    },
    liveTrade(t) {
      if (!item?.address || item.address.toLowerCase() !== t.address.toLowerCase() || item.flagKind === "VAMP") return;
      // Recent trades: the trade goes on top, as the list's own rows are (seconds, side, dollars); the next full read (every 20 s) replaces the list.
      const row: [number, "buy" | "sell", number] = [Math.floor(t.atMs / 1000), t.side, t.usd];
      if (tradesView && !tradesView.none) tradesView = { ...tradesView, trades: [row, ...tradesView.trades].slice(0, 500) };
      else tradesView = { none: false, trades: [row], complete: false, coversFrom: row[0], asOf: null, summary: tradesView?.summary ?? null };
      tradesState = "ok";
      // The chart: the trade grows the current candle in place (or opens the next one).
      const cs = currentCandles();
      if (cs.length) {
        const bucket = cs.length > 1 ? cs[cs.length - 1]![0] - cs[cs.length - 2]![0] : RANGE_BUCKET_SEC[range] ?? 900;
        if (foldPrice(cs, bucket, t.priceUsd, t.atMs, { usd: t.usd })) lastDrawKey = "";
      }
      // One redraw per frame however many trades arrive in it (a busy coin sends bursts).
      if (liveFrame) return;
      liveFrame = requestAnimationFrame(() => {
        liveFrame = 0;
        render();
        renderTrades(tradesBody, tradesState, tradesView);
      });
    },
    update(nowSec) {
      if (nowSec - lastUpdate < 1) return;
      lastUpdate = nowSec;
      if (!item) return;
      render();
      // keep the chart fresh: the day's chart every minute, the others every few
      const ch = chartOf(range);
      const age = Date.now() - ch.fetchedAt;
      // a busy or failed answer is tried again soon; a good one is refreshed on a slower clock
      const stale = ch.status === "busy" || ch.status === "error" || ch.status === "stale" ? age > 8_000 : age > (range === "1D" ? 60_000 : 300_000);
      if (item.address && stale && ch.status !== "loading") void load(range, true);
      if (item.address && range !== "1D" && chartOf("1D").status === "loading") void load("1D", true);
      // the coin's own figures (price, market cap and liquidity receipts): at once on a new coin, then every 15 seconds
      if (item.address && opts.fetchDetail && (detailFor !== item || Date.now() - detailAt > 15_000)) {
        detailFor = item;
        detailAt = Date.now();
        void opts.fetchDetail(item);
      }
      // recent trades: every 20 seconds (8 after a failure)
      if (item.address && Date.now() - tradesAt > (tradesState === "error" ? 8_000 : 20_000)) void loadTrades();
      // the evidence: retried after a failure, refreshed every few minutes (the engine re-scores over time)
      if (item.address && dossierState !== "loading" && (showsEarly(item) !== dossierEarly || Date.now() - dossierAt > (dossierState === "error" ? 8_000 : 180_000))) void loadDossier();
    },
  };
}
