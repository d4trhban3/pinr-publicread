/**
 * The footer: five places in the same black glass as the header. Left to right:
 *   Discover (a magnifying glass) | PINR (the wordmark, "page" below it) | the compass (the d-pad with the PINR blade: where you are, and a tap
 *   zooms out to the whole site; it swapped places with the PINR guide button, which is now the header's centre, the operator 2026-10-25) |
 *   DeepScan (a pie chart: the scan's parts) | Wallet / Profile
 * For now only PINR has a page; the others show a quiet "coming soon" note. Later each tab flies the
 * camera to its page on the site map.
 */
import { scoreShown } from "../world/hub";
import type { PageId } from "../world/sitemap";
import { createCompass } from "./compass";

export type TabId = "discover" | "pinr" | "deepscan" | "wallet";
/** The tab to light for a page. Ad areas have no tab, so none lights. */
export function tabFor(page: string): TabId {
  return page as TabId;
}

const ICON = {
  discover: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6.5"/><path d="M15.5 15.5L21 21"/></svg>',
  deepscan: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3a9 9 0 109 9h-9z"/><path d="M15 3.5a8.5 8.5 0 015.5 5.5H15z"/></svg>',
  wallet:
    '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7.5A2.5 2.5 0 016.5 5H17v3"/><path d="M4 7.5V17a2 2 0 002 2h13V8H6.5A2.5 2.5 0 014 7.5z"/><circle cx="16" cy="13.5" r="1.1"/></svg>',
};

export interface TabBar {
  el: HTMLElement;
  /** Mark which page the camera is on. */
  setActive(id: string): void;
  /** Top edge of the bar in CSS pixels: the grid ends above this. */
  top(): number;
  /** The compass: which page it points at, and whether the whole site is in view. */
  setCompass(id: PageId, map: boolean): void;
}

export function createTabBar(onTab: (id: TabId) => void, onCompass: () => void): TabBar {
  const bar = document.createElement("nav");
  bar.id = "tabbar";
  bar.setAttribute("aria-label", "Pages");

  const tabs = new Map<TabId, HTMLButtonElement>();
  const add = (id: TabId, label: string, html: string): void => {
    const b = document.createElement("button");
    b.className = "tab";
    b.dataset.tab = id;
    b.setAttribute("aria-label", label);
    b.innerHTML = html; // only ever our own constant strings
    b.addEventListener("click", () => onTab(id));
    tabs.set(id, b);
    bar.append(b);
  };
  add("discover", "Discover", ICON.discover);
  // The operator's own wordmarks (art pack 64 for dark, 65 for light), the one for the look in use, with a small "page" centred below.
  add("pinr", "PINR page", '<span class="wmpage"><img class="wm wmdark" src="/art/pinr-wordmark-dark.svg" alt="" draggable="false" /><img class="wm wmlight" src="/art/pinr-wordmark-light.svg" alt="" draggable="false" /><span class="pg">page</span></span>');
  // The centre is the compass (it was the header's): where you are on the site, and a tap zooms out to all of it.
  const compass = createCompass(onCompass);
  const slot = document.createElement("div");
  slot.className = "tab compassslot";
  slot.append(compass.el);
  bar.append(slot);
  // The lite chart and DeepScan's report are one page: its tab is DeepScan's.
  add("deepscan", scoreShown() ? "PINRbot DeepScan" : "DeepScan", ICON.deepscan);
  add("wallet", "Wallet and profile", ICON.wallet);
  document.body.append(bar);

  function setActive(page: string): void {
    const id = tabFor(page);
    for (const [k, b] of tabs) {
      b.classList.toggle("on", k === id);
      b.setAttribute("aria-current", k === id ? "page" : "false");
    }
  }
  setActive("pinr");
  return { el: bar, setActive, top: () => bar.getBoundingClientRect().top, setCompass: (id, map) => (compass.setPage(id), compass.setMap(map)) };
}
