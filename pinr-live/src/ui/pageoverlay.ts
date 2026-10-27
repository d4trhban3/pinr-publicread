
/**
 * What every full page that lives over the camera view (Discover, DeepScan) shares:
 *   - where it stands: moved and scaled with the camera so zooming out is that same page getting smaller (`Placer`)
 *   - how it is handled: up and down scrolls the page, pinch and trackpad-zoom drive the camera
 */
export interface Placement {
  /** Screen position of the page's top-left corner, and its scale (1 = at home). */
  x: number;
  y: number;
  k: number;
  /** The room's edges inside the page, in the page's own pixels: what shows above, below, and how round the corners are. */
  top: number;
  bottom: number;
  radius: number;
}

export interface GestureOptions {
  onPinchStart(): void;
  onPinch(ratio: number, cx: number, cy: number): void;
  onPinchEnd(): void;
  /** Trackpad pinch (ctrl + wheel). */
  onZoomWheel(deltaY: number, cx: number, cy: number): void;
}

export function attachPageGestures(root: HTMLElement, scroller: HTMLElement, opts: GestureOptions): void {
  scroller.addEventListener(
    "wheel",
    (e) => {
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault(); // trackpad pinch
        opts.onZoomWheel(e.deltaY, e.clientX, e.clientY);
        return;
      }
    },
    { passive: false },
  );
  const down = new Map<number, { x: number; y: number }>();
  let lastDist = 0;
  let pinching = false;
  const distOf = (): number => {
    const p = [...down.values()];
    return p.length < 2 ? 0 : Math.hypot(p[0]!.x - p[1]!.x, p[0]!.y - p[1]!.y);
  };
  root.addEventListener("pointerdown", (e) => {
    if (e.pointerType === "mouse") return;
    // A part of the page can claim its own touches (the chart you scrub with a finger): those are not swipes.
    if ((e.target as HTMLElement).closest?.("[data-own-touch]")) return;
    down.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (down.size === 2) {
      lastDist = distOf();
      pinching = true;
      opts.onPinchStart();
    }
  });
  root.addEventListener("pointermove", (e) => {
    const p = down.get(e.pointerId);
    if (!p) return;
    p.x = e.clientX;
    p.y = e.clientY;
    if (pinching && down.size === 2) {
      const d = distOf();
      const pts = [...down.values()];
      if (lastDist > 0 && d > 0) opts.onPinch(d / lastDist, (pts[0]!.x + pts[1]!.x) / 2, (pts[0]!.y + pts[1]!.y) / 2);
      lastDist = d;
    }
  });
  const endPinch = (): void => {
    if (!pinching) return;
    pinching = false;
    lastDist = 0;
    opts.onPinchEnd();
  };
  const lift = (e: PointerEvent): void => {
    if (!down.has(e.pointerId)) return;
    down.delete(e.pointerId);
    if (down.size < 2) endPinch();
  };
  root.addEventListener("pointerup", lift);
  // The browser took the gesture for a vertical scroll: that is not a swipe.
  root.addEventListener("pointercancel", (e) => {
    down.delete(e.pointerId);
    if (down.size < 2) endPinch();
  });
}

/** Moves a page overlay to where the camera says its room is. Cheap to call every frame: it only writes what changed. */
export function createPlacer(root: HTMLElement, frame: HTMLElement, scroller: HTMLElement, onHidden: () => void): (p: Placement | null, live: boolean) => void {
  let lastT = "";
  let lastClip = "";
  let hiddenNow = true;
  return (p, live) => {
    root.classList.toggle("on", p !== null);
    root.classList.toggle("live", p !== null && live);
    if (!p) {
      if (!hiddenNow) onHidden();
      hiddenNow = true;
      return;
    }
    hiddenNow = false;
    const t = `translate3d(${p.x.toFixed(2)}px,${p.y.toFixed(2)}px,0) scale(${p.k.toFixed(5)})`;
    if (t !== lastT) {
      lastT = t;
      root.style.transform = t;
    }
    const edges = `${p.top.toFixed(1)}|${p.bottom.toFixed(1)}|${p.radius.toFixed(1)}`;
    if (edges !== lastClip) {
      lastClip = edges;
      frame.style.top = `${p.top}px`;
      frame.style.bottom = `${p.bottom}px`;
      frame.style.borderRadius = `${p.radius}px`;
      // The scroller spans the whole screen; the frame shows only the room's part of it.
      scroller.style.top = `${-p.top}px`;
      scroller.style.bottom = `${-p.bottom}px`;
    }
  };
}
