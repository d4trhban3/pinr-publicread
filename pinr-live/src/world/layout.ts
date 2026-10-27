/**
 * The tile grid. A plain, regular lattice: `cols` tiles across, rows going down, in rank order (the most
 * important token first, reading left to right then top to bottom). Every tile is the same size; how much
 * a token matters shows in how it behaves (swell, glow, speed), never in where it sits or how big it is.
 * Pure function: same input, same output, no DOM.
 */
export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** The grid never holds more rows than this: the most tiles (200) at the fewest columns the grid offers (4) is 50 rows. */
export const MAX_ROWS = 50;
/** Rows that fit on one screen at home. */
export const VISIBLE_ROWS = 5;

/**
 * Place `ids` (best first) in a lattice centred on x = 0 with its top edge at y = 0.
 * Anything beyond `cols x MAX_ROWS` is left out.
 */
export function layoutGrid(ids: readonly number[], cols: number, cw: number, ch: number, gap: number): Map<number, Rect> {
  const out = new Map<number, Rect>();
  const x0 = -(cols * cw + (cols - 1) * gap) / 2;
  const cap = cols * MAX_ROWS;
  for (let i = 0; i < ids.length && i < cap; i++) {
    const row = Math.floor(i / cols);
    const col = i % cols;
    out.set(ids[i]!, { x: x0 + col * (cw + gap), y: row * (ch + gap), w: cw, h: ch });
  }
  return out;
}

/** Tile height that makes exactly `rows` rows (with gaps) fill `availableH` screen pixels at zoom `scale`. */
export function cellHeightFor(availableH: number, scale: number, rows: number, gap: number): number {
  return availableH / (rows * scale) - gap;
}
