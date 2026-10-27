// decoding the launchpads' own trade events from a transaction's logs ("Program data: <base64>").
// The layouts are the programs' published IDLs (read 2026-10-21): Pump.fun `pump-fun/pump-public-docs` idl/pump.json,
// Raydium LaunchLab `raydium-io/raydium-idl` raydium_launchpad.json. Anchor events: 8-byte discriminator, then Borsh.
// Whole or nothing per event: a field the bytes do not reach is absent (an older, shorter event), never zero; an event
// that does not decode is skipped, never guessed. No network, no state.
import bs58 from "./b58.mjs";

export const PROGRAMS = { pumpfun: "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P", launchlab: "LanMV9sAd7wArD4vJFi2qDdfnVhFxYSUg6eADduJ3uj" };
export const WSOL = "So11111111111111111111111111111111111111112";
const DISC = { trade: "bddb7fd34ee661ee", create: "1b72a94ddeeb6376", complete: "5f72619cd42e9808" };   // the same trade discriminator in both IDLs

class Reader {
  constructor(buf) { this.b = buf; this.o = 8; }
  left(n) { return this.o + n <= this.b.length; }
  pubkey() { if (!this.left(32)) throw new RangeError("short"); const v = bs58(this.b.subarray(this.o, this.o + 32)); this.o += 32; return v; }
  u64() { if (!this.left(8)) throw new RangeError("short"); const v = this.b.readBigUInt64LE(this.o); this.o += 8; return v; }
  i64() { if (!this.left(8)) throw new RangeError("short"); const v = this.b.readBigInt64LE(this.o); this.o += 8; return v; }
  u16() { if (!this.left(2)) throw new RangeError("short"); const v = this.b.readUInt16LE(this.o); this.o += 2; return v; }
  u8() { if (!this.left(1)) throw new RangeError("short"); return this.b[this.o++]; }
  bool() { const v = this.u8(); if (v > 1) throw new RangeError("not a bool"); return v === 1; }
  str() { if (!this.left(4)) throw new RangeError("short"); const n = this.b.readUInt32LE(this.o); this.o += 4; if (!this.left(n)) throw new RangeError("short"); const v = this.b.subarray(this.o, this.o + n).toString("utf8"); this.o += n; return v; }
}

/** Pump.fun TradeEvent, every field in the IDL's order; the tail (fields added later) only as far as the bytes go. */
export function pumpTrade(buf) {
  const r = new Reader(buf), e = {};
  e.mint = r.pubkey(); e.sol_amount = r.u64(); e.token_amount = r.u64(); e.is_buy = r.bool(); e.user = r.pubkey();
  e.timestamp = r.i64(); e.virtual_sol_reserves = r.u64(); e.virtual_token_reserves = r.u64();
  e.real_sol_reserves = r.u64(); e.real_token_reserves = r.u64();
  const tail = [["fee_recipient", "pubkey"], ["fee_basis_points", "u64"], ["fee", "u64"], ["creator", "pubkey"], ["creator_fee_basis_points", "u64"],
    ["creator_fee", "u64"], ["track_volume", "bool"], ["total_unclaimed_tokens", "u64"], ["total_claimed_tokens", "u64"], ["current_sol_volume", "u64"],
    ["last_update_timestamp", "i64"], ["ix_name", "str"], ["mayhem_mode", "bool"], ["cashback_fee_basis_points", "u64"], ["cashback", "u64"],
    ["buyback_fee_basis_points", "u64"], ["buyback_fee", "u64"], ["shareholders", "shareholders"], ["quote_mint", "pubkey"], ["quote_amount", "u64"],
    ["virtual_quote_reserves", "u64"], ["real_quote_reserves", "u64"]];
  for (const [name, kind] of tail) {
    if (r.o >= buf.length) break;                        // an older, shorter event: the rest is absent
    if (kind === "shareholders") {
      const n = (() => { if (!r.left(4)) throw new RangeError("short"); const v = r.b.readUInt32LE(r.o); r.o += 4; return v; })();
      const list = []; for (let i = 0; i < n; i++) list.push({ address: r.pubkey(), share_bps: r.u16() });
      e[name] = list;
    } else e[name] = r[kind]();
  }
  return e;
}

/** Pump.fun CompleteEvent: the curve finished (graduation). */
export function pumpComplete(buf) {
  const r = new Reader(buf);
  const e = { user: r.pubkey(), mint: r.pubkey(), bonding_curve: r.pubkey(), timestamp: r.i64() };
  if (r.o < buf.length) e.quote_mint = r.pubkey();
  return e;
}

/** Pump.fun CreateEvent: a new coin (name, symbol, uri, mint, curve, creator, time). */
export function pumpCreate(buf) {
  const r = new Reader(buf);
  return { name: r.str(), symbol: r.str(), uri: r.str(), mint: r.pubkey(), bonding_curve: r.pubkey(), user: r.pubkey(), creator: r.pubkey(), timestamp: r.i64() };
}

/** LaunchLab TradeEvent (147 bytes): names the pool, not the coin. */
export function launchlabTrade(buf) {
  const r = new Reader(buf), e = { pool_state: r.pubkey() };
  for (const k of ["total_base_sell", "virtual_base", "virtual_quote", "real_base_before", "real_quote_before", "real_base_after", "real_quote_after",
    "amount_in", "amount_out", "protocol_fee", "platform_fee", "creator_fee", "share_fee"]) e[k] = r.u64();
  const dir = r.u8(); if (dir > 1) throw new RangeError("not a trade direction");
  e.trade_direction = dir === 0 ? "buy" : "sell";
  e.pool_status = r.u8(); e.exact_in = r.bool();
  return e;
}

/** Every launchpad event in one transaction's logs, attributed to the program that emitted it (the log's own
 *  invoke/success nesting), as [{program, kind, event}]. A failed transaction gives nothing. */
export function eventsFromLogs(logs, err) {
  if (err) return [];
  const out = [], stack = [];
  for (const line of logs || []) {
    let m = line.match(/^Program (\S+) invoke \[\d+\]$/);
    if (m) { stack.push(m[1]); continue; }
    m = line.match(/^Program (\S+) (success|failed)/);
    if (m) { stack.pop(); continue; }
    if (!line.startsWith("Program data: ")) continue;
    const program = stack[stack.length - 1];
    let buf; try { buf = Buffer.from(line.slice(14), "base64"); } catch { continue; }
    if (buf.length < 8) continue;
    const disc = buf.subarray(0, 8).toString("hex");
    try {
      if (program === PROGRAMS.pumpfun && disc === DISC.trade) out.push({ program: "pumpfun", kind: "trade", event: pumpTrade(buf) });
      else if (program === PROGRAMS.pumpfun && disc === DISC.complete) out.push({ program: "pumpfun", kind: "complete", event: pumpComplete(buf) });
      else if (program === PROGRAMS.pumpfun && disc === DISC.create) out.push({ program: "pumpfun", kind: "create", event: pumpCreate(buf) });
      else if (program === PROGRAMS.launchlab && disc === DISC.trade) out.push({ program: "launchlab", kind: "trade", event: launchlabTrade(buf) });
    } catch { /* an event the layout does not fit: skipped, never guessed */ }
  }
  return out;
}

const n = (big) => Number(big);

/** One chart tick from a Pump.fun trade on `mint`: the side, the amounts and the price after the trade from the
 *  curve's own virtual reserves (quote per token, token at 6 decimals, SOL at 9). A curve priced in another coin
 *  (sol_amount 0, quote_mint not SOL) uses the quote fields; their decimals are not in the event, so the tick names the
 *  quote mint and gives raw units and no price. Null when the event is not this coin's. */
export function pumpTick(ev, mint, signature, slot) {
  if (ev.mint !== mint) return null;
  const quote = ev.quote_mint && ev.quote_mint !== WSOL && ev.quote_mint !== "11111111111111111111111111111111" ? ev.quote_mint : WSOL;
  const t = { t: n(ev.timestamp) * 1000, sig: signature, slot, side: ev.is_buy ? "buy" : "sell", tokens: n(ev.token_amount) / 1e6, quote };
  if (quote === WSOL) {
    if (ev.virtual_token_reserves === 0n) return null;
    t.sol = n(ev.sol_amount) / 1e9;
    t.price_sol = (n(ev.virtual_sol_reserves) / 1e9) / (n(ev.virtual_token_reserves) / 1e6);
  } else {
    if (ev.quote_amount === undefined) return null;   // the quote amount not in this event: nothing to chart
    t.quote_raw = n(ev.quote_amount);
  }
  return t;
}

/** A LaunchLab pool account (Raydium's layout, as stage2/readers.read_launchlab_pool reads it): status, the two mints'
 *  decimals and addresses. Null when the bytes are too short. */
export function launchlabPool(raw) {
  if (!raw || raw.length < 269) return null;
  return { status: raw[17], base_decimals: raw[18], quote_decimals: raw[19], base_mint: bs58(raw.subarray(205, 237)), quote_mint: bs58(raw.subarray(237, 269)) };
}

/** One chart tick from a LaunchLab trade on `mint`. LaunchLab's event carries no time and names the pool, not the coin:
 *  the caller gives the pool's own record (read once on chain: `launchlabPool`) and the time the notification arrived
 *  (`at`, marked as a receipt time). No pool record, or a pool whose base coin is not this coin: no tick (never a guess
 *  of the quote coin or the decimals). Price after the trade, quote per base, from the curve's virtual and real reserves
 *  ((virtual_quote + real_quote_after) / (virtual_base - real_base_after)) at the mints' own decimals. */
export function launchlabTick(ev, mint, signature, slot, at, pool) {
  if (!pool || pool.base_mint !== mint) return null;
  const buy = ev.trade_direction === "buy";
  const bd = 10 ** pool.base_decimals, qd = 10 ** pool.quote_decimals;
  const vb = n(ev.virtual_base) - n(ev.real_base_after), vq = n(ev.virtual_quote) + n(ev.real_quote_after);
  if (vb <= 0) return null;
  const t = { t: at, t_is_receipt: true, sig: signature, slot, side: ev.trade_direction, tokens: (buy ? n(ev.amount_out) : n(ev.amount_in)) / bd, quote: pool.quote_mint };
  const q = (buy ? n(ev.amount_in) : n(ev.amount_out)) / qd, price = (vq / qd) / (vb / bd);
  if (pool.quote_mint === WSOL) { t.sol = q; t.price_sol = price; } else { t.quote_amount = q; t.price_quote = price; }
  return t;
}
