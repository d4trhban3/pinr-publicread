// curve coins' trades over ONE standard Solana websocket (plan: ops/PLAN-206-WEBSOCKET.md).
// `accountSubscribe` on each shown curve coin's CURVE ACCOUNT (Pump.fun's bonding curve, LaunchLab's pool): the account
// changes only when a trade succeeds, so failed bot transactions cost nothing (per-coin logsSubscribe, 2026-10-21: 42,766
// notifications for 472 trades). Each change becomes a tick (side and size from the two states, the price from the
// curve's own reserves) in `frontend-feed/ticks/<mint>.json` (the latest ticks and the 5-minute candles), written whole by
// a rename, for the feed server to serve and push. After a reconnect the curve is read once over HTTP; a
// move while disconnected is written as a gap, never invented. Metered against a daily share in bytes and in messages
// (Chainstack bills each notification, 3 M a month free; Helius 2 credits per 0.1 MB; docs read 2026-10-21).
// Shown, never scored. Off unless `trades_ws` is "on" in scanner/settings.json. The node's key is never printed.
//   node livews/trades.mjs            the service (the user unit ops/systemd/pinr-trades.service runs it)
import { readFileSync, writeFileSync, renameSync, mkdirSync, readdirSync, statSync, watch } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PROGRAMS } from "./decode.mjs";
import { pumpCurveAddress, launchlabPoolAddress, pumpCurveState, launchlabPoolState, tradeBetween, priceOf } from "./curve.mjs";

export const ENGINE = join(dirname(fileURLToPath(import.meta.url)), "..");
export const FEED_DIR = join(ENGINE, "frontend-feed");
export const TICK_DIR = join(FEED_DIR, "ticks");
const SETTINGS = join(ENGINE, "scanner", "settings.json");
const STATE = join(ENGINE, "index", "trades_ws.json");
export const KEEP_TICKS = 500, KEEP_CANDLES = 288, CANDLE_MS = 5 * 60 * 1000;
// 40 coins: on Chainstack (1 unit a notification, 3 M a month) curve accounts gave about 0.013 notifications a second a coin
// (2026-10-21: 147 coins, 182 a minute with the subscriptions), so 40 coins stay inside a 60,000-a-day share all day.
// Solana's own public websocket first (free, no key, no bill), a keyed node only as overflow when
// the public one will not hold, and the daily shares meter that overflow node only (they guard its free allowance).
export const DEFAULTS = { trades_ws: "off", trades_ws_max_coins: 40, trades_ws_daily_mb: 300, trades_ws_daily_msgs: 60000, trades_ws_node: "public", trades_ws_overflow: "chainstack" };
export const NODE_NAMES = ["public", "publicnode", "chainstack", "helius", "shyft"];
export const HOLD_MIN_S = 20;       // item 55: a public connection that held less than this ...
export const SHORT_IN_ROW = 3;      // ... this many times in a row "will not hold": the overflow node takes over ...
export const PUBLIC_RETRY_MS = 10 * 60_000;   // ... and the public node is tried again after this
export const GAP_READ_MS = 300;     // between the after-reconnect curve reads on the public node (its 40 a method per 10 s)
export const SUBS_PER_SECOND = 4;   // subscribe requests sent at most this fast (Chainstack refused a burst of 150 with "RPS limit", 2026-10-21)
const say = (line) => console.log(new Date().toISOString().slice(11, 19) + " " + line);

// ------------------------------------------------------------------ each trade to the feed server at once
export const PUSH_URL = "http://127.0.0.1:8792/internal/ticks";   // the feed server's own listener on this machine, never reached by the tunnel (257)
export const PUSH_MAX = 500;                                        // the site's limit: at most this many ticks a call
export const PUSH_REST_MS = 5_000;                                  // the feed refusing (down, restarting): ask again after this
export const PUSH_TIMEOUT_MS = 3_000;                               // a slow answer (a busy machine) is waited this long, never rested on
/** Hands every new tick to the feed server as soon as it is heard: the ticks of one moment go together, one request a coin,
 *  never awaited (the tick file still follows as history and fallback). A refusal rests the push 5 s; a slow answer (past 3 s) rests nothing, those ticks go by file. */
export class Pusher {
  constructor(fetchFn = fetch, url = PUSH_URL, now = () => Date.now()) { this.fetch = fetchFn; this.url = url; this.now = now; this.batch = new Map(); this.restUntil = 0; this.sent = 0; this.failed = 0; }
  add(mint, tick) {
    if (this.now() < this.restUntil) return;
    if (!this.batch.size) queueMicrotask(() => this.send());
    if (!this.batch.has(mint)) this.batch.set(mint, []);
    this.batch.get(mint).push(tick);
  }
  send() {
    const b = this.batch; this.batch = new Map();
    for (const [mint, all] of b) for (let k = 0; k < all.length; k += PUSH_MAX) {
      const ticks = all.slice(k, k + PUSH_MAX);
      this.fetch(this.url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ contract: "ticks-1", mint, ticks }), signal: AbortSignal.timeout(PUSH_TIMEOUT_MS) })
        .then((r) => { if (r.ok || r.status === 204) this.sent += ticks.length; else { this.failed += ticks.length; this.restUntil = this.now() + PUSH_REST_MS; } })
        .catch((e) => {                                                // slow (a timeout): these ticks go by file, the next ones still pushed;
          this.failed += ticks.length;                                 // refused or down: rest a moment
          if (e?.name !== "TimeoutError" && e?.name !== "AbortError") this.restUntil = this.now() + PUSH_REST_MS;
        });
    }
  }
}

// ------------------------------------------------------------------ settings and the node (the key stays in .env)
export const CONTROL = join(ENGINE, "control", "control.json");   // pinr.io/control's file, read with the settings
export const ROUTING = join(ENGINE, "control", "routing.json");   // the trade_feed wire (nodes in order, coins)

/** The trade_feed wire from /control's routing file, or null when none is set or it is not usable (then today's settings stand). */
export function routedFeed(routingPath = ROUTING) {
  let tf;
  try { tf = JSON.parse(readFileSync(routingPath, "utf8"))?.routing?.trade_feed; } catch { return null; }
  if (!tf || typeof tf !== "object") return null;
  const nodes = tf.nodes, coins = tf.coins;
  if (!Array.isArray(nodes) || nodes.length < 1 || nodes.length > 2 || !nodes.every((n) => NODE_NAMES.includes(n)) || new Set(nodes).size !== nodes.length) return null;
  if (!Number.isInteger(coins) || coins < 1 || coins > 1000) return null;
  return { node: nodes[0], overflow: nodes[1] || "none", coins };
}

export function settings(path = SETTINGS, controlPath = CONTROL, routingPath = ROUTING) {
  let s = {};
  try { s = JSON.parse(readFileSync(path, "utf8")); } catch { return { ...DEFAULTS, trades_ws: "off", why: "settings.json not usable" }; }
  const out = { ...DEFAULTS };
  for (const k of Object.keys(DEFAULTS)) if (s[k] !== undefined) out[k] = s[k];
  let ctl = {};
  try { ctl = JSON.parse(readFileSync(controlPath, "utf8")); } catch {}
  if (Number.isInteger(ctl?.trades_ws_max_coins) && ctl.trades_ws_max_coins >= 1 && ctl.trades_ws_max_coins <= 1000) out.trades_ws_max_coins = ctl.trades_ws_max_coins;
  const wire = routedFeed(routingPath);             // the wire wins over settings.json and the control coin count
  if (wire) { out.trades_ws_node = wire.node; out.trades_ws_overflow = wire.overflow; out.trades_ws_max_coins = wire.coins; out.routed = true; }
  const max = out.trades_ws_max_coins, mb = out.trades_ws_daily_mb;
  if (!Number.isInteger(max) || max < 1 || max > 1000) return { ...out, trades_ws: "off", why: "trades_ws_max_coins not usable (1 to 1000)" };
  if (typeof mb !== "number" || !(mb > 0) || mb > 5000) return { ...out, trades_ws: "off", why: "trades_ws_daily_mb not usable (above 0, at most 5000)" };
  const msgs = out.trades_ws_daily_msgs;
  if (!Number.isInteger(msgs) || msgs < 1 || msgs > 3000000) return { ...out, trades_ws: "off", why: "trades_ws_daily_msgs not usable (1 to 3,000,000)" };
  if (!NODE_NAMES.includes(out.trades_ws_node)) return { ...out, trades_ws: "off", why: "trades_ws_node not usable (" + NODE_NAMES.join(", ") + ")" };
  if (out.trades_ws_overflow === out.trades_ws_node) out.trades_ws_overflow = "none";       // the node itself: no overflow
  if (out.trades_ws_overflow !== "none" && !NODE_NAMES.includes(out.trades_ws_overflow))
    return { ...out, trades_ws: "off", why: "trades_ws_overflow not usable (one of " + NODE_NAMES.join(", ") + ", or none)" };
  return out;
}

export const PUBLIC_NODE = { wss: "wss://api.mainnet-beta.solana.com", http: "https://api.mainnet-beta.solana.com" };
// the team 2026-10-23: PublicNode's free Solana endpoint, keyless; it accepted accountSubscribe and sent notifications (tested).
export const PUBLICNODE = { wss: "wss://solana-rpc.publicnode.com", http: "https://solana-rpc.publicnode.com" };
/** A node bills (by message or byte) unless it is a free keyless endpoint (Solana's own, PublicNode's): only a billing node is metered. */
export const bills = (which) => which !== "public" && which !== "publicnode";

export function nodeUrls(env, which) {
  if (which === "public") return PUBLIC_NODE;
  if (which === "publicnode") return PUBLICNODE;
  if (which === "helius" && env.HELIUS_API_KEY) return { wss: "wss://mainnet.helius-rpc.com/?api-key=" + env.HELIUS_API_KEY, http: "https://mainnet.helius-rpc.com/?api-key=" + env.HELIUS_API_KEY };
  if (which === "chainstack" && (env.CHAINSTACK_SOLANA_URL || "").startsWith("https://")) return { wss: env.CHAINSTACK_SOLANA_URL.replace(/^https:/, "wss:"), http: env.CHAINSTACK_SOLANA_URL };
  if (which === "shyft" && env.SHYFT_API_KEY) return { wss: "wss://rpc.shyft.to?api_key=" + env.SHYFT_API_KEY, http: "https://rpc.shyft.to?api_key=" + env.SHYFT_API_KEY };
  return null;
}

export function readEnv(path = join(ENGINE, ".env")) {
  try {
    return Object.fromEntries(readFileSync(path, "utf8").split("\n").map((l) => l.match(/^([A-Z0-9_]+)=(.*)$/)).filter(Boolean).map((m) => [m[1], m[2].trim()]));
  } catch { return {}; }
}

// ------------------------------------------------------------------ which coins: the shown curve coins, newest first
const isFeedFile = (f) => f.endsWith(".json") && !f.startsWith("_") && f !== "trigger-seen.json";

/** The feed folder's files and their change times, read once whole (a stat each) and then kept current from the
 *  folder's own change events (`fs.watch`, as the feed server's reader does), so the minute's selection stats nothing
 * . A full re-read every `fullEveryMs` catches an
 *  event the system dropped. */
export class FeedIndex {
  constructor(dir, { fullEveryMs = 30 * 60 * 1000, watchFn = watch } = {}) {
    this.dir = dir; this.times = new Map(); this.fullEveryMs = fullEveryMs; this.fullAt = 0; this.fulls = 0; this.events = 0;
    try { this.watcher = watchFn(dir, (_e, name) => { if (name && isFeedFile(String(name))) { this.events++; this.touch(String(name)); } }); } catch { this.watcher = null; }
  }
  touch(name) { try { this.times.set(name, statSync(join(this.dir, name)).mtimeMs); } catch { this.times.delete(name); } }
  full(now = Date.now()) {
    let names; try { names = readdirSync(this.dir).filter(isFeedFile); } catch { return; }
    const keep = new Map();
    for (const f of names) { try { keep.set(f, statSync(join(this.dir, f)).mtimeMs); } catch {} }
    this.times = keep; this.fullAt = now; this.fulls++;
  }
  newest(n, now = Date.now()) {
    if (!this.fullAt || !this.watcher || now - this.fullAt >= this.fullEveryMs) this.full(now);
    return [...this.times].sort((a, b) => b[1] - a[1]).slice(0, n).map(([f]) => f);
  }
  close() { try { this.watcher?.close(); } catch {} }
}

// the coins the site's first page shows, in page order, the same number of subscriptions. The
// feed server on this machine answers the page; when it does not, the old rule below (the newest feed files) stands in.
export const PAGE_URL = "http://127.0.0.1:8787/api/tokens";
export const PAGE_EVERY_MS = 30_000;

/** The curve coins on the site's first page, in the page's own order, at most `max`: [{mint, kind, when: 0}]. A coin
 *  whose launchpad is not a Pump.fun or LaunchLab curve is left out (a graduated coin has no curve to watch). */
export function pageCoins(page, max) {
  const toks = Array.isArray(page) ? page : (page && (page.tokens || page.items)) || [];
  const out = [], seen = new Set();
  for (const raw of toks) {
    const t = raw && typeof raw === "object" ? (raw.token || raw) : null;
    const mint = t && typeof t.address === "string" ? t.address : null;
    const lp = String((t && t.launchpad) || "");
    if (!mint || seen.has(mint) || !/curve/i.test(lp)) continue;
    const kind = /launchlab/i.test(lp) ? "launchlab" : /pump/i.test(lp) ? "pumpfun" : null;
    if (!kind) continue;
    seen.add(mint); out.push({ mint, kind, when: 0 });
    if (out.length >= max) break;
  }
  return out;
}

/** The site's first page from the feed server, or null when it does not answer (never throws). */
export async function loadPage(fetchFn, url = PAGE_URL) {
  try {
    const r = await fetchFn(url, { signal: AbortSignal.timeout(5000) });
    if (!r || !r.ok) return null;
    return await r.json();
  } catch { return null; }
}

/** The curve coins (the feed file's `launchpad` names a curve) among the newest feed files, scored before seen-only,
 *  newest first within each, at most `max`. Reads only the newest `scan` files by their change time: never the whole
 *  folder (the lag of 2026-10-20); with an index, their times come from it. */
export function selectCoins(feedDir, max, scan = 1500, index = null) {
  let stamped;
  if (index) stamped = index.newest(scan).map((f) => [0, f]);
  else {
    let names;
    try { names = readdirSync(feedDir).filter(isFeedFile); } catch { return []; }
    stamped = [];
    for (const f of names) { try { stamped.push([statSync(join(feedDir, f)).mtimeMs, f]); } catch {} }
    stamped.sort((a, b) => b[0] - a[0]);
  }
  const scored = [], seen = [];
  for (const [, f] of stamped.slice(0, scan)) {
    let d; try { d = JSON.parse(readFileSync(join(feedDir, f), "utf8")); } catch { continue; }
    if (!d || typeof d.mint !== "string" || !/curve/i.test(String(d.launchpad || ""))) continue;
    const when = Date.parse(d.as_of || d.seen_at || d.launched_at || "") || 0;
    const kind = /launchlab/i.test(d.launchpad) ? "launchlab" : /pump/i.test(d.launchpad) ? "pumpfun" : null;
    if (!kind) continue;
    (d.seen ? seen : scored).push({ mint: d.mint, kind, when });
  }
  const by = (a, b) => b.when - a.when;
  return [...scored.sort(by), ...seen.sort(by)].slice(0, max);
}

// ------------------------------------------------------------------ the byte meter (a UTC day's share of the node)
/** A UTC day's share of the node, in bytes (a node billed by data, Helius) and in messages (a node billed per
 *  notification, Chainstack: each one a request unit, its docs read 2026-10-21); past either, the socket closes. */
export class Budget {
  constructor(dailyMb, state = {}, dailyMsgs = Infinity) { this.limit = dailyMb * 1e6; this.msgLimit = dailyMsgs; this.day = state.day || ""; this.bytes = state.bytes || 0; this.msgs = state.msgs || 0; }
  add(n, now = Date.now()) {
    const day = new Date(now).toISOString().slice(0, 10);
    if (day !== this.day) { this.day = day; this.bytes = 0; this.msgs = 0; }
    this.bytes += n; this.msgs += 1;
    return this.bytes <= this.limit && this.msgs <= this.msgLimit;
  }
  over(now = Date.now()) { return new Date(now).toISOString().slice(0, 10) === this.day && (this.bytes > this.limit || this.msgs > this.msgLimit); }
  /** A new UTC day starts the count again even when nothing was added (the status never shows yesterday's day). */
  roll(now = Date.now()) { const day = new Date(now).toISOString().slice(0, 10); if (day !== this.day) { this.day = day; this.bytes = 0; this.msgs = 0; } return this; }
  state() { return { day: this.day, bytes: this.bytes, msgs: this.msgs }; }
}

// ------------------------------------------------------------------ the ticks and 5-minute candles per coin
const OWN = new Set(["contract", "mint", "source", "read_at", "quote", "ticks", "candles_5m", "last_sig", "graduated_at", "gaps", "trades_1h", "buys_1h", "sells_1h"]);
export const HOUR_MS = 3_600_000;   // the site's ask (260): each coin's trades over the last hour, counted by the minute
const count = (c, t, n) => { const m = Math.floor((t.t || 0) / 60_000), b = c.mins.get(m) || [0, 0]; b[t.side === "buy" ? 0 : 1] += n; c.mins.set(m, b); };
/** trades_1h, buys_1h, sells_1h: the last hour's trades by the minute of their block time, only when this writer's count
 *  covers the whole hour (it has counted the coin an hour, or the kept trades span the hour); else none, never a part-hour count. */
export function hourCounts(c, now) {
  const first = Math.floor((now - HOUR_MS) / 60_000);
  for (const m of [...c.mins.keys()]) if (m < first) c.mins.delete(m);
  if (c.since > now - HOUR_MS) return {};
  let buys = 0, sells = 0; for (const [m, b] of c.mins) if (m >= first) { buys += b[0]; sells += b[1]; }
  return { trades_1h: buys + sells, buys_1h: buys, sells_1h: sells };
}
const extras = (d) => Object.fromEntries(Object.entries(d || {}).filter(([k]) => !OWN.has(k)));
const mtimeOf = (path) => { try { return statSync(path).mtimeMs; } catch { return 0; } };
/** The coins' tick files. Another writer shares them (the SQD service, scanner/sqd_live.py, for coins this feed is not
 *  watching): a file changed on disk since this store last read or wrote it is read again and merged before writing, its
 *  ticks by sig:i and its own fields (1 s and 1 min candles, supply) kept, so neither writer loses the other's. */
export const PRICES = join(ENGINE, "index", "quote_prices.json");   // the quote coins' dollar prices: scanner/sqd_live.py reads them (Jupiter)
export const PRICE_STALE_MS = 120_000;                               // an older price is not used: the tick goes without a dollar figure
/** the site's ask (257): each tick's dollar price and size from its quote coin's price at the time (the SQD service reads Jupiter's
 *  price into PRICES; the quote coins this feed sees go in its status' `quotes`, so they are read too). price_usd, usd and
 *  price_usd_src come together or not at all. */
export class QuoteUsd {
  constructor(path = PRICES, now = () => Date.now()) { this.path = path; this.now = now; this.prices = {}; this.mtime = -1; this.checked = -Infinity; this.seen = new Set(); }
  load() {
    const t = this.now(); if (t - this.checked < 2_000) return; this.checked = t;
    const m = mtimeOf(this.path); if (m === this.mtime) return; this.mtime = m;
    try { this.prices = JSON.parse(readFileSync(this.path, "utf8")).prices || {}; } catch { this.prices = {}; }
  }
  stamp(tick) {
    const q = tick.quote; if (typeof q === "string" && q !== "other") this.seen.add(q);
    this.load();
    const p = typeof q === "string" ? this.prices[q] : null, price = tick.price_sol ?? tick.price_quote, amount = tick.sol ?? tick.quote_amount;
    if (p && typeof p.usd === "number" && p.usd > 0 && this.now() - p.read_ms <= PRICE_STALE_MS && typeof price === "number" && typeof amount === "number") {
      tick.price_usd = price * p.usd; tick.usd = amount * p.usd;
      tick.price_usd_src = "Jupiter price v3, read " + new Date(p.read_ms).toISOString().slice(0, 19) + "Z";
    }
    return tick;
  }
}

export class TickStore {
  constructor(dir = TICK_DIR, clock = () => Date.now()) { this.dir = dir; this.coins = new Map(); this.dirty = new Set(); this.clock = clock; }
  coin(mint) {
    if (!this.coins.has(mint)) {
      const path = join(this.dir, mint + ".json"), mtime = mtimeOf(path);
      let old = null;
      try { old = JSON.parse(readFileSync(path, "utf8")); } catch {}
      const c = { ticks: [], candles: old?.candles_5m || [], gaps: old?.gaps || [], graduated_at: old?.graduated_at || null,
                  seen: new Set(), last_sig: old?.last_sig || null, quote: old?.quote || null, extra: extras(old), mtime };
      for (const t of old?.ticks || []) { c.seen.add(t.sig + ":" + (t.i ?? 0)); c.ticks.push(t); }
      c.loadedFull = c.ticks.length >= KEEP_TICKS;                   // read full from disk: older trades may have been trimmed before
      const now = this.clock(); c.mins = new Map();
      for (const t of c.ticks) if ((t.t || 0) > now - HOUR_MS) count(c, t, 1);
      c.since = c.ticks.length && c.ticks[0].t <= now - HOUR_MS ? now - HOUR_MS : now;   // the kept trades span the hour: whole already
      this.coins.set(mint, c);
    }
    return this.coins.get(mint);
  }
  /** Add a tick once (a signature and its event's index within it); the candle of its 5 minutes follows. */
  add(mint, tick, i = 0) {
    const c = this.coin(mint);
    if (!this.put(c, { ...tick, i })) return false;
    c.quote = tick.quote;
    c.last_sig = tick.sig;
    this.dirty.add(mint);
    return true;
  }
  put(c, tick) {
    const key = tick.sig + ":" + (tick.i ?? 0);
    if (c.seen.has(key)) return false;
    c.seen.add(key);
    c.ticks.push(tick);
    count(c, tick, 1);
    c.ticks.sort((a, b) => a.t - b.t);
    if (c.ticks.length > KEEP_TICKS) { for (const t of c.ticks.splice(0, c.ticks.length - KEEP_TICKS)) { c.seen.delete(t.sig + ":" + (t.i ?? 0)); c.trimmed = Math.max(c.trimmed ?? -Infinity, t.t); } }
    const p = tick.price_sol ?? tick.price_quote;
    if (typeof p === "number" && isFinite(p)) {
      const start = Math.floor(tick.t / CANDLE_MS) * CANDLE_MS;
      let k = c.candles.find((x) => x.t === start);
      if (!k) { k = { t: start, o: p, h: p, l: p, c: p, v: 0, buys: 0, sells: 0 }; c.candles.push(k); c.candles.sort((a, b) => a.t - b.t); }
      else { k.h = Math.max(k.h, p); k.l = Math.min(k.l, p); if (tick.t >= (k.last_t ?? 0)) k.c = p; }
      k.last_t = Math.max(k.last_t ?? 0, tick.t);
      k.v += tick.sol ?? tick.quote_amount ?? 0;
      k[tick.side === "buy" ? "buys" : "sells"] += 1;
      if (c.candles.length > KEEP_CANDLES) c.candles.splice(0, c.candles.length - KEEP_CANDLES);
    }
    return true;
  }
  /** Remove a transaction's ticks (one the chain never confirmed, 257 W1) and take them out of their 5-minute candles: a
   *  candle whose whole window is still among the kept ticks is rebuilt from them, else only its volume and counts are taken
   *  down (its open, high, low and close stay as they were). The number of ticks removed. */
  forget(mint, sig) {
    const c = this.coins.get(mint); if (!c) return 0;
    const gone = c.ticks.filter((t) => t.sig === sig); if (!gone.length) return 0;
    c.ticks = c.ticks.filter((t) => t.sig !== sig);
    for (const t of gone) {
      c.seen.delete(t.sig + ":" + (t.i ?? 0)); count(c, t, -1);
      const start = Math.floor(t.t / CANDLE_MS) * CANDLE_MS, k = c.candles.find((x) => x.t === start);
      if (!k) continue;
      const rest = c.ticks.filter((x) => x.t >= start && x.t < start + CANDLE_MS && typeof (x.price_sol ?? x.price_quote) === "number");
      const trimmed = c.trimmed ?? (c.loadedFull ? c.ticks[0]?.t ?? Infinity : -Infinity);   // the newest trade no longer kept
      if (trimmed < start) {                                         // every trade of this window is still among the kept ticks
        if (!rest.length) { c.candles = c.candles.filter((x) => x !== k); continue; }
        const ps = rest.map((x) => x.price_sol ?? x.price_quote);
        Object.assign(k, { o: ps[0], h: Math.max(...ps), l: Math.min(...ps), c: ps[ps.length - 1], last_t: rest[rest.length - 1].t,
                           v: rest.reduce((a, x) => a + (x.sol ?? x.quote_amount ?? 0), 0), buys: rest.filter((x) => x.side === "buy").length,
                           sells: rest.filter((x) => x.side !== "buy").length });
      } else {
        k.v = Math.max(0, k.v - (t.sol ?? t.quote_amount ?? 0)); k[t.side === "buy" ? "buys" : "sells"] = Math.max(0, k[t.side === "buy" ? "buys" : "sells"] - 1);
      }
    }
    this.dirty.add(mint);
    return gone.length;
  }
  graduated(mint, at) { const c = this.coin(mint); if (!c.graduated_at) { c.graduated_at = new Date(at).toISOString(); this.dirty.add(mint); } }
  gap(mint, from, to, why) { const c = this.coin(mint); c.gaps.push({ from: new Date(from).toISOString(), to: new Date(to).toISOString(), why }); c.gaps = c.gaps.slice(-20); this.dirty.add(mint); }
  /** Forget coins this feed has stopped writing (another writer takes them), after writing what it holds: when one comes
   *  back it is read from its file again and its hour counted afresh, never from the old count. */
  release(mints) {
    if ([...mints].some((m) => this.dirty.has(m))) this.flush();
    for (const m of mints) this.coins.delete(m);
  }
  /** Write every changed coin's file whole (a temporary file, then one rename), after merging what another writer put there. */
  flush(now = this.clock()) {
    if (!this.dirty.size) return 0;
    mkdirSync(this.dir, { recursive: true });
    let n = 0;
    for (const mint of this.dirty) {
      const c = this.coins.get(mint); if (!c) continue;
      const path = join(this.dir, mint + ".json"), m = mtimeOf(path);
      if (m && m !== c.mtime) {
        let disk = null;
        try { disk = JSON.parse(readFileSync(path, "utf8")); } catch {}
        if (disk) { c.extra = extras(disk); for (const t of disk.ticks || []) this.put(c, t); if (!c.graduated_at && disk.graduated_at) c.graduated_at = disk.graduated_at; }
      }
      const body = { ...c.extra, contract: "ticks-1", mint, source: "Solana chain", read_at: new Date(now).toISOString(), quote: c.quote,
                     ticks: c.ticks, candles_5m: c.candles.map(({ last_t, ...k }) => k), last_sig: c.last_sig };
      if (c.graduated_at) body.graduated_at = c.graduated_at;
      if (c.gaps.length) body.gaps = c.gaps;
      Object.assign(body, hourCounts(c, now));
      writeFileSync(path + ".tmp", JSON.stringify(body)); renameSync(path + ".tmp", path); n++;
      c.mtime = mtimeOf(path);
    }
    this.dirty.clear();
    return n;
  }
}

// ------------------------------------------------------------------ a coin's curve account: where it is, what it holds
/** The curve account for a coin and how to read it: Pump.fun's from its PDA; LaunchLab's pool from its PDA with SOL as
 *  the quote, trusted only when the chain shows the LaunchLab program owns it and it names this coin (else null: the coin
 *  is not watched, never a guessed pool). */
export async function curveFor(coin, rpc, poolOf = raydiumPool) {
  if (coin.kind === "pumpfun") return { address: pumpCurveAddress(coin.mint), owner: PROGRAMS.pumpfun, read: pumpCurveState };
  const verified = async (address) => {
    const v = (await rpc("getAccountInfo", [address, { encoding: "base64" }]))?.value;
    const st = v && v.owner === PROGRAMS.launchlab ? launchlabPoolState(Buffer.from(v.data[0], "base64")) : null;
    return st && st.base_mint === coin.mint ? { address, owner: PROGRAMS.launchlab, read: launchlabPoolState } : null;
  };
  try {
    const sol = await verified(launchlabPoolAddress(coin.mint));
    if (sol) return sol;
    // the team 2026-10-23: a Stonk.fun pool can be quoted in another coin, so its address is not the SOL one. Raydium's own
    // launch record names the pool; it is trusted only when the chain shows LaunchLab owns it and it names this coin.
    const other = await poolOf(coin.mint);
    return other ? await verified(other) : null;
  } catch { return null; }
}

/** The coin's LaunchLab pool from Raydium's own keyless launch record (the engine reads the same record), or null. */
export async function raydiumPool(mint, fetchFn = fetch) {
  try {
    const r = await fetchFn(`https://launch-mint-v1.raydium.io/get/by/mints?ids=${mint}`, { signal: AbortSignal.timeout(5000) });
    if (!r || !r.ok) return null;
    const row = ((await r.json())?.data?.rows || []).find((x) => x && x.mint === mint);
    return row && typeof row.poolId === "string" ? row.poolId : null;
  } catch { return null; }
}

export const SKIP_RETRY_MS = 15 * 60_000;              // a coin whose curve could not be verified is asked about again after this

/** One state of a coin's curve (a notification or an HTTP read) against the last one: a tick when it moved, a
 *  graduation when the curve finished. Returns {state, tick?, graduated?}. */
export function step(prev, raw, owner, curve, at, slot) {
  if (owner !== curve.owner) return { state: prev };
  const st = curve.read(raw);
  if (!st) return { state: prev };
  const out = { state: st };
  const t = tradeBetween(prev, st, at, slot);
  if (t) out.tick = t;
  if ((st.kind === "pumpfun" && st.complete) || (st.kind === "launchlab" && st.status !== 0)) out.graduated = at;
  return out;
}

export function httpRpc(url, fetchFn = fetch) {
  let id = 0;
  return async (method, params) => {
    const r = await fetchFn(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }) });
    if (!r.ok) throw new Error("HTTP " + r.status);
    const j = await r.json();
    if (j.error) throw new Error(j.error.message || "rpc error");
    return j.result;
  };
}

// ------------------------------------------------------------------ the service
export async function main({ WebSocketImpl = globalThis.WebSocket, fetchFn = fetch, env = readEnv(), settingsPath = SETTINGS, store = new TickStore(),
                             statePath = STATE, statusDir = TICK_DIR, feedDir = FEED_DIR, log = say, retryMs = PUBLIC_RETRY_MS,
                             routingPath = ROUTING, restart = () => {}, refreshMs = 60_000, pusher = null, flushMs = 500, prices = new QuoteUsd() } = {}) {
  const push = pusher || new Pusher(fetchFn);
  let s = settings(settingsPath, CONTROL, routingPath);
  if (s.trades_ws !== "on") { log(`trades_ws is not on${s.why ? ": " + s.why : ""}: nothing opened`); return null; }
  const primary = s.trades_ws_node, overflow = s.trades_ws_overflow;
  if (!nodeUrls(env, primary)) { log(`no address for the node ${primary} in the engine's .env: nothing opened`); return null; }
  let saved = {}; try { saved = JSON.parse(readFileSync(statePath, "utf8")); } catch {}
  const budget = new Budget(s.trades_ws_daily_mb, saved.budget || {}, s.trades_ws_daily_msgs);   // the billing node's share only
  const free = new Budget(Infinity, saved.free || {}, Infinity);                                   // the public node's count, for the status only
  let node = primary, urls = nodeUrls(env, node), rpc = httpRpc(urls.http, fetchFn);
  let openedAt = 0, heldLast = null, shortRun = 0, backToPrimaryAt = 0;
  const useNode = (name) => { node = name; urls = nodeUrls(env, name); rpc = httpRpc(urls.http, fetchFn); };
  const pick = () => {                                     // which node this connection uses; null when none may be used now
    if (node !== primary && Date.now() >= backToPrimaryAt) useNode(primary);
    if (bills(node) && budget.over()) { if (node !== primary && !bills(primary)) useNode(primary); else return null; }
    return urls;
  };
  let ws = null, backoff = 1000, reconnects = 0, lastMessage = 0, connected = false, stopped = false;
  const timers = [];
  const later = (fn, ms) => { if (!stopped) timers.push(setTimeout(fn, ms)); };
  const stop = () => { stopped = true; for (const t of timers) { clearTimeout(t); clearInterval(t); } try { ws?.close(1000, "stop"); } catch {} index?.close(); };
  const subs = new Map(), byMint = new Map(), pending = new Map(), curves = new Map(), states = new Map(), skipped = new Map(), graduated = new Set();
  const index = new FeedIndex(feedDir);
  let watched = [];
  let page = null;                                        // the site's first page, refreshed on its own timer
  const reloadPage = async () => { const p = await loadPage(fetchFn); if (p) page = p; else page = null; };
  const status = (why) => {
    mkdirSync(statusDir, { recursive: true });
    budget.roll(); free.roll();                           // a new UTC day shows as today's, even with nothing counted yet
    const body = { connected, node, primary, overflow, method: "accountSubscribe (curve accounts)", coins: watched.length, subscribed: subs.size,
                   pushed: push.sent, push_failed: push.failed,                // 257: ticks handed to the feed server at once
                   watched: watched.map((c) => c.mint),                        // 257: these coins' tick files are this service's (SQD skips them)
                   quotes: [...prices.seen],                                   // 257: their quote coins, so the SQD service reads their dollar prices
                   bytes_today: budget.bytes, budget_mb: s.trades_ws_daily_mb, messages_today: budget.msgs, budget_messages: s.trades_ws_daily_msgs, day: budget.day,
                   public_messages_today: free.msgs, held_last_s: heldLast, reconnects,
                   last_message_at: lastMessage ? new Date(lastMessage).toISOString() : null, note: why || null };
    writeFileSync(join(statusDir, "_status.json.tmp"), JSON.stringify(body)); renameSync(join(statusDir, "_status.json.tmp"), join(statusDir, "_status.json"));
    writeFileSync(statePath, JSON.stringify({ budget: budget.state(), free: free.state() }));
  };
  let nextId = 1;
  const send = (m) => { try { ws.send(JSON.stringify(m)); } catch {} };
  const queue = [];                                       // subscribe requests waiting their turn (SUBS_PER_SECOND)
  const subscribe = (coin) => { if (!queue.some((c) => c.mint === coin.mint)) queue.push(coin); };
  let draining = false;                                   // one batch at a time, however slow a pool read
  const drain = async () => {
    if (!connected || draining) return;
    draining = true;
    try { await drainOnce(); } finally { draining = false; }
  };
  const drainOnce = async () => {
    for (let k = 0; k < SUBS_PER_SECOND && queue.length; k++) {
      const coin = queue.shift();
      let curve = curves.get(coin.mint);
      if (!curve) {
        curve = await curveFor(coin, rpc, (m) => raydiumPool(m, fetchFn));
        if (!curve) { if (!skipped.has(coin.mint)) log(`${coin.mint.slice(0, 6)}..: no curve account verified on chain: not watched for now`); skipped.set(coin.mint, Date.now()); continue; }
        curves.set(coin.mint, curve);
      }
      const id = nextId++;
      pending.set(id, coin);
      send({ jsonrpc: "2.0", id, method: "accountSubscribe", params: [curve.address, { encoding: "base64", commitment: "confirmed" }] });
    }
  };
  const unsubscribe = (mint) => { const sub = byMint.get(mint); if (sub === undefined) return; send({ jsonrpc: "2.0", id: nextId++, method: "accountUnsubscribe", params: [sub] }); byMint.delete(mint); subs.delete(sub); };
  const refresh = () => {
    s = settings(settingsPath, CONTROL, routingPath);
    if (s.trades_ws !== "on") { log("trades_ws switched off: closing"); stop(); return false; }
    if (s.trades_ws_node !== primary || s.trades_ws_overflow !== overflow) {   // 243 phase 2: a new node wire is followed live
      log(`the nodes changed (${primary}, then ${overflow} -> ${s.trades_ws_node}, then ${s.trades_ws_overflow}): closing to start again on them`);
      stop(); restart(); return false;
    }
    for (const [m, at] of skipped) if (Date.now() - at > SKIP_RETRY_MS) skipped.delete(m);   // asked about again
    const room = s.trades_ws_max_coins + graduated.size + skipped.size;
    const fromPage = page ? pageCoins(page, room) : [];   // the page's coins in its order; else the old rule
    watched = (fromPage.length ? fromPage : selectCoins(feedDir, room, 1500, index))
      .filter((c) => !skipped.has(c.mint) && !graduated.has(c.mint) && !store.coin(c.mint).graduated_at)   // a graduated coin is never subscribed again (watch 2)
      .slice(0, s.trades_ws_max_coins);
    const want = new Set(watched.map((c) => c.mint));
    for (const mint of [...byMint.keys()]) if (!want.has(mint)) { unsubscribe(mint); states.delete(mint); }
    if (connected) for (const c of watched) if (!byMint.has(c.mint) && ![...pending.values()].some((p) => p.mint === c.mint)) subscribe(c);
    for (let k = queue.length - 1; k >= 0; k--) if (!want.has(queue[k].mint)) queue.splice(k, 1);
    return true;
  };
  const apply = (coin, raw, owner, at, slot) => {
    const curve = curves.get(coin.mint); if (!curve) return;
    const r = step(states.get(coin.mint), raw, owner, curve, at, slot);
    states.set(coin.mint, r.state);
    if (r.tick) { r.tick.seen_ms = Date.now(); prices.stamp(r.tick); if (store.add(coin.mint, r.tick)) push.add(coin.mint, { ...r.tick, i: r.tick.i ?? 0 }); }   // 257
    if (r.graduated) { store.graduated(coin.mint, r.graduated); graduated.add(coin.mint); unsubscribe(coin.mint); }
  };
  const open = () => {
    if (stopped) return;
    if (!pick()) { connected = false; status("the overflow node's share is used up and the public node is resting: trying again in a minute"); later(open, 60_000); return; }
    const sock = ws = new WebSocketImpl(urls.wss);
    ws.onopen = async () => {
      connected = true; backoff = 1000; openedAt = Date.now(); subs.clear(); byMint.clear(); pending.clear(); queue.length = 0;
      log(`connected to ${node}; ${watched.length} coins`);
      if (reconnects) {                                   // while disconnected: one HTTP read of each curve; a move is a gap
        let gaps = 0;
        for (const c of watched) {
          const curve = curves.get(c.mint), prev = states.get(c.mint);
          if (!curve || !prev) continue;
          try {
            const v = (await rpc("getAccountInfo", [curve.address, { encoding: "base64" }]))?.value;
            if (!v) continue;
            if (!bills(node)) await new Promise((ok) => setTimeout(ok, GAP_READ_MS));   // the public node's per-method limit
            const r = step(prev, Buffer.from(v.data[0], "base64"), v.owner, curve, Date.now(), null);
            if (r.tick) { gaps++; store.gap(c.mint, lastMessage || Date.now(), Date.now(), `trades while the socket was down not read; the price moved from ${priceOf(prev)} to ${priceOf(r.state)}`); }
            states.set(c.mint, r.state);
            if (r.graduated) store.graduated(c.mint, r.graduated);
          } catch {}
        }
        log(`after the reconnect: ${gaps} coins moved while disconnected (written as gaps)`);
      }
      for (const c of watched) subscribe(c);
    };
    ws.onmessage = (ev) => {
      const text = typeof ev.data === "string" ? ev.data : ev.data.toString();
      lastMessage = Date.now();
      if (!bills(node)) free.add(text.length);
      else if (!budget.add(text.length)) { log(`the day's share of ${node} (${s.trades_ws_daily_mb} MB or ${s.trades_ws_daily_msgs} messages) is used up: closing it`); try { ws.close(4000, "budget"); } catch {} return; }
      let m; try { m = JSON.parse(text); } catch { return; }
      if (m.id !== undefined && pending.has(m.id)) {
        const coin = pending.get(m.id); pending.delete(m.id);
        if (m.error) { log(`subscription refused for ${coin.mint.slice(0, 6)}..: ${m.error.message || m.error.code}`); subscribe(coin); return; }
        subs.set(m.result, coin); byMint.set(coin.mint, m.result); return;
      }
      if (m.method !== "accountNotification") return;
      const coin = subs.get(m.params?.subscription); if (!coin) return;
      const v = m.params.result.value;
      apply(coin, Buffer.from(v.data[0], "base64"), v.owner, Date.now(), m.params.result.context?.slot);
    };
    ws.onclose = (e) => {
      if (sock !== ws) return;                             // an older socket's late close
      connected = false;
      heldLast = openedAt ? Math.round((Date.now() - openedAt) / 1000) : 0; openedAt = 0;
      if (stopped) return;
      if (e?.code === 4000) {                              // the overflow node's share is used up: back to the public node at once
        backToPrimaryAt = 0; status(`${node}'s share is used up`); later(open, bills(primary) ? 60_000 : 1000); return;
      }
      if (e?.code === 4001) {                              // the overflow's time is up: straight back to the public node
        backToPrimaryAt = 0; backoff = 1000; log(`${overflow}'s turn is over: back to ${primary}`); status("back to the public node"); later(open, 1000); return;
      }
      if (node === primary && overflow !== "none") {
        shortRun = heldLast < HOLD_MIN_S ? shortRun + 1 : 0;
        if (shortRun >= SHORT_IN_ROW && nodeUrls(env, overflow) && !budget.over()) {
          log(`${primary} held less than ${HOLD_MIN_S} s ${shortRun} times in a row: ${overflow} takes over for ${retryMs / 60000} minutes`);
          shortRun = 0; useNode(overflow); backToPrimaryAt = Date.now() + retryMs;
          const until = backToPrimaryAt;                   // F1: even while it holds; a timer from an earlier turn never ends a later one
          later(() => { if (node === overflow && connected && backToPrimaryAt === until) { try { ws.close(4001, "back to the public node"); } catch {} } }, retryMs);
        }
      }
      reconnects++; const wait = backoff; backoff = Math.min(backoff * 2, 60_000);
      log(`the socket closed (${e?.code ?? "?"}) after ${heldLast} s; reconnecting to ${node} in ${wait / 1000} s`); status("reconnecting");
      later(open, wait);
    };
    ws.onerror = () => {};
  };
  await reloadPage();                                     // the first pick already follows the page
  refresh();
  open();
  timers.push(setInterval(() => store.flush(), flushMs));             // 257: the file every half second (the push goes at once)
  timers.push(setInterval(drain, 1000));
  timers.push(setInterval(reloadPage, PAGE_EVERY_MS));
  timers.push(setInterval(() => { if (refresh()) status(); }, refreshMs));
  return { stop, status: () => ({ connected, node, subscribed: subs.size, waiting: queue.length, bytes: budget.bytes, messages: budget.msgs, public_messages: free.msgs, held_last_s: heldLast, reconnects }) };
}

// A node change closes the feed; the service (Restart=always) starts it again on the new nodes.
if (process.argv[1] === fileURLToPath(import.meta.url)) main({ restart: () => setTimeout(() => process.exit(0), 500) });
