/**
 * The PINRads application form's rules: one list for the page (src/ui/adsapply.ts) and the server (server/adsapply.ts),
 * so both check the same things in the same words.
 */
export const AD_SLOTS = ["A1", "A2", "A3", "A4", "B1", "B2", "B3", "B4", "C1", "C2", "C3", "C4", "D1", "D2", "D3", "D4"] as const;
export type AdSlot = (typeof AD_SLOTS)[number];
/** A picture larger than this is refused in the browser (the server's own limit is the same). */
export const AD_PICTURE_MAX_BYTES = 3 * 1024 * 1024;

/** The form as sent: what the server reads (server/adsapply.ts). */
export interface AdApplication {
  slot: AdSlot;
  name: string;
  link: string;
  contact: string;
  /** the picture as a data address (image/png, jpeg, webp or gif), or null */
  picture: string | null;
}

/** What the form checks before sending; the server checks the same again. Null when it is fine, else the plain words to show. */
export function formProblem(a: Omit<AdApplication, "picture">): string | null {
  if (!AD_SLOTS.includes(a.slot)) return "Choose an ad space.";
  if (!a.name.trim()) return "Add your project's name.";
  if (a.name.trim().length > 60) return "The project name can be at most 60 characters.";
  let ok = false;
  try {
    const u = new URL(a.link.trim());
    ok = u.protocol === "https:" && u.hostname.includes(".");
  } catch {
    ok = false;
  }
  if (!ok || a.link.trim().length > 200) return "Add your project's link, starting with https://";
  if (!a.contact.trim()) return "Add a way to reach you (an email, Telegram or X handle).";
  if (a.contact.trim().length > 120) return "The contact can be at most 120 characters.";
  return null;
}
