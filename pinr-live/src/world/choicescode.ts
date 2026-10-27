import type { KeyValueStore, Moderation } from "./moderation";
import { cleanAddress, parseProfile, WALLET_KEY } from "./wallet";

/**
 * The PINR choices code: a person's looked-up address, hidden coins
 * and name filter as one short text to copy and paste, so another browser or the app can pick them up. No account, no server, no personal data: the
 * code is made and read on this device and nothing is sent anywhere.
 */
export const CODE_PREFIX = "PINR1.";
export const MAX_WALLETS = 10;
export const MAX_HIDDEN = 1000;

export interface Choices {
  /** looked-up public addresses, newest first */
  wallets: string[];
  /** hidden coin addresses, lower-case */
  hidden: string[];
  /** the rude-name filter; undefined when a code did not say */
  filter?: boolean;
}

const b64urlEncode = (text: string): string => {
  const bytes = new TextEncoder().encode(text);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};
const b64urlDecode = (s: string): string | null => {
  if (!/^[A-Za-z0-9_-]*$/.test(s) || s.length % 4 === 1) return null;
  try {
    const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (s.length % 4)) % 4));
    const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
};

/** Make the code. The same choices always make the same code (hidden coins are sorted); lists are cut to their limits. */
export function encodeChoices(c: Choices): string {
  const wallets = [...new Set(c.wallets.map((w) => cleanAddress(w)?.address).filter((w): w is string => !!w))].slice(0, MAX_WALLETS);
  const hidden = [...new Set(c.hidden.map((h) => h.trim().toLowerCase()).filter(Boolean))].sort().slice(0, MAX_HIDDEN);
  const obj: Record<string, unknown> = { v: 1, w: wallets, h: hidden };
  if (c.filter !== undefined) obj.f = c.filter;
  // Key order is fixed (v, w, h, f) so the text is the same on every device.
  const ordered = { v: obj.v, w: obj.w, h: obj.h, ...(c.filter !== undefined ? { f: c.filter } : {}) };
  return CODE_PREFIX + b64urlEncode(JSON.stringify(ordered));
}

export type DecodeResult = { ok: true; choices: Choices } | { ok: false; reason: "not a code" | "newer" };

/** Read a code. Anything not a PINR code is refused whole; what is valid inside is kept and the rest is dropped. */
export function decodeChoices(text: string): DecodeResult {
  const s = text.trim();
  if (!s.startsWith(CODE_PREFIX)) return { ok: false, reason: "not a code" };
  const json = b64urlDecode(s.slice(CODE_PREFIX.length));
  if (json === null) return { ok: false, reason: "not a code" };
  let o: unknown;
  try {
    o = JSON.parse(json);
  } catch {
    return { ok: false, reason: "not a code" };
  }
  if (typeof o !== "object" || o === null || Array.isArray(o)) return { ok: false, reason: "not a code" };
  const r = o as Record<string, unknown>;
  if (typeof r.v !== "number" || !Number.isFinite(r.v)) return { ok: false, reason: "not a code" };
  if (r.v > 1) return { ok: false, reason: "newer" };
  if (r.v < 1) return { ok: false, reason: "not a code" };
  const wallets = Array.isArray(r.w) ? [...new Set(r.w.map((w) => (typeof w === "string" ? cleanAddress(w)?.address : undefined)).filter((w): w is string => !!w))].slice(0, MAX_WALLETS) : [];
  const hidden = Array.isArray(r.h) ? [...new Set(r.h.filter((h): h is string => typeof h === "string" && h.trim() !== "").map((h) => h.trim().toLowerCase()))].slice(0, MAX_HIDDEN) : [];
  const choices: Choices = { wallets, hidden };
  if (typeof r.f === "boolean") choices.filter = r.f;
  return { ok: true, choices };
}

/** What a code holds, in the words shown before it is applied: "1 wallet, 12 hidden coins, name filter on". */
export function describeChoices(c: Choices): string {
  const n = (k: number, one: string, many: string): string => `${k} ${k === 1 ? one : many}`;
  return [n(c.wallets.length, "wallet", "wallets"), n(c.hidden.length, "hidden coin", "hidden coins"), c.filter === undefined ? "name filter unchanged" : `name filter ${c.filter ? "on" : "off"}`].join(", ");
}

/** The choices as they are on this device now: the looked-up address (saved by the Wallet page), the hidden coins and the name filter. */
export function currentChoices(storage: KeyValueStore | null, moderation: Moderation): Choices {
  let wallets: string[] = [];
  try {
    const p = parseProfile(JSON.parse(storage?.getItem(WALLET_KEY) ?? "null"));
    if (p) wallets = [p.address];
  } catch {
    /* nothing saved, or storage blocked */
  }
  return { wallets, hidden: moderation.hiddenList(), filter: moderation.filterNames };
}

export interface Applied {
  hiddenAdded: number;
  /** True when the looked-up address changed: the Wallet page reads it again when the page reloads. */
  walletChanged: boolean;
}

/**
 * Apply a code the person has confirmed. Hidden coins are added to the ones already hidden (nothing is un-hidden); the filter takes the code's value
 * when it has one; the looked-up address becomes the code's first wallet (a code with none leaves the current one).
 */
export function applyChoices(c: Choices, storage: KeyValueStore | null, moderation: Moderation, now = Date.now()): Applied {
  const hiddenAdded = moderation.addHidden(c.hidden);
  if (c.filter !== undefined && c.filter !== moderation.filterNames) moderation.setFilterNames(c.filter);
  let walletChanged = false;
  const first = c.wallets[0] ? cleanAddress(c.wallets[0]) : null;
  if (first) {
    const had = currentChoices(storage, moderation).wallets[0];
    if (had !== first.address) {
      try {
        // saved in the form the Wallet page already reads (a lookup of a public address)
        storage?.setItem(WALLET_KEY, JSON.stringify({ kind: "watch", chain: first.chain, address: first.address, via: "Watching", at: now }));
        walletChanged = true;
      } catch {
        /* kept for this visit only: not applied */
      }
    }
  }
  return { hiddenAdded, walletChanged };
}
