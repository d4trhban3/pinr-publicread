import type { Item } from "../world/model";

/**
 * The Hide controls' small shared pieces: the eye-slash icon, the one-button menu a long press or right-click on a tile opens, and
 * the note that says a coin is hidden (with Undo). Hiding is kept in this browser only and changes no score.
 */
export const EYE_OFF_ICON =
  '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 12s3.5-6 9-6c1.7 0 3.2.5 4.5 1.3M21 12s-3.5 6-9 6c-1.7 0-3.2-.5-4.5-1.3M10 10.3a2.5 2.5 0 0 0 3.7 3.4M4 4l16 16"/></svg>';

let menu: HTMLElement | null = null;
let closeMenu: (() => void) | null = null;

export function closeHideMenu(): void {
  closeMenu?.();
}

/** A small menu at the point pressed, with one action: "Hide this coin". Closes on any press elsewhere or Escape. */
export function showHideMenu(x: number, y: number, item: Item, onHide: (item: Item) => void): void {
  closeHideMenu();
  const box = document.createElement("div");
  box.className = "hidemenu";
  box.setAttribute("role", "menu");
  const name = document.createElement("div");
  name.className = "hidemenuname";
  name.textContent = item.name;
  const hide = document.createElement("button");
  hide.type = "button";
  hide.className = "hidemenubtn";
  hide.setAttribute("role", "menuitem");
  hide.innerHTML = `${EYE_OFF_ICON}<span>Hide this coin</span>`;
  const done = (): void => {
    box.remove();
    removeEventListener("pointerdown", away, true);
    removeEventListener("keydown", esc, true);
    menu = null;
    closeMenu = null;
  };
  const away = (e: Event): void => {
    if (!box.contains(e.target as Node)) done();
  };
  const esc = (e: KeyboardEvent): void => {
    if (e.key === "Escape") done();
  };
  hide.addEventListener("click", () => {
    done();
    onHide(item);
  });
  box.append(name, hide);
  document.body.append(box);
  // Keep it on the screen: its corner is where the finger or pointer is, moved in if that would run off an edge.
  const w = box.offsetWidth;
  const h = box.offsetHeight;
  box.style.left = `${Math.max(8, Math.min(innerWidth - w - 8, x - w / 2))}px`;
  box.style.top = `${Math.max(8, Math.min(innerHeight - h - 8, y - h - 12))}px`;
  menu = box;
  closeMenu = done;
  // Not on this very press: the menu opens on a hold, whose release must not close it at once.
  setTimeout(() => {
    if (menu === box) {
      addEventListener("pointerdown", away, true);
      addEventListener("keydown", esc, true);
    }
  }, 0);
}

let toastTimer: ReturnType<typeof setTimeout> | undefined;

/** "Hidden: <name>. Undo" at the foot of the page for a few seconds. */
export function showHiddenNote(name: string, onUndo: () => void): void {
  document.getElementById("hidenote")?.remove();
  clearTimeout(toastTimer);
  const t = document.createElement("div");
  t.id = "hidenote";
  t.setAttribute("role", "status");
  const msg = document.createElement("span");
  msg.textContent = `Hidden: ${name}`;
  const undo = document.createElement("button");
  undo.type = "button";
  undo.textContent = "Undo";
  undo.addEventListener("click", () => {
    t.remove();
    onUndo();
  });
  t.append(msg, undo);
  document.body.append(t);
  toastTimer = setTimeout(() => t.remove(), 6000);
}

/** A plain line at the foot of the page for a few seconds (the same place as the hidden note), e.g. why a coin link opened nothing. */
export function showNote(text: string): void {
  document.getElementById("hidenote")?.remove();
  clearTimeout(toastTimer);
  const t = document.createElement("div");
  t.id = "hidenote";
  t.setAttribute("role", "status");
  const msg = document.createElement("span");
  msg.textContent = text;
  t.append(msg);
  document.body.append(t);
  toastTimer = setTimeout(() => t.remove(), 8000);
}
