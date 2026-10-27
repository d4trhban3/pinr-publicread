import { scoreShown } from "../world/hub";
import { palette } from "./theme";
import { foldPrice, type Candle as LiveCandle } from "../world/livecandle";
import { attachPageGestures, createPlacer, type Placement } from "./pageoverlay";
import { getSort, type Filter } from "../world/filters";
import { ageText, money, rankDiscover, signedPct, type DiscoverTab } from "../world/discoverlist";
import { LIME, MANDARIN, SIZE_ALPHAS, sizeOffset } from "../engine/streams";
import { pictureOf } from "../world/cards";
import { COUNTED_DIM, flowSpeed, lastTradeText, makeFlow, lineFromTrades, prewarm, REAL_SPEED, realOf, ribbonMode, ribbonValue, spawnRate, stepFlow, stepReal, type Flow, type RibbonMode } from "../world/flow";
import { createBadge, type Badge } from "./badge";
import { flagWord } from "../world/copynote";
import { avatarChar, BADGE_VERIFIED_SRC, liveImportance, SIM, statusLook, type Item } from "../world/model";
import { scoreColor } from "../world/scorecolor";
import { BY_COUNT, BY_COUNT_TITLE, SCORE_NOTICE, makeAdviceTag, makeByCount, makeScoreTag } from "./scorenotice";
import { formatAsOf, scoredAgo } from "../world/format";
import { makeEarlyTag, makeSocialTag, setEarly, showsEarly, showsSocial } from "./earlytag";
import { EYE_OFF_ICON } from "./hidemenu";
import { moderation } from "../world/moderation";
import type { Candle } from "../../server/market";
import { tagChips } from "../world/tags";

/**
 * The Discover page: search first, then the market pulse, three tabs and a list of token rows.
 * It is a real scrolling page laid over the camera view (the camera rests on its room), so it scrolls natively.
 * The PINR wordmark and blurb scroll away; the search bar stays under the header.
 * Rows are the same black glass as the PINR tiles. All numbers are SIMULATED.
 */
export interface DiscoverOptions {
  items(): readonly Item[];
  /** the Base/BNB tab needs every coin, not only the first page (those coins are further down the list). */
  wantRest?(): void;
  /** The Base/BNB tab's coins straight from the server, filtered by chain, so the tab fills at once. */
  wantChains?(): void;
  /** look a coin up by its exact address when no loaded coin has it (a coin quiet for 24 hours is on no list). True when found. */
  find?(address: string): Promise<boolean>;
  /** What the data is called in the "updated Ns ago" line, e.g. "Simulated tape" or "Replay tape". */
  tapeName(): string;
  /** True when moving streams are switched off (in Settings, or by the device's reduce-motion): the ribbons stay empty. */
  still(): boolean;
  /** The user chose a tab here: the header filter and the PINR grid follow it. */
  onFilter(f: Filter): void;
  /** Candles for a card's chart options (15m, 1h, 4h, 1D). A failure is an answer too (`error`), never a made-up line. */
  fetchCandles(address: string, tf: ChartTf): Promise<{ status: string; source: string; candles: Candle[]; asOfMs?: number; bucketSec?: number }>;
  /** A row's Deep Scan button: open this token's dossier. */
  onDeepScan(item: Item): void;
  /** The eye-slash on a card: hide this coin (kept in this browser only). */
  onHide(item: Item): void;
  /** Every plain wheel event first; return true if it was a page swipe (then the list must not scroll). */
  /** A touch swipe sideways: go to the page next door. */
  /** Two fingers touched down, moved by `ratio` since the last move (about screen point cx, cy), or lifted: the camera zooms with them. */
  onPinchStart(): void;
  onPinch(ratio: number, cx: number, cy: number): void;
  onPinchEnd(): void;
  /** Trackpad pinch (ctrl + wheel). */
  onZoomWheel(deltaY: number, cx: number, cy: number): void;
}

export interface Discover {
  el: HTMLElement;
  /** Redraw the live parts (throttled inside). `calm` is true at home, where the ribbons run every frame. */
  update(nowSec: number, calm: boolean): void;
  /** A live price for a coin from the stream: folded into the candles its card shows, no reload. */
  livePrice(address: string, price: number, atMs: number, usd?: number): void;
  /** The header filter changed: show the matching list ("all", the base, shows Trending). */
  setFilter(f: Filter): void;
  /** Ask the list again (the user changed what is taken out). */
  refresh(): void;
  /**
   * Put the page where the camera says its room is: moved and scaled with the camera, so zooming out is the very same
   * page getting smaller. `null` hides it. `live` means it is at home and takes touches.
   */
  place(p: Placement | null, live: boolean): void;
  /** Seconds since the list was last ranked. */
  ageSeconds(): number;
}

// The ribbon is drawn larger than on a PINR tile.
const RIB_W = 132;
const RIB_H = 42;
const RIB_K = RIB_H / 22;

/** The lite chart's options: the card's own live line, or candles from the free chart source at one of these sizes. */
export type ChartTf = "15m" | "1h" | "4h" | "1D";
const CHART_TFS: ChartTf[] = ["15m", "1h", "4h", "1D"];
interface ChartView {
  tf: "Live" | ChartTf;
  kind: "line" | "candles";
}
interface Series {
  key: string;
  res: { status: string; source: string; candles: Candle[]; asOfMs?: number; bucketSec?: number } | null;
}
const SERIES_TTL_MS = 60_000;

const TABS: { id: DiscoverTab; label: string; note: string }[] = [
  { id: "trending", label: "Trending", note: "Most active right now" },
  { id: "movers", label: "Top Movers", note: "Largest 24h moves" },
  { id: "fresh", label: "Fresh Launches", note: "Under an hour old" },
  { id: "pinrscore", label: "PINRscore", note: "Scored tokens, by PINRscore" },
  { id: "chains", label: "Base/BNB", note: "New on Base and BNB Chain, newest first" },
];

const ICON_SEARCH =
  '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6.5"/><path d="M15.5 15.5L21 21"/></svg>';
const ICON_SCAN =
  '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6.5"/><path d="M15.5 15.5L21 21M8 10.5h5M10.5 8v5"/></svg>';

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

interface Row {
  root: HTMLElement;
  item: Item | null;
  name: HTMLElement;
  sub: HTMLElement;
  /** the coin's tags */
  tagsEl: HTMLElement;
  avatar: HTMLElement;
  badge: Badge;
  score: HTMLElement;
  covPct: HTMLElement;
  covWord: HTMLElement;
  earlyEl: HTMLElement;
  socialEl: HTMLElement;
  chainEl: HTMLElement;
  adviceEl: HTMLElement;
  byCountEl: HTMLElement;
  ageEl: HTMLElement;
  chg: HTMLElement;
  money: HTMLElement;
  mcVal: HTMLElement;
  athVal: HTMLElement;
  ribbon: HTMLCanvasElement;
  chart: HTMLCanvasElement;
  view: ChartView;
  viewId: number;
  series: Series | null;
  tfBtns: Map<string, HTMLButtonElement>;
  kindBtn: HTMLButtonElement;
  flow: Flow;
  flowId: number;
  seen: number;
  /** which ribbon the row is drawing, and (real) the time of the newest trade already turned into a dot */
  flowMode: RibbonMode;
  cursor: number;
  key: string;
  chartKey: string;
}

export function createDiscover(opts: DiscoverOptions): Discover {
  const root = el("div", "discover");
  root.id = "discover";
  const frame = el("div", "dframe");
  const scroller = el("div", "dscroll");

  // Hero: the wordmark and the line under it. These scroll away.
  const hero = el("section", "dhero");
  const mark = el("img", "dmark wmdark") as HTMLImageElement;
  mark.src = "/art/pinr-wordmark.svg";
  mark.alt = "PINR";
  mark.draggable = false;
  // Light mode shows the operator's light wordmark (art pack 65) instead of turning the dark one over; the CSS shows one of the two.
  const markLight = el("img", "dmark wmlight") as HTMLImageElement;
  markLight.src = "/art/pinr-wordmark-light.svg";
  markLight.alt = "PINR";
  markLight.draggable = false;
  // The wordmark wears the verified seal: the example of what a verified token's badge looks like (the blank one on every
  // token's picture is the unverified version of it).
  const markWrap = el("div", "dmarkwrap");
  const verified = el("img", "dmarkbadge") as HTMLImageElement;
  verified.src = BADGE_VERIFIED_SRC;
  verified.alt = "Verified";
  verified.title = "Verified";
  verified.draggable = false;
  markWrap.append(mark, markLight, verified);
  hero.append(
    markWrap,
    el("h1", "dtag", "clean up the trenches"),
    el(
      "p",
      "ddesc",
      "Deep scans contract architecture, custody protocol, quote pairing synergy, launchpad reward protocols, and social media posts to help traders see what the developer did, real efforts, and strategy for the endgame.",
    ),
  );

  // Search: stays under the header while the list scrolls beneath it.
  const searchWrap = el("div", "dsearchwrap");
  const search = el("form", "dsearch");
  search.setAttribute("role", "search");
  search.innerHTML = ICON_SEARCH;
  const input = el("input", "dinput");
  input.type = "search";
  input.placeholder = "Ticker, name, CA, X, social, or website";
  input.autocomplete = "off";
  input.autocapitalize = "off";
  input.spellcheck = false;
  input.setAttribute("aria-label", "Search tokens");
  input.enterKeyHint = "search";
  // (No "find the needle" button, the operator's review R4: the search runs as you type, and Enter scrolls to the list.)
  search.append(input);
  searchWrap.append(search);

  // Market pulse line.
  const pulse = el("div", "dpulse");
  const pulseTitle = el("div", "dpt");
  pulseTitle.append(el("i", "live"), document.createTextNode("TRENCHES MARKET PULSE"));
  const pulseLine = el("div", "dpl");
  const tape = el("span", "tape");
  const refresh = el("button", "drefresh", "Refresh");
  refresh.type = "button";
  pulseLine.append(tape, refresh);
  pulse.append(pulseTitle, pulseLine);

  // Tabs.
  const tabsEl = el("div", "dtabs");
  const tabBtns = new Map<DiscoverTab, HTMLButtonElement>();
  for (const t of TABS.filter((x) => scoreShown() || x.id !== "pinrscore")) {
    const b = el("button", "dtab", t.label);
    b.type = "button";
    b.addEventListener("click", () => {
      tab = t.id;
      rerank();
      // The Base/BNB tab is Discover's own: the PINR page's filter stays as it is; the rest of the list is read so its coins are there.
      if (t.id === "chains") {
        opts.wantChains?.();
        opts.wantRest?.();
      }
      else opts.onFilter(tabFilter(t.id));
    });
    tabBtns.set(t.id, b);
    tabsEl.append(b);
  }
  const note = el("div", "dnote");

  const list = el("div", "dlist");
  const empty = el("div", "dempty");
  empty.hidden = true;
  list.append(empty);

  const body = el("section", "dbody");
  body.append(pulse, tabsEl, note, list);
  scroller.append(hero, searchWrap, body);
  frame.append(scroller);
  root.append(frame);

  // Rows are built once and reused: a re-rank only repoints them.
  const rows: Row[] = [];
  function makeRow(): Row {
    const r = el("div", "drow");
    const top = el("div", "dtop");
    const avatar = el("div", "avatar");
    // The picture wears its pair and launchpad logos in the lower-right corner.
    const avwrap = el("div", "avwrap");
    const badge = createBadge();
    avwrap.append(avatar, badge.el);
    const idt = el("div", "idtxt");
    const name = el("div", "name");
    const sub = el("div", "tick");
    const tagsEl = el("div", "dtags");
    idt.append(name, sub, tagsEl);
    // The data ribbon beside the score: the same lime (buy) / mandarin (sell) trade streaks as a PINR tile.
    const ribbon = el("canvas", "dribbon");
    ribbon.width = RIB_W * 2;
    ribbon.height = RIB_H * 2;
    const sc = el("div", "dscore");
    const score = el("span", "val");
    const cov = el("div", "cov");
    const covPct = el("b");
    const covWord = el("i", undefined, "coverage");
    const earlyEl = makeEarlyTag();
    const socialEl = makeSocialTag();
    const chainEl = makeScoreTag();
    const ageEl = el("i", "scoredage");
    ageEl.hidden = true;
    const byCountEl = makeByCount();
    const adviceEl = makeAdviceTag();
    cov.append(earlyEl, socialEl, covPct, covWord, chainEl, adviceEl, ageEl, byCountEl);
    sc.append(score, cov);
    // The card, in three columns: the left side is the PINR tile (picture, name, ticker, market cap, all-time high), the lite
    // chart sits in the middle, and the details are on the right (ribbon, score, coverage and what they rest on).
    const ident = el("div", "dident");
    ident.append(avwrap, idt);
    // Hide this coin: an eye-slash at the end of the name row. It never opens the card.
    const hideBtn = el("button", "dhide");
    hideBtn.type = "button";
    hideBtn.setAttribute("aria-label", "Hide this coin");
    hideBtn.title = "Hide this coin";
    hideBtn.innerHTML = EYE_OFF_ICON;
    hideBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      if (row.item) opts.onHide(row.item);
    });
    ident.append(hideBtn);
    const figs = el("div", "dfigs");
    const mcRow = el("div", "dfig");
    const mcVal = el("b");
    mcRow.append(el("i", undefined, "MC"), mcVal);
    const athRow = el("div", "dfig");
    const athVal = el("b");
    athRow.append(el("i", undefined, "ATH"), athVal);
    figs.append(mcRow, athRow);
    const left = el("div", "dleft");
    // The buy/sell ribbon sits in the left column, between the name and the figures.
    left.append(ident, ribbon, figs);
    // A classic light line chart of the last 24h, in the middle of the card.
    const chart = el("canvas", "dchart");
    // The lite chart's options (tapping them never opens the card): the live line, or candles at 15m / 1h / 4h / 1D, as a line or as candles.
    const wrap = el("div", "dchartwrap");
    const optBar = el("div", "dchopts");
    const tfBtns = new Map<string, HTMLButtonElement>();
    for (const t of ["Live", ...CHART_TFS]) {
      const b = el("button", "dchopt", t);
      b.type = "button";
      b.addEventListener("click", (e) => {
        e.stopPropagation();
        pickOption(row, t as ChartView["tf"], null);
      });
      tfBtns.set(t, b);
      optBar.append(b);
    }
    const kindBtn = el("button", "dchopt dchkind", "Candles");
    kindBtn.type = "button";
    kindBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      pickOption(row, null, row.view.kind === "line" ? "candles" : "line");
    });
    optBar.append(kindBtn);
    wrap.append(optBar, chart);
    const right = el("div", "dright");
    right.append(sc);
    top.append(left, wrap, right);

    const bot = el("div", "dbot");
    const chg = el("b", "dchg");
    const mny = el("span", "dmoney");
    const scan = el("button", "dscan");
    scan.type = "button";
    scan.innerHTML = `${ICON_SCAN}<span>Deep Scan</span>`;
    scan.addEventListener("click", (e) => {
      e.stopPropagation(); // the card itself opens DeepScan too: one tap, one open
      if (row.item) opts.onDeepScan(row.item);
    });
    bot.append(chg, mny, scan);
    r.append(top, bot);
    // Tapping anywhere on the card opens that token's DeepScan page, the same as tapping a tile on the PINR page.
    r.setAttribute("role", "button");
    r.tabIndex = 0;
    r.addEventListener("click", () => {
      if (row.item) opts.onDeepScan(row.item);
    });
    r.addEventListener("keydown", (e) => {
      if ((e.key === "Enter" || e.key === " ") && e.target === r && row.item) {
        e.preventDefault();
        opts.onDeepScan(row.item);
      }
    });
    const row: Row = { root: r, item: null, name, sub, tagsEl, avatar, badge, score, covPct, covWord, earlyEl, socialEl, chainEl, adviceEl, byCountEl, ageEl, chg, money: mny, ribbon, chart, view: { tf: "Live", kind: "line" }, viewId: -1, series: null, tfBtns, kindBtn, mcVal, athVal, flow: makeFlow(), flowId: -1, seen: 0, flowMode: "none", cursor: 0, key: "", chartKey: "" };
    return row;
  }

  const tabFilter = (t: DiscoverTab): Filter => (t === "fresh" ? "new" : t === "chains" ? "all" : t);
  let tab: DiscoverTab = "trending";
  let query = "";
  let rankedAt = performance.now();
  let shown: Item[] = [];

  function rerank(): void {
    rankedAt = performance.now();
    for (const [id, b] of tabBtns) {
      b.classList.toggle("on", id === tab && !query.trim());
      b.setAttribute("aria-pressed", String(id === tab));
    }
    // A coin this person hid never shows, even while the feed still holds it for a moment.
    shown = rankDiscover(tab, opts.items(), query, tab === "chains" ? "default" : getSort(tabFilter(tab))).filter((i) => !moderation.isHidden(i.address));
    while (rows.length < shown.length) {
      const r = makeRow();
      rows.push(r);
      list.append(r.root);
    }
    rows.forEach((r, i) => {
      const it = shown[i] ?? null;
      r.item = it;
      r.root.hidden = it === null;
      r.key = ""; // forces a full redraw
    });
    const q = query.trim();
    const t = TABS.find((x) => x.id === tab)!;
    const noMoves = tab === "movers" && !shown.some((i) => Number.isFinite(i.change24h));
    note.textContent = q ? `Search · ${shown.length} found` : noMoves && shown.length > 0 ? `No 24h price data yet · ${shown.length}` : `${t.note} · ${shown.length}`;
    empty.hidden = shown.length > 0;
    empty.textContent = q
      ? import.meta.env.DEV
        ? `No simulated token matches “${q}”. Contract, X and website search arrive with live data.`
        : `No coin matches “${q}”.`
      : tab === "chains"
        ? "No Base or BNB Chain coin here yet: the coins further down the list are still loading, and this fills in by itself."
        : "Nothing here right now.";
    draw(performance.now() / 1000, true);
  }

  const rnd = Math.random;
  let lastRib = 0;
  let ribAcc = 0;
  /** The ribbon beside the score: only for rows you can see. While the page is zoomed out it moves 30 times a second, not every frame. */
  function drawRibbons(nowSec: number, calm: boolean): void {
    ribAcc += Math.min(0.05, Math.max(0, nowSec - lastRib));
    lastRib = nowSec;
    if (!calm && ribAcc < 1 / 30) return;
    const dt = ribAcc;
    ribAcc = 0;
    const nowMs = Date.now();
    const still = opts.still();
    const top = scroller.scrollTop;
    const bottom = top + scroller.clientHeight;
    for (const r of rows) {
      const it = r.item;
      const c = r.ribbon.getContext("2d")!;
      if (!it) continue;
      // No streaks while they are switched off, and none for a token with neither real trades nor counts (that would be invented motion).
      const mode = ribbonMode(it, nowMs);
      if (still || mode === "none") {
        c.clearRect(0, 0, RIB_W * 2, RIB_H * 2);
        r.seen = 0;
        continue;
      }
      const y0 = r.root.offsetTop;
      if (y0 + r.root.offsetHeight < top || y0 > bottom) {
        r.seen = 0;
        continue;
      }
      c.clearRect(0, 0, RIB_W * 2, RIB_H * 2);
      // Flagged tokens stop being tracked, and one being read has nothing to show yet: no stream.
      if (it.status === "flag" || it.status === "checking") continue;
      const imp = liveImportance(it);
      const real = mode === "real";
      const speed = real ? REAL_SPEED : flowSpeed(imp, Math.min(1, it.spike / 0.6));
      const rate = spawnRate(speed, 1);
      if (r.flowId !== it.id || r.seen === 0 || r.flowMode !== mode) {
        r.flowId = it.id;
        r.flowMode = mode;
        r.cursor = nowMs;
        // A real ribbon never starts with made-up dots: it takes the trades heard from now on.
        if (real) {
          r.flow.n = 0;
          r.flow.acc = 0;
        } else prewarm(r.flow, rate, speed, it.buyShare, rnd);
      }
      r.seen = nowSec;
      if (real) r.cursor = stepReal(r.flow, dt, realOf(it.address)?.realTrades, r.cursor, rnd);
      else stepFlow(r.flow, dt, rate, speed, it.buyShare, rnd);
      const yAt = (u: number): number => RIB_H * (1 - 0.5 * (ribbonValue(it.hist, it.histAge, SIM.histEvery, imp, u) - 0.5));
      const f = r.flow;
      c.lineWidth = 2.5 * RIB_K;
      c.lineCap = "round";
      // a design decision, as on the tiles: a trade's size is its height (a buy above the line, a sell below, swooping further at "now"); one path per colour.
      const span = RIB_H * 2 * 2.2; // the ribbon is short: its range is a larger share of its height than a tile's
      for (let sd = 0; sd < 2; sd++) {
        c.beginPath();
        let any = false;
        for (let k = 0; k < f.n; k++) {
          const u = f.u[k]!;
          if (u > 1 || f.side[k] !== sd) continue;
          const size = real ? f.size[k]! : f.size[k]! * COUNTED_DIM * 0.5;
          const u0 = Math.max(0, u - (0.03 + 0.04 * f.spd[k]!));
          const j = (f.lane[k]! - 0.5) * 3 * RIB_K;
          c.moveTo(2 + (RIB_W * 2 - 4) * u0, yAt(u0) + sizeOffset(size, sd === 1, u0) * span + j);
          c.lineTo(2 + (RIB_W * 2 - 4) * u, yAt(u) + sizeOffset(size, sd === 1, u) * span + j);
          any = true;
        }
        if (!any) continue;
        c.strokeStyle = `rgba(${sd === 1 ? LIME : MANDARIN},${real ? SIZE_ALPHAS[SIZE_ALPHAS.length - 1] : SIZE_ALPHAS[1]})`;
        c.stroke();
      }
    }
  }

  // ---- the lite chart's options ----
  const seriesCache = new Map<string, { at: number; res: NonNullable<Series["res"]> }>();
  function syncOptions(r: Row): void {
    for (const [t, b] of r.tfBtns) b.classList.toggle("on", t === r.view.tf);
    r.kindBtn.textContent = r.view.kind === "line" ? "Candles" : "Line";
    r.kindBtn.classList.toggle("on", r.view.kind === "candles");
  }
  function loadSeries(r: Row): void {
    const it = r.item;
    if (!it || r.view.tf === "Live") return;
    const tf = r.view.tf;
    if (!it.address) {
      r.series = { key: "", res: { status: "none", source: "", candles: [] } };
      return;
    }
    const key = `${it.address}|${tf}`;
    const hit = seriesCache.get(key);
    if (hit && Date.now() - hit.at < SERIES_TTL_MS) {
      r.series = { key, res: hit.res };
      return;
    }
    const mine: Series = { key, res: null };
    r.series = mine;
    void opts.fetchCandles(it.address, tf).then(
      (res) => {
        mine.res = res;
        r.chartKey = ""; // redraw
        if (res.status === "busy" || res.status === "error" || res.status === "stale") {
          // not kept: the note says "retrying", so ask again shortly if this card still shows the same chart
          setTimeout(() => {
            if (r.series === mine) loadSeries(r);
          }, 8_000);
          return;
        }
        seriesCache.set(key, { at: Date.now(), res });
      },
      () => {
        mine.res = { status: "error", source: "", candles: [] };
        r.chartKey = "";
      },
    );
  }
  function pickOption(r: Row, tf: ChartView["tf"] | null, kind: ChartView["kind"] | null): void {
    if (tf) {
      r.view.tf = tf;
      if (tf === "Live") r.view.kind = "line";
    }
    if (kind) {
      r.view.kind = kind;
      if (kind === "candles" && r.view.tf === "Live") r.view.tf = "15m";
    }
    syncOptions(r);
    loadSeries(r);
    r.chartKey = "";
    if (r.item) drawChart(r, r.item);
  }

  /** A lite chart: the card's live line, or the free chart source's candles at a chosen size. Thin line, faint grid, soft fill, a dot at "now". Log scale when the move is huge. */
  function drawChart(r: Row, it: Item): void {
    const cv = r.chart;
    const w = cv.clientWidth;
    const h = cv.clientHeight;
    if (!w || !h) return;
    const dpr = Math.min(devicePixelRatio || 1, 2);
    if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) {
      cv.width = Math.round(w * dpr);
      cv.height = Math.round(h * dpr);
    }
    const c = cv.getContext("2d")!;
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    c.clearRect(0, 0, w, h);
    const note = (text: string): void => {
      // Missing stays missing: no line is drawn, and the card says so.
      c.fillStyle = `rgba(${palette().mute},0.7)`;
      c.font = "400 11px ui-monospace, Menlo, monospace";
      c.textAlign = "center";
      c.textBaseline = "middle";
      c.fillText(text, w / 2, h / 2);
    };
    let data: number[];
    let candles: Candle[] | null = null;
    let label = "";
    if (r.view.tf === "Live") {
      // A coin with no price series of its own but real trades draws its line from them (item 57): a coin that trades is never "no price history".
      const fromTrades = it.chart.length < 2 ? lineFromTrades(realOf(it.address)) : [];
      if (it.chart.length < 2 && fromTrades.length < 2) return note("no price history yet");
      data = fromTrades.length >= 2 ? fromTrades : it.chart;
      // Where the history came from, small, in the corner (the chart is real, so it says whose).
      if (fromTrades.length >= 2) label = "live trades";
      else if (it.priceSource) label = it.priceSource.startsWith("PINR") ? `${it.priceSource} · tracked` : `1h · ${it.priceSource}`;
    } else {
      const res = r.series?.res;
      if (!res) return note("loading…");
      if ((res.status !== "ok" && res.status !== "stale") || res.candles.length < 2) return note(res.status === "busy" ? "chart not read yet" : res.status === "none" ? "no chart yet" : "no candles for this size");
      const last = res.candles.slice(-80);
      data = last.map((k) => k[4]);
      if (r.view.kind === "candles") candles = last;
      label = res.status === "stale" && res.asOfMs !== undefined ? `${r.view.tf} · ${formatAsOf(res.asOfMs)}` : `${r.view.tf} · ${res.source}`;
    }
    const lows = candles ? candles.map((k) => k[3]) : data;
    const highs = candles ? candles.map((k) => k[2]) : data;
    let lo = Infinity;
    let hi = -Infinity;
    for (const v of lows) lo = Math.min(lo, v);
    for (const v of highs) hi = Math.max(hi, v);
    const log = lo > 0 && hi / lo > 6;
    const f = (v: number): number => (log ? Math.log(v) : v);
    const a = f(lo);
    const span = Math.max(1e-9, f(hi) - a);
    const padY = 6;
    const X = (i: number): number => 1 + ((w - 2) * (candles ? i + 0.5 : i)) / (candles ? candles.length : data.length - 1);
    const Y = (v: number): number => h - padY - ((f(v) - a) / span) * (h - padY * 2);
    c.lineWidth = 1;
    c.strokeStyle = `rgba(${palette().fg},0.08)`;
    c.beginPath();
    for (const g of [0.25, 0.5, 0.75]) {
      c.moveTo(0, Math.round(h * g) + 0.5);
      c.lineTo(w, Math.round(h * g) + 0.5);
    }
    c.stroke();
    const up = data[data.length - 1]! >= (candles ? candles[0]![1] : data[0]!);
    const tint = up ? LIME : MANDARIN;
    if (candles) {
      const bw = Math.max(1.5, ((w - 2) / candles.length) * 0.66);
      candles.forEach((k, i) => {
        const col = `rgb(${k[4] >= k[1] ? LIME : MANDARIN})`;
        const x = X(i);
        c.strokeStyle = col;
        c.fillStyle = col;
        c.lineWidth = 1;
        c.beginPath();
        c.moveTo(x, Y(k[2]));
        c.lineTo(x, Y(k[3]));
        c.stroke();
        const top = Y(Math.max(k[1], k[4]));
        c.fillRect(x - bw / 2, top, bw, Math.max(1, Y(Math.min(k[1], k[4])) - top));
      });
    } else {
      const line = new Path2D();
      data.forEach((v, i) => (i === 0 ? line.moveTo(X(i), Y(v)) : line.lineTo(X(i), Y(v))));
      const fill = new Path2D(line);
      fill.lineTo(X(data.length - 1), h);
      fill.lineTo(X(0), h);
      fill.closePath();
      const grad = c.createLinearGradient(0, 0, 0, h);
      grad.addColorStop(0, `rgba(${tint},0.16)`);
      grad.addColorStop(1, `rgba(${tint},0)`);
      c.fillStyle = grad;
      c.fill(fill);
      c.lineWidth = 1.3;
      c.lineJoin = "round";
      c.lineCap = "round";
      c.strokeStyle = `rgba(${palette().text},0.82)`;
      c.stroke(line);
      c.fillStyle = `rgb(${tint})`;
      c.beginPath();
      c.arc(X(data.length - 1) - 1, Y(data[data.length - 1]!), 2.6, 0, Math.PI * 2);
      c.fill();
    }
    if (label) {
      c.fillStyle = `rgba(${palette().mute},0.7)`;
      c.font = "400 8.5px ui-monospace, Menlo, monospace";
      c.textAlign = "right";
      c.textBaseline = "alphabetic";
      c.fillText(label, w - 4, h - 2);
    }
  }

  let lastDraw = 0;
  function draw(nowSec: number, force = false): void {
    if (!force && nowSec - lastDraw < 0.25) return;
    lastDraw = nowSec;
    // The feed fills in after this page is built: rank as soon as there is something to rank.
    if (!force && shown.length === 0 && !query.trim() && opts.items().length > 0) return rerank();
    for (const r of rows) {
      const it = r.item;
      if (!it) continue;
      const look = statusLook(it);
      const ago = scoredAgo(it.scoredAtMs, Date.now());
      const key = [ribbonMode(it, Date.now()), lastTradeText(realOf(it.address)?.lastRealMs, Date.now()), ago, it.name, it.image, look.kind, look.text, it.coverage, showsEarly(it), showsSocial(it), it.flowCount, it.change24h, it.mcap, it.ath, it.volume24h, it.changeWindowH, Math.round(it.ageMin), it.status, it.launchpad, it.quotePair, it.possibleCopy?.address, it.copyProof, (it.tags ?? []).join(",")].join("|");
      if (key !== r.key) {
        r.key = key;
        r.name.textContent = it.name;
        // A scored token whose picture matches an earlier coin says so right here, beside its score (a warning, the score stays).
        r.sub.textContent = `${it.ticker} · ${ageText(it.ageMin)}${it.possibleCopy ? ` · possible copy of ${it.possibleCopy.ticker}` : ""}`;
        r.sub.classList.toggle("warn", !!it.possibleCopy);
        r.tagsEl.replaceChildren(...tagChips(it.tags ?? []));
        r.avatar.replaceChildren();
        if (it.image) r.avatar.append(pictureOf(it.image, it.name, it.address));
        else r.avatar.textContent = avatarChar(it.name);
        r.badge.set(it);
        r.score.textContent = look.text;
        r.score.title = look.numeric ? SCORE_NOTICE : "";
        r.root.dataset.look = look.kind;
        r.root.dataset.flen = look.kind === "flag" ? (look.text.length <= 4 ? "s" : look.text.length <= 7 ? "m" : "l") : "";
        r.score.style.color = look.kind === "flag" ? "" : look.numeric ? scoreColor(Number(it.value)) : "";
        // Nothing read yet is not "0% read": an unscored coin shows a dash and "unscored", as on the tiles.
        setEarly(r.earlyEl, showsEarly(it));
        setEarly(r.socialEl, showsSocial(it));
        r.chainEl.hidden = !look.numeric;
        r.adviceEl.hidden = !look.numeric;
        r.ageEl.hidden = !look.numeric || ago === null;
        r.ageEl.textContent = ago === null ? "" : `scored ${ago}`;
        // The ribbon's label (a design decision): the time of the last real trade, or "counted" for a ribbon made from DexScreener's counts.
        const rm = ribbonMode(it, Date.now());
        const lt = rm === "real" ? lastTradeText(realOf(it.address)?.lastRealMs, Date.now()) : "";
        r.byCountEl.hidden = rm === "none" || (rm === "real" && lt === "");
        r.byCountEl.textContent = rm === "real" ? lt : BY_COUNT;
        r.byCountEl.title = rm === "real" ? "When the last real trade was heard from the stream. Each dot on the ribbon is one trade." : BY_COUNT_TITLE;
        r.covPct.textContent = look.kind === "flag" ? "" : it.coverage <= 0 ? "—" : `${it.coverage}%`;
        r.covWord.textContent = look.kind === "flag" ? flagWord(it) : it.coverage <= 0 ? "unscored" : "coverage";
        if (!scoreShown()) {
          // no coverage, tags or score words while the score is hidden (not deleted); the ribbon's label stays.
          r.covPct.textContent = "";
          r.covWord.textContent = look.kind === "flag" ? flagWord(it) : "";
          setEarly(r.earlyEl, false);
          setEarly(r.socialEl, false);
          r.chainEl.hidden = true;
          r.adviceEl.hidden = true;
          r.ageEl.hidden = true;
        }
        r.chg.textContent = signedPct(it.change24h) + (Number.isFinite(it.change24h) && Number.isFinite(it.changeWindowH) && it.changeWindowH < 23 ? ` · ${Math.max(1, Math.round(it.changeWindowH))}h` : "");
        r.chg.dataset.dir = it.change24h < 0 ? "down" : "up";
        r.mcVal.textContent = it.status === "flag" ? "—" : money(it.mcap);
        r.athVal.textContent = it.status !== "flag" && Number.isFinite(it.ath) && it.ath > 0 ? money(it.ath) : "—";
        r.money.textContent = `VOL ${money(it.volume24h)}`;
      }
      if (r.viewId !== it.id) {
        // A reused row now shows another coin: its chart goes back to the live line.
        r.viewId = it.id;
        r.view = { tf: "Live", kind: "line" };
        r.series = null;
        syncOptions(r);
      }
      const rp = realOf(it.address)?.prices;
      const ck = `${r.key}|${it.chart[it.chart.length - 1]}|${rp?.length ?? 0}:${rp?.[rp.length - 1]?.p ?? 0}|${r.chart.clientWidth}|${r.view.tf}|${r.view.kind}|${r.series?.res?.candles.length ?? -1}`;
      if (ck !== r.chartKey) {
        r.chartKey = ck;
        drawChart(r, it);
      }
    }
    const age = Math.max(0, Math.round((performance.now() - rankedAt) / 1000));
    tape.textContent = `${opts.tapeName()} · updated ${age}s ago`;
  }

  refresh.addEventListener("click", rerank);
  search.addEventListener("submit", (e) => {
    e.preventDefault();
    input.blur();
    scroller.scrollTo({ top: Math.min(scroller.scrollHeight, hero.offsetHeight), behavior: "smooth" });
  });
  const ADDRESS = /^(0x[0-9a-fA-F]{40}|[1-9A-HJ-NP-Za-km-z]{32,44})$/;
  input.addEventListener("input", () => {
    query = input.value;
    rerank();
    // An exact contract address that no loaded coin has: ask the server, then show it.
    const q = query.trim();
    if (opts.find && ADDRESS.test(q) && !opts.items().some((i) => i.address?.toLowerCase() === q.toLowerCase())) {
      void opts.find(q).then((ok) => {
        if (ok) setTimeout(() => query.trim() === q && rerank(), 500);
      });
    }
  });

  // Up and down scrolls, pinch zooms the camera (shared with the other overlay pages).
  attachPageGestures(root, scroller, opts);

  const placer = createPlacer(root, frame, scroller, () => input.blur());

  rerank();
  return {
    el: root,
    livePrice(address, price, atMs, usd) {
      const a = address.toLowerCase();
      for (const r of rows) {
        const res = r.series?.res;
        const trade = usd !== undefined;
        if (r.item?.address?.toLowerCase() !== a || r.view.tf === "Live" || !res || (res.status !== "ok" && res.status !== "stale" && !(trade && res.status === "none"))) continue;
        const tfSec = { "1m": 60, "5m": 300, "15m": 900, "1h": 3600, "4h": 14400, "1D": 86400 }[r.view.tf as string];
        if (tfSec && foldPrice(res.candles as LiveCandle[], res.bucketSec ?? tfSec, price, atMs, { usd, start: trade })) {
          if (res.status === "none") res.status = "ok";
          r.chartKey = "";
        }
      }
      // The "Live" line is the coin's own tracked line with the live price as its newest point (livefeed's withLiveHead); it redraws itself.
    },
    setFilter(f) {
      tab = f === "movers" ? "movers" : f === "new" ? "fresh" : f === "pinrscore" ? "pinrscore" : "trending";
      rerank();
    },
    refresh: () => rerank(),
    place: placer,
    update: (t, calm) => {
      draw(t);
      drawRibbons(t, calm);
    },
    ageSeconds: () => (performance.now() - rankedAt) / 1000,
  };
}
