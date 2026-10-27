/** The notice that goes beside every score. */
export const SCORE_NOTICE = "Social presence unchecked until the X API is connected. This score reads the chain only.";

/** The line beside a score everywhere (tiles, Discover, DeepScan; the iPhone app matches): the score is a reading, not advice. Public copy: change it only by a decision. */
export const ADVICE_LINE = "Not investment advice";

export function makeAdviceTag(): HTMLElement {
  const e = document.createElement("em");
  e.className = "advtag";
  e.textContent = ADVICE_LINE;
  e.hidden = true;
  return e;
}

/** The short tag shown beside a score everywhere (tiles, Discover rows, wallet holdings), phones included; the full sentence is its hover text and is shown whole on DeepScan and the wallet list. */
export const SCORE_TAG = "Chain only";

export function makeScoreTag(): HTMLElement {
  const e = document.createElement("em");
  e.className = "chaintag";
  e.textContent = SCORE_TAG;
  e.title = SCORE_NOTICE;
  e.hidden = true;
  return e;
}

/** The small label on a ribbon made from DexScreener's buy and sell counts, not real trades or dollars (a design decision; it was "by count"). */
export const BY_COUNT = "counted";
export const BY_COUNT_TITLE = "These dots are counted trades (DexScreener's buy and sell counts), not individual trades or dollars.";
export function makeByCount(): HTMLElement {
  const e = document.createElement("i");
  e.className = "bycount";
  e.textContent = BY_COUNT;
  e.title = BY_COUNT_TITLE;
  e.hidden = true;
  return e;
}
