/**
 * Coin names and pictures are made by strangers (a design decision; the iPhone app's `Safety/Moderation.swift` is the model). Two tools, both kept in
 * this browser only and neither changing any score: a plain word filter that masks rude names (on unless switched off), and a per-coin Hide.
 */

/** Word stems that mark a name as rude. Matched inside a word, case and accents ignored, with common letter swaps undone. Short and plain; extend as needed. */
const STEMS = [
  "fuck", "fuk", "shit", "cunt", "pussy", "dick", "cock", "bitch", "whore", "slut", "porn", "penis", "vagina",
  "boob", "tits", "anal", "cum", "nigg", "fagg", "retard", "rape", "nazi", "hitler", "kkk", "jizz", "dildo", "wank",
];
/** Stems short enough to sit inside harmless words: matched only as a whole word ("cum" in "document" stays). */
const WHOLE_WORD_ONLY = new Set(["cum", "anal", "kkk", "tits", "dick", "cock", "rape", "fuk", "porn"]);
/** Names that contain a stem but are not rude. */
const ALLOWED = new Set(["moby dick"]);
const SWAPS: Record<string, string> = { "0": "o", "1": "i", "3": "e", "4": "a", "5": "s", $: "s", "@": "a", "!": "i" };

export const MASKED_NAME = "Name hidden";
export const MASKED_TICKER = "$•••";

export function normalise(s: string): string {
  const folded = s.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase();
  return [...folded].map((c) => SWAPS[c] ?? c).join("");
}

export function isRude(text: string | null | undefined): boolean {
  if (!text) return false;
  // A ticker's leading "$" is not a letter swap ("$HIT" is not "shit").
  const plain = normalise(text.replace(/^\$+/, ""));
  if (ALLOWED.has(plain.trim())) return false;
  // Matched inside one word at a time, never across a space ("Satoshi Tajiri" is not rude).
  const words = plain.split(/[^\p{L}]+/u).filter(Boolean);
  return STEMS.some((s) => (WHOLE_WORD_ONLY.has(s) ? words.includes(s) : words.some((w) => w.includes(s))));
}

const HIDDEN_KEY = "pinr.hidden";
const FILTER_KEY = "pinr.filterNames";

export interface KeyValueStore {
  getItem(k: string): string | null;
  setItem(k: string, v: string): void;
}

/** The coins this person has hidden, and the filter switch. Kept in the browser (any failure to read or write it just means "this visit only"). */
export class Moderation {
  private hidden: Set<string>;
  private filter: boolean;
  /** Bumped on every change, so a reader can tell cheaply that it has to look again. */
  rev = 0;
  private listeners = new Set<() => void>();

  constructor(private storage: KeyValueStore | null = null) {
    this.hidden = new Set();
    this.filter = true;
    try {
      const raw = storage?.getItem(HIDDEN_KEY);
      const list: unknown = raw ? JSON.parse(raw) : [];
      if (Array.isArray(list)) this.hidden = new Set(list.filter((x): x is string => typeof x === "string").map((x) => x.toLowerCase()));
      this.filter = storage?.getItem(FILTER_KEY) !== "false";
    } catch {
      /* blocked or damaged storage: defaults */
    }
  }

  get filterNames(): boolean {
    return this.filter;
  }
  setFilterNames(on: boolean): void {
    this.filter = on;
    this.save(FILTER_KEY, String(on));
    this.changed();
  }
  get hiddenCount(): number {
    return this.hidden.size;
  }
  isHidden(address: string | null | undefined): boolean {
    return !!address && this.hidden.has(address.toLowerCase());
  }
  hide(address: string): void {
    this.hidden.add(address.toLowerCase());
    this.save(HIDDEN_KEY, JSON.stringify([...this.hidden]));
    this.changed();
  }
  unhide(address: string): void {
    this.hidden.delete(address.toLowerCase());
    this.save(HIDDEN_KEY, JSON.stringify([...this.hidden]));
    this.changed();
  }
  /** Add coins to the hidden ones (nothing is un-hidden), with one change for the whole lot. Returns how many were new. */
  addHidden(addresses: readonly string[]): number {
    const before = this.hidden.size;
    for (const a of addresses) if (a.trim()) this.hidden.add(a.trim().toLowerCase());
    const added = this.hidden.size - before;
    if (added > 0) {
      this.save(HIDDEN_KEY, JSON.stringify([...this.hidden]));
      this.changed();
    }
    return added;
  }
  /** The hidden coins, lower-case (for the choices code). */
  hiddenList(): string[] {
    return [...this.hidden];
  }
  unhideAll(): void {
    this.hidden.clear();
    this.save(HIDDEN_KEY, "[]");
    this.changed();
  }
  /** True when this coin's name or ticker is masked right now. */
  masks(name: string | null | undefined, ticker: string | null | undefined): boolean {
    return this.filter && (isRude(name) || isRude(ticker));
  }
  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => void this.listeners.delete(fn);
  }
  private changed(): void {
    this.rev++;
    for (const fn of this.listeners) fn();
  }
  private save(k: string, v: string): void {
    try {
      this.storage?.setItem(k, v);
    } catch {
      /* kept for this visit only */
    }
  }
}

function browserStorage(): KeyValueStore | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

/** The one set of choices the page uses. */
export const moderation = new Moderation(browserStorage());
