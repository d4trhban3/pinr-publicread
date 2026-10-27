import { guideSections, type GuideBlock } from "./guidecopy";
import { scoreShown } from "../world/hub";

/**
 * The PINR guide: plain reading, no data and no buttons. The words live in guidecopy.ts as one list of sections, and this
 * file only draws that list. Since the operator put PINR in the map's centre (2026-10-25) the guide is not on the map: it is a
 * full page over the view, opened from the header's "PINR GUIDE" button, in the same glass as the Whitepaper and Settings.
 */
export interface GuidePage {
  el: HTMLElement;
  show(on: boolean): void;
  isOpen(): boolean;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

/** Text with **bold** pieces, built from text nodes only (the copy is never parsed as HTML). */
function richText(text: string): Node[] {
  return text.split("**").map((part, i) => (i % 2 === 1 ? el("strong", undefined, part) : document.createTextNode(part)));
}

function blockNode(b: GuideBlock): HTMLElement {
  const node = el(b.kind === "li" ? "li" : "p", b.kind === "li" ? "gdli" : "gdp");
  if (b.lead) node.append(el("b", "gdlead", b.lead), " ");
  node.append(...richText(b.text));
  return node;
}

export function createGuidePage(onClose: () => void): GuidePage {
  const root = el("div");
  root.id = "guidepanel";
  root.setAttribute("role", "dialog");
  root.setAttribute("aria-label", "PINR guide");
  const scroller = el("div", "sscroll");
  root.append(scroller);
  const top = el("div", "stop");
  const back = el("button", "sback");
  back.type = "button";
  back.setAttribute("aria-label", "Close the PINR guide");
  back.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15 5l-7 7 7 7"/></svg>';
  back.addEventListener("click", onClose);
  top.append(back, el("h1", "stitle", "PINR guide"));
  scroller.append(top);
  const page = el("div", "gdpage");
  scroller.append(page);

  // The words follow the score switch as it is when the guide opens: the feed sets it seconds after the page starts.
  let builtFor: boolean | null = null;
  function fill(): void {
    const shown = scoreShown();
    if (builtFor === shown) return;
    builtFor = shown;
    page.replaceChildren();
    for (const s of guideSections(scoreShown())) {
      const sec = el("section", "dssec gdsec");
      sec.append(el("h2", "dsh", s.title));
      // Bullets stay in one list; a paragraph between bullet runs ends the list.
      let list: HTMLUListElement | null = null;
      for (const b of s.blocks) {
        if (b.kind === "li") {
          if (!list) {
            list = el("ul", "gdul");
            sec.append(list);
          }
          list.append(blockNode(b));
        } else {
          list = null;
          sec.append(blockNode(b));
        }
      }
      page.append(sec);
    }
  }
  fill();
  document.body.append(root);
  let open = false;
  addEventListener("keydown", (e) => {
    if (e.key === "Escape" && open) onClose();
  });
  return {
    el: root,
    show(on) {
      open = on;
      if (on) fill();
      root.classList.toggle("on", on);
      if (on) scroller.scrollTop = 0;
    },
    isOpen: () => open,
  };
}
