import type { PageId } from "../world/sitemap";

/**
 * The compass: a game-controller d-pad in the middle of the header with the PINR blade at its heart.
 * The site is a 3 x 3 map (see sitemap.ts), so every page has a bearing from the middle (PINR): the blade turns
 * its tip toward the page you are on and that arm of the pad lights up. Tapping it zooms right out to see the whole site (and does nothing once you are there).
 */

/** Degrees clockwise from north of each page, seen from the middle of the map. PINR is the middle (null). */
export const BEARING: Record<PageId, number | null> = {
  arena: 0,
  adsne: 45,
  wallet: 90,
  adse: 135,
  deepscan: 180,
  adsw: 225,
  discover: 270,
  ads: 315,
  pinr: null,
};

/** Which part of the pad lights for a page: an arm for the four main pages, a corner dot for the ad spaces, the hub for PINR. */
export type Part = "n" | "e" | "s" | "w" | "ne" | "se" | "sw" | "nw" | "hub";
export const PART: Record<PageId, Part> = {
  arena: "n",
  adsne: "ne",
  wallet: "e",
  adse: "se",
  deepscan: "s",
  adsw: "sw",
  discover: "w",
  ads: "nw",
  pinr: "hub",
};

/** The blade art points its tip DOWN, so it turns 180 degrees more than the bearing. At the hub it rests upright. */
export const needleAngle = (id: PageId): number => {
  const b = BEARING[id];
  return b === null ? 0 : b + 180;
};

const SVG =
  '<svg viewBox="0 0 44 44" aria-hidden="true">' +
  '<rect class="arm" data-p="n" x="15" y="1.5" width="14" height="15" rx="4.5"/>' +
  '<rect class="arm" data-p="s" x="15" y="27.5" width="14" height="15" rx="4.5"/>' +
  '<rect class="arm" data-p="w" x="1.5" y="15" width="15" height="14" rx="4.5"/>' +
  '<rect class="arm" data-p="e" x="27.5" y="15" width="15" height="14" rx="4.5"/>' +
  '<circle class="dot" data-p="nw" cx="7" cy="7" r="2"/>' +
  '<circle class="dot" data-p="ne" cx="37" cy="7" r="2"/>' +
  '<circle class="dot" data-p="sw" cx="7" cy="37" r="2"/>' +
  '<circle class="dot" data-p="se" cx="37" cy="37" r="2"/>' +
  '<circle class="hub" data-p="hub" cx="22" cy="22" r="11"/>' +
  "</svg>";

export interface Compass {
  el: HTMLButtonElement;
  /** Point at a page. */
  setPage(id: PageId): void;
  /** True while the whole site is in view (the compass then glows; tapping it does nothing more). */
  setMap(on: boolean): void;
}

export function createCompass(onTap: () => void): Compass {
  const b = document.createElement("button");
  b.className = "compass";
  b.type = "button";
  b.innerHTML = `${SVG}<img class="needle" src="/art/pinr-blade-large.svg" alt="" draggable="false">`;
  b.addEventListener("click", onTap);
  const needle = b.querySelector(".needle") as HTMLElement;
  const parts = [...b.querySelectorAll<SVGElement>("[data-p]")];
  let page: PageId | null = null;
  let map = false;
  let angle = 0;
  const label = (): void => {
    const where = page === null ? "" : ` You are in ${page === "pinr" ? "PINR" : page === "deepscan" ? "DeepScan" : page === "discover" ? "Discover" : page === "wallet" ? "Wallet" : page === "arena" ? "the PvP Arena" : "an ad space"}.`;
    b.setAttribute("aria-label", `See the whole site.${where}`);
    b.title = "See the whole site";
  };
  return {
    el: b,
    setPage(id) {
      if (id === page) return;
      page = id;
      // Turn the short way round, never the long way.
      angle += ((needleAngle(id) - angle + 540) % 360) - 180;
      needle.style.transform = `rotate(${angle}deg)`;
      const lit = PART[id];
      for (const p of parts) p.classList.toggle("lit", p.dataset.p === lit);
      label();
    },
    setMap(on) {
      if (on === map) return;
      map = on;
      b.classList.toggle("map", on);
      label();
    },
  };
}
