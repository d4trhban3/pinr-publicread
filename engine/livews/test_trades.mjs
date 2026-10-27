// the design's websocket trades (livews/): plain-English cases, offline, on the real sample read 2026-10-21
// (tools/profiles/2026-10-21-ws-sample.json, public chain data) and on bytes built from the programs' published layouts.
// A made-up websocket and a made-up node; temporary folders; no network.   Run:  node livews/test_trades.mjs
import { readFileSync, mkdtempSync, writeFileSync, readdirSync, existsSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { eventsFromLogs, pumpTick, pumpComplete, launchlabTick, launchlabPool, PROGRAMS, WSOL } from "./decode.mjs";
import { b58decode } from "./b58.mjs";
import { selectCoins, TickStore, Budget, settings, nodeUrls, main, step, curveFor, FeedIndex, CANDLE_MS, KEEP_TICKS, pageCoins, loadPage, PAGE_URL, PAGE_EVERY_MS, PUBLIC_NODE, PUBLIC_RETRY_MS, bills, raydiumPool, SKIP_RETRY_MS, routedFeed, Pusher, PUSH_URL, QuoteUsd, PRICE_STALE_MS, HOUR_MS } from "./trades.mjs";
import { pumpCurveAddress, launchlabPoolAddress, pumpCurveState, launchlabPoolState, tradeBetween, onCurve } from "./curve.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const SAMPLE = JSON.parse(readFileSync(join(HERE, "..", "tools", "profiles", "2026-10-21-ws-sample.json"), "utf8"));
const results = [];
async function kase(n, title, should, fn) {
  let ok, said;
  try { [ok, said] = await fn(); } catch (e) { ok = false; said = `CRASH ${e.name}: ${e.message}`; }
  results.push(ok);
  console.log(`\n${String(n).padStart(2)}. ${title}\n    should: ${should}\n    did:    ${said}\n    ${ok ? "PASS" : "FAIL"}`);
}
const tmp = () => mkdtempSync(join(tmpdir(), "pinr-ws-"));
const pumpTrades = () => SAMPLE.pumpfun.flatMap((n) => eventsFromLogs(n.logs, n.err).filter((e) => e.kind === "trade").map((e) => ({ n, e })));

await kase(1, "The real sample decodes: Pump.fun trades and creations, LaunchLab trades; failed transactions give nothing",
  "18 Pump.fun trades (14 in SOL, 4 in another coin) and 3 creations from the kept notifications; 2 LaunchLab trades; the 2 failed ones nothing", () => {
    const pf = SAMPLE.pumpfun.flatMap((n) => eventsFromLogs(n.logs, n.err));
    const kinds = pf.reduce((a, e) => ({ ...a, [e.kind]: (a[e.kind] || 0) + 1 }), {});
    const sol = pumpTrades().filter(({ e }) => e.event.sol_amount > 0n).length;
    const failed = SAMPLE.pumpfun.filter((n) => n.err).map((n) => eventsFromLogs(n.logs, n.err).length);
    const ll = SAMPLE.launchlab.flatMap((n) => eventsFromLogs(n.logs, n.err));
    return [kinds.trade === 18 && kinds.create === 3 && sol === 14 && failed.every((x) => x === 0) && ll.length === 2 && ll.every((e) => e.program === "launchlab"),
      `Pump.fun ${JSON.stringify(kinds)} (${sol} in SOL); failed ones: ${failed.join(", ")} events; LaunchLab ${ll.length} (${ll.map((e) => e.event.trade_direction).join(", ")})`];
  });

await kase(2, "Buy or sell agrees with the transaction's own instruction", "every trade in a transaction with one Buy or one Sell instruction carries that side", () => {
  let agree = 0, total = 0;
  for (const { n, e } of pumpTrades()) {
    const ins = n.logs.filter((l) => l.startsWith("Program log: Instruction: ")).map((l) => l.split(": ")[2]);
    const b = ins.includes("Buy") || ins.includes("BuyExactSolIn"), s = ins.includes("Sell");
    if (b === s) continue;
    total++; agree += e.event.is_buy === b;
  }
  return [total > 0 && agree === total, `${agree} of ${total}`];
});

await kase(3, "A SOL trade's tick: side, amounts and the price after the trade from the curve's own reserves",
  "price = virtual SOL / virtual tokens (9 and 6 decimals), between the trade's own average and the reserves before", () => {
    const { n, e } = pumpTrades().find(({ e }) => e.event.sol_amount > 0n && e.event.is_buy);
    const t = pumpTick(e.event, e.event.mint, n.signature, n.slot);
    const want = (Number(e.event.virtual_sol_reserves) / 1e9) / (Number(e.event.virtual_token_reserves) / 1e6);
    const avg = t.sol / t.tokens;
    return [t.side === "buy" && t.quote === WSOL && Math.abs(t.price_sol - want) < 1e-18 && t.price_sol >= avg * 0.95 && t.t === Number(e.event.timestamp) * 1000 && pumpTick(e.event, "SomeOtherMint", n.signature, n.slot) === null,
      `buy ${t.sol} SOL for ${t.tokens.toFixed(2)} tokens (average ${avg.toExponential(4)}), price after ${t.price_sol.toExponential(4)} SOL; another coin's event gives no tick`];
  });

await kase(4, "A curve priced in another coin: the quote coin named, raw units, no price invented",
  "sol_amount 0 and a quote mint that is not SOL: the tick names the quote mint and its raw amount, no SOL price", () => {
    const hits = pumpTrades().filter(({ e }) => e.event.sol_amount === 0n);
    const ts = hits.map(({ n, e }) => pumpTick(e.event, e.event.mint, n.signature, n.slot));
    return [hits.length === 4 && ts.every((t) => t && t.quote !== WSOL && t.price_sol === undefined && typeof t.quote_raw === "number"),
      `${hits.length} such trades: quote ${[...new Set(ts.map((t) => t?.quote.slice(0, 6)))].join(", ")}.., raw amounts ${ts.map((t) => t?.quote_raw).join(", ")}; no SOL price`];
  });

await kase(5, "A graduation event (CompleteEvent, built from the published layout) decodes", "the mint, the curve and the time read back", () => {
  const mint = pumpTrades()[0].e.event.mint, pk = (x) => b58decode(x);
  const body = Buffer.concat([Buffer.from("5f72619cd42e9808", "hex"), pk(PROGRAMS.pumpfun), pk(mint), pk(PROGRAMS.launchlab), Buffer.from(new BigInt64Array([1792551300n]).buffer), pk(WSOL)]);
  const ev = pumpComplete(body);
  return [ev.mint === mint && ev.bonding_curve === PROGRAMS.launchlab && ev.timestamp === 1792551300n && ev.quote_mint === WSOL, `mint ${ev.mint.slice(0, 6)}.., time ${ev.timestamp}, quote ${ev.quote_mint.slice(0, 6)}..`];
});

const llEvent = () => { const n = SAMPLE.launchlab[0]; return { n, e: eventsFromLogs(n.logs, n.err)[0].event }; };
function poolBytes(baseMint, quoteMint, bd = 6, qd = 9) { const raw = Buffer.alloc(400); raw[17] = 0; raw[18] = bd; raw[19] = qd; b58decode(baseMint).copy(raw, 205); b58decode(quoteMint).copy(raw, 237); return raw; }
const MINT_LL = "4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R";
await kase(6, "A LaunchLab trade's tick needs its pool's own record", "with the pool record: side, amounts and price at the mints' own decimals; no record or a pool of another coin: no tick", () => {
  const { n, e } = llEvent();
  const pool = launchlabPool(poolBytes(MINT_LL, WSOL));
  const t = launchlabTick(e, MINT_LL, n.signature, n.slot, 1234, pool);
  const vb = Number(e.virtual_base) - Number(e.real_base_after), vq = Number(e.virtual_quote) + Number(e.real_quote_after);
  const none = launchlabTick(e, MINT_LL, n.signature, n.slot, 1234, null), other = launchlabTick(e, "SomeOtherMint", n.signature, n.slot, 1234, pool);
  return [t && t.t === 1234 && t.t_is_receipt && Math.abs(t.price_sol - (vq / 1e9) / (vb / 1e6)) < 1e-18 && none === null && other === null && pool.base_decimals === 6,
    `${t.side} ${t.sol} SOL / ${t.tokens} tokens, price ${t.price_sol.toExponential(4)}; without the record: ${none}; another coin's pool: ${other}`];
});

await kase(7, "A LaunchLab pool priced in another coin keeps its own unit", "quote amount and price in the quote coin, never called SOL", () => {
  const { n, e } = llEvent();
  const usdc = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
  const t = launchlabTick(e, MINT_LL, n.signature, n.slot, 1, launchlabPool(poolBytes(MINT_LL, usdc, 6, 6)));
  return [t.quote === usdc && t.sol === undefined && t.price_sol === undefined && typeof t.price_quote === "number", `quote ${t.quote.slice(0, 6)}.., amount ${t.quote_amount}, price ${t.price_quote}`];
});

function feed(dir, files) { for (const [name, body, ageS] of files) { const p = join(dir, name + ".json"); writeFileSync(p, JSON.stringify(body)); const t = Date.now() / 1000 - ageS; utimesSync(p, t, t); } }
await kase(8, "Which coins are watched: shown curve coins, scored first, newest first, at most the setting",
  "graduated and other coins left out; scored before seen-only; newest first; the status files and trigger-seen.json ignored", () => {
    const d = tmp();
    feed(d, [["A", { mint: "A", launchpad: "Pump.fun curve", as_of: "2026-10-21T02:00:00Z" }, 50], ["B", { mint: "B", launchpad: "Pump.fun curve", as_of: "2026-10-21T02:30:00Z" }, 40],
             ["C", { mint: "C", launchpad: "PumpSwap (graduated)", as_of: "2026-10-21T02:40:00Z" }, 30], ["D", { mint: "D", seen: true, launchpad: "Pump.fun curve", seen_at: "2026-10-21T02:50:00Z" }, 20],
             ["E", { mint: "E", launchpad: "LaunchLab curve (StonkFun (reward mode))", as_of: "2026-10-21T01:00:00Z" }, 60], ["_status", { mint: "X", launchpad: "Pump.fun curve" }, 1],
             ["trigger-seen", { coins: {} }, 1]]);
    const all = selectCoins(d, 10).map((c) => c.mint + ":" + c.kind), two = selectCoins(d, 2).map((c) => c.mint);
    return [JSON.stringify(all) === JSON.stringify(["B:pumpfun", "A:pumpfun", "E:launchlab", "D:pumpfun"]) && JSON.stringify(two) === JSON.stringify(["B", "A"]), `${all.join(", ")}; at most 2: ${two.join(", ")}`];
  });

await kase(9, "Only the newest feed files are read, never the whole folder", "a curve coin outside the newest `scan` files is not read", () => {
  const d = tmp();
  feed(d, [["old", { mint: "old", launchpad: "Pump.fun curve", as_of: "2026-10-21T00:00:00Z" }, 900], ["new1", { mint: "new1", launchpad: "Pump.fun curve", as_of: "2026-10-21T02:00:00Z" }, 10], ["new2", { mint: "new2", launchpad: "Pump.fun curve", as_of: "2026-10-21T02:01:00Z" }, 5]]);
  const got = selectCoins(d, 10, 2).map((c) => c.mint);
  return [!got.includes("old") && got.length === 2, `with a scan of the 2 newest files: ${got.join(", ")}`];
});

await kase(10, "Ticks and 5-minute candles: each trade once, open/high/low/close, volume, buys and sells", "the same signature and index twice counts once; candles by 5 minutes", () => {
  const s = new TickStore(tmp()), t0 = 1792551000000 - (1792551000000 % CANDLE_MS);
  const tk = (sig, dt, side, p, sol) => ({ t: t0 + dt, sig, side, tokens: 1, sol, price_sol: p, quote: WSOL });
  s.add("M", tk("a", 1000, "buy", 2, 1)); s.add("M", tk("a", 1000, "buy", 2, 1)); s.add("M", tk("b", 2000, "sell", 1, 0.5)); s.add("M", tk("c", 3000, "buy", 3, 2)); s.add("M", tk("d", CANDLE_MS + 10, "buy", 4, 1));
  s.flush();
  const f = JSON.parse(readFileSync(join(s.dir, "M.json"), "utf8")), k = f.candles_5m;
  return [f.ticks.length === 4 && k.length === 2 && k[0].o === 2 && k[0].h === 3 && k[0].l === 1 && k[0].c === 3 && k[0].v === 3.5 && k[0].buys === 2 && k[0].sells === 1 && k[1].o === 4 && f.source === "Solana chain" && f.contract === "ticks-1",
    `${f.ticks.length} ticks; first candle o ${k[0].o} h ${k[0].h} l ${k[0].l} c ${k[0].c} v ${k[0].v} buys ${k[0].buys} sells ${k[0].sells}; second opens ${k[1].o}`];
});

await kase(11, "Files written whole; the store keeps at most the newest ticks", `a coin's file appears by a rename, no .tmp left; at most ${KEEP_TICKS} ticks`, () => {
  const s = new TickStore(tmp());
  for (let i = 0; i < KEEP_TICKS + 30; i++) s.add("N", { t: 1e12 + i, sig: "s" + i, side: "buy", tokens: 1, sol: 1, price_sol: 1, quote: WSOL });
  s.flush();
  const f = JSON.parse(readFileSync(join(s.dir, "N.json"), "utf8"));
  return [f.ticks.length === KEEP_TICKS && f.ticks[0].sig === "s30" && !readdirSync(s.dir).some((x) => x.endsWith(".tmp")), `${f.ticks.length} ticks kept, oldest ${f.ticks[0].sig}; temporary files left: none`];
});

await kase(12, "The day's byte share", "past the share the meter says stop; a new UTC day starts at zero", () => {
  const b = new Budget(1), day1 = Date.parse("2026-10-21T10:00:00Z"), day2 = Date.parse("2026-10-22T00:00:01Z");
  const under = b.add(600_000, day1), over = b.add(500_000, day1), isOver = b.over(day1), fresh = b.add(10, day2);
  return [under && !over && isOver && fresh && b.bytes === 10, `600 KB fits 1 MB: ${under}; +500 KB: ${over} (over: ${isOver}); next day: ${fresh}, ${b.bytes} bytes`];
});

function curveBytes({ vtok, vquote, rtok = 0, rquote = 0, complete = 0, quote = null }) {
  const b = Buffer.alloc(150);
  b.writeBigUInt64LE(BigInt(vtok), 8); b.writeBigUInt64LE(BigInt(vquote), 16); b.writeBigUInt64LE(BigInt(rtok), 24); b.writeBigUInt64LE(BigInt(rquote), 32);
  b[48] = complete; if (quote) b58decode(quote).copy(b, 83);
  return b;
}
await kase(13, "The curve account: its address and its state", "the bonding-curve address equals the engine's Python derivation; the state reads the reserves, the flag and the quote coin (zero bytes: SOL)", () => {
  const a = pumpCurveAddress("CADGrfKKVkK1cE3cR9bWrLBTpg6tuGhC6Xyy3gfLpump");
  const st = pumpCurveState(curveBytes({ vtok: 800_000_000_000_000, vquote: 40_000_000_000 })), other = pumpCurveState(curveBytes({ vtok: 1, vquote: 1, quote: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v" }));
  return [a === "9Le61uFq7HVz8cxPi7MhkYnFvZu6Y5czX5kmWPqByZvr" && !onCurve(b58decode(a)) && st.quote === WSOL && st.vquote === 40_000_000_000 && !st.complete && other.quote.startsWith("EPjF") && other.quote_decimals === null && launchlabPoolAddress("CADGrfKKVkK1cE3cR9bWrLBTpg6tuGhC6Xyy3gfLpump"),
    `curve address ${a.slice(0, 8)}.. (the engine's stage2/b58.py gives the same, 2026-10-21); SOL curve read; a curve in another coin names it and has no decimals`];
});

await kase(14, "A trade from two states of the curve", "a buy raises the quote reserve: side, SOL paid, tokens out, price after; a sell the other way; no move, no tick; another quote coin: raw units, no price", () => {
  const s0 = pumpCurveState(curveBytes({ vtok: 1_000_000_000_000_000, vquote: 30_000_000_000 }));
  const s1 = pumpCurveState(curveBytes({ vtok: 990_000_000_000_000, vquote: 30_303_030_303 }));
  const b = tradeBetween(s0, s1, 5, 7), sl = tradeBetween(s1, s0, 6, 8), none = tradeBetween(s0, s0, 1, 1);
  const q0 = pumpCurveState(curveBytes({ vtok: 1e15, vquote: 5e9, quote: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v" })), q1 = pumpCurveState(curveBytes({ vtok: 9e14, vquote: 6e9, quote: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v" }));
  const q = tradeBetween(q0, q1, 1, 1);
  return [b.side === "buy" && Math.abs(b.sol - 0.303030303) < 1e-9 && b.tokens === 10_000_000 && Math.abs(b.price_sol - 30.303030303 / 990_000_000) < 1e-15 && b.merged_possible
          && sl.side === "sell" && none === null && q.quote_raw === 1e9 && q.price_sol === undefined && q.sol === undefined,
    `buy ${b.sol.toFixed(9)} SOL for ${b.tokens} tokens at ${b.price_sol.toExponential(4)}; reverse: ${sl.side}; no move: ${none}; in another coin: ${q.quote_raw} raw, no price`];
});

await kase(20, "A graduated curve, a foreign owner, a LaunchLab pool of another coin", "the flag ends the coin's ticks; an account the program does not own is ignored; a pool naming another coin is not watched", async () => {
  const curve = { owner: PROGRAMS.pumpfun, read: pumpCurveState };
  const s0 = pumpCurveState(curveBytes({ vtok: 1e15, vquote: 3e10 }));
  const g = step(s0, curveBytes({ vtok: 2e14, vquote: 8.5e10, complete: 1 }), PROGRAMS.pumpfun, curve, 99, 1);
  const f = step(s0, curveBytes({ vtok: 9e14, vquote: 4e10 }), "AnotherProgramAddress111111111111111111111", curve, 99, 1);
  const pool = Buffer.alloc(400); pool[18] = 6; pool[19] = 9; b58decode("AnotherMintAddress1111111111111111111111111").copy(pool, 205); b58decode(WSOL).copy(pool, 237);
  const none = await curveFor({ mint: "CADGrfKKVkK1cE3cR9bWrLBTpg6tuGhC6Xyy3gfLpump", kind: "launchlab" }, async () => ({ value: { owner: PROGRAMS.launchlab, data: [pool.toString("base64"), "base64"] } }), async () => null);
  const pf = await curveFor({ mint: "CADGrfKKVkK1cE3cR9bWrLBTpg6tuGhC6Xyy3gfLpump", kind: "pumpfun" }, async () => null);
  return [g.graduated === 99 && g.tick?.side === "buy" && f.state === s0 && !f.tick && none === null && pf.address.startsWith("9Le61u"),
    `graduated at ${g.graduated} (its last buy kept); a foreign owner: ignored; a LaunchLab pool naming another coin: ${none}; a Pump.fun coin's curve: ${pf.address.slice(0, 6)}..`];
});

await kase(15, "Settings: off unless on; unusable figures keep it off; the node's address only from the .env", "no setting: off; a bad coin count or byte share: off with the reason; helius from its key", () => {
  const d = tmp(), w = (o) => { const p = join(d, Math.random() + ".json"); writeFileSync(p, JSON.stringify(o)); return p; };
  const a = settings(w({})), b = settings(w({ trades_ws: "on", trades_ws_max_coins: 0 })), c = settings(w({ trades_ws: "on", trades_ws_daily_mb: 9999 })), ok = settings(w({ trades_ws: "on" }));
  const u = nodeUrls({ HELIUS_API_KEY: "made-up-key" }, "helius"), none = nodeUrls({}, "helius");
  return [a.trades_ws === "off" && b.trades_ws === "off" && /max_coins/.test(b.why) && c.trades_ws === "off" && ok.trades_ws === "on" && ok.trades_ws_max_coins === 40 && ok.trades_ws_daily_msgs === 60000 && ok.trades_ws_node === "public" && ok.trades_ws_overflow === "chainstack" && u.wss.startsWith("wss://mainnet.helius-rpc.com/") && none === null,
    `no setting: ${a.trades_ws}; 0 coins: ${b.trades_ws} (${b.why}); 9999 MB: ${c.trades_ws}; on: ${ok.trades_ws_max_coins} coins, ${ok.trades_ws_daily_mb} MB and ${ok.trades_ws_daily_msgs} messages a day, ${ok.trades_ws_node} first with ${ok.trades_ws_overflow} as overflow; no key: ${none}`];
});

class FakeWS {
  static last = null;
  constructor(url) { this.url = url; this.sent = []; FakeWS.last = this; setTimeout(() => this.onopen?.(), 0); }
  send(s) { this.sent.push(JSON.parse(s)); }
  close(code) { this.closed = code ?? 1000; (this.codes ||= []).push(this.closed); setTimeout(() => this.onclose?.({ code: code ?? 1000 }), 0); }
  emit(obj) { return this.onmessage?.({ data: JSON.stringify(obj) }); }
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
await kase(16, "The service end to end on a made-up socket: subscribe each coin's curve, turn two states into a tick file, never print the key",
  "one accountSubscribe per watched coin on its curve address; the second state becomes a tick in the coin's file; the log never holds the key", async () => {
    const d = tmp(), ticks = join(d, "ticks"), lines = [], mint = "CADGrfKKVkK1cE3cR9bWrLBTpg6tuGhC6Xyy3gfLpump";
    feed(d, [[mint, { mint, launchpad: "Pump.fun curve", as_of: "2026-10-21T02:50:00Z" }, 5]]);
    const sp = join(d, "settings.json"); writeFileSync(sp, JSON.stringify({ trades_ws: "on", trades_ws_max_coins: 5, trades_ws_node: "helius" }));
    const store = new TickStore(ticks);
    const h = await main({ WebSocketImpl: FakeWS, fetchFn: async () => ({ ok: false, status: 500 }), env: { HELIUS_API_KEY: "made-up-secret-key" }, settingsPath: sp,
                           store, statePath: join(d, "state.json"), statusDir: ticks, feedDir: d, log: (l) => lines.push(l) });
    await wait(1100);
    const sub = FakeWS.last.sent.find((m) => m.method === "accountSubscribe");
    await FakeWS.last.emit({ jsonrpc: "2.0", id: sub.id, result: 77 });
    const note = (b, slot) => FakeWS.last.emit({ jsonrpc: "2.0", method: "accountNotification", params: { subscription: 77, result: { context: { slot }, value: { owner: PROGRAMS.pumpfun, data: [b.toString("base64"), "base64"] } } } });
    await note(curveBytes({ vtok: 1e15, vquote: 3e10 }), 1); await note(curveBytes({ vtok: 9.9e14, vquote: 3.0303e10 }), 2);
    store.flush(); h.stop(); await wait(10);
    const f = existsSync(join(ticks, mint + ".json")) && JSON.parse(readFileSync(join(ticks, mint + ".json"), "utf8"));
    return [sub.params[0] === pumpCurveAddress(mint) && sub.params[1].encoding === "base64" && f && f.ticks.length === 1 && f.ticks[0].side === "buy" && f.candles_5m.length === 1
            && !lines.join(" ").includes("made-up-secret-key") && FakeWS.last.url.includes("helius"),
      `subscribed the curve ${sub.params[0].slice(0, 6)}..; tick file with ${f && f.ticks.length} tick (${f && f.ticks[0].side}, ${f && f.ticks[0].sol} SOL) and ${f && f.candles_5m.length} candle; key in the log: ${lines.join(" ").includes("made-up-secret-key")}`];
  });

await kase(17, "Off means nothing is opened", "with trades_ws off, or no key for the node, no socket is made", async () => {
  const d = tmp(); FakeWS.last = null;
  const sp = join(d, "s.json"); writeFileSync(sp, JSON.stringify({ trades_ws: "off" }));
  const h1 = await main({ WebSocketImpl: FakeWS, env: { HELIUS_API_KEY: "k" }, settingsPath: sp, feedDir: d, statusDir: d, statePath: join(d, "st.json"), log: () => {} });
  writeFileSync(sp, JSON.stringify({ trades_ws: "on", trades_ws_node: "chainstack" }));   // a keyed node with no address here
  const h2 = await main({ WebSocketImpl: FakeWS, env: {}, settingsPath: sp, feedDir: d, statusDir: d, statePath: join(d, "st.json"), log: () => {} });
  return [h1 === null && h2 === null && FakeWS.last === null, `off: ${h1}; on with no key: ${h2}; sockets made: ${FakeWS.last ? 1 : 0}`];
});

await kase(18, "The day's byte share closes the socket", "a message past the share closes with the budget code; nothing more is decoded", async () => {
  const d = tmp(), lines = [];
  const sp = join(d, "s.json"); writeFileSync(sp, JSON.stringify({ trades_ws: "on", trades_ws_daily_mb: 0.0001, trades_ws_node: "helius" }));
  const h = await main({ WebSocketImpl: FakeWS, env: { HELIUS_API_KEY: "k" }, settingsPath: sp, feedDir: d, statusDir: d, statePath: join(d, "st.json"), log: (l) => lines.push(l) });
  await wait(10);
  await FakeWS.last.emit({ jsonrpc: "2.0", method: "logsNotification", params: { subscription: 1, result: { context: { slot: 1 }, value: { signature: "s", err: null, logs: ["x".repeat(200)] } } } });
  await wait(10); h.stop();
  return [FakeWS.last.codes?.[0] === 4000 && lines.some((l) => /day's share/.test(l)), `first close code ${FakeWS.last.codes?.[0]} (the budget's); log: ${lines.find((l) => /day's share/.test(l))}`];
});

await kase(19, "Subscriptions go out a few a second, and the day's message share closes the socket too",
  "40 coins: at most 4 subscribe requests in the first second; a share of 3 messages: the 4th closes with the budget code", async () => {
    const d = tmp(), lines = [];
    feed(d, Array.from({ length: 40 }, (_, i) => ["c" + i, { mint: "CADGrfKKVkK1cE3cR9bWrLBTpg6tuGhC6Xyy3gfL" + "abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMN"[i] + "pump", launchpad: "Pump.fun curve", as_of: "2026-10-21T02:00:00Z" }, i + 1]));
    const sp = join(d, "s.json"); writeFileSync(sp, JSON.stringify({ trades_ws: "on", trades_ws_max_coins: 40, trades_ws_daily_msgs: 3, trades_ws_node: "chainstack" }));
    const h = await main({ WebSocketImpl: FakeWS, env: { CHAINSTACK_SOLANA_URL: "https://made-up.example/key" }, settingsPath: sp, feedDir: d, statusDir: d, statePath: join(d, "st.json"), log: (l) => lines.push(l) });
    await wait(1100);
    const first = FakeWS.last.sent.filter((m) => m.method === "accountSubscribe").length, ws = FakeWS.last;
    for (let k = 0; k < 4; k++) await ws.emit({ jsonrpc: "2.0", method: "ping" });
    await wait(10); h.stop();
    return [first === 4 && ws.url.startsWith("wss://made-up.example") && ws.codes?.[0] === 4000, `first second: ${first} subscribe requests (of 40); the 4th message: close code ${ws.codes?.[0]}`];
  });

await kase(25, "Item 55: Solana's public websocket first, never metered", "with no keys at all the feed opens the public node; a share of 3 messages does not close it (it bills nothing); its messages are counted for the status only", async () => {
  const d = tmp(), lines = [];
  const sp = join(d, "s.json"); writeFileSync(sp, JSON.stringify({ trades_ws: "on", trades_ws_daily_msgs: 3 }));
  const h = await main({ WebSocketImpl: FakeWS, fetchFn: async () => ({ ok: false, status: 500 }), env: {}, settingsPath: sp, feedDir: d, statusDir: d, statePath: join(d, "st.json"), log: (l) => lines.push(l) });
  await wait(10);
  const ws = FakeWS.last;
  for (let k = 0; k < 6; k++) await ws.emit({ jsonrpc: "2.0", method: "ping" });
  const st = h.status(), closedBefore = ws.codes; await wait(10); h.stop();
  return [ws.url === PUBLIC_NODE.wss && !closedBefore && st.node === "public" && st.public_messages === 6 && st.messages === 0 && bills("public") === false && bills("chainstack") === true,
    `opened ${ws.url}; 6 messages past a share of 3: closed ${closedBefore ? "yes" : "no"}; counted ${st.public_messages} public, ${st.messages} against the share`];
});

await kase(26, "Item 55: the public node will not hold: the overflow node takes over, then the public node again", "three connections that held under the minimum in a row hand over to chainstack under its share; after the retry time the next connection is the public node again", async () => {
  const d = tmp(), lines = [], urls = [];
  const sp = join(d, "s.json"); writeFileSync(sp, JSON.stringify({ trades_ws: "on" }));
  class W extends FakeWS { constructor(u) { super(u); urls.push(u); } }
  const realNow = Date.now; let shift = 0; Date.now = () => realNow() + shift;
  try {
    const h = await main({ WebSocketImpl: W, fetchFn: async () => ({ ok: false, status: 500 }), env: { CHAINSTACK_SOLANA_URL: "https://made-up.example/key" }, settingsPath: sp, feedDir: d, statusDir: d, statePath: join(d, "st.json"), log: (l) => lines.push(l) });
    for (let k = 0; k < 3; k++) { await wait(20); FakeWS.last.close(1013); await wait(1100); }
    await wait(50);
    const over = FakeWS.last.url, st = h.status();
    shift = PUBLIC_RETRY_MS + 1000;
    FakeWS.last.close(1006); await wait(1100); await wait(50);
    const back = FakeWS.last.url;
    h.stop();
    return [urls.slice(0, 3).every((u) => u === PUBLIC_NODE.wss) && over.startsWith("wss://made-up.example") && st.node === "chainstack" && back === PUBLIC_NODE.wss && lines.some((l) => /takes over/.test(l)),
      `first three: ${urls.slice(0, 3).map((u) => (u === PUBLIC_NODE.wss ? "public" : "other")).join(", ")}; then ${over.startsWith("wss://made-up") ? "chainstack" : over}; after the retry time: ${back === PUBLIC_NODE.wss ? "public" : back}; log: '${lines.find((l) => /takes over/.test(l))}'`];
  } finally { Date.now = realNow; }
});

await kase(27, "Item 55: the overflow node's share used up, and the node settings", "the overflow closes at its share and the public node opens again at once; an unknown node keeps the feed off; an overflow equal to the node means none; overflow 'none' is allowed", async () => {
  const d = tmp(), lines = [];
  const sp = join(d, "s.json"); writeFileSync(sp, JSON.stringify({ trades_ws: "on", trades_ws_daily_msgs: 2 }));
  const realNow = Date.now; let shift = 0; Date.now = () => realNow() + shift;
  let backTo, codes;
  try {
    const h = await main({ WebSocketImpl: FakeWS, fetchFn: async () => ({ ok: false, status: 500 }), env: { CHAINSTACK_SOLANA_URL: "https://made-up.example/key" }, settingsPath: sp, feedDir: d, statusDir: d, statePath: join(d, "st.json"), log: (l) => lines.push(l) });
    for (let k = 0; k < 3; k++) { await wait(20); FakeWS.last.close(1013); await wait(1100); }
    await wait(50);
    const ws = FakeWS.last;
    for (let k = 0; k < 3; k++) await ws.emit({ jsonrpc: "2.0", method: "ping" });
    await wait(1200);
    codes = ws.codes; backTo = FakeWS.last.url;
    h.stop();
  } finally { Date.now = realNow; }
  const w = (o) => { const p = join(d, Math.random() + ".json"); writeFileSync(p, JSON.stringify(o)); return p; };
  const bad = settings(w({ trades_ws: "on", trades_ws_node: "instantnodes" })), same = settings(w({ trades_ws: "on", trades_ws_node: "chainstack", trades_ws_overflow: "chainstack" })), none = settings(w({ trades_ws: "on", trades_ws_overflow: "none" }));
  return [codes?.[0] === 4000 && backTo === PUBLIC_NODE.wss && bad.trades_ws === "off" && same.trades_ws === "on" && same.trades_ws_overflow === "none" && none.trades_ws === "on",
    `the overflow at its share: closed ${codes?.[0]}, then ${backTo === PUBLIC_NODE.wss ? "the public node" : backTo}; an unknown node: ${bad.trades_ws} (${bad.why}); overflow equal to the node: ${same.trades_ws}, overflow ${same.trades_ws_overflow}; overflow none: ${none.trades_ws}`];
});

await kase(28, "the team's F1 on item 55: the overflow hands back while its connection still holds", "with the overflow's connection open and healthy, its turn ends on time: that socket is closed and the next is the public node; a second turn gets its own full time", async () => {
  const d = tmp(), lines = [], urls = [];
  const sp = join(d, "s.json"); writeFileSync(sp, JSON.stringify({ trades_ws: "on" }));
  class W extends FakeWS { constructor(u) { super(u); urls.push(u); } }
  const h = await main({ WebSocketImpl: W, fetchFn: async () => ({ ok: false, status: 500 }), env: { CHAINSTACK_SOLANA_URL: "https://made-up.example/key" }, settingsPath: sp,
                         feedDir: d, statusDir: d, statePath: join(d, "st.json"), log: (l) => lines.push(l), retryMs: 3000 });
  for (let k = 0; k < 3; k++) { await wait(20); FakeWS.last.close(1013); await wait(1100); }
  await wait(50);
  const over = FakeWS.last, onOverflow = h.status().node;
  await wait(2200);                                           // the overflow's connection is never closed by the node: it holds
  const closedWith = over.codes?.[0];
  await wait(1200);
  const back = FakeWS.last.url, nodeNow = h.status().node;
  for (let k = 0; k < 3; k++) { await wait(20); FakeWS.last.close(1013); await wait(1100); }
  await wait(50);
  const second = FakeWS.last; await wait(800);
  const stillOpen = !second.codes;
  h.stop();
  return [onOverflow === "chainstack" && over.url.startsWith("wss://made-up.example") && closedWith === 4001 && back === PUBLIC_NODE.wss && nodeNow === "public"
          && second.url.startsWith("wss://made-up.example") && stillOpen && lines.some((l) => /turn is over/.test(l)),
    `on the overflow: ${onOverflow}; its healthy socket closed with ${closedWith} at its time; next socket: ${back === PUBLIC_NODE.wss ? "public" : back} (${nodeNow}); a second turn still open after half its time: ${stillOpen}`];
});

await kase(21, "The service's unit runs the server's own Node", "ExecStart names /usr/local/bin/node (where the server keeps it; the first install pointed at the Mac's ~/.local/node and failed 203/EXEC); no key in the unit", () => {
  const u = readFileSync(join(HERE, "..", "ops", "systemd", "pinr-trades.service"), "utf8");
  return [/^ExecStart=\/usr\/local\/bin\/node livews\/trades\.mjs$/m.test(u) && !/\.local\/node/.test(u.split("\n").filter((l) => !l.startsWith("#")).join("\n")) && !/api-key|api_key|HELIUS_API_KEY=/.test(u),
    u.split("\n").find((l) => l.startsWith("ExecStart"))];
});

await kase(22, "The feed index: one whole read, then the folder's own change events",
  "the newest files come from remembered times; a change event updates one file; asking again reads nothing whole", () => {
    const d = tmp();
    feed(d, [["a", { mint: "a" }, 300], ["b", { mint: "b" }, 200], ["c", { mint: "c" }, 100]]);
    let cb = null;
    const ix = new FeedIndex(d, { watchFn: (_dir, fn) => { cb = fn; return { close() {} }; } });
    const first = ix.newest(2);
    feed(d, [["a", { mint: "a" }, 1]]); cb("change", "a.json");      // a changes: one event, one stat
    const second = ix.newest(2), third = ix.newest(3);
    return [JSON.stringify(first) === JSON.stringify(["c.json", "b.json"]) && JSON.stringify(second) === JSON.stringify(["a.json", "c.json"]) && ix.fulls === 1 && ix.events === 1 && third.length === 3,
      `first ${first.join(", ")}; after a's change event ${second.join(", ")}; whole reads ${ix.fulls}, events ${ix.events}`];
  });

await kase(23, "A graduated coin is not subscribed again", "a coin whose tick file says graduated, while its feed file still says curve, gets no subscription", async () => {
  const d = tmp(), ticks = join(d, "ticks"), a = "CADGrfKKVkK1cE3cR9bWrLBTpg6tuGhC6Xyy3gfLpump", b = "CADGrfKKVkK1cE3cR9bWrLBTpg6tuGhC6Xyy3gfLbump";
  feed(d, [[a, { mint: a, launchpad: "Pump.fun curve", as_of: "2026-10-21T02:50:00Z" }, 5], [b, { mint: b, launchpad: "Pump.fun curve", as_of: "2026-10-21T02:49:00Z" }, 6]]);
  const store = new TickStore(ticks); store.graduated(a, 1792551300000); store.flush();
  const sp = join(d, "s.json"); writeFileSync(sp, JSON.stringify({ trades_ws: "on", trades_ws_node: "helius" }));
  const h = await main({ WebSocketImpl: FakeWS, env: { HELIUS_API_KEY: "k" }, settingsPath: sp, store: new TickStore(ticks), feedDir: d, statusDir: ticks, statePath: join(d, "st.json"), log: () => {} });
  await wait(1100);
  const subs = FakeWS.last.sent.filter((m) => m.method === "accountSubscribe").map((m) => m.params[0]);
  h.stop();
  return [subs.length === 1 && subs[0] === pumpCurveAddress(b), `subscribed ${subs.length}: ${subs.map((x) => x.slice(0, 6)).join(", ")} (the graduated coin's curve ${pumpCurveAddress(a).slice(0, 6)}.. not among them)`];
});

await kase(24, "One subscription batch at a time, however slow the node", "pool reads taking 1.5 s, longer than the 1 s timer: never two batches at once", async () => {
  const d = tmp(), ticks = join(d, "ticks");
  feed(d, Array.from({ length: 6 }, (_, i) => ["l" + i, { mint: "CADGrfKKVkK1cE3cR9bWrLBTpg6tuGhC6Xyy3gfL" + "abcdef"[i] + "pump", launchpad: "LaunchLab curve (StonkFun (reward mode))", as_of: "2026-10-21T02:00:00Z" }, i + 1]));
  const sp = join(d, "s.json"); writeFileSync(sp, JSON.stringify({ trades_ws: "on", trades_ws_node: "helius" }));
  let inFlight = 0, most = 0, calls = 0;
  const slow = async () => { inFlight++; calls++; most = Math.max(most, inFlight); await wait(1500); inFlight--; return { ok: true, json: async () => ({ result: { value: null } }) }; };
  const h = await main({ WebSocketImpl: FakeWS, fetchFn: slow, env: { HELIUS_API_KEY: "k" }, settingsPath: sp, store: new TickStore(ticks), feedDir: d, statusDir: ticks, statePath: join(d, "st.json"), log: () => {} });
  await wait(4200); h.stop(); await wait(1600);
  return [most === 1 && calls >= 2, `${calls} pool reads in 4 s, at most ${most} at once`];
});

await kase(25, "The coins the site's first page shows, in page order", "curve coins only, in the page's own order, each once, at most the setting; both answer shapes read", () => {
  const page = { tokens: [{ token: { address: "S1", launchpad: "Pump.fun curve" } }, { address: "G1", launchpad: "PumpSwap (graduated)" },
                          { address: "S2", launchpad: "LaunchLab curve (StonkFun (reward mode))" }, { address: "S1", launchpad: "Pump.fun curve" },
                          { address: "S3", launchpad: "Pump.fun curve" }, { address: "S4", launchpad: "Pump.fun curve" }, { launchpad: "Pump.fun curve" }] };
  const all = pageCoins(page, 10).map((c) => c.mint + ":" + c.kind), two = pageCoins(page, 2).map((c) => c.mint);
  const list = pageCoins([{ address: "L1", launchpad: "Pump.fun curve" }], 5).map((c) => c.mint);
  return [JSON.stringify(all) === JSON.stringify(["S1:pumpfun", "S2:launchlab", "S3:pumpfun", "S4:pumpfun"]) && JSON.stringify(two) === JSON.stringify(["S1", "S2"])
          && JSON.stringify(list) === JSON.stringify(["L1"]), `${all.join(", ")}; at most 2: ${two.join(", ")}; a plain list: ${list.join(", ")}`];
});

await kase(26, "Reading the page from the feed server on this machine", "its answer when it answers; nothing (the old rule stands in) when it refuses or fails; never throws", async () => {
  const urls = [];
  const ok = await loadPage(async (u) => { urls.push(u); return { ok: true, json: async () => ({ tokens: [] }) }; });
  const no = await loadPage(async () => ({ ok: false, status: 503 }));
  const boom = await loadPage(async () => { throw new Error("connection refused"); });
  return [JSON.stringify(ok) === JSON.stringify({ tokens: [] }) && no === null && boom === null && urls[0] === PAGE_URL && PAGE_URL.startsWith("http://127.0.0.1:8787/"),
          `answer read: ${!!ok}; refused: ${no}; failed: ${boom}; asked ${urls[0]}`];
});

await kase(27, "The service follows the page", "the first pick waits for the page; each minute's pick takes the page's coins first and the newest feed files only when there is no page; the page re-read every 30 s; the same number of subscriptions", () => {
  const src = readFileSync(new URL("./trades.mjs", import.meta.url), "utf8");
  const ok = src.includes("const fromPage = page ? pageCoins(page, room) : [];") && src.includes("(fromPage.length ? fromPage : selectCoins(feedDir, room, 1500, index))")
    && /await reloadPage\(\);[^\n]*\n\s*refresh\(\);/.test(src) && src.includes("setInterval(reloadPage, PAGE_EVERY_MS)") && PAGE_EVERY_MS === 30000
    && src.includes(".slice(0, s.trades_ws_max_coins);");
  return [ok, `page first, the old rule as fallback, the page loaded before the first pick and every 30 s, still at most trades_ws_max_coins: ${ok}`];
});

await kase(32, "the team 2026-10-23: a LaunchLab pool quoted in another coin, found through Raydium's record", "the SOL-quoted address first; when it is not this coin's pool, Raydium's own launch record names the pool, trusted only when LaunchLab owns it and it names this coin; no record or a pool naming another coin: not watched", async () => {
  const mint = "6zuNTjWjxVeAQaZyAxmoACXNrzQzcftqFE5p2sDhGoty", other = "9cS4tCzT3ERyiyRz83NMT7vhnaA9boxvdYfWUDBhjRZi";
  const mine = Buffer.alloc(400); mine[18] = 6; mine[19] = 6; b58decode(mint).copy(mine, 205); b58decode("58QyXQ1UDgHh64EiTsCeevVM9cLPqBDNf3qZE6EdfUhZ").copy(mine, 237);
  const asked = [];
  const rpc = async (_m, [addr]) => { asked.push(addr); return addr === other ? { value: { owner: PROGRAMS.launchlab, data: [mine.toString("base64"), "base64"] } } : { value: null }; };
  const found = await curveFor({ mint, kind: "launchlab" }, rpc, async (m) => (m === mint ? other : null));
  const noRecord = await curveFor({ mint, kind: "launchlab" }, rpc, async () => null);
  const wrong = await curveFor({ mint: "CADGrfKKVkK1cE3cR9bWrLBTpg6tuGhC6Xyy3gfLpump", kind: "launchlab" }, rpc, async () => other);
  const rec = await raydiumPool(mint, async () => ({ ok: true, json: async () => ({ data: { rows: [{ mint, poolId: other }] } }) }));
  const recNone = await raydiumPool(mint, async () => ({ ok: false }));
  return [found?.address === other && asked[0] !== other && noRecord === null && wrong === null && rec === other && recNone === null && SKIP_RETRY_MS === 15 * 60_000,
    `quoted in another coin: watched at Raydium's pool ${found?.address.slice(0, 6)}.. after the SOL address; no record: ${noRecord}; a pool naming another coin: ${wrong}; the record read: ${rec?.slice(0, 6)}.., unreadable: ${recNone}; a skipped coin asked again after ${SKIP_RETRY_MS / 60000} min`];
});

await kase(33, "The status shows today's day", "a new UTC day resets the counts in the status even when nothing was counted yet (the day no longer sticks on the last day with an overflow message)", () => {
  const b = new Budget(300, { day: "2026-10-22", bytes: 5, msgs: 60001 }, 60000);
  const before = b.over(Date.parse("2026-10-22T12:00:00Z"));
  b.roll(Date.parse("2026-10-23T00:00:05Z"));
  return [before && b.day === "2026-10-23" && b.msgs === 0 && b.bytes === 0 && !b.over(Date.parse("2026-10-23T00:00:06Z")), `yesterday over its share: ${before}; after midnight: day ${b.day}, ${b.msgs} messages`];
});

await kase(34, "the coin count from pinr.io/control's file", "a usable trades_ws_max_coins in the control file wins over the settings file; an unusable one, or no file, leaves the settings' own", () => {
  const d = tmp(), sp = join(d, "s.json"), cp = join(d, "c.json");
  writeFileSync(sp, JSON.stringify({ trades_ws: "on", trades_ws_max_coins: 150 }));
  const none = settings(sp, join(d, "missing.json")).trades_ws_max_coins;
  writeFileSync(cp, JSON.stringify({ trades_ws_max_coins: 300 }));
  const set = settings(sp, cp).trades_ws_max_coins;
  writeFileSync(cp, JSON.stringify({ trades_ws_max_coins: 5000 }));
  const bad = settings(sp, cp).trades_ws_max_coins;
  return [none === 150 && set === 300 && bad === 150, `no control file: ${none}; control says 300: ${set}; control says 5000 (unusable): ${bad}`];
});

await kase(35, "the team 2026-10-23: PublicNode's free node as the fallback", "a known node name with keyless addresses, never metered (no daily share), usable as the overflow behind the public node", () => {
  const u = nodeUrls({}, "publicnode");
  const d = tmp(), sp = join(d, "s.json");
  writeFileSync(sp, JSON.stringify({ trades_ws: "on", trades_ws_overflow: "publicnode" }));
  const s = settings(sp, join(d, "none.json"));
  return [u?.wss === "wss://solana-rpc.publicnode.com" && !bills("publicnode") && bills("chainstack") && s.trades_ws === "on" && s.trades_ws_overflow === "publicnode",
    `addresses ${u?.wss}; metered: ${bills("publicnode")}; as the overflow: ${s.trades_ws_overflow}`];
});

await kase(36, "243 phase 2: the trade_feed wire from /control's routing file", "a usable wire sets the first node, the overflow (or none) and the coin count over the settings and the control file; an unusable wire, or none, leaves them", () => {
  const d = tmp(), sp = join(d, "s.json"), cp = join(d, "c.json"), rp = join(d, "r.json");
  writeFileSync(sp, JSON.stringify({ trades_ws: "on", trades_ws_max_coins: 150 }));
  writeFileSync(cp, JSON.stringify({ trades_ws_max_coins: 300 }));
  const none = settings(sp, cp, join(d, "missing.json"));
  writeFileSync(rp, JSON.stringify({ version: 2, routing: { trade_feed: { nodes: ["publicnode", "chainstack"], coins: 500 } } }));
  const two = settings(sp, cp, rp);
  writeFileSync(rp, JSON.stringify({ version: 3, routing: { trade_feed: { nodes: ["public"], coins: 60 } } }));
  const one = settings(sp, cp, rp);
  writeFileSync(rp, JSON.stringify({ version: 4, routing: { trade_feed: { nodes: ["instantnodes"], coins: 60 } } }));
  const bad = settings(sp, cp, rp), badWire = routedFeed(rp);
  return [none.trades_ws_max_coins === 300 && none.trades_ws_node === "public" && !none.routed
          && two.trades_ws_node === "publicnode" && two.trades_ws_overflow === "chainstack" && two.trades_ws_max_coins === 500 && two.routed
          && one.trades_ws_node === "public" && one.trades_ws_overflow === "none" && one.trades_ws_max_coins === 60
          && badWire === null && bad.trades_ws_node === "public" && bad.trades_ws_max_coins === 300 && bad.trades_ws === "on",
    `no wire: ${none.trades_ws_node}, ${none.trades_ws_max_coins} coins; two nodes: ${two.trades_ws_node} then ${two.trades_ws_overflow}, ${two.trades_ws_max_coins} coins; one node: overflow ${one.trades_ws_overflow}; an unknown node: wire ${badWire}, ${bad.trades_ws_node} stays`];
});

await kase(37, "243 phase 2: a new node wire is followed live", "when the wire changes the nodes, the running feed closes and asks to be started again (the service starts it on the new nodes); a coin count change alone keeps it open", async () => {
  const d = tmp(), lines = []; FakeWS.last = null; let restarts = 0;
  const sp = join(d, "s.json"), rp = join(d, "r.json");
  writeFileSync(sp, JSON.stringify({ trades_ws: "on", trades_ws_max_coins: 5 }));
  writeFileSync(rp, JSON.stringify({ version: 1, routing: { trade_feed: { nodes: ["public", "publicnode"], coins: 5 } } }));
  const h = await main({ WebSocketImpl: FakeWS, fetchFn: async () => ({ ok: false, status: 500 }), env: {}, settingsPath: sp, routingPath: rp, feedDir: d, statusDir: d,
                         statePath: join(d, "st.json"), log: (l) => lines.push(l), restart: () => restarts++, refreshMs: 50 });
  await wait(300);                                                   // several refreshes, even on a busy machine
  writeFileSync(rp, JSON.stringify({ version: 2, routing: { trade_feed: { nodes: ["public", "publicnode"], coins: 9 } } }));
  await wait(400);
  const afterCoins = restarts;
  writeFileSync(rp, JSON.stringify({ version: 3, routing: { trade_feed: { nodes: ["publicnode"], coins: 9 } } }));
  for (let k = 0; k < 60 && !restarts; k++) await wait(50);          // the restart, however busy the machine (up to 3 s)
  h.stop();
  const said = lines.find((l) => /nodes changed/.test(l)) || "";
  return [afterCoins === 0 && restarts === 1 && /public, then publicnode -> publicnode, then none/.test(said),
    `after a coin change: ${afterCoins} restarts; after the node change: ${restarts}; said "${said.slice(0, 90)}"`];
});

await kase(38, "each trade to the feed server at once", "the ticks of one moment go in one request a coin to the feed on this machine, not awaited; a refusal rests the push 5 s (the tick file still follows), a slow answer rests nothing", async () => {
  const sent = []; let clock = 1_000_000, answer = 204;
  const fetchFn = async (url, o) => { sent.push({ url, body: JSON.parse(o.body) }); return { ok: answer === 204, status: answer }; };
  const p = new Pusher(fetchFn, PUSH_URL, () => clock);
  p.add("CoinA", { sig: "s1", i: 0, t: 1 }); p.add("CoinA", { sig: "s2", i: 0, t: 2 }); p.add("CoinB", { sig: "s3", i: 0, t: 3 });
  await wait(5);
  const first = sent.map((x) => `${x.body.mint}:${x.body.ticks.length}`);
  answer = 404; p.add("CoinA", { sig: "s4", i: 0, t: 4 }); await wait(5);
  const n = sent.length; p.add("CoinA", { sig: "s5", i: 0, t: 5 }); await wait(5);
  const held = sent.length === n;
  clock += 6_000; answer = 204; p.add("CoinA", { sig: "s6", i: 0, t: 6 }); await wait(5);
  const slowFetch = async () => { const e = new Error("slow"); e.name = "TimeoutError"; throw e; };
  const q = new Pusher(slowFetch, PUSH_URL, () => clock); q.add("CoinS", { sig: "x", i: 0, t: 1 }); await wait(5);
  const slowNoRest = q.restUntil === 0 && q.failed === 1;
  return [first.join(",") === "CoinA:2,CoinB:1" && sent[0].url === "http://127.0.0.1:8792/internal/ticks" && sent[0].body.contract === "ticks-1" && held
          && sent.length === n + 1 && p.sent === 4 && p.failed === 1 && slowNoRest,
    `one moment: ${first.join(", ")} (one request a coin, to ${sent[0].url}); after a refusal the next tick held: ${held}; 5 s later sent again; a slow answer does not rest it: ${slowNoRest}; sent ${p.sent}, failed ${p.failed}`];
});

await kase(39, "Two writers on one tick file: the SQD service's ticks and fields survive this feed's write", "a file the SQD service changed after this store read it is merged by sig:i before writing; its 1 s and 1 min candles and supply are kept", async () => {
  const d = tmp(), path = join(d, "W.json"), t0 = 1792551000000 - (1792551000000 % CANDLE_MS);
  const tk = (sig, dt, p) => ({ t: t0 + dt, sig, i: 0, side: "buy", tokens: 1, sol: 1, price_sol: p, quote: WSOL });
  writeFileSync(path, JSON.stringify({ contract: "ticks-1", mint: "W", source: "SQD Portal", ticks: [tk("q1", 1000, 1)], candles_5m: [{ t: t0, o: 1, h: 1, l: 1, c: 1, v: 1, buys: 1, sells: 0 }], candles_1s: [{ t: 1 }], candles_1m: [{ t: 2 }], supply: 5 }));
  const s = new TickStore(d); s.add("W", tk("w1", 2000, 2)); s.flush();                     // this feed takes the coin over
  await wait(20);
  const mid = JSON.parse(readFileSync(path, "utf8"));
  writeFileSync(path, JSON.stringify({ ...mid, ticks: [...mid.ticks, tk("q2", 3000, 3)], candles_1s: [{ t: 9 }] }));   // the SQD service writes again
  s.add("W", tk("w2", 4000, 4)); s.flush();
  const f = JSON.parse(readFileSync(path, "utf8")), sigs = f.ticks.map((t) => t.sig).join(",");
  const k = f.candles_5m[0];
  return [sigs === "q1,w1,q2,w2" && f.candles_1s?.[0]?.t === 9 && f.candles_1m?.[0]?.t === 2 && f.supply === 5 && k.v === 4 && k.c === 4 && f.source === "Solana chain",
    `ticks ${sigs}; candles_1s ${JSON.stringify(f.candles_1s)}, candles_1m ${JSON.stringify(f.candles_1m)}, supply ${f.supply}; 5-min candle volume ${k.v}, close ${k.c}`];
});

await kase(40, "Dollar price and size on each tick (the site's ask, 257)", "a tick gets price_usd and usd from the shared quote prices (the SQD service's Jupiter reads); none from a stale price or a missing one; its quote coin is named for the next read", () => {
  const d = tmp(), path = join(d, "quote_prices.json"), OTHERQ = "QuoteCoinNobodyPriced1111111111111111111111";
  let clock = 1_000_000;
  writeFileSync(path, JSON.stringify({ contract: "quote-prices-1", prices: { [WSOL]: { usd: 200, read_ms: 990_000 } } }));
  const q = new QuoteUsd(path, () => clock);
  const sol = q.stamp({ quote: WSOL, sol: 0.5, price_sol: 2e-8 });
  const other = q.stamp({ quote: OTHERQ, quote_amount: 3, price_quote: 1e-3 });
  clock = 990_000 + PRICE_STALE_MS + 5_000;
  const stale = q.stamp({ quote: WSOL, sol: 0.5, price_sol: 2e-8 });
  return [sol.usd === 100 && Math.abs(sol.price_usd - 4e-6) < 1e-15 && sol.price_usd_src === "Jupiter price v3, read 1970-01-01T00:16:30Z" && !("usd" in other) && !("price_usd" in other)
          && !("usd" in stale) && q.seen.has(OTHERQ) && q.seen.has(WSOL),
    `SOL tick $${sol.usd} at $${sol.price_usd}, '${sol.price_usd_src}'; an unpriced quote coin: no dollar fields; past the stale line: none; quote coins named for the next read: ${[...q.seen].length}`];
});

await kase(41, "A removed trade comes out of its candle; a candle whose start is no longer among the kept ticks is only taken down", "forget removes the transaction's ticks; a candle wholly covered by the kept ticks is rebuilt from them; one that began before the oldest kept tick keeps its open, high, low and close and loses the trade's volume and count", () => {
  const s = new TickStore(tmp()), t0 = 1792551000000 - (1792551000000 % CANDLE_MS);
  const tk = (sig, dt, side, p, sol) => ({ t: t0 + dt, sig, side, tokens: 1, sol, price_sol: p, quote: WSOL });
  s.add("F", tk("a", 1000, "buy", 2, 1)); s.add("F", tk("b", 2000, "buy", 9, 3)); s.add("F", tk("c", 3000, "sell", 1, 1));
  s.forget("F", "b"); const k = s.coins.get("F").candles[0];
  const rebuilt = k.h === 2 && k.v === 2 && k.buys === 1 && k.sells === 1 && k.o === 2 && k.c === 1;
  const u = new TickStore(tmp());
  for (let i = 0; i < KEEP_TICKS + 5; i++) u.add("G", tk("g" + i, i, "buy", 1 + (i === 3 ? 8 : 0), 1));
  const last = "g" + (KEEP_TICKS + 4); u.forget("G", last); const g = u.coins.get("G").candles[0];
  const takenDown = g.h === 9 && g.v === KEEP_TICKS + 4 && g.buys === KEEP_TICKS + 4 && u.coins.get("G").ticks.every((t) => t.sig !== last);
  return [rebuilt && takenDown, `covered candle rebuilt: high ${k.h}, volume ${k.v}, buys ${k.buys}, sells ${k.sells}; a candle begun before the kept ticks: high stays ${g.h}, volume ${g.v}`];
});

await kase(42, "Each coin's trades over the last hour", "trades_1h, buys_1h and sells_1h written only once this store's count covers the whole hour; a count left in the file by the other writer is never carried over; a removed trade comes out of the count", () => {
  const d = tmp(); let clock = 2_000_000_000_000;
  const tk = (sig, ago, side) => ({ t: clock - ago, sig, side, tokens: 1, sol: 1, price_sol: 1, quote: WSOL });
  writeFileSync(join(d, "H.json"), JSON.stringify({ contract: "ticks-1", mint: "H", source: "Solana chain", ticks: [], trades_1h: 999, buys_1h: 999, sells_1h: 0 }));
  const s = new TickStore(d, () => clock);
  s.add("H", tk("h1", 1000, "buy")); s.flush(); const young = JSON.parse(readFileSync(join(d, "H.json"), "utf8"));
  clock += HOUR_MS + 120_000;
  s.add("H", tk("h2", 1000, "buy")); s.add("H", tk("h3", 2000, "sell")); s.add("H", tk("h4", 3000, "buy")); s.forget("H", "h4"); s.flush();
  const f = JSON.parse(readFileSync(join(d, "H.json"), "utf8"));
  return [!("trades_1h" in young) && f.trades_1h === 2 && f.buys_1h === 1 && f.sells_1h === 1,
    `counted under an hour (the other writer's 999 in the file): ${"trades_1h" in young ? young.trades_1h : "none written"}; after the hour: ${f.trades_1h} (${f.buys_1h} buys, ${f.sells_1h} sells; one removed trade out, the first past the hour)`];
});

await kase(43, "A coin that goes to the other writer and comes back is counted afresh", "released when this feed stops writing it; back, it is read from its file again: the file's newest trades no longer span the hour, so no hour count is written until this feed has counted an hour again", () => {
  const d = tmp(); let clock = 2_000_000_000_000;
  const tk = (sig, at, side) => ({ t: at, sig, side, tokens: 1, sol: 1, price_sol: 1, quote: WSOL });
  const s = new TickStore(d, () => clock);
  for (let i = 0; i < 300; i++) s.add("R", tk("r" + i, clock - 3_000_000 + i * 10_000, "buy"));
  clock += HOUR_MS; s.add("R", tk("r-last", clock - 1000, "sell")); s.flush();
  const before = JSON.parse(readFileSync(join(d, "R.json"), "utf8")).trades_1h;
  s.release(["R"]);                                                         // the coin went to SQD
  const sqd = Array.from({ length: KEEP_TICKS }, (_, i) => tk("q" + i, clock + 1000 + i * 50, i % 2 ? "buy" : "sell"));
  writeFileSync(join(d, "R.json"), JSON.stringify({ contract: "ticks-1", mint: "R", source: "Solana chain", ticks: sqd }));   // its newest 500, under a minute
  clock += 120_000; s.add("R", tk("back", clock - 500, "buy")); s.flush();
  const after = JSON.parse(readFileSync(join(d, "R.json"), "utf8"));
  return [typeof before === "number" && !("trades_1h" in after),
    `counted for an hour: ${before}; gone to SQD and back (its file holding only its newest ${KEEP_TICKS}): ${"trades_1h" in after ? after.trades_1h + " written" : "no hour count written"}`];
});

console.log(`\n${results.filter(Boolean).length}/${results.length} passed`);
process.exit(results.every(Boolean) ? 0 : 1);
