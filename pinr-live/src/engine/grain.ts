/**
 * One small tile of fine film grain, made once at startup and tiled by CSS.
 * It gives the cards a matte silicone surface instead of a flat digital fill.
 * Mostly transparent: only a few specks of white and black.
 */
export function makeGrainDataUrl(size = 128): string {
  const c = document.createElement("canvas");
  c.width = c.height = size;
  const ctx = c.getContext("2d")!;
  const img = ctx.createImageData(size, size);
  // Seeded so the grain is identical on every load.
  let a = 0x9e3779b9;
  for (let i = 0; i < img.data.length; i += 4) {
    a = (Math.imul(a, 1664525) + 1013904223) >>> 0;
    const v = a >>> 24;
    const light = v > 127;
    img.data[i] = img.data[i + 1] = img.data[i + 2] = light ? 255 : 0;
    img.data[i + 3] = Math.abs(v - 127) < 40 ? 0 : Math.round((Math.abs(v - 127) / 128) * 9);
  }
  ctx.putImageData(img, 0, 0);
  return c.toDataURL("image/png");
}
