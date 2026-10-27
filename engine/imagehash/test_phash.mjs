// The perceptual hash helper (imagehash/phash.mjs) on made-up pictures drawn here with sharp; no network.
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { hashFile } from "./phash.mjs";

const dir = mkdtempSync(join(tmpdir(), "phash-"));
const results = [];
const dist = (a, b) => [...(BigInt("0x" + a) ^ BigInt("0x" + b)).toString(2)].filter((c) => c === "1").length;

// A made-up picture: a gradient with a block, 256 x 256.
function picture(variant) {
  const w = 256, px = Buffer.alloc(w * w * 3);
  for (let y = 0; y < w; y++) for (let x = 0; x < w; x++) {
    const i = (y * w + x) * 3;
    const inBlock = variant === "other" ? (x > 20 && x < 120 && y > 140 && y < 240) : (x > 140 && x < 230 && y > 30 && y < 110);
    const g = variant === "other" ? (255 - x) : x;
    px[i] = inBlock ? 240 : g; px[i + 1] = inBlock ? 30 : (y * 255) / w; px[i + 2] = inBlock ? 60 : 128;
  }
  return sharp(px, { raw: { width: w, height: w, channels: 3 } });
}

async function main() {
  const a = join(dir, "a.png"), b = join(dir, "b.jpg"), c = join(dir, "c.webp"), d = join(dir, "d.png"), e = join(dir, "e.txt");
  await picture("base").png().toFile(a);
  await picture("base").resize(128, 128).jpeg({ quality: 60 }).toFile(b);      // the same picture re-saved smaller as JPEG
  await picture("base").webp({ quality: 50 }).toFile(c);                       // and as WebP
  await picture("other").png().toFile(d);                                      // a different picture
  writeFileSync(e, "not an image");
  const [ha, hb, hc, hd, he] = await Promise.all([a, b, c, d, e].map(hashFile));
  results.push([/^[0-9a-f]{16}$/.test(ha) && he === null, `a hash of 16 hex digits (${ha}); a file that is not an image: ${he}`]);
  results.push([dist(ha, hb) <= 5 && dist(ha, hc) <= 5, `the same picture re-saved: ${dist(ha, hb)} bits apart (JPEG, half size), ${dist(ha, hc)} (WebP)`]);
  results.push([dist(ha, hd) > 10, `a different picture: ${dist(ha, hd)} bits apart`]);
  results.forEach(([ok, text], i) => console.log(`${ok ? "PASS" : "FAIL"} ${i + 1}. ${text}`));
  const passed = results.filter(([ok]) => ok).length;
  console.log(`${passed}/${results.length} passing`);
  process.exit(passed === results.length ? 0 : 1);
}
main();
