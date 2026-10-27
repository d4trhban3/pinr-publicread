import type { Item } from "./model";

/**
 * "Similar tokens" for the DeepScan page: other tokens that look like this one from MEASURED facts only
 * (same chain, same launchpad, market cap and age close to each other). Nothing here uses the score or how it is worked out.
 * A token with no known chain is not matched at all (missing stays missing); a missing market cap or age just adds no closeness.
 */
export function chainAndPad(it: Pick<Item, "detail">): { chain: string; pad: string } {
  const [c = "", p = ""] = it.detail.split("·").map((s) => s.trim());
  const unknown = (s: string) => s === "" || s.endsWith("unknown");
  return { chain: unknown(c) ? "" : c.toLowerCase(), pad: unknown(p) ? "" : p.toLowerCase() };
}

/** 0 = identical, grows as two positive numbers drift apart (distance in tenfold steps). Null when either is missing. */
function tenfold(a: number, b: number): number | null {
  if (!Number.isFinite(a) || !Number.isFinite(b) || a <= 0 || b <= 0) return null;
  return Math.abs(Math.log10(a / b));
}

export function similarTokens(base: Item, all: readonly Item[], count = 5): Item[] {
  const me = chainAndPad(base);
  if (!me.chain) return [];
  const scored: { it: Item; d: number }[] = [];
  for (const it of all) {
    if (it.id === base.id || (import.meta.env.DEV && it.tag === "SIM")) continue; // made-up tokens exist only in dev mode and tests
    const o = chainAndPad(it);
    if (o.chain !== me.chain) continue;
    const cap = tenfold(base.mcap, it.mcap);
    const age = tenfold(base.ageMin, it.ageMin);
    // Needs at least one measured likeness besides the chain, so a pair we know nothing about is not called similar.
    const samePad = me.pad !== "" && me.pad === o.pad;
    if (cap === null && age === null && !samePad) continue;
    if (cap !== null && cap > 1.5) continue; // more than ~30x apart in size is not similar
    const d = (cap ?? 1) + (age ?? 1) * 0.6 + (samePad ? 0 : 0.5);
    scored.push({ it, d });
  }
  scored.sort((a, b) => a.d - b.d || a.it.id - b.it.id);
  return scored.slice(0, count).map((s) => s.it);
}
