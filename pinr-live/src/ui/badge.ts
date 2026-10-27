import { MARK_SVG, padOf, pairOf } from "../world/marks";
import type { Item } from "../world/model";

/**
 * The pill on a token's picture (lower right): its pair logo and its launchpad logo, like Pump.fun's. A copy (VAMP) shows
 * neither: it carries no data anywhere but its label. A token whose pair and launchpad are both unknown shows no pill.
 */
export interface Badge {
  el: HTMLElement;
  set(it: Pick<Item, "quotePair" | "chain" | "launchpad" | "flagKind"> | null): void;
}

export function createBadge(): Badge {
  const root = document.createElement("span");
  root.className = "pbadge";
  root.hidden = true;
  let key = "";
  return {
    el: root,
    set(it) {
      const pair = it && it.flagKind !== "VAMP" ? pairOf(it) : null;
      const pad = it && it.flagKind !== "VAMP" ? padOf(it) : null;
      const k = `${pair}|${pad}`;
      if (k === key) return;
      key = k;
      root.hidden = pair === null && pad === null;
      root.replaceChildren();
      for (const m of [pair, pad]) {
        if (!m) continue;
        const i = document.createElement("i");
        i.innerHTML = MARK_SVG[m]; // only our own constant drawings
        root.append(i);
      }
    },
  };
}
