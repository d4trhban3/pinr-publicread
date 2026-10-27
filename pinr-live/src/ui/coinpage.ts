import type { ChartResult } from "../../server/market";
import { foldPrice, type Candle } from "../world/livecandle";
import { changeWindowLabel, formatPrice, RANGES, type RangeId } from "../world/format";
import { ageText, money, signedPct } from "../world/discoverlist";
import type { IChartApi, ISeriesApi, UTCTimestamp } from "lightweight-charts";
import type { Evidence } from "../../server/evidence";
import { createBadge } from "./badge";
import { EYE_OFF_ICON } from "./hidemenu";
import { createOrbit } from "./orbit";
import { avatarChar, type Item } from "../world/model";
import { pictureOf } from "../world/cards";
import { attachPageGestures, createPlacer, type GestureOptions, type Placement } from "./pageoverlay";
import { tagChips } from "../world/tags";

/**
 * The DeepScan page: built to stand beside the best coin pages on a phone. The coin's ticker and name, a big
 * price, the change over the range with its period in words, a full-width line coloured by direction with a dotted line at the start of the range,
 * a scrub (finger or cursor) that turns the big price and the change into that moment's, range tabs, links out for a full chart, key stats, then
 * DeepScan's report. PINR has no trading chart of its own.
 *
 * The line is fed like every small chart: the visitor's own browser where the provider allows it, else the tape, else the server,
 * and kept current by the stream's trades. Nothing is invented: a figure that is missing is a dash, and no chart says so.
 */
export interface CoinPageOptions extends GestureOptions {
  /** The eye-slash in the coin's bar: hide this coin (kept in this browser only). */
  onHide(item: Item): void;
  /** `launchpad` lets a Pump.fun or PumpSwap coin ask Pump.fun's own candle history first (via the server; its CORS refuses a browser). */
  fetchChart(address: string, range: RangeId, launchpad?: string | null): Promise<ChartResult>;
  /** TradingView's symbol for a coin it lists (EXCHANGE:NAME), else null: the TradingView link then opens that chart. */
  fetchTvSymbol(address: string): Promise<string | null>;
  /** The paper trail PINR keeps for a coin; null when there is none yet. */
  fetchEvidence(address: string): Promise<Evidence | null>;
}

export interface CoinPage {
  el: HTMLElement;
  setItem(it: Item | null | undefined): void;
  place(p: Placement | null, live: boolean): void;
  update(nowSec: number): void;
  /** A live price for a coin from the stream: folded into the shown coin's newest candle, no reload. */
  livePrice(address: string, price: number, atMs: number, usd?: number): void;
  /** Where DeepScan's report goes: the second half of this page, below the key stats. */
  dossierHost: HTMLElement;
  /** Scroll the page to its top or to the report. */
  scrollTo(part: "chart" | "dossier", smooth?: boolean): void;
}

export const DEFAULT_RANGE: RangeId = "1D";

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

/** The coin's own links (X, Telegram, website) as named links beside the outside chart sites. */
export function socialLinks(l: Item["links"]): { label: string; href: string }[] {
  return [l?.x ? { label: "X", href: l.x } : null, l?.telegram ? { label: "Telegram", href: l.telegram } : null, l?.website ? { label: "Website", href: l.website } : null].filter((x): x is { label: string; href: string } => x !== null);
}

export const TRADINGVIEW_CHART = "https://www.tradingview.com/chart/";
/** TradingView's chart for a listed symbol (EXCHANGE:NAME); anything else keeps the plain chart page. */
export function tradingViewHref(symbol: string | null | undefined): string {
  return symbol && /^[A-Z0-9_]{2,40}:[A-Z0-9_.\-]{2,60}$/.test(symbol) ? `${TRADINGVIEW_CHART}?symbol=${encodeURIComponent(symbol)}` : TRADINGVIEW_CHART;
}

/** The outside chart sites for a coin's full chart. Only what applies to the coin's chain; the Pump.fun page only for a Pump.fun coin. */
export function chartLinks(it: Pick<Item, "address" | "chain" | "launchpad">): { label: string; href: string }[] {
  const a = it.address;
  if (!a) return [];
  const slug = ({ solana: "solana", base: "base", bsc: "bsc", bnb: "bsc", ethereum: "ethereum" } as Record<string, string>)[(it.chain ?? "").toLowerCase()];
  if (!slug) return [];
  const e = encodeURIComponent(a);
  const out = [
    { label: "DexScreener", href: `https://dexscreener.com/${slug}/${e}` },
    { label: "GeckoTerminal", href: `https://www.geckoterminal.com/${slug}/tokens/${e}` },
  ];
  const lp = it.launchpad ?? "";
  if (slug === "solana" && /pump/i.test(lp)) out.push({ label: "Pump.fun", href: `https://pump.fun/coin/${e}` });
  // The chain's own explorer, and the launchpad's own page where it has one for a coin.
  const explorer = ({ solana: ["Solscan", "https://solscan.io/token/"], base: ["Basescan", "https://basescan.org/token/"], bsc: ["BscScan", "https://bscscan.com/token/"], ethereum: ["Etherscan", "https://etherscan.io/token/"] } as Record<string, [string, string]>)[slug];
  if (explorer) out.push({ label: explorer[0], href: `${explorer[1]}${e}` });
  if (slug === "base" && /clanker/i.test(lp)) out.push({ label: "Clanker", href: `https://www.clanker.world/clanker/${e}` });
  if (slug === "base" && /zora/i.test(lp)) out.push({ label: "Zora", href: `https://zora.co/coin/base:${e}` });
  // Virtuals' own page is keyed by the address the coin trades as (CHAINS checked: it forwards to its /virtuals/<id> page, on the curve or graduated).
  if (slug === "base" && /virtuals/i.test(lp)) out.push({ label: "Virtuals", href: `https://app.virtuals.io/prototypes/${e}` });
  if (slug === "bsc" && /four\.?meme/i.test(lp)) out.push({ label: "Four.meme", href: `https://four.meme/token/${e}` });
  if (slug === "bsc" && /flap/i.test(lp)) out.push({ label: "Flap", href: `https://flap.sh/bnb/${e}` });
  // TradingView: the coin's own chart once TradingView is known to list it (the page swaps the address in, see tradingViewHref); until then, and for a coin it
  // does not list, TradingView's chart page, whose own search box finds the coin (TradingView has no address search by link: checked 2026-10-23).
  out.push({ label: "TradingView", href: TRADINGVIEW_CHART });
  return out;
}

/** The time of a candle for the scrub: "Oct 22, 2:15 PM" for a size under a day, "Oct 22, 2026" for a day. */
export function candleTime(tSec: number, bucketSec: number): string {
  const d = new Date(tSec * 1000);
  if (bucketSec >= 86_400) return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
  return `${d.toLocaleDateString("en-US", { month: "short", day: "numeric" })}, ${d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })}`;
}

/** The change from where the range starts (the first candle's open) to a price: in price, in percent, and its direction. Null with no start to measure from. */
export function changeFrom(start: number, price: number): { delta: number; pct: number; up: boolean } | null {
  if (!(start > 0) || !Number.isFinite(price)) return null;
  return { delta: price - start, pct: ((price - start) / start) * 100, up: price >= start };
}

const RANGE_SEC: Record<RangeId, number> = { "1D": 86_400, "1W": 7 * 86_400, "1M": 30 * 86_400, "3M": 90 * 86_400, ALL: Infinity };

/** A length of time in the plainest words: "45 min", "31 h", "3 days". */
export function spanText(sec: number): string {
  const s = Math.max(0, sec);
  if (s < 5_400) return `${Math.max(1, Math.round(s / 60))} min`;
  if (s < 72 * 3_600) return `${Math.round(s / 3_600)} h`;
  return `${Math.round(s / 86_400)} days`;
}

/**
 * What the change is a change OVER, said from what was actually measured. The change runs from the first candle's open to the
 * last price, so the label must match that span: the range's own words ("Past day", "Since launch (49 min)") only when the candles start where
 * the range starts (or at the coin's launch) and run up to now. A sparse answer (a few tape candles from days ago) says the span it covers and
 * how long ago it ended, never "Past day".
 */
export function periodText(a: { range: RangeId; ageMin: number; firstSec: number; lastSec: number; bucketSec: number; nowSec: number }): string {
  const end = a.lastSec + a.bucketSec;
  const fresh = a.nowSec - end <= Math.max(2 * a.bucketSec, 900);
  const rangeSec = RANGE_SEC[a.range];
  const launchedAgo = Number.isFinite(a.ageMin) && a.ageMin >= 0 ? a.ageMin * 60 : NaN;
  const slack = Math.max(3 * a.bucketSec, 1_800);
  // A coin younger than the range (or the whole history): its first candle should be at its launch. An older one: its first candle should sit AT the
  // range's start, bounded on both sides.
  const firstAgo = a.nowSec - a.firstSec;
  const startsRight = launchedAgo < rangeSec ? Math.abs(firstAgo - launchedAgo) <= slack : firstAgo >= 0.95 * rangeSec && firstAgo <= 1.05 * rangeSec + slack;
  if (fresh && startsRight) return changeWindowLabel(a.range, a.ageMin);
  const span = spanText(end - a.firstSec);
  return fresh ? `Over ${span}` : `Over ${span}, ending ${spanText(a.nowSec - end)} ago`;
}

/** "▲ $0.0123 (3.6%)" or "▼ $0.0123 (3.6%)": the arrow, the price change and the percent, without a plus sign. */
export function changeText(c: { delta: number; pct: number; up: boolean }): string {
  return `${c.up ? "▲" : "▼"} ${formatPrice(Math.abs(c.delta))} (${signedPct(Math.abs(c.pct)).replace("+", "")})`;
}

/** The key stats under the chart: label and value, a dash for anything not known (missing stays missing). */
export function keyStats(it: Item): { label: string; value: string }[] {
  const dash = (v: string): string => (v && v !== "—" ? v : "—");
  return [
    { label: "Market cap", value: money(it.mcap) },
    { label: "Volume (24h)", value: money(it.volume24h) },
    { label: "Liquidity", value: money(it.liquidity) },
    { label: "All-time high", value: Number.isFinite(it.ath) && it.ath > 0 ? money(it.ath) : "—" },
    { label: "Launched", value: Number.isFinite(it.ageMin) ? `${ageText(it.ageMin)} ago` : "—" },
    { label: "Launchpad", value: dash(it.launchpad ?? "") },
    { label: "Chain", value: dash(it.chain ? it.chain.charAt(0).toUpperCase() + it.chain.slice(1) : "") },
    { label: "Change (24h)", value: Number.isFinite(it.change24h) ? signedPct(it.change24h) : "—" },
    { label: "Pair", value: dash(it.quotePair ?? "") },
  ];
}

export function createCoinPage(opts: CoinPageOptions): CoinPage {
  const root = el("div", "coinpage");
  root.id = "coinpage";
  const frame = el("div", "dframe");
  const body = el("div", "dscroll cproot");
  frame.append(body);
  root.append(frame);

  // ---- the compact bar that appears when the big price scrolls away ----
  const mini = el("div", "cpmini");
  const miniName = el("b", "cpmininame");
  const miniPrice = el("b", "cpminiprice");
  const miniChange = el("span", "cpminichange");
  mini.append(miniName, miniPrice, miniChange);

  // ---- the head: ticker, name, big price, change and its period ----
  const head = el("div", "cphead");
  const idRow = el("div", "cpidrow");
  const avwrap = el("div", "avwrap");
  const avatar = el("div", "avatar");
  const badge = createBadge();
  avwrap.append(avatar, badge.el);
  const tickerEl = el("span", "cpticker");
  const hideBtn = el("button", "cphide");
  hideBtn.type = "button";
  hideBtn.setAttribute("aria-label", "Hide this coin");
  hideBtn.title = "Hide this coin";
  hideBtn.innerHTML = EYE_OFF_ICON;
  hideBtn.addEventListener("click", () => {
    if (item) opts.onHide(item);
  });
  idRow.append(avwrap, tickerEl, hideBtn);
  const nameEl = el("h1", "cpname");
  const priceEl = el("div", "cpprice");
  const changeRow = el("div", "cpchangerow");
  const changeEl = el("b", "cpchange");
  const periodEl = el("span", "cpperiod");
  changeRow.append(changeEl, periodEl);
  const tagsEl = el("div", "cptags"); // the coin's tags; their evidence is in "At launch" below
  head.append(idRow, nameEl, tagsEl, priceEl, changeRow);

  // ---- the chart: TradingView's Lightweight Charts, candlesticks over a volume strip, as Pump.fun's own page draws a coin (the operator: "they use trading view") ----
  const chartBox = el("div", "cpchart");
  const plot = el("div", "cpplot");
  const status = el("div", "cpstatus");
  chartBox.append(plot, status);

  // ---- range tabs, the source, links out ----
  const tabs = el("div", "cptabs");
  const tabBtns = new Map<RangeId, HTMLButtonElement>();
  for (const r of RANGES) {
    const b = el("button", "cptab", r);
    b.type = "button";
    b.addEventListener("click", () => selectRange(r));
    tabBtns.set(r, b);
    tabs.append(b);
  }
  const caption = el("div", "cpcap");
  const quietNote = el("div", "cpquiet", "No trades in the last 24 hours.");
  quietNote.hidden = true;
  const links = el("div", "cplinks");

  // ---- key stats ----
  const statsSec = el("section", "cpstatsec");
  const statsGrid = el("div", "cpstats");
  statsSec.append(el("h2", "cpstath", "Stats"), statsGrid);

  const main = el("div", "cpmain");
  main.append(head, chartBox, tabs, caption, quietNote, links, statsSec);
  const empty = el("div", "dsempty cpempty");
  empty.append(el("div", "dsemptyt", "DeepScan"), el("div", "dsemptys", "Choose a coin to see its page."));
  const top = el("div", "cptop");
  top.append(main, empty);
  // Orbit: the coin in the middle, what is linked to it around it; DeepScan's report below is its health file.
  const orbit = createOrbit({ fetchEvidence: opts.fetchEvidence });
  const healthHead = el("h2", "cphealth", "Health file");
  // Checklist 12: the health file to keep, as the server serves it (a file download, same site, nothing secret).
  const healthGet = el("a", "cphealthget", "Download");
  healthGet.setAttribute("download", "");
  healthGet.setAttribute("aria-label", "Download this coin's health file");
  healthHead.append(healthGet);
  const dossierHost = el("div", "cpdossier");
  const toTop = el("button", "cpgo cpgoup", "↑ Chart");
  toTop.type = "button";
  toTop.addEventListener("click", () => body.scrollTo({ top: 0, behavior: "smooth" }));
  body.append(mini, top, toTop, orbit.el, healthHead, dossierHost);
  attachPageGestures(root, body, opts);
  const place: CoinPage["place"] = createPlacer(root, frame, body, () => {});
  body.addEventListener("scroll", () => mini.classList.toggle("on", body.scrollTop > head.offsetHeight - 24), { passive: true });

  // ------------------------------------------------------------------ state ---
  let item: Item | null = null;
  let range: RangeId = DEFAULT_RANGE;
  let candles: Candle[] = [];
  let bucket = 900;
  let state: ChartResult["status"] | "loading" = "loading";
  let source = "";
  let fetchedAt = 0;
  let epoch = 0;
  let lastUpdate = 0;
  /** the index of the candle under the finger or cursor, or -1 */
  let scrub = -1;
  /** the range and coin the chart was last fitted to (a live update keeps the view where it is) */
  let fitted = "";

  function paintHead(): void {
    if (!item) return;
    const it = item;
    nameEl.textContent = it.name;
    const tagKey = (it.tags ?? []).join(",");
    if (tagsEl.dataset.k !== tagKey) {
      tagsEl.dataset.k = tagKey;
      tagsEl.replaceChildren(...tagChips(it.tags ?? []));
    }
    tickerEl.textContent = `${it.ticker !== "—" ? it.ticker : ""}${it.launchpad ? `${it.ticker !== "—" ? " · " : ""}${it.launchpad}` : ""}`;
    const ok = candles.length >= 2;
    const at = scrub >= 0 && scrub < candles.length ? candles[scrub]! : null;
    const price = at ? at[4] : candles.length ? candles[candles.length - 1]![4] : Number.isFinite(it.priceUsd) ? it.priceUsd : NaN;
    priceEl.textContent = formatPrice(price);
    let up = true;
    if (ok) {
      const c = changeFrom(candles[0]![1], price);
      if (c) {
        up = c.up;
        changeEl.textContent = changeText(c);
      } else changeEl.textContent = "";
      periodEl.textContent = at
        ? candleTime(at[0], bucket)
        : periodText({ range, ageMin: it.ageMin, firstSec: candles[0]![0], lastSec: candles[candles.length - 1]![0], bucketSec: bucket, nowSec: Date.now() / 1000 });
    } else {
      // No chart to measure from: the feed's own 24-hour change, or nothing.
      const pct = it.change24h;
      up = !(Number.isFinite(pct) && pct < 0);
      changeEl.textContent = Number.isFinite(pct) ? `${pct >= 0 ? "▲" : "▼"} ${signedPct(Math.abs(pct)).replace("+", "")}` : "";
      periodEl.textContent = Number.isFinite(pct) ? "Past day" : "";
    }
    for (const e of [root]) e.classList.toggle("down", !up);
    miniName.textContent = it.ticker !== "—" ? it.ticker : it.name;
    miniPrice.textContent = priceEl.textContent;
    miniChange.textContent = changeEl.textContent;
  }

  function paintStats(): void {
    if (!item) return;
    statsGrid.replaceChildren(
      ...keyStats(item).map((s) => {
        const c = el("div", "cpstat");
        c.append(el("span", "cpstatl", s.label), el("b", "cpstatv", s.value));
        return c;
      }),
    );
  }

  /** The chart library loads on the first coin page (it is not part of the first screen). */
  let tv: { chart: IChartApi; candle: ISeriesApi<"Candlestick">; volume: ISeriesApi<"Histogram">; line: ISeriesApi<"Line"> } | null = null;
  let tvLoading = false;
  const css = (name: string, fallback: string): string => getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;
  /** The price line's colour: the bright lime on the dark theme, a deep green on the light one (the lime is faint on white). */
  const lineColor = (): string => (document.documentElement.dataset.theme === "light" ? "#2f4a00" : css("--live", "#d6ff3c"));
  async function ensureChart(): Promise<void> {
    if (tv || tvLoading) return;
    tvLoading = true;
    try {
      const lw = await import("lightweight-charts");
      const chart = lw.createChart(plot, {
        autoSize: true,
        layout: { background: { type: lw.ColorType.Solid, color: "transparent" }, textColor: css("--mute", "#9aa1ae"), fontFamily: css("--font", "system-ui"), attributionLogo: false },
        grid: { vertLines: { visible: false }, horzLines: { color: "rgba(128,128,128,0.12)" } },
        rightPriceScale: { borderVisible: false, scaleMargins: { top: 0.08, bottom: 0.28 } },
        timeScale: { borderVisible: false, timeVisible: true, secondsVisible: false, rightOffset: 2 },
        crosshair: { mode: lw.CrosshairMode.Normal },
        // The page scrolls under a finger: the chart only shows the crosshair (the scrub); its range is the tabs'.
        handleScroll: { mouseWheel: false, pressedMouseMove: false, horzTouchDrag: false, vertTouchDrag: false },
        handleScale: { mouseWheel: false, pinch: false, axisPressedMouseMove: false, axisDoubleClickReset: false },
        localization: { priceFormatter: (v: number) => formatPrice(v) },
      });
      const candle = chart.addSeries(lw.CandlestickSeries, { upColor: css("--live", "#d6ff3c"), downColor: css("--mandarin", "#ff8c1a"), borderVisible: false, wickUpColor: css("--live", "#d6ff3c"), wickDownColor: css("--mandarin", "#ff8c1a"), priceFormat: { type: "custom", formatter: (v: number) => formatPrice(v), minMove: 1e-12 } });
      const volume = chart.addSeries(lw.HistogramSeries, { priceFormat: { type: "volume" }, priceScaleId: "", lastValueVisible: false, priceLineVisible: false });
      volume.priceScale().applyOptions({ scaleMargins: { top: 0.8, bottom: 0 } });
      chart.subscribeCrosshairMove((p) => {
        const t = p.time as number | undefined;
        if (t === undefined) return endScrub();
        const i = candles.findIndex((c) => c[0] === t);
        if (i < 0) return endScrub();
        scrub = i;
        paintHead();
      });
      const line = chart.addSeries(lw.LineSeries, { lineWidth: 2, priceFormat: { type: "custom", formatter: (v: number) => formatPrice(v), minMove: 1e-12 }, visible: false });
      tv = { chart, candle, volume, line };
      // The colours are read again when the theme is switched (the chart is not redrawn by a stylesheet).
      new MutationObserver(() => paint()).observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    } catch {
      tv = null;
    } finally {
      tvLoading = false;
    }
    if (tv) paint();
  }

  /** The coin's own price line as chart points, evenly spaced back from now over the hours it covers; null with fewer than two points. */
  function lineFallback(): { time: UTCTimestamp; value: number }[] | null {
    const s = item?.series;
    if (!s || s.length < 2 || candles.length >= 2) return null;
    const hours = Number.isFinite(item!.changeWindowH) && item!.changeWindowH > 0 ? item!.changeWindowH : 24;
    const stepSec = Math.max(60, Math.round((hours * 3600) / (s.length - 1)));
    const end = Math.floor(Date.now() / 1000);
    return s.map((v, i) => ({ time: (end - (s.length - 1 - i) * stepSec) as UTCTimestamp, value: v }));
  }

  function paint(): void {
    // No candles from any source: the coin's own tracked or measured price line in the same chart, said plainly (never a made-up candle).
    const fallback = lineFallback();
    const ok = candles.length >= 2 || fallback !== null;
    plot.style.visibility = ok ? "visible" : "hidden";
    if (tv) {
      tv.candle.applyOptions({ visible: candles.length >= 2 });
      tv.volume.applyOptions({ visible: candles.length >= 2 });
      tv.line.applyOptions({ visible: candles.length < 2 && fallback !== null, color: lineColor(), lineWidth: 3 });
    }
    if (fallback && candles.length < 2 && tv) {
      tv.line.setData(fallback);
      if (fitted !== "line:" + (item?.id ?? "")) {
        tv.chart.timeScale().fitContent();
        fitted = "line:" + (item?.id ?? "");
      }
    }
    if (candles.length >= 2 && tv) {
      const up = css("--live", "#d6ff3c");
      const down = css("--mandarin", "#ff8c1a");
      tv.chart.applyOptions({ layout: { textColor: css("--mute", "#9aa1ae") } });
      tv.candle.applyOptions({ upColor: up, downColor: down, wickUpColor: up, wickDownColor: down });
      tv.candle.setData(candles.map((c) => ({ time: c[0] as UTCTimestamp, open: c[1], high: c[2], low: c[3], close: c[4] })));
      tv.volume.setData(candles.map((c) => ({ time: c[0] as UTCTimestamp, value: c[5], color: c[4] >= c[1] ? up + "66" : down + "66" })));
      if (fitted !== range + ":" + (item?.id ?? "")) {
        tv.chart.timeScale().fitContent();
        fitted = range + ":" + (item?.id ?? "");
      }
    }
    // One message, from what is actually on the chart: a drawn line or candles never sit beside "Chart busy".
    const drawn = tv !== null && ok;
    const msg = drawn
      ? ""
      : ok
        ? "Loading…" // data is here, the chart library is still loading
        : state === "loading"
          ? "Loading…"
          : state === "busy"
            ? "Chart not read yet. PINR asks again shortly."
            : state === "error"
              ? "Chart not read yet. PINR asks again shortly."
              : item?.chain === "bsc" || item?.chain === "base"
                ? "No trades read yet."
                : "No chart yet.";
    status.textContent = msg;
    status.classList.toggle("hide", msg === "");
    caption.textContent = candles.length >= 2 && source ? `Chart: ${source === "PINR tape" ? "Pump.fun" : source} · candles with volume` : fallback ? `Chart: ${item?.priceSource || "PINR"} price line · no candles are available for this coin yet` : "";
    paintHead();
  }

  async function load(silent: boolean): Promise<void> {
    const it = item;
    if (!it?.address) return;
    const e = epoch;
    if (!silent) {
      state = "loading";
      paint();
    }
    const res = await opts.fetchChart(it.address, range, it.launchpad);
    if (e !== epoch) return; // another coin or range was chosen meanwhile
    fetchedAt = Date.now();
    state = res.status;
    if (res.status === "ok" || res.status === "stale") {
      candles = res.candles as Candle[];
      bucket = res.bucketSec ?? (candles.length > 1 ? Math.max(1, candles[1]![0] - candles[0]![0]) : 900);
      source = res.source;
    } else if (!silent) candles = [];
    paint();
  }

  function selectRange(r: RangeId): void {
    if (r === range) return;
    range = r;
    for (const [id, b] of tabBtns) b.classList.toggle("on", id === r);
    epoch++;
    candles = [];
    source = "";
    endScrub();
    if (item && item.flagKind !== "VAMP") void load(false);
    else paint();
  }

  // The scrub: while a finger or cursor is on the chart the big price and the change are that candle's, with its time (the chart's crosshair says which).
  function endScrub(): void {
    if (scrub < 0) return;
    scrub = -1;
    paintHead();
  }

  function setItem(given: Item | null | undefined): void {
    const next = given ?? null;
    const same = next !== null && item !== null && next.id === item.id;
    item = next;
    root.classList.toggle("hastoken", next !== null);
    // A copy (VAMP) has no chart anywhere: the page shows only its report (the label page).
    root.classList.toggle("isvamp", next?.flagKind === "VAMP");
    orbit.setItem(next);
    healthGet.hidden = !next?.address;
    if (next?.address) healthGet.href = `/api/healthfile?address=${encodeURIComponent(next.address)}`;
    quietNote.hidden = next?.quiet !== true; // said in plain words on a coin found by its address
    if (next === null) return;
    void ensureChart();
    if (same) {
      paintHead();
      paintStats();
      if (candles.length < 2) paint(); // a line that arrived with the latest list draws now, whatever state the chart is in
      return;
    }
    epoch++;
    candles = [];
    source = "";
    state = "loading";
    // The TradingView link goes to the coin's own chart where TradingView lists it (the server looks the symbol up), else to its chart page.
    if (next.chain === "solana" && next.address && next.flagKind !== "VAMP") {
      const e0 = epoch;
      void opts.fetchTvSymbol(next.address).then((sym) => {
        if (e0 !== epoch || !sym) return;
        for (const a of links.querySelectorAll<HTMLAnchorElement>("a.cplink")) if (a.textContent?.startsWith("TradingView")) a.href = tradingViewHref(sym);
      });
    }
    scrub = -1;
    for (const [id, b] of tabBtns) b.classList.toggle("on", id === range);
    badge.set(next);
    avatar.replaceChildren();
    if (next.image) avatar.append(pictureOf(next.image, next.name, next.address));
    else avatar.textContent = avatarChar(next.name);
    links.replaceChildren(
      ...[...chartLinks(next), ...socialLinks(next.links)].map((l) => {
        const a = el("a", "cplink", `${l.label} ↗`);
        a.href = l.href;
        a.target = "_blank";
        a.rel = "noopener noreferrer";
        return a;
      }),
    );
    links.hidden = links.childElementCount === 0;
    paintStats();
    paint();
    if (next.flagKind !== "VAMP") void load(false);
  }

  return {
    el: root,
    dossierHost,
    livePrice(address, price, atMs, usd) {
      if (!item?.address || item.address.toLowerCase() !== address.toLowerCase()) return;
      const trade = usd !== undefined;
      // Only onto a chart that is up; a trade may start one for a coin that has none yet.
      if (state !== "ok" && state !== "stale" && !(trade && (state === "none" || state === "busy"))) return;
      if (foldPrice(candles, bucket, price, atMs, { usd, start: trade })) {
        if (state === "none" || state === "busy") state = "ok";
        paint();
      }
    },
    scrollTo(part, smooth = false) {
      body.scrollTo({ top: part === "dossier" && !root.classList.contains("isvamp") ? top.offsetHeight + 8 : 0, behavior: smooth ? "smooth" : "auto" });
    },
    setItem,
    place,
    update(nowSec) {
      if (nowSec - lastUpdate < 0.5) return;
      lastUpdate = nowSec;
      if (!item?.address || item.flagKind === "VAMP") return;
      paintStats();
      if (candles.length < 2) paint(); // a line that arrived with the latest list, or a chart library that just loaded
      // fresh candles: every 20 s; a busy or failed answer is tried again after 8 s
      const age = Date.now() - fetchedAt;
      const retry = state === "busy" || state === "error" || state === "stale" ? age > 8_000 : age > 20_000;
      if (retry && state !== "loading" && scrub < 0) void load(true);
    },
  };
}
