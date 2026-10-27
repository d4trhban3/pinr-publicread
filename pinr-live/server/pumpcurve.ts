import { createHash } from "node:crypto";

/**
 * Is `curve` really `mint`'s Pump.fun bonding curve? Pump.fun keeps each coin's curve at one fixed address, derived from the coin's own
 * address (Solana's program-derived address: seeds "bonding-curve" and the mint, under the Pump.fun program). DATA, 2026-10-25: PumpPortal
 * sent "create" events naming PUMP's own address (pumpCm…) with another coin's curve, and the pool listed PUMP as a new curve coin
 * ("Blind Ape", then "Mega Jack"). A create whose curve is not the mint's own is not that coin's launch, and is dropped.
 * Plain arithmetic: base58, SHA-256 (Node's own) and the ed25519 on-curve test, with no outside library and no network.
 */
const PUMP_PROGRAM = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";
const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

export function base58(s: string): Uint8Array | null {
  let n = 0n;
  for (const ch of s) {
    const v = ALPHABET.indexOf(ch);
    if (v < 0) return null;
    n = n * 58n + BigInt(v);
  }
  const out: number[] = [];
  while (n > 0n) {
    out.unshift(Number(n & 255n));
    n >>= 8n;
  }
  for (const ch of s) {
    if (ch !== "1") break;
    out.unshift(0);
  }
  return out.length === 32 ? Uint8Array.from(out) : null;
}

export function toBase58(b: Uint8Array): string {
  let n = 0n;
  for (const x of b) n = (n << 8n) | BigInt(x);
  let s = "";
  while (n > 0n) {
    s = ALPHABET[Number(n % 58n)] + s;
    n /= 58n;
  }
  for (const x of b) {
    if (x !== 0) break;
    s = "1" + s;
  }
  return s;
}

const P = 2n ** 255n - 19n;
const mod = (a: bigint): bigint => ((a % P) + P) % P;
function pow(b: bigint, e: bigint): bigint {
  let r = 1n;
  b = mod(b);
  while (e > 0n) {
    if (e & 1n) r = (r * b) % P;
    b = (b * b) % P;
    e >>= 1n;
  }
  return r;
}
const D = mod(-121665n * pow(121666n, P - 2n));
const SQRT_M1 = pow(2n, (P - 1n) / 4n);

/** Whether 32 bytes are a point on the ed25519 curve (a program-derived address must not be one). */
export function onCurve(b: Uint8Array): boolean {
  let y = 0n;
  for (let i = 31; i >= 0; i--) y = (y << 8n) | BigInt(i === 31 ? b[i]! & 0x7f : b[i]!);
  if (y >= P) return false;
  const u = mod(y * y - 1n);
  const v = mod(D * y * y + 1n);
  let x = mod(u * pow(v, 3n) * pow(u * pow(v, 7n), (P - 5n) / 8n));
  const vx2 = mod(v * x * x);
  if (vx2 === u) return true;
  if (vx2 === mod(-u)) {
    x = mod(x * SQRT_M1);
    return true;
  }
  return false;
}

const cache = new Map<string, string | null>();

/** The mint's own Pump.fun curve address, or null for an address that is not one. */
export function pumpCurveOf(mint: string): string | null {
  const hit = cache.get(mint);
  if (hit !== undefined) return hit;
  const m = base58(mint);
  const prog = base58(PUMP_PROGRAM)!;
  let found: string | null = null;
  if (m) {
    for (let bump = 255; bump >= 0 && found === null; bump--) {
      const h = createHash("sha256").update("bonding-curve").update(m).update(Uint8Array.of(bump)).update(prog).update("ProgramDerivedAddress").digest();
      if (!onCurve(h)) found = toBase58(h);
    }
  }
  if (cache.size > 50_000) cache.clear();
  cache.set(mint, found);
  return found;
}

export const isPumpCurve = (mint: string, curve: string): boolean => pumpCurveOf(mint) === curve;
