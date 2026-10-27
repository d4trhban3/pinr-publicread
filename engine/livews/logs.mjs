// the busiest listed coins' trades over websockets, about 0.7 s before SQD
// Portal hears them (measured on the server 2026-10-25: 63 trades, Helius at "processed" a median 0.74 s ahead of SQD).
// `logsSubscribe` mentioning each coin; every trade event in a transaction's logs ("Program data: ...") is decoded with
// the launchpads' own published IDLs (livews/idl.mjs, the same reading as scanner/sqd.py): Pump.fun's curve TradeEvent,
// PumpSwap's BuyEvent and SellEvent (graduated coins), LaunchLab's TradeEvent. A pool or a coin's decimals is read from
// the chain once (getAccountInfo on the public node) and kept; a trade whose pool or decimals could not be read gives no
// tick, never a guessed one. Ticks go into the same ticks-1 files (keyed sig:i, merged with the other writers' by
// TickStore) and to the feed server at once (Pusher), with dollar figures (QuoteUsd).
// Helius bills websockets by data (2 credits per 0.1 MB, its websocket page, read 2026-10-25), so a daily share in bytes
// (`trades_logs_daily_mb`) is metered on a billing node (BILLED); past it every subscription closes and SQD carries the coins again. At most 1,000
// coins a connection and 5 connections (Helius's free plan, its rate-limits page, read 2026-10-25). Its node is RPC provider B's
// websocket on the operator's key (no data meter, about 0.55 s ahead of the public node, measured 2026-10-25), the public node
// taking a socket that goes silent or keeps dropping. The coins this service
// watches are in `frontend-feed/ticks/_logs_status.json`; the SQD service writes every other listed coin (one writer a coin; the curve-account feed is switched off).
// Off unless `trades_logs` is "on" in scanner/settings.json. The node's key is never printed.
//   node livews/logs.mjs            the service (the user unit ops/systemd/pinr-wslogs.service runs it)
import { readFileSync, writeFileSync, renameSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Idl, IDL_PATHS } from "./idl.mjs";
import { ENGINE, TICK_DIR, TickStore, Pusher, QuoteUsd, Budget, readEnv, httpRpc, PUBLIC_NODE } from "./trades.mjs";
import * as W from "./wires.mjs";

export const LOGS_STATUS = join(TICK_DIR, "_logs_status.json");
const SETTINGS = join(ENGINE, "scanner", "settings.json");
const STATE = join(ENGINE, "index", "trades_logs.json");
const SQD_STATUS = join(ENGINE, "index", "sqd_live.json");
export const UNCONFIRMED = join(ENGINE, "index", "unconfirmed.json");   // unconfirmed trades of coins this feed handed back: SQD removes them
export const HANDED_KEEP_MS = 15 * 60_000;
const WANTED = join(ENGINE, "index", "pinrbot-wanted-site.json");
const FEED = "http://127.0.0.1:8787";
export const PUMP = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";
export const PUMP_AMM = "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA";
export const LAUNCHLAB = "LanMV9sAd7wArD4vJFi2qDdfnVhFxYSUg6eADduJ3uj";
export const WSOL = "So11111111111111111111111111111111111111112";
const ZERO = "11111111111111111111111111111111";              // an unset pubkey in an event: no quote coin named (SOL)
const PUMP_DECIMALS = 6;                                       // Pump.fun's program makes every curve coin with six
export const PER_SOCKET = 1000, MAX_SOCKETS = 5;               // Helius free plan: 1,000 subscriptions a connection, 5 connections
export const LOGS_DEFAULTS = { trades_logs: "off", trades_logs_node: "helius_official", trades_logs_fallback: "public", trades_logs_daily_mb: 1000, trades_logs_max_coins: 1000 };
export const NODES = ["rpc_b", "helius_official", "public"];
export const BILLED = new Set(["helius_official"]);            // nodes that bill by data (Helius: 2 credits per 0.1 MB); the others are not metered
export const SUBS_PER_S = 4;                                   // subscribe requests at most this fast
export const STRIKES = 2;                                      // a node silent, or dropping within SHORT_MS of opening, this many times: the fallback takes the socket
export const SHORT_MS = 30_000;
export const FALLBACK_MS = 10 * 60_000;                        // then the main node is tried again after this
export const BUSY_WINDOW_MS = 10 * 60_000;                     // a coin's trades over this window rank it
export const SILENT_MS = 90_000;                               // a socket that heard nothing this long is not trusted: its coins are
                                                               // not named (SQD writes them) and it is opened again
const say = (line) => console.log(new Date().toISOString().slice(11, 19) + " " + line);

export function logsSettings(path = SETTINGS) {
  let s = {};
  try { s = JSON.parse(readFileSync(path, "utf8")); } catch { return { ...LOGS_DEFAULTS, trades_logs: "off", why: "settings.json not usable" }; }
  const out = { ...LOGS_DEFAULTS };
  for (const k of Object.keys(LOGS_DEFAULTS)) if (s[k] !== undefined) out[k] = s[k];
  const mb = out.trades_logs_daily_mb, max = out.trades_logs_max_coins;
  if (typeof mb !== "number" || !(mb > 0) || mb > 50_000) return { ...out, trades_logs: "off", why: "trades_logs_daily_mb not usable (above 0, at most 50000)" };
  if (!Number.isInteger(max) || max < 1 || max > PER_SOCKET * MAX_SOCKETS) return { ...out, trades_logs: "off", why: `trades_logs_max_coins not usable (1 to ${PER_SOCKET * MAX_SOCKETS})` };
  if (!NODES.includes(out.trades_logs_node)) return { ...out, trades_logs: "off", why: `trades_logs_node not usable (${NODES.join(", ")})` };
  if (out.trades_logs_fallback !== "none" && (!NODES.includes(out.trades_logs_fallback) || out.trades_logs_fallback === out.trades_logs_node
      || BILLED.has(out.trades_logs_fallback))) out.trades_logs_fallback = "none";   // a billing node is never the fallback: its share would stop and restart it in a loop
  return out;
}

export function logsNode(env, which) {
  if (which === "public") return PUBLIC_NODE.wss;
  if (which === "rpc_b" && /^https:\/\//.test(env.RPC_B_SOLANA_URL || "")) return env.RPC_B_SOLANA_URL.replace(/^https:/, "wss:");   // the operator's key, in the address
  if (which === "helius_official" && env.HELIUS_OFFICIAL_KEY) return "wss://mainnet.helius-rpc.com/?api-key=" + env.HELIUS_OFFICIAL_KEY;
  return null;
}

// ------------------------------------------------------------------ the events in one transaction's logs
const IDLS = { [PUMP]: new Idl(IDL_PATHS.pump), [PUMP_AMM]: new Idl(IDL_PATHS.pump_amm), [LAUNCHLAB]: new Idl(IDL_PATHS.launchlab) };

/** [{program, name, f}] for the launchpads' events in a transaction's logs, in the order the logs give them. */
export function eventsOf(logs) {
  const out = [], stack = [];
  for (const line of logs || []) {
    let m = line.match(/^Program (\S+) invoke \[\d+\]$/);
    if (m) { stack.push(m[1]); continue; }
    if (/^Program \S+ (success|failed)/.test(line)) { stack.pop(); continue; }
    if (!line.startsWith("Program data: ")) continue;
    const program = stack[stack.length - 1], idl = IDLS[program];
    if (!idl) continue;
    let got = null;
    try { got = idl.event(Buffer.from(line.slice(14), "base64")); } catch { got = null; }   // a shape the IDL does not fit: skipped
    if (got) out.push({ program, name: got[0], f: got[1] });
  }
  return out;
}

/** A pool's coin and quote, and a coin's decimals, read from the chain once each and kept (in memory and in STATE). */
export class Lookups {
  constructor(rpc, saved = {}) { this.rpc = rpc; this.pools = new Map(Object.entries(saved.pools || {})); this.decimals = new Map(Object.entries(saved.decimals || {})); this.asking = new Map(); }
  once(key, fn) {
    if (!this.asking.has(key)) this.asking.set(key, fn().finally(() => this.asking.delete(key)));
    return this.asking.get(key);
  }
  async account(addr) {
    const r = await this.rpc("getAccountInfo", [addr, { encoding: "base64", commitment: "confirmed" }]);
    const v = r && r.value; return v && Array.isArray(v.data) ? { owner: v.owner, data: Buffer.from(v.data[0], "base64") } : null;
  }
  /** {base, quote, base_decimals?, quote_decimals?} of a PumpSwap or LaunchLab pool, or null when the chain does not show one. */
  async pool(program, addr) {
    if (this.pools.has(addr)) return this.pools.get(addr);
    return this.once("pool:" + addr, async () => {
      let a = null; try { a = await this.account(addr); } catch { return null; }   // not read now: asked again with the next trade
      let p = null;
      if (a && a.owner === program && program === PUMP_AMM) { const s = IDLS[PUMP_AMM].account("Pool", a.data); if (s) p = { base: s.base_mint, quote: s.quote_mint }; }
      if (a && a.owner === program && program === LAUNCHLAB) { const s = IDLS[LAUNCHLAB].account("PoolState", a.data); if (s) p = { base: s.base_mint, quote: s.quote_mint, base_decimals: s.base_decimals, quote_decimals: s.quote_decimals }; }
      if (p) this.pools.set(addr, p);
      return p;
    });
  }
  async decimalsOf(mint) {
    if (mint === WSOL) return 9;
    if (this.decimals.has(mint)) return this.decimals.get(mint);
    return this.once("dec:" + mint, async () => {
      let r = null; try { r = await this.rpc("getAccountInfo", [mint, { encoding: "jsonParsed", commitment: "confirmed" }]); } catch { return null; }
      const d = r?.value?.data?.parsed?.info?.decimals;
      if (!Number.isInteger(d)) return null;
      this.decimals.set(mint, d); return d;
    });
  }
  state() { return { pools: Object.fromEntries(this.pools), decimals: Object.fromEntries(this.decimals) }; }
}

const good = (v) => typeof v === "number" && Number.isFinite(v) && v >= 0;
/** Put the quote side on a tick as ticks-1 has it (the same as scanner/sqd_live.py _sized). */
function sized(tick, quote, amount, price) {
  tick.quote = quote || "other";
  if (quote === WSOL) { if (good(amount)) tick.sol = amount; if (good(price) && price > 0) tick.price_sol = price; }
  else if (quote) { if (good(amount)) tick.quote_amount = amount; if (good(price) && price > 0) tick.price_quote = price; }
  return tick;
}

/** [{tick?, graduated?}] for `mint` from one logs notification, in the same shape and by the same arithmetic as
 *  scanner/sqd_live.py ticks_of (so the two writers' ticks for one trade are the same tick): block time from the event's
 *  own timestamp where it has one, else the time it was heard (marked t_is_receipt). */
export async function ticksOf(value, slot, mint, lookups, seenMs) {
  if (!value || value.err) return [];
  const out = []; let i = 0;
  for (const { program, name, f } of eventsOf(value.logs)) {
    if (program === PUMP && name === "CompleteEvent") { if (f.mint === mint) out.push({ graduated: (f.timestamp || 0) * 1000 || seenMs }); continue; }
    const at = Number.isFinite(f.timestamp) && f.timestamp > 0 ? f.timestamp * 1000 : null;
    const base = () => ({ t: at ?? seenMs, t_is_receipt: at === null, seen_ms: seenMs, slot, sig: value.signature, i: 0, from_state: false });
    if (program === PUMP && name === "TradeEvent") {
      if (f.mint !== mint) continue;
      const q = f.quote_mint && f.quote_mint !== ZERO ? f.quote_mint : WSOL;
      const qd = await lookups.decimalsOf(q), bd = PUMP_DECIMALS;
      const qa = q === WSOL ? f.sol_amount : f.quote_amount, vq = q === WSOL ? f.virtual_sol_reserves : f.virtual_quote_reserves, vt = f.virtual_token_reserves;
      const price = qd !== null && vq && vt ? (vq / 10 ** qd) / (vt / 10 ** bd) : null;
      const tick = { ...base(), i: i++, side: f.is_buy ? "buy" : "sell", tokens: (f.token_amount || 0) / 10 ** bd };
      out.push({ tick: sized(tick, q, qd !== null && Number.isFinite(qa) ? qa / 10 ** qd : null, price) });
    } else if (program === PUMP_AMM && (name === "BuyEvent" || name === "SellEvent")) {
      const p = await lookups.pool(PUMP_AMM, f.pool);
      if (!p || p.base !== mint) continue;
      const buy = name === "BuyEvent";
      const bd = await lookups.decimalsOf(mint), qd = await lookups.decimalsOf(p.quote);
      const b = buy ? f.base_amount_out : f.base_amount_in, qa = buy ? f.quote_amount_in : f.quote_amount_out;
      if (bd === null || !Number.isFinite(b) || b <= 0) continue;   // the coin's decimals not read: not priced, not sized
      const tokens = b / 10 ** bd, qv = qd !== null && Number.isFinite(qa) ? qa / 10 ** qd : null;
      const tick = { ...base(), i: i++, side: buy ? "buy" : "sell", tokens };
      out.push({ tick: sized(tick, p.quote, qv, qv !== null && tokens ? qv / tokens : null), supply: Number.isFinite(f.base_supply) && f.base_supply > 0 ? f.base_supply / 10 ** bd : null });
    } else if (program === LAUNCHLAB && name === "TradeEvent") {
      const p = await lookups.pool(LAUNCHLAB, f.pool_state);
      if (!p || p.base !== mint) continue;
      const d = f.trade_direction, buy = d === "Buy", bd = p.base_decimals, qd = p.quote === WSOL ? 9 : p.quote_decimals;
      if (!Number.isInteger(bd) || (d !== "Buy" && d !== "Sell")) continue;
      const b = buy ? f.amount_out : f.amount_in, qa = buy ? f.amount_in : f.amount_out;
      const vb = (f.virtual_base || 0) - (f.real_base_after || 0), vq = (f.virtual_quote || 0) + (f.real_quote_after || 0);
      const price = Number.isInteger(qd) && vb > 0 ? (vq / 10 ** qd) / (vb / 10 ** bd) : null;
      const tick = { ...base(), i: i++, side: buy ? "buy" : "sell", tokens: (b || 0) / 10 ** bd };
      out.push({ tick: sized(tick, p.quote, Number.isInteger(qd) && Number.isFinite(qa) ? qa / 10 ** qd : null, price) });
    }
  }
  return out;
}

// ------------------------------------------------------------------ which coins: the busiest listed coins first
/** The Solana coins the site lists (its first page, the rest of its lists, the coins viewers opened); null when the feed does not answer. */
export async function listedCoins(fetchFn = fetch, wantedPath = WANTED) {
  const out = new Set();
  try {
    for (const path of ["/api/tokens", "/api/tokens/rest"]) {
      const r = await fetchFn(FEED + path, { signal: AbortSignal.timeout(5000) });
      if (!r.ok) return null;
      const d = await r.json(), rows = (d && (d.tokens || d.rest)) || (Array.isArray(d) ? d : []);
      for (const t of rows) if (t && typeof t.address === "string" && !t.address.startsWith("0x")) out.add(t.address);
    }
  } catch { return null; }
  try { for (const m of Object.keys(JSON.parse(readFileSync(wantedPath, "utf8")).coins || {})) if (!m.startsWith("0x")) out.add(m); } catch {}
  return out;
}

/** The coins to watch: listed coins ranked by their trades over the last BUSY_WINDOW_MS (the SQD service's count, or
 *  this service's own for coins it already watches), the busiest first, at most `max`; ties keep the coins already watched. */
export function pickCoins(listed, sqdBusy, ownBusy, watched, max) {
  const score = (m) => Math.max(sqdBusy[m] || 0, ownBusy.get(m) || 0);
  return [...listed].filter((m) => score(m) > 0 || watched.has(m))
    .sort((a, b) => score(b) - score(a) || (watched.has(b) ? 1 : 0) - (watched.has(a) ? 1 : 0) || (a < b ? -1 : 1))
    .slice(0, max);
}

/** Each coin's trades heard by this service within the window. */
export class Busy {
  constructor() { this.times = new Map(); }
  add(mint, at) { if (!this.times.has(mint)) this.times.set(mint, []); this.times.get(mint).push(at); }
  counts(now = Date.now()) {
    const out = new Map();
    for (const [m, ts] of this.times) { const keep = ts.filter((t) => t > now - BUSY_WINDOW_MS); if (keep.length) { this.times.set(m, keep); out.set(m, keep.length); } else this.times.delete(m); }
    return out;
  }
}

// ------------------------------------------------------------------ trades heard before confirmation
export const CONFIRM_AFTER_MS = 20_000;      // a trade heard at "processed" is asked about this long after (inside the node's recent-status window)
export const GIVE_UP_MS = 120_000;           // still not confirmed this long after: looked up in the chain's history once, then removed
/** Every trade this feed writes was heard at "processed", before its block was confirmed. CONFIRM_AFTER_MS later its
 *  signature is asked about (getSignatureStatuses, 256 at a time, on the public node): confirmed or finalized keeps it; a
 *  failed one, or one the chain still does not show after GIVE_UP_MS (its block was abandoned), is removed from the coin's
 *  file. A node that does not answer leaves them to the next look, never removed on a guess. */
export class Confirmer {
  constructor(rpc, now = () => Date.now()) { this.rpc = rpc; this.now = now; this.pending = new Map(); this.dropped = 0; this.asking = false; this.handed = new Map(); }
  add(mint, sig, heard) { if (!this.pending.has(sig)) this.pending.set(sig, { mint, heard }); }
  async check(store) {
    if (this.asking) return; this.asking = true;
    try {
      const due = [...this.pending].filter(([, v]) => this.now() - v.heard >= CONFIRM_AFTER_MS).slice(0, 2048);
      for (let k = 0; k < due.length; k += 256) {
        const part = due.slice(k, k + 256);
        let r; try { r = await this.rpc("getSignatureStatuses", [part.map(([s]) => s), { searchTransactionHistory: false }]); } catch { return; }
        const vals = r?.value; if (!Array.isArray(vals) || vals.length !== part.length) return;
        const lookAgain = [];
        part.forEach(([s, v], j) => {
          const st = vals[j];
          if (st && st.err) { this.drop(store, v.mint, s); return; }
          if (st && (st.confirmationStatus === "confirmed" || st.confirmationStatus === "finalized")) { this.pending.delete(s); return; }
          if (this.now() - v.heard >= GIVE_UP_MS) lookAgain.push([s, v]);      // not confirmed yet, or not shown: once more, in history
        });
        if (!lookAgain.length) continue;
        let h; try { h = await this.rpc("getSignatureStatuses", [lookAgain.map(([s]) => s), { searchTransactionHistory: true }]); } catch { return; }
        const hv = h?.value; if (!Array.isArray(hv) || hv.length !== lookAgain.length) return;
        lookAgain.forEach(([s, v], j) => {
          const st = hv[j];
          if (st && !st.err && (st.confirmationStatus === "confirmed" || st.confirmationStatus === "finalized")) this.pending.delete(s);
          else this.drop(store, v.mint, s);                                    // failed, or never confirmed: its block was abandoned
        });
      }
    } finally { this.asking = false; }
  }
  /** Removed here while this feed writes the coin; a coin already handed to SQD (one writer a coin) is listed in
   *  UNCONFIRMED for SQD to remove it from its own copy, and removed here too if the coin comes back first. */
  drop(store, mint, sig) {
    this.pending.delete(sig);
    if (store.forget(mint, sig)) { this.dropped++; return; }
    if (!store.coins.has(mint)) { this.handed.set(sig, { mint, at: this.now() }); this.dropped++; }
  }
  applyHanded(store) {
    for (const [sig, v] of [...this.handed]) {
      if (this.now() - v.at > HANDED_KEEP_MS) { this.handed.delete(sig); continue; }
      if (store.coins.has(v.mint)) store.forget(v.mint, sig);
    }
  }
}

// ------------------------------------------------------------------ the service
export async function main({ WebSocketImpl = globalThis.WebSocket, fetchFn = fetch, env = readEnv(), settingsPath = SETTINGS, store = new TickStore(),
                             statePath = STATE, statusPath = LOGS_STATUS, sqdStatusPath = SQD_STATUS, unconfirmedPath = UNCONFIRMED, log = say, pusher = null, prices = new QuoteUsd(),
                             rpc = httpRpc(PUBLIC_NODE.http, fetchFn), listed = () => listedCoins(fetchFn), refreshMs = 30_000, flushMs = 250, now = () => Date.now() } = {}) {
  const s = logsSettings(settingsPath);
  if (s.trades_logs !== "on") { log(`trades_logs is not on${s.why ? ": " + s.why : ""}: nothing opened`); return null; }
  const url = logsNode(env, s.trades_logs_node), fallback = s.trades_logs_fallback === "none" ? null : logsNode(env, s.trades_logs_fallback);
  if (!url) { log(`no key for ${s.trades_logs_node} in the engine's .env: nothing opened`); return null; }
  const nodeOf = (k) => (k.onFallback ? s.trades_logs_fallback : s.trades_logs_node);
  const over = () => BILLED.has(s.trades_logs_node) && budget.over();   // the day's share guards a billing node's allowance only
  let saved = {}; try { saved = JSON.parse(readFileSync(statePath, "utf8")); } catch {}
  const budget = new Budget(s.trades_logs_daily_mb, saved.budget || {});
  const look = new Lookups(rpc, saved.lookups || {}), busy = new Busy(), push = pusher || new Pusher(fetchFn), confirm = new Confirmer(rpc, now);
  const sockets = [];                                            // {ws, open, coins: Set, bySub: Map(sub -> mint), byId: Map(id -> mint), subOf: Map(mint -> sub)}
  let stopped = false, note = null, nextId = 1;
  const timers = [];
  const live = (k) => k.open && now() - (k.heard || 0) < SILENT_MS;   // open and heard from lately
  const watchedNow = () => sockets.flatMap((k) => (live(k) ? [...k.subOf.keys()] : []));
  const status = () => {
    mkdirSync(dirname(statusPath), { recursive: true }); budget.roll();
    const body = { contract: "logs-status-1", as_of: new Date().toISOString(), node: s.trades_logs_node, nodes: sockets.map(nodeOf), sockets: sockets.filter((k) => k.open).length,
                   watched: watchedNow(), pushed: push.sent, push_failed: push.failed, dropped_unconfirmed: confirm.dropped, quotes: [...prices.seen],
                   bytes_today: budget.bytes, messages_today: budget.msgs, budget_mb: s.trades_logs_daily_mb, day: budget.day, note };
    writeFileSync(statusPath + ".tmp", JSON.stringify(body)); renameSync(statusPath + ".tmp", statusPath);
    confirm.applyHanded(store);
    try { writeFileSync(unconfirmedPath + ".tmp", JSON.stringify({ contract: "unconfirmed-1", as_of: new Date(now()).toISOString(), trades: [...confirm.handed].map(([sig, v]) => ({ mint: v.mint, sig, at: v.at })) }));
          renameSync(unconfirmedPath + ".tmp", unconfirmedPath); } catch {}
    try { writeFileSync(statePath, JSON.stringify({ budget: budget.state(), lookups: look.state() })); } catch {}
  };
  const send = (k, m) => { try { k.ws.send(JSON.stringify(m)); } catch {} };
  const queue = [];                                              // [socket, coin] waiting to be asked for, SUBS_PER_S a second
  const subscribe = (k, mint) => { k.coins.add(mint); queue.push([k, mint]); };
  const drain = () => {
    while (queue.length) {
      const [k, mint] = queue.shift();
      if (!k.open || !k.coins.has(mint) || k.subOf.has(mint) || [...k.byId.values()].includes(mint)) continue;
      const id = nextId++; k.byId.set(id, mint); send(k, { jsonrpc: "2.0", id, method: "logsSubscribe", params: [{ mentions: [mint] }, { commitment: "processed" }] });
      return;
    }
  };
  const unsubscribe = (k, mint) => { const sub = k.subOf.get(mint); k.coins.delete(mint); k.subOf.delete(mint); if (sub !== undefined) { k.bySub.delete(sub); send(k, { jsonrpc: "2.0", id: nextId++, method: "logsUnsubscribe", params: [sub] }); } store.release([mint]); };
  const handle = async (mint, value, slot, seen) => {
    let got = [];
    try { got = await ticksOf(value, slot, mint, look, seen); } catch { got = []; }
    for (const g of got) {
      if (g.graduated) store.graduated(mint, g.graduated);
      if (g.tick) { busy.add(mint, seen); if (store.add(mint, prices.stamp(g.tick), g.tick.i)) { push.add(mint, g.tick); confirm.add(mint, g.tick.sig, seen);
        const smp = { coin: mint, t: g.tick.t, side: g.tick.side, sol: g.tick.sol, sig: g.tick.sig };   // where the trade crosses
        W.meter("s_ws|live trades|a_trades|live trades", 1, smp); W.meter("a_trades|trades|p_trades|trades", 1, smp); W.meter("a_trades|trades|p_chart|own ticks", 1, smp); } }
    }
  };
  const open = (k) => {
    if (stopped || over()) return;
    if (k.onFallback && now() >= k.primaryAt) { k.onFallback = false; k.strikes = 0; }        // the main node tried again
    const ws = new WebSocketImpl(k.onFallback ? fallback : url); k.ws = ws; k.open = false; k.idle = false; k.bySub.clear(); k.byId.clear(); k.subOf.clear();
    k.openedAt = now();
    ws.onopen = () => { k.open = true; k.back = 1000; k.heard = now(); const want = [...k.coins]; k.coins.clear(); for (const m of want) subscribe(k, m); status(); };   // every coin given it while it opened
    ws.onmessage = (e) => {
      const text = typeof e.data === "string" ? e.data : String(e.data); k.heard = now();
      if (BILLED.has(nodeOf(k)) && !budget.add(text.length)) { note = "the day's share is used: every subscription closed, SQD carries the coins"; closeAll(); status(); return; }
      let d; try { d = JSON.parse(text); } catch { return; }
      if (d.id !== undefined && k.byId.has(d.id)) {
        const mint = k.byId.get(d.id); k.byId.delete(d.id);
        if (typeof d.result === "number" && k.coins.has(mint)) { k.subOf.set(mint, d.result); k.bySub.set(d.result, mint); }
        return;
      }
      if (d.method !== "logsNotification") return;
      const mint = k.bySub.get(d.params?.subscription); if (!mint) return;
      handle(mint, d.params.result?.value, d.params.result?.context?.slot, Date.now());
    };
    ws.onclose = () => {
      const was = k.open; k.open = false;
      store.release(new Set([...k.subOf.keys(), ...k.coins]));    // SQD writes them until this socket is back: counted afresh then
      if (!k.silenced && now() - (k.openedAt || 0) < SHORT_MS) strike(k, "dropped soon after opening");
      k.silenced = false;
      for (const m of k.subOf.keys()) k.coins.add(m);              // asked for again when it opens
      if (was) status();
      if (!stopped && !over()) { k.back = Math.min(60_000, (k.back || 1000) * 2); timers.push(setTimeout(() => open(k), k.back)); }
      else k.idle = true;                                          // opened again by the next refresh with room in the day's share
    };
    ws.onerror = () => {};
  };
  /** A main-node socket that fails STRIKES times moves to the fallback node (the public one) for FALLBACK_MS. */
  const strike = (k, why) => {
    if (k.onFallback || !fallback) return;
    k.strikes = (k.strikes || 0) + 1;
    if (k.strikes >= STRIKES) { k.onFallback = true; k.primaryAt = now() + FALLBACK_MS; k.strikes = 0; note = `${s.trades_logs_node} ${why} twice: a socket moved to ${s.trades_logs_fallback} for ${FALLBACK_MS / 60_000} min`; }
  };
  const closeAll = () => { for (const k of sockets) { k.open = false; k.idle = true; k.coins.clear(); k.subOf.clear(); k.bySub.clear(); try { k.ws?.close(1000, "share used"); } catch {} } };
  const refresh = async () => {
    if (stopped) return;
    if (over()) { status(); return; }
    note = null;
    const got = await listed(); if (!got) return;               // the feed not answering: keep what is watched
    let sqdBusy = {}; try { sqdBusy = JSON.parse(readFileSync(sqdStatusPath, "utf8")).busy || {}; } catch {}
    const watched = new Set(sockets.flatMap((k) => [...k.coins]));
    const want = new Set(pickCoins(got, sqdBusy, busy.counts(), watched, s.trades_logs_max_coins));
    for (const k of sockets) for (const m of [...k.coins]) if (!want.has(m)) unsubscribe(k, m);
    for (const m of want) {
      if (sockets.some((k) => k.coins.has(m))) continue;
      let k = sockets.find((x) => x.coins.size < PER_SOCKET);
      if (!k && sockets.length < MAX_SOCKETS) { k = { coins: new Set(), bySub: new Map(), byId: new Map(), subOf: new Map(), back: 1000 }; sockets.push(k); k.coins.add(m); open(k); continue; }
      if (!k) break;
      if (k.open) subscribe(k, m); else k.coins.add(m);
    }
    for (const k of sockets) if (k.idle && k.coins.size) open(k);   // a new day after the share was used
    status();
  };
  /** A socket open but silent past SILENT_MS (a stalled connection does not always close): closed, so it opens again. */
  const watchdog = () => {
    for (const k of sockets) if (k.open && k.coins.size && now() - (k.heard || 0) >= SILENT_MS) {
      note = "a socket was silent: opened again (SQD carried its coins meanwhile)";
      strike(k, "silent"); k.silenced = true;
      try { k.ws.close(4000, "silent"); } catch {}
    }
    status();
  };
  const stop = () => { stopped = true; for (const t of timers) { clearTimeout(t); clearInterval(t); } for (const k of sockets) try { k.ws?.close(1000, "stop"); } catch {} };
  await refresh();
  timers.push(setInterval(refresh, refreshMs));
  timers.push(setInterval(() => store.flush(), flushMs));
  timers.push(setInterval(watchdog, 5_000));
  timers.push(setInterval(drain, 1000 / SUBS_PER_S));
  timers.push(setInterval(() => confirm.check(store), 10_000));
  log(`logs feed on ${s.trades_logs_node}: ${watchedNow().length} coins asked for`);
  return { stop, sockets, status, refresh, store, budget, watchdog, confirm, drain };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  W.name("wslogs");                                          // this service's wire meters
  const h = await main();
  if (!h) process.exit(0);
  const end = () => { h.status(); h.store.flush(); h.stop(); process.exit(0); };
  process.on("SIGTERM", end); process.on("SIGINT", end);
}
