#!/usr/bin/env node
/**
 * Make an MP4 start playing before it has fully downloaded ("fast start").
 *
 * An MP4 has an index (the `moov` box) that the player needs before it can show a frame.
 * Many exporters put it at the END of the file, so a phone must download everything first.
 * This moves it to the front. The video itself is not touched or re-encoded: not one pixel changes.
 *
 *   node tools/faststart.mjs input.mp4 output.mp4
 */
import fs from "node:fs";

const [, , inPath, outPath] = process.argv;
if (!inPath || !outPath) {
  console.error("usage: node tools/faststart.mjs input.mp4 output.mp4");
  process.exit(2);
}
const buf = fs.readFileSync(inPath);

function readBoxes(start, end) {
  const boxes = [];
  let p = start;
  while (p + 8 <= end) {
    let size = buf.readUInt32BE(p);
    const type = buf.toString("latin1", p + 4, p + 8);
    let hdr = 8;
    if (size === 1) {
      size = Number(buf.readBigUInt64BE(p + 8));
      hdr = 16;
    } else if (size === 0) size = end - p;
    if (size < hdr || p + size > end) throw new Error(`corrupt box "${type}" at byte ${p}`);
    boxes.push({ type, start: p, size, hdr });
    p += size;
  }
  return boxes;
}

const top = readBoxes(0, buf.length);
const order = top.map((b) => b.type);
const ftyp = top.find((b) => b.type === "ftyp");
const moov = top.find((b) => b.type === "moov");
const mdat = top.find((b) => b.type === "mdat");
if (!ftyp || !moov || !mdat) throw new Error(`not a plain MP4 (found: ${order.join(", ")})`);
if (moov.start < mdat.start) {
  console.log("Already fast-start: the index is before the video data. Copying unchanged.");
  fs.copyFileSync(inPath, outPath);
  process.exit(0);
}

// Everything the player is told to read lives at absolute byte offsets. Moving the index in front of
// the video data pushes that data later by exactly the index's size, so every offset must grow by it.
const moovBytes = Buffer.from(buf.subarray(moov.start, moov.start + moov.size));
const shift = moov.size;
let patched = 0;
function patch(parentStart, parentEnd) {
  for (const b of readBoxes(parentStart, parentEnd)) {
    const at = b.start - moov.start; // position inside moovBytes
    // Containers on the way down to the chunk-offset tables: look inside them (past their own header).
    if (["trak", "mdia", "minf", "stbl"].includes(b.type)) patch(b.start + b.hdr, b.start + b.size);
    if (b.type === "stco") {
      const n = moovBytes.readUInt32BE(at + 12);
      for (let i = 0; i < n; i++) {
        const o = at + 16 + i * 4;
        moovBytes.writeUInt32BE(moovBytes.readUInt32BE(o) + shift, o);
        patched++;
      }
    } else if (b.type === "co64") {
      const n = moovBytes.readUInt32BE(at + 12);
      for (let i = 0; i < n; i++) {
        const o = at + 16 + i * 8;
        moovBytes.writeBigUInt64BE(moovBytes.readBigUInt64BE(o) + BigInt(shift), o);
        patched++;
      }
    }
  }
}
// moov's own children start after its header.
patch(moov.start + moov.hdr, moov.start + moov.size);
if (patched === 0) throw new Error("found no chunk offsets to adjust; refusing to write a possibly broken file");

const pieces = [];
for (const b of top) {
  if (b.type === "moov") continue;
  pieces.push(buf.subarray(b.start, b.start + b.size));
  if (b.type === "ftyp") pieces.push(moovBytes);
}
fs.writeFileSync(outPath, Buffer.concat(pieces));
console.log(`Done. Index moved to the front; ${patched} offsets adjusted by ${shift} bytes. Wrote ${outPath}`);
