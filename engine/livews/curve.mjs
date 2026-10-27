// a curve coin's trades from its CURVE ACCOUNT's state (accountSubscribe), not from transaction logs: the
// account changes only when a trade succeeds, so a failed bot transaction costs nothing (2026-10-21: per-coin
// logsSubscribe gave 42,766 notifications for 472 trades). Layouts as the engine's own readers read them
// (stage2/readers.py read_pump_curve, read_launchlab_pool) and Pump.fun's published IDL (BondingCurve).
// Addresses: Pump.fun's bonding curve is the PDA ["bonding-curve", mint]; LaunchLab's pool is the PDA
// ["pool", base mint, quote mint] (Raydium's SDK), checked on chain before it is trusted. No network here.
import { createHash } from "node:crypto";
import bs58, { b58decode } from "./b58.mjs";
import { PROGRAMS, WSOL } from "./decode.mjs";

// ---- ed25519: is a 32-byte value a point on the curve (a PDA must not be), as stage2/b58.py's oc()
const P = 2n ** 255n - 19n;
const modp = (a) => ((a % P) + P) % P;
const powm = (b, e) => { let r = 1n; b = modp(b); while (e > 0n) { if (e & 1n) r = (r * b) % P; b = (b * b) % P; e >>= 1n; } return r; };
const D = modp(-121665n * powm(121666n, P - 2n));
export function onCurve(bytes) {
  let y = 0n;
  for (let i = 31; i >= 0; i--) y = (y << 8n) | BigInt(bytes[i]);
  y &= (1n << 255n) - 1n;
  if (y >= P) return false;
  const u = modp(y * y - 1n), v = modp(D * y * y + 1n), x2 = modp(u * powm(v, P - 2n));
  return x2 === 0n || powm(x2, (P - 1n) / 2n) === 1n;
}
export function pda(seeds, program) {
  const prog = b58decode(program);
  for (let bump = 255; bump >= 0; bump--) {
    const h = createHash("sha256").update(Buffer.concat([...seeds, Buffer.from([bump]), prog, Buffer.from("ProgramDerivedAddress")])).digest();
    if (!onCurve(h)) return bs58(h);
  }
  return null;
}
export const pumpCurveAddress = (mint) => pda([Buffer.from("bonding-curve"), b58decode(mint)], PROGRAMS.pumpfun);
export const launchlabPoolAddress = (mint, quote = WSOL) => pda([Buffer.from("pool"), b58decode(mint), b58decode(quote)], PROGRAMS.launchlab);

// ---- the two accounts' states
const u64 = (b, o) => Number(b.readBigUInt64LE(o));
/** Pump.fun bonding curve: reserves, complete (graduated), the quote coin (all zero: SOL). Null when too short. */
export function pumpCurveState(raw) {
  if (!raw || raw.length < 81) return null;
  const quote = raw.length >= 115 && raw.subarray(83, 115).some((x) => x) ? bs58(raw.subarray(83, 115)) : WSOL;
  return { kind: "pumpfun", vtok: u64(raw, 8), vquote: u64(raw, 16), rtok: u64(raw, 24), rquote: u64(raw, 32), complete: raw[48] === 1, quote,
           base_decimals: 6, quote_decimals: quote === WSOL ? 9 : null };
}
/** LaunchLab pool: status, decimals, the two mints, reserves (virtual and real). Null when too short. */
export function launchlabPoolState(raw) {
  if (!raw || raw.length < 269) return null;
  return { kind: "launchlab", status: raw[17], base_decimals: raw[18], quote_decimals: raw[19], virtual_base: u64(raw, 37), virtual_quote: u64(raw, 45),
           real_base: u64(raw, 53), real_quote: u64(raw, 61), base_mint: bs58(raw.subarray(205, 237)), quote: bs58(raw.subarray(237, 269)) };
}

/** The price (quote per token) a state stands at, at the mints' decimals; null when a decimal count is not known
 *  (a Pump.fun curve priced in another coin: its decimals are not in the curve). */
export function priceOf(s) {
  if (s.kind === "pumpfun") {
    if (s.quote_decimals == null || s.vtok === 0) return null;
    return (s.vquote / 10 ** s.quote_decimals) / (s.vtok / 10 ** s.base_decimals);
  }
  const vb = s.virtual_base - s.real_base, vq = s.virtual_quote + s.real_quote;
  if (vb <= 0) return null;
  return (vq / 10 ** s.quote_decimals) / (vb / 10 ** s.base_decimals);
}

/** One trade from two consecutive states of the same curve: the side from which way the quote reserve moved, the
 *  sizes from the two reserves' changes, the price after it. Null when nothing moved. Two trades landing between two
 *  notifications show as one (their sum): the tick says `merged_possible` so nobody reads it as one wallet's trade. */
export function tradeBetween(prev, next, at, slot) {
  if (!prev || !next) return null;
  const dq = next.kind === "pumpfun" ? next.vquote - prev.vquote : next.real_quote - prev.real_quote;
  const dt = next.kind === "pumpfun" ? prev.vtok - next.vtok : next.real_base - prev.real_base;
  if (dq === 0 && dt === 0) return null;
  const side = dq > 0 ? "buy" : "sell";
  const t = { t: at, t_is_receipt: true, slot, sig: `slot:${slot}`, side, tokens: Math.abs(dt) / 10 ** next.base_decimals, quote: next.quote, from_state: true, merged_possible: true };
  const p = priceOf(next);
  if (next.quote_decimals == null) t.quote_raw = Math.abs(dq);
  else if (next.quote === WSOL) { t.sol = Math.abs(dq) / 10 ** next.quote_decimals; if (p != null) t.price_sol = p; }
  else { t.quote_amount = Math.abs(dq) / 10 ** next.quote_decimals; if (p != null) t.price_quote = p; }
  return t;
}
