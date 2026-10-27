import { GAP, CARD_W } from "./cards";

/** Choices offered in the tile-count control. Wider screens may use more. */
export const COLUMN_CHOICES = [4, 5, 6, 7, 8, 10, 12];
export const DEFAULT_COLS = 5;
/** Narrower than this a tile at five across is too small to carry its name (R1), so a phone starts on four. */
export const PHONE_WIDTH = 600;
export const PHONE_DEFAULT_COLS = 4;
/** The tiles per row a screen of this width starts on. */
export const defaultCols = (viewW: number): number => (viewW < PHONE_WIDTH ? PHONE_DEFAULT_COLS : DEFAULT_COLS);
/** Never show a tile narrower than this many CSS pixels at home. */
export const MIN_TILE_PX = 30;

/** The safe zone at the grid's sides, in world units: the operator (26 Oct) found everything too close to the edge, so it is wider than the gap between tiles. */
export const EDGE = 14;

/** Width of the whole grid in world units for this many columns, including outer margins. */
export function gridWidth(cols: number): number {
  return cols * CARD_W + (cols - 1) * GAP + 2 * EDGE;
}

/** The zoom at which `cols` columns exactly fill a screen of this width. This is what locks the grid horizontally. */
export function fitScale(cols: number, viewW: number): number {
  return viewW / gridWidth(cols);
}

/** At phone width the choices are the apps' . */
export const PHONE_COLUMN_CHOICES = [2, 3, 4];

/** The column counts a screen of this width can sensibly show. */
export function allowedCols(viewW: number): number[] {
  if (viewW < PHONE_WIDTH) return PHONE_COLUMN_CHOICES.slice();
  const out = COLUMN_CHOICES.filter((c) => fitScale(c, viewW) * CARD_W >= MIN_TILE_PX);
  return out.length ? out : [COLUMN_CHOICES[0]!];
}

/** Keep a saved or requested count valid for this screen. */
export function clampCols(cols: number, viewW: number): number {
  const ok = allowedCols(viewW);
  if (ok.includes(cols)) return cols;
  return ok.reduce((best, c) => (Math.abs(c - cols) < Math.abs(best - cols) ? c : best), ok[0]!);
}

/** How big a tile is at the default count on a wide screen (2.2 times its design width): the size the operator's 5 x 5 home was set at. */
export const WIDE_TILE_SCALE = 2.2;

/**
 * The zoom for the chosen count. On a phone the chosen count fills the width (the apps' tiles). On a wider screen the choice sets the tile's SIZE
 * (5 across is the 2.2 size, 4 a little bigger, 8 smaller), never more than fills the width.
 */
export function tileScale(cols: number, viewW: number): number {
  if (viewW < PHONE_WIDTH) return Math.min(4, fitScale(cols, viewW));
  return Math.min((WIDE_TILE_SCALE * DEFAULT_COLS) / cols, fitScale(cols, viewW));
}

/**
 * How many tiles go across. The operator (2026-10-25): the site is a website, not an app frame, so every room is as wide as the browser and a wider
 * window shows more tiles across at the same size; never fewer than the chosen count.
 */
export function shownCols(cols: number, viewW: number): number {
  if (viewW < PHONE_WIDTH) return cols;
  // whole tiles only: the count that fits at the chosen size, each tile then a little larger to fill the rest of the width
  return Math.max(cols, Math.floor((viewW / tileScale(cols, viewW) - 2 * EDGE + GAP) / (CARD_W + GAP)));
}
