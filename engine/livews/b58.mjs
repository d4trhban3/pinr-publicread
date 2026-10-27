// Base58 (Bitcoin alphabet) for Solana addresses: encode 32 raw bytes, decode an address. The same as stage2/b58.py.
const A = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
export default function bs58(bytes) {
  let n = 0n;
  for (const b of bytes) n = n * 256n + BigInt(b);
  let s = "";
  while (n > 0n) { s = A[Number(n % 58n)] + s; n /= 58n; }
  for (const b of bytes) { if (b !== 0) break; s = "1" + s; }
  return s;
}
export function b58decode(s) {
  let n = 0n;
  for (const c of s) { const i = A.indexOf(c); if (i < 0) throw new Error("not base58"); n = n * 58n + BigInt(i); }
  const out = [];
  while (n > 0n) { out.unshift(Number(n % 256n)); n /= 256n; }
  for (const c of s) { if (c !== "1") break; out.unshift(0); }
  return Buffer.from(out);
}
