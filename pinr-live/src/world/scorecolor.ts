import { onLook, palette } from "../ui/theme";
/**
 * The colour of a PINRscore: mandarin orange at 25 and below, lime at 95 and above, and a smooth blend in between.
 * One scale for the whole interface, so a glance at the colour says roughly how the token reads.
 */
export const SCORE_LOW = 25;
export const SCORE_HIGH = 95;
export const MANDARIN_RGB: readonly [number, number, number] = [255, 140, 26];
export const LIME_RGB: readonly [number, number, number] = [214, 255, 60];
/** The two ends of the scale follow the light/dark look (set in place so every user of the scale sees it). */
onLook(() => {
  const set = (to: readonly [number, number, number], rgb: string): void => {
    const [r, g, b] = rgb.split(",").map(Number) as [number, number, number];
    (to as [number, number, number]).splice(0, 3, r, g, b);
  };
  set(LIME_RGB, palette().live);
  set(MANDARIN_RGB, palette().mandarin);
});

/** How far along the scale a score is, 0 (mandarin) to 1 (lime). */
export function scoreT(score: number): number {
  if (!Number.isFinite(score)) return 0;
  return Math.min(1, Math.max(0, (score - SCORE_LOW) / (SCORE_HIGH - SCORE_LOW)));
}

export function scoreRgb(score: number): [number, number, number] {
  const t = scoreT(score);
  return [0, 1, 2].map((i) => Math.round(MANDARIN_RGB[i]! + (LIME_RGB[i]! - MANDARIN_RGB[i]!) * t)) as [number, number, number];
}

export function scoreColor(score: number): string {
  const [r, g, b] = scoreRgb(score);
  return `rgb(${r},${g},${b})`;
}
