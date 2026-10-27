import type { Camera, View } from "../engine/camera";
import { makeSpring, stepSpring, type Spring } from "../engine/spring";
import { pressureOffsets, type Body } from "../world/pressure";
import { PAGE_ORDER, PAGE_TITLES, type Frame, type PageId } from "../world/sitemap";

/**
 * The page rooms of the site map. PINR's own content is the tile grid, so it only gets a faint frame here;
 * the other four pages are labelled placeholders until they are built. All rooms live in one container
 * that is moved and scaled with the camera, so they cost one style write per frame however many there are.
 */
const ICONS: Partial<Record<PageId, string>> = {
  arena: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 4l9.5 9.5M4 4h4M4 4v4M20 4l-9.5 9.5M20 4h-4M20 4v4M8.5 15.5l-3 3M15.5 15.5l3 3M6.5 14l3.5 3.5M17.5 14L14 17.5"/></svg>',
  deepscan:
    '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6.5"/><path d="M15.5 15.5L21 21M8 10.5h5M10.5 8v5"/></svg>',
  discover:
    '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M15.6 8.4l-2.1 5.1-5.1 2.1 2.1-5.1z"/></svg>',
  wallet:
    '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7.5A2.5 2.5 0 016.5 5H17v3"/><path d="M4 7.5V17a2 2 0 002 2h13V8H6.5A2.5 2.5 0 014 7.5z"/><circle cx="16" cy="13.5" r="1.1"/></svg>',
};

/**
 * Placeholder ads: each of the four ad areas has four slots (a wide one, two squares, a wide one), all PINR's own empty
 * placeholders, in our own colours. No project, brand, logo or name of anyone else appears here, and every area is labelled as a
 * placeholder advertisement.
 */
type AdId = "ads" | "adsne" | "adsw" | "adse";
// B is the north-east area again.
const AREA_LETTER: Record<AdId, string> = { ads: "A", adsne: "B", adsw: "C", adse: "D" };
export const AD_AREAS: Record<AdId, { name: string; kind: string }[]> = Object.fromEntries(
  (Object.keys(AREA_LETTER) as AdId[]).map((id) => [
    id,
    [0, 1, 2, 3].map((i) => ({ name: `Ad space ${AREA_LETTER[id]}${i + 1}`, kind: i === 0 || i === 3 ? "Wide placeholder" : "Square placeholder" })),
  ]),
) as Record<AdId, { name: string; kind: string }[]>;
/** Our own gradients, handed out in turn so neighbouring slots look different. */
const AD_GRADIENTS = [
  "linear-gradient(100deg, #9b6bff 0%, #5ec6c0 60%, #7dffb4 100%)",
  "linear-gradient(100deg, #4aa8ff 0%, #8f7bff 60%, #d6ff3c 130%)",
  "linear-gradient(100deg, #ff8c1a 0%, #ff5e8a 55%, #b86bff 100%)",
  "linear-gradient(100deg, #d6ff3c 0%, #5ee0a0 70%, #4aa8ff 130%)",
  "linear-gradient(100deg, #ff5e8a 0%, #ff8c1a 60%, #ffd23c 100%)",
  "linear-gradient(100deg, #5ec6c0 0%, #4aa8ff 55%, #9b6bff 100%)",
];

/** Four filled placeholder slots for one ad area. */
function adSlotsHtml(id: AdId, offset: number): string {
  return AD_AREAS[id]
    .map((s, i) => {
      const wide = i === 0 || i === 3;
      const grad = AD_GRADIENTS[(offset + i) % AD_GRADIENTS.length];
      return (
        `<div class="adslot${wide ? " wide" : ""}" data-slot="${AREA_LETTER[id]}${i + 1}" style="--adgrad:${grad}">` +
        `<span class="adchip">Ad</span><div class="adname">${s.name}</div><div class="adkind">${s.kind}</div><div class="adapply">Apply for this space</div></div>`
      );
    })
    .join("");
}

export interface Pages {
  /** Rebuild the rooms for new frame positions/sizes. */
  setFrames(frames: Record<PageId, Frame>): void;
  /** Move the whole layer with the camera, ease any pressed room, and show or hide the layer. */
  update(cam: Camera, view: View, visible: boolean, dt: number): void;
  /** Swell one room (hover or hold) so it presses against its neighbours; null lets go. */
  setPressed(id: PageId | null, swell?: number): void;
  /** Tell the DeepScan room which token's dossier it is for (null clears it). */
  setSubject(name: string | null): void;
  /** How one room is swelled and pushed right now, so a live page standing in it can follow. */
  roomPress(id: PageId): { scale: number; ox: number; oy: number };
  /** Which room is at this world position, or null. */
  roomAt(x: number, y: number): PageId | null;
  /** How the PINR room is swelled and pushed right now, so its tiles can follow it. */
  pinrPress(): { scale: number; ox: number; oy: number; cx: number; cy: number };
}

export function createPages(root: HTMLElement): Pages {
  const world = document.createElement("div");
  world.className = "pageworld";
  root.append(world);
  const rooms = new Map<PageId, HTMLElement>();

  function build(id: PageId): HTMLElement {
    const room = document.createElement("div");
    room.className = `page page-${id}${id.startsWith("ad") ? " page-adarea" : ""}`;
    const body = document.createElement("div");
    body.className = "pbody";
    if (id === "ads" || id === "adsne" || id === "adsw" || id === "adse") {
      // An empty advertising slot, clearly labelled. Nothing here is a real placement.
      body.innerHTML = `<div class="adtag">Advertisement · placeholder</div>${adSlotsHtml(id, ["ads", "adsw", "adse", "adsne"].indexOf(id) * 2)}`;
    } else if (id !== "pinr") {
      body.innerHTML = `${ICONS[id] ?? ""}<div class="ptitle">${PAGE_TITLES[id]}</div>`;
    }
    if (id === "deepscan") {
      const who = document.createElement("div");
      who.className = "pwho";
      who.textContent = "Pick a token on the PINR page";
      body.insertBefore(who, body.querySelector(".ptitle")!.nextSibling);
    }
    if (id !== "pinr" && !id.startsWith("ad")) {
      const sub = document.createElement("div");
      sub.className = "psub";
      sub.textContent = id === "arena" ? "Every version of a contested coin" : id === "wallet" ? "Read-only wallet profile" : id === "deepscan" ? "Dossier coming soon" : id === "discover" ? "Search the trenches" : "Coming soon";
      body.append(sub);
    }
    room.append(body);
    return room;
  }

  let shown: boolean | null = null; // unknown until the first update, so the layer's starting state is always set
  let frameSet: Record<PageId, Frame> | null = null;
  const grow = new Map<PageId, Spring>(PAGE_ORDER.map((id) => [id, makeSpring(1)]));
  const ox = new Map<PageId, Spring>(PAGE_ORDER.map((id) => [id, makeSpring()]));
  const oy = new Map<PageId, Spring>(PAGE_ORDER.map((id) => [id, makeSpring()]));
  let pressed: PageId | null = null;
  let pressedSwell = 0;
  let offsets = new Float32Array(PAGE_ORDER.length * 2);
  return {
    setSubject(name) {
      const who = rooms.get("deepscan")?.querySelector(".pwho");
      if (who) who.textContent = name ? `Dossier for ${name}` : "Pick a token on the PINR page";
    },
    setPressed(id, swell = 0) {
      pressed = id;
      pressedSwell = id === null ? 0 : swell;
    },
    roomPress: (id) => ({ scale: grow.get(id)!.x, ox: ox.get(id)!.x, oy: oy.get(id)!.x }),
    roomAt(x, y) {
      if (!frameSet) return null;
      for (const id of PAGE_ORDER) {
        const f = frameSet[id];
        if (x >= f.x && x <= f.x + f.w && y >= f.y && y <= f.y + f.h) return id;
      }
      return null;
    },
    pinrPress() {
      const f = frameSet?.pinr;
      return { scale: grow.get("pinr")!.x, ox: ox.get("pinr")!.x, oy: oy.get("pinr")!.x, cx: f ? f.x + f.w / 2 : 0, cy: f ? f.y + f.h / 2 : 0 };
    },
    setFrames(frames) {
      frameSet = frames;
      for (const id of Object.keys(frames) as PageId[]) {
        let room = rooms.get(id);
        if (!room) {
          room = build(id);
          rooms.set(id, room);
          world.append(room);
        }
        const f = frames[id];
        room.style.left = `${f.x}px`;
        room.style.top = `${f.y}px`;
        room.style.width = `${f.w}px`;
        room.style.height = `${f.h}px`;
      }
    },
    update(cam, view, visible, dt) {
      if (visible !== shown) {
        shown = visible;
        root.style.display = visible ? "" : "none";
      }
      // Rooms ease toward their pressed or resting state even while hidden, so nothing is left stuck.
      if (frameSet) {
        const bodies: Body[] = PAGE_ORDER.map((id) => {
          const f = frameSet![id];
          return { cx: f.x + f.w / 2, cy: f.y + f.h / 2, w: f.w, h: f.h, grow: grow.get(id)!.x };
        });
        // Pressure constants are tuned for 170-wide tiles; a room is about twice as wide.
        pressureOffsets(bodies, offsets, frameSet.pinr.w / 170);
        PAGE_ORDER.forEach((id, i) => {
          const g = grow.get(id)!;
          g.target = id === pressed ? 1 + pressedSwell : 1;
          stepSpring(g, 11, dt);
          const x = ox.get(id)!;
          const y = oy.get(id)!;
          x.target = offsets[i * 2]!;
          y.target = offsets[i * 2 + 1]!;
          stepSpring(x, 9, dt);
          stepSpring(y, 9, dt);
          const room = rooms.get(id);
          if (room && visible) room.style.transform = `translate3d(${x.x.toFixed(2)}px,${y.x.toFixed(2)}px,0) scale(${g.x.toFixed(4)})`;
        });
      }
      if (!visible) return;
      const s = cam.scale;
      world.style.transform = `translate3d(${(view.w / 2 - cam.x * s).toFixed(2)}px,${(view.h / 2 - cam.y * s).toFixed(2)}px,0) scale(${s.toFixed(5)})`;
    },
  };
}
