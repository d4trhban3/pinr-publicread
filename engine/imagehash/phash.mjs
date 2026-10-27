// each picture's
// perceptual hash, so the gate can see the same picture re-saved, resized or re-hosted. Open-source: sharp decodes the
// image, sharp-phash makes the 64-bit hash. Input: a JSON list of file paths (argv[2], a file). Output on stdout: JSON
// {path: "16 hex digits" | null}; a file that cannot be decoded (not an image, broken) is null, never a guess.
import { readFileSync } from "node:fs";
import phash from "sharp-phash";

export async function hashFile(path) {
  try {
    const bits = await phash(readFileSync(path));                 // "0101..." (64 characters)
    if (!/^[01]{64}$/.test(bits)) return null;
    return BigInt("0b" + bits).toString(16).padStart(16, "0");
  } catch {
    return null;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const paths = JSON.parse(readFileSync(process.argv[2], "utf8"));
  const out = {};
  for (const p of paths) out[p] = await hashFile(p);              // one at a time: a few hundred small pictures a pass
  process.stdout.write(JSON.stringify(out));
}
