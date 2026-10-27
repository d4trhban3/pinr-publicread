import { scoreShown } from "./hub";
import { onLook, palette } from "../ui/theme";
import type { Camera, View } from "../engine/camera";
import { makeSpring, stepSpring, type Spring } from "../engine/spring";
import { layoutGrid } from "./layout";
import { pressureOffsets, type Body } from "./pressure";
import { createBadge, type Badge } from "../ui/badge";
import { avatarChar, liveImportance, SIM, statusLook, type Item, type LookKind, type Store } from "./model";
import { getRoster, hasSomethingToShow, rankFeatured, type Filter } from "./filters";
import { scoreColor } from "./scorecolor";
import { money } from "./discoverlist";
import { ADVICE_LINE, BY_COUNT_TITLE, SCORE_NOTICE, SCORE_TAG } from "../ui/scorenotice";
import { lastTradeText, realOf, ribbonMode } from "./flow";
import { scoredAgoShort } from "./format";
import { feeShort } from "../../server/transferfee";
import { makeEarlyTag, setEarly, showsEarly } from "../ui/earlytag";
import { tileTagChips } from "./tags";

/** One tile, in world units. At home on a phone, 5 of these (plus gaps) fill the screen width. */
export const CARD_W = 66;
export const GAP = 8;

/**
 * Semantic zoom. Tiles are laid out at one of four design widths and then scaled to the real
 * on-screen size, so text never gets absurdly small or huge: past each threshold the tile
 * re-lays itself out with more detail instead of just magnifying.
 *   level 0: name + score          (the overview, 5+ tiles per row)
 *   level 1: + coverage + event line
 *   level 2: + token/SIM label
 *   level 3: + description (full card)
 */
export const LOD_DESIGN_W = [66, 104, 150, 220];
/** On-screen tile width (px) at which each next level begins. Geometric mean of neighbours. */
export const LOD_AT = [83, 125, 182];

/**
 * What a tile holds: the picture with its small badge, name, ticker, market cap, all-time high, the ribbon, the score and the coverage.
 * By priority from the top: name and score (never dropped), coverage, market cap, all-time high; lines are dropped from the bottom until the rest fits.
 * Numbers are design units at each level.
 */
export const LABEL_PX = 9.3;
export const PAD_Y2 = [13, 20, 26, 36];
export const FIMG = [27, 37, 48, 61];
export const SCORE_H = [21, 29, 36, 44];
export const PRICE_H = [14, 16, 18, 20];
export const COV_H = [2, 2, 3, 3];
/** The extra height of the "Not investment advice" line on the wider tiles (zoom levels 2 and 3). */
export const ADV_H = [0, 0, 11, 13];
/** The extra height of the name and ticker when they stand under the picture instead of beside it (a narrow tile, so the name can use the tile's whole width). */
export const STACK_H = [22, 28, 34, 42];
/** A tile narrower than this on screen (CSS pixels) puts its name under the picture. */
export const STACK_BELOW_PX = 120;
/** The least a tile's content may be shrunk to before a line is dropped instead. */
export const SHRINK_MIN = 0.85;
/** The least the market cap and all-time-high rows may be shrunk to before they are dropped (R1: a tile carries them where it can). */
export const SHRINK_FIGS = 0.8;

/** Which level to use for an on-screen tile width, with a little hysteresis so it never flickers at a boundary. */
export function lodFor(screenW: number, current: number): number {
  let l = current;
  while (l < 3 && screenW > LOD_AT[l]! * 1.06) l++;
  while (l > 0 && screenW < LOD_AT[l - 1]! / 1.06) l--;
  return l;
}

/** What the stream layer needs to know about a tile that is on screen right now. */
export interface StreamTile {
  id: number;
  /** On-screen box in CSS pixels, including swell and push. */
  x: number;
  y: number;
  w: number;
  h: number;
  heat: number;
  imp: number;
  item: Item;
}

interface CardView {
  item: Item;
  /** The text layer (sits above the streams). */
  el: HTMLElement;
  /** The glass layer (sits below the streams): blur, tint, rim, light. */
  glass: HTMLElement;
  valueEl: HTMLElement;
  /** The pair and launchpad logos on the picture. */
  badge: Badge;
  covEl: HTMLElement;
  /** Last status look written to the DOM (a cheap key), and its kind. */
  lookKey: string;
  lookKind: LookKind | "";
  noteEl: HTMLElement;
  spec: HTMLElement;
  /** Identity text, kept so a name or picture that arrives later (real results) can be written in. */
  nameEl: HTMLElement;
  tickEl: HTMLElement;
  avatarEl: HTMLElement;
  tagEl: HTMLElement;
  /** The trader's facts line (market cap, age, price change) and the PINR chips (serial launcher, copy of, not scored). */
  factsEl: HTMLElement;
  chipsEl: HTMLElement;
  /** the coin's tags under its ticker, shown at every size (the chips row stays hidden on tiles, R1) */
  ttagsEl: HTMLElement;
  covWordEl: HTMLElement;
  earlyEl: HTMLElement;
  /** The one label row above the score: "Chain only · 41m". */
  ctagEl: HTMLElement;
  factsKey: string;
  idKey: string;
  /** Resting place and size. Set by the layout; only a deliberate change of filter or tile count moves them. */
  cx: number;
  cy: number;
  w: number;
  h: number;
  /** Swelling and neighbour push, both springs so everything eases. */
  grow: Spring;
  ox: Spring;
  oy: Spring;
  seq: number;
  heat: number;
  /** Last values written to the DOM, so a tile is only touched when it actually changed. */
  tx: number;
  ty: number;
  ts: number;
  z: number;
  off: boolean;
  /** True while a filter hides this tile. */
  gone: boolean;
  tier: number;
  /** Which sizing round this tile's CSS width/height was last written in (see `epoch`). */
  sizedAt: number;
  /** Last event colour written to the DOM: 1 lime, 0 mandarin, -1 never. */
  ev: number;
  /** The score rolls to its new value instead of jumping. */
  num: Spring;
  shown: number;
  specX: number;
  specY: number;
}

/** Event colours. Good news / buying is lime; red flags / selling is mandarin. */
export let EV_LIME = "#d6ff3c";
export let EV_MANDARIN = "#ff8c1a";
onLook(() => {
  const hex = (rgb: string): string => "#" + rgb.split(",").map((n) => Number(n).toString(16).padStart(2, "0")).join("");
  EV_LIME = hex(palette().live);
  EV_MANDARIN = hex(palette().mandarin);
});

/**
 * A token's picture. If it cannot be loaded (the host refuses to share it, the link is dead, or it is not a picture at all) the
 * circle shows the plain letter instead of a broken-picture icon.
 */
/** The coin's own links as small chips on the tile (X, Telegram, website). A press on a chip opens the link and never the tile. */
export function socialChips(links: Item["links"]): HTMLElement[] {
  const out: HTMLElement[] = [];
  for (const [label, url] of [["X", links?.x], ["TG", links?.telegram], ["Web", links?.website]] as const) {
    if (!url) continue;
    const a = document.createElement("a");
    a.className = "chip chiplink";
    a.textContent = label;
    a.href = url;
    a.target = "_blank";
    a.rel = "noopener noreferrer nofollow";
    for (const ev of ["pointerdown", "pointerup", "click"] as const) a.addEventListener(ev, (e) => e.stopPropagation());
    out.push(a);
  }
  return out;
}

export function pictureOf(src: string, name: string, address?: string | null): HTMLImageElement {
  const img = document.createElement("img");
  img.alt = "";
  img.draggable = false;
  img.referrerPolicy = "no-referrer";
  img.loading = "lazy";
  // A picture loaded straight from its own host that fails (the host is down or refuses) is asked of the server once instead; one more try a few
  // seconds later for a picture our own server was still fetching; after that the plain initial stays.
  let tried = false;
  let current = src;
  img.addEventListener("error", () => {
    if (!src.startsWith("/api/img") && address && current === src) {
      current = `/api/img?a=${encodeURIComponent(address)}`;
      img.src = current;
      return;
    }
    if (!tried && current.startsWith("/api/img")) {
      tried = true;
      setTimeout(() => (img.src = `${current}&again=1`), 6000);
      return;
    }
    const holder = img.parentElement;
    img.remove();
    if (holder && holder.childElementCount === 0) holder.textContent = avatarChar(name);
  });
  img.src = src;
  return img;
}

function build(item: Item): Pick<CardView, "el" | "glass" | "valueEl" | "badge" | "covEl" | "noteEl" | "spec" | "nameEl" | "tickEl" | "avatarEl" | "tagEl" | "factsEl" | "chipsEl" | "ttagsEl" | "covWordEl" | "earlyEl" | "ctagEl"> {
  // TEXT layer: name, event line, score. Crisp, above the streams.
  const el = document.createElement("div");
  el.className = "card";
  const k = document.createElement("div");
  k.className = "k";
  const tag = document.createElement("span");
  tag.className = "sim";
  tag.textContent = item.tag;
  k.append(tag);
  k.classList.toggle("none", !item.tag); // no row at all for real results (the tag is only "SIM" for made-up data)

  // Identity: a circle for the token's picture, then its name (main font) with the $ticker beneath it (small mono).
  const ident = document.createElement("div");
  ident.className = "ident";
  const avatar = document.createElement("div");
  avatar.className = "avatar";
  if (item.image) avatar.append(pictureOf(item.image, item.name, item.address));
  else avatar.textContent = avatarChar(item.name);
  // The picture wears its pair and launchpad logos in the lower-right corner.
  const avwrap = document.createElement("div");
  avwrap.className = "avwrap";
  const badge = createBadge();
  badge.set(item);
  avwrap.append(avatar, badge.el);
  const idtxt = document.createElement("div");
  idtxt.className = "idtxt";
  const name = document.createElement("div");
  name.className = "name";
  name.textContent = item.name;
  const tick = document.createElement("div");
  tick.className = "tick";
  tick.textContent = item.ticker;
  const ttags = document.createElement("div");
  ttags.className = "ttags";
  idtxt.append(name, tick, ttags);
  ident.append(avwrap, idtxt);
  const detail = document.createElement("div");
  detail.className = "detail";
  detail.textContent = item.detail;
  const noteEl = document.createElement("div");
  noteEl.className = "note";
  // What a trader sees on Pump.fun or Fomo (market cap, age, price move), then what PINR adds (chips).
  const factsEl = document.createElement("div");
  factsEl.className = "facts";
  const chipsEl = document.createElement("div");
  chipsEl.className = "chips";

  const n = document.createElement("div");
  n.className = "n";
  const valueEl = document.createElement("span");
  valueEl.textContent = item.value;
  valueEl.className = "val";
  // Bottom right of every card: the share of readings that loaded, with the word "coverage" beneath it.
  const cov = document.createElement("div");
  cov.className = "cov";
  const covPct = document.createElement("b");
  covPct.textContent = `${item.coverage}%`;
  const covWord = document.createElement("i");
  covWord.textContent = "coverage";
  const earlyTag = makeEarlyTag();
  const adv = document.createElement("div");
  adv.className = "advtag";
  adv.textContent = ADVICE_LINE;
  cov.append(earlyTag, covPct, covWord, adv);
  // "Chain only" and "scored ... ago" stand on their own lines above the score row, so on the narrowest tile they never sit over the number.
  const stags = document.createElement("div");
  stags.className = "stags";
  const ctag = document.createElement("div");
  ctag.className = "ctag";
  ctag.title = SCORE_NOTICE;
  // "Not investment advice" under the coverage, beside the score, on tiles wide enough to carry the line (zoom levels 2 and 3); the smaller tiles carry it one tap away, on Discover and DeepScan.
  stags.append(ctag);
  n.append(stags, valueEl, cov);

  const top = document.createElement("div");
  top.className = "top";
  top.append(k, ident, factsEl, chipsEl, detail, noteEl);
  el.append(top, n);

  // GLASS layer: blurs the live background behind it. Moving light slides across it like tilting an object.
  const glass = document.createElement("div");
  glass.className = "glass";
  const flash = document.createElement("div");
  flash.className = "flash";
  const spec = document.createElement("div");
  spec.className = "spec";
  glass.append(flash, spec);
  return { el, glass, valueEl, badge, covEl: covPct, noteEl, spec, nameEl: name, tickEl: tick, avatarEl: avatar, tagEl: tag, factsEl, chipsEl, ttagsEl: ttags, covWordEl: covWord, earlyEl: earlyTag, ctagEl: ctag };
}

/**
 * Owns every card. Each card has ONE permanent place, decided once from its long-term
 * importance. Live events never move a card: they make it swell in place, flash, and show a
 * short line, while the pressure field gently nudges its neighbours aside and back.
 */
export class CardField {
  private cards: CardView[] = [];
  private seenRev = 0;
  /** Tokens whose tile could not be made. */
  private bad = new Set<number>();
  /** The tiles the current filter shows, in the order the layout used. Everything live loops over these. */
  private active: CardView[] = [];
  private byId = new Map<number, CardView>();
  private cols = 5;
  /** Tile height in world units. The app sets it so that 15 rows fill one screen. */
  private cellH = 40;
  /** When set, tiles that extend below this world y are hidden: the map shows only each page's first screen. */
  private frameClip: number | null = null;
  /** The tile being hovered or held, and how much it swells. */
  /** In the map view the whole PINR room can swell and be pushed; its tiles follow it. */
  private group = { scale: 1, ox: 0, oy: 0, cx: 0, cy: 0 };
  private pressedId: number | null = null;
  private pressedSwell = 0;
  /** The base view is Trending (the header filter starts on it too). */
  private filter: Filter = "trending";
  /** 1 = fully shown; dips to 0 and back whenever the arrangement is changed on purpose. */
  private fade = 1;
  private fadeDir: -1 | 0 | 1 = 0;
  private firstLayout = true;
  private storeRef: Store | null = null;
  /** Counts up each time the arrangement is rebuilt, so other layers know to start fresh. */
  layoutVersion = 0;
  private lod = -1;
  /** Bumped whenever tile sizes change (zoom level or new layout). Tiles catch up lazily, only while on screen. */
  private epoch = 0;
  /** CSS size of a tile = world size x m; the transform scales it back to its true on-screen size. */
  private m = 1;
  private needsLayout = true;
  private offsets = new Float32Array(0);
  private bodies: Body[] = [];

  /** Every tile lives in these two containers (glass, text). Panning moves only the containers: two writes per frame, however many tiles. */
  private gWorld: HTMLElement;
  private cWorld: HTMLElement;
  private vis: StreamTile[] = [];
  private nVis = 0;

  constructor(
    private glassRoot: HTMLElement,
    private stage: HTMLElement,
  ) {
    this.gWorld = document.createElement("div");
    this.gWorld.className = "world";
    glassRoot.appendChild(this.gWorld);
    this.cWorld = document.createElement("div");
    this.cWorld.className = "world";
    stage.appendChild(this.cWorld);
  }

  /** Show this many tiles per row. The grid dissolves and re-forms; it never slides tiles around. */
  setCols(cols: number): void {
    if (cols !== this.cols) {
      this.cols = cols;
      this.needsLayout = true;
    }
  }

  /** Height of every tile, in world units. A change rebuilds the grid. */
  setCellHeight(h: number): void {
    if (Math.abs(h - this.cellH) > 0.01) {
      this.cellH = h;
      this.needsLayout = true;
    }
  }

  /** Swell one tile (hover or touch-hold) so it presses against its neighbours; null lets go. */
  setPressed(id: number | null, swell = 0): void {
    this.pressedId = id;
    this.pressedSwell = id === null ? 0 : swell;
  }

  /** Which tile is at this world position (its resting box), or null. */
  tileAt(x: number, y: number): number | null {
    for (const c of this.active) {
      if (Math.abs(x - c.cx) <= c.w / 2 && Math.abs(y - c.cy) <= c.h / 2) return c.item.id;
    }
    return null;
  }

  setGroup(g: { scale: number; ox: number; oy: number; cx: number; cy: number }): void {
    this.group = g;
  }

  setFrameClip(maxBottom: number | null): void {
    this.frameClip = maxBottom;
  }

  setFilter(f: Filter): void {
    if (f !== this.filter) {
      this.filter = f;
      this.needsLayout = true;
    }
  }

  /** The roster size changed: pick the tiles again. */
  relayout(): void {
    this.needsLayout = true;
  }

  get currentFilter(): Filter {
    return this.filter;
  }

  /** Vertical extent of the tiles now shown, in world units. */
  bounds(): { top: number; bottom: number } {
    let top = Infinity;
    let bottom = -Infinity;
    for (const c of this.active) {
      top = Math.min(top, c.cy - c.h / 2);
      bottom = Math.max(bottom, c.cy + c.h / 2);
    }
    return top === Infinity ? { top: 0, bottom: 0 } : { top, bottom };
  }

  get count(): number {
    return this.active.length;
  }

  /** Where every card rests. Exposed so tests can prove nothing ever moves. */
  restingPlaces(): [number, number, number, number][] {
    return this.active.map((c) => [c.cx, c.cy, c.w, c.h]);
  }

  tick(store: Store, dt: number, cam: Camera, view: View, light: { x: number; y: number }): void {
    this.storeRef = store;
    // Tiles exist only for the tokens the current filter shows (see layout), never for the whole pool the app knows about.
    if (store.rev !== this.seenRev) {
      this.seenRev = store.rev;
      // A token that has left the roster takes its tile away.
      const live = new Set(store.items.map((i) => i.id));
      for (const c of [...this.cards]) {
        if (live.has(c.item.id)) continue;
        this.dropCard(c);
        this.needsLayout = true;
      }
      // An under-full screen (first load, or a short list like New Launches) takes in what has arrived; a full one never reshuffles by itself.
      if (this.active.length < Math.min(getRoster(), store.items.length)) this.needsLayout = true;
    }
    const lod = lodFor(CARD_W * cam.scale, this.lod < 0 ? 0 : this.lod);
    if (lod !== this.lod) {
      this.lod = lod;
      this.m = LOD_DESIGN_W[lod]! / CARD_W;
      this.stage.dataset.lod = String(lod);
      this.glassRoot.dataset.lod = String(lod);
      this.applySizes();
    }
    this.labelsFor(cam, lod);
    this.arrange(dt);
    this.live(dt);
    this.render(cam, view, light);
  }

  /**
   * Decides, from the tile's size on screen, how much of a tile is drawn (see the priority note by LABEL_PX): `data-fit` is "row" (name, score, the
   * label row, coverage, price), "rowless" (no price), "rowbare" (no price, no coverage), and the same three as "plain", "plainnp", "plainbare" when there is no label row (too narrow or too short for one). The content is
   * shrunk a little (`--hs`) before anything is dropped. `--lab` is the row's size in the tile's own units, so it is 9 screen pixels.
   */
  private labelsFor(cam: Camera, lod: number): void {
    // The size the tiles really have on screen right now (they catch up with the camera a moment late while it moves), else what the camera implies.
    let sw = CARD_W * cam.scale;
    let sh = this.cellH * cam.scale;
    for (let i = 0; i < Math.min(this.active.length, 4); i++) {
      const r = this.active[i]!.el.getBoundingClientRect();
      if (r.width > 20 && r.height > 20) {
        sw = r.width;
        sh = r.height;
        break;
      }
    }
    const k = sw / LOD_DESIGN_W[lod]!;
    const avail = sh / k;
    // At phone width (under 600 px, PHONE_WIDTH in grid.ts) the picture always sits above the name, as in the apps, whatever the tile size.
    const stack = sw < STACK_BELOW_PX || innerWidth < 600;
    if (stack !== (this.stage.dataset.stack === "1")) this.stage.dataset.stack = stack ? "1" : "0";
    const base = PAD_Y2[lod]! + FIMG[lod]! + SCORE_H[lod]! + 2 + (stack ? STACK_H[lod]! : 0) + ADV_H[lod]!;
    // Priority from the top: name and score (never dropped), coverage, market cap, all-time high. Lines are dropped from the bottom.
    const cov = COV_H[lod]!;
    const mcH = PRICE_H[lod]!;
    const athH = PRICE_H[lod]!;
    // "fee": room for a third line, the transfer fee; a tile without a fee simply has none.
    const options: [string, number][] = [["fee", base + cov + mcH + athH + PRICE_H[lod]!], ["all", base + cov + mcH + athH], ["mc", base + cov + mcH], ["cov", base + cov], ["bare", base]];
    let pick: [string, number] | undefined;
    for (const o of options) {
      // The figures may shrink a little more than the rest before they are dropped, so a short tile on a desktop still carries them where it can.
      if (avail >= o[1] * (o[0] === "fee" || o[0] === "all" || o[0] === "mc" ? SHRINK_FIGS : SHRINK_MIN)) {
        pick = o;
        break;
      }
    }
    // Nothing fits at 85%: the content is shrunk further instead.
    pick ??= ["bare", base];
    const [fit, content] = pick;
    if (this.stage.dataset.fit !== fit) this.stage.dataset.fit = fit;
    // The tile's own padding does not shrink; everything else does.
    const hs = Math.max(0.3, Math.min(1, (0.93 * (avail - PAD_Y2[lod]!)) / (content - PAD_Y2[lod]!))).toFixed(3);
    if (this.stage.style.getPropertyValue("--hs") !== hs) this.stage.style.setProperty("--hs", hs);
    this.stage.style.setProperty("--lab", `${(LABEL_PX / k / Number(hs)).toFixed(2)}px`);
    this.stage.style.setProperty("--nmin", `${(LABEL_PX / k / Number(hs)).toFixed(2)}px`);
  }

  /** Rebuild the arrangement when asked: the very first time at once, afterwards dissolve out, rebuild, dissolve in. */
  private arrange(dt: number): void {
    if (this.needsLayout && this.fadeDir === 0) {
      if (this.firstLayout) {
        // The first arrangement fades in from nothing.
        this.firstLayout = false;
        this.layout();
        this.fade = 0;
        this.fadeDir = 1;
      } else this.fadeDir = -1;
    }
    if (this.fadeDir === -1) {
      this.fade = Math.max(0, this.fade - dt / 0.16);
      if (this.fade === 0) {
        this.layout();
        this.fadeDir = 1;
      }
    } else if (this.fadeDir === 1) {
      this.fade = Math.min(1, this.fade + dt / 0.26);
      if (this.fade === 1) this.fadeDir = 0;
    }
    if (this.fadeDir !== 0 || this.fade < 1) {
      const o = this.fadeDir === 0 ? "" : String(this.fade.toFixed(3));
      this.gWorld.style.opacity = o;
      this.cWorld.style.opacity = o;
    }
  }

  private add(item: Item): void {
    const parts = build(item);
    const c: CardView = {
      item,
      ...parts,
      cx: 0,
      cy: 0,
      w: CARD_W,
      h: 100,
      grow: makeSpring(1),
      ox: makeSpring(),
      oy: makeSpring(),
      seq: item.noteSeq,
      heat: -1,
      tx: NaN,
      ty: NaN,
      ts: NaN,
      z: -1,
      off: false,
      gone: false,
      tier: -1,
      sizedAt: -1,
      ev: -1,
      num: makeSpring(Number(item.value)),
      shown: Number(item.value),
      lookKey: "",
      lookKind: "",
      factsKey: "",
      idKey: `${item.name}|${item.ticker}|${item.image ?? ""}|${item.tag}`,
      specX: 1e9,
      specY: 1e9,
    };
    this.gWorld.appendChild(c.glass);
    this.cWorld.appendChild(c.el);
    this.cards.push(c);
    this.byId.set(item.id, c);
  }

  private dropCard(c: CardView): void {
    c.el.remove();
    c.glass.remove();
    this.byId.delete(c.item.id);
    this.cards.splice(this.cards.indexOf(c), 1);
  }

  /** Decide every shown tile's place from the current filter's ranking. */
  private layout(): void {
    this.needsLayout = false;
    this.layoutVersion++;
    const items = this.storeRef?.items ?? [];
    // Pump.fun and PumpSwap coins first, other launchpads in the room left.
    const ranked = rankFeatured(this.filter, items.filter(hasSomethingToShow));
    // Tiles for the ranked tokens only: the ones no longer shown are taken away, the newly shown ones are made.
    const wanted = new Set(ranked.map((r) => r.id));
    for (const c of [...this.cards]) if (!wanted.has(c.item.id)) this.dropCard(c);
    const byItem = new Map(items.map((it) => [it.id, it]));
    for (const r of ranked) {
      if (this.byId.has(r.id) || this.bad.has(r.id)) continue;
      try {
        this.add(byItem.get(r.id)!);
      } catch (e) {
        // A token whose tile cannot be made is left out (once), not retried every frame, and never stops the others.
        this.bad.add(r.id);
        if (this.storeRef) this.storeRef.skipped++;
        console.error("PINR: a tile could not be made and was skipped:", r.id, e);
      }
    }
    const rects = layoutGrid(
      ranked.map((r) => r.id).filter((id) => this.byId.has(id)),
      this.cols,
      CARD_W,
      this.cellH,
      GAP,
    );
    this.active = [];
    this.pressedId = null;
    for (const c of this.cards) {
      const r = rects.get(c.item.id);
      const gone = r === undefined;
      if (gone !== c.gone) {
        c.gone = gone;
        c.el.classList.toggle("gone", gone);
        c.glass.classList.toggle("gone", gone);
      }
      if (!r) continue;
      c.cx = r.x + r.w / 2;
      c.cy = r.y + r.h / 2;
      c.w = r.w;
      c.h = r.h;
      if (c.tier !== 1) {
        c.el.classList.add("t1");
        c.tier = 1;
      }
      c.tx = NaN; // force a fresh write of its position
      c.grow.x = 1;
      c.grow.v = 0;
      c.ox.x = c.oy.x = 0;
      c.ox.v = c.oy.v = 0;
      this.active.push(c);
    }
    this.applySizes();
    this.bodies = this.active.map((c) => ({ cx: c.cx, cy: c.cy, w: c.w, h: c.h, grow: 1 }));
    this.offsets = new Float32Array(this.active.length * 2);
  }

  /** Sizes changed. Nothing is written here: each tile updates itself the moment it is next on screen. */
  private applySizes(): void {
    this.epoch++;
  }

  /**
   * What a tile carries besides its picture, name, ticker, score, coverage and ribbon: the market cap and the all-time high,
   * nothing else. The all-time high shows only where a launchpad's own record states it (receipt on DeepScan), else a dash. Rewritten only when the words change.
   */
  private writeFacts(c: CardView): void {
    const it = c.item;
    const flagged = it.status === "flag";
    const mc = flagged ? "" : money(it.mcap);
    const ath = flagged ? "" : Number.isFinite(it.ath) && it.ath > 0 ? money(it.ath) : "—";
    // the number of trades in the last hour; a dash when no source counts it (missing stays missing).
    const txns = flagged ? "" : it.trades1h !== undefined && Number.isFinite(it.trades1h) ? `${countShort(it.trades1h)} /1h` : "—";
    // The transfer fee: a fee outside the rewards norm takes the top line, before MC, so a short tile drops ATH then MC
    // first; a rewards program's fee at its standard rate comes last, after ATH, so it is the first line a short tile drops.
    const fee = flagged || !it.transferFee ? "" : feeShort(it.transferFee);
    const lk = it.links ? `${it.links.x ?? ""}|${it.links.telegram ?? ""}|${it.links.website ?? ""}` : "";
    const key = `${fee}|${mc}|${txns}|${ath}|${lk}`;
    if (key === c.factsKey) return;
    c.factsKey = key;
    const row = (label: string, value: string): HTMLDivElement => {
      const d = document.createElement("div");
      d.className = "frow";
      const l = document.createElement("span");
      l.className = "flab";
      l.textContent = label;
      const v = document.createElement("span");
      v.className = "fmc";
      v.textContent = value;
      d.append(l, v);
      return d;
    };
    const rows: HTMLElement[] = [];
    const feeFirst = fee !== "" && it.transferFee?.kind === "outside_norm";
    if (feeFirst) rows.push(row("Fee", fee));
    if (mc !== "") {
      const r = row("MC", mc);
      // Where a tile has room for one line only, the hour's trades ride beside the market cap.
      if (txns !== "") {
        const x = document.createElement("span");
        x.className = "ftx";
        x.textContent = ` · ${txns === "—" ? "— tx" : txns.replace(" /1h", " tx/1h")}`;
        r.querySelector(".fmc")!.append(x);
      }
      rows.push(r);
    }
    if (txns !== "") {
      const r = row("TXNS", txns);
      r.classList.add("ftxrow");
      rows.push(r);
    }
    if (ath !== "") rows.push(row("ATH", ath));
    if (fee !== "" && !feeFirst) rows.push(row("Fee", fee));
    c.factsEl.replaceChildren(...rows);
    c.chipsEl.replaceChildren(...socialChips(it.links));
  }

  private factsDue = false;
  private factsAt = 0;

  /** Live state: swelling, neighbour push, flash and event line. */
  private live(dt: number): void {
    const clock = performance.now();
    this.factsDue = clock - this.factsAt > 1000;
    if (this.factsDue) this.factsAt = clock;
    for (let i = 0; i < this.active.length; i++) {
      const c = this.active[i]!;
      const it = c.item;
      const flagged = it.status === "flag";
      const heat = flagged ? 0 : Math.min(1, it.spike / 0.6);
      const pressed = it.id === this.pressedId;
      c.grow.target = 1 + Math.max(SIM.maxSwell * heat, pressed ? this.pressedSwell : 0);
      // Pressing is snappier than the slow swell of an event.
      stepSpring(c.grow, pressed || this.pressedId !== null ? 12 : 7, dt);
      this.bodies[i]!.grow = c.grow.x;

      // IDENTITY: a name, ticker or picture that arrives after the tile was made (real results) is written in.
      const idKey = `${it.name}|${it.ticker}|${it.image ?? ""}|${it.tag}|${(it.tags ?? []).join(",")}`;
      if (idKey !== c.idKey) {
        c.idKey = idKey;
        c.ttagsEl.replaceChildren(...tileTagChips(it.tags ?? []));
        c.nameEl.textContent = it.name;
        c.tickEl.textContent = it.ticker;
        c.tagEl.textContent = it.tag;
        c.tagEl.parentElement?.classList.toggle("none", !it.tag);
        c.avatarEl.replaceChildren();
        if (it.image) c.avatarEl.append(pictureOf(it.image, it.name, it.address));
        else c.avatarEl.textContent = avatarChar(it.name);
      }

      // STATUS: a flagged token shows its label instead of a score, and a missing reading is a dash, never a number.
      const ago = scoredAgoShort(it.scoredAtMs, Date.now());
      const key = `${it.status}|${it.flagKind ?? ""}|${it.coverage}|${showsEarly(it)}|${ago}|${ribbonMode(it, Date.now())}|${lastTradeText(realOf(it.address)?.lastRealMs, Date.now())}`;
      if (key !== c.lookKey) {
        c.lookKey = key;
        const look = statusLook(it);
        if (look.kind !== c.lookKind) {
          c.el.classList.toggle("st-flag", look.kind === "flag");
          c.lookKind = look.kind;
        }
        // A longer label (MAYHEM, HONEYPOT) is set smaller so it never runs into the coverage figure.
        c.el.dataset.flen = look.kind === "flag" ? (look.text.length <= 4 ? "s" : look.text.length <= 7 ? "m" : "l") : "";
        // Coverage is how much of PINR's reading loaded. A coin PINR has not read yet says so instead of a "0%".
        c.covEl.textContent = it.coverage > 0 ? `${it.coverage}%` : "—";
        setEarly(c.earlyEl, showsEarly(it));
        (c.el.querySelector(".advtag") as HTMLElement | null)?.toggleAttribute("hidden", !look.numeric);
        c.ctagEl.textContent = look.numeric ? (ago !== null ? `${SCORE_TAG} · ${ago}` : SCORE_TAG) : "";
        // The ribbon's label (a design decision): a tile carries no extra words, so it is the hover text.
        const rm = ribbonMode(it, Date.now());
        const lt = rm === "real" ? lastTradeText(realOf(it.address)?.lastRealMs, Date.now()) : "";
        c.ctagEl.title = rm === "real" ? `${SCORE_NOTICE} Each dot is one real trade${lt ? `; ${lt}` : ""}.` : rm === "counted" ? `${SCORE_NOTICE} ${BY_COUNT_TITLE} They are drawn fainter.` : SCORE_NOTICE;
        c.covWordEl.textContent = look.kind === "flag" ? "no data" : it.coverage > 0 ? "coverage" : "unscored";
        if (!scoreShown()) {
          // no coverage, tags or score words on a tile while the score is hidden (not deleted). A copy (VAMP) keeps its label as a fact.
          // The ribbon's label stays, as the tile's hover text.
          c.covEl.textContent = "";
          c.covWordEl.textContent = look.kind === "flag" ? "no data" : "";
          setEarly(c.earlyEl, false);
          c.ctagEl.textContent = "";
          c.ctagEl.title = "";
          (c.el.querySelector(".advtag") as HTMLElement | null)?.toggleAttribute("hidden", true);
          c.el.title = rm === "real" ? `Each dot is one real trade${lt ? `; ${lt}` : ""}.` : rm === "counted" ? `${BY_COUNT_TITLE} They are drawn fainter.` : "";
        }
        if (look.numeric) {
          c.shown = Number(it.value);
          c.num.x = c.shown;
          c.num.v = 0;
          c.valueEl.style.color = scoreColor(c.shown);
        } else c.valueEl.style.color = look.kind === "flag" ? "" : "var(--mute)";
        c.valueEl.textContent = look.text;
        // The notice beside every score: on hover or long-press of the number; the full line is on the DeepScan page.
        c.valueEl.title = look.numeric ? SCORE_NOTICE : "";
      }
      if (c.lookKind === "ok" || (c.lookKind === "thin" && it.coverage > 0 && Number.isFinite(Number(it.value)))) {
        c.num.target = Number(it.value);
        stepSpring(c.num, 9, dt);
        const n = Math.round(c.num.x);
        if (n !== c.shown) {
          c.shown = n;
          c.valueEl.textContent = String(n);
          c.valueEl.style.color = scoreColor(n);
        }
      }
      // The glow colour follows the latest event.
      const evSide = it.evSide;
      if (evSide !== c.ev) {
        c.ev = evSide;
        const col = evSide === 1 ? EV_LIME : EV_MANDARIN;
        c.el.style.setProperty("--ev", col);
        c.glass.style.setProperty("--ev", col);
      }
      if (it.noteSeq !== c.seq) {
        c.seq = it.noteSeq;
        // Restart the flash animation on every new event.
        c.glass.classList.remove("ping");
        void c.glass.offsetWidth;
        c.glass.classList.add("ping");
      }
      if (this.factsDue) {
        this.writeFacts(c);
        c.badge.set(it);
      }
      const text = it.note ?? "";
      if (c.noteEl.textContent !== text) c.noteEl.textContent = text;
      c.noteEl.classList.toggle("on", it.note !== null && it.noteLeft > 0.8);

      const h = Math.round(heat * 50) / 50;
      if (h !== c.heat) {
        c.heat = h;
        c.el.style.setProperty("--heat", String(h));
        c.glass.style.setProperty("--heat", String(h));
      }
    }
    pressureOffsets(this.bodies, this.offsets, CARD_W / 170);
    for (let i = 0; i < this.active.length; i++) {
      const c = this.active[i]!;
      c.ox.target = this.offsets[i * 2]!;
      c.oy.target = this.offsets[i * 2 + 1]!;
      stepSpring(c.ox, 8, dt);
      stepSpring(c.oy, 8, dt);
    }
  }

  /** The tiles currently on screen, with their boxes. Valid until the next tick; read only the first `count`. */
  visibleTiles(): { list: StreamTile[]; count: number } {
    return { list: this.vis, count: this.nVis };
  }

  private render(cam: Camera, view: View, light: { x: number; y: number }): void {
    this.nVis = 0;
    const s = cam.scale;
    // Pan = move the container. Nothing else is written for a tile that has not itself changed.
    const wx = view.w / 2 - cam.x * s;
    const wy = view.h / 2 - cam.y * s;
    const wt = `translate3d(${wx.toFixed(2)}px,${wy.toFixed(2)}px,0)`;
    this.gWorld.style.transform = wt;
    this.cWorld.style.transform = wt;

    for (const c of this.active) {
      const g = c.grow.x;
      // Swell is a scale about the tile's own centre, so its place never changes.
      const gr = this.group;
      const gs = gr.scale;
      const sw = c.w * g * gs * s;
      const sh = c.h * g * gs * s;
      // A swelled/pushed PINR room (map view) carries its tiles with it: scale about the room's centre, then shift.
      const ex = gr.cx + (c.cx + c.ox.x - gr.cx) * gs + gr.ox;
      const ey = gr.cy + (c.cy + c.oy.x - gr.cy) * gs + gr.oy;
      const px = ex * s - sw / 2;
      const py = ey * s - sh / 2;
      // Visible if any part is on screen (screen position = container offset + local position).
      const vis =
        px + wx + sw > -40 &&
        py + wy + sh > -40 &&
        px + wx < view.w + 40 &&
        py + wy < view.h + 40 &&
        (this.frameClip === null || c.cy + c.h / 2 <= this.frameClip);
      if (vis && c.sizedAt !== this.epoch) {
        // Off-screen tiles are out of layout entirely, so zoom-level changes only ever touch what you can see.
        const w = `${(c.w * this.m).toFixed(2)}px`;
        const h = `${(c.h * this.m).toFixed(2)}px`;
        c.el.style.width = c.glass.style.width = w;
        c.el.style.height = c.glass.style.height = h;
        c.sizedAt = this.epoch;
      }
      if (vis === c.off) {
        c.off = !vis;
        c.el.classList.toggle("off", !vis);
        c.glass.classList.toggle("off", !vis);
      }
      if (!vis) continue;

      let t = this.vis[this.nVis];
      if (!t) t = this.vis[this.nVis] = { id: 0, x: 0, y: 0, w: 0, h: 0, heat: 0, imp: 0, item: c.item };
      this.nVis++;
      t.id = c.item.id;
      t.x = px + wx;
      t.y = py + wy;
      t.w = sw;
      t.h = sh;
      t.heat = Math.min(1, c.item.spike / 0.6);
      t.imp = liveImportance(c.item);
      t.item = c.item;

      const sc = (s * g * gs) / this.m;
      // Written when NOT within tolerance of the last value, so a never-written tile (NaN) is always written.
      if (!(Math.abs(px - c.tx) <= 0.02 && Math.abs(py - c.ty) <= 0.02 && Math.abs(sc - c.ts) <= 1e-5)) {
        c.tx = px;
        c.ty = py;
        c.ts = sc;
        const tf = `translate3d(${px.toFixed(2)}px,${py.toFixed(2)}px,0) scale(${sc.toFixed(5)})`;
        c.el.style.transform = tf;
        c.glass.style.transform = tf;
      }
      // Light position inside the tile. Only touched when it has visibly moved.
      const lx = Math.round((light.x * c.w * this.m * 0.5) / 2) * 2;
      const ly = Math.round((light.y * c.h * this.m * 0.5) / 2) * 2;
      if (lx !== c.specX || ly !== c.specY) {
        c.specX = lx;
        c.specY = ly;
        c.spec.style.transform = `translate3d(${lx}px,${ly}px,0)`;
      }
      // Hotter tiles sit above the tiles they push against.
      const z = 1 + Math.round((g - 1) * 100);
      if (z !== c.z) {
        c.z = z;
        c.el.style.zIndex = String(z);
        c.glass.style.zIndex = String(z);
      }
    }
  }
}

/** A count of trades, short: 87, 1,240, 12.4K, 1.2M. */
export function countShort(n: number): string {
  if (n < 10_000) return Math.round(n).toLocaleString("en-US");
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 100_000 ? 1 : 0)}K`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}
