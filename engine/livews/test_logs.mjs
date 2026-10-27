// a design decision step 2's logs feed (livews/logs.mjs, livews/idl.mjs): plain-English cases, offline, on a real sample read
// 2026-10-25 (tools/profiles/2026-10-25-logs-sample.json: Helius logs notifications, the public node's answers to the reads
// they needed, and SQD Portal's ticks for the same signatures; public chain data) and on bytes built from the published
// IDLs. A made-up websocket and node; temporary folders; no network.   Run:  node livews/test_logs.mjs
import { readFileSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Idl, IDL_PATHS } from "./idl.mjs";
import { b58decode } from "./b58.mjs";
import { eventsOf, ticksOf, Lookups, pickCoins, Busy, main, logsSettings, logsNode, PUMP_AMM, LAUNCHLAB, WSOL, BUSY_WINDOW_MS, SILENT_MS, Confirmer, CONFIRM_AFTER_MS, GIVE_UP_MS, FALLBACK_MS } from "./logs.mjs";
import { TickStore } from "./trades.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const SAMPLE = JSON.parse(readFileSync(join(HERE, "..", "tools", "profiles", "2026-10-25-logs-sample.json"), "utf8"));
const results = [];
async function kase(n, title, should, fn) {
  let ok, said;
  try { [ok, said] = await fn(); } catch (e) { ok = false; said = `CRASH ${e.name}: ${e.message}`; }
  results.push(ok);
  console.log(`\n${String(n).padStart(2)}. ${title}\n    should: ${should}\n    did:    ${said}\n    ${ok ? "PASS" : "FAIL"}`);
}
const tmp = () => mkdtempSync(join(tmpdir(), "pinr-logs-"));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const sampleRpc = (calls = []) => async (method, params) => { calls.push(params[0]); const k = `${method} ${params[0]} ${params[1].encoding}`; if (!(k in SAMPLE.reads)) throw new Error("not in the sample"); return SAMPLE.reads[k]; };

/** Borsh bytes for one IDL type, from values (the test's own writer, the mirror of Idl.read). */
function encode(idl, t, v) {
  const w = (n, fn, x) => { const b = Buffer.alloc(n); b[fn](x, 0); return b; };
  if (typeof t === "string") {
    if (t === "u8") return w(1, "writeUInt8", v); if (t === "u16") return w(2, "writeUInt16LE", v); if (t === "u32") return w(4, "writeUInt32LE", v);
    if (t === "u64") return w(8, "writeBigUInt64LE", BigInt(v)); if (t === "i64") return w(8, "writeBigInt64LE", BigInt(v));
    if (t === "u128" || t === "i128") { let x = BigInt(v); if (x < 0n) x += 1n << 128n; const b = Buffer.alloc(16); for (let k = 0; k < 16; k++) { b[k] = Number(x & 255n); x >>= 8n; } return b; }
    if (t === "bool") return Buffer.from([v ? 1 : 0]); if (t === "pubkey") return b58decode(v);
    if (t === "string") { const s = Buffer.from(v, "utf8"); return Buffer.concat([w(4, "writeUInt32LE", s.length), s]); }
  }
  if (t.vec) return Buffer.concat([w(4, "writeUInt32LE", v.length), ...v.map((x) => encode(idl, t.vec, x))]);
  if (t.array) return Buffer.concat(v.map((x) => encode(idl, t.array[0], x)));
  if (t.defined) { const spec = idl.types[t.defined.name ?? t.defined]; if (spec.kind === "enum") return Buffer.from([spec.variants.findIndex((x) => x.name === v)]); return struct(idl, spec, v); }
  throw new Error("cannot encode " + JSON.stringify(t));
}
const zero = (idl, t) => typeof t === "string" ? (t === "pubkey" ? "11111111111111111111111111111111" : t === "bool" ? false : t === "string" ? "" : 0)
  : t.vec ? [] : t.array ? Array(t.array[1]).fill(zero(idl, t.array[0])) : idl.types[t.defined.name ?? t.defined].kind === "enum" ? idl.types[t.defined.name ?? t.defined].variants[0].name : {};
const struct = (idl, spec, v) => Buffer.concat(spec.fields.map((f) => encode(idl, f.type, v[f.name] ?? zero(idl, f.type))));
const eventBytes = (idl, name, v) => { const tag = [...idl.events].find(([, n]) => n === name)[0]; return Buffer.concat([Buffer.from(tag, "hex"), struct(idl, idl.types[name], v)]); };
const accountBytes = (idl, name, v) => Buffer.concat([Buffer.from(idl.accounts.get(name), "hex"), struct(idl, idl.types[name], v)]);
const logsOf = (program, bufs) => [`Program ${program} invoke [1]`, ...bufs.map((b) => "Program data: " + b.toString("base64")), `Program ${program} success`];

await kase(1, "The real sample: every tick the logs give is SQD's tick for the same trade", "decoded with the published IDLs and the sample's chain reads, each tick with a matching SQD tick (same sig:i) has the same time, side, size, quote, amount and price", async () => {
  const look = new Lookups(sampleRpc());
  const keys = ["t", "side", "tokens", "quote", "sol", "price_sol", "quote_amount", "price_quote", "t_is_receipt"];
  const close = (a, b) => a === b || (typeof a === "number" && typeof b === "number" && Math.abs(a - b) <= 1e-9 * Math.max(Math.abs(a), Math.abs(b)));
  let same = 0, differ = [], made = 0, venues = new Set();
  for (const n of SAMPLE.notes) {
    for (const g of await ticksOf(n.value, n.slot, n.mint, look, 1)) {
      if (!g.tick) continue; made++; venues.add(g.tick.quote === WSOL ? "SOL" : "other quote");
      const s = SAMPLE.sqd.find((x) => x.mint === n.mint && x.tick.sig === g.tick.sig && x.tick.i === g.tick.i)?.tick;
      if (!s) continue;
      const bad = keys.filter((k) => !close(g.tick[k], s[k])); bad.length ? differ.push(bad) : same++;
    }
  }
  return [same >= 16 && differ.length === 0 && made >= 24, `${made} ticks from ${SAMPLE.notes.length} notifications (${[...venues].join(", ")}); ${same} matched SQD's exactly, ${differ.length} differed`];
});

await kase(2, "The IDL reader: fields in the IDL's order; a shorter, older event keeps only what its bytes hold", "a PumpSwap BuyEvent written from the IDL reads back field for field; cut after `timestamp` it has that field and none after", () => {
  const idl = new Idl(IDL_PATHS.pump_amm), POOL = "EMbzSTpktXndowjqE31PF5EYUmTnfkx9getTRjzd1fvv";
  const b = eventBytes(idl, "BuyEvent", { timestamp: 1792900000, base_amount_out: 123456789, quote_amount_in: 2_000_000_000, pool: POOL, virtual_quote_reserves: -5, ix_name: "buy" });
  const [name, f] = idl.event(b), [, short] = idl.event(b.subarray(0, 16));
  return [name === "BuyEvent" && f.timestamp === 1792900000 && f.base_amount_out === 123456789 && f.pool === POOL && f.virtual_quote_reserves === -5 && f.ix_name === "buy"
          && short.timestamp === 1792900000 && !("base_amount_out" in short) && idl.event(Buffer.alloc(16)) === null,
    `read back: ${name}, base ${f.base_amount_out}, pool ${f.pool.slice(0, 6)}…, i128 ${f.virtual_quote_reserves}; cut short: ${Object.keys(short).join(", ")}; an unknown tag: nothing`];
});

await kase(3, "A pool or decimals the chain does not show gives no tick, never a guessed one; another coin's pool is not this coin's", "PumpSwap trades whose pool cannot be read, belongs to another coin, or whose coin's decimals cannot be read give nothing; a pool is read once however many trades ask at once", async () => {
  const idl = new Idl(IDL_PATHS.pump_amm), POOL = "EMbzSTpktXndowjqE31PF5EYUmTnfkx9getTRjzd1fvv";
  const n = SAMPLE.notes.find((x) => x.value.logs.some((l) => l.startsWith(`Program ${PUMP_AMM} invoke`)));
  const none = new Lookups(async () => { throw new Error("down"); });
  const downTicks = await ticksOf(n.value, n.slot, n.mint, none, 1);
  const calls = [], look = new Lookups(sampleRpc(calls));
  const other = await ticksOf(n.value, n.slot, "So11111111111111111111111111111111111111112", look, 1);
  await Promise.all([1, 2, 3].map(() => ticksOf(n.value, n.slot, n.mint, look, 1)));
  const poolReads = calls.filter((c) => SAMPLE.reads[`getAccountInfo ${c} base64`]).length;
  const nodec = new Lookups(async (m, p) => (p[1].encoding === "jsonParsed" ? { value: null } : SAMPLE.reads[`getAccountInfo ${p[0]} base64`]));
  const noDecTicks = (await ticksOf(n.value, n.slot, n.mint, nodec, 1)).filter((g) => g.tick);
  return [downTicks.length === 0 && other.length === 0 && poolReads === 1 && noDecTicks.length === 0,
    `node down: ${downTicks.length} ticks; asked as another coin: ${other.length}; three trades at once: the pool read ${poolReads} time; the coin's decimals unreadable: ${noDecTicks.length} ticks`];
});

await kase(4, "LaunchLab: a sell from its own TradeEvent and the pool's own decimals", "a LaunchLab sell for this coin becomes a sell tick sized and priced from the event and the pool account (the same arithmetic as SQD's); a failed transaction gives nothing", async () => {
  const idl = new Idl(IDL_PATHS.launchlab), MINT = "9hKLTgwbsZ1VdsGhDPv7MiY1xR6sdPaTTq6tEDWVpump", POOL = "AFaYrFH7hUYnkv5mbvbnRHwX29M9JzUL3ySGtQz69AUv";
  const pool = accountBytes(idl, "PoolState", { base_decimals: 6, quote_decimals: 9, base_mint: MINT, quote_mint: WSOL });
  const rpc = async (m, p) => (p[0] === POOL ? { value: { owner: LAUNCHLAB, data: [pool.toString("base64"), "base64"] } } : { value: null });
  const ev = eventBytes(idl, "TradeEvent", { pool_state: POOL, virtual_base: 1_073_000_000_000_000, virtual_quote: 30_000_000_000, real_base_after: 200_000_000_000_000, real_quote_after: 5_000_000_000,
                                              amount_in: 1_000_000_000, amount_out: 40_000_000, trade_direction: "Sell" });
  const value = { signature: "SigLaunchLab", err: null, logs: logsOf(LAUNCHLAB, [ev]) };
  const [g] = await ticksOf(value, 9, MINT, new Lookups(rpc), 1_792_900_000_000), failed = await ticksOf({ ...value, err: { x: 1 } }, 9, MINT, new Lookups(rpc), 1);
  const price = (35_000_000_000 / 1e9) / (873_000_000_000_000 / 1e6);
  return [g.tick.side === "sell" && g.tick.tokens === 1000 && g.tick.sol === 0.04 && Math.abs(g.tick.price_sol - price) < 1e-18 && g.tick.t_is_receipt === true && g.tick.t === 1_792_900_000_000 && failed.length === 0,
    `${g.tick.side} ${g.tick.tokens} for ${g.tick.sol} SOL at ${g.tick.price_sol.toExponential(3)} (heard time, LaunchLab's event has none); a failed transaction: ${failed.length} ticks`];
});

await kase(5, "The busiest listed coins first", "listed coins ranked by trades in the last 10 minutes (SQD's count or this feed's own), only coins that traded or are already watched, at most the share; an unlisted coin never", () => {
  const listed = new Set(["A", "B", "C", "D", "E"]), sqd = { A: 3, B: 50, Z: 999 }, own = new Map([["C", 20]]), watched = new Set(["D"]);
  const got = pickCoins(listed, sqd, own, watched, 3), all = pickCoins(listed, sqd, own, watched, 10);
  const b = new Busy(); b.add("X", 1000); b.add("X", 2000 + BUSY_WINDOW_MS); const c = b.counts(2500 + BUSY_WINDOW_MS);
  return [got.join() === "B,C,A" && all.join() === "B,C,A,D" && c.get("X") === 1,
    `3 at most: ${got.join(", ")}; no limit: ${all.join(", ")} (E never traded, Z not listed); a trade past the window no longer counts: ${c.get("X")}`];
});

class FakeWS {
  static all = [];
  constructor(url) { this.url = url; this.sent = []; FakeWS.all.push(this); setTimeout(() => this.onopen?.(), 0); }
  send(s) { this.sent.push(JSON.parse(s)); }
  close(code) { this.closed = code ?? 1000; setTimeout(() => this.onclose?.({ code: this.closed }), 0); }
  emit(obj) { return this.onmessage?.({ data: JSON.stringify(obj) }); }
}

await kase(6, "The service end to end: subscribe the busiest coins, write and push their ticks, name them for SQD, never print the key", "one logsSubscribe (processed) per picked coin; a notification becomes ticks in the coin's file and in the push; the status names the watched coins; the log never holds the key", async () => {
  FakeWS.all = [];
  const d = tmp(), ticks = join(d, "ticks"), lines = [], pushed = [];
  const n = SAMPLE.notes.find((x) => SAMPLE.sqd.some((s) => s.tick.sig === x.value.signature));
  const sp = join(d, "settings.json"); writeFileSync(sp, JSON.stringify({ trades_logs: "on", trades_logs_max_coins: 2 }));
  const sq = join(d, "sqd.json"); writeFileSync(sq, JSON.stringify({ busy: { [n.mint]: 40, Quiet: 1, Other: 9 } }));
  const pusher = { sent: 0, failed: 0, add: (m, t) => pushed.push([m, t.sig]) };
  const prices = { seen: new Set(), stamp: (t) => t };
  const h = await main({ WebSocketImpl: FakeWS, env: { HELIUS_OFFICIAL_KEY: "made-up-secret-key" }, settingsPath: sp, store: new TickStore(ticks), statePath: join(d, "st.json"),
                         statusPath: join(ticks, "_logs_status.json"), unconfirmedPath: join(d, "unconfirmed.json"), sqdStatusPath: sq, log: (l) => lines.push(l), pusher, prices, rpc: sampleRpc(),
                         listed: async () => new Set([n.mint, "Quiet", "Other"]), refreshMs: 1e9, flushMs: 20 });
  await wait(20); for (let i = 0; i < 10; i++) h.drain();
  const ws = FakeWS.all[0], subs = ws.sent.filter((m) => m.method === "logsSubscribe");
  for (const m of subs) await ws.emit({ jsonrpc: "2.0", id: m.id, result: 500 + m.id });
  const mine = subs.find((m) => m.params[0].mentions[0] === n.mint);
  await ws.emit({ jsonrpc: "2.0", method: "logsNotification", params: { subscription: 500 + mine.id, result: { context: { slot: n.slot }, value: n.value } } });
  await wait(60); h.status();
  const file = JSON.parse(readFileSync(join(ticks, n.mint + ".json"), "utf8")), st = JSON.parse(readFileSync(join(ticks, "_logs_status.json"), "utf8"));
  h.stop();
  const keyless = !lines.join("\n").includes("made-up-secret-key") && !JSON.stringify(st).includes("made-up-secret-key");
  return [subs.length === 2 && subs.every((m) => m.params[1].commitment === "processed") && subs.map((m) => m.params[0].mentions[0]).sort().join() === [n.mint, "Other"].sort().join()
          && file.ticks.some((t) => t.sig === n.value.signature) && pushed.some(([m, s]) => m === n.mint && s === n.value.signature)
          && st.watched.sort().join() === [n.mint, "Other"].sort().join() && keyless && ws.url.includes("helius-rpc.com"),
    `subscribed ${subs.length} (the two busiest of three, at processed); the notification wrote ${file.ticks.length} tick(s) and pushed ${pushed.length}; status watches ${st.watched.length}; key printed: ${!keyless}`];
});

await kase(7, "Past the day's share every subscription closes and SQD takes the coins back", "once the day's bytes pass the share the sockets close, the status names no coins and says why, nothing is asked again that day, and the next day the coins are asked for again", async () => {
  FakeWS.all = [];
  const d = tmp(), ticks = join(d, "ticks");
  const sp = join(d, "settings.json"); writeFileSync(sp, JSON.stringify({ trades_logs: "on", trades_logs_daily_mb: 0.0001 }));
  const h = await main({ WebSocketImpl: FakeWS, env: { HELIUS_OFFICIAL_KEY: "k" }, settingsPath: sp, store: new TickStore(ticks), statePath: join(d, "st.json"), statusPath: join(ticks, "_logs_status.json"), unconfirmedPath: join(d, "unconfirmed.json"),
                         sqdStatusPath: (writeFileSync(join(d, "sqd.json"), JSON.stringify({ busy: { CoinA: 5 } })), join(d, "sqd.json")), log: () => {}, pusher: { sent: 0, failed: 0, add() {} }, prices: { seen: new Set(), stamp: (t) => t }, rpc: sampleRpc(),
                         listed: async () => new Set(["CoinA"]), refreshMs: 1e9, flushMs: 1e9 });
  h.sockets.length || (await h.refresh());
  await wait(20); for (let i = 0; i < 10; i++) h.drain(); for (let i = 0; i < 10; i++) h.drain();
  const ws = FakeWS.all[0], sub = ws?.sent.find((m) => m.method === "logsSubscribe");
  await ws.emit({ jsonrpc: "2.0", id: sub.id, result: 7 });
  await ws.emit({ jsonrpc: "2.0", method: "logsNotification", params: { subscription: 7, result: { context: { slot: 1 }, value: { signature: "x".repeat(200), err: null, logs: ["y".repeat(300)] } } } });
  await wait(30); await h.refresh();
  const st = JSON.parse(readFileSync(join(ticks, "_logs_status.json"), "utf8")), sameDay = FakeWS.all.length;
  h.budget.day = "2000-01-01"; await h.refresh(); await wait(20); for (let i = 0; i < 10; i++) h.drain();              // the next day: the share is whole again
  const next = FakeWS.all[1], again = next?.sent.some((m) => m.method === "logsSubscribe" && m.params[0].mentions[0] === "CoinA");
  h.stop();
  return [ws.closed === 1000 && st.watched.length === 0 && /share/.test(st.note || "") && sameDay === 1 && again,
    `socket closed: ${ws.closed}; watched now ${st.watched.length}; note "${st.note}"; opened again that day: ${sameDay - 1}; the next day the coin is asked for again: ${again}`];
});

await kase(8, "Settings and the node: off unless on, and only the operator's official key or the public node", "off by default or with a bad share; helius_official needs its key; the public node needs none", () => {
  const d = tmp(), p = join(d, "s.json");
  writeFileSync(p, "{}"); const off = logsSettings(p);
  writeFileSync(p, JSON.stringify({ trades_logs: "on", trades_logs_daily_mb: -1 })); const bad = logsSettings(p);
  writeFileSync(p, JSON.stringify({ trades_logs: "on", trades_logs_node: "other" })); const node = logsSettings(p);
  return [off.trades_logs === "off" && bad.trades_logs === "off" && node.trades_logs === "off" && logsNode({}, "helius_official") === null && logsNode({}, "public").startsWith("wss://api.mainnet-beta"),
    `default ${off.trades_logs}; a negative share: ${bad.why}; another node: ${node.why}; no key: ${logsNode({}, "helius_official")}`];
});

await kase(9, "A socket that goes silent without closing gives its coins back", "subscriptions confirmed, then nothing heard: past the silence line the status names none of its coins (SQD writes them) and the socket is closed and opened again, asking for them anew", async () => {
  FakeWS.all = [];
  const d = tmp(), ticks = join(d, "ticks"); let clock = 1_000_000;
  const sp = join(d, "settings.json"); writeFileSync(sp, JSON.stringify({ trades_logs: "on" }));
  const sq = join(d, "sqd.json"); writeFileSync(sq, JSON.stringify({ busy: { CoinA: 9, CoinB: 4 } }));
  const h = await main({ WebSocketImpl: FakeWS, env: { HELIUS_OFFICIAL_KEY: "k" }, settingsPath: sp, store: new TickStore(ticks), statePath: join(d, "st.json"), statusPath: join(ticks, "_logs_status.json"), unconfirmedPath: join(d, "unconfirmed.json"),
                         sqdStatusPath: sq, log: () => {}, pusher: { sent: 0, failed: 0, add() {} }, prices: { seen: new Set(), stamp: (t) => t }, rpc: sampleRpc(),
                         listed: async () => new Set(["CoinA", "CoinB"]), refreshMs: 1e9, flushMs: 1e9, now: () => clock });
  await wait(20); for (let i = 0; i < 10; i++) h.drain();
  const ws = FakeWS.all[0];
  for (const m of ws.sent.filter((x) => x.method === "logsSubscribe")) await ws.emit({ jsonrpc: "2.0", id: m.id, result: 900 + m.id });
  h.status(); const before = JSON.parse(readFileSync(join(ticks, "_logs_status.json"), "utf8")).watched.length;
  clock += SILENT_MS + 1; h.watchdog();
  const after = JSON.parse(readFileSync(join(ticks, "_logs_status.json"), "utf8"));
  await wait(2200); for (let i = 0; i < 10; i++) h.drain();                // the reconnect waits a moment
  const again = FakeWS.all[1]?.sent.filter((x) => x.method === "logsSubscribe").length;
  h.stop();
  return [before === 2 && after.watched.length === 0 && ws.closed === 4000 && again === 2 && /silent/.test(after.note || ""),
    `named before: ${before}; after ${SILENT_MS / 1000} s of silence: ${after.watched.length} (note "${after.note}"); socket closed (${ws.closed}) and opened again asking for ${again} coins`];
});

await kase(10, "A trade heard before its block was confirmed stays only if the chain confirms it", "confirmed or finalized: kept; failed: removed; not shown even in the chain's history two minutes on (an abandoned block): removed, with its candle taken down; still processing: asked again; the node not answering: nothing removed", async () => {
  const d = tmp(), store = new TickStore(d), M = "CoinW", t0 = 1_792_900_200_000;
  const tk = (sig, ms, side) => ({ t: t0 + ms, sig, i: 0, side, tokens: 1, sol: 1, price_sol: 2, quote: WSOL });
  for (const [sig, ms, side] of [["ok", 1000, "buy"], ["failed", 2000, "buy"], ["gone", 3000, "sell"], ["slow", 4000, "buy"]]) store.add(M, tk(sig, ms, side), 0);
  let clock = 0, down = false; const asked = [];
  const answers = { ok: { confirmationStatus: "confirmed", err: null }, failed: { confirmationStatus: "confirmed", err: { InstructionError: [0, "x"] } }, gone: null, slow: { confirmationStatus: "processed", err: null } };
  const rpc = async (m, [sigs, o]) => { if (down) throw new Error("down"); asked.push(o.searchTransactionHistory); return { value: sigs.map((x) => answers[x]) }; };
  const c = new Confirmer(rpc, () => clock);
  for (const sig of ["ok", "failed", "gone", "slow"]) c.add(M, sig, 0);
  clock = CONFIRM_AFTER_MS; await c.check(store);
  const after1 = store.coins.get(M).ticks.map((t) => t.sig).join();
  down = true; clock = GIVE_UP_MS; await c.check(store); const whileDown = store.coins.get(M).ticks.length;
  down = false; answers.slow = { confirmationStatus: "finalized", err: null }; await c.check(store);
  store.flush(); const f = JSON.parse(readFileSync(join(d, M + ".json"), "utf8")), k = f.candles_5m[0];
  return [after1 === "ok,gone,slow" && whileDown === 3 && f.ticks.map((t) => t.sig).join() === "ok,slow" && c.dropped === 2 && c.pending.size === 0 && k.v === 2 && k.buys === 2 && k.sells === 0 && asked.includes(true),
    `after 20 s: ${after1} (the failed one removed); the node down at 2 min: ${whileDown} kept; then: ${f.ticks.map((t) => t.sig).join()} (the abandoned one removed, looked up in history first); candle volume ${k.v}, buys ${k.buys}, sells ${k.sells}`];
});

await kase(11, "OrbitFlare first, the public node when it fails, and subscriptions paced", "the socket opens on OrbitFlare's address from the .env (https made wss); coins are asked for one a tick, never all at once; a socket silent twice moves to the public node, and after ten minutes goes back to OrbitFlare; the key is in neither the log nor the status", async () => {
  FakeWS.all = [];
  const d = tmp(), ticks = join(d, "ticks"), lines = []; let clock = 5_000_000;
  const sp = join(d, "settings.json"); writeFileSync(sp, JSON.stringify({ trades_logs: "on", trades_logs_node: "orbitflare" }));
  const coins = Array.from({ length: 6 }, (_, i) => "Coin" + i), sq = join(d, "sqd.json");
  writeFileSync(sq, JSON.stringify({ busy: Object.fromEntries(coins.map((m, i) => [m, 10 - i])) }));
  const h = await main({ WebSocketImpl: FakeWS, env: { ORBITFLARE_SOLANA_URL: "https://slc.example.test?api_key=made-up-of-key" }, settingsPath: sp, store: new TickStore(ticks),
                         statePath: join(d, "st.json"), statusPath: join(ticks, "_logs_status.json"), unconfirmedPath: join(d, "unconfirmed.json"), sqdStatusPath: sq, log: (l) => lines.push(l), pusher: { sent: 0, failed: 0, add() {} },
                         prices: { seen: new Set(), stamp: (t) => t }, rpc: sampleRpc(), listed: async () => new Set(coins), refreshMs: 1e9, flushMs: 1e9, now: () => clock });
  await wait(20);
  const first = FakeWS.all[0], subsAt = () => first.sent.filter((m) => m.method === "logsSubscribe").length;
  h.drain(); const one = subsAt(); for (let i = 0; i < 10; i++) h.drain(); const all = subsAt();
  const silence = async () => { clock += 91_000; h.watchdog(); await wait(2200); };
  await silence(); const second = FakeWS.all[1]?.url; await silence(); const third = FakeWS.all[2]?.url;
  clock += FALLBACK_MS; await silence(); await silence(); const back = FakeWS.all.at(-1)?.url;
  h.status(); const st = readFileSync(join(ticks, "_logs_status.json"), "utf8"); h.stop();
  const keyless = !lines.join("\n").includes("made-up-of-key") && !st.includes("made-up-of-key");
  return [first.url === "wss://slc.example.test?api_key=made-up-of-key" && one === 1 && all === 6 && second === first.url && third.startsWith("wss://api.mainnet-beta") && back === first.url && keyless,
    `opened on OrbitFlare (wss); asked for ${one} coin on the first tick, ${all} after ten; silent once: OrbitFlare again; twice: ${third.split("/")[2]}; ten minutes on: OrbitFlare again; key printed: ${!keyless}`];
});

await kase(12, "An unconfirmed trade of a coin already handed back is not lost", "the coin released, its failed trade is listed for SQD (the coin's writer now) instead of dropped; if the coin comes back to this feed first, the trade is removed here", async () => {
  const d = tmp(), store = new TickStore(d), M = "CoinF", t0 = 1_792_900_200_000;
  store.add(M, { t: t0, sig: "bad", i: 0, side: "buy", tokens: 1, sol: 1, price_sol: 2, quote: WSOL }, 0); store.flush();
  store.release([M]);                                                       // a silent socket: SQD writes the coin now
  let clock = 0; const c = new Confirmer(async (m, [sigs]) => ({ value: sigs.map(() => ({ confirmationStatus: "confirmed", err: { x: 1 } })) }), () => clock);
  c.add(M, "bad", 0); clock = CONFIRM_AFTER_MS; await c.check(store);
  const listed = [...c.handed.keys()], stillInFile = JSON.parse(readFileSync(join(d, M + ".json"), "utf8")).ticks.length;
  store.coin(M); c.applyHanded(store); store.flush();                      // the coin back with this feed before SQD removed it
  const after = JSON.parse(readFileSync(join(d, M + ".json"), "utf8")).ticks.length;
  return [listed.join() === "bad" && stillInFile === 1 && after === 0 && c.pending.size === 0,
    `listed for SQD: ${listed.join() || "nothing"} (the file still holds ${stillInFile}, SQD removes it); the coin back here first: ${after} left in the file`];
});

await kase(13, "The day's share meters a billing node only", "on the public node (free) a share of a few bytes never closes anything; the same share on the operator's Helius key closes every socket; a billing node is never taken as the fallback (it would stop and restart in a loop)", async () => {
  const run = async (settings, env) => {
    FakeWS.all = [];
    const d = tmp(), ticks = join(d, "ticks"), sp = join(d, "settings.json"); writeFileSync(sp, JSON.stringify(settings));
    const sq = join(d, "sqd.json"); writeFileSync(sq, JSON.stringify({ busy: { CoinA: 5 } }));
    const h = await main({ WebSocketImpl: FakeWS, env, settingsPath: sp, store: new TickStore(ticks), statePath: join(d, "st.json"), statusPath: join(ticks, "_logs_status.json"),
                           unconfirmedPath: join(d, "unconfirmed.json"), sqdStatusPath: sq, log: () => {}, pusher: { sent: 0, failed: 0, add() {} }, prices: { seen: new Set(), stamp: (t) => t },
                           rpc: sampleRpc(), listed: async () => new Set(["CoinA"]), refreshMs: 1e9, flushMs: 1e9 });
    await wait(20); for (let i = 0; i < 5; i++) h.drain();
    const ws = FakeWS.all[0], sub = ws.sent.find((m) => m.method === "logsSubscribe");
    await ws.emit({ jsonrpc: "2.0", id: sub.id, result: 3 });
    await ws.emit({ jsonrpc: "2.0", method: "logsNotification", params: { subscription: 3, result: { context: { slot: 1 }, value: { signature: "s".repeat(88), err: null, logs: ["x".repeat(400)] } } } });
    await wait(20); const closed = ws.closed; h.stop(); return closed;
  };
  const free = await run({ trades_logs: "on", trades_logs_node: "public", trades_logs_daily_mb: 0.0001 }, {});
  const billed = await run({ trades_logs: "on", trades_logs_node: "helius_official", trades_logs_daily_mb: 0.0001 }, { HELIUS_OFFICIAL_KEY: "k" });
  const d = tmp(), sp = join(d, "s.json"); writeFileSync(sp, JSON.stringify({ trades_logs: "on", trades_logs_node: "orbitflare", trades_logs_fallback: "helius_official" }));
  const fb = logsSettings(sp).trades_logs_fallback;
  return [free === undefined && billed === 1000 && fb === "none", `public node past the share: ${free === undefined ? "still open" : "closed"}; Helius past the share: ${billed === 1000 ? "closed" : "open"}; Helius as the fallback: refused (${fb})`];
});

console.log(`\n${results.filter(Boolean).length}/${results.length} passed`);
process.exit(results.every(Boolean) ? 0 : 1);
