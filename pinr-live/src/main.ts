import { applyHubSwitch } from "./world/hub";
import { browserCharts, CHART_RANGES, TIMEFRAMES } from "./world/browserchart";
import { hearTrade } from "./world/flow";
import "@fontsource-variable/inter";
import "./style.css";
// the page class that hides the score, its labels and PINRbot (one switch: world/hub.ts).
applyHubSwitch();
import { look, onLook, startTheme } from "./ui/theme";
import { getSort, setRoster, type Filter } from "./world/filters";
startTheme();
import { Camera, type View } from "./engine/camera";
import { attachInput } from "./engine/input";
import { FrameHud } from "./engine/hud";
import { GridLayer } from "./engine/grid";
import { StreamLayer } from "./engine/streams";
import { makeGrainDataUrl } from "./engine/grain";
import { CardField } from "./world/cards";
import { rankDiscover } from "./world/discoverlist";
import { allowedCols, clampCols, defaultCols, fitScale, gridWidth, PHONE_WIDTH, shownCols } from "./world/grid";
import { CARD_W } from "./world/cards";
/** A phone tile's height to its width, as in the iPhone and Android apps. */
const PHONE_TILE_TALL = 1.52;
import { createHeader } from "./ui/header";
import { createTabBar } from "./ui/tabbar";
import { createPages } from "./ui/pages";
import { createDiscover } from "./ui/discover";
import { createDeepScan } from "./ui/deepscan";
import { createCoinPage } from "./ui/coinpage";
import type { Evidence } from "../server/evidence";
import type { TF } from "./world/timeframes";
import { createGuidePage } from "./ui/guide";
import { createAdsApplyPage } from "./ui/adsapply";
import { AD_SLOTS, type AdSlot } from "./world/adsform";
import { createWalletPage } from "./ui/wallet";
import { createArenaPage } from "./ui/arena";
import type { WalletView } from "../server/wallet";
import type { GestureOptions, Placement } from "./ui/pageoverlay";
import { createSettings } from "./ui/settings";
import { closeHideMenu, showHiddenNote, showHideMenu, showNote } from "./ui/hidemenu";
import { moderation } from "./world/moderation";
import { createWhitepaper } from "./ui/whitepaper";
import {
  axisRange,
  cameraFor,
  journeyAt,
  journeyDip,
  journeySeconds,
  mapExtent,
  mapFitScale,
  nearestPage,
  PAGE_GAP,
  pageFrames,
  type CamState,
  type Frame,
  type PageId,
} from "./world/sitemap";
import { makeStore, NEW_LAUNCH_MIN, SIM, THIN_BELOW, type Feed, type FlagKind, type Item } from "./world/model";
import type { RangeId } from "./world/format";
import type { CandlesResult, ChartResult } from "../server/market";
import type { Dossier } from "../server/dossier";
import type { TradesView } from "./ui/tradeslist";
import { applyCoinPage, LiveFeed, shortAddress } from "./world/livefeed";
import type { WireToken } from "../server/translate";

const stage = document.getElementById("stage")!;
const glassLayer = document.getElementById("glassLayer")!;
const gridCanvas = document.getElementById("grid") as HTMLCanvasElement;
const streamCanvas = document.getElementById("streams") as HTMLCanvasElement;
const bgVid = document.getElementById("bgvid") as HTMLVideoElement;
const bgSvg = document.getElementById("bgsvg") as HTMLImageElement | null;
/** Phone width (the site's own line, PHONE_WIDTH): the creep video; wider: the SVG teaser, and the video is never loaded. */
const phoneBg = matchMedia(`(max-width: ${PHONE_WIDTH - 0.02}px)`);
/**
 * a design decision, round 2: the phone's poster frame is set only at phone width (a desktop never fetches it), and the 8.5 MB video only once
 * the first tiles are up (so it never competes with the tile list) and never when the phone asks to save data (the poster then stays).
 */
let tilesUp = false;
const saveData = (): boolean =>
  (navigator as Navigator & { connection?: { saveData?: boolean } }).connection?.saveData === true || matchMedia("(prefers-reduced-data: reduce)").matches;
/** The video's source is set only while the page is at phone width, so a desktop never downloads it. */
/** Light mode has its own art: the light teaser at every width, no video. */
const lightBg = (): boolean => look() === "light";
function syncBgSource(): void {
  const video = phoneBg.matches && !lightBg();
  const poster = bgVid.dataset.poster ?? "";
  if (video && poster && bgVid.getAttribute("poster") !== poster) bgVid.poster = poster;
  const src = bgVid.dataset.src ?? "";
  if (video && tilesUp && !saveData() && src && bgVid.getAttribute("src") !== src) bgVid.src = src;
  else if (!video && bgVid.hasAttribute("src")) {
    bgVid.pause();
    bgVid.removeAttribute("src");
    bgVid.load();
  }
}
syncBgSource();
const hudEl = document.getElementById("hud")!;
document.documentElement.style.setProperty("--grain", `url(${makeGrainDataUrl()})`);
// One grain speck = one device pixel, on every screen. Finer than the eye can pick out, felt as matte.
document.documentElement.style.setProperty("--grain-size", `${128 / Math.min(devicePixelRatio || 1, 3)}px`);

/**
 * Test switches for finding what slows a phone down: open the page as /?no=video,streams,grid and those layers are
 * left out. Nothing here changes how the app normally runs.
 */
const off = new Set((new URLSearchParams(location.search).get("no") ?? "").split(",").filter(Boolean));
if (off.has("video")) document.getElementById("bg")?.remove();
if (off.has("grid")) document.getElementById("grid")?.remove();
if (off.has("streams")) document.getElementById("streams")?.remove();

const showHud = import.meta.env.DEV || new URLSearchParams(location.search).has("hud");
if (!showHud) hudEl.remove();

const view: View = { w: innerWidth, h: innerHeight };
let dpr = Math.min(devicePixelRatio || 1, 3);
const cam = new Camera();
const grid = new GridLayer(gridCanvas);
const hud = new FrameHud(hudEl);
const streams = new StreamLayer(streamCanvas);
const field = new CardField(glassLayer, stage);
const store = makeStore();
/** The tiles show the engine's real results and the launchpads' own lists, read by the feed server. There is no simulated data. */
const liveFeed = new LiveFeed();
/**
 * the tile page's default order (Trending, newest seen or scored first) is the head of the first page's own order, so it needs
 * nothing more; every other filter or order ranks over every scored coin, so the scored set is read for it. the team's F1b.
 */
function rankingNeedsRest(f: Filter): boolean {
  return f !== "trending" || getSort("trending") !== "default";
}
if (rankingNeedsRest("trending")) liveFeed.wantRest();
// the stream's live prices move the charts with no reload (the DeepScan page's lite chart, Discover's cards).
liveFeed.onPrice((address, price, atMs, usd) => {
  coinPage.livePrice(address, price, atMs, usd);
  discover.livePrice(address, price, atMs, usd);
});
// each real trade the stream brings is kept by its coin's address (the row may not exist yet) and becomes one dot on its ribbon.
liveFeed.onTrade((t) => {
  hearTrade(t.address, t.side, t.usd, t.priceUsd, t.atMs, Date.now());
  // the open coin page shows each trade at once (price, the chart's current candle, Recent trades).
  deepscan.liveTrade(t);
});
const feed: Feed = liveFeed;

interface DataView {
  long: string;
  short: string;
  /** Name for the "updated Ns ago" line on Discover. */
  tape: string;
  /** Name for the Diagnostics panel. */
  name: string;
  status: string;
  warn: boolean;
  note: string;
}
const ago = (ms: number): string => {
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  return s < 90 ? `${s}s` : s < 5400 ? `${Math.round(s / 60)} min` : s < 129600 ? `${Math.round(s / 3600)} h` : `${Math.round(s / 86400)} days`;
};
/** Plain words about what the data is right now. Honest at every step: a missing server shows nothing, never pretend data. */
function dataView(): DataView {
  const v = dataViewNow();
  // Once the server has gone quiet the numbers on screen are the last ones heard: say so in the header, not just in Settings.
  if (liveFeed && liveFeed.link().state === "offline" && liveFeed.link().heardMs !== null) return { ...v, long: "Stale", short: "OLD", warn: true };
  return v;
}
function dataViewNow(): DataView {
  const l = liveFeed.link();
  if (l.state === "connecting") return { long: "Connecting", short: "…", tape: "Connecting", name: "CONNECTING", status: "Connecting to the feed server…", warn: false, note: "Waiting for the feed server." };
  if (l.state === "offline" && l.heardMs === null)
    return { long: "Offline", short: "OFF", tape: "Offline", name: "OFFLINE", status: "Feed server not running (start it with: npm run feed)", warn: true, note: "The feed server cannot be reached, so there are no tokens to show. Nothing is made up." };
  if (l.state === "mismatch") return { long: "Mismatch", short: "ERR", tape: "Contract mismatch", name: "CONTRACT MISMATCH", status: "The feed speaks a different data contract than this app", warn: true, note: "Results are not shown until the app and the engine output agree on the data contract." };
  const stale = l.state === "offline" ? " · server stopped" : "";
  const problems = l.fileProblems > 0 ? ` · ${l.fileProblems} file(s) with problems` : "";
  const age = l.asOfMs !== null ? ` · newest result ${ago(l.asOfMs)} old` : "";
  const prices = l.market ? ` · price history for ${l.market.covered}` : "";
  const cut = l.more.total > l.more.loaded ? ` · loading the rest of the scored set (${l.more.loaded} of ${l.more.total})` : "";
  const status = `${l.tokens} tokens${age}${prices}${cut}${problems}${stale}`;
  const warn = l.fileProblems > 0 || l.state === "offline";
  if (l.mode === "feed")
    return { long: "Engine feed", short: "ENG", tape: "Engine feed", name: "ENGINE FEED", status, warn, note: "Real results from the PINR engine. Anything the engine has not provided yet (names, prices, charts, trades) shows as missing, not as a made-up value." };
  if (l.mode === "replay")
    return { long: "Replay", short: "RPL", tape: "Replay", name: "REPLAY OF SAVED RUNS", status, warn, note: "Real engine results from saved test runs, shown as saved: not live. Anything the engine has not provided (names, prices, charts, trades) shows as missing, not as a made-up value." };
  return { long: "No results", short: "NONE", tape: "No results", name: "NO RESULTS", status: "The feed server sees no result files", warn: true, note: "No engine result files were found, so there are no tokens to show." };
}

/**
 * Live background playback. It costs the phone's video chip, not its CPU, but it still shouldn't run
 * when nobody can see it, or for people who asked their device to cut motion.
 */
const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)");
/** Two switches in Settings, remembered between visits. */
const readPref = (key: string): boolean => {
  try {
    return localStorage.getItem(key) !== "off";
  } catch {
    return true;
  }
};
const savePref = (key: string, on: boolean): void => {
  try {
    localStorage.setItem(key, on ? "on" : "off");
  } catch {
    /* not saved; still works for this visit */
  }
};
let bgEnabled = readPref("pinr.bg");
let motionEnabled = readPref("pinr.motion");
function syncBgPlayback(): void {
  if (!phoneBg.matches || lightBg()) {
    // Desktop width (and light mode at every width): the SVG teaser animates by itself; with the background switched off or motion reduced, the still frame stands instead.
    const still = reduceMotion.matches || !bgEnabled;
    const want = lightBg() ? (still ? "/art/pinr-system-teaser-light-still.svg" : "/art/pinr-system-teaser-light.svg") : still ? (bgVid.dataset.poster ?? "") : "/art/pinr-system-teaser.svg";
    if (bgSvg && want && bgSvg.getAttribute("src") !== want) bgSvg.src = want;
    return;
  }
  if (document.hidden || reduceMotion.matches || !bgEnabled || off.has("video")) bgVid.pause();
  else void bgVid.play().catch(() => {
    /* Autoplay refused (e.g. iOS Low Power Mode): the poster frame simply stays up. */
  });
}
document.addEventListener("visibilitychange", syncBgPlayback);
reduceMotion.addEventListener("change", syncBgPlayback);
phoneBg.addEventListener("change", () => (syncBgSource(), syncBgPlayback()));
onLook(() => (syncBgSource(), syncBgPlayback()));
// The video is drawn at the creep speed itself (a 240 s loop at 24 frames a second), so it plays at normal rate: slowing a
// 24 fps video to half speed shows only 12 distinct pictures a second, which is what looked choppy.
syncBgPlayback();
// Some phones (iOS Low Power Mode) refuse to autoplay video but allow it after a touch: the first touch starts it.
addEventListener("pointerdown", () => { if (bgVid.paused) syncBgPlayback(); }, { passive: true });

/** Tiles per row: the user's choice, remembered between visits. */
let userCols = defaultCols(view.w);
try {
  // When the standard layout changes (now 5 across, 4 on a phone), choices saved under the old standard are dropped once, so everyone
  // starts on the new one. Anything picked afterwards is remembered as usual.
  const standard = "5-wide-4-phone";
  if (localStorage.getItem("pinr.colsDefault") !== standard) {
    localStorage.removeItem("pinr.cols");
    localStorage.setItem("pinr.colsDefault", standard);
  }
  const saved = Number(localStorage.getItem("pinr.cols"));
  if (saved >= 2) userCols = saved;
} catch {
  /* private mode: fine, default it is */
}

// The compass sits in the footer's centre. It only ever zooms out to the whole site;
// slightly zoomed in from there it still works, fully out a tap does nothing.
const tabbar = createTabBar(
  (id) => goTo(id),
  () => {
    if (!atMacro()) seeWholeSite();
  },
);
const pagesRoot = document.getElementById("pages")!;
const pages = createPages(pagesRoot);

/** One row per proven label that any token carries (the engine's labels differ from the simulation's). */
function flaggedRows(): { label: string; value: string; tone: "warn" }[] {
  const kinds: FlagKind[] = ["BOT", "RUG", "VAMP", "BOT/RUG", "MAYHEM", "HONEYPOT"];
  const rows = kinds.map((k) => ({ label: `Label observed: ${k}`, value: String(store.items.filter((i) => i.flagKind === k).length), tone: "warn" as const })).filter((r) => r.value !== "0");
  return rows.length ? rows : [{ label: "Labels observed", value: "0", tone: "warn" as const }];
}
/** Surges (event lines) seen in the last 60 seconds: counted from the tiles' own event counters. */
const eventLog: { at: number; n: number }[] = [];
let eventTotal = -1;
function trackEvents(nowMs: number): void {
  let total = 0;
  for (const it of store.items) total += it.noteSeq;
  if (eventTotal >= 0 && total > eventTotal) eventLog.push({ at: nowMs, n: total - eventTotal });
  eventTotal = total;
  while (eventLog.length && nowMs - eventLog[0]!.at > 60_000) eventLog.shift();
}
const eventsLastMinute = (): number => eventLog.reduce((a, e) => a + e.n, 0);
/** Why the buy/sell streaks are, or are not, on screen: said in plain words. */
function streamsState(): { text: string; on: boolean } {
  if (reduceMotion.matches) return { text: "OFF: this device asks for reduced motion", on: false };
  if (!motionEnabled) return { text: "OFF: switched off in Settings", on: false };
  const flowing = store.items.filter((i) => i.hasFlow).length;
  if (flowing === 0) return { text: "NONE: this data has no trades yet", on: false };
  return { text: `ON for ${flowing} of ${store.items.length} tokens`, on: true };
}
const streamsRow = (): { label: string; value: string; tone?: "warn" } => {
  const s = streamsState();
  return { label: "Buy/sell streaks", value: s.text, tone: s.on ? undefined : "warn" };
};
const count = (f: (i: (typeof store.items)[number]) => boolean): number => store.items.filter(f).length;
const header = createHeader({
  // The header filter works on both PINR and Discover.
  onFilter: (f) => {
    if (rankingNeedsRest(f)) liveFeed.wantRest();
    field.setFilter(f);
    discover.setFilter(f);
  },
  onCols: (n) => setUserCols(n),
  onSort: () => {
    // A changed order ranks over every coin.
    liveFeed.wantRest();
    field.relayout();
    discover.refresh();
  },
  onHide: () => {
    field.relayout();
    discover.refresh();
  },
  onRoster: (n) => {
    setRoster(n);
    field.relayout();
  },
  // The Whitepaper opens only from its header symbol.
  dataNote: () => dataView().note,
  onPaper: () => {
    settings.show(false);
    guide.show(false);
    adsApply.show(false);
    whitepaper.show(true);
    header.setPage("paper");
  },
  onNavigate: (id) => openPage(id),
  // Back: close Settings or the Whitepaper if one is open; from the whole-site view, return to the page; otherwise the page visited before.
  onBack: (overlay) => {
    if (overlay) {
      settings.show(false);
      whitepaper.show(false);
      guide.show(false);
      adsApply.show(false);
      header.setPage(current);
    } else if (inMap()) goTo(current, false, false);
    else {
      const prev = visited.pop();
      if (prev) goTo(prev, false, false);
    }
  },
  onMap: () => seeWholeSite(),
  // The header's centre "PINR GUIDE" button (and the menu) open the PINR guide over the page; it is not on the map (2026-10-25).
  onGuide: () => {
    settings.show(false);
    whitepaper.show(false);
    guide.show(true);
    header.setPage("guide");
  },
  onSettings: () => {
    whitepaper.show(false);
    guide.show(false);
    adsApply.show(false);
    settings.show(true);
    header.setPage("settings");
  },
  // Where every token stands in PINRbot's reading, counted live from the (simulated) feed.
  pipeline: () => [
    { label: "Tokens found", value: String(store.items.length) },
    { label: "Being read now", value: String(count((i) => i.status === "checking")) },
    { label: "Scored", value: String(count((i) => i.status === "ok" && i.coverage > 0)), tone: "live" },
    { label: "Launchpad coins, not scored yet", value: String(count((i) => i.status === "ok" && i.coverage <= 0 && i.note === null)) },
    { label: "Readings to ask again", value: String(count((i) => i.status === "error")) },
    ...flaggedRows(),
  ],
  diagnostics: () => {
    const loaded = store.items.filter((i) => i.coverage > 0);
    const avg = loaded.length ? Math.round(loaded.reduce((a, i) => a + i.coverage, 0) / loaded.length) : null;
    return [
      { label: "Data source", value: dataView().name, tone: dataView().warn ? ("warn" as const) : undefined },
      ...(liveFeed
        ? [
            { label: "Files with problems", value: String(liveFeed.link().fileProblems) },
            { label: "Price history", value: liveFeed.link().market ? `${liveFeed.link().market!.covered} of ${store.items.length} · ${liveFeed.link().market!.source}` : "off" },
          ]
        : []),
      { label: "Average coverage", value: avg === null ? "—" : `${avg}%` },
      { label: "Thin coverage (under 55%)", value: String(count((i) => i.coverage > 0 && i.coverage < THIN_BELOW)) },
      { label: "Nothing loaded (0%)", value: String(count((i) => i.coverage <= 0)) },
      { label: "New launches (under 1h)", value: String(count((i) => i.ageMin < NEW_LAUNCH_MIN)) },
      { label: "Discover list age", value: `${Math.round(discover.ageSeconds())}s` },
      streamsRow(),
      { label: "Tokens skipped (unreadable)", value: String(store.skipped), tone: store.skipped === 0 ? undefined : ("warn" as const) },
      { label: "Drawing errors", value: drawErrors === 0 ? "none" : `${drawErrors} · ${lastDrawError.slice(0, 60)}`, tone: drawErrors === 0 ? undefined : ("warn" as const) },
      { label: "Events in the last minute", value: String(eventsLastMinute()) },
    ];
  },
});

let zoomWheelTimer: ReturnType<typeof setTimeout> | undefined;
const whitepaper = createWhitepaper(() => {
  whitepaper.show(false);
  header.setPage(current);
});
const guide = createGuidePage(() => {
  guide.show(false);
  header.setPage(current);
});
/** PINRads: the application page an ad space opens. */
const adsApply = createAdsApplyPage(
  () => adsApply.show(false),
  async (a) => {
    const r = await fetch("/api/ads/apply", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(a) });
    const j = (await r.json().catch(() => null)) as { ok?: boolean; words?: string } | null;
    return j?.ok ? { ok: true } : { ok: false, words: j?.words ?? "The application was not sent. Please try again." };
  },
);
/** The ad space under a screen point (the slots are drawn in the map's room layer, which takes no clicks itself), or null. */
function adSlotUnder(x: number, y: number): AdSlot | null {
  for (const s of document.querySelectorAll<HTMLElement>(`.page-${current} .adslot[data-slot]`)) {
    const r = s.getBoundingClientRect();
    if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) return (AD_SLOTS as readonly string[]).includes(s.dataset.slot ?? "") ? (s.dataset.slot as AdSlot) : null;
  }
  return null;
}
function openAdsApply(slot: AdSlot): void {
  settings.show(false);
  whitepaper.show(false);
  guide.show(false);
  adsApply.open(slot);
  adsApply.show(true);
}
const settings = createSettings({
  onBackground: (on) => {
    bgEnabled = on;
    savePref("pinr.bg", on);
    syncBgPlayback();
  },
  onMotion: (on) => {
    motionEnabled = on;
    savePref("pinr.motion", on);
  },
  onClose: () => {
    settings.show(false);
    header.setPage(current);
  },
});
settings.setBackground(bgEnabled);
settings.setMotion(motionEnabled);

// Hiding or showing a coin, or switching the name filter, re-ranks Discover at once.
moderation.onChange(() => {
  discover.refresh();
  // The feed puts a coin that was shown again back on its next frame: look once more after it has.
  setTimeout(() => discover.refresh(), 300);
});

/** Hide a coin (kept in this browser only; no score changes). The page it was on goes back to PINR when it was open. */
function hideCoin(item: Item): void {
  const address = item.address;
  if (!address) return;
  const name = item.name;
  moderation.hide(address);
  if (focusToken?.id === item.id) focusToken = null;
  if (current === "deepscan") goTo("pinr");
  showHiddenNote(name, () => moderation.unhide(address));
}

const discover = createDiscover({
  items: () => store.items,
  find: (address) => liveFeed.find(address),
  wantRest: () => liveFeed.wantRest(),
  wantChains: () => void liveFeed.loadChains(["base", "bsc"]),
  tapeName: () => dataView().tape,
  still: () => reduceMotion.matches || !motionEnabled,
  onFilter: (f) => {
    if (rankingNeedsRest(f)) liveFeed.wantRest();
    header.setFilter(f);
    field.setFilter(f);
  },
  fetchCandles: (address, tf) => fetchCandles(address, tf),
  onDeepScan: (token) => openDeepScan(token),
  onHide: hideCoin,
  // Pinching on Discover zooms the camera, exactly as on every other page.
  onPinchStart: () => {
    cam.touching = true;
    cam.stopMotion();
  },
  onPinch: (ratio, cx, cy) => cam.zoomAbout(cam.logZoom + Math.log(ratio), cx, cy, view),
  onPinchEnd: () => {
    cam.touching = false;
    onZoomEnd();
  },
  onZoomWheel: (dy, cx, cy) => {
    cam.cancelHoming();
    cam.anchorX = cx;
    cam.anchorY = cy;
    cam.vz += -dy * 0.045;
    clearTimeout(zoomWheelTimer);
    zoomWheelTimer = setTimeout(onZoomEnd, 180);
  },
});
document.getElementById("inner")!.append(discover.el);

/** Price history from the feed server for the DeepScan chart. A failure is an answer too ("error"), never a made-up line. */
async function fetchChart(address: string, range: RangeId, launchpad?: string | null): Promise<ChartResult> {
  // A Pump.fun or PumpSwap coin: Pump.fun's own candle history first (its CORS refuses a browser, so the server passes it on, server/pumpcandles.ts).
  const fromServer = async (): Promise<ChartResult | null> => {
    try {
      const r = await fetch(`/api/chart?address=${encodeURIComponent(address)}&range=${range}`, { cache: "no-store" });
      return r.ok ? ((await r.json()) as ChartResult) : null;
    } catch {
      return null;
    }
  };
  const pump = /pump\.?fun|pumpswap/i.test(launchpad ?? "");
  if (pump) {
    // Pump.fun's own API answers the server with Cloudflare's bot challenge (seen 2026-10-23), so GeckoTerminal from this browser is asked at the same time, not after.
    const spec0 = CHART_RANGES[range];
    const [sv, gt] = await Promise.all([fromServer(), spec0 ? browserCharts.candles(address, spec0).catch(() => null) : Promise.resolve(null)]);
    if (sv && sv.status === "ok" && sv.source === "Pump.fun") return sv;
    if (gt) return { range, source: "GeckoTerminal", candles: gt, status: "ok" };
    return sv ?? { range, source: "", candles: [], status: "error" };
  }
  // this browser asks the free chart source first (its own per-address limit, not the server's); the server only if that gives nothing.
  const spec = CHART_RANGES[range];
  const own = spec ? await browserCharts.candles(address, spec).catch(() => null) : null;
  if (own) return { range, source: "GeckoTerminal", candles: own, status: "ok" };
  const sv = await fromServer();
  return sv ?? { range, source: "", candles: [], status: "error" };
}
/** TradingView's symbol for a coin it lists (the server asks TradingView's search; its CORS refuses a browser), else null. */
async function fetchTvSymbol(address: string): Promise<string | null> {
  try {
    const r = await fetch(`/api/tvsymbol?address=${encodeURIComponent(address)}`, { cache: "no-store" });
    if (!r.ok) return null;
    const j = (await r.json()) as { symbol?: unknown };
    return typeof j.symbol === "string" ? j.symbol : null;
  } catch {
    return null;
  }
}
const deepscan = createDeepScan({
  fetchChart,
  fetchDossier,
  fetchBudget,
  fetchDetail,
  fetchTrades,
  items: () => store.items,
  onPick: (token) => openDeepScan(token),
  onPinchStart: () => {
    cam.touching = true;
    cam.stopMotion();
  },
  onPinch: (ratio, cx, cy) => cam.zoomAbout(cam.logZoom + Math.log(ratio), cx, cy, view),
  onPinchEnd: () => {
    cam.touching = false;
    onZoomEnd();
  },
  onZoomWheel: (dy, cx, cy) => {
    cam.cancelHoming();
    cam.anchorX = cx;
    cam.anchorY = cy;
    cam.vz += -dy * 0.045;
    clearTimeout(zoomWheelTimer);
    zoomWheelTimer = setTimeout(onZoomEnd, 180);
  },
});
document.getElementById("inner")!.append(deepscan.el);

/** Candles at one timeframe for a chart. A failure is an answer too ("error"), never a made-up line. */
async function fetchCandles(address: string, tf: TF): Promise<CandlesResult> {
  const spec = TIMEFRAMES[tf];
  const own = spec ? await browserCharts.candles(address, spec).catch(() => null) : null;
  if (own) return { tf, source: "GeckoTerminal", candles: own, status: "ok" };
  try {
    const r = await fetch(`/api/candles?address=${encodeURIComponent(address)}&tf=${tf}`, { cache: "no-store" });
    if (!r.ok) throw new Error(`server answered ${r.status}`);
    return (await r.json()) as CandlesResult;
  } catch {
    return { tf, source: "", candles: [], status: "error" };
  }
}
/** The engine's recent trades for a token. Null when they could not be asked (no file is an answer too: `none`). */
async function fetchTrades(address: string): Promise<TradesView | null> {
  try {
    const r = await fetch(`/api/trades?address=${encodeURIComponent(address)}`, { cache: "no-store" });
    return r.ok ? ((await r.json()) as TradesView) : null;
  } catch {
    return null;
  }
}
/** The coin page's own figures for one coin, written onto its item; the tile list leaves them out. */
async function fetchDetail(it: Item): Promise<boolean> {
  if (!it.address) return false;
  try {
    const r = await fetch(`/api/token/detail?address=${encodeURIComponent(it.address)}`, { cache: "no-store" });
    if (!r.ok) return false;
    applyCoinPage(it, (await r.json()) as Partial<WireToken>);
    return true;
  } catch {
    return false;
  }
}
/** The cleaned evidence for a token (word bands, facts, approved sentences, links). Null when it could not be loaded. */
async function fetchBudget(): Promise<{ status: "on" | "off"; usedPct: number; asOfMs: number } | null> {
  try {
    const r = await fetch("/api/pinrbot/budget", { cache: "no-store" });
    if (!r.ok) return null;
    const j = (await r.json()) as { budget?: { status?: unknown; usedPct?: unknown; asOfMs?: unknown } | null };
    const b = j.budget;
    if (!b || (b.status !== "on" && b.status !== "off") || typeof b.usedPct !== "number" || typeof b.asOfMs !== "number") return null;
    return { status: b.status, usedPct: Math.max(0, Math.min(100, Math.round(b.usedPct))), asOfMs: b.asOfMs };
  } catch {
    return null;
  }
}

async function fetchDossier(address: string): Promise<Dossier | null> {
  try {
    const r = await fetch(`/api/dossier?address=${encodeURIComponent(address)}`, { cache: "no-store" });
    return r.ok ? ((await r.json()) as Dossier) : null;
  } catch {
    return null;
  }
}
/** The paper trail PINR keeps for a coin. Null when there is none yet or it could not be asked. */
async function fetchEvidence(address: string): Promise<Evidence | null> {
  try {
    const r = await fetch(`/api/evidence?address=${encodeURIComponent(address)}`, { cache: "no-store" });
    if (!r.ok) return null;
    const j = (await r.json()) as { evidence?: Evidence | null };
    return j.evidence ?? null;
  } catch {
    return null;
  }
}
// The DeepScan page: a lite chart at the top, links out to outside chart sites, and DeepScan's report below. PINR has no trading chart of its own.
const coinPage = createCoinPage({
  onHide: hideCoin,
  fetchChart,
  fetchTvSymbol,
  fetchEvidence,
  onPinchStart: () => {
    cam.touching = true;
    cam.stopMotion();
  },
  onPinch: (ratio, cx, cy) => cam.zoomAbout(cam.logZoom + Math.log(ratio), cx, cy, view),
  onPinchEnd: () => {
    cam.touching = false;
    onZoomEnd();
  },
  onZoomWheel: (dy, cx, cy) => {
    cam.cancelHoming();
    cam.anchorX = cx;
    cam.anchorY = cy;
    cam.vz += -dy * 0.045;
    clearTimeout(zoomWheelTimer);
    zoomWheelTimer = setTimeout(onZoomEnd, 180);
  },
});
document.getElementById("inner")!.append(coinPage.el);
// One page: the lite chart on top, DeepScan's dossier as its second half below the chart.
deepscan.mountDossier(coinPage.dossierHost);

/** What a wallet holds of the tracked tokens (public balances read by the feed server). Null when it could not be asked. */
async function fetchWallet(address: string): Promise<WalletView | null> {
  try {
    const r = await fetch(`/api/wallet?address=${encodeURIComponent(address)}`, { cache: "no-store" });
    return r.ok ? ((await r.json()) as WalletView) : null;
  } catch {
    return null;
  }
}
const pageGestures: GestureOptions = {
  onPinchStart: () => {
    cam.touching = true;
    cam.stopMotion();
  },
  onPinch: (ratio, cx, cy) => cam.zoomAbout(cam.logZoom + Math.log(ratio), cx, cy, view),
  onPinchEnd: () => {
    cam.touching = false;
    onZoomEnd();
  },
  onZoomWheel: (dy, cx, cy) => {
    cam.cancelHoming();
    cam.anchorX = cx;
    cam.anchorY = cy;
    cam.vz += -dy * 0.045;
    clearTimeout(zoomWheelTimer);
    zoomWheelTimer = setTimeout(onZoomEnd, 180);
  },
};
const walletPage = createWalletPage({
  fetchWallet,
  items: () => store.items,
  onOpenToken: (token) => openDeepScan(token),
  ...pageGestures,
});
document.getElementById("inner")!.append(walletPage.el);
// the PvP Arena, in the north room since the operator put PINR in the centre (2026-10-25).
const arenaPage = createArenaPage({
  fetchArena: async () => {
    const r = await fetch("/api/arena", { cache: "no-store" });
    return r.ok ? ((await r.json()) as Awaited<ReturnType<Parameters<typeof createArenaPage>[0]["fetchArena"]>>) : null;
  },
  onOpen: (address) => void openByAddress(address),
  ...pageGestures,
});
document.getElementById("inner")!.append(arenaPage.el);

/** The token the operator last looked at, so the page and its report open on the same one. */
let focusToken: Item | null = null;
/** Open a token's DeepScan page. */
function openDeepScan(token: Item): void {
  liveFeed.wantRest(); // its similar tokens come from every scored coin
  focusToken = token;
  coinPage.setItem(token);
  pages.setSubject(`${token.name} ${token.ticker}`);
  deepscan.setItem(token);
  goTo("deepscan");
  // A "Deep Scan" click opens the one page scrolled to its second half, the dossier.
  coinPage.scrollTo("dossier");
}

/** The pages that are real DOM pages standing over their room on the map (everything but PINR itself and the ad areas). */
const isOverlayPage = (id: PageId): boolean => id === "discover" || id === "deepscan" || id === "wallet" || id === "arena";

/** Space kept free above the grid for the header and below it for the tab bar (measured on resize). */
let bottomInset = 90;
let topInset = 80;

/** Scroll limits come from the tiles now shown, so the view can never wander off into empty space. */
let bnd = { top: 0, bottom: 0 };
let seenLayout = -1;

/** The site map: where each page's frame sits, and which page the camera belongs to. */
let frames: Record<PageId, Frame> = pageFrames(378, 675);
let mapFit = 0.3;
let current: PageId = "pinr";
let mapMode = false;
let wasMapMode = false;
interface Journey {
  t: number;
  dur: number;
  from: CamState;
  to: CamState;
  dip: number;
}
let journey: Journey | null = null;
/** The pages visited before this one, most recent last (what the Back button returns to). */
const visited: PageId[] = [];

function boundsAt(s: number): { lo: number; hi: number; sideways: number } {
  let lo = bnd.top + (view.h / 2 - topInset) / s;
  let hi = bnd.bottom - (view.h / 2 - bottomInset) / s;
  if (lo > hi) lo = hi = (lo + hi) / 2; // fewer tiles than a screenful: centre them
  // Zoomed in past the screen width the grid may pan sideways, but only within its own edges.
  const sideways = Math.max(0, gridWidth(shownCols(userCols, view.w)) / 2 - view.w / 2 / s);
  return { lo, hi, sideways };
}

/** What the camera may do right now: scroll inside a page, or roam the whole map when zoomed out. */
function applyBounds(): void {
  if (journey) {
    cam.minX = cam.minY = -Infinity;
    cam.maxX = cam.maxY = Infinity;
    return;
  }
  const s = cam.scale;
  if (mapMode) {
    const e = mapExtent(frames);
    const rx = axisRange(e.left, e.right, view.w / 2 / s, view.w / 2 / s);
    const ry = axisRange(e.top, e.bottom, (view.h / 2 - topInset) / s, (view.h / 2 - bottomInset) / s);
    cam.minX = rx.min;
    cam.maxX = rx.max;
    cam.minY = ry.min;
    cam.maxY = ry.max;
  } else if (current === "pinr") {
    const b = boundsAt(s);
    cam.minY = b.lo;
    cam.maxY = b.hi;
    cam.minX = frames.pinr.x + frames.pinr.w / 2 - b.sideways;
    cam.maxX = frames.pinr.x + frames.pinr.w / 2 + b.sideways;
  } else {
    // The other pages are one screen each: the camera rests on them.
    const c = cameraFor(frames[current], view.h, topInset, homeScale());
    cam.minX = cam.maxX = c.x;
    cam.minY = cam.maxY = c.y;
  }
}

/** Open a page chosen from the header or the menu. */
function openPage(id: PageId): void {
  goTo(id);
}

/** Fly to a page: zoom out, travel across the map, zoom back in and lock onto it. */
function goTo(id: PageId, keepZoom = false, record = true): void {
  // Discover (its lists and its search) and a coin's page (its similar tokens) use every scored coin, so the scored set is read
  // the first time either opens.
  if (id === "discover" || id === "deepscan") liveFeed.wantRest();
  // Remember where you came from, so Back can return (a page is never listed twice in a row).
  if (record && id !== current && visited[visited.length - 1] !== current) {
    visited.push(current);
    if (visited.length > 30) visited.shift();
  }
  if (id === "deepscan" && !focusToken) {
    // The page is never empty: it opens on the roster's most active token until you pick another.
    focusToken = rankDiscover("trending", store.items, "")[0] ?? null;
    coinPage.setItem(focusToken);
    deepscan.setItem(focusToken);
  }
  settings.show(false);
  whitepaper.show(false);
  guide.show(false);
  adsApply.show(false);
  header.closePanels();
  const home = homeScale();
  const pinrHome = cameraFor(frames.pinr, view.h, topInset, home);
  let fromY = cam.y;
  // Leaving PINR scrolled far down: the trip starts from its first screen, which is all the map shows of it.
  if (current === "pinr" && !mapMode && fromY > pinrHome.y + frames.pinr.h) fromY = pinrHome.y;
  const to = cameraFor(frames[id], view.h, topInset, keepZoom ? cam.scale : home);
  const dist = Math.hypot(to.x - cam.x, to.y - fromY);
  const step = frames.pinr.h + PAGE_GAP;
  const maxDip = Math.max(0, Math.log(home / mapFit) * 0.98);
  journey = {
    t: 0,
    dur: keepZoom ? 0.45 : journeySeconds(dist, step),
    from: { x: cam.x, y: fromY, lz: cam.logZoom },
    to: { x: to.x, y: to.y, lz: keepZoom ? cam.logZoom : Math.log(home) },
    dip: keepZoom ? 0 : journeyDip(dist, step, maxDip),
  };
  cam.stopMotion();
  current = id;
  tabbar.setActive(id);
}

/** After a pinch or trackpad zoom: if you are left looking at the map, near enough to a page, lock onto it. */
let settlePending = false;
function onZoomEnd(): void {
  if (journey) {
    // A glide is still running (e.g. recentring PINR): settle as soon as it ends.
    settlePending = true;
    return;
  }
  if (!mapMode) {
    // Let go almost at home: settle all the way, so the page is never left a hair too small to touch.
    if (cam.scale < homeScale() * 0.999) {
      const h = cameraFor(frames[current], view.h, topInset, homeScale());
      cam.flyTo(h.x, current === "pinr" ? cam.y : h.y, homeScale());
    }
    return;
  }
  const near = nearestPage(frames, cam.x, cam.y, view.h, topInset, cam.scale);
  if (cam.scale >= homeScale() * 0.75) goTo(near);
  else {
    current = near;
    tabbar.setActive(near);
  }
}

/** The zoom at which the chosen number of columns exactly fills the screen width. */
function homeScale(): number {
  // A phone keeps the apps' rule (its 2, 3 or 4 across fill the width, at most 4 times). A computer's shown columns always fill the width
  // (world/grid.ts: a wider window shows more tiles across at the chosen size).
  if (view.w < PHONE_WIDTH) return Math.min(4, fitScale(userCols, view.w));
  return fitScale(shownCols(userCols, view.w), view.w);
}

/** The zoom the whole-site view settles at. */
const macroScale = (): number => mapFit * 1.05;
/** True when the camera is already at (about) the full macro zoom. */
const atMacro = (): boolean => mapMode && !journey && Math.abs(cam.scale / macroScale() - 1) < 0.03;

/** Macro zoom: fly out until the whole site map fits the screen, centred. */
function seeWholeSite(): void {
  settings.show(false);
  whitepaper.show(false);
  guide.show(false);
  adsApply.show(false);
  header.setPage(current);
  const e = mapExtent(frames);
  const s = macroScale();
  // The middle of the map goes to the middle of the space between the header and the footer.
  const lift = (topInset - bottomInset) / 2 / s;
  cam.flyTo((e.left + e.right) / 2, (e.top + e.bottom) / 2 - lift, s);
}

function layoutHome(): void {
  const cols = clampCols(userCols, view.w);
  userCols = cols;
  // the grid shows as many across as fill the window (never fewer than chosen); the control keeps the chosen count
  const across = shownCols(cols, view.w);
  field.setCols(across);
  header.setCols(allowedCols(view.w), cols);
  const scale = homeScale();
  // 5 rows fill one screen at home (a 5 x 5 grid); the grid scrolls on down to the roster size. At phone width the tiles keep the apps'
  // shape instead (about 1.52 times as tall as wide, at 2, 3 or 4 across), so 2 across shows big tiles as in the apps, not wide strips.
  // On a computer each tile is the browser window in small: its height to width is the window's (the operator, 2026-10-25: "rooms and tiles").
  field.setCellHeight(view.w < PHONE_WIDTH ? PHONE_TILE_TALL * CARD_W : Math.max(24, (CARD_W * view.h) / view.w));
  // Zoom locks onto the 5 x 5 view and goes no closer. The far limit is a placeholder for the site map:
  // it will be where all five pages are in view.
  // Page frames on the map. A frame is what one screen of a page covers.
  // Each room is one browser window's shape; it starts under the header and
  // runs on under the footer, as a website's page does. A phone keeps the room between the header and the footer, as the apps do.
  frames = pageFrames(gridWidth(across), (view.w < PHONE_WIDTH ? view.h - topInset - bottomInset : view.h) / scale);
  pages.setFrames(frames);
  // A page is as wide as its room is on screen at home zoom: the whole browser width, at every size, so it lines up with the room it stands in.
  document.documentElement.style.setProperty("--page-w", `${(frames.pinr.w * scale).toFixed(2)}px`);
  // A computer's room is the whole window tall but starts under the header, so its last (header + footer) is out of sight: the ad areas keep
  // their slots above it, so every slot can be clicked. A phone's room already ends at the footer.
  document.documentElement.style.setProperty("--room-hidden", `${view.w < PHONE_WIDTH ? 0 : ((topInset + bottomInset) / scale).toFixed(2)}px`);
  mapFit = mapFitScale(frames, view.w, view.h, topInset, bottomInset);
  // Zoom locks onto the 5 x 5 view and goes no closer; the far limit is where all five pages are in view.
  cam.zoomHi = Math.log(scale);
  cam.zoomLo = Math.log(mapFit);
  const home = cameraFor(frames[current], view.h, topInset, scale);
  cam.setHome(home.x, home.y, scale);
}

/** Choose a tile count: the grid dissolves and re-forms with the new count, and the view settles to fit it. */
function setUserCols(n: number): void {
  userCols = clampCols(n, view.w);
  try {
    localStorage.setItem("pinr.cols", String(userCols));
  } catch {
    /* not saved; still works for this visit */
  }
  layoutHome();
  const h = cameraFor(frames[current], view.h, topInset, homeScale());
  cam.flyTo(h.x, cam.y, homeScale());
}

function resize(): void {
  view.w = innerWidth;
  view.h = innerHeight;
  dpr = Math.min(devicePixelRatio || 1, 3);
  // The dots are tiny: they don't need a sharp 3x canvas, which on a phone is millions of pixels redrawn every frame.
  grid.resize(view.w, view.h, Math.min(dpr, 2));
  streams.resize(view.w, view.h, Math.min(dpr, 2));
  const hb = header.el.getBoundingClientRect();
  topInset = hb.bottom + 10;
  bottomInset = view.h - tabbar.top() + 10;
  // The grid is cut cleanly at the header's and footer's edges.
  document.documentElement.style.setProperty("--clip-top", `${hb.bottom + 2}px`);
  document.documentElement.style.setProperty("--clip-bottom", `${view.h - tabbar.top() + 2}px`);
  document.documentElement.style.setProperty("--vh", `${view.h}px`);
  layoutHome();
  // A window resized while a page is open: the page settles at once to the new window's size (checklist 5; the operator's "auto resize with my
  // browser"), instead of keeping the old zoom. PINR keeps its scroll; the map and a glide in progress are left alone.
  if (sized && !mapMode && !journey) {
    const h = cameraFor(frames[current], view.h, topInset, homeScale());
    cam.logZoom = Math.log(homeScale());
    cam.x = h.x;
    if (current !== "pinr") cam.y = h.y;
    cam.stopMotion();
  }
  sized = true;
}
let sized = false;
addEventListener("resize", resize);
resize();
cam.jumpHome();

const touches = new Map<number, { x: number; y: number }>();

/**
 * Pressing. In a page, a mouse hovering over a tile swells it a little; a finger held on it (about a third of a second,
 * without moving) swells it more, and it presses out against its neighbours. In the map the very same thing happens to
 * the rooms, and tapping, clicking, or pressing and releasing a room flies to it.
 */
const HOLD_MS = 340;
const MOVE_PX = 10;
let holdTimer: ReturnType<typeof setTimeout> | undefined;
/** Held on a tile a little longer: the Hide menu. The release after it must not open the tile. */
const LONG_MS = 600;
let longTimer: ReturnType<typeof setTimeout> | undefined;
let longPressed = false;
let holding = false;
let downAt = { x: 0, y: 0 };
let moved = false;
let touchCount = 0;
let multi = false;
const inMap = (): boolean => mapMode && !journey;
function tileUnder(clientX: number, clientY: number): number | null {
  if (mapMode || journey || current !== "pinr") return null;
  const w = cam.screenToWorld(clientX, clientY, view);
  return field.tileAt(w.x, w.y);
}
function roomUnder(clientX: number, clientY: number): PageId | null {
  if (!inMap()) return null;
  const w = cam.screenToWorld(clientX, clientY, view);
  return pages.roomAt(w.x, w.y);
}
function press(clientX: number, clientY: number, hover: boolean): void {
  if (inMap()) pages.setPressed(roomUnder(clientX, clientY), hover ? SIM.hoverSwell * 0.6 : SIM.holdSwell * 0.5);
  else field.setPressed(tileUnder(clientX, clientY), hover ? SIM.hoverSwell : SIM.holdSwell);
}
function hideMenuAt(x: number, y: number): boolean {
  const id = tileUnder(x, y);
  const token = id === null ? undefined : store.items.find((i) => i.id === id);
  if (!token || !token.address) return false;
  showHideMenu(x, y, token, hideCoin);
  return true;
}
function letGo(): void {
  clearTimeout(longTimer);
  longTimer = undefined;
  clearTimeout(holdTimer);
  holdTimer = undefined;
  holding = false;
  field.setPressed(null);
  pages.setPressed(null);
}
stage.addEventListener("pointermove", (e) => {
  if (e.pointerType === "mouse") {
    if (e.buttons === 0) press(e.clientX, e.clientY, true);
    return;
  }
  const tp = touches.get(e.pointerId);
  if (tp) {
    tp.x = e.clientX;
    tp.y = e.clientY;
  }
  // A finger that moves is scrolling, not holding or tapping.
  if (Math.hypot(e.clientX - downAt.x, e.clientY - downAt.y) > MOVE_PX) {
    moved = true;
    clearTimeout(holdTimer);
    holdTimer = undefined;
    clearTimeout(longTimer);
    longTimer = undefined;
  }
});
stage.addEventListener("pointerdown", (e) => {
  if (e.pointerType === "mouse") {
    downAt = { x: e.clientX, y: e.clientY };
    moved = false;
    multi = false;
    return;
  }
  touchCount++;
  touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (touchCount > 1) {
    multi = true;
    return letGo(); // a second finger means a pinch
  }
  multi = false;
  moved = false;
  longPressed = false;
  closeHideMenu();
  downAt = { x: e.clientX, y: e.clientY };
  holdTimer = setTimeout(() => {
    const hit = inMap() ? roomUnder(downAt.x, downAt.y) !== null : tileUnder(downAt.x, downAt.y) !== null;
    if (!hit) return;
    holding = true;
    press(downAt.x, downAt.y, false);
    navigator.vibrate?.(8); // a tiny tick where the phone supports it
    if (!inMap()) {
      longTimer = setTimeout(() => {
        if (moved || !hideMenuAt(downAt.x, downAt.y)) return;
        longPressed = true;
        navigator.vibrate?.(14);
      }, LONG_MS);
    }
  }, HOLD_MS);
});
const release = (e: PointerEvent): void => {
  const isMouse = e.pointerType === "mouse";
  if (!isMouse) {
    touches.delete(e.pointerId);
    touchCount = Math.max(0, touchCount - 1);
  }
  if (isMouse && Math.hypot(e.clientX - downAt.x, e.clientY - downAt.y) > MOVE_PX) moved = true;
  // Press and release on a room, without dragging or pinching: go there.
  if (e.type === "pointerup" && !moved && !multi && inMap()) {
    const room = roomUnder(e.clientX, e.clientY);
    if (room) goTo(room);
  }
  // Press and release on an ad space: its PINRads application page, the space pre-filled.
  else if (e.type === "pointerup" && e.button === 0 && !moved && !multi && !mapMode && !journey && current.startsWith("ad") && current !== "arena") {
    const slot = adSlotUnder(e.clientX, e.clientY);
    if (slot) openAdsApply(slot);
  }
  // Press and release on a token in the PINR page: open its dossier in PINRbot DeepScan.
  else if (e.type === "pointerup" && e.button === 0 && !moved && !multi && !longPressed && !mapMode && !journey && current === "pinr") {
    const id = tileUnder(e.clientX, e.clientY);
    const token = id === null ? undefined : store.items.find((i) => i.id === id);
    if (token) openDeepScan(token);
  }
  if (!isMouse || holding) letGo();
  if (!isMouse && touchCount === 0) multi = false;
};
// A right-click (or the phone's own long-press menu) on a tile: the same Hide menu.
stage.addEventListener("contextmenu", (e) => {
  if (hideMenuAt(e.clientX, e.clientY)) e.preventDefault();
});
stage.addEventListener("pointerup", release);
stage.addEventListener("pointercancel", release);
stage.addEventListener("pointerleave", () => letGo());

attachInput(stage, cam, () => view, () => {}, onZoomEnd, () => holding);
if (import.meta.env.DEV) {
  Object.assign(window, {
    __cam: cam,
    __store: store,
    __field: field,
    __streams: streams,
    __header: header,
    __discover: discover,
    __deepscan: deepscan,
    __coinPage: coinPage,
    __wallet: walletPage,
    __guide: guide,
    __live: liveFeed,
    __goTo: goTo,
    __state: () => ({ current, mapMode, journey: journey !== null, frames, mapFit }),
  });
}

/**
 * One light source for the whole interface. It rests top-left and slides against camera motion,
 * so cards catch the light differently as you move: they feel like objects, not pictures.
 */
let lastBgT = "";
const light = { x: -0.4, y: -0.55 };
let prevX = cam.x;
let prevY = cam.y;
let svx = 0;
let svy = 0;

let lastPageKey = "";
let lastDataCheck = -1e9;
let lastEventCheck = -1e9;
let lastDataKey = "";
let prevLz = cam.logZoom;
let holdFrames = 0;
/** Camera speed (screen px/s) or zoom speed (log units/s) above which the decorative streaks pause. */
const FAST_PX = 700;
const FAST_ZOOM = 0.9;
let last = performance.now();
/**
 * A frame that goes wrong must never stop the show. If drawing throws (say, one odd token), the error is counted and shown in
 * the Diagnostics panel, and the very next frame runs as usual: the screen never freezes.
 */
let drawErrors = 0;
let lastDrawError = "";
/** Run one drawing step on its own: if it throws, it is counted and the other steps still run. */
function safely(fn: () => void): void {
  try {
    fn();
  } catch (e) {
    drawErrors++;
    lastDrawError = e instanceof Error ? e.message : String(e);
    if (drawErrors <= 3) console.error("PINR: a drawing step failed:", e);
  }
}
function frame(now: number): void {
  try {
    frameBody(now);
  } catch (e) {
    drawErrors++;
    lastDrawError = e instanceof Error ? e.message : String(e);
    if (drawErrors <= 3) console.error("PINR: a frame could not be drawn:", e);
  } finally {
    requestAnimationFrame(frame);
  }
}
function frameBody(now: number): void {
  const dtMs = now - last;
  last = now;
  // Clamp so a background-tab pause never launches the camera across the world.
  const dt = Math.min(dtMs, 50) / 1000;
  const t0 = performance.now();
  // A trip between pages moves the camera directly; touching the screen cancels it.
  if (journey) {
    if (cam.touching) journey = null;
    else {
      journey.t = Math.min(1, journey.t + dt / journey.dur);
      const p = journeyAt(journey.t, journey.from, journey.to, journey.dip);
      cam.x = p.x;
      cam.y = p.y;
      cam.logZoom = Math.min(cam.zoomHi, Math.max(cam.zoomLo, p.lz));
      cam.stopInertia();
      if (journey.t >= 1) {
        journey = null;
        if (settlePending) {
          settlePending = false;
          mapMode = cam.scale < homeScale() * 0.985;
          onZoomEnd();
        }
      }
    }
  }
  mapMode = cam.scale < homeScale() * 0.985;
  // Zooming out of a deeply scrolled PINR page: glide back to its first screen, which is what the map shows.
  if (mapMode && !wasMapMode && !journey && current === "pinr") {
    const h = cameraFor(frames.pinr, view.h, topInset, homeScale());
    if (cam.y > h.y + frames.pinr.h * 0.5) goTo("pinr", true);
  }
  wasMapMode = mapMode;
  cam.step(dt, view);

  // Camera speed on screen, in px/s, eased.
  const s = cam.scale;
  const k = 1 - Math.exp(-dt * 10);
  svx += (-((cam.x - prevX) * s) / dt - svx) * k;
  svy += (-((cam.y - prevY) * s) / dt - svy) * k;
  prevX = cam.x;
  prevY = cam.y;
  const lk = 1 - Math.exp(-dt * 6);
  light.x += (-0.4 - Math.max(-1, Math.min(1, svx / 2500)) * 0.9 - light.x) * lk;
  light.y += (-0.55 - Math.max(-1, Math.min(1, svy / 2500)) * 0.9 - light.y) * lk;

  // The live background drifts a little against the camera and swells slightly as you zoom in: depth.
  // Computed first: the video element and the blurred copy under the glass must use the very same placement.
  const place = {
    tx: view.w * 0.06 * Math.tanh((-cam.x * s) / 900),
    ty: view.h * 0.06 * Math.tanh((-cam.y * s) / 1400),
    scale: 1 + 0.25 * Math.max(0, Math.tanh(Math.log(s) * 0.3)),
  };
  const bgT = `translate3d(${place.tx.toFixed(1)}px,${place.ty.toFixed(1)}px,0) scale(${place.scale.toFixed(4)})`;
  if (bgT !== lastBgT) {
    lastBgT = bgT;
    bgVid.style.transform = bgT;
    if (bgSvg) bgSvg.style.transform = bgT;
  }

  feed.tick(store, dt);
  // The first tiles are in: now the phone's background video may load.
  if (!tilesUp && store.items.length > 0) {
    tilesUp = true;
    syncBgSource();
    syncBgPlayback();
  }
  if (!off.has("grid")) grid.draw(cam, view, Math.min(dpr, 2));
  // Map view: PINR shows only its first screen (rows beyond it would run into the neighbouring pages).
  const mapish = mapMode || journey !== null;
  field.setFrameClip(mapish || current !== "pinr" ? frames.pinr.h : null);
  // Discover and DeepScan are real pages that move and scale with the camera, so zooming out is that same page getting smaller.
  const home = homeScale();
  const zoomedOut = cam.scale < home * 0.999;
  const sc = cam.scale;
  const mapness = Math.min(1, Math.max(0, (1 - sc / home) * 20));
  const placementOf = (id: PageId): Placement => {
    const pr = pages.roomPress(id);
    const f = frames[id];
    const cx = f.x + f.w / 2;
    const cy = f.y + f.h / 2;
    const lx = f.x;
    const ly = f.y - topInset / home; // the page's own top edge sits topInset (screen px at home) above its room
    const wx = cx + pr.scale * (lx - cx) + pr.ox;
    const wy = cy + pr.scale * (ly - cy) + pr.oy;
    return { x: (wx - cam.x) * sc + view.w / 2, y: (wy - cam.y) * sc + view.h / 2, k: (pr.scale * sc) / home, top: topInset, bottom: bottomInset, radius: (26 / home) * mapness };
  };
  const discoverShown = current === "discover" || mapish;
  // Discover drawn at all (its own page, or the map, or reached by zooming in): it lists every scored coin.
  if (discoverShown) liveFeed.wantRest();
  if (discoverShown) {
    discover.place(placementOf("discover"), current === "discover" && !mapish && !zoomedOut);
    safely(() => discover.update(now / 1000, current === "discover" && !mapish && !zoomedOut && holdFrames === 0));
  } else discover.place(null, false);
  // The coin's lite chart and DeepScan's report are one page in DeepScan's room: the page stands there with the report as its second half.
  // DeepScan's own overlay is never placed; it only keeps the dossier's sections alive.
  deepscan.place(null, false);
  const coinPageShown = current === "deepscan" || mapish;
  if (coinPageShown) {
    coinPage.place(placementOf("deepscan"), current === "deepscan" && !mapish && !zoomedOut);
    safely(() => coinPage.update(now / 1000));
    safely(() => deepscan.update(now / 1000));
  } else coinPage.place(null, false);
  if (current === "arena" || mapish) {
    arenaPage.place(placementOf("arena"), current === "arena" && !mapish && !zoomedOut);
    safely(() => arenaPage.update(now / 1000));
  } else arenaPage.place(null, false);
  const walletShown = current === "wallet" || mapish;
  if (walletShown) {
    walletPage.place(placementOf("wallet"), current === "wallet" && !mapish && !zoomedOut);
    safely(() => walletPage.update(now / 1000));
  } else walletPage.place(null, false);
  // The glass plates behind the pages (shown in the map) fade in as a page starts to shrink, so nothing pops.
  pagesRoot.style.setProperty("--dplate", mapness.toFixed(3));
  pages.update(cam, view, mapish || (current !== "pinr" && !isOverlayPage(current)) || (isOverlayPage(current) && zoomedOut), dt);
  field.setGroup(mapish ? pages.pinrPress() : { scale: 1, ox: 0, oy: 0, cx: 0, cy: 0 });
  // Hovering or holding applies to the tiles in a page, or to the rooms in the map, never both at once.
  if (mapMode) field.setPressed(null);
  else pages.setPressed(null);
  header.setActive(!mapish && (current === "pinr" || current === "discover"), !mapish && current === "pinr");
  if (now - lastEventCheck > 500) {
    lastEventCheck = now;
    trackEvents(Date.now());
  }
  if (now - lastDataCheck > 700) {
    lastDataCheck = now;
    const dv = dataView();
    const key = `${dv.long}|${dv.status}|${dv.note}`;
    if (key !== lastDataKey) {
      lastDataKey = key;
      header.setDataLabel(dv.long, dv.short);
      settings.setDataStatus(dv.status, dv.warn);
      settings.setDataNote(dv.note);
    }
    {
      const st = streamsState();
      settings.setMotionNote(st.on ? "Buy and sell streaks on tiles and rows" : st.text);
    }
  }
  const pageKey = settings.isOpen() ? "settings" : whitepaper.isOpen() ? "paper" : guide.isOpen() ? "guide" : current;
  if (pageKey !== lastPageKey) {
    lastPageKey = pageKey;
    header.setPage(pageKey);
  }
  safely(() => field.tick(store, dt, cam, view, light));
  if (field.layoutVersion !== seenLayout) {
    // The arrangement was rebuilt (first time, a filter, or a new tile count): refit the scroll limits and settle the view.
    const first = seenLayout < 0;
    seenLayout = field.layoutVersion;
    bnd = field.bounds();
    streams.reset();
    // Home: the top of the current page sits just under the header, at the zoom that fits the width.
    const h = cameraFor(frames[current], view.h, topInset, homeScale());
    cam.setHome(h.x, h.y, homeScale());
    if (first) cam.jumpHome();
    else if (current === "pinr" && !mapMode && !journey) cam.flyHome();
  }
  applyBounds();
  // While the map is showing, "which page am I on" follows the camera, so zooming in over a room locks onto that room.
  if (mapMode && !journey) current = nearestPage(frames, cam.x, cam.y, view.h, topInset, s);
  if (!journey) tabbar.setActive(current);
  tabbar.setCompass(current, atMacro());
  header.setBack(visited.length > 0 || (mapMode && !journey));
  const vt = field.visibleTiles();
  streams.still = reduceMotion.matches || !motionEnabled;
  // While the camera is moving fast (a fling, a quick pinch, a trip between pages) the tiles are a blur anyway: the trade
  // streaks wait, so every frame goes to moving things smoothly. They come back the moment it settles.
  const zoomRate = Math.abs(cam.logZoom - prevLz) / Math.max(dt, 1e-3);
  prevLz = cam.logZoom;
  if (journey !== null || Math.hypot(svx, svy) > FAST_PX || zoomRate > FAST_ZOOM) holdFrames = 10;
  else if (holdFrames > 0) holdFrames--;
  const fast = holdFrames > 0;
  if (!off.has("streams")) {
    if (fast) streams.hold();
    else safely(() => streams.draw(vt.list, vt.count, dt, view.w, view.h, Math.min(dpr, 2), now / 1000));
  }

  hud.cpu += (performance.now() - t0 - hud.cpu) * 0.05;
  hud.extra = `tiles ${field.count} · ${userCols} per row · ${mapMode ? "map" : current}`;
  hud.push(dtMs, now);
}
requestAnimationFrame(frame);

// D3: pinr.io/?coin=<address> opens that coin's page. A coin on no list
// is asked for by its address. The lists arrive within seconds; after about 12 s an unknown address simply leaves the PINR page as it is.
const COIN_LINK = /^(0x[0-9a-fA-F]{40}|[1-9A-HJ-NP-Za-km-z]{32,44})$/;
const coinLink = (new URLSearchParams(location.search).get("coin") ?? "").trim();
if (COIN_LINK.test(coinLink)) void openCoinLink(coinLink);
/** Open a coin's DeepScan page by its address (an Arena version may be on no list yet): from the store, else asked for by address. */
async function openByAddress(address: string): Promise<void> {
  const lower = address.toLowerCase();
  for (let i = 0; i < 40; i++) {
    const it = store.items.find((x) => x.address?.toLowerCase() === lower);
    if (it) return openDeepScan(it);
    if (i === 0 && !(await liveFeed.find(address))) return notListed(address);
    await new Promise((r) => setTimeout(r, 250));
  }
  notListed(address);
}
/** A coin asked for that PINR does not list now says so, never nothing. */
function notListed(address: string): void {
  showNote(`This coin is not on PINR's lists right now (${shortAddress(address)}).`);
}
async function openCoinLink(address: string): Promise<void> {
  const lower = address.toLowerCase();
  // The page settles first (its opening layout and camera, and the first list landing); a coin opened before that is put back on the
  // PINR page. So wait for the first list (at least 1.5 s, at most about 10 s), then a moment more, then ask for the coin at once.
  await new Promise((r) => setTimeout(r, 1500));
  for (let i = 0; i < 34 && store.items.length === 0; i++) await new Promise((r) => setTimeout(r, 250));
  await new Promise((r) => setTimeout(r, 600));
  for (let i = 0; i < 48; i++) {
    const it = store.items.find((x) => x.address?.toLowerCase() === lower);
    if (it) {
      openDeepScan(it);
      coinPage.scrollTo("chart");
      return;
    }
    // not on the first page: ask the server for this one coin at once; a coin the server does not know says so
    if (i === 0 && !(await liveFeed.find(address))) return notListed(address);
    await new Promise((r) => setTimeout(r, 250));
  }
  notListed(address);
}
