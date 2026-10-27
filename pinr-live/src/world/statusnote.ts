/**
 * The engine's own status words in a coin's note ("Technical error, retrying") are not an observation about the coin: never shown, on the site
 * or in the apps (checklist 7). One rule for the server (server/translate.ts drops them from the served note) and the page (livefeed.ts).
 */
export const STATUS_NOTE = /^technical error\b|\bretrying\b/i;

/** The note with its status parts taken out ("a; b" parts), or null when nothing observed is left. */
export function observedNote(note: string | null): string | null {
  if (note === null) return null;
  const kept = note.split(";").map((x) => x.trim()).filter((x) => x && !STATUS_NOTE.test(x));
  return kept.length ? kept.join("; ") : null;
}
