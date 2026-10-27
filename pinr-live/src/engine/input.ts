import type { Camera, View } from "./camera";

/** Fastest release fling, in screen pixels per second. */
const MAX_FLING = 4500;

/**
 * Pointer / touch / trackpad input for the camera.
 *  - one finger or mouse drag  : pan, with inertia on release
 *  - two fingers               : pinch-zoom + pan together
 *  - ctrl/cmd + wheel, trackpad pinch (Safari gesture events): zoom
 *  - plain wheel / two-finger trackpad scroll : pan
 *  - double tap / double click on empty space, or Escape: fly home
 */
export function attachInput(
  el: HTMLElement,
  cam: Camera,
  getView: () => View,
  onActivity: () => void,
  /** Fired when a zoom gesture (pinch or trackpad) has finished, so the app can settle on a tile count. */
  onZoomEnd: () => void = () => {},
  /** While true (a tile is being held) one finger no longer scrolls the grid. */
  locked: () => boolean = () => false,
): void {
  const pointers = new Map<number, { x: number; y: number }>();
  let lastMid = { x: 0, y: 0 };
  let lastDist = 0;
  // Smoothed pan velocity (screen px/s) for the release fling.
  let pvx = 0;
  let pvy = 0;
  let lastT = 0;
  let lastTap = 0;
  let lastTapPos = { x: 0, y: 0 };
  let moved = 0;
  let pinched = false;
  let wheelTimer: ReturnType<typeof setTimeout> | undefined;
  const scheduleZoomEnd = () => {
    clearTimeout(wheelTimer);
    wheelTimer = setTimeout(onZoomEnd, 180);
  };

  const mid = () => {
    const pts = [...pointers.values()];
    const a = pts[0]!;
    const b = pts[1];
    return b ? { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 } : { x: a.x, y: a.y };
  };
  const dist = () => {
    const pts = [...pointers.values()];
    const a = pts[0]!;
    const b = pts[1];
    return b ? Math.hypot(a.x - b.x, a.y - b.y) : 0;
  };

  el.addEventListener("pointerdown", (e) => {
    el.setPointerCapture(e.pointerId);
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    cam.touching = true;
    cam.stopMotion();
    pvx = pvy = 0;
    lastT = e.timeStamp;
    lastMid = mid();
    lastDist = dist();
    if (pointers.size === 1) moved = 0;
    onActivity();
  });

  el.addEventListener("pointermove", (e) => {
    const p = pointers.get(e.pointerId);
    if (!p) return;
    p.x = e.clientX;
    p.y = e.clientY;
    const m = mid();
    if (pointers.size === 1 && locked()) {
      lastMid = m;
      return;
    }
    const v = getView();
    const dt = Math.max(1, e.timeStamp - lastT) / 1000;

    if (pointers.size >= 2) {
      const d = dist();
      if (lastDist > 0) {
        const anchor = cam.screenToWorld(lastMid.x, lastMid.y, v);
        cam.zoomAbout(cam.logZoom + Math.log(d / lastDist), lastMid.x, lastMid.y, v);
        // Re-pin the anchored world point to the (moved) midpoint: pan + zoom in one motion.
        const s = cam.scale;
        if (!cam.lockX) cam.x = anchor.x - (m.x - v.w / 2) / s;
        cam.y = anchor.y - (m.y - v.h / 2) / s;
        pinched = true;
      }
      lastDist = d;
    } else {
      const dx = m.x - lastMid.x;
      const dy = m.y - lastMid.y;
      cam.panByScreen(dx, dy);
      moved += Math.abs(dx) + Math.abs(dy);
      const a = Math.min(1, dt * 40);
      pvx += (dx / dt - pvx) * a;
      pvy += (dy / dt - pvy) * a;
    }
    lastMid = m;
    lastT = e.timeStamp;
    onActivity();
  });

  const release = (e: PointerEvent) => {
    if (!pointers.has(e.pointerId)) return;
    const wasSingle = pointers.size === 1;
    pointers.delete(e.pointerId);
    if (pointers.size === 0) {
      cam.touching = false;
      if (pinched) {
        pinched = false;
        onZoomEnd();
      }
    }
    if (pointers.size === 1) {
      // Going from pinch to one finger: restart pan tracking without a jump.
      lastMid = mid();
      lastDist = 0;
      pvx = pvy = 0;
    }
    if (pointers.size === 0 && wasSingle) {
      const idle = e.timeStamp - lastT;
      if (moved < 8) {
        // A tap. Two taps close together in time and space = go home.
        const near = Math.hypot(e.clientX - lastTapPos.x, e.clientY - lastTapPos.y) < 30;
        if (e.timeStamp - lastTap < 320 && near) {
          cam.flyHome();
          lastTap = 0;
        } else {
          lastTap = e.timeStamp;
          lastTapPos = { x: e.clientX, y: e.clientY };
        }
      } else if (idle < 90) {
        // Cap the fling so one hard flick travels a few screens, never across the universe.
        const speed = Math.hypot(pvx, pvy);
        const k = speed > MAX_FLING ? MAX_FLING / speed : 1;
        const s = cam.scale;
        cam.vx = (-pvx * k) / s;
        cam.vy = (-pvy * k) / s;
      }
    }
    onActivity();
  };
  el.addEventListener("pointerup", release);
  el.addEventListener("pointercancel", release);

  el.addEventListener(
    "wheel",
    (e) => {
      e.preventDefault();
      cam.cancelHoming();
      const v = getView();
      if (e.ctrlKey || e.metaKey) {
        // Trackpad pinch arrives as ctrl+wheel in Chrome/Firefox.
        cam.anchorX = e.clientX;
        cam.anchorY = e.clientY;
        cam.vz += -e.deltaY * 0.045;
        scheduleZoomEnd();
      } else {
        const s = cam.scale;
        // Sideways only where the page is wider than the screen; otherwise a stray sideways drift would just wobble it.
        if (!cam.lockX && cam.maxX > cam.minX) cam.x += e.deltaX / s;
        cam.y += e.deltaY / s;
      }
      void v;
      onActivity();
    },
    { passive: false },
  );

  // Safari trackpad pinch.
  let gestureStartLog = 0;
  el.addEventListener("gesturestart", (e) => {
    e.preventDefault();
    cam.stopMotion();
    gestureStartLog = cam.logZoom;
  });
  el.addEventListener("gesturechange", (e) => {
    e.preventDefault();
    const g = e as unknown as { scale: number; clientX: number; clientY: number };
    cam.zoomAbout(gestureStartLog + Math.log(g.scale), g.clientX, g.clientY, getView());
    onActivity();
  });
  el.addEventListener("gestureend", () => onZoomEnd());

  window.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      cam.flyHome();
      onActivity();
    }
  });
  el.addEventListener("dblclick", () => {
    cam.flyHome();
    onActivity();
  });
}
