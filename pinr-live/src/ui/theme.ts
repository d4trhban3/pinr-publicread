/**
 * Light and dark look. It follows the phone's setting until the user taps the sun/moon button; that choice is saved.
 * Choosing the look the phone already uses clears the saved choice, so the site goes back to following the phone.
 * The look is one attribute on <html> (data-theme); every colour in style.css hangs off it. Canvas drawing reads `palette()`.
 */
export type Look = "dark" | "light";
const KEY = "pinr.theme";

const query = typeof matchMedia === "function" ? matchMedia("(prefers-color-scheme: light)") : null;
const phoneLook = (): Look => (query?.matches ? "light" : "dark");

function saved(): Look | null {
  try {
    const v = localStorage.getItem(KEY);
    return v === "light" || v === "dark" ? v : null;
  } catch {
    return null;
  }
}

const listeners = new Set<(look: Look) => void>();
let current: Look = saved() ?? phoneLook();

/** The colours canvases draw with ("r,g,b" strings, as they are written into rgba()). */
export interface Palette {
  live: string;
  mandarin: string;
  text: string;
  mute: string;
  /** hairlines and soft fills */
  fg: string;
  /** the opposite of text: what sits behind it */
  ground: string;
  /** the chart labels' backdrop */
  label: string;
}
const DARK: Palette = { live: "214,255,60", mandarin: "255,140,26", text: "244,238,255", mute: "154,161,174", fg: "255,255,255", ground: "10,12,14", label: "#20242c" };
const LIGHT: Palette = { live: "88,122,0", mandarin: "217,97,0", text: "20,22,28", mute: "67,74,88", fg: "14,18,28", ground: "250,251,253", label: "#e4e7ee" };

export const look = (): Look => current;
export const palette = (): Palette => (current === "light" ? LIGHT : DARK);

function apply(): void {
  document.documentElement.dataset.theme = current;
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute("content", current === "light" ? "#F1EBFC" : "#0A0C0E");
  for (const f of listeners) f(current);
}

/** Flip to the other look. Landing on the phone's own look goes back to following the phone. */
export function toggleLook(): void {
  current = current === "light" ? "dark" : "light";
  try {
    if (current === phoneLook()) localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, current);
  } catch {
    /* no storage: the choice lasts until the page closes */
  }
  apply();
}

/** Run now and again every time the look changes. */
export function onLook(f: (look: Look) => void): void {
  listeners.add(f);
  f(current);
}

export function startTheme(): void {
  apply();
  query?.addEventListener("change", () => {
    if (saved() === null) {
      current = phoneLook();
      apply();
    }
  });
}
