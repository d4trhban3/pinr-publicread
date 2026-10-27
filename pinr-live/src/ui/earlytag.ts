/**
 * The word "Early" beside a score that is an early one (slower readings still to come). Shown on a tile, a Discover row and the
 * DeepScan page. Public copy: the single word is fixed; the one-sentence explanation (hover, tap or keyboard focus) is EARLY_TIP.
 */
export const EARLY_WORD = "Early";
// a design decision.
export const EARLY_TIP = "An early look while more readings load; it can change.";

export function makeEarlyTag(): HTMLElement {
  const e = document.createElement("em");
  e.className = "earlytag";
  e.textContent = EARLY_WORD;
  e.tabIndex = 0;
  e.dataset.tip = EARLY_TIP;
  e.setAttribute("aria-label", `${EARLY_WORD}: ${EARLY_TIP}`);
  e.hidden = true;
  return e;
}

export function setEarly(tag: HTMLElement, on: boolean): void {
  tag.hidden = !on;
}

/** Whether a tile shows the label: an early score with a number or a dash, never beside a no-score label. */
export function showsEarly(it: { early: boolean; status: string }): boolean {
  return it.early && it.status !== "flag";
}

/** "Social: not checked yet" : beside the score on Discover and DeepScan, for a coin whose X check has not run. Never on a tile. */
export const SOCIAL_WORD = "Social: not checked yet";
export const SOCIAL_TIP = "PINR has not read this coin's X account yet, so social is left out for now.";

export function makeSocialTag(): HTMLElement {
  const e = document.createElement("em");
  e.className = "earlytag socialtag";
  e.textContent = SOCIAL_WORD;
  e.tabIndex = 0;
  e.dataset.tip = SOCIAL_TIP;
  e.setAttribute("aria-label", `${SOCIAL_WORD}: ${SOCIAL_TIP}`);
  e.hidden = true;
  return e;
}

/** Shown only with a real score (a number), never beside a no-score label or flag, and only when the feed said "not_checked". */
export function showsSocial(it: { socialNotChecked?: boolean; status: string }): boolean {
  return it.socialNotChecked === true && it.status !== "flag";
}
