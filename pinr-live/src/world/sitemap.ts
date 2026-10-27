/**
 * The site as a map. Nine places sit on one canvas in a 3 x 3 grid:
 *
 *   Ads (north-west)     PvP Arena (north)        Ads (north-east)
 *   Discover (west)      PINR (middle)            Wallet / Profile (east)
 *   Ads (south-west)     PINRbot DeepScan (south)   Ads (south-east)
 *
 * The operator, 2026-10-25: the PINR page in the centre and the PvP Arena north. The PINR guide left the map: it opens over
 * the page from the header's "PINR GUIDE" button, as the Whitepaper does.
 *
 * A page "frame" is what one screen of that page covers. Zoomed in (the 5 x 5 lock) you are inside one
 * page. Zoomed out you see the frames side by side, and the zoom limit is where all nine are in view.
 * Everything here is plain arithmetic so it can be tested without a screen.
 */
import { scoreShown } from "./hub";

export type PageId = "ads" | "arena" | "adsne" | "adsw" | "adse" | "pinr" | "deepscan" | "discover" | "wallet";

export const PAGE_ORDER: PageId[] = ["ads", "arena", "adsne", "discover", "pinr", "wallet", "deepscan", "adsw", "adse"];

export const PAGE_TITLES: Record<PageId, string> = {
  ads: "Ad space",
  arena: "PvP Arena",
  adsne: "Ad space",
  adsw: "Ad space",
  adse: "Ad space",
  pinr: "PINR",
  deepscan: scoreShown() ? "PINRbot DeepScan" : "DeepScan",
  discover: "Discover",
  wallet: "Wallet / Profile",
};

export interface Frame {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** World units between neighbouring frames. */
export const PAGE_GAP = 80;

/** PINR is the middle page and its top edge is y = 0, centred on x = 0 (where its tile grid already sits); the rows above sit at negative y. */
export function pageFrames(pw: number, ph: number, gap = PAGE_GAP): Record<PageId, Frame> {
  const step = ph + gap;
  const side = pw + gap;
  const x0 = -pw / 2;
  return {
    // The top row: advertising north-west and north-east, either side of the PvP Arena.
    ads: { x: x0 - side, y: -step, w: pw, h: ph },
    arena: { x: x0, y: -step, w: pw, h: ph },
    adsne: { x: x0 + side, y: -step, w: pw, h: ph },
    discover: { x: x0 - side, y: 0, w: pw, h: ph },
    pinr: { x: x0, y: 0, w: pw, h: ph },
    wallet: { x: x0 + side, y: 0, w: pw, h: ph },
    // Opened by tapping a token on the PINR page: it sits south, below PINR.
    deepscan: { x: x0, y: step, w: pw, h: ph },
    // Advertising, south-west and south-east: below Discover and below Wallet, either side of DeepScan.
    adsw: { x: x0 - side, y: step, w: pw, h: ph },
    adse: { x: x0 + side, y: step, w: pw, h: ph },
  };
}

export function mapExtent(frames: Record<PageId, Frame>): { left: number; top: number; right: number; bottom: number } {
  const all = Object.values(frames);
  return {
    left: Math.min(...all.map((f) => f.x)),
    top: Math.min(...all.map((f) => f.y)),
    right: Math.max(...all.map((f) => f.x + f.w)),
    bottom: Math.max(...all.map((f) => f.y + f.h)),
  };
}

/** The zoom at which the whole map just fits the area between the header and the footer (with a little air). */
export function mapFitScale(frames: Record<PageId, Frame>, viewW: number, viewH: number, topInset: number, bottomInset: number, air = 0.94): number {
  const e = mapExtent(frames);
  return Math.min(viewW / (e.right - e.left), (viewH - topInset - bottomInset) / (e.bottom - e.top)) * air;
}

/** Where the camera centre goes to look at a page the way you do at home: its top edge just under the header. */
export function cameraFor(frame: Frame, viewH: number, topInset: number, scale: number): { x: number; y: number } {
  return { x: frame.x + frame.w / 2, y: frame.y + (viewH / 2 - topInset) / scale };
}

/** The page whose home camera position is closest to where the camera is now. */
export function nearestPage(frames: Record<PageId, Frame>, camX: number, camY: number, viewH: number, topInset: number, scale: number): PageId {
  let best: PageId = "pinr";
  let bestD = Infinity;
  for (const id of PAGE_ORDER) {
    const c = cameraFor(frames[id], viewH, topInset, scale);
    const d = Math.hypot(c.x - camX, c.y - camY);
    if (d < bestD) {
      bestD = d;
      best = id;
    }
  }
  return best;
}

/** Camera range along one axis so that content [lo, hi] fills the screen without gaps; centred if it is smaller. */
export function axisRange(contentLo: number, contentHi: number, halfBefore: number, halfAfter: number): { min: number; max: number } {
  let min = contentLo + halfBefore;
  let max = contentHi - halfAfter;
  if (min > max) min = max = (min + max) / 2;
  return { min, max };
}

export interface CamState {
  x: number;
  y: number;
  /** natural-log zoom */
  lz: number;
}

const smoothstep = (t: number): number => t * t * (3 - 2 * t);

/**
 * A journey between two views: the camera travels in a smooth line while the zoom swings out and back in
 * (`dip` = how far out, in log units), so you see where you are going. p runs 0 -> 1.
 */
export function journeyAt(p: number, from: CamState, to: CamState, dip: number): CamState {
  const t = Math.min(1, Math.max(0, p));
  const e = smoothstep(t);
  return {
    x: from.x + (to.x - from.x) * e,
    y: from.y + (to.y - from.y) * e,
    lz: from.lz + (to.lz - from.lz) * e - dip * Math.sin(Math.PI * t),
  };
}

/** How far to zoom out on a trip of this length (world units): a hop to a neighbour dips most of the way, a long trip all of it. */
export function journeyDip(distance: number, pageStep: number, maxDip: number): number {
  if (distance < pageStep * 0.05) return 0;
  return maxDip * Math.min(1, 0.55 + 0.45 * (distance / (2 * pageStep)));
}

/** Seconds a trip takes. */
export function journeySeconds(distance: number, pageStep: number): number {
  return 0.7 + 0.22 * Math.min(2, distance / pageStep);
}
