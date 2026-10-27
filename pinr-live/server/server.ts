import { createServer, type IncomingMessage } from "node:http";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { FeedReader, type FeedSnapshot } from "./feed.ts";
import { readDossier } from "./dossier.ts";
import { readSocial } from "./social.ts";
import { summarize } from "./trades.ts";
import { readHoldings } from "./wallet.ts";
import { readEvents } from "./events.ts";
import { readMetric } from "./metrics.ts";
import { fetcherWith, isChartRange, isTimeframe, MarketWorker, SOURCE_NAME, type Candle } from "./market.ts";
import { providersFromEnv, QuoteWorker } from "./quotes.ts";
import { PumpfunUniverse } from "./pumpfun.ts";
import { GeckoBudget } from "./geckobudget.ts";
import { DEMO_API, DEMO_HEADER, demoKeyFrom, GeckoKeyRoute } from "./geckokey.ts";
import { chainOf, onServedChains, servedChains } from "./chains.ts";
import { GeckoPools } from "./geckopools.ts";
import { publicCurveCheck, PumpPortalFeed } from "./pumpportal.ts";
import { coinPageFields, tileView, type CoinPageFields } from "./tileview.ts";
import { StreamHub } from "./stream.ts";
import { SolPrice, TickReader, withLiveEnd } from "./ticks.ts";
import { DROP_DIR, feedDirs } from "./feed.ts";
import { isVamp, lite, markCopies, stripVamp } from "./vamp.ts";
import { Tape } from "./tape.ts";
import { Wanted } from "./wanted.ts";
import { ActivityBoard, chooseHidden, finalFamilies, groupMembers, HIDDEN_NOTICE, planGroups, planGroupsStepped, WINDOW_MS, type Plan } from "./hidden.ts";
import { readBudget } from "./budgetmeter.ts";
import { FUNDING_NOT_TRACED, readEvidence } from "./evidence.ts";
import { directImageUrl } from "./imagehosts.ts";
import { isControlPath, proxyControl } from "./controlproxy.ts";
import { JupiterMeta } from "./jupmeta.ts";
import { LiteFill } from "./liteline.ts";
import { TvSymbols } from "./tvsymbol.ts";
import { CandleFiles, type CandleSize } from "./candlefile.ts";
import { startPushIn } from "./pushin.ts";
import { arenaGroups, behindLeaders, pvpReader } from "./arena.ts";
import { poolRowsOf, readPoolEvents } from "./poolevents.ts";
import { CHART_WAIT_MS, within } from "./within.ts";
import { allInterval, isPumpLaunchpad, PumpCandles, finerSizes, RANGE_PLAN, SECONDS, type PumpInterval } from "./pumpcandles.ts";
import { maskDossier, maskEvents, maskToken, scoreServed } from "./hubmask.ts";
import { isQuiet, quietReader, splitQuiet } from "./quiet.ts";
import { candleOrder, routeToken, routingReader, type Figures } from "./routing.ts";
import { byFirstPage, firstPageKey } from "./firstpage.ts";
import { firstPageFactsOf } from "./feed.ts";
import { PictureHashes } from "./imagehash.ts";
import { ChainCreators } from "./chaincheck.ts";
import { VampDesk } from "./vampdesk.ts";
import { ImageCache } from "./imgcache.ts";
import { TapeFill } from "./tapefill.ts";
import { isLoopback, publicSnapshot, serveStatic, setSecurityHeaders } from "./staticsite.ts";
import { CONTRACT_VERSION, NO_SCORE_LABELS, type WireToken } from "./translate.ts";
import { AdsDesk } from "./adsapply.ts";
import { askerOf, LIVE_MS, WireMeter } from "./wiremeter.ts";

/**
 * The feed server: a small READ-ONLY local service. It answers on 127.0.0.1 only (the dev server passes /api through
 * to it, so a phone on your Wi-Fi reaches it via the page, never directly). No secrets live here or are sent out.
 *   GET /api/tokens   the tile-ready tokens (re-read from the result files, at most every 2 seconds)
 *   GET /api/health   is it up, and what does it see
 *   GET /api/contract the contract version and the no-score labels
 */
const PORT = Number(process.env.PINR_FEED_PORT ?? 8787);
/**
 * Production: PINR_PUBLIC=on makes this server also serve the built site (`dist/`, or PINR_STATIC_DIR) on the same origin as /api, answers
 * with the security headers, and keeps the providers' counters and the workers' stats off the public answers. It still listens on 127.0.0.1 unless
 * PINR_FEED_HOST says otherwise: the intended shape is a TLS proxy in front .
 */
const PUBLIC = process.env.PINR_PUBLIC === "on";
const HOST = process.env.PINR_FEED_HOST || "127.0.0.1";
const STATIC_ROOT = process.env.PINR_STATIC_DIR || join(import.meta.dirname, "..", "dist");
/** the coins with no trade for 24 hours (marked `quiet`), kept off every list and found by address (`/api/token/find`). Rebuilt with the lists. */
let quietCoins = new Map<string, WireToken>();
/** the engine's own marks (`frontend-feed/_quiet.json`): the coins the engine found with no trade in 24 hours. */
const quietMarks = quietReader(join(DROP_DIR, "_quiet.json"));
let cache: { at: number; body: string; tile: string; publicBody: string; publicTile: string; detail: Map<string, CoinPageFields> } | null = null;
/** How long a browser or cache may reuse one token list. */
const TOKENS_CACHE = "public, max-age=5";
/** Live changes by stream: one hub for the site's tile list, one for the apps' full list. See stream.ts. */
/** the engine's tick files (curve coins' own trades), and the SOL price that turns them into dollars. See ticks.ts. */
const ticks = new TickReader(process.env.PINR_TICKS_DIR || join(DROP_DIR, "ticks"));
const solPrice = new SolPrice();
solPrice.start();
const tileHub = new StreamHub();
const fullHub = new StreamHub();
// While anyone is listening, the lists are rebuilt on the server's own clock (the first page every 2 s, the scored set every 30 s), so the changes
// go out without any page polling for them.
// curve coins' own trades, as the engine's tick files change, down both streams (each trade once).
function pushTrades(): void {
  const changed = ticks.refresh();
  if (changed.length) wires.hit("a_trades>p_trades:trades", changed.length, changed[0]);
  if (changed.length && tileHub.size + fullHub.size > 0) {
    const fresh = ticks.newTrades(changed, solPrice.usd());
    if (fresh.length) wires.hit("p_trades>w_ribbon:trades", fresh.length, null);
    tileHub.publishTrades(fresh);
    fullHub.publishTrades(fresh);
  } else if (changed.length) ticks.newTrades(changed, solPrice.usd()); // nobody listening: only remember what was there
}
// a changed tick file is read and its trades sent 100 ms after the watch sees it (renames come in bursts),
// not at the next 2-second pass; the pass below still catches anything the watch missed.
let pushSoon: ReturnType<typeof setTimeout> | null = null;
ticks.onChange(() => {
  if (pushSoon) return;
  pushSoon = setTimeout(() => {
    pushSoon = null;
    pushTrades();
  }, 100);
});
setInterval(() => {
  if (tileHub.size + fullHub.size > 0) tokens();
  pushTrades();
}, 2000);
setInterval(() => {
  if (tileHub.size + fullHub.size > 0) restTokens();
}, 30_000);

/** Price history, 24h change and 24h volume for tokens whose engine file does not carry them (see market.ts). PINR_MARKET=off disables it. */
// Settings come from the environment, and from pinr-live/.env if it exists (never in git, never sent to the app). See .env.example.
const ENV_FILE = join(import.meta.dirname, "..", ".env");
if (existsSync(ENV_FILE)) process.loadEnvFile(ENV_FILE);
const env = process.env;
// trades the engine pushes the moment it hears them go down both streams on arrival (pushin.ts: 127.0.0.1 only, its own port).
const pushIn =
  env.PINR_PUSH === "off"
    ? null
    : startPushIn((mint, ticksIn) => {
        const fresh = ticks.pushed(mint, ticksIn, solPrice.usd());
        if (fresh.length) wires.hit("a_trades>p_trades:trades", fresh.length, mint);
        if (!fresh.length || tileHub.size + fullHub.size === 0) return;
        wires.hit("p_trades>w_ribbon:trades", fresh.length, mint);
        tileHub.publishTrades(fresh);
        fullHub.publishTrades(fresh);
      }, Number(env.PINR_PUSH_PORT) || undefined);
/** Charts and candles: GeckoTerminal. Free and public by default; a paid plan is the same service at another address with a key. */
const geckoKey = env.PINR_GECKO_KEY;
const geckoBudget = new GeckoBudget();
/** The operator's free CoinGecko Demo key (COINGECKO_API, saved in the engine's .env): a viewer's chart reads go through it, within its daily share (geckokey.ts). A paid PINR_GECKO_KEY takes every read instead. */
const demoKey = geckoKey ? null : demoKeyFrom(env.COINGECKO_API, join(DROP_DIR, "..", ".env"));
const geckoDemo = demoKey ? new GeckoKeyRoute(fetcherWith({ [DEMO_HEADER]: demoKey }), DEMO_API, join(import.meta.dirname, "..", ".cache", "gecko-demo-count.json")) : null;
const market =
  env.PINR_MARKET === "off"
    ? null
    : new MarketWorker(geckoKey ? fetcherWith({ [env.PINR_GECKO_KEY_HEADER ?? "x-cg-pro-api-key"]: geckoKey }) : undefined, Date.now, env.PINR_GECKO_BASE || undefined, geckoBudget, geckoDemo);
/** Current price, change, volume and liquidity: the quote providers, in the order named in PINR_QUOTE_PROVIDERS. */
const quotes = env.PINR_MARKET === "off" ? null : new QuoteWorker(providersFromEnv(env.PINR_QUOTE_PROVIDERS, env.JUPITER_API, Number(env.PINR_JUPITER_EVERY_MS) || undefined));
/** Names, pictures, links, holders and a price cross-check for every listed Solana coin from Jupiter Tokens v2 (100 a call, one call every 6 s), since Pump.fun's records refuse the server. server/jupmeta.ts. PINR_JUPMETA=off switches it off. */
const jupMeta = env.PINR_MARKET === "off" || env.PINR_JUPMETA === "off" ? null : new JupiterMeta((url, headers) => fetch(url, { headers: { accept: "application/json", "user-agent": "PINR-live/1.0 (read-only market data)", ...headers }, signal: AbortSignal.timeout(10_000) }), Date.now, env.JUPITER_API || undefined);
/** The coins listed on the first page as last served (scored first page and pool coins): what the quote and Jupiter sweeps keep fresh. */
let listedNow: WireToken[] = [];
/** Token pictures, fetched once and served from here (see imgcache.ts), so tiles fill in and the viewer never contacts a stranger's server. */
const images = new ImageCache(join(import.meta.dirname, "..", ".cache", "img"));
/** token address (lower case) -> the address its picture came from. Rebuilt with every token list; a VAMP's picture is never in it. */
const imageSources = new Map<string, string>();
let deskStats: () => Record<string, number> = () => ({});
/** Pump.fun read directly: every coin it lists, new and active and biggest (PINR_PUMPFUN=off disables it). See pumpfun.ts. */
const pumpfun = env.PINR_MARKET === "off" || env.PINR_PUMPFUN === "off" ? null : new PumpfunUniverse();
/** The pool of new Pump.fun coins comes from GeckoTerminal's newest pools now (Pump.fun's own list is behind a bot challenge): see geckopools.ts. */
/** The chains served: only those the scanner scores now, `PINR_CHAINS` (default solana; `all` for every chain). See chains.ts. */
const CHAINS = servedChains(env.PINR_CHAINS);
/** The engine's results on the served chains only: every list, search, per-coin route and reader starts from here. */
// a design decision fix (2026-10-20): the drop folder is read through one FeedReader, which keeps each file's token and re-reads only the files that
// changed; with nothing changed it gives back the same snapshot, and so does this (the same object), so nothing downstream is rebuilt for nothing.
const reader = new FeedReader();
const BOOT_MS = Date.now();
// After a restart the saved first page serves until every tick file has been read (so the quiet coins are known) or two minutes have passed.
reader.holdWhile = () => !ticks.firstPassDone() && Date.now() - BOOT_MS < 120_000;
// The cold start: the first full read runs in the background, and the last saved first page is served meanwhile (feed.ts, startWarm).
if (env.PINR_WARM !== "off") reader.startWarm(join(import.meta.dirname, "..", ".cache", "firstpage.json"));
/**
 * Coins left off pinr.io for now: every VAMP, and every member of a developer's duplicate-relaunch group except its most active
 * one (last 30 minutes). Address (lower case) to label. Chosen again at every rebuild; a direct request for one gets only the label and a notice.
 */
let hiddenCoins = new Map<string, string>();
/** Coins left off by the last pass over the served first page (copy families among the launchpad coins too); chosen again at every rebuild of the list. */
let finalHidden = new Map<string, string>();
/** The label for a coin left off by either pass, or undefined. */
const offLabel = (addrLower: string): string | undefined => hiddenCoins.get(addrLower) ?? finalHidden.get(addrLower);
let served: { from: FeedSnapshot; planAt: number; rawTokens: WireToken[]; rawRest: WireToken[]; byAddr: Map<string, WireToken>; plan: Plan; sig: string; out: FeedSnapshot } | null = null;
/** The developer wallet of a scored coin, from its feed file's `launcher` fact (kept: a coin's developer does not change). */
const launchers = new Map<string, string | null>();
function launcherOf(addrLower: string): string | null {
  // From the reader, which noted it while parsing the file (no second read); the file is read here only for a coin the reader has not parsed.
  const known = reader.launcherOf(addrLower);
  if (known !== undefined) return known;
  if (launchers.has(addrLower)) return launchers.get(addrLower)!;
  let w: string | null = null;
  const orig = served?.byAddr.get(addrLower)?.address;
  const dir = feedDirs()[0]?.dir;
  if (orig && dir) {
    try {
      const facts = (JSON.parse(readFileSync(join(dir, `${orig}.json`), "utf8")) as { facts?: unknown }).facts;
      const f = Array.isArray(facts) ? (facts as Record<string, unknown>[]).find((x) => x && x.id === "launcher") : undefined;
      w = f && typeof f.value === "string" && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(f.value) ? f.value : null;
    } catch {
      w = null;
    }
  }
  launchers.set(addrLower, w);
  return w;
}
/**
 * The coins the gate's result in a coin's evidence file ties it to (its earlier look-alike, the same creator's same-name coins). Bounded: a coin's answer is
 * kept five minutes, and one rebuild of the groups reads at most 300 files (the rest are read on the next rebuilds), so ten thousand feed files never
 * mean ten thousand file reads at once.
 */
const gateRelated = new Map<string, { at: number; coins: string[] }>();
let gateReads = 0;
const GATE_KEEP_MS = 5 * 60_000;
const GATE_READS_PER_PLAN = 300;
function gateOf(addrLower: string): string[] {
  const held = gateRelated.get(addrLower);
  if (held && Date.now() - held.at < GATE_KEEP_MS) return held.coins;
  if (gateReads >= GATE_READS_PER_PLAN) return held?.coins ?? [];
  gateReads++;
  const orig = served?.byAddr.get(addrLower)?.address;
  const coins: string[] = [];
  const g = orig ? readEvidence(orig)?.gate : undefined;
  for (const it of g?.items ?? []) {
    if (it.kind === "earlier_lookalike" && it.coin) coins.push(it.coin);
    else if (it.kind === "same_creator_relaunch") for (const c of it.coins) coins.push(c.coin);
  }
  gateRelated.set(addrLower, { at: Date.now(), coins });
  return coins;
}
/** The coins left off, chosen again at most every 5 seconds (it was every call: thousands of members each time). */
let chosen: { at: number; plan: Plan; hidden: Map<string, string>; sig: string } | null = null;
/** A stepped plan is being made; and whether the first (made at once) is done. */
let planning = false;
let planned = false;
const CHOOSE_EVERY_MS = 5000;
const loadServed = (): FeedSnapshot => {
  const f = reader.read();
  if (served?.from !== f) {
    const rawTokens = onServedChains(f.tokens, CHAINS);
    const rawRest = onServedChains(f.rest, CHAINS);
    const byAddr = new Map<string, WireToken>(); // built by loops, not through two spread copies of 67,000 coins
    for (const t of rawTokens) byAddr.set(t.address.toLowerCase(), t);
    for (const t of rawRest) byAddr.set(t.address.toLowerCase(), t);
    // The groups are kept across snapshots and made again once a minute (they were made again with every new snapshot, every 15 s).
    served = { from: f, planAt: served?.planAt ?? 0, rawTokens, rawRest, byAddr, plan: served?.plan ?? { groups: [], labels: new Map(), vamps: new Set(), cases: new Map() }, sig: "\u0000", out: f };
  }
  // The groups are made again at least once a minute (the picture desk's verdicts change slowly). The first plan after a start is made at once (so no
  // copy is ever listed); every later one runs in steps between requests (planGroupsStepped) while the last plan keeps serving: made in one go over
  // 58,000 coins it held every visitor up 0.8 to 2.4 s once a minute.
  if (Date.now() - served.planAt > 60_000 && !planning) {
    const all = [...served.rawTokens, ...served.rawRest];
    const verdicts = pumpfun ? pumpfun.vamps(served.rawTokens) : new Map<string, { id: string }>();
    const copyOf = (a: string): string | null => verdicts.get(served!.byAddr.get(a)?.address ?? "")?.id ?? null;
    gateReads = 0;
    const tp = performance.now();
    const done = (plan: Plan): void => {
      if (served) served = { ...served, plan, sig: "\u0000" };
      const planMs = performance.now() - tp;
      if (planMs > 3000) console.log(`copy groups: planned ${all.length} coins in ${(planMs / 1000).toFixed(1)} s (in steps)`);
    };
    served = { ...served, planAt: Date.now() };
    if (planned) {
      planning = true;
      void planGroupsStepped(all, launcherOf, copyOf, gateOf)
        .then(done)
        .catch((e: unknown) => console.error("copy groups: the plan failed; the last one stays", e))
        .finally(() => void (planning = false));
    } else {
      done(planGroups(all, launcherOf, copyOf, gateOf));
      planned = true;
    }
  }
  if (!chosen || chosen.plan !== served.plan || Date.now() - chosen.at > CHOOSE_EVERY_MS) {
    const h = chooseHidden(served.plan, served.byAddr, activityBoard.activityOf);
    chosen = { at: Date.now(), plan: served.plan, hidden: h, sig: [...h.keys()].sort().join(",") };
    activityBoard.refresh(groupMembers(served.plan));
  }
  const hidden = chosen.hidden;
  hiddenCoins = hidden;
  const sig = chosen.sig;
  if (served.sig !== sig) {
    const tokens = served.rawTokens.filter((t) => !hidden.has(t.address.toLowerCase()));
    const rest = served.rawRest.filter((t) => !hidden.has(t.address.toLowerCase()));
    served = { ...served, sig, out: { ...f, tokens, rest, cut: rest.length } };
  }
  return served.out;
};
/** the PvP Arena's battles, made again at most every 15 s (each version's X record is a file read). */
let arenaCache: { at: number; json: string } | null = null;
/** the battles' versions kept off the lists (all but each leader), and every listed row as built, for the Arena. */
let pvpBehind = new Set<string>();
/** a coin the engine tags as a bot launch. */
const isBotLaunch = (t: WireToken): boolean => !!t.tags?.includes("bot");
/** Those versions' served rows, for a search by their address (first page, rest list). */
let pvpOff = new Map<string, WireToken>();
let restPvpOff = new Map<string, WireToken>();
const arenaRows = new Map<string, WireToken>();
const pvpNow = pvpReader(join(DROP_DIR, "_pvp.json"));
function arenaJson(): string {
  if (arenaCache && Date.now() - arenaCache.at < 15_000) return arenaCache.json;
  if (!served) loadServed();
  const s = served!;
  const picture = (t: WireToken): string | null => {
    if (!t.imageUrl) return null;
    imageSources.set(t.address.toLowerCase(), t.imageUrl);
    return directImageUrl(t.imageUrl) ?? `/api/img?a=${encodeURIComponent(t.address)}`;
  };
  const xOf = (address: string): { posts: number | null } => {
    const so = readSocial(address);
    return { posts: so ? so.claims.length : null };
  };
  // The coins as the lists serve them where they are listed (with their live market figures), else the feed's own record (a hidden copy).
  const live = new Map<string, WireToken>([...s.byAddr]);
  for (const [a, t] of arenaRows) live.set(a, t); // every version with its live figures, the ones off the lists too
  // the engine's battle groups where the engine writes them (pvp-1), else the site's own copy families.
  const pvp = pvpNow();
  const groups = arenaGroups(pvp ? { ...s.plan, groups: pvp.groups } : s.plan, live, activityBoard.activityOf, xOf, picture, 40, pvp?.names, activityBoard.known);
  activityBoard.refresh(groups.flatMap((g) => g.members.map((m) => m.address.toLowerCase())));
  arenaCache = { at: Date.now(), json: JSON.stringify({ groups, asOfMs: Date.now() }) };
  return arenaCache.json;
}
const pool = pumpfun ? new GeckoPools(pumpfun, undefined, undefined, geckoBudget) : null;
/** PumpPortal's free socket: new Pump.fun and bonk.fun coins at creation, and graduations, into the same pool. ONE connection for all of PINR, so it is OFF unless PINR_PUMPPORTAL=on, which only the server's .env sets. See pumpportal.ts. */
const portal = pumpfun && env.PINR_PUMPPORTAL === "on" ? new PumpPortalFeed(pumpfun, undefined, undefined, undefined, publicCurveCheck) : null;
/** The tape: the recent trades of the coins somebody opens, read from Pump.fun's per-coin trade list (no recorder). PINR_TAPE=off disables it. See tape.ts. */
const tape = env.PINR_TAPE === "off" ? null : new Tape();
/** Launch item 7: the coins opened on the site, for PINRbot's demand (its own file, one writer), and the engine's public budget meter. */
const ENGINE_DIR = join(DROP_DIR, "..");
/** the operator's wires for the fields the feed fills (control/routing.json, written by the engine's control service; read live). */
const routingNow = routingReader(join(ENGINE_DIR, "control", "routing.json"), join(ENGINE_DIR, "control", "routing-catalog.json"));
/** Every source's own current figures for one coin, by the catalog's source names. */
function figuresOf(t: WireToken): Figures {
  const out: Figures = {};
  const q = quotes ? quotes.figures(t) : {};
  for (const [id, f] of Object.entries(q)) if (id === "dexscreener" || id === "pumpfun" || id === "jupiter") out[id] = f;
  const g = market?.figures(t);
  if (g) out.geckoterminal = g;
  const j = jupMeta?.figures(t);
  if (j && (!out.jupiter || j.atMs >= out.jupiter.atMs)) out.jupiter = j;
  const p = pumpfun?.figures(t);
  if (p && !out[p.source]) out[p.source] = { price: p.price, cap: p.cap, atMs: p.atMs };
  return out;
}
/** PINRads applications: kept in pinr-live/.data/ads (git-ignored), read by the engine's control service for /control. */
const adsDesk = new AdsDesk(env.PINR_ADS_DIR || join(import.meta.dirname, "..", ".data", "ads"));
const ADS_BODY_MAX = 4.5 * 1024 * 1024;
const wanted = new Wanted(env.PINR_WANTED_FILE === undefined ? join(ENGINE_DIR, "index", "pinrbot-wanted-site.json") : env.PINR_WANTED_FILE || null);
setInterval(() => wanted.flush(), 2000).unref();
/** Who is asking, for a limit only (never stored or logged): Cloudflare's header behind the tunnel (the server listens on loopback, so only the tunnel can set it), else the connection. */
function visitorOf(req: IncomingMessage): string {
  const cf = req.headers["cf-connecting-ip"];
  const xff = req.headers["x-forwarded-for"];
  const v = (Array.isArray(cf) ? cf[0] : cf) || (Array.isArray(xff) ? xff[0] : xff)?.split(",")[0]?.trim() || req.socket.remoteAddress || "local";
  return v.slice(0, 64);
}
/** The last-30-minutes activity of the coins in copy groups: the engine's tick files first, else Pump.fun\'s trade list, one coin at a time. */
const activityBoard = new ActivityBoard({
  ticks: (a) => ticks.activity(a, Date.now() - WINDOW_MS, solPrice.usd()),
  tape: async (a) => {
    const orig = served?.plan.cases.get(a);
    if (!tape || !orig) return null;
    await tape.read(orig);
    return tape.activity(orig, Math.floor((Date.now() - WINDOW_MS) / 1000));
  },
});
const BUDGET_FILE = env.PINR_BUDGET_FILE || join(DROP_DIR, "_pinrbot-budget.json");
/** A Pump.fun or PumpSwap coin's full candle history from Pump.fun's own free endpoint, through the server (its CORS refuses a visitor's browser). See pumpcandles.ts. */
const pumpCandles = env.PINR_PUMPCANDLES === "off" ? null : new PumpCandles();
/** Pump.fun's own candles as the engine saved them (frontend-feed/candles/<mint>.json); asked before Pump.fun itself, which refuses the server. */
const candleFiles = new CandleFiles(env.PINR_CANDLES_DIR || join(DROP_DIR, "candles"));
/** a chart's newest candles from the coin's own trades (its tick file), so the chart moves within seconds of a trade. */
const TF_SEC: Record<string, number> = { "1m": 60, "5m": 300, "15m": 900, "1h": 3600, "4h": 14_400, "1D": 86_400 };
const RANGE_SEC: Record<string, number> = { "1D": 900, "1W": 3600, "1M": 14_400, "3M": 86_400 };
const liveEnd = (mint: string, history: Candle[], bucketSec: number): Candle[] => (bucketSec > 0 ? withLiveEnd(history, ticks.candlesAt(mint, bucketSec, solPrice.usd())) : history);
/** Whether TradingView lists a coin, and its symbol, for the free Advanced Chart widget (server/tvsymbol.ts). */
const tvSymbols = env.PINR_TVWIDGET === "off" ? null : new TvSymbols();
const tapeFill = tape ? new TapeFill(tape) : null;
/** What the coins with no line or no last-trade time get from the engine's tick files and DexScreener's measured changes (server/liteline.ts). */
const liteFill = new LiteFill(ticks, () => solPrice.usd(), (t) => (quotes ? quotes.changesFor(t) : null) ?? jupMeta?.changesFor(t) ?? null);
tape?.start();
/**
 * the feed server's own wires on the /control map, measured where the data crosses (server/wiremeter.ts), served to
 * /control at /api/control/sitewires. Into the feed: the workers' running counts, looked at every 10 s. Out of the feed: each answer as it goes.
 */
const wires = new WireMeter(Date.now, join(import.meta.dirname, "..", ".data", "wiremeter.json"));
setInterval(() => wires.save(), 30_000).unref();
const W = {
  poolIn: "a_pool>p_tokens:coin list",
  pricesIn: "s_dex>p_tokens:prices",
  picIn: "a_pic>p_img:picture",
  portalIn: "s_pp>a_pool:stream",
  tradesIn: "a_trades>p_trades:trades",
  evidIn: "e_store>p_evid:evidence",
  pumpChart: "s_pump>p_chart:Pump.fun candles",
  ownChart: "a_trades>p_chart:own ticks",
  geckoChart: "s_gtc>p_chart:GeckoTerminal",
  homeList: "p_tokens>w_home:coin list",
  appsList: "p_tokens>w_apps:coin list",
  homePic: "p_img>w_home:picture",
  coinOpen: "w_home>w_coin:open",
  coinEvid: "p_evid>w_coin:evidence",
  gateEvid: "p_evid>w_gate:gate result",
  appsEvid: "p_evid>w_apps:evidence",
  chartOut: "p_chart>w_chart:server",
  ribbon: "p_trades>w_ribbon:trades",
} as const;
wires.expect([W.poolIn, W.pricesIn, W.picIn, W.tradesIn, W.evidIn, W.pumpChart, W.ownChart, W.geckoChart, W.homeList, W.appsList, W.homePic, W.coinOpen, W.coinEvid, W.gateEvid, W.appsEvid, W.chartOut, W.ribbon, ...(portal ? [W.portalIn] : [])]);
let dexWas: { ok: number; errors: number } | null = null;
function meterWorkers(): void {
  const newest = listedNow[0]?.address ?? null;
  wires.tally(W.poolIn, reader.stat.parsed, newest);
  wires.tally(W.picIn, images.stat.fetched, newest);
  const dex = quotes?.stats().find((q) => q.id === "dexscreener");
  if (dex) {
    const ok = dex.calls - dex.errors;
    if (dexWas && dex.errors > dexWas.errors && ok === dexWas.ok) wires.fail(W.pricesIn, "DexScreener's calls since the last look all failed");
    wires.tally(W.pricesIn, ok, newest);
    dexWas = { ok, errors: dex.errors };
  }
  if (portal) {
    const p = portal.stats();
    wires.tally(W.portalIn, p.created + p.graduated, null);
    if (!p.connected) wires.fail(W.portalIn, "PumpPortal's socket is not connected");
  }
  // The live trade streams open now: the site's tile list (browsers) and the full list (the apps).
  if (tileHub.size > 0) wires.hit(W.homeList, tileHub.size, `${tileHub.size} open live stream${tileHub.size > 1 ? "s" : ""}`);
}
setInterval(meterWorkers, 10_000).unref();
meterWorkers();
/** A chart answer with candles: out to the chart, and in from the source that drew it. */
function meterChart(body: string, address: string | null): void {
  if (!/"candles":\[\s*[[{]/.test(body)) return;
  const source = /"source":"([^"]+)"/.exec(body)?.[1] ?? "";
  wires.hit(W.chartOut, 1, address ? `${source || "chart"} · ${address}` : source);
  const into = source === "Pump.fun" ? W.pumpChart : source === "Solana chain" || source === "BNB chain" || source === "Base chain" || source === "PINR tape" ? W.ownChart : source === SOURCE_NAME ? W.geckoChart : null;
  if (into) wires.hit(into, 1, address);
}
/** One answer that went out of the feed, on the asker's wire (a browser's or the apps'). */
function meterOut(req: IncomingMessage, site: string, apps: string | null, sample: string | null): void {
  wires.hit(apps && askerOf(req.headers["user-agent"]) === "app" ? apps : site, 1, sample);
}
let latest: FeedSnapshot | null = null;
/** The first page of scored tokens (served in full on every poll) and the rest (paged in lite form). A scored token that is also on the Pump.fun lists is on the first page. */
let hot: WireToken[] = [];
let restList: WireToken[] = [];
const hotTokens = (): WireToken[] => {
  if (!latest) {
    latest = loadServed();
    hot = latest.tokens;
    restList = latest.rest;
  }
  return hot;
};
// What the worker has learned is kept on disk (pinr-live/.cache, not in git), so a restart does not begin the slow first pass again.
// PINRdebug (2026-10-25): a start read 129,092 picture hashes, 88,452 market readings and 13,271 creators before answering anyone (a health read took 64 s).
// Now the server answers first and reads them in the background, one at a time; nothing is saved over a cache until it has been read.
// The saved caches (tens of MB of JSON on the server) load after the first visitors are answered from the saved first page (checklist 4).
const AFTER_START_MS = 15_000;
const loaded = { pump: false, pictures: false, market: false };
const afterStart = (steps: (() => void)[]): void => {
  let i = 0;
  const next = (): void => {
    const step = steps[i++];
    if (!step) return;
    step();
    setTimeout(next, 200); // a breath between caches, so requests are answered between them
  };
  setTimeout(next, AFTER_START_MS);
};
const MARKET_CACHE = join(import.meta.dirname, "..", ".cache", "market.json");
const QUOTE_CACHE = join(import.meta.dirname, "..", ".cache", "quotes.json");
const PUMP_CACHE = join(import.meta.dirname, "..", ".cache", "pumpfun.json");
if (pumpfun) {
  setInterval(() => loaded.pump && pumpfun.saveTo(PUMP_CACHE), 30_000);
  for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, () => (loaded.pump && pumpfun.saveTo(PUMP_CACHE), process.exit(0)));
  pumpfun.start();
  pool?.start();
  portal?.start();
  // The VAMP desk: looks at the coins' pictures (near matches) and asks the chain who made them. Slow and sparing on purpose.
  const pictures = new PictureHashes();
  const creators = new ChainCreators();
  const desk = new VampDesk(pictures, creators);
  pumpfun.desk = desk;
  deskStats = () => ({ pictures: pictures.size, pictureFetches: pictures.stat.fetched, pictureFailures: pictures.stat.failed, chainReads: creators.stat.reads, chainErrors: creators.stat.errors, copies: desk.judge(pumpfun.all(), []).verdicts.size });
  const PIC_CACHE = join(import.meta.dirname, "..", ".cache", "pictures.json");
  const CRE_CACHE = join(import.meta.dirname, "..", ".cache", "creators.json");
  afterStart([
    () => {
      const n = pumpfun.loadFrom(PUMP_CACHE);
      loaded.pump = true;
      if (n) console.log(`pumpfun: ${n} saved coins restored`);
    },
    () => {
      const np = pictures.loadFrom(PIC_CACHE);
      const nc = creators.loadFrom(CRE_CACHE);
      loaded.pictures = true;
      if (np || nc) console.log(`vamp desk: ${np} picture hashes, ${nc} chain creators restored`);
    },
  ]);
  // Every 2 minutes, not 30 s: writing 129,000 hashes is a long pause of its own; at most 2 minutes of learning is lost to a crash.
  setInterval(() => loaded.pictures && (pictures.saveTo(PIC_CACHE), creators.saveTo(CRE_CACHE)), 120_000);
  let busyPic = false;
  setInterval(async () => {
    if (busyPic) return;
    busyPic = true;
    try {
      const c = desk.nextPicture(pumpfun.all());
      if (c?.image) await pictures.learn(c.image);
    } finally {
      busyPic = false;
    }
  }, 1200);
  let busyChain = false;
  setInterval(async () => {
    if (busyChain) return;
    busyChain = true;
    try {
      const batch = desk.nextChainReads(pumpfun.all(), hotTokens());
      if (batch.length) await creators.read(batch.map((c) => ({ mint: c.mint })));
    } finally {
      busyChain = false;
    }
  }, 30_000);
}
if (market) {
  afterStart([
    () => {
      const back = market.loadFrom(MARKET_CACHE);
      const qback = quotes?.loadFrom(QUOTE_CACHE) ?? 0;
      loaded.market = true;
      if (back) console.log(`market: ${back} saved readings restored`);
      if (qback) console.log(`quotes: ${qback} saved quotes restored`);
    },
  ]);
  const saveAll = (): void => void (loaded.market && (market.saveTo(MARKET_CACHE), quotes?.saveTo(QUOTE_CACHE)));
  setInterval(saveAll, 30_000);
  for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, () => (saveAll(), process.exit(0)));
}
// The PINR page's first coins' 1-minute candles are read ahead on the free route only while there is no Demo key: with one, a viewer's read has its
// own allowance, and the read-ahead was most of the home address's GeckoTerminal calls (measured 2026-10-25: 12 of 19 in four minutes).
market?.start(workable, Number(env.PINR_GECKO_EVERY_MS) || 12_000, geckoDemo ? undefined : () => listedNow.filter((t) => !isVamp(t)));
quotes?.start(workable);
jupMeta?.start(workable);

/** A token the app can ask about: a scored one from the engine's results, or a launchpad coin it has not scored. */
function findToken(addressLower: string): WireToken | undefined {
  const scored = hotTokens();
  const found = scored.find((x) => x.address.toLowerCase() === addressLower) ?? restByAddress().get(addressLower);
  const t = found ? markCopies([found], pumpfun?.vamps(scored) ?? new Map())[0] : pumpfun?.tokenByLower(addressLower, scored);
  // The VAMP gate: a copy has no data anywhere. Nothing is looked up, fetched or shown for it, so every data route answers "unknown".
  return t && !isVamp(t) ? t : undefined;
}

/** The tokens the market and quote workers may spend requests on: a VAMP gets none. */
function workable(): WireToken[] {
  const marks = quietMarks();
  const hot = hotTokens().filter((t) => !isVamp(t) && !isBotLaunch(t) && !isQuiet(t, Date.now(), marks)); // no reads are spent on a quiet coin; 271: nor on a bot launch
  // The coins listed beyond the scored first page (the launchpad coins PumpPortal and the pool bring) are quoted too: they were the ones with no price, volume or picture.
  const seen = new Set(hot.map((t) => t.address.toLowerCase()));
  return [...hot, ...listedNow.filter((t) => !isVamp(t) && !seen.has(t.address.toLowerCase()))];
}

const RANGE_BUCKET: Record<string, [number, number]> = { "1D": [900, 96], "1W": [3600, 168], "1M": [14400, 180], "3M": [86400, 90], ALL: [86400, 1000] };
const TF_BUCKET: Record<string, [number, number]> = { "1m": [60, 1000], "5m": [300, 1000], "15m": [900, 1000], "1h": [3600, 1000], "4h": [14400, 1000], "1D": [86400, 1000] };
/**
 * The tape's candles for a Solana coin. A coin the tape has never read is fetched with this request, so the first chart
 * does not meet an empty tape. `wholeOnly`: only when the list holds the coin's whole life (then two candles are needed, else the market
 * service may do better); otherwise whatever trades are held, down to one candle. The size asked is kept when it gives two candles, else
 * the finest size that does (as the tick files do) and `bucketSec` says which.
 */
async function tapeCandles(t: WireToken, spec: [number, number], wholeOnly: boolean): Promise<{ candles: Candle[]; bucketSec: number } | null> {
  if (!tape || t.chain !== "solana") return null;
  await tape.ensure(t.address).catch(() => undefined);
  if (wholeOnly && !tape.complete(t.address)) return null;
  const r = tape.candlesBest(t.address, spec[0], spec[1]);
  return r && (!wholeOnly || r.candles.length >= 2) ? r : null;
}
const sizeNote = (spec: [number, number], r: { bucketSec: number }): { bucketSec?: number } => (r.bucketSec !== spec[0] ? { bucketSec: r.bucketSec } : {});

// the team, 26 Oct: a tick far from the coin's other price is dropped (ticks.ts dropOutliers); the other price is the feed's own figure for the coin.
ticks.ref = (a) => findToken(a.toLowerCase())?.priceUsd ?? null;

/** The scored tokens after the first page, ready to serve: copies reduced to a label, no chart or trade lines, pictures through /api/img. Rebuilt every 30 seconds. */
let restCache: { at: number; list: WireToken[]; from: WireToken[]; marks: ReadonlySet<string> } | null = null;
/** Each rest coin's served row by the token it came from (a token object is the same while its file is): reused at the next rebuild. */
const restRows = new WeakMap<WireToken, { shown: boolean; lite: WireToken; served: WireToken }>();
/** the rest-of-the-scored-set coins that are quiet, served masked and marked `quiet` for the address lookup only. */
let restQuiet = new Map<string, WireToken>();
function restTokens(): WireToken[] {
  const now = Date.now();
  tokens(); // brings the first page and the rest up to date
  // Rebuilt every 30 s, and only when the scored set itself is a new one (a file changed); otherwise the last list stands.
  const marks = quietMarks();
  if (!restCache || restCache.marks !== marks || (now - restCache.at > 30_000 && restCache.from !== restList)) {
    const gated = markCopies(restList, pumpfun ? pumpfun.vamps(hot) : new Map());
    const quietNow = new Map<string, WireToken>();
    const pvpOffNow = new Map<string, WireToken>();
    const list: WireToken[] = [];
    for (const t of gated) {
      let served: WireToken;
      if (isVamp(t)) {
        imageSources.delete(t.address.toLowerCase());
        served = maskToken(t);
      } else {
        // An unchanged coin (the feed reader keeps its token while its file is the same) keeps its served row, so the stream's diff finds it unchanged at once.
        const shown = scoreServed();
        const hit = restRows.get(t);
        const kept = hit && hit.shown === shown ? hit : undefined; // the score switch on /control changes every row
        const l = kept?.lite ?? maskToken(lite(t));
        if (l.imageUrl) imageSources.set(l.address.toLowerCase(), l.imageUrl);
        served = kept?.served ?? (l.imageUrl ? { ...l, imageUrl: directImageUrl(l.imageUrl) ?? `/api/img?a=${encodeURIComponent(l.address)}` } : l);
        if (!kept) restRows.set(t, { shown, lite: l, served });
      }
      // a quiet coin is on no list; its address still finds it. neither is a battle's version other than its leader.
      if (isQuiet(t, now, marks)) quietNow.set(t.address.toLowerCase(), { ...served, quiet: true });
      else if (pvpBehind.has(t.address.toLowerCase()) || isBotLaunch(t)) pvpOffNow.set(t.address.toLowerCase(), served);
      else list.push(served);
    }
    restQuiet = quietNow;
    restPvpOff = pvpOffNow;
    restCache = { at: now, list, from: restList, marks };
    tileHub.publishRest(list);
    fullHub.publishRest(list);
  }
  return restCache.list;
}
let restIndex: { for: WireToken[]; by: Map<string, WireToken> } | null = null;
function restByAddress(): Map<string, WireToken> {
  if (!restIndex || restIndex.for !== restList) restIndex = { for: restList, by: new Map(restList.map((t) => [t.address.toLowerCase(), t])) };
  return restIndex.by;
}

function tokens(): string {
  const t0 = performance.now();
  const out = tokensInner();
  const ms = performance.now() - t0;
  if (ms > 1000) console.log(`tokens: a list build took ${(ms / 1000).toFixed(1)} s`);
  return out;
}
/** The first page's promoted coins and the rest list, kept while the snapshot and the promoted coins are the same. */
let promo: { rest: WireToken[]; tokens: WireToken[]; sig: string; hot: WireToken[]; restList: WireToken[] } | null = null;
function tokensInner(): string {
  const now = Date.now();
  if (!cache || now - cache.at > 2000) {
    const ph: [string, number][] = []; // where a slow build spends its time (logged only when it is slow)
    let pt = performance.now();
    const mark = (name: string): void => {
      const n = performance.now();
      ph.push([name, n - pt]);
      pt = n;
    };
    latest = loadServed();
    mark("loadServed");
    // A scored token that is also on the Pump.fun lists (a coin the engine has just scored) stays on the first page, so it stays live.
    const listed = pumpfun ? pumpfun.poolMints() : new Set<string>();
    const promoted = latest.rest.filter((t) => listed.has(t.address.toLowerCase()));
    // The same lists are kept while nothing in them changed: a new rest list every 2 s made the 50,000-row rest rebuild run every 30 s for nothing.
    const promoSig = promoted.map((t) => t.address).join(",");
    if (!promo || promo.rest !== latest.rest || promo.tokens !== latest.tokens || promo.sig !== promoSig) {
      promo = {
        rest: latest.rest,
        tokens: latest.tokens,
        sig: promoSig,
        hot: promoted.length ? [...latest.tokens, ...promoted] : latest.tokens,
        restList: promoted.length ? latest.rest.filter((t) => !listed.has(t.address.toLowerCase())) : latest.rest,
      };
    }
    hot = promo.hot;
    restList = promo.restList;
    // The picture desk's verdicts reach scored tokens as a warning only: their score and data are never removed on a picture match.
    mark("promo");
    const gated = markCopies(hot, pumpfun ? pumpfun.vamps(hot) : new Map());
    mark("copies");
    const live = gated.filter((t) => !isVamp(t));
    const copies = gated.filter(isVamp);
    const priced0 = liteFill.apply(market ? (quotes ? quotes.fillHistory : (x: WireToken[]) => x).call(quotes, market.enrich(quotes ? quotes.enrich(live) : live)) : live);
    // The coins on screen (first page, in the order shown) get their own record read, one at a time, for the picture, links, creator and all-time high.
    pumpfun?.want(priced0.filter((t) => t.chain === "solana" && !!t.address).map((t) => t.address));
    mark("enrich");
    const filled = pumpfun ? pumpfun.fill(priced0) : priced0;
    mark("pumpfill");
    // Launchpad coins the engine has not scored join the pool after the scored ones (no score, market data only).
    const known = new Set([...filled, ...copies].map((t) => t.address.toLowerCase()).concat([...hiddenCoins.keys()])); // the last pass's losers are listed again and judged again each rebuild, so the winner can change // a hidden coin is not re-listed from the launchpad pool
    // THE VAMP GATE comes last, over everything: a token the ENGINE labels VAMP is reduced to its name and the label; no price, chart,
    // stats, trades or score leave the server for it.
    // The launchpad coins of the pool are quoted too (DexScreener first), and get their price line: they were listed with no price, volume or line of their own.
    // with Pump.fun's discovery switched off on the operator's map, its pool's coins join no list.
    const pooled = pumpfun && routingNow().pumpfunOn ? pumpfun.poolTokens(known, filled) : [];
    const pooledQ = pooled.length ? liteFill.apply(quotes ? quotes.fillHistory(quotes.enrich(pooled)) : pooled) : pooled;
    const priced = [...(pumpfun ? [...filled, ...pooledQ] : filled), ...copies.map(stripVamp)];
    // The tape: real buy and sell dollars for the coins somebody has opened. No engine trades files are read any more.
    mark("pool");
    const filledJup = jupMeta ? jupMeta.fill(priced) : priced; // names, pictures, links and any figure still empty, from Jupiter Tokens v2
    // a field the operator reordered on /control (price, volume, liquidity) is filled by his order; the others stay as filled above.
    const route = routingNow();
    const filledAll = route.orders.price || route.orders.volume || route.orders.liquidity ? filledJup.map((t) => routeToken(t, figuresOf(t), route)) : filledJup;
    // The last pass over the list as it will be served: coins with the same picture file or the same name and ticker are one family, the most active shows
    // (the launchpad coins of the pool are in no feed file, so the plan from the feed files never saw them).
    mark("jup+route");
    finalHidden = finalFamilies(filledAll, activityBoard.activityOf);
    mark("families");
    const filled1 = finalHidden.size ? filledAll.filter((t) => !finalHidden.has(t.address.toLowerCase())) : filledAll;
    // a battle's versions are listed nowhere but the Arena; only its leader is (the Arena's first). They keep their live rows
    // for the Arena, and a search by their address still finds them (findToken reads the feed, not these lists).
    arenaRows.clear(); // this build's rows only, so it never grows with every coin ever listed
    for (const t of filled1) arenaRows.set(t.address.toLowerCase(), t);
    pvpBehind = behindLeaders(pvpNow()?.groups ?? [], (a) => arenaRows.get(a) ?? served?.byAddr.get(a), activityBoard.activityOf);
    mark("pvp");
    const filled2 = filled1;
    const taped00 = tapeFill ? tapeFill.apply(filled2) : filled2;
    // the engine's own count of the last hour's trades, where its writers carry one (else the tiles keep DexScreener's).
    const taped0 = taped00.map((t) => {
      const h = ticks.hourCounts(t.address);
      return h ? { ...t, hourTrades: h } : t;
    });
    mark("tape+hours");
    // while the score is off, every list and stream below is built from tokens that carry none of it.
    const taped = taped0.map((t0) => {
      const t = maskToken(t0);
      if (!t.imageUrl || isVamp(t)) {
        imageSources.delete(t.address.toLowerCase());
        return t;
      }
      imageSources.set(t.address.toLowerCase(), t.imageUrl);
      return { ...t, imageUrl: directImageUrl(t.imageUrl) ?? `/api/img?a=${encodeURIComponent(t.address)}` };
    });
    // a coin with no trade for 24 hours is on no list, no stream and no count; it is set apart and found only by its address, and no reads are spent on it.
    mark("mask+images");
    const split0 = splitQuiet(taped, Date.now(), quietMarks());
    quietCoins = new Map(split0.quiet.map((t) => [t.address.toLowerCase(), t]));
    // the battles' other versions leave the list here, kept whole (like the quiet coins) for a search by their address.
    // a bot launch is never listed either; a search by its address shows it, its tag and its gate section.
    pvpOff = new Map(split0.shown.filter((t) => pvpBehind.has(t.address.toLowerCase()) || isBotLaunch(t)).map((t) => [t.address.toLowerCase(), t]));
    const split = pvpOff.size ? { ...split0, shown: split0.shown.filter((t) => !pvpOff.has(t.address.toLowerCase())) } : split0;
    const allTaped = taped;
    // the list as served puts scored coins first (newest-scored), then new unscored ones (the pool's launchpad coins among them); the rest keep their order.
    const nowMs = Date.now();
    const pageKeys = new Map(split.shown.map((t) => [t, firstPageKey(firstPageFactsOf(t), nowMs)]));
    mark("quiet+pageKeys");
    const shown = [...split.shown].sort((a, b) => byFirstPage(pageKeys.get(a)!, pageKeys.get(b)!));
    mark("sort");
    listedNow = shown;
    const { rest: _rest, ...head } = latest;
    void _rest;
    const snap = { ...head, scoreShown: scoreServed(), tokens: shown };
    const stats = { market: market ? { source: SOURCE_NAME, ...market.stats() } : null, quotes: quotes ? quotes.stats() : null, pumpfun: pumpfun ? pumpfun.stats() : null, pool: pool ? pool.stats() : null, tape: tape ? tape.stats() : null, vampDesk: deskStats(), images: images.stat };
    // what changed since the last rebuild goes to every open stream; each list says where in its stream it stands.
    const { tokens: _t, ...listHead } = snap;
    void _t;
    const meta = { ...listHead, market: stats.market };
    const tileRows = shown.map(tileView) as (Partial<WireToken> & { address: string })[];
    const tileAt = tileHub.publishFirst(tileRows, meta);
    mark("tileRows+tileHub");
    const fullAt = fullHub.publishFirst(shown, meta);
    mark("fullHub");
    const body = JSON.stringify({ ...snap, ...stats, stream: { boot: fullHub.boot, seq: fullAt } });
    // the site's lighter list, and every body made once per rebuild (not once per request). The public ones carry no worker stats.
    const tileBody = JSON.stringify({ ...snap, tokens: tileRows, ...stats, stream: { boot: tileHub.boot, seq: tileAt } });
    mark("stringify");
    const total = ph.reduce((a, [, ms]) => a + ms, 0);
    if (total > 500) console.log(`tokens: a slow build, ${Math.round(total)} ms, ${shown.length} coins: ${ph.filter(([, ms]) => ms >= 20).map(([n, ms]) => `${n} ${Math.round(ms)}`).join(", ")}`);
    cache = { at: now, body, tile: tileBody, publicBody: publicSnapshot(body), publicTile: publicSnapshot(tileBody), detail: new Map(allTaped.map((t) => [t.address.toLowerCase(), coinPageFields(t)])) };
  }
  return cache.body;
}

/** The token list as the route serves it: full (the apps' contract) or the site's tile list; a visitor's without the worker stats. */
function tokensBody(view: "full" | "tile", visitor: boolean): string {
  tokens();
  const c = cache!;
  return view === "tile" ? (visitor ? c.publicTile : c.tile) : visitor ? c.publicBody : c.body;
}

/** The coin page's own figures for one token: from the first page as built, else the rest of the scored set. */
function coinDetail(addressLower: string): CoinPageFields | undefined {
  tokens();
  const hit = cache!.detail.get(addressLower);
  if (hit) return hit;
  const r = restByAddress().get(addressLower);
  return r && !isVamp(r) ? coinPageFields(r) : undefined;
}

createServer(async (req, res) => {
  const full = new URL(req.url ?? "/", "http://local");
  const url = full.pathname;
  const send = (code: number, body: string): void => {
    res.writeHead(code, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
    res.end(body);
  };
  setSecurityHeaders(res);
  /** A chart's answer, metered on the chart wire and on the wire of the source that filled it. */
  const sendChart = (code: number, body: string): void => {
    meterChart(body, full.searchParams.get("address"));
    send(code, body);
  };
  // PINRads: an application for an ad space, kept on the server for the operator (server/adsapply.ts). The one place the public site
  // takes a POST: JSON only, at most 4.5 MB (a 3 MB picture as base64), answered in the form's plain words.
  if (url === "/api/ads/apply") {
    if (req.method !== "POST") return send(405, '{"ok":false,"words":"Send the form to apply."}');
    if (!String(req.headers["content-type"] ?? "").startsWith("application/json")) return send(415, '{"ok":false,"words":"Send the form to apply."}');
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const c of req as AsyncIterable<Buffer>) {
      size += c.length;
      if (size > ADS_BODY_MAX) return send(413, '{"ok":false,"words":"The picture can be at most 3 MB."}');
      chunks.push(c);
    }
    let raw: unknown;
    try {
      raw = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
      return send(400, '{"ok":false,"words":"The application could not be read. Please try again."}');
    }
    const answer = await adsDesk.accept(raw, visitorOf(req));
    return send(answer.status, JSON.stringify(answer.body));
  }
  // the feed server's own wires for /control, measured here. /control is behind Cloudflare Access at the edge, which adds its token header;
  // on this machine (no proxy) a loopback ask is enough. Counts, times and a coin address or source name as the sample: nothing private.
  if (url === "/api/control/sitewires") {
    const local = isLoopback(req.socket.remoteAddress) && !req.headers["x-forwarded-for"];
    if (!local && !req.headers["cf-access-jwt-assertion"]) return send(403, '{"error":"control only"}');
    return send(200, JSON.stringify({ v: 1, nowMs: Date.now(), startedMs: wires.startedMs, liveMs: LIVE_MS, wires: wires.snapshot() }));
  }
  // The control service on the server: /api/control/* is passed through unchanged, GET and POST, to 127.0.0.1:8790, which checks Cloudflare Access's token itself.
  if (url.startsWith("/api/control")) {
    if (env.PINR_CONTROL === "off" || !isControlPath(req.url)) return send(404, '{"error":"not found"}');
    return proxyControl(req, res, Number(env.PINR_CONTROL_PORT) || undefined);
  }
  // The built site (production only): a file of dist/, or 404. Everything under /api goes on to the feed below.
  if (PUBLIC && !url.startsWith("/api/")) {
    if (req.method !== "GET" && req.method !== "HEAD") return send(405, '{"error":"read-only"}');
    if (serveStatic(req, res, url, STATIC_ROOT, scoreServed())) return;
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" });
    return void res.end("Not found");
  }
  if (req.method !== "GET") return send(405, '{"error":"read-only"}');
  // Behind the proxy every request arrives from the machine itself, so a request that carries the proxy's forwarding header is a visitor's.
  const fromVisitor = PUBLIC && !(isLoopback(req.socket.remoteAddress) && !req.headers["x-forwarded-for"]);
  if (url === "/api/tokens") {
    // `max-age=5`, so a browser (and Cloudflare, where a rule allows it) reuses one answer for 5 seconds. `?view=tile` is the site's lighter list.
    const body = tokensBody(full.searchParams.get("view") === "tile" ? "tile" : "full", PUBLIC);
    meterOut(req, W.homeList, W.appsList, listedNow[0]?.address ?? null);
    res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": TOKENS_CACHE });
    return void res.end(body);
  }
  if (url === "/api/stream") {
    // the live changes. `?view=tile` for the site's tile list, the full list otherwise (the apps). Kept open; see stream.ts.
    tokens();
    restTokens();
    const hub = full.searchParams.get("view") === "tile" ? tileHub : fullHub;
    meterOut(req, W.homeList, W.appsList, "a live stream opened");
    return hub.attach(req, res, StreamHub.position(req, full));
  }
  if (url === "/api/token/detail") {
    // The coin page's own figures (receipts the tile list leaves out) for ONE token in the feed; anything else is refused.
    const addr = (full.searchParams.get("address") ?? "").toLowerCase();
    const off = offLabel(addr);
    if (off) return send(200, JSON.stringify({ hidden: true, label: off, notice: HIDDEN_NOTICE }));
    const opened = findToken(addr);
    if (opened && opened.chain === "solana") wanted.add(opened.address, visitorOf(req)); // opened: PINRbot reads it first
    const d = coinDetail(addr);
    if (d) meterOut(req, W.coinOpen, null, opened?.address ?? addr);
    return d ? send(200, JSON.stringify(d)) : send(404, '{"error":"unknown token"}');
  }
  if (url === "/api/token/find") {
    // the one way to a coin that is on no list: its contract address, exactly. Quiet coins (no trade for 24 hours) come back marked `quiet`; a coin on a list comes back as listed.
    const addr = (full.searchParams.get("address") ?? "").toLowerCase();
    if (!/^(0x[0-9a-f]{40}|[1-9a-hj-np-za-km-z]{32,44})$/.test(addr)) return send(400, '{"error":"an address is needed"}');
    const off = offLabel(addr);
    if (off) return send(200, JSON.stringify({ hidden: true, label: off, notice: HIDDEN_NOTICE }));
    restTokens(); // brings the first page and the rest (and their quiet coins) up to date
    const hit = quietCoins.get(addr) ?? restQuiet.get(addr) ?? pvpOff.get(addr) ?? restPvpOff.get(addr) ?? listedNow.find((t) => t.address.toLowerCase() === addr) ?? restTokens().find((t) => t.address.toLowerCase() === addr);
    return hit ? send(200, JSON.stringify({ token: hit })) : send(404, '{"error":"unknown token"}');
  }
  if (url === "/api/tokens/rest") {
    // The rest of the scored set, a page at a time (offset and limit; at most 1000 a page), in the engine's roster order.
    // `chains=base,bsc` keeps only those chains' coins, so the Base/BNB tab fills in a second instead of after the whole sweep.
    const want = (full.searchParams.get("chains") ?? "").toLowerCase().split(",").map((c) => c.trim()).filter(Boolean);
    const list = want.length ? restTokens().filter((t) => want.includes(chainOf(t) ?? "")) : restTokens();
    const offset = Math.max(0, Math.floor(Number(full.searchParams.get("offset")) || 0));
    const limit = Math.min(1000, Math.max(1, Math.floor(Number(full.searchParams.get("limit")) || 500)));
    return send(200, JSON.stringify({ contract: CONTRACT_VERSION, total: list.length, offset, tokens: list.slice(offset, offset + limit) }));
  }
  if (url === "/api/health") {
    if (fromVisitor) return send(200, '{"ok":true}');
    const f = JSON.parse(tokens()) as { mode: string; files: number; tokens: unknown[]; problems: unknown[] };
    const all = JSON.parse(tokens()) as { market: unknown; quotes: unknown; pumpfun: unknown; tape: unknown; vampDesk: unknown; images: unknown; cut: number };
    const m = all.market;
    return send(200, JSON.stringify({ ok: true, contract: CONTRACT_VERSION, mode: f.mode, chains: CHAINS ? [...CHAINS] : "all", files: f.files, tokens: f.tokens.length, fileProblems: f.problems.length, market: m, quotes: all.quotes, pumpfun: all.pumpfun, pumpportal: portal ? portal.stats() : null, stream: { tile: tileHub.stats(), full: fullHub.stats() }, feedReader: reader.stat, ticks: { files: ticks.size, solUsd: solPrice.usd(), engine: ticks.status() }, tape: all.tape, vampDesk: all.vampDesk, images: all.images, gecko: { ...geckoBudget.stats(), demoKey: geckoDemo ? geckoDemo.stats() : null }, candleFiles: candleFiles.stat, pushIn: pushIn ? (pushIn as unknown as { stat: unknown }).stat : null }));
  }
  if (url === "/api/img") {
    // A token's picture, small and cached. Only a token in the list can be asked for; the address of the picture is the server's own record.
    const src = imageSources.get((full.searchParams.get("a") ?? "").toLowerCase());
    if (!src) return send(404, '{"error":"no picture"}');
    const buf = await images.picture(src);
    if (!buf) return send(404, '{"error":"no picture yet"}');
    meterOut(req, W.homePic, null, full.searchParams.get("a"));
    res.writeHead(200, { "content-type": "image/webp", "cache-control": "public, max-age=86400" });
    return void res.end(buf);
  }
  if (url === "/api/chart") {
    // Price history for ONE token that is in the feed (anything else is refused), over one of the offered ranges.
    const address = (full.searchParams.get("address") ?? "").toLowerCase();
    const range = full.searchParams.get("range") ?? "1D";
    const token = findToken(address);
    // the operator's candle order (today's: Pump.fun, then PINR's own trades, then GeckoTerminal).
    const order = candleOrder(routingNow());
    let got: Awaited<ReturnType<NonNullable<typeof market>["chartFor"]>> | null = null;
    if (token && isChartRange(range)) {
      for (const source of order) {
        if (source === "pumpfun") {
          // Pump.fun's own candle history for a Pump.fun or PumpSwap coin: the chart its own page draws, from the coin's first trade.
          if (token.chain === "solana" && isPumpLaunchpad(token.launchpad) && !isVamp(token)) {
            const fc = candleFiles.range(token.address, range);
            if (fc) return sendChart(200, JSON.stringify({ range, source: "Pump.fun", candles: liveEnd(token.address, fc.candles, fc.bucketSec), status: fc.status, bucketSec: fc.bucketSec, ...(fc.asOfMs ? { asOfMs: fc.asOfMs } : {}) }));
          }
          if (pumpCandles && token.chain === "solana" && isPumpLaunchpad(token.launchpad) && !isVamp(token)) {
            const ageSec = token.launchedAtMs ? Math.max(60, (Date.now() - token.launchedAtMs) / 1000) : 3600;
            const plan: { interval: PumpInterval; limit: number } | undefined = range === "ALL" ? { interval: allInterval(ageSec), limit: 400 } : RANGE_PLAN[range];
            // A coin too young for two candles at that size is drawn at the finest size that gives two (its own first minutes), as Pump.fun's page does.
            for (const iv of plan ? finerSizes(plan.interval) : []) {
              const pc = await pumpCandles.candles(token.address, iv, plan!.limit, token.launchedAtMs);
              if (pc && pc.length >= 2) return sendChart(200, JSON.stringify({ range, source: "Pump.fun", candles: pc, status: "ok", bucketSec: SECONDS[iv] }));
              if (pc && pc.length === 1 && iv !== plan!.interval) continue;
              if (!pc) break; // nothing, or Pump.fun is resting: the other sources answer
            }
          }
        } else if (source === "tape") {
          // a curve coin's own trades, read from the chain by the engine.
          const [b, n] = RANGE_BUCKET[range]!;
          const ch = ticks.candles(token.address, b, n, solPrice.usd());
          if (ch) return sendChart(200, JSON.stringify({ range, source: ticks.sourceOf(token.address) ?? "Solana chain", candles: ch.candles, status: "ok", ...(ch.bucketSec !== b ? { bucketSec: ch.bucketSec } : {}) }));
          const cs = await tapeCandles(token, RANGE_BUCKET[range]!, true);
          if (cs) return sendChart(200, JSON.stringify({ range, source: "PINR tape", candles: cs.candles, status: "ok", ...sizeNote(RANGE_BUCKET[range]!, cs) }));
        } else if (source === "geckoterminal" && market) {
          got = await within(market.chartFor(token, range), CHART_WAIT_MS, { range, source: null, candles: [], status: "busy" } as never);
          if (got.candles.length >= 2) return sendChart(200, JSON.stringify({ ...got, candles: liveEnd(token.address, got.candles, RANGE_SEC[range] ?? 0) }));
        }
      }
    }
    if (!market) return sendChart(200, JSON.stringify({ range, source: null, candles: [], status: "none" }));
    if (!token || !isChartRange(range)) return send(404, '{"error":"unknown token or range"}');
    if (order.includes("tape")) {
      const part = await tapeCandles(token, RANGE_BUCKET[range]!, false);
      if (part) return sendChart(200, JSON.stringify({ range, source: "PINR tape", candles: part.candles, status: "ok", ...sizeNote(RANGE_BUCKET[range]!, part) }));
    }
    if (!got && order.includes("geckoterminal")) got = await within(market.chartFor(token, range), CHART_WAIT_MS, { range, source: null, candles: [], status: "busy" } as never);
    return sendChart(200, JSON.stringify(got ?? { range, source: null, candles: [], status: "none" }));
  }
  if (url === "/api/candles") {
    // Candles at one timeframe for a chart, for ONE token that is in the feed.
    const address = (full.searchParams.get("address") ?? "").toLowerCase();
    const tf = full.searchParams.get("tf") ?? "15m";
    const token = findToken(address);
    // the sources are tried in the operator's order for candles (today's: Pump.fun, then PINR's own trades, then GeckoTerminal).
    const order = candleOrder(routingNow());
    let gecko: Awaited<ReturnType<NonNullable<typeof market>["candlesFor"]>> | null = null;
    if (token && isTimeframe(tf)) {
      for (const source of order) {
        if (source === "pumpfun") {
          const pumpTf: Record<string, PumpInterval> = { "1m": "1m", "5m": "5m", "15m": "15m", "1h": "1h", "4h": "4h" };
          if (token.chain === "solana" && isPumpLaunchpad(token.launchpad) && !isVamp(token)) {
            const fc = candleFiles.candles(token.address, tf as CandleSize, 1000);
            if (fc) return sendChart(200, JSON.stringify({ tf, source: "Pump.fun", candles: liveEnd(token.address, fc.candles, fc.bucketSec), status: fc.status, bucketSec: fc.bucketSec, ...(fc.asOfMs ? { asOfMs: fc.asOfMs } : {}) }));
          }
          if (pumpCandles && pumpTf[tf] && token.chain === "solana" && isPumpLaunchpad(token.launchpad) && !isVamp(token)) {
            const pc = await pumpCandles.candles(token.address, pumpTf[tf]!, 400, token.launchedAtMs);
            if (pc && pc.length >= 2) return sendChart(200, JSON.stringify({ tf, source: "Pump.fun", candles: pc, status: "ok", bucketSec: SECONDS[pumpTf[tf]!] }));
          }
        } else if (source === "tape") {
          const [b, n] = TF_BUCKET[tf]!;
          const ch = ticks.candles(token.address, b, n, solPrice.usd());
          if (ch) return sendChart(200, JSON.stringify({ tf, source: ticks.sourceOf(token.address) ?? "Solana chain", candles: ch.candles, status: "ok", ...(ch.bucketSec !== b ? { bucketSec: ch.bucketSec } : {}) }));
          const cs = await tapeCandles(token, TF_BUCKET[tf]!, true);
          if (cs) return sendChart(200, JSON.stringify({ tf, source: "PINR tape", candles: cs.candles, status: "ok", ...sizeNote(TF_BUCKET[tf]!, cs) }));
        } else if (source === "geckoterminal" && market) {
          gecko = await within(market.candlesFor(token, tf), CHART_WAIT_MS, { tf, source: null, candles: [], status: "busy" } as never);
          if (gecko.candles.length >= 2) return sendChart(200, JSON.stringify({ ...gecko, candles: liveEnd(token.address, gecko.candles, TF_SEC[tf] ?? 0) }));
        }
      }
    }
    if (!market) return sendChart(200, JSON.stringify({ tf, source: null, candles: [], status: "none" }));
    if (!token || !isTimeframe(tf)) return send(404, '{"error":"unknown token or timeframe"}');
    // Nothing whole from the sources in the order: part of PINR's own trades where it is in the order, else what GeckoTerminal said (its status), as before.
    if (order.includes("tape")) {
      const part = await tapeCandles(token, TF_BUCKET[tf]!, false);
      if (part) return sendChart(200, JSON.stringify({ tf, source: "PINR tape", candles: part.candles, status: "ok", ...sizeNote(TF_BUCKET[tf]!, part) }));
    }
    if (!gecko && order.includes("geckoterminal")) gecko = await within(market.candlesFor(token, tf), CHART_WAIT_MS, { tf, source: null, candles: [], status: "busy" } as never);
    return sendChart(200, JSON.stringify(gecko ?? { tf, source: null, candles: [], status: "none" }));
  }
  if (url === "/api/events") {
    // Dated engine events for a chart, for ONE token that is in the feed. No file = an empty list.
    const address = (full.searchParams.get("address") ?? "").toLowerCase();
    const token = findToken(address);
    if (!token) return send(404, '{"error":"unknown token"}');
    return send(200, JSON.stringify({ events: maskEvents(readEvents(token.address)) }));
  }
  if (url === "/api/launchpad/pumpfun") {
    // Coins read directly from Pump.fun (market data only, no score): ?sort=new|active|top&limit=&offset=; bonk.fun coins (PumpPortal) only with &launchpad=all,
    // so a reader that takes every coin here for a Pump.fun coin is never handed another launchpad's.
    if (!pumpfun) return send(200, JSON.stringify({ coins: [], total: 0 }));
    const sort = full.searchParams.get("sort");
    const how = sort === "active" || sort === "top" ? sort : "new";
    const limit = Number(full.searchParams.get("limit") ?? 50) || 50;
    const offset = Number(full.searchParams.get("offset") ?? 0) || 0;
    const pads = full.searchParams.get("launchpad") === "all" ? "all" : "pump";
    return send(200, JSON.stringify({ coins: pumpfun.list(how, limit, offset, pads), total: pumpfun.size }));
  }
  if (url === "/api/evidence") {
    // The paper trail PINR keeps for ONE token that is in the feed. No file = {"evidence":null}.
    const address = (full.searchParams.get("address") ?? "").toLowerCase();
    const off = offLabel(address);
    if (off) return send(200, JSON.stringify({ hidden: true, label: off, notice: HIDDEN_NOTICE }));
    const token = findToken(address);
    if (!token) return send(404, '{"error":"unknown token"}');
    if (isVamp(token)) return send(200, '{"evidence":null}');
    const evidence = readEvidence(token.address);
    if (evidence) {
      wires.hit(W.evidIn, 1, token.address);
      meterOut(req, W.coinEvid, W.appsEvid, token.address);
      if (askerOf(req.headers["user-agent"]) !== "app") wires.hit(W.gateEvid, 1, token.address);
    }
    const hidden = evidence && readDossier(token.address).checks.some((c) => c.reason === "dev not identified");
    return send(200, JSON.stringify({ evidence: hidden && evidence ? { ...evidence, fundingNote: FUNDING_NOT_TRACED } : evidence }));
  }
  if (url === "/api/tvsymbol") {
    // The TradingView symbol for ONE Solana token in the feed, when TradingView lists it: {"symbol":"EXCHANGE:NAME"}, else {"symbol":null}. See server/tvsymbol.ts.
    const address = (full.searchParams.get("address") ?? "").toLowerCase();
    const token = findToken(address);
    if (!tvSymbols || !token || token.chain !== "solana" || isVamp(token) || offLabel(address) !== undefined) return send(200, '{"symbol":null}');
    const sym = await tvSymbols.symbol(token.address);
    return send(200, JSON.stringify({ symbol: sym ?? null }));
  }
  if (url === "/api/metric") {
    // The engine's finished PINR Index line series for ONE token that is in the feed. No file = {"metric":null}.
    const address = (full.searchParams.get("address") ?? "").toLowerCase();
    const token = findToken(address);
    if (!token) return send(404, '{"error":"unknown token"}');
    // the PINR Index line is the score over time; while the score is off it answers null.
    return send(200, JSON.stringify({ metric: scoreServed() ? readMetric(token.address) : null }));
  }
  if (url === "/api/pinrbot/budget") {
    // The public daily PINRbot budget, as a percentage and whether the bot runs; null when the engine has not written today's reading.
    return send(200, JSON.stringify({ budget: scoreServed() ? readBudget(BUDGET_FILE) : null }));
  }
  if (url === "/api/dossier") {
    // The cleaned evidence for ONE token that is in the feed (see server/dossier.ts: an allow-list, never scoring detail).
    const address = (full.searchParams.get("address") ?? "").toLowerCase();
    const off = offLabel(address);
    if (off) return send(200, JSON.stringify({ hidden: true, label: off, notice: HIDDEN_NOTICE }));
    const token = findToken(address);
    if (!token) return send(404, '{"error":"unknown token"}');
    if (token.chain === "solana") wanted.add(token.address, visitorOf(req)); // opened: PINRbot reads it first
    return send(200, JSON.stringify({ ...maskDossier(readDossier(token.address)), social: readSocial(token.address), pool: readPoolEvents(token.address), poolRows: isVamp(token) ? [] : poolRowsOf(readEvidence(token.address)) }));
  }
  if (url === "/api/healthfile") {
    // Checklist 12: the coin's health file to keep, any coin PINR can find (quiet ones too). Exactly what the coin page shows:
    // the cleaned dossier (server/dossier.ts's allow-list), its pool events and social scan, and the evidence trail; nothing else.
    const address = (full.searchParams.get("address") ?? "").toLowerCase();
    const off = offLabel(address);
    if (off) return send(200, JSON.stringify({ hidden: true, label: off, notice: HIDDEN_NOTICE }));
    const token = findToken(address);
    if (!token) return send(404, '{"error":"unknown token"}');
    const made = new Date();
    const body = {
      contract: "pinr-health-1",
      madeAt: made.toISOString(),
      words: "Observed facts as PINR read them: ● read on chain, ○ reported by the source named. Missing stays missing (null). Not advice and not a verdict.",
      page: `https://pinr.io/?coin=${token.address}`,
      coin: { address: token.address, name: token.name, ticker: token.ticker, chain: token.chain ?? null, launchpad: token.launchpad ?? null, launchedAtMs: token.launchedAtMs ?? null },
      dossier: { ...maskDossier(readDossier(token.address)), social: readSocial(token.address), pool: readPoolEvents(token.address), poolRows: isVamp(token) ? [] : poolRowsOf(readEvidence(token.address)) },
      evidence: isVamp(token) ? null : readEvidence(token.address),
    };
    const tick = (token.ticker ?? "").replace(/[^A-Za-z0-9]/g, "").slice(0, 16) || "coin";
    const name = `PINR-health-${tick}-${token.address.slice(0, 6)}-${made.toISOString().slice(0, 10)}.json`;
    res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "content-disposition": `attachment; filename="${name}"` });
    return void res.end(JSON.stringify(body, null, 2));
  }
  if (url === "/api/wallet") {
    // What a wallet holds of the tracked tokens: public balances only, read from public nodes. Asked for an address the person
    // connected or typed to view; nothing here can sign or send.
    const raw = (full.searchParams.get("address") ?? "").trim();
    const isEvm = /^0x[0-9a-fA-F]{40}$/.test(raw);
    const isSol = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(raw);
    if (!isEvm && !isSol) return send(400, '{"error":"not a wallet address"}');
    const roster = (JSON.parse(tokens()) as { tokens: WireToken[] }).tokens;
    return send(200, JSON.stringify(await readHoldings(isEvm ? raw.toLowerCase() : raw, isEvm ? "evm" : "solana", roster)));
  }
  if (url === "/api/trades") {
    // Recent trades for ONE token that is in the feed: rows [time, "buy"|"sell", usd], newest 500, from Pump.fun's trade list for a Solana coin; no list for other chains yet.
    const address = (full.searchParams.get("address") ?? "").toLowerCase();
    const token = findToken(address);
    if (!token) return send(404, '{"error":"unknown token"}');
    // A Solana coin's recent trades come from Pump.fun's trade list through the tape (asking marks the coin as wanted; the first answer takes a few seconds).
    if (tape && token.chain === "solana") tape.want(token.address);
    // the coin's own trades from its tick file first (the engine's live readers, seconds old), else Pump.fun's list.
    const file = ticks.tradesFile(token.address, solPrice.usd()) ?? (tape && token.chain === "solana" ? tape.file(token.address) : null);
    if (!file) return send(200, JSON.stringify({ none: true, trades: [], complete: false, coversFrom: null, asOf: null, summary: null }));
    return send(200, JSON.stringify({ none: false, ...file, summary: summarize(file, Math.floor(Date.now() / 1000)) }));
  }
  if (url === "/api/arena") {
    // the PvP Arena, every version of each contested coin (copy hiding off here only), ranked by volume, X presence and chart.
    return send(200, arenaJson());
  }
  if (url === "/api/contract") return send(200, JSON.stringify({ contract: CONTRACT_VERSION, noScoreLabels: NO_SCORE_LABELS }));
  send(404, '{"error":"not found"}');
}).listen(PORT, HOST, () => console.log(`PINR feed server on http://${HOST}:${PORT} (read-only${PUBLIC ? `, serving the site from ${STATIC_ROOT}` : ""})`));
