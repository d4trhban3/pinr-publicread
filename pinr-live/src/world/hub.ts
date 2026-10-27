/**
 * PINR is the evidence hub. The PINR Index, its coverage, its labels (VAMP stays, as a fact), PINRbot's findings and the budget meter are HIDDEN on
 * pinr.io, not deleted: the engine, its rules and the feed still carry them, and this one switch brings them back. The site says what was observed
 * ("observed", "not checked yet", "worth a closer look"), never a verdict.
 *
 * The switch is the SERVER's setting (`PINR_SHOW_SCORE=on`; server/hubmask.ts), not the visitor's: while it is off the feed carries no score, coverage,
 * score label (VAMP stays) or PINRbot field at all, and the page follows the `scoreShown` flag the feed states. No URL turns it on.
 */
export const SCORE_DEFAULT = false;

// The server marks its page when the score is shown (server/staticsite.ts), so everything built at start already has the right words; the feed's flag follows.
let shown = typeof document !== "undefined" && document.documentElement?.dataset.score === "on" ? true : SCORE_DEFAULT;

/** Whether the score, its labels and PINRbot are shown (false on pinr.io today). */
export function scoreShown(): boolean {
  return shown;
}
/** For tests and for the page start: set the switch. */
export function setScoreShown(on: boolean): void {
  shown = on;
  if (typeof document !== "undefined") document.documentElement.classList.toggle("noscore", !on);
}

/** Put the switch's state on the page (a class its styles read). Called once at start. */
export function applyHubSwitch(): void {
  setScoreShown(shown);
}

/** A coin's labels stay only when they are a fact about the coin (a copy: VAMP); every other score label is hidden with the score. */
export function labelShown(label: string | null | undefined): boolean {
  return shown || label === "VAMP";
}

/** What a check's band is said as when no verdict is shown: what was observed, never a judgement. */
export function observedWords(band: string): string {
  switch (band) {
    case "Weak":
    case "worth a closer look": // already said so by the server (it sends no band while the score is off)
      return "worth a closer look";
    case "Strong":
    case "Fair":
    case "Clear":
    case "observed":
      return "observed";
    default:
      return "not checked yet"; // "Not read", "No data"
  }
}
